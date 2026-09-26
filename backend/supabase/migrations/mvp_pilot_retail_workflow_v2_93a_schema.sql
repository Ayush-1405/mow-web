-- v2_93a -- Retail Stores module, Phase 1: the transactional backbone (customers -> leads/walk-ins -> follow-ups -> quotations ->
-- orders -> confirmed-order fulfilment split -> Factory Job Card / Procurement Request / stock reservation -> delivery), built on the
-- EXISTING retail_leads/retail_quotations/retail_quotation_items/retail_orders/retail_order_items/retail_payments tables (extended, not
-- duplicated) plus a small number of genuinely new tables. Reuses the existing Today's Tasks / Chat / Attachments / Notifications /
-- centralized-permission infrastructure instead of inventing parallel systems: every retail follow-up and confirmed order gets a real
-- linked staff_tasks row (via the same system_key idempotency pattern factory_sync_job_task already uses), which is what makes Chat,
-- file/voice attachments and Today's Tasks work for Retail with zero new plumbing.
--
-- part a: tables, columns, indexes, RLS.  part b: automation RPCs (walk-in, follow-up, quotation, confirm-order fulfilment split).

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 0. helper
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_dept_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.departments where code = 'RETAIL';
$$;

create or replace function public.retail_normalize_phone(p text)
returns text language sql immutable as $$
  select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10), '');
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. retail_customers -- one row per real person, deduped by normalized mobile number so a walk-in never creates a duplicate.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_customers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text,
  normalized_phone text,
  whatsapp text,
  email text,
  city text,
  area text,
  customer_type text not null default 'RETAIL' check (customer_type in ('RETAIL', 'CORPORATE', 'DEALER', 'ARCHITECT_DESIGNER')),
  notes text,
  is_active boolean not null default true,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists retail_customers_phone_uq on public.retail_customers (normalized_phone) where normalized_phone is not null;
