-- mvp_pilot_factory_dashboard_phase1b_v2_81
--
-- Follow-up to _80 after end-to-end role testing:
--  1. The Job Card must exist the moment a request is submitted, NOT only
--     after the optional AI step -- so a missing/undeployed AI function can
--     never lose or delay a request. factory_ai_finalize_submission creates
--     it immediately; AI extraction later only ENRICHES an untouched draft.
--  2. Read models the UI needs: item names in the search view, files and
--     timeline with the person's name (security_invoker, so the caller's
--     own RLS still decides what they can see).

create or replace view public.factory_job_cards_v with (security_invoker = true) as
select
  r.id, r.job_order_number, r.factory_status, r.status as legacy_status,
  r.source_department_id, d.name_en as source_department_name, d.name_gu as source_department_name_gu,
  r.source_module, r.source_reference,
  r.project_id, coalesce(r.project_code, pr.project_code) as project_code,
  coalesce(r.customer_name, pr.customer) as customer_name, coalesce(r.site_location, pr.location) as site_location,
  r.product_item,
  coalesce(ic.item_count, case when r.product_item is not null then 1 else 0 end) as item_count,
  ic.total_qty, ic.qty_summary,
  r.required_completion_date as required_date, r.priority, r.current_stage, r.completion_percentage,
  r.assigned_factory_coordinator, public.factory_person_name(r.assigned_factory_coordinator) as assigned_name,
  r.second_assignee_coordinator, public.factory_person_name(r.second_assignee_coordinator) as second_name,
  coalesce(fc.file_count, 0) as file_count, coalesce(fc.drawing_count, 0) as drawing_count,
  ( (case when r.required_completion_date is null then 1 else 0 end)
  + (case when coalesce(ic.item_count, 0) = 0 then 1 else 0 end)
  + (case when coalesce(fc.drawing_count, 0) = 0 then 1 else 0 end)
  + (case when coalesce(ic.missing_qty, 0) > 0 then 1 else 0 end)
  + (case when coalesce(ic.missing_spec, 0) > 0 then 1 else 0 end) ) as missing_count,
  (r.factory_status not in ('completed', 'cancelled')
    and (r.factory_status = 'blocked'
         or (r.required_completion_date is not null and r.required_completion_date < (now() at time zone 'Asia/Kolkata')::date))) as is_delayed,
  (r.factory_status = 'blocked') as is_blocked,
  r.viewed_at, r.requested_by, public.factory_user_name(r.requested_by) as requested_by_name,
  r.clarification_note, r.blocked_reason, r.factory_location_id, r.production_department,
  r.created_at, r.updated_at, r.ready_at, r.completed_at, r.is_test_data,
  ic.all_items, r.production_start_date as planned_start, r.expected_completion_date as expected_end
from public.inhouse_production_requests r
left join public.departments d on d.id = r.source_department_id
left join public.projects pr on pr.id = r.project_id
left join lateral (
  select count(*) as item_count, sum(i.quantity) as total_qty,
    string_agg(coalesce(i.quantity::text, '?') || ' ' || coalesce(i.unit, '') || ' ' || i.item_name, ', ' order by i.line_no) filter (where i.line_no <= 3) as qty_summary,
    count(*) filter (where i.quantity is null or i.quantity <= 0) as missing_qty,
    count(*) filter (where i.material is null or i.dimensions is null) as missing_spec,
    string_agg(i.item_name, ', ' order by i.line_no) as all_items
  from public.factory_job_items i where i.job_id = r.id
) ic on true
left join lateral (
  select count(*) as file_count,
    count(*) filter (where f.category in ('Working Drawing', 'Production Drawing', '3D Drawing', 'Normal Drawing', 'Reference Drawing',
      'Furniture Detail Drawing', 'Cutting Drawing', 'Approved Design', 'RCP', 'Electrical Drawing', 'MEP Drawing')) as drawing_count
  from public.factory_drawings f where f.job_id = r.id and f.status <> 'Superseded'
) fc on true;
grant select on public.factory_job_cards_v to authenticated;

create or replace view public.factory_job_files_v with (security_invoker = true) as
select d.id, d.job_id, d.category, d.custom_category_name, d.title, d.file_name, d.mime_type, d.file_size,
       d.storage_bucket, d.storage_path, d.status, d.note, d.uploaded_at, d.uploaded_by,
       public.factory_user_name(d.uploaded_by) as uploader_name, d.version_number
from public.factory_drawings d where d.status <> 'Superseded';
grant select on public.factory_job_files_v to authenticated;

create or replace view public.factory_job_events_v with (security_invoker = true) as
select e.id, e.job_id, e.event_type, e.from_status, e.to_status, e.note, e.actor_id, e.created_at,
       public.factory_user_name(e.actor_id) as actor_name
from public.factory_job_events e;
grant select on public.factory_job_events_v to authenticated;

