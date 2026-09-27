-- v2_93v -- Quotation form improvements: mandatory searchable customer selection (never re-typing an existing
-- customer's details), a Display-status allowance for scanned items when selling from display is permitted, and an
-- optional Manual Item entry point (clearly marked, never a fake inventory serial). Nothing here creates a second
-- quotation table or duplicates Product Master/Inventory -- every change is additive to the SAME
-- retail_quotations/retail_quotation_items/retail_customers rows already in use.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. retail_create_quotation -- widened with p_customer_id. When given (the salesperson picked an existing customer
--    from search), it is used DIRECTLY -- no upsert-by-name/phone guessing -- and every detail not explicitly
--    overridden is snapshotted from that customer's own record (never re-typed). When omitted (older callers, or a
--    genuinely new customer), behavior is UNCHANGED: retail_upsert_customer's own phone-based dedupe still applies.
-- ---------------------------------------------------------------------------------------------------------------------------------
drop function if exists public.retail_create_quotation(uuid, text, text, uuid, date, date, numeric, numeric, text, boolean, jsonb, uuid, text, text, text, uuid);

create or replace function public.retail_create_quotation(
  p_lead_id uuid, p_customer_name text, p_phone text, p_location_id uuid default null::uuid, p_valid_until date default null::date,
  p_expected_delivery date default null::date, p_delivery_charge numeric default 0, p_installation_charge numeric default 0,
  p_terms text default null::text, p_internal_approval_required boolean default false, p_items jsonb default '[]'::jsonb,
  p_supersedes_id uuid default null::uuid, p_email text default null::text, p_billing_address text default null::text,
  p_delivery_address text default null::text, p_store_location_id uuid default null::uuid, p_customer_id uuid default null::uuid)
returns public.retail_quotations
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_dept uuid := public.retail_dept_id(); v_customer_id uuid; v_customer public.retail_customers; v_number text;
  v_revision int := 1; v_total numeric := 0; v_row public.retail_quotations; v_item jsonb; v_line numeric;
