-- v3_22 Mood AI floating chat: private history, replies written only by the server, daily limit, who may chat, stop switch,
-- frozen messages, cost visible only to monitors. Own fixtures; ALWAYS rolls back (the report is in the error message).
do $t$
declare
  v_log text := ''; v jsonb; th uuid; th2 uuid; n int; r_emp uuid; r_mgmt uuid; d_int uuid; d_ctl uuid;
  u_own uuid := gen_random_uuid(); u_mg uuid := gen_random_uuid(); u_e1 uuid := gen_random_uuid(); u_e2 uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid, p_aal text default 'aal1') returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true); end $f$;
  select id into r_emp from roles where code = 'employee';
  select id into r_mgmt from roles where code = 'management';
  select id into d_int from departments where code = 'INTERIOR';
  select id into d_ctl from departments where is_control_tower limit 1;
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_own, u_mg, u_e1, u_e2]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_own, 'ZZ-CH-O', 'ZZ Owner', r_mgmt, d_ctl, '9888850001', false, true),
    (u_mg, 'ZZ-CH-M', 'ZZ Manager', r_mgmt, d_ctl, '9888850002', false, true),
    (u_e1, 'ZZ-CH-1', 'ZZ Employee One', r_emp, d_int, '9888850003', false, true),
    (u_e2, 'ZZ-CH-2', 'ZZ Employee Two', r_emp, d_int, '9888850004', false, true);
  perform set_config('mai.owner_change', 'on', true);
  update mai_owners set is_active = false where is_active;
  perform set_config('mai.owner_change', 'off', true);
  insert into mai_owners (user_id, kind) values (u_own, 'OWNER');
  update mai_settings set ai_enabled = true, chat_audience = 'everyone', chat_daily_limit = 40 where id = 1;
  update mai_models set input_usd_per_mtok = 4, output_usd_per_mtok = 20 where provider = 'anthropic' and model = 'claude-opus-5-5';

  v_log := public.zz_chk(v_log, 'defaults: everyone may chat, 40 messages a day',
    (select column_default from information_schema.columns where table_name = 'mai_settings' and column_name = 'chat_audience') like '%everyone%'
    and (select column_default from information_schema.columns where table_name = 'mai_settings' and column_name = 'chat_daily_limit') = '40');

  -- the edge function (service role) starts a conversation for employee 1
  v := public.mai_chat_begin(u_e1, null, 'Factory job card kaise banate hain?', '/factory-job-cards');
  th := (v ->> 'thread_id')::uuid;
  v_log := public.zz_chk(v_log, 'a new question starts a conversation titled from the question, and is stored',
    (v ->> 'ok')::boolean and (select title from mai_chat_threads where id = th) = 'Factory job card kaise banate hain?'
    and (select count(*) from mai_chat_messages where thread_id = th and role = 'user' and page = '/factory-job-cards') = 1
    and (v ->> 'used_today')::int = 1 and jsonb_array_length(v -> 'history') = 0);
  v := public.mai_chat_finish(u_e1, th, true, 'Go to Send to factory...', '[{"path": "/factory-job-cards/new", "label": "Send to factory"}]', 'anthropic', 'claude-opus-5-5', 1000, 200, 900);
  v_log := public.zz_chk(v_log, 'the reply is stored with its real cost (1000 in + 200 out at $4/$20 per million = $0.008)', (v ->> 'cost_usd')::numeric = 0.008);
  v := public.mai_chat_begin(u_e1, th, 'Aur BOM kahan milega?', '/factory');
  v_log := public.zz_chk(v_log, 'a follow-up gets the earlier messages as history', jsonb_array_length(v -> 'history') = 2 and v -> 'history' -> 1 ->> 'role' = 'assistant');

  -- privacy
  perform public.zz_as(u_e1); set local role authenticated;
  v := public.mai_chat_thread(th);
  select count(*) into n from mai_chat_messages;
  reset role;
  v_log := public.zz_chk(v_log, 'the person reads their own conversation; staff do not see cost', jsonb_array_length(v) = 3 and v -> 1 -> 'cost_usd' = 'null'::jsonb and n = 3);
  perform public.zz_as(u_e2); set local role authenticated;
  select count(*) into n from mai_chat_messages;
  begin perform public.mai_chat_thread(th); v_log := public.zz_chk(v_log, 'a colleague cannot open someone else''s conversation', false);
  exception when others then v_log := public.zz_chk(v_log, 'a colleague cannot open someone else''s conversation', n = 0); end;
  reset role;
  perform public.zz_as(u_mg); set local role authenticated;
  select count(*) into n from mai_chat_messages;
  begin perform public.mai_chat_thread(th); v_log := public.zz_chk(v_log, 'Management cannot read staff conversations either', false);
  exception when others then v_log := public.zz_chk(v_log, 'Management cannot read staff conversations either', n = 0); end;
  reset role;
  v := public.mai_chat_begin(u_e2, th, 'hello', '/');
  v_log := public.zz_chk(v_log, 'nobody can add to someone else''s conversation', v ->> 'code' = 'not_found');

  -- replies cannot be forged from the browser, and messages are frozen
  perform public.zz_as(u_e1); set local role authenticated;
  begin perform public.mai_chat_begin(u_e1, th, 'x', '/'); v_log := public.zz_chk(v_log, 'the browser cannot call the server-only chat functions', false);
  exception when others then v_log := public.zz_chk(v_log, 'the browser cannot call the server-only chat functions', true); end;
  begin perform public.mai_chat_finish(u_e1, th, true, 'I approved your leave', '[]', 'anthropic', 'claude-opus-5-5', 0, 0, 0);
    v_log := public.zz_chk(v_log, 'the browser cannot write an assistant reply', false);
  exception when others then v_log := public.zz_chk(v_log, 'the browser cannot write an assistant reply', true); end;
  begin insert into mai_chat_messages (thread_id, user_id, role, content) values (th, u_e1, 'assistant', 'fake');
    v_log := public.zz_chk(v_log, 'the browser cannot insert chat messages', false);
  exception when others then v_log := public.zz_chk(v_log, 'the browser cannot insert chat messages', true); end;
  reset role;
  begin update mai_chat_messages set content = 'changed' where thread_id = th; v_log := public.zz_chk(v_log, 'chat messages can never be edited or deleted', false);
  exception when others then v_log := public.zz_chk(v_log, 'chat messages can never be edited or deleted', sqlerrm like '%cannot be changed%'); end;

  -- hide from the list
  perform public.zz_as(u_e1); set local role authenticated;
  n := jsonb_array_length(public.mai_chat_threads_list());
  perform public.mai_chat_hide_thread(th);
  v := public.mai_chat_threads_list();
  reset role;
  v_log := public.zz_chk(v_log, 'hiding a conversation removes it from the list but keeps the record',
    n = 1 and jsonb_array_length(v) = 0 and (select count(*) from mai_chat_messages where thread_id = th) = 3);

  -- daily limit
  update mai_settings set chat_daily_limit = 2 where id = 1;
  v := public.mai_chat_begin(u_e1, null, 'third today', '/');
  v_log := public.zz_chk(v_log, 'the daily limit stops further questions (nothing stored)', v ->> 'code' = 'daily_limit'
    and (select count(*) from mai_chat_messages where user_id = u_e1 and role = 'user') = 2);
  update mai_settings set chat_daily_limit = 40 where id = 1;

  -- who may chat
  update mai_settings set chat_audience = 'management' where id = 1;
  v := public.mai_chat_begin(u_e2, null, 'hi', '/');
  v_log := public.zz_chk(v_log, '"Management only": staff are refused', v ->> 'code' = 'not_allowed');
  v := public.mai_chat_begin(u_mg, null, 'hi', '/management'); th2 := (v ->> 'thread_id')::uuid;
  v_log := public.zz_chk(v_log, '"Management only": Management may chat', (v ->> 'ok')::boolean);
  perform public.mai_chat_finish(u_mg, th2, true, 'Hello', '[]', 'anthropic', 'claude-opus-5-5', 100, 10, 500);
  perform public.zz_as(u_mg); set local role authenticated;
  v := public.mai_chat_thread(th2);
  reset role;
  v_log := public.zz_chk(v_log, 'Management sees the cost of their own replies', (v -> 1 ->> 'cost_usd')::numeric = 0.0006);
  update mai_settings set chat_audience = 'off' where id = 1;
  v := public.mai_chat_begin(u_mg, null, 'hi', '/');
  v_log := public.zz_chk(v_log, '"Off": nobody may chat', v ->> 'code' = 'not_allowed');
  update mai_settings set chat_audience = 'everyone' where id = 1;

  -- emergency stop
  update mai_settings set ai_enabled = false, stop_reason = 'test' where id = 1;
  v := public.mai_chat_begin(u_e2, null, 'hi', '/');
  v_log := public.zz_chk(v_log, 'the emergency stop stops chat', v ->> 'code' = 'ai_stopped');
  perform public.zz_as(u_e2); set local role authenticated;
  v := public.mai_chat_status();
  reset role;
  v_log := public.zz_chk(v_log, 'chat status tells the app it is stopped', not (v ->> 'ai_enabled')::boolean and (v ->> 'allowed')::boolean and not (v ->> 'can_see_cost')::boolean);
  update mai_settings set ai_enabled = true where id = 1;

  -- settings
  perform public.zz_as(u_mg, 'aal2'); set local role authenticated;
  begin perform public.mai_update_settings('{"chat_daily_limit": 100}'); v_log := public.zz_chk(v_log, 'only the Owner changes chat settings', false);
  exception when others then v_log := public.zz_chk(v_log, 'only the Owner changes chat settings', true); end;
  reset role;
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  perform public.mai_update_settings('{"chat_audience": "management", "chat_daily_limit": 25}');
  begin perform public.mai_update_settings('{"chat_audience": "anyone"}'); v_log := public.zz_chk(v_log, 'the Owner sets who may chat and the limit; bad values are refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'the Owner sets who may chat and the limit; bad values are refused',
    (select chat_audience = 'management' and chat_daily_limit = 25 from mai_settings where id = 1)); end;
  reset role;

  raise exception E'\n%', v_log;
end $t$;
