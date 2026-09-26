-- v2_93h -- Retail Stores module: salesperson-wise customer ownership.
--
-- retail_customers today is department-wide (any active Retail team member can read/write every customer — confirmed live before
-- this migration). This adds a real per-customer owner, a permanent ownership-history log, backup/temporary/readonly access grants
-- (with their own request/approve flow), duplicate detection, merge, and a customer timeline — then rewrites RLS so a plain
-- salesperson genuinely only sees customers they own, created, or were explicitly granted access to (plus Retail Head/Management,
-- as before). Every SELECT/UPDATE policy this touches gets an ADDITIVE `OR retail_can_access_customer(customer_id)` /
-- `retail_can_write_customer(customer_id)` clause — a row a user could already see via created_by/assigned_to stays visible; the
-- real narrowing is on retail_customers itself (whose policy is fully replaced, not extended) and on new rows going forward.
--
-- Incidental fix while rewriting these policies: the original v2_2b policies gate management access on the bare `staff_is_management()`
-- (director/CEO/etc. only) rather than `staff_has_global_oversight()` (also covers super_admin) — upgraded here for consistency with
-- every policy written since v2_90a.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. retail_customers -- ownership columns + one-time backfill (every existing row gets its creator as owner, nothing left blank).
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.retail_customers add column if not exists owner_salesperson_id uuid references public.user_profiles(id);
alter table public.retail_customers add column if not exists ownership_status text not null default 'OWNED';
alter table public.retail_customers add column if not exists ownership_started_at timestamptz;
alter table public.retail_customers add column if not exists previous_owner_id uuid references public.user_profiles(id);
alter table public.retail_customers add column if not exists transferred_by uuid references public.user_profiles(id);
alter table public.retail_customers add column if not exists transfer_reason text;
alter table public.retail_customers add column if not exists transferred_at timestamptz;
alter table public.retail_customers add column if not exists merged_into_id uuid references public.retail_customers(id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'retail_customers_ownership_status_check') then
    alter table public.retail_customers add constraint retail_customers_ownership_status_check check (ownership_status in ('OWNED', 'UNASSIGNED', 'MERGED'));
  end if;
end $$;
update public.retail_customers set owner_salesperson_id = created_by, ownership_started_at = created_at
  where owner_salesperson_id is null and merged_into_id is null;
create index if not exists retail_customers_owner_idx on public.retail_customers (owner_salesperson_id);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. retail_customer_ownership_log -- append-only; every CREATE/TRANSFER/SHARE/MERGE is recorded here, never overwritten.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_customer_ownership_log (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.retail_customers(id),
  action text not null check (action in ('CREATED', 'TRANSFERRED', 'BACKUP_ADDED', 'BACKUP_REMOVED', 'SHARED', 'SHARE_REVOKED', 'MERGED')),
  previous_owner_id uuid references public.user_profiles(id),
  new_owner_id uuid references public.user_profiles(id),
  performed_by uuid not null references public.user_profiles(id),
  reason text,
  effective_date date not null default current_date,
  created_at timestamptz not null default now()
);
create index if not exists retail_customer_ownership_log_customer_idx on public.retail_customer_ownership_log (customer_id, created_at desc);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. retail_customer_access -- BACKUP / TEMPORARY (write access) or READONLY (view only) grants, one row per grant, time-boxed.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_customer_access (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.retail_customers(id),
  user_id uuid not null references public.user_profiles(id),
  access_type text not null check (access_type in ('BACKUP', 'TEMPORARY', 'READONLY')),
  granted_by uuid not null references public.user_profiles(id),
  granted_at timestamptz not null default now(),
  effective_from date not null default current_date,
  effective_until date,
  reason text,
  revoked_at timestamptz,
  revoked_by uuid references public.user_profiles(id),
  is_active boolean not null default true
);
create index if not exists retail_customer_access_customer_idx on public.retail_customer_access (customer_id) where is_active;
create index if not exists retail_customer_access_user_idx on public.retail_customer_access (user_id) where is_active;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. retail_customer_access_requests -- "I hit a duplicate I don't own, let me request access" flow.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_customer_access_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.retail_customers(id),
  requested_by uuid not null references public.user_profiles(id),
  reason text,
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'DENIED')),
  decided_by uuid references public.user_profiles(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists retail_customer_access_requests_customer_idx on public.retail_customer_access_requests (customer_id, status);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. access helpers -- retail_can_access_customer (read: owner/backup/temporary/readonly/oversight/dept-head-in-scope), and
--    retail_can_write_customer (same minus READONLY — a read-only share never grants write). Both return FALSE (not a bypass) when
--    p_customer_id is null, so a policy's OTHER existing clauses keep deciding access to legacy rows with no customer link.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_can_access_customer(p_customer_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_customer_id is not null and exists (
    select 1 from public.retail_customers c where c.id = p_customer_id and (
      c.owner_salesperson_id = auth.uid() or c.created_by = auth.uid()
      or exists (select 1 from public.retail_customer_access a where a.customer_id = c.id and a.user_id = auth.uid() and a.is_active
                 and a.effective_from <= current_date and (a.effective_until is null or a.effective_until >= current_date))
      or public.staff_has_global_oversight()
      or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(public.retail_dept_id()))
    ));
$$;

create or replace function public.retail_can_write_customer(p_customer_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_customer_id is not null and exists (
    select 1 from public.retail_customers c where c.id = p_customer_id and (
      c.owner_salesperson_id = auth.uid() or c.created_by = auth.uid()
      or exists (select 1 from public.retail_customer_access a where a.customer_id = c.id and a.user_id = auth.uid()
                 and a.access_type in ('BACKUP', 'TEMPORARY') and a.is_active
                 and a.effective_from <= current_date and (a.effective_until is null or a.effective_until >= current_date))
      or public.staff_has_global_oversight()
      or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(public.retail_dept_id()))
    ));
