-- Product lifecycle (v2_93r, part 2/3): safe model-code + serial-number generation, Product Master pricing/detail
-- versioning, the two-tier stock intake rewrite, QR scan lookup, and QR-based quotation entry with reservation at
-- order-confirm time. Every rewritten function below keeps its EXISTING signature/behavior for non-serialized
-- callers unchanged -- new behavior is strictly additive, gated on the new product_type/inventory_item columns.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. retail_generate_stock_code -- now resolves the prefix from retail_product_types first (Head-managed), falling
--    back to the old free-text regex map (v2_93q) only when no matching type exists. Same signature, same table
--    (retail_product_code_counters), still race-free.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_generate_stock_code(p_category text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_norm text; v_prefix text; v_seq int;
begin
  v_norm := upper(btrim(coalesce(p_category, '')));

  select prefix into v_prefix from public.retail_product_types where upper(code) = v_norm or upper(name_en) = v_norm limit 1;

  if v_prefix is null then
    v_prefix := case
      when v_norm ~* 'chair' then 'CHR'
      when v_norm ~* 'sofa' then 'SOF'
      when v_norm ~* 'bed' then 'BED'
      when v_norm ~* 'table' or v_norm ~* 'dining' then case when v_norm ~* 'dining' then 'DIN' else 'TBL' end
      when v_norm ~* 'wardrobe' then 'WRD'
      when v_norm ~* 'cabinet' or v_norm ~* 'storage' then 'CAB'
      when v_norm ~* 'office' then 'OFF'
      when v_norm ~* 'decor' or v_norm ~* 'd.cor' then 'DEC'
      else 'OTH'
    end;
  end if;

  insert into public.retail_product_code_counters (category_code, next_seq) values (v_prefix, 1) on conflict (category_code) do nothing;
  update public.retail_product_code_counters set next_seq = next_seq + 1 where category_code = v_prefix returning next_seq - 1 into v_seq;

  return v_prefix || '-' || lpad(v_seq::text, 6, '0');
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. retail_generate_serial_number -- one race-free counter PER PRODUCT MASTER, format <model_sku>-NNN (3-digit,
--    matching the spec's own CHR-000125-001 example exactly).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_generate_serial_number(p_product_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_sku text; v_seq int;
begin
  select sku into v_sku from public.retail_products where id = p_product_id;
  if v_sku is null then raise exception 'Product not found'; end if;

  insert into public.retail_serial_counters (product_id, next_seq) values (p_product_id, 1) on conflict (product_id) do nothing;
  update public.retail_serial_counters set next_seq = next_seq + 1 where product_id = p_product_id returning next_seq - 1 into v_seq;

  return v_sku || '-' || lpad(v_seq::text, 3, '0');
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. retail_confirm_stock_intake -- rewritten a second time: adds p_product_type_code, and the two-tier shape this
--    spec requires. Old 10-arg signature dropped (this is the second, and final for this architecture, rewrite of
--    this function -- disclosed).
-- ---------------------------------------------------------------------------------------------------------------------------------
drop function if exists public.retail_confirm_stock_intake(uuid, text, text, text, numeric, text, text, text, boolean, boolean);

create or replace function public.retail_confirm_stock_intake(
  p_product_id uuid, p_category text, p_name text, p_unit text default 'Nos', p_quantity numeric default 1,
  p_condition text default 'GOOD', p_rack_location text default null, p_note text default null,
  p_item_level boolean default false, p_category_corrected boolean default false, p_product_type_code text default null)
returns public.retail_products
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_product public.retail_products; v_allowed boolean; v_photo_id uuid; v_sku text; v_qty int; v_type_id uuid;
  v_batch_number text; v_location_id uuid; v_i int; v_serial text;
begin
  perform public.staff_assert_operational();
  select * into v_product from public.retail_products where id = p_product_id for update;
  if v_product.id is null then raise exception 'Product not found'; end if;

  v_allowed := (coalesce(v_product.created_by = auth.uid(), false) or coalesce(public.staff_is_godown_staff(), false)
    or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_godown_dept_id()), false)));
  if not v_allowed then raise exception 'Not authorized to confirm this stock item'; end if;

  if coalesce(btrim(p_category), '') = '' or coalesce(btrim(p_name), '') = '' then
    raise exception 'A category and name are required to confirm this item';
  end if;
  if coalesce(p_condition, 'GOOD') not in ('GOOD', 'DAMAGED') then raise exception 'Invalid condition'; end if;

  select id into v_photo_id from public.staff_attachments
    where entity_type = 'retail_product' and entity_id = p_product_id and purpose = 'proof' and is_active
    order by created_at desc limit 1;
  if v_photo_id is null then raise exception 'A photo of the item is required before it can be confirmed'; end if;

  if p_product_type_code is not null then
    select id into v_type_id from public.retail_product_types where code = upper(btrim(p_product_type_code));
  end if;

  select location_id into v_location_id from public.retail_stock where product_id = p_product_id limit 1;

  v_qty := greatest(coalesce(p_quantity, 1)::int, 1);
  v_batch_number := public.retail_generate_batch_number();
  v_sku := public.retail_generate_stock_code(coalesce(p_product_type_code, p_category));

  -- The ONE Product Master row -- always exactly one, regardless of quantity or item-level tracking.
  update public.retail_products set
    sku = v_sku, name = btrim(p_name), category = btrim(p_category), unit = coalesce(nullif(btrim(p_unit), ''), 'Nos'),
    image_path = v_photo_id::text, confirmed_at = now(), condition = coalesce(p_condition, 'GOOD'), intake_note = p_note,
    category_confirmed_manually = coalesce(p_category_corrected, false), batch_number = v_batch_number,
    batch_item_level = coalesce(p_item_level, false), batch_total_qty = v_qty, product_type_id = v_type_id
  where id = p_product_id returning * into v_product;

  if coalesce(p_item_level, false) then
    -- Serialized: N physical units in retail_inventory_items, each with its own permanent serial + QR. No bulk
    -- retail_stock row is used for a serialized master -- retail_stock_availability (part 3) reads inventory_items
    -- directly for any product that has them.
    for v_i in 1..v_qty loop
      v_serial := public.retail_generate_serial_number(p_product_id);
      insert into public.retail_inventory_items (product_id, serial_number, status, location_id, rack_location, condition, batch_number, created_by)
      values (p_product_id, v_serial, case when p_condition = 'DAMAGED' then 'DAMAGED' else 'AVAILABLE' end,
        v_location_id, p_rack_location, coalesce(p_condition, 'GOOD'), v_batch_number, auth.uid());

      insert into public.staff_attachments (entity_type, entity_id, file_type, storage_path, original_filename, mime_type, file_size, uploaded_by, is_confidential, purpose, storage_bucket)
      select 'retail_inventory_item', (select id from public.retail_inventory_items where serial_number = v_serial),
        a.file_type, a.storage_path, a.original_filename, a.mime_type, a.file_size, a.uploaded_by, a.is_confidential, 'proof', a.storage_bucket
      from public.staff_attachments a where a.id = v_photo_id;
    end loop;
    -- The placeholder retail_stock row from retail_start_stock_intake stays at qty 0 and is simply unused for a
    -- serialized master (retail_stock_availability skips it once inventory_items exist for the product).
  else
    update public.retail_stock set
      on_hand_qty = case when coalesce(p_condition, 'GOOD') = 'GOOD' then v_qty else 0 end,
      damaged_qty = case when p_condition = 'DAMAGED' then v_qty else 0 end,
      rack_location = coalesce(p_rack_location, rack_location), updated_by = auth.uid(), updated_at = now()
    where product_id = p_product_id;
  end if;

  perform public.staff_write_audit('retail_product', p_product_id, 'INTAKE_CONFIRM', null,
    jsonb_build_object('sku', v_sku, 'category', p_category, 'quantity', v_qty, 'batch_number', v_batch_number,
      'item_level', p_item_level, 'condition', p_condition), public.retail_godown_dept_id());

  return v_product;
