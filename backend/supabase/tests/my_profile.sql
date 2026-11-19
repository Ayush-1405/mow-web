-- My Profile (v3_04): adding your own mobile number, personal details, and who can see whose profile. Own fixtures,
-- ALWAYS rolls back. Run it on the dev database.

do $t$
declare
  v_log text := ''; v_p jsonb; n int;
  r_emp uuid; r_head uuid; r_mgmt uuid; d_int uuid; d_ret uuid;
  u_a uuid := gen_random_uuid(); u_b uuid := gen_random_uuid(); u_h uuid := gen_random_uuid(); u_rh uuid := gen_random_uuid(); u_m uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true); end $f$;
  select id into r_emp from roles where code = 'employee';
  select id into r_head from roles where code = 'dept_head';
  select id into r_mgmt from roles where code = 'management';
  select id into d_int from departments where code = 'INTERIOR';
  select id into d_ret from departments where code = 'RETAIL';
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_a, u_b, u_h, u_rh, u_m]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_a, 'ZZ-MP-A', 'Profile A', r_emp, d_int, null, false, true),
    (u_b, 'ZZ-MP-B', 'Profile B', r_emp, d_int, '9811100002', false, true),
    (u_h, 'ZZ-MP-H', 'Interior Head', r_head, d_int, '9811100003', false, true),
    (u_rh, 'ZZ-MP-R', 'Retail Head', r_head, d_ret, '9811100004', false, true),
    (u_m, 'ZZ-MP-M', 'Director', r_mgmt, null, '9811100005', false, true);

  perform public.zz_as(u_a); set local role authenticated;
  begin perform public.staff_set_my_phone('12345'); v_log := public.zz_chk(v_log, 'a short number is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'a short number is refused', sqlerrm ilike '%10 to 13 digits%'); end;
  begin perform public.staff_set_my_phone('+91 98111 00002'); v_log := public.zz_chk(v_log, 'someone else''s number is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'someone else''s number is refused', sqlerrm ilike '%already used%'); end;
  begin perform public.staff_set_my_phone('+91 98111 00001');
        v_log := public.zz_chk(v_log, 'the user adds their own number (first-open screen)', (select phone from user_profiles where id = u_a) = '+91 98111 00001');
  exception when others then v_log := public.zz_chk(v_log, 'set own phone: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'the new number signs in at once', (select auth_user_id from public.resolve_employee_login('9811100001')) = u_a);
  v_log := public.zz_chk(v_log, 'adding the number is audited', (select count(*) from staff_audit_log where entity_id = u_a and action = 'SET_OWN_PHONE') = 1);

  perform public.zz_as(u_a); set local role authenticated;
  begin perform public.staff_save_my_profile('+91 98111 00001', '{"city":"Rajkot","blood_group":"B+","date_of_birth":"1995-04-12","emergency_contact_name":"Ramesh","emergency_contact_phone":"9811199999","personal_email":"a@example.com"}');
        v_p := public.staff_get_profile(null);
        v_log := public.zz_chk(v_log, 'personal details are saved and shown on the own profile',
          v_p->'personal'->>'city' = 'Rajkot' and v_p->'personal'->>'blood_group' = 'B+' and (v_p->>'is_self')::boolean and v_p->>'department' is not null);
  exception when others then v_log := public.zz_chk(v_log, 'save profile: ' || sqlerrm, false); end;
  begin perform public.staff_save_my_profile('+91 98111 00001', '{"blood_group":"Z+"}'); v_log := public.zz_chk(v_log, 'an invalid blood group is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'an invalid blood group is refused', sqlerrm ilike '%blood group%'); end;
  begin perform public.staff_save_my_profile('+91 98111 00001', '{"date_of_birth":"2099-01-01"}'); v_log := public.zz_chk(v_log, 'a future date of birth is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'a future date of birth is refused', true); end;
  begin perform public.staff_get_profile(u_b); v_log := public.zz_chk(v_log, 'an employee cannot open a colleague''s profile', false);
  exception when others then v_log := public.zz_chk(v_log, 'an employee cannot open a colleague''s profile', sqlerrm ilike '%cannot view%'); end;
  select count(*) into n from staff_personal_details where user_id <> u_a;
  v_log := public.zz_chk(v_log, 'an employee cannot read anyone else''s personal details', n = 0);
  begin insert into staff_personal_details (user_id, city) values (u_b, 'x'); v_log := public.zz_chk(v_log, 'personal details cannot be written directly', false);
  exception when others then v_log := public.zz_chk(v_log, 'personal details cannot be written directly', sqlerrm ilike '%permission denied%'); end;
  begin update user_profiles set full_name = 'Hacked' where id = u_a; get diagnostics n = row_count;
        v_log := public.zz_chk(v_log, 'official name cannot be changed by the user directly', n = 0 or (select full_name from user_profiles where id = u_a) = 'Profile A');
  exception when others then v_log := public.zz_chk(v_log, 'official name cannot be changed by the user directly', true); end;
  reset role;

  perform public.zz_as(u_h); set local role authenticated;
  begin v_p := public.staff_get_profile(u_a);
        v_log := public.zz_chk(v_log, 'the Interior Head opens an Interior employee''s profile with personal details and work summary',
          v_p->'personal'->>'city' = 'Rajkot' and not (v_p->>'is_self')::boolean and v_p->'stats' ? 'tasks_open');
  exception when others then v_log := public.zz_chk(v_log, 'head view: ' || sqlerrm, false); end;
  reset role;
  perform public.zz_as(u_rh); set local role authenticated;
  begin perform public.staff_get_profile(u_a); v_log := public.zz_chk(v_log, 'a Retail Head cannot open an Interior employee''s profile', false);
  exception when others then v_log := public.zz_chk(v_log, 'a Retail Head cannot open an Interior employee''s profile', true); end;
  reset role;
  perform public.zz_as(u_m); set local role authenticated;
  begin v_p := public.staff_get_profile(u_a);
        v_log := public.zz_chk(v_log, 'Management opens anyone''s profile', v_p->>'employee_code' = 'ZZ-MP-A');
  exception when others then v_log := public.zz_chk(v_log, 'management view: ' || sqlerrm, false); end;
  reset role;

  raise exception E'\n%', v_log;
end $t$;