$$;
revoke all on function public.retail_can_access_customer(uuid) from public, anon;
revoke all on function public.retail_can_write_customer(uuid) from public, anon;
grant execute on function public.retail_can_access_customer(uuid) to authenticated;
grant execute on function public.retail_can_write_customer(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 6. RLS -- realtime + enable on the 3 new tables, then rewrite retail_customers fully, then extend every other Retail table that
--    can reach a customer_id.
-- ---------------------------------------------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['retail_customer_ownership_log', 'retail_customer_access', 'retail_customer_access_requests'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- retail_customers -- fully replaced (not extended): department-wide read/write is gone. INSERT stays department-scoped (a new
-- customer has no owner yet to check); SELECT/UPDATE become genuinely per-row via the helpers above.
drop policy if exists retail_customers_select on public.retail_customers;
drop policy if exists retail_customers_write on public.retail_customers;
create policy retail_customers_select on public.retail_customers for select to authenticated using (
  staff_current_user_ok() and public.retail_can_access_customer(id));
create policy retail_customers_insert on public.retail_customers for insert to authenticated with check (
  staff_current_user_ok() and (staff_current_department_id() = retail_dept_id() or staff_has_global_oversight()
    or (staff_is_dept_head() and staff_dept_in_hod_scope(retail_dept_id()))));
create policy retail_customers_update on public.retail_customers for update to authenticated
  using (staff_current_user_ok() and public.retail_can_write_customer(id))
  with check (staff_current_user_ok() and public.retail_can_write_customer(id));

-- retail_customer_ownership_log -- read-only to clients (whoever can see the customer can see its history); writes are RPC-only
-- (defense in depth: direct client writes restricted to global oversight, same pattern as retail_fulfilment_items).
create policy retail_customer_ownership_log_select on public.retail_customer_ownership_log for select to authenticated using (
  staff_current_user_ok() and (public.retail_can_access_customer(customer_id) or staff_has_global_oversight()
    or (staff_is_dept_head() and staff_dept_in_hod_scope(retail_dept_id()))));
create policy retail_customer_ownership_log_write on public.retail_customer_ownership_log for all to authenticated
  using (staff_current_user_ok() and staff_has_global_oversight()) with check (staff_current_user_ok() and staff_has_global_oversight());

-- retail_customer_access -- the grant-holder and the customer's owner/oversight/dept-head can see a grant; writes are RPC-only.
create policy retail_customer_access_select on public.retail_customer_access for select to authenticated using (
  staff_current_user_ok() and (user_id = auth.uid() or public.retail_can_access_customer(customer_id) or staff_has_global_oversight()
    or (staff_is_dept_head() and staff_dept_in_hod_scope(retail_dept_id()))));
create policy retail_customer_access_write on public.retail_customer_access for all to authenticated
  using (staff_current_user_ok() and staff_has_global_oversight()) with check (staff_current_user_ok() and staff_has_global_oversight());

-- retail_customer_access_requests -- the requester and the customer's owner/oversight/dept-head can see a request; writes are RPC-only.
create policy retail_customer_access_requests_select on public.retail_customer_access_requests for select to authenticated using (
  staff_current_user_ok() and (requested_by = auth.uid() or public.retail_can_access_customer(customer_id) or staff_has_global_oversight()
    or (staff_is_dept_head() and staff_dept_in_hod_scope(retail_dept_id()))));
create policy retail_customer_access_requests_write on public.retail_customer_access_requests for all to authenticated
  using (staff_current_user_ok() and staff_has_global_oversight()) with check (staff_current_user_ok() and staff_has_global_oversight());

grant select, insert, update, delete on public.retail_customer_ownership_log, public.retail_customer_access, public.retail_customer_access_requests to authenticated;

-- retail_leads
drop policy if exists retail_leads_select_scoped on public.retail_leads;
create policy retail_leads_select_scoped on public.retail_leads for select to authenticated using (
  staff_current_user_ok() and (
    created_by = auth.uid() or assigned_to = auth.uid() or public.retail_can_access_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))
    or (staff_is_accounts_head() and department_id = staff_current_department_id())));
drop policy if exists retail_leads_insert_scoped on public.retail_leads;
create policy retail_leads_insert_scoped on public.retail_leads for insert to authenticated with check (
  staff_current_user_ok() and (
    department_id = staff_current_department_id() or public.retail_can_write_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))));
drop policy if exists retail_leads_update_scoped on public.retail_leads;
create policy retail_leads_update_scoped on public.retail_leads for update to authenticated
  using (staff_current_user_ok() and (
    created_by = auth.uid() or assigned_to = auth.uid() or public.retail_can_write_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))))
  with check (department_id = staff_current_department_id() or public.retail_can_write_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id)));

-- retail_followups (already owner-shaped; add the customer-access clause both sides)
drop policy if exists retail_followups_select on public.retail_followups;
create policy retail_followups_select on public.retail_followups for select to authenticated using (
  staff_current_user_ok() and (
    created_by = auth.uid() or exists (select 1 from retail_leads l where l.id = retail_followups.lead_id and l.assigned_to = auth.uid())
    or public.retail_can_access_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))));
drop policy if exists retail_followups_write on public.retail_followups;
create policy retail_followups_write on public.retail_followups for all to authenticated
  using (staff_current_user_ok() and (created_by = auth.uid() or public.retail_can_write_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))))
  with check (staff_current_user_ok() and (department_id = staff_current_department_id() or public.retail_can_write_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))));

-- retail_quotations
drop policy if exists retail_quotations_select_scoped on public.retail_quotations;
create policy retail_quotations_select_scoped on public.retail_quotations for select to authenticated using (
  staff_current_user_ok() and (
    created_by = auth.uid() or public.retail_can_access_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))
    or (staff_is_accounts_head() and department_id = staff_current_department_id())));
drop policy if exists retail_quotations_insert_scoped on public.retail_quotations;
create policy retail_quotations_insert_scoped on public.retail_quotations for insert to authenticated with check (
  staff_current_user_ok() and (
    department_id = staff_current_department_id() or public.retail_can_write_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))));
