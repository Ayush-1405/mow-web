-- v3_29 Interior AI: the agent is built and on and follows its switch and the emergency stop; the interior data its tools read is
-- limited by row-level security (a staff member who is not on a project and not organisation-wide sees none of it).
-- Own fixtures; ALWAYS rolls back (report in the error).
do $t$
declare
  v_log text := ''; n int; n_all int; r_staff uuid; d1 uuid;
  u_a uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal1')::text, true); end $f$;

  update mai_settings set ai_enabled = true where id = 1;
  update mai_agents set enabled = true where code = 'TOOLS';
  v_log := public.zz_chk(v_log, 'Interior AI is marked built and on', (select is_built and enabled from mai_agents where code = 'INTERIOR') and public.mai_agent_enabled('INTERIOR'));
  update mai_agents set enabled = false where code = 'INTERIOR';
  v_log := public.zz_chk(v_log, 'switched off in the Control Center: off', not public.mai_agent_enabled('INTERIOR'));
  update mai_agents set enabled = true where code = 'INTERIOR';
  update mai_settings set ai_enabled = false where id = 1;
  v_log := public.zz_chk(v_log, 'emergency stop: off', not public.mai_agent_enabled('INTERIOR'));
  update mai_settings set ai_enabled = true where id = 1;
  v_log := public.zz_chk(v_log, 'the other department agents are still not built', not exists (select 1 from mai_agents where built_in_phase = 'H' and code <> 'INTERIOR' and is_built));

  select count(*) into n_all from projects where not archived;
  select id into r_staff from roles where code not in ('management', 'admin', 'director', 'interior_head') and is_active order by code limit 1;
  select id into d1 from departments where code = 'RETAIL' limit 1;
  insert into auth.users (id, email, aud, role) values (u_a, 'zz-' || u_a || '@test.invalid', 'authenticated', 'authenticated');
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active)
  values (u_a, 'ZZ-IN-A', 'ZZ Retail Staff', r_staff, d1, '9888880001', false, true);
  perform public.zz_as(u_a); set local role authenticated;
  select count(*) into n from projects;
  select n + count(*) into n from site_reports;
  select n + count(*) into n from project_materials;
  select n + count(*) into n from snags;
  reset role;
  v_log := public.zz_chk(v_log, 'a staff member not on any project sees no projects, site reports, materials or snags (row-level security)', n = 0 and n_all > 0);

  raise exception E'\n%', v_log;
end $t$;
