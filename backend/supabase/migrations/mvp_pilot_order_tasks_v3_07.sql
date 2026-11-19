-- Procurement orders become Procurement tasks in the existing task system (staff_tasks / staff_task_assignees / bridges).
--
-- One submitted order = one staff_tasks row (system_key 'PROC_ORDER:<order id>', purchase_request_id FK, unique) and, when
-- the order comes from another department, one bridges row (bridges.task_id is already unique). Nothing new is invented
-- for tasks: the order task uses the normal task statuses, My Tasks, Bridges, task chat and notifications.
--
-- The ORDER stays the single source of truth. A trigger on the order's status history (every status change writes one)
-- keeps the task and bridge in step: same due date, priority and description; task status follows the order. The
-- Procurement work stage (OPEN, WAITING FOR VENDOR, WAITING FOR GRN, COMPLETION PENDING ...) is derived from the order's
-- status by proc_task_stage(), so order and task can never disagree.
--
-- Flow: order submitted -> task created, owned by the Procurement Head, waiting for department approval
--   -> order reaches Procurement -> every active Procurement member is added to the task (it shows in their My Tasks)
--   -> the first to ACCEPT becomes the only assignee (row lock: a second person gets "already accepted by ...")
--   -> the task stays IN PROGRESS through ordering and delivery
--   -> the assignee marks it done only when the goods are delivered and verified (GRN, or direct delivery recorded)
--      and a placed order with PO number and vendor exists, with completion remarks
--   -> the Procurement Head verifies and completes the order; the task is VERIFIED and CLOSED with it.
-- Generic task actions that would bypass these rules (return, hold, reassign, complete, verify, close, reopen, delete) are
-- refused on order tasks with a message pointing to the order page; "Accept" in My Tasks works and is routed here.

begin;

-- ---------------------------------------------------------------------------
-- 1. Link
-- ---------------------------------------------------------------------------

alter table public.staff_tasks add column if not exists purchase_request_id uuid references public.purchase_requests(id) on delete set null;
create unique index if not exists staff_tasks_purchase_request_uq on public.staff_tasks (purchase_request_id) where purchase_request_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------

create or replace function public.proc_task_status_id(p_code text)
returns uuid language sql stable set search_path to 'public' as $$
  select id from public.status_master where code = p_code;
$$;

create or replace function public.proc_task_status_code(p_task_id uuid)
returns text language sql stable security definer set search_path to 'public' as $$
  select sm.code from public.staff_tasks t join public.status_master sm on sm.id = t.status_id where t.id = p_task_id;
$$;

-- The Procurement work stage of an order, shown on task cards, bridges and the dashboard.
create or replace function public.proc_task_stage(p_status text, p_task_code text, p_accepted boolean, p_direct_delivery boolean)
returns text language sql immutable set search_path to 'public' as $$
  select case
    when p_status = 'DRAFT' then 'DRAFT'
    when p_status in ('PENDING_DEPT_APPROVAL', 'EMERGENCY_APPROVAL_PENDING', 'APPROVED_BY_DEPT_HEAD') then 'WAITING_APPROVAL'
    when p_status = 'RETURNED_FOR_CORRECTION' then 'RETURNED'
    when p_status in ('REJECTED_BY_DEPT_HEAD', 'REJECTED_BY_PROCUREMENT', 'EMERGENCY_REJECTED') then 'REJECTED'
    when p_status = 'CANCELLED' then 'CANCELLED'
    when p_status = 'ON_HOLD' then 'ON_HOLD'
    when p_status = 'CLOSED' then 'COMPLETED'
    when p_task_code in ('COMPLETED', 'VERIFIED') then 'COMPLETION_PENDING'
    when p_status in ('SENT_TO_PROCUREMENT', 'CLARIFICATION_REQUIRED') then case when p_accepted then 'ACCEPTED' else 'OPEN' end
    when p_status in ('ACCEPTED_BY_PROCUREMENT', 'DOCUMENT_GENERATED') then 'IN_PROGRESS'
    when p_status in ('VENDOR_CONFIRMED', 'IN_PRODUCTION', 'READY_FOR_DISPATCH') then 'WAITING_FOR_VENDOR'
    when p_status = 'ORDER_PLACED' then 'ORDER_PLACED'
    when p_status in ('IN_TRANSIT', 'DELAYED') then 'IN_TRANSIT'
    when p_status = 'PARTIALLY_RECEIVED' then 'PARTIALLY_RECEIVED'
    when p_status = 'RECEIVED' then case when p_direct_delivery then 'COMPLETION_PENDING' else 'WAITING_FOR_GRN' end
    when p_status in ('GRN_VERIFIED', 'INVOICE_VERIFIED', 'PAYMENT_PENDING', 'PARTIALLY_PAID', 'PAID') then 'COMPLETION_PENDING'
    else 'IN_PROGRESS' end;
$$;

-- Why an order's task cannot be marked done yet (null = it can). The goods must be delivered and verified: a verified GRN
-- (or later: invoice / payment), or a direct delivery to the client/site recorded by Procurement; and a placed order with a
-- PO number and vendor must exist.
create or replace function public.proc_task_completion_blocker(p_row public.purchase_requests)
returns text language plpgsql stable security definer set search_path to 'public' as $$
begin
  if p_row.proc_status in ('DRAFT', 'PENDING_DEPT_APPROVAL', 'EMERGENCY_APPROVAL_PENDING', 'APPROVED_BY_DEPT_HEAD', 'SENT_TO_PROCUREMENT',
                           'CLARIFICATION_REQUIRED', 'ACCEPTED_BY_PROCUREMENT', 'DOCUMENT_GENERATED', 'ON_HOLD') then
    return 'The order has not been placed yet';
  end if;
  if p_row.proc_status in ('ORDER_PLACED', 'VENDOR_CONFIRMED', 'IN_PRODUCTION', 'READY_FOR_DISPATCH', 'IN_TRANSIT', 'DELAYED', 'PARTIALLY_RECEIVED') then
    return 'The goods have not been fully delivered yet';
  end if;
  if p_row.proc_status = 'RECEIVED' and p_row.delivered_to_client_at is null then
    return 'The goods receipt (GRN) has not been verified yet';
  end if;
  if p_row.proc_status not in ('RECEIVED', 'GRN_VERIFIED', 'INVOICE_VERIFIED', 'PAYMENT_PENDING', 'PARTIALLY_PAID', 'PAID') then
    return 'This order cannot be completed in its current state';
  end if;
  if not exists (select 1 from public.purchase_orders po where po.purchase_request_id = p_row.id and po.is_current
                    and btrim(coalesce(po.po_number, '')) <> '' and po.vendor_id is not null) then
    return 'No placed order with a PO number and vendor is recorded';
  end if;
  return null;