drop policy if exists retail_quotations_update_scoped on public.retail_quotations;
create policy retail_quotations_update_scoped on public.retail_quotations for update to authenticated
  using (staff_current_user_ok() and (
    created_by = auth.uid() or public.retail_can_write_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))))
  with check (department_id = staff_current_department_id() or public.retail_can_write_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id)));

-- retail_quotation_items (scoped via parent quotation)
drop policy if exists retail_quotation_items_select_scoped on public.retail_quotation_items;
create policy retail_quotation_items_select_scoped on public.retail_quotation_items for select to authenticated using (
  staff_current_user_ok() and exists (select 1 from public.retail_quotations q where q.id = retail_quotation_items.quotation_id and (
    q.created_by = auth.uid() or public.retail_can_access_customer(q.customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(q.department_id))
    or (staff_is_accounts_head() and q.department_id = staff_current_department_id()))));
drop policy if exists retail_quotation_items_write_scoped on public.retail_quotation_items;
create policy retail_quotation_items_write_scoped on public.retail_quotation_items for all to authenticated
  using (staff_current_user_ok() and exists (select 1 from public.retail_quotations q where q.id = retail_quotation_items.quotation_id and (
    q.created_by = auth.uid() or public.retail_can_write_customer(q.customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(q.department_id)))))
  with check (exists (select 1 from public.retail_quotations q where q.id = retail_quotation_items.quotation_id and (
    q.department_id = staff_current_department_id() or public.retail_can_write_customer(q.customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(q.department_id)))));

-- retail_orders
drop policy if exists retail_orders_select_scoped on public.retail_orders;
create policy retail_orders_select_scoped on public.retail_orders for select to authenticated using (
  staff_current_user_ok() and (
    created_by = auth.uid() or public.retail_can_access_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))
    or (staff_is_accounts_head() and department_id = staff_current_department_id())));
drop policy if exists retail_orders_insert_scoped on public.retail_orders;
create policy retail_orders_insert_scoped on public.retail_orders for insert to authenticated with check (
  staff_current_user_ok() and (
    department_id = staff_current_department_id() or public.retail_can_write_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))));
drop policy if exists retail_orders_update_scoped on public.retail_orders;
create policy retail_orders_update_scoped on public.retail_orders for update to authenticated
  using (staff_current_user_ok() and (
    created_by = auth.uid() or public.retail_can_write_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))))
  with check (department_id = staff_current_department_id() or public.retail_can_write_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id)));

-- retail_order_items (scoped via parent order)
drop policy if exists retail_order_items_select_scoped on public.retail_order_items;
create policy retail_order_items_select_scoped on public.retail_order_items for select to authenticated using (
  staff_current_user_ok() and exists (select 1 from public.retail_orders o where o.id = retail_order_items.order_id and (
    o.created_by = auth.uid() or public.retail_can_access_customer(o.customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(o.department_id))
    or (staff_is_accounts_head() and o.department_id = staff_current_department_id()))));
drop policy if exists retail_order_items_write_scoped on public.retail_order_items;
create policy retail_order_items_write_scoped on public.retail_order_items for all to authenticated
  using (staff_current_user_ok() and exists (select 1 from public.retail_orders o where o.id = retail_order_items.order_id and (
    o.created_by = auth.uid() or public.retail_can_write_customer(o.customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(o.department_id)))))
  with check (exists (select 1 from public.retail_orders o where o.id = retail_order_items.order_id and (
    o.department_id = staff_current_department_id() or public.retail_can_write_customer(o.customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(o.department_id)))));

-- retail_complaints -- gains a nullable customer_id (best-effort backfilled from its order), then the same additive treatment.
alter table public.retail_complaints add column if not exists customer_id uuid references public.retail_customers(id);
update public.retail_complaints set customer_id = o.customer_id
  from public.retail_orders o where o.id = retail_complaints.order_id and retail_complaints.customer_id is null and o.customer_id is not null;
create index if not exists retail_complaints_customer_idx on public.retail_complaints (customer_id);

drop policy if exists retail_complaints_select_scoped on public.retail_complaints;
create policy retail_complaints_select_scoped on public.retail_complaints for select to authenticated using (
  staff_current_user_ok() and (
    created_by = auth.uid() or assigned_to = auth.uid() or public.retail_can_access_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))));
drop policy if exists retail_complaints_insert_scoped on public.retail_complaints;
create policy retail_complaints_insert_scoped on public.retail_complaints for insert to authenticated with check (
  staff_current_user_ok() and (
    department_id = staff_current_department_id() or public.retail_can_write_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))));
drop policy if exists retail_complaints_update_scoped on public.retail_complaints;
create policy retail_complaints_update_scoped on public.retail_complaints for update to authenticated
  using (staff_current_user_ok() and (
    created_by = auth.uid() or assigned_to = auth.uid() or public.retail_can_write_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))))
  with check (department_id = staff_current_department_id() or public.retail_can_write_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id)));

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 7. retail_upsert_customer -- gains p_salesperson_id (new trailing param, default auth.uid(), so every existing call site is
--    unaffected). Ownership is assigned ONLY on a genuine first insert; an existing customer's ownership is never touched here —
--    the only path that may change it from this point on is retail_transfer_customer.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_upsert_customer(
  p_full_name text, p_phone text, p_whatsapp text default null, p_email text default null,
  p_city text default null, p_area text default null, p_customer_type text default 'RETAIL',
  p_salesperson_id uuid default auth.uid())
