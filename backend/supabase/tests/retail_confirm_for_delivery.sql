-- Regression test for v2_93u ("Approved Quotation -> Confirm for Delivery -> Dispatch Request -> Godown -> Pick/Pack
-- -> Dispatch -> Deliver -> Sold" gap-closing pass). Runs against real data as impersonated users, always rolls
-- back. Covers: retail_convert_quotation_to_order now uses the quotation's OWN address snapshot (not the generic
-- customer.area); retail_confirm_order_for_delivery is the single guarded action that creates the Delivery Challan
-- (never before the order is confirmed, never without a delivery contact/mobile/date, never while payment is
-- pending and unconfirmed) and is idempotent on retry; retail_godown_accept now notifies the salesperson;
-- retail_record_dispatch now persists driver name/phone; retail_record_delivery_proof has exactly ONE live
-- overload (the v2_93j/v2_93r3 duplicate-overload bug is gone) and accepts optional, non-blocking GPS.
do $t$
declare
  v_log text := ''; v_sales uuid; v_head uuid; v_godown_head uuid; v_other uuid; v_emp_role uuid; v_head_role uuid;
  v_retail_dept uuid; v_godown_dept uuid; v_godown_loc uuid; n int; v_errmsg text;
  v_placeholder public.retail_products; v_product public.retail_products; v_serial text;
  v_lead record; v_quote public.retail_quotations; v_order public.retail_orders; v_qi public.retail_quotation_items;
  v_dc public.retail_delivery_challans; v_dc2 public.retail_delivery_challans; v_handover public.retail_godown_handovers;
  v_delivery public.retail_deliveries; v_dispatch record; v_notif_count int; v_addr text; v_status text;
  v_packing public.retail_packing_records;
