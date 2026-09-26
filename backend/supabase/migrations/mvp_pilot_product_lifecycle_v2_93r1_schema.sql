-- Product lifecycle (v2_93r, part 1/3 -- schema): Product Master vs. physical Inventory Serial, product types with
-- managed prefixes, versioned pricing/details, Delivery Challans. This corrects a real architecture gap from the
-- previous pass (v2_93q): "track each item separately" there created N separate top-level retail_products rows
-- (CHR-000001, CHR-000002...) instead of ONE model row + N serial sub-rows (CHR-000125-001, -002...) -- the
-- two-tier shape this spec explicitly requires. Confirmed live: zero real confirmed retail_products rows exist
-- (only unconfirmed PENDING placeholders), so this correction is safe.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. Product types -- replaces the previous regex-guess category prefix map with a real, Head-manageable table.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_product_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_en text not null,
  name_gu text not null,
  prefix text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.retail_product_types (code, name_en, name_gu, prefix) values
  ('CHAIR', 'Chair', 'ખુરશી', 'CHR'),
  ('SOFA', 'Sofa', 'સોફા', 'SOF'),
  ('BED', 'Bed', 'પલંગ', 'BED'),
  ('DINING_TABLE', 'Dining Table', 'ડાઇનિંગ ટેબલ', 'DNT'),
  ('DINING_CHAIR', 'Dining Chair', 'ડાઇનિંગ ખુરશી', 'DNC'),
  ('CENTRE_TABLE', 'Centre Table', 'સેન્ટર ટેબલ', 'CNT'),
  ('SIDE_TABLE', 'Side Table', 'સાઇડ ટેબલ', 'SDT'),
  ('OFFICE_CHAIR', 'Office Chair', 'ઓફિસ ખુરશી', 'OFC'),
  ('OFFICE_TABLE', 'Office Table', 'ઓફિસ ટેબલ', 'OFT'),
  ('WARDROBE', 'Wardrobe', 'વોર્ડરોબ', 'WRD'),
  ('CABINET', 'Cabinet/Storage', 'કેબિનેટ/સ્ટોરેજ', 'CAB'),
  ('RECLINER', 'Recliner', 'રિક્લાઇનર', 'RCL'),
  ('BENCH', 'Bench', 'બેંચ', 'BNC'),
  ('STOOL', 'Stool', 'સ્ટૂલ', 'STL'),
  ('MATTRESS', 'Mattress', 'ગાદલું', 'MTR'),
  ('DECOR', 'Décor', 'ડેકોર', 'DEC'),
  ('OTHER', 'Other', 'અન્ય', 'OTH')
on conflict (code) do nothing;

alter table public.retail_product_types enable row level security;
drop policy if exists retail_product_types_select on public.retail_product_types;
create policy retail_product_types_select on public.retail_product_types for select using (auth.uid() is not null);
-- Non-sensitive reference data (names/prefixes only) -- readable by any signed-in staff member; only
-- retail_upsert_product_type (SECURITY DEFINER, Head/oversight-gated) can write.

create or replace function public.retail_list_product_types()
returns setof public.retail_product_types
language sql stable security definer set search_path to 'public'
as $$ select * from public.retail_product_types where is_active order by name_en; $$;
grant execute on function public.retail_list_product_types() to authenticated;

create or replace function public.retail_upsert_product_type(p_code text, p_name_en text, p_name_gu text, p_prefix text)
returns public.retail_product_types
language plpgsql security definer set search_path to 'public'
as $function$
declare v_allowed boolean; v_row public.retail_product_types;
begin
  perform public.staff_assert_operational();
  v_allowed := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false)));
  if not v_allowed then raise exception 'Only Retail Head/Management may manage product types'; end if;
  if coalesce(btrim(p_code), '') = '' or coalesce(btrim(p_prefix), '') = '' then raise exception 'Code and prefix are required'; end if;

  insert into public.retail_product_types (code, name_en, name_gu, prefix)
  values (upper(btrim(p_code)), btrim(p_name_en), btrim(p_name_gu), upper(btrim(p_prefix)))
  on conflict (code) do update set name_en = excluded.name_en, name_gu = excluded.name_gu, prefix = excluded.prefix
  returning * into v_row;

  perform public.staff_write_audit('retail_product_type', v_row.id, 'UPSERT', null,
    jsonb_build_object('code', v_row.code, 'prefix', v_row.prefix), public.retail_dept_id());
  return v_row;
