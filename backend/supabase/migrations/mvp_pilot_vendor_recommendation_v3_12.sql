-- Product-wise / material-wise vendor recommendation, vendor master upgrade, per-item vendor allocation.
--
-- * Vendor master (existing `vendors`): WhatsApp, several material categories, brands, specifications, average delivery
--   days, preference (Highly Preferred / Preferred / Regular, set by Management or the Procurement Head), Temporarily
--   Blocked / Blacklisted, active flag. Internal remarks and documents are kept apart, visible to Procurement and
--   Management only.
-- * procurement_categories: the material categories with their matching keywords -- configuration, editable by the
--   Procurement Head / Management. An order line's categories come from its description, item code and remarks.
-- * proc_recommend_vendors: for every line of an order, the vendors that match it (category, brand, or supplied the same
--   item before), never blocked / blacklisted / inactive ones, grouped Preferred -> Regular approved -> Other, and scored
--   only from real records: preference, category / brand match, previous purchases of that item, on-time deliveries,
--   quality rejections, whether the usual delivery time meets the due date. Nothing is invented: a vendor with no
--   history simply has no history.
-- * proc_vendor_performance: per vendor -- orders, value, on-time / delayed deliveries, cancellations, quality
--   rejections, last purchase, department-wise purchases -- from purchase orders, vendor allocations and receipts.
-- * purchase_vendor_allocations: one vendor per order line, each with its own vendor PO / reference, rate, amount and
--   expected delivery; proc_place_order_with_vendors places the order (one main purchase order, as every later step --
--   delivery, GRN, invoice, payment -- expects) and records the split. Expected delivery after the department's due date
--   needs a written reason. The order row is locked and each line can be allocated once, so nothing is duplicated.

begin;

-- ---------------------------------------------------------------------------
-- 1. Structure
-- ---------------------------------------------------------------------------

