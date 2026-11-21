-- v3_19 Mood AI Core: owner verification (own account + authenticator check), emergency stop / resume, backup approver rules,
-- unbuilt agents stay off, settings validation, append-only usage and audit, server-only functions, cost calculation.
-- Own fixtures; the real Owner row is parked for the test. ALWAYS rolls back (the report is in the error message).
do $t$
declare
  v_log text := ''; v jsonb; n int; r_emp uuid; r_mgmt uuid; d_int uuid; d_ctl uuid; v_ok boolean;
  u_own uuid := gen_random_uuid(); u_mg uuid := gen_random_uuid(); u_mg2 uuid := gen_random_uuid(); u_emp uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid, p_aal text default 'aal1') returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true); end $f$;
  select id into r_emp from roles where code = 'employee';
  select id into r_mgmt from roles where code = 'management';
  select id into d_int from departments where code = 'INTERIOR';
  select id into d_ctl from departments where is_control_tower limit 1;
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_own, u_mg, u_mg2, u_emp]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_own, 'ZZ-MA-O', 'ZZ Owner', r_mgmt, d_ctl, '9888820001', false, true),
    (u_mg, 'ZZ-MA-M', 'ZZ Manager', r_mgmt, d_ctl, '9888820002', false, true),
    (u_mg2, 'ZZ-MA-M2', 'ZZ Manager Two', r_mgmt, d_ctl, '9888820003', false, true),
    (u_emp, 'ZZ-MA-E', 'ZZ Employee', r_emp, d_int, '9888820004', false, true);
  v_log := public.zz_chk(v_log, 'the real Owner was seeded (one active OWNER)', (select count(*) from mai_owners where kind = 'OWNER' and is_active) = 1);
  perform set_config('mai.owner_change', 'on', true);
  update mai_owners set is_active = false where is_active;
  perform set_config('mai.owner_change', 'off', true);
  insert into mai_owners (user_id, kind) values (u_own, 'OWNER');
  update mai_settings set ai_enabled = true, stop_reason = null where id = 1;

  -- reading the Control Center
  perform public.zz_as(u_emp); set local role authenticated;
  begin perform public.mai_control_center(); v_log := public.zz_chk(v_log, 'an employee cannot open the Control Center', false);
  exception when others then v_log := public.zz_chk(v_log, 'an employee cannot open the Control Center', true); end;
  select count(*) into n from mai_usage;
  v_log := public.zz_chk(v_log, 'an employee cannot read usage or settings', n = 0 and (select count(*) from mai_settings) = 0);
  v := public.mai_public_status();
  reset role;
  v_log := public.zz_chk(v_log, 'every signed-in user can see whether Mood AI is running', (v ->> 'ai_enabled')::boolean);

  perform public.zz_as(u_mg); set local role authenticated;
  v := public.mai_control_center();
  reset role;
  v_log := public.zz_chk(v_log, 'Management can open the Control Center but is not the Owner', not (v -> 'me' ->> 'is_owner')::boolean and jsonb_array_length(v -> 'models') >= 4);

  -- owner verification
  perform public.zz_as(u_own, 'aal1'); set local role authenticated;
  v := public.mai_control_center();
  begin perform public.mai_resume(); v_log := public.zz_chk(v_log, 'the Owner must confirm with the authenticator app', false);
  exception when others then v_log := public.zz_chk(v_log, 'the Owner must confirm with the authenticator app', sqlerrm like '%authenticator%'); end;
  reset role;
  v_log := public.zz_chk(v_log, 'the Owner is recognised by account, not by name', (v -> 'me' ->> 'is_owner')::boolean and not (v -> 'me' ->> 'owner_verified')::boolean);
  perform public.zz_as(u_mg, 'aal2'); set local role authenticated;
  begin perform public.mai_update_settings('{"chat_model": "claude-haiku-5-5"}'); v_log := public.zz_chk(v_log, 'Management (even verified) cannot change Mood AI settings', false);
  exception when others then v_log := public.zz_chk(v_log, 'Management (even verified) cannot change Mood AI settings', true); end;
  reset role;

  -- emergency stop and resume
  perform public.zz_as(u_emp); set local role authenticated;
  begin perform public.mai_emergency_stop('x'); v_log := public.zz_chk(v_log, 'an employee cannot stop Mood AI', false);
  exception when others then v_log := public.zz_chk(v_log, 'an employee cannot stop Mood AI', true); end;
  reset role;
  perform public.zz_as(u_mg); set local role authenticated;
  perform public.mai_emergency_stop('Testing the stop switch');
  begin perform public.mai_resume(); v_log := public.zz_chk(v_log, 'Management can stop but not resume', false);
  exception when others then v_log := public.zz_chk(v_log, 'Management can stop but not resume', true); end;
  reset role;
  v_log := public.zz_chk(v_log, 'the stop takes effect for the server and the Owner is notified', not (public.mai_runtime() ->> 'ai_enabled')::boolean
    and exists (select 1 from notifications where recipient_id = u_own and entity_type = 'MOOD_AI') and public.notification_deep_link('MOOD_AI', u_own) = '/mood-ai');
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  perform public.mai_resume();
  reset role;
  v_log := public.zz_chk(v_log, 'the verified Owner resumes it', (public.mai_runtime() ->> 'ai_enabled')::boolean
    and (select count(*) from mai_audit where action in ('EMERGENCY_STOP', 'RESUMED') and actor in (u_mg, u_own)) = 2);

  -- settings
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  begin perform public.mai_update_settings('{"chat_model": "gpt-made-up"}'); v_log := public.zz_chk(v_log, 'only connected models can be chosen', false);
  exception when others then v_log := public.zz_chk(v_log, 'only connected models can be chosen', true); end;
  perform public.mai_update_settings('{"chat_model": "claude-sonnet-5-5", "monthly_budget_usd": "25"}');
  begin perform public.mai_set_agent('DEVELOPER', true); v_log := public.zz_chk(v_log, 'an agent that is not built yet cannot be switched on', false);
  exception when others then v_log := public.zz_chk(v_log, 'an agent that is not built yet cannot be switched on', sqlerrm like '%not built%'); end;
  perform public.mai_set_agent('CORE', false); perform public.mai_set_agent('CORE', true);
  reset role;
  v_log := public.zz_chk(v_log, 'the Owner changes the chat model and budget', (public.mai_runtime() ->> 'chat_model') = 'claude-sonnet-5-5' and (public.mai_runtime() ->> 'monthly_budget_usd')::numeric = 25);

  -- backup approver
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  begin perform public.mai_set_backup(u_emp, true); v_log := public.zz_chk(v_log, 'the backup must be a Management account', false);
  exception when others then v_log := public.zz_chk(v_log, 'the backup must be a Management account', true); end;
  perform public.mai_set_backup(u_mg, true);
  begin perform public.mai_set_backup(u_mg2, true); v_log := public.zz_chk(v_log, 'there is at most one backup approver', false);
  exception when others then v_log := public.zz_chk(v_log, 'there is at most one backup approver', true); end;
  reset role;
  perform public.zz_as(u_mg, 'aal2'); set local role authenticated;
  v_ok := public.mai_is_owner(true);
  perform public.mai_resume();
  begin perform public.mai_set_backup(u_mg, false); v_log := public.zz_chk(v_log, 'the backup cannot change approvers', false);
  exception when others then v_log := public.zz_chk(v_log, 'the backup cannot change approvers', true); end;
  reset role;
  v_log := public.zz_chk(v_log, 'the verified backup can approve owner-level actions', v_ok);
  begin update mai_owners set is_active = false where user_id = u_own; v_log := public.zz_chk(v_log, 'the Owner cannot be removed from the app', false);
  exception when others then v_log := public.zz_chk(v_log, 'the Owner cannot be removed from the app', true); end;

  -- server-only functions, cost, permanence
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  begin perform public.mai_record_usage(u_own, 'x', 'anthropic', 'claude-opus-5-5', 1, 1, 1, true, null); v_log := public.zz_chk(v_log, 'the app cannot write usage records', false);
  exception when others then v_log := public.zz_chk(v_log, 'the app cannot write usage records', true); end;
  begin perform public.mai_runtime(); v_log := public.zz_chk(v_log, 'the app cannot call server-only functions', false);
  exception when others then v_log := public.zz_chk(v_log, 'the app cannot call server-only functions', true); end;
  reset role;
  perform public.mai_record_usage(u_own, 'zz-test', 'anthropic', 'claude-opus-5-5', 1000000, 100000, 1200, true, null);
  perform public.mai_record_usage(u_own, 'zz-test', 'gemini', 'gemini-3.5-flash', 5000, 500, 3000, true, null);
  v_log := public.zz_chk(v_log, 'cost is worked out from the model price ($4 in + $2 out = $6)', (select cost_usd from mai_usage where feature = 'zz-test' and provider = 'anthropic') = 6);
  v_log := public.zz_chk(v_log, 'a model without a price is recorded with no cost, not a made-up one', (select cost_usd from mai_usage where feature = 'zz-test' and provider = 'gemini') is null);
  begin delete from mai_usage where feature = 'zz-test'; v_log := public.zz_chk(v_log, 'usage records cannot be deleted', false);
  exception when others then v_log := public.zz_chk(v_log, 'usage records cannot be deleted', true); end;
  begin update mai_audit set action = 'x' where true; v_log := public.zz_chk(v_log, 'the audit log cannot be changed', false);
  exception when others then v_log := public.zz_chk(v_log, 'the audit log cannot be changed', true); end;
  perform public.zz_as(u_mg); set local role authenticated;
  v := public.mai_control_center();
  reset role;
  v_log := public.zz_chk(v_log, 'the Control Center shows usage by feature and model', exists (select 1 from jsonb_array_elements(v -> 'usage' -> 'by_feature') x where x ->> 'feature' = 'zz-test'));

  raise exception E'\n%', v_log;
end $t$;
