-- v3_14: the order form follows the ordering department. Interior -> Interior PO form, Retail -> Retail PO form, whatever is
-- sent; other departments keep their choice and the Procurement Head's override. Own fixtures, ALWAYS rolls back
-- (the report is in the error message).

do $t$
declare
  v_log text := ''; v_day date; v_int uuid; v_ret uuid; v_mkt uuid; v_res jsonb;
  r_emp uuid; r_head uuid; d_int uuid; d_proc uuid; d_ret uuid; d_mkt uuid;
  u_i uuid := gen_random_uuid(); u_r uuid := gen_random_uuid(); u_m uuid := gen_random_uuid(); u_ph uuid := gen_random_uuid();
  v_item jsonb := '[{"description":"Shelf, oak","qty_size":"1 no","quantity":"1","rate":"5000"}]';
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true); end $f$;
  v_day := public.proc_today_ist();
  select id into r_emp from roles where code = 'employee';
  select id into r_head from roles where code = 'dept_head';
  select id into d_int from departments where code = 'INTERIOR';
  select id into d_proc from departments where code = 'PROCUREMENT';
  select id into d_ret from departments where code = 'RETAIL';
  select id into d_mkt from departments where code = 'MARKETING';
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_i, u_r, u_m, u_ph]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_i, 'ZZ-FD-I', 'ZZ Interior Employee', r_emp, d_int, '9866600001', false, true),
    (u_r, 'ZZ-FD-R', 'ZZ Retail Employee', r_emp, d_ret, '9866600002', false, true),
    (u_m, 'ZZ-FD-M', 'ZZ Marketing Employee', r_emp, d_mkt, '9866600003', false, true),
    (u_ph, 'ZZ-FD-P', 'ZZ Procurement Head', r_head, d_proc, '9866600004', false, true);

  perform public.zz_as(u_i); set local role authenticated;
  v_int := (public.proc_create_order(jsonb_build_object('form_type', 'RETAIL', 'required_completion_date', v_day + 10, 'delivery_location', 'Site A'), v_item)).id;
  reset role;
  v_log := public.zz_chk(v_log, 'an Interior department order is always on the Interior PO form (even when Retail is sent)',
    (select order_form_type = 'INTERIOR' and print_template is null from purchase_requests where id = v_int));

  perform public.zz_as(u_r); set local role authenticated;
  v_ret := (public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'required_completion_date', v_day + 10, 'delivery_location', 'Showroom'), v_item)).id;
  reset role;
  v_log := public.zz_chk(v_log, 'a Retail department order is always on the Retail PO form (even when Interior is sent)',
    (select order_form_type = 'RETAIL' from purchase_requests where id = v_ret));

  perform public.zz_as(u_m); set local role authenticated;
  v_mkt := (public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'required_completion_date', v_day + 10, 'delivery_location', 'Office'), v_item)).id;
  reset role;
  v_log := public.zz_chk(v_log, 'another department (Marketing) keeps the form it chose',
    (select order_form_type = 'INTERIOR' from purchase_requests where id = v_mkt));

  perform public.zz_as(u_r); set local role authenticated;
  begin perform public.proc_update_order(v_ret, jsonb_build_object('form_type', 'INTERIOR', 'required_completion_date', v_day + 11, 'delivery_location', 'Showroom'), v_item);
  exception when others then null; end;
  reset role;
  v_log := public.zz_chk(v_log, 'editing a Retail order cannot move it to the Interior form',
    (select order_form_type = 'RETAIL' from purchase_requests where id = v_ret));

  update procurement_settings set primary_head_user_id = u_ph where id;
  perform public.zz_as(u_ph); set local role authenticated;
  begin perform public.proc_set_print_template(v_int, 'RETAIL', 'test'); v_log := public.zz_chk(v_log, 'the Procurement Head cannot switch an Interior order to Retail', false);
  exception when others then v_log := public.zz_chk(v_log, 'the Procurement Head cannot switch an Interior order to Retail', sqlerrm ilike '%always use the Interior PO form%'); end;
  begin perform public.proc_set_print_template(v_ret, 'INTERIOR', 'test'); v_log := public.zz_chk(v_log, 'the Procurement Head cannot switch a Retail order to Interior', false);
  exception when others then v_log := public.zz_chk(v_log, 'the Procurement Head cannot switch a Retail order to Interior', sqlerrm ilike '%always use the Retail PO form%'); end;
  begin perform public.proc_set_print_template(v_mkt, 'RETAIL', 'Vendor needs the compact form');
        v_log := public.zz_chk(v_log, 'a Marketing order can still be switched by the Procurement Head, with history',
          (select print_template = 'RETAIL' from purchase_requests where id = v_mkt)
          and exists (select 1 from purchase_request_status_history where purchase_request_id = v_mkt and remarks like 'Order form changed from Interior to Retail%'));
  exception when others then v_log := public.zz_chk(v_log, 'Marketing override: ' || sqlerrm, false); end;
  reset role;
  begin update purchase_requests set print_template = 'RETAIL' where id = v_int; exception when others then null; end;
  v_log := public.zz_chk(v_log, 'even a direct write cannot put an Interior order on the Retail form',
    (select order_form_type = 'INTERIOR' and print_template is null from purchase_requests where id = v_int));
  v_log := public.zz_chk(v_log, 'proc_order_template agrees: Interior / Retail / Marketing override',
    (select public.proc_order_template(p) from purchase_requests p where id = v_int) = 'INTERIOR'
    and (select public.proc_order_template(p) from purchase_requests p where id = v_ret) = 'RETAIL'
    and (select public.proc_order_template(p) from purchase_requests p where id = v_mkt) = 'RETAIL');

  raise exception E'\n%', v_log;
end $t$;
