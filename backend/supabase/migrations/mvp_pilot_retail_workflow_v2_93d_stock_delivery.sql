-- v2_93d -- Retail Stores module, Phase 2a: a real Stock Availability data source (none existed before -- RetailStock.jsx was an honest
-- empty state with nowhere to read from) and the read-side helpers the Delivery screen needs to show real orders instead of generic tasks.
--
-- retail_products / retail_stock: a small, genuinely new product+per-location-stock ledger. "Reserved" is computed from
-- retail_fulfilment_items (mode='STOCK') cross-referenced by SKU against retail_order_items.sku -- order items keep their own free-typed
-- SKU (unchanged, matches this schema's existing loose-item style) rather than a hard FK, so a reservation is real without forcing every
-- order line to first exist as a catalog product. "Available" is on_hand - reserved - damaged, and reserved stock is NEVER shown as free.

create table if not exists public.retail_products (
  id uuid primary key default gen_random_uuid(),
  sku text not null,
  name text not null,
  category text,
  image_path text,
  unit text not null default 'Nos',
  is_active boolean not null default true,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists retail_products_sku_uq on public.retail_products (upper(sku));
create index if not exists retail_products_name_idx on public.retail_products using gin (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(category, '')));
create trigger trg_touch_updated_at before update on public.retail_products for each row execute function public.staff_touch_updated_at();

create table if not exists public.retail_stock (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.retail_products(id) on delete cascade,
  location_id uuid not null references public.locations(id),
  on_hand_qty numeric(12,2) not null default 0,
  damaged_qty numeric(12,2) not null default 0,
  incoming_qty numeric(12,2) not null default 0,
  expected_availability_date date,
  rack_location text,
  updated_by uuid references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists retail_stock_product_location_uq on public.retail_stock (product_id, location_id);
create trigger trg_touch_updated_at before update on public.retail_stock for each row execute function public.staff_touch_updated_at();

alter table public.retail_products enable row level security;
alter table public.retail_stock enable row level security;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'retail_stock') then
    alter publication supabase_realtime add table public.retail_stock;
  end if;
end $$;

-- Read: any active Retail (or Godown/Inventory, who actually hold the stock) team member, plus global oversight/dept-head scope.
-- Write: dept_head/management (Retail or Godown) -- an ordinary salesperson requests a transfer through the existing STOCK_TRANSFER task
-- flow (RetailStockTransfer.jsx) rather than editing quantities directly, same "who may touch inventory numbers" boundary as before.
create policy retail_products_select on public.retail_products for select to authenticated using (
  staff_current_user_ok() and (
    staff_current_department_id() in (select id from departments where code in ('RETAIL', 'GODOWN_INV'))
    or staff_has_global_oversight()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(retail_dept_id()) or staff_dept_in_hod_scope((select id from departments where code = 'GODOWN_INV'))))));
create policy retail_products_write on public.retail_products for all to authenticated
  using (staff_current_user_ok() and (staff_has_global_oversight() or (staff_is_dept_head() and (staff_dept_in_hod_scope(retail_dept_id()) or staff_dept_in_hod_scope((select id from departments where code = 'GODOWN_INV'))))))
  with check (staff_current_user_ok() and (staff_has_global_oversight() or (staff_is_dept_head() and (staff_dept_in_hod_scope(retail_dept_id()) or staff_dept_in_hod_scope((select id from departments where code = 'GODOWN_INV'))))));

create policy retail_stock_select on public.retail_stock for select to authenticated using (
  staff_current_user_ok() and (
    staff_current_department_id() in (select id from departments where code in ('RETAIL', 'GODOWN_INV'))
    or staff_has_global_oversight()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(retail_dept_id()) or staff_dept_in_hod_scope((select id from departments where code = 'GODOWN_INV'))))));