create table if not exists public.procurement_categories (
  code text primary key check (code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  name_en text not null,
  name_gu text,
  keywords text[] not null default '{}',
  is_active boolean not null default true,
  sort_order integer not null default 100,
  updated_by uuid references public.user_profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
-- The standard categories and the words that identify them on an order line (lower-case, whole words).
insert into public.procurement_categories (code, name_en, name_gu, keywords, sort_order) values
  ('PLYWOOD', 'Plywood & boards', 'પ્લાયવુડ અને બોર્ડ', array['plywood','ply','bwr','bwp','mr grade','marine','block board','blockboard','mdf','hdhmr','particle board','flush door'], 10),
  ('LAMINATE', 'Laminates & veneers', 'લેમિનેટ અને વિનિયર', array['laminate','laminates','sunmica','veneer','acrylic','edge band','edgeband','louver'], 20),
  ('HARDWARE', 'Hardware & fittings', 'હાર્ડવેર અને ફિટિંગ', array['hardware','hinge','hinges','channel','channels','drawer slide','handle','handles','knob','lock','screw','screws','bracket','tandem','soft close','gas lift','telescopic','fitting','fittings'], 30),
  ('FURNITURE', 'Furniture (manufactured)', 'ફર્નિચર', array['furniture','sofa','bed','chair','chairs','table','wardrobe','cabinet','dresser','recliner','dining'], 40),
  ('FABRIC', 'Fabric & upholstery', 'કાપડ અને અપહોલ્સ્ટરી', array['fabric','upholstery','curtain','curtains','cloth','velvet','leather','leatherette','rexine'], 50),
  ('FOAM', 'Foam & cushioning', 'ફોમ અને ગાદી', array['foam','cushion','cushions','mattress','pu foam','fibre','fiber'], 60),
  ('GLASS', 'Glass & mirrors', 'કાચ અને અરીસા', array['glass','mirror','mirrors','toughened','lacquered'], 70),
  ('ELECTRICAL', 'Electrical', 'ઇલેક્ટ્રિકલ', array['electrical','wire','wires','cable','cables','switch','switches','socket','sockets','mcb','conduit','db box'], 80),
  ('LIGHTING', 'Lighting', 'લાઇટિંગ', array['light','lights','lighting','led','lamp','chandelier','profile light','strip light','spotlight','downlight'], 90),
  ('PAINT', 'Paint & polish', 'પેઇન્ટ અને પોલિશ', array['paint','polish','primer','putty','enamel','melamine','duco','pu polish','lacquer','stain'], 100),
  ('RAW_MATERIAL', 'Raw material', 'કાચો માલ', array['timber','wood','teak','sheesham','steel','aluminium','aluminum','ms pipe','adhesive','fevicol','raw material'], 110),
  ('FINISHED_GOODS', 'Finished goods', 'તૈયાર માલ', array['finished goods','ready made','readymade','finished product'], 120)
on conflict (code) do nothing;

alter table public.vendors
  add column if not exists whatsapp text,
  add column if not exists categories text[] not null default '{}',
  add column if not exists brands text[] not null default '{}',
  add column if not exists specifications text,
  add column if not exists avg_delivery_days integer check (avg_delivery_days is null or avg_delivery_days between 0 and 365),
  add column if not exists preference text not null default 'REGULAR',
  add column if not exists is_active boolean not null default true;
do $$ begin
  alter table public.vendors add constraint vendors_preference_check check (preference in ('HIGHLY_PREFERRED', 'PREFERRED', 'REGULAR'));
exception when duplicate_object then null; end $$;
create index if not exists vendors_categories_idx on public.vendors using gin (categories);

-- Internal remarks and documents: Procurement and Management only (the vendor directory itself is readable by all staff).
create table if not exists public.vendor_internal_notes (
  vendor_id uuid primary key references public.vendors(id) on delete cascade,
  remarks text,
  updated_by uuid references public.user_profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
create table if not exists public.vendor_documents (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  file_type text,
  description text,
  uploaded_by uuid references public.user_profiles(id) on delete set null,
  uploaded_at timestamptz not null default now()
);

create table if not exists public.purchase_vendor_allocations (
  id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid not null references public.purchase_requests(id) on delete cascade,
  item_id uuid not null unique references public.purchase_request_items(id) on delete cascade,
  vendor_id uuid not null references public.vendors(id),
  purchase_order_id uuid references public.purchase_orders(id) on delete set null,
  vendor_po_reference text not null,
  quotation_reference text,
  rate numeric(14,2),
  amount numeric(14,2),
  expected_delivery_date date not null,
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists purchase_vendor_allocations_vendor_idx on public.purchase_vendor_allocations (vendor_id, created_at desc);
create index if not exists purchase_vendor_allocations_request_idx on public.purchase_vendor_allocations (purchase_request_id);

alter table public.procurement_categories enable row level security;
alter table public.vendor_internal_notes enable row level security;
alter table public.vendor_documents enable row level security;
alter table public.purchase_vendor_allocations enable row level security;
revoke all on public.procurement_categories, public.vendor_internal_notes, public.vendor_documents, public.purchase_vendor_allocations from anon, authenticated;
grant select on public.procurement_categories, public.vendor_internal_notes, public.vendor_documents, public.purchase_vendor_allocations to authenticated;
drop policy if exists procurement_categories_select on public.procurement_categories;
create policy procurement_categories_select on public.procurement_categories for select to authenticated using (public.staff_current_user_ok());
drop policy if exists vendor_internal_notes_select on public.vendor_internal_notes;
create policy vendor_internal_notes_select on public.vendor_internal_notes for select to authenticated
  using (public.staff_current_user_ok() and (public.proc_is_procurement_member() or public.staff_has_global_oversight()));
drop policy if exists vendor_documents_select on public.vendor_documents;
create policy vendor_documents_select on public.vendor_documents for select to authenticated
  using (public.staff_current_user_ok() and (public.proc_is_procurement_member() or public.staff_has_global_oversight()));
drop policy if exists purchase_vendor_allocations_select on public.purchase_vendor_allocations;
create policy purchase_vendor_allocations_select on public.purchase_vendor_allocations for select to authenticated
  using (public.proc_can_view_request(purchase_request_id));

-- Vendor documents live in the procurement-orders bucket under vendors/<vendor id>/...
drop policy if exists proc_vendor_files_select on storage.objects;
create policy proc_vendor_files_select on storage.objects for select to authenticated
  using (bucket_id = 'procurement-orders' and split_part(name, '/', 1) = 'vendors'
         and (public.proc_is_procurement_member() or public.staff_has_global_oversight()));
drop policy if exists proc_vendor_files_insert on storage.objects;
create policy proc_vendor_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'procurement-orders' and split_part(name, '/', 1) = 'vendors'
              and (public.proc_is_procurement_member() or public.staff_has_global_oversight()));

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------

-- May this vendor be chosen for a normal purchase?
create or replace function public.proc_vendor_selectable(v public.vendors)
returns boolean language sql immutable set search_path to 'public' as $$
  select coalesce(v.is_active, true) and not coalesce(v.blacklisted, false)
     and coalesce(v.approved_status, '') not in ('Blocked', 'Temporarily Blocked', 'Blacklisted');
$$;

-- Category codes an order line belongs to, from the configured keywords (whole-word match).
create or replace function public.proc_text_categories(p_text text)
returns text[] language sql stable security definer set search_path to 'public' as $$
  select coalesce(array_agg(c.code order by c.sort_order), '{}') from public.procurement_categories c
   where c.is_active and exists (select 1 from unnest(c.keywords) k
                                  where lower(coalesce(p_text, '')) ~ ('\m' || regexp_replace(lower(k), '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '\M'));
$$;

-- Each vendor order line: an allocation, or (for orders placed before allocations existed) the whole purchase order.
create or replace function public.proc_vendor_lines()
returns table (vendor_id uuid, purchase_request_id uuid, item_id uuid, item_text text, item_code text, rate numeric, amount numeric,
  expected_delivery_date date, placed_on date)
language sql stable security definer set search_path to 'public' as $$
  select a.vendor_id, a.purchase_request_id, a.item_id, lower(coalesce(i.description, i.item_name, '')), lower(nullif(btrim(coalesce(i.item_code, '')), '')),
         a.rate, a.amount, a.expected_delivery_date, (a.created_at at time zone 'Asia/Kolkata')::date
    from public.purchase_vendor_allocations a join public.purchase_request_items i on i.id = a.item_id
  union all
  select po.vendor_id, po.purchase_request_id, null, lower(coalesce(r.material_name, '')), null, null, po.total_order_value, po.expected_delivery_date, po.order_date
    from public.purchase_orders po join public.purchase_requests r on r.id = po.purchase_request_id
   where po.is_current and po.vendor_id is not null
     and not exists (select 1 from public.purchase_vendor_allocations a where a.purchase_order_id = po.id);
$$;

-- ---------------------------------------------------------------------------
-- 3. Performance (only what actually happened)
-- ---------------------------------------------------------------------------

create or replace function public.proc_vendor_performance(p_vendor_ids uuid[])
returns table (vendor_id uuid, total_orders integer, total_value numeric, avg_order_value numeric, delivered integer, on_time integer, delayed integer,
  open_overdue integer, cancelled integer, quality_rejections integer, last_purchase date, on_time_pct numeric, departments jsonb)
language plpgsql stable security definer set search_path to 'public' as $$
#variable_conflict use_column
begin
  if not coalesce(public.proc_is_procurement_member() or public.staff_has_global_oversight(), false) then
    raise exception 'Only Procurement or Management can see vendor performance';
  end if;
  return query
  with lines as (
    select l.vendor_id, l.purchase_request_id, max(l.expected_delivery_date) as expected, sum(coalesce(l.amount, 0)) as value, max(l.placed_on) as placed
      from public.proc_vendor_lines() l where l.vendor_id = any(p_vendor_ids)
     group by l.vendor_id, l.purchase_request_id
  ), facts as (
    select ln.*, r.proc_status, r.requesting_department_id,
           coalesce(r.delivered_to_client_at, (select min(g.receipt_date) from public.purchase_receipts g where g.purchase_request_id = r.id)) as delivered_on,
           exists (select 1 from public.purchase_receipts g where g.purchase_request_id = r.id and coalesce(g.qty_rejected, 0) > 0) as rejected
      from lines ln join public.purchase_requests r on r.id = ln.purchase_request_id
  )
  select f.vendor_id, count(*)::int, sum(f.value), round(avg(nullif(f.value, 0)), 2),
         count(*) filter (where f.delivered_on is not null)::int,
         count(*) filter (where f.delivered_on is not null and f.expected is not null and f.delivered_on <= f.expected)::int,
         count(*) filter (where f.delivered_on is not null and f.expected is not null and f.delivered_on > f.expected)::int,
         count(*) filter (where f.delivered_on is null and f.expected < public.proc_today_ist() and f.proc_status not in ('CANCELLED', 'CLOSED'))::int,
         count(*) filter (where f.proc_status = 'CANCELLED')::int,
         count(*) filter (where f.rejected)::int,
         max(f.placed),
         case when count(*) filter (where f.delivered_on is not null and f.expected is not null) > 0
              then round(100.0 * count(*) filter (where f.delivered_on is not null and f.expected is not null and f.delivered_on <= f.expected)
                         / count(*) filter (where f.delivered_on is not null and f.expected is not null), 0) end,
         (select coalesce(jsonb_object_agg(d.name_en, x.n), '{}') from (select f2.requesting_department_id, count(*) n from facts f2
            where f2.vendor_id = f.vendor_id group by 1) x join public.departments d on d.id = x.requesting_department_id)
    from facts f group by f.vendor_id;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Recommendations, line by line
-- ---------------------------------------------------------------------------

create or replace function public.proc_recommend_vendors(p_request_id uuid)
returns table (item_id uuid, line_no integer, item_text text, item_categories text[], vendor_id uuid, vendor_name text, tier integer, score numeric,
  reasons text[], last_rate numeric, last_rate_on date, quote_amount numeric, quote_reference text, quote_lead_days integer, meets_due boolean, combined boolean)
language plpgsql stable security definer set search_path to 'public' as $$
#variable_conflict use_column
declare r public.purchase_requests; v_days integer; v_items integer;
begin
  if not coalesce(public.proc_is_procurement_member() or public.staff_has_global_oversight(), false) then
    raise exception 'Only Procurement or Management can see vendor recommendations';
  end if;
  select * into r from public.purchase_requests where id = p_request_id;
  if r.id is null or not public.proc_can_view_request(p_request_id) then raise exception 'Order not found'; end if;
  v_days := r.required_by_date - public.proc_today_ist();
  select count(*) into v_items from public.purchase_request_items i where i.purchase_request_id = p_request_id;
  return query
  with items as (
    select i.id, coalesce(i.line_no, 1) as ln, coalesce(i.description, i.item_name, r.material_name) as txt, lower(nullif(btrim(coalesce(i.item_code, '')), '')) as code,
           public.proc_text_categories(concat_ws(' ', i.description, i.item_name, i.item_code, i.line_remarks, i.category, i.brand, r.specifications)) as cats,
           lower(concat_ws(' ', i.description, i.item_name, i.item_code, i.line_remarks, i.brand)) as hay
      from public.purchase_request_items i where i.purchase_request_id = p_request_id
  ), perf as (
    select p.* from public.proc_vendor_performance((select array_agg(v.id) from public.vendors v where public.proc_vendor_selectable(v))) p
  ), cand as (
    select it.id as item_id, it.ln, it.txt, it.cats, v.id as vendor_id, v.name, v.preference, v.approved_status, v.avg_delivery_days,
           (select coalesce(array_agg(c), '{}') from unnest(v.categories) c where c = any(it.cats)) as matched,
           exists (select 1 from unnest(v.brands) b where length(btrim(b)) > 1 and it.hay ~ ('\m' || regexp_replace(lower(btrim(b)), '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '\M')) as brand_hit,
           (select l.rate from public.proc_vendor_lines() l where l.vendor_id = v.id and l.rate is not null
              and ((it.code is not null and l.item_code = it.code) or l.item_text = lower(it.txt)) order by l.placed_on desc limit 1) as prev_rate,
           (select l.placed_on from public.proc_vendor_lines() l where l.vendor_id = v.id
              and ((it.code is not null and l.item_code = it.code) or l.item_text = lower(it.txt)) order by l.placed_on desc limit 1) as prev_on,
           q.amount as q_amount, q.ref as q_ref, q.lead as q_lead
      from items it cross join public.vendors v
      left join lateral (select coalesce(vq.final_offer, vq.negotiated_amount, vq.total_landed_cost) as amount, vq.quotation_number as ref, vq.lead_time_days as lead
                           from public.vendor_quotations vq where vq.purchase_request_id = p_request_id and vq.vendor_id = v.id
                          order by vq.created_at desc limit 1) q on true
     where public.proc_vendor_selectable(v)
  ), scored as (
    select c.*, p.on_time_pct, coalesce(p.delivered, 0) as delivered, coalesce(p.quality_rejections, 0) as rejections, coalesce(p.total_orders, 0) as orders,
           case when c.q_lead is not null then c.q_lead <= v_days when c.avg_delivery_days is not null then c.avg_delivery_days <= v_days end as on_time_possible
      from cand c left join perf p on p.vendor_id = c.vendor_id
     where cardinality(c.matched) > 0 or c.brand_hit or c.prev_on is not null or c.q_ref is not null
  )
  select s.item_id, s.ln, s.txt, s.cats, s.vendor_id, s.name,
         case when s.preference in ('HIGHLY_PREFERRED', 'PREFERRED') then 1 when s.approved_status = 'Approved' then 2 else 3 end,
         ( case s.preference when 'HIGHLY_PREFERRED' then 30 when 'PREFERRED' then 20 else 0 end
           + 20 * cardinality(s.matched) + case when s.brand_hit then 10 else 0 end + case when s.prev_on is not null then 10 else 0 end
           + case when s.q_ref is not null then 8 else 0 end
           + coalesce(s.on_time_pct * 0.2, 0) - case when s.orders > 0 then 20.0 * s.rejections / s.orders else 0 end
           + case when s.on_time_possible then 5 when s.on_time_possible = false then -10 else 0 end )::numeric,
         array_remove(array[
           case s.preference when 'HIGHLY_PREFERRED' then 'Highly preferred by Management' when 'PREFERRED' then 'Preferred vendor' end,
           case when cardinality(s.matched) > 0 then 'Supplies ' || array_to_string(s.matched, ', ') end,
           case when s.brand_hit then 'Supplies the brand asked for' end,
           case when s.prev_on is not null then 'Supplied this item before (' || to_char(s.prev_on, 'DD-MM-YYYY') || ')' end,
           case when s.q_ref is not null then 'Quoted for this order (' || s.q_ref || ')' end,
           case when s.on_time_pct is not null then s.on_time_pct || '% on time over ' || s.delivered || ' delivered order(s)' end,
           case when s.rejections > 0 then s.rejections || ' order(s) with quality rejections' end,
           case when s.on_time_possible = false then 'Usual delivery time is longer than the time left' end], null),
         s.prev_rate, s.prev_on, s.q_amount, s.q_ref, coalesce(s.q_lead, s.avg_delivery_days), s.on_time_possible,
         (select count(distinct s2.item_id) from scored s2 where s2.vendor_id = s.vendor_id) = v_items and v_items > 1
    from scored s
   order by s.ln, 7, 8 desc, s.name;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Vendor master maintenance
-- ---------------------------------------------------------------------------

-- p: name, contact_person, mobile, whatsapp, email, address, gstin, pan, categories[], brands[], specifications, payment_terms,
--    credit_period, avg_delivery_days, is_active, internal_remarks. Procurement and Management.
create or replace function public.proc_save_vendor_master(p_vendor_id uuid, p jsonb)
returns public.vendors language plpgsql security definer set search_path to 'public' as $$
declare v_row public.vendors; v_cats text[]; v_bad text; v_brands text[]; v_wa text; v_days integer;
begin
  v_row := public.proc_save_vendor(p_vendor_id, p->>'name', p->>'contact_person', p->>'mobile', p->>'email', p->>'address', p->>'gstin', p->>'pan',
    nullif(btrim(coalesce(p->>'categories_text', '')), ''), p->>'payment_terms', p->>'credit_period', nullif(btrim(coalesce(p->>'lead_time', '')), ''), p->>'notes');
  select coalesce(array_agg(distinct upper(btrim(x))), '{}') into v_cats from jsonb_array_elements_text(coalesce(p->'categories', '[]')) x where btrim(x) <> '';
  select c into v_bad from unnest(v_cats) c where not exists (select 1 from public.procurement_categories pc where pc.code = c) limit 1;
  if v_bad is not null then raise exception 'Unknown material category %', v_bad; end if;
  select coalesce(array_agg(distinct btrim(x)), '{}') into v_brands from jsonb_array_elements_text(coalesce(p->'brands', '[]')) x where btrim(x) <> '';
  v_wa := nullif(regexp_replace(coalesce(p->>'whatsapp', ''), '[^0-9+]', '', 'g'), '');
  if v_wa is not null and length(regexp_replace(v_wa, '[^0-9]', '', 'g')) not between 10 and 13 then raise exception 'WhatsApp must be a valid phone number'; end if;
  v_days := nullif(btrim(coalesce(p->>'avg_delivery_days', '')), '')::integer;
  if v_days is not null and v_days not between 0 and 365 then raise exception 'Average delivery days must be between 0 and 365'; end if;
  update public.vendors set whatsapp = v_wa, categories = v_cats, brands = v_brands, specifications = nullif(btrim(coalesce(p->>'specifications', '')), ''),
    avg_delivery_days = v_days, is_active = coalesce((p->>'is_active')::boolean, is_active),
    product_service_category = coalesce(nullif(array_to_string(v_cats, ', '), ''), product_service_category), updated_at = now()
   where id = v_row.id returning * into v_row;
  if p ? 'internal_remarks' then
    insert into public.vendor_internal_notes (vendor_id, remarks, updated_by) values (v_row.id, nullif(btrim(coalesce(p->>'internal_remarks', '')), ''), auth.uid())
    on conflict (vendor_id) do update set remarks = excluded.remarks, updated_by = excluded.updated_by, updated_at = now();
  end if;
  return v_row;
exception when invalid_text_representation then raise exception 'Average delivery days must be a number';
end $$;

-- Management / Procurement Head: Highly Preferred, Preferred, Regular, Temporarily Blocked or Blacklisted (with a reason).
create or replace function public.proc_set_vendor_rating(p_vendor_id uuid, p_level text, p_reason text)
returns public.vendors language plpgsql security definer set search_path to 'public' as $$
declare v_old public.vendors; v_new public.vendors; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_head() or public.staff_has_global_oversight(), false) then
    raise exception 'Only Management or the Procurement Head can rate vendors';
  end if;
  if coalesce(p_level, '') not in ('HIGHLY_PREFERRED', 'PREFERRED', 'REGULAR', 'TEMPORARILY_BLOCKED', 'BLACKLISTED') then raise exception 'Unknown vendor level'; end if;
  if p_level in ('TEMPORARILY_BLOCKED', 'BLACKLISTED') and v_reason is null then raise exception 'A reason is required to block a vendor'; end if;
  select * into v_old from public.vendors where id = p_vendor_id for update;
  if v_old.id is null then raise exception 'Vendor not found'; end if;
  update public.vendors set
    preference = case when p_level in ('HIGHLY_PREFERRED', 'PREFERRED', 'REGULAR') then p_level else preference end,
    approved_status = case p_level when 'TEMPORARILY_BLOCKED' then 'Temporarily Blocked' when 'BLACKLISTED' then 'Blacklisted' else 'Approved' end,
    blacklisted = (p_level = 'BLACKLISTED'), blacklist_reason = case when p_level in ('TEMPORARILY_BLOCKED', 'BLACKLISTED') then v_reason end,
    status_changed_by = auth.uid(), status_changed_at = now(), updated_at = now()
   where id = p_vendor_id returning * into v_new;
  perform public.staff_write_audit('vendor', p_vendor_id, 'RATING_' || p_level, jsonb_build_object('preference', v_old.preference, 'approved_status', v_old.approved_status),
    jsonb_build_object('preference', v_new.preference, 'approved_status', v_new.approved_status), public.factory_procurement_dept_id(), v_reason);
  return v_new;
end $$;

create or replace function public.proc_add_vendor_document(p_vendor_id uuid, p_storage_path text, p_file_name text, p_file_type text, p_description text)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_member() or public.staff_has_global_oversight(), false) then raise exception 'Only Procurement can add vendor documents'; end if;
  if not exists (select 1 from public.vendors where id = p_vendor_id) then raise exception 'Vendor not found'; end if;
  if p_storage_path not like 'vendors/' || p_vendor_id::text || '/%' then raise exception 'The file is not stored under this vendor'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'procurement-orders' and name = p_storage_path) then raise exception 'The file was not uploaded'; end if;
  insert into public.vendor_documents (vendor_id, storage_path, file_name, file_type, description, uploaded_by)
  values (p_vendor_id, p_storage_path, btrim(p_file_name), p_file_type, nullif(btrim(coalesce(p_description, '')), ''), auth.uid()) returning id into v_id;
  return v_id;
end $$;

-- Material categories: add / edit (Procurement Head, Management).
create or replace function public.proc_save_category(p_code text, p_name text, p_keywords text[], p_active boolean)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_code text := upper(regexp_replace(btrim(coalesce(p_code, '')), '[^A-Za-z0-9]+', '_', 'g'));
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_head() or public.staff_has_global_oversight(), false) then
    raise exception 'Only the Procurement Head or Management can change material categories';
  end if;
  if v_code !~ '^[A-Z][A-Z0-9_]{1,40}$' then raise exception 'Category code must start with a letter (letters, digits, _)'; end if;
  if btrim(coalesce(p_name, '')) = '' then raise exception 'Category name is required'; end if;
  insert into public.procurement_categories (code, name_en, keywords, is_active, updated_by)
  values (v_code, btrim(p_name), (select coalesce(array_agg(distinct lower(btrim(k))), '{}') from unnest(coalesce(p_keywords, '{}')) k where btrim(k) <> ''),
          coalesce(p_active, true), auth.uid())
  on conflict (code) do update set name_en = excluded.name_en, keywords = excluded.keywords, is_active = excluded.is_active,
    updated_by = excluded.updated_by, updated_at = now();
end $$;

-- ---------------------------------------------------------------------------
-- 6. Placing the order with one vendor per line
-- ---------------------------------------------------------------------------

-- p_allocations: [{item_id, vendor_id, vendor_po_reference, quotation_reference, rate, expected_delivery_date}] -- every line once.
-- p_details: {order_date, payment_terms, remarks, scope_of_work, late_reason}.
create or replace function public.proc_place_order_with_vendors(p_request_id uuid, p_allocations jsonb, p_details jsonb)
returns public.purchase_orders language plpgsql security definer set search_path to 'public' as $$
declare
  r public.purchase_requests; v_po public.purchase_orders; a jsonb; v_item public.purchase_request_items; v_vendor public.vendors;
  v_n integer := 0; v_items integer; v_order_date date; v_late text := nullif(btrim(coalesce(p_details->>'late_reason', '')), '');
  v_lead uuid; v_lead_ref text; v_lead_quote text; v_total numeric := 0; v_any_amount boolean := false; v_max_exp date; v_rate numeric; v_amount numeric;
  v_exp date; v_ref text; v_split text; v_late_any boolean := false;
begin
  perform public.staff_assert_operational();
  if not public.proc_can_work_order(p_request_id) then
    raise exception 'Only the Procurement employee handling this order, or a Procurement Head / Supervisor, can place it';
  end if;
  select * into r from public.purchase_requests where id = p_request_id for update;
  if r.id is null then raise exception 'Order not found'; end if;
  if exists (select 1 from public.purchase_orders where purchase_request_id = p_request_id and is_current) or exists (select 1 from public.purchase_vendor_allocations where purchase_request_id = p_request_id) then
    raise exception 'The order for this request has already been confirmed';
  end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then raise exception 'Choose a vendor for every line'; end if;
  select count(*) into v_items from public.purchase_request_items where purchase_request_id = p_request_id;
  v_order_date := coalesce(nullif(p_details->>'order_date', '')::date, public.proc_today_ist());

  create temporary table if not exists zz_alloc (item_id uuid primary key, vendor_id uuid, ref text, quote text, rate numeric, amount numeric, exp date) on commit drop;
  delete from zz_alloc;
  for a in select * from jsonb_array_elements(p_allocations) loop
    select * into v_item from public.purchase_request_items where id = public.proc_try_uuid(a->>'item_id') and purchase_request_id = p_request_id;
    if v_item.id is null then raise exception 'A line does not belong to this order'; end if;
    select * into v_vendor from public.vendors where id = public.proc_try_uuid(a->>'vendor_id');
    if v_vendor.id is null then raise exception 'Choose a vendor for line %', v_item.line_no; end if;
    if not public.proc_vendor_selectable(v_vendor) then raise exception 'Vendor % is blocked or inactive', v_vendor.name; end if;
    v_ref := nullif(btrim(coalesce(a->>'vendor_po_reference', '')), '');
    if v_ref is null then raise exception 'Vendor PO / reference number is required for %', v_vendor.name; end if;
    v_exp := nullif(a->>'expected_delivery_date', '')::date;
    if v_exp is null then raise exception 'Expected delivery date is required for %', v_vendor.name; end if;
    if v_exp < v_order_date then raise exception 'Expected delivery cannot be before the order date'; end if;
    v_rate := nullif(btrim(coalesce(a->>'rate', '')), '')::numeric;
    if v_rate is not null and v_rate < 0 then raise exception 'Rate cannot be negative'; end if;
    v_amount := case when v_rate is not null then round(v_rate * coalesce(v_item.quantity, 1), 2) else v_item.amount end;
    begin
      insert into zz_alloc values (v_item.id, v_vendor.id, v_ref, nullif(btrim(coalesce(a->>'quotation_reference', '')), ''), v_rate, v_amount, v_exp);
    exception when unique_violation then raise exception 'Line % has more than one vendor', v_item.line_no; end;
    v_n := v_n + 1;
    if v_exp > r.required_by_date then v_late_any := true; end if;
  end loop;
  if v_n <> v_items then raise exception 'Choose a vendor for every line (% of % chosen)', v_n, v_items; end if;
  -- One vendor, one reference: the same vendor on several lines must carry the same PO / reference.
  if exists (select 1 from zz_alloc group by vendor_id having count(distinct lower(ref)) > 1) then
    raise exception 'Use one PO / reference number per vendor';
  end if;
  if v_late_any and v_late is null then
    raise exception 'Expected delivery is after the department''s due date (%) — give the reason or agree a new commitment', to_char(r.required_by_date, 'DD-MM-YYYY');
  end if;

  -- The main vendor (most lines, then highest value) carries the order's purchase order; every line keeps its own vendor.
  select z.vendor_id, min(z.ref), min(z.quote) into v_lead, v_lead_ref, v_lead_quote from zz_alloc z
   group by z.vendor_id order by count(*) desc, sum(coalesce(z.amount, 0)) desc limit 1;
  select coalesce(sum(amount), 0), bool_or(amount is not null), max(exp) into v_total, v_any_amount, v_max_exp from zz_alloc;
  select * into v_vendor from public.vendors where id = v_lead;
  v_po := public.proc_confirm_order(p_request_id, v_vendor.name, v_vendor.mobile, v_lead_quote, v_lead_ref, v_order_date, null,
    case when v_any_amount and v_total > 0 then v_total end, v_max_exp, coalesce(nullif(p_details->>'payment_terms', ''), v_vendor.payment_terms),
    nullif(btrim(coalesce(p_details->>'remarks', '')), ''), nullif(btrim(coalesce(p_details->>'scope_of_work', '')), ''));
  update public.purchase_orders set vendor_id = v_lead, vendor_contact = coalesce(vendor_contact, v_vendor.mobile) where id = v_po.id returning * into v_po;

  insert into public.purchase_vendor_allocations (purchase_request_id, item_id, vendor_id, purchase_order_id, vendor_po_reference, quotation_reference, rate, amount,
    expected_delivery_date, created_by)
  select p_request_id, z.item_id, z.vendor_id, v_po.id, z.ref, z.quote, z.rate, z.amount, z.exp, auth.uid() from zz_alloc z;
  update public.purchase_request_items i set rate = coalesce(z.rate, i.rate), amount = coalesce(z.amount, i.amount) from zz_alloc z where i.id = z.item_id;

  select string_agg(v.name || ' (' || x.n || ' line' || case when x.n > 1 then 's' else '' end || ', ' || x.ref || ')', '; ' order by x.n desc)
    into v_split from (select vendor_id, count(*) n, min(ref) ref from zz_alloc group by vendor_id) x join public.vendors v on v.id = x.vendor_id;
  insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
  values (p_request_id, 'ORDER_PLACED', 'ORDER_PLACED', auth.uid(), public.staff_current_role_code(),
    'Vendors: ' || v_split || case when v_late_any then '. Delivery after the due date agreed: ' || v_late else '' end);
  return v_po;
exception when invalid_datetime_format or datetime_field_overflow then raise exception 'A date is not valid';
  when invalid_text_representation then raise exception 'A rate is not a number';
end $$;

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.proc_vendor_lines(), public.proc_text_categories(text) from public, anon, authenticated;
revoke all on function public.proc_vendor_performance(uuid[]), public.proc_recommend_vendors(uuid), public.proc_save_vendor_master(uuid, jsonb),
  public.proc_set_vendor_rating(uuid, text, text), public.proc_add_vendor_document(uuid, text, text, text, text), public.proc_save_category(text, text, text[], boolean),
  public.proc_place_order_with_vendors(uuid, jsonb, jsonb), public.proc_vendor_selectable(public.vendors) from public, anon;
grant execute on function public.proc_vendor_performance(uuid[]), public.proc_recommend_vendors(uuid), public.proc_save_vendor_master(uuid, jsonb),
  public.proc_set_vendor_rating(uuid, text, text), public.proc_add_vendor_document(uuid, text, text, text, text), public.proc_save_category(text, text, text[], boolean),
  public.proc_place_order_with_vendors(uuid, jsonb, jsonb), public.proc_vendor_selectable(public.vendors) to authenticated;

commit;