end $function$;
grant execute on function public.retail_upsert_product_type(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. Product Master detail/pricing columns -- currently retail_products has ZERO commercial fields; confirmed live.
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.retail_products
  add column if not exists product_type_id uuid references public.retail_product_types(id),
  add column if not exists material text,
  add column if not exists color_finish text,
  add column if not exists dimensions text,
  add column if not exists brand_vendor text,
  add column if not exists description text,
  add column if not exists mrp numeric,
  add column if not exists selling_price numeric,
  add column if not exists min_approved_price numeric,
  add column if not exists gst_percent numeric,
  add column if not exists warranty_text text,
  add column if not exists tags text[],
  add column if not exists display_availability boolean not null default true,
  add column if not exists updated_by uuid references public.user_profiles(id);

create table if not exists public.retail_product_price_history (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.retail_products(id),
  field_name text not null,
  old_value text,
  new_value text,
  changed_by uuid not null references public.user_profiles(id),
  changed_at timestamptz not null default now(),
  reason text not null
);
create index if not exists retail_product_price_history_product_idx on public.retail_product_price_history (product_id, changed_at desc);
alter table public.retail_product_price_history enable row level security;
drop policy if exists retail_product_price_history_select on public.retail_product_price_history;
create policy retail_product_price_history_select on public.retail_product_price_history for select using (
  public.staff_has_global_oversight() or public.staff_current_department_id() in (select id from public.departments where code = 'RETAIL')
  or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(public.retail_dept_id()))
);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. Physical inventory serials -- ONE row per sellable unit. retail_products above is now strictly the MODEL/MASTER.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_inventory_items (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.retail_products(id),
  serial_number text not null unique,
  status text not null default 'AVAILABLE',
  location_id uuid references public.locations(id),
  rack_location text,
  condition text not null default 'GOOD',
  reserved_quotation_id uuid references public.retail_quotations(id),
  reserved_order_id uuid references public.retail_orders(id),
  sold_to_customer_id uuid references public.retail_customers(id),
  sold_order_id uuid references public.retail_orders(id),
  sold_at timestamptz,
  damage_reason text,
  batch_number text,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.retail_inventory_items drop constraint if exists retail_inventory_items_status_check;
alter table public.retail_inventory_items add constraint retail_inventory_items_status_check check (status in
  ('AVAILABLE', 'DISPLAY', 'RESERVED', 'PICKED', 'PACKED', 'DISPATCHED', 'IN_TRANSIT_EXCEPTION', 'RETURNED', 'DAMAGED', 'SOLD'));
alter table public.retail_inventory_items drop constraint if exists retail_inventory_items_condition_check;
alter table public.retail_inventory_items add constraint retail_inventory_items_condition_check check (condition in ('GOOD', 'DAMAGED'));
create index if not exists retail_inventory_items_product_idx on public.retail_inventory_items (product_id);
create index if not exists retail_inventory_items_status_idx on public.retail_inventory_items (status);

alter table public.retail_inventory_items enable row level security;
drop policy if exists retail_inventory_items_select on public.retail_inventory_items;
create policy retail_inventory_items_select on public.retail_inventory_items for select using (
  public.staff_has_global_oversight() or public.staff_is_godown_staff()
  or public.staff_current_department_id() in (select id from public.departments where code = 'RETAIL')
  or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(public.retail_godown_dept_id()) or public.staff_dept_in_hod_scope(public.retail_dept_id())))
);
-- No insert/update/delete policy for authenticated -- every write goes through a SECURITY DEFINER RPC (part 2/3).

