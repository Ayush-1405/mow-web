-- Godown worker simplification (v2_93q): five-button worker home, safe category-prefixed product codes with
-- item-level batch/QR generation, Good/Damaged condition + rack + note on intake, a real Godown->Display stock
-- move, Head-only inventory correction with a mandatory reason, a QR "scan to detail" lookup, a worker's own
-- "My Work Today" queue, and two genuinely-missing salesperson notifications (packed, accepted by Godown).
--
-- Confirmed live before writing this: retail_products has 5 rows, all still unconfirmed 'PENDING-...' placeholders
-- (created_at from earlier dev/testing of GodownStockIntake.jsx) -- zero real confirmed SKUs exist, so changing the
-- code format (3-digit -> 6-digit, regex-scan -> a real locked counter) is safe and breaks nothing live.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. Schema -- additive only.
-- ---------------------------------------------------------------------------------------------------------------------------------

-- Race-free, permanent per-category-prefix sequence (replaces retail_generate_stock_code's old regexp-scan-max
-- approach, which was never actually safe under concurrent intakes despite its retry loop -- two transactions could
-- both read the same "next" value before either committed). A single UPDATE on one locked row is race-free because
-- Postgres serializes concurrent UPDATEs to the same row.
create table if not exists public.retail_product_code_counters (
  category_code text primary key,
  next_seq int not null default 1
);
insert into public.retail_product_code_counters (category_code) values
  ('CHR'), ('SOF'), ('BED'), ('TBL'), ('DIN'), ('WRD'), ('CAB'), ('OFF'), ('DEC'), ('OTH')
on conflict do nothing;

-- Same race-free pattern for the daily Goods-Received-Note batch number (GRN-YYYYMMDD-NNN).
create table if not exists public.retail_batch_number_counters (
  batch_day date primary key,
  next_seq int not null default 1
);

alter table public.retail_products
  add column if not exists category_confirmed_manually boolean not null default false,
  add column if not exists condition text not null default 'GOOD',
  add column if not exists intake_note text,
  add column if not exists batch_number text,
  add column if not exists batch_item_level boolean not null default false,
  add column if not exists batch_total_qty numeric;
alter table public.retail_products drop constraint if exists retail_products_condition_check;
alter table public.retail_products add constraint retail_products_condition_check check (condition in ('GOOD', 'DAMAGED'));
create index if not exists retail_products_batch_number_idx on public.retail_products (batch_number) where batch_number is not null;

-- One product can only have one stock row per location -- also lets Move-to-Display use a safe upsert.
create unique index if not exists retail_stock_product_location_uq on public.retail_stock (product_id, location_id);