end $function$;

grant execute on function public.retail_confirm_stock_intake(uuid, text, text, text, numeric, text, text, text, boolean, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. Product Master pricing/detail edits -- Retail Head/Management only, every field change versioned with a
--    mandatory reason. A quotation/order line item is its own immutable snapshot (already true today -- confirmed
--    live: retail_quotation_items.unit_price is copied at insert time, never live-joined), so editing pricing here
--    can never retroactively change an old quotation's price.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_update_product_pricing(
  p_product_id uuid, p_mrp numeric, p_selling_price numeric, p_min_approved_price numeric, p_reason text)
returns public.retail_products
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_allowed boolean; v_old public.retail_products; v_row public.retail_products;
begin
  perform public.staff_assert_operational();
  v_allowed := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false)));
  if not v_allowed then raise exception 'Only Retail Head/Management may edit pricing'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to change pricing'; end if;

  select * into v_old from public.retail_products where id = p_product_id for update;
  if v_old.id is null then raise exception 'Product not found'; end if;

  update public.retail_products set mrp = p_mrp, selling_price = p_selling_price, min_approved_price = p_min_approved_price,
    updated_by = auth.uid(), updated_at = now()
  where id = p_product_id returning * into v_row;

  insert into public.retail_product_price_history (product_id, field_name, old_value, new_value, changed_by, reason) values
    (p_product_id, 'mrp', v_old.mrp::text, p_mrp::text, auth.uid(), p_reason),
    (p_product_id, 'selling_price', v_old.selling_price::text, p_selling_price::text, auth.uid(), p_reason),
    (p_product_id, 'min_approved_price', v_old.min_approved_price::text, p_min_approved_price::text, auth.uid(), p_reason);

  perform public.staff_write_audit('retail_product', p_product_id, 'PRICE_UPDATE',
    jsonb_build_object('mrp', v_old.mrp, 'selling_price', v_old.selling_price),
    jsonb_build_object('mrp', p_mrp, 'selling_price', p_selling_price), public.retail_dept_id(), p_reason);
  return v_row;
