-- v2_93u -- "Approved Quotation -> Confirm for Delivery -> Dispatch Request -> Godown -> Pick/Pack -> Dispatch ->
-- Deliver -> Sold" is already built and tested end to end (v2_93a..93t, product_lifecycle v2_93r1-r8, amazon-style
-- tracking v2_93p-p3). A live audit against the full new spec found six concrete, narrow gaps in that already-real
-- pipeline -- this migration closes them. Nothing here duplicates a quotation/order/delivery record or invents a
-- second status engine; every change is additive to the SAME tables/RPCs already in use.
--
-- Gaps found and fixed:
--   1. retail_convert_quotation_to_order still copied the customer's generic `area` text onto the new order's
--      billing_address/delivery_address, ignoring the quotation's OWN billing_address/delivery_address snapshot
--      that v2_93t added specifically so a salesperson never re-types customer/address details. Confirmed live:
--      the quotation columns exist and are populated; the order-conversion function was simply never updated to
--      read them (it predates v2_93t). Fixed to prefer the quotation snapshot, falling back to customer.area only
--      when a quotation predates that column.
--   2. retail_deliveries.contact_person / contact_phone / driver_name / driver_phone have existed since v2_93j but
--      confirmed live: NO function anywhere ever writes them -- the "delivery contact person/mobile" and
--      "driver/delivery person" fields the spec requires have columns but no path to ever be filled in.
--   3. There was no single guarded action matching the spec's "Confirm Order & Send for Delivery" -- today a
--      salesperson must separately Confirm (mode selection) then, on a second screen, click Create Delivery
--      Challan with none of the delivery-specific fields (contact person/mobile, installation Yes/No, special
--      instructions, payment clearance) the spec's Quotation Confirmation Form requires. New
--      retail_confirm_order_for_delivery() collects exactly those fields once, then calls the SAME already-
--      idempotent retail_create_delivery_challan() (which already auto-reaches Godown via the already-idempotent
--      retail_send_to_godown()) -- no new dispatch-creation logic, just the missing single entry point.
--   4. retail_godown_accept() never notified the salesperson on acceptance, though the spec explicitly requires it
--      ("On acceptance: ... Notify the salesperson") and every other stage (dispatch, delivery failure, damage,
--      packed) already does. Confirmed live by reading the function body -- genuinely missing, now added.
--   5. retail_record_delivery_proof has TWO live overloads right now (the original v2_93j 6-arg one, and v2_93r3's
--      7-arg widening that added p_delivered_serials) -- confirmed live via pg_proc. The frontend's wrapper calls
--      it with exactly 6 named arguments, so it has always resolved to the OLD 6-arg overload: the partial-
--      delivery-by-serial capability v2_93r3 built has been unreachable from the app since it was written. Both
--      overloads are dropped and replaced with ONE final version.
--   6. Delivery-site GPS (spec section 13: "if available and permission granted, store coordinates... never block
--      delivery solely because GPS is unavailable... require an authorized note when it cannot be verified") did
--      not exist as a concept anywhere. Added as optional, non-blocking columns + parameters.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 0. New columns -- all additive, all nullable, nothing existing is affected.
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.retail_delivery_proofs add column if not exists delivery_latitude numeric;
alter table public.retail_delivery_proofs add column if not exists delivery_longitude numeric;
alter table public.retail_delivery_proofs add column if not exists location_unverifiable_reason text;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. retail_convert_quotation_to_order -- same signature, only the address source changes (gap #1 above).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_convert_quotation_to_order(p_quotation_id uuid)
returns public.retail_orders
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_quotation public.retail_quotations; v_customer public.retail_customers; v_allowed boolean; v_order public.retail_orders;
  v_order_number text; v_task record; v_key text; v_qi record; v_item public.retail_inventory_items;
  v_billing text; v_delivery text;
begin
  perform public.staff_assert_operational();

  select * into v_quotation from public.retail_quotations where id = p_quotation_id;
  if v_quotation is null then raise exception 'Quotation not found'; end if;
  if v_quotation.status <> 'ACCEPTED' then raise exception 'Only an ACCEPTED quotation can be converted to an order'; end if;

  select * into v_order from public.retail_orders where quotation_id = p_quotation_id;
  if v_order.id is not null then return v_order; end if;

  v_allowed := (v_quotation.created_by = auth.uid() or public.staff_has_global_oversight()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_quotation.department_id)));
  if not v_allowed then raise exception 'Not authorized to convert this quotation'; end if;

  -- Safety check BEFORE writing anything: every linked serial must still be AVAILABLE.
  for v_qi in select * from public.retail_quotation_items where quotation_id = p_quotation_id and inventory_item_id is not null loop
    select * into v_item from public.retail_inventory_items where id = v_qi.inventory_item_id for update;
    if v_item.status <> 'AVAILABLE' then
      raise exception 'Item % is no longer available (status: %) — cannot convert this quotation', v_item.serial_number, v_item.status;
    end if;
  end loop;

  if v_quotation.customer_id is not null then select * into v_customer from public.retail_customers where id = v_quotation.customer_id; end if;

  -- Prefer the quotation's OWN address snapshot (v2_93t) -- it is what the customer actually approved this
  -- quotation against; fall back to the customer's generic area only for a quotation that predates those columns.
  v_billing := coalesce(nullif(btrim(v_quotation.billing_address), ''), v_customer.area);
  v_delivery := coalesce(nullif(btrim(v_quotation.delivery_address), ''), v_customer.area);

  v_order_number := 'ORD-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  insert into public.retail_orders (
    department_id, quotation_id, customer_id, order_number, customer_name, phone, total_amount, required_delivery_date,
    delivery_address, billing_address, created_by
  ) values (
    v_quotation.department_id, v_quotation.id, v_quotation.customer_id, v_order_number, v_quotation.customer_name, v_quotation.phone,
    v_quotation.total_amount, v_quotation.expected_delivery, v_delivery, v_billing, auth.uid()
  ) returning * into v_order;

  insert into public.retail_order_items (order_id, item_name, sku, dimensions, finish_color_fabric, customization_notes, product_image_path, quantity, unit_price, discount, tax, line_total, product_id, inventory_item_id)
  select v_order.id, item_name, sku, dimensions, null, customization_notes, product_image_path, quantity, unit_price, discount, tax, line_total, product_id, inventory_item_id
  from public.retail_quotation_items where quotation_id = v_quotation.id;

  update public.retail_inventory_items set status = 'RESERVED', reserved_quotation_id = p_quotation_id, reserved_order_id = v_order.id, updated_at = now()
  where id in (select inventory_item_id from public.retail_quotation_items where quotation_id = p_quotation_id and inventory_item_id is not null);

  for v_qi in select inventory_item_id from public.retail_quotation_items where quotation_id = p_quotation_id and inventory_item_id is not null loop
    perform public.retail_log_status_change('retail_inventory_item', v_qi.inventory_item_id, 'AVAILABLE', 'RESERVED', v_quotation.department_id,
      'Reserved for order ' || v_order_number);
  end loop;

  update public.retail_leads set converted_order_id = v_order.id, status = 'CONVERTED' where id = v_quotation.lead_id;

  v_key := 'retail_order_verify:' || v_order.id::text;
  select t.task_id, t.task_number into v_task from public.staff_create_task(
    'Verify order ' || v_order_number, 'Check items, pricing and stock/production plan before confirming.', 'GENERAL_TASK', 'HIGH', 'none',
    v_order.department_id, v_order.department_id, auth.uid(), coalesce(v_order.required_delivery_date, current_date + 3), null,
    null, v_order_number, null, null, null, null) t;
  update public.staff_tasks set system_key = v_key where id = v_task.task_id;
  update public.retail_orders set linked_task_id = v_task.task_id where id = v_order.id;

  perform public.staff_write_audit('retail_order', v_order.id, 'CREATE_FROM_QUOTATION', null,
    jsonb_build_object('order_number', v_order_number, 'quotation_id', p_quotation_id), v_quotation.department_id);
  return v_order;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. retail_confirm_order_for_delivery -- THE single guarded "Confirm Order & Send for Delivery" action (spec
--    section 1). Requires retail_confirm_order() already run (fulfilment mode chosen per item — unchanged,
--    untouched); collects exactly the delivery-specific fields the spec's Quotation Confirmation Form lists that
--    nothing currently collects, writes them onto the SAME retail_orders/retail_deliveries rows (never a second
--    copy), then delegates dispatch-request creation entirely to the already-idempotent
--    retail_create_delivery_challan() — repeated clicks return the same Delivery Challan, never a duplicate.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_confirm_order_for_delivery(
  p_order_id uuid, p_delivery_contact_name text, p_delivery_contact_mobile text,
  p_installation_required boolean default false, p_special_instructions text default null,
  p_required_delivery_date date default null, p_payment_clearance_confirmed boolean default false,
  p_vehicle_transporter text default null, p_notes text default null)
