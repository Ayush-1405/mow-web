-- Regression test for v2_93r (full product lifecycle: photo -> type -> model code -> serial -> QR -> quotation ->
-- DC -> Godown pick/pack/dispatch -> delivery -> Sold). Runs against real data as impersonated users, always rolls
-- back. Covers: pricing versioning with old quotations unaffected; QR-scan-based quotation entry with duplicate and
-- sold/unavailable guards and the discount-floor gate; quotation confirm reserves the exact serial; DC auto-reaches
-- Godown and is idempotent; wrong-serial scan is refused with a clear error; correct-serial pick then requires ALL
-- linked serials picked before packing verifies; dispatch marks serials In Transit; delivery proof marks the
-- delivered serial Sold exactly once (double-sell refused); partial delivery leaves the other serial untouched;
-- damage reporting holds the order and notifies; unauthorized users are blocked throughout.
do $t$
declare
  v_log text := ''; v_sales uuid; v_head uuid; v_godown_head uuid; v_worker uuid; v_other uuid; v_emp_role uuid; v_head_role uuid;
  v_retail_dept uuid; v_godown_dept uuid; v_godown_loc uuid; n int; v_errmsg text;
  v_placeholder public.retail_products; v_product public.retail_products; v_serials text[];
  v_lead record; v_quote public.retail_quotations; v_order public.retail_orders; v_qi public.retail_quotation_items;
  v_dc public.retail_delivery_challans; v_handover public.retail_godown_handovers; v_packing public.retail_packing_records;
  v_dispatch record; v_item record; v_scan jsonb; v_old_price numeric; v_new_price numeric; v_delivery_id uuid;
  v_status text; v_on_hold boolean; v_item_id uuid;
