-- Product lifecycle (v2_93r, part 3/3): retail_stock_availability now reads serialized masters directly from
-- retail_inventory_items (bulk masters unchanged), a real linked Delivery Challan that automatically reaches
-- Godown (reusing the existing, already-idempotent retail_send_to_godown), scan-verified picking (wrong item =
-- big clear error), damage reporting, and the pack -> dispatch -> deliver -> Sold serial transitions layered onto
-- the SAME already-tested packing/dispatch/delivery-proof/delivery-failure RPCs (every existing parameter and
-- non-serialized behavior is unchanged; new logic only fires when an order has DC-linked serials).

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. retail_stock_availability -- same output columns as before (bare CREATE OR REPLACE is safe), now a union of
--    serialized masters (counted from retail_inventory_items) and bulk masters (unchanged, from retail_stock).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_stock_availability(p_query text default null, p_location_id uuid default null)
returns table(product_id uuid, sku text, name text, category text, image_path text, unit text, location_id uuid, location_name text,
  on_hand_qty numeric, damaged_qty numeric, incoming_qty numeric, reserved_qty numeric, available_qty numeric,
  expected_availability_date date, rack_location text)
language sql
stable security definer
set search_path to 'public'
as $function$
  with serialized as (
    select p.id as product_id, p.sku, p.name, p.category, p.image_path, p.unit,
      ii.location_id, l.name_en as location_name,
      count(*) filter (where ii.status <> 'SOLD')::numeric as on_hand_qty,
      count(*) filter (where ii.status = 'DAMAGED')::numeric as damaged_qty,
      0::numeric as incoming_qty,
      count(*) filter (where ii.status in ('RESERVED', 'PICKED', 'PACKED', 'DISPATCHED', 'IN_TRANSIT_EXCEPTION'))::numeric as reserved_qty,
      count(*) filter (where ii.status = 'AVAILABLE')::numeric as available_qty,
      null::date as expected_availability_date,
      max(ii.rack_location) as rack_location
    from public.retail_products p
    join public.retail_inventory_items ii on ii.product_id = p.id
    join public.locations l on l.id = ii.location_id
    where p.is_active
    group by p.id, p.sku, p.name, p.category, p.image_path, p.unit, ii.location_id, l.name_en
  ),
  bulk as (
    select p.id as product_id, p.sku, p.name, p.category, p.image_path, p.unit,
      s.location_id, l.name_en as location_name, s.on_hand_qty, s.damaged_qty, s.incoming_qty,
      coalesce(r.reserved, 0) as reserved_qty,
      greatest(s.on_hand_qty - coalesce(r.reserved, 0) - s.damaged_qty, 0) as available_qty,
      s.expected_availability_date, s.rack_location
    from public.retail_products p
    join public.retail_stock s on s.product_id = p.id
    join public.locations l on l.id = s.location_id
    left join lateral (
      select sum(fi.quantity) reserved from public.retail_fulfilment_items fi
        join public.retail_order_items oi on oi.id = fi.order_item_id
       where fi.mode = 'STOCK' and fi.status not in ('CANCELLED') and upper(oi.sku) = upper(p.sku)
    ) r on true
    where p.is_active and not exists (select 1 from public.retail_inventory_items ii2 where ii2.product_id = p.id)
  )
  select * from (select * from serialized union all select * from bulk) x
  where (staff_current_department_id() in (select id from departments where code = 'RETAIL') or staff_current_department_id() = public.retail_godown_dept_id()
    or staff_has_global_oversight()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(retail_dept_id()) or staff_dept_in_hod_scope(public.retail_godown_dept_id()))))
    and (p_query is null or btrim(p_query) = '' or x.name ilike '%' || p_query || '%' or x.sku ilike '%' || p_query || '%' or x.category ilike '%' || p_query || '%')
    and (p_location_id is null or x.location_id = p_location_id)
  order by x.name, x.location_name;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. retail_create_delivery_challan -- idempotent per order (a refresh/retry returns the existing ACTIVE DC, never
--    a duplicate), copies serial linkage from order items, and automatically reaches Godown by reusing
--    retail_send_to_godown (which is ALREADY idempotent per order -- confirmed live, unchanged here).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_create_delivery_challan(
  p_order_id uuid, p_vehicle_transporter text default null, p_delivery_date date default null,
  p_special_instructions text default null, p_notes text default null)
