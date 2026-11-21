-- v3_25 chat fallback on the laptop: ready only with an online, running, unpaused laptop whose Ollama has a chat model and that is not
-- building a request; the job jumps the queue; the answer is read once and then cleared; giving up cancels it and the laptop's late
-- answer is dropped; the app (signed-in staff) cannot call any of it. Own fixtures; ALWAYS rolls back (report in the error).
do $t$
declare
  v_log text := ''; v jsonb; tok text; w uuid; j uuid; j_old uuid; j2 uuid; r_mgmt uuid; d_ctl uuid; ok boolean;
  u_own uuid := gen_random_uuid();
  good jsonb := '{"ollama": {"up": true, "chat_model": "qwen3:4b-instruct"}, "claude": {"up": true, "busy": null}}';
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
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_own, 'ZZ-LC-O', 'ZZ Owner', r_mgmt, d_ctl, '9888850001', false, true);
  perform set_config('mai.owner_change', 'on', true);
  update mai_owners set is_active = false where is_active;
  perform set_config('mai.owner_change', 'off', true);
  insert into mai_owners (user_id, kind) values (u_own, 'OWNER');
  update mai_settings set ai_enabled = true where id = 1;
  update mai_workers set paused = true where status = 'ACTIVE';           -- the real laptop is left out of this test
  update mai_jobs set status = 'CANCELLED' where status in ('QUEUED', 'RUNNING');

  v_log := public.zz_chk(v_log, 'LOCAL_CHAT exists: Ollama only, one attempt, 2-minute lease',
    exists (select 1 from mai_job_types where code = 'LOCAL_CHAT' and requires = 'ollama' and max_attempts = 1 and lease_minutes = 2 and enabled));
  v_log := public.zz_chk(v_log, 'no laptop online: not ready, and nothing is queued', not public.mai_chat_local_ready()
    and public.mai_chat_local_enqueue(u_own, '{"system": "x"}') is null);

  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  tok := public.mai_worker_register('ZZ chat laptop') ->> 'token';
  reset role;
  select id into w from mai_workers where name = 'ZZ chat laptop' and status = 'ACTIVE';

  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_heartbeat(tok, '{"ollama": {"up": true, "chat_model": null}}', 'RUNNING', null, '1.3.0', 'zz', now());
  reset role;
  v_log := public.zz_chk(v_log, 'Ollama up but no chat model: not ready', not public.mai_chat_local_ready());

  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_heartbeat(tok, '{"ollama": {"up": true, "chat_model": "qwen3:4b-instruct"}, "claude": {"busy": "DR-0009"}}', 'RUNNING', 'Building DR-0009', '1.3.0', 'zz', now());
  reset role;
  v_log := public.zz_chk(v_log, 'busy building a developer request: not ready', not public.mai_chat_local_ready());

  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_heartbeat(tok, good, 'THROTTLED', 'On battery', '1.3.0', 'zz', now());
  reset role;
  v_log := public.zz_chk(v_log, 'throttled (battery / busy laptop): not ready', not public.mai_chat_local_ready());

  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_heartbeat(tok, good, 'RUNNING', null, '1.3.0', 'zz', now());
  reset role;
  v_log := public.zz_chk(v_log, 'online, running, Ollama with a chat model: ready', public.mai_chat_local_ready());

  update mai_workers set last_heartbeat_at = now() - interval '2 minutes' where id = w;
  v_log := public.zz_chk(v_log, 'no heartbeat for 2 minutes: not ready', not public.mai_chat_local_ready());
  update mai_workers set last_heartbeat_at = now() where id = w;

  update mai_settings set ai_enabled = false where id = 1;
  v_log := public.zz_chk(v_log, 'emergency stop on: not ready', not public.mai_chat_local_ready());
  update mai_settings set ai_enabled = true where id = 1;

  -- an older job is waiting; the chat question still goes first
  insert into mai_jobs (job_type, payload, max_attempts, created_by) values ('SELFTEST', '{}', 1, u_own) returning id into j_old;
  update mai_jobs set created_at = now() - interval '5 minutes' where id = j_old;
  j := public.mai_chat_local_enqueue(u_own, '{"system": "You are Mood AI.", "messages": [{"role": "user", "content": "How do I send a job card?"}]}');
  v_log := public.zz_chk(v_log, 'the question is queued as LOCAL_CHAT, priority 1, one attempt',
    (select job_type = 'LOCAL_CHAT' and priority = 1 and max_attempts = 1 and status = 'QUEUED' from mai_jobs where id = j));
  v := public.mai_chat_local_take(j);
  v_log := public.zz_chk(v_log, 'reading before the laptop answers: still QUEUED, nothing cleared',
    v ->> 'status' = 'QUEUED' and (select payload <> '{}' from mai_jobs where id = j));

  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_claim(tok);
  reset role;
  v_log := public.zz_chk(v_log, 'the laptop takes the chat question before the older job', (v ->> 'id')::uuid = j and v ->> 'job_type' = 'LOCAL_CHAT');

  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_complete(tok, j, true, '{"model": "qwen3:4b-instruct", "text": "{\"reply\": \"Open Send to factory\"}", "ms": 9000, "output_tokens": 40}', null);
  reset role;
  v := public.mai_chat_local_take(j);
  v_log := public.zz_chk(v_log, 'the answer is handed over once', v ->> 'status' = 'DONE' and v -> 'result' ->> 'text' like '%Send to factory%');
  v_log := public.zz_chk(v_log, 'then the question and answer text are cleared from the job (timing kept)',
    (select payload = '{}' and result ->> 'text' is null and result ->> 'model' = 'qwen3:4b-instruct' and (result ->> 'ms')::int = 9000 from mai_jobs where id = j));

  -- giving up: cancelled and cleared; the laptop's late answer is dropped
  j2 := public.mai_chat_local_enqueue(u_own, '{"system": "s", "messages": [{"role": "user", "content": "q"}]}');
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_claim(tok);
  reset role;
  perform public.mai_chat_local_cancel(j2);
  perform public.zz_anon(); set local role anon;
  v_log := public.zz_chk(v_log, 'after the chat gives up, the laptop''s late answer is dropped (lost)',
    public.mai_worker_complete(tok, j2, true, '{"text": "late"}', null) = 'lost');
  reset role;
  v_log := public.zz_chk(v_log, 'the cancelled job keeps no question or answer',
    (select status = 'CANCELLED' and payload = '{}' and result is null from mai_jobs where id = j2));

  -- signed-in staff (even the Owner) and anon cannot use the server-only functions
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  begin perform public.mai_chat_local_enqueue(u_own, '{}'); ok := false; exception when insufficient_privilege then ok := true; end;
  begin perform public.mai_chat_local_take(j); ok := false; exception when insufficient_privilege then ok := ok; end;
  begin perform public.mai_chat_local_ready(); ok := false; exception when insufficient_privilege then ok := ok; end;
  reset role;
  v_log := public.zz_chk(v_log, 'the app cannot queue, read or check the laptop chat itself', ok);
  perform public.zz_anon(); set local role anon;
  begin perform public.mai_chat_local_cancel(j); ok := false; exception when insufficient_privilege then ok := true; end;
  reset role;
  v_log := public.zz_chk(v_log, 'anon cannot either', ok);

  raise exception E'\n%', v_log;
end $t$;
