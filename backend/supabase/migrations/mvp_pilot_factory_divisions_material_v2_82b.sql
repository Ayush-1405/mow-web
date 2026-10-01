-- Factory Divisions + Material-to-Order (handwritten workflow spec). Foundational layer only this pass: the
-- existing Factory system (34 screens, job cards, QC, BOM, drawings, attachments, notifications, audit log,
-- realtime) is already real and extensive -- confirmed live by reading inhouse_production_requests,
-- factory_job_cards_v, factoryApi.js, and factory_is_head()/staff_is_factory_staff() before writing a line here.
-- What genuinely does not exist anywhere: (1) a real Sofa/Modular/Metal Fabrication division on a Job Card --
-- "production_department" on inhouse_production_requests is a free-text per-TASK team label ("e.g. Carpentry,
-- Polish"), not a Job-Card-level production stream; (2) configurable, division-scoped stage templates (the one
-- stage list, factory_production_stages, is global); (3) a dedicated "Material to Order" entity with the exact
-- fields the handwritten note lists -- Factory's only existing shortage path is the generic
-- outsource_requirements/purchase_requests tables, which have none of Material/Requesting Department/PO
-- Reference/Person Name/Priority/Required Date/Job Card/Supplier/Status as named fields.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. production_divisions -- Sofa / Modular / Metal Fabrication. Reference data (like retail_product_types):
--    readable by any signed-in staff member, not yet editable from the UI this pass (disclosed).
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.production_divisions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_en text not null,
  name_gu text not null,
  icon text,
  sort_order int not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.production_divisions (code, name_en, name_gu, icon, sort_order) values
  ('SOFA', 'Sofa', 'સોફા', '🛋️', 10),
  ('MODULAR', 'Modular', 'મોડ્યુલર', '🗄️', 20),
  ('METAL_FAB', 'Metal Fabrication', 'મેટલ ફેબ્રિકેશન', '🔩', 30)
on conflict (code) do nothing;