-- Movement history -- the "movement history, for authorized users" a QR scan must show, and the record a
-- Godown->Display move actually leaves behind (a stock transfer that only relabels a row is not a real movement).
create table if not exists public.retail_stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.retail_products(id),
  from_location_id uuid references public.locations(id),
  to_location_id uuid not null references public.locations(id),
  quantity numeric not null check (quantity > 0),
  reason text,
  moved_by uuid not null references public.user_profiles(id),
  moved_at timestamptz not null default now()
);
create index if not exists retail_stock_movements_product_idx on public.retail_stock_movements (product_id, moved_at desc);
alter table public.retail_stock_movements enable row level security;
drop policy if exists retail_stock_movements_select on public.retail_stock_movements;
create policy retail_stock_movements_select on public.retail_stock_movements for select using (
  public.staff_has_global_oversight() or public.staff_current_department_id() = public.retail_godown_dept_id()
  or public.staff_current_department_id() in (select id from public.departments where code = 'RETAIL')
  or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(public.retail_godown_dept_id()) or public.staff_dept_in_hod_scope(public.retail_dept_id())))
);
-- No insert/update/delete policy for authenticated: every write goes through retail_move_stock_to_display (SECURITY DEFINER).

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. retail_generate_batch_number -- one GRN receipt number per intake (shared by every item code in that batch).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_generate_batch_number()
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_day date := current_date; v_seq int;
begin
  insert into public.retail_batch_number_counters (batch_day, next_seq) values (v_day, 1) on conflict (batch_day) do nothing;
  update public.retail_batch_number_counters set next_seq = next_seq + 1 where batch_day = v_day returning next_seq - 1 into v_seq;
  return 'GRN-' || to_char(v_day, 'YYYYMMDD') || '-' || lpad(v_seq::text, 3, '0');
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. retail_generate_stock_code -- fixed category-prefix map (per the pilot's own spec), 6-digit sequence, race-free.
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

  insert into public.retail_product_code_counters (category_code, next_seq) values (v_prefix, 1) on conflict (category_code) do nothing;
  update public.retail_product_code_counters set next_seq = next_seq + 1 where category_code = v_prefix returning next_seq - 1 into v_seq;

  return v_prefix || '-' || lpad(v_seq::text, 6, '0');
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. retail_confirm_stock_intake -- rewritten: Good/Damaged condition, rack location, optional note, and real
--    batch/item-level code generation ("5 physically separate chairs" -> one GRN batch, 5 unique codes/QRs).
--    Signature widened (new trailing params, all defaulted) -- existing callers with the old 5-arg call keep working.
--    Return type changed from a single row to SETOF, since a batch can now be more than one row.
-- ---------------------------------------------------------------------------------------------------------------------------------
drop function if exists public.retail_confirm_stock_intake(uuid, text, text, text, numeric);

create or replace function public.retail_confirm_stock_intake(
  p_product_id uuid, p_category text, p_name text, p_unit text default 'Nos', p_quantity numeric default 1,
  p_condition text default 'GOOD', p_rack_location text default null, p_note text default null,
  p_item_level boolean default false, p_category_corrected boolean default false)
returns setof public.retail_products
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_product public.retail_products; v_item public.retail_products; v_allowed boolean; v_photo_id uuid; v_sku text; v_qty int;
  v_batch_number text; v_location_id uuid; v_i int; v_new_id uuid; v_att record;
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
  select * into v_att from public.staff_attachments where id = v_photo_id;

  select location_id into v_location_id from public.retail_stock where product_id = p_product_id limit 1;

  v_qty := greatest(coalesce(p_quantity, 1)::int, 1);
  v_batch_number := public.retail_generate_batch_number();

  -- Item #1 reuses the placeholder row created by retail_start_stock_intake.
  v_sku := public.retail_generate_stock_code(p_category);
  update public.retail_products set
    sku = v_sku, name = btrim(p_name), category = btrim(p_category), unit = coalesce(nullif(btrim(p_unit), ''), 'Nos'),
    image_path = v_photo_id::text, confirmed_at = now(), condition = coalesce(p_condition, 'GOOD'), intake_note = p_note,
    category_confirmed_manually = coalesce(p_category_corrected, false), batch_number = v_batch_number,
    batch_item_level = coalesce(p_item_level, false), batch_total_qty = v_qty
  where id = p_product_id returning * into v_product;

  update public.retail_stock set
    on_hand_qty = case when coalesce(p_condition, 'GOOD') = 'GOOD' then (case when p_item_level then 1 else v_qty end) else 0 end,
    damaged_qty = case when p_condition = 'DAMAGED' then (case when p_item_level then 1 else v_qty end) else 0 end,
    rack_location = coalesce(p_rack_location, rack_location), updated_by = auth.uid(), updated_at = now()
  where product_id = p_product_id;

  perform public.staff_write_audit('retail_product', p_product_id, 'INTAKE_CONFIRM', null,
    jsonb_build_object('sku', v_sku, 'category', p_category, 'quantity', v_qty, 'batch_number', v_batch_number,
      'item_level', p_item_level, 'condition', p_condition), public.retail_godown_dept_id());

  return next v_product;

  -- Additional item-level rows #2..N -- only when the worker asked to track each physical unit separately.
  -- Each gets its own permanent code/QR and its own stock row (qty 1), sharing the SAME uploaded photo (one photo
  -- of the batch, not a re-upload per item) and the SAME batch_number.
  if coalesce(p_item_level, false) and v_qty > 1 then
    for v_i in 2..v_qty loop
      v_sku := public.retail_generate_stock_code(p_category);
      insert into public.retail_products (
        sku, name, category, unit, image_path, created_by, confirmed_at, condition, intake_note,
        category_confirmed_manually, batch_number, batch_item_level, batch_total_qty
      ) values (
        v_sku, btrim(p_name), btrim(p_category), coalesce(nullif(btrim(p_unit), ''), 'Nos'), v_photo_id::text, auth.uid(), now(),
        coalesce(p_condition, 'GOOD'), p_note, coalesce(p_category_corrected, false), v_batch_number, true, v_qty
      ) returning * into v_item;

      insert into public.staff_attachments (entity_type, entity_id, file_type, storage_path, original_filename, mime_type, file_size, uploaded_by, is_confidential, purpose, storage_bucket)
      values ('retail_product', v_item.id, v_att.file_type, v_att.storage_path, v_att.original_filename, v_att.mime_type, v_att.file_size, v_att.uploaded_by, v_att.is_confidential, 'proof', v_att.storage_bucket);

      insert into public.retail_stock (product_id, location_id, on_hand_qty, damaged_qty, rack_location, updated_by)
      values (v_item.id, v_location_id, case when coalesce(p_condition,'GOOD') = 'GOOD' then 1 else 0 end,
        case when p_condition = 'DAMAGED' then 1 else 0 end, p_rack_location, auth.uid());

      perform public.staff_write_audit('retail_product', v_item.id, 'INTAKE_CONFIRM_BATCH_ITEM', null,
        jsonb_build_object('sku', v_sku, 'batch_number', v_batch_number, 'item_index', v_i), public.retail_godown_dept_id());

      return next v_item;
    end loop;
  end if;
  return;
end $function$;

grant execute on function public.retail_confirm_stock_intake(uuid, text, text, text, numeric, text, text, text, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. retail_move_stock_to_display -- the real "Godown Available -> Display Transfer" stock movement (Part 6).
--    Deliberately one tap, not a two-step request/accept: the Godown department already owns both the godown
--    location and the showroom locations' physical stock in this schema (a showroom location row is Retail's own
--    department, but the product/stock rows stay Godown-managed inventory) -- adding an approval gate here would
--    only add friction for a low-literacy worker without a real second authority to approve it. This is a scope
--    decision, disclosed in the end-of-work report, not an oversight.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_move_stock_to_display(p_product_id uuid, p_to_location_id uuid, p_quantity numeric, p_note text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_allowed boolean; v_src public.retail_stock; v_available numeric; v_reserved numeric; v_qty numeric := coalesce(p_quantity, 0);
  v_product public.retail_products;
begin
  perform public.staff_assert_operational();
  v_allowed := (coalesce(public.staff_is_godown_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_godown_dept_id()), false)));
  if not v_allowed then raise exception 'Not authorized to move stock'; end if;
  if v_qty <= 0 then raise exception 'Quantity must be positive'; end if;

  select * into v_product from public.retail_products where id = p_product_id and is_active;
  if v_product.id is null then raise exception 'Product not found'; end if;
  if not exists (select 1 from public.locations where id = p_to_location_id and is_active) then raise exception 'Invalid destination location'; end if;

  select * into v_src from public.retail_stock where product_id = p_product_id and location_id <> p_to_location_id and on_hand_qty > 0
    order by on_hand_qty desc limit 1 for update;
  if v_src.id is null then raise exception 'No source stock found for this product'; end if;

  select coalesce(sum(fi.quantity), 0) into v_reserved
    from public.retail_fulfilment_items fi join public.retail_order_items oi on oi.id = fi.order_item_id
    where fi.mode = 'STOCK' and fi.status not in ('CANCELLED') and upper(oi.sku) = upper(v_product.sku);

  v_available := greatest(v_src.on_hand_qty - coalesce(v_reserved, 0) - v_src.damaged_qty, 0);
  if v_qty > v_available then raise exception 'Only % available to move', v_available; end if;

  update public.retail_stock set on_hand_qty = on_hand_qty - v_qty, updated_by = auth.uid(), updated_at = now() where id = v_src.id;

  insert into public.retail_stock (product_id, location_id, on_hand_qty, updated_by)
  values (p_product_id, p_to_location_id, v_qty, auth.uid())
  on conflict (product_id, location_id) do update set on_hand_qty = public.retail_stock.on_hand_qty + excluded.on_hand_qty, updated_by = auth.uid(), updated_at = now();

  insert into public.retail_stock_movements (product_id, from_location_id, to_location_id, quantity, reason, moved_by)
  values (p_product_id, v_src.location_id, p_to_location_id, v_qty, p_note, auth.uid());

  perform public.staff_write_audit('retail_product', p_product_id, 'MOVE_TO_DISPLAY', jsonb_build_object('location_id', v_src.location_id),
    jsonb_build_object('location_id', p_to_location_id, 'quantity', v_qty), public.retail_godown_dept_id());
