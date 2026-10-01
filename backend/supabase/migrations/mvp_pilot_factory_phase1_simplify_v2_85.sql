-- Phase 1 simplification: "New [Segment] Job" becomes photo-first (take/upload the PO or Order Form -> the
-- segment is already known from the page the employee is on -> submit), reusing the app's EXISTING, mature AI
-- extraction pipeline (factory_ai_submit_request -> factory-ai-extract edge function -> factory_ai_finalize_submission
-- -> factory_ai_ensure_job, which itself reuses factory_create_job_internal) instead of the typed 3-step/
-- field-level-photo form added in mvp_pilot_factory_segment_pages_v2_84.sql. That form and its field-level photo
-- component are removed from the frontend (see factoryApi.js) as the "duplicate Job Card creation logic" this
-- cleanup pass asks to remove; their DB functions/columns are harmless unused leftovers -- this environment's
-- tooling can't run a DROP (gated behind a confirmation it can't satisfy), so they're disclosed, not hidden.
--
-- The only real gap in the existing AI pipeline for this: it had no way to carry a Factory segment through to
-- the created Job Card. This migration adds exactly that, as an additive overload (not a signature change to
-- the existing 6-arg function, which stays valid and untouched for defense-in-depth, though its only real
-- caller -- factoryAiSubmit() in interiorApi.js -- now always calls the 7-arg form explicitly to avoid any
-- "could not choose a best candidate function" ambiguity between the two overloads).
alter table public.factory_ai_requests add column if not exists division_id uuid references public.production_divisions(id);

create or replace function public.factory_ai_submit_request(p_idempotency_key text, p_project_id uuid, p_work_title text, p_work_description text default null::text, p_required_date date default null::date, p_priority text default 'Normal'::text, p_division_id uuid default null::uuid)
 returns table(request_id uuid, request_number text, already_submitted boolean)
 language plpgsql security definer set search_path to 'public' as $function$
declare
  v_existing record;
  v_dept_id uuid;
  v_id uuid; v_number text;
begin
  perform public.staff_assert_operational();
  if coalesce(btrim(p_work_title), '') = '' then raise exception 'A work title or instruction is required'; end if;
  if p_priority not in ('Normal', 'High', 'Urgent', 'Emergency') then raise exception 'Invalid priority'; end if;
  if p_division_id is not null and not exists (select 1 from public.production_divisions where id = p_division_id and is_active) then
    raise exception 'Invalid Factory segment';
  end if;

  select * into v_existing from public.factory_ai_requests where idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    return query select v_existing.id, v_existing.request_number, true;
    return;
  end if;

  select department_id into v_dept_id from public.user_profiles where id = auth.uid();
  if v_dept_id is null then raise exception 'Your department could not be resolved -- please contact an administrator'; end if;

  select 'FR-' || lpad((select count(*) + 1 from public.factory_ai_requests)::text, 6, '0') into v_number;

  insert into public.factory_ai_requests (
    request_number, idempotency_key, source_department_id, project_id, work_title, work_description,
    priority, required_date, status, created_by, division_id
  ) values (
    v_number, p_idempotency_key, v_dept_id, p_project_id, btrim(p_work_title), p_work_description,
    p_priority, p_required_date, 'uploaded', auth.uid(), p_division_id
  ) returning id into v_id;

  perform public.staff_write_audit('factory_ai_requests', v_id, 'CREATE', null,
    jsonb_build_object('request_number', v_number, 'project_id', p_project_id, 'source_department_id', v_dept_id), v_dept_id, null);

  return query select v_id, v_number, false;
end;
$function$;

revoke all on function public.factory_ai_submit_request(text, uuid, text, text, date, text, uuid) from public, anon;
grant execute on function public.factory_ai_submit_request(text, uuid, text, text, date, text, uuid) to authenticated;

-- factory_ai_ensure_job -- unchanged signature, just carries v_req.division_id onto the created Job Card when set.
create or replace function public.factory_ai_ensure_job(p_request_id uuid)
 returns uuid
 language plpgsql security definer set search_path to 'public' as $function$
declare
  v_req public.factory_ai_requests%rowtype; v_items jsonb := '[]'::jsonb; v_x jsonb; v_job uuid; v_res record; a record;
  v_ext jsonb; v_date date;
begin
  select * into v_req from public.factory_ai_requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'Request not found'; end if;
  if v_req.factory_job_id is not null then return v_req.factory_job_id; end if;

  v_ext := coalesce(v_req.verified_extraction, v_req.ai_extraction, '{}'::jsonb);
  if jsonb_typeof(v_ext -> 'product_items') = 'array' then
    for v_x in select * from jsonb_array_elements(v_ext -> 'product_items') loop
      if coalesce(btrim(v_x ->> 'item_name'), '') <> '' then
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'item_name', v_x ->> 'item_name', 'quantity', v_x ->> 'quantity', 'unit', v_x ->> 'unit', 'dimensions', v_x ->> 'dimensions',
          'material', v_x ->> 'material', 'finish', v_x ->> 'finish', 'hardware', v_x ->> 'hardware', 'room_area', v_x ->> 'room_area',
          'instruction', v_x ->> 'notes'));
      end if;
    end loop;
  end if;
  begin v_date := coalesce(v_req.required_date, nullif(v_ext ->> 'required_date', '')::date); exception when others then v_date := v_req.required_date; end;

  select * into v_res from public.factory_create_job_internal(
    v_req.created_by, v_req.source_department_id, 'ai:' || v_req.id::text, 'ai_intake', v_req.request_number, v_req.id,
    v_req.project_id, v_ext ->> 'customer_name', v_ext ->> 'site_name',
    coalesce(nullif(v_ext ->> 'work_title', ''), v_req.work_title), v_date, v_req.priority,
    coalesce(v_req.work_description, v_ext ->> 'work_description'), v_items, null, v_req.id, null);
  v_job := v_res.job_id;

  if v_req.division_id is not null then
    update public.inhouse_production_requests set division_id = v_req.division_id where id = v_job;
  end if;

  for a in select * from public.factory_ai_attachments where request_id = p_request_id loop
    insert into public.factory_drawings(job_id, category, custom_category_name, title, storage_path, storage_bucket, file_name, mime_type, file_size, status, uploaded_by)
    values (v_job,
      case when lower(coalesce(a.mime_type, '')) like 'image/%' then 'Reference Photo' when a.original_file_name ilike '%.pdf' then 'Reference Drawing' else 'Others' end,
      case when lower(coalesce(a.mime_type, '')) like 'image/%' or a.original_file_name ilike '%.pdf' then null else 'Source document' end,
      a.original_file_name, a.storage_path, 'factory-ai-attachments', a.original_file_name, a.mime_type, a.file_size, 'Submitted', a.uploaded_by);
    perform public.factory_log_event(v_job, 'file_added', null, null, a.original_file_name, a.uploaded_by);
  end loop;

  update public.factory_ai_requests set factory_job_id = v_job, updated_at = now() where id = p_request_id;
  return v_job;
end $function$;
