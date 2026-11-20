-- Vendor master, recommendations and per-line vendor allocation (v3_12). Own fixtures (ZZ vendors); ALWAYS rolls back.

do $t$
declare
  v_log text := ''; n int; v_day date; v_id uuid; v_id2 uuid; v_po public.purchase_orders; v_txt text;
  r_emp uuid; r_head uuid; r_mgmt uuid; d_int uuid; d_proc uuid;
  u_e uuid := gen_random_uuid(); u_h uuid := gen_random_uuid(); u_p1 uuid := gen_random_uuid(); u_ph uuid := gen_random_uuid(); u_m uuid := gen_random_uuid();
  v1 uuid; v2 uuid; v3 uuid; v4 uuid; v5 uuid; v6 uuid;
  i_ply uuid; i_lam uuid; i_hin uuid; i_chn uuid;
  v_items jsonb := '[{"item_code":"PLY-18","description":"18mm BWR Plywood Century","qty_size":"10 sheets","quantity":"10"},
                     {"description":"Laminate 1mm suede finish","qty_size":"6 sheets","quantity":"6"},
                     {"description":"Soft close hinges Hettich","qty_size":"40 nos","quantity":"40"},
                     {"description":"Drawer channels 18 in","qty_size":"10 pairs","quantity":"10"}]';
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
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_e, u_h, u_p1, u_ph, u_m]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_e, 'ZZ-VR-E', 'ZZ Interior Employee', r_emp, d_int, '9899900001', false, true),
    (u_h, 'ZZ-VR-H', 'ZZ Interior Head', r_head, d_int, '9899900002', false, true),
    (u_p1, 'ZZ-VR-1', 'ZZ Procurement One', r_emp, d_proc, '9899900003', false, true),
    (u_ph, 'ZZ-VR-P', 'ZZ Procurement Head', r_head, d_proc, '9899900004', false, true),
    (u_m, 'ZZ-VR-M', 'ZZ Management', r_mgmt, (select department_id from user_profiles up join roles r on r.id = up.role_id where r.code = 'management' limit 1), '9899900005', false, true);
  update procurement_settings set primary_head_user_id = u_ph where id;

  ---------------------------------------------------------------- vendor master
  v_log := public.zz_chk(v_log, 'material categories are recognised from the line text (whole words)',
    'PLYWOOD' = any(public.proc_text_categories('18mm BWR Plywood Century')) and 'HARDWARE' = any(public.proc_text_categories('Soft close hinges Hettich'))
    and 'HARDWARE' = any(public.proc_text_categories('Drawer channels 18 in')) and cardinality(public.proc_text_categories('computer input device')) = 0);
  perform public.zz_as(u_e); set local role authenticated;
  begin perform public.proc_save_vendor_master(null, '{"name":"ZZ X","mobile":"9811100000"}'); v_log := public.zz_chk(v_log, 'a department employee cannot add vendors', false);
  exception when others then v_log := public.zz_chk(v_log, 'a department employee cannot add vendors', sqlerrm ilike '%Only Procurement%'); end;
  reset role;
  perform public.zz_as(u_p1); set local role authenticated;
  v1 := (public.proc_save_vendor_master(null, '{"name":"ZZ Century Ply Dealer","contact_person":"ZZ Mehul","mobile":"9811100001","whatsapp":"9811100001","email":"zz1@test.invalid","address":"ZZ Rajkot","gstin":"24AAAAA1111A1Z1","categories":["PLYWOOD"],"brands":["Century"],"payment_terms":"30 days","avg_delivery_days":"3","internal_remarks":"ZZ reliable"}')).id;
  v2 := (public.proc_save_vendor_master(null, '{"name":"ZZ Greenply Traders","mobile":"9811100002","categories":["PLYWOOD"],"avg_delivery_days":"2"}')).id;
  v3 := (public.proc_save_vendor_master(null, '{"name":"ZZ Hettich Hardware","mobile":"9811100003","categories":["HARDWARE"],"brands":["Hettich"],"avg_delivery_days":"2"}')).id;
  v4 := (public.proc_save_vendor_master(null, '{"name":"ZZ All In One Interiors","mobile":"9811100004","categories":["PLYWOOD","LAMINATE","HARDWARE"],"avg_delivery_days":"5"}')).id;
  v5 := (public.proc_save_vendor_master(null, '{"name":"ZZ Blacklisted Ply","mobile":"9811100005","categories":["PLYWOOD"]}')).id;
  v6 := (public.proc_save_vendor_master(null, '{"name":"ZZ Laminate House","mobile":"9811100006","categories":["LAMINATE"]}')).id;
  begin perform public.proc_save_vendor_master(null, '{"name":"ZZ Bad","mobile":"9811100007","categories":["NOPE"]}'); v_log := public.zz_chk(v_log, 'an unknown category is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'an unknown category is refused', sqlerrm ilike '%Unknown material category%'); end;
  begin perform public.proc_set_vendor_rating(v1, 'PREFERRED', null); v_log := public.zz_chk(v_log, 'a Procurement employee cannot set vendor preference', false);
  exception when others then v_log := public.zz_chk(v_log, 'a Procurement employee cannot set vendor preference', sqlerrm ilike '%Only Management%'); end;
  reset role;
  v_log := public.zz_chk(v_log, 'vendor master keeps categories, brands, WhatsApp, delivery days; internal remarks kept apart',
    (select categories = '{PLYWOOD}' and brands = '{Century}' and whatsapp = '9811100001' and avg_delivery_days = 3 from vendors where id = v1)
    and (select remarks from vendor_internal_notes where vendor_id = v1) = 'ZZ reliable');
  perform public.zz_as(u_m); set local role authenticated;
  perform public.proc_set_vendor_rating(v1, 'PREFERRED', 'ZZ best rates');
  perform public.proc_set_vendor_rating(v2, 'REGULAR', null);
  perform public.proc_set_vendor_rating(v3, 'REGULAR', null);
  begin perform public.proc_set_vendor_rating(v5, 'BLACKLISTED', ''); v_log := public.zz_chk(v_log, 'blacklisting needs a reason', false);
  exception when others then v_log := public.zz_chk(v_log, 'blacklisting needs a reason', sqlerrm ilike '%reason%'); end;
  perform public.proc_set_vendor_rating(v5, 'BLACKLISTED', 'ZZ fake bills');
  perform public.proc_set_vendor_rating(v6, 'TEMPORARILY_BLOCKED', 'ZZ late twice');
  reset role;
  perform public.zz_as(u_e); set local role authenticated;
  select count(*) into n from vendor_internal_notes where vendor_id = v1;
  v_log := public.zz_chk(v_log, 'department staff cannot read internal vendor remarks', n = 0);
  reset role;

  ---------------------------------------------------------------- order with four materials
  perform public.zz_as(u_e); set local role authenticated;
  v_id := (public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'client_name', 'ZZ Shah', 'required_completion_date', v_day + 6,
    'delivery_location', 'ZZ Shah site'), v_items)).id;
  reset role;
  select id into i_ply from purchase_request_items where purchase_request_id = v_id and line_no = 1;
  select id into i_lam from purchase_request_items where purchase_request_id = v_id and line_no = 2;
  select id into i_hin from purchase_request_items where purchase_request_id = v_id and line_no = 3;
  select id into i_chn from purchase_request_items where purchase_request_id = v_id and line_no = 4;
  perform public.zz_as(u_h); set local role authenticated; perform public.proc_dept_decision(v_id, 'APPROVE', null); reset role;
  insert into vendor_quotations (purchase_request_id, vendor_id, quotation_number, quotation_date, material_rate, final_offer, lead_time_days)
  values (v_id, v2, 'ZZQ-77', v_day, 14200, 14200, 2);
  perform public.zz_as(u_e); set local role authenticated;
  begin perform public.proc_recommend_vendors(v_id); v_log := public.zz_chk(v_log, 'department staff cannot see vendor recommendations', false);
  exception when others then v_log := public.zz_chk(v_log, 'department staff cannot see vendor recommendations', sqlerrm ilike '%Only Procurement%'); end;
  reset role;

  perform public.zz_as(u_p1); set local role authenticated;
  perform public.proc_accept_order_task(v_id);
  select string_agg(vendor_name || ':' || tier, ',' order by score desc) filter (where item_id = i_ply) into v_txt from public.proc_recommend_vendors(v_id) where vendor_name like 'ZZ%';
  v_log := public.zz_chk(v_log, 'plywood: the preferred vendor first, then regular approved, then other matching; blacklisted never shown ' || coalesce(v_txt, ''),
    (select vendor_id from public.proc_recommend_vendors(v_id) where item_id = i_ply and vendor_name like 'ZZ%' order by tier, score desc limit 1) = v1
    and exists (select 1 from public.proc_recommend_vendors(v_id) where item_id = i_ply and vendor_id = v2 and tier = 2)
    and exists (select 1 from public.proc_recommend_vendors(v_id) where item_id = i_ply and vendor_id = v4 and tier = 3)
    and not exists (select 1 from public.proc_recommend_vendors(v_id) where vendor_id = v5));
  v_log := public.zz_chk(v_log, 'the recommendation says why: preferred, category, brand; a quote for this order is shown',
    (select 'Preferred vendor' = any(reasons) and 'Supplies the brand asked for' = any(reasons) from public.proc_recommend_vendors(v_id) where item_id = i_ply and vendor_id = v1)
    and (select quote_reference = 'ZZQ-77' and quote_amount = 14200 from public.proc_recommend_vendors(v_id) where item_id = i_ply and vendor_id = v2));
  v_log := public.zz_chk(v_log, 'laminate: a temporarily blocked vendor is not offered',
    not exists (select 1 from public.proc_recommend_vendors(v_id) where item_id = i_lam and vendor_id = v6)
    and exists (select 1 from public.proc_recommend_vendors(v_id) where item_id = i_lam and vendor_id = v4));
  v_log := public.zz_chk(v_log, 'hinges and channels: hardware suppliers, each line on its own',
    exists (select 1 from public.proc_recommend_vendors(v_id) where item_id = i_hin and vendor_id = v3)
    and exists (select 1 from public.proc_recommend_vendors(v_id) where item_id = i_chn and vendor_id = v3)
    and not exists (select 1 from public.proc_recommend_vendors(v_id) where item_id = i_hin and vendor_id = v1));
  v_log := public.zz_chk(v_log, 'a vendor that supplies every line is marked as a combined-supply option',
    (select bool_and(combined) from public.proc_recommend_vendors(v_id) where vendor_id = v4)
    and not (select bool_or(combined) from public.proc_recommend_vendors(v_id) where vendor_id = v1));
  perform public.proc_record_order_print(v_id, 'PRINT');

  ---------------------------------------------------------------- placing with several vendors
  begin perform public.proc_place_order_with_vendors(v_id, jsonb_build_array(jsonb_build_object('item_id', i_ply, 'vendor_id', v1, 'vendor_po_reference', 'ZZPO-A', 'expected_delivery_date', v_day + 3)),
          jsonb_build_object('order_date', v_day));
        v_log := public.zz_chk(v_log, 'every line needs a vendor', false);
  exception when others then v_log := public.zz_chk(v_log, 'every line needs a vendor', sqlerrm ilike '%every line%'); end;
  begin perform public.proc_place_order_with_vendors(v_id, jsonb_build_array(
            jsonb_build_object('item_id', i_ply, 'vendor_id', v5, 'vendor_po_reference', 'ZZPO-X', 'expected_delivery_date', v_day + 3),
            jsonb_build_object('item_id', i_lam, 'vendor_id', v4, 'vendor_po_reference', 'ZZPO-B', 'expected_delivery_date', v_day + 3),
            jsonb_build_object('item_id', i_hin, 'vendor_id', v3, 'vendor_po_reference', 'ZZPO-C', 'expected_delivery_date', v_day + 3),
            jsonb_build_object('item_id', i_chn, 'vendor_id', v3, 'vendor_po_reference', 'ZZPO-C', 'expected_delivery_date', v_day + 3)), jsonb_build_object('order_date', v_day));
        v_log := public.zz_chk(v_log, 'a blacklisted vendor cannot be chosen', false);
  exception when others then v_log := public.zz_chk(v_log, 'a blacklisted vendor cannot be chosen', sqlerrm ilike '%blocked or inactive%'); end;
  begin perform public.proc_place_order_with_vendors(v_id, jsonb_build_array(
            jsonb_build_object('item_id', i_ply, 'vendor_id', v1, 'vendor_po_reference', 'ZZPO-A', 'expected_delivery_date', v_day + 3),
            jsonb_build_object('item_id', i_lam, 'vendor_id', v4, 'vendor_po_reference', 'ZZPO-B', 'expected_delivery_date', v_day + 3),
            jsonb_build_object('item_id', i_hin, 'vendor_id', v3, 'vendor_po_reference', 'ZZPO-C', 'expected_delivery_date', v_day + 3),
            jsonb_build_object('item_id', i_chn, 'vendor_id', v3, 'vendor_po_reference', 'ZZPO-D', 'expected_delivery_date', v_day + 3)), jsonb_build_object('order_date', v_day));
        v_log := public.zz_chk(v_log, 'one PO / reference per vendor', false);
  exception when others then v_log := public.zz_chk(v_log, 'one PO / reference per vendor', sqlerrm ilike '%one PO / reference number per vendor%'); end;
  begin perform public.proc_place_order_with_vendors(v_id, jsonb_build_array(
            jsonb_build_object('item_id', i_ply, 'vendor_id', v1, 'vendor_po_reference', 'ZZPO-A', 'expected_delivery_date', v_day + 9),
            jsonb_build_object('item_id', i_lam, 'vendor_id', v4, 'vendor_po_reference', 'ZZPO-B', 'expected_delivery_date', v_day + 3),
            jsonb_build_object('item_id', i_hin, 'vendor_id', v3, 'vendor_po_reference', 'ZZPO-C', 'expected_delivery_date', v_day + 3),
            jsonb_build_object('item_id', i_chn, 'vendor_id', v3, 'vendor_po_reference', 'ZZPO-C', 'expected_delivery_date', v_day + 3)), jsonb_build_object('order_date', v_day));
        v_log := public.zz_chk(v_log, 'delivery after the due date needs a reason', false);
  exception when others then v_log := public.zz_chk(v_log, 'delivery after the due date needs a reason', sqlerrm ilike '%after the department''s due date%'); end;
  begin
    v_po := public.proc_place_order_with_vendors(v_id, jsonb_build_array(
      jsonb_build_object('item_id', i_ply, 'vendor_id', v1, 'vendor_po_reference', 'ZZPO-A', 'quotation_reference', 'ZZQ-1', 'rate', '1500', 'expected_delivery_date', v_day + 9),
      jsonb_build_object('item_id', i_lam, 'vendor_id', v4, 'vendor_po_reference', 'ZZPO-B', 'rate', '900', 'expected_delivery_date', v_day + 3),
      jsonb_build_object('item_id', i_hin, 'vendor_id', v3, 'vendor_po_reference', 'ZZPO-C', 'rate', '45', 'expected_delivery_date', v_day + 2),
      jsonb_build_object('item_id', i_chn, 'vendor_id', v3, 'vendor_po_reference', 'ZZPO-C', 'rate', '320', 'expected_delivery_date', v_day + 2)),
      jsonb_build_object('order_date', v_day, 'remarks', 'ZZ split order', 'late_reason', 'ZZ plywood mill restocks on Monday; site agreed'));
  exception when others then v_log := public.zz_chk(v_log, 'place: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'placed with three vendors: one main PO (the vendor with most lines), every line allocated with its own reference',
    (select proc_status from purchase_requests where id = v_id) = 'ORDER_PLACED' and v_po.vendor_id = v3 and v_po.po_number = 'ZZPO-C'
    and (select count(*) from purchase_vendor_allocations where purchase_request_id = v_id) = 4
    and (select vendor_po_reference from purchase_vendor_allocations where item_id = i_ply) = 'ZZPO-A'
    and (select vendor_id from purchase_vendor_allocations where item_id = i_lam) = v4);
  v_log := public.zz_chk(v_log, 'amounts = rate x quantity; the order total is their sum; expected delivery is the latest',
    (select amount from purchase_vendor_allocations where item_id = i_ply) = 15000 and (select amount from purchase_vendor_allocations where item_id = i_hin) = 1800
    and v_po.total_order_value = 15000 + 5400 + 1800 + 3200 and v_po.expected_delivery_date = v_day + 9);
  v_log := public.zz_chk(v_log, 'history keeps the vendor split and the agreed late delivery',
    (select count(*) from purchase_request_status_history where purchase_request_id = v_id and remarks like 'Vendors: ZZ Hettich Hardware (2 lines, ZZPO-C)%Delivery after the due date agreed: ZZ plywood mill%') = 1);
  v_log := public.zz_chk(v_log, 'the requester and the department Head are notified',
    (select count(distinct recipient_id) from notifications where entity_id = v_id and title_en like 'Order placed%' and recipient_id in (u_e, u_h)) = 2);
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.proc_place_order_with_vendors(v_id, jsonb_build_array(jsonb_build_object('item_id', i_ply, 'vendor_id', v1, 'vendor_po_reference', 'ZZPO-Z', 'expected_delivery_date', v_day + 3)), '{}');
        v_log := public.zz_chk(v_log, 'the order cannot be placed twice', false);
  exception when others then v_log := public.zz_chk(v_log, 'the order cannot be placed twice', sqlerrm ilike '%already been confirmed%'); end;
  reset role;
  perform public.zz_as(u_e); set local role authenticated;
  select count(*) into n from purchase_vendor_allocations where purchase_request_id = v_id;
  v_log := public.zz_chk(v_log, 'the requester can see which vendor supplies each line of their order', n = 4);
  reset role;

  ---------------------------------------------------------------- performance, then a future plywood order
  perform public.zz_as(u_p1); set local role authenticated;
  perform public.proc_mark_delivered(v_id, v_day, 'ZZ delivered');
  v_log := public.zz_chk(v_log, 'performance from real records: one order each, delivered on time',
    (select total_orders = 1 and delivered = 1 and on_time = 1 and on_time_pct = 100 and total_value = 15000 from public.proc_vendor_performance(array[v1]))
    and (select total_orders = 1 and total_value = 5000 from public.proc_vendor_performance(array[v3])));
  reset role;
  perform public.zz_as(u_e); set local role authenticated;
  v_id2 := (public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'client_name', 'ZZ Patel', 'required_completion_date', v_day + 8,
    'delivery_location', 'ZZ Patel site'), '[{"item_code":"PLY-18","description":"18mm BWR Plywood Century","qty_size":"20 sheets","quantity":"20"}]')).id;
  reset role;
  perform public.zz_as(u_p1); set local role authenticated;
  v_log := public.zz_chk(v_log, 'the next plywood order shows the previous rate and history for that vendor',
    (select last_rate = 1500 and 'Supplied this item before (' || to_char(v_day, 'DD-MM-YYYY') || ')' = any(reasons) and reasons::text like '%100% on time%'
       from public.proc_recommend_vendors(v_id2) where vendor_id = v1));
  reset role;

  raise exception E'\n%', v_log;
end $t$;