create table if not exists public.retail_serial_counters (
  product_id uuid primary key references public.retail_products(id),
  next_seq int not null default 1
);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. Delivery Challan -- a real, linked document (previously only a free-text "delivery_challan_ref" on dispatch).
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_dc_number_counters (
  dc_day date primary key,
  next_seq int not null default 1
);

create table if not exists public.retail_delivery_challans (
  id uuid primary key default gen_random_uuid(),
  dc_number text not null unique,
  order_id uuid not null references public.retail_orders(id),
  quotation_id uuid references public.retail_quotations(id),
  revision_no int not null default 1,
  status text not null default 'ACTIVE',
  vehicle_transporter text,
  delivery_date date,
  installation_required boolean,
  special_instructions text,
  notes text,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now()
);
alter table public.retail_delivery_challans drop constraint if exists retail_delivery_challans_status_check;
alter table public.retail_delivery_challans add constraint retail_delivery_challans_status_check check (status in ('ACTIVE', 'REVISED', 'CANCELLED'));
create index if not exists retail_delivery_challans_order_idx on public.retail_delivery_challans (order_id);

create table if not exists public.retail_delivery_challan_items (
  id uuid primary key default gen_random_uuid(),
  dc_id uuid not null references public.retail_delivery_challans(id),
  order_item_id uuid references public.retail_order_items(id),
  product_id uuid references public.retail_products(id),
  inventory_item_id uuid references public.retail_inventory_items(id),
  quantity numeric not null default 1
);
create index if not exists retail_delivery_challan_items_dc_idx on public.retail_delivery_challan_items (dc_id);

alter table public.retail_delivery_challans enable row level security;
alter table public.retail_delivery_challan_items enable row level security;
drop policy if exists retail_delivery_challans_select on public.retail_delivery_challans;
create policy retail_delivery_challans_select on public.retail_delivery_challans for select using (
  public.staff_has_global_oversight() or public.staff_is_godown_staff()
  or exists (select 1 from public.retail_orders o where o.id = retail_delivery_challans.order_id and (
    o.created_by = auth.uid() or public.retail_can_access_customer(o.customer_id)
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(o.department_id))))
);
drop policy if exists retail_delivery_challan_items_select on public.retail_delivery_challan_items;
create policy retail_delivery_challan_items_select on public.retail_delivery_challan_items for select using (
  exists (select 1 from public.retail_delivery_challans dc where dc.id = retail_delivery_challan_items.dc_id)
);
-- No insert/update/delete policy for authenticated -- every write goes through a SECURITY DEFINER RPC (part 3/3).

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. Additive links on existing tables -- quotation/order items can now point at a real Product Master + a specific
--    physical serial (set when added via QR scan); godown handovers can now point at the DC that created them.
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.retail_quotation_items
  add column if not exists product_id uuid references public.retail_products(id),
  add column if not exists inventory_item_id uuid references public.retail_inventory_items(id);
create unique index if not exists retail_quotation_items_no_dup_serial on public.retail_quotation_items (quotation_id, inventory_item_id) where inventory_item_id is not null;

alter table public.retail_order_items
  add column if not exists product_id uuid references public.retail_products(id),
  add column if not exists inventory_item_id uuid references public.retail_inventory_items(id);

alter table public.retail_godown_handovers add column if not exists delivery_challan_id uuid references public.retail_delivery_challans(id);

alter table public.staff_attachments drop constraint if exists staff_attachments_entity_type_check;
alter table public.staff_attachments add constraint staff_attachments_entity_type_check
  check (entity_type in ('task', 'bridge', 'retail_packing', 'retail_godown_handover', 'retail_dispatch', 'retail_delivery',
                          'retail_installation', 'retail_order_item', 'retail_product', 'retail_inventory_item', 'retail_quotation',
                          'retail_delivery_challan'));
