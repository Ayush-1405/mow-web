-- Access-matrix test for the centralized Director/Management access model (v2_90a/b).
-- Run:  psql / Supabase SQL editor / MCP execute_sql.  It creates throw-away users, impersonates each one through the SAME path
-- PostgREST uses (SET LOCAL ROLE authenticated + request.jwt.claims), asserts what RLS returns, and then ALWAYS rolls everything back
-- by raising at the end. The report is in the error message: every line starts with PASS or FAIL. Nothing is persisted.

do $t$
declare
  v_log text := '';
  d_mkt uuid; d_fac uuid; d_int uuid; d_acc uuid; d_ct uuid;
  r_mgmt uuid; r_head uuid; r_sup uuid; r_emp uuid; r_accH uuid; r_sys uuid;
  u_m uuid := gen_random_uuid(); u_m2 uuid := gen_random_uuid(); u_fh uuid := gen_random_uuid(); u_sup uuid := gen_random_uuid();
  u_ef uuid := gen_random_uuid(); u_ei uuid := gen_random_uuid(); u_acc uuid := gen_random_uuid(); u_sys uuid := gen_random_uuid();
  n_total int; n_conf int; n_bridges int; n_depts int; n int; n2 int; n3 int; b boolean;
  v_task uuid; v_conv uuid; v_direct uuid; v_restricted uuid; v_part uuid; v_msgs int; v_notif0 int; v_notif1 int;
  cn text;
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select id into d_mkt from departments where code = 'MARKETING';   select id into d_fac from departments where code = 'FACTORY';
  select id into d_int from departments where code = 'INTERIOR';     select id into d_acc from departments where code = 'ACCOUNTS';
  select id into d_ct from departments where code = 'CONTROL_TOWER';
  select id into r_mgmt from roles where code = 'management'; select id into r_head from roles where code = 'dept_head';
  select id into r_sup from roles where code = 'supervisor';  select id into r_emp from roles where code = 'employee';
  select id into r_accH from roles where code = 'accounts_head'; select id into r_sys from roles where code = 'sysadmin';

  -- throw-away users (auth row first: user_profiles.id references it)
  insert into auth.users (id, instance_id, aud, role, email) select x, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'zz-' || x || '@example.test'
    from unnest(array[u_m, u_m2, u_fh, u_sup, u_ef, u_ei, u_acc, u_sys]) x;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password) values
    (u_m,  'ZZ-M-1',  'ZZ Management',      r_mgmt, d_mkt, true, false),
    (u_m2, 'ZZ-M-2',  'ZZ Management OFF',  r_mgmt, d_mkt, false, false),
    (u_fh, 'ZZ-FH-1', 'ZZ Factory Head',    r_head, d_fac, true, false),
    (u_sup,'ZZ-SU-1', 'ZZ Factory Sup',     r_sup,  d_fac, true, false),
    (u_ef, 'ZZ-EF-1', 'ZZ Factory Emp',     r_emp,  d_fac, true, false),
    (u_ei, 'ZZ-EI-1', 'ZZ Interior Emp',    r_emp,  d_int, true, false),
    (u_acc,'ZZ-AC-1', 'ZZ Accounts Head',   r_accH, d_acc, true, false),
    (u_sys,'ZZ-SY-1', 'ZZ Sysadmin',        r_sys,  d_ct,  true, false);

  select count(*) into n_total from staff_tasks;
  select count(*) into n_conf from staff_tasks t where public.staff_task_is_confidential(t);
  select count(*) into n_bridges from bridges;
  select count(*) into n_depts from departments where is_active;

  ---------------------------------------------------------------- role-name normalisation (legacy / alias values)
  v_log := public.zz_chk(v_log, 'family: "Management / Director" -> management', public.staff_role_family('Management / Director') = 'management');
  v_log := public.zz_chk(v_log, 'family: Managing-Director / CEO / Central Tower / Management Control Tower -> management',
    public.staff_role_family('Managing-Director') = 'management' and public.staff_role_family('CEO') = 'management'
    and public.staff_role_family('Central Tower') = 'management' and public.staff_role_family('Management Control Tower') = 'management'
    and public.staff_role_family(' DIRECTOR ') = 'management');
  v_log := public.zz_chk(v_log, 'family: Super Admin / sysadmin -> super_admin', public.staff_role_family('Super Admin') = 'super_admin' and public.staff_role_family('sysadmin') = 'super_admin');
  v_log := public.zz_chk(v_log, 'family: dept_head / supervisor / employee / accounts_head / null / "" are NOT global',
    public.staff_role_family('dept_head') is null and public.staff_role_family('Department Head') is null and public.staff_role_family('supervisor') is null
    and public.staff_role_family('employee') is null and public.staff_role_family('accounts_head') is null and public.staff_role_family(null) is null and public.staff_role_family('') is null);

  ---------------------------------------------------------------- Director / Management
  perform set_config('request.jwt.claims', json_build_object('sub', u_m, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from staff_tasks;
  v_log := public.zz_chk(v_log, format('management sees ALL tasks (%s of %s) although creator/assignee of none', n, n_total), n = n_total and n_total > 0);
  select count(*), count(distinct id) into n, n2 from staff_tasks;
  v_log := public.zz_chk(v_log, 'management: no duplicated task rows', n = n2);
  select count(distinct to_department_id) into n from staff_tasks;
  v_log := public.zz_chk(v_log, format('management sees tasks of several departments (%s)', n), n >= 2);
  select count(*) into n from bridges;
  v_log := public.zz_chk(v_log, format('management sees ALL bridges (%s of %s)', n, n_bridges), n = n_bridges);
  select count(*) into n from departments where public.can_view_department(u_m, id);
  v_log := public.zz_chk(v_log, format('management can open every department dashboard incl. Control Tower (%s of %s)', n, n_depts), n = n_depts);
  v_log := public.zz_chk(v_log, 'is_management_user(self) true; asking about someone else is refused (false)', public.is_management_user(u_m) and not public.is_management_user(u_fh));
  select count(*) into n from notifications;
  v_log := public.zz_chk(v_log, 'management notifications are still recipient-only (no cross-user notifications)', n = (select count(*) from notifications where recipient_id = u_m));
  select count(*) into n from staff_audit_log;
  v_log := public.zz_chk(v_log, 'management can read the audit log', n = (select count(*) from staff_audit_log));
  v_log := public.zz_chk(v_log, 'capabilities: finance TRUE, payroll FALSE, sensitive HR FALSE, manage users TRUE',
    (public.staff_my_capabilities() -> 'capabilities' ->> 'can_view_restricted_finance')::boolean
    and not (public.staff_my_capabilities() -> 'capabilities' ->> 'can_view_payroll')::boolean
    and not (public.staff_my_capabilities() -> 'capabilities' ->> 'can_view_sensitive_hr')::boolean
    and (public.staff_my_capabilities() -> 'capabilities' ->> 'can_manage_users')::boolean);
  reset role;

  -- automatically part of the Management & Department Heads conversation
  select count(*) into n from chat_participants p join chat_conversations c on c.id = p.conversation_id
   where c.type = 'management' and p.user_id = u_m and p.left_at is null;
  v_log := public.zz_chk(v_log, 'management user is auto-included in "Management & Department Heads"', n = 1);

  ---------------------------------------------------------------- Sysadmin
  perform set_config('request.jwt.claims', json_build_object('sub', u_sys, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from staff_tasks;
  v_log := public.zz_chk(v_log, 'super admin sees all tasks', n = n_total);
  reset role;

  ---------------------------------------------------------------- Inactive management user loses access immediately
  perform set_config('request.jwt.claims', json_build_object('sub', u_m2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from staff_tasks;  select count(*) into n2 from bridges;
  v_log := public.zz_chk(v_log, 'INACTIVE management user: 0 tasks, 0 bridges, not management', n = 0 and n2 = 0 and not public.is_management_user(u_m2) and not public.staff_has_global_oversight());
  reset role;

  ---------------------------------------------------------------- Factory Head: department scope only
  perform set_config('request.jwt.claims', json_build_object('sub', u_fh, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from staff_tasks;
  select count(*) into n2 from staff_tasks t where t.to_department_id = d_int and not (t.is_bridge and t.from_department_id = d_fac);
  v_log := public.zz_chk(v_log, format('factory head sees only Factory scope (%s tasks) -- 0 unrelated Interior tasks (found %s)', n, n2), n2 = 0 and n < n_total);
  select count(*) into n from staff_tasks t where public.staff_task_is_confidential(t);
  v_log := public.zz_chk(v_log, 'factory head sees no Accounts/Finance tasks', n = 0);
  v_log := public.zz_chk(v_log, 'factory head: Accounts + Control Tower departments not viewable',
    not public.can_view_department(u_fh, d_acc) and not public.can_view_department(u_fh, d_ct) and public.can_view_department(u_fh, d_fac));
  select count(*) into n from staff_audit_log where department_id is distinct from d_fac;
  v_log := public.zz_chk(v_log, 'factory head audit visibility limited to own scope', n = 0);
  v_log := public.zz_chk(v_log, 'factory head is NOT management / cannot start oversight',
    not public.staff_has_global_oversight() and (select count(*) from chat_conversations where type = 'project') = 0);
  reset role;

  ---------------------------------------------------------------- Supervisor: own department only
  perform set_config('request.jwt.claims', json_build_object('sub', u_sup, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) filter (where to_department_id <> d_fac), count(*) into n, n2 from staff_tasks;
  v_log := public.zz_chk(v_log, format('supervisor sees only own-department tasks (%s visible, %s outside)', n2, n), n = 0);
  reset role;

  ---------------------------------------------------------------- Normal employee: assigned / created only; assignment makes exactly that task visible
  select id into v_task from staff_tasks where to_department_id = d_fac and not public.staff_task_is_confidential(staff_tasks) and is_active limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', u_ef, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from staff_tasks;
  select count(*) into n2 from bridges;
  v_log := public.zz_chk(v_log, 'employee with no assignments sees 0 tasks and 0 bridges', n = 0 and n2 = 0);
  reset role;
  if v_task is not null then
    update staff_tasks set assigned_to = u_ef where id = v_task;
    perform set_config('request.jwt.claims', json_build_object('sub', u_ef, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from staff_tasks;
    v_log := public.zz_chk(v_log, 'employee sees exactly the task assigned to them (1)', n = 1);
    reset role;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u_ei, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from staff_tasks where to_department_id = d_fac;
  v_log := public.zz_chk(v_log, 'interior employee cannot see Factory tasks by URL / direct API', n = 0);
  select count(*) into n from staff_audit_log;
  v_log := public.zz_chk(v_log, 'employee cannot read the audit log', n = 0);
  reset role;

  ---------------------------------------------------------------- Confidential Finance data
  perform set_config('request.jwt.claims', json_build_object('sub', u_acc, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from staff_tasks t where public.staff_task_is_confidential(t);
  v_log := public.zz_chk(v_log, format('accounts head sees all confidential Accounts tasks (%s of %s)', n, n_conf), n = n_conf);
  reset role;
  update role_permissions set is_allowed = false, scope = 'none' where role_id = r_mgmt and permission_key = 'can_view_restricted_finance';
  perform set_config('request.jwt.claims', json_build_object('sub', u_m, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from staff_tasks; select count(*) into n2 from staff_tasks t where public.staff_task_is_confidential(t);
  v_log := public.zz_chk(v_log, format('management WITHOUT finance capability: all operational tasks (%s) but 0 confidential (%s)', n, n2), n2 = 0 and n = n_total - n_conf);
  v_log := public.zz_chk(v_log, 'management WITHOUT finance capability cannot open the Accounts department', not public.can_view_department(u_m, d_acc) and public.can_view_department(u_m, d_fac));
  reset role;
  update role_permissions set is_allowed = true, scope = 'all' where role_id = r_mgmt and permission_key = 'can_view_restricted_finance';

  ---------------------------------------------------------------- Chat: oversight is view-only, logged, and not participation
  select c.id into v_conv from chat_conversations c
   where c.type = 'project' and c.migration_status is null and c.management_visible and not public.chat_is_restricted(c.id)
     and exists (select 1 from chat_messages m where m.conversation_id = c.id) limit 1;
  select c.id into v_direct from chat_conversations c where c.type = 'direct' limit 1;
  select c.id into v_restricted from chat_conversations c where public.chat_is_restricted(c.id) and c.type <> 'direct' limit 1;
  if v_conv is not null then
    select up.id into v_part from chat_participants p join user_profiles up on up.id = p.user_id
     where p.conversation_id = v_conv and p.left_at is null and p.scope = 'full' and up.is_active and not up.must_change_password
       and up.id not in (u_m, u_m2, u_fh, u_sup, u_ef, u_ei, u_acc, u_sys) limit 1;
    select count(*) into v_msgs from chat_messages where conversation_id = v_conv;

    perform set_config('request.jwt.claims', json_build_object('sub', u_m, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from chat_conversations where id = v_conv;
    select count(*) into n2 from chat_messages where conversation_id = v_conv;
    v_log := public.zz_chk(v_log, 'management cannot read a work chat BEFORE opening a logged oversight session (conversations + messages = 0)', n = 0 and n2 = 0);
    perform public.chat_oversight_open(v_conv, 'zz test');
    select count(*) into n from chat_conversations where id = v_conv;
    select count(*) into n2 from chat_messages where conversation_id = v_conv;
    v_log := public.zz_chk(v_log, format('after oversight_open management reads the conversation and all %s messages', v_msgs), n = 1 and n2 = v_msgs);
    v_log := public.zz_chk(v_log, 'oversight is NOT participation: not a participant, cannot post',
      not public.chat_is_participant(v_conv) and not public.chat_can_post(v_conv));
    begin perform public.chat_send_message(v_conv, 'should fail'); v_log := public.zz_chk(v_log, 'management cannot send into an unjoined conversation', false);
    exception when others then v_log := public.zz_chk(v_log, 'management cannot send into an unjoined conversation', true); end;
    select count(*) into v_notif0 from notifications where recipient_id = u_m;
    reset role;
    v_log := public.zz_chk(v_log, 'access is audited: chat_access_log row', (select count(*) from chat_access_log where conversation_id = v_conv and user_id = u_m and action = 'management_view') = 1);
    v_log := public.zz_chk(v_log, 'access is audited: staff_audit_log row with actor role',
      (select count(*) from staff_audit_log where entity_id = v_conv and action = 'MANAGEMENT_VIEW' and performed_by = u_m and performed_by_role = 'management') = 1);
    perform set_config('request.jwt.claims', json_build_object('sub', u_m, 'role', 'authenticated')::text, true);
    set local role authenticated; perform public.chat_oversight_open(v_conv, null); reset role;
    v_log := public.zz_chk(v_log, 'repeat opens within 30 min do not spam the audit log', (select count(*) from chat_access_log where conversation_id = v_conv and user_id = u_m) = 1);

    if v_part is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', v_part, 'role', 'authenticated')::text, true);
      set local role authenticated;
      perform public.chat_send_message(v_conv, 'zz oversight notification probe');
      reset role;
      select count(*) into v_notif1 from notifications where recipient_id = u_m;
      v_log := public.zz_chk(v_log, 'a new message in an overseen chat creates NO notification for management', v_notif1 = v_notif0);
    end if;

    -- session expiry
    update chat_access_log set created_at = now() - interval '13 hours' where conversation_id = v_conv and user_id = u_m;
    perform set_config('request.jwt.claims', json_build_object('sub', u_m, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from chat_messages where conversation_id = v_conv;
    v_log := public.zz_chk(v_log, 'oversight session expires after 12 hours (messages unreadable again)', n = 0);
    reset role;
    -- non-management cannot open one
    perform set_config('request.jwt.claims', json_build_object('sub', u_fh, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin perform public.chat_oversight_open(v_conv, 'x'); v_log := public.zz_chk(v_log, 'department head cannot start chat oversight', false);
    exception when others then v_log := public.zz_chk(v_log, 'department head cannot start chat oversight', true); end;
    reset role;
    -- inactive management cannot
    perform set_config('request.jwt.claims', json_build_object('sub', u_m2, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin perform public.chat_oversight_open(v_conv, 'x'); v_log := public.zz_chk(v_log, 'inactive management cannot start chat oversight', false);
    exception when others then v_log := public.zz_chk(v_log, 'inactive management cannot start chat oversight', true); end;
    reset role;
  else
    v_log := v_log || 'SKIP  no project conversation with messages in this database' || E'\n';
  end if;

  if v_direct is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', u_m, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin perform public.chat_oversight_open(v_direct, 'x'); v_log := public.zz_chk(v_log, 'private DIRECT chats are outside view-only oversight', false);
    exception when others then v_log := public.zz_chk(v_log, 'private DIRECT chats are outside view-only oversight', true); end;
    select count(*) into n from chat_messages where conversation_id = v_direct;
    v_log := public.zz_chk(v_log, 'management cannot read a direct chat through the table either', n = 0);
    reset role;
  end if;

  if v_restricted is not null then
    update role_permissions set is_allowed = false, scope = 'none' where role_id = r_mgmt and permission_key = 'can_view_restricted_finance';
    perform set_config('request.jwt.claims', json_build_object('sub', u_m, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin perform public.chat_oversight_open(v_restricted, 'x'); v_log := public.zz_chk(v_log, 'restricted (Finance) chat needs the finance capability', false);
    exception when others then v_log := public.zz_chk(v_log, 'restricted (Finance) chat needs the finance capability', true); end;
    reset role;
    update role_permissions set is_allowed = true, scope = 'all' where role_id = r_mgmt and permission_key = 'can_view_restricted_finance';
  end if;

  ---------------------------------------------------------------- Explicit action capabilities
  select id into v_task from staff_tasks where is_active and assigned_by <> u_m limit 1;
  update role_permissions set is_allowed = false, scope = 'none' where role_id = r_mgmt and permission_key in ('can_delete_records', 'can_manage_users');
  perform set_config('request.jwt.claims', json_build_object('sub', u_m, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.staff_delete_task(v_task); v_log := public.zz_chk(v_log, 'management WITHOUT can_delete_records cannot delete a task', false);
  exception when others then v_log := public.zz_chk(v_log, 'management WITHOUT can_delete_records cannot delete a task', true); end;
  begin perform public.staff_update_user_role(u_ef, 'supervisor'); v_log := public.zz_chk(v_log, 'management WITHOUT can_manage_users cannot change roles', false);
  exception when others then v_log := public.zz_chk(v_log, 'management WITHOUT can_manage_users cannot change roles', true); end;
  reset role;
  update role_permissions set is_allowed = true, scope = 'all' where role_id = r_mgmt and permission_key in ('can_delete_records', 'can_manage_users');
  perform set_config('request.jwt.claims', json_build_object('sub', u_m, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.staff_update_user_role(u_ef, 'supervisor'); v_log := public.zz_chk(v_log, 'management WITH can_manage_users can change roles', true);
  exception when others then v_log := public.zz_chk(v_log, 'management WITH can_manage_users can change roles: ' || sqlerrm, false); end;
  begin perform public.staff_delete_task(v_task); v_log := public.zz_chk(v_log, 'management WITH can_delete_records can delete a task', true);
  exception when others then v_log := public.zz_chk(v_log, 'management WITH can_delete_records can delete a task: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'management actions write audit rows with the acting role',
    (select count(*) from staff_audit_log where performed_by = u_m and performed_by_role = 'management' and action in ('ROLE_CHANGE', 'DELETE')) >= 2);

  raise exception E'ACCESS-MATRIX-REPORT (rolled back)\n%', v_log;
end
$t$;