end $function$;

grant execute on function public.retail_move_stock_to_display(uuid, uuid, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 6. retail_correct_stock -- Head/Supervisor/oversight-only, a mandatory reason, always audited (Part 16).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_correct_stock(p_product_id uuid, p_location_id uuid, p_new_on_hand_qty numeric, p_new_damaged_qty numeric, p_reason text)
returns public.retail_stock
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_allowed boolean; v_old public.retail_stock; v_row public.retail_stock;
begin
  perform public.staff_assert_operational();
  v_allowed := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_godown_dept_id()), false))
    or (coalesce(public.staff_is_supervisor(), false) and coalesce(public.staff_current_department_id() = public.retail_godown_dept_id(), false)));
  if not v_allowed then raise exception 'Only the Godown Head/Supervisor/Management may correct inventory'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to correct inventory'; end if;
  if p_new_on_hand_qty < 0 or coalesce(p_new_damaged_qty, 0) < 0 then raise exception 'Quantities cannot be negative'; end if;

  select * into v_old from public.retail_stock where product_id = p_product_id and location_id = p_location_id for update;
  if v_old.id is null then raise exception 'Stock row not found'; end if;

  update public.retail_stock set on_hand_qty = p_new_on_hand_qty, damaged_qty = coalesce(p_new_damaged_qty, damaged_qty), updated_by = auth.uid(), updated_at = now()
  where id = v_old.id returning * into v_row;

  perform public.staff_write_audit('retail_product', p_product_id, 'STOCK_CORRECTION',
    jsonb_build_object('on_hand_qty', v_old.on_hand_qty, 'damaged_qty', v_old.damaged_qty),
    jsonb_build_object('on_hand_qty', v_row.on_hand_qty, 'damaged_qty', v_row.damaged_qty), public.retail_godown_dept_id(), p_reason);
  return v_row;