begin
  create function public.zz_chk_lc(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
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
    values (v_head, 'ZTEST-LC-RHEAD', 'ZTest Lifecycle Retail Head', v_head_role, v_retail_dept, true, false);
  insert into auth.users (id) values (gen_random_uuid()) returning id into v_godown_head;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password)
    values (v_godown_head, 'ZTEST-LC-GHEAD', 'ZTest Lifecycle Godown Head', v_head_role, v_godown_dept, true, false);
  insert into auth.users (id) values (gen_random_uuid()) returning id into v_worker;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password)
    values (v_worker, 'ZTEST-LC-WORKER', 'ZTest Lifecycle Godown Worker', v_emp_role, v_godown_dept, true, false);

  v_log := public.zz_chk_lc(v_log, 'fixture: sales, Retail Head, Godown Head+Worker, unrelated employee, godown location resolved',
    v_sales is not null and v_head is not null and v_godown_head is not null and v_worker is not null and v_other is not null and v_godown_loc is not null);

  -- ===== 1. Photo -> Type -> Model Code -> 2 unique Serials =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_worker, 'role', 'authenticated')::text, true); set local role authenticated;
  v_placeholder := retail_start_stock_intake(v_godown_loc);
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_worker::text || '/zlc-chair.jpg', jsonb_build_object('size', 400, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_worker, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_product', v_placeholder.id, 'image', v_worker::text || '/zlc-chair.jpg', 'zlc-chair.jpg', 'image/jpeg', 400, null, 'proof');
  v_product := retail_confirm_stock_intake(v_placeholder.id, 'Chair', 'ZLC Test Chair', 'Nos', 2, 'GOOD', 'Rack L1', null, true, false, 'CHAIR');
  reset role;
  select array_agg(serial_number order by serial_number) into v_serials from retail_inventory_items where product_id = v_product.id;
  v_log := public.zz_chk_lc(v_log, 'photo->type->model code->2 unique serials all created', v_product.sku ~ '^CHR-\d{6}$' and array_length(v_serials, 1) = 2);

  -- ===== 2. Pricing versioning: Head sets price, edits it, old quotation keeps its own snapshot =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_worker, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin perform retail_update_product_pricing(v_product.id, 20000, 15000, 12000, 'initial pricing'); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_lc(v_log, 'a plain Godown worker cannot set pricing', v_errmsg is not null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_head, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_update_product_pricing(v_product.id, 20000, 15000, 12000, 'initial pricing');
  reset role;

  -- ===== 3. QR-based quotation entry: scan adds the serial with a full snapshot, duplicate scan refused =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_lead from retail_create_walkin('ZLC Customer', '9887766551', null, null, null, null, null, null, null, null, null, 'walkin', v_sales, 'RETAIL', null, 'WARM', null);
  v_quote := retail_create_quotation(v_lead.lead_id, 'ZLC Customer', '9887766551', null, current_date + 10, current_date + 20, 0, 0, null, false, '[]'::jsonb, null);

  v_qi := retail_add_quotation_item_from_scan(v_quote.id, v_serials[1], 1, 1000);
  v_log := public.zz_chk_lc(v_log, 'scanning a serial adds it with the current approved price snapshot minus discount', v_qi.unit_price = 14000 and v_qi.inventory_item_id is not null);

  v_errmsg := null;
  begin perform retail_add_quotation_item_from_scan(v_quote.id, v_serials[1], 1, 0); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_lc(v_log, 'scanning the SAME serial twice into one quotation is refused', v_errmsg is not null);

  v_errmsg := null;
  begin perform retail_add_quotation_item_from_scan(v_quote.id, v_serials[2], 1, 8000); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_lc(v_log, 'a discount below the approved minimum price is refused', v_errmsg is not null);

  perform retail_add_quotation_item_from_scan(v_quote.id, v_serials[2], 1, 0);
  reset role;

  -- Retail Head now changes the price -- the ALREADY-ADDED quotation item must keep its own snapshot unchanged.
  select unit_price into v_old_price from retail_quotation_items where id = v_qi.id;
  perform set_config('request.jwt.claims', json_build_object('sub', v_head, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_update_product_pricing(v_product.id, 22000, 17000, 13000, 'price increase after supplier update');
  reset role;
  select unit_price into v_new_price from retail_quotation_items where id = v_qi.id;
  v_log := public.zz_chk_lc(v_log, 'editing the Product Master price does NOT change the already-created quotation line', v_new_price = v_old_price);

  -- ===== 5. Confirm quotation -> order: reserves the exact scanned serials =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  update retail_quotations set status = 'ACCEPTED' where id = v_quote.id;
  v_order := retail_convert_quotation_to_order(v_quote.id);
  reset role;
  select count(*) into n from retail_inventory_items where product_id = v_product.id and status = 'RESERVED' and reserved_order_id = v_order.id;
  v_log := public.zz_chk_lc(v_log, 'converting the quotation reserves both scanned serials to this order', n = 2);

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_confirm_order(v_order.id, (select jsonb_agg(jsonb_build_object('order_item_id', id, 'mode', 'STOCK', 'quantity', 1, 'stock_location_id', v_godown_loc)) from retail_order_items where order_id = v_order.id));
  reset role;

  -- ===== 6. Delivery Challan: auto-reaches Godown, idempotent on retry =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin perform retail_create_delivery_challan(v_order.id, null, null, null, null); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_lc(v_log, 'an unrelated employee cannot create a Delivery Challan for this order', v_errmsg is not null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_dc := retail_create_delivery_challan(v_order.id, 'Truck 1', current_date + 1, 'Careful — glass top', 'Handle with care');
  v_log := public.zz_chk_lc(v_log, 'creating a DC generates a real DC number', v_dc.dc_number ~ '^DC-\d{8}-\d{3}$');
  select count(*) into n from retail_delivery_challan_items where dc_id = v_dc.id;
  v_log := public.zz_chk_lc(v_log, 'the DC carries both product serials as line items', n = 2);

  select * into v_handover from retail_godown_handovers where delivery_challan_id = v_dc.id;
  v_log := public.zz_chk_lc(v_log, 'the DC automatically reached Godown as one linked handover, no manual hand-off', v_handover.id is not null and v_handover.status = 'PENDING');

  perform retail_create_delivery_challan(v_order.id, null, null, null, null);
  select count(*) into n from retail_delivery_challans where order_id = v_order.id;
  v_log := public.zz_chk_lc(v_log, 'retrying DC creation is idempotent — still exactly one DC', n = 1);
  select count(*) into n from retail_godown_handovers where order_id = v_order.id;
  v_log := public.zz_chk_lc(v_log, 'retrying DC creation does not create a second Godown handover', n = 1);
  reset role;

  -- ===== 7. Godown accept, then scan-verified picking: wrong serial refused, correct serial picked =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown_head::text || '/zlc-receive.jpg', jsonb_build_object('size', 300, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_godown_handover', v_handover.id, 'image', v_godown_head::text || '/zlc-receive.jpg', 'zlc-receive.jpg', 'image/jpeg', 300, null, 'proof');
  v_handover := retail_godown_accept(v_handover.id, 2, true, true, 'Rack L1', null);
  v_log := public.zz_chk_lc(v_log, 'Godown accepts the handover', v_handover.status = 'ACCEPTED');

  v_errmsg := null;
  begin perform retail_godown_scan_pick(v_handover.id, 'CHR-999999-999'); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_lc(v_log, 'scanning an unknown code is refused', v_errmsg is not null);

  -- fabricate a DIFFERENT product's serial to prove a real "wrong item for THIS delivery" is caught, not just "unknown"
  declare v_other_placeholder public.retail_products; v_other_product public.retail_products; v_other_serial text;
  begin
    v_other_placeholder := retail_start_stock_intake(v_godown_loc);
    reset role;
    insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown_head::text || '/zlc-other.jpg', jsonb_build_object('size', 300, 'mimetype', 'image/jpeg'));
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
    perform staff_record_attachment('retail_product', v_other_placeholder.id, 'image', v_godown_head::text || '/zlc-other.jpg', 'zlc-other.jpg', 'image/jpeg', 300, null, 'proof');
    v_other_product := retail_confirm_stock_intake(v_other_placeholder.id, 'Sofa', 'ZLC Unrelated Sofa', 'Nos', 1, 'GOOD', 'Rack L9', null, true, false, 'SOFA');
    select serial_number into v_other_serial from retail_inventory_items where product_id = v_other_product.id;
    v_errmsg := null;
    begin perform retail_godown_scan_pick(v_handover.id, v_other_serial); exception when others then v_errmsg := sqlerrm; end;
    v_log := public.zz_chk_lc(v_log, 'scanning a real but WRONG (unrelated) serial for this delivery is refused with a clear error',
      v_errmsg is not null and v_errmsg ilike '%WRONG ITEM%');
  end;

  perform retail_godown_scan_pick(v_handover.id, v_serials[1]);
  select status into v_status from retail_inventory_items where serial_number = v_serials[1];
  v_log := public.zz_chk_lc(v_log, 'the correct serial is picked', v_status = 'PICKED');
  reset role;

  -- ===== 8. Packing requires ALL linked serials picked; wraps + photo required =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  update retail_fulfilment_items set status = 'READY' where order_id = v_order.id;
  v_packing := retail_start_packing(v_order.id);
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_sales::text || '/zlc-pack.jpg', jsonb_build_object('size', 300, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_packing', v_packing.id, 'image', v_sales::text || '/zlc-pack.jpg', 'zlc-pack.jpg', 'image/jpeg', 300, null, 'proof');

  v_errmsg := null;
  begin perform retail_verify_packing(v_packing.id, '[]'::jsonb, 'PASSED', 1, null, null); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_lc(v_log, 'packing refuses to verify while one serial is still unpicked', v_errmsg is not null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_godown_scan_pick(v_handover.id, v_serials[2]);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_packing := retail_verify_packing(v_packing.id, '[]'::jsonb, 'PASSED', 1, null, null);
  v_log := public.zz_chk_lc(v_log, 'packing verifies once every linked serial is picked', v_packing.status = 'READY_FOR_GODOWN');
  reset role;
  select count(*) into n from retail_inventory_items where product_id = v_product.id and status = 'PACKED';
  v_log := public.zz_chk_lc(v_log, 'both serials moved PICKED -> PACKED on packing verify', n = 2);

  -- ===== 9. Dispatch -> In Transit for both serials =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  update retail_deliveries set checklist = jsonb_build_object('correct_order', true, 'correct_customer_address', true, 'quantity_checked', true,
    'packing_checked', true, 'condition_checked', true, 'documents_checked', true, 'payment_clearance_checked', true, 'site_confirmed', true, 'vehicle_assigned', true)
    where order_id = v_order.id;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  v_dispatch := retail_start_dispatch(v_order.id);
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown_head::text || '/zlc-dispatch.jpg', jsonb_build_object('size', 300, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_dispatch', v_dispatch.id, 'image', v_godown_head::text || '/zlc-dispatch.jpg', 'zlc-dispatch.jpg', 'image/jpeg', 300, null, 'proof');
  perform retail_record_dispatch(v_dispatch.id, 'GJ-01-AB-1234', 'Local Transporter', 2, v_dc.dc_number, null, null);
  reset role;
  select count(*) into n from retail_inventory_items where product_id = v_product.id and status = 'DISPATCHED';
  v_log := public.zz_chk_lc(v_log, 'both serials moved PACKED -> DISPATCHED on dispatch', n = 2);

  -- ===== 10. Partial delivery: only the named serial becomes Sold, the other stays Dispatched =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown_head::text || '/zlc-deliver.jpg', jsonb_build_object('size', 300, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  select id into v_delivery_id from retail_deliveries where order_id = v_order.id;
  perform staff_record_attachment('retail_delivery', v_delivery_id, 'image', v_godown_head::text || '/zlc-deliver.jpg', 'zlc-deliver.jpg', 'image/jpeg', 300, null, 'proof');
  perform retail_record_delivery_proof(v_order.id, 'Site Rep', 'PHOTO_CONFIRM', null, '[]'::jsonb, null, array[v_serials[1]]);
  reset role;

  select status into v_status from retail_inventory_items where serial_number = v_serials[1];
  v_log := public.zz_chk_lc(v_log, 'the named delivered serial is now SOLD', v_status = 'SOLD');
  select status into v_status from retail_inventory_items where serial_number = v_serials[2];
  v_log := public.zz_chk_lc(v_log, 'the OTHER serial (not delivered yet) stays DISPATCHED — partial delivery', v_status = 'DISPATCHED');
  select count(*) into n from retail_inventory_items where serial_number = v_serials[1] and sold_order_id = v_order.id and sold_at is not null;
  v_log := public.zz_chk_lc(v_log, 'the Sold serial is linked to the order and has a sold_at timestamp', n = 1);

  -- double-sell guard: the same serial cannot be delivered/sold again
  v_errmsg := null;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_record_delivery_proof(v_order.id, 'Site Rep', 'PHOTO_CONFIRM', null, '[]'::jsonb, null, array[v_serials[1]]);
  reset role;
  select status into v_status from retail_inventory_items where serial_number = v_serials[1];
  v_log := public.zz_chk_lc(v_log, 'retrying delivery proof on an already-SOLD serial is a safe no-op (never double-sold)', v_status = 'SOLD');

  -- ===== 11. Damage reporting holds the order and preserves history (on the still-dispatched second serial) =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  select id into v_item_id from retail_inventory_items where serial_number = v_serials[2];
  v_errmsg := null;
  begin perform retail_report_item_damage(v_item_id, 'Cracked leg found on second inspection'); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_lc(v_log, 'damage report is refused without a photo', v_errmsg is not null);

  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown_head::text || '/zlc-damage.jpg', jsonb_build_object('size', 300, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_inventory_item', v_item_id, 'image', v_godown_head::text || '/zlc-damage.jpg', 'zlc-damage.jpg', 'image/jpeg', 300, null, 'proof');
  perform retail_report_item_damage(v_item_id, 'Cracked leg found on second inspection');
  reset role;

  select status into v_status from retail_inventory_items where serial_number = v_serials[2];
  v_log := public.zz_chk_lc(v_log, 'the reported serial is now DAMAGED', v_status = 'DAMAGED');
  select on_hold into v_on_hold from retail_orders where id = v_order.id;
  v_log := public.zz_chk_lc(v_log, 'the linked order is put on hold after a damage report', v_on_hold = true);
  select count(*) into n from retail_status_history where entity_type = 'retail_inventory_item' and entity_id = v_item_id;
  v_log := public.zz_chk_lc(v_log, 'the full lifecycle history for this serial is preserved (never deleted)', n >= 3); -- picked, packed, dispatched, damaged

  raise exception E'PRODUCT-LIFECYCLE-REGRESSION (rolled back)\n%', v_log;
end $t$;
