-- Retail Stores module Phase 2a — stock availability + delivery board. Runs against real data as impersonated users, always rolls back.
-- Covers: on_hand/damaged/reserved/available math; a confirmed STOCK order item actually reserves stock (never shown as free); the
-- deliveries board shows a real confirmed order; retail_advance_delivery creates a real coordination task and moves the stage; RLS
-- (an unrelated employee sees nothing and cannot advance the delivery).
do $t$
declare
  v_log text := ''; v_sales uuid; v_other uuid; v_prod uuid; v_loc uuid; n int; v_avail numeric; v_reserved numeric;
  v_lead record; v_quote public.retail_quotations; v_order public.retail_orders; v_item_id uuid;
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select up.id into v_sales from user_profiles up join roles r on r.id=up.role_id where up.department_id=public.retail_dept_id() and r.code='employee' and up.is_active limit 1;
  select up.id into v_other from user_profiles up join roles r on r.id=up.role_id where up.department_id<>public.retail_dept_id() and r.code='employee' and up.is_active and up.department_id is not null limit 1;
  select id into v_loc from locations where type='showroom' and is_active limit 1;
  v_log := public.zz_chk(v_log, 'fixture: sales, unrelated user, showroom location found', v_sales is not null and v_other is not null and v_loc is not null);

  insert into retail_products (sku, name, category, unit, created_by) values ('ZS-SOFA-01', 'ZS Test Sofa', 'Sofa', 'Nos', v_sales) returning id into v_prod;
  insert into retail_stock (product_id, location_id, on_hand_qty, damaged_qty, incoming_qty) values (v_prod, v_loc, 10, 1, 3);

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  select available_qty, reserved_qty into v_avail, v_reserved from retail_stock_availability('ZS Test Sofa', null);
  v_log := public.zz_chk(v_log, 'stock availability: 10 on hand, 1 damaged, 0 reserved -> 9 available', v_avail = 9 and v_reserved = 0);

  select * into v_lead from retail_create_walkin('ZS Test Customer', '9112233440', null, null, null, null, null, null, null, null, null, 'walkin', v_sales, 'RETAIL', null, 'WARM', null);
  v_quote := retail_create_quotation(v_lead.lead_id, 'ZS Test Customer', '9112233440', null, current_date+10, current_date+20, 0, 0, null, false,
    jsonb_build_array(jsonb_build_object('item_name','ZS Test Sofa','sku','ZS-SOFA-01','quantity',2,'unit_price',20000)), null);
  update retail_quotations set status='ACCEPTED' where id = v_quote.id;
  v_order := retail_convert_quotation_to_order(v_quote.id);
  select id into v_item_id from retail_order_items where order_id = v_order.id;
  perform retail_confirm_order(v_order.id, jsonb_build_array(jsonb_build_object('order_item_id', v_item_id, 'mode', 'STOCK', 'quantity', 2, 'stock_location_id', v_loc)));

  select available_qty, reserved_qty into v_avail, v_reserved from retail_stock_availability('ZS Test Sofa', null);
  v_log := public.zz_chk(v_log, 'confirming a STOCK order RESERVES it: reserved=2, available drops to 7 (never shown as free)', v_reserved = 2 and v_avail = 7);

  select count(*) into n from retail_deliveries_board() where order_id = v_order.id;
  v_log := public.zz_chk(v_log, 'salesperson sees their confirmed order on the deliveries board', n = 1);

  perform retail_advance_delivery(v_order.id, 'DELIVERY_SCHEDULED', 'Customer confirmed slot', now() + interval '2 days');
  select count(*) into n from staff_tasks where system_key like 'retail_delivery:%' and is_active and title ilike '%'||v_order.order_number||'%';
  v_log := public.zz_chk(v_log, 'scheduling delivery creates a real coordination task', n = 1);
  select count(*) into n from retail_deliveries_board() where order_id = v_order.id and stage = 'DELIVERY_SCHEDULED';
  v_log := public.zz_chk(v_log, 'delivery stage updated on the board', n = 1);

  -- v2_93j narrowed retail_advance_delivery to pre-dispatch coordination stages only -- DISPATCHED is now a genuinely guarded stage,
  -- reachable only via retail_record_dispatch(); confirm the bare RPC still refuses it for everyone, not just for RLS reasons.
  begin
    perform retail_advance_delivery(v_order.id, 'DISPATCHED', null, null);
    v_log := public.zz_chk(v_log, 'retail_advance_delivery refuses DISPATCHED even for the order''s own owner (v2_93j)', false);
  exception when others then
    v_log := public.zz_chk(v_log, 'retail_advance_delivery refuses DISPATCHED even for the order''s own owner (v2_93j)', true);
  end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*) into n from retail_stock_availability(null, null);
  v_log := public.zz_chk(v_log, 'an unrelated employee (not Retail/Godown) sees NO stock rows', n = 0);
  select count(*) into n from retail_deliveries_board() where order_id = v_order.id;
  v_log := public.zz_chk(v_log, 'an unrelated employee sees NOTHING on the deliveries board for this order', n = 0);
  begin perform retail_advance_delivery(v_order.id, 'SITE_READINESS', null, null); v_log := public.zz_chk(v_log, 'unrelated employee cannot advance this delivery', false);
  exception when others then v_log := public.zz_chk(v_log, 'unrelated employee cannot advance this delivery', true); end;
  reset role;

  raise exception E'STOCK-DELIVERY-REPORT (rolled back)\n%', v_log;
end $t$;