returns public.retail_customers language plpgsql security definer set search_path = public as $$
declare v_norm text := public.retail_normalize_phone(p_phone); v_row public.retail_customers; v_owner uuid := coalesce(p_salesperson_id, auth.uid());
begin
  perform public.staff_assert_operational();
  if coalesce(btrim(p_full_name), '') = '' then raise exception 'Customer name is required'; end if;
  if v_norm is not null then
    select * into v_row from public.retail_customers where normalized_phone = v_norm for update;
  end if;
  if v_row.id is not null then
    update public.retail_customers set
      full_name = coalesce(nullif(btrim(p_full_name), ''), full_name),
      whatsapp = coalesce(nullif(btrim(p_whatsapp), ''), whatsapp),
      email = coalesce(nullif(btrim(p_email), ''), email),
      city = coalesce(nullif(btrim(p_city), ''), city),
      area = coalesce(nullif(btrim(p_area), ''), area)
    where id = v_row.id returning * into v_row;
    return v_row;
  end if;
  insert into public.retail_customers (
    full_name, phone, normalized_phone, whatsapp, email, city, area, customer_type, created_by,
    owner_salesperson_id, ownership_status, ownership_started_at
  ) values (
    btrim(p_full_name), nullif(btrim(p_phone), ''), v_norm, nullif(btrim(p_whatsapp), ''), nullif(btrim(p_email), ''),
    nullif(btrim(p_city), ''), nullif(btrim(p_area), ''), coalesce(p_customer_type, 'RETAIL'), auth.uid(), v_owner, 'OWNED', now()
  ) returning * into v_row;
  insert into public.retail_customer_ownership_log (customer_id, action, previous_owner_id, new_owner_id, performed_by, reason)
  values (v_row.id, 'CREATED', null, v_owner, auth.uid(), 'First entry for this customer');
  return v_row;
end $$;

-- retail_create_walkin -- CREATE OR REPLACE, same signature; the only change is passing the resolved salesperson through to the
-- upsert call explicitly, so a manager creating a walk-in "for" a salesperson still makes THAT salesperson the owner, not themselves.
create or replace function public.retail_create_walkin(
  p_customer_name text, p_phone text, p_whatsapp text default null, p_email text default null, p_city text default null,
  p_location_id uuid default null, p_requirement_category text default null, p_interested_products text default null,
  p_room_category text default null, p_approx_budget numeric default null, p_purchase_timeline text default null,
  p_lead_source text default 'walkin', p_salesperson uuid default null, p_customer_type text default 'RETAIL',
  p_notes text default null, p_lead_temperature text default 'WARM', p_next_follow_up_at timestamptz default null)
returns table (lead_id uuid, walkin_number text, customer_id uuid, task_id uuid, task_number text)
language plpgsql security definer set search_path = public as $$
declare
  v_dept uuid := public.retail_dept_id(); v_customer public.retail_customers; v_salesperson uuid; v_salesperson_dept uuid;
  v_lead_id uuid; v_walkin text; v_task_id uuid; v_task_number text; v_due_date date; v_due_time time; v_key text;
begin
  perform public.staff_assert_operational();
  if coalesce(btrim(p_customer_name), '') = '' then raise exception 'Customer name is required'; end if;
  if p_lead_temperature not in ('HOT', 'WARM', 'COLD') then raise exception 'Invalid lead temperature'; end if;

  v_salesperson := coalesce(p_salesperson, auth.uid());
  select department_id into v_salesperson_dept from public.user_profiles where id = v_salesperson and is_active = true;
  if v_salesperson_dept is distinct from v_dept then raise exception 'Salesperson must be an active Retail team member'; end if;

  v_customer := public.retail_upsert_customer(p_customer_name, p_phone, p_whatsapp, p_email, p_city, null, p_customer_type, v_salesperson);
  v_walkin := 'WI-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  insert into public.retail_leads (
    department_id, location_id, customer_id, walkin_number, customer_name, phone, whatsapp, email, city, source,
    requirement_category, interested_products, room_category, approx_budget, purchase_timeline, customer_type,
    lead_temperature, interest_notes, assigned_to, status, next_follow_up_date, next_follow_up_time, created_by
  ) values (
    v_dept, p_location_id, v_customer.id, v_walkin, btrim(p_customer_name), nullif(btrim(p_phone), ''), nullif(btrim(p_whatsapp), ''),
    nullif(btrim(p_email), ''), nullif(btrim(p_city), ''), coalesce(p_lead_source, 'walkin'),
    p_requirement_category, nullif(btrim(p_interested_products), ''), nullif(btrim(p_room_category), ''), p_approx_budget,
    nullif(btrim(p_purchase_timeline), ''), p_customer_type, p_lead_temperature, nullif(btrim(p_notes), ''), v_salesperson, 'NEW',
    (coalesce(p_next_follow_up_at, now() + interval '1 day'))::date, (coalesce(p_next_follow_up_at, now() + interval '1 day'))::time,
    auth.uid()
  ) returning id into v_lead_id;

  v_due_date := (coalesce(p_next_follow_up_at, now() + interval '1 day'))::date;
  v_due_time := (coalesce(p_next_follow_up_at, now() + interval '1 day'))::time;
  v_key := 'retail_followup:lead:' || v_lead_id::text;
  select st.id, st.task_number into v_task_id, v_task_number from public.staff_tasks st where st.system_key = v_key;
  if v_task_id is null then
    select t.task_id, t.task_number into v_task_id, v_task_number from public.staff_create_task(
      'Follow up: ' || btrim(p_customer_name), coalesce(p_notes, 'New walk-in — first follow-up'), 'FOLLOW_UP', 'NORMAL', 'none',
      v_dept, v_dept, v_salesperson, v_due_date, v_due_time, null, v_walkin, p_interested_products, null, null, null) t;
    update public.staff_tasks set system_key = v_key where id = v_task_id;
  end if;

  update public.retail_leads set linked_task_id = v_task_id where id = v_lead_id;
  perform public.staff_write_audit('retail_lead', v_lead_id, 'CREATE_WALKIN',
    null, jsonb_build_object('walkin_number', v_walkin, 'customer_id', v_customer.id, 'assigned_to', v_salesperson), v_dept);
  if v_salesperson <> auth.uid() then
    perform public.staff_notify_assignment(v_salesperson, 'retail_lead', v_lead_id,
      'New walk-in assigned: ' || btrim(p_customer_name), 'નવો વોક-ઇન સોંપાયો: ' || btrim(p_customer_name));
  end if;

  return query select v_lead_id, v_walkin, v_customer.id, v_task_id, v_task_number;