end $function$;
grant execute on function public.retail_update_product_pricing(uuid, numeric, numeric, numeric, text) to authenticated;

create or replace function public.retail_update_product_details(
  p_product_id uuid, p_name text, p_material text, p_color_finish text, p_dimensions text, p_description text,
  p_warranty_text text, p_gst_percent numeric, p_brand_vendor text, p_display_availability boolean, p_reason text)
returns public.retail_products
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_allowed boolean; v_old public.retail_products; v_row public.retail_products;
begin
  perform public.staff_assert_operational();
  v_allowed := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false)));
  if not v_allowed then raise exception 'Only Retail Head/Management may edit product details'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to change product details'; end if;

  select * into v_old from public.retail_products where id = p_product_id for update;
  if v_old.id is null then raise exception 'Product not found'; end if;

  update public.retail_products set
    name = coalesce(nullif(btrim(p_name), ''), name), material = p_material, color_finish = p_color_finish, dimensions = p_dimensions,
    description = p_description, warranty_text = p_warranty_text, gst_percent = p_gst_percent, brand_vendor = p_brand_vendor,
    display_availability = coalesce(p_display_availability, display_availability), updated_by = auth.uid(), updated_at = now()
  where id = p_product_id returning * into v_row;

  insert into public.retail_product_price_history (product_id, field_name, old_value, new_value, changed_by, reason)
  values (p_product_id, 'details', to_jsonb(v_old)::text, to_jsonb(v_row)::text, auth.uid(), p_reason);

  perform public.staff_write_audit('retail_product', p_product_id, 'DETAILS_UPDATE', null, null, public.retail_dept_id(), p_reason);
  return v_row;