begin
  perform public.staff_assert_operational();

  if p_customer_id is not null then
    if not coalesce(public.retail_can_access_customer(p_customer_id), false) then
      raise exception 'Not authorized to create a quotation for this customer';
    end if;
    select * into v_customer from public.retail_customers where id = p_customer_id;
    if v_customer.id is null then raise exception 'Customer not found'; end if;
    v_customer_id := v_customer.id;
  elsif p_lead_id is not null then
    select customer_id into v_customer_id from public.retail_leads where id = p_lead_id;
  end if;

  if v_customer_id is null then
    v_customer_id := (public.retail_upsert_customer(p_customer_name, p_phone, null, null, null, null, 'RETAIL', auth.uid())).id;
  end if;
  if v_customer.id is null then select * into v_customer from public.retail_customers where id = v_customer_id; end if;

  if p_supersedes_id is not null then
    select revision_no + 1 into v_revision from public.retail_quotations where id = p_supersedes_id;
    if v_revision is null then raise exception 'Original quotation not found'; end if;
  end if;

  v_number := 'QT-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_line := coalesce((v_item->>'quantity')::numeric, 0) * coalesce((v_item->>'unit_price')::numeric, 0)
              - coalesce((v_item->>'discount')::numeric, 0) + coalesce((v_item->>'tax')::numeric, 0);
    v_total := v_total + v_line;
  end loop;
  v_total := v_total + coalesce(p_delivery_charge, 0) + coalesce(p_installation_charge, 0);

  -- When a real, linked customer is known (picked from search, or already linked via the lead), that customer's OWN
  -- record is the source of truth for the snapshot -- it wins over any (possibly stale) text the form happened to
  -- carry, since the whole point of selecting a customer is to never re-type/re-guess their details. Only a
  -- genuinely brand-new customer (no v_customer_id resolved at all) relies on the explicit params, and in that
  -- case v_customer IS that freshly-created row anyway, so there's no conflict either way.
  insert into public.retail_quotations (
    department_id, lead_id, customer_id, quotation_number, customer_name, phone, status, total_amount, valid_until,
    delivery_charge, installation_charge, terms, expected_delivery, supersedes_id, revision_no, internal_approval_required, created_by,
    email, billing_address, delivery_address, store_location_id
  ) values (
    v_dept, p_lead_id, v_customer_id, v_number,
    coalesce(v_customer.full_name, nullif(btrim(p_customer_name), '')),
    coalesce(v_customer.phone, nullif(btrim(p_phone), '')),
    'DRAFT', v_total, p_valid_until,
    coalesce(p_delivery_charge, 0), coalesce(p_installation_charge, 0), p_terms, p_expected_delivery, p_supersedes_id, v_revision,
    coalesce(p_internal_approval_required, false), auth.uid(),
    coalesce(v_customer.email, nullif(btrim(coalesce(p_email, '')), '')),
    coalesce(v_customer.billing_address, p_billing_address),
    coalesce(v_customer.delivery_address, p_delivery_address),
    p_store_location_id
  ) returning * into v_row;

  insert into public.retail_quotation_items (quotation_id, item_name, sku, description, dimensions, product_image_path, quantity, unit_price, discount, tax, line_total, customization_notes)
  select v_row.id, it->>'item_name', it->>'sku', it->>'description', it->>'dimensions', it->>'product_image_path',
    coalesce((it->>'quantity')::numeric, 0), coalesce((it->>'unit_price')::numeric, 0), coalesce((it->>'discount')::numeric, 0), coalesce((it->>'tax')::numeric, 0),
    coalesce((it->>'quantity')::numeric, 0) * coalesce((it->>'unit_price')::numeric, 0) - coalesce((it->>'discount')::numeric, 0) + coalesce((it->>'tax')::numeric, 0),
    it->>'customization_notes'
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it;

  if p_supersedes_id is not null then
    update public.retail_quotations set is_current_revision = false where id = p_supersedes_id;
  end if;

  if p_lead_id is not null then update public.retail_leads set status = 'QUOTED' where id = p_lead_id; end if;
  perform public.staff_write_audit('retail_quotation', v_row.id, 'CREATE', null, jsonb_build_object('quotation_number', v_number, 'total', v_total, 'customer_id', v_customer_id), v_dept);
  return v_row;