end $$;

-- retail_create_quotation -- CREATE OR REPLACE, same signature; now resolves/creates the customer itself (via retail_upsert_customer,
-- owner = the caller) when no lead already supplied a customer_id — closing the one "first entry" point that used to skip ownership
-- assignment entirely (a quotation created without a prior lead never touched retail_customers before this).
create or replace function public.retail_create_quotation(
  p_lead_id uuid, p_customer_name text, p_phone text, p_location_id uuid default null, p_valid_until date default null,
  p_expected_delivery date default null, p_delivery_charge numeric default 0, p_installation_charge numeric default 0,
  p_terms text default null, p_internal_approval_required boolean default false, p_items jsonb default '[]'::jsonb,
  p_supersedes_id uuid default null)
returns public.retail_quotations language plpgsql security definer set search_path = public as $$
declare
  v_dept uuid := public.retail_dept_id(); v_customer_id uuid; v_number text; v_revision int := 1; v_total numeric := 0;
  v_row public.retail_quotations; v_item jsonb; v_line numeric;
begin
  perform public.staff_assert_operational();
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then raise exception 'At least one line item is required'; end if;
  if p_lead_id is not null then select customer_id into v_customer_id from public.retail_leads where id = p_lead_id; end if;
  if v_customer_id is null then
    v_customer_id := (public.retail_upsert_customer(p_customer_name, p_phone, null, null, null, null, 'RETAIL', auth.uid())).id;
  end if;
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

  insert into public.retail_quotations (
    department_id, lead_id, customer_id, quotation_number, customer_name, phone, status, total_amount, valid_until,
    delivery_charge, installation_charge, terms, expected_delivery, supersedes_id, revision_no, internal_approval_required, created_by
  ) values (
    v_dept, p_lead_id, v_customer_id, v_number, btrim(p_customer_name), nullif(btrim(p_phone), ''), 'DRAFT', v_total, p_valid_until,
    coalesce(p_delivery_charge, 0), coalesce(p_installation_charge, 0), p_terms, p_expected_delivery, p_supersedes_id, v_revision,
    coalesce(p_internal_approval_required, false), auth.uid()
  ) returning * into v_row;

  insert into public.retail_quotation_items (quotation_id, item_name, sku, description, dimensions, product_image_path, quantity, unit_price, discount, tax, line_total, customization_notes)
  select v_row.id, it->>'item_name', it->>'sku', it->>'description', it->>'dimensions', it->>'product_image_path',
    coalesce((it->>'quantity')::numeric, 0), coalesce((it->>'unit_price')::numeric, 0), coalesce((it->>'discount')::numeric, 0), coalesce((it->>'tax')::numeric, 0),
    coalesce((it->>'quantity')::numeric, 0) * coalesce((it->>'unit_price')::numeric, 0) - coalesce((it->>'discount')::numeric, 0) + coalesce((it->>'tax')::numeric, 0),
    it->>'customization_notes'
  from jsonb_array_elements(p_items) it;

  if p_lead_id is not null then update public.retail_leads set status = 'QUOTED' where id = p_lead_id; end if;
  perform public.staff_write_audit('retail_quotation', v_row.id, 'CREATE', null, jsonb_build_object('quotation_number', v_number, 'total', v_total), v_dept);
  return v_row;
end $$;

-- retail_record_followup -- CREATE OR REPLACE, same signature; adds an explicitly-granted BACKUP/TEMPORARY access holder as one
-- more authorized party, coalesced exactly like the v2_93g hotfix (never a bare boolean that can evaluate to SQL NULL).
create or replace function public.retail_record_followup(
  p_lead_id uuid, p_contact_mode text, p_outcome text default null, p_customer_response text default null,
  p_products_discussed text default null, p_expected_decision_date date default null, p_revised_budget numeric default null,
  p_notes text default null, p_next_action text default null, p_next_follow_up_at timestamptz default null,
  p_status text default 'CONTACTED', p_lost_reason text default null)
returns table (followup_id uuid, task_id uuid, task_number text)
language plpgsql security definer set search_path = public as $$
declare
  v_lead public.retail_leads; v_prev uuid; v_followup_id uuid; v_task_id uuid; v_task_number text; v_key text; v_lead_status text;
  v_open_statuses constant text[] := array['NEW','CONTACTED','FOLLOW_UP_DUE','INTERESTED','QUOTATION_REQUESTED','QUOTATION_SENT','NEGOTIATION','DECISION_PENDING','ON_HOLD'];