begin
  create function public.zz_chk_cfd(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select id into v_emp_role from roles where code = 'employee';
  select id into v_head_role from roles where code = 'dept_head';
  v_retail_dept := public.retail_dept_id();
  v_godown_dept := public.retail_godown_dept_id();
  select id into v_godown_loc from locations where type = 'godown' and is_active limit 1;
  select up.id into v_sales from user_profiles up join roles r on r.id = up.role_id where up.department_id = v_retail_dept and r.code = 'employee' and up.is_active limit 1;
  select up.id into v_other from user_profiles up join roles r on r.id = up.role_id where up.department_id <> v_retail_dept and up.department_id <> v_godown_dept and r.code = 'employee' and up.is_active and up.department_id is not null limit 1;

  insert into auth.users (id) values (gen_random_uuid()) returning id into v_head;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password)
    values (v_head, 'ZTEST-CFD-RHEAD', 'ZTest CFD Retail Head', v_head_role, v_retail_dept, true, false);
  insert into auth.users (id) values (gen_random_uuid()) returning id into v_godown_head;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password)
    values (v_godown_head, 'ZTEST-CFD-GHEAD', 'ZTest CFD Godown Head', v_head_role, v_godown_dept, true, false);

  v_log := public.zz_chk_cfd(v_log, 'fixture: sales, Retail Head, Godown Head, unrelated employee, godown location resolved',
    v_sales is not null and v_head is not null and v_godown_head is not null and v_other is not null and v_godown_loc is not null);

  -- ===== 1. Register one serialized item, sell it into a quotation with its OWN address snapshot =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  v_placeholder := retail_start_stock_intake(v_godown_loc);
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown_head::text || '/zcfd-chair.jpg', jsonb_build_object('size', 400, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_product', v_placeholder.id, 'image', v_godown_head::text || '/zcfd-chair.jpg', 'zcfd-chair.jpg', 'image/jpeg', 400, null, 'proof');
  v_product := retail_confirm_stock_intake(v_placeholder.id, 'Chair', 'ZCFD Test Chair', 'Nos', 1, 'GOOD', 'Rack Z1', null, true, false, 'CHAIR');
  reset role;
  select serial_number into v_serial from retail_inventory_items where product_id = v_product.id limit 1;

  perform set_config('request.jwt.claims', json_build_object('sub', v_head, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_update_product_pricing(v_product.id, 20000, 15000, 12000, 'initial pricing');
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_lead from retail_create_walkin('ZCFD Customer', '9887766001', null, null, null, null, null, null, null, null, null, 'walkin', v_sales, 'RETAIL', null, 'WARM', null);
  v_quote := retail_create_quotation(v_lead.lead_id, 'ZCFD Customer', '9887766001', null, current_date + 10, current_date + 20, 0, 0, null, false, '[]'::jsonb, null);
  update retail_quotations set billing_address = '221B Snapshot Billing Road', delivery_address = '742 Snapshot Delivery Lane' where id = v_quote.id;
  perform retail_add_quotation_item_from_scan(v_quote.id, v_serial, 1, 0);
  update retail_quotations set status = 'ACCEPTED' where id = v_quote.id;
  v_order := retail_convert_quotation_to_order(v_quote.id);
  reset role;

  select delivery_address into v_addr from retail_orders where id = v_order.id;
  v_log := public.zz_chk_cfd(v_log, 'the new order''s delivery_address comes from the QUOTATION''S OWN snapshot, not customer.area', v_addr = '742 Snapshot Delivery Lane');
  select billing_address into v_addr from retail_orders where id = v_order.id;
  v_log := public.zz_chk_cfd(v_log, 'the new order''s billing_address comes from the QUOTATION''S OWN snapshot, not customer.area', v_addr = '221B Snapshot Billing Road');

  -- ===== 2. retail_confirm_order_for_delivery cannot run before retail_confirm_order (fulfilment_locked) =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin perform retail_confirm_order_for_delivery(v_order.id, 'Ramesh Site Contact', '9998887770'); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_cfd(v_log, 'Confirm-for-Delivery is refused before the order itself is confirmed (fulfilment_locked)', v_errmsg is not null);

  perform retail_confirm_order(v_order.id, (select jsonb_agg(jsonb_build_object('order_item_id', id, 'mode', 'STOCK', 'quantity', 1, 'stock_location_id', v_godown_loc)) from retail_order_items where order_id = v_order.id));

  -- ===== 3. Confirm-for-Delivery's own required-field gates =====
  v_errmsg := null;
  begin perform retail_confirm_order_for_delivery(v_order.id, '', '9998887770', false, null, current_date + 15); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_cfd(v_log, 'a blank delivery contact name is refused', v_errmsg is not null);

  v_errmsg := null;
  begin perform retail_confirm_order_for_delivery(v_order.id, 'Ramesh', '', false, null, current_date + 15); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_cfd(v_log, 'a blank delivery contact mobile is refused', v_errmsg is not null);

  -- payment is PENDING (nothing recorded yet) and total_amount > 0 -> must be confirmed explicitly
  v_errmsg := null;
  begin perform retail_confirm_order_for_delivery(v_order.id, 'Ramesh Site Contact', '9998887770', false, 'Handle with care', current_date + 15, false); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_cfd(v_log, 'sending for delivery is refused while payment is PENDING and not explicitly confirmed', v_errmsg is not null);

  -- ===== 4. The real, guarded action: confirm for delivery succeeds once every field is provided =====
  v_dc := retail_confirm_order_for_delivery(v_order.id, 'Ramesh Site Contact', '9998887770', true, 'Handle with care — glass top', current_date + 15, true);
  reset role;
  v_log := public.zz_chk_cfd(v_log, 'Confirm Order & Send for Delivery succeeds and returns a real Delivery Challan', v_dc.id is not null and v_dc.dc_number is not null);

  select installation_required, special_instructions into v_order.installation_required, v_order.special_instructions from retail_orders where id = v_order.id;
  v_log := public.zz_chk_cfd(v_log, 'installation_required and special_instructions are written onto the SAME order (no second copy)',
    v_order.installation_required = true and v_order.special_instructions = 'Handle with care — glass top');

  select * into v_delivery from retail_deliveries where order_id = v_order.id;
  v_log := public.zz_chk_cfd(v_log, 'the delivery contact person/mobile — columns that existed since v2_93j with no writer — are now populated',
    v_delivery.contact_person = 'Ramesh Site Contact' and v_delivery.contact_phone = '9998887770');

  select count(*) into n from retail_godown_handovers where order_id = v_order.id and status = 'PENDING';
  v_log := public.zz_chk_cfd(v_log, 'exactly one Godown handover request was created by the SAME already-idempotent retail_send_to_godown', n = 1);

  -- ===== 5. Idempotent on retry: clicking Confirm-for-Delivery again returns the SAME Delivery Challan =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_dc2 := retail_confirm_order_for_delivery(v_order.id, 'Ramesh Site Contact', '9998887770', true, 'Handle with care — glass top', current_date + 15, true);
  reset role;
  v_log := public.zz_chk_cfd(v_log, 'a repeated Confirm-for-Delivery click returns the SAME Delivery Challan, never a duplicate', v_dc2.id = v_dc.id);
  select count(*) into n from retail_godown_handovers where order_id = v_order.id;
  v_log := public.zz_chk_cfd(v_log, 'still exactly one Godown handover after the retry', n = 1);

  -- ===== 6. retail_godown_accept now notifies the salesperson =====
  select * into v_handover from retail_godown_handovers where order_id = v_order.id and status = 'PENDING';
  select count(*) into v_notif_count from notifications where recipient_id = v_sales;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown_head::text || '/zcfd-recv.jpg', jsonb_build_object('size', 300, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_godown_handover', v_handover.id, 'image', v_godown_head::text || '/zcfd-recv.jpg', 'zcfd-recv.jpg', 'image/jpeg', 300, null, 'proof');
  perform retail_godown_accept(v_handover.id, 1, true, true, 'Rack Z1', null);
  reset role;
  v_log := public.zz_chk_cfd(v_log, 'the salesperson gets a NEW notification the instant Godown accepts the handover',
    (select count(*) from notifications where recipient_id = v_sales) > v_notif_count);

  -- ===== 7. Scan-pick, pack, dispatch with driver name/phone persisted =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_godown_scan_pick(v_handover.id, v_serial);
  reset role;

  select * into v_packing from retail_packing_records where order_id = v_order.id;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_sales::text || '/zcfd-pack.jpg', jsonb_build_object('size', 300, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_packing', v_packing.id, 'image', v_sales::text || '/zcfd-pack.jpg', 'zcfd-pack.jpg', 'image/jpeg', 300, null, 'proof');
  perform retail_verify_packing(v_packing.id, '[]'::jsonb, 'PASSED', 1, null, null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  v_dispatch := retail_start_dispatch(v_order.id);
  perform retail_pre_dispatch_checklist(v_order.id, jsonb_build_object('correct_order', true, 'correct_customer_address', true, 'quantity_checked', true,
    'packing_checked', true, 'condition_checked', true, 'documents_checked', true, 'payment_clearance_checked', true, 'site_confirmed', true, 'vehicle_assigned', true), null);
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown_head::text || '/zcfd-dispatch.jpg', jsonb_build_object('size', 300, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_dispatch', v_dispatch.id, 'image', v_godown_head::text || '/zcfd-dispatch.jpg', 'zcfd-dispatch.jpg', 'image/jpeg', 300, null, 'proof');
  perform retail_record_dispatch(v_dispatch.id, 'GJ-01-AB-1234', 'Self', 1, 'DC-REF-1', null, null, 'Suresh Driver', '9123456780');
  reset role;

  select * into v_delivery from retail_deliveries where order_id = v_order.id;
  v_log := public.zz_chk_cfd(v_log, 'driver name/phone — columns that existed since v2_93j with no writer — are now populated by retail_record_dispatch',
    v_delivery.driver_name = 'Suresh Driver' and v_delivery.driver_phone = '9123456780');

  -- ===== 8. retail_record_delivery_proof: one live overload, GPS is optional and non-blocking, serial is Sold =====
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = 'retail_record_delivery_proof';
  v_log := public.zz_chk_cfd(v_log, 'retail_record_delivery_proof now has exactly ONE live overload (the v2_93j/v2_93r3 duplicate is gone)', n = 1);

  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin perform retail_record_delivery_proof(v_order.id, 'Site Rep', 'PHOTO_CONFIRM'); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_cfd(v_log, 'delivery proof is still refused without a site photo (unchanged gate)', v_errmsg is not null);
  reset role;

  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown_head::text || '/zcfd-delivery.jpg', jsonb_build_object('size', 300, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_delivery', v_delivery.id, 'image', v_godown_head::text || '/zcfd-delivery.jpg', 'zcfd-delivery.jpg', 'image/jpeg', 300, null, 'proof');
  v_notif_count := (select count(*) from notifications where recipient_id = v_sales);
  -- No GPS provided at all — must never block a legitimate delivery (spec section 13).
  perform retail_record_delivery_proof(v_order.id, 'Site Rep', 'PHOTO_CONFIRM', null, '[]'::jsonb, null, array[v_serial], null, null, null);
  reset role;

  select status into v_status from retail_inventory_items where serial_number = v_serial;
  v_log := public.zz_chk_cfd(v_log, 'the delivered serial is SOLD even though no GPS was supplied — GPS never blocks delivery', v_status = 'SOLD');
  v_log := public.zz_chk_cfd(v_log, 'the salesperson is notified of the final delivery outcome',
    (select count(*) from notifications where recipient_id = v_sales) > v_notif_count);

  select count(*) into n from retail_delivery_proofs where delivery_id = v_delivery.id and delivery_latitude is null and location_unverifiable_reason is null;
  v_log := public.zz_chk_cfd(v_log, 'the proof row itself stores null GPS fields cleanly when none was captured (additive columns, no crash)', n >= 1);

  raise exception E'CONFIRM-FOR-DELIVERY-REGRESSION (rolled back)\n%', v_log;
end $t$;