end $function$;
grant execute on function public.retail_create_quotation(uuid, text, text, uuid, date, date, numeric, numeric, text, boolean, jsonb, uuid, text, text, text, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. retail_add_quotation_item_from_scan -- same signature, additive: a DISPLAY-status item may now also be added
--    (spec: "Display, when sale is permitted" -- read here as "the caller is already authorized to build this
--    quotation at all", the same authorization check already gating this whole function). AVAILABLE is unchanged;
--    every other status (RESERVED/PICKED/PACKED/DISPATCHED/SOLD/DAMAGED/etc.) is still blocked with the same clear
--    per-status error message as before.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_add_quotation_item_from_scan(p_quotation_id uuid, p_code text, p_quantity numeric default 1, p_discount numeric default 0,
  p_discount_type text default 'FIXED'::text, p_adjustment_type text default 'NONE'::text, p_adjustment_value numeric default 0, p_adjustment_reason text default null::text)
returns public.retail_quotation_items
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_quotation public.retail_quotations; v_allowed boolean; v_item public.retail_inventory_items; v_product public.retail_products;
  v_code text := upper(btrim(coalesce(p_code, ''))); v_can_override_floor boolean; v_row public.retail_quotation_items;
  v_calc record; v_needs_approval boolean;
begin
  perform public.staff_assert_operational();
  select * into v_quotation from public.retail_quotations where id = p_quotation_id;
  if v_quotation.id is null then raise exception 'Quotation not found'; end if;
  if v_quotation.status not in ('DRAFT', 'SENT') then raise exception 'This quotation can no longer be edited'; end if;
  if not v_quotation.is_current_revision then raise exception 'This is a superseded revision and can no longer be edited'; end if;

  v_allowed := (v_quotation.created_by = auth.uid() or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_quotation.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to edit this quotation'; end if;

  if coalesce(p_discount_type, 'FIXED') not in ('NONE', 'PERCENT', 'FIXED') then raise exception 'Invalid discount type'; end if;
  if coalesce(p_adjustment_type, 'NONE') not in ('NONE', 'INCREASE', 'DECREASE') then raise exception 'Invalid adjustment type'; end if;
  if coalesce(p_adjustment_type, 'NONE') <> 'NONE' and coalesce(btrim(p_adjustment_reason), '') = '' then
    raise exception 'A reason is required for a price adjustment';
  end if;

  select * into v_item from public.retail_inventory_items where upper(serial_number) = v_code limit 1;
  if v_item.id is not null then
    if v_item.status not in ('AVAILABLE', 'DISPLAY') then
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

  if v_product.approval_status <> 'ACTIVE' then
    raise exception 'This product is pending Retail Head approval and cannot be added to a quotation yet';
  end if;

  select * into v_calc from public.retail_compute_quotation_line(
    coalesce(p_quantity, 1), coalesce(v_product.selling_price, 0), p_discount_type, coalesce(p_discount, 0),
    p_adjustment_type, p_adjustment_value, coalesce(v_product.gst_percent, 0));

  v_can_override_floor := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_quotation.department_id), false)));
  v_needs_approval := (not v_can_override_floor) and (
    (v_product.min_approved_price is not null and (v_calc.amount_after_discount / greatest(coalesce(p_quantity, 1), 1)) < v_product.min_approved_price)
    or coalesce(p_adjustment_type, 'NONE') = 'DECREASE');

  insert into public.retail_quotation_items (
    quotation_id, item_name, sku, description, dimensions, product_image_path, quantity, unit_price, discount, tax, line_total,
    product_id, inventory_item_id, discount_type, discount_value, adjustment_type, adjustment_value, adjustment_reason,
    gst_rate, base_amount, taxable_amount, tax_amount
  ) values (
    p_quotation_id, v_product.name, v_product.sku, v_product.description, v_product.dimensions, v_product.image_path,
    coalesce(p_quantity, 1), v_calc.taxable_amount / greatest(coalesce(p_quantity, 1), 1), v_calc.discount_amount,
    coalesce(v_product.gst_percent, 0), v_calc.line_total,
    v_product.id, v_item.id, coalesce(p_discount_type, 'FIXED'), coalesce(p_discount, 0), coalesce(p_adjustment_type, 'NONE'),
    coalesce(p_adjustment_value, 0), p_adjustment_reason, coalesce(v_product.gst_percent, 0), v_calc.base_amount, v_calc.taxable_amount, v_calc.tax_amount
  ) returning * into v_row;

  update public.retail_quotations set total_amount = coalesce(total_amount, 0) + v_row.line_total,
    discount_approval_status = case when v_needs_approval and discount_approval_status = 'NONE' then 'PENDING' else discount_approval_status end,
    discount_approval_requested_by = case when v_needs_approval and discount_approval_status = 'NONE' then auth.uid() else discount_approval_requested_by end,
    discount_approval_requested_at = case when v_needs_approval and discount_approval_status = 'NONE' then now() else discount_approval_requested_at end,
    discount_approval_reason = case when v_needs_approval and discount_approval_status = 'NONE' then coalesce(p_adjustment_reason, 'Below approved minimum price') else discount_approval_reason end
  where id = p_quotation_id;

  if v_needs_approval then
    perform public.staff_notify_dept_leadership('RETAIL', 'retail_quotation', p_quotation_id,
      'Discount/price approval needed: ' || v_quotation.quotation_number, v_quotation.quotation_number || ' — ડિસ્કાઉન્ટ મંજૂરી જરૂરી');
  end if;

  perform public.staff_write_audit('retail_quotation', p_quotation_id, 'ADD_ITEM_FROM_SCAN', null,
    jsonb_build_object('product_id', v_product.id, 'inventory_item_id', v_item.id, 'line_total', v_calc.line_total, 'needs_approval', v_needs_approval), v_quotation.department_id);
  return v_row;
