-- mvp_pilot_factory_drawing_notes_v2_68
--
-- Extends factory_drawings (not a new parallel table) for the Purchase
-- Management "Submit to Factory" flow's new "Factory Reference Drawings &
-- Files" section:
--   1. A wider, real drawing-type vocabulary (additive to the existing 10).
--   2. Per-file `note` (drawing-specific instruction) and an optional
--      `drawing_date` distinct from `uploaded_at`.
--   3. factory_upload_drawing gains p_note/p_drawing_date -- same lesson as
--      v2_67's mistake: CREATE OR REPLACE with a new signature creates a
--      SECOND overload rather than replacing the function, so the old
--      7-argument signature is explicitly dropped in this same migration,
--      not left to bite a later caller.

alter table public.factory_drawings drop constraint if exists factory_drawings_category_check;
alter table public.factory_drawings add constraint factory_drawings_category_check
  check (category = any (array[
    'Working Drawing','Production Drawing','Furniture Detail Drawing','Cutting Drawing','RCP',
    'Electrical Drawing','MEP Drawing','Material Specification','Job Card','Others',
    '3D Drawing','Normal Drawing','Reference Drawing','Approved Design','Site Measurement','Reference Photo','PDF/Document'
  ]));

alter table public.factory_drawings add column if not exists note text;
alter table public.factory_drawings add column if not exists drawing_date date;

create or replace function public.factory_upload_drawing(
  p_job_id uuid, p_category text, p_title text, p_storage_path text,
  p_custom_category_name text default null, p_revision_reason text default null, p_parent_drawing_id uuid default null,
  p_note text default null, p_drawing_date date default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_job public.inhouse_production_requests%rowtype; v_id uuid; v_version int;
  v_critical boolean := false;
  v_msg_en text; v_msg_gu text;
begin
  perform public.staff_assert_operational();
  select * into v_job from public.inhouse_production_requests where id = p_job_id;
  if v_job.id is null then raise exception 'Job not found'; end if;
  if not public.staff_factory_record_authorized(v_job.project_id) then raise exception 'You are not authorized to upload a drawing for this job'; end if;
  if p_category = 'Others' and (p_custom_category_name is null or btrim(p_custom_category_name) = '') then
    raise exception 'A custom category name is required when category is Others';
  end if;
  if p_storage_path is null or btrim(p_storage_path) = '' then raise exception 'A file is required'; end if;

  v_version := 1;
  if p_parent_drawing_id is not null then
    select version_number + 1 into v_version from public.factory_drawings where id = p_parent_drawing_id;
    if v_version is null then raise exception 'Parent drawing not found'; end if;
    if p_revision_reason is null or btrim(p_revision_reason) = '' then
      raise exception 'A revision reason is required when revising an existing drawing';
    end if;
  end if;

  insert into public.factory_drawings (job_id, category, custom_category_name, title, storage_path, version_number, parent_drawing_id, revision_reason, uploaded_by, note, drawing_date)
  values (p_job_id, p_category, p_custom_category_name, p_title, p_storage_path, v_version, p_parent_drawing_id, p_revision_reason, auth.uid(), p_note, p_drawing_date)
  returning id into v_id;

  if p_parent_drawing_id is not null then
    update public.factory_drawings set status = 'Superseded' where id = p_parent_drawing_id and status <> 'Superseded';
    v_critical := v_job.current_stage is not null and v_job.current_stage not in ('Planning', 'Drawing Pending');
  end if;

  perform public.staff_write_audit('factory_drawings', v_id, 'UPLOAD', null, jsonb_build_object('category', p_category, 'version', v_version, 'project_id', v_job.project_id, 'critical_revision', v_critical), null);

  if v_job.linked_task_id is not null then
    if p_parent_drawing_id is not null then
      v_msg_en := (case when v_critical then 'CRITICAL REVISION -- production already in progress: ' else 'Drawing revised: ' end)
        || p_title || ' (v' || v_version || ') -- ' || coalesce(p_revision_reason, '');
      v_msg_gu := (case when v_critical then 'ગંભીર સુધારો -- ઉત્પાદન પહેલેથી ચાલુ છે: ' else 'ડ્રોઈંગ સુધારેલ: ' end)
        || p_title || ' (v' || v_version || ') -- ' || coalesce(p_revision_reason, '');
    else
      v_msg_en := 'Drawing uploaded: ' || p_title || ' (v' || v_version || ')';
      v_msg_gu := 'ડ્રોઈંગ અપલોડ: ' || p_title || ' (v' || v_version || ')';
    end if;
    perform public.staff_post_system_task_message(v_job.linked_task_id, v_msg_en, v_msg_gu);
  end if;

  return v_id;
end;
$function$;

drop function if exists public.factory_upload_drawing(uuid, text, text, text, text, text, uuid);