begin
  perform public.staff_assert_operational();
  select * into v_lead from public.retail_leads where id = p_lead_id for update;
  if v_lead.id is null then raise exception 'Lead not found'; end if;
  if not (coalesce(v_lead.assigned_to = auth.uid(), false) or coalesce(v_lead.created_by = auth.uid(), false)
          or coalesce(public.staff_has_global_oversight(), false)
          or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_lead.department_id), false))
          or coalesce(public.retail_can_write_customer(v_lead.customer_id), false)) then
    raise exception 'Not authorized to record a follow-up on this lead';
  end if;
  if p_contact_mode not in ('CALL', 'WHATSAPP', 'VISIT', 'EMAIL') then raise exception 'Invalid contact mode'; end if;
  if p_status not in ('NEW','CONTACTED','FOLLOW_UP_DUE','INTERESTED','QUOTATION_REQUESTED','QUOTATION_SENT','NEGOTIATION','DECISION_PENDING','WON','LOST','NOT_RESPONDING','ON_HOLD') then
    raise exception 'Invalid follow-up status';
  end if;

  select id into v_prev from public.retail_followups where lead_id = p_lead_id order by created_at desc limit 1;

  insert into public.retail_followups (
    department_id, lead_id, customer_id, previous_followup_id, contact_mode, outcome, customer_response, products_discussed,
    expected_decision_date, revised_budget, notes, next_action, next_follow_up_at, status, lost_reason, created_by
  ) values (
    v_lead.department_id, p_lead_id, v_lead.customer_id, v_prev, p_contact_mode, p_outcome, p_customer_response, p_products_discussed,
    p_expected_decision_date, p_revised_budget, p_notes, p_next_action, p_next_follow_up_at, p_status, p_lost_reason, auth.uid()
  ) returning id into v_followup_id;

  v_lead_status := case when p_status = 'WON' then v_lead.status when p_status = 'LOST' then 'LOST'
    when p_status in ('QUOTATION_REQUESTED', 'QUOTATION_SENT', 'NEGOTIATION') then 'QUOTED' else 'FOLLOW_UP' end;
  update public.retail_leads set status = v_lead_status,
    next_follow_up_date = p_next_follow_up_at::date, next_follow_up_time = p_next_follow_up_at::time
  where id = p_lead_id;

  if v_lead.linked_task_id is not null then
    update public.staff_tasks set is_active = false where id = v_lead.linked_task_id and is_active = true
      and status_id not in (select id from public.status_master where code in ('CLOSED', 'VERIFIED'));
  end if;
  update public.retail_leads set linked_task_id = null where id = p_lead_id;

  if p_next_follow_up_at is not null and p_status = any(v_open_statuses) then
    v_key := 'retail_followup:' || v_followup_id::text;
    select st.id, st.task_number into v_task_id, v_task_number from public.staff_tasks st where st.system_key = v_key;
    if v_task_id is null then
      select tk.task_id, tk.task_number into v_task_id, v_task_number from public.staff_create_task(
        'Follow up: ' || v_lead.customer_name, coalesce(p_next_action, 'Scheduled follow-up'), 'FOLLOW_UP', 'NORMAL', 'none',
        v_lead.department_id, v_lead.department_id, v_lead.assigned_to, p_next_follow_up_at::date, p_next_follow_up_at::time,
        null, v_lead.walkin_number, p_products_discussed, null, null, null) tk;
      update public.staff_tasks set system_key = v_key where id = v_task_id;
    end if;
    update public.retail_followups set linked_task_id = v_task_id where id = v_followup_id;
    update public.retail_leads set linked_task_id = v_task_id where id = p_lead_id;
    if v_lead.assigned_to is distinct from auth.uid() and v_lead.assigned_to is not null then
      perform public.staff_notify_assignment(v_lead.assigned_to, 'retail_lead', p_lead_id,
        'Next follow-up scheduled: ' || v_lead.customer_name, 'આગલું ફોલો-અપ નક્કી થયું: ' || v_lead.customer_name);
    end if;
  end if;

  perform public.staff_write_audit('retail_lead', p_lead_id, 'FOLLOW_UP',
    jsonb_build_object('previous_status', v_lead.status), jsonb_build_object('status', p_status, 'followup_id', v_followup_id), v_lead.department_id);

  return query select v_followup_id, v_task_id, v_task_number;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 8. duplicate detection -- exact-normalized only (phone / whatsapp / email / lowercased name+city). Contact fields are withheld
--    unless the caller already has access to the matched customer (owner_name is always shown so the UI can say who to ask).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_check_duplicate_customer(
  p_full_name text, p_phone text default null, p_whatsapp text default null, p_email text default null, p_city text default null)
returns table (customer_id uuid, match_reason text, full_name text, city text, owner_name text, owner_id uuid,
               can_view_contact boolean, phone text, whatsapp text, email text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_norm_phone text := public.retail_normalize_phone(p_phone); v_norm_wa text := public.retail_normalize_phone(p_whatsapp);
  v_norm_email text := nullif(lower(btrim(coalesce(p_email, ''))), ''); v_norm_name text := nullif(lower(btrim(coalesce(p_full_name, ''))), '');
  v_norm_city text := nullif(lower(btrim(coalesce(p_city, ''))), '');
begin
  perform public.staff_assert_operational();
  return query
  select c.id, m.reason, c.full_name, c.city, up.full_name, c.owner_salesperson_id,
    public.retail_can_access_customer(c.id),
    case when public.retail_can_access_customer(c.id) then c.phone else null end,
    case when public.retail_can_access_customer(c.id) then c.whatsapp else null end,
    case when public.retail_can_access_customer(c.id) then c.email else null end
  from public.retail_customers c
  left join public.user_profiles up on up.id = c.owner_salesperson_id
  cross join lateral (
    select case
      when v_norm_phone is not null and c.normalized_phone = v_norm_phone then 'PHONE'
      when v_norm_wa is not null and public.retail_normalize_phone(c.whatsapp) = v_norm_wa then 'WHATSAPP'
      when v_norm_email is not null and lower(btrim(coalesce(c.email, ''))) = v_norm_email then 'EMAIL'
      when v_norm_name is not null and v_norm_city is not null and lower(btrim(c.full_name)) = v_norm_name and lower(btrim(coalesce(c.city, ''))) = v_norm_city then 'NAME_CITY'
      else null end as reason
  ) m
  where c.is_active and m.reason is not null
  order by case m.reason when 'PHONE' then 1 when 'WHATSAPP' then 2 when 'EMAIL' then 3 else 4 end
  limit 5;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 9. transfer / share -- the ONLY path allowed to change retail_customers ownership after creation, or to grant backup/temporary/
--    readonly access. Always logged, always notifies the new assignee, never silent.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_transfer_customer(
  p_customer_id uuid, p_new_owner_id uuid, p_transfer_type text, p_effective_date date default current_date,
  p_until date default null, p_reason text default null, p_approved_by uuid default null)
returns public.retail_customers language plpgsql security definer set search_path = public as $$
declare v_customer public.retail_customers; v_allowed boolean; v_new_dept uuid; v_prev_owner uuid;
begin
  perform public.staff_assert_operational();
  if p_transfer_type not in ('PERMANENT', 'TEMPORARY', 'BACKUP', 'READONLY') then raise exception 'Invalid transfer type'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required'; end if;

  select * into v_customer from public.retail_customers where id = p_customer_id for update;
  if v_customer.id is null then raise exception 'Customer not found'; end if;

  v_allowed := (coalesce(v_customer.owner_salesperson_id = auth.uid(), false) or coalesce(v_customer.created_by = auth.uid(), false)
    or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false)));
  if not v_allowed then raise exception 'Not authorized to transfer or share this customer'; end if;

  select department_id into v_new_dept from public.user_profiles where id = p_new_owner_id and is_active = true;
  if v_new_dept is distinct from public.retail_dept_id() then raise exception 'New assignee must be an active Retail team member'; end if;

  v_prev_owner := v_customer.owner_salesperson_id;
  if p_transfer_type = 'PERMANENT' then
    update public.retail_customers set
      previous_owner_id = v_prev_owner, owner_salesperson_id = p_new_owner_id, transferred_by = auth.uid(),
      transfer_reason = p_reason, transferred_at = now(), ownership_status = 'OWNED'
    where id = p_customer_id returning * into v_customer;
    insert into public.retail_customer_ownership_log (customer_id, action, previous_owner_id, new_owner_id, performed_by, reason, effective_date)
    values (p_customer_id, 'TRANSFERRED', v_prev_owner, p_new_owner_id, auth.uid(), p_reason, p_effective_date);
  else
    insert into public.retail_customer_access (customer_id, user_id, access_type, granted_by, effective_from, effective_until, reason)
    values (p_customer_id, p_new_owner_id, p_transfer_type, auth.uid(), p_effective_date, p_until, p_reason);
    insert into public.retail_customer_ownership_log (customer_id, action, previous_owner_id, new_owner_id, performed_by, reason, effective_date)
    values (p_customer_id, case p_transfer_type when 'BACKUP' then 'BACKUP_ADDED' else 'SHARED' end, v_prev_owner, p_new_owner_id, auth.uid(), p_reason, p_effective_date);
  end if;

  perform public.staff_write_audit('retail_customer', p_customer_id, 'TRANSFER_' || p_transfer_type,
    jsonb_build_object('previous_owner', v_prev_owner), jsonb_build_object('new_assignee', p_new_owner_id, 'type', p_transfer_type), public.retail_dept_id());
  perform public.staff_notify_assignment(p_new_owner_id, 'retail_customer', p_customer_id,
    'Customer assigned to you: ' || v_customer.full_name, 'ગ્રાહક તમને સોંપાયો: ' || v_customer.full_name);

  return v_customer;
