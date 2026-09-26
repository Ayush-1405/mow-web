-- v2_93j -- Retail fulfilment pipeline, stage 2: Dispatch -> Delivery (proof, partial, failure) -> Installation -> Completion.
--
-- retail_advance_delivery (v2_93a) currently accepts ANY of its stages, including 'DISPATCHED'/'DELIVERED'/'INSTALLATION'/
-- 'CUSTOMER_CONFIRMATION'/'COMPLETED', with no proof requirement at all -- a real, live bypass of everything this migration is
-- about to build. It is narrowed here to only the pre-dispatch coordination stages; every safety-critical stage from here on is
-- reachable ONLY through the new guarded RPCs below.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. retail_deliveries -- widen stage (additive) + new coordination/document columns.
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.retail_deliveries drop constraint if exists retail_deliveries_stage_check;
alter table public.retail_deliveries add constraint retail_deliveries_stage_check check (stage in (
  'ORDER_READY', 'PAYMENT_CLEARANCE', 'SITE_READINESS', 'DELIVERY_SCHEDULED', 'VEHICLE_ASSIGNED',
  'ASSIGNED_TO_GODOWN', 'RECEIVED_AT_GODOWN', 'DISPATCHED', 'OUT_FOR_DELIVERY', 'ARRIVED_AT_SITE',
  'DELIVERED_AWAITING_PROOF', 'DELIVERY_PROOF_UPLOADED', 'DELIVERY_SUCCESSFUL', 'DELIVERY_FAILED',
  'INSTALLATION_PENDING', 'INSTALLATION_IN_PROGRESS', 'INSTALLATION_PROOF_UPLOADED',
  'DELIVERED', 'INSTALLATION', 'CUSTOMER_CONFIRMATION', 'COMPLETED'
));
alter table public.retail_deliveries add column if not exists driver_name text;
alter table public.retail_deliveries add column if not exists driver_phone text;
alter table public.retail_deliveries add column if not exists delivery_team text;
alter table public.retail_deliveries add column if not exists installation_team text;
alter table public.retail_deliveries add column if not exists delivery_challan_number text;
alter table public.retail_deliveries add column if not exists invoice_eway_status text;
alter table public.retail_deliveries add column if not exists checklist jsonb not null default '{}'::jsonb;
alter table public.retail_deliveries add column if not exists checklist_exception_reason text;
alter table public.retail_deliveries add column if not exists checklist_exception_by uuid references public.user_profiles(id);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. retail_dispatch_records -- one row per order. Dispatch/Godown staff only, requires the pre-dispatch checklist (or a logged
--    exception) and a real dispatch photo before retail_record_dispatch() will mark it dispatched.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_dispatch_records (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.retail_orders(id),
  godown_handover_id uuid references public.retail_godown_handovers(id),
  department_id uuid not null references public.departments(id), -- DISPATCH
  vehicle_number text,
  vehicle_transporter text,
  package_count integer,
  dispatched_by uuid references public.user_profiles(id),
  dispatched_at timestamptz,
  delivery_challan_ref text,
  gps_location text,
  notes text,
  linked_task_id uuid references public.staff_tasks(id),
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_active boolean not null default true
);
create unique index if not exists retail_dispatch_records_order_uq on public.retail_dispatch_records (order_id);
create trigger trg_touch_updated_at before update on public.retail_dispatch_records for each row execute function public.staff_touch_updated_at();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. retail_delivery_items -- the partial-delivery tracker: quantity_delivered vs. quantity_pending, per order line item.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_delivery_items (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.retail_deliveries(id) on delete cascade,
  order_item_id uuid not null references public.retail_order_items(id),
  quantity_delivered numeric(12,2) not null default 0,
  quantity_pending numeric(12,2),
  condition text,
  notes text,
  updated_at timestamptz not null default now()
);
create unique index if not exists retail_delivery_items_uq on public.retail_delivery_items (delivery_id, order_item_id);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. retail_delivery_proofs -- one row per ATTEMPT (delivery / installation / failure). A failed attempt and a successful retry are
--    both kept -- never overwritten.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_delivery_proofs (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.retail_deliveries(id),
  proof_type text not null check (proof_type in ('DELIVERY', 'INSTALLATION', 'FAILURE')),
  site_representative_name text,
  delivered_by uuid references public.user_profiles(id),
  pod_method text check (pod_method is null or pod_method in ('SIGNATURE', 'OTP', 'PHOTO_CONFIRM')),
  pod_reference text,
  quantity_note text,
  condition_notes text,
  damage_notes text,
  failure_reason text,
  next_delivery_date date,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists retail_delivery_proofs_delivery_idx on public.retail_delivery_proofs (delivery_id, created_at desc);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. retail_installations -- one row per order (only created when installation_required). Mirrors packing/godown's "photo before
--    advance" discipline.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_installations (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.retail_deliveries(id),
  order_id uuid not null references public.retail_orders(id),
  status text not null default 'PENDING' check (status in ('PENDING', 'IN_PROGRESS', 'PROOF_UPLOADED', 'COMPLETED')),
  installation_team text,
  completed_at timestamptz,
  pending_work text,
  damage_rework text,
  customer_confirmed boolean not null default false,
  feedback_score integer check (feedback_score between 1 and 5),
  linked_task_id uuid references public.staff_tasks(id),
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists retail_installations_order_uq on public.retail_installations (order_id);
create trigger trg_touch_updated_at before update on public.retail_installations for each row execute function public.staff_touch_updated_at();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 6. RLS
-- ---------------------------------------------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['retail_dispatch_records', 'retail_delivery_items', 'retail_delivery_proofs', 'retail_installations'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

create policy retail_dispatch_records_select on public.retail_dispatch_records for select to authenticated using (
  staff_current_user_ok() and (
    created_by = auth.uid() or staff_is_dispatch_staff() or staff_is_godown_staff()
    or exists (select 1 from public.retail_orders o where o.id = retail_dispatch_records.order_id and (o.created_by = auth.uid() or retail_can_access_customer(o.customer_id)))
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))));
create policy retail_dispatch_records_write on public.retail_dispatch_records for all to authenticated
  using (staff_current_user_ok() and staff_has_global_oversight()) with check (staff_current_user_ok() and staff_has_global_oversight());

