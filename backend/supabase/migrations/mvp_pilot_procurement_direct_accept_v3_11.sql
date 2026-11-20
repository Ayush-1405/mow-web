-- Procurement takes orders directly: any active Procurement employee may accept an order as soon as the department
-- raises it -- Department Head approval is no longer a precondition. Accepting assigns it to that employee and moves the
-- order straight to Accepted (history says it was taken without Department Head approval; the department's Heads are
-- told). Until someone in Procurement takes it, the Department Head can still approve, return or reject it as before.
-- A pending order is in every Procurement member's My Tasks as OPEN. Emergency orders keep their Management approval.
-- The four functions are the live definitions with only these changes.

begin;

CREATE OR REPLACE FUNCTION public.proc_accept_order_task(p_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.purchase_requests; t public.staff_tasks; v_name text; v_head uuid := public.proc_procurement_head_user(); v_user uuid; v_mine boolean := false;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_member(), false) then raise exception 'Only Procurement staff can accept order tasks'; end if;
  select * into r from public.purchase_requests where id = p_request_id for update;
  if r.id is null then raise exception 'Order not found'; end if;
  -- (v3_11) also straight from the department: no Department Head approval is needed for Procurement to take an order.
  if not (r.proc_status = any(public.proc_due_watch_statuses()) or r.proc_status = 'PENDING_DEPT_APPROVAL') then
    raise exception 'Order % is not with Procurement (%)', r.request_number, public.proc_status_label(r.proc_status);
  end if;
  perform public.proc_sync_order_task(p_request_id);
  select * into t from public.staff_tasks where purchase_request_id = p_request_id for update;
  if t.id is null then raise exception 'This order has no Procurement task'; end if;
  if t.accepted_by is not null then
    -- The owner pressing Accept again (e.g. after a clarification came back) only accepts the order.
    if t.assigned_to = auth.uid() and r.proc_status = 'SENT_TO_PROCUREMENT' then
      v_mine := true;
    else
      raise exception 'This order task was already accepted by %', coalesce((select full_name from public.user_profiles where id = t.accepted_by), 'someone else');
    end if;
  end if;
  select full_name into v_name from public.user_profiles where id = auth.uid();
  if not v_mine then
    perform public.proc_take_order_task(t.id, auth.uid(), auth.uid(), null);
    insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
    values (r.id, r.proc_status, r.proc_status, auth.uid(), public.staff_current_role_code(), 'Task ' || t.task_number || ' accepted by ' || v_name);
    perform public.staff_write_audit('task', t.id, 'ACCEPT', jsonb_build_object('status', 'ASSIGNED'), jsonb_build_object('status', 'IN_PROGRESS', 'accepted_by', auth.uid()),
      t.to_department_id, 'Order ' || r.request_number);
  end if;

  -- The order itself is accepted by Procurement now (unless it is waiting for a clarification from the requester).
  if r.proc_status in ('SENT_TO_PROCUREMENT', 'PENDING_DEPT_APPROVAL') then
    update public.purchase_requests set proc_decided_by = auth.uid(), proc_decided_at = now(), proc_decision_remarks = null,
      sent_to_procurement_at = coalesce(sent_to_procurement_at, now()) where id = r.id;
    perform public.proc_set_status(r.id, r.proc_status, 'ACCEPTED_BY_PROCUREMENT',
      case when r.proc_status = 'PENDING_DEPT_APPROVAL'
           then 'Accepted directly by ' || v_name || ' (Procurement task ' || t.task_number || ') — Department Head approval not required'
           else 'Accepted by ' || v_name || ' (Procurement task ' || t.task_number || ')' end);
    perform public.proc_notify_users(public.proc_department_heads(r.requesting_department_id), r.id,
      'Procurement accepted order ' || r.request_number || ': ' || r.material_name || ' — handled by ' || v_name
        || case when r.proc_status = 'PENDING_DEPT_APPROVAL' then ' (taken directly; your approval was not needed)' else '' end,
      'ઓર્ડર ' || r.request_number || ' ખરીદી વિભાગે સ્વીકાર્યો');
  end if;

  if not v_mine then
    for v_user in select distinct x from unnest(array[v_head] || public.proc_procurement_team()) x where x is not null loop
      perform public.staff_notify_assignment(v_user, 'PURCHASE_REQUEST', r.id, v_name || ' accepted order ' || r.request_number || ' (due ' || to_char(r.required_by_date, 'DD-MM-YYYY') || ')',
        v_name || ' એ ઓર્ડર ' || r.request_number || ' સ્વીકાર્યો');
    end loop;
  end if;
  perform public.staff_notify_assignment(r.requester_user_id, 'PURCHASE_REQUEST', r.id,
    'Procurement accepted your order ' || r.request_number || '. It is being handled by ' || v_name || ' (Procurement)',
    'તમારો ઓર્ડર ' || r.request_number || ' સ્વીકારાયો; ' || v_name || ' સંભાળે છે');
end $function$;

CREATE OR REPLACE FUNCTION public.proc_sync_order_task(p_request_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_with_proc := r.proc_status = any(public.proc_due_watch_statuses()) or r.proc_status in ('ON_HOLD', 'CLOSED', 'PENDING_DEPT_APPROVAL')
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
end $function$;

CREATE OR REPLACE FUNCTION public.proc_order_task_info(p_request_ids uuid[])
 RETURNS TABLE(request_id uuid, task_id uuid, task_number text, task_status text, stage text, assigned_to uuid, assigned_name text, accepted_by uuid, accepted_by_name text, accepted_at timestamp with time zone, completed_by_name text, completed_at timestamp with time zone, completion_note text, verified_by_name text, verified_at timestamp with time zone, bridge_id uuid, bridge_number text, procurement_head_name text, open_to_count integer, can_accept boolean, can_finish boolean, finish_blocker text, task_due_date date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select r.id, t.id, t.task_number, sm.code,
         public.proc_task_stage(r.proc_status, sm.code, t.accepted_by is not null, r.delivered_to_client_at is not null),
         t.assigned_to, asg.full_name, t.accepted_by, acc.full_name, t.accepted_at, cb.full_name, t.completed_at, t.completion_note,
         vb.full_name, t.verified_at, b.id, b.bridge_number, (select full_name from public.user_profiles where id = public.proc_procurement_head_user()),
         (select count(*)::int from public.staff_task_assignees a where a.task_id = t.id and a.is_active),
         t.id is not null and t.accepted_by is null and sm.code = 'ASSIGNED' and (r.proc_status = any(public.proc_due_watch_statuses()) or r.proc_status = 'PENDING_DEPT_APPROVAL')
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
$function$;

CREATE OR REPLACE FUNCTION public.proc_task_stage(p_status text, p_task_code text, p_accepted boolean, p_direct_delivery boolean)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case
    when p_status = 'DRAFT' then 'DRAFT'
    when p_status = 'PENDING_DEPT_APPROVAL' then case when p_accepted then 'ACCEPTED' else 'OPEN' end
    when p_status in ('EMERGENCY_APPROVAL_PENDING', 'APPROVED_BY_DEPT_HEAD') then 'WAITING_APPROVAL'
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
$function$;

-- Orders already waiting for their Department Head: open them to the Procurement team now.
do $$
declare v_id uuid;
begin
  for v_id in select id from public.purchase_requests where proc_status = 'PENDING_DEPT_APPROVAL' loop
    perform public.proc_sync_order_task(v_id);
  end loop;
end $$;

commit;
