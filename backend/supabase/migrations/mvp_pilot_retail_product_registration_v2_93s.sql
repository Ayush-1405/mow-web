-- Retail Product Registration (v2_93s): the SAME Product Master / Inventory Serial / QR engine Godown already uses
-- (retail_products, retail_inventory_items, retail_product_types, retail_generate_stock_code,
-- retail_generate_serial_number, retail_start_stock_intake, retail_confirm_stock_intake) is now also reachable by a
-- plain Retail employee — no separate Retail QR table, no second Product Master. What's new is strictly additive:
-- an approval gate for a NEW model a Retail employee registers (a Godown worker's intake, and anything a Retail
-- Head/oversight registers directly, is unchanged and stays immediately ACTIVE, exactly as before), a text-based
-- duplicate-product search so a salesperson can attach a new serial to an EXISTING approved model instead of
-- minting a second one, an Area field (Display / Sale Floor / Back Store) on the same inventory rows Godown
-- already reads, and Head-only approve/merge actions.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. Schema: approval + origin on the Product Master, Area on the shared inventory rows. Existing rows default to
--    exactly what they already behaviorally are today (ACTIVE / GODOWN) -- zero change for anything already live.
-- ---------------------------------------------------------------------------------------------------------------------------------
create extension if not exists pg_trgm;

alter table public.retail_products
  add column if not exists approval_status text not null default 'ACTIVE',
  add column if not exists origin_department text not null default 'GODOWN';
alter table public.retail_products
  add constraint retail_products_approval_status_check check (approval_status in ('PENDING_APPROVAL', 'ACTIVE'));
alter table public.retail_products
  add constraint retail_products_origin_department_check check (origin_department in ('GODOWN', 'RETAIL'));

alter table public.retail_inventory_items add column if not exists area text;
alter table public.retail_inventory_items
  add constraint retail_inventory_items_area_check check (area is null or area in ('DISPLAY', 'SALE_FLOOR', 'BACK_STORE'));
alter table public.retail_stock add column if not exists area text;
alter table public.retail_stock
  add constraint retail_stock_area_check check (area is null or area in ('DISPLAY', 'SALE_FLOOR', 'BACK_STORE'));

-- Fast fuzzy name search for the duplicate-product check (Part 4 of the spec).
create index if not exists idx_retail_products_name_trgm on public.retail_products using gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. retail_start_stock_intake -- same placeholder-row behavior, widened to also authorize a plain Retail employee
--    (any active member of the Retail department), not only Godown staff/oversight/Godown Head. This is the ONLY
--    change here; the placeholder row shape is identical for both departments.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_start_stock_intake(p_location_id uuid)
returns public.retail_products
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_allowed boolean; v_product public.retail_products; v_placeholder_sku text;
begin
  perform public.staff_assert_operational();
  v_allowed := (coalesce(public.staff_is_godown_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and (coalesce(public.staff_dept_in_hod_scope(public.retail_godown_dept_id()), false)
        or coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false)))
    or coalesce(public.staff_current_department_id() = public.retail_dept_id(), false));
  if not v_allowed then raise exception 'Not authorized to add stock'; end if;
  if not exists (select 1 from public.locations where id = p_location_id and is_active) then
    raise exception 'Invalid location';
  end if;

  v_placeholder_sku := 'PENDING-' || substr(gen_random_uuid()::text, 1, 8);
  insert into public.retail_products (sku, name, unit, created_by)
  values (v_placeholder_sku, 'New item (pending photo)', 'Nos', auth.uid())
  returning * into v_product;

  insert into public.retail_stock (product_id, location_id, on_hand_qty, updated_by)
  values (v_product.id, p_location_id, 0, auth.uid());

  perform public.staff_write_audit('retail_product', v_product.id, 'INTAKE_START', null, jsonb_build_object('location_id', p_location_id), public.retail_godown_dept_id());
  return v_product;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. retail_confirm_stock_intake -- third rewrite of this function (disclosed): adds p_area (Display/Sale Floor/
--    Back Store, additive on every generated inventory/stock row) and p_existing_product_id (the "Use Existing
--    Product" branch of the duplicate check -- attaches new serial(s) to an ALREADY-approved Product Master
--    instead of minting a second model), and tags every brand-new Product Master with who created it and whether
--    it needs Retail Head approval before it can be quoted. A Godown worker's intake, and anything a Retail Head/
--    oversight/global-oversight caller registers directly, is unaffected: still immediately ACTIVE, exactly as
--    every already-tested Godown flow expects.
-- ---------------------------------------------------------------------------------------------------------------------------------
drop function if exists public.retail_confirm_stock_intake(uuid, text, text, text, numeric, text, text, text, boolean, boolean, text);

