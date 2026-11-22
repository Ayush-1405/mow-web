-- v3_26 live build tracking + Owner-verified merge: only the worker holding a request writes its log / report; the log is
-- append-only and Owner/backup-only; merging needs the authenticator app, a passing report and the exact reviewed commit;
-- the laptop only reports MERGED (never LIVE); failed merges and stale approvals go back to review.
-- Own fixtures; ALWAYS rolls back (the report is in the error message).
do $t$
declare
  v_log text := ''; v jsonb; tok text; tok2 text; w uuid; d jsonb; rid uuid; v_ref text; rid2 uuid; v_ref2 text; n int; r_mgmt uuid; d_ctl uuid;
  u_own uuid := gen_random_uuid(); u_mg uuid := gen_random_uuid();
  pass_checks jsonb := '[{"name": "frontend build", "ok": true, "ms": 1200, "tail": "built"}, {"name": "worker tests", "ok": true, "ms": 300}]';
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
    (u_own, 'ZZ-LB-O', 'ZZ Owner', r_mgmt, d_ctl, '9888880001', false, true),
    (u_mg, 'ZZ-LB-M', 'ZZ Manager', r_mgmt, d_ctl, '9888880002', false, true);
  perform set_config('mai.owner_change', 'on', true);
  update mai_owners set is_active = false where is_active;
  perform set_config('mai.owner_change', 'off', true);
  insert into mai_owners (user_id, kind) values (u_own, 'OWNER');
  update mai_settings set ai_enabled = true, dev_agent = 'laptop' where id = 1;
  update mai_dev_requests set status = 'CANCELLED', worker_id = null where status in ('SUBMITTED', 'IN_PROGRESS', 'NEEDS_INFO', 'MERGE_APPROVED');

  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  tok := public.mai_worker_register('ZZ build laptop') ->> 'token';
  tok2 := public.mai_worker_register('ZZ other laptop') ->> 'token';
  reset role;
  select id into w from mai_workers where name = 'ZZ build laptop';
  d := public.mai_dev_draft_internal(u_own, null, 'x', '{"title": "Live 1", "prompt": "Do L1"}', 'm'); rid := (d ->> 'id')::uuid; v_ref := d ->> 'ref';
  d := public.mai_dev_draft_internal(u_own, null, 'y', '{"title": "Live 2", "prompt": "Do L2"}', 'm'); rid2 := (d ->> 'id')::uuid; v_ref2 := d ->> 'ref';

  -- nothing can be logged for a request nobody holds (draft)
  perform public.zz_anon(); set local role anon;
  begin perform public.mai_worker_dev_log(tok, v_ref, '[{"s": "stdout", "t": "x"}]'); v_log := public.zz_chk(v_log, 'no log for a request the laptop does not hold', false);
  exception when others then v_log := public.zz_chk(v_log, 'no log for a request the laptop does not hold', sqlerrm like '%does not hold%'); end;
  reset role;

  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  perform public.mai_dev_submit(rid);
  reset role;
  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_heartbeat(tok, '{"claude": {"up": true}}', 'RUNNING', null, '1.4.0', 'h', now());
  perform public.mai_worker_heartbeat(tok2, '{"claude": {"up": true}}', 'RUNNING', null, '1.4.0', 'h2', now());
  v := public.mai_worker_dev_claim(tok);
  n := public.mai_worker_dev_log(tok, v_ref, jsonb_build_array(
    jsonb_build_object('s', 'progress', 't', 'Run started'), jsonb_build_object('s', 'stdout', 't', 'line two'),
    jsonb_build_object('s', 'weird', 't', 'odd stream'), jsonb_build_object('s', 'stderr', 't', repeat('e', 5000))));
  reset role;
  v_log := public.zz_chk(v_log, 'the holding laptop appends log lines (unknown stream -> stdout, long lines capped)',
    n = 4 and (select count(*) from mai_dev_logs where request_id = rid) = 4
    and (select stream from mai_dev_logs where request_id = rid and line = 'odd stream') = 'stdout'
    and (select max(length(line)) from mai_dev_logs where request_id = rid) = 2000);

  perform public.zz_anon(); set local role anon;
  begin perform public.mai_worker_dev_log(tok2, v_ref, '[{"s": "stdout", "t": "spoof"}]'); v_log := public.zz_chk(v_log, 'another laptop cannot write the log', false);
  exception when others then v_log := public.zz_chk(v_log, 'another laptop cannot write the log', true); end;
  begin perform public.mai_worker_dev_log('not-a-valid-token-not-a-valid-token-xx', v_ref, '[]'); v_log := public.zz_chk(v_log, 'a wrong token cannot write the log', false);
  exception when others then v_log := public.zz_chk(v_log, 'a wrong token cannot write the log', sqlerrm like '%not authorized%'); end;
  begin insert into mai_dev_logs (request_id, line) values (rid, 'direct'); v_log := public.zz_chk(v_log, 'anon cannot insert log rows directly', false);
  exception when others then v_log := public.zz_chk(v_log, 'anon cannot insert log rows directly', true); end;
  reset role;

  -- who can read
  perform public.zz_as(u_mg, 'aal2'); set local role authenticated;
  select count(*) into n from mai_dev_logs;
  v_log := public.zz_chk(v_log, 'a manager who is not the Owner sees no log rows (RLS)', n = 0);
  begin perform public.mai_dev_detail(rid); v_log := public.zz_chk(v_log, 'a manager cannot open the build detail', false);
  exception when others then v_log := public.zz_chk(v_log, 'a manager cannot open the build detail', true); end;
  begin insert into mai_dev_logs (request_id, line) values (rid, 'direct'); v_log := public.zz_chk(v_log, 'the app cannot insert log rows', false);
  exception when others then v_log := public.zz_chk(v_log, 'the app cannot insert log rows', true); end;
  reset role;
  perform public.zz_as(u_own); set local role authenticated;
  v := public.mai_dev_detail(rid);
  reset role;
  v_log := public.zz_chk(v_log, 'the Owner sees the live log in order and the request is shown as building',
    jsonb_array_length(v -> 'logs') = 4 and v -> 'logs' -> 0 ->> 't' = 'Run started' and (v ->> 'building')::boolean and v ->> 'status' = 'IN_PROGRESS');
  perform public.zz_as(u_own); set local role authenticated;
  v := public.mai_dev_detail(rid, ((v -> 'logs' -> 1 ->> 'id'))::bigint);
  reset role;
  v_log := public.zz_chk(v_log, 'detail with p_after returns only newer lines', jsonb_array_length(v -> 'logs') = 2);

  begin update mai_dev_logs set line = 'changed' where request_id = rid; v_log := public.zz_chk(v_log, 'log lines cannot be changed', false);
  exception when others then v_log := public.zz_chk(v_log, 'log lines cannot be changed', sqlerrm like '%cannot be changed%'); end;
  begin delete from mai_dev_logs where request_id = rid; v_log := public.zz_chk(v_log, 'log lines cannot be deleted', false);
  exception when others then v_log := public.zz_chk(v_log, 'log lines cannot be deleted', true); end;

  -- report: a failing check first
  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_dev_result(tok, v_ref, '[{"name": "frontend lint", "ok": false, "ms": "oops", "tail": "2 errors"}, {"name": "worker tests", "ok": "yes"}]',
    ' 2 files changed', 'diff --git a/x b/x' || repeat('+', 300100));
  perform public.mai_worker_dev_report(tok, v_ref, 'READY_FOR_REVIEW', 'Built', 'mood-ai/' || v_ref, 'abc1234');
  begin perform public.mai_worker_dev_result(tok, v_ref, pass_checks, null, null); v_log := public.zz_chk(v_log, 'after reporting, the laptop can no longer change the report', false);
  exception when others then v_log := public.zz_chk(v_log, 'after reporting, the laptop can no longer change the report', true); end;
  reset role;
  v_log := public.zz_chk(v_log, 'report stored and sanitised (bad ms dropped, non-true ok is a fail, patch capped and flagged)',
    (select jsonb_array_length(checks) = 2 and checks -> 0 ->> 'ms' is null and checks -> 1 -> 'ok' = 'false'::jsonb
       and length(diff_patch) = 300000 and diff_truncated and diff_stat = ' 2 files changed' from mai_dev_requests where id = rid));

  perform public.zz_as(u_own); set local role authenticated;
  v := public.mai_dev_list();
  reset role;
  v_log := public.zz_chk(v_log, 'the list leaves out the large patch', not ((select x from jsonb_array_elements(v) x where x ->> 'id' = rid::text) ? 'diff_patch'));

  -- merge approval
  perform public.zz_as(u_own, 'aal1'); set local role authenticated;
  begin perform public.mai_dev_approve_merge(rid, 'abc1234'); v_log := public.zz_chk(v_log, 'merging without the authenticator app is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'merging without the authenticator app is refused', sqlerrm like '%authenticator%'); end;
  reset role;
  perform public.zz_as(u_mg, 'aal2'); set local role authenticated;
  begin perform public.mai_dev_approve_merge(rid, 'abc1234'); v_log := public.zz_chk(v_log, 'a verified manager who is not the Owner cannot approve a merge', false);
  exception when others then v_log := public.zz_chk(v_log, 'a verified manager who is not the Owner cannot approve a merge', true); end;
  reset role;
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  begin perform public.mai_dev_approve_merge(rid, 'abc1234'); v_log := public.zz_chk(v_log, 'a failing check blocks the merge', false);
  exception when others then v_log := public.zz_chk(v_log, 'a failing check blocks the merge', sqlerrm like '%must pass%'); end;
  reset role;
  update mai_dev_requests set checks = pass_checks where id = rid; -- fixture: the re-run passed
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  begin perform public.mai_dev_approve_merge(rid, 'zzz9999'); v_log := public.zz_chk(v_log, 'approving a different commit than the reviewed one is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'approving a different commit than the reviewed one is refused', sqlerrm like '%changed since%'); end;
  perform public.mai_dev_approve_merge(rid, 'abc1234');
  reset role;
  v_log := public.zz_chk(v_log, 'verified Owner approval -> MERGE_APPROVED, recorded and audited',
    (select status = 'MERGE_APPROVED' and merge_approved_by = u_own from mai_dev_requests where id = rid)
    and exists (select 1 from mai_dev_events where request_id = rid and status = 'MERGE_APPROVED' and actor = u_own)
    and exists (select 1 from mai_audit where action = 'DEV_MERGE_APPROVED' and detail ->> 'commit' = 'abc1234'));
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  begin perform public.mai_dev_approve_merge(rid, 'abc1234'); v_log := public.zz_chk(v_log, 'a merge cannot be approved twice', false);
  exception when others then v_log := public.zz_chk(v_log, 'a merge cannot be approved twice', true); end;
  reset role;

  -- the laptop merges
  update mai_workers set paused = true where id = w;
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_dev_merge_claim(tok);
  reset role;
  v_log := public.zz_chk(v_log, 'a paused laptop does not merge', v is null);
  update mai_workers set paused = false where id = w;
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_dev_merge_claim(tok);
  reset role;
  v_log := public.zz_chk(v_log, 'the laptop takes the approved merge with the reviewed commit',
    v ->> 'ref' = v_ref and v ->> 'commit' = 'abc1234' and (select worker_id = w from mai_dev_requests where id = rid));
  perform public.zz_as(u_own); set local role authenticated;
  begin perform public.mai_dev_cancel(rid); v_log := public.zz_chk(v_log, 'a request cannot be cancelled in the middle of its merge', false);
  exception when others then v_log := public.zz_chk(v_log, 'a request cannot be cancelled in the middle of its merge', true); end;
  reset role;
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_dev_merge_claim(tok2);
  begin perform public.mai_worker_dev_merge_report(tok2, v_ref, true, 'spoof', 'fff'); v_log := public.zz_chk(v_log, 'another laptop cannot report the merge', false);
  exception when others then v_log := public.zz_chk(v_log, 'another laptop cannot report the merge', v is null); end;
  begin perform public.mai_worker_dev_report(tok, v_ref, 'LIVE', 'x'); v_log := public.zz_chk(v_log, 'the laptop still can never mark it live', false);
  exception when others then v_log := public.zz_chk(v_log, 'the laptop still can never mark it live', true); end;
  reset role;
  select count(*) into n from notifications where recipient_id = u_own and entity_type = 'MOOD_AI';  -- counted as the test itself, not as the laptop
  perform public.zz_anon(); set local role anon;
  perform public.mai_worker_dev_merge_report(tok, v_ref, true, 'Merged into local main as def5678 (not pushed)', 'def5678');
  reset role;
  v_log := public.zz_chk(v_log, 'merged: MERGED (not LIVE), merged commit kept, lock released, Owner notified',
    (select status = 'MERGED' and merged_commit = 'def5678' and worker_id is null from mai_dev_requests where id = rid)
    and (select count(*) from notifications where recipient_id = u_own and entity_type = 'MOOD_AI') = n + 1);
  perform public.zz_as(u_own); set local role authenticated;
  begin perform public.mai_dev_cancel(rid); v_log := public.zz_chk(v_log, 'a merged request cannot be cancelled', false);
  exception when others then v_log := public.zz_chk(v_log, 'a merged request cannot be cancelled', true); end;
  reset role;

  -- second request: the merge fails, then an approval that is never used expires
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  perform public.mai_dev_submit(rid2);
  reset role;
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_dev_claim(tok);
  perform public.mai_worker_dev_result(tok, v_ref2, pass_checks, ' 1 file changed', 'diff');
  perform public.mai_worker_dev_report(tok, v_ref2, 'READY_FOR_REVIEW', 'Built', 'mood-ai/' || v_ref2, 'aaa1111');
  reset role;
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  perform public.mai_dev_approve_merge(rid2, 'aaa1111');
  reset role;
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_dev_merge_claim(tok);
  perform public.mai_worker_dev_merge_report(tok, v_ref2, false, 'main has uncommitted changes');
  reset role;
  v_log := public.zz_chk(v_log, 'a failed merge goes back to review and the approval is cleared',
    (select status = 'READY_FOR_REVIEW' and merge_approved_by is null and worker_id is null from mai_dev_requests where id = rid2)
    and exists (select 1 from mai_dev_events where request_id = rid2 and note like 'Merge not done:%'));
  perform public.zz_as(u_own, 'aal2'); set local role authenticated;
  perform public.mai_dev_approve_merge(rid2, 'aaa1111');
  reset role;
  update mai_dev_requests set merge_approved_at = now() - interval '25 hours' where id = rid2;
  perform public.zz_anon(); set local role anon;
  v := public.mai_worker_dev_merge_claim(tok);
  reset role;
  v_log := public.zz_chk(v_log, 'a merge approval not used within 24 hours expires back to review',
    v is null and (select status = 'READY_FOR_REVIEW' and merge_approved_at is null from mai_dev_requests where id = rid2));

  begin update mai_dev_requests set status = 'SHIPPED' where id = rid2; v_log := public.zz_chk(v_log, 'unknown statuses are still refused by the table', false);
  exception when others then v_log := public.zz_chk(v_log, 'unknown statuses are still refused by the table', true); end;

  raise exception E'\n%', v_log;
end $t$;
