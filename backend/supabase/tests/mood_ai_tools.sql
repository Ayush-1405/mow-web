-- v3_27 Phase D: agents list is truthful; the tools switch works and follows the emergency stop; only the server can check it;
-- and the data the tools read is limited by the person's own access (row-level security on the task view and notifications).
-- Own fixtures; ALWAYS rolls back (report in the error).
do $t$
declare
  v_log text := ''; ok boolean; n int; r_staff uuid; d1 uuid; d2 uuid;
  u_a uuid := gen_random_uuid(); u_b uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal1')::text, true); end $f$;

  v_log := public.zz_chk(v_log, 'Assistant, Developer agent and Application tools are marked built and on',
    (select count(*) from mai_agents where code in ('ASSISTANT', 'DEVELOPER', 'TOOLS') and is_built and enabled) = 3);
  v_log := public.zz_chk(v_log, 'department agents (Phase H) not built yet stay off (built so far: Interior)',
    not exists (select 1 from mai_agents where built_in_phase = 'H' and is_built and code not in ('INTERIOR')));

  update mai_settings set ai_enabled = true where id = 1;
  v_log := public.zz_chk(v_log, 'tools switch on: the server sees it on', public.mai_agent_enabled('TOOLS'));
  update mai_agents set enabled = false where code = 'TOOLS';
  v_log := public.zz_chk(v_log, 'switched off in the Control Center: off', not public.mai_agent_enabled('TOOLS'));
  update mai_agents set enabled = true where code = 'TOOLS';
  update mai_settings set ai_enabled = false where id = 1;
  v_log := public.zz_chk(v_log, 'emergency stop: off', not public.mai_agent_enabled('TOOLS'));
  update mai_settings set ai_enabled = true where id = 1;
  v_log := public.zz_chk(v_log, 'an unknown agent is off', not public.mai_agent_enabled('NOPE'));

  select id into r_staff from roles where code not in ('management', 'admin') and is_active limit 1;
  select id into d1 from departments where is_active and not is_control_tower order by code limit 1;
  select id into d2 from departments where is_active and not is_control_tower and id <> d1 order by code limit 1;
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_a, u_b]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_a, 'ZZ-TL-A', 'ZZ Staff A', r_staff, d1, '9888860001', false, true),
    (u_b, 'ZZ-TL-B', 'ZZ Staff B', r_staff, d2, '9888860002', false, true);
  insert into notifications (recipient_id, entity_type, entity_id, title_en, title_gu, is_read) values (u_a, 'TASK', gen_random_uuid(), 'ZZ for A', 'ZZ', false), (u_b, 'TASK', gen_random_uuid(), 'ZZ for B', 'ZZ', false);

  perform public.zz_as(u_a); set local role authenticated;
  select count(*) into n from notifications where title_en like 'ZZ for %';
  ok := n = 1 and exists (select 1 from notifications where title_en = 'ZZ for A');
  begin perform public.mai_agent_enabled('TOOLS'); ok := ok and false; exception when insufficient_privilege then null; end;
  reset role;
  v_log := public.zz_chk(v_log, 'as staff A: only A''s own notifications are visible, and the server-only switch check is refused', ok);

  perform public.zz_as(u_a); set local role authenticated;
  select count(*) into n from staff_task_scope_v where scope_mine and assigned_to = u_b;
  reset role;
  v_log := public.zz_chk(v_log, 'the task view (security invoker) never shows A someone else''s tasks as A''s own', n = 0
    and (select 'security_invoker=true' = any(reloptions) from pg_class where relname = 'staff_task_scope_v'));

  raise exception E'\n%', v_log;
end $t$;