create or replace function public.retail_confirm_stock_intake(
  p_product_id uuid, p_category text, p_name text, p_unit text default 'Nos', p_quantity numeric default 1,
  p_condition text default 'GOOD', p_rack_location text default null, p_note text default null,
  p_item_level boolean default false, p_category_corrected boolean default false, p_product_type_code text default null,
  p_area text default null, p_existing_product_id uuid default null)
returns public.retail_products
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_product public.retail_products; v_allowed boolean; v_photo_id uuid; v_sku text; v_qty int; v_type_id uuid;
  v_batch_number text; v_location_id uuid; v_i int; v_serial text; v_existing public.retail_products;
  v_is_retail_caller boolean; v_trusted_for_active boolean;
begin
  perform public.staff_assert_operational();
  select * into v_product from public.retail_products where id = p_product_id for update;
  if v_product.id is null then raise exception 'Product not found'; end if;

  v_allowed := (coalesce(v_product.created_by = auth.uid(), false) or coalesce(public.staff_is_godown_staff(), false)
    or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and (coalesce(public.staff_dept_in_hod_scope(public.retail_godown_dept_id()), false)
        or coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false)))
    or coalesce(public.staff_current_department_id() = public.retail_dept_id(), false));
  if not v_allowed then raise exception 'Not authorized to confirm this stock item'; end if;

  if coalesce(btrim(p_category), '') = '' or coalesce(btrim(p_name), '') = '' then
    raise exception 'A category and name are required to confirm this item';
  end if;
  if coalesce(p_condition, 'GOOD') not in ('GOOD', 'DAMAGED') then raise exception 'Invalid condition'; end if;
  if p_area is not null and p_area not in ('DISPLAY', 'SALE_FLOOR', 'BACK_STORE') then raise exception 'Invalid area'; end if;

  select id into v_photo_id from public.staff_attachments
    where entity_type = 'retail_product' and entity_id = p_product_id and purpose = 'proof' and is_active
    order by created_at desc limit 1;
  if v_photo_id is null then raise exception 'A photo of the item is required before it can be confirmed'; end if;

  select location_id into v_location_id from public.retail_stock where product_id = p_product_id limit 1;
  v_qty := greatest(coalesce(p_quantity, 1)::int, 1);
  v_batch_number := public.retail_generate_batch_number();

  -- "Use Existing Product": the duplicate-check dialog's [Use Existing Product] choice. Never mints a second model
  -- code -- just adds v_qty new physical serials under the model the worker confirmed already exists, using this
  -- intake's own photo, and discards the empty placeholder row retail_start_stock_intake created for this attempt.
  if p_existing_product_id is not null then
    select * into v_existing from public.retail_products where id = p_existing_product_id and is_active for update;
    if v_existing.id is null then raise exception 'Selected existing product could not be found'; end if;
    if v_existing.approval_status <> 'ACTIVE' then
      raise exception 'The existing product is still pending approval — wait for it to be approved before adding more serials';
    end if;

    for v_i in 1..v_qty loop
      v_serial := public.retail_generate_serial_number(p_existing_product_id);
      insert into public.retail_inventory_items (product_id, serial_number, status, location_id, rack_location, area, condition, batch_number, created_by)
      values (p_existing_product_id, v_serial, case when p_condition = 'DAMAGED' then 'DAMAGED' else 'AVAILABLE' end,
        v_location_id, p_rack_location, p_area, coalesce(p_condition, 'GOOD'), v_batch_number, auth.uid());

      insert into public.staff_attachments (entity_type, entity_id, file_type, storage_path, original_filename, mime_type, file_size, uploaded_by, is_confidential, purpose, storage_bucket)
      select 'retail_inventory_item', (select id from public.retail_inventory_items where serial_number = v_serial),
        a.file_type, a.storage_path, a.original_filename, a.mime_type, a.file_size, a.uploaded_by, a.is_confidential, 'proof', a.storage_bucket
      from public.staff_attachments a where a.id = v_photo_id;
    end loop;

    -- The staged photo now lives on each new serial; the placeholder product/stock scaffolding is discarded.
    delete from public.staff_attachments where id = v_photo_id;
    delete from public.retail_stock where product_id = p_product_id;
    delete from public.retail_products where id = p_product_id;

    perform public.staff_write_audit('retail_product', p_existing_product_id, 'INTAKE_ADD_SERIALS_EXISTING', null,
      jsonb_build_object('quantity', v_qty, 'batch_number', v_batch_number, 'condition', p_condition), public.retail_dept_id());
    return v_existing;
  end if;

  -- Brand-new Product Master (unchanged core logic from v2_93r), now tagged with who created it and whether it
  -- needs Retail Head approval before anyone can add it to a quotation.
  if p_product_type_code is not null then
    select id into v_type_id from public.retail_product_types where code = upper(btrim(p_product_type_code));
  end if;

  v_is_retail_caller := coalesce(public.staff_current_department_id() = public.retail_dept_id(), false);
  v_trusted_for_active := (coalesce(public.staff_is_godown_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and (coalesce(public.staff_dept_in_hod_scope(public.retail_godown_dept_id()), false)
        or coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false))));

  v_sku := public.retail_generate_stock_code(coalesce(p_product_type_code, p_category));

  update public.retail_products set
    sku = v_sku, name = btrim(p_name), category = btrim(p_category), unit = coalesce(nullif(btrim(p_unit), ''), 'Nos'),
    image_path = v_photo_id::text, confirmed_at = now(), condition = coalesce(p_condition, 'GOOD'), intake_note = p_note,
    category_confirmed_manually = coalesce(p_category_corrected, false), batch_number = v_batch_number,
    batch_item_level = coalesce(p_item_level, false), batch_total_qty = v_qty, product_type_id = v_type_id,
    origin_department = case when v_is_retail_caller then 'RETAIL' else 'GODOWN' end,
    approval_status = case when v_trusted_for_active then 'ACTIVE' else 'PENDING_APPROVAL' end
  where id = p_product_id returning * into v_product;

  if coalesce(p_item_level, false) then
    for v_i in 1..v_qty loop
      v_serial := public.retail_generate_serial_number(p_product_id);
      insert into public.retail_inventory_items (product_id, serial_number, status, location_id, rack_location, area, condition, batch_number, created_by)
      values (p_product_id, v_serial, case when p_condition = 'DAMAGED' then 'DAMAGED' else 'AVAILABLE' end,
        v_location_id, p_rack_location, p_area, coalesce(p_condition, 'GOOD'), v_batch_number, auth.uid());

      insert into public.staff_attachments (entity_type, entity_id, file_type, storage_path, original_filename, mime_type, file_size, uploaded_by, is_confidential, purpose, storage_bucket)
      select 'retail_inventory_item', (select id from public.retail_inventory_items where serial_number = v_serial),
        a.file_type, a.storage_path, a.original_filename, a.mime_type, a.file_size, a.uploaded_by, a.is_confidential, 'proof', a.storage_bucket
      from public.staff_attachments a where a.id = v_photo_id;
    end loop;
  else
    update public.retail_stock set
      on_hand_qty = case when coalesce(p_condition, 'GOOD') = 'GOOD' then v_qty else 0 end,
      damaged_qty = case when p_condition = 'DAMAGED' then v_qty else 0 end,
      rack_location = coalesce(p_rack_location, rack_location), area = coalesce(p_area, area), updated_by = auth.uid(), updated_at = now()
    where product_id = p_product_id;
  end if;

  perform public.staff_write_audit('retail_product', p_product_id, 'INTAKE_CONFIRM', null,
    jsonb_build_object('sku', v_sku, 'category', p_category, 'quantity', v_qty, 'batch_number', v_batch_number,
      'item_level', p_item_level, 'condition', p_condition, 'approval_status', v_product.approval_status), public.retail_godown_dept_id());

  if v_product.approval_status = 'PENDING_APPROVAL' then
    perform public.staff_notify_dept_leadership('RETAIL', 'retail_product', p_product_id,
      'New product pending approval: ' || v_sku || ' — ' || p_name,
      'નવું ઉત્પાદન મંજૂરીની રાહમાં: ' || v_sku || ' — ' || p_name);
  end if;

  return v_product;