returns public.retail_delivery_challans
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_order public.retail_orders; v_allowed boolean; v_delivery_date date; v_dc public.retail_delivery_challans;
begin
  perform public.staff_assert_operational();
  select * into v_order from public.retail_orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;

  v_allowed := (v_order.created_by = auth.uid() or coalesce(public.retail_can_write_customer(v_order.customer_id), false)
    or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_order.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to confirm this order for delivery'; end if;

  if not v_order.fulfilment_locked then
    raise exception 'Confirm the order (choose Stock/Factory/Outsource/Immediate Delivery per item) before confirming it for delivery';
  end if;
  if v_order.on_hold then raise exception 'Order is on hold: %', v_order.on_hold_reason; end if;

  if coalesce(btrim(p_delivery_contact_name), '') = '' then raise exception 'A delivery contact person is required'; end if;
  if coalesce(btrim(p_delivery_contact_mobile), '') = '' then raise exception 'A delivery contact mobile number is required'; end if;

  v_delivery_date := coalesce(p_required_delivery_date, v_order.required_delivery_date);
  if v_delivery_date is null then raise exception 'A required delivery date is needed before sending this order for delivery'; end if;

  -- Payment-clearance status is a real field on the confirmation form, not merely informational: an authorized
  -- user must actively confirm it (or the order must already show PARTIAL/PAID) before Godown/Dispatch is engaged.
  if coalesce(v_order.total_amount, 0) > 0 and v_order.payment_status = 'PENDING' and not p_payment_clearance_confirmed then
    raise exception 'Payment-clearance status must be confirmed before sending this order for delivery';
  end if;

  update public.retail_orders set
    installation_required = coalesce(p_installation_required, installation_required),
    special_instructions = coalesce(nullif(btrim(p_special_instructions), ''), special_instructions),
    required_delivery_date = v_delivery_date
  where id = p_order_id returning * into v_order;

  -- retail_confirm_order() already inserted the retail_deliveries row for this order; this just fills in the
  -- contact fields that have existed since v2_93j with no writer until now (gap #2 above).
  insert into public.retail_deliveries (department_id, order_id, delivery_address, contact_person, contact_phone, created_by)
  values (v_order.department_id, p_order_id, v_order.delivery_address, btrim(p_delivery_contact_name), btrim(p_delivery_contact_mobile), auth.uid())
  on conflict (order_id) do update set contact_person = excluded.contact_person, contact_phone = excluded.contact_phone;

  perform public.staff_write_audit('retail_order', p_order_id, 'CONFIRM_FOR_DELIVERY', null,
    jsonb_build_object('delivery_contact_name', p_delivery_contact_name, 'installation_required', p_installation_required,
      'required_delivery_date', v_delivery_date), v_order.department_id);

  v_dc := public.retail_create_delivery_challan(p_order_id, p_vehicle_transporter, v_delivery_date, p_special_instructions, p_notes);
  return v_dc;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. retail_godown_accept -- same signature/behavior, PLUS notify the salesperson on acceptance (gap #4 above).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_godown_accept(
  p_handover_id uuid, p_packages_received integer, p_quantity_verified boolean, p_condition_verified boolean,
  p_rack_location text default null, p_notes text default null)
returns public.retail_godown_handovers language plpgsql security definer set search_path = public as $$
declare v_row public.retail_godown_handovers; v_allowed boolean; v_has_photo boolean; v_order public.retail_orders;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_godown_handovers where id = p_handover_id for update;
  if v_row.id is null then raise exception 'Handover not found'; end if;
  if v_row.status = 'ACCEPTED' then return v_row; end if; -- idempotent
  if v_row.status <> 'PENDING' then raise exception 'This handover is not pending'; end if;

  v_allowed := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_row.department_id), false))
    or (coalesce(public.staff_is_godown_staff(), false) and (coalesce(v_row.responsible_user_id = auth.uid(), false) or v_row.responsible_user_id is null)));
  if not v_allowed then raise exception 'Not authorized to accept this handover'; end if;

  select exists (select 1 from public.staff_attachments a where a.entity_type = 'retail_godown_handover' and a.entity_id = p_handover_id
    and a.purpose = 'proof' and a.is_active) into v_has_photo;
  if not v_has_photo then raise exception 'A receiving photo is required before this handover can be accepted'; end if;

  update public.retail_godown_handovers set status = 'ACCEPTED', accepted_by = auth.uid(), accepted_at = now(),
    packages_received = p_packages_received, quantity_verified = p_quantity_verified, condition_verified = p_condition_verified,
    rack_location = p_rack_location, notes = coalesce(p_notes, notes)
  where id = p_handover_id returning * into v_row;

  update public.retail_orders set on_hold = false, on_hold_reason = null where id = v_row.order_id and on_hold;

  select * into v_order from public.retail_orders where id = v_row.order_id;
  if v_order.created_by is not null and v_order.created_by <> auth.uid() then
    perform public.staff_notify_assignment(v_order.created_by, 'retail_godown_handover', p_handover_id,
      'Godown accepted order: ' || v_order.order_number, v_order.order_number || ' — ગોડાઉન દ્વારા સ્વીકારાયું');
  end if;

  perform public.retail_log_status_change('retail_order', v_row.order_id, 'ASSIGNED_TO_GODOWN', 'RECEIVED_AT_GODOWN', v_row.department_id, p_notes);
  perform public.staff_write_audit('retail_godown_handover', p_handover_id, 'ACCEPT', null,
    jsonb_build_object('packages_received', p_packages_received, 'rack_location', p_rack_location), v_row.department_id);
  return v_row;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. retail_record_dispatch -- drop BOTH prior forms (none-in-this-case, only one exists) and widen with optional
