-- v3_30 Factory AI: the agent is built and on and follows its switch and the emergency stop; the job cards its tools read are
-- limited by row-level security: a job card requested by one department is not visible to an ordinary staff member of another
-- department. Own fixtures; ALWAYS rolls back (report in the error).
do $t$
declare
  v_log text := ''; n int; n_all int; r_staff uuid; d_int uuid; d_ret uuid; jc uuid;
  u_req uuid := gen_random_uuid(); u_other uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal1')::text, true); end $f$;

  update mai_settings set ai_enabled = true where id = 1;
  update mai_agents set enabled = true where code = 'TOOLS';
  v_log := public.zz_chk(v_log, 'Factory AI is marked built and on', (select is_built and enabled from mai_agents where code = 'FACTORY') and public.mai_agent_enabled('FACTORY'));
  update mai_agents set enabled = false where code = 'FACTORY';
  v_log := public.zz_chk(v_log, 'switched off in the Control Center: off', not public.mai_agent_enabled('FACTORY'));
  update mai_agents set enabled = true where code = 'FACTORY';
  update mai_settings set ai_enabled = false where id = 1;
  v_log := public.zz_chk(v_log, 'emergency stop: off', not public.mai_agent_enabled('FACTORY'));
  update mai_settings set ai_enabled = true where id = 1;
  v_log := public.zz_chk(v_log, 'no agent can be on without being built', not exists (select 1 from mai_agents where enabled and not is_built));

  select id into r_staff from roles where code not in ('management', 'admin', 'director') and is_active order by code limit 1;
  select id into d_int from departments where code = 'INTERIOR' limit 1;
  select id into d_ret from departments where code = 'RETAIL' limit 1;
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_req, u_other]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_req, 'ZZ-FA-R', 'ZZ Interior Requester', r_staff, d_int, '9888890001', false, true),
    (u_other, 'ZZ-FA-O', 'ZZ Retail Staff', r_staff, d_ret, '9888890002', false, true);
  insert into inhouse_production_requests (job_order_number, product_item, source_department_id, requested_by, factory_status, required_completion_date)
  values ('ZZ-JC-1', 'ZZ wardrobe', d_int, u_req, 'pending_verification', current_date + 7) returning id into jc;
  select count(*) into n_all from factory_job_cards_v where id = jc;

  perform public.zz_as(u_other); set local role authenticated;
  select count(*) into n from factory_job_cards_v where id = jc;
  select n + count(*) into n from factory_job_items where job_id = jc;
  reset role;
  v_log := public.zz_chk(v_log, 'a staff member of another department cannot see the job card (row-level security)', n = 0 and n_all = 1);

  perform public.zz_as(u_other); set local role authenticated;
  select count(*) into n from public.factory_my_actions() a where a.job_id = jc;
  reset role;
  v_log := public.zz_chk(v_log, 'and it is not in their "waiting on me" list', n = 0);

  raise exception E'\n%', v_log;
end $t$;