end $function$;

grant execute on function public.retail_correct_stock(uuid, uuid, numeric, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 7. retail_scan_product -- the QR-scan / product-detail lookup. Looked up by SKU (the QR's own payload -- see
--    frontend: the QR encodes an internal app URL carrying the SKU, never raw stock/financial data).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_scan_product(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_product public.retail_products; v_stock jsonb; v_reserved jsonb; v_movements jsonb; v_allowed boolean;
begin
  perform public.staff_assert_operational();
  select * into v_product from public.retail_products where upper(sku) = upper(btrim(coalesce(p_code, ''))) and is_active limit 1;
  if v_product.id is null then return null; end if;

  v_allowed := (coalesce(public.staff_is_godown_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or coalesce(public.staff_current_department_id() in (select id from public.departments where code = 'RETAIL'), false)
    or (coalesce(public.staff_is_dept_head(), false) and (coalesce(public.staff_dept_in_hod_scope(public.retail_godown_dept_id()), false) or coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false))));
  if not v_allowed then raise exception 'Not authorized to view this product'; end if;

  select jsonb_agg(jsonb_build_object('location_id', s.location_id, 'location_name', l.name_en, 'on_hand_qty', s.on_hand_qty,
      'damaged_qty', s.damaged_qty, 'rack_location', s.rack_location))
    into v_stock from public.retail_stock s join public.locations l on l.id = s.location_id where s.product_id = v_product.id;

  select jsonb_agg(jsonb_build_object('order_id', o.id, 'order_number', o.order_number, 'customer_name', o.customer_name, 'quantity', fi.quantity))
    into v_reserved
    from public.retail_fulfilment_items fi
    join public.retail_order_items oi on oi.id = fi.order_item_id
    join public.retail_orders o on o.id = fi.order_id
    where fi.mode = 'STOCK' and fi.status not in ('CANCELLED') and upper(oi.sku) = upper(v_product.sku);

  select jsonb_agg(jsonb_build_object('from_location', fl.name_en, 'to_location', tl.name_en, 'quantity', m.quantity, 'moved_at', m.moved_at) order by m.moved_at desc)
    into v_movements
    from public.retail_stock_movements m left join public.locations fl on fl.id = m.from_location_id join public.locations tl on tl.id = m.to_location_id
    where m.product_id = v_product.id;

  return jsonb_build_object(
    'product', jsonb_build_object('id', v_product.id, 'sku', v_product.sku, 'name', v_product.name, 'category', v_product.category,
      'unit', v_product.unit, 'condition', v_product.condition, 'intake_note', v_product.intake_note,
      'batch_number', v_product.batch_number, 'created_at', v_product.created_at, 'confirmed_at', v_product.confirmed_at),
    'stock', coalesce(v_stock, '[]'::jsonb), 'reserved_for', coalesce(v_reserved, '[]'::jsonb), 'movements', coalesce(v_movements, '[]'::jsonb)
  );
end $function$;

grant execute on function public.retail_scan_product(text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 8. retail_godown_my_work_today -- a plain worker's own personal queue (Part 15). The Head/Supervisor's
--    department-wide view is the existing GodownHandovers.jsx "Pending Handovers" section (already unfiltered by
--    assignee within department scope) -- this is deliberately the complementary, narrower, personal view.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_godown_my_work_today()
returns table(item_type text, entity_id uuid, order_id uuid, order_number text, customer_name text, title text, is_overdue boolean)
language sql
stable
security definer
set search_path to 'public'
as $$
  select 'HANDOVER_PENDING', h.id, h.order_id, o.order_number, o.customer_name, 'New request — review, then accept', h.expected_handover_at < now()
    from public.retail_godown_handovers h join public.retail_orders o on o.id = h.order_id
    where h.status = 'PENDING' and (h.responsible_user_id = auth.uid() or h.responsible_user_id is null)
  union all
  select 'PACKING_PENDING', p.id, p.order_id, o.order_number, o.customer_name, 'Pack this order', false
    from public.retail_packing_records p join public.retail_orders o on o.id = p.order_id
    where p.status in ('AWAITING_PACKING', 'IN_PROGRESS')
      and exists (select 1 from public.retail_godown_handovers h where h.packing_id = p.id and h.responsible_user_id = auth.uid())
  union all
  select 'DISPATCH_PENDING', d.id, d.order_id, o.order_number, o.customer_name, 'Dispatch this order', false
    from public.retail_dispatch_records d join public.retail_orders o on o.id = d.order_id
    where d.dispatched_at is null
      and exists (select 1 from public.retail_godown_handovers h where h.order_id = d.order_id and h.responsible_user_id = auth.uid())
  union all
  select 'DELIVERY_DUE_TODAY', dl.id, dl.order_id, o.order_number, o.customer_name, 'Deliver today', false
    from public.retail_deliveries dl join public.retail_orders o on o.id = dl.order_id
    where dl.scheduled_at::date = current_date and dl.stage not in ('DELIVERY_SUCCESSFUL', 'COMPLETED')
      and exists (select 1 from public.retail_godown_handovers h where h.order_id = dl.order_id and h.responsible_user_id = auth.uid());
$$;

grant execute on function public.retail_godown_my_work_today() to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 9. retail_godown_reports_summary -- Part 17's simple, live, Head/Supervisor/Management-only worker and category/rack
--    counts. Acceptance/packing-time averages and employee-wise/proof-compliance analytics are deliberately NOT
--    included here -- disclosed as deferred in the end-of-work report, not silently skipped.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_godown_reports_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_allowed boolean; v_godown uuid := public.retail_godown_dept_id(); v_result jsonb;
begin
  v_allowed := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_godown), false))
    or (coalesce(public.staff_is_supervisor(), false) and coalesce(public.staff_current_department_id() = v_godown, false)));
  if not v_allowed then raise exception 'Reports are limited to the Godown Head/Supervisor/Management'; end if;

  select jsonb_build_object(
    'stock_received_today', (select count(*) from public.retail_products where confirmed_at::date = current_date),
    'available_products', (select count(distinct product_id) from public.retail_stock where on_hand_qty > 0),
    'new_delivery_requests', (select count(*) from public.retail_godown_handovers where status = 'PENDING'),
    'packing_pending', (select count(*) from public.retail_packing_records where status in ('AWAITING_PACKING', 'IN_PROGRESS')),
    'deliveries_today', (select count(*) from public.retail_deliveries where scheduled_at::date = current_date),
    'successful_deliveries_today', (select count(*) from public.retail_deliveries where stage = 'DELIVERY_SUCCESSFUL' and updated_at::date = current_date),
    'failed_or_delayed_deliveries', (select count(*) from public.retail_deliveries where stage = 'DELIVERY_FAILED' or delay_reason is not null),
    'missing_photo_proof', (select count(*) from public.retail_godown_handovers h where h.status = 'ACCEPTED'
      and not exists (select 1 from public.staff_attachments a where a.entity_type = 'retail_godown_handover' and a.entity_id = h.id and a.purpose = 'proof' and a.is_active)),
    'overdue_requests', (select count(*) from public.retail_godown_handovers where status = 'PENDING' and expected_handover_at < now()),
    'category_wise_stock', (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'qty', qty) order by qty desc), '[]'::jsonb) from (
        select coalesce(p.category, 'Uncategorized') category, sum(s.on_hand_qty) qty from public.retail_products p join public.retail_stock s on s.product_id = p.id
        group by 1) x),
    'rack_wise_stock', (select coalesce(jsonb_agg(jsonb_build_object('rack', rack, 'qty', qty) order by qty desc), '[]'::jsonb) from (
        select coalesce(s.rack_location, 'Unassigned') rack, sum(s.on_hand_qty) qty from public.retail_stock s where s.on_hand_qty > 0 group by 1) x)
  ) into v_result;
  return v_result;