end $$;

-- retail_request_customer_access -- what the "Request Access" button on a duplicate-match hit calls.
create or replace function public.retail_request_customer_access(p_customer_id uuid, p_reason text default null)
returns public.retail_customer_access_requests language plpgsql security definer set search_path = public as $$
declare v_customer public.retail_customers; v_req public.retail_customer_access_requests;
begin
  perform public.staff_assert_operational();
  select * into v_customer from public.retail_customers where id = p_customer_id;
  if v_customer.id is null then raise exception 'Customer not found'; end if;
  if public.retail_can_access_customer(p_customer_id) then raise exception 'You already have access to this customer'; end if;

  insert into public.retail_customer_access_requests (customer_id, requested_by, reason)
  values (p_customer_id, auth.uid(), p_reason) returning * into v_req;

  perform public.staff_write_audit('retail_customer', p_customer_id, 'ACCESS_REQUEST', null, jsonb_build_object('requested_by', auth.uid()), public.retail_dept_id());
  if v_customer.owner_salesperson_id is not null then
    perform public.staff_notify_assignment(v_customer.owner_salesperson_id, 'retail_customer', p_customer_id,
      'A colleague requested access to ' || v_customer.full_name, v_customer.full_name || ' માટે સાથીદારે ઍક્સેસ માંગી');
  end if;
  return v_req;
end $$;

-- retail_decide_access_request -- owner (or oversight/dept-head) approves/denies; approval grants TEMPORARY access (a deliberate,
-- separate action is required to make it PERMANENT or BACKUP).
create or replace function public.retail_decide_access_request(p_request_id uuid, p_approved boolean, p_notes text default null)
returns public.retail_customer_access_requests language plpgsql security definer set search_path = public as $$
declare v_req public.retail_customer_access_requests; v_customer public.retail_customers; v_allowed boolean;
begin
  perform public.staff_assert_operational();
  select * into v_req from public.retail_customer_access_requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'Request not found'; end if;
  if v_req.status <> 'PENDING' then return v_req; end if; -- idempotent: already decided

  select * into v_customer from public.retail_customers where id = v_req.customer_id;
  v_allowed := (coalesce(v_customer.owner_salesperson_id = auth.uid(), false) or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false)));
  if not v_allowed then raise exception 'Not authorized to decide this access request'; end if;

  update public.retail_customer_access_requests set status = case when p_approved then 'APPROVED' else 'DENIED' end,
    decided_by = auth.uid(), decided_at = now() where id = p_request_id returning * into v_req;

  if p_approved then
    perform public.retail_transfer_customer(v_req.customer_id, v_req.requested_by, 'TEMPORARY', current_date, null,
      coalesce(p_notes, v_req.reason, 'Access request approved'), auth.uid());
  end if;
  perform public.staff_write_audit('retail_customer_access_request', p_request_id, case when p_approved then 'APPROVE' else 'DENY' end,
    null, jsonb_build_object('customer_id', v_req.customer_id, 'requested_by', v_req.requested_by), public.retail_dept_id());
  perform public.staff_notify_assignment(v_req.requested_by, 'retail_customer', v_req.customer_id,
    case when p_approved then 'Access request approved' else 'Access request denied' end,
    case when p_approved then 'ઍક્સેસ વિનંતી મંજૂર થઈ' else 'ઍક્સેસ વિનંતી નકારાઈ' end);
  return v_req;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 10. merge -- management/dept-head-in-scope only. Repoints every child row, keeps the duplicate (soft-merged, never deleted),
