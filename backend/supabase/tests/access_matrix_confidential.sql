-- Companion to access_matrix.sql: Finance-confidential TASKS / BRIDGES and RESTRICTED chats, with the finance capability on and off.
-- Same mechanics: throw-away users, impersonation via SET LOCAL ROLE authenticated, everything rolled back by the final RAISE (read the report in the error).
-- The database may contain no confidential task, so this test turns one existing task and one bridge task into Accounts tasks (rolled back).

do $t$
declare
  v_log text := ''; d_mkt uuid; d_fac uuid; d_acc uuid; r_mgmt uuid; r_head uuid; r_accH uuid; r_emp uuid;
  u_m uuid := gen_random_uuid(); u_fh uuid := gen_random_uuid(); u_acc uuid := gen_random_uuid(); u_ef uuid := gen_random_uuid();
  v_task uuid; v_bridge_task uuid; v_conv uuid; v_err text;
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  select id into d_mkt from departments where code = 'MARKETING'; select id into d_fac from departments where code = 'FACTORY'; select id into d_acc from departments where code = 'ACCOUNTS';
  select id into r_mgmt from roles where code = 'management'; select id into r_head from roles where code = 'dept_head';
  select id into r_accH from roles where code = 'accounts_head'; select id into r_emp from roles where code = 'employee';
  insert into auth.users (id, instance_id, aud, role, email) select x, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'zz-' || x || '@example.test' from unnest(array[u_m, u_fh, u_acc, u_ef]) x;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password) values
    (u_m, 'ZZ-M-1', 'ZZ M', r_mgmt, d_mkt, true, false), (u_fh, 'ZZ-FH-1', 'ZZ FH', r_head, d_fac, true, false),
    (u_acc, 'ZZ-AC-1', 'ZZ ACC', r_accH, d_acc, true, false), (u_ef, 'ZZ-EF-1', 'ZZ EF', r_emp, d_fac, true, false);

  select id into v_task from staff_tasks where is_active and not is_bridge limit 1;
  update staff_tasks set to_department_id = d_acc where id = v_task;
  select task_id into v_bridge_task from bridges limit 1;
  update staff_tasks set to_department_id = d_acc where id = v_bridge_task;

  perform set_config('request.jwt.claims', json_build_object('sub', u_m, 'role', 'authenticated')::text, true); set local role authenticated;
  v_log := public.zz_chk(v_log, 'management (finance capability) sees the confidential task', (select count(*) from staff_tasks where id = v_task) = 1);
  v_log := public.zz_chk(v_log, 'management (finance capability) sees the confidential-domain bridge', (select count(*) from bridges where task_id = v_bridge_task) = 1);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u_acc, 'role', 'authenticated')::text, true); set local role authenticated;
  v_log := public.zz_chk(v_log, 'accounts head sees the confidential task', (select count(*) from staff_tasks where id = v_task) = 1);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u_fh, 'role', 'authenticated')::text, true); set local role authenticated;
  v_log := public.zz_chk(v_log, 'factory head does NOT see the confidential task', (select count(*) from staff_tasks where id = v_task) = 0);
  reset role;
  update staff_tasks set assigned_to = u_ef where id = v_task;
  perform set_config('request.jwt.claims', json_build_object('sub', u_ef, 'role', 'authenticated')::text, true); set local role authenticated;
  v_log := public.zz_chk(v_log, 'employee assigned to a confidential task still cannot read it (no finance capability)', (select count(*) from staff_tasks where id = v_task) = 0);
  reset role;

  update role_permissions set is_allowed = false, scope = 'none' where role_id = r_mgmt and permission_key = 'can_view_restricted_finance';
  perform set_config('request.jwt.claims', json_build_object('sub', u_m, 'role', 'authenticated')::text, true); set local role authenticated;
  v_log := public.zz_chk(v_log, 'management WITHOUT finance capability: confidential task hidden', (select count(*) from staff_tasks where id = v_task) = 0);
  v_log := public.zz_chk(v_log, 'management WITHOUT finance capability: confidential bridge hidden', (select count(*) from bridges where task_id = v_bridge_task) = 0);
  reset role;
  update role_permissions set is_allowed = true, scope = 'all' where role_id = r_mgmt and permission_key = 'can_view_restricted_finance';

  select c.id into v_conv from chat_conversations c where c.type <> 'direct' and c.management_visible and c.migration_status is null and public.chat_is_restricted(c.id) limit 1;
  v_log := public.zz_chk(v_log, 'fixture: a live restricted conversation exists', v_conv is not null);
  update role_permissions set is_allowed = false, scope = 'none' where role_id = r_mgmt and permission_key = 'can_view_restricted_finance';
  perform set_config('request.jwt.claims', json_build_object('sub', u_m, 'role', 'authenticated')::text, true); set local role authenticated;
  begin perform public.chat_oversight_open(v_conv, 'x'); v_err := 'NO ERROR'; exception when others then v_err := sqlerrm; end;
  v_log := public.zz_chk(v_log, 'oversight refused because the chat is restricted (' || v_err || ')', v_err ilike '%restricted%');
  begin perform public.chat_management_open(v_conv, 'reason for joining'); v_err := 'NO ERROR'; exception when others then v_err := sqlerrm; end;
  v_log := public.zz_chk(v_log, 'joining refused because the chat is restricted (' || v_err || ')', v_err ilike '%restricted%');
  v_log := public.zz_chk(v_log, 'directory hides it without the capability', not exists (select 1 from jsonb_array_elements(public.chat_management_directory(null, null)) e where (e ->> 'id')::uuid = v_conv));
  v_log := public.zz_chk(v_log, 'table read denied without the capability', (select count(*) from chat_conversations where id = v_conv) = 0);
  reset role;
  update role_permissions set is_allowed = true, scope = 'all' where role_id = r_mgmt and permission_key = 'can_view_restricted_finance';
  perform set_config('request.jwt.claims', json_build_object('sub', u_m, 'role', 'authenticated')::text, true); set local role authenticated;
  begin perform public.chat_oversight_open(v_conv, 'x'); v_err := 'OK'; exception when others then v_err := sqlerrm; end;
  v_log := public.zz_chk(v_log, 'with the capability it opens (' || v_err || ')', v_err = 'OK');
  reset role;
  raise exception E'CONFIDENTIAL-REPORT (rolled back)\n%', v_log;
end $t$;