alter table public.production_divisions enable row level security;
drop policy if exists production_divisions_select on public.production_divisions;
create policy production_divisions_select on public.production_divisions for select to authenticated using (auth.uid() is not null);
grant select on public.production_divisions to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. production_stage_templates -- division-scoped stage buttons (spec: "configurable division-specific
--    templates, do not hard-code the same stages for every product"). Seeded identically across all three
--    divisions for now -- the handwritten note's own instruction that Modular/Metal Fabrication "follow the same
--    flow as Sofa" -- but each division's rows are independent and can be edited separately later without
--    touching the others.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.production_stage_templates (
  id uuid primary key default gen_random_uuid(),
  division_id uuid not null references public.production_divisions(id),
  stage_code text not null,
  name_en text not null,
  name_gu text not null,
  sort_order int not null default 100,
  requires_photo boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (division_id, stage_code)
);
insert into public.production_stage_templates (division_id, stage_code, name_en, name_gu, sort_order, requires_photo)
select d.id, s.stage_code, s.name_en, s.name_gu, s.sort_order, s.requires_photo
from public.production_divisions d
cross join (values
  ('CUTTING', 'Cutting', 'કટિંગ', 10, false),
  ('FRAME', 'Frame', 'ફ્રેમ', 20, false),
  ('ASSEMBLY', 'Assembly', 'એસેમ્બલી', 30, false),
  ('FOAM', 'Foam', 'ફોમ', 40, false),
  ('UPHOLSTERY', 'Upholstery', 'અપહોલ્સ્ટરી', 50, false),
  ('FINISHING', 'Finishing', 'ફિનિશિંગ', 60, true),
  ('QC', 'QC', 'ક્યુસી', 70, true),
  ('PACKING', 'Packing', 'પેકિંગ', 80, true)
) as s(stage_code, name_en, name_gu, sort_order, requires_photo)
where d.code in ('SOFA', 'MODULAR', 'METAL_FAB')
on conflict (division_id, stage_code) do nothing;

alter table public.production_stage_templates enable row level security;
drop policy if exists production_stage_templates_select on public.production_stage_templates;
create policy production_stage_templates_select on public.production_stage_templates for select to authenticated using (auth.uid() is not null);
grant select on public.production_stage_templates to authenticated;

create or replace function public.factory_list_stage_templates(p_division_id uuid)
returns setof public.production_stage_templates
language sql stable security definer set search_path to 'public' as $$
  select * from public.production_stage_templates where division_id = p_division_id and is_active order by sort_order;
$$;
grant execute on function public.factory_list_stage_templates(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. inhouse_production_requests.division_id -- additive, nullable (every existing/new Job Card keeps working
--    unassigned; retail_confirm_order's FACTORY branch and the AI intake path are both untouched).
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.inhouse_production_requests add column if not exists division_id uuid references public.production_divisions(id);

-- factory_set_job_division -- the "simple three-button division selection" when a Job Card's division is unclear.
-- Factory Head/Management only (factory_is_head(), already the exact gate every other Head-only Factory action uses).
create or replace function public.factory_set_job_division(p_job_id uuid, p_division_id uuid)
returns public.inhouse_production_requests
language plpgsql security definer set search_path to 'public' as $$
declare v_row public.inhouse_production_requests;
begin
  if not coalesce(public.factory_is_head(), false) then raise exception 'Only the Factory Head/Management may set a Job Card''s division'; end if;
  if not exists (select 1 from public.production_divisions where id = p_division_id and is_active) then raise exception 'Invalid division'; end if;
  update public.inhouse_production_requests set division_id = p_division_id, updated_at = now() where id = p_job_id returning * into v_row;
  if v_row.id is null then raise exception 'Job Card not found'; end if;
  insert into public.factory_job_events (job_id, event_type, note, actor_id)
  values (p_job_id, 'division_set', (select name_en from public.production_divisions where id = p_division_id), auth.uid());
  return v_row;
end $$;
grant execute on function public.factory_set_job_division(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. factory_job_cards_v -- append division columns (bare CREATE OR REPLACE VIEW is safe: adding trailing columns
--    only, nothing existing is removed or reordered).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace view public.factory_job_cards_v with (security_invoker = true) as
select
  r.id, r.job_order_number, r.factory_status, r.status as legacy_status,
  r.source_department_id, d.name_en as source_department_name, d.name_gu as source_department_name_gu,
  r.source_module, r.source_reference,
  r.project_id, coalesce(r.project_code, pr.project_code) as project_code,
  coalesce(r.customer_name, pr.customer) as customer_name, coalesce(r.site_location, pr.location) as site_location,
  r.product_item,
  coalesce(ic.item_count, case when r.product_item is not null then 1 else 0 end) as item_count,
  ic.total_qty, ic.qty_summary,
  r.required_completion_date as required_date, r.priority, r.current_stage, r.completion_percentage,
  r.assigned_factory_coordinator, public.factory_person_name(r.assigned_factory_coordinator) as assigned_name,
  r.second_assignee_coordinator, public.factory_person_name(r.second_assignee_coordinator) as second_name,
  coalesce(fc.file_count, 0) as file_count, coalesce(fc.drawing_count, 0) as drawing_count,
  ( (case when r.required_completion_date is null then 1 else 0 end)
  + (case when coalesce(ic.item_count, 0) = 0 then 1 else 0 end)
  + (case when coalesce(fc.drawing_count, 0) = 0 then 1 else 0 end)
  + (case when coalesce(ic.missing_qty, 0) > 0 then 1 else 0 end)
  + (case when coalesce(ic.missing_spec, 0) > 0 then 1 else 0 end) ) as missing_count,
  (r.factory_status not in ('completed', 'cancelled')
    and (r.factory_status = 'blocked'
         or (r.required_completion_date is not null and r.required_completion_date < (now() at time zone 'Asia/Kolkata')::date))) as is_delayed,
  (r.factory_status = 'blocked') as is_blocked,
  r.viewed_at, r.requested_by, public.factory_user_name(r.requested_by) as requested_by_name,
  r.clarification_note, r.blocked_reason, r.factory_location_id, r.production_department,
  r.created_at, r.updated_at, r.ready_at, r.completed_at, r.is_test_data,
  ic.all_items, r.production_start_date as planned_start, r.expected_completion_date as expected_end,
  r.division_id, pd.code as division_code, pd.name_en as division_name_en, pd.name_gu as division_name_gu
from public.inhouse_production_requests r
left join public.departments d on d.id = r.source_department_id
left join public.projects pr on pr.id = r.project_id
left join public.production_divisions pd on pd.id = r.division_id
left join lateral (
  select count(*) as item_count, sum(i.quantity) as total_qty,
    string_agg(coalesce(i.quantity::text, '?') || ' ' || coalesce(i.unit, '') || ' ' || i.item_name, ', ' order by i.line_no) filter (where i.line_no <= 3) as qty_summary,
    count(*) filter (where i.quantity is null or i.quantity <= 0) as missing_qty,
    count(*) filter (where i.material is null or i.dimensions is null) as missing_spec,
    string_agg(i.item_name, ', ' order by i.line_no) as all_items
  from public.factory_job_items i where i.job_id = r.id
) ic on true
left join lateral (
  select count(*) as file_count,
    count(*) filter (where f.category in ('Working Drawing', 'Production Drawing', '3D Drawing', 'Normal Drawing', 'Reference Drawing',
      'Furniture Detail Drawing', 'Cutting Drawing', 'Approved Design', 'RCP', 'Electrical Drawing', 'MEP Drawing')) as drawing_count
  from public.factory_drawings f where f.job_id = r.id and f.status <> 'Superseded'
) fc on true;
grant select on public.factory_job_cards_v to authenticated;

-- factory_division_dashboard_counts -- the new Home's division tiles (New/In Production/Delayed per division),
-- alongside the unchanged factory_dashboard_counts() the existing dashboard already uses.
create or replace function public.factory_division_dashboard_counts(p_location uuid default null)
returns table(division_id uuid, division_code text, division_name_en text, division_name_gu text,
  new_requests bigint, in_production bigint, delayed_blocked bigint, ready_today bigint, total_active bigint)
language sql stable security invoker set search_path to 'public' as $$
  select d.id, d.code, d.name_en, d.name_gu,
    count(*) filter (where r.factory_status in ('pending_verification','needs_clarification')),
    count(*) filter (where r.factory_status in ('in_production','assigned')),
    count(*) filter (where r.factory_status = 'blocked'
      or (r.required_completion_date is not null and r.required_completion_date < (now() at time zone 'Asia/Kolkata')::date and r.factory_status not in ('completed','cancelled'))),
    count(*) filter (where (r.factory_status = 'ready_for_review' and (r.ready_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date)
      or (r.factory_status = 'completed' and (r.completed_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date)),
    count(*) filter (where r.factory_status not in ('completed','cancelled'))
  from public.production_divisions d
  left join public.inhouse_production_requests r on r.division_id = d.id and not r.is_test_data
    and (p_location is null or r.factory_location_id = p_location)
  where d.is_active
  group by d.id, d.code, d.name_en, d.name_gu, d.sort_order
  order by d.sort_order;
$$;
grant execute on function public.factory_division_dashboard_counts(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. factory_material_requests -- the real "Material to Order" entity (handwritten note, column 1), with exactly
--    the fields listed: Material, Requesting Department, Order/PO Reference, Person Name/Requested By, Priority,
--    Required Date, Quantity+Unit, Related Job Card, Supplier, Current Material Status, Notes. Photos/documents
--    reuse the SAME staff_attachments polymorphic pattern every other entity in this app already uses.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.factory_material_number_counters (
  day date primary key,
  next_seq int not null default 1
);

create table if not exists public.factory_material_requests (
  id uuid primary key default gen_random_uuid(),
  request_number text not null unique,
  material text not null,
  requesting_department_id uuid not null references public.departments(id),
  order_po_reference text,
  requested_by uuid not null references public.user_profiles(id),
  priority text not null default 'Normal' check (priority in ('Normal', 'High', 'Urgent', 'Emergency')),
  required_date date,
  quantity numeric not null check (quantity > 0),
  unit text not null default 'Nos',
  job_card_id uuid references public.inhouse_production_requests(id),
  supplier text,
  status text not null default 'REQUESTED' check (status in ('REQUESTED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')),
  notes text,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  received_at timestamptz,
  received_by uuid references public.user_profiles(id),
  is_active boolean not null default true
);
create index if not exists factory_material_requests_job_idx on public.factory_material_requests (job_card_id);
create index if not exists factory_material_requests_status_idx on public.factory_material_requests (status);
-- Prevent a duplicate open request for the same material on the same Job Card (spec: "Do not ask workers to
-- create the same material request twice. Prevent duplicate PO/material requests.") -- a cancelled/received one
-- does not block a fresh request.
create unique index if not exists factory_material_requests_no_dup_open
  on public.factory_material_requests (job_card_id, lower(material))
  where job_card_id is not null and status in ('REQUESTED', 'ORDERED', 'PARTIALLY_RECEIVED');
create trigger trg_touch_updated_at before update on public.factory_material_requests for each row execute function public.staff_touch_updated_at();

alter table public.staff_attachments drop constraint if exists staff_attachments_entity_type_check;
alter table public.staff_attachments add constraint staff_attachments_entity_type_check
  check (entity_type in ('task', 'bridge', 'retail_packing', 'retail_godown_handover', 'retail_dispatch', 'retail_delivery',
                          'retail_installation', 'retail_order_item', 'retail_product', 'retail_inventory_item', 'retail_quotation',
                          'retail_delivery_challan', 'factory_material_request'));

create or replace function public.factory_procurement_dept_id() returns uuid
language sql stable security definer set search_path to 'public' as $$ select id from public.departments where code = 'PROCUREMENT'; $$;
grant execute on function public.factory_procurement_dept_id() to authenticated;

alter table public.factory_material_requests enable row level security;
create policy factory_material_requests_select on public.factory_material_requests for select to authenticated using (
  staff_current_user_ok() and (
    created_by = auth.uid() or requested_by = auth.uid()
    or staff_is_factory_staff() or staff_current_department_id() = public.factory_procurement_dept_id()
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(requesting_department_id))));
create policy factory_material_requests_write on public.factory_material_requests for all to authenticated
  using (staff_current_user_ok() and staff_has_global_oversight()) with check (staff_current_user_ok() and staff_has_global_oversight());
-- (writes happen via the SECURITY DEFINER RPCs below; direct writes stay management-only, same defense-in-depth
-- pattern every other table in this pass of the app already uses.)
grant select, insert, update, delete on public.factory_material_requests to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'factory_material_requests') then
    alter publication supabase_realtime add table public.factory_material_requests;
  end if;
end $$;

-- factory_create_material_request -- Factory staff/Head/oversight only. request_number is day-scoped and
-- race-free (same counter-table pattern as every other number generator in this app).
create or replace function public.factory_create_material_request(
  p_material text, p_requesting_department_id uuid, p_quantity numeric, p_unit text default 'Nos',
  p_order_po_reference text default null, p_priority text default 'Normal', p_required_date date default null,
  p_job_card_id uuid default null, p_supplier text default null, p_notes text default null)
returns public.factory_material_requests
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_allowed boolean; v_day date := (now() at time zone 'Asia/Kolkata')::date; v_seq int; v_number text; v_row public.factory_material_requests;
begin
  perform public.staff_assert_operational();
  v_allowed := (coalesce(public.staff_is_factory_staff(), false) or coalesce(public.staff_has_global_oversight(), false));
  if not v_allowed then raise exception 'Not authorized to create a material request'; end if;

  if coalesce(btrim(p_material), '') = '' then raise exception 'Material is required'; end if;
  if p_requesting_department_id is null then raise exception 'Requesting department is required'; end if;
  if coalesce(p_quantity, 0) <= 0 then raise exception 'A positive quantity is required'; end if;
  if coalesce(p_priority, 'Normal') not in ('Normal', 'High', 'Urgent', 'Emergency') then raise exception 'Invalid priority'; end if;

  -- Idempotent on the (job_card_id, material) duplicate guard: a second attempt for the same open request
  -- returns the existing row instead of erroring, so a worker's retry/double-tap never creates a second one.
  if p_job_card_id is not null then
    select * into v_row from public.factory_material_requests
      where job_card_id = p_job_card_id and lower(material) = lower(btrim(p_material)) and status in ('REQUESTED', 'ORDERED', 'PARTIALLY_RECEIVED');
    if v_row.id is not null then return v_row; end if;
  end if;

  insert into public.factory_material_number_counters (day, next_seq) values (v_day, 1) on conflict (day) do nothing;
  update public.factory_material_number_counters set next_seq = next_seq + 1 where day = v_day returning next_seq - 1 into v_seq;
  v_number := 'MTO-' || to_char(v_day, 'YYYYMMDD') || '-' || lpad(v_seq::text, 3, '0');

  insert into public.factory_material_requests (
    request_number, material, requesting_department_id, order_po_reference, requested_by, priority, required_date,
    quantity, unit, job_card_id, supplier, notes, created_by
  ) values (
    v_number, btrim(p_material), p_requesting_department_id, nullif(btrim(coalesce(p_order_po_reference, '')), ''), auth.uid(),
    coalesce(p_priority, 'Normal'), p_required_date, p_quantity, coalesce(nullif(btrim(p_unit), ''), 'Nos'), p_job_card_id,
    nullif(btrim(coalesce(p_supplier, '')), ''), p_notes, auth.uid()
  ) returning * into v_row;

  perform public.staff_write_audit('factory_material_request', v_row.id, 'CREATE', null,
    jsonb_build_object('request_number', v_number, 'material', p_material, 'quantity', p_quantity, 'job_card_id', p_job_card_id),
    public.factory_dept_id());

  perform public.staff_notify_dept_leadership('PROCUREMENT', 'factory_material_request', v_row.id,
    'Material requested: ' || v_number || ' — ' || p_material, v_number || ' — ' || p_material || ' મટિરિયલ મંગાવ્યું');

  if p_job_card_id is not null then
    insert into public.factory_job_events (job_id, event_type, note, actor_id)
    values (p_job_card_id, 'material_requested', v_number || ' — ' || p_material || ' (' || p_quantity || ' ' || coalesce(p_unit, 'Nos') || ')', auth.uid());
  end if;

  return v_row;
end $function$;
grant execute on function public.factory_create_material_request(text, uuid, numeric, text, text, text, date, uuid, text, text) to authenticated;

-- factory_update_material_request_status -- Factory staff/Head/Procurement/oversight. Marking RECEIVED notifies
-- the linked Job Card's responsible people that work can start (spec: "Notify the Factory Supervisor that work
-- can start"), and logs it on the Job Card's own timeline -- never a second, disconnected record.
create or replace function public.factory_update_material_request_status(p_id uuid, p_status text, p_notes text default null)
returns public.factory_material_requests
language plpgsql security definer set search_path to 'public' as $function$
declare v_row public.factory_material_requests; v_allowed boolean; v_job public.inhouse_production_requests; v_factory_dept uuid;
begin
  perform public.staff_assert_operational();
  if coalesce(p_status, '') not in ('REQUESTED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED') then raise exception 'Invalid status'; end if;
  select * into v_row from public.factory_material_requests where id = p_id for update;
  if v_row.id is null then raise exception 'Material request not found'; end if;

  v_allowed := (coalesce(public.staff_is_factory_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or public.staff_current_department_id() = public.factory_procurement_dept_id()
    or v_row.created_by = auth.uid() or v_row.requested_by = auth.uid());
  if not v_allowed then raise exception 'Not authorized to update this material request'; end if;

  update public.factory_material_requests set status = p_status, notes = coalesce(p_notes, notes),
    received_at = case when p_status = 'RECEIVED' then now() else received_at end,
    received_by = case when p_status = 'RECEIVED' then auth.uid() else received_by end
  where id = p_id returning * into v_row;

  perform public.staff_write_audit('factory_material_request', p_id, 'STATUS_UPDATE', null, jsonb_build_object('status', p_status), null, p_notes);

  if v_row.job_card_id is not null then
    select * into v_job from public.inhouse_production_requests where id = v_row.job_card_id;
    insert into public.factory_job_events (job_id, event_type, note, actor_id)
    values (v_row.job_card_id, 'material_status', v_row.request_number || ' — ' || p_status || coalesce(': ' || p_notes, ''), auth.uid());
    -- v_job.assigned_factory_coordinator is a profiles.id (Factory's own id space, via factory_my_profile_id()),
    -- not a user_profiles.id -- resolved through profiles.auth_id (confirmed live: every profiles row's auth_id
    -- matches a real user_profiles.id) before calling the shared, user_profiles-based notification helper.
    if p_status = 'RECEIVED' and v_job.id is not null and v_job.assigned_factory_coordinator is not null then
      perform public.staff_notify_assignment(
        (select auth_id from public.profiles where id = v_job.assigned_factory_coordinator),
        'factory_material_request', p_id, 'Material received — work can start: ' || v_job.job_order_number,
        v_job.job_order_number || ' — મટિરિયલ મળ્યું, કામ શરૂ કરી શકાય');
    end if;
  end if;

  return v_row;
end $function$;
grant execute on function public.factory_update_material_request_status(uuid, text, text) to authenticated;

do $$
declare fn text;
begin
  foreach fn in array array[
    'factory_set_job_division(uuid, uuid)',
    'factory_list_stage_templates(uuid)',
    'factory_division_dashboard_counts(uuid)',
    'factory_create_material_request(text, uuid, numeric, text, text, text, date, uuid, text, text)',
    'factory_update_material_request_status(uuid, text, text)',
    'factory_procurement_dept_id()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
