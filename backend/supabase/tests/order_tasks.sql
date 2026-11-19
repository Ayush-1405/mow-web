-- Orders become Procurement tasks (v3_07): one task + one Bridge per order, Procurement pool, transaction-safe accept,
-- synchronised due date, completion only after delivery + verification, Head verification, reassignment, reopen, reject and
-- cancel. Own fixtures; ALWAYS rolls back (the report is in the error message).

do $t$
declare
  v_log text := ''; n int; v_day date; v_pr public.purchase_requests; v_row public.purchase_requests; v_id uuid; v_id2 uuid; v_id3 uuid;
  v_task public.staff_tasks; v_info record; v_txt text;
  r_emp uuid; r_head uuid; r_mgmt uuid; d_int uuid; d_proc uuid; d_ret uuid;
  u_e uuid := gen_random_uuid(); u_h uuid := gen_random_uuid(); u_ph uuid := gen_random_uuid(); u_p1 uuid := gen_random_uuid();
  u_p2 uuid := gen_random_uuid(); u_r uuid := gen_random_uuid(); u_m uuid := gen_random_uuid();
  v_items jsonb := '[{"item_code":"PLY-18","description":"Plywood 18 mm BWP","qty_size":"10 sheets","quantity":"10","rate":"850"}]';
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true); end $f$;
  create function public.zz_task(p_req uuid) returns public.staff_tasks language sql as $f$
    select * from public.staff_tasks where purchase_request_id = p_req $f$;
  create function public.zz_tcode(p_req uuid) returns text language sql as $f$
    select sm.code from public.staff_tasks t join public.status_master sm on sm.id = t.status_id where t.purchase_request_id = p_req $f$;
  v_day := public.proc_today_ist();
  select id into r_emp from roles where code = 'employee';
  select id into r_head from roles where code = 'dept_head';
  select id into r_mgmt from roles where code = 'management';
  select id into d_int from departments where code = 'INTERIOR';
  select id into d_proc from departments where code = 'PROCUREMENT';
  select id into d_ret from departments where code = 'RETAIL';
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_e, u_h, u_ph, u_p1, u_p2, u_r, u_m]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_e, 'ZZ-OT-E', 'ZZ Interior Employee', r_emp, d_int, '9844400001', false, true),
    (u_h, 'ZZ-OT-H', 'ZZ Interior Head', r_head, d_int, '9844400002', false, true),
    (u_ph, 'ZZ-OT-P', 'ZZ Procurement Head', r_head, d_proc, '9844400003', false, true),
    (u_p1, 'ZZ-OT-1', 'ZZ Procurement One', r_emp, d_proc, '9844400004', false, true),
    (u_p2, 'ZZ-OT-2', 'ZZ Procurement Two', r_emp, d_proc, '9844400005', false, true),
    (u_r, 'ZZ-OT-R', 'ZZ Retail Employee', r_emp, d_ret, '9844400006', false, true),
    (u_m, 'ZZ-OT-M', 'ZZ Management', r_mgmt, (select department_id from user_profiles up join roles r on r.id = up.role_id where r.code = 'management' limit 1), '9844400007', false, true);
  update procurement_settings set primary_head_user_id = u_ph where id;

  ---------------------------------------------------------------- TEST 1: an order creates exactly one task and one Bridge
  perform public.zz_as(u_e); set local role authenticated;
  v_pr := public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'client_name', 'Mr. Shah', 'required_completion_date', v_day + 5,
    'delivery_location', 'Shah site', 'priority', 'HIGH', 'urgency_reason', 'Carpenter starts Monday'), v_items);
  v_id := v_pr.id;
  reset role;
  v_task := public.zz_task(v_id);
  v_log := public.zz_chk(v_log, 'T1  one Procurement task created with the order (Interior -> Procurement, PURCHASE_REQUEST, same due date)',
    (select count(*) from staff_tasks where purchase_request_id = v_id) = 1 and v_task.system_key = 'PROC_ORDER:' || v_id
    and v_task.from_department_id = d_int and v_task.to_department_id = d_proc and v_task.due_date = v_day + 5 and v_task.reference_number = v_pr.request_number
    and v_task.assigned_by = u_e and public.zz_tcode(v_id) = 'ASSIGNED'
    and (select code from task_types where id = v_task.task_type_id) = 'PURCHASE_REQUEST' and (select code from priority_master where id = v_task.priority_id) = 'HIGH');
  v_log := public.zz_chk(v_log, 'T1  one Cross-Department Bridge: Interior requester -> Procurement',
    (select count(*) from bridges where task_id = v_task.id) = 1
    and (select from_person_id = u_e and from_department_id = d_int and to_department_id = d_proc and acceptance_status = 'PENDING' from bridges where task_id = v_task.id));
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.staff_accept_task(v_task.id); v_log := public.zz_chk(v_log, 'T1  nobody can accept before the Department Head approves', false);
  exception when others then v_log := public.zz_chk(v_log, 'T1  nobody can accept before the Department Head approves', sqlerrm ilike '%not with Procurement%'); end;
  reset role;

  ---------------------------------------------------------------- TEST 2: approved -> every Procurement member sees it
  perform public.zz_as(u_h); set local role authenticated; perform public.proc_dept_decision(v_id, 'APPROVE', null); reset role;
  v_log := public.zz_chk(v_log, 'T2  after approval every active Procurement member is on the task',
    (select count(*) from staff_task_assignees where task_id = v_task.id and is_active and user_id in (u_ph, u_p1, u_p2)) = 3);
  perform public.zz_as(u_p2); set local role authenticated;
  select count(*) into n from staff_task_scope_v where id = v_task.id and scope_mine;
  select * into v_info from public.proc_order_task_info(array[v_id]);
  reset role;
  v_log := public.zz_chk(v_log, 'T2  a Procurement employee sees it in My Tasks as OPEN and may accept it', n = 1 and v_info.stage = 'OPEN' and v_info.can_accept);
  perform public.zz_as(u_r); set local role authenticated;
  select count(*) into n from staff_tasks where id = v_task.id;
  reset role;
  v_log := public.zz_chk(v_log, 'T2  an unrelated Retail employee cannot see it', n = 0);

  ---------------------------------------------------------------- TEST 3 / 4: accept (from My Tasks) and the second accept
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.staff_accept_task(v_task.id);
  exception when others then v_log := public.zz_chk(v_log, 'T3  accept: ' || sqlerrm, false); end;
  reset role;
  v_task := public.zz_task(v_id);
  v_log := public.zz_chk(v_log, 'T3  the first to accept owns it: assigned, accepted_by/at saved, IN PROGRESS, others removed',
    v_task.assigned_to = u_p1 and v_task.accepted_by = u_p1 and v_task.accepted_at is not null and v_task.current_owner_id = u_p1
    and public.zz_tcode(v_id) = 'IN_PROGRESS'
    and (select count(*) from staff_task_assignees where task_id = v_task.id and is_active) = 1
    and (select proc_assigned_to from purchase_requests where id = v_id) = u_p1
    and (select acceptance_status = 'ACCEPTED' and to_person_id = u_p1 from bridges where task_id = v_task.id));
  v_log := public.zz_chk(v_log, 'T3  the Procurement Head and the requester are told who took it',
    (select count(*) from notifications where entity_id = v_id and recipient_id = u_ph and title_en like 'ZZ Procurement One accepted order%') = 1
    and (select count(*) from notifications where entity_id = v_id and recipient_id = u_e and title_en like '%is being handled by ZZ Procurement One%') = 1);
  perform public.zz_as(u_p2); set local role authenticated;
  begin perform public.staff_accept_task(v_task.id); v_log := public.zz_chk(v_log, 'T4  a second person cannot accept the same task', false);
  exception when others then v_log := public.zz_chk(v_log, 'T4  a second person cannot accept the same task', sqlerrm ilike '%already accepted by ZZ Procurement One%'); end;
  begin perform public.proc_accept_order_task(v_id); v_log := public.zz_chk(v_log, 'T4  ... nor through the order page', false);
  exception when others then v_log := public.zz_chk(v_log, 'T4  ... nor through the order page', sqlerrm ilike '%already accepted%'); end;
  reset role;

  ---------------------------------------------------------------- TEST 5 / 6: one due date everywhere; changing it
  perform public.zz_as(u_p1); set local role authenticated;
  select * into v_info from public.proc_order_task_info(array[v_id]);
  v_log := public.zz_chk(v_log, 'T5  order, task (My Tasks view) and Bridge task show the same due date',
    v_info.task_due_date = v_day + 5 and (select due_date from staff_task_scope_v where id = v_task.id) = v_day + 5
    and (select t.due_date from bridges b join staff_tasks t on t.id = b.task_id where b.task_id = v_task.id) = v_day + 5);
  reset role;
  update staff_tasks set due_date = v_day + 30 where id = v_task.id;
  v_log := public.zz_chk(v_log, 'T5  even a direct edit cannot give the task a different due date', (public.zz_task(v_id)).due_date = v_day + 5);
  perform public.zz_as(u_e); set local role authenticated;
  begin perform public.proc_change_due_date(v_id, v_day + 8, 'Site delayed'); v_log := public.zz_chk(v_log, 'T6  the requester (employee) cannot change the due date', false);
  exception when others then v_log := public.zz_chk(v_log, 'T6  the requester (employee) cannot change the due date', true); end;
  reset role;
  perform public.zz_as(u_h); set local role authenticated;
  begin perform public.proc_change_due_date(v_id, v_day + 8, ''); v_log := public.zz_chk(v_log, 'T6  a due-date change needs a reason', false);
  exception when others then v_log := public.zz_chk(v_log, 'T6  a due-date change needs a reason', sqlerrm ilike '%reason%'); end;
  begin perform public.proc_change_due_date(v_id, v_day + 8, 'Site handover moved');
  exception when others then v_log := public.zz_chk(v_log, 'T6  change: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'T6  the Department Head moves it: order, task and history updated together',
    (select required_by_date from purchase_requests where id = v_id) = v_day + 8 and (public.zz_task(v_id)).due_date = v_day + 8
    and (select count(*) from purchase_request_status_history where purchase_request_id = v_id
           and remarks like 'Due date changed from ' || to_char(v_day + 5, 'DD-MM-YYYY') || ' to ' || to_char(v_day + 8, 'DD-MM-YYYY') || ' by ZZ Interior Head: Site handover moved') = 1);
  v_log := public.zz_chk(v_log, 'T6  the assigned employee, Procurement Head and requester are notified',
    (select count(distinct recipient_id) from notifications where entity_id = v_id and title_en like '%Due date changed from%' and recipient_id in (u_p1, u_ph, u_e)) = 3);

  ---------------------------------------------------------------- TEST 7 / 8: accepted and ordered is not done
  -- (v3_08) accepting the task already accepted the order for the employee who took it.
  v_log := public.zz_chk(v_log, 'T7  the order was accepted with the task, by that employee; the task is still IN PROGRESS',
    (select proc_status from purchase_requests where id = v_id) = 'ACCEPTED_BY_PROCUREMENT' and (select proc_decided_by from purchase_requests where id = v_id) = u_p1
    and (public.zz_task(v_id)).assigned_to = u_p1 and public.zz_tcode(v_id) = 'IN_PROGRESS');
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.proc_finish_order_task(v_id, 'done'); v_log := public.zz_chk(v_log, 'T7  accepted but not ordered: cannot be marked done', false);
  exception when others then v_log := public.zz_chk(v_log, 'T7  accepted but not ordered: cannot be marked done', sqlerrm ilike '%not been placed%'); end;
  begin perform public.staff_complete_task(v_task.id, null::text); v_log := public.zz_chk(v_log, 'T7  the generic Complete in My Tasks is refused for order tasks', false);
  exception when others then v_log := public.zz_chk(v_log, 'T7  the generic Complete in My Tasks is refused for order tasks: ' || left(sqlerrm, 90), sqlerrm ilike '%order%'); end;
  begin perform public.staff_return_task(v_task.id, 'not mine'); v_log := public.zz_chk(v_log, 'T7  the generic Return is refused for order tasks', false);
  exception when others then v_log := public.zz_chk(v_log, 'T7  the generic Return is refused for order tasks: ' || left(sqlerrm, 90), sqlerrm ilike '%order%'); end;
  reset role;
  perform public.zz_as(u_ph); set local role authenticated;
  perform public.proc_record_print(v_id, 'PURCHASE_REQUEST');
  perform public.proc_confirm_order(v_id, 'Century Ply Dealer', '9876500333', 'Q-55', 'ZZPO-OT-1', v_day, 10, 8500, v_day + 6, 'Cash', 'ok');
  reset role;
  select * into v_info from public.proc_order_task_info(array[v_id]);
  v_log := public.zz_chk(v_log, 'T8  order placed, material not received: task stays IN PROGRESS, stage ORDER PLACED',
    public.zz_tcode(v_id) = 'IN_PROGRESS' and v_info.stage = 'ORDER_PLACED' and not v_info.can_finish);
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.proc_finish_order_task(v_id, 'done'); v_log := public.zz_chk(v_log, 'T8  ordered but not delivered: cannot be marked done', false);
  exception when others then v_log := public.zz_chk(v_log, 'T8  ordered but not delivered: cannot be marked done', sqlerrm ilike '%not been fully delivered%'); end;
  perform public.proc_update_progress(v_id, 'IN_TRANSIT', 'Dispatched', 'VRL', 'GJ03 1234', null, v_day, v_day + 2);
  reset role;
  v_log := public.zz_chk(v_log, 'T8  in transit shows as IN TRANSIT', (select stage from public.proc_order_task_info(array[v_id])) = 'IN_TRANSIT');
  select * into v_row from purchase_requests where id = v_id;
  v_row.proc_status := 'RECEIVED'; v_row.delivered_to_client_at := null;
  v_log := public.zz_chk(v_log, 'T8  received at the Godown without a verified GRN cannot be completed (WAITING FOR GRN)',
    public.proc_task_completion_blocker(v_row) ilike '%GRN%' and public.proc_task_stage('RECEIVED', 'IN_PROGRESS', true, false) = 'WAITING_FOR_GRN');

  ---------------------------------------------------------------- reassignment by the Procurement Head
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.proc_assign_request(v_id, u_p2, 'leave'); v_log := public.zz_chk(v_log, 'an employee cannot reassign', false);
  exception when others then v_log := public.zz_chk(v_log, 'an employee cannot reassign', true); end;
  reset role;
  perform public.zz_as(u_ph); set local role authenticated;
  begin perform public.proc_assign_request(v_id, u_p2); v_log := public.zz_chk(v_log, 'reassigning an accepted task needs a reason', false);
  exception when others then v_log := public.zz_chk(v_log, 'reassigning an accepted task needs a reason', sqlerrm ilike '%reason%'); end;
  begin perform public.proc_assign_request(v_id, u_p2, 'ZZ One on leave');
  exception when others then v_log := public.zz_chk(v_log, 'reassign: ' || sqlerrm, false); end;
  reset role;
  v_task := public.zz_task(v_id);
  v_log := public.zz_chk(v_log, 'the Head reassigns with a reason: new owner, history kept, both notified',
    v_task.assigned_to = u_p2 and v_task.current_owner_id = u_p2 and v_task.accepted_by = u_p1
    and (select array_agg(user_id) from staff_task_assignees where task_id = v_task.id and is_active) = array[u_p2]
    and (select proc_assigned_to from purchase_requests where id = v_id) = u_p2
    and (select count(*) from purchase_request_status_history where purchase_request_id = v_id and remarks = 'Reassigned from ZZ Procurement One to ZZ Procurement Two: ZZ One on leave') = 1
    and (select count(*) from notifications where entity_id = v_id and recipient_id = u_p2 and title_en like '%assigned to you%') = 1
    and (select count(*) from notifications where entity_id = v_id and recipient_id = u_p1 and title_en like '%Reassigned from%') = 1);

  ---------------------------------------------------------------- TEST 9 / 10 / 13: delivered and verified -> done -> Head completes
  perform public.zz_as(u_p2); set local role authenticated;
  perform public.proc_mark_delivered(v_id, v_day, 'Delivered at site');
  reset role;
  select * into v_info from public.proc_order_task_info(array[v_id]);
  v_log := public.zz_chk(v_log, 'T9  delivered and recorded: completion becomes available (COMPLETION PENDING)', v_info.stage = 'COMPLETION_PENDING' and v_info.finish_blocker is null);
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.proc_finish_order_task(v_id, 'done'); v_log := public.zz_chk(v_log, 'T13 the previous assignee cannot complete another employee''s task', false);
  exception when others then v_log := public.zz_chk(v_log, 'T13 the previous assignee cannot complete another employee''s task', sqlerrm ilike '%Only the Procurement employee handling%'); end;
  reset role;
  perform public.zz_as(u_r); set local role authenticated;
  begin perform public.proc_finish_order_task(v_id, 'done'); v_log := public.zz_chk(v_log, 'T13 an unrelated employee cannot complete it', false);
  exception when others then v_log := public.zz_chk(v_log, 'T13 an unrelated employee cannot complete it', true); end;
  reset role;
  perform public.zz_as(u_p2); set local role authenticated;
  begin perform public.proc_finish_order_task(v_id, ' '); v_log := public.zz_chk(v_log, 'T9  completion remarks are required', false);
  exception when others then v_log := public.zz_chk(v_log, 'T9  completion remarks are required', sqlerrm ilike '%remarks%'); end;
  begin perform public.proc_finish_order_task(v_id, 'All 10 sheets delivered and checked at site');
  exception when others then v_log := public.zz_chk(v_log, 'T9  finish: ' || sqlerrm, false); end;
  begin perform public.proc_complete_order(v_id, 'self'); v_log := public.zz_chk(v_log, 'T13 an employee cannot verify and complete the order', false);
  exception when others then v_log := public.zz_chk(v_log, 'T13 an employee cannot verify and complete the order', true); end;
  reset role;
  v_task := public.zz_task(v_id);
  v_log := public.zz_chk(v_log, 'T10 marked done: task COMPLETED (by, at, remarks); order still open waiting for the Head',
    public.zz_tcode(v_id) = 'COMPLETED' and v_task.completed_by = u_p2 and v_task.completed_at is not null
    and v_task.completion_note = 'All 10 sheets delivered and checked at site' and (select proc_status from purchase_requests where id = v_id) = 'RECEIVED'
    and (select count(*) from notifications where entity_id = v_id and recipient_id = u_ph and title_en like 'Verify order%') = 1);
  -- The Head reopens it (found a short delivery), then the order cannot be completed until it is marked done again.
  perform public.zz_as(u_ph); set local role authenticated;
  begin perform public.proc_reopen_order_task(v_id, ''); v_log := public.zz_chk(v_log, 'reopening needs a reason', false);
  exception when others then v_log := public.zz_chk(v_log, 'reopening needs a reason', sqlerrm ilike '%reason%'); end;
  perform public.proc_reopen_order_task(v_id, 'One sheet damaged, replacement pending');
  v_log := public.zz_chk(v_log, 'the Head reopens a task marked done -> IN PROGRESS again', public.zz_tcode(v_id) = 'IN_PROGRESS');
  begin perform public.proc_complete_order(v_id, 'try'); v_log := public.zz_chk(v_log, 'T10 the order cannot be completed while the task is not done', false);
  exception when others then v_log := public.zz_chk(v_log, 'T10 the order cannot be completed while the task is not done', sqlerrm ilike '%has not been marked done%'); end;
  reset role;
  perform public.zz_as(u_p2); set local role authenticated; perform public.proc_finish_order_task(v_id, 'Replacement sheet delivered'); reset role;
  perform public.zz_as(u_ph); set local role authenticated;
  begin perform public.proc_complete_order(v_id, 'Verified');
  exception when others then v_log := public.zz_chk(v_log, 'T10 complete: ' || sqlerrm, false); end;
  reset role;
  v_task := public.zz_task(v_id);
  v_log := public.zz_chk(v_log, 'T10 the Head verifies: order COMPLETED, task CLOSED (verified by the Head), Bridge closed',
    (select proc_status from purchase_requests where id = v_id) = 'CLOSED' and public.zz_tcode(v_id) = 'CLOSED' and v_task.verified_by = u_ph
    and v_task.closed_by = u_ph and (select closed_at is not null and verified_by = u_ph from bridges where task_id = v_task.id)
    and (select stage from public.proc_order_task_info(array[v_id])) = 'COMPLETED');
  v_log := public.zz_chk(v_log, 'T10 the requesting department is told it is completed',
    (select count(*) from notifications where entity_id = v_id and recipient_id = u_h and title_en like '%completed and verified by Procurement%') = 1
    and (select count(*) from notifications where entity_id = v_id and recipient_id = u_e and title_en like 'Order completed%') = 1);

  ---------------------------------------------------------------- TEST 11: the requester sees real progress
  perform public.zz_as(u_e); set local role authenticated;
  select * into v_info from public.proc_order_task_info(array[v_id]);
  select count(*) into n from staff_task_scope_v where id = v_task.id;
  reset role;
  v_log := public.zz_chk(v_log, 'T11 the requester sees the task, stage, who handled it and the completion',
    n = 1 and v_info.stage = 'COMPLETED' and v_info.assigned_name = 'ZZ Procurement Two' and v_info.accepted_by_name = 'ZZ Procurement One'
    and v_info.completed_by_name = 'ZZ Procurement Two' and v_info.verified_by_name = 'ZZ Procurement Head' and v_info.bridge_number is not null);
  perform public.zz_as(u_h); set local role authenticated;
  select count(*) into n from bridges where task_id = v_task.id;
  reset role;
  v_log := public.zz_chk(v_log, 'T11 the requesting Department Head sees the Bridge', n = 1);

  ---------------------------------------------------------------- TEST 12: repeated events never duplicate
  perform public.proc_sync_order_task(v_id); perform public.proc_sync_order_task(v_id); perform public.proc_sync_order_task(v_id);
  insert into purchase_request_status_history (purchase_request_id, from_status, to_status, remarks) values (v_id, 'CLOSED', 'CLOSED', 'ZZ duplicate event');
  v_log := public.zz_chk(v_log, 'T12 repeated sync / duplicate events: still one task and one Bridge',
    (select count(*) from staff_tasks where purchase_request_id = v_id) = 1 and (select count(*) from bridges where task_id = v_task.id) = 1);
  begin
    insert into staff_tasks (title, task_type_id, priority_id, status_id, proof_type_id, from_department_id, to_department_id, assigned_by, assigned_to,
      verifier_id, current_owner_id, due_date, system_key)
    values ('dup', v_task.task_type_id, v_task.priority_id, v_task.status_id, v_task.proof_type_id, d_int, d_proc, u_e, u_ph, u_ph, u_ph, v_day, 'PROC_ORDER:' || v_id);
    v_log := public.zz_chk(v_log, 'T12 the database refuses a second task for the same order', false);
  exception when unique_violation then v_log := public.zz_chk(v_log, 'T12 the database refuses a second task for the same order', true); end;

  ---------------------------------------------------------------- rejection, return-and-resubmit, cancellation
  perform public.zz_as(u_e); set local role authenticated;
  v_id2 := (public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'client_name', 'Mrs. Patel', 'required_completion_date', v_day + 9,
    'delivery_location', 'Patel site'), '[{"description":"Laminate 1 mm","qty_size":"6 sheets"}]')).id;
  v_id3 := (public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'client_name', 'Mr. Rao', 'required_completion_date', v_day + 9,
    'delivery_location', 'Rao site'), '[{"description":"Edge band","qty_size":"2 rolls"}]')).id;
  perform public.proc_cancel_request(v_id3, 'Client cancelled');
  reset role;
  v_log := public.zz_chk(v_log, 'a cancelled order''s task and Bridge are withdrawn',
    not (public.zz_task(v_id3)).is_active and not (select is_active from bridges where task_id = (public.zz_task(v_id3)).id));
  perform public.zz_as(u_h); set local role authenticated; perform public.proc_dept_decision(v_id2, 'APPROVE', null); reset role;
  perform public.zz_as(u_ph); set local role authenticated; perform public.proc_procurement_decision(v_id2, 'RETURN', 'Give the laminate code'); reset role;
  v_log := public.zz_chk(v_log, 'returned for correction: task RETURNED to the requester with the reason, Bridge RETURNED',
    public.zz_tcode(v_id2) = 'RETURNED' and (public.zz_task(v_id2)).current_owner_id = u_e and (public.zz_task(v_id2)).return_reason like '%Give the laminate code%'
    and (select acceptance_status from bridges where task_id = (public.zz_task(v_id2)).id) = 'RETURNED');
  perform public.zz_as(u_e); set local role authenticated;
  perform public.proc_update_order(v_id2, jsonb_build_object('form_type', 'INTERIOR', 'client_name', 'Mrs. Patel', 'required_completion_date', v_day + 9,
    'delivery_location', 'Patel site'), '[{"item_code":"LAM-1101","description":"Laminate 1 mm","qty_size":"6 sheets"}]');
  perform public.proc_submit_request(v_id2);
  reset role;
  perform public.zz_as(u_h); set local role authenticated; perform public.proc_dept_decision(v_id2, 'APPROVE', null); reset role;
  v_log := public.zz_chk(v_log, 'resubmitted and approved: the same task is OPEN again for the whole Procurement team',
    (select count(*) from staff_tasks where purchase_request_id = v_id2) = 1 and public.zz_tcode(v_id2) = 'ASSIGNED' and (public.zz_task(v_id2)).accepted_by is null
    and (select count(*) from staff_task_assignees where task_id = (public.zz_task(v_id2)).id and is_active and user_id in (u_ph, u_p1, u_p2)) = 3);
  perform public.zz_as(u_ph); set local role authenticated; perform public.proc_procurement_decision(v_id2, 'REJECT', 'Not stocked by any vendor'); reset role;
  v_log := public.zz_chk(v_log, 'rejected by Procurement: task RETURNED with the reason', public.zz_tcode(v_id2) = 'RETURNED'
    and (public.zz_task(v_id2)).return_reason like 'Rejected by Procurement: Not stocked by any vendor');

  ---------------------------------------------------------------- TEST 14: server-side reminders
  v_log := public.zz_chk(v_log, 'T14 reminders run on the server every 15 minutes and follow the task owner',
    exists (select 1 from cron.job where jobname = 'procurement-order-reminders' and active)
    and exists (select 1 from procurement_reminders where purchase_request_id = v_id and kind = 'ACCEPT_NEW' and recipient_id = u_p1));

  raise exception E'\n%', v_log;
end $t$;