create index if not exists retail_customers_name_idx on public.retail_customers using gin (to_tsvector('simple', coalesce(full_name, '')));

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. retail_leads -- extended in place (walk-in intake fields). Existing rows are untouched; new columns are nullable / defaulted.
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.retail_leads add column if not exists customer_id uuid references public.retail_customers(id);
alter table public.retail_leads add column if not exists walkin_number text;
alter table public.retail_leads add column if not exists whatsapp text;
alter table public.retail_leads add column if not exists email text;
alter table public.retail_leads add column if not exists city text;
alter table public.retail_leads add column if not exists requirement_category text;
alter table public.retail_leads add column if not exists interested_products text;
alter table public.retail_leads add column if not exists room_category text;
alter table public.retail_leads add column if not exists approx_budget numeric(12,2);
alter table public.retail_leads add column if not exists purchase_timeline text;
alter table public.retail_leads add column if not exists customer_type text;
alter table public.retail_leads add column if not exists lead_temperature text default 'WARM';
alter table public.retail_leads add column if not exists next_follow_up_time time;
alter table public.retail_leads add column if not exists linked_task_id uuid references public.staff_tasks(id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'retail_leads_temperature_check') then
    alter table public.retail_leads add constraint retail_leads_temperature_check check (lead_temperature in ('HOT', 'WARM', 'COLD'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'retail_leads_requirement_check') then
    alter table public.retail_leads add constraint retail_leads_requirement_check check (requirement_category is null or requirement_category in
      ('LOOSE_FURNITURE', 'SOFA', 'BED', 'DINING', 'OFFICE_FURNITURE', 'MODULAR_KITCHEN', 'WARDROBE', 'COMPLETE_INTERIOR', 'BULK_CORPORATE', 'CUSTOMIZED', 'OTHER'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'retail_leads_walkin_number_uq') then
    alter table public.retail_leads add constraint retail_leads_walkin_number_uq unique (walkin_number);
  end if;
end $$;
create index if not exists retail_leads_customer_idx on public.retail_leads (customer_id);
create index if not exists retail_leads_next_followup_idx on public.retail_leads (next_follow_up_date) where is_active and status not in ('CONVERTED', 'LOST');
create index if not exists retail_leads_assigned_idx on public.retail_leads (assigned_to) where is_active;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. retail_followups -- the CRM timeline. Every entry is linked to the lead, the previous entry, and (once scheduled) a real task.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_followups (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  lead_id uuid not null references public.retail_leads(id) on delete cascade,
  customer_id uuid references public.retail_customers(id),
  previous_followup_id uuid references public.retail_followups(id),
  contact_mode text not null check (contact_mode in ('CALL', 'WHATSAPP', 'VISIT', 'EMAIL')),
  outcome text,
  customer_response text,
  products_discussed text,
  expected_decision_date date,
  revised_budget numeric(12,2),
  notes text,
  next_action text,
  next_follow_up_at timestamptz,
  status text not null check (status in
    ('NEW', 'CONTACTED', 'FOLLOW_UP_DUE', 'INTERESTED', 'QUOTATION_REQUESTED', 'QUOTATION_SENT', 'NEGOTIATION', 'DECISION_PENDING', 'WON', 'LOST', 'NOT_RESPONDING', 'ON_HOLD')),
  lost_reason text,
  quotation_id uuid references public.retail_quotations(id),
  order_id uuid references public.retail_orders(id),
  linked_task_id uuid references public.staff_tasks(id),
  is_active boolean not null default true,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists retail_followups_lead_idx on public.retail_followups (lead_id, created_at desc);
create index if not exists retail_followups_customer_idx on public.retail_followups (customer_id);
create index if not exists retail_followups_next_idx on public.retail_followups (next_follow_up_at) where is_active;
create trigger trg_touch_updated_at before update on public.retail_followups for each row execute function public.staff_touch_updated_at();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. retail_quotations / retail_quotation_items -- extended: customer link, store, revision history, richer line items.
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.retail_quotations add column if not exists customer_id uuid references public.retail_customers(id);
alter table public.retail_quotations add column if not exists delivery_charge numeric(12,2) not null default 0;
alter table public.retail_quotations add column if not exists installation_charge numeric(12,2) not null default 0;
alter table public.retail_quotations add column if not exists terms text;
alter table public.retail_quotations add column if not exists expected_delivery date;
alter table public.retail_quotations add column if not exists supersedes_id uuid references public.retail_quotations(id);
alter table public.retail_quotations add column if not exists revision_no integer not null default 1;
alter table public.retail_quotations add column if not exists internal_approval_required boolean not null default false;
alter table public.retail_quotations add column if not exists internal_approved_by uuid references public.user_profiles(id);
alter table public.retail_quotations add column if not exists internal_approved_at timestamptz;
create index if not exists retail_quotations_customer_idx on public.retail_quotations (customer_id);
create index if not exists retail_quotations_lead_idx on public.retail_quotations (lead_id);

alter table public.retail_quotation_items add column if not exists sku text;
alter table public.retail_quotation_items add column if not exists description text;
alter table public.retail_quotation_items add column if not exists dimensions text;
alter table public.retail_quotation_items add column if not exists product_image_path text;
alter table public.retail_quotation_items add column if not exists discount numeric(12,2) not null default 0;
alter table public.retail_quotation_items add column if not exists tax numeric(12,2) not null default 0;
alter table public.retail_quotation_items add column if not exists customization_notes text;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. retail_orders / retail_order_items -- extended: customer/addresses, approvals, per-item fulfilment mode, the confirm-order guard.
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.retail_orders add column if not exists customer_id uuid references public.retail_customers(id);
alter table public.retail_orders add column if not exists billing_address text;
alter table public.retail_orders add column if not exists delivery_address text;
alter table public.retail_orders add column if not exists required_delivery_date date;
alter table public.retail_orders add column if not exists installation_required boolean not null default false;
alter table public.retail_orders add column if not exists special_instructions text;
alter table public.retail_orders add column if not exists sales_approved_by uuid references public.user_profiles(id);
alter table public.retail_orders add column if not exists sales_approved_at timestamptz;
alter table public.retail_orders add column if not exists management_approved_by uuid references public.user_profiles(id);
alter table public.retail_orders add column if not exists management_approved_at timestamptz;
alter table public.retail_orders add column if not exists confirmed_at timestamptz;
alter table public.retail_orders add column if not exists confirmed_by uuid references public.user_profiles(id);
-- the guard that makes retail_confirm_order() safely retryable: once true, a second call is a no-op read, never a second split.
alter table public.retail_orders add column if not exists fulfilment_locked boolean not null default false;
alter table public.retail_orders add column if not exists linked_task_id uuid references public.staff_tasks(id);
create index if not exists retail_orders_customer_idx on public.retail_orders (customer_id);

alter table public.retail_order_items add column if not exists sku text;
alter table public.retail_order_items add column if not exists dimensions text;
alter table public.retail_order_items add column if not exists finish_color_fabric text;
alter table public.retail_order_items add column if not exists customization_notes text;
alter table public.retail_order_items add column if not exists product_image_path text;
alter table public.retail_order_items add column if not exists discount numeric(12,2) not null default 0;
alter table public.retail_order_items add column if not exists tax numeric(12,2) not null default 0;
-- chosen at/just before confirmation, one of STOCK / FACTORY / OUTSOURCE; null until decided.
alter table public.retail_order_items add column if not exists fulfilment_mode text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'retail_order_items_fulfilment_check') then
    alter table public.retail_order_items add constraint retail_order_items_fulfilment_check check (fulfilment_mode is null or fulfilment_mode in ('STOCK', 'FACTORY', 'OUTSOURCE'));
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 6. retail_fulfilment_items -- ONE row per order line item's fulfilment decision. A partial unique index on order_item_id is what
--    "prevents double reservation" / double job-card / double procurement-request for the same line item.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_fulfilment_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.retail_orders(id) on delete cascade,
  order_item_id uuid not null references public.retail_order_items(id) on delete cascade,
  mode text not null check (mode in ('STOCK', 'FACTORY', 'OUTSOURCE')),
  quantity numeric(12,2),
  status text not null default 'PENDING' check (status in ('PENDING', 'RESERVED', 'IN_PROGRESS', 'READY', 'ISSUE', 'CANCELLED')),
  stock_location_id uuid references public.locations(id),
  job_card_id uuid references public.inhouse_production_requests(id),
  procurement_request_id uuid, -- FK added after that table exists, below
  notes text,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists retail_fulfilment_items_order_item_uq on public.retail_fulfilment_items (order_item_id);
create index if not exists retail_fulfilment_items_order_idx on public.retail_fulfilment_items (order_id);
create index if not exists retail_fulfilment_items_job_idx on public.retail_fulfilment_items (job_card_id) where job_card_id is not null;
create trigger trg_touch_updated_at before update on public.retail_fulfilment_items for each row execute function public.staff_touch_updated_at();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 7. retail_procurement_requests -- an OUTSOURCE/vendor request raised by Retail. Kept separate from Interior's project-scoped
--    purchase_requests (whose project_id is NOT NULL, a poor fit for a store sale) rather than forcing that table to serve two shapes.
--    department_id is the RECEIVING department (Procurement) — same "who does the RLS scope belong to" convention bridges/tasks use.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_procurement_requests (
  id uuid primary key default gen_random_uuid(),
  request_number text not null unique,
  department_id uuid not null references public.departments(id), -- PROCUREMENT
  origin_department_id uuid not null references public.departments(id), -- RETAIL
  order_id uuid not null references public.retail_orders(id),
  order_item_id uuid not null references public.retail_order_items(id),
  item_name text not null,
  specification text,
  quantity numeric(12,2),
  required_date date,
  target_cost numeric(12,2),
  preferred_vendor text,
  delivery_destination text,
  qc_requirement text,
  status text not null default 'REQUESTED' check (status in
    ('REQUESTED', 'VERIFIED', 'VENDOR_QUOTED', 'APPROVED', 'PO_RAISED', 'VENDOR_FOLLOWUP', 'DISPATCHED', 'GRN_QC', 'READY', 'DELAYED', 'COMPLETED', 'CANCELLED')),
  linked_task_id uuid references public.staff_tasks(id),
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_active boolean not null default true
);
create unique index if not exists retail_procurement_requests_item_uq on public.retail_procurement_requests (order_item_id);
create index if not exists retail_procurement_requests_order_idx on public.retail_procurement_requests (order_id);
create trigger trg_touch_updated_at before update on public.retail_procurement_requests for each row execute function public.staff_touch_updated_at();
alter table public.retail_fulfilment_items add constraint retail_fulfilment_items_procurement_fk foreign key (procurement_request_id) references public.retail_procurement_requests(id);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 8. retail_deliveries -- one row per order's delivery timeline (created lazily when Fulfilment Planning starts).
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_deliveries (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  order_id uuid not null references public.retail_orders(id),
  stage text not null default 'ORDER_READY' check (stage in
    ('ORDER_READY', 'PAYMENT_CLEARANCE', 'SITE_READINESS', 'DELIVERY_SCHEDULED', 'VEHICLE_ASSIGNED', 'DISPATCHED', 'DELIVERED', 'INSTALLATION', 'CUSTOMER_CONFIRMATION', 'COMPLETED')),
  delivery_address text,
  contact_person text,
  contact_phone text,
  scheduled_at timestamptz,
  vehicle_transporter text,
  assigned_team text,
  pod_path text,
  installation_proof_path text,
  customer_confirmed boolean not null default false,
  feedback_score integer check (feedback_score between 1 and 5),
  delay_reason text,
  rescheduled_at timestamptz,
  linked_task_id uuid references public.staff_tasks(id),
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_active boolean not null default true
);
create unique index if not exists retail_deliveries_order_uq on public.retail_deliveries (order_id);
create trigger trg_touch_updated_at before update on public.retail_deliveries for each row execute function public.staff_touch_updated_at();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 9. retail_display_updates -- Visual Merchandising (separate from retail_vm_tasks: different, richer field set).
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_display_updates (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  location_id uuid references public.locations(id),
  display_area text not null,
  product_name text,
  before_photo_path text,
  after_photo_path text,
  update_type text check (update_type in ('REFRESH', 'NEW_SETUP', 'REPAIR', 'PRICE_TAG', 'CLEANING', 'REPLACEMENT')),
  condition text check (condition in ('GOOD', 'NEEDS_ATTENTION', 'DAMAGED')),
  price_tag_status text check (price_tag_status in ('OK', 'MISSING', 'INCORRECT')),
  cleaning_status text check (cleaning_status in ('CLEAN', 'NEEDS_CLEANING')),
  display_start_date date,
  last_refreshed_date date,
  responsible_user uuid references public.user_profiles(id),
  notes text,
  next_review_date date,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_active boolean not null default true
);
create index if not exists retail_display_updates_location_idx on public.retail_display_updates (location_id, next_review_date);
create trigger trg_touch_updated_at before update on public.retail_display_updates for each row execute function public.staff_touch_updated_at();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 10. retail_daily_updates -- one per employee per store per day; system-computed counters are filled by the RPC, never hand-typed.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_daily_updates (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  location_id uuid references public.locations(id),
  employee_id uuid not null references public.user_profiles(id),
  update_date date not null default current_date,
  walkins_count integer not null default 0,
  followups_count integer not null default 0,
  quotations_count integer not null default 0,
  orders_count integer not null default 0,
  sales_value numeric(12,2) not null default 0,
  collection_amount numeric(12,2) not null default 0,
  display_update_note text,
  delivery_coordination_note text,
  problems text,
  tomorrow_priority text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists retail_daily_updates_uq on public.retail_daily_updates (employee_id, location_id, update_date);
create trigger trg_touch_updated_at before update on public.retail_daily_updates for each row execute function public.staff_touch_updated_at();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 11. Realtime + RLS
-- ---------------------------------------------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['retail_customers','retail_followups','retail_fulfilment_items','retail_procurement_requests','retail_deliveries','retail_display_updates','retail_daily_updates'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Customers: any active Retail team member may read/search (needed for dedupe + assigning any lead to any customer); writes are open to
-- the same scope (upsert-only in practice, via retail_upsert_customer). Global oversight and the Retail Head's own hod-scope see it too.
create policy retail_customers_select on public.retail_customers for select to authenticated using (
  staff_current_user_ok() and (
    staff_current_department_id() = retail_dept_id() or staff_has_global_oversight()
    or (staff_is_dept_head() and staff_dept_in_hod_scope(retail_dept_id()))));
create policy retail_customers_write on public.retail_customers for all to authenticated
  using (staff_current_user_ok() and (staff_current_department_id() = retail_dept_id() or staff_has_global_oversight()))
  with check (staff_current_user_ok() and (staff_current_department_id() = retail_dept_id() or staff_has_global_oversight()));

create policy retail_followups_select on public.retail_followups for select to authenticated using (
  staff_current_user_ok() and (
    created_by = auth.uid() or exists (select 1 from retail_leads l where l.id = retail_followups.lead_id and l.assigned_to = auth.uid())
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))));
create policy retail_followups_write on public.retail_followups for all to authenticated
  using (staff_current_user_ok() and (created_by = auth.uid() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))))
  with check (staff_current_user_ok() and (department_id = staff_current_department_id() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))));

