-- Company information and the optional approval threshold (v3_09). Own fixtures; ALWAYS rolls back.

do $t$
declare
  v_log text := ''; n int; v_day date; v_id uuid; v_po public.purchase_orders; v_cp public.company_profile;
  r_emp uuid; r_head uuid; r_mgmt uuid; d_int uuid; d_proc uuid;
  u_e uuid := gen_random_uuid(); u_h uuid := gen_random_uuid(); u_p1 uuid := gen_random_uuid(); u_m uuid := gen_random_uuid(); u_ph uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true); end $f$;
  v_day := public.proc_today_ist();
  select id into r_emp from roles where code = 'employee';
  select id into r_head from roles where code = 'dept_head';
  select id into r_mgmt from roles where code = 'management';
  select id into d_int from departments where code = 'INTERIOR';
  select id into d_proc from departments where code = 'PROCUREMENT';
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_e, u_h, u_p1, u_m, u_ph]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_e, 'ZZ-CS-E', 'ZZ Interior Employee', r_emp, d_int, '9866600001', false, true),
    (u_h, 'ZZ-CS-H', 'ZZ Interior Head', r_head, d_int, '9866600002', false, true),
    (u_p1, 'ZZ-CS-1', 'ZZ Procurement One', r_emp, d_proc, '9866600003', false, true),
    (u_m, 'ZZ-CS-M', 'ZZ Management', r_mgmt, (select department_id from user_profiles up join roles r on r.id = up.role_id where r.code = 'management' limit 1), '9866600004', false, true),
    (u_ph, 'ZZ-CS-P', 'ZZ Procurement Head', r_head, d_proc, '9866600005', false, true);
  update procurement_settings set primary_head_user_id = u_ph where id;

  ---------------------------------------------------------------- company information
  v_log := public.zz_chk(v_log, 'the seeded Rs 25,000 limit is gone: no Management step by default',
    (select max_amount from procurement_approval_limits where approver = 'PROCUREMENT_HEAD') is null
    or (select updated_by from procurement_approval_limits where approver = 'PROCUREMENT_HEAD') is not null);
  update procurement_approval_limits set max_amount = null where approver = 'PROCUREMENT_HEAD';   -- start from the default for this test
  perform public.zz_as(u_e); set local role authenticated;
  begin perform public.staff_set_company_profile('{"company_name":"ZZ"}'); v_log := public.zz_chk(v_log, 'an employee cannot change the company information', false);
  exception when others then v_log := public.zz_chk(v_log, 'an employee cannot change the company information', sqlerrm ilike '%Only Management%'); end;
  begin update company_profile set company_name = 'ZZ hacked'; get diagnostics n = row_count; v_log := public.zz_chk(v_log, 'company information cannot be written directly', n = 0);
  exception when others then v_log := public.zz_chk(v_log, 'company information cannot be written directly', true); end;
  reset role;
  perform public.zz_as(u_m); set local role authenticated;
  begin perform public.staff_set_company_profile('{"company_name":"ZZ Co","gstin":"123"}'); v_log := public.zz_chk(v_log, 'an invalid GST number is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'an invalid GST number is refused', sqlerrm ilike '%GST%'); end;
  begin perform public.staff_set_company_profile('{"company_name":"ZZ Co","pin_code":"12"}'); v_log := public.zz_chk(v_log, 'an invalid PIN code is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'an invalid PIN code is refused', sqlerrm ilike '%PIN%'); end;
  begin
    v_cp := public.staff_set_company_profile(jsonb_build_object('company_name', 'ZZ Test Company Pvt Ltd', 'address_line', 'ZZ Plot 1, ZZ Road',
      'city', 'ZZ City', 'state', 'Gujarat', 'pin_code', '360001', 'phone', '+91 98666 00009', 'email', 'zz@test.invalid', 'gstin', '24abcde1234f1z5'));
    v_log := public.zz_chk(v_log, 'Management saves the company information (GSTIN upper-cased), audited',
      v_cp.company_name = 'ZZ Test Company Pvt Ltd' and v_cp.gstin = '24ABCDE1234F1Z5' and v_cp.pin_code = '360001' and v_cp.updated_by = u_m
      and exists (select 1 from staff_audit_log where entity_type = 'company_profile' and performed_by = u_m));
  exception when others then v_log := public.zz_chk(v_log, 'company save: ' || sqlerrm, false); end;
  reset role;
  perform public.zz_as(u_p1); set local role authenticated;
  select count(*) into n from company_profile where company_name = 'ZZ Test Company Pvt Ltd' and city = 'ZZ City';
  reset role;
  v_log := public.zz_chk(v_log, 'every staff member can read it (it prints on the order form)', n = 1);

  ---------------------------------------------------------------- no Management approval for a normal order
  perform public.zz_as(u_e); set local role authenticated;
  v_id := (public.proc_create_order(jsonb_build_object('form_type', 'RETAIL', 'client_name', 'ZZ Client', 'required_completion_date', v_day + 7,
    'delivery_location', 'Showroom'), '[{"item_code":"ZZ-1","description":"Wardrobe","qty_size":"1","quantity":"1","rate":"85000"}]')).id;
  reset role;
  perform public.zz_as(u_h); set local role authenticated; perform public.proc_dept_decision(v_id, 'APPROVE', null); reset role;
  v_log := public.zz_chk(v_log, 'after the Department Head the order is with Procurement (no Management step)',
    (select proc_status from purchase_requests where id = v_id) = 'SENT_TO_PROCUREMENT'
    and not exists (select 1 from purchase_approvals where purchase_request_id = v_id));
  perform public.zz_as(u_p1); set local role authenticated;
  perform public.proc_accept_order_task(v_id);
  perform public.proc_record_order_print(v_id, 'PRINT');
  begin v_po := public.proc_confirm_order(v_id, 'ZZ Vendor', null, null, 'ZZPO-CS-1', v_day, null, null, v_day + 5, null, null);
  exception when others then v_log := public.zz_chk(v_log, 'confirm: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'a Procurement employee accepts, prints and places an Rs 85,000 order with no Management approval',
    (select proc_status from purchase_requests where id = v_id) = 'ORDER_PLACED' and v_po.total_order_value = 85000 and v_po.confirmed_by = u_p1);

  ---------------------------------------------------------------- optional threshold set by Management
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.proc_set_approval_limit('PROCUREMENT_HEAD', 50000); v_log := public.zz_chk(v_log, 'Procurement cannot set the threshold', false);
  exception when others then v_log := public.zz_chk(v_log, 'Procurement cannot set the threshold', sqlerrm ilike '%Only Management%'); end;
  reset role;
  perform public.zz_as(u_m); set local role authenticated;
  begin perform public.proc_set_approval_limit('PROCUREMENT_HEAD', 50000);
  exception when others then v_log := public.zz_chk(v_log, 'set threshold: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'Management sets an optional threshold (audited)', (select max_amount from procurement_approval_limits where approver = 'PROCUREMENT_HEAD') = 50000
    and exists (select 1 from staff_audit_log where entity_type = 'procurement_approval_limit' and performed_by = u_m));
  perform public.zz_as(u_e); set local role authenticated;
  v_id := (public.proc_create_order(jsonb_build_object('form_type', 'RETAIL', 'client_name', 'ZZ Client 2', 'required_completion_date', v_day + 7,
    'delivery_location', 'Showroom'), '[{"item_code":"ZZ-2","description":"Sofa set","qty_size":"1","quantity":"1","rate":"65000"}]')).id;
  reset role;
  perform public.zz_as(u_h); set local role authenticated; perform public.proc_dept_decision(v_id, 'APPROVE', null); reset role;
  perform public.zz_as(u_p1); set local role authenticated;
  perform public.proc_accept_order_task(v_id);
  perform public.proc_record_order_print(v_id, 'PRINT');
  begin perform public.proc_confirm_order(v_id, 'ZZ Vendor', null, null, 'ZZPO-CS-2', v_day, null, null, v_day + 5, null, null);
        v_log := public.zz_chk(v_log, 'above the configured threshold, Management approval is then needed', false);
  exception when others then v_log := public.zz_chk(v_log, 'above the configured threshold, Management approval is then needed', sqlerrm ilike '%need Management approval%'); end;
  reset role;
  perform public.zz_as(u_m); set local role authenticated; perform public.proc_set_approval_limit('PROCUREMENT_HEAD', null); reset role;
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.proc_confirm_order(v_id, 'ZZ Vendor', null, null, 'ZZPO-CS-2', v_day, null, null, v_day + 5, null, null);
        v_log := public.zz_chk(v_log, 'threshold removed again: the order is placed directly', (select proc_status from purchase_requests where id = v_id) = 'ORDER_PLACED');
  exception when others then v_log := public.zz_chk(v_log, 'threshold removed: ' || sqlerrm, false); end;
  reset role;

  raise exception E'\n%', v_log;
end $t$;