end $$;

-- Makes p_user the only active assignee (primary). p_accepted: their acceptance is recorded too.
create or replace function public.proc_task_set_owner(p_task_id uuid, p_user uuid, p_accepted boolean, p_actor uuid, p_reason text)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update public.staff_task_assignees set is_active = false, removed_at = now(), removed_by = p_actor, removal_reason = left(p_reason, 300)
   where task_id = p_task_id and is_active and user_id <> p_user;
  insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by, acceptance_status, accepted_at, individual_status, is_active)
  values (p_task_id, p_user, 'primary', p_actor, case when p_accepted then 'ACCEPTED' else 'PENDING' end, case when p_accepted then now() end,
          case when p_accepted then 'IN_PROGRESS' else 'ASSIGNED' end, true)
  on conflict (task_id, user_id) do update set assignment_role = 'primary', is_active = true, removed_at = null, removed_by = null, removal_reason = null,
    acceptance_status = case when p_accepted then 'ACCEPTED' else public.staff_task_assignees.acceptance_status end,
    accepted_at = case when p_accepted then coalesce(public.staff_task_assignees.accepted_at, now()) else public.staff_task_assignees.accepted_at end,
    individual_status = case when p_accepted then 'IN_PROGRESS' else public.staff_task_assignees.individual_status end;
end $$;

-- Adds every active Procurement member to an unaccepted order task (as secondary), so it shows in their My Tasks.
create or replace function public.proc_task_open_to_pool(p_task_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_user uuid;
begin
  foreach v_user in array public.proc_procurement_team() loop
    insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by, is_active)
    values (p_task_id, v_user, 'secondary', null, true)
    on conflict (task_id, user_id) do update set is_active = true, removed_at = null, removed_by = null, removal_reason = null,
      acceptance_status = 'PENDING', individual_status = 'ASSIGNED'
     where not public.staff_task_assignees.is_active;
  end loop;
end $$;

-- Every status gets its proper wording in task messages and history (v3_06 covered only the Procurement-side ones).
create or replace function public.proc_status_label(p_status text)
returns text language sql immutable set search_path to 'public' as $$
  select case p_status
    when 'DRAFT' then 'Draft' when 'PENDING_DEPT_APPROVAL' then 'Pending Department Approval' when 'RETURNED_FOR_CORRECTION' then 'Returned for Correction'
    when 'REJECTED_BY_DEPT_HEAD' then 'Rejected by Department Head' when 'APPROVED_BY_DEPT_HEAD' then 'Approved by Department Head'
    when 'EMERGENCY_APPROVAL_PENDING' then 'Emergency Approval Pending' when 'EMERGENCY_REJECTED' then 'Emergency Rejected'
    when 'SENT_TO_PROCUREMENT' then 'Pending Procurement' when 'CLARIFICATION_REQUIRED' then 'Clarification Required'
    when 'REJECTED_BY_PROCUREMENT' then 'Rejected by Procurement'
    when 'ACCEPTED_BY_PROCUREMENT' then 'Accepted - Awaiting Print' when 'DOCUMENT_GENERATED' then 'Printed - Awaiting Order Placed'
    when 'ORDER_PLACED' then 'Order Placed' when 'VENDOR_CONFIRMED' then 'Vendor Confirmed' when 'IN_PRODUCTION' then 'In Production'
    when 'READY_FOR_DISPATCH' then 'Ready for Dispatch' when 'IN_TRANSIT' then 'In Transit' when 'DELAYED' then 'Delayed'
    when 'PARTIALLY_RECEIVED' then 'Partially Delivered' when 'RECEIVED' then 'Delivered' when 'GRN_VERIFIED' then 'GRN Verified'
    when 'INVOICE_VERIFIED' then 'Invoice Verified' when 'PAYMENT_PENDING' then 'Payment Pending' when 'PARTIALLY_PAID' then 'Partially Paid'
    when 'PAID' then 'Paid' when 'ON_HOLD' then 'On Hold' when 'CLOSED' then 'Completed' when 'CANCELLED' then 'Cancelled'
    else initcap(replace(coalesce(p_status, ''), '_', ' ')) end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Keeping the task and bridge in step with the order (idempotent; safe to run any number of times)
-- ---------------------------------------------------------------------------

create or replace function public.proc_sync_order_task(p_request_id uuid)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare
  r public.purchase_requests; t public.staff_tasks; v_prev text := coalesce(current_setting('mow.proc_task_sync', true), '');
  v_proc uuid := public.factory_procurement_dept_id(); v_head uuid := public.proc_procurement_head_user(); v_owner uuid; v_from_person uuid;
  v_code text; v_title text; v_desc text; v_prio uuid; v_dept text; v_reason text; v_items text; v_with_proc boolean; v_from_dept uuid;