create policy retail_stock_write on public.retail_stock for all to authenticated
  using (staff_current_user_ok() and (staff_has_global_oversight() or (staff_is_dept_head() and (staff_dept_in_hod_scope(retail_dept_id()) or staff_dept_in_hod_scope((select id from departments where code = 'GODOWN_INV'))))))
  with check (staff_current_user_ok() and (staff_has_global_oversight() or (staff_is_dept_head() and (staff_dept_in_hod_scope(retail_dept_id()) or staff_dept_in_hod_scope((select id from departments where code = 'GODOWN_INV'))))));

grant select, insert, update, delete on public.retail_products, public.retail_stock to authenticated;

-- One read call for the Stock screen: product + per-location on-hand/damaged/incoming + reserved (cross-referenced by SKU, mode=STOCK,
-- status in PENDING/RESERVED -- i.e. not yet dispatched) + available = on_hand - reserved - damaged (never negative).
create or replace function public.retail_stock_availability(p_query text default null, p_location_id uuid default null)
returns table (
  product_id uuid, sku text, name text, category text, image_path text, unit text,
  location_id uuid, location_name text, on_hand_qty numeric, damaged_qty numeric, incoming_qty numeric,
  reserved_qty numeric, available_qty numeric, expected_availability_date date, rack_location text
)
language sql stable security definer set search_path = public as $$
  select p.id, p.sku, p.name, p.category, p.image_path, p.unit,
    s.location_id, l.name_en, s.on_hand_qty, s.damaged_qty, s.incoming_qty,
    coalesce(r.reserved, 0) as reserved_qty,
    greatest(s.on_hand_qty - coalesce(r.reserved, 0) - s.damaged_qty, 0) as available_qty,
    s.expected_availability_date, s.rack_location
  from public.retail_products p
  join public.retail_stock s on s.product_id = p.id
  join public.locations l on l.id = s.location_id
  left join lateral (
    select sum(fi.quantity) reserved from public.retail_fulfilment_items fi
      join public.retail_order_items oi on oi.id = fi.order_item_id
     where fi.mode = 'STOCK' and fi.status in ('PENDING', 'RESERVED') and upper(oi.sku) = upper(p.sku)
  ) r on true
  where p.is_active and (
    staff_current_department_id() in (select id from departments where code in ('RETAIL', 'GODOWN_INV'))
    or staff_has_global_oversight()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(retail_dept_id()) or staff_dept_in_hod_scope((select id from departments where code = 'GODOWN_INV')))))
    and (p_query is null or btrim(p_query) = '' or p.name ilike '%' || p_query || '%' or p.sku ilike '%' || p_query || '%' or p.category ilike '%' || p_query || '%')
    and (p_location_id is null or s.location_id = p_location_id)
  order by p.name, l.name_en;
$$;
revoke execute on function public.retail_stock_availability(text, uuid) from public, anon;
grant execute on function public.retail_stock_availability(text, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Delivery read-side: confirmed orders joined to their retail_deliveries row (a row always exists once retail_confirm_order has run --
-- see v2_93b), so the screen shows real orders, not a generic task list, without a second round trip per order.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_deliveries_board()
returns table (
  delivery_id uuid, order_id uuid, order_number text, customer_name text, phone text, stage text, delivery_address text,
  contact_person text, contact_phone text, scheduled_at timestamptz, vehicle_transporter text, assigned_team text,
  customer_confirmed boolean, feedback_score integer, delay_reason text, total_amount numeric, payment_status text
)
language sql stable security definer set search_path = public as $$
  select d.id, o.id, o.order_number, o.customer_name, o.phone, d.stage, coalesce(d.delivery_address, o.delivery_address),
    d.contact_person, d.contact_phone, d.scheduled_at, d.vehicle_transporter, d.assigned_team,
    d.customer_confirmed, d.feedback_score, d.delay_reason, o.total_amount, o.payment_status
  from public.retail_deliveries d join public.retail_orders o on o.id = d.order_id
  where o.is_active and (
    o.created_by = auth.uid() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(o.department_id)))
  order by coalesce(d.scheduled_at, d.created_at) desc;
$$;
revoke execute on function public.retail_deliveries_board() from public, anon;
grant execute on function public.retail_deliveries_board() to authenticated;