--    driver name/phone (gap #2), written onto the columns that have existed unused since v2_93j.
-- ---------------------------------------------------------------------------------------------------------------------------------
drop function if exists public.retail_record_dispatch(uuid, text, text, integer, text, text, text);

create or replace function public.retail_record_dispatch(
  p_dispatch_id uuid, p_vehicle_number text, p_vehicle_transporter text default null, p_package_count integer default null,
  p_delivery_challan_ref text default null, p_gps_location text default null, p_notes text default null,
  p_driver_name text default null, p_driver_phone text default null)
returns public.retail_dispatch_records language plpgsql security definer set search_path = public as $$
declare
  v_row public.retail_dispatch_records; v_order public.retail_orders; v_delivery public.retail_deliveries; v_allowed boolean; v_has_photo boolean;
  v_checklist jsonb; v_all_checked boolean; v_key text; v_task_id uuid; v_ii uuid;
  v_required_keys constant text[] := array['correct_order','correct_customer_address','quantity_checked','packing_checked','condition_checked','documents_checked','payment_clearance_checked','site_confirmed','vehicle_assigned'];
  v_k text;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_dispatch_records where id = p_dispatch_id for update;
  if v_row.id is null then raise exception 'Dispatch record not found'; end if;
  if v_row.dispatched_at is not null then return v_row; end if; -- idempotent

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
  update public.retail_deliveries set stage = 'OUT_FOR_DELIVERY', delivery_challan_number = p_delivery_challan_ref,
    driver_name = coalesce(p_driver_name, driver_name), driver_phone = coalesce(p_driver_phone, driver_phone)
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
    jsonb_build_object('vehicle_number', p_vehicle_number, 'package_count', p_package_count, 'driver_name', p_driver_name), v_row.department_id);
  perform public.staff_notify_assignment(v_order.created_by, 'retail_dispatch', p_dispatch_id,
    'Order dispatched: ' || v_order.order_number, v_order.order_number || ' — મોકલી દેવાયો');
  return v_row;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. retail_record_delivery_proof -- drop BOTH live overloads (gap #5 above -- the 6-arg v2_93j original and the
--    v2_93r3 7-arg widening the frontend could never actually reach) and replace with one final version that adds
--    optional, non-blocking GPS capture (gap #6).
-- ---------------------------------------------------------------------------------------------------------------------------------
drop function if exists public.retail_record_delivery_proof(uuid, text, text, text, jsonb, text);
drop function if exists public.retail_record_delivery_proof(uuid, text, text, text, jsonb, text, text[]);

create or replace function public.retail_record_delivery_proof(
  p_order_id uuid, p_site_representative_name text, p_pod_method text, p_pod_reference text default null,
  p_items jsonb default '[]'::jsonb, p_condition_notes text default null, p_delivered_serials text[] default null,
  p_delivery_latitude numeric default null, p_delivery_longitude numeric default null, p_location_unverifiable_reason text default null)
returns public.retail_deliveries language plpgsql security definer set search_path = public as $$
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

  -- GPS is captured best-effort and never blocks delivery (spec section 13): both coordinates and, when they truly
  -- could not be captured, an authorized note are simply stored alongside the proof for later reference.
  insert into public.retail_delivery_proofs (
    delivery_id, proof_type, site_representative_name, delivered_by, pod_method, pod_reference, condition_notes, created_by,
    delivery_latitude, delivery_longitude, location_unverifiable_reason)
  values (
    v_delivery.id, 'DELIVERY', p_site_representative_name, auth.uid(), p_pod_method, p_pod_reference, p_condition_notes, auth.uid(),
    p_delivery_latitude, p_delivery_longitude, p_location_unverifiable_reason);

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

  -- The spec requires the salesperson be notified of the final status either way — success or otherwise, they must
  -- know their order reached (or didn't fully reach) the customer.
  if v_order.created_by is not null and v_order.created_by <> auth.uid() then
    perform public.staff_notify_assignment(v_order.created_by, 'retail_delivery', v_delivery.id,
      case when v_new_stage = 'DELIVERY_SUCCESSFUL' then 'Delivered successfully: ' || v_order.order_number else 'Delivery proof uploaded (partial): ' || v_order.order_number end,
      v_order.order_number || (case when v_new_stage = 'DELIVERY_SUCCESSFUL' then ' — સફળતાપૂર્વક ડિલિવર થયું' else ' — આંશિક ડિલિવરી' end));
  end if;
  return v_delivery;
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'retail_convert_quotation_to_order(uuid)',
    'retail_confirm_order_for_delivery(uuid, text, text, boolean, text, date, boolean, text, text)',
    'retail_godown_accept(uuid, integer, boolean, boolean, text, text)',
    'retail_record_dispatch(uuid, text, text, integer, text, text, text, text, text)',
    'retail_record_delivery_proof(uuid, text, text, text, jsonb, text, text[], numeric, numeric, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