end $function$;
grant execute on function public.retail_add_quotation_item_from_scan(uuid, text, numeric, numeric, text, text, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. retail_add_manual_quotation_item -- the "+ Add Manual Item (Optional)" entry point. NEVER touches
--    retail_products/retail_inventory_items -- product_id/inventory_item_id stay null, so it can never be confused
--    with real stock and never blocks/consumes a real serial. The frontend renders every row with a null
--    inventory_item_id as "Manual Item — Not linked to Inventory".
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_add_manual_quotation_item(
  p_quotation_id uuid, p_item_name text, p_description text default null, p_product_code text default null,
  p_quantity numeric default 1, p_unit_price numeric default 0, p_discount_type text default 'FIXED',
  p_discount numeric default 0, p_gst_rate numeric default 0, p_notes text default null)
returns public.retail_quotation_items
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_quotation public.retail_quotations; v_allowed boolean; v_row public.retail_quotation_items; v_calc record;
begin
  perform public.staff_assert_operational();
  if coalesce(btrim(p_item_name), '') = '' then raise exception 'An item name is required'; end if;
  select * into v_quotation from public.retail_quotations where id = p_quotation_id;
  if v_quotation.id is null then raise exception 'Quotation not found'; end if;
  if v_quotation.status not in ('DRAFT', 'SENT') then raise exception 'This quotation can no longer be edited'; end if;
  if not v_quotation.is_current_revision then raise exception 'This is a superseded revision and can no longer be edited'; end if;

  v_allowed := (v_quotation.created_by = auth.uid() or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_quotation.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to edit this quotation'; end if;

  if coalesce(p_discount_type, 'FIXED') not in ('NONE', 'PERCENT', 'FIXED') then raise exception 'Invalid discount type'; end if;

  select * into v_calc from public.retail_compute_quotation_line(
    coalesce(p_quantity, 1), coalesce(p_unit_price, 0), p_discount_type, coalesce(p_discount, 0), 'NONE', 0, coalesce(p_gst_rate, 0));

  insert into public.retail_quotation_items (
    quotation_id, item_name, sku, description, quantity, unit_price, discount, tax, line_total,
    product_id, inventory_item_id, discount_type, discount_value, adjustment_type, gst_rate, base_amount, taxable_amount, tax_amount, customization_notes
  ) values (
    p_quotation_id, btrim(p_item_name), nullif(btrim(p_product_code), ''), p_description,
    coalesce(p_quantity, 1), v_calc.taxable_amount / greatest(coalesce(p_quantity, 1), 1), v_calc.discount_amount,
    coalesce(p_gst_rate, 0), v_calc.line_total,
    null, null, coalesce(p_discount_type, 'FIXED'), coalesce(p_discount, 0), 'NONE', coalesce(p_gst_rate, 0),
    v_calc.base_amount, v_calc.taxable_amount, v_calc.tax_amount, p_notes
  ) returning * into v_row;

  update public.retail_quotations set total_amount = coalesce(total_amount, 0) + v_row.line_total where id = p_quotation_id;

  perform public.staff_write_audit('retail_quotation', p_quotation_id, 'ADD_MANUAL_ITEM', null,
    jsonb_build_object('item_name', p_item_name, 'line_total', v_calc.line_total), v_quotation.department_id);
  return v_row;
end $function$;
grant execute on function public.retail_add_manual_quotation_item(uuid, text, text, text, numeric, numeric, text, numeric, numeric, text) to authenticated;

do $$
begin
  execute 'revoke all on function public.retail_create_quotation(uuid, text, text, uuid, date, date, numeric, numeric, text, boolean, jsonb, uuid, text, text, text, uuid, uuid) from public, anon';
  execute 'revoke all on function public.retail_add_quotation_item_from_scan(uuid, text, numeric, numeric, text, text, numeric, text) from public, anon';
  execute 'revoke all on function public.retail_add_manual_quotation_item(uuid, text, text, text, numeric, numeric, text, numeric, numeric, text) from public, anon';
end $$;
