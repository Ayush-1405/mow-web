-- v3_23 developer requests + Owner notifications: only the Owner/backup drafts and reads them; submitting needs the
-- authenticator app; the developer reports progress server-side and every step reaches the Owner's bell; history is frozen.
-- Own fixtures; ALWAYS rolls back (the report is in the error message).
do $t$
declare
  v_log text := ''; v jsonb; d jsonb; rid uuid; ref text; n int; r_emp uuid; r_mgmt uuid; d_int uuid; d_ctl uuid; th uuid;
  u_own uuid := gen_random_uuid(); u_bk uuid := gen_random_uuid(); u_mg uuid := gen_random_uuid(); u_emp uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid, p_aal text default 'aal1') returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true); end $f$;
  select id into r_emp from roles where code = 'employee';
  select id into r_mgmt from roles where code = 'management';
  select id into d_int from departments where code = 'INTERIOR';
  select id into d_ctl from departments where is_control_tower limit 1;
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_own, u_bk, u_mg, u_emp]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_own, 'ZZ-DR-O', 'ZZ Owner', r_mgmt, d_ctl, '9888860001', false, true),
    (u_bk, 'ZZ-DR-B', 'ZZ Backup', r_mgmt, d_ctl, '9888860002', false, true),
    (u_mg, 'ZZ-DR-M', 'ZZ Manager', r_mgmt, d_ctl, '9888860003', false, true),
    (u_emp, 'ZZ-DR-E', 'ZZ Employee', r_emp, d_int, '9888860004', false, true);
  perform set_config('mai.owner_change', 'on', true);
  update mai_owners set is_active = false where is_active;
  perform set_config('mai.owner_change', 'off', true);
  insert into mai_owners (user_id, kind) values (u_own, 'OWNER'), (u_bk, 'BACKUP');
  update mai_settings set ai_enabled = true, chat_audience = 'everyone' where id = 1;
  th := (public.mai_chat_begin(u_own, null, 'add a wastage report', '/') ->> 'thread_id')::uuid;

  -- drafting (the chat function, service role)
  begin perform public.mai_dev_draft_internal(u_mg, null, 'x', '{"title": "x", "prompt": "x"}', 'm');
    v_log := public.zz_chk(v_log, 'Management (not Owner/backup) cannot create developer requests', false);
  exception when others then v_log := public.zz_chk(v_log, 'Management (not Owner/backup) cannot create developer requests', true); end;
  d := public.mai_dev_draft_internal(u_own, th, 'factory ma wastage report joie che',
    '{"title": "Factory wastage report", "goal": "See wastage per month", "details": "...", "acceptance": ["a", "b"], "areas": ["Factory"], "risk": "LOW", "questions": [], "prompt": "Build a wastage report ..."}', 'gemini-3.5-flash');
  rid := (d ->> 'id')::uuid; ref := d ->> 'ref';
  v_log := public.zz_chk(v_log, 'the Owner''s wish is saved as a numbered DRAFT with the full prompt',
    ref ~ '^DR-\d{4}$' and (select status = 'DRAFT' and prompt = 'Build a wastage report ...' and risk = 'LOW' from mai_dev_requests where id = rid)
    and (select count(*) from mai_dev_events where request_id = rid) = 1);

  -- reading
  perform public.zz_as(u_mg); set local role authenticated;
  select count(*) into n from mai_dev_requests;
  begin perform public.mai_dev_list(); v_log := public.zz_chk(v_log, 'Management cannot see developer requests', false);
  exception when others then v_log := public.zz_chk(v_log, 'Management cannot see developer requests', n = 0); end;
  reset role;
  perform public.zz_as(u_bk); set local role authenticated;
  v := public.mai_dev_list();
  reset role;
  v_log := public.zz_chk(v_log, 'the backup approver sees them with their history', jsonb_array_length(v) >= 1 and jsonb_array_length(v -> 0 -> 'events') = 1);

  -- the developer cannot start a draft
  begin perform public.mai_dev_report(ref, 'IN_PROGRESS', 'starting'); v_log := public.zz_chk(v_log, 'the developer cannot start work on an unsubmitted draft', false);
  exception when others then v_log := public.zz_chk(v_log, 'the developer cannot start work on an unsubmitted draft', sqlerrm like '%not submitted%'); end;

  -- submitting needs the authenticator app
  perform public.zz_as(u_own, 'aal1'); set local role authenticated;
  begin perform public.mai_dev_submit(rid); v_log := public.zz_chk(v_log, 'submitting without the authenticator app is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'submitting without the authenticator app is refused', sqlerrm like '%authenticator%'); end;
  perform public.mai_dev_edit(rid, 'Factory wastage report (monthly)', null);
  reset role;
  perform public.zz_as(u_mg, 'aal2'); set local role authenticated;
  begin perform public.mai_dev_submit(rid); v_log := public.zz_chk(v_log, 'Management cannot submit even when verified', false);
  exception when others then v_log := public.zz_chk(v_log, 'Management cannot submit even when verified', true); end;
  reset role;
  select count(*) into n from notifications where recipient_id = u_bk and entity_type = 'MOOD_AI';
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  perform public.mai_dev_submit(rid, 'go ahead');
  reset role;
  v_log := public.zz_chk(v_log, 'the verified Owner submits it (= approval to build on a branch); the backup is told',
    (select status = 'SUBMITTED' and submitted_by = u_own and title = 'Factory wastage report (monthly)' from mai_dev_requests where id = rid)
    and (select count(*) from notifications where recipient_id = u_bk and entity_type = 'MOOD_AI') = n + 1);
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  begin perform public.mai_dev_edit(rid, 'changed', 'changed'); v_log := public.zz_chk(v_log, 'a submitted request can no longer be edited', false);
  exception when others then v_log := public.zz_chk(v_log, 'a submitted request can no longer be edited', true); end;
  reset role;

  -- developer progress -> Owner's bell
  select count(*) into n from notifications where recipient_id = u_own and entity_type = 'MOOD_AI';
  perform public.mai_dev_report(ref, 'IN_PROGRESS', 'Working on branch mood-ai/dr', 'mood-ai/dr', null);
  perform public.mai_dev_report(ref, 'NEEDS_INFO', 'Which factory units should be included?');
  v_log := public.zz_chk(v_log, 'every developer step notifies the Owner in the app',
    (select count(*) from notifications where recipient_id = u_own and entity_type = 'MOOD_AI') = n + 2
    and exists (select 1 from notifications where recipient_id = u_own and title_en like ref || ' needs your answer:%')
    and (select branch from mai_dev_requests where id = rid) = 'mood-ai/dr');
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  perform public.mai_dev_answer(rid, 'All units');
  reset role;
  v_log := public.zz_chk(v_log, 'the Owner''s answer sends it back to the developer',
    (select status from mai_dev_requests where id = rid) = 'SUBMITTED' and exists (select 1 from mai_dev_events where request_id = rid and note = 'Owner answered: All units'));
  begin perform public.mai_dev_report(ref, 'WHATEVER', 'x'); v_log := public.zz_chk(v_log, 'unknown statuses are refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'unknown statuses are refused', true); end;

  -- the app cannot fake the developer or change history
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  begin perform public.mai_dev_report(ref, 'LIVE', 'pretend'); v_log := public.zz_chk(v_log, 'the app cannot post developer reports', false);
  exception when others then v_log := public.zz_chk(v_log, 'the app cannot post developer reports', true); end;
  begin update mai_dev_requests set status = 'LIVE' where id = rid; get diagnostics n = row_count;
    v_log := public.zz_chk(v_log, 'the app cannot change a request directly', n = 0);
  exception when others then v_log := public.zz_chk(v_log, 'the app cannot change a request directly', true); end;
  reset role;
  begin delete from mai_dev_events where request_id = rid; v_log := public.zz_chk(v_log, 'request history can never be changed or deleted', false);
  exception when others then v_log := public.zz_chk(v_log, 'request history can never be changed or deleted', sqlerrm like '%cannot be changed%'); end;

  -- cancel
  perform public.zz_as(u_own); set local role authenticated;
  perform public.mai_dev_cancel(rid, 'not needed');
  reset role;
  begin perform public.mai_dev_report(ref, 'IN_PROGRESS', 'x'); v_log := public.zz_chk(v_log, 'a cancelled request cannot be worked on', false);
  exception when others then v_log := public.zz_chk(v_log, 'a cancelled request cannot be worked on', true); end;

  -- phase reports
  select count(*) into n from notifications where entity_type = 'MOOD_AI' and recipient_id in (u_own, u_bk);
  perform public.mai_phase_report('Phase C', 'floating chat complete');
  v_log := public.zz_chk(v_log, 'a phase report reaches the Owner and backup and is kept in the audit log',
    (select count(*) from notifications where entity_type = 'MOOD_AI' and recipient_id in (u_own, u_bk)) = n + 2
    and exists (select 1 from mai_audit where action = 'PHASE_REPORT' and detail ->> 'phase' = 'Phase C'));
  perform public.zz_as(u_emp); set local role authenticated;
  begin perform public.mai_phase_report('x', 'y'); v_log := public.zz_chk(v_log, 'staff cannot send phase reports or owner notifications', false);
  exception when others then v_log := public.zz_chk(v_log, 'staff cannot send phase reports or owner notifications', true); end;
  v := public.mai_chat_status();
  reset role;
  perform public.zz_as(u_bk); set local role authenticated;
  d := public.mai_chat_status();
  reset role;
  v_log := public.zz_chk(v_log, 'chat status shows the developer-request switch only to the Owner/backup', not (v ->> 'is_owner')::boolean and (d ->> 'is_owner')::boolean);

  raise exception E'\n%', v_log;
end $t$;
