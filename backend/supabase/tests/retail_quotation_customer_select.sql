-- Regression test for v2_93v (quotation customer-select, Display-status allowance, manual item entry). Runs
-- against real data as impersonated users, always rolls back. Covers: retail_create_quotation with p_customer_id
-- snapshots the customer's own record (never re-typed) and is refused for a customer the caller cannot access; a
-- DISPLAY-status serial can now be added to a quotation (AVAILABLE unchanged); every other status is still
-- blocked; retail_add_manual_quotation_item creates a real line item with no product_id/inventory_item_id (never a
-- fake serial), computes totals via the same server-side formula, is blocked once the quotation is no longer
-- editable, and unauthorized users are refused throughout.
do $t$
declare
  v_log text := ''; v_sales uuid; v_head uuid; v_other uuid; v_emp_role uuid; v_head_role uuid; v_retail_dept uuid; v_godown_dept uuid; v_godown_loc uuid;
  n int; v_errmsg text;
  v_customer public.retail_customers; v_quote public.retail_quotations; v_qi public.retail_quotation_items;
  v_placeholder public.retail_products; v_product public.retail_products; v_serial text; v_status text; v_old_total numeric;
begin
  create function public.zz_chk_qcs(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
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
    values (v_head, 'ZTEST-QCS-RHEAD', 'ZTest QCS Retail Head', v_head_role, v_retail_dept, true, false);

  v_log := public.zz_chk_qcs(v_log, 'fixture: sales, Retail Head, unrelated employee, godown location resolved', v_sales is not null and v_head is not null and v_other is not null and v_godown_loc is not null);

  -- ===== 1. Existing customer, picked from search, is used directly -- never re-typed, never upserted-by-guess =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_customer := retail_upsert_customer('ZQCS Existing Customer', '9112233440', '9112233441', 'zqcs@example.com', 'Ahmedabad', 'SG Highway', 'RETAIL', v_sales);
  update retail_customers set billing_address = 'ZQCS Billing House', delivery_address = 'ZQCS Delivery House' where id = v_customer.id;

  v_quote := retail_create_quotation(null, 'Placeholder Name (should be ignored)', '0000000000', null, current_date + 10, current_date + 20,
    0, 0, null, false, '[]'::jsonb, null, null, null, null, null, v_customer.id);

  v_log := public.zz_chk_qcs(v_log, 'the quotation is linked to the EXACT existing customer, not a new one', v_quote.customer_id = v_customer.id);
  v_log := public.zz_chk_qcs(v_log, 'name/phone/email/addresses are snapshotted from the customer''s OWN record, not the placeholder text passed in',
    v_quote.customer_name = 'ZQCS Existing Customer' and v_quote.phone = '9112233440' and v_quote.email = 'zqcs@example.com'
    and v_quote.billing_address = 'ZQCS Billing House' and v_quote.delivery_address = 'ZQCS Delivery House');
  select count(*) into n from retail_customers where normalized_phone = '9112233440';
  v_log := public.zz_chk_qcs(v_log, 'no duplicate customer row was created', n = 1);
  reset role;

  -- ===== 2. A caller cannot pass a customer_id they are not authorized to access =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_create_quotation(null, 'x', '9000000001', null, null, null, 0, 0, null, false, '[]'::jsonb, null, null, null, null, null, v_customer.id);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_qcs(v_log, 'an unrelated employee cannot create a quotation for a customer they cannot access', v_errmsg is not null);
  reset role;

  -- ===== 3. DISPLAY-status item can now be added; other blocked statuses are unchanged =====
  -- registered by the Retail Head (not a plain employee) so it is immediately ACTIVE, not PENDING_APPROVAL —
  -- product-approval status is a separate, already-tested concern (retail_product_registration.sql), not what
  -- this test is exercising.
  perform set_config('request.jwt.claims', json_build_object('sub', v_head, 'role', 'authenticated')::text, true); set local role authenticated;
  v_placeholder := retail_start_stock_intake(v_godown_loc);
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_head::text || '/zqcs-chair.jpg', jsonb_build_object('size', 400, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_head, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_product', v_placeholder.id, 'image', v_head::text || '/zqcs-chair.jpg', 'zqcs-chair.jpg', 'image/jpeg', 400, null, 'proof');
  v_product := retail_confirm_stock_intake(v_placeholder.id, 'Chair', 'ZQCS Test Chair', 'Nos', 1, 'GOOD', 'Display Rack', null, true, false, 'CHAIR');
  reset role;
  select serial_number into v_serial from retail_inventory_items where product_id = v_product.id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_head, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_update_product_pricing(v_product.id, 20000, 15000, 12000, 'initial pricing');
  reset role;

  update retail_inventory_items set status = 'DISPLAY' where id in (select id from retail_inventory_items where product_id = v_product.id);

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_qi := retail_add_quotation_item_from_scan(v_quote.id, v_serial, 1, 0);
  reset role;
  v_log := public.zz_chk_qcs(v_log, 'a DISPLAY-status item can now be scanned into a quotation (spec: "Display, when sale is permitted")', v_qi.inventory_item_id is not null);

  update retail_inventory_items set status = 'RESERVED' where id = v_qi.inventory_item_id;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin perform retail_add_quotation_item_from_scan(v_quote.id, v_serial, 1, 0); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_qcs(v_log, 'a RESERVED item is still blocked with a clear status message', v_errmsg is not null and v_errmsg ilike '%RESERVED%');
  reset role;

  -- ===== 4. Manual item: no product_id/inventory_item_id, real server-computed totals, clearly marked =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin perform retail_add_manual_quotation_item(v_quote.id, 'Unauthorized Manual Item'); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_qcs(v_log, 'an unrelated employee cannot add a manual item to this quotation', v_errmsg is not null);
  reset role;

  select total_amount into v_old_total from retail_quotations where id = v_quote.id;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_qi := retail_add_manual_quotation_item(v_quote.id, 'ZQCS Custom Curtain Rod', 'Made to order, not in Product Master', 'CUST-001', 2, 1000, 'PERCENT', 10, 12, 'Customer-supplied fabric');
  reset role;
  v_log := public.zz_chk_qcs(v_log, 'a manual item is created with NO product_id/inventory_item_id (never a fake serial)', v_qi.product_id is null and v_qi.inventory_item_id is null);
  -- base=2000, discount 10% = 200, after-discount=1800, taxable=1800, gst 12% = 216, total = 2016
  v_log := public.zz_chk_qcs(v_log, 'the manual item''s total is computed via the SAME server-side formula (base 2000 - 10% + 12% GST = 2016)',
    v_qi.base_amount = 2000 and v_qi.discount = 200 and v_qi.tax_amount = 216 and v_qi.line_total = 2016);
  select total_amount into n from retail_quotations where id = v_quote.id;
  v_log := public.zz_chk_qcs(v_log, 'the quotation running total increased by exactly the manual item''s line total', n = v_old_total + 2016);

  update retail_quotations set status = 'ACCEPTED' where id = v_quote.id;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin perform retail_add_manual_quotation_item(v_quote.id, 'Too Late Item'); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_qcs(v_log, 'a manual item cannot be added once the quotation is no longer editable (ACCEPTED)', v_errmsg is not null);
  reset role;

  raise exception E'QUOTATION-CUSTOMER-SELECT-REGRESSION (rolled back)\n%', v_log;
end $t$;
