-- Assign Task -> PO/Order Form upload replaces manual Job Card search (handwritten spec). An ordinary task
-- creator should never need to know a Job Card number exists. This widens the Factory-segment routing built in
-- mvp_pilot_assign_task_factory_segment_v2_89.sql: task_link_type gains 'po_order_form' / 'general_factory_task'
-- (the old 'job_card' / 'general' values stay valid -- "do not remove existing Job Card IDs from old tasks" --
-- nothing historical is touched), and a new RPC does the automatic matching the spec asks for, reusing
-- factory_create_job_internal (the SAME job-creation path the AI-intake pipeline and every other Factory
-- creation path already uses) for the "no match" branch rather than a second, parallel implementation.
--
-- Disclosed design decisions:
-- * OCR/auto-extraction from the uploaded PO photo is NOT wired this pass. The spec's "automatically extract
--   these details... mark low-confidence fields 'Please Verify'" would mean hooking this flow into the existing
--   factory-ai-extract Edge Function (built for the separate AI-intake pipeline, keyed off factory_ai_requests,
--   not staff_tasks) -- a real, separate integration effort. This pass collects the simple reference fields as
--   plain manual entry (same honesty as every other deferred-AI note this session).
-- * Material to Order has no Job Card concept in this schema (it is factory_material_requests, a different
--   table) -- a PO uploaded under that segment creates a real material request via the EXISTING
--   factory_create_material_request() RPC instead of attempting Job Card matching, which would never find
--   anything there by design.
-- * "Multiple possible matches -> Supervisor verification" is a real, working queue (factory_list_po_
--   verification_tasks / factory_resolve_po_verification below), not a stub -- a Factory Head/Supervisor can
--   link the correct Job Card or create a new one.

-- 1. staff_tasks -- widen task_link_type, add the PO/match-tracking columns. All additive and nullable.
alter table public.staff_tasks drop constraint if exists staff_tasks_task_link_type_check;
alter table public.staff_tasks add constraint staff_tasks_task_link_type_check
  check (task_link_type in ('job_card', 'general', 'po_order_form', 'general_factory_task'));

alter table public.staff_tasks add column if not exists po_order_number text;
alter table public.staff_tasks add column if not exists po_attachment_id uuid references public.staff_attachments(id);
alter table public.staff_tasks add column if not exists job_card_match_status text
  check (job_card_match_status in ('pending', 'matched', 'verification_required', 'new_job_card_required', 'created'));
alter table public.staff_tasks add column if not exists job_card_match_candidates uuid[];

create index if not exists staff_tasks_match_status_idx on public.staff_tasks (job_card_match_status) where job_card_match_status is not null;

-- 2. staff_set_task_factory_po -- the PO-upload counterpart to staff_set_task_factory_context(). Called right
--    after staff_create_task() AND after the PO file itself has been uploaded and recorded (uploadTaskProof,
--    entity_type='task'), so p_attachment_id already exists and is already visible to this caller.
create or replace function public.staff_set_task_factory_po(
  p_task_id uuid, p_factory_segment_code text, p_attachment_id uuid,
  p_po_number text default null, p_party_name text default null, p_product_name text default null,
  p_quantity numeric default null, p_delivery_date date default null, p_instructions text default null
) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  t public.staff_tasks%rowtype;
  v_fac uuid := public.factory_dept_id();
  v_division public.production_divisions%rowtype;
  v_caller_dept uuid := public.staff_current_department_id();
  v_candidates uuid[];
  v_match_count int;
  v_match_status text;
  v_job_id uuid;
  v_matched_number text;
  v_priority text;
  v_result record;
  v_second uuid;
  v_mat_day date; v_mat_seq int; v_mat_number text; v_mat_id uuid;