end $function$;

grant execute on function public.retail_confirm_stock_intake(uuid, text, text, text, numeric, text, text, text, boolean, boolean, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. retail_find_similar_products -- the duplicate-product search (Part 4). Photo-similarity is disclosed as out of
--    scope (no image-embedding infrastructure exists in this project); this matches on product type + fuzzy name
--    (pg_trgm), which is the same "is this really a new model?" question a human would ask first. Read-only.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_find_similar_products(p_product_type_code text, p_name text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_allowed boolean; v_type_id uuid; v_name text := btrim(coalesce(p_name, '')); v_result jsonb;
begin
  perform public.staff_assert_operational();
  v_allowed := (coalesce(public.staff_is_godown_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or coalesce(public.staff_current_department_id() in (select id from public.departments where code = 'RETAIL'), false)
    or (coalesce(public.staff_is_dept_head(), false) and (coalesce(public.staff_dept_in_hod_scope(public.retail_godown_dept_id()), false)
        or coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false))));
  if not v_allowed then raise exception 'Not authorized to search products'; end if;
  if v_name = '' then return '[]'::jsonb; end if;

  if p_product_type_code is not null then
    select id into v_type_id from public.retail_product_types where code = upper(btrim(p_product_type_code));
  end if;

  select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) into v_result from (
    select p.id, p.sku, p.name, p.category, p.material, p.dimensions, p.color_finish, p.approval_status,
      similarity(p.name, v_name) as score,
      (select s.storage_path from public.staff_attachments s where s.entity_type = 'retail_product' and s.entity_id = p.id and s.purpose = 'proof' and s.is_active order by s.created_at desc limit 1) as photo_path,
      coalesce((select sum(st.on_hand_qty) from public.retail_stock st where st.product_id = p.id), 0)
        + coalesce((select count(*) from public.retail_inventory_items ii where ii.product_id = p.id and ii.status = 'AVAILABLE'), 0) as available_qty
    from public.retail_products p
    where p.is_active and p.sku not like 'PENDING-%'
      and (v_type_id is null or p.product_type_id = v_type_id)
      and (similarity(p.name, v_name) > 0.2 or p.name ilike '%' || v_name || '%')
    order by score desc
    limit 5
  ) x;

  return v_result;
end $function$;
grant execute on function public.retail_find_similar_products(text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. retail_approve_product -- Retail Head/oversight reviews a PENDING_APPROVAL Product Master: corrects category/
--    type, adds description/material/dimensions/finish, sets MRP/selling price/discount-floor/GST/warranty, and
--    flips it to ACTIVE (only then can it be added to a quotation — enforced server-side, part 6 below). Every
--    field change is versioned exactly like the existing retail_update_product_pricing/_details (never a live
--    price change on an already-quoted item — those functions remain untouched and available for LATER edits).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_approve_product(
  p_product_id uuid, p_product_type_code text, p_name text, p_material text, p_color_finish text, p_dimensions text,
  p_description text, p_warranty_text text, p_gst_percent numeric, p_mrp numeric, p_selling_price numeric,
  p_min_approved_price numeric, p_reason text)
returns public.retail_products
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_allowed boolean; v_old public.retail_products; v_row public.retail_products; v_type_id uuid;
begin
  perform public.staff_assert_operational();
  v_allowed := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false)));
  if not v_allowed then raise exception 'Only Retail Head/Management may approve a product'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to approve this product'; end if;

  select * into v_old from public.retail_products where id = p_product_id for update;
  if v_old.id is null then raise exception 'Product not found'; end if;
  if v_old.approval_status = 'ACTIVE' then raise exception 'This product is already approved'; end if;

  if p_product_type_code is not null then
    select id into v_type_id from public.retail_product_types where code = upper(btrim(p_product_type_code));
  end if;

  update public.retail_products set
    product_type_id = coalesce(v_type_id, product_type_id),
    name = coalesce(nullif(btrim(p_name), ''), name), material = p_material, color_finish = p_color_finish, dimensions = p_dimensions,
    description = p_description, warranty_text = p_warranty_text, gst_percent = p_gst_percent,
    mrp = p_mrp, selling_price = p_selling_price, min_approved_price = p_min_approved_price,
    approval_status = 'ACTIVE', updated_by = auth.uid(), updated_at = now()
  where id = p_product_id returning * into v_row;

  insert into public.retail_product_price_history (product_id, field_name, old_value, new_value, changed_by, reason) values
    (p_product_id, 'approval_status', v_old.approval_status, 'ACTIVE', auth.uid(), p_reason),
    (p_product_id, 'mrp', v_old.mrp::text, p_mrp::text, auth.uid(), p_reason),
    (p_product_id, 'selling_price', v_old.selling_price::text, p_selling_price::text, auth.uid(), p_reason),
    (p_product_id, 'min_approved_price', v_old.min_approved_price::text, p_min_approved_price::text, auth.uid(), p_reason),
    (p_product_id, 'details', to_jsonb(v_old)::text, to_jsonb(v_row)::text, auth.uid(), p_reason);

  perform public.staff_write_audit('retail_product', p_product_id, 'PRODUCT_APPROVED',
    jsonb_build_object('approval_status', v_old.approval_status), jsonb_build_object('approval_status', 'ACTIVE'), public.retail_dept_id(), p_reason);

  if v_old.created_by is not null then
    perform public.staff_notify_assignment(v_old.created_by, 'retail_product', p_product_id,
      'Your product registration was approved: ' || v_row.sku || ' — ' || v_row.name,
      'તમારી ઉત્પાદન નોંધણી મંજૂર થઈ: ' || v_row.sku || ' — ' || v_row.name);
  end if;

  return v_row;