-- Enrich an untouched, still-unverified AI-sourced Job Card with what the
-- model read. Never overwrites a human edit: skipped as soon as anyone has
-- edited the items, or the card has left pending_verification.
create or replace function public.factory_ai_apply_extraction(p_job uuid, p_req uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
declare
  j public.inhouse_production_requests%rowtype; r public.factory_ai_requests%rowtype; ext jsonb; x jsonb; i int := 0; n int;
  v_date date; v_first text;
begin
  select * into j from public.inhouse_production_requests where id = p_job for update;
  select * into r from public.factory_ai_requests where id = p_req;
  if j.id is null or r.id is null or j.factory_status <> 'pending_verification' then return; end if;
  if exists (select 1 from public.factory_job_events where job_id = p_job and event_type in ('items_updated', 'ai_extracted')) then return; end if;
  ext := coalesce(r.verified_extraction, r.ai_extraction);
  if ext is null then return; end if;

  if jsonb_typeof(ext -> 'product_items') = 'array' and jsonb_array_length(ext -> 'product_items') > 0 then
    delete from public.factory_job_items where job_id = p_job;
    for x in select * from jsonb_array_elements(ext -> 'product_items') loop
      if coalesce(btrim(x ->> 'item_name'), '') = '' then continue; end if;
      i := i + 1;
      insert into public.factory_job_items(job_id, line_no, item_name, quantity, unit, dimensions, material, finish, hardware, room_area, instruction)
      values (p_job, i, btrim(x ->> 'item_name'), nullif(x ->> 'quantity', '')::numeric, nullif(btrim(x ->> 'unit'), ''), nullif(btrim(x ->> 'dimensions'), ''),
        nullif(btrim(x ->> 'material'), ''), nullif(btrim(x ->> 'finish'), ''), nullif(btrim(x ->> 'hardware'), ''),
        nullif(btrim(x ->> 'room_area'), ''), nullif(btrim(x ->> 'notes'), ''));
    end loop;
    if i = 0 then
      insert into public.factory_job_items(job_id, line_no, item_name) values (p_job, 1, coalesce(j.product_item, 'Item'));
      i := 1;
    end if;
    select item_name into v_first from public.factory_job_items where job_id = p_job order by line_no limit 1;
    select count(*) into n from public.factory_job_items where job_id = p_job;
    update public.inhouse_production_requests set product_item = case when n > 1 then v_first || ' (+' || (n - 1) || ' more)' else v_first end where id = p_job;
  end if;
  begin v_date := nullif(ext ->> 'required_date', '')::date; exception when others then v_date := null; end;
  update public.inhouse_production_requests set
    customer_name = coalesce(customer_name, nullif(ext ->> 'customer_name', '')),
    site_location = coalesce(site_location, nullif(ext ->> 'site_name', '')),
    required_completion_date = coalesce(required_completion_date, v_date),
    special_instructions = coalesce(special_instructions, nullif(ext ->> 'work_description', '')),
    updated_at = now()
  where id = p_job;
end $$;
revoke all on function public.factory_ai_apply_extraction(uuid, uuid) from public, anon, authenticated;

create or replace function public.factory_ai_store_extraction(
  p_request_id uuid, p_extraction jsonb, p_model text, p_prompt_version text,
  p_confidence_overall numeric, p_served_from_cache boolean default false
) returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_request public.factory_ai_requests%rowtype; v_job uuid;
begin
  select * into v_request from public.factory_ai_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'Request not found'; end if;

  update public.factory_ai_requests set status = 'extracted', ai_extraction = p_extraction, ai_model = p_model,
    ai_prompt_version = p_prompt_version, ai_confidence_overall = p_confidence_overall, ai_processed_at = now(),
    ai_served_from_cache = p_served_from_cache, ai_failure_reason = null, updated_at = now()
  where id = p_request_id;

  perform public.staff_write_audit('factory_ai_requests', p_request_id, 'AI_EXTRACTED', null,
    jsonb_build_object('model', p_model, 'confidence', p_confidence_overall, 'served_from_cache', p_served_from_cache), v_request.source_department_id, null);

  v_job := public.factory_ai_ensure_job(p_request_id);
  perform public.factory_ai_apply_extraction(v_job, p_request_id);
  perform public.factory_log_event(v_job, 'ai_extracted', null, null, 'AI read the source file(s) — confidence ' || round(coalesce(p_confidence_overall, 0) * 100) || '%', null);
end $function$;
revoke all on function public.factory_ai_store_extraction(uuid, jsonb, text, text, numeric, boolean) from public, authenticated, anon;
grant execute on function public.factory_ai_store_extraction(uuid, jsonb, text, text, numeric, boolean) to service_role;

create or replace function public.factory_ai_finalize_submission(p_request_id uuid)
returns table(job_id uuid, job_order_number text)
language plpgsql security definer set search_path to 'public' as $$
declare v_req public.factory_ai_requests%rowtype; v_job uuid;
begin
  perform public.staff_assert_operational();
  select * into v_req from public.factory_ai_requests where id = p_request_id;
  if v_req.id is null then raise exception 'Request not found'; end if;
  if v_req.created_by <> auth.uid() then raise exception 'You are not authorized to finalise this request'; end if;
  v_job := public.factory_ai_ensure_job(p_request_id);
  return query select v_job, (select r.job_order_number from public.inhouse_production_requests r where r.id = v_job);
end $$;
revoke all on function public.factory_ai_finalize_submission(uuid) from public, anon;
grant execute on function public.factory_ai_finalize_submission(uuid) to authenticated;