begin
  perform public.staff_assert_operational();
  select * into t from public.staff_tasks where id = p_task_id for update;
  if t.id is null then raise exception 'Task not found'; end if;
  if not (t.assigned_by = auth.uid() or public.staff_has_global_oversight()) then
    raise exception 'Only the person who created this task may set its Factory routing';
  end if;
  if t.to_department_id <> v_fac then raise exception 'This task is not assigned to Factory'; end if;
  if p_attachment_id is null then raise exception 'Please attach a PO or Order Form'; end if;
  if not exists (select 1 from public.staff_attachments a where a.id = p_attachment_id and a.entity_type = 'task' and a.entity_id = p_task_id and a.is_active) then
    raise exception 'The uploaded file could not be found on this task';
  end if;
  if coalesce(btrim(coalesce(p_po_number, '')), '') = '' and coalesce(btrim(coalesce(p_party_name, '')), '') = ''
     and coalesce(btrim(coalesce(p_product_name, '')), '') = '' then
    raise exception 'Please enter at least the PO/Order number, party name or product name';
  end if;
  if coalesce(p_factory_segment_code, '') not in ('SOFA', 'MODULAR', 'METAL_FAB', 'MATERIAL_ORDER') then
    raise exception 'Please select a Factory Segment';
  end if;

  if v_caller_dept is distinct from v_fac and not public.staff_has_global_oversight() then
    if not public.factory_is_leadership_user(t.assigned_to) then
      raise exception 'Selected assignee is not authorized for this Factory Segment';
    end if;
  end if;

  -- staff_tasks' priority vocabulary (Low/Normal/High/Urgent) and the Job Card's (Normal/High/Urgent/Emergency)
  -- don't quite line up (no Low on a Job Card, no Emergency from a task) -- Low maps to the closest safe
  -- equivalent, Normal, rather than passing a value factory_create_job_internal's own callers never expect.
  select case upper(coalesce(p.code, 'NORMAL')) when 'LOW' then 'Normal' when 'HIGH' then 'High' when 'URGENT' then 'Urgent' else 'Normal' end
    into v_priority from public.priority_master p where p.id = t.priority_id;

  if p_factory_segment_code = 'MATERIAL_ORDER' then
    -- No Job Card concept here -- a real Material to Order request instead. factory_create_material_request()
    -- itself re-checks staff_is_factory_staff() against auth.uid() -- correct for ITS normal callers, but wrong
    -- here: this function has ALREADY authorized the request (task ownership + leadership-assignee check
    -- above), so its insert logic is inlined rather than calling that RPC and failing its own, differently-
    -- scoped authorization check. Same table, same numbering scheme, same notify -- not a parallel feature.
    v_mat_day := (now() at time zone 'Asia/Kolkata')::date;
    insert into public.factory_material_number_counters (day, next_seq) values (v_mat_day, 1) on conflict (day) do nothing;
    update public.factory_material_number_counters set next_seq = next_seq + 1 where day = v_mat_day returning next_seq - 1 into v_mat_seq;
    v_mat_number := 'MTO-' || to_char(v_mat_day, 'YYYYMMDD') || '-' || lpad(v_mat_seq::text, 3, '0');
    insert into public.factory_material_requests (
      request_number, material, requesting_department_id, order_po_reference, requested_by, priority, required_date,
      quantity, unit, job_card_id, supplier, notes, created_by
    ) values (
      v_mat_number, coalesce(nullif(btrim(p_product_name), ''), 'See attached PO'), v_fac, nullif(btrim(coalesce(p_po_number, '')), ''),
      t.assigned_by, coalesce(v_priority, 'Normal'), p_delivery_date, coalesce(p_quantity, 1), 'Nos', null,
      nullif(btrim(coalesce(p_party_name, '')), ''), coalesce(p_instructions, '') || ' (from task ' || coalesce(t.task_number, '') || ')', t.assigned_by
    ) returning id into v_mat_id;
    perform public.staff_notify_dept_leadership('PROCUREMENT', 'factory_material_request', v_mat_id,
      'Material requested: ' || v_mat_number || ' — ' || coalesce(p_product_name, ''), v_mat_number || ' — ' || coalesce(p_product_name, '') || ' મટિરિયલ મંગાવ્યું');
    update public.staff_tasks set
      factory_segment_code = p_factory_segment_code, division_id = null, task_link_type = 'po_order_form',
      po_order_number = p_po_number, po_attachment_id = p_attachment_id, job_card_match_status = 'created'
    where id = p_task_id;
  else
    select * into v_division from public.production_divisions where code = p_factory_segment_code and is_active;
    if v_division.id is null then raise exception 'Please select a Factory Segment'; end if;

    select array_agg(r.id) into v_candidates
    from public.inhouse_production_requests r
    where r.division_id = v_division.id and not r.is_test_data and r.factory_status not in ('completed', 'cancelled')
      and (
        (coalesce(btrim(p_po_number), '') <> '' and r.po_number ilike btrim(p_po_number))
        or (coalesce(btrim(p_party_name), '') <> '' and r.customer_name ilike '%' || btrim(p_party_name) || '%')
        or (coalesce(btrim(p_product_name), '') <> '' and r.product_item ilike '%' || btrim(p_product_name) || '%')
      );
    v_match_count := coalesce(array_length(v_candidates, 1), 0);

    if v_match_count = 1 then
      v_job_id := v_candidates[1];
      select job_order_number into v_matched_number from public.inhouse_production_requests where id = v_job_id;
      v_match_status := 'matched';
      perform public.factory_log_event(v_job_id, 'task_created', null, null,
        'Task ' || coalesce(t.task_number, '') || ' matched automatically: ' || t.title, auth.uid());
    elsif v_match_count > 1 then
      v_match_status := 'verification_required';
    else
      -- No match -- reuse the SAME job-creation path every other Factory entry point already uses.
      -- Idempotency key = this task's own id: a retry of this RPC for the same task can never create a second
      -- Job Card (factory_create_job_internal's own dedup already covers this, same as every other caller).
      select * into v_result from public.factory_create_job_internal(
        t.assigned_by, v_fac, p_task_id::text, 'task_po', p_po_number, p_task_id, null,
        p_party_name, null, coalesce(nullif(btrim(p_product_name), ''), t.title),
        p_delivery_date, coalesce(v_priority, 'Normal'), p_instructions,
        jsonb_build_array(jsonb_build_object('item_name', coalesce(nullif(btrim(p_product_name), ''), t.title), 'quantity', coalesce(p_quantity, 1), 'unit', 'Nos')),
        null, null, null
      );
      v_job_id := v_result.job_id;
      v_matched_number := v_result.job_order_number;
      update public.inhouse_production_requests set division_id = v_division.id, po_number = p_po_number, po_received = (p_po_number is not null) where id = v_job_id;
      v_match_status := 'created';
    end if;

    update public.staff_tasks set
      factory_segment_code = p_factory_segment_code, division_id = v_division.id, task_link_type = 'po_order_form',
      po_order_number = p_po_number, po_attachment_id = p_attachment_id, job_card_id = v_job_id,
      job_card_match_status = v_match_status, job_card_match_candidates = case when v_match_status = 'verification_required' then v_candidates else null end
    where id = p_task_id;
  end if;

  perform public.staff_write_audit('task', p_task_id, 'FACTORY_PO_SET', null,
    jsonb_build_object('factory_segment_code', p_factory_segment_code, 'po_number', p_po_number, 'match_status', coalesce(v_match_status, 'created'), 'job_card_id', v_job_id), v_fac);

  perform public.staff_notify_assignment(t.assigned_to, 'task', p_task_id,
    t.title || ' — ' || p_factory_segment_code || coalesce(' — PO ' || p_po_number, ''), t.title || ' — ' || p_factory_segment_code);
  select user_id into v_second from public.staff_task_assignees where task_id = p_task_id and is_active and user_id <> t.assigned_to limit 1;
  if v_second is not null then
    perform public.staff_notify_assignment(v_second, 'task', p_task_id, t.title || ' — ' || p_factory_segment_code, t.title || ' — ' || p_factory_segment_code);
  end if;

  if v_match_status = 'verification_required' then
    perform public.staff_notify_dept_leadership('FACTORY', 'task', p_task_id,
      'Job Card verification needed (' || p_factory_segment_code || '): ' || t.title,
      'જોબ કાર્ડ ચકાસણી જરૂરી (' || p_factory_segment_code || '): ' || t.title);
  elsif v_matched_number is not null then
    perform public.staff_notify_dept_leadership('FACTORY', 'task', p_task_id,
      'New Factory PO (' || p_factory_segment_code || '): ' || t.title || ' — Matched with Job Card: ' || v_matched_number,
      'નવું ફેક્ટરી PO (' || p_factory_segment_code || '): ' || t.title || ' — જોબ કાર્ડ સાથે મેળ: ' || v_matched_number);
  else
    perform public.staff_notify_dept_leadership('FACTORY', 'task', p_task_id,
      'New Factory PO (' || p_factory_segment_code || '): ' || t.title,
      'નવું ફેક્ટરી PO (' || p_factory_segment_code || '): ' || t.title);
  end if;
end $function$;

-- 3. factory_list_po_verification_tasks -- the Supervisor/Head's queue of PO uploads that matched more than
--    one existing Job Card, each with its candidate rows resolved to real summaries (not just raw ids).
create or replace function public.factory_list_po_verification_tasks()
returns table(
  task_id uuid, task_number text, title text, factory_segment_code text, po_order_number text,
  assigned_by uuid, assigned_by_name text, created_at timestamptz,
  candidates jsonb
)
language sql stable security definer set search_path to 'public' as $$
  select t.id, t.task_number, t.title, t.factory_segment_code, t.po_order_number,
    t.assigned_by, up.full_name, t.created_at,
    coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'job_order_number', r.job_order_number,
        'customer_name', r.customer_name, 'product_item', r.product_item, 'factory_status', r.factory_status, 'po_number', r.po_number))
      from public.inhouse_production_requests r where r.id = any(t.job_card_match_candidates)), '[]'::jsonb)
  from public.staff_tasks t
  left join public.user_profiles up on up.id = t.assigned_by
  where t.job_card_match_status = 'verification_required' and t.is_active
    and (public.staff_has_global_oversight() or public.staff_is_dept_head() or public.staff_is_supervisor())
    and t.to_department_id = public.factory_dept_id()
  order by t.created_at desc;