create policy retail_fulfilment_items_select on public.retail_fulfilment_items for select to authenticated using (
  staff_current_user_ok() and exists (select 1 from retail_orders o where o.id = retail_fulfilment_items.order_id and
    (o.created_by = auth.uid() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(o.department_id)))));
create policy retail_fulfilment_items_write on public.retail_fulfilment_items for all to authenticated
  using (staff_current_user_ok() and staff_has_global_oversight())
  with check (staff_current_user_ok() and staff_has_global_oversight());
-- (writes normally happen only via the SECURITY DEFINER retail_confirm_order RPC; direct writes are management-only, same defense-in-depth
-- pattern the rest of this app uses for RPC-mediated tables.)

create policy retail_procurement_requests_select on public.retail_procurement_requests for select to authenticated using (
  staff_current_user_ok() and (
    created_by = auth.uid() or staff_has_global_oversight()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(department_id) or staff_dept_in_hod_scope(origin_department_id)))
    or (department_id = staff_current_department_id()) or (origin_department_id = staff_current_department_id())
    or exists (select 1 from retail_orders o where o.id = retail_procurement_requests.order_id and o.created_by = auth.uid())));
create policy retail_procurement_requests_write on public.retail_procurement_requests for all to authenticated
  using (staff_current_user_ok() and (created_by = auth.uid() or staff_has_global_oversight() or (staff_is_dept_head() and (staff_dept_in_hod_scope(department_id) or staff_dept_in_hod_scope(origin_department_id))) or department_id = staff_current_department_id()))
  with check (staff_current_user_ok() and (staff_has_global_oversight() or (staff_is_dept_head() and (staff_dept_in_hod_scope(department_id) or staff_dept_in_hod_scope(origin_department_id))) or department_id = staff_current_department_id() or origin_department_id = staff_current_department_id()));