end $function$;
grant execute on function public.retail_approve_product(uuid, text, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 6. retail_merge_duplicate_products -- Retail Head/oversight cleanup for two Product Masters later discovered to
--    be the same model (Part 5). Moves every physical serial and pooled stock quantity onto the surviving product
--    and retires (never deletes) the duplicate, preserving its full audit/price history.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_merge_duplicate_products(p_from_product_id uuid, p_into_product_id uuid, p_reason text)
returns public.retail_products
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_allowed boolean; v_from public.retail_products; v_into public.retail_products; v_src public.retail_stock; v_dst_id uuid;
begin
  perform public.staff_assert_operational();
  v_allowed := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false)));
  if not v_allowed then raise exception 'Only Retail Head/Management may merge products'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to merge products'; end if;
  if p_from_product_id = p_into_product_id then raise exception 'Cannot merge a product into itself'; end if;

  select * into v_from from public.retail_products where id = p_from_product_id for update;
  select * into v_into from public.retail_products where id = p_into_product_id for update;
  if v_from.id is null or v_into.id is null then raise exception 'Both products must exist'; end if;
  if v_into.approval_status <> 'ACTIVE' or not v_into.is_active then raise exception 'The surviving product must be an approved, active model'; end if;

  update public.retail_inventory_items set product_id = p_into_product_id, updated_at = now() where product_id = p_from_product_id;

  -- retail_stock has no unique (product_id, location_id) constraint to ON CONFLICT against -- fold each of the
  -- "from" product's per-location rows into the matching "into" row by hand (or create one if none exists yet).
  for v_src in select * from public.retail_stock where product_id = p_from_product_id loop
    select id into v_dst_id from public.retail_stock where product_id = p_into_product_id and location_id = v_src.location_id;
    if v_dst_id is null then
      insert into public.retail_stock (product_id, location_id, on_hand_qty, damaged_qty, incoming_qty, rack_location, area, updated_by)
      values (p_into_product_id, v_src.location_id, v_src.on_hand_qty, v_src.damaged_qty, v_src.incoming_qty, v_src.rack_location, v_src.area, auth.uid());
    else
      update public.retail_stock set on_hand_qty = on_hand_qty + v_src.on_hand_qty, damaged_qty = damaged_qty + v_src.damaged_qty,
        incoming_qty = incoming_qty + v_src.incoming_qty, updated_by = auth.uid(), updated_at = now()
      where id = v_dst_id;
    end if;
  end loop;
  update public.retail_stock set on_hand_qty = 0, damaged_qty = 0, incoming_qty = 0, updated_by = auth.uid(), updated_at = now()
  where product_id = p_from_product_id;

  update public.retail_products set is_active = false, updated_by = auth.uid(), updated_at = now() where id = p_from_product_id;

  insert into public.retail_product_price_history (product_id, field_name, old_value, new_value, changed_by, reason) values
    (p_from_product_id, 'merged_into', v_from.sku, v_into.sku, auth.uid(), p_reason),
    (p_into_product_id, 'merged_from', v_from.sku, v_into.sku, auth.uid(), p_reason);

  perform public.staff_write_audit('retail_product', p_from_product_id, 'PRODUCT_MERGED', jsonb_build_object('is_active', true), jsonb_build_object('is_active', false, 'merged_into', v_into.sku), public.retail_dept_id(), p_reason);
  perform public.staff_write_audit('retail_product', p_into_product_id, 'PRODUCT_MERGE_RECEIVED', null, jsonb_build_object('merged_from', v_from.sku), public.retail_dept_id(), p_reason);

  return v_into;