end $function$;
grant execute on function public.retail_update_product_details(uuid, text, text, text, text, text, text, numeric, text, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. retail_scan_product -- rewritten in place (same signature): serial-first lookup (retail_inventory_items),
--    falling back to the product master's own sku for non-serialized stock. Price is only ever included for
--    authorized viewers. Movement/event history now reads the SAME generic retail_status_history table every other
--    stage already writes to (entity_type='retail_inventory_item'), not a separate table.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_scan_product(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_item public.retail_inventory_items; v_product public.retail_products; v_stock jsonb; v_reserved jsonb; v_movements jsonb;
  v_allowed boolean; v_show_price boolean; v_code text := upper(btrim(coalesce(p_code, '')));
begin
  perform public.staff_assert_operational();

  select * into v_item from public.retail_inventory_items where upper(serial_number) = v_code limit 1;
  if v_item.id is not null then
    select * into v_product from public.retail_products where id = v_item.product_id;
  else
    select * into v_product from public.retail_products where upper(sku) = v_code and is_active limit 1;
  end if;
  if v_product.id is null then return null; end if;

  v_allowed := (coalesce(public.staff_is_godown_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or coalesce(public.staff_current_department_id() in (select id from public.departments where code = 'RETAIL'), false)
    or (coalesce(public.staff_is_dept_head(), false) and (coalesce(public.staff_dept_in_hod_scope(public.retail_godown_dept_id()), false) or coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false))));
  if not v_allowed then raise exception 'Not authorized to view this product'; end if;

  -- Price is "sensitive commercial information" -- shown to Retail staff/Head and oversight, never to a plain
  -- Godown worker (who may still need the rest of this screen to pick/pack/dispatch).
  v_show_price := (coalesce(public.staff_has_global_oversight(), false)
    or coalesce(public.staff_current_department_id() in (select id from public.departments where code = 'RETAIL'), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false))
    or (coalesce(public.staff_is_supervisor(), false) and coalesce(public.staff_current_department_id() = public.retail_dept_id(), false)));

  select jsonb_agg(jsonb_build_object('location_id', s.location_id, 'location_name', l.name_en, 'on_hand_qty', s.on_hand_qty,
      'damaged_qty', s.damaged_qty, 'rack_location', s.rack_location))
    into v_stock from public.retail_stock s join public.locations l on l.id = s.location_id where s.product_id = v_product.id;

  select jsonb_agg(jsonb_build_object('order_id', o.id, 'order_number', o.order_number, 'customer_name', o.customer_name, 'quantity', fi.quantity))
    into v_reserved
    from public.retail_fulfilment_items fi
    join public.retail_order_items oi on oi.id = fi.order_item_id
    join public.retail_orders o on o.id = fi.order_id
    where fi.mode = 'STOCK' and fi.status not in ('CANCELLED') and upper(oi.sku) = upper(v_product.sku);

  if v_item.id is not null then
    select jsonb_agg(jsonb_build_object('previous_status', h.previous_status, 'new_status', h.new_status, 'changed_at', h.created_at, 'notes', h.notes) order by h.created_at desc)
      into v_movements from public.retail_status_history h where h.entity_type = 'retail_inventory_item' and h.entity_id = v_item.id;
  else
    select jsonb_agg(jsonb_build_object('from_location', fl.name_en, 'to_location', tl.name_en, 'quantity', m.quantity, 'moved_at', m.moved_at) order by m.moved_at desc)
      into v_movements from public.retail_stock_movements m left join public.locations fl on fl.id = m.from_location_id
      join public.locations tl on tl.id = m.to_location_id where m.product_id = v_product.id;
  end if;

  return jsonb_build_object(
    'product', jsonb_build_object('id', v_product.id, 'sku', v_product.sku, 'name', v_product.name, 'category', v_product.category,
      'unit', v_product.unit, 'condition', v_product.condition, 'intake_note', v_product.intake_note, 'batch_number', v_product.batch_number,
      'created_at', v_product.created_at, 'confirmed_at', v_product.confirmed_at, 'material', v_product.material,
      'color_finish', v_product.color_finish, 'dimensions', v_product.dimensions, 'description', v_product.description,
      'warranty_text', v_product.warranty_text, 'gst_percent', v_product.gst_percent,
      'mrp', case when v_show_price then v_product.mrp else null end,
      'selling_price', case when v_show_price then v_product.selling_price else null end,
      'min_approved_price', case when v_show_price then v_product.min_approved_price else null end),
    'serial', case when v_item.id is null then null else jsonb_build_object(
      'id', v_item.id, 'serial_number', v_item.serial_number, 'status', v_item.status, 'condition', v_item.condition,
      'rack_location', v_item.rack_location, 'sold_at', v_item.sold_at) end,
    'stock', coalesce(v_stock, '[]'::jsonb), 'reserved_for', coalesce(v_reserved, '[]'::jsonb), 'movements', coalesce(v_movements, '[]'::jsonb)
  );
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 6. retail_add_quotation_item_from_scan -- "Scan QR -> Add to Quotation", the core of the new QR-based quotation
--    flow. Resolves a serial (preferred) or a bulk product master, blocks sold/reserved/damaged serials, blocks
--    adding the same serial twice to one quotation (unique index, part 1), enforces the discount floor
--    (min_approved_price) unless the caller is Head/oversight, and snapshots every customer-facing field into the
--    new retail_quotation_items row -- never a live join, so a later price edit can never change this quotation.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_add_quotation_item_from_scan(p_quotation_id uuid, p_code text, p_quantity numeric default 1, p_discount numeric default 0)
returns public.retail_quotation_items
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_quotation public.retail_quotations; v_allowed boolean; v_item public.retail_inventory_items; v_product public.retail_products;
  v_code text := upper(btrim(coalesce(p_code, ''))); v_unit_price numeric; v_can_override_floor boolean; v_row public.retail_quotation_items;
begin
  perform public.staff_assert_operational();
  select * into v_quotation from public.retail_quotations where id = p_quotation_id;
  if v_quotation.id is null then raise exception 'Quotation not found'; end if;
  if v_quotation.status not in ('DRAFT', 'SENT') then raise exception 'This quotation can no longer be edited'; end if;

  v_allowed := (v_quotation.created_by = auth.uid() or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_quotation.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to edit this quotation'; end if;

  select * into v_item from public.retail_inventory_items where upper(serial_number) = v_code limit 1;
  if v_item.id is not null then
    if v_item.status <> 'AVAILABLE' then
      raise exception 'This item is % and cannot be added to a quotation', v_item.status;
    end if;
    if exists (select 1 from public.retail_quotation_items where quotation_id = p_quotation_id and inventory_item_id = v_item.id) then
      raise exception 'This exact item is already in this quotation';
    end if;
    select * into v_product from public.retail_products where id = v_item.product_id;
  else
    select * into v_product from public.retail_products where upper(sku) = v_code and is_active limit 1;
    if v_product.id is null then raise exception 'Product not found for code %', p_code; end if;
  end if;

  v_unit_price := greatest(coalesce(v_product.selling_price, 0) - coalesce(p_discount, 0), 0);
  v_can_override_floor := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_quotation.department_id), false)));
  if not v_can_override_floor and v_product.min_approved_price is not null and v_unit_price < v_product.min_approved_price then
    raise exception 'Discount exceeds your approved limit — minimum price for this item is %', v_product.min_approved_price;
  end if;

  insert into public.retail_quotation_items (
    quotation_id, item_name, sku, description, dimensions, product_image_path, quantity, unit_price, discount, tax, line_total,
    product_id, inventory_item_id
  ) values (
    p_quotation_id, v_product.name, v_product.sku, v_product.description, v_product.dimensions, v_product.image_path,
    coalesce(p_quantity, 1), v_unit_price, coalesce(p_discount, 0), coalesce(v_product.gst_percent, 0),
    v_unit_price * coalesce(p_quantity, 1), v_product.id, v_item.id
  ) returning * into v_row;

  update public.retail_quotations set total_amount = coalesce(total_amount, 0) + v_row.line_total where id = p_quotation_id;

  perform public.staff_write_audit('retail_quotation', p_quotation_id, 'ADD_ITEM_FROM_SCAN', null,
    jsonb_build_object('product_id', v_product.id, 'inventory_item_id', v_item.id, 'unit_price', v_unit_price), v_quotation.department_id);
  return v_row;
end $function$;
grant execute on function public.retail_add_quotation_item_from_scan(uuid, text, numeric, numeric) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 7. retail_convert_quotation_to_order -- rewritten in place (same signature/behavior for plain items): carries
--    product_id/inventory_item_id onto the new order items, and RESERVES each linked serial right here, per the
--    spec's own status sequence (reservation happens at order-confirm/conversion, not at quotation time). Aborts
--    the whole conversion if any linked serial is no longer AVAILABLE (sold/reserved elsewhere meanwhile) --
--    nothing is partially converted.
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
  v_order_number := 'ORD-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  insert into public.retail_orders (
    department_id, quotation_id, customer_id, order_number, customer_name, phone, total_amount, required_delivery_date,
    delivery_address, billing_address, created_by
  ) values (
    v_quotation.department_id, v_quotation.id, v_quotation.customer_id, v_order_number, v_quotation.customer_name, v_quotation.phone,
    v_quotation.total_amount, v_quotation.expected_delivery, v_customer.area, v_customer.area, auth.uid()
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