create policy retail_deliveries_select on public.retail_deliveries for select to authenticated using (
  staff_current_user_ok() and (
    created_by = auth.uid() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))
    or exists (select 1 from retail_orders o where o.id = retail_deliveries.order_id and o.created_by = auth.uid())));
create policy retail_deliveries_write on public.retail_deliveries for all to authenticated
  using (staff_current_user_ok() and (created_by = auth.uid() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id)) or exists (select 1 from retail_orders o where o.id = retail_deliveries.order_id and o.created_by = auth.uid())))
  with check (staff_current_user_ok() and (department_id = staff_current_department_id() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))));

create policy retail_display_updates_select on public.retail_display_updates for select to authenticated using (
  staff_current_user_ok() and (created_by = auth.uid() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id)) or department_id = staff_current_department_id()));
create policy retail_display_updates_write on public.retail_display_updates for all to authenticated
  using (staff_current_user_ok() and (created_by = auth.uid() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))))
  with check (staff_current_user_ok() and (department_id = staff_current_department_id() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))));

create policy retail_daily_updates_select on public.retail_daily_updates for select to authenticated using (
  staff_current_user_ok() and (employee_id = auth.uid() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))));
create policy retail_daily_updates_write on public.retail_daily_updates for all to authenticated
  using (staff_current_user_ok() and (employee_id = auth.uid() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))))
  with check (staff_current_user_ok() and (employee_id = auth.uid() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))));

grant select, insert, update, delete on public.retail_customers, public.retail_followups, public.retail_fulfilment_items,
  public.retail_procurement_requests, public.retail_deliveries, public.retail_display_updates, public.retail_daily_updates to authenticated;