--     preserves both customers' ownership history under the surviving primary.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_merge_customers(p_primary_id uuid, p_duplicate_id uuid, p_reason text)
returns public.retail_customers language plpgsql security definer set search_path = public as $$
declare v_primary public.retail_customers; v_dup public.retail_customers; v_allowed boolean;
begin
  perform public.staff_assert_operational();
  if p_primary_id = p_duplicate_id then raise exception 'Cannot merge a customer into itself'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A merge reason is required'; end if;

  select * into v_primary from public.retail_customers where id = p_primary_id for update;
  select * into v_dup from public.retail_customers where id = p_duplicate_id for update;
  if v_primary.id is null or v_dup.id is null then raise exception 'Customer not found'; end if;
  if v_dup.merged_into_id is not null then return v_primary; end if; -- idempotent: already merged

  v_allowed := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false)));
  if not v_allowed then raise exception 'Only Retail Head or Management may merge customers'; end if;

  update public.retail_leads set customer_id = p_primary_id where customer_id = p_duplicate_id;
  update public.retail_quotations set customer_id = p_primary_id where customer_id = p_duplicate_id;
  update public.retail_orders set customer_id = p_primary_id where customer_id = p_duplicate_id;
  update public.retail_complaints set customer_id = p_primary_id where customer_id = p_duplicate_id;
  update public.retail_followups set customer_id = p_primary_id where customer_id = p_duplicate_id;
  update public.retail_customer_access set customer_id = p_primary_id where customer_id = p_duplicate_id;
  update public.retail_customer_ownership_log set customer_id = p_primary_id where customer_id = p_duplicate_id;
  update public.retail_customer_access_requests set customer_id = p_primary_id where customer_id = p_duplicate_id;

  update public.retail_customers set merged_into_id = p_primary_id, ownership_status = 'MERGED', is_active = false where id = p_duplicate_id;

  insert into public.retail_customer_ownership_log (customer_id, action, previous_owner_id, new_owner_id, performed_by, reason)
  values (p_primary_id, 'MERGED', v_dup.owner_salesperson_id, v_primary.owner_salesperson_id, auth.uid(), p_reason);

  perform public.staff_write_audit('retail_customer', p_primary_id, 'MERGE', jsonb_build_object('duplicate_id', p_duplicate_id),
    jsonb_build_object('reason', p_reason), public.retail_dept_id());

  return v_primary;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 11. customer timeline -- partial version (leads/followups/quotations/orders/payments/fulfilment/complaints/ownership log only;
--     packing/godown/dispatch/installation entries are added by a later CREATE OR REPLACE once those tables exist, v2_93k).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_customer_timeline(p_customer_id uuid)
returns table (entry_type text, entity_id uuid, occurred_at timestamptz, title text, status text, linked_task_id uuid)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_assert_operational();
  if not public.retail_can_access_customer(p_customer_id) then raise exception 'Not authorized to view this customer'; end if;
  return query
  -- the first branch's column ALIASES become the UNION's own output column names, required for "order by occurred_at" below to
  -- resolve at all (a bug found live and fixed in v2_93k2 once this function's full version was actually executed for the first time).
  select 'LEAD'::text as entry_type, l.id as entity_id, l.created_at as occurred_at, coalesce(l.walkin_number, 'Lead') || ' — ' || l.customer_name as title, l.status as status, l.linked_task_id as linked_task_id
    from public.retail_leads l where l.customer_id = p_customer_id
  union all
  select 'FOLLOWUP', f.id, f.created_at, 'Follow-up (' || f.contact_mode || ')', f.status, f.linked_task_id
    from public.retail_followups f where f.customer_id = p_customer_id
  union all
  select 'QUOTATION', q.id, q.created_at, q.quotation_number || ' (v' || q.revision_no || ')', q.status, null::uuid
    from public.retail_quotations q where q.customer_id = p_customer_id
  union all
  select 'ORDER', o.id, o.created_at, o.order_number, o.status, o.linked_task_id
    from public.retail_orders o where o.customer_id = p_customer_id
  union all
  select 'PAYMENT', p.id, p.paid_at, 'Payment received', p.payment_mode, null::uuid
    from public.retail_payments p join public.retail_orders o on o.id = p.order_id where o.customer_id = p_customer_id
  union all
  select 'FULFILMENT', fi.id, fi.created_at, fi.mode || ' fulfilment', fi.status, null::uuid
    from public.retail_fulfilment_items fi join public.retail_orders o on o.id = fi.order_id where o.customer_id = p_customer_id
  union all
  select 'COMPLAINT', c.id, c.created_at, c.description, c.status, null::uuid
    from public.retail_complaints c where c.customer_id = p_customer_id
  union all
  select 'OWNERSHIP_CHANGE', log.id, log.created_at, log.action, log.action, null::uuid
    from public.retail_customer_ownership_log log where log.customer_id = p_customer_id
  order by occurred_at desc;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 12. grants -- every new/changed RPC follows the established revoke-from-public-and-anon / grant-to-authenticated convention.
-- ---------------------------------------------------------------------------------------------------------------------------------
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'retail_upsert_customer(text, text, text, text, text, text, text, uuid)',
    'retail_create_walkin(text, text, text, text, text, uuid, text, text, text, numeric, text, text, uuid, text, text, text, timestamptz)',
    'retail_create_quotation(uuid, text, text, uuid, date, date, numeric, numeric, text, boolean, jsonb, uuid)',
    'retail_record_followup(uuid, text, text, text, text, date, numeric, text, text, timestamptz, text, text)',
    'retail_check_duplicate_customer(text, text, text, text, text)',
    'retail_transfer_customer(uuid, uuid, text, date, date, text, uuid)',
    'retail_request_customer_access(uuid, text)',
    'retail_decide_access_request(uuid, boolean, text)',
    'retail_merge_customers(uuid, uuid, text)',
    'retail_customer_timeline(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