create policy retail_delivery_items_select on public.retail_delivery_items for select to authenticated using (
  staff_current_user_ok() and exists (select 1 from public.retail_deliveries dl join public.retail_orders o on o.id = dl.order_id
    where dl.id = retail_delivery_items.delivery_id and (
      dl.created_by = auth.uid() or o.created_by = auth.uid() or retail_can_access_customer(o.customer_id)
      or staff_is_dispatch_staff() or staff_is_godown_staff() or staff_has_global_oversight()
      or (staff_is_dept_head() and staff_dept_in_hod_scope(dl.department_id)))));
create policy retail_delivery_items_write on public.retail_delivery_items for all to authenticated
  using (staff_current_user_ok() and staff_has_global_oversight()) with check (staff_current_user_ok() and staff_has_global_oversight());

create policy retail_delivery_proofs_select on public.retail_delivery_proofs for select to authenticated using (
  staff_current_user_ok() and exists (select 1 from public.retail_deliveries dl join public.retail_orders o on o.id = dl.order_id
    where dl.id = retail_delivery_proofs.delivery_id and (
      dl.created_by = auth.uid() or o.created_by = auth.uid() or retail_can_access_customer(o.customer_id)
      or staff_is_dispatch_staff() or staff_is_godown_staff() or staff_has_global_oversight()
      or (staff_is_dept_head() and staff_dept_in_hod_scope(dl.department_id)))));
create policy retail_delivery_proofs_write on public.retail_delivery_proofs for all to authenticated
  using (staff_current_user_ok() and staff_has_global_oversight()) with check (staff_current_user_ok() and staff_has_global_oversight());

create policy retail_installations_select on public.retail_installations for select to authenticated using (
  staff_current_user_ok() and (
    created_by = auth.uid()
    or exists (select 1 from public.retail_orders o where o.id = retail_installations.order_id and (o.created_by = auth.uid() or retail_can_access_customer(o.customer_id)))
    or staff_has_global_oversight() or (staff_is_dept_head())));
create policy retail_installations_write on public.retail_installations for all to authenticated
  using (staff_current_user_ok() and staff_has_global_oversight()) with check (staff_current_user_ok() and staff_has_global_oversight());