begin
  select * into r from public.purchase_requests where id = p_request_id;
  if r.id is null or r.proc_status is null or r.proc_status in ('LEGACY', 'DRAFT') or v_proc is null then return null; end if;
  perform set_config('mow.proc_task_sync', 'on', true);

  select d.name_en into v_dept from public.departments d where d.id = r.requesting_department_id;
  select string_agg(i.line_no || ') ' || coalesce(i.description, i.item_name) || coalesce(' — ' || i.qty_size, ''), '; ' order by i.line_no)
    into v_items from public.purchase_request_items i where i.purchase_request_id = r.id and i.line_no is not null;
  v_title := left('Procurement order ' || r.request_number || ': ' || coalesce(r.material_name, ''), 200);
  v_desc := 'Order ' || r.request_number || ' from ' || coalesce(v_dept, 'a department')
    || coalesce(' · client ' || nullif(r.client_name, ''), '') || '. Due ' || to_char(r.required_by_date, 'DD-MM-YYYY')
    || '. Priority ' || initcap(coalesce(r.priority, 'NORMAL')) || coalesce(' (' || coalesce(r.urgency_reason, r.emergency_reason) || ')', '') || '.'
    || coalesce(' Items: ' || v_items || '.', ' ' || coalesce(r.quantity::text || ' ' || r.unit, '') || '.')
    || coalesce(' Deliver to: ' || r.delivery_location || '.', '');
  select id into v_prio from public.priority_master where code = case when r.priority in ('URGENT', 'EMERGENCY') or r.is_emergency then 'URGENT'
                                                                      when r.priority in ('HIGH', 'LOW') then r.priority else 'NORMAL' end;
  v_with_proc := r.proc_status = any(public.proc_due_watch_statuses()) or r.proc_status = 'ON_HOLD' or r.proc_status = 'CLOSED'
                 or r.proc_status in ('RECEIVED', 'GRN_VERIFIED', 'INVOICE_VERIFIED', 'PAYMENT_PENDING', 'PARTIALLY_PAID', 'PAID');

  select * into t from public.staff_tasks where purchase_request_id = r.id for update;

  if t.id is null then
    v_owner := coalesce(case when exists (select 1 from public.user_profiles where id = r.proc_assigned_to and is_active) then r.proc_assigned_to end,
                        v_head, (public.proc_procurement_team())[1]);
    if v_owner is null then
      raise warning 'Order % has no Procurement task yet: there is no active Procurement staff member', r.request_number;
      perform set_config('mow.proc_task_sync', v_prev, true);
      return null;
    end if;
    v_from_person := coalesce(r.requester_user_id, (public.proc_department_heads(r.requesting_department_id))[1], v_owner);
    -- A confidential department (Accounts) cannot have Bridges: its order becomes an internal Procurement task, and the
    -- requester follows it on the order page.
    v_from_dept := case when exists (select 1 from public.departments where id = r.requesting_department_id and is_confidential_domain)
                        then v_proc else coalesce(r.requesting_department_id, v_proc) end;
    insert into public.staff_tasks (title, description, task_type_id, priority_id, status_id, proof_type_id, from_department_id, to_department_id,
      assigned_by, assigned_to, verifier_id, current_owner_id, reference_number, requirement_text, quantity, due_date, project_id, source_module,
      source_type, system_key, purchase_request_id, requires_acceptance, proof_instructions)
    values (v_title, v_desc, (select id from public.task_types where code = 'PURCHASE_REQUEST'), v_prio, public.proc_task_status_id('ASSIGNED'),
      (select id from public.proof_types where code = 'note'), v_from_dept, v_proc,
      v_from_person, v_owner, coalesce(v_head, v_owner), v_owner, r.request_number, left(coalesce(r.material_name, v_title), 500),
      case when r.order_form_type is not null then r.quantity::int || ' ' || r.unit else r.quantity || ' ' || coalesce(r.unit, '') end,
      r.required_by_date, r.project_id, 'procurement', 'purchase_request', 'PROC_ORDER:' || r.id, r.id, true,
      'Mark done on the order page once the goods are delivered and verified (GRN or direct delivery), with the PO and completion remarks.')
    on conflict (system_key) where system_key is not null do nothing;
    select * into t from public.staff_tasks where purchase_request_id = r.id for update;
    insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by)
    values (t.id, v_owner, 'primary', v_from_person) on conflict (task_id, user_id) do nothing;
    if t.is_bridge then
      insert into public.bridges (task_id, from_department_id, to_department_id, from_person_id, to_person_id, requirement_text, quantity)
      values (t.id, t.from_department_id, t.to_department_id, v_from_person, v_owner, t.requirement_text, t.quantity)
      on conflict (task_id) do nothing;
    end if;
    perform public.staff_write_audit('task', t.id, 'CREATE', null, jsonb_build_object('task_number', t.task_number, 'purchase_request_id', r.id,
      'request_number', r.request_number, 'is_bridge', t.is_bridge), v_proc, 'Created automatically from order ' || r.request_number);
    perform public.staff_post_system_task_message(t.id, 'Procurement task created for order ' || r.request_number || ', due ' || to_char(r.required_by_date, 'DD-MM-YYYY'),
      'ઓર્ડર ' || r.request_number || ' માટે ખરીદી કાર્ય બનાવાયું');
  end if;

  -- One due date (the order's), priority and description.
  if t.due_date is distinct from r.required_by_date or t.priority_id is distinct from v_prio or t.title is distinct from v_title or t.description is distinct from v_desc then
    update public.staff_tasks set due_date = r.required_by_date, priority_id = v_prio, title = v_title, description = v_desc where id = t.id;
  end if;

  v_code := public.proc_task_status_code(t.id);
  select remarks into v_reason from public.purchase_request_status_history where purchase_request_id = r.id and to_status = r.proc_status
   order by created_at desc limit 1;

  if r.proc_status = 'CANCELLED' then
    if t.is_active then
      update public.staff_tasks set is_active = false where id = t.id;
      update public.bridges set is_active = false where task_id = t.id;
      perform public.staff_post_system_task_message(t.id, 'Order cancelled: ' || coalesce(v_reason, ''), 'ઓર્ડર રદ');
    end if;

  elsif r.proc_status in ('REJECTED_BY_DEPT_HEAD', 'REJECTED_BY_PROCUREMENT', 'EMERGENCY_REJECTED', 'RETURNED_FOR_CORRECTION') then
    if v_code in ('ASSIGNED', 'ACCEPTED', 'PARTIALLY_ACCEPTED', 'IN_PROGRESS', 'ON_HOLD') then
      update public.staff_tasks set return_reason = left(public.proc_status_label(r.proc_status) || coalesce(': ' || v_reason, ''), 500),
        status_id = public.proc_task_status_id('RETURNED') where id = t.id;
      update public.bridges set acceptance_status = 'RETURNED', return_reason = left(coalesce(v_reason, public.proc_status_label(r.proc_status)), 500) where task_id = t.id;
    end if;

  elsif r.proc_status = 'CLOSED' then
    -- Completing the order completes the task -- but only if the assigned employee has marked the work done.
    if v_code not in ('COMPLETED', 'VERIFIED', 'CLOSED') then
      raise exception 'Order % cannot be completed yet: its Procurement task % has not been marked done by the assigned employee', r.request_number, t.task_number;
    end if;
    if v_code = 'COMPLETED' then
      update public.staff_tasks set verified_by = auth.uid(), status_id = public.proc_task_status_id('VERIFIED') where id = t.id;
      v_code := 'VERIFIED';
    end if;
    if v_code = 'VERIFIED' then
      update public.staff_tasks set closed_by = coalesce(auth.uid(), t.verifier_id), status_id = public.proc_task_status_id('CLOSED') where id = t.id;
      update public.bridges set verified_by = coalesce(auth.uid(), t.verifier_id), verified_at = now(), closed_at = now() where task_id = t.id;
      perform public.staff_post_system_task_message(t.id, 'Order completed and verified', 'ઓર્ડર પૂર્ણ અને ચકાસાયો');
      perform public.proc_notify_users(public.proc_department_heads(r.requesting_department_id)
          || case when r.project_id is not null then array[public.proc_project_manager_user(r.project_id)] else '{}'::uuid[] end, r.id,
        'Order ' || r.request_number || ' is completed and verified by Procurement', 'ઓર્ડર ' || r.request_number || ' પૂર્ણ થયો');
    end if;

  else
    -- Back in play after a correction: open again, owned by the Procurement Head until someone accepts.
    if v_code = 'RETURNED' then
      v_owner := coalesce(v_head, t.assigned_to);
      perform public.proc_task_set_owner(t.id, v_owner, false, auth.uid(), 'Order resubmitted');
      update public.staff_tasks set assigned_to = v_owner, current_owner_id = v_owner, accepted_by = null, return_reason = null,
        status_id = public.proc_task_status_id('ASSIGNED') where id = t.id;
      update public.bridges set acceptance_status = 'PENDING', to_person_id = v_owner, return_reason = null, accepted_at = null where task_id = t.id;
      update public.purchase_requests set proc_assigned_to = null where id = r.id;
      select * into t from public.staff_tasks where id = t.id;
      v_code := 'ASSIGNED';
    end if;
    if not t.is_active then
      update public.staff_tasks set is_active = true where id = t.id;
      update public.bridges set is_active = true where task_id = t.id;
    end if;
    -- With Procurement and nobody has accepted yet: every active Procurement member sees it in My Tasks.
    if v_with_proc and t.accepted_by is null and v_code = 'ASSIGNED' then
      perform public.proc_task_open_to_pool(t.id);
    end if;
    -- Procurement accepted the ORDER but nobody took the task: whoever accepted the order takes it.
    if r.proc_status in ('ACCEPTED_BY_PROCUREMENT', 'DOCUMENT_GENERATED') and t.accepted_by is null and v_code = 'ASSIGNED'
       and r.proc_decided_by is not null and exists (select 1 from public.user_profiles where id = r.proc_decided_by and is_active
                                                      and department_id = v_proc) then
      perform public.proc_take_order_task(t.id, r.proc_decided_by, auth.uid(), null);
      v_code := public.proc_task_status_code(t.id);
    end if;
    -- On hold and back.
    if r.proc_status = 'ON_HOLD' and v_code = 'IN_PROGRESS' then
      update public.staff_tasks set hold_reason = left(coalesce(v_reason, 'Order on hold'), 500), held_by = auth.uid(), held_at = now(),
        status_id = public.proc_task_status_id('ON_HOLD') where id = t.id;
    elsif r.proc_status <> 'ON_HOLD' and v_code = 'ON_HOLD' then
      update public.staff_tasks set status_id = public.proc_task_status_id('IN_PROGRESS') where id = t.id;
    end if;
  end if;

  perform set_config('mow.proc_task_sync', v_prev, true);
  return t.id;
end $$;

-- p_user takes the order task: only assignee, ACCEPTED then IN PROGRESS; the order's assigned staff and the bridge follow.
create or replace function public.proc_take_order_task(p_task_id uuid, p_user uuid, p_actor uuid, p_reason text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_prev text := coalesce(current_setting('mow.proc_task_sync', true), ''); v_name text; v_code text;
begin
  perform set_config('mow.proc_task_sync', 'on', true);
  select full_name into v_name from public.user_profiles where id = p_user;
  v_code := public.proc_task_status_code(p_task_id);
  perform public.proc_task_set_owner(p_task_id, p_user, true, p_actor, coalesce(p_reason, 'Accepted by ' || v_name));
  update public.staff_tasks set assigned_to = p_user, accepted_by = p_user, status_id = public.proc_task_status_id('ACCEPTED')
   where id = p_task_id and v_code in ('ASSIGNED', 'RETURNED', 'REOPENED');
  update public.staff_tasks set started_by = p_user, started_at = now(), status_id = public.proc_task_status_id('IN_PROGRESS') where id = p_task_id;
  update public.bridges set acceptance_status = 'ACCEPTED', accepted_at = now(), to_person_id = p_user where task_id = p_task_id;
  update public.purchase_requests set proc_assigned_to = p_user where id = (select purchase_request_id from public.staff_tasks where id = p_task_id);
  perform public.staff_post_system_task_message(p_task_id, 'Accepted by ' || v_name, v_name || ' દ્વારા સ્વીકારાયું');
  perform set_config('mow.proc_task_sync', v_prev, true);
end $$;

create or replace function public.proc_on_order_history()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.proc_sync_order_task(new.purchase_request_id);
  return null;
end $$;
drop trigger if exists purchase_request_status_history_task_sync on public.purchase_request_status_history;
create trigger purchase_request_status_history_task_sync after insert on public.purchase_request_status_history
  for each row execute function public.proc_on_order_history();

-- Edits to the order itself (corrected items, due date, priority) reach the task too.
create or replace function public.proc_on_order_update()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if exists (select 1 from public.staff_tasks where purchase_request_id = new.id) then
    perform public.proc_sync_order_task(new.id);
  end if;
  return null;
end $$;
drop trigger if exists purchase_requests_task_sync on public.purchase_requests;
create trigger purchase_requests_task_sync after update of required_by_date, priority, material_name, urgency_reason, client_name, delivery_location
  on public.purchase_requests for each row execute function public.proc_on_order_update();

-- ---------------------------------------------------------------------------
-- 4. Guard: order tasks change only through the Procurement workflow; their due date is always the order's
-- ---------------------------------------------------------------------------

create or replace function public.proc_task_guard()
returns trigger language plpgsql set search_path to 'public' as $$
declare v_due date; v_number text;
begin
  if new.purchase_request_id is null then return new; end if;
  select required_by_date, request_number into v_due, v_number from public.purchase_requests where id = new.purchase_request_id;
  if v_due is not null then new.due_date := v_due; end if;
  if coalesce(current_setting('mow.proc_task_sync', true), '') = 'on' then return new; end if;
  if new.status_id is distinct from old.status_id or new.assigned_to is distinct from old.assigned_to or new.current_owner_id is distinct from old.current_owner_id
     or new.is_active is distinct from old.is_active or new.verifier_id is distinct from old.verifier_id or new.to_department_id is distinct from old.to_department_id
     or new.from_department_id is distinct from old.from_department_id then
    raise exception 'Task % belongs to order %. Open the order to accept, reassign, complete or change it.', old.task_number, v_number;
  end if;
  return new;
end $$;
drop trigger if exists trg_a_proc_task_guard on public.staff_tasks;
create trigger trg_a_proc_task_guard before update on public.staff_tasks for each row execute function public.proc_task_guard();

create or replace function public.proc_task_assignee_guard()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if coalesce(current_setting('mow.proc_task_sync', true), '') = 'on' then return coalesce(new, old); end if;
  if exists (select 1 from public.staff_tasks where id = coalesce(new.task_id, old.task_id) and purchase_request_id is not null)
     and (tg_op <> 'UPDATE' or new.is_active is distinct from old.is_active or new.user_id is distinct from old.user_id
          or new.assignment_role is distinct from old.assignment_role) then
    raise exception 'People on an order task change only through the order (accept or assign)';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists trg_a_proc_task_assignee_guard on public.staff_task_assignees;
create trigger trg_a_proc_task_assignee_guard before insert or update or delete on public.staff_task_assignees
  for each row execute function public.proc_task_assignee_guard();

-- ---------------------------------------------------------------------------
-- 5. Accept, assign / reassign, mark done, reopen, change due date
-- ---------------------------------------------------------------------------

-- Any active Procurement member accepts an open order task. The task row is locked, so of two people pressing Accept at
-- the same moment the second one gets "already accepted by ...".
create or replace function public.proc_accept_order_task(p_request_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.purchase_requests; t public.staff_tasks; v_name text; v_head uuid := public.proc_procurement_head_user(); v_user uuid;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_member(), false) then raise exception 'Only Procurement staff can accept order tasks'; end if;
  select * into r from public.purchase_requests where id = p_request_id;
  if r.id is null then raise exception 'Order not found'; end if;
  if not (r.proc_status = any(public.proc_due_watch_statuses())) then
    raise exception 'Order % is not with Procurement (%)', r.request_number, public.proc_status_label(r.proc_status);
  end if;
  perform public.proc_sync_order_task(p_request_id);
  select * into t from public.staff_tasks where purchase_request_id = p_request_id for update;
  if t.id is null then raise exception 'This order has no Procurement task'; end if;
  if t.accepted_by is not null then
    raise exception 'This order task was already accepted by %', coalesce((select full_name from public.user_profiles where id = t.accepted_by), 'someone else');
  end if;
  perform public.proc_take_order_task(t.id, auth.uid(), auth.uid(), null);
  select full_name into v_name from public.user_profiles where id = auth.uid();
  insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
  values (r.id, r.proc_status, r.proc_status, auth.uid(), public.staff_current_role_code(), 'Task ' || t.task_number || ' accepted by ' || v_name);
  perform public.staff_write_audit('task', t.id, 'ACCEPT', jsonb_build_object('status', 'ASSIGNED'), jsonb_build_object('status', 'IN_PROGRESS', 'accepted_by', auth.uid()),
    t.to_department_id, 'Order ' || r.request_number);
  -- The Procurement Head and the rest of the team learn who took it; the requester learns who is handling it.
  for v_user in select distinct x from unnest(array[v_head] || public.proc_procurement_team()) x where x is not null loop
    perform public.staff_notify_assignment(v_user, 'PURCHASE_REQUEST', r.id, v_name || ' accepted order ' || r.request_number || ' (due ' || to_char(r.required_by_date, 'DD-MM-YYYY') || ')',
      v_name || ' એ ઓર્ડર ' || r.request_number || ' સ્વીકાર્યો');
  end loop;
  perform public.staff_notify_assignment(r.requester_user_id, 'PURCHASE_REQUEST', r.id, 'Your order ' || r.request_number || ' is being handled by ' || v_name || ' (Procurement)',
    'તમારો ઓર્ડર ' || r.request_number || ' ' || v_name || ' સંભાળે છે');
end $$;

-- Procurement Head / Supervisor / Management assign or reassign. Reassigning a task someone already accepted needs a reason.
-- An unaccepted task assigned to someone waits for them to accept; an accepted task moves to them as it is.
drop function if exists public.proc_assign_request(uuid, uuid);
create or replace function public.proc_assign_request(p_request_id uuid, p_user_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.purchase_requests; t public.staff_tasks; v_name text; v_old text; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_code text; v_prev text := coalesce(current_setting('mow.proc_task_sync', true), ''); v_note text;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_authorized() or public.staff_has_global_oversight(), false) then
    raise exception 'Only the Procurement Head, a Procurement Supervisor or Management can assign orders';
  end if;
  r := public.proc_lock_request(p_request_id);
  if not (r.proc_status = any(public.proc_due_watch_statuses())) and r.proc_status <> 'ON_HOLD' then
    raise exception 'Only an open order with Procurement can be assigned';
  end if;
  select full_name into v_name from public.user_profiles where id = p_user_id and is_active and department_id = public.factory_procurement_dept_id();
  if v_name is null then raise exception 'Assign the order to an active Procurement staff member'; end if;
  perform public.proc_sync_order_task(p_request_id);
  select * into t from public.staff_tasks where purchase_request_id = p_request_id for update;
  if t.assigned_to = p_user_id and (t.accepted_by is not null or r.proc_assigned_to = p_user_id) then raise exception 'The order is already assigned to %', v_name; end if;
  if t.accepted_by is not null and v_reason is null then raise exception 'Give the reason for reassigning this order'; end if;
  select full_name into v_old from public.user_profiles where id = coalesce(case when t.accepted_by is not null then t.assigned_to end, r.proc_assigned_to);
  v_note := case when v_old is not null then 'Reassigned from ' || v_old || ' to ' || v_name else 'Assigned to ' || v_name end || coalesce(': ' || v_reason, '');

  perform set_config('mow.proc_task_sync', 'on', true);
  v_code := public.proc_task_status_code(t.id);
  if t.accepted_by is null then
    perform public.proc_task_set_owner(t.id, p_user_id, false, auth.uid(), v_note);
    update public.staff_tasks set assigned_to = p_user_id, current_owner_id = p_user_id where id = t.id;
  else
    perform public.proc_task_set_owner(t.id, p_user_id, true, auth.uid(), v_note);
    update public.staff_tasks set assigned_to = p_user_id,
      current_owner_id = case when v_code in ('COMPLETED', 'VERIFIED') then current_owner_id else p_user_id end where id = t.id;
  end if;
  update public.bridges set to_person_id = p_user_id where task_id = t.id;
  update public.purchase_requests set proc_assigned_to = p_user_id where id = p_request_id;
  perform set_config('mow.proc_task_sync', v_prev, true);

  insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
  values (p_request_id, r.proc_status, r.proc_status, auth.uid(), public.staff_current_role_code(), v_note);
  perform public.staff_write_audit('purchase_request', p_request_id, 'ASSIGN', jsonb_build_object('proc_assigned_to', r.proc_assigned_to, 'task_assigned_to', t.assigned_to),
    jsonb_build_object('proc_assigned_to', p_user_id), r.requesting_department_id, v_reason);
  perform public.staff_post_system_task_message(t.id, v_note, 'સોંપણી: ' || v_name);
  perform public.proc_notify_users(array[p_user_id], p_request_id,
    'Order ' || r.request_number || ' is assigned to you' || case when t.accepted_by is null then ' — please accept it' else '' end || '. '
      || public.proc_due_text(r.required_by_date, public.proc_today_ist()) || '. Status: ' || public.proc_status_label(r.proc_status) || '.',
    'ઓર્ડર ' || r.request_number || ' તમને સોંપાયો');
  if t.accepted_by is not null and t.assigned_to <> p_user_id then
    perform public.proc_notify_users((select coalesce(array_agg(distinct x), '{}') from unnest(array[t.assigned_to, public.proc_procurement_head_user(), r.requester_user_id]) x
                                      where x is not null and x <> p_user_id), p_request_id,
      'Order ' || r.request_number || ': ' || v_note, 'ઓર્ડર ' || r.request_number || ' નવી વ્યક્તિને સોંપાયો');
  end if;
end $$;

-- The assigned employee (or the Procurement Head / Management) marks the work done -- only once the goods are delivered and
-- verified and a placed order exists. The order then waits for the Procurement Head to verify and complete it.
create or replace function public.proc_finish_order_task(p_request_id uuid, p_remarks text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.purchase_requests; t public.staff_tasks; v_block text; v_remarks text := nullif(btrim(coalesce(p_remarks, '')), ''); v_code text;
  v_name text; v_prev text := coalesce(current_setting('mow.proc_task_sync', true), '');
begin
  perform public.staff_assert_operational();
  select * into r from public.purchase_requests where id = p_request_id for update;
  if r.id is null then raise exception 'Order not found'; end if;
  select * into t from public.staff_tasks where purchase_request_id = p_request_id for update;
  if t.id is null then raise exception 'This order has no Procurement task'; end if;
  if not (t.assigned_to = auth.uid() and t.accepted_by is not null) and not coalesce(public.proc_is_procurement_head() or public.staff_has_global_oversight(), false) then
    raise exception 'Only the Procurement employee handling this order (or the Procurement Head) can mark it done';
  end if;
  v_block := public.proc_task_completion_blocker(r);
  if v_block is not null then raise exception 'Not yet: %', v_block; end if;
  if v_remarks is null then raise exception 'Completion remarks are required'; end if;
  v_code := public.proc_task_status_code(t.id);
  if v_code in ('COMPLETED', 'VERIFIED', 'CLOSED') then raise exception 'This task is already marked done'; end if;
  perform set_config('mow.proc_task_sync', 'on', true);
  if t.accepted_by is null then perform public.proc_take_order_task(t.id, auth.uid(), auth.uid(), null); end if;
  if public.proc_task_status_code(t.id) in ('ACCEPTED', 'REOPENED', 'ON_HOLD') then
    update public.staff_tasks set status_id = public.proc_task_status_id('IN_PROGRESS') where id = t.id;
  end if;
  update public.staff_task_assignees set individual_status = 'COMPLETED', completed_at = now(), completion_note = v_remarks where task_id = t.id and is_active;
  update public.staff_tasks set completion_note = v_remarks, completed_by = auth.uid(), status_id = public.proc_task_status_id('COMPLETED') where id = t.id;
  update public.bridges set completed_at = now() where task_id = t.id;
  perform set_config('mow.proc_task_sync', v_prev, true);
  select full_name into v_name from public.user_profiles where id = auth.uid();
  insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
  values (r.id, r.proc_status, r.proc_status, auth.uid(), public.staff_current_role_code(), 'Task ' || t.task_number || ' marked done by ' || v_name || ': ' || v_remarks);
  perform public.staff_write_audit('task', t.id, 'COMPLETE', null, jsonb_build_object('completed_by', auth.uid(), 'remarks', v_remarks), t.to_department_id, 'Order ' || r.request_number);
  perform public.staff_post_system_task_message(t.id, 'Marked done by ' || v_name || ': ' || v_remarks, v_name || ' દ્વારા પૂર્ણ ચિહ્નિત');
  perform public.proc_notify_users(array[public.proc_procurement_head_user()], r.id,
    'Verify order ' || r.request_number || ': ' || v_name || ' marked the Procurement work done. ' || v_remarks,
    'ઓર્ડર ' || r.request_number || ' ચકાસો');
end $$;

-- Procurement Head / Management reopen a task marked done by mistake, or a completed order (it returns to the status it
-- had before completion).
create or replace function public.proc_reopen_order_task(p_request_id uuid, p_reason text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.purchase_requests; t public.staff_tasks; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_code text; v_back text;
  v_prev text := coalesce(current_setting('mow.proc_task_sync', true), '');
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_head() or public.staff_has_global_oversight(), false) then
    raise exception 'Only the Procurement Head or Management can reopen an order task';
  end if;
  if v_reason is null then raise exception 'A reason is required to reopen'; end if;
  select * into r from public.purchase_requests where id = p_request_id for update;
  select * into t from public.staff_tasks where purchase_request_id = p_request_id for update;
  if t.id is null then raise exception 'This order has no Procurement task'; end if;
  v_code := public.proc_task_status_code(t.id);
  if v_code not in ('COMPLETED', 'VERIFIED', 'CLOSED') then raise exception 'Only a task marked done or completed can be reopened'; end if;
  perform set_config('mow.proc_task_sync', 'on', true);
  update public.staff_tasks set reopen_reason = left(v_reason, 500), reopened_by = auth.uid(), reopened_at = now(),
    status_id = public.proc_task_status_id('REOPENED') where id = t.id;
  update public.staff_tasks set status_id = public.proc_task_status_id('IN_PROGRESS'), completed_by = null, completed_at = null,
    current_owner_id = assigned_to where id = t.id;
  update public.staff_task_assignees set individual_status = 'IN_PROGRESS', completed_at = null where task_id = t.id and is_active;
  update public.bridges set completed_at = null, verified_at = null, verified_by = null, closed_at = null where task_id = t.id;
  perform set_config('mow.proc_task_sync', v_prev, true);
  if r.proc_status = 'CLOSED' then
    select from_status into v_back from public.purchase_request_status_history where purchase_request_id = r.id and to_status = 'CLOSED'
     order by created_at desc limit 1;
    perform public.proc_set_status(r.id, 'CLOSED', coalesce(v_back, 'GRN_VERIFIED'), 'Reopened: ' || v_reason);
  else
    insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
    values (r.id, r.proc_status, r.proc_status, auth.uid(), public.staff_current_role_code(), 'Task ' || t.task_number || ' reopened: ' || v_reason);
  end if;
  perform public.staff_write_audit('task', t.id, 'REOPEN', jsonb_build_object('status', v_code), jsonb_build_object('status', 'IN_PROGRESS'), t.to_department_id, v_reason);
  perform public.staff_post_system_task_message(t.id, 'Reopened: ' || v_reason, 'ફરી ખોલ્યું: ' || v_reason);
  perform public.proc_notify_users((select coalesce(array_agg(distinct x), '{}') from unnest(array[t.assigned_to, r.requester_user_id]) x where x is not null), r.id,
    'Order ' || r.request_number || ' was reopened: ' || v_reason,
    'ઓર્ડર ' || r.request_number || ' ફરી ખોલાયો');
end $$;

-- One authoritative due date. The requesting department's Head, the Procurement Head / Supervisor or Management change it,
-- with a reason; the old date stays in the order's history and the task follows automatically.
create or replace function public.proc_change_due_date(p_request_id uuid, p_new_date date, p_reason text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.purchase_requests; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_name text; v_msg text;
begin
  perform public.staff_assert_operational();
  select * into r from public.purchase_requests where id = p_request_id for update;
  if r.id is null or r.proc_status = 'LEGACY' then raise exception 'Order not found'; end if;
  if not coalesce(public.proc_is_procurement_authorized() or public.staff_has_global_oversight()
                  or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(r.requesting_department_id)), false) then
    raise exception 'Only the department''s Head, the Procurement Head or Management can change the due date';
  end if;
  if r.proc_status in ('CLOSED', 'CANCELLED', 'REJECTED_BY_DEPT_HEAD', 'REJECTED_BY_PROCUREMENT', 'EMERGENCY_REJECTED') then
    raise exception 'The order is closed';
  end if;
  if p_new_date is null or p_new_date < public.proc_today_ist() then raise exception 'The new due date must be today or later'; end if;
  if p_new_date = r.required_by_date then raise exception 'That is already the due date'; end if;
  if v_reason is null then raise exception 'A reason is required to change the due date'; end if;
  update public.purchase_requests set required_by_date = p_new_date, overdue_since = null, proc_updated_at = now() where id = p_request_id;
  update public.purchase_request_items set required_by_date = p_new_date where purchase_request_id = p_request_id;
  select full_name into v_name from public.user_profiles where id = auth.uid();
  v_msg := 'Due date changed from ' || to_char(r.required_by_date, 'DD-MM-YYYY') || ' to ' || to_char(p_new_date, 'DD-MM-YYYY') || ' by ' || v_name || ': ' || v_reason;
  insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
  values (p_request_id, r.proc_status, r.proc_status, auth.uid(), public.staff_current_role_code(), v_msg);
  perform public.staff_write_audit('purchase_request', p_request_id, 'DUE_DATE', jsonb_build_object('required_by_date', r.required_by_date),
    jsonb_build_object('required_by_date', p_new_date), r.requesting_department_id, v_reason);
  perform public.proc_notify_users((select coalesce(array_agg(distinct x), '{}') from unnest(array[r.proc_assigned_to, public.proc_procurement_head_user(), r.requester_user_id]) x
                                      where x is not null), p_request_id,
    'Order ' || r.request_number || ': ' || v_msg, 'ઓર્ડર ' || r.request_number || ' ની ડ્યુ તારીખ બદલાઈ: ' || to_char(p_new_date, 'DD-MM-YYYY'));
end $$;

-- "Accept" in My Tasks on an order task does the Procurement accept above. Otherwise unchanged from the live definition.
create or replace function public.staff_accept_task(p_task_id uuid)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid; v_actor_name text; v_my_row record; v_row record;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  if v_task.purchase_request_id is not null then
    perform public.proc_accept_order_task(v_task.purchase_request_id);
    return;
  end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;
  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;
  if v_my_row.id is null then
    raise exception 'You are not an active assignee on this task';
  end if;

  if v_old_code not in ('ASSIGNED','RETURNED','REOPENED') then
    if v_old_code in ('ACCEPTED','IN_PROGRESS','ON_HOLD','COMPLETED','VERIFIED','CLOSED') then
      raise exception 'This task was already accepted by %', coalesce((select full_name from public.user_profiles where id = v_task.accepted_by), 'another assignee');
    end if;
    raise exception 'Task must be ASSIGNED, RETURNED, or REOPENED to accept (currently %)', v_old_code;
  end if;

  update public.staff_task_assignees set acceptance_status = 'ACCEPTED', accepted_at = now(),
    individual_status = case when individual_status in ('ASSIGNED','REJECTED') then 'ACCEPTED' else individual_status end
    where id = v_my_row.id;

  select id into v_status_id from public.status_master where code = 'ACCEPTED';
  update public.staff_tasks set status_id = v_status_id, accepted_by = auth.uid()
    where id = p_task_id and status_id = v_task.status_id;

  if v_task.is_bridge then
    update public.bridges set acceptance_status = 'ACCEPTED', accepted_at = now() where task_id = p_task_id;
  end if;

  perform public.staff_write_audit('task', p_task_id, 'ACCEPT', jsonb_build_object('status', v_old_code), jsonb_build_object('status','ACCEPTED','accepted_by', auth.uid()), v_task.to_department_id);
  perform public.staff_post_system_task_message(p_task_id, 'Accepted by ' || v_actor_name, v_actor_name || ' દ્વારા સ્વીકારાયું');

  perform public.staff_notify_assignment(v_task.assigned_by, 'task', p_task_id, 'Task accepted: ' || v_task.task_number, 'કામ સ્વીકાર્યું: ' || v_task.task_number);
  for v_row in select user_id from public.staff_task_assignees where task_id = p_task_id and is_active loop
    perform public.staff_notify_assignment(v_row.user_id, 'task', p_task_id, v_actor_name || ' accepted shared task ' || v_task.task_number, v_actor_name || ' એ સહિયારું કાર્ય સ્વીકાર્યું ' || v_task.task_number);
  end loop;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. What screens show: the task, bridge and stage of each order
-- ---------------------------------------------------------------------------

create or replace function public.proc_order_task_info(p_request_ids uuid[])
returns table (request_id uuid, task_id uuid, task_number text, task_status text, stage text, assigned_to uuid, assigned_name text,
  accepted_by uuid, accepted_by_name text, accepted_at timestamptz, completed_by_name text, completed_at timestamptz, completion_note text,
  verified_by_name text, verified_at timestamptz, bridge_id uuid, bridge_number text, procurement_head_name text, open_to_count integer,
  can_accept boolean, can_finish boolean, finish_blocker text, task_due_date date)
language sql stable security definer set search_path to 'public' as $$
  select r.id, t.id, t.task_number, sm.code,
         public.proc_task_stage(r.proc_status, sm.code, t.accepted_by is not null, r.delivered_to_client_at is not null),
         t.assigned_to, asg.full_name, t.accepted_by, acc.full_name, t.accepted_at, cb.full_name, t.completed_at, t.completion_note,
         vb.full_name, t.verified_at, b.id, b.bridge_number, (select full_name from public.user_profiles where id = public.proc_procurement_head_user()),
         (select count(*)::int from public.staff_task_assignees a where a.task_id = t.id and a.is_active),
         t.id is not null and t.accepted_by is null and sm.code = 'ASSIGNED' and r.proc_status = any(public.proc_due_watch_statuses())
           and coalesce(public.proc_is_procurement_member(), false),
         t.id is not null and sm.code not in ('COMPLETED', 'VERIFIED', 'CLOSED') and public.proc_task_completion_blocker(r) is null
           and ((t.assigned_to = auth.uid() and t.accepted_by is not null) or coalesce(public.proc_is_procurement_head() or public.staff_has_global_oversight(), false)),
         case when t.id is not null and sm.code not in ('COMPLETED', 'VERIFIED', 'CLOSED') then public.proc_task_completion_blocker(r) end,
         t.due_date
    from public.purchase_requests r
    left join public.staff_tasks t on t.purchase_request_id = r.id
    left join public.status_master sm on sm.id = t.status_id
    left join public.bridges b on b.task_id = t.id
    left join public.user_profiles asg on asg.id = t.assigned_to
    left join public.user_profiles acc on acc.id = t.accepted_by
    left join public.user_profiles cb on cb.id = t.completed_by
    left join public.user_profiles vb on vb.id = t.verified_by
   where r.id = any(p_request_ids) and public.proc_can_view_request(r.id);
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants, guard columns, backfill
-- ---------------------------------------------------------------------------

revoke all on function public.proc_task_set_owner(uuid, uuid, boolean, uuid, text), public.proc_task_open_to_pool(uuid),
  public.proc_sync_order_task(uuid), public.proc_take_order_task(uuid, uuid, uuid, text), public.proc_on_order_history(), public.proc_on_order_update(),
  public.proc_task_completion_blocker(public.purchase_requests) from public, anon, authenticated;
revoke all on function public.proc_accept_order_task(uuid), public.proc_assign_request(uuid, uuid, text), public.proc_finish_order_task(uuid, text),
  public.proc_reopen_order_task(uuid, text), public.proc_change_due_date(uuid, date, text), public.proc_order_task_info(uuid[]) from public, anon;
grant execute on function public.proc_accept_order_task(uuid), public.proc_assign_request(uuid, uuid, text), public.proc_finish_order_task(uuid, text),
  public.proc_reopen_order_task(uuid, text), public.proc_change_due_date(uuid, date, text), public.proc_order_task_info(uuid[]),
  public.proc_task_stage(text, text, boolean, boolean), public.proc_task_status_id(text), public.proc_task_status_code(uuid) to authenticated;

-- Every order already with a department or Procurement gets its task now (live has none yet; this keeps re-runs safe).
do $$
declare v_id uuid;
begin
  for v_id in select id from public.purchase_requests where proc_status not in ('LEGACY', 'DRAFT') loop
    perform public.proc_sync_order_task(v_id);
  end loop;
end $$;

commit;
