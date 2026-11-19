-- Sign in by employee code OR mobile number (v3_03). Own fixtures, ALWAYS rolls back. Run it on the dev database.

do $t$
declare
  v_log text := ''; v_a uuid := gen_random_uuid(); v_b uuid := gen_random_uuid(); v_c uuid := gen_random_uuid(); v_mgmt uuid := gen_random_uuid();
  r_emp uuid; r_mgmt uuid; d_int uuid; v_hit uuid; n int;
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  select id into r_emp from roles where code = 'employee';
  select id into r_mgmt from roles where code = 'management';
  select id into d_int from departments where code = 'INTERIOR';
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[v_a, v_b, v_c, v_mgmt]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (v_a, 'ZZ-PH-A', 'Phone User A', r_emp, d_int, '+91 97000 12345', false, true),
    (v_b, 'ZZ-PH-B', 'Phone User B', r_emp, d_int, null, false, true),
    (v_mgmt, 'ZZ-PH-M', 'Phone Director', r_mgmt, null, null, false, true);

  select auth_user_id into v_hit from public.resolve_employee_login('zz-ph-a');
  v_log := public.zz_chk(v_log, 'employee code still signs in (any case)', v_hit = v_a);
  select auth_user_id into v_hit from public.resolve_employee_login('9700012345');
  v_log := public.zz_chk(v_log, 'mobile number signs in: 9700012345', v_hit = v_a);
  select auth_user_id into v_hit from public.resolve_employee_login('+91 97000-12345');
  v_log := public.zz_chk(v_log, 'mobile number signs in however it is typed: +91 97000-12345', v_hit = v_a);
  select auth_user_id into v_hit from public.resolve_employee_login('09700012345');
  v_log := public.zz_chk(v_log, 'mobile number signs in with a leading 0', v_hit = v_a);
  select count(*) into n from public.resolve_employee_login('97000');
  v_log := public.zz_chk(v_log, 'a short number matches nobody', n = 0);
  select count(*) into n from public.resolve_employee_login('9999999999');
  v_log := public.zz_chk(v_log, 'an unknown number matches nobody', n = 0);

  begin update user_profiles set phone = '97000 12345' where id = v_b; v_log := public.zz_chk(v_log, 'the database refuses the same number for a second person', false);
  exception when unique_violation then v_log := public.zz_chk(v_log, 'the database refuses the same number for a second person', true); end;
  begin update user_profiles set phone = '12345' where id = v_b; v_log := public.zz_chk(v_log, 'the database refuses a number with fewer than 10 digits', false);
  exception when check_violation then v_log := public.zz_chk(v_log, 'the database refuses a number with fewer than 10 digits', true); end;
  v_log := public.zz_chk(v_log, 'staff-create-user''s pre-check names who holds a number', public.staff_phone_in_use('9700012345') = 'Phone User A');

  perform set_config('request.jwt.claims', json_build_object('sub', v_mgmt, 'role', 'authenticated')::text, true); set local role authenticated;
  begin perform public.staff_update_user_profile(v_b, 'Phone User B', '+91 97000 12345'); v_log := public.zz_chk(v_log, 'profile edit: a taken number gives a readable message', false);
  exception when others then v_log := public.zz_chk(v_log, 'profile edit: a taken number gives a readable message (' || sqlerrm || ')', sqlerrm ilike '%already used by Phone User A%'); end;
  begin perform public.staff_update_user_profile(v_b, 'Phone User B', '123'); v_log := public.zz_chk(v_log, 'profile edit: a short number is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'profile edit: a short number is refused', sqlerrm ilike '%10 to 13 digits%'); end;
  begin perform public.staff_update_user_profile(v_b, 'Phone User B', '98000 54321');
        v_log := public.zz_chk(v_log, 'profile edit: a free number is saved', (select phone from user_profiles where id = v_b) = '98000 54321');
  exception when others then v_log := public.zz_chk(v_log, 'profile edit: ' || sqlerrm, false); end;
  reset role;
  select auth_user_id into v_hit from public.resolve_employee_login('9800054321');
  v_log := public.zz_chk(v_log, 'the newly added number signs in straight away', v_hit = v_b);

  update user_profiles set is_deleted = true, is_active = false where id = v_a;
  select count(*) into n from public.resolve_employee_login('9700012345');
  v_log := public.zz_chk(v_log, 'a deleted user''s number no longer signs in', n = 0);
  begin update user_profiles set phone = '9700012345' where id = v_mgmt;
        v_log := public.zz_chk(v_log, 'a deleted user''s number can be given to someone new', true);
  exception when others then v_log := public.zz_chk(v_log, 'reuse number: ' || sqlerrm, false); end;

  perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true); set local role authenticated;
  begin perform public.resolve_employee_login('9800054321'); v_log := public.zz_chk(v_log, 'signed-in users cannot call the login lookup themselves', false);
  exception when others then v_log := public.zz_chk(v_log, 'signed-in users cannot call the login lookup themselves', sqlerrm ilike '%permission denied%'); end;
  begin perform public.staff_phone_in_use('9800054321'); v_log := public.zz_chk(v_log, 'signed-in users cannot probe who owns a number', false);
  exception when others then v_log := public.zz_chk(v_log, 'signed-in users cannot probe who owns a number', sqlerrm ilike '%permission denied%'); end;
  reset role;

  raise exception E'\n%', v_log;
end $t$;