grant select, insert, update, delete on public.retail_dispatch_records, public.retail_delivery_items, public.retail_delivery_proofs, public.retail_installations to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 7. retail_advance_delivery -- CREATE OR REPLACE, same signature; narrowed to pre-dispatch coordination stages only (closing the
--    bypass described above), and the old bare `v_task record` pattern is replaced with scalar variables (the same class of bug
--    fixed in v2_93g's retail_record_followup hotfix, pre-empted here rather than discovered live).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_advance_delivery(p_order_id uuid, p_stage text, p_notes text default null, p_scheduled_at timestamptz default null)
returns public.retail_deliveries language plpgsql security definer set search_path = public as $$
declare v_order public.retail_orders; v_row public.retail_deliveries; v_task_id uuid; v_key text;
begin
  perform public.staff_assert_operational();
  if p_stage not in ('ORDER_READY','PAYMENT_CLEARANCE','SITE_READINESS','DELIVERY_SCHEDULED','VEHICLE_ASSIGNED') then
    raise exception 'Invalid delivery stage — dispatch/delivery/installation stages are set only by their own guarded actions';
  end if;
  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if not (coalesce(v_order.created_by = auth.uid(), false) or coalesce(public.retail_can_write_customer(v_order.customer_id), false)
          or coalesce(public.staff_has_global_oversight(), false)
          or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_order.department_id), false))) then
    raise exception 'Not authorized to update this delivery';
  end if;

  insert into public.retail_deliveries (department_id, order_id, delivery_address, created_by)
  values (v_order.department_id, p_order_id, v_order.delivery_address, auth.uid())
  on conflict (order_id) do nothing;

  update public.retail_deliveries set stage = p_stage, scheduled_at = coalesce(p_scheduled_at, scheduled_at)
  where order_id = p_order_id returning * into v_row;

  if p_stage = 'DELIVERY_SCHEDULED' then
    v_key := 'retail_delivery:' || v_row.id::text;
    if not exists (select 1 from public.staff_tasks where system_key = v_key) then
      select t.task_id into v_task_id from public.staff_create_task(
        'Coordinate delivery: ' || v_order.order_number, coalesce(p_notes, 'Delivery scheduled'), 'DELIVERY', 'HIGH', 'none',
        v_order.department_id, v_order.department_id, v_order.created_by, coalesce(p_scheduled_at::date, current_date + 1), p_scheduled_at::time,
        null, v_order.order_number, null, null, null, null) t;
      update public.staff_tasks set system_key = v_key where id = v_task_id;
      update public.retail_deliveries set linked_task_id = v_task_id where id = v_row.id;
    end if;
  end if;

  perform public.retail_log_status_change('retail_order', p_order_id, null, p_stage, v_order.department_id, p_notes);
  perform public.staff_write_audit('retail_order', p_order_id, 'DELIVERY_STAGE', null, jsonb_build_object('stage', p_stage), v_order.department_id);
  return v_row;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 8. Dispatch RPCs
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_start_dispatch(p_order_id uuid)
returns public.retail_dispatch_records language plpgsql security definer set search_path = public as $$
declare v_order public.retail_orders; v_handover public.retail_godown_handovers; v_row public.retail_dispatch_records; v_dispatch_dept uuid := public.retail_dispatch_dept_id();
begin
  perform public.staff_assert_operational();
  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if v_order.on_hold then raise exception 'Order is on hold: %', v_order.on_hold_reason; end if;

  select * into v_row from public.retail_dispatch_records where order_id = p_order_id;
  if v_row.id is not null then return v_row; end if; -- idempotent

  select * into v_handover from public.retail_godown_handovers where order_id = p_order_id and status = 'ACCEPTED' order by accepted_at desc limit 1;
  if v_handover.id is null then raise exception 'Order must be accepted at Godown before dispatch can start'; end if;

  if not (coalesce(public.staff_is_dispatch_staff(), false) or coalesce(public.staff_is_godown_staff(), false)
          or coalesce(public.staff_has_global_oversight(), false)
          or (coalesce(public.staff_is_dept_head(), false) and (coalesce(public.staff_dept_in_hod_scope(v_dispatch_dept), false) or coalesce(public.staff_dept_in_hod_scope(v_handover.department_id), false)))) then
    raise exception 'Not authorized to start dispatch for this order';
  end if;

  insert into public.retail_dispatch_records (order_id, godown_handover_id, department_id, created_by)
  values (p_order_id, v_handover.id, v_dispatch_dept, auth.uid()) returning * into v_row;

  perform public.staff_write_audit('retail_dispatch', v_row.id, 'START', null, jsonb_build_object('order_id', p_order_id), v_dispatch_dept);
  return v_row;
