-- v3_24 laptop developer: claims only approved requests, one at a time, only when Claude Code is up and the switch is on;
-- reports only on the request it holds; can never set LIVE/DONE; vanished laptop -> request back in the queue.
-- Own fixtures; ALWAYS rolls back (the report is in the error message).
do $t$
declare
  v_log text := ''; v jsonb; tok text; tok2 text; w uuid; d jsonb; rid uuid; v_ref text; rid2 uuid; n int; r_mgmt uuid; d_ctl uuid;
  u_own uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid, p_aal text default 'aal1') returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true); end $f$;
  create function public.zz_anon() returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true); end $f$;
  select id into r_mgmt from roles where code = 'management';
  select id into d_ctl from departments where is_control_tower limit 1;
  insert into auth.users (id, email, aud, role) values (u_own, 'zz-' || u_own || '@test.invalid', 'authenticated', 'authenticated');
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active)
  values (u_own, 'ZZ-LD-O', 'ZZ Owner', r_mgmt, d_ctl, '9888870001', false, true);
  perform set_config('mai.owner_change', 'on', true);
  update mai_owners set is_active = false where is_active;
  perform set_config('mai.owner_change', 'off', true);
  insert into mai_owners (user_id, kind) values (u_own, 'OWNER');
  update mai_settings set ai_enabled = true, dev_agent = 'laptop' where id = 1;
  update mai_dev_requests set status = 'CANCELLED' where status in ('SUBMITTED', 'IN_PROGRESS', 'NEEDS_INFO');

  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  tok := public.mai_worker_register('ZZ dev laptop') ->> 'token';
  tok2 := public.mai_worker_register('ZZ other laptop') ->> 'token';
  reset role;
  select id into w from mai_workers where name = 'ZZ dev laptop';
  d := public.mai_dev_draft_internal(u_own, null, 'x', '{"title": "T1", "prompt": "Do T1"}', 'm'); rid := (d ->> 'id')::uuid; v_ref := d ->> 'ref';
  d := public.mai_dev_draft_internal(u_own, null, 'y', '{"title": "T2", "prompt": "Do T2"}', 'm'); rid2 := (d ->> 'id')::uuid;

  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_heartbeat(tok, '{"claude": {"up": true}}', 'RUNNING', null, '1.2.0', 'h', now());
  v := public.mai_worker_dev_claim(tok);
  reset role;
  v_log := public.zz_chk(v_log, 'a draft the Owner has not approved is never picked up', v is null);

  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  perform public.mai_dev_submit(rid); perform public.mai_dev_submit(rid2);
  reset role;

  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_heartbeat(tok2, '{"claude": {"up": false}}', 'RUNNING', null, '1.2.0', 'h2', now());
  v := public.mai_worker_dev_claim(tok2);
  reset role;
  v_log := public.zz_chk(v_log, 'a laptop without Claude Code gets nothing', v is null);

  update mai_settings set dev_agent = 'off' where id = 1;
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_dev_claim(tok);
  reset role;
  v_log := public.zz_chk(v_log, 'the Owner''s off switch stops pickup', v is null);
  update mai_settings set dev_agent = 'laptop' where id = 1;

  select count(*) into n from notifications where recipient_id = u_own and entity_type = 'MOOD_AI';
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_dev_claim(tok);
  reset role;
  v_log := public.zz_chk(v_log, 'an approved request is picked up (oldest first), marked in progress, and the Owner is notified',
    v ->> 'ref' = v_ref and v ->> 'prompt' = 'Do T1' and (select status = 'IN_PROGRESS' and worker_id = w and branch = 'mood-ai/' || v_ref from mai_dev_requests where id = rid)
    and (select count(*) from notifications where recipient_id = u_own and entity_type = 'MOOD_AI') = n + 1);
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_dev_claim(tok);
  reset role;
  v_log := public.zz_chk(v_log, 'one request at a time per laptop', v is null and (select status from mai_dev_requests where id = rid2) = 'SUBMITTED');

  perform public.zz_anon(); set local role anon;
  begin perform public.mai_worker_dev_report(tok2, v_ref, 'READY_FOR_REVIEW', 'x'); v_log := public.zz_chk(v_log, 'another laptop cannot report on it', false);
  exception when others then v_log := public.zz_chk(v_log, 'another laptop cannot report on it', true); end;
  begin perform public.mai_worker_dev_report(tok, v_ref, 'LIVE', 'x'); v_log := public.zz_chk(v_log, 'the laptop developer can never mark a request live or done', false);
  exception when others then v_log := public.zz_chk(v_log, 'the laptop developer can never mark a request live or done', sqlerrm like '%cannot set%'); end;
  perform public.mai_worker_dev_report(tok, v_ref, 'READY_FOR_REVIEW', 'Built; tests passed', 'mood-ai/' || v_ref, 'abc1234');
  reset role;
  v_log := public.zz_chk(v_log, 'ready for review: recorded with commit, lock released',
    (select status = 'READY_FOR_REVIEW' and commit_ref = 'abc1234' and worker_id is null and locked_until is null from mai_dev_requests where id = rid));

  -- the next one; then the laptop vanishes
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_dev_claim(tok);
  reset role;
  update mai_dev_requests set locked_until = now() - interval '1 minute' where id = rid2;
  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_heartbeat(tok2, '{"claude": {"up": true}}', 'RUNNING', null, '1.2.0', 'h2', now());
  v := public.mai_worker_dev_claim(tok2);
  reset role;
  v_log := public.zz_chk(v_log, 'if the laptop vanishes mid-work the request goes back and another laptop can take it', (v ->> 'id')::uuid = rid2);

  -- paused / stopped
  update mai_dev_requests set status = 'SUBMITTED', worker_id = null where id = rid2;
  update mai_workers set paused = true where id = w;
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_dev_claim(tok);
  reset role;
  v_log := public.zz_chk(v_log, 'a paused laptop takes nothing', v is null);

  raise exception E'\n%', v_log;
end $t$;
