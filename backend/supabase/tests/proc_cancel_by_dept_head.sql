-- v3_33 Cancel a purchase order: the requesting department's head may cancel an order already placed with a vendor; a head of another
-- department, the requester and an ordinary staff member may not; nobody may cancel once goods are received; a reason is required;
-- the order's task closes and the buyer is told to inform the vendor. Own fixtures; ALWAYS rolls back.
do $t$
declare
  v_log text := ''; msg text; ok boolean; n int;
  r_emp uuid; r_head uuid; d_int uuid; d_ret uuid; d_proc uuid; pr uuid; pr2 uuid;
  u_head uuid := gen_random_uuid(); u_rhead uuid := gen_random_uuid(); u_req uuid := gen_random_uuid(); u_buyer uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal1')::text, true); end $f$;
  -- tries the cancel as p_user; returns null when it worked, else the error text
  create function public.zz_cancel(p_user uuid, p_id uuid, p_reason text) returns text language plpgsql as $f$
    begin
      perform public.zz_as(p_user);
      set local role authenticated;
      perform public.proc_cancel_request(p_id, p_reason);
      reset role;
      return null;
    exception when others then
      reset role;
      return sqlerrm;
    end $f$;

  select id into r_emp from roles where code = 'employee';
  select id into r_head from roles where code = 'dept_head';
  select id into d_int from departments where code = 'INTERIOR' limit 1;
  select id into d_ret from departments where code = 'RETAIL' limit 1;
  select id into d_proc from departments where code = 'PROCUREMENT' limit 1;
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_head, u_rhead, u_req, u_buyer]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_head,  'ZZ-CX-H', 'ZZ Interior Head',  r_head, d_int,  '9888880201', false, true),
    (u_rhead, 'ZZ-CX-R', 'ZZ Retail Head',    r_head, d_ret,  '9888880202', false, true),
    (u_req,   'ZZ-CX-Q', 'ZZ Interior Staff', r_emp,  d_int,  '9888880203', false, true),
    (u_buyer, 'ZZ-CX-B', 'ZZ Buyer',          r_emp,  d_proc, '9888880204', false, true);

  -- an Interior order already placed with a vendor, and one already received
  insert into purchase_requests (request_number, purchase_source, requester_user_id, requesting_department_id, request_date, status, proc_status,
                                 material_name, quantity, unit, required_by_date, priority, proc_assigned_to)
  values ('ZZ-CX-1', 'Procurement', u_req, d_int, current_date, 'Procurement', 'ORDER_PLACED', 'ZZ laminate', 4, 'pcs', current_date + 3, 'NORMAL', u_buyer)
  returning id into pr;
  insert into purchase_requests (request_number, purchase_source, requester_user_id, requesting_department_id, request_date, status, proc_status,
                                 material_name, quantity, unit, required_by_date, priority, proc_assigned_to)
  values ('ZZ-CX-2', 'Procurement', u_req, d_int, current_date, 'Procurement', 'RECEIVED', 'ZZ hinges', 10, 'pcs', current_date + 3, 'NORMAL', u_buyer)
  returning id into pr2;
  perform public.proc_sync_order_task(pr);   -- the order's task, as the workflow creates it

  msg := public.zz_cancel(u_req, pr, 'changed my mind');
  v_log := public.zz_chk(v_log, 'the requester cannot cancel an order already placed (' || coalesce(msg, 'it worked') || ')', msg is not null);
  msg := public.zz_cancel(u_rhead, pr, 'not ours');
  v_log := public.zz_chk(v_log, 'a head of ANOTHER department cannot cancel it', msg is not null);
  msg := public.zz_cancel(u_head, pr, '   ');
  v_log := public.zz_chk(v_log, 'a reason is required (' || coalesce(msg, 'it worked') || ')', msg ilike '%reason%');
  msg := public.zz_cancel(u_head, pr2, 'too late');
  v_log := public.zz_chk(v_log, 'nobody can cancel once goods are received (' || coalesce(msg, 'it worked') || ')', msg ilike '%received%');
  v_log := public.zz_chk(v_log, '... and the received order is unchanged', (select proc_status from purchase_requests where id = pr2) = 'RECEIVED');

  msg := public.zz_cancel(u_head, pr, 'Client changed the size');
  v_log := public.zz_chk(v_log, 'the Interior Department Head CAN cancel the placed Interior order (' || coalesce(msg, 'worked') || ')', msg is null);
  v_log := public.zz_chk(v_log, 'order is CANCELLED with the reason in its history',
    (select proc_status from purchase_requests where id = pr) = 'CANCELLED'
    and exists (select 1 from purchase_request_status_history where purchase_request_id = pr and to_status = 'CANCELLED'
                 and from_status = 'ORDER_PLACED' and remarks = 'Client changed the size' and actor_id = u_head));
  select count(*) into n from staff_tasks where system_key = 'PROC_ORDER:' || pr and is_active;
  v_log := public.zz_chk(v_log, 'the order''s task is removed from everyone''s list', n = 0
    and exists (select 1 from staff_tasks where system_key = 'PROC_ORDER:' || pr));
  v_log := public.zz_chk(v_log, 'the buyer is told to inform the vendor',
    exists (select 1 from notifications where recipient_id = u_buyer and entity_id = pr and title_en ilike '%inform the vendor%'));
  v_log := public.zz_chk(v_log, 'the requester is told too', exists (select 1 from notifications where recipient_id = u_req and entity_id = pr));
  v_log := public.zz_chk(v_log, 'the head who cancelled is not notified about their own action',
    not exists (select 1 from notifications where recipient_id = u_head and entity_id = pr));
  msg := public.zz_cancel(u_head, pr, 'again');
  v_log := public.zz_chk(v_log, 'an already-cancelled order cannot be cancelled again', msg is not null);

  raise exception E'\n%', v_log;
end $t$;