end $$;

-- retail_record_dispatch -- requires the pre-dispatch checklist complete (or a logged exception by an authorized user) and a real
-- dispatch photo already uploaded. Sets the delivery stage DISPATCHED -> OUT_FOR_DELIVERY in one step (there is no separate manual
-- "leaving the yard" action in this pilot) and creates the per-item delivery rows the partial-delivery tracker needs.
create or replace function public.retail_record_dispatch(
  p_dispatch_id uuid, p_vehicle_number text, p_vehicle_transporter text default null, p_package_count integer default null,
  p_delivery_challan_ref text default null, p_gps_location text default null, p_notes text default null)
returns public.retail_dispatch_records language plpgsql security definer set search_path = public as $$
declare
  v_row public.retail_dispatch_records; v_order public.retail_orders; v_delivery public.retail_deliveries; v_allowed boolean; v_has_photo boolean;
  v_checklist jsonb; v_all_checked boolean; v_key text; v_task_id uuid;
  v_required_keys constant text[] := array['correct_order','correct_customer_address','quantity_checked','packing_checked','condition_checked','documents_checked','payment_clearance_checked','site_confirmed','vehicle_assigned'];
  v_k text;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_dispatch_records where id = p_dispatch_id for update;
  if v_row.id is null then raise exception 'Dispatch record not found'; end if;
  if v_row.dispatched_at is not null then return v_row; end if; -- idempotent

  select * into v_order from public.retail_orders where id = v_row.order_id;
  v_allowed := (coalesce(public.staff_is_dispatch_staff(), false) or coalesce(public.staff_is_godown_staff(), false)
    or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_row.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to record dispatch'; end if;
  if v_order.on_hold then raise exception 'Order is on hold: %', v_order.on_hold_reason; end if;

  select coalesce(checklist, '{}'::jsonb) into v_checklist from public.retail_deliveries where order_id = v_row.order_id;
  v_all_checked := true;
  foreach v_k in array v_required_keys loop
    if coalesce((v_checklist->>v_k)::boolean, false) = false then v_all_checked := false; end if;
  end loop;
  if not v_all_checked and not exists (select 1 from public.retail_deliveries where order_id = v_row.order_id and checklist_exception_reason is not null) then
    raise exception 'Pre-dispatch checklist is incomplete — complete it, or an authorized user must record an exception reason';
  end if;

  select exists (select 1 from public.staff_attachments a where a.entity_type = 'retail_dispatch' and a.entity_id = p_dispatch_id
    and a.purpose = 'proof' and a.is_active) into v_has_photo;
  if not v_has_photo then raise exception 'A dispatch photo (packed order + vehicle) is required before dispatch can be recorded'; end if;

  update public.retail_dispatch_records set vehicle_number = p_vehicle_number, vehicle_transporter = p_vehicle_transporter,
    package_count = p_package_count, dispatched_by = auth.uid(), dispatched_at = now(), delivery_challan_ref = p_delivery_challan_ref,
    gps_location = p_gps_location, notes = coalesce(p_notes, notes)
  where id = p_dispatch_id returning * into v_row;

  insert into public.retail_deliveries (department_id, order_id, delivery_address, created_by)
  values (v_order.department_id, v_row.order_id, v_order.delivery_address, auth.uid())
  on conflict (order_id) do nothing;
  update public.retail_deliveries set stage = 'OUT_FOR_DELIVERY', delivery_challan_number = p_delivery_challan_ref
  where order_id = v_row.order_id returning * into v_delivery;

  insert into public.retail_delivery_items (delivery_id, order_item_id, quantity_pending)
  select v_delivery.id, oi.id, oi.quantity from public.retail_order_items oi where oi.order_id = v_row.order_id
  on conflict (delivery_id, order_item_id) do nothing;

  v_key := 'retail_dispatch_delivery:' || v_row.order_id::text;
  select tk.task_id into v_task_id from public.staff_create_task(
    'Deliver order ' || v_order.order_number, coalesce(p_notes, 'Dispatched — proceed to delivery'), 'DELIVERY', 'HIGH', 'photo',
    v_row.department_id, v_order.department_id, v_order.created_by, current_date + 1, null, null, v_order.order_number, null, null, null, null) tk;
  update public.staff_tasks set system_key = v_key where id = v_task_id and not exists (select 1 from staff_tasks where system_key = v_key and id <> v_task_id);
  update public.retail_dispatch_records set linked_task_id = v_task_id where id = p_dispatch_id;

  perform public.retail_log_status_change('retail_order', v_row.order_id, 'RECEIVED_AT_GODOWN', 'OUT_FOR_DELIVERY', v_row.department_id, p_notes);
  perform public.staff_write_audit('retail_dispatch', p_dispatch_id, 'DISPATCH', null,
    jsonb_build_object('vehicle_number', p_vehicle_number, 'package_count', p_package_count), v_row.department_id);
  perform public.staff_notify_assignment(v_order.created_by, 'retail_dispatch', p_dispatch_id,
    'Order dispatched: ' || v_order.order_number, v_order.order_number || ' — મોકલી દેવાયો');
  return v_row;
end $$;

-- retail_pre_dispatch_checklist -- p_exception_reason may only be set by an authorized user (management/dept-head-in-scope).
create or replace function public.retail_pre_dispatch_checklist(p_order_id uuid, p_checklist jsonb, p_exception_reason text default null)
returns public.retail_deliveries language plpgsql security definer set search_path = public as $$
declare v_order public.retail_orders; v_row public.retail_deliveries;
begin
  perform public.staff_assert_operational();
  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if not (coalesce(v_order.created_by = auth.uid(), false) or coalesce(public.retail_can_write_customer(v_order.customer_id), false)
          or coalesce(public.staff_is_dispatch_staff(), false) or coalesce(public.staff_is_godown_staff(), false)
          or coalesce(public.staff_has_global_oversight(), false)
          or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_order.department_id), false))) then
    raise exception 'Not authorized to update this checklist';
  end if;
  if p_exception_reason is not null and not (coalesce(public.staff_has_global_oversight(), false)
      or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_order.department_id), false))) then
    raise exception 'Only management or a dept head may record a checklist exception';
  end if;

  insert into public.retail_deliveries (department_id, order_id, delivery_address, created_by)
  values (v_order.department_id, p_order_id, v_order.delivery_address, auth.uid())
  on conflict (order_id) do nothing;

  update public.retail_deliveries set checklist = coalesce(p_checklist, '{}'::jsonb),
    checklist_exception_reason = p_exception_reason, checklist_exception_by = case when p_exception_reason is not null then auth.uid() else null end
  where order_id = p_order_id returning * into v_row;

  perform public.staff_write_audit('retail_order', p_order_id, 'CHECKLIST_UPDATE', null,
    jsonb_build_object('checklist', p_checklist, 'exception_reason', p_exception_reason), v_order.department_id);
  return v_row;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 9. Delivery proof / partial / failure RPCs
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_record_delivery_proof(
  p_order_id uuid, p_site_representative_name text, p_pod_method text, p_pod_reference text default null,
  p_items jsonb default '[]'::jsonb, p_condition_notes text default null)