returns public.retail_delivery_challans
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_order public.retail_orders; v_allowed boolean; v_dc public.retail_delivery_challans; v_dc_number text;
  v_godown_dept uuid := public.retail_godown_dept_id(); v_head uuid; v_handover public.retail_godown_handovers; v_day date := current_date; v_seq int;
begin
  perform public.staff_assert_operational();
  select * into v_order from public.retail_orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if not v_order.fulfilment_locked then raise exception 'The order must be confirmed before creating a Delivery Challan'; end if;

  v_allowed := (v_order.created_by = auth.uid() or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_order.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to create a Delivery Challan for this order'; end if;

  select * into v_dc from public.retail_delivery_challans where order_id = p_order_id and status = 'ACTIVE';
  if v_dc.id is not null then return v_dc; end if;

  insert into public.retail_dc_number_counters (dc_day, next_seq) values (v_day, 1) on conflict (dc_day) do nothing;
  update public.retail_dc_number_counters set next_seq = next_seq + 1 where dc_day = v_day returning next_seq - 1 into v_seq;
  v_dc_number := 'DC-' || to_char(v_day, 'YYYYMMDD') || '-' || lpad(v_seq::text, 3, '0');

  insert into public.retail_delivery_challans (dc_number, order_id, quotation_id, vehicle_transporter, delivery_date, installation_required, special_instructions, notes, created_by)
  values (v_dc_number, p_order_id, v_order.quotation_id, p_vehicle_transporter, p_delivery_date, v_order.installation_required, p_special_instructions, p_notes, auth.uid())
  returning * into v_dc;

  insert into public.retail_delivery_challan_items (dc_id, order_item_id, product_id, inventory_item_id, quantity)
  select v_dc.id, oi.id, oi.product_id, oi.inventory_item_id, oi.quantity from public.retail_order_items oi where oi.order_id = p_order_id;

  select up.id into v_head from public.user_profiles up join public.roles ro on ro.id = up.role_id
    where up.is_active = true and up.department_id = v_godown_dept and ro.code = 'dept_head' order by up.created_at limit 1;

  v_handover := public.retail_send_to_godown(p_order_id, null, v_head, null, coalesce(p_notes, 'Delivery Challan ' || v_dc_number), true);
  update public.retail_godown_handovers set delivery_challan_id = v_dc.id where id = v_handover.id and delivery_challan_id is null;

  perform public.staff_write_audit('retail_delivery_challan', v_dc.id, 'CREATE', null,
    jsonb_build_object('dc_number', v_dc_number, 'order_id', p_order_id), v_order.department_id);
  return v_dc;
end $function$;
grant execute on function public.retail_create_delivery_challan(uuid, text, date, text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. retail_godown_scan_pick -- compares the scanned serial against this handover's DC. Wrong item = a specific,
--    clearly-worded exception the frontend renders as a big warning; correct item = RESERVED -> PICKED.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_godown_scan_pick(p_handover_id uuid, p_code text)
returns public.retail_inventory_items
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_handover public.retail_godown_handovers; v_allowed boolean; v_item public.retail_inventory_items;
  v_code text := upper(btrim(coalesce(p_code, ''))); v_expected boolean;
begin
  perform public.staff_assert_operational();
  select * into v_handover from public.retail_godown_handovers where id = p_handover_id;
  if v_handover.id is null then raise exception 'Handover not found'; end if;
  if v_handover.status <> 'ACCEPTED' then raise exception 'This handover must be accepted before picking'; end if;

  v_allowed := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_handover.department_id), false))
    or (coalesce(public.staff_is_godown_staff(), false) and coalesce(v_handover.responsible_user_id = auth.uid(), false)));
  if not v_allowed then raise exception 'Not authorized to pick for this handover'; end if;

  select * into v_item from public.retail_inventory_items where upper(serial_number) = v_code limit 1;
  if v_item.id is null then raise exception 'Unknown product code — check the label and try again'; end if;

  if v_handover.delivery_challan_id is null then raise exception 'This delivery has no linked Delivery Challan to verify against'; end if;
  select exists (select 1 from public.retail_delivery_challan_items where dc_id = v_handover.delivery_challan_id and inventory_item_id = v_item.id) into v_expected;
  if not v_expected then
    raise exception 'WRONG ITEM SCANNED — % is not part of this delivery''s Delivery Challan', v_item.serial_number;
  end if;
  if v_item.status <> 'RESERVED' then raise exception 'This item is % and cannot be picked', v_item.status; end if;

  update public.retail_inventory_items set status = 'PICKED', updated_at = now() where id = v_item.id returning * into v_item;
  perform public.retail_log_status_change('retail_inventory_item', v_item.id, 'RESERVED', 'PICKED', v_handover.department_id, 'Picked for handover ' || p_handover_id::text);
  perform public.staff_write_audit('retail_inventory_item', v_item.id, 'PICK', null, jsonb_build_object('handover_id', p_handover_id), v_handover.department_id);
  return v_item;
