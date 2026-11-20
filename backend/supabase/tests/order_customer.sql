-- Customer details on order forms (v3_10). Own fixtures; ALWAYS rolls back (the report is in the error message).

do $t$
declare
  v_log text := ''; n int; v_day date; v_pr public.purchase_requests; v_id uuid; v_rc public.retail_customers; v_other public.retail_customers;
  r_emp uuid; d_int uuid; d_ret uuid; d_fac uuid; v_cust jsonb;
  u_r uuid := gen_random_uuid(); u_r2 uuid := gen_random_uuid(); u_e uuid := gen_random_uuid(); u_f uuid := gen_random_uuid();
  v_items jsonb := '[{"item_code":"BD-1","description":"King bed","qty_size":"1","quantity":"1","rate":"42000"}]';
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true); end $f$;
  v_day := public.proc_today_ist();
  select id into r_emp from roles where code = 'employee';
  select id into d_int from departments where code = 'INTERIOR';
  select id into d_ret from departments where code = 'RETAIL';
  select id into d_fac from departments where code = 'FACTORY';
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_r, u_r2, u_e, u_f]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_r, 'ZZ-OC-R', 'ZZ Retail Sales One', r_emp, d_ret, '9877700001', false, true),
    (u_r2, 'ZZ-OC-R2', 'ZZ Retail Sales Two', r_emp, d_ret, '9877700002', false, true),
    (u_e, 'ZZ-OC-E', 'ZZ Interior Employee', r_emp, d_int, '9877700003', false, true),
    (u_f, 'ZZ-OC-F', 'ZZ Factory Employee', r_emp, d_fac, '9877700004', false, true);
  v_cust := jsonb_build_object('name', 'ZZ Mrs. Patel', 'mobile', '+91 98765 43210', 'alt_mobile', '09123456789', 'email', 'ZZ.Patel@Example.com',
    'gstin', '24abcde1234f1z5', 'billing', jsonb_build_object('line1', 'ZZ 12, Shanti Nagar', 'line2', 'Near ZZ Circle', 'city', 'Rajkot', 'state', 'Gujarat', 'pin', '360005'),
    'delivery_same_as_billing', true, 'delivery', jsonb_build_object('contact_person', 'ZZ Ramesh', 'contact_phone', '99887 76655'));

  ---------------------------------------------------------------- new Retail customer, billing copied to delivery
  perform public.zz_as(u_r); set local role authenticated;
  begin
    v_pr := public.proc_create_order(jsonb_build_object('form_type', 'RETAIL', 'required_completion_date', v_day + 7, 'delivery_location', 'Showroom', 'customer', v_cust), v_items);
    v_id := v_pr.id;
  exception when others then v_log := public.zz_chk(v_log, 'create with customer: ' || sqlerrm, false); end;
  reset role;
  select * into v_pr from purchase_requests where id = v_id;
  v_log := public.zz_chk(v_log, 'the order keeps the customer: mobiles normalised, email lower-case, GST upper-case, client name follows',
    v_pr.customer->>'mobile' = '+91 9876543210' and v_pr.customer->>'alt_mobile' = '+91 9123456789' and v_pr.customer->>'email' = 'zz.patel@example.com'
    and v_pr.customer->>'gstin' = '24ABCDE1234F1Z5' and v_pr.client_name = 'ZZ Mrs. Patel');
  v_log := public.zz_chk(v_log, '"same as billing" copies the billing address into delivery and keeps the delivery contact',
    v_pr.customer->'delivery'->>'line1' = 'ZZ 12, Shanti Nagar' and v_pr.customer->'delivery'->>'pin' = '360005' and v_pr.customer->'delivery'->>'city' = 'Rajkot'
    and v_pr.customer->'delivery'->>'contact_person' = 'ZZ Ramesh' and v_pr.customer->'delivery'->>'contact_phone' = '+91 9988776655');
  select * into v_rc from retail_customers where id = v_pr.retail_customer_id;
  v_log := public.zz_chk(v_log, 'a new customer is saved in the Retail customer database, owned by the salesperson, with the address',
    v_rc.id is not null and v_rc.full_name = 'ZZ Mrs. Patel' and v_rc.owner_salesperson_id = u_r and v_rc.normalized_phone = public.retail_normalize_phone('9876543210')
    and v_rc.billing_address = 'ZZ 12, Shanti Nagar, Near ZZ Circle, Rajkot, Gujarat, 360005');

  ---------------------------------------------------------------- existing customer re-used; delivery edited on its own
  perform public.zz_as(u_r); set local role authenticated;
  begin
    v_pr := public.proc_create_order(jsonb_build_object('form_type', 'RETAIL', 'required_completion_date', v_day + 9, 'delivery_location', 'Site',
      'customer', jsonb_build_object('name', 'ZZ Mrs. Patel', 'mobile', '9876543210', 'retail_customer_id', v_rc.id,
        'billing', v_cust->'billing', 'delivery_same_as_billing', false,
        'delivery', jsonb_build_object('line1', 'ZZ Farmhouse, Kalawad Road', 'city', 'Rajkot', 'state', 'Gujarat', 'pin', '360007'))),
      '[{"item_code":"SF-2","description":"Sofa","qty_size":"1","quantity":"1","rate":"30000"}]');
  exception when others then v_log := public.zz_chk(v_log, 'second order: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'an existing customer is linked again, not duplicated',
    v_pr.retail_customer_id = v_rc.id and (select count(*) from retail_customers where normalized_phone = public.retail_normalize_phone('9876543210')) = 1);
  v_log := public.zz_chk(v_log, 'the delivery address can differ from billing', v_pr.customer->'delivery'->>'line1' = 'ZZ Farmhouse, Kalawad Road'
    and v_pr.customer->'billing'->>'line1' = 'ZZ 12, Shanti Nagar' and not (v_pr.customer->>'delivery_same_as_billing')::boolean);

  ---------------------------------------------------------------- validation; GST optional
  perform public.zz_as(u_r); set local role authenticated;
  begin perform public.proc_create_order(jsonb_build_object('form_type', 'RETAIL', 'required_completion_date', v_day + 7, 'delivery_location', 'X',
          'customer', jsonb_build_object('name', 'ZZ A', 'mobile', '12345')), '[{"description":"A","qty_size":"1"}]');
        v_log := public.zz_chk(v_log, 'an invalid mobile number is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'an invalid mobile number is refused', sqlerrm ilike '%10-digit mobile%'); end;
  begin perform public.proc_create_order(jsonb_build_object('form_type', 'RETAIL', 'required_completion_date', v_day + 7, 'delivery_location', 'X',
          'customer', jsonb_build_object('name', 'ZZ B', 'billing', jsonb_build_object('pin', '0360'))), '[{"description":"B","qty_size":"1"}]');
        v_log := public.zz_chk(v_log, 'an invalid PIN code is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'an invalid PIN code is refused', sqlerrm ilike '%PIN code must be 6 digits%'); end;
  begin perform public.proc_create_order(jsonb_build_object('form_type', 'RETAIL', 'required_completion_date', v_day + 7, 'delivery_location', 'X',
          'customer', jsonb_build_object('name', 'ZZ C', 'gstin', 'ABC')), '[{"description":"C","qty_size":"1"}]');
        v_log := public.zz_chk(v_log, 'an invalid GST number is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'an invalid GST number is refused', sqlerrm ilike '%GST%'); end;
  begin perform public.proc_create_order(jsonb_build_object('form_type', 'RETAIL', 'required_completion_date', v_day + 7, 'delivery_location', 'X',
          'customer', jsonb_build_object('name', 'ZZ D', 'mobile', '9000011111')), '[{"description":"D","qty_size":"1"}]');
        v_log := public.zz_chk(v_log, 'GST number is optional', true);
  exception when others then v_log := public.zz_chk(v_log, 'GST number is optional: ' || sqlerrm, false); end;
  reset role;

  ---------------------------------------------------------------- another salesperson's customer is never changed or duplicated
  perform public.zz_as(u_r2); set local role authenticated;
  begin
    v_pr := public.proc_create_order(jsonb_build_object('form_type', 'RETAIL', 'required_completion_date', v_day + 7, 'delivery_location', 'Showroom',
      'customer', jsonb_build_object('name', 'ZZ Someone Else', 'mobile', '9876543210', 'billing', jsonb_build_object('line1', 'ZZ Other address'))),
      '[{"description":"Table","qty_size":"1"}]');
  exception when others then v_log := public.zz_chk(v_log, 'other salesperson: ' || sqlerrm, false); end;
  reset role;
  select * into v_other from retail_customers where id = v_rc.id;
  v_log := public.zz_chk(v_log, 'a customer owned by another salesperson is not linked, not duplicated and not changed',
    v_pr.retail_customer_id is null and v_pr.customer->>'name' = 'ZZ Someone Else'
    and (select count(*) from retail_customers where normalized_phone = public.retail_normalize_phone('9876543210')) = 1
    and v_other.full_name = 'ZZ Mrs. Patel' and v_other.billing_address = 'ZZ 12, Shanti Nagar, Near ZZ Circle, Rajkot, Gujarat, 360005');

  ---------------------------------------------------------------- Interior: the order is the record; save, reopen, edit
  perform public.zz_as(u_e); set local role authenticated;
  begin
    v_pr := public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'required_completion_date', v_day + 10, 'delivery_location', 'Shah site',
      'customer', jsonb_build_object('name', 'ZZ Kamlesh Shah', 'mobile', '9811122233', 'billing', jsonb_build_object('line1', 'ZZ 4, Race Course', 'city', 'Rajkot', 'pin', '360001'),
        'delivery_same_as_billing', true)), '[{"description":"Dining table","qty_size":"1 no"}]', false);
    v_id := v_pr.id;
    perform public.proc_update_order(v_id, jsonb_build_object('form_type', 'INTERIOR', 'required_completion_date', v_day + 10, 'delivery_location', 'Shah site',
      'customer', jsonb_build_object('name', 'ZZ Kamlesh Shah', 'mobile', '9811122233', 'billing', jsonb_build_object('line1', 'ZZ 4, Race Course', 'city', 'Rajkot', 'pin', '360001'),
        'delivery_same_as_billing', false, 'delivery', jsonb_build_object('line1', 'ZZ New Villa, 150 Ft Ring Road', 'city', 'Rajkot', 'pin', '360005',
        'contact_person', 'ZZ Watchman', 'contact_phone', '9822233344'))), '[{"description":"Dining table","qty_size":"1 no"}]');
  exception when others then v_log := public.zz_chk(v_log, 'interior: ' || sqlerrm, false); end;
  select * into v_pr from purchase_requests where id = v_id;
  reset role;
  v_log := public.zz_chk(v_log, 'Interior: saved with the draft, reopened and the delivery address edited on its own',
    v_pr.customer->>'name' = 'ZZ Kamlesh Shah' and v_pr.customer->'delivery'->>'line1' = 'ZZ New Villa, 150 Ft Ring Road'
    and v_pr.customer->'billing'->>'line1' = 'ZZ 4, Race Course' and v_pr.customer->'delivery'->>'contact_phone' = '+91 9822233344');
  v_log := public.zz_chk(v_log, 'Interior orders do not create Retail customers', v_pr.retail_customer_id is null
    and not exists (select 1 from retail_customers where normalized_phone = public.retail_normalize_phone('9811122233')));
  perform public.zz_as(u_e); set local role authenticated;
  begin perform public.proc_update_order(v_id, jsonb_build_object('form_type', 'INTERIOR', 'required_completion_date', v_day + 10, 'delivery_location', 'Shah site'),
          '[{"description":"Dining table","qty_size":"1 no"}]');
  exception when others then v_log := public.zz_chk(v_log, 'update without customer: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'saving other fields leaves the customer as it was', (select customer->>'name' from purchase_requests where id = v_id) = 'ZZ Kamlesh Shah');

  ---------------------------------------------------------------- search and visibility
  perform public.zz_as(u_e); set local role authenticated;
  select count(*) into n from public.proc_search_customers('kamlesh') s where s.source = 'ORDER' and s.customer->'delivery'->>'line1' = 'ZZ New Villa, 150 Ft Ring Road';
  v_log := public.zz_chk(v_log, 'the employee finds the customer from their earlier order, with the full address, to fill a new order', n = 1);
  reset role;
  perform public.zz_as(u_f); set local role authenticated;
  select count(*) into n from public.proc_search_customers('kamlesh');
  v_log := public.zz_chk(v_log, 'another department cannot find it', n = 0);
  select count(*) into n from purchase_requests where id = v_id;
  v_log := public.zz_chk(v_log, 'another department cannot see the order or its customer', n = 0);
  reset role;
  perform public.zz_as(u_r); set local role authenticated;
  perform public.retail_upsert_customer('ZZ Walk-in Mehta', '9700000001', null, null, 'Rajkot');
  select count(*) into n from public.proc_search_customers('9700000001') s where s.source = 'RETAIL' and s.customer->>'mobile' = '+91 9700000001';
  v_log := public.zz_chk(v_log, 'a Retail salesperson also finds their customers from the Retail customer database', n = 1);
  select count(*) into n from public.proc_search_customers('98765');
  v_log := public.zz_chk(v_log, 'search by part of the mobile number; one row per customer', n = 1);
  reset role;
  perform public.zz_as(u_r2); set local role authenticated;
  select count(*) into n from public.proc_search_customers('9700000001');
  v_log := public.zz_chk(v_log, 'another salesperson does not see that customer', n = 0);
  reset role;

  raise exception E'\n%', v_log;
end $t$;