returns public.retail_deliveries language plpgsql security definer set search_path = public as $$
declare
  v_order public.retail_orders; v_delivery public.retail_deliveries; v_allowed boolean; v_has_photo boolean;
  v_it jsonb; v_ordered numeric; v_delivered numeric; v_all_delivered boolean := true; v_new_stage text; v_key text; v_task_id uuid;
begin
  perform public.staff_assert_operational();
  if p_pod_method not in ('SIGNATURE', 'OTP', 'PHOTO_CONFIRM') then raise exception 'Invalid proof-of-delivery method'; end if;
  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order.id is null then raise exception 'Order not found'; end if;
  select * into v_delivery from public.retail_deliveries where order_id = p_order_id for update;
  if v_delivery.id is null or not exists (select 1 from public.retail_dispatch_records where order_id = p_order_id and dispatched_at is not null) then
    raise exception 'Order has not been dispatched yet';
  end if;

  v_allowed := (coalesce(public.staff_is_dispatch_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_delivery.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to record delivery proof'; end if;

  select exists (select 1 from public.staff_attachments a where a.entity_type = 'retail_delivery' and a.entity_id = v_delivery.id
    and a.purpose = 'proof' and a.is_active) into v_has_photo;
  if not v_has_photo then raise exception 'A delivery-site photo is required before delivery proof can be recorded'; end if;

  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select quantity into v_ordered from public.retail_order_items where id = (v_it->>'order_item_id')::uuid;
    v_delivered := coalesce((v_it->>'quantity_delivered')::numeric, 0);
    insert into public.retail_delivery_items (delivery_id, order_item_id, quantity_delivered, quantity_pending, condition)
    values (v_delivery.id, (v_it->>'order_item_id')::uuid, v_delivered, greatest(coalesce(v_ordered, v_delivered) - v_delivered, 0), v_it->>'condition')
    on conflict (delivery_id, order_item_id) do update set quantity_delivered = excluded.quantity_delivered,
      quantity_pending = excluded.quantity_pending, condition = excluded.condition, updated_at = now();
  end loop;

  select bool_and(quantity_pending <= 0) into v_all_delivered from public.retail_delivery_items where delivery_id = v_delivery.id;
  v_new_stage := case when coalesce(v_all_delivered, false) then 'DELIVERY_SUCCESSFUL' else 'DELIVERY_PROOF_UPLOADED' end;

  update public.retail_deliveries set stage = v_new_stage where id = v_delivery.id returning * into v_delivery;

  insert into public.retail_delivery_proofs (delivery_id, proof_type, site_representative_name, delivered_by, pod_method, pod_reference, condition_notes, created_by)
  values (v_delivery.id, 'DELIVERY', p_site_representative_name, auth.uid(), p_pod_method, p_pod_reference, p_condition_notes, auth.uid());

  if v_new_stage = 'DELIVERY_PROOF_UPLOADED' then
    v_key := 'retail_pending_delivery:' || p_order_id::text;
    if not exists (select 1 from public.staff_tasks where system_key = v_key and is_active) then
      select tk.task_id into v_task_id from public.staff_create_task(
        'Pending delivery: ' || v_order.order_number, 'Some items were not fully delivered — arrange the remaining quantity.',
        'DELIVERY', 'URGENT', 'photo', v_delivery.department_id, v_delivery.department_id, v_order.created_by, current_date + 2, null,
        null, v_order.order_number, null, null, null, null) tk;
      update public.staff_tasks set system_key = v_key where id = v_task_id;
    end if;
  end if;

  perform public.retail_log_status_change('retail_order', p_order_id, 'OUT_FOR_DELIVERY', v_new_stage, v_delivery.department_id, p_condition_notes);
  perform public.staff_write_audit('retail_order', p_order_id, 'DELIVERY_PROOF', null, jsonb_build_object('stage', v_new_stage), v_delivery.department_id);
  return v_delivery;
end $$;

create or replace function public.retail_record_delivery_failure(p_order_id uuid, p_reason text, p_next_delivery_date date default null)
returns public.retail_deliveries language plpgsql security definer set search_path = public as $$
declare v_order public.retail_orders; v_delivery public.retail_deliveries; v_allowed boolean;
begin
  perform public.staff_assert_operational();
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A failure reason is required'; end if;
  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order.id is null then raise exception 'Order not found'; end if;
  select * into v_delivery from public.retail_deliveries where order_id = p_order_id for update;
  if v_delivery.id is null then raise exception 'No delivery record for this order'; end if;

  v_allowed := (coalesce(public.staff_is_dispatch_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_delivery.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to record a delivery failure'; end if;

  update public.retail_deliveries set stage = 'DELIVERY_FAILED', delay_reason = p_reason, rescheduled_at = p_next_delivery_date::timestamptz
  where id = v_delivery.id returning * into v_delivery;

  insert into public.retail_delivery_proofs (delivery_id, proof_type, failure_reason, next_delivery_date, created_by)
  values (v_delivery.id, 'FAILURE', p_reason, p_next_delivery_date, auth.uid());

  perform public.retail_log_status_change('retail_order', p_order_id, 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', v_delivery.department_id, p_reason);
  perform public.staff_write_audit('retail_order', p_order_id, 'DELIVERY_FAILED', null, jsonb_build_object('reason', p_reason), v_delivery.department_id);
  perform public.staff_notify_assignment(v_order.created_by, 'retail_order', p_order_id,
    'Delivery failed: ' || v_order.order_number, v_order.order_number || ' — ડિલિવરી નિષ્ફળ');
  perform public.staff_notify_dept_leadership('RETAIL', 'retail_order', p_order_id,
    'Delivery failed: ' || v_order.order_number, v_order.order_number || ' — ડિલિવરી નિષ્ફળ');
  return v_delivery;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 10. Installation + completion RPCs
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_start_installation(p_order_id uuid)
returns public.retail_installations language plpgsql security definer set search_path = public as $$
declare v_order public.retail_orders; v_delivery public.retail_deliveries; v_row public.retail_installations; v_key text; v_task_id uuid;
begin
  perform public.staff_assert_operational();
  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if not v_order.installation_required then raise exception 'This order does not require installation'; end if;
  select * into v_delivery from public.retail_deliveries where order_id = p_order_id;
  if v_delivery.id is null or v_delivery.stage not in ('DELIVERY_SUCCESSFUL', 'INSTALLATION_PENDING', 'INSTALLATION_IN_PROGRESS') then
    raise exception 'Delivery must be successful before installation can start';
  end if;

  select * into v_row from public.retail_installations where order_id = p_order_id;
  if v_row.id is not null then return v_row; end if; -- idempotent

  if not (coalesce(v_order.created_by = auth.uid(), false) or coalesce(public.retail_can_write_customer(v_order.customer_id), false)
          or coalesce(public.staff_has_global_oversight(), false)
          or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_order.department_id), false))) then
    raise exception 'Not authorized to start installation for this order';
  end if;

  insert into public.retail_installations (delivery_id, order_id, status, created_by)
  values (v_delivery.id, p_order_id, 'IN_PROGRESS', auth.uid()) returning * into v_row;

  update public.retail_deliveries set stage = 'INSTALLATION_IN_PROGRESS' where id = v_delivery.id;

  v_key := 'retail_installation:' || v_row.id::text;
  select tk.task_id into v_task_id from public.staff_create_task(
    'Install order ' || v_order.order_number, 'Complete installation and upload a proof photo.', 'GENERAL_TASK', 'HIGH', 'photo',
    v_order.department_id, v_order.department_id, auth.uid(), current_date + 3, null, null, v_order.order_number, null, null, null, null) tk;
  update public.staff_tasks set system_key = v_key where id = v_task_id;
  update public.retail_installations set linked_task_id = v_task_id where id = v_row.id returning * into v_row;

  perform public.retail_log_status_change('retail_order', p_order_id, 'DELIVERY_SUCCESSFUL', 'INSTALLATION_IN_PROGRESS', v_order.department_id, null);
  return v_row;
end $$;

create or replace function public.retail_record_installation(p_installation_id uuid, p_installation_team text default null, p_pending_work text default null, p_damage_rework text default null)
returns public.retail_installations language plpgsql security definer set search_path = public as $$
declare v_row public.retail_installations; v_order public.retail_orders; v_allowed boolean; v_has_photo boolean;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_installations where id = p_installation_id for update;
  if v_row.id is null then raise exception 'Installation record not found'; end if;
  select * into v_order from public.retail_orders where id = v_row.order_id;

  v_allowed := (coalesce(v_row.created_by = auth.uid(), false) or coalesce(public.retail_can_write_customer(v_order.customer_id), false)
    or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_order.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to update this installation'; end if;

  select exists (select 1 from public.staff_attachments a where a.entity_type = 'retail_installation' and a.entity_id = p_installation_id
    and a.purpose = 'proof' and a.is_active) into v_has_photo;
  if not v_has_photo then raise exception 'An installation proof photo is required'; end if;

  update public.retail_installations set status = 'PROOF_UPLOADED', installation_team = coalesce(p_installation_team, installation_team),
    pending_work = p_pending_work, damage_rework = p_damage_rework
  where id = p_installation_id returning * into v_row;

  update public.retail_deliveries set stage = 'INSTALLATION_PROOF_UPLOADED' where id = v_row.delivery_id;

  perform public.retail_log_status_change('retail_order', v_row.order_id, 'INSTALLATION_IN_PROGRESS', 'INSTALLATION_PROOF_UPLOADED', v_order.department_id, p_pending_work);
  perform public.staff_write_audit('retail_installation', p_installation_id, 'PROOF', null, jsonb_build_object('pending_work', p_pending_work), v_order.department_id);
  return v_row;
end $$;

-- retail_confirm_installation -- the LAST gate before Completed. Requires the proof photo already recorded (status=PROOF_UPLOADED).
create or replace function public.retail_confirm_installation(p_installation_id uuid, p_customer_confirmed boolean, p_feedback_score integer default null)
returns public.retail_installations language plpgsql security definer set search_path = public as $$
declare v_row public.retail_installations; v_order public.retail_orders; v_allowed boolean;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_installations where id = p_installation_id for update;
  if v_row.id is null then raise exception 'Installation record not found'; end if;
  select * into v_order from public.retail_orders where id = v_row.order_id;

  v_allowed := (coalesce(v_row.created_by = auth.uid(), false) or coalesce(public.retail_can_write_customer(v_order.customer_id), false)
    or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_order.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to confirm this installation'; end if;
  if v_row.status <> 'PROOF_UPLOADED' then raise exception 'Installation proof must be uploaded before it can be confirmed'; end if;

  update public.retail_installations set status = case when p_customer_confirmed then 'COMPLETED' else status end,
    customer_confirmed = p_customer_confirmed, feedback_score = p_feedback_score, completed_at = case when p_customer_confirmed then now() else completed_at end
  where id = p_installation_id returning * into v_row;

  if p_customer_confirmed then
    update public.retail_deliveries set stage = 'COMPLETED', customer_confirmed = true, feedback_score = coalesce(p_feedback_score, feedback_score) where id = v_row.delivery_id;
    update public.retail_orders set status = 'DELIVERED' where id = v_row.order_id;
    perform public.retail_log_status_change('retail_order', v_row.order_id, 'INSTALLATION_PROOF_UPLOADED', 'COMPLETED', v_order.department_id, null);
  end if;

  perform public.staff_write_audit('retail_installation', p_installation_id, 'CONFIRM', null,
    jsonb_build_object('customer_confirmed', p_customer_confirmed, 'feedback_score', p_feedback_score), v_order.department_id);
  return v_row;
end $$;

-- retail_complete_order -- for orders that never required installation: the direct DELIVERY_SUCCESSFUL -> COMPLETED step.
create or replace function public.retail_complete_order(p_order_id uuid)
returns public.retail_deliveries language plpgsql security definer set search_path = public as $$
declare v_order public.retail_orders; v_delivery public.retail_deliveries; v_allowed boolean;
begin
  perform public.staff_assert_operational();
  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if v_order.installation_required then raise exception 'This order requires installation — use retail_confirm_installation instead'; end if;
  select * into v_delivery from public.retail_deliveries where order_id = p_order_id for update;
  if v_delivery.id is null or v_delivery.stage <> 'DELIVERY_SUCCESSFUL' then raise exception 'Delivery must be successful before the order can be completed'; end if;

  v_allowed := (coalesce(v_order.created_by = auth.uid(), false) or coalesce(public.retail_can_write_customer(v_order.customer_id), false)
    or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_order.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to complete this order'; end if;

  update public.retail_deliveries set stage = 'COMPLETED', customer_confirmed = true where id = v_delivery.id returning * into v_delivery;
  update public.retail_orders set status = 'DELIVERED' where id = p_order_id;

  perform public.retail_log_status_change('retail_order', p_order_id, 'DELIVERY_SUCCESSFUL', 'COMPLETED', v_order.department_id, null);
  perform public.staff_write_audit('retail_order', p_order_id, 'COMPLETE', null, null, v_order.department_id);
  return v_delivery;
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'retail_advance_delivery(uuid, text, text, timestamptz)',
    'retail_start_dispatch(uuid)',
    'retail_record_dispatch(uuid, text, text, integer, text, text, text)',
    'retail_pre_dispatch_checklist(uuid, jsonb, text)',
    'retail_record_delivery_proof(uuid, text, text, text, jsonb, text)',
    'retail_record_delivery_failure(uuid, text, date)',
    'retail_start_installation(uuid)',
    'retail_record_installation(uuid, text, text, text)',
    'retail_confirm_installation(uuid, boolean, integer)',
    'retail_complete_order(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
