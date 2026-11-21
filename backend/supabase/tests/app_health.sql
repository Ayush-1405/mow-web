-- v3_16 app problem log: grouping, masking, per-user limit, Management-only reading, status changes, hourly check.
-- Own fixtures, ALWAYS rolls back (the report is in the error message).

do $t$
declare
  v_log text := ''; n int; r public.app_error_reports;
  r_emp uuid; r_mgmt uuid; d_int uuid; d_ctl uuid;
  u_a uuid := gen_random_uuid(); u_b uuid := gen_random_uuid(); u_m uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true); end $f$;
  select id into r_emp from roles where code = 'employee';
  select id into r_mgmt from roles where code = 'management';
  select id into d_int from departments where code = 'INTERIOR';
  select id into d_ctl from departments where is_control_tower limit 1;
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_a, u_b, u_m]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_a, 'ZZ-AH-A', 'ZZ Employee A', r_emp, d_int, '9888800001', false, true),
    (u_b, 'ZZ-AH-B', 'ZZ Employee B', r_emp, d_int, '9888800002', false, true),
    (u_m, 'ZZ-AH-M', 'ZZ Management', r_mgmt, coalesce(d_ctl, d_int), '9888800003', false, true);

  perform public.zz_as(u_a); set local role authenticated;
  perform public.app_report_error('rpc', '/purchase-requests/11111111-2222-3333-4444-555555555555',
    'Could not find the function public.zz_x(p) in the schema cache; phone 9876543210, mail ravi@example.com', null, 'abc1234', 'test-agent');
  perform public.app_report_error('rpc', '/purchase-requests/99999999-2222-3333-4444-555555555555?x=1',
    'Could not find the function public.zz_x(p) in the schema cache; phone 9876543210, mail ravi@example.com', null, 'abc1234', 'test-agent');
  perform public.app_report_error('evil', '/x', 'not a known kind');
  select count(*) into n from app_error_reports;
  reset role;
  v_log := public.zz_chk(v_log, 'an employee cannot read the problem log', n = 0);
  select * into r from app_error_reports where message like 'Could not find the function public.zz_x%';
  v_log := public.zz_chk(v_log, 'the same problem on two order pages is one row, counted twice', r.occurrences = 2 and r.users_affected = 1
    and (select count(*) from app_error_reports where message like 'Could not find the function public.zz_x%') = 1);
  v_log := public.zz_chk(v_log, 'phone numbers, e-mails and ids are masked', r.message not like '%9876543210%' and r.message not like '%ravi@%'
    and r.message like '%<n>%' and r.message like '%<email>%' and r.page = '/purchase-requests/<id>');
  v_log := public.zz_chk(v_log, 'unknown kinds are ignored', not exists (select 1 from app_error_reports where message = 'not a known kind'));

  perform public.zz_as(u_b); set local role authenticated;
  perform public.app_report_error('rpc', '/purchase-requests/aaaaaaaa-2222-3333-4444-555555555555',
    'Could not find the function public.zz_x(p) in the schema cache; phone 9876543210, mail ravi@example.com', null, 'abc1234', null);
  reset role;
  v_log := public.zz_chk(v_log, 'a second person raises users affected', (select users_affected from app_error_reports where id = r.id) = 2);

  perform public.zz_as(u_a); set local role authenticated;
  for n in 1..40 loop perform public.app_report_error('crash', '/p' || n, 'zz crash ' || n); end loop;
  reset role;
  v_log := public.zz_chk(v_log, 'one person can add at most 30 new problems an hour', (select count(*) from app_error_reports where message like 'zz crash %') between 28 and 30);

  perform public.zz_as(u_a); set local role authenticated;
  begin perform public.app_set_problem_status(r.id, 'FIXED', 'x'); v_log := public.zz_chk(v_log, 'an employee cannot change a status', false);
  exception when others then v_log := public.zz_chk(v_log, 'an employee cannot change a status', true); end;
  reset role;
  perform public.zz_as(u_m); set local role authenticated;
  select count(*) into n from app_error_reports where id = r.id;
  perform public.app_set_problem_status(r.id, 'FIXED', 'v3_99 fixed it');
  perform public.app_report_error('rpc', '/purchase-requests/aaaaaaaa-2222-3333-4444-555555555555',
    'Could not find the function public.zz_x(p) in the schema cache; phone 9876543210, mail ravi@example.com');
  reset role;
  v_log := public.zz_chk(v_log, 'Management reads the log and marks a problem fixed', n = 1 and (select status from app_error_reports where id = r.id) = 'FIXED');
  v_log := public.zz_chk(v_log, 'if it happens again after the fix, a new open problem appears',
    (select count(*) from app_error_reports where message like 'Could not find the function public.zz_x%' and status = 'OPEN') = 1);

  n := public.app_health_check();
  v_log := public.zz_chk(v_log, 'the hourly server check runs', n >= 0);
  v_log := public.zz_chk(v_log, 'the hourly check is scheduled', exists (select 1 from cron.job where jobname = 'app-health-check'));
  begin
    perform public.zz_as(u_a); set local role authenticated;
    insert into app_error_reports (fingerprint, source, kind, message) values ('x', 'browser', 'rpc', 'x');
    reset role; v_log := public.zz_chk(v_log, 'the log cannot be written directly', false);
  exception when others then reset role; v_log := public.zz_chk(v_log, 'the log cannot be written directly', true); end;

  raise exception E'\n%', v_log;
end $t$;