end $function$;
grant execute on function public.retail_merge_duplicate_products(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 7. retail_scan_product -- additive fields only (same signature): approval_status/origin_department so the scan
--    screen can show a clear "Pending Retail Head Approval" state, and each serial's area.
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

  v_show_price := (coalesce(public.staff_has_global_oversight(), false)
    or coalesce(public.staff_current_department_id() in (select id from public.departments where code = 'RETAIL'), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false))
    or (coalesce(public.staff_is_supervisor(), false) and coalesce(public.staff_current_department_id() = public.retail_dept_id(), false)));

  select jsonb_agg(jsonb_build_object('location_id', s.location_id, 'location_name', l.name_en, 'on_hand_qty', s.on_hand_qty,
      'damaged_qty', s.damaged_qty, 'rack_location', s.rack_location, 'area', s.area))
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
      'approval_status', v_product.approval_status, 'origin_department', v_product.origin_department,
      'mrp', case when v_show_price then v_product.mrp else null end,
      'selling_price', case when v_show_price then v_product.selling_price else null end,
      'min_approved_price', case when v_show_price then v_product.min_approved_price else null end),
    'serial', case when v_item.id is null then null else jsonb_build_object(
      'id', v_item.id, 'serial_number', v_item.serial_number, 'status', v_item.status, 'condition', v_item.condition,
      'rack_location', v_item.rack_location, 'area', v_item.area, 'sold_at', v_item.sold_at) end,
    'stock', coalesce(v_stock, '[]'::jsonb), 'reserved_for', coalesce(v_reserved, '[]'::jsonb), 'movements', coalesce(v_movements, '[]'::jsonb)
  );
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 8. retail_add_quotation_item_from_scan -- the server-side enforcement of "must not become available for final
--    quotation until approved" (Part 6). Never relies on the frontend hiding the Add-to-Quotation button.
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

  if v_product.approval_status <> 'ACTIVE' then
    raise exception 'This product is pending Retail Head approval and cannot be added to a quotation yet';
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

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 9. retail_pending_product_approvals -- Retail Head's approval queue (Part 6/14). Read-only list, same
--    authorization shape as retail_approve_product.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_pending_product_approvals()
returns table (id uuid, sku text, name text, category text, product_type_name text, origin_department text,
  created_by uuid, created_by_name text, created_at timestamptz, photo_path text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select p.id, p.sku, p.name, p.category, pt.name_en, p.origin_department, p.created_by, up.full_name, p.created_at,
    (select s.storage_path from public.staff_attachments s where s.entity_type = 'retail_product' and s.entity_id = p.id and s.purpose = 'proof' and s.is_active order by s.created_at desc limit 1)
  from public.retail_products p
  left join public.retail_product_types pt on pt.id = p.product_type_id
  left join public.user_profiles up on up.id = p.created_by
  where p.approval_status = 'PENDING_APPROVAL' and p.is_active
    and (coalesce(public.staff_has_global_oversight(), false)
      or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false)))
  order by p.created_at asc;
$function$;
grant execute on function public.retail_pending_product_approvals() to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 10. Dashboard KPI: how many products are waiting for the caller's own approval (0 for anyone who isn't Retail
--     Head/oversight — staff_dept_in_hod_scope/staff_has_global_oversight already gate this, this is just a count).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_count_pending_product_approvals()
returns int
language sql
stable
security definer
set search_path to 'public'
as $function$
  select count(*)::int from public.retail_products p
  where p.approval_status = 'PENDING_APPROVAL' and p.is_active
    and (coalesce(public.staff_has_global_oversight(), false)
      or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false)));
$function$;
grant execute on function public.retail_count_pending_product_approvals() to authenticated;