$$;
grant execute on function public.factory_list_po_verification_tasks() to authenticated;

-- 4. factory_resolve_po_verification -- Head/Supervisor links the correct candidate, or creates a new Job Card
--    when none of the candidates is actually right (p_job_card_id null).
create or replace function public.factory_resolve_po_verification(p_task_id uuid, p_job_card_id uuid default null)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  t public.staff_tasks%rowtype;
  v_job public.inhouse_production_requests%rowtype;
  v_result record;
  v_priority text;
begin
  perform public.staff_assert_operational();
  if not (public.staff_has_global_oversight() or public.staff_is_dept_head() or public.staff_is_supervisor()) then
    raise exception 'Only Factory Head/Supervisor/oversight may resolve a Job Card match';
  end if;
  select * into t from public.staff_tasks where id = p_task_id and job_card_match_status = 'verification_required' for update;
  if t.id is null then raise exception 'No pending verification found for this task'; end if;

  if p_job_card_id is not null then
    if not (p_job_card_id = any(coalesce(t.job_card_match_candidates, array[]::uuid[]))) then
      raise exception 'This Job Card was not one of the suggested matches';
    end if;
    update public.staff_tasks set job_card_id = p_job_card_id, job_card_match_status = 'matched', job_card_match_candidates = null where id = p_task_id;
    perform public.factory_log_event(p_job_card_id, 'task_created', null, null, 'Task ' || coalesce(t.task_number, '') || ' linked after verification', auth.uid());
  else
    select case upper(coalesce(p.code, 'NORMAL')) when 'LOW' then 'Normal' when 'HIGH' then 'High' when 'URGENT' then 'Urgent' else 'Normal' end
      into v_priority from public.priority_master p where p.id = t.priority_id;
    select * into v_result from public.factory_create_job_internal(
      t.assigned_by, public.factory_dept_id(), p_task_id::text || '-new', 'task_po', t.po_order_number, p_task_id, null,
      null, null, t.title, null, coalesce(v_priority, 'Normal'), null,
      jsonb_build_array(jsonb_build_object('item_name', t.title, 'quantity', 1, 'unit', 'Nos')), null, null, null
    );
    update public.inhouse_production_requests set division_id = t.division_id, po_number = t.po_order_number where id = v_result.job_id;
    update public.staff_tasks set job_card_id = v_result.job_id, job_card_match_status = 'created', job_card_match_candidates = null where id = p_task_id;
  end if;
  perform public.staff_write_audit('task', p_task_id, 'FACTORY_PO_VERIFIED', null, jsonb_build_object('job_card_id', coalesce(p_job_card_id, (select job_card_id from public.staff_tasks where id = p_task_id))), public.factory_dept_id());
