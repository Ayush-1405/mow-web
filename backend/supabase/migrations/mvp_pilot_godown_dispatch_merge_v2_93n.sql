-- Safe merge of Godown/Inventory (GODOWN_INV) + Dispatch/Logistics (DISPATCH) into one department:
-- "Godown, Inventory & Dispatch". Confirmed live (audit, 2026-09-24): both departments have ZERO real users and
-- ZERO data rows referencing them anywhere in the schema except 2 auto-generated chat_conversations rows -- so this
-- is a clean consolidation, not a painful data migration. `departments.code` is UNIQUE, so the two codes cannot
-- collapse into one row; instead GODOWN_INV survives as the canonical row (it already owns more of the built
-- pipeline) and DISPATCH is retired (is_active=false, parent_department_id -> GODOWN_INV) rather than deleted --
-- its full row, code and history stay queryable forever for audit purposes.
--
-- Nearly all RLS/RPC logic already funnels through 4 helper functions (retail_godown_dept_id/
-- retail_dispatch_dept_id/staff_is_godown_staff/staff_is_dispatch_staff) -- aliasing the two "dispatch" ones to
-- the "godown" ones is what makes the entire existing packing/handover/dispatch/delivery/installation pipeline
-- (built earlier this session) treat Dispatch and Godown staff as one pool, with zero edits to its 20+ callers.

-- 1. Rename the surviving department.
update public.departments
set name_en = 'Godown, Inventory & Dispatch', name_gu = 'ગોડાઉન, ઇન્વેન્ટરી અને ડિસ્પેચ'
where code = 'GODOWN_INV';

-- 2. Retire the DISPATCH row (never delete -- full audit history stays intact and queryable).
update public.departments
set is_active = false, parent_department_id = (select id from public.departments where code = 'GODOWN_INV')
where code = 'DISPATCH';

-- 3. Alias the two "dispatch" helpers onto the "godown" ones -- same signatures, safe CREATE OR REPLACE.
create or replace function public.retail_dispatch_dept_id()
returns uuid
language sql
stable security definer
set search_path to 'public'
as $function$ select public.retail_godown_dept_id(); $function$;

create or replace function public.staff_is_dispatch_staff()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$ select public.staff_is_godown_staff(); $function$;

-- 4. Cosmetic-only cleanup: route the 4 objects that bypassed the helper functions and hardcoded the department
--    code inline through retail_godown_dept_id() instead, for consistency with every other caller. Behaviorally
--    identical (GODOWN_INV's id/code are unchanged by this merge) -- not a bug fix, just closing a DRY gap the
--    pre-merge audit found, so nothing is left pointing at a literal that a future rename could silently break.
create or replace function public.retail_stock_availability(p_query text default null::text, p_location_id uuid default null::uuid)
returns table(product_id uuid, sku text, name text, category text, image_path text, unit text, location_id uuid, location_name text, on_hand_qty numeric, damaged_qty numeric, incoming_qty numeric, reserved_qty numeric, available_qty numeric, expected_availability_date date, rack_location text)
language sql
stable security definer
set search_path to 'public'
as $function$
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
    staff_current_department_id() in (select id from departments where code = 'RETAIL') or staff_current_department_id() = public.retail_godown_dept_id()
    or staff_has_global_oversight()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(retail_dept_id()) or staff_dept_in_hod_scope(public.retail_godown_dept_id()))))
    and (p_query is null or btrim(p_query) = '' or p.name ilike '%' || p_query || '%' or p.sku ilike '%' || p_query || '%' or p.category ilike '%' || p_query || '%')
    and (p_location_id is null or s.location_id = p_location_id)
  order by p.name, l.name_en;
$function$;

drop policy if exists retail_products_select on public.retail_products;
create policy retail_products_select on public.retail_products for select using (
  staff_current_user_ok() and (
    staff_current_department_id() in (select id from departments where code = 'RETAIL') or staff_current_department_id() = public.retail_godown_dept_id()
    or staff_has_global_oversight()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(retail_dept_id()) or staff_dept_in_hod_scope(public.retail_godown_dept_id())))
  ));

drop policy if exists retail_products_write on public.retail_products;
create policy retail_products_write on public.retail_products for all using (
  staff_current_user_ok() and (
    staff_has_global_oversight()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(retail_dept_id()) or staff_dept_in_hod_scope(public.retail_godown_dept_id())))
  )) with check (
  staff_current_user_ok() and (
    staff_has_global_oversight()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(retail_dept_id()) or staff_dept_in_hod_scope(public.retail_godown_dept_id())))
  ));

drop policy if exists retail_stock_select on public.retail_stock;
create policy retail_stock_select on public.retail_stock for select using (
  staff_current_user_ok() and (
    staff_current_department_id() in (select id from departments where code = 'RETAIL') or staff_current_department_id() = public.retail_godown_dept_id()
    or staff_has_global_oversight()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(retail_dept_id()) or staff_dept_in_hod_scope(public.retail_godown_dept_id())))
  ));

drop policy if exists retail_stock_write on public.retail_stock;
create policy retail_stock_write on public.retail_stock for all using (
  staff_current_user_ok() and (
    staff_has_global_oversight()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(retail_dept_id()) or staff_dept_in_hod_scope(public.retail_godown_dept_id())))
  )) with check (
  staff_current_user_ok() and (
    staff_has_global_oversight()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(retail_dept_id()) or staff_dept_in_hod_scope(public.retail_godown_dept_id())))
  ));

-- 5. Permanent audit record of the merge itself. staff_write_audit() inserts performed_by = auth.uid(), which is
--    null outside a request context (this migration runs as the migration-apply role, not an authenticated user)
--    -- insert the row directly instead, with performed_by left null, exactly the way a system-originated audit
--    entry is meant to look (auth.uid() would be null here even if we routed through the RPC).
insert into public.staff_audit_log (entity_type, entity_id, action, old_value, new_value, department_id, remarks, performed_by, performed_by_role)
select 'department', d.id, 'MERGE', jsonb_build_object('name_en', 'Godown/Inventory'),
  jsonb_build_object('name_en', 'Godown, Inventory & Dispatch', 'merged_department_code', 'DISPATCH'),
  d.id, 'Godown/Inventory and Dispatch/Logistics merged into one department (v2_93n); DISPATCH row retired, not deleted.', null, 'system'
from public.departments d where d.code = 'GODOWN_INV';