end $function$;
grant execute on function public.retail_godown_scan_pick(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. retail_report_item_damage -- requires a photo already uploaded, puts the linked order on hold, notifies both
--    the salesperson and Retail leadership. Preserves the item's history (status change logged, row never deleted).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_report_item_damage(p_inventory_item_id uuid, p_reason text)
returns public.retail_inventory_items
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_item public.retail_inventory_items; v_allowed boolean; v_has_photo boolean; v_order public.retail_orders; v_prev_status text;
begin
  perform public.staff_assert_operational();
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to report damage'; end if;
  select * into v_item from public.retail_inventory_items where id = p_inventory_item_id for update;
  if v_item.id is null then raise exception 'Item not found'; end if;
  v_prev_status := v_item.status;

  v_allowed := (coalesce(public.staff_is_godown_staff(), false) or coalesce(public.staff_has_global_oversight(), false) or coalesce(public.staff_is_dept_head(), false));
  if not v_allowed then raise exception 'Not authorized to report damage'; end if;

  select exists (select 1 from public.staff_attachments where entity_type = 'retail_inventory_item' and entity_id = p_inventory_item_id and purpose = 'proof' and is_active) into v_has_photo;
  if not v_has_photo then raise exception 'A damage photo is required'; end if;

  update public.retail_inventory_items set status = 'DAMAGED', damage_reason = p_reason, updated_at = now() where id = p_inventory_item_id returning * into v_item;
  perform public.retail_log_status_change('retail_inventory_item', p_inventory_item_id, v_prev_status, 'DAMAGED', public.retail_godown_dept_id(), p_reason);

  if v_item.reserved_order_id is not null then
    select * into v_order from public.retail_orders where id = v_item.reserved_order_id;
    update public.retail_orders set on_hold = true, on_hold_reason = 'Damaged item: ' || v_item.serial_number || ' — ' || p_reason where id = v_item.reserved_order_id;
    if v_order.created_by is not null then
      perform public.staff_notify_assignment(v_order.created_by, 'retail_inventory_item', p_inventory_item_id,
        'Item damaged: ' || v_item.serial_number || ' (' || v_order.order_number || ')', v_order.order_number || ' — વસ્તુ ક્ષતિગ્રસ્ત મળી');
    end if;
    perform public.staff_notify_dept_leadership('RETAIL', 'retail_inventory_item', p_inventory_item_id,
      'Item damaged: ' || v_item.serial_number || ' (' || v_order.order_number || ')', v_order.order_number || ' — વસ્તુ ક્ષતિગ્રસ્ત મળી');
  end if;

  perform public.staff_write_audit('retail_inventory_item', p_inventory_item_id, 'DAMAGE_REPORT', null, jsonb_build_object('reason', p_reason), public.retail_godown_dept_id());
  return v_item;
end $function$;
grant execute on function public.retail_report_item_damage(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. retail_verify_packing -- rewritten a third time: same signature/behavior as before, PLUS a new gate: if the
--    order has DC-linked serials, ALL of them must already be PICKED (via retail_godown_scan_pick) before packing
--    can be verified, and a successful verify transitions them PICKED -> PACKED.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_verify_packing(
  p_packing_id uuid, p_items jsonb default '[]'::jsonb, p_qc_status text default 'PASSED'::text,
  p_package_count integer default null::integer, p_condition_notes text default null::text, p_missing_damaged_note text default null::text)
returns public.retail_packing_records
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row public.retail_packing_records; v_order public.retail_orders; v_allowed boolean; v_has_photo boolean; v_it jsonb; v_new_status text;
  v_unpicked int; v_ii uuid;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_packing_records where id = p_packing_id for update;
  if v_row.id is null then raise exception 'Packing record not found'; end if;
  select * into v_order from public.retail_orders where id = v_row.order_id;

  v_allowed := (coalesce(v_row.created_by = auth.uid(), false) or coalesce(public.retail_can_write_customer(v_order.customer_id), false)
    or coalesce(public.staff_has_global_oversight(), false) or coalesce(public.staff_is_godown_staff(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_row.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to verify this packing record'; end if;
  if p_qc_status not in ('PENDING', 'PASSED', 'FAILED') then raise exception 'Invalid QC status'; end if;

  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into public.retail_packing_items (packing_id, order_item_id, quantity_confirmed)
    values (p_packing_id, (v_it->>'order_item_id')::uuid, coalesce((v_it->>'quantity_confirmed')::numeric, 0))
    on conflict (packing_id, order_item_id) do update set quantity_confirmed = excluded.quantity_confirmed;
  end loop;

  select exists (select 1 from public.staff_attachments a where a.entity_type = 'retail_packing' and a.entity_id = p_packing_id
    and a.purpose = 'proof' and a.is_active) into v_has_photo;
  if not v_has_photo then raise exception 'A current packing photo is required before packing can be verified'; end if;

  select count(*) into v_unpicked
    from public.retail_delivery_challan_items dci
    join public.retail_delivery_challans dc on dc.id = dci.dc_id
    join public.retail_inventory_items ii on ii.id = dci.inventory_item_id
    where dc.order_id = v_row.order_id and dc.status = 'ACTIVE' and ii.status <> 'PICKED';
  if v_unpicked > 0 then
    raise exception '% linked item(s) still need to be picked (scan each product QR) before packing can be verified', v_unpicked;
  end if;

  v_new_status := case when p_qc_status = 'PASSED' and coalesce(p_package_count, 0) > 0 then 'READY_FOR_GODOWN' else 'VERIFIED' end;

  update public.retail_packing_records set
    status = v_new_status, qc_status = p_qc_status, package_count = coalesce(p_package_count, package_count),
    condition_notes = coalesce(p_condition_notes, condition_notes), missing_damaged_note = coalesce(p_missing_damaged_note, missing_damaged_note),
    packed_by = auth.uid(), packed_at = now()
  where id = p_packing_id returning * into v_row;

  if v_new_status = 'READY_FOR_GODOWN' then
    for v_ii in
      select dci.inventory_item_id from public.retail_delivery_challan_items dci
      join public.retail_delivery_challans dc on dc.id = dci.dc_id
      where dc.order_id = v_row.order_id and dc.status = 'ACTIVE' and dci.inventory_item_id is not null
    loop
      update public.retail_inventory_items set status = 'PACKED', updated_at = now() where id = v_ii and status = 'PICKED';
      perform public.retail_log_status_change('retail_inventory_item', v_ii, 'PICKED', 'PACKED', v_row.department_id, 'Packed with order ' || v_order.order_number);
    end loop;
  end if;

  perform public.retail_log_status_change('retail_packing', p_packing_id, 'IN_PROGRESS', v_new_status, v_row.department_id, p_condition_notes);
  perform public.staff_write_audit('retail_packing', p_packing_id, 'VERIFY', null, jsonb_build_object('status', v_new_status, 'qc_status', p_qc_status), v_row.department_id);

  if v_new_status = 'READY_FOR_GODOWN' and v_order.created_by is not null and v_order.created_by <> auth.uid() then
    perform public.staff_notify_assignment(v_order.created_by, 'retail_packing', p_packing_id,
      'Packed and ready for delivery: ' || v_order.order_number, v_order.order_number || ' — પેક થયું, ડિલિવરી માટે તૈયાર');
  end if;

  return v_row;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 6. retail_record_dispatch -- rewritten in place: same signature/behavior, PLUS PACKED -> DISPATCHED for any
--    DC-linked serials on this order.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_record_dispatch(
  p_dispatch_id uuid, p_vehicle_number text, p_vehicle_transporter text default null::text, p_package_count integer default null::integer,
  p_delivery_challan_ref text default null::text, p_gps_location text default null::text, p_notes text default null::text)
returns public.retail_dispatch_records
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row public.retail_dispatch_records; v_order public.retail_orders; v_delivery public.retail_deliveries; v_allowed boolean; v_has_photo boolean;
  v_checklist jsonb; v_all_checked boolean; v_key text; v_task_id uuid; v_ii uuid;
  v_required_keys constant text[] := array['correct_order', 'correct_customer_address', 'quantity_checked', 'packing_checked', 'condition_checked', 'documents_checked', 'payment_clearance_checked', 'site_confirmed', 'vehicle_assigned'];
  v_k text;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_dispatch_records where id = p_dispatch_id for update;
  if v_row.id is null then raise exception 'Dispatch record not found'; end if;
  if v_row.dispatched_at is not null then return v_row; end if;

  select * into v_order from public.retail_orders where id = v_row.order_id;
  v_allowed := (coalesce(public.staff_is_dispatch_staff(), false) or coalesce(public.staff_is_godown_staff(), false)
    or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_row.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to record dispatch'; end if;
  if v_order.on_hold then raise exception 'Order is on hold: %', v_order.on_hold_reason; end if;

  select coalesce(checklist, '{}'::jsonb) into v_checklist from public.retail_deliveries where order_id = v_row.order_id;
  v_all_checked := true;
  foreach v_k in array v_required_keys loop
    if coalesce((v_checklist->>v_k)::boolean, false) = false then v_all_checked := false; end if;
  end loop;
  if not v_all_checked and not exists (select 1 from public.retail_deliveries where order_id = v_row.order_id and checklist_exception_reason is not null) then
    raise exception 'Pre-dispatch checklist is incomplete — complete it, or an authorized user must record an exception reason';
  end if;

  select exists (select 1 from public.staff_attachments a where a.entity_type = 'retail_dispatch' and a.entity_id = p_dispatch_id
    and a.purpose = 'proof' and a.is_active) into v_has_photo;
  if not v_has_photo then raise exception 'A dispatch photo (packed order + vehicle) is required before dispatch can be recorded'; end if;

  update public.retail_dispatch_records set vehicle_number = p_vehicle_number, vehicle_transporter = p_vehicle_transporter,
    package_count = p_package_count, dispatched_by = auth.uid(), dispatched_at = now(), delivery_challan_ref = p_delivery_challan_ref,
    gps_location = p_gps_location, notes = coalesce(p_notes, notes)
  where id = p_dispatch_id returning * into v_row;

  insert into public.retail_deliveries (department_id, order_id, delivery_address, created_by)
  values (v_order.department_id, v_row.order_id, v_order.delivery_address, auth.uid())
  on conflict (order_id) do nothing;
  update public.retail_deliveries set stage = 'OUT_FOR_DELIVERY', delivery_challan_number = p_delivery_challan_ref
  where order_id = v_row.order_id returning * into v_delivery;

  insert into public.retail_delivery_items (delivery_id, order_item_id, quantity_pending)
  select v_delivery.id, oi.id, oi.quantity from public.retail_order_items oi where oi.order_id = v_row.order_id
  on conflict (delivery_id, order_item_id) do nothing;

  for v_ii in
    select dci.inventory_item_id from public.retail_delivery_challan_items dci
    join public.retail_delivery_challans dc on dc.id = dci.dc_id
    where dc.order_id = v_row.order_id and dc.status = 'ACTIVE' and dci.inventory_item_id is not null
  loop
    update public.retail_inventory_items set status = 'DISPATCHED', updated_at = now() where id = v_ii and status = 'PACKED';
    perform public.retail_log_status_change('retail_inventory_item', v_ii, 'PACKED', 'DISPATCHED', v_row.department_id, 'Dispatched with order ' || v_order.order_number);
  end loop;

  v_key := 'retail_dispatch_delivery:' || v_row.order_id::text;
  select tk.task_id into v_task_id from public.staff_create_task(
    'Deliver order ' || v_order.order_number, coalesce(p_notes, 'Dispatched — proceed to delivery'), 'DELIVERY', 'HIGH', 'photo',
    v_row.department_id, v_order.department_id, v_order.created_by, current_date + 1, null, null, v_order.order_number, null, null, null, null) tk;
  update public.staff_tasks set system_key = v_key where id = v_task_id and not exists (select 1 from staff_tasks where system_key = v_key and id <> v_task_id);
  update public.retail_dispatch_records set linked_task_id = v_task_id where id = p_dispatch_id;

  perform public.retail_log_status_change('retail_order', v_row.order_id, 'RECEIVED_AT_GODOWN', 'OUT_FOR_DELIVERY', v_row.department_id, p_notes);
  perform public.staff_write_audit('retail_dispatch', p_dispatch_id, 'DISPATCH', null,
    jsonb_build_object('vehicle_number', p_vehicle_number, 'package_count', p_package_count), v_row.department_id);
  perform public.staff_notify_assignment(v_order.created_by, 'retail_dispatch', p_dispatch_id,
    'Order dispatched: ' || v_order.order_number, v_order.order_number || ' — મોકલી દેવાયો');
  return v_row;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 7. retail_record_delivery_proof -- rewritten in place: same signature/behavior for the non-serialized case, PLUS
--    an optional p_delivered_serials text[] to mark exactly those serials Sold (defaults to ALL DC-linked serials
--    on the order still DISPATCHED, when the caller doesn't name specific ones -- a partial delivery names only
--    the serials actually handed over, leaving the rest DISPATCHED/RESERVED, matching the spec's own rule).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_record_delivery_proof(
  p_order_id uuid, p_site_representative_name text, p_pod_method text, p_pod_reference text default null::text,
  p_items jsonb default '[]'::jsonb, p_condition_notes text default null::text, p_delivered_serials text[] default null)
returns public.retail_deliveries
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_order public.retail_orders; v_delivery public.retail_deliveries; v_allowed boolean; v_has_photo boolean;
  v_it jsonb; v_ordered numeric; v_delivered numeric; v_all_delivered boolean := true; v_new_stage text; v_key text; v_task_id uuid;
  v_serial text; v_item public.retail_inventory_items;
begin
  perform public.staff_assert_operational();
  if p_pod_method not in ('SIGNATURE', 'OTP', 'PHOTO_CONFIRM') then raise exception 'Invalid proof-of-delivery method'; end if;
  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order.id is null then raise exception 'Order not found'; end if;
  select * into v_delivery from public.retail_deliveries where order_id = p_order_id for update;
  if v_delivery.id is null or not exists (select 1 from public.retail_dispatch_records where order_id = p_order_id and dispatched_at is not null) then
    raise exception 'Order has not been dispatched yet';
  end if;

  v_allowed := (coalesce(public.staff_is_dispatch_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_delivery.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to record delivery proof'; end if;

  select exists (select 1 from public.staff_attachments a where a.entity_type = 'retail_delivery' and a.entity_id = v_delivery.id
    and a.purpose = 'proof' and a.is_active) into v_has_photo;
  if not v_has_photo then raise exception 'A delivery-site photo is required before delivery proof can be recorded'; end if;

  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select quantity into v_ordered from public.retail_order_items where id = (v_it->>'order_item_id')::uuid;
    v_delivered := coalesce((v_it->>'quantity_delivered')::numeric, 0);
    insert into public.retail_delivery_items (delivery_id, order_item_id, quantity_delivered, quantity_pending, condition)
    values (v_delivery.id, (v_it->>'order_item_id')::uuid, v_delivered, greatest(coalesce(v_ordered, v_delivered) - v_delivered, 0), v_it->>'condition')
    on conflict (delivery_id, order_item_id) do update set quantity_delivered = excluded.quantity_delivered,
      quantity_pending = excluded.quantity_pending, condition = excluded.condition, updated_at = now();
  end loop;

  select bool_and(quantity_pending <= 0) into v_all_delivered from public.retail_delivery_items where delivery_id = v_delivery.id;
  v_new_stage := case when coalesce(v_all_delivered, false) then 'DELIVERY_SUCCESSFUL' else 'DELIVERY_PROOF_UPLOADED' end;

  update public.retail_deliveries set stage = v_new_stage where id = v_delivery.id returning * into v_delivery;

  insert into public.retail_delivery_proofs (delivery_id, proof_type, site_representative_name, delivered_by, pod_method, pod_reference, condition_notes, created_by)
  values (v_delivery.id, 'DELIVERY', p_site_representative_name, auth.uid(), p_pod_method, p_pod_reference, p_condition_notes, auth.uid());

  -- Mark exactly the delivered serials Sold -- named ones if given, else every DC-linked serial on this order
  -- still DISPATCHED (the common "fully delivered" case). A serial not DISPATCHED is silently skipped (already
  -- Sold, or was never part of this delivery) -- never double-sold.
  if p_delivered_serials is not null then
    foreach v_serial in array p_delivered_serials loop
      select * into v_item from public.retail_inventory_items where upper(serial_number) = upper(v_serial) and status = 'DISPATCHED' for update;
      if v_item.id is not null then
        update public.retail_inventory_items set status = 'SOLD', sold_to_customer_id = v_order.customer_id, sold_order_id = p_order_id, sold_at = now(), updated_at = now()
        where id = v_item.id;
        perform public.retail_log_status_change('retail_inventory_item', v_item.id, 'DISPATCHED', 'SOLD', v_delivery.department_id, 'Delivered with order ' || v_order.order_number);
      end if;
    end loop;
  elsif v_new_stage = 'DELIVERY_SUCCESSFUL' then
    for v_item in
      select ii.* from public.retail_delivery_challan_items dci
      join public.retail_delivery_challans dc on dc.id = dci.dc_id
      join public.retail_inventory_items ii on ii.id = dci.inventory_item_id
      where dc.order_id = p_order_id and dc.status = 'ACTIVE' and ii.status = 'DISPATCHED'
    loop
      update public.retail_inventory_items set status = 'SOLD', sold_to_customer_id = v_order.customer_id, sold_order_id = p_order_id, sold_at = now(), updated_at = now()
      where id = v_item.id;
      perform public.retail_log_status_change('retail_inventory_item', v_item.id, 'DISPATCHED', 'SOLD', v_delivery.department_id, 'Delivered with order ' || v_order.order_number);
    end loop;
  end if;

  if v_new_stage = 'DELIVERY_PROOF_UPLOADED' then
    v_key := 'retail_pending_delivery:' || p_order_id::text;
    if not exists (select 1 from public.staff_tasks where system_key = v_key and is_active) then
      select tk.task_id into v_task_id from public.staff_create_task(
        'Pending delivery: ' || v_order.order_number, 'Some items were not fully delivered — arrange the remaining quantity.',
        'DELIVERY', 'URGENT', 'photo', public.retail_dispatch_dept_id(), v_delivery.department_id, v_order.created_by, current_date + 2, null,
        null, v_order.order_number, null, null, null, null) tk;
      update public.staff_tasks set system_key = v_key where id = v_task_id;
    end if;
  end if;

  perform public.retail_log_status_change('retail_order', p_order_id, 'OUT_FOR_DELIVERY', v_new_stage, v_delivery.department_id, p_condition_notes);
  perform public.staff_write_audit('retail_order', p_order_id, 'DELIVERY_PROOF', null, jsonb_build_object('stage', v_new_stage), v_delivery.department_id);
  return v_delivery;
end $function$;
grant execute on function public.retail_record_delivery_proof(uuid, text, text, text, jsonb, text, text[]) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 8. retail_record_delivery_failure -- rewritten in place: same signature/behavior, PLUS DISPATCHED -> IN_TRANSIT_EXCEPTION
--    for any DC-linked serials still out with this order.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_record_delivery_failure(p_order_id uuid, p_reason text, p_next_delivery_date date default null::date)
returns public.retail_deliveries
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_order public.retail_orders; v_delivery public.retail_deliveries; v_allowed boolean; v_ii uuid;
begin
  perform public.staff_assert_operational();
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A failure reason is required'; end if;
  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order.id is null then raise exception 'Order not found'; end if;
  select * into v_delivery from public.retail_deliveries where order_id = p_order_id for update;
  if v_delivery.id is null then raise exception 'No delivery record for this order'; end if;

  v_allowed := (coalesce(public.staff_is_dispatch_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_delivery.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to record a delivery failure'; end if;

  update public.retail_deliveries set stage = 'DELIVERY_FAILED', delay_reason = p_reason, rescheduled_at = p_next_delivery_date::timestamptz
  where id = v_delivery.id returning * into v_delivery;

  insert into public.retail_delivery_proofs (delivery_id, proof_type, failure_reason, next_delivery_date, created_by)
  values (v_delivery.id, 'FAILURE', p_reason, p_next_delivery_date, auth.uid());

  for v_ii in
    select dci.inventory_item_id from public.retail_delivery_challan_items dci
    join public.retail_delivery_challans dc on dc.id = dci.dc_id
    where dc.order_id = p_order_id and dc.status = 'ACTIVE' and dci.inventory_item_id is not null
  loop
    update public.retail_inventory_items set status = 'IN_TRANSIT_EXCEPTION', updated_at = now() where id = v_ii and status = 'DISPATCHED';
    perform public.retail_log_status_change('retail_inventory_item', v_ii, 'DISPATCHED', 'IN_TRANSIT_EXCEPTION', v_delivery.department_id, p_reason);
  end loop;

  perform public.retail_log_status_change('retail_order', p_order_id, 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', v_delivery.department_id, p_reason);
  perform public.staff_write_audit('retail_order', p_order_id, 'DELIVERY_FAILED', null, jsonb_build_object('reason', p_reason), v_delivery.department_id);
  perform public.staff_notify_assignment(v_order.created_by, 'retail_order', p_order_id,
    'Delivery failed: ' || v_order.order_number, v_order.order_number || ' — ડિલિવરી નિષ્ફળ');
  perform public.staff_notify_dept_leadership('RETAIL', 'retail_order', p_order_id,
    'Delivery failed: ' || v_order.order_number, v_order.order_number || ' — ડિલિવરી નિષ્ફળ');
  return v_delivery;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 9. Return path -- never silently goes back to Available. A returned serial must be physically scanned back
--    (retail_scan_return_to_godown), then explicitly restocked by an authorized user with a reason
--    (retail_restock_returned_item).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_scan_return_to_godown(p_code text, p_notes text default null)
returns public.retail_inventory_items
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_item public.retail_inventory_items; v_allowed boolean; v_code text := upper(btrim(coalesce(p_code, ''))); v_prev text;
begin
  perform public.staff_assert_operational();
  v_allowed := (coalesce(public.staff_is_godown_staff(), false) or coalesce(public.staff_has_global_oversight(), false) or coalesce(public.staff_is_dept_head(), false));
  if not v_allowed then raise exception 'Not authorized to record a return'; end if;
  select * into v_item from public.retail_inventory_items where upper(serial_number) = v_code for update;
  if v_item.id is null then raise exception 'Unknown product code'; end if;
  if v_item.status not in ('IN_TRANSIT_EXCEPTION', 'DISPATCHED') then raise exception 'This item is % and cannot be returned this way', v_item.status; end if;
  v_prev := v_item.status;
  update public.retail_inventory_items set status = 'RETURNED', updated_at = now() where id = v_item.id returning * into v_item;
  perform public.retail_log_status_change('retail_inventory_item', v_item.id, v_prev, 'RETURNED', public.retail_godown_dept_id(), p_notes);
  perform public.staff_write_audit('retail_inventory_item', v_item.id, 'RETURN_TO_GODOWN', null, jsonb_build_object('notes', p_notes), public.retail_godown_dept_id());
  return v_item;
end $function$;
grant execute on function public.retail_scan_return_to_godown(text, text) to authenticated;

create or replace function public.retail_restock_returned_item(p_inventory_item_id uuid, p_reason text)
returns public.retail_inventory_items
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_item public.retail_inventory_items; v_allowed boolean;
begin
  perform public.staff_assert_operational();
  v_allowed := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_godown_dept_id()), false)));
  if not v_allowed then raise exception 'Only Godown Head/Management may restock a returned item'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to restock a returned item'; end if;
  select * into v_item from public.retail_inventory_items where id = p_inventory_item_id for update;
  if v_item.id is null then raise exception 'Item not found'; end if;
  if v_item.status <> 'RETURNED' then raise exception 'Only a RETURNED item can be restocked (physically inspected first)'; end if;
  update public.retail_inventory_items set status = 'AVAILABLE', reserved_order_id = null, reserved_quotation_id = null, updated_at = now() where id = p_inventory_item_id returning * into v_item;
  perform public.retail_log_status_change('retail_inventory_item', p_inventory_item_id, 'RETURNED', 'AVAILABLE', public.retail_godown_dept_id(), p_reason);
  perform public.staff_write_audit('retail_inventory_item', p_inventory_item_id, 'RESTOCK', null, jsonb_build_object('reason', p_reason), public.retail_godown_dept_id());
  return v_item;
end $function$;
grant execute on function public.retail_restock_returned_item(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 10. Widen retail_log_label_reprint (v2_93q2) to also accept a specific serial -- reprinting ONE physical unit's
--     label, not just a whole model's.
-- ---------------------------------------------------------------------------------------------------------------------------------
drop function if exists public.retail_log_label_reprint(uuid, text);

create or replace function public.retail_log_label_reprint(p_product_id uuid, p_reason text, p_inventory_item_id uuid default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_allowed boolean;
begin
  perform public.staff_assert_operational();
  if not exists (select 1 from public.retail_products where id = p_product_id and is_active) then raise exception 'Product not found'; end if;
  v_allowed := (coalesce(public.staff_is_godown_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_godown_dept_id()), false)));
  if not v_allowed then raise exception 'Not authorized to reprint this label'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to reprint a label'; end if;

  perform public.staff_write_audit(case when p_inventory_item_id is not null then 'retail_inventory_item' else 'retail_product' end,
    coalesce(p_inventory_item_id, p_product_id), 'LABEL_REPRINT', null, null, public.retail_godown_dept_id(), p_reason);
end $function$;
grant execute on function public.retail_log_label_reprint(uuid, text, uuid) to authenticated;