end $function$;
grant execute on function public.factory_resolve_po_verification(uuid, uuid) to authenticated;

-- 5. staff_set_task_factory_context (built in v2_89) -- widen its task_link_type validation to also accept
--    'general_factory_task' (the value the UI now actually sends for the no-PO case, replacing 'general') and
--    'po_order_form', without removing 'job_card'/'general' -- old rows and any other existing caller keep
--    working. Same signature, so this is a true in-place replace, not a new overload.
CREATE OR REPLACE FUNCTION public.staff_set_task_factory_context(p_task_id uuid, p_factory_segment_code text, p_job_card_id uuid DEFAULT NULL::uuid, p_task_link_type text DEFAULT 'general_factory_task'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t public.staff_tasks%rowtype;
  v_fac uuid := public.factory_dept_id();
  v_division public.production_divisions%rowtype;
  v_job public.inhouse_production_requests%rowtype;
  v_caller_dept uuid := public.staff_current_department_id();
  v_second uuid;
begin
  perform public.staff_assert_operational();
  select * into t from public.staff_tasks where id = p_task_id for update;
  if t.id is null then raise exception 'Task not found'; end if;
  if not (t.assigned_by = auth.uid() or public.staff_has_global_oversight()) then
    raise exception 'Only the person who created this task may set its Factory routing';
  end if;
  if t.to_department_id <> v_fac then raise exception 'This task is not assigned to Factory'; end if;

  if coalesce(p_factory_segment_code, '') not in ('SOFA', 'MODULAR', 'METAL_FAB', 'MATERIAL_ORDER') then
    raise exception 'Please select a Factory Segment';
  end if;
  if coalesce(p_task_link_type, 'general_factory_task') not in ('job_card', 'general', 'po_order_form', 'general_factory_task') then
    raise exception 'Invalid task link type';
  end if;

  if p_factory_segment_code = 'MATERIAL_ORDER' then
    if p_job_card_id is not null then raise exception 'Material to Order tasks cannot be linked to a Job Card'; end if;
    v_division.id := null;
  else
    select * into v_division from public.production_divisions where code = p_factory_segment_code and is_active;
    if v_division.id is null then raise exception 'Please select a Factory Segment'; end if;
    if p_task_link_type = 'job_card' then
      if p_job_card_id is null then raise exception 'Please select a Job Card or choose General Factory Task'; end if;
      select * into v_job from public.inhouse_production_requests r where r.id = p_job_card_id and public.factory_job_visible_row(r);
      if v_job.id is null then raise exception 'Job Card not found or not accessible'; end if;
      if v_job.factory_status in ('completed', 'cancelled') then raise exception 'Tasks cannot be linked to a closed Job Card'; end if;
      if v_job.division_id is distinct from v_division.id then raise exception 'This Job Card belongs to another Factory Segment'; end if;
    elsif p_job_card_id is not null then
      raise exception 'Please select a Job Card or choose General Factory Task';
    end if;
  end if;

  if v_caller_dept is distinct from v_fac and not public.staff_has_global_oversight() then
    if not public.factory_is_leadership_user(t.assigned_to) then
      raise exception 'Selected assignee is not authorized for this Factory Segment';
    end if;
  end if;

  update public.staff_tasks set
    division_id = v_division.id, factory_segment_code = p_factory_segment_code,
    job_card_id = p_job_card_id, task_link_type = coalesce(p_task_link_type, 'general_factory_task')
  where id = p_task_id;

  perform public.staff_write_audit('task', p_task_id, 'FACTORY_SEGMENT_SET', null,
    jsonb_build_object('factory_segment_code', p_factory_segment_code, 'job_card_id', p_job_card_id, 'task_link_type', p_task_link_type), v_fac);

  if v_job.id is not null then
    perform public.factory_log_event(v_job.id, 'task_created', v_job.factory_status, v_job.factory_status,
      'Task ' || coalesce(t.task_number, '') || ': ' || t.title, auth.uid());
  end if;

  perform public.staff_notify_assignment(t.assigned_to, 'task', p_task_id,
    t.title || ' — ' || p_factory_segment_code, t.title || ' — ' || p_factory_segment_code);
  select user_id into v_second from public.staff_task_assignees
    where task_id = p_task_id and is_active and user_id <> t.assigned_to limit 1;
  if v_second is not null then
    perform public.staff_notify_assignment(v_second, 'task', p_task_id,
      t.title || ' — ' || p_factory_segment_code, t.title || ' — ' || p_factory_segment_code);
  end if;
  perform public.staff_notify_dept_leadership('FACTORY', 'task', p_task_id,
    'New Factory task (' || p_factory_segment_code || '): ' || t.title,
    'નવું ફેક્ટરી ટાસ્ક (' || p_factory_segment_code || '): ' || t.title);
end $function$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'staff_set_task_factory_po(uuid, text, uuid, text, text, text, numeric, date, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
