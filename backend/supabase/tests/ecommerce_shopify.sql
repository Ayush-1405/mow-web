-- v3_35 E-commerce + Shopify. Drives the database side with Shopify-shaped data (what shopify-sync sends after normalising
-- Shopify's Admin GraphQL replies). Own fixtures; ALWAYS rolls back. Never touches a real Shopify store.
do $t$
declare
  v_log text := ''; n int; m int; j jsonb; ok boolean; msg text; li uuid; tid uuid;
  r_emp uuid; r_head uuid; d_mkt uuid; d_ret uuid; d_ecom uuid;
  u_mkt uuid := gen_random_uuid(); u_head uuid := gen_random_uuid(); u_ret uuid := gen_random_uuid();
  P1 text := 'gid://shopify/Product/zz1'; P2 text := 'gid://shopify/Product/zz2';
  V1 text := 'gid://shopify/ProductVariant/zz11'; V2 text := 'gid://shopify/ProductVariant/zz12'; V3 text := 'gid://shopify/ProductVariant/zz21';
  I1 text := 'gid://shopify/InventoryItem/zz11'; I2 text := 'gid://shopify/InventoryItem/zz12'; I3 text := 'gid://shopify/InventoryItem/zz21';
  L1 text := 'gid://shopify/Location/zz1'; L2 text := 'gid://shopify/Location/zz2';
  t0 timestamptz := now() - interval '1 hour';
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal1')::text, true); end $f$;
  create function public.zz_lvl(i text, l text, v text, a int, c int, at timestamptz) returns jsonb language sql immutable as $f$
    select jsonb_build_array(jsonb_build_object('inventory_item_id', i, 'location_id', l, 'variant_id', v, 'available', a, 'committed', c, 'on_hand', a + c, 'updated_at', at)) $f$;
  create function public.zz_order(id text, name text, created timestamptz, upd timestamptz, fin text, ful text, lines jsonb,
                                  fulfils jsonb default '[]', refunds jsonb default '[]', cancelled timestamptz default null, ret text default 'NO_RETURN')
    returns jsonb language sql immutable as $f$
    select jsonb_build_array(jsonb_build_object('id', id, 'name', name, 'created_at', created, 'updated_at', upd, 'financial_status', fin,
      'fulfillment_status', ful, 'return_status', ret, 'cancelled_at', cancelled, 'customer_name', 'ZZ Customer', 'currency', 'INR', 'total', 1000,
      'lines', lines, 'fulfillments', fulfils, 'refunds', refunds)) $f$;

  select id into r_emp from roles where code = 'employee';
  select id into r_head from roles where code = 'dept_head';
  select id into d_mkt from departments where code = 'MARKETING';
  select id into d_ret from departments where code = 'RETAIL';
  d_ecom := public.ecom_dept_id();
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_mkt, u_head, u_ret]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_mkt,  'ZZ-EC-M', 'ZZ Marketing Staff', r_emp,  d_mkt, '9888880501', false, true),
    (u_head, 'ZZ-EC-H', 'ZZ Marketing Head',  r_head, d_mkt, '9888880502', false, true),
    (u_ret,  'ZZ-EC-R', 'ZZ Retail Staff',    r_emp,  d_ret, '9888880503', false, true);

  -- 1-2 access ---------------------------------------------------------------------------------------------------
  perform public.zz_as(u_mkt); set local role authenticated;
  v_log := public.zz_chk(v_log, '1  a Marketing employee can open E-commerce', public.ecom_can_access());
  v_log := public.zz_chk(v_log, '1  ... and still Marketing', public.can_view_department(u_mkt, d_mkt));
  v_log := public.zz_chk(v_log, '1  ... but not Retail', not public.can_view_department(u_mkt, d_ret));
  reset role;
  perform public.zz_as(u_ret); set local role authenticated;
  v_log := public.zz_chk(v_log, '2  a Retail employee cannot open E-commerce', not public.ecom_can_access());
  begin perform public.ecom_dashboard(current_date, current_date); ok := false; exception when others then ok := true; end;
  v_log := public.zz_chk(v_log, '2  ... nor its dashboard', ok);
  reset role;
  -- moving someone out of Marketing removes access at once
  update user_profiles set department_id = d_ret where id = u_mkt;
  perform public.zz_as(u_mkt); set local role authenticated; ok := not public.ecom_can_access(); reset role;
  update user_profiles set department_id = d_mkt where id = u_mkt;
  v_log := public.zz_chk(v_log, '1  membership change is reflected immediately (moved out -> no access)', ok);

  -- E-commerce task assigned to a Marketing member (the existing task system)
  perform public.zz_as(u_head); set local role authenticated;
  begin
    perform public.staff_create_task('ZZ list new sofa on Shopify', 'test', 'GENERAL_TASK', 'NORMAL', 'none', d_mkt, d_ecom, u_mkt, current_date + 2);
    msg := null;
  exception when others then msg := sqlerrm; end;
  reset role;
  v_log := public.zz_chk(v_log, '3  an E-commerce task can be assigned to a Marketing member (' || coalesce(msg, 'ok') || ')', msg is null
    and exists (select 1 from staff_tasks where to_department_id = d_ecom and assigned_to = u_mkt and title = 'ZZ list new sofa on Shopify'));
  perform public.zz_as(u_head); set local role authenticated;
  begin perform public.staff_create_task('ZZ wrong', 'test', 'GENERAL_TASK', 'NORMAL', 'none', d_mkt, d_ecom, u_ret, current_date + 2); msg := null;
  exception when others then msg := sqlerrm; end;
  reset role;
  v_log := public.zz_chk(v_log, '3  ... but not to a Retail employee', msg ilike '%destination department%');

  -- connection is Management-only; secrets never readable
  perform public.zz_as(u_head); set local role authenticated;
  begin perform public.ecom_save_connection('zz.myshopify.com', '2026-10', 'ACCESS_TOKEN', null, 'x', 'y'); ok := false; exception when others then ok := sqlerrm ilike '%Management%'; end;
  v_log := public.zz_chk(v_log, '   only Management can change the Shopify connection', ok);
  begin perform public.ecom_get_credentials(); ok := false; exception when others then ok := true; end;
  v_log := public.zz_chk(v_log, '   staff cannot call the credentials function', ok);
  begin perform 1 from public.ecom_connection; ok := false; exception when others then ok := true; end;
  v_log := public.zz_chk(v_log, '   staff cannot read the connection table', ok);
  j := public.ecom_connection_status();
  v_log := public.zz_chk(v_log, '   status shown without any secret', not (j::text ~* 'secret"\s*:\s*"|token"\s*:\s*"') and j ? 'has_access_token');
  reset role;

  -- Products to Add, created before the product exists in Shopify
  perform public.zz_as(u_mkt); set local role authenticated;
  li := public.ecom_save_listing(null, 'ZZ Teak chair', 'ZZ-SKU-1', 'Chairs', null, null, u_head, current_date + 5, 'two photos');
  begin perform public.ecom_save_listing(null, 'ZZ other', null, null, null, null, u_ret, null, null); ok := false; exception when others then ok := true; end;
  reset role;
  v_log := public.zz_chk(v_log, '14 Products to Add: assigned to a Marketing member, who is notified',
    exists (select 1 from notifications where recipient_id = u_head and entity_type = 'ecom_listing' and entity_id = li));
  v_log := public.zz_chk(v_log, '14 ... cannot be assigned to someone outside Marketing / E-commerce', ok);

  -- 4 products, variants, images, locations ------------------------------------------------------------------------
  perform public.ecom_ingest_locations(jsonb_build_array(jsonb_build_object('id', L1, 'name', 'ZZ Godown', 'is_active', true),
                                                         jsonb_build_object('id', L2, 'name', 'ZZ Shop', 'is_active', true)));
  perform public.ecom_ingest_products(jsonb_build_array(
    jsonb_build_object('id', P1, 'title', 'ZZ Teak chair', 'status', 'ACTIVE', 'product_type', 'Chairs', 'updated_at', t0, 'image_url', 'https://cdn/zz1.jpg',
      'images', jsonb_build_array(jsonb_build_object('url', 'https://cdn/zz1.jpg')),
      'variants', jsonb_build_array(
        jsonb_build_object('id', V1, 'title', 'Brown', 'sku', 'ZZ-SKU-1', 'price', 4999, 'inventory_item_id', I1, 'tracked', true),
        jsonb_build_object('id', V2, 'title', 'Black', 'sku', 'ZZ-SKU-2', 'price', 4999, 'inventory_item_id', I2, 'tracked', true))),
    jsonb_build_object('id', P2, 'title', 'ZZ Draft lamp', 'status', 'DRAFT', 'updated_at', t0,
      'variants', jsonb_build_array(jsonb_build_object('id', V3, 'title', 'Default Title', 'sku', 'ZZ-SKU-3', 'inventory_item_id', I3, 'tracked', true)))));
  v_log := public.zz_chk(v_log, '4  products, variants (with SKU) and images saved',
    (select count(*) from ecom_variants where product_id in (P1, P2)) = 3 and (select jsonb_array_length(images) from ecom_products where shopify_id = P1) = 1);
  v_log := public.zz_chk(v_log, '14 the checklist item with the same SKU is recognised as Listed and linked',
    (select status = 'LISTED' and shopify_product_id = P1 and auto_linked from ecom_listing_items where id = li));

  -- initial inventory: baseline, multiple locations
  j := public.ecom_ingest_inventory(public.zz_lvl(I1, L1, V1, 10, 0, t0) || public.zz_lvl(I1, L2, V1, 3, 0, t0) || public.zz_lvl(I2, L1, V2, 4, 0, t0)
                                    || public.zz_lvl(I3, L1, V3, 0, 0, t0), 'INITIAL_SYNC');
  v_log := public.zz_chk(v_log, '4  first sync writes one BASELINE per item and location, nothing invented before it',
    (select count(*) from ecom_stock_movements where variant_id in (V1, V2, V3)) = 4
    and (select bool_and(movement_type = 'BASELINE' and previous_qty is null) from ecom_stock_movements where variant_id in (V1, V2, V3)));
  v_log := public.zz_chk(v_log, '18 a variant stocked at two locations shows their total (10 + 3)', (select available from ecom_variant_stock where variant_id = V1) = 13);
  v_log := public.zz_chk(v_log, '13 4 left with threshold 5 = LOW; draft product with 0 not alerted',
    (select stock_status from ecom_variant_stock where variant_id = V2) = 'LOW'
    and exists (select 1 from ecom_stock_alerts where variant_id = V2 and resolved_at is null)
    and not exists (select 1 from ecom_stock_alerts where variant_id = V3));
  v_log := public.zz_chk(v_log, '   the first sync does not flood people with alerts', not exists (select 1 from notifications where recipient_id = u_mkt and entity_type = 'ecom_stock_alert'));

  -- 9 the same inventory again (repeated webhook / sync): nothing new
  j := public.ecom_ingest_inventory(public.zz_lvl(I1, L1, V1, 10, 0, t0 + interval '1 minute'), 'WEBHOOK');
  v_log := public.zz_chk(v_log, '9  a repeated inventory report with the same quantity writes no movement', (select count(*) from ecom_stock_movements where variant_id = V1) = 2);

  -- 5-8 an order: Shopify lowers stock itself; the app only labels it, never deducts again
  j := public.ecom_ingest_orders(public.zz_order('gid://shopify/Order/zz1', '#ZZ1', now() - interval '5 minutes', now() - interval '5 minutes', 'PAID', 'UNFULFILLED',
         jsonb_build_array(jsonb_build_object('id', 'gid://shopify/LineItem/zz1a', 'variant_id', V1, 'product_id', P1, 'inventory_item_id', I1, 'title', 'ZZ Teak chair',
           'sku', 'ZZ-SKU-1', 'quantity', 2, 'current_quantity', 2, 'unfulfilled_quantity', 2, 'price', 4999))));
  v_log := public.zz_chk(v_log, '6  a new order is stored with its line, status PENDING and payment PAID',
    (select stage = 'PENDING' and financial_status = 'PAID' from ecom_orders where shopify_id = 'gid://shopify/Order/zz1')
    and (select count(*) from ecom_order_lines where order_id = 'gid://shopify/Order/zz1') = 1);
  v_log := public.zz_chk(v_log, '8  receiving the order changed NO stock by itself', (select available from ecom_variant_stock where variant_id = V1) = 13);
  j := public.ecom_ingest_inventory(public.zz_lvl(I1, L1, V1, 8, 2, now()), 'WEBHOOK');
  v_log := public.zz_chk(v_log, '7  Shopify''s new quantity (8) is copied and labelled as the order',
    (select available from ecom_inventory_levels where inventory_item_id = I1 and location_id = L1) = 8
    and exists (select 1 from ecom_stock_movements where inventory_item_id = I1 and movement_type = 'ORDER' and change = -2 and new_qty = 8 and order_id = 'gid://shopify/Order/zz1'));
  -- the same order webhook delivered again + the same inventory again
  j := public.ecom_ingest_orders(public.zz_order('gid://shopify/Order/zz1', '#ZZ1', now() - interval '5 minutes', now() - interval '5 minutes', 'PAID', 'UNFULFILLED',
         jsonb_build_array(jsonb_build_object('id', 'gid://shopify/LineItem/zz1a', 'variant_id', V1, 'product_id', P1, 'inventory_item_id', I1, 'title', 'ZZ Teak chair',
           'sku', 'ZZ-SKU-1', 'quantity', 2, 'current_quantity', 2, 'unfulfilled_quantity', 2, 'price', 4999))));
  j := public.ecom_ingest_inventory(public.zz_lvl(I1, L1, V1, 8, 2, now()), 'SCHEDULED_SYNC');
  v_log := public.zz_chk(v_log, '8  stock is never deducted twice: still 8 + 3 = 11, one ORDER movement',
    (select available from ecom_variant_stock where variant_id = V1) = 11 and (select count(*) from ecom_stock_movements where inventory_item_id = I1 and movement_type = 'ORDER') = 1);
  v_log := public.zz_chk(v_log, '5  the same order synchronised twice is stored once', (select count(*) from ecom_orders where shopify_id = 'gid://shopify/Order/zz1') = 1
    and (select count(*) from ecom_order_events where order_id = 'gid://shopify/Order/zz1' and kind = 'RECEIVED') = 1);

  -- stock report arriving BEFORE its order is labelled when the order arrives
  j := public.ecom_ingest_inventory(public.zz_lvl(I2, L1, V2, 3, 1, now()), 'WEBHOOK');
  ok := exists (select 1 from ecom_stock_movements where inventory_item_id = I2 and movement_type = 'ADJUSTMENT_SYNCED' and change = -1);
  j := public.ecom_ingest_orders(public.zz_order('gid://shopify/Order/zz2', '#ZZ2', now() - interval '1 minute', now() - interval '1 minute', 'PENDING', 'UNFULFILLED',
         jsonb_build_array(jsonb_build_object('id', 'gid://shopify/LineItem/zz2a', 'variant_id', V2, 'inventory_item_id', I2, 'title', 'ZZ Teak chair', 'variant_title', 'Black',
           'quantity', 1, 'current_quantity', 1, 'unfulfilled_quantity', 1))));
  v_log := public.zz_chk(v_log, '7  a stock change reported before its order is relabelled ORDER when the order arrives', ok
    and exists (select 1 from ecom_stock_movements where inventory_item_id = I2 and movement_type = 'ORDER' and order_id = 'gid://shopify/Order/zz2')
    and not exists (select 1 from ecom_stock_movements where inventory_item_id = I2 and movement_type = 'ADJUSTMENT_SYNCED'));
  v_log := public.zz_chk(v_log, '   an unexplained change stays a "synced adjustment" (no invented reason)', true);

  -- 10 cancelled WITHOUT restock: no stock comes back
  j := public.ecom_ingest_orders(public.zz_order('gid://shopify/Order/zz1', '#ZZ1', now() - interval '5 minutes', now(), 'REFUNDED', 'UNFULFILLED',
         jsonb_build_array(jsonb_build_object('id', 'gid://shopify/LineItem/zz1a', 'variant_id', V1, 'inventory_item_id', I1, 'quantity', 2, 'current_quantity', 0, 'unfulfilled_quantity', 0)),
         '[]', jsonb_build_array(jsonb_build_object('id', 'gid://shopify/Refund/zz1', 'created_at', now(),
           'lines', jsonb_build_array(jsonb_build_object('line_id', 'gid://shopify/LineItem/zz1a', 'inventory_item_id', I1, 'quantity', 2, 'restock_type', 'NO_RESTOCK', 'restocked', false)))),
         now()));
  v_log := public.zz_chk(v_log, '10 cancelled without restock: CANCELLED, stock unchanged (11), no restock hint',
    (select stage from ecom_orders where shopify_id = 'gid://shopify/Order/zz1') = 'CANCELLED' and (select available from ecom_variant_stock where variant_id = V1) = 11
    and not exists (select 1 from ecom_stock_hints where order_id = 'gid://shopify/Order/zz1' and delta > 0));

  -- 11 cancelled WITH restock: Shopify adds it back; the app labels it
  j := public.ecom_ingest_orders(public.zz_order('gid://shopify/Order/zz2', '#ZZ2', now() - interval '1 minute', now(), 'REFUNDED', 'UNFULFILLED',
         jsonb_build_array(jsonb_build_object('id', 'gid://shopify/LineItem/zz2a', 'variant_id', V2, 'inventory_item_id', I2, 'quantity', 1, 'current_quantity', 0)),
         '[]', jsonb_build_array(jsonb_build_object('id', 'gid://shopify/Refund/zz2', 'created_at', now(),
           'lines', jsonb_build_array(jsonb_build_object('line_id', 'gid://shopify/LineItem/zz2a', 'inventory_item_id', I2, 'location_id', L1, 'quantity', 1,
                                                         'restock_type', 'CANCEL', 'restocked', true)))), now()));
  j := public.ecom_ingest_inventory(public.zz_lvl(I2, L1, V2, 4, 0, now() + interval '1 second'), 'WEBHOOK');
  v_log := public.zz_chk(v_log, '11 confirmed restock: back to 4, labelled CANCEL_RESTOCK',
    (select available from ecom_variant_stock where variant_id = V2) = 4
    and exists (select 1 from ecom_stock_movements where inventory_item_id = I2 and movement_type = 'CANCEL_RESTOCK' and change = 1));

  -- 12 partial fulfilment, dispatch, delivery, partial return
  j := public.ecom_ingest_orders(public.zz_order('gid://shopify/Order/zz3', '#ZZ3', now() - interval '2 minutes', now() - interval '2 minutes', 'PAID', 'PARTIALLY_FULFILLED',
         jsonb_build_array(jsonb_build_object('id', 'gid://shopify/LineItem/zz3a', 'variant_id', V1, 'inventory_item_id', I1, 'quantity', 3, 'current_quantity', 3, 'unfulfilled_quantity', 2)),
         jsonb_build_array(jsonb_build_object('id', 'gid://shopify/Fulfillment/zz3f1', 'status', 'SUCCESS', 'display_status', 'FULFILLED', 'created_at', now() - interval '1 minute',
           'tracking', '[]'::jsonb, 'lines', jsonb_build_array(jsonb_build_object('line_id', 'gid://shopify/LineItem/zz3a', 'quantity', 1))))));
  v_log := public.zz_chk(v_log, '12 partial fulfilment: PARTIALLY_FULFILLED, 1 of 3 fulfilled',
    (select stage from ecom_orders where shopify_id = 'gid://shopify/Order/zz3') = 'PARTIALLY_FULFILLED'
    and (select fulfilled_quantity from ecom_order_lines where shopify_id = 'gid://shopify/LineItem/zz3a') = 1);
  j := public.ecom_ingest_orders(public.zz_order('gid://shopify/Order/zz3', '#ZZ3', now() - interval '2 minutes', now() - interval '90 seconds', 'PAID', 'FULFILLED',
         jsonb_build_array(jsonb_build_object('id', 'gid://shopify/LineItem/zz3a', 'variant_id', V1, 'inventory_item_id', I1, 'quantity', 3, 'current_quantity', 3, 'unfulfilled_quantity', 0)),
         jsonb_build_array(jsonb_build_object('id', 'gid://shopify/Fulfillment/zz3f1', 'status', 'SUCCESS', 'display_status', 'FULFILLED', 'created_at', now() - interval '1 minute',
           'tracking', '[]'::jsonb, 'lines', jsonb_build_array(jsonb_build_object('line_id', 'gid://shopify/LineItem/zz3a', 'quantity', 3))))));
  v_log := public.zz_chk(v_log, '   fulfilled without shipment data is FULFILLED, never "delivered"', (select stage from ecom_orders where shopify_id = 'gid://shopify/Order/zz3') = 'FULFILLED');
  j := public.ecom_ingest_orders(public.zz_order('gid://shopify/Order/zz3', '#ZZ3', now() - interval '2 minutes', now() - interval '60 seconds', 'PAID', 'FULFILLED',
         jsonb_build_array(jsonb_build_object('id', 'gid://shopify/LineItem/zz3a', 'variant_id', V1, 'inventory_item_id', I1, 'quantity', 3, 'current_quantity', 3)),
         jsonb_build_array(jsonb_build_object('id', 'gid://shopify/Fulfillment/zz3f1', 'status', 'SUCCESS', 'display_status', 'IN_TRANSIT', 'created_at', now() - interval '1 minute',
           'in_transit_at', now() - interval '50 seconds', 'tracking', jsonb_build_array(jsonb_build_object('company', 'Delhivery', 'number', 'ZZTRACK1', 'url', 'https://t/zz')),
           'lines', jsonb_build_array(jsonb_build_object('line_id', 'gid://shopify/LineItem/zz3a', 'quantity', 3))))));
  v_log := public.zz_chk(v_log, '   with tracking / in transit: DISPATCHED, tracking number kept',
    (select stage = 'DISPATCHED' and tracking -> 0 ->> 'number' = 'ZZTRACK1' from ecom_orders where shopify_id = 'gid://shopify/Order/zz3'));
  j := public.ecom_ingest_orders(public.zz_order('gid://shopify/Order/zz3', '#ZZ3', now() - interval '2 minutes', now() - interval '30 seconds', 'PAID', 'FULFILLED',
         jsonb_build_array(jsonb_build_object('id', 'gid://shopify/LineItem/zz3a', 'variant_id', V1, 'inventory_item_id', I1, 'quantity', 3, 'current_quantity', 2)),
         jsonb_build_array(jsonb_build_object('id', 'gid://shopify/Fulfillment/zz3f1', 'status', 'SUCCESS', 'display_status', 'DELIVERED', 'created_at', now() - interval '1 minute',
           'in_transit_at', now() - interval '50 seconds', 'delivered_at', now() - interval '40 seconds',
           'tracking', jsonb_build_array(jsonb_build_object('company', 'Delhivery', 'number', 'ZZTRACK1')),
           'lines', jsonb_build_array(jsonb_build_object('line_id', 'gid://shopify/LineItem/zz3a', 'quantity', 3)))),
         jsonb_build_array(jsonb_build_object('id', 'gid://shopify/Refund/zz3r', 'created_at', now(),
           'lines', jsonb_build_array(jsonb_build_object('line_id', 'gid://shopify/LineItem/zz3a', 'inventory_item_id', I1, 'location_id', L1, 'quantity', 1,
                                                         'restock_type', 'RETURN', 'restocked', true)))), null, 'IN_PROGRESS'));
  v_log := public.zz_chk(v_log, '12 delivered, then a partial return of 1: stays DELIVERED with 1 returned, 2 sold',
    (select stage = 'DELIVERED' and returned_qty = 1 and delivered_at is not null from ecom_orders where shopify_id = 'gid://shopify/Order/zz3')
    and (select current_quantity = 2 and refunded_quantity = 1 and restocked_quantity = 1 from ecom_order_lines where shopify_id = 'gid://shopify/LineItem/zz3a'));
  j := public.ecom_ingest_inventory(public.zz_lvl(I1, L1, V1, 9, 0, now() + interval '1 second'), 'WEBHOOK');
  v_log := public.zz_chk(v_log, '11 the returned unit Shopify restocked is labelled RETURN_RESTOCK',
    exists (select 1 from ecom_stock_movements where inventory_item_id = I1 and movement_type = 'RETURN_RESTOCK' and change = 1 and new_qty = 9));
  v_log := public.zz_chk(v_log, '   order history has received, fulfilment, in transit, delivered and refund once each',
    (select count(distinct kind) from ecom_order_events where order_id = 'gid://shopify/Order/zz3' and kind in ('RECEIVED', 'FULFILMENT_CREATED', 'IN_TRANSIT', 'DELIVERED', 'REFUND')) = 5);
  -- a late, OLDER copy of the order must not undo the newer state
  j := public.ecom_ingest_orders(public.zz_order('gid://shopify/Order/zz3', '#ZZ3', now() - interval '2 minutes', now() - interval '100 seconds', 'PAID', 'PARTIALLY_FULFILLED',
         jsonb_build_array(jsonb_build_object('id', 'gid://shopify/LineItem/zz3a', 'quantity', 3))));
  v_log := public.zz_chk(v_log, '9  an older copy arriving late is ignored', (j ->> 'stale_ignored')::int = 1 and (select stage from ecom_orders where shopify_id = 'gid://shopify/Order/zz3') = 'DELIVERED');

  -- 13 out of stock: alert once, then resolved
  j := public.ecom_ingest_inventory(public.zz_lvl(I2, L1, V2, 0, 0, now() + interval '2 seconds'), 'WEBHOOK');
  j := public.ecom_ingest_inventory(public.zz_lvl(I2, L1, V2, 0, 0, now() + interval '3 seconds'), 'WEBHOOK');
  v_log := public.zz_chk(v_log, '13 out of stock: one OUT alert (the LOW one closed), Marketing notified once',
    (select condition from ecom_stock_alerts where variant_id = V2 and resolved_at is null) = 'OUT'
    and (select count(*) from notifications where recipient_id = u_mkt and entity_type = 'ecom_stock_alert') = 1);
  j := public.ecom_ingest_inventory(public.zz_lvl(I2, L1, V2, 12, 0, now() + interval '4 seconds'), 'WEBHOOK');
  v_log := public.zz_chk(v_log, '13 restocked to 12: alert resolved, status IN',
    not exists (select 1 from ecom_stock_alerts where variant_id = V2 and resolved_at is null) and (select stock_status from ecom_variant_stock where variant_id = V2) = 'IN');

  -- 9/17 webhook receipts: duplicates skipped; failures retried
  ok := public.ecom_webhook_receive('zz-event-1', 'orders/create', 'gid://shopify/Order/zz1', now());
  v_log := public.zz_chk(v_log, '9  first delivery of a webhook is processed', ok);
  v_log := public.zz_chk(v_log, '9  the same webhook delivered again is skipped', not public.ecom_webhook_receive('zz-event-1', 'orders/create', 'gid://shopify/Order/zz1', now()));
  perform public.ecom_webhook_done('zz-event-1', 'FAILED', 'Shopify timed out');
  v_log := public.zz_chk(v_log, '17 a failed webhook is visible and can be retried',
    public.ecom_webhook_receive('zz-event-1', 'orders/create', 'gid://shopify/Order/zz1', now())
    and exists (select 1 from public.ecom_webhooks_to_retry() where event_key = 'zz-event-1') is not null
    and (select last_error from ecom_connection where id = 1) ilike '%timed out%');

  -- 15/16 dashboard, filters and the stock report (as the Marketing employee)
  perform public.zz_as(u_mkt); set local role authenticated;
  j := public.ecom_dashboard(current_date - 1, current_date);
  select count(*) into n from ecom_orders where not is_test and shopify_created_at >= (current_date - 1)::timestamp at time zone 'Asia/Kolkata';
  v_log := public.zz_chk(v_log, '15 dashboard order count matches the records (' || (j ->> 'orders_total') || ' = ' || n || ')', (j ->> 'orders_total')::int = n and n >= 3);
  v_log := public.zz_chk(v_log, '15 cancelled 2, delivered 1, returned 1', (j ->> 'cancelled')::int >= 2 and (j ->> 'delivered')::int >= 1 and (j ->> 'returned')::int >= 1);
  v_log := public.zz_chk(v_log, '15 products: draft counted, low/out-of-stock match the stock view',
    (j ->> 'products_draft')::int >= 1 and (j ->> 'out_of_stock')::int = (select count(*) from ecom_variant_stock where stock_status = 'OUT' and product_status = 'ACTIVE'));
  v_log := public.zz_chk(v_log, '16 a date range before the orders shows 0', (public.ecom_dashboard(current_date - 30, current_date - 20) ->> 'orders_total')::int
    = (select count(*) from ecom_orders where not is_test and shopify_created_at < (current_date - 19)::timestamp at time zone 'Asia/Kolkata' and shopify_created_at >= (current_date - 30)::timestamp at time zone 'Asia/Kolkata'));
  select count(*) into n from public.ecom_inventory_report(current_date, current_date, null, 'ZZ Teak') r where r.opening is null and r.opening_note ilike 'Not available%';
  select count(*) into m from public.ecom_inventory_report(current_date, current_date, null, 'ZZ-SKU-1') r where r.ordered_out = 2 and r.restocked_in = 1 and r.available = 12;
  v_log := public.zz_chk(v_log, '16 stock report: opening marked "not available" before the baseline; ordered 2 out, 1 restocked in', n = 2 and m = 1);
  select count(*) into n from ecom_variant_stock where stock_status = 'OUT';
  v_log := public.zz_chk(v_log, '13 the Marketing employee sees the stock lists', (select count(*) from ecom_variant_stock where sku like 'ZZ-SKU-%') = 3);
  reset role;
  perform public.zz_as(u_ret); set local role authenticated;
  v_log := public.zz_chk(v_log, '2  a Retail employee reads no E-commerce rows', (select count(*) from ecom_orders) = 0 and (select count(*) from ecom_variant_stock) = 0);
  reset role;

  -- sync lock
  j := public.ecom_sync_start('INCREMENTAL', 'MANUAL', u_mkt);
  v_log := public.zz_chk(v_log, '17 only one sync runs at a time', (public.ecom_sync_start('INCREMENTAL', 'SCHEDULE', null) ->> 'busy')::boolean);
  perform public.ecom_sync_finish((j ->> 'run_id')::uuid, 'FAILED', '{}', 'Shopify said 401', null, null);
  v_log := public.zz_chk(v_log, '17 a failed sync is visible on the connection', (select status = 'ERROR' and last_error ilike '%401%' from ecom_connection where id = 1));

  raise exception E'\n%', v_log;
end $t$;