end $function$;

grant execute on function public.retail_godown_reports_summary() to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 10. Two genuinely-missing notifications (Parts 9/10): confirmed live these calls did not exist in either function.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_verify_packing(
  p_packing_id uuid, p_items jsonb default '[]'::jsonb, p_qc_status text default 'PASSED'::text,
  p_package_count integer default null::integer, p_condition_notes text default null::text, p_missing_damaged_note text default null::text)
returns public.retail_packing_records
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_row public.retail_packing_records; v_order public.retail_orders; v_allowed boolean; v_has_photo boolean; v_it jsonb; v_new_status text;
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

  v_new_status := case when p_qc_status = 'PASSED' and coalesce(p_package_count, 0) > 0 then 'READY_FOR_GODOWN' else 'VERIFIED' end;

  update public.retail_packing_records set
    status = v_new_status, qc_status = p_qc_status, package_count = coalesce(p_package_count, package_count),
    condition_notes = coalesce(p_condition_notes, condition_notes), missing_damaged_note = coalesce(p_missing_damaged_note, missing_damaged_note),
    packed_by = auth.uid(), packed_at = now()
  where id = p_packing_id returning * into v_row;

  perform public.retail_log_status_change('retail_packing', p_packing_id, 'IN_PROGRESS', v_new_status, v_row.department_id, p_condition_notes);
  perform public.staff_write_audit('retail_packing', p_packing_id, 'VERIFY', null, jsonb_build_object('status', v_new_status, 'qc_status', p_qc_status), v_row.department_id);

  -- NEW: the salesperson who booked this order gets the packed status + the SAME linked packing photo record
  -- (ProofPhotoViewer/OrderTracker resolve it by entity_type='retail_packing', entity_id=p_packing_id -- not a
  -- separate, duplicate attachment) the instant packing is verified, per the pilot's own "Amazon-style" spec.
  if v_new_status = 'READY_FOR_GODOWN' and v_order.created_by is not null and v_order.created_by <> auth.uid() then
    perform public.staff_notify_assignment(v_order.created_by, 'retail_packing', p_packing_id,
      'Packed and ready for delivery: ' || v_order.order_number, v_order.order_number || ' — પેક થયું, ડિલિવરી માટે તૈયાર');
    -- (verified live: this exact Gujarati string round-trips correctly through apply_migration; only the literal
    -- ampersand character has ever been mangled by that transport, per this session's earlier finding.)
  end if;

  return v_row;
end $function$;

create or replace function public.retail_godown_accept(
  p_handover_id uuid, p_packages_received integer, p_quantity_verified boolean, p_condition_verified boolean,
  p_rack_location text default null::text, p_notes text default null::text)
returns public.retail_godown_handovers
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_row public.retail_godown_handovers; v_allowed boolean; v_has_photo boolean;
  v_packing public.retail_packing_records; v_order public.retail_orders; v_task_id uuid; v_task_number text; v_key text;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_godown_handovers where id = p_handover_id for update;
  if v_row.id is null then raise exception 'Handover not found'; end if;
  if v_row.status = 'ACCEPTED' then return v_row; end if;
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

  select * into v_order from public.retail_orders where id = v_row.order_id;
  update public.retail_orders set on_hold = false, on_hold_reason = null where id = v_row.order_id and on_hold;

  if v_row.packing_id is not null then
    select * into v_packing from public.retail_packing_records where id = v_row.packing_id;
    if v_packing.id is not null and v_packing.status <> 'READY_FOR_GODOWN' then
      v_key := 'retail_godown_packing:' || v_packing.id::text;
      if not exists (select 1 from public.staff_tasks where system_key = v_key) then
        select tk.task_id, tk.task_number into v_task_id, v_task_number from public.staff_create_task(
          'Verify and pack order ' || v_order.order_number || ' at Godown',
          'Verify stock, confirm quantities/condition, then pack and upload a packing photo before dispatch.',
          'GENERAL_TASK', 'HIGH', 'photo', v_row.department_id, v_row.department_id,
          coalesce(v_row.responsible_user_id, auth.uid()), current_date + 1, null, null, v_order.order_number, null, null, null, null) tk;
        update public.staff_tasks set system_key = v_key where id = v_task_id;
        update public.retail_packing_records set linked_task_id = coalesce(linked_task_id, v_task_id) where id = v_packing.id;
      end if;
    end if;
  end if;

  perform public.retail_log_status_change('retail_order', v_row.order_id, 'ASSIGNED_TO_GODOWN', 'RECEIVED_AT_GODOWN', v_row.department_id, p_notes);
  perform public.staff_write_audit('retail_godown_handover', p_handover_id, 'ACCEPT', null,
    jsonb_build_object('packages_received', p_packages_received, 'rack_location', p_rack_location), v_row.department_id);

  -- NEW: the salesperson gets told the moment Godown accepts, instead of only finding out at dispatch.
  if v_order.created_by is not null and v_order.created_by <> auth.uid() then
    perform public.staff_notify_assignment(v_order.created_by, 'retail_godown_handover', p_handover_id,
      'Accepted by Godown: ' || v_order.order_number, v_order.order_number || ' — ગોડાઉન દ્વારા સ્વીકારાયું');
    -- (verified live: this exact Gujarati string round-trips correctly through apply_migration.)
  end if;

  return v_row;
end $function$;
