-- v3_32 Procurement AI: the agent is built and on and follows its switch and the emergency stop; the purchase requests its tools
-- read are limited by row-level security: a request raised in one department is not visible to an ordinary staff member of
-- another department (nor its items or history), and ordinary staff are not shown costing. Own fixtures; ALWAYS rolls back.
do $t$
declare
  v_log text := ''; n int; n_all int; r_staff uuid; d_int uuid; d_ret uuid; pr uuid; ok boolean;
  u_req uuid := gen_random_uuid(); u_other uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal1')::text, true); end $f$;

  update mai_settings set ai_enabled = true where id = 1;
  update mai_agents set enabled = true where code = 'TOOLS';
  v_log := public.zz_chk(v_log, 'Procurement AI is marked built and on', (select is_built and enabled from mai_agents where code = 'PROCUREMENT') and public.mai_agent_enabled('PROCUREMENT'));
  update mai_agents set enabled = false where code = 'PROCUREMENT';
  v_log := public.zz_chk(v_log, 'switched off in the Control Center: off', not public.mai_agent_enabled('PROCUREMENT'));
  update mai_agents set enabled = true where code = 'PROCUREMENT';
  update mai_settings set ai_enabled = false where id = 1;
  v_log := public.zz_chk(v_log, 'emergency stop: off', not public.mai_agent_enabled('PROCUREMENT'));
  update mai_settings set ai_enabled = true where id = 1;
  v_log := public.zz_chk(v_log, 'no agent can be on without being built', not exists (select 1 from mai_agents where enabled and not is_built));

  select id into r_staff from roles where code = 'employee';   -- an ordinary staff member (Accounts staff see every request by design)
  select id into d_int from departments where code = 'INTERIOR' limit 1;
  select id into d_ret from departments where code = 'RETAIL' limit 1;
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_req, u_other]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_req, 'ZZ-PA-R', 'ZZ Interior Requester', r_staff, d_int, '9888880101', false, true),
    (u_other, 'ZZ-PA-O', 'ZZ Retail Staff', r_staff, d_ret, '9888880102', false, true);
  insert into purchase_requests (request_number, purchase_source, requester_user_id, requesting_department_id, request_date, status, proc_status,
                                 material_name, quantity, unit, required_by_date, priority, order_total)
  values ('ZZ-PR-1', 'Procurement', u_req, d_int, current_date, 'Procurement', 'SENT_TO_PROCUREMENT', 'ZZ plywood', 5, 'sheets', current_date + 3, 'NORMAL', 12345)
  returning id into pr;
  insert into purchase_request_items (purchase_request_id, item_name, quantity, unit, line_no) values (pr, 'ZZ plywood 18mm', 5, 'sheets', 1);
  insert into purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id) values (pr, null, 'SENT_TO_PROCUREMENT', u_req);

  perform public.zz_as(u_req); set local role authenticated;
  select count(*) into n_all from purchase_requests where id = pr;
  reset role;
  perform public.zz_as(u_other); set local role authenticated;
  select count(*) into n from purchase_requests where id = pr;
  select n + count(*) into n from purchase_request_items where purchase_request_id = pr;
  select n + count(*) into n from purchase_request_status_history where purchase_request_id = pr;
  ok := not coalesce(public.purchase_costing_can_view(), false);
  reset role;
  v_log := public.zz_chk(v_log, 'the requester sees their request', n_all = 1);
  v_log := public.zz_chk(v_log, 'a staff member of another department cannot see it, its items or history (row-level security)', n = 0);
  v_log := public.zz_chk(v_log, 'ordinary staff are not allowed to see costing, so the AI leaves amounts out', ok);

  raise exception E'\n%', v_log;
end $t$;
