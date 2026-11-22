-- v3_28 Phase G releases: who may ask / approve / roll back, the authenticator rule, the exact-commit rule, one release at a time,
-- only a laptop with releases switched on, only the laptop holding it reports, expiry and stalled-laptop handling, and
-- merged developer requests becoming LIVE. Own fixtures; ALWAYS rolls back (report in the error).
do $t$
declare
  v_log text := ''; v jsonb; ok boolean; tok text; tok2 text; rid uuid; rid2 uuid; v_ref text; dr uuid; r_mgmt uuid; d_ctl uuid; n int;
  u_own uuid := gen_random_uuid(); u_mg uuid := gen_random_uuid();
  plan jsonb := '{"commits": [{"sha": "abc1234def", "subject": "Fix"}], "migrations": ["backend/supabase/migrations/x_v9.sql"], "tests": [], "functions": ["mood-ai"], "website": true}';
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid, p_aal text default 'aal1') returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true); end $f$;
  create function public.zz_anon() returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true); end $f$;
  select id into r_mgmt from roles where code = 'management';
  select id into d_ctl from departments where is_control_tower limit 1;
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_own, u_mg]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_own, 'ZZ-RL-O', 'ZZ Owner', r_mgmt, d_ctl, '9888870001', false, true), (u_mg, 'ZZ-RL-M', 'ZZ Manager', r_mgmt, d_ctl, '9888870002', false, true);
  perform set_config('mai.owner_change', 'on', true);
  update mai_owners set is_active = false where is_active;
  perform set_config('mai.owner_change', 'off', true);
  insert into mai_owners (user_id, kind) values (u_own, 'OWNER');
  update mai_settings set ai_enabled = true where id = 1;
  update mai_workers set paused = true where status = 'ACTIVE';     -- the real laptop is left out
  update mai_releases set status = 'CANCELLED' where status not in ('LIVE', 'FAILED', 'ROLLED_BACK', 'CANCELLED', 'NOTHING_TO_RELEASE');

  perform public.zz_as(u_mg, 'aal2'); set local role authenticated;
  begin perform public.mai_release_request(); ok := false; exception when others then ok := true; end;
  begin perform public.mai_release_list(); ok := ok and false; exception when others then null; end;
  reset role;
  v_log := public.zz_chk(v_log, 'Management cannot prepare or see releases', ok);

  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  tok := public.mai_worker_register('ZZ release laptop') ->> 'token';
  tok2 := public.mai_worker_register('ZZ other laptop') ->> 'token';
  reset role;
  perform public.zz_as(u_own); set local role authenticated;
  v := public.mai_release_request(); rid := (v ->> 'id')::uuid; v_ref := v ->> 'ref';
  begin perform public.mai_release_request(); ok := false; exception when others then ok := true; end;
  reset role;
  v_log := public.zz_chk(v_log, 'the Owner asks for a plan (no code needed to ask); a second open release is refused', v ->> 'status' = 'REQUESTED' and v_ref like 'RL-%' and ok);

  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_heartbeat(tok, '{"release": {"enabled": false}}', 'RUNNING', null, '1.5.0', 'zz', now());
  v := public.mai_worker_release_claim(tok);
  reset role;
  v_log := public.zz_chk(v_log, 'a laptop without RELEASE=on gets no release work', v is null);

  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_heartbeat(tok, '{"release": {"enabled": true}}', 'RUNNING', null, '1.5.0', 'zz', now());
  perform public.mai_worker_heartbeat(tok2, '{"release": {"enabled": true}}', 'RUNNING', null, '1.5.0', 'zz2', now());
  v := public.mai_worker_release_claim(tok);
  begin perform public.mai_worker_release_plan(tok2, v_ref, 'base000', 'abc1234def', plan); ok := false; exception when others then ok := true; end;
  perform public.mai_worker_release_plan(tok, v_ref, 'base000', 'abc1234def', plan);
  reset role;
  v_log := public.zz_chk(v_log, 'the laptop with releases on plans it; another laptop cannot', v ->> 'action' = 'plan' and ok
    and (select status = 'PLANNED' and commit_ref = 'abc1234def' and worker_id is null from mai_releases where id = rid));
  v_log := public.zz_chk(v_log, 'the Owner is told the plan is ready', exists (select 1 from notifications where recipient_id = u_own and title_en like v_ref || ' is ready for your approval%'));

  perform public.zz_as(u_own, 'aal1'); set local role authenticated;
  begin perform public.mai_release_approve(rid, 'abc1234def'); ok := false; exception when others then ok := sqlerrm like '%authenticator%'; end;
  reset role;
  v_log := public.zz_chk(v_log, 'approving needs the authenticator app', ok);
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  begin perform public.mai_release_approve(rid, 'zzz9999'); ok := false; exception when others then ok := true; end;
  perform public.mai_release_approve(rid, 'abc1234def');
  reset role;
  v_log := public.zz_chk(v_log, 'only the exact commit on screen can be approved', ok and (select status = 'APPROVED' from mai_releases where id = rid));

  -- an old approval is not used
  update mai_releases set approved_at = now() - interval '3 hours' where id = rid;
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_release_claim(tok);
  reset role;
  v_log := public.zz_chk(v_log, 'an approval older than 2 hours expires back to PLANNED', v is null and (select status = 'PLANNED' and approved_at is null from mai_releases where id = rid));
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  perform public.mai_release_approve(rid, 'abc1234def');
  reset role;

  -- a developer request merged on the laptop, part of this release
  insert into mai_dev_requests (requested_by, raw_text, title, goal, prompt, status, merged_commit) values (u_own, 'x', 'ZZ merged', 'x', 'x', 'MERGED', 'abc1234') returning id into dr;

  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_release_claim(tok);
  begin perform public.mai_worker_release_step(tok2, v_ref, 'backup', true, 'x'); ok := false; exception when others then ok := true; end;
  perform public.mai_worker_release_step(tok, v_ref, 'backup', true, 'Backup saved');
  perform public.mai_worker_release_step(tok, v_ref, 'database trial', true, '12 checks passed');
  begin perform public.mai_release_cancel(rid); ok := ok and false; exception when others then null; end;
  perform public.mai_worker_release_finish(tok, v_ref, true, 'Live and healthy', 'D:/backups/release.dump');
  reset role;
  v_log := public.zz_chk(v_log, 'the laptop runs it, reports each step (another laptop cannot), and finishes LIVE', v ->> 'action' = 'release' and ok
    and (select status = 'LIVE' and jsonb_array_length(steps) = 2 and backup_file = 'D:/backups/release.dump' and worker_id is null from mai_releases where id = rid));
  v_log := public.zz_chk(v_log, 'the developer request in it becomes LIVE, with a history line', (select status = 'LIVE' from mai_dev_requests where id = dr)
    and exists (select 1 from mai_dev_events where request_id = dr and status = 'LIVE' and note like '%' || v_ref || '%'));

  perform public.zz_as(u_own, 'aal1'); set local role authenticated;
  begin perform public.mai_release_rollback(rid); ok := false; exception when others then ok := sqlerrm like '%authenticator%'; end;
  reset role;
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  perform public.mai_release_rollback(rid);
  reset role;
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_release_claim(tok);
  perform public.mai_worker_release_finish(tok, v_ref, true, 'Website and functions back to base000');
  reset role;
  v_log := public.zz_chk(v_log, 'rollback needs the authenticator app, then the laptop rolls back', ok and v ->> 'action' = 'rollback'
    and (select status = 'ROLLED_BACK' from mai_releases where id = rid));

  -- a laptop that stops in the middle: FAILED, never retried by itself
  perform public.zz_as(u_own); set local role authenticated;
  rid2 := (public.mai_release_request() ->> 'id')::uuid;
  reset role;
  update mai_releases set status = 'RUNNING', worker_id = (select id from mai_workers where name = 'ZZ other laptop' and status = 'ACTIVE'), locked_until = now() - interval '1 minute' where id = rid2;
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_release_claim(tok);
  reset role;
  v_log := public.zz_chk(v_log, 'a release whose laptop stopped responding is FAILED, not restarted', v is null
    and (select status = 'FAILED' and note like '%stopped responding%' from mai_releases where id = rid2));

  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  begin update mai_releases set status = 'LIVE' where id = rid2; get diagnostics n = row_count; ok := n = 0; exception when others then ok := true; end;
  reset role;
  v_log := public.zz_chk(v_log, 'nobody can change a release row directly from the app', ok);
  v_log := public.zz_chk(v_log, 'the Deployment manager agent is marked built', (select is_built from mai_agents where code = 'DEPLOYER'));

  raise exception E'\n%', v_log;
end $t$;
