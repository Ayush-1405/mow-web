-- v3_17 AI Employee Performance, end to end on fixtures:
-- task attribution and points, fairness rules (creator / cancelled / reassigned / colleague / excused delay / few tasks),
-- privacy (employee, other employee, other department, Head, Management, HR grant), monthly snapshot + duplicate prevention,
-- permanence, AI review saved once, Head feedback + goals, employee response, Management final, versioned recalculation,
-- next month separate snapshot with comparison and goal tracking, deadline not counted twice, company report, settings.
-- Own fixtures, ALWAYS rolls back (the report is in the error message).

do $t$
declare
  v_log text := ''; n int; v jsonb; v2 jsonb; m1 date; m2 date; rep public.perf_monthly_reports; rep2 public.perf_monthly_reports; v_id uuid; v_ok boolean;
  r_emp uuid; r_head uuid; r_mgmt uuid; d_int uuid; d_proc uuid; d_ctl uuid; s_done uuid; s_ver uuid; s_prog uuid; tt uuid; pr uuid; pf uuid;
  u_e1 uuid := gen_random_uuid(); u_e2 uuid := gen_random_uuid(); u_h uuid := gen_random_uuid(); u_o uuid := gen_random_uuid(); u_m uuid := gen_random_uuid();
  t1 uuid; t2 uuid; t3 uuid; t4 uuid; t5 uuid; t6 uuid; t7 uuid; t8 uuid; t9 uuid; t10 uuid;
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true); end $f$;
  create function public.zz_ts(p_day date, p_hour int) returns timestamptz language sql immutable as $f$
    select (p_day::timestamp + make_interval(hours => p_hour)) at time zone 'Asia/Kolkata' $f$;
  create function public.zz_msg(p_task uuid, p_user uuid, p_at timestamptz) returns void language sql as $f$
    insert into chat_messages (conversation_id, sender_id, body, created_at, task_id)
    values ((select id from chat_conversations where task_id = p_task order by created_at limit 1), p_user, 'zz update', p_at, p_task) $f$;
  create function public.zz_row(p jsonb, p_task uuid) returns jsonb language sql immutable as $f$
    select x from jsonb_array_elements(p -> 'tasks') x where x ->> 'task_id' = p_task::text $f$;

  m1 := (public.perf_current_month() - interval '2 months')::date;
  m2 := (public.perf_current_month() - interval '1 month')::date;
  select id into r_emp from roles where code = 'employee';
  select id into r_head from roles where code = 'dept_head';
  select id into r_mgmt from roles where code = 'management';
  select id into d_int from departments where code = 'INTERIOR';
  select id into d_proc from departments where code = 'PROCUREMENT';
  select id into d_ctl from departments where is_control_tower limit 1;
  select id into s_done from status_master where code = 'COMPLETED';
  select id into s_ver from status_master where code = 'VERIFIED';
  select id into s_prog from status_master where code = 'IN_PROGRESS';
  select id into tt from task_types limit 1;
  select id into pr from priority_master where code = 'NORMAL';
  select id into pf from proof_types where code = 'none';

  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_e1, u_e2, u_h, u_o, u_m]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active, created_at) values
    (u_e1, 'ZZ-PF-E1', 'ZZ Employee One', r_emp, d_int, '9888810001', false, true, m1 - 30),
    (u_e2, 'ZZ-PF-E2', 'ZZ Employee Two', r_emp, d_int, '9888810002', false, true, m1 - 30),
    (u_h, 'ZZ-PF-H', 'ZZ Interior Head', r_head, d_int, '9888810003', false, true, m1 - 30),
    (u_o, 'ZZ-PF-O', 'ZZ Procurement Person', r_emp, d_proc, '9888810004', false, true, m1 - 30),
    (u_m, 'ZZ-PF-M', 'ZZ Management', r_mgmt, coalesce(d_ctl, d_int), '9888810005', false, true, m1 - 30);

  create function public.zz_mk(p_title text, p_from uuid, p_to uuid, p_by uuid, p_user uuid, p_due date, p_status text, p_assigned timestamptz,
                               p_completed timestamptz, p_verified timestamptz, p_active boolean default true) returns uuid language plpgsql as $f$
  declare v uuid;
  begin
    insert into staff_tasks (title, task_type_id, priority_id, status_id, proof_type_id, from_department_id, to_department_id, assigned_by, assigned_to,
        verifier_id, current_owner_id, due_date, created_at, assigned_at, accepted_at, accepted_by, started_at, completed_at, completed_by, verified_at, verified_by,
        is_active, proof_verification_required)
    values (p_title, (select id from task_types limit 1), (select id from priority_master where code = 'NORMAL'), (select id from status_master where code = p_status),
        (select id from proof_types where code = 'none'), p_from, p_to, p_by, p_user, p_by, p_user, p_due, p_assigned, p_assigned,
        case when p_status <> 'ASSIGNED' then p_assigned + interval '2 hours' end, case when p_status <> 'ASSIGNED' then p_user end,
        case when p_status not in ('ASSIGNED', 'ACCEPTED') then p_assigned + interval '3 hours' end,
        p_completed, case when p_completed is not null then p_user end, p_verified, case when p_verified is not null then p_by end, p_active, true)
    returning id into v;
    insert into staff_task_assignees (task_id, user_id, assignment_role, assigned_by, assigned_at, acceptance_status, accepted_at, individual_status, completed_at)
    values (v, p_user, 'primary', p_by, p_assigned, case when p_status <> 'ASSIGNED' then 'ACCEPTED' else 'PENDING' end,
            case when p_status <> 'ASSIGNED' then p_assigned + interval '2 hours' end,
            case when p_status in ('COMPLETED', 'VERIFIED', 'CLOSED') then 'COMPLETED' when p_status = 'ASSIGNED' then 'ASSIGNED' else 'IN_PROGRESS' end, p_completed);
    return v;
  end $f$;

  -- e1, month 1
  t1 := public.zz_mk('ZZ on time verified', d_int, d_int, u_h, u_e1, m1 + 9, 'VERIFIED', public.zz_ts(m1 + 1, 10), public.zz_ts(m1 + 7, 12), public.zz_ts(m1 + 8, 12));
  perform public.zz_msg(t1, u_e1, public.zz_ts(m1 + 3, 11));
  t2 := public.zz_mk('ZZ two days late, not verified', d_int, d_int, u_h, u_e1, m1 + 9, 'COMPLETED', public.zz_ts(m1 + 1, 10), public.zz_ts(m1 + 11, 18), null);
  t3 := public.zz_mk('ZZ overdue at month end', d_int, d_int, u_h, u_e1, m1 + 19, 'IN_PROGRESS', public.zz_ts(m1 + 2, 10), null, null);
  t4 := public.zz_mk('ZZ created by e1 for e2', d_int, d_int, u_e1, u_e2, m1 + 14, 'COMPLETED', public.zz_ts(m1 + 2, 10), public.zz_ts(m1 + 10, 10), null);
  t5 := public.zz_mk('ZZ cancelled', d_int, d_int, u_h, u_e1, m1 + 12, 'ASSIGNED', public.zz_ts(m1 + 2, 10), null, null, false);
  insert into staff_audit_log (entity_type, entity_id, action, old_value, new_value, performed_by, performed_at) values ('task', t5, 'DELETE', '{"is_active": true}', '{"is_active": false}', u_h, public.zz_ts(m1 + 5, 10));
  t6 := public.zz_mk('ZZ reassigned away', d_int, d_int, u_h, u_e1, m2 + 15, 'ASSIGNED', public.zz_ts(m1 + 2, 10), null, null);
  update staff_task_assignees set is_active = false, removed_at = public.zz_ts(m1 + 4, 10), removal_reason = 'Reassigned' where task_id = t6 and user_id = u_e1;
  insert into staff_task_assignees (task_id, user_id, assignment_role, assigned_by, assigned_at, acceptance_status, individual_status)
    values (t6, u_e2, 'primary', u_h, public.zz_ts(m1 + 4, 10), 'PENDING', 'ASSIGNED');
  t7 := public.zz_mk('ZZ overdue, vendor delay', d_int, d_int, u_h, u_e1, m1 + 16, 'IN_PROGRESS', public.zz_ts(m1 + 2, 10), null, null);
  t8 := public.zz_mk('ZZ cross department with rework', d_proc, d_int, u_h, u_e1, m1 + 20, 'VERIFIED', public.zz_ts(m1 + 3, 10), public.zz_ts(m1 + 18, 10), public.zz_ts(m1 + 19, 10));
  perform public.zz_msg(t8, u_e1, public.zz_ts(m1 + 5, 11));
  insert into staff_audit_log (entity_type, entity_id, action, performed_by, performed_at) values ('task', t8, 'REOPEN', u_h, public.zz_ts(m1 + 17, 10));
  -- a shared task e2 completed; e1 was a second assignee and did not
  t9 := public.zz_mk('ZZ completed by colleague', d_int, d_int, u_h, u_e2, m1 + 12, 'COMPLETED', public.zz_ts(m1 + 2, 10), public.zz_ts(m1 + 11, 10), null);
  insert into staff_task_assignees (task_id, user_id, assignment_role, assigned_by, assigned_at, acceptance_status, individual_status)
    values (t9, u_e1, 'secondary', u_h, public.zz_ts(m1 + 2, 10), 'ACCEPTED', 'IN_PROGRESS');
  -- procurement person, month 1 (other department)
  t10 := public.zz_mk('ZZ procurement work', d_proc, d_proc, u_h, u_o, m1 + 9, 'VERIFIED', public.zz_ts(m1 + 1, 10), public.zz_ts(m1 + 8, 10), public.zz_ts(m1 + 8, 12));

  ---------------------------------------------------------------- scoring + fairness (live engine)
  perform public.zz_as(u_e1); set local role authenticated;
  v := public.perf_live(null, m1);
  reset role;
  v_log := public.zz_chk(v_log, 'on-time, verified task with updates earns the full 100 points', (public.zz_row(v, t1) ->> 'points')::numeric = 100);
  v_log := public.zz_chk(v_log, 'a late, unverified task earns less and says why',
    (public.zz_row(v, t2) ->> 'points')::numeric < 100 and (public.zz_row(v, t2) ->> 'explanation') like '%late%' and (public.zz_row(v, t2) ->> 'explanation') like '%waiting for verification%');
  v_log := public.zz_chk(v_log, 'an open task past its due date counts against completion and deadline', public.zz_row(v, t3) ->> 'outcome' = 'OVERDUE_OPEN'
    and (public.zz_row(v, t3) -> 'earned' ->> 'completion')::numeric = 0);
  v_log := public.zz_chk(v_log, 'creating a task for someone else earns no points', public.zz_row(v, t4) is null and (v -> 'metrics' ->> 'tasks_created')::int >= 1);
  v_log := public.zz_chk(v_log, 'a cancelled task is listed but not scored', public.zz_row(v, t5) ->> 'outcome' = 'CANCELLED' and not (public.zz_row(v, t5) ->> 'scored')::boolean);
  v_log := public.zz_chk(v_log, 'a task moved to someone else is not scored for the first person', public.zz_row(v, t6) ->> 'outcome' = 'REASSIGNED_AWAY'
    and not (public.zz_row(v, t6) ->> 'scored')::boolean);
  v_log := public.zz_chk(v_log, 'a task a colleague completed is not credited to you', public.zz_row(v, t9) ->> 'outcome' = 'COMPLETED_BY_COLLEAGUE');
  v_log := public.zz_chk(v_log, 'rework lowers quality and cross-department communication is credited',
    (public.zz_row(v, t8) -> 'earned' ->> 'quality')::numeric < (public.zz_row(v, t8) -> 'available' ->> 'quality')::numeric
    and (public.zz_row(v, t8) -> 'earned' ->> 'collaboration')::numeric = (public.zz_row(v, t8) -> 'available' ->> 'collaboration')::numeric);
  v_log := public.zz_chk(v_log, 'each task is counted once', (select count(*) from jsonb_array_elements(v -> 'tasks')) = (select count(distinct x ->> 'task_id') from jsonb_array_elements(v -> 'tasks') x));
  v_log := public.zz_chk(v_log, 'five scored tasks give an overall score', (v ->> 'overall_score') is not null and (v ->> 'scored_tasks')::int = 5);

  -- Head verifies the vendor delay -> not penalised
  perform public.zz_as(u_e2); set local role authenticated;
  begin perform public.perf_excuse_delay(t7, u_e1, 'VENDOR_DELAY', 'x'); v_log := public.zz_chk(v_log, 'a colleague cannot excuse a delay', false);
  exception when others then v_log := public.zz_chk(v_log, 'a colleague cannot excuse a delay', true); end;
  reset role;
  perform public.zz_as(u_h); set local role authenticated;
  perform public.perf_excuse_delay(t7, u_e1, 'VENDOR_DELAY', 'Vendor delivered the hinges late');
  v2 := public.perf_live(u_e1, m1);
  reset role;
  v_log := public.zz_chk(v_log, 'a delay the Head verified as a vendor delay is not penalised', public.zz_row(v2, t7) ->> 'outcome' = 'EXCUSED'
    and not (public.zz_row(v2, t7) ->> 'scored')::boolean and (v2 ->> 'raw_score')::numeric > (v ->> 'raw_score')::numeric);

  perform public.zz_as(u_e2); set local role authenticated;
  v2 := public.perf_live(null, m1);
  reset role;
  v_log := public.zz_chk(v_log, 'too few scored tasks give no overall score (insufficient data)', (v2 ->> 'overall_score') is null and v2 ->> 'confidence' = 'INSUFFICIENT'
    and (public.zz_row(v2, t4) ->> 'scored')::boolean);

  ---------------------------------------------------------------- privacy
  perform public.zz_as(u_e2); set local role authenticated;
  begin perform public.perf_live(u_e1, m1); v_log := public.zz_chk(v_log, 'an employee cannot see a colleague''s performance', false);
  exception when others then v_log := public.zz_chk(v_log, 'an employee cannot see a colleague''s performance', true); end;
  reset role;
  perform public.zz_as(u_o); set local role authenticated;
  begin perform public.perf_live(u_e1, m1); v_log := public.zz_chk(v_log, 'another department cannot see it', false);
  exception when others then v_log := public.zz_chk(v_log, 'another department cannot see it', true); end;
  reset role;
  perform public.zz_as(u_h); set local role authenticated;
  v := public.perf_team(m1, null);
  reset role;
  v_log := public.zz_chk(v_log, 'the Head sees their department but not other departments',
    exists (select 1 from jsonb_array_elements(v -> 'people') p where p ->> 'user_id' = u_e1::text)
    and not exists (select 1 from jsonb_array_elements(v -> 'people') p where p ->> 'user_id' = u_o::text));
  perform public.zz_as(u_m); set local role authenticated;
  v := public.perf_team(m1, null);
  reset role;
  v_log := public.zz_chk(v_log, 'Management sees every department', exists (select 1 from jsonb_array_elements(v -> 'people') p where p ->> 'user_id' = u_o::text)
    and exists (select 1 from jsonb_array_elements(v -> 'people') p where p ->> 'user_id' = u_e1::text));
  perform public.zz_as(u_m); set local role authenticated;
  perform public.perf_set_viewer(u_o, d_int, true);
  reset role;
  perform public.zz_as(u_o); set local role authenticated;
  v_ok := true; begin perform public.perf_live(u_e1, m1); exception when others then v_ok := false; end;
  begin perform public.perf_live(u_h, m1); exception when others then null; end;
  reset role;
  v_log := public.zz_chk(v_log, 'a person Management grants Interior access to (HR) can read Interior reports', v_ok);
  perform public.zz_as(u_m); set local role authenticated; perform public.perf_set_viewer(u_o, d_int, false); reset role;

  ---------------------------------------------------------------- month 1 snapshot
  perform public.zz_as(u_e1); set local role authenticated;
  begin perform public.perf_generate_month(m1); v_log := public.zz_chk(v_log, 'an employee cannot save a month', false);
  exception when others then v_log := public.zz_chk(v_log, 'an employee cannot save a month', true); end;
  reset role;
  perform public.zz_as(u_m); set local role authenticated;
  begin perform public.perf_generate_month(public.perf_current_month()); v_log := public.zz_chk(v_log, 'the running month cannot be saved', false);
  exception when others then v_log := public.zz_chk(v_log, 'the running month cannot be saved', true); end;
  v := public.perf_generate_month(m1);
  v2 := public.perf_generate_month(m1);
  reset role;
  v_log := public.zz_chk(v_log, 'saving the month creates one report per person', (v ->> 'created')::int >= 5
    and (select count(*) from perf_monthly_reports where period_month = m1 and user_id in (u_e1, u_e2, u_h, u_o, u_m)) = 5);
  v_log := public.zz_chk(v_log, 'saving the same month again creates no duplicates', (v2 ->> 'created')::int = 0
    and (select count(*) from perf_monthly_reports where period_month = m1 and user_id = u_e1) = 1);
  select * into rep from perf_monthly_reports where user_id = u_e1 and period_month = m1;
  v_log := public.zz_chk(v_log, 'the snapshot stores the score, every task and its points', rep.overall_score is not null and rep.status = 'DRAFT'
    and (select count(*) from perf_report_tasks where report_id = rep.id) = cardinality(rep.task_ids) and t1 = any(rep.task_ids)
    and rep.calculation_version = 'perf-v1' and rep.framework ? 'completion');
  v_log := public.zz_chk(v_log, 'the Head is told reviews are waiting', exists (select 1 from notifications where recipient_id = u_h and entity_type = 'PERF_TEAM'));

  perform public.zz_as(u_e1); set local role authenticated;
  select count(*) into n from perf_monthly_reports where user_id = u_e1;
  reset role;
  v_log := public.zz_chk(v_log, 'the employee cannot see their report before the Head has reviewed it', n = 0);

  begin update perf_monthly_reports set overall_score = 99 where id = rep.id; v_log := public.zz_chk(v_log, 'saved scores cannot be edited', false);
  exception when others then v_log := public.zz_chk(v_log, 'saved scores cannot be edited', true); end;
  begin delete from perf_report_tasks where report_id = rep.id; v_log := public.zz_chk(v_log, 'saved task points cannot be deleted', false);
  exception when others then v_log := public.zz_chk(v_log, 'saved task points cannot be deleted', true); end;
  begin delete from perf_monthly_reports where id = rep.id; v_log := public.zz_chk(v_log, 'a monthly report cannot be deleted', false);
  exception when others then v_log := public.zz_chk(v_log, 'a monthly report cannot be deleted', true); end;
  perform public.zz_as(u_m); set local role authenticated;
  begin update perf_monthly_reports set head_feedback = 'x' where id = rep.id; get diagnostics n = row_count;
    v_log := public.zz_chk(v_log, 'reports cannot be written directly from the app', n = 0);
  exception when others then v_log := public.zz_chk(v_log, 'reports cannot be written directly from the app', true); end;
  reset role;

  ---------------------------------------------------------------- AI review stored once, Head review, response, final
  perform public.zz_as(u_e1); set local role authenticated;
  begin perform public.perf_ai_input(rep.id); v_log := public.zz_chk(v_log, 'the employee cannot pull the AI input', false);
  exception when others then v_log := public.zz_chk(v_log, 'the employee cannot pull the AI input', true); end;
  reset role;
  perform public.zz_as(u_h); set local role authenticated;
  v := public.perf_ai_input(rep.id);
  perform public.perf_save_ai_review(rep.id, jsonb_build_object('overall_summary', 'zz summary from the saved facts'), 'test-model');
  begin perform public.perf_save_ai_review(rep.id, jsonb_build_object('overall_summary', 'second'), 'test-model');
    v_log := public.zz_chk(v_log, 'the AI review is written once per version', false);
  exception when others then v_log := public.zz_chk(v_log, 'the AI review is written once per version', true); end;
  reset role;
  v_log := public.zz_chk(v_log, 'the AI gets the frozen task facts only', jsonb_array_length(v -> 'tasks') = cardinality(rep.task_ids) and not (v::text like '%9888810001%'));

  perform public.zz_as(u_e1); set local role authenticated;
  begin perform public.perf_head_review(rep.id, 'self review', '[]'); v_log := public.zz_chk(v_log, 'nobody reviews themselves', false);
  exception when others then v_log := public.zz_chk(v_log, 'nobody reviews themselves', true); end;
  reset role;
  perform public.zz_as(u_h); set local role authenticated;
  perform public.perf_head_review(rep.id, 'Good month, keep updates coming.', jsonb_build_array(jsonb_build_object('goal_type', 'REDUCE_OVERDUE', 'target_value', 0,
    'description', 'No overdue tasks next month')));
  reset role;
  perform public.zz_as(u_e1); set local role authenticated;
  select count(*) into n from perf_monthly_reports where id = rep.id;
  v := public.perf_report_detail(rep.id);
  reset role;
  v_log := public.zz_chk(v_log, 'after the Head review the employee sees their report and goal', n = 1 and v ->> 'status' = 'SHARED'
    and jsonb_array_length(v -> 'goals_set') = 1 and (v ->> 'can_respond')::boolean);
  v_log := public.zz_chk(v_log, 'the employee is notified', exists (select 1 from notifications where recipient_id = u_e1 and entity_type = 'PERF_REVIEW' and entity_id = rep.id)
    and public.notification_deep_link('PERF_REVIEW', rep.id) = '/performance/report/' || rep.id);
  perform public.zz_as(u_e2); set local role authenticated;
  begin perform public.perf_employee_respond(rep.id, 'not mine'); v_log := public.zz_chk(v_log, 'only the employee can respond', false);
  exception when others then v_log := public.zz_chk(v_log, 'only the employee can respond', true); end;
  select count(*) into n from perf_monthly_reports where id = rep.id;
  reset role;
  v_log := public.zz_chk(v_log, 'a colleague cannot read the shared report', n = 0);
  perform public.zz_as(u_e1); set local role authenticated;
  perform public.perf_employee_respond(rep.id, 'Thanks -- the overdue task was waiting on site access.');
  reset role;
  v_log := public.zz_chk(v_log, 'the Head is told about the response', exists (select 1 from notifications where recipient_id = u_h and entity_type = 'PERF_REVIEW' and entity_id = rep.id));
  perform public.zz_as(u_h); set local role authenticated;
  begin perform public.perf_finalize_report(rep.id); v_log := public.zz_chk(v_log, 'only Management finalises', false);
  exception when others then v_log := public.zz_chk(v_log, 'only Management finalises', true); end;
  reset role;
  perform public.zz_as(u_m); set local role authenticated;
  perform public.perf_finalize_report(rep.id);
  reset role;
  begin update perf_monthly_reports set employee_response = 'changed' where id = rep.id; v_log := public.zz_chk(v_log, 'a final report cannot be changed', false);
  exception when others then v_log := public.zz_chk(v_log, 'a final report cannot be changed', true); end;

  ---------------------------------------------------------------- versioned recalculation
  perform public.zz_as(u_m); set local role authenticated;
  begin perform public.perf_recalculate(u_e1, m1, ''); v_log := public.zz_chk(v_log, 'a recalculation needs a reason', false);
  exception when others then v_log := public.zz_chk(v_log, 'a recalculation needs a reason', true); end;
  perform public.perf_recalculate(u_e1, m1, 'Task ZZ verified late; record corrected');
  reset role;
  select * into rep2 from perf_monthly_reports where user_id = u_e1 and period_month = m1 and status <> 'SUPERSEDED';
  v_log := public.zz_chk(v_log, 'a recalculation makes version 2 and keeps version 1 unchanged', rep2.version = 2 and rep2.supersedes_id = rep.id
    and (select status from perf_monthly_reports where id = rep.id) = 'SUPERSEDED' and (select head_feedback from perf_monthly_reports where id = rep.id) is not null
    and (select count(*) from perf_report_tasks where report_id = rep.id) > 0
    and exists (select 1 from perf_audit where report_id = rep2.id and action = 'RECALCULATED'));
  -- bring version 2 through review so month 2 compares against it
  perform public.zz_as(u_h); set local role authenticated;
  perform public.perf_head_review(rep2.id, 'Reviewed again after the correction.', jsonb_build_array(jsonb_build_object('goal_type', 'REDUCE_OVERDUE', 'target_value', 0,
    'description', 'No overdue tasks next month')));
  reset role;

  ---------------------------------------------------------------- month 2: separate snapshot, comparison, goals, deadline counted once
  update staff_tasks set status_id = s_done, completed_at = public.zz_ts(m2 + 2, 10), completed_by = u_e1 where id = t3;
  update staff_task_assignees set individual_status = 'COMPLETED', completed_at = public.zz_ts(m2 + 2, 10) where task_id = t3 and user_id = u_e1;
  perform public.zz_mk('ZZ m2 on time ' || g, d_int, d_int, u_h, u_e1, m2 + 9 + g, 'VERIFIED', public.zz_ts(m2 + 1, 10), public.zz_ts(m2 + 5 + g, 10), public.zz_ts(m2 + 6 + g, 10))
    from generate_series(1, 4) g;
  perform public.zz_as(u_m); set local role authenticated;
  perform public.perf_generate_month(m2);
  reset role;
  select * into rep2 from perf_monthly_reports where user_id = u_e1 and period_month = m2 and status <> 'SUPERSEDED';
  v_log := public.zz_chk(v_log, 'the next month is a separate snapshot and the earlier month stays', rep2.id is not null
    and (select count(*) from perf_monthly_reports where user_id = u_e1 and period_month = m1) = 2);
  v_log := public.zz_chk(v_log, 'the month compares with the previous month''s saved score',
    (rep2.comparison ->> 'previous_score')::numeric = (select overall_score from perf_monthly_reports where user_id = u_e1 and period_month = m1 and status <> 'SUPERSEDED')
    and (rep2.comparison ->> 'score_change') is not null);
  v_log := public.zz_chk(v_log, 'a missed due date is not counted twice', exists (select 1 from perf_report_tasks where report_id = rep2.id and task_id = t3
    and outcome = 'COMPLETED' and not (available ? 'deadline') and array_to_string(explanation, ' ') like '%already counted%'));
  v_log := public.zz_chk(v_log, 'last month''s goal is checked against this month', exists (select 1 from perf_goals where user_id = u_e1 and target_month = m2
    and evaluated_report_id = rep2.id and status in ('ACHIEVED', 'NOT_ACHIEVED')) and jsonb_array_length(rep2.metrics -> 'goals') >= 1);

  ---------------------------------------------------------------- company report
  perform public.zz_as(u_h); set local role authenticated;
  begin perform public.perf_generate_company_report(m2); v_log := public.zz_chk(v_log, 'a Head cannot create the company report', false);
  exception when others then v_log := public.zz_chk(v_log, 'a Head cannot create the company report', true); end;
  begin perform public.perf_company_report(m2); v_log := public.zz_chk(v_log, 'a Head cannot read the company report', false);
  exception when others then v_log := public.zz_chk(v_log, 'a Head cannot read the company report', true); end;
  reset role;
  perform public.zz_as(u_m); set local role authenticated;
  v_id := public.perf_generate_company_report(m2);
  v := public.perf_company_report(m2);
  v2 := public.perf_company_ai_input(v_id);
  perform public.perf_save_company_ai(v_id, jsonb_build_object('overview', 'zz overview', 'departments', jsonb_build_array(jsonb_build_object('department_id', d_int, 'summary', 'zz interior'))), 'test-model');
  perform public.perf_finalize_company_report(v_id, 'Reviewed');
  reset role;
  v_log := public.zz_chk(v_log, 'the company report has departments, people with department ranks, and bottleneck sections',
    jsonb_array_length(v -> 'metrics' -> 'departments') >= 2 and exists (select 1 from jsonb_array_elements(v -> 'metrics' -> 'people') p where p ->> 'user_id' = u_e1::text and (p ->> 'dept_rank') is not null)
    and v -> 'metrics' ? 'procurement_bottlenecks' and v -> 'metrics' ? 'factory_bottlenecks' and v -> 'metrics' ? 'coordination_issues');
  v_log := public.zz_chk(v_log, 'the AI company summary gets department figures, not people''s names', not (v2 -> 'metrics' ? 'people')
    and not (v2::text like '%ZZ Employee One%') and v2 -> 'metrics' ? 'departments');
  perform public.zz_as(u_h); set local role authenticated;
  begin perform public.perf_company_ai_input(v_id); v_log := public.zz_chk(v_log, 'a Head cannot pull the company AI input', false);
  exception when others then v_log := public.zz_chk(v_log, 'a Head cannot pull the company AI input', true); end;
  reset role;
  v_log := public.zz_chk(v_log, 'the company report is final after Management review', (select status from perf_company_reports where id = v_id) = 'FINAL');
  perform public.zz_as(u_h); set local role authenticated;
  v := public.perf_department_view(m2, d_int);
  reset role;
  v_log := public.zz_chk(v_log, 'the Head gets their department''s part of the report', v -> 'ai_summary' ->> 'summary' = 'zz interior' and (v -> 'stats') is not null);

  ---------------------------------------------------------------- scoring settings
  perform public.zz_as(u_e1); set local role authenticated;
  begin perform public.perf_save_framework(d_int, 20, 20, 20, 20, 20, array['x']); v_log := public.zz_chk(v_log, 'an employee cannot change the scoring', false);
  exception when others then v_log := public.zz_chk(v_log, 'an employee cannot change the scoring', true); end;
  reset role;
  perform public.zz_as(u_m); set local role authenticated;
  begin perform public.perf_save_framework(d_int, 50, 20, 20, 20, 20, array['x']); v_log := public.zz_chk(v_log, 'weights must add up to 100', false);
  exception when others then v_log := public.zz_chk(v_log, 'weights must add up to 100', true); end;
  perform public.perf_save_framework(d_int, 40, 20, 20, 10, 10, array['Site coordination']);
  reset role;
  v_log := public.zz_chk(v_log, 'Management changes the Interior weights without code changes', (select w_completion from perf_frameworks where department_id = d_int) = 40
    and (select framework ->> 'completion' from perf_monthly_reports where id = rep2.id)::numeric <> 40);
  v_log := public.zz_chk(v_log, 'the monthly run is scheduled', exists (select 1 from cron.job where jobname = 'perf-monthly-reports'));

  raise exception E'\n%', v_log;
end $t$;
