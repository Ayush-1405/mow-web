-- mvp_pilot_factory_drawing_revision_v2_66
--
-- Drawing-revision-after-Factory-issue support (extends, does not replace,
-- the existing factory_upload_drawing revision mechanism that was already
-- there via parent_drawing_id/version_number):
--   1. Old versions are still never overwritten (unchanged) -- they now
--      additionally get marked Superseded so the current one is obvious.
--   2. A revision uploaded after production has already started on the job
--      gets flagged as a Critical Revision in the existing system-message
--      notification channel (staff_post_system_task_message), not a new
--      notifications table.
--   3. Factory can now explicitly acknowledge a drawing (who/when), a real
--      gap before this migration -- there was no acknowledgment concept at
--      all on factory_drawings.

-- ---------------------------------------------------------------------
-- 1. 'Superseded' status + acknowledgment columns.
-- ---------------------------------------------------------------------
alter table public.factory_drawings drop constraint if exists factory_drawings_status_check;
alter table public.factory_drawings add constraint factory_drawings_status_check
  check (status = any (array['Draft','Submitted','Revision Required','Approved','Issued for Production','Superseded']));

alter table public.factory_drawings add column if not exists acknowledged_by uuid references public.user_profiles(id);
alter table public.factory_drawings add column if not exists acknowledged_at timestamptz;

-- ---------------------------------------------------------------------
-- 2. factory_upload_drawing -- CREATE OR REPLACE, same signature/grants,
--    additive behaviour only (early-return/validation paths unchanged):
--    when a parent_drawing_id is given, mark that parent Superseded and
--    flag the notification as Critical if the job's own current_stage
--    shows production is already past Planning/Drawing stages.
-- ---------------------------------------------------------------------
create or replace function public.factory_upload_drawing(
  p_job_id uuid, p_category text, p_title text, p_storage_path text,
  p_custom_category_name text default null, p_revision_reason text default null, p_parent_drawing_id uuid default null
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

  insert into public.factory_drawings (job_id, category, custom_category_name, title, storage_path, version_number, parent_drawing_id, revision_reason, uploaded_by)
  values (p_job_id, p_category, p_custom_category_name, p_title, p_storage_path, v_version, p_parent_drawing_id, p_revision_reason, auth.uid())
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

-- ---------------------------------------------------------------------
-- 3. factory_acknowledge_drawing -- new, additive RPC. Restricted to
--    actual Factory staff/Management/Super Admin (an Interior viewer can
--    SEE a drawing's status via the existing SELECT policy, but
--    acknowledging a revision is Factory's own action, not theirs).
-- ---------------------------------------------------------------------
create or replace function public.factory_acknowledge_drawing(p_drawing_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_job_id uuid;
begin
  perform public.staff_assert_operational();
  select job_id into v_job_id from public.factory_drawings where id = p_drawing_id;
  if v_job_id is null then raise exception 'Drawing not found'; end if;
  if not (public.staff_is_management() or public.staff_is_super_admin() or public.staff_is_factory_staff()) then
    raise exception 'Only Factory staff can acknowledge a drawing revision';
  end if;
  if not public.staff_factory_job_visible(v_job_id) then
    raise exception 'You are not authorized for this job';
  end if;

  update public.factory_drawings
  set acknowledged_by = auth.uid(),
      acknowledged_at = now()
  where id = p_drawing_id;

  perform public.staff_write_audit('factory_drawings', p_drawing_id, 'ACKNOWLEDGE', null, null, null);
end;
$function$;

grant execute on function public.factory_acknowledge_drawing(uuid) to authenticated;
