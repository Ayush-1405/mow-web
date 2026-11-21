-- v3_20 laptop worker queue: token identity, revoke, one job per lock (no duplicates), expired lock -> back in queue,
-- retries then FAILED, pause / emergency stop block new work, roles for each control, dedupe, job types, token never readable.
-- Own fixtures; ALWAYS rolls back (the report is in the error message).
do $t$
declare
  v_log text := ''; v jsonb; v2 jsonb; n int; tok text; tok2 text; w uuid; w2 uuid; j uuid; j2 uuid; r text; v_ok boolean;
  r_emp uuid; r_mgmt uuid; d_int uuid; d_ctl uuid;
  u_own uuid := gen_random_uuid(); u_mg uuid := gen_random_uuid(); u_emp uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid, p_aal text default 'aal1') returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true); end $f$;
  create function public.zz_anon() returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true); end $f$;
  select id into r_emp from roles where code = 'employee';
  select id into r_mgmt from roles where code = 'management';
  select id into d_int from departments where code = 'INTERIOR';
  select id into d_ctl from departments where is_control_tower limit 1;
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_own, u_mg, u_emp]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_own, 'ZZ-MW-O', 'ZZ Owner', r_mgmt, d_ctl, '9888830001', false, true),
    (u_mg, 'ZZ-MW-M', 'ZZ Manager', r_mgmt, d_ctl, '9888830002', false, true),
    (u_emp, 'ZZ-MW-E', 'ZZ Employee', r_emp, d_int, '9888830003', false, true);
  perform set_config('mai.owner_change', 'on', true);
  update mai_owners set is_active = false where is_active;
  perform set_config('mai.owner_change', 'off', true);
  insert into mai_owners (user_id, kind) values (u_own, 'OWNER');
  update mai_settings set ai_enabled = true where id = 1;
  update mai_jobs set status = 'CANCELLED' where status in ('QUEUED', 'RUNNING');

  -- registering
  perform public.zz_as(u_mg, 'aal2'); set local role authenticated;
  begin perform public.mai_worker_register('x'); v_log := public.zz_chk(v_log, 'Management cannot register a worker', false);
  exception when others then v_log := public.zz_chk(v_log, 'Management cannot register a worker', true); end;
  reset role;
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  v := public.mai_worker_register('ZZ Laptop'); v2 := public.mai_worker_register('ZZ Laptop 2');
  reset role;
  tok := v ->> 'token'; w := (v ->> 'worker_id')::uuid; tok2 := v2 ->> 'token'; w2 := (v2 ->> 'worker_id')::uuid;
  v_log := public.zz_chk(v_log, 'the Owner registers a worker and gets its token once; only a hash is stored',
    tok like 'mw_%' and length(tok) = 67 and not exists (select 1 from mai_workers where token_hash = tok or token_hint = tok));

  -- the worker, signed in with nothing but its token
  perform public.zz_anon(); set local role anon;
  begin perform public.mai_worker_heartbeat('mw_' || repeat('0', 64), '{}', 'RUNNING', null, 't', 'h', now()); v_log := public.zz_chk(v_log, 'a wrong token is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'a wrong token is refused', sqlerrm like '%not authorized%'); end;
  v := public.mai_worker_heartbeat(tok, '{"cpu_pct": 12}', 'RUNNING', null, '1.0.0', 'zz-host', now() - interval '1 minute');
  begin perform count(*) from mai_jobs; v_log := public.zz_chk(v_log, 'the worker token cannot read the tables directly', false);
  exception when others then v_log := public.zz_chk(v_log, 'the worker token cannot read the tables directly', true); end;
  reset role;
  v_log := public.zz_chk(v_log, 'a heartbeat records the health readings and returns the limits', (v ->> 'worker_id')::uuid = w and (v -> 'limits' ->> 'max_cpu_pct')::int = 70
    and (select metrics ->> 'cpu_pct' from mai_workers where id = w) = '12');

  -- queue and claim
  perform public.zz_as(u_emp); set local role authenticated;
  begin perform public.mai_enqueue_job('SELFTEST', '{}', null); v_log := public.zz_chk(v_log, 'an employee cannot queue jobs', false);
  exception when others then v_log := public.zz_chk(v_log, 'an employee cannot queue jobs', true); end;
  reset role;
  perform public.zz_as(u_mg); set local role authenticated;
  begin perform public.mai_enqueue_job('PAY_VENDOR', '{}', null); v_log := public.zz_chk(v_log, 'only listed job types can be queued', false);
  exception when others then v_log := public.zz_chk(v_log, 'only listed job types can be queued', true); end;
  j := public.mai_enqueue_job('SELFTEST', '{"note": "zz"}', 'zz-dedupe');
  begin perform public.mai_enqueue_job('SELFTEST', '{}', 'zz-dedupe'); v_log := public.zz_chk(v_log, 'the same job cannot be queued twice', false);
  exception when others then v_log := public.zz_chk(v_log, 'the same job cannot be queued twice', true); end;
  reset role;
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_claim(tok); v2 := public.mai_worker_claim(tok2);
  reset role;
  v_log := public.zz_chk(v_log, 'one worker gets the job; the other gets nothing (no duplicate run)', (v ->> 'id')::uuid = j and v2 is null);
  perform public.zz_anon(); set local role anon;
  r := public.mai_worker_complete(tok2, j, true, '{"x": 1}', null);
  reset role;
  v_log := public.zz_chk(v_log, 'a worker that does not hold the lock cannot finish the job', r = 'lost' and (select status from mai_jobs where id = j) = 'RUNNING');

  -- the worker vanishes: lock expires, job goes back, the other worker finishes it
  update mai_jobs set locked_until = now() - interval '1 second' where id = j;
  perform public.zz_anon(); set local role anon;
  v2 := public.mai_worker_claim(tok2);
  r := public.mai_worker_complete(tok, j, true, '{"late": true}', null);
  reset role;
  v_log := public.zz_chk(v_log, 'when a worker stops responding its job goes back in the queue and runs once elsewhere', (v2 ->> 'id')::uuid = j and r = 'lost'
    and (select attempts from mai_jobs where id = j) = 2);
  perform public.zz_anon(); set local role anon;
  r := public.mai_worker_complete(tok2, j, true, '{"ok": true}', null);
  reset role;
  v_log := public.zz_chk(v_log, 'the holder finishes it and the result is saved', r = 'done' and (select status from mai_jobs where id = j) = 'DONE'
    and (select result ->> 'ok' from mai_jobs where id = j) = 'true');

  -- retries then FAILED
  perform public.zz_as(u_mg); set local role authenticated; j2 := public.mai_enqueue_job('SELFTEST', '{}', null); reset role;
  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_claim(tok); r := public.mai_worker_complete(tok, j2, false, null, 'zz boom');
  perform public.mai_worker_claim(tok); v2 := to_jsonb(public.mai_worker_complete(tok, j2, false, null, 'zz boom again'));
  reset role;
  v_log := public.zz_chk(v_log, 'a failed job is retried, then marked failed with its error', r = 'retry' and v2 #>> '{}' = 'failed'
    and (select status || ':' || error from mai_jobs where id = j2) = 'FAILED:zz boom again');

  -- pause, emergency stop, restart, limits, disconnect
  perform public.zz_as(u_mg); set local role authenticated;
  j2 := public.mai_enqueue_job('SELFTEST', '{}', null);
  perform public.mai_worker_set_paused(w, true);
  begin perform public.mai_worker_set_paused(w, false); v_log := public.zz_chk(v_log, 'Management can pause but not resume the worker', false);
  exception when others then v_log := public.zz_chk(v_log, 'Management can pause but not resume the worker', true); end;
  begin perform public.mai_worker_set_limits(w, '{"max_cpu_pct": 95}'); v_log := public.zz_chk(v_log, 'only the Owner changes the limits', false);
  exception when others then v_log := public.zz_chk(v_log, 'only the Owner changes the limits', true); end;
  perform public.mai_worker_request_restart(w2);
  reset role;
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_claim(tok);
  v2 := public.mai_worker_heartbeat(tok2, '{}', 'RUNNING', null, '1.0.0', 'zz-host', now() - interval '1 minute');
  reset role;
  v_log := public.zz_chk(v_log, 'a paused worker takes no jobs', v is null);
  v_log := public.zz_chk(v_log, 'a restart request reaches the worker once', (v2 ->> 'restart')::boolean);
  perform public.zz_anon(); set local role anon;
  v2 := public.mai_worker_heartbeat(tok2, '{}', 'RUNNING', null, '1.0.0', 'zz-host', now());
  reset role;
  v_log := public.zz_chk(v_log, 'after restarting, the request is cleared', not (v2 ->> 'restart')::boolean);
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  perform public.mai_worker_set_paused(w, false);
  perform public.mai_worker_set_limits(w, '{"max_cpu_pct": 500, "min_free_ram_gb": 4, "working_hours": {"from": "09:00", "to": "19:00"}}');
  reset role;
  v_log := public.zz_chk(v_log, 'limits are kept within safe bounds', (select (limits ->> 'max_cpu_pct')::int = 95 and (limits ->> 'min_free_ram_gb')::numeric = 4
    and limits -> 'working_hours' ->> 'from' = '09:00' from mai_workers where id = w));
  update mai_settings set ai_enabled = false where id = 1;
  perform public.zz_anon(); set local role anon; v := public.mai_worker_claim(tok); reset role;
  update mai_settings set ai_enabled = true where id = 1;
  v_log := public.zz_chk(v_log, 'the Mood AI emergency stop also stops the worker taking jobs', v is null);
  perform public.zz_anon(); set local role anon; v := public.mai_worker_claim(tok); reset role;
  perform public.zz_as(u_mg); set local role authenticated; perform public.mai_worker_disconnect(w); v2 := public.mai_worker_panel(); reset role;
  v_log := public.zz_chk(v_log, 'disconnecting puts its running job back in the queue', (v ->> 'id')::uuid = j2 and (select status from mai_jobs where id = j2) = 'QUEUED');
  perform public.zz_anon(); set local role anon;
  begin perform public.mai_worker_heartbeat(tok, '{}', 'RUNNING', null, 't', 'h', now()); v_log := public.zz_chk(v_log, 'a disconnected worker is refused at once', false);
  exception when others then v_log := public.zz_chk(v_log, 'a disconnected worker is refused at once', true); end;
  reset role;
  v_log := public.zz_chk(v_log, 'the panel shows workers, online state and job counts without the token', jsonb_array_length(v2 -> 'workers') >= 2
    and (v2 -> 'jobs' ->> 'queued')::int >= 1 and not (v2::text like '%' || tok || '%') and not (v2::text like '%token_hash%'));
  perform public.zz_as(u_mg); set local role authenticated;
  begin perform token_hash from mai_workers limit 1; v_log := public.zz_chk(v_log, 'nobody can read token hashes from the app', false);
  exception when others then v_log := public.zz_chk(v_log, 'nobody can read token hashes from the app', true); end;
  reset role;
  v_log := public.zz_chk(v_log, 'every control action is in the permanent activity log',
    (select count(*) from mai_audit where action in ('WORKER_REGISTERED', 'WORKER_PAUSED', 'WORKER_RESUMED', 'WORKER_LIMITS_CHANGED', 'WORKER_RESTART_REQUESTED', 'WORKER_DISCONNECTED')) >= 7);

  raise exception E'\n%', v_log;
end $t$;
