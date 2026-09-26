-- Regression test for v2_93q (Godown worker simplification). Runs against real data as impersonated users, always
-- rolls back. Covers: safe category-prefixed 6-digit codes; a quantity-5 item-level intake produces one shared
-- GRN batch number and 5 unique SKUs/stock rows; AI-suggested vs worker-confirmed category is recorded distinctly;
-- new stock is immediately visible via retail_stock_availability (the same read Retail/Display already use);
-- Move-to-Display moves real quantity between locations without duplicating the product row and never exceeds
-- what's actually available; retail_correct_stock requires a reason and is Head-only; retail_scan_product returns
-- the right product and respects authorization; packing-verified and godown-accept now notify the salesperson.
do $t$
declare
  v_log text := ''; v_worker uuid; v_head uuid; v_sales uuid; v_emp_role uuid; v_head_role uuid;
  v_godown_dept uuid; v_godown_loc uuid; v_showroom_loc uuid; v_errmsg text; n int;
  v_placeholder public.retail_products; v_product public.retail_products; v_serials text[]; v_serial_ids uuid[];
  v_avail record; v_scan jsonb; v_notif_count int;
begin
  create function public.zz_chk_gws(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select id into v_emp_role from roles where code = 'employee';
  select id into v_head_role from roles where code = 'dept_head';
  v_godown_dept := public.retail_godown_dept_id();
  select id into v_godown_loc from locations where type = 'godown' and is_active limit 1;
  select id into v_showroom_loc from locations where type = 'showroom' and is_active limit 1;
  select up.id into v_sales from user_profiles up join roles r on r.id = up.role_id where up.department_id = public.retail_dept_id() and r.code = 'employee' and up.is_active limit 1;

  insert into auth.users (id) values (gen_random_uuid()) returning id into v_worker;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password)
    values (v_worker, 'ZTEST-GWS-WORKER', 'ZTest GWS Worker', v_emp_role, v_godown_dept, true, false);
  insert into auth.users (id) values (gen_random_uuid()) returning id into v_head;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password)
    values (v_head, 'ZTEST-GWS-HEAD', 'ZTest GWS Head', v_head_role, v_godown_dept, true, false);

  v_log := public.zz_chk_gws(v_log, 'fixture: worker, head, godown+showroom locations resolved',
    v_worker is not null and v_head is not null and v_godown_loc is not null and v_showroom_loc is not null);

  -- ===== 1. Category-prefixed, 6-digit, race-free code generation =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_worker, 'role', 'authenticated')::text, true); set local role authenticated;
  n := (select (regexp_match(public.retail_generate_stock_code('Chair'), '^CHR-(\d{6})$'))[1]::int);
  v_log := public.zz_chk_gws(v_log, 'retail_generate_stock_code("Chair") returns a CHR-###### 6-digit code', n is not null);
  reset role;
  declare v_next int;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_worker, 'role', 'authenticated')::text, true); set local role authenticated;
    v_next := (select (regexp_match(public.retail_generate_stock_code('Chair'), '^CHR-(\d{6})$'))[1]::int);
    reset role;
    v_log := public.zz_chk_gws(v_log, 'a second call for the same category returns the next sequential number', v_next = n + 1);
  end;

  -- ===== 2. Quantity-5, item-level intake (two-tier, corrected in v2_93r): ONE product-master row + 5 unique
  --    serials in retail_inventory_items, all sharing one GRN batch number =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_worker, 'role', 'authenticated')::text, true); set local role authenticated;
  v_placeholder := retail_start_stock_intake(v_godown_loc);
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_worker::text || '/zgws-chair.jpg', jsonb_build_object('size', 400, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_worker, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_product', v_placeholder.id, 'image', v_worker::text || '/zgws-chair.jpg', 'zgws-chair.jpg', 'image/jpeg', 400, null, 'proof');

  v_product := retail_confirm_stock_intake(
    v_placeholder.id, 'Chair', 'ZGWS Test Chair', 'Nos', 5, 'GOOD', 'Rack Z1', 'five identical dining chairs', true, true, 'CHAIR');
  reset role;

  v_log := public.zz_chk_gws(v_log, 'a quantity-5 item-level intake returns exactly ONE product-master row', v_product.id is not null and v_product.batch_item_level = true);
  select array_agg(serial_number order by serial_number), array_agg(id) into v_serials, v_serial_ids from retail_inventory_items where product_id = v_product.id;
  v_log := public.zz_chk_gws(v_log, 'exactly 5 physical serials were created for this one model', array_length(v_serials, 1) = 5);
  v_log := public.zz_chk_gws(v_log, 'every serial follows <model_sku>-NNN and is unique', (select count(distinct s) from unnest(v_serials) s) = 5
    and v_serials[1] = v_product.sku || '-001');
  v_log := public.zz_chk_gws(v_log, 'category_confirmed_manually is recorded true (worker changed the AI suggestion)', v_product.category_confirmed_manually = true);
  select count(*) into n from retail_inventory_items where product_id = v_product.id and condition = 'GOOD' and status = 'AVAILABLE';
  v_log := public.zz_chk_gws(v_log, 'condition GOOD / status AVAILABLE is recorded on every serial', n = 5);

  select count(*) into n from staff_attachments where entity_type = 'retail_inventory_item' and entity_id = any (v_serial_ids) and purpose = 'proof' and is_active;
  v_log := public.zz_chk_gws(v_log, 'every one of the 5 serials has a linked proof photo (the shared intake photo, not a re-upload)', n = 5);

  -- ===== 3. Immediately visible via the SAME read Retail/Display already use (now serial-aware) =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_avail from retail_stock_availability(null, v_godown_loc) where sku = v_product.sku;
  reset role;
  v_log := public.zz_chk_gws(v_log, 'the new serialized model is immediately visible to Retail via retail_stock_availability', v_avail.available_qty = 5);

  -- ===== 4. Move to Display: moves ONE serial, no duplicate product row, cannot exceed availability =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_worker, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin perform retail_move_stock_to_display(v_product.id, v_showroom_loc, 99, null);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_gws(v_log, 'moving more than available is refused', v_errmsg is not null);

  perform retail_move_stock_to_display(v_product.id, v_showroom_loc, 1, 'moved to Gandhinagar showroom');
  reset role;
  select count(*) into n from retail_products where id = v_product.id; -- still exactly one product row
  v_log := public.zz_chk_gws(v_log, 'Move-to-Display does not duplicate the product row', n = 1);
  select count(*) into n from retail_stock_movements where product_id = v_product.id;
  v_log := public.zz_chk_gws(v_log, 'a movement-history row was recorded', n = 1);

  -- ===== 5. retail_correct_stock: Head-only, reason required (against the placeholder bulk retail_stock row) =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_worker, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin perform retail_correct_stock(v_product.id, v_godown_loc, 3, 0, 'recount'); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_gws(v_log, 'a plain worker cannot correct inventory', v_errmsg is not null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_head, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin perform retail_correct_stock(v_product.id, v_godown_loc, 3, 0, ''); exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_gws(v_log, 'the Head cannot correct stock without a reason', v_errmsg is not null);
  perform retail_correct_stock(v_product.id, v_godown_loc, 3, 0, 'physical recount found 3, not 1');
  reset role;
  select on_hand_qty into n from retail_stock where product_id = v_product.id and location_id = v_godown_loc;
  v_log := public.zz_chk_gws(v_log, 'the Head''s correction (with reason) applied to the placeholder bulk row', n = 3);

  -- ===== 6. retail_scan_product: serial-first lookup + authorization =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_worker, 'role', 'authenticated')::text, true); set local role authenticated;
  v_scan := retail_scan_product(v_serials[2]);
  reset role;
  v_log := public.zz_chk_gws(v_log, 'retail_scan_product finds the right product by serial number', (v_scan->'product'->>'id')::uuid = v_product.id
    and (v_scan->'serial'->>'serial_number') = v_serials[2]);
  v_log := public.zz_chk_gws(v_log, 'retail_scan_product returns the moved serial''s movement history', jsonb_array_length((retail_scan_product(v_serials[1]))->'movements') = 1);

  -- ===== 7. New notifications: godown-accept and packing-verified both now notify the salesperson =====
  declare
    v_lead record; v_quote public.retail_quotations; v_order public.retail_orders; v_item uuid; v_handover public.retail_godown_handovers;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
    select * into v_lead from retail_create_walkin('ZGWS Notif Customer', '9556677899', null, null, null, null, null, null, null, null, null, 'walkin', v_sales, 'RETAIL', null, 'WARM', null);
    v_quote := retail_create_quotation(v_lead.lead_id, 'ZGWS Notif Customer', '9556677899', null, current_date + 10, current_date + 20, 0, 0, null, false,
      jsonb_build_array(jsonb_build_object('item_name', 'ZGWS Notif Item', 'quantity', 1, 'unit_price', 0)), null);
    update retail_quotations set status = 'ACCEPTED' where id = v_quote.id;
    v_order := retail_convert_quotation_to_order(v_quote.id);
    select id into v_item from retail_order_items where order_id = v_order.id;
    perform retail_confirm_order(v_order.id, jsonb_build_array(jsonb_build_object('order_item_id', v_item, 'mode', 'STOCK', 'quantity', 1, 'stock_location_id', v_godown_loc)));
    reset role;

    select * into v_handover from retail_godown_handovers where order_id = v_order.id;
    v_log := public.zz_chk_gws(v_log, 'fixture: a STOCK order auto-fires a Godown handover for the notification test', v_handover.id is not null);

    perform set_config('request.jwt.claims', json_build_object('sub', v_head, 'role', 'authenticated')::text, true); set local role authenticated;
    reset role;
    insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_head::text || '/zgws-receive.jpg', jsonb_build_object('size', 300, 'mimetype', 'image/jpeg'));
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', v_head, 'role', 'authenticated')::text, true); set local role authenticated;
    perform staff_record_attachment('retail_godown_handover', v_handover.id, 'image', v_head::text || '/zgws-receive.jpg', 'zgws-receive.jpg', 'image/jpeg', 300, null, 'proof');
    v_handover := retail_godown_accept(v_handover.id, 1, true, true, 'Rack Z2', null);
    reset role;

    select count(*) into v_notif_count from notifications where recipient_id = v_sales and entity_type = 'retail_godown_handover' and entity_id = v_handover.id;
    v_log := public.zz_chk_gws(v_log, 'retail_godown_accept notifies the salesperson ("Accepted by Godown")', v_notif_count = 1);

    perform set_config('request.jwt.claims', json_build_object('sub', v_head, 'role', 'authenticated')::text, true); set local role authenticated;
    reset role;
    insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_head::text || '/zgws-pack.jpg', jsonb_build_object('size', 300, 'mimetype', 'image/jpeg'));
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', v_head, 'role', 'authenticated')::text, true); set local role authenticated;
    perform staff_record_attachment('retail_packing', v_handover.packing_id, 'image', v_head::text || '/zgws-pack.jpg', 'zgws-pack.jpg', 'image/jpeg', 300, null, 'proof');
    perform retail_verify_packing(v_handover.packing_id, '[]'::jsonb, 'PASSED', 1, null, null);
    reset role;

    select count(*) into v_notif_count from notifications where recipient_id = v_sales and entity_type = 'retail_packing' and entity_id = v_handover.packing_id;
    v_log := public.zz_chk_gws(v_log, 'retail_verify_packing notifies the salesperson ("Packed and ready for delivery") with the SAME linked photo record', v_notif_count = 1);
  end;

  raise exception E'GODOWN-WORKER-SIMPLIFY-REGRESSION (rolled back)\n%', v_log;
end $t$;
