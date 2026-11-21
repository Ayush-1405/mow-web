-- v3_21 local models: local-model jobs go only to a laptop whose last heartbeat says Ollama is up; ordinary jobs are
-- unaffected; job types exist with "requires = ollama"; pause still wins. Own fixtures; ALWAYS rolls back (report in the error).
do $t$
declare
  v_log text := ''; v jsonb; tok text; tok2 text; w uuid; w2 uuid; j_loc uuid; j_self uuid; r_mgmt uuid; d_ctl uuid;
  u_own uuid := gen_random_uuid(); u_mg uuid := gen_random_uuid();
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
    (u_own, 'ZZ-LM-O', 'ZZ Owner', r_mgmt, d_ctl, '9888840001', false, true),
    (u_mg, 'ZZ-LM-M', 'ZZ Manager', r_mgmt, d_ctl, '9888840002', false, true);
  perform set_config('mai.owner_change', 'on', true);
  update mai_owners set is_active = false where is_active;
  perform set_config('mai.owner_change', 'off', true);
  insert into mai_owners (user_id, kind) values (u_own, 'OWNER');
  update mai_settings set ai_enabled = true where id = 1;
  update mai_jobs set status = 'CANCELLED' where status in ('QUEUED', 'RUNNING');

  v_log := public.zz_chk(v_log, 'LOCAL_EMBED and LOCAL_GENERATE exist and require Ollama; SELFTEST requires nothing',
    (select count(*) from mai_job_types where code in ('LOCAL_EMBED', 'LOCAL_GENERATE') and requires = 'ollama' and enabled) = 2
    and (select requires from mai_job_types where code = 'SELFTEST') is null);

  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  tok := public.mai_worker_register('ZZ no-Ollama laptop') ->> 'token';
  tok2 := public.mai_worker_register('ZZ Ollama laptop') ->> 'token';
  reset role;

  perform public.zz_as(u_mg); set local role authenticated;
  j_loc := public.mai_enqueue_job('LOCAL_GENERATE', '{"prompt": "hi"}', null);
  reset role;

  -- a laptop without Ollama: heartbeat says ollama.up = false
  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_heartbeat(tok, '{"ollama": {"up": false}}', 'RUNNING', null, '1.1.0', 'zz-a', now());
  v := public.mai_worker_claim(tok);
  reset role;
  v_log := public.zz_chk(v_log, 'a laptop without Ollama is not given a local-model job (it stays queued)',
    v is null and (select status from mai_jobs where id = j_loc) = 'QUEUED');

  -- an older worker that sends no ollama section at all is treated the same
  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_heartbeat(tok, '{"cpu_pct": 5}', 'RUNNING', null, '1.0.0', 'zz-a', now());
  v := public.mai_worker_claim(tok);
  reset role;
  v_log := public.zz_chk(v_log, 'an older worker with no Ollama report is not given one either', v is null);

  -- ordinary jobs still flow to it, even with a local job queued ahead
  perform public.zz_as(u_mg); set local role authenticated;
  j_self := public.mai_enqueue_job('SELFTEST', '{}', null);
  reset role;
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_claim(tok);
  reset role;
  v_log := public.zz_chk(v_log, 'that laptop still gets ordinary jobs queued behind the local one', (v ->> 'id')::uuid = j_self);

  -- a laptop with Ollama up, but paused: nothing
  select id into w2 from mai_workers where name = 'ZZ Ollama laptop';
  update mai_workers set paused = true where id = w2;
  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_heartbeat(tok2, '{"ollama": {"up": true}}', 'PAUSED', null, '1.1.0', 'zz-b', now());
  v := public.mai_worker_claim(tok2);
  reset role;
  v_log := public.zz_chk(v_log, 'a paused laptop with Ollama gets nothing', v is null);

  -- unpaused: it takes the local-model job
  update mai_workers set paused = false where id = w2;
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_claim(tok2);
  reset role;
  v_log := public.zz_chk(v_log, 'a laptop with Ollama up takes the local-model job, with its lease',
    (v ->> 'id')::uuid = j_loc and v ->> 'job_type' = 'LOCAL_GENERATE' and (v ->> 'lease_minutes')::int = 10
    and (select status from mai_jobs where id = j_loc) = 'RUNNING');

  -- the job types table still cannot be changed from the app
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  begin update mai_job_types set requires = null where code = 'LOCAL_GENERATE';
    v_log := public.zz_chk(v_log, 'the app cannot edit job types', not found);
  exception when others then v_log := public.zz_chk(v_log, 'the app cannot edit job types', true); end;
  reset role;

  raise exception E'\n%', v_log;
end $t$;
