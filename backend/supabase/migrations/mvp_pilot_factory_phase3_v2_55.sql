-- mvp_pilot_factory_phase3_v2_55
-- Unlocks the 6 remaining Factory cards that were genuinely blocked on
-- missing shared infrastructure (confirmed by schema scan, not assumed):
-- Raw Material Availability, Material Issue, Machine Tracking, Transfer,
-- Factory Inventory Costing, Drawings.
--
-- This is the first real inventory ledger anywhere in this app -- reused
-- (via factory_locations, already existing) rather than duplicated. It is
-- scoped to Factory materials because that is what was asked for and what
-- is tested here; nothing prevents Godown/Inventory from growing into the
-- same tables later, since the design (materials/locations/transactions)
-- is not Factory-specific in shape.
--
-- factory_bom_items gets an ADDITIVE nullable material_id so future BOM
-- rows can link to the real material master; existing/free-text rows are
-- untouched and keep working exactly as before.

-- ---------------------------------------------------------------------
-- 1. Material master + stock + transaction ledger.
-- ---------------------------------------------------------------------
create table public.factory_materials (
  id uuid primary key default gen_random_uuid(),
  material_code text not null unique,
  material_name text not null,
  category text,
  unit text,
  reorder_level numeric,
  is_active boolean not null default true,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now()
);

create table public.factory_material_stock (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.factory_materials(id),
  location_id uuid not null references public.factory_locations(id),
  quantity_on_hand numeric not null default 0 check (quantity_on_hand >= 0),
  reserved_quantity numeric not null default 0 check (reserved_quantity >= 0),
  updated_at timestamptz not null default now(),
  unique (material_id, location_id)
);

create table public.factory_material_transactions (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.factory_materials(id),
  location_id uuid not null references public.factory_locations(id),
  job_id uuid references public.inhouse_production_requests(id),
  transaction_type text not null check (transaction_type in ('receipt', 'issue', 'return', 'adjustment', 'reservation', 'release_reservation')),
  quantity numeric not null check (quantity > 0),
  balance_after numeric not null,
  reference_number text,
  notes text,
  performed_by uuid not null references public.user_profiles(id),
  performed_at timestamptz not null default now()
);
create index factory_material_transactions_material_idx on public.factory_material_transactions(material_id, location_id);
create index factory_material_transactions_job_idx on public.factory_material_transactions(job_id);

alter table public.factory_bom_items add column if not exists material_id uuid references public.factory_materials(id);

alter table public.factory_materials enable row level security;
alter table public.factory_material_stock enable row level security;
alter table public.factory_material_transactions enable row level security;
grant select on public.factory_materials to authenticated;
grant select on public.factory_material_stock to authenticated;
grant select on public.factory_material_transactions to authenticated;

create policy "factory_materials_select" on public.factory_materials for select using (
  staff_is_management() or staff_is_super_admin() or staff_is_factory_staff() or interior_is_org_wide()
);
create policy "factory_material_stock_select" on public.factory_material_stock for select using (
  staff_is_management() or staff_is_super_admin() or staff_is_factory_staff() or interior_is_org_wide()
);
create policy "factory_material_transactions_select" on public.factory_material_transactions for select using (
  staff_is_management() or staff_is_super_admin() or staff_is_factory_staff() or interior_is_org_wide()
);

create or replace function public.factory_upsert_material(
  p_material_id uuid, p_material_code text, p_material_name text, p_category text default null,
  p_unit text default null, p_reorder_level numeric default null
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare v_id uuid;
begin
  perform public.staff_assert_operational();
  if not (public.staff_is_management() or public.staff_is_super_admin() or public.staff_is_factory_staff()) then
    raise exception 'You are not authorized to manage the material master';
  end if;
  if p_material_code is null or btrim(p_material_code) = '' then raise exception 'Material code is required'; end if;
  if p_material_name is null or btrim(p_material_name) = '' then raise exception 'Material name is required'; end if;

  if p_material_id is null then
    insert into public.factory_materials (material_code, material_name, category, unit, reorder_level, created_by)
    values (p_material_code, p_material_name, p_category, p_unit, p_reorder_level, auth.uid())
    returning id into v_id;
  else
    update public.factory_materials set material_code = p_material_code, material_name = p_material_name,
      category = p_category, unit = p_unit, reorder_level = p_reorder_level
    where id = p_material_id returning id into v_id;
    if v_id is null then raise exception 'Material not found'; end if;
  end if;

  perform public.staff_write_audit('factory_materials', v_id, 'SAVE', null, jsonb_build_object('material_code', p_material_code), null);
  return v_id;
end;
$function$;

revoke all on function public.factory_upsert_material(uuid,text,text,text,text,numeric) from public;
grant execute on function public.factory_upsert_material(uuid,text,text,text,text,numeric) to authenticated;

-- One internal helper used by every transaction RPC: applies a signed
-- delta to quantity_on_hand/reserved_quantity under row lock, refuses to
-- go negative, upserts the stock row on first movement, and returns the
-- resulting quantity_on_hand for the ledger's balance_after snapshot.
create or replace function public._factory_apply_stock_delta(p_material_id uuid, p_location_id uuid, p_qty_delta numeric, p_reserved_delta numeric)
returns numeric
language plpgsql security definer set search_path to 'public' as $function$
declare v_row public.factory_material_stock%rowtype; v_new_qty numeric; v_new_reserved numeric;
begin
  insert into public.factory_material_stock (material_id, location_id) values (p_material_id, p_location_id)
    on conflict (material_id, location_id) do nothing;
  select * into v_row from public.factory_material_stock where material_id = p_material_id and location_id = p_location_id for update;

  v_new_qty := v_row.quantity_on_hand + p_qty_delta;
  v_new_reserved := v_row.reserved_quantity + p_reserved_delta;
  if v_new_qty < 0 then raise exception 'This movement would take stock negative (available %, requested change %)', v_row.quantity_on_hand, p_qty_delta; end if;
  if v_new_reserved < 0 then raise exception 'This movement would take reserved quantity negative'; end if;
  if v_new_reserved > v_new_qty then raise exception 'Reserved quantity cannot exceed quantity on hand'; end if;

  update public.factory_material_stock set quantity_on_hand = v_new_qty, reserved_quantity = v_new_reserved, updated_at = now()
    where material_id = p_material_id and location_id = p_location_id;
  return v_new_qty;
end;
$function$;

revoke all on function public._factory_apply_stock_delta(uuid,uuid,numeric,numeric) from public;

create or replace function public.factory_receive_material(p_material_id uuid, p_location_id uuid, p_quantity numeric, p_reference_number text default null, p_notes text default null)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_balance numeric;
begin
  perform public.staff_assert_operational();
  if not (public.staff_is_management() or public.staff_is_super_admin() or public.staff_is_factory_staff()) then
    raise exception 'You are not authorized to receive material';
  end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'A positive quantity is required'; end if;

  v_balance := public._factory_apply_stock_delta(p_material_id, p_location_id, p_quantity, 0);
  insert into public.factory_material_transactions (material_id, location_id, transaction_type, quantity, balance_after, reference_number, notes, performed_by)
  values (p_material_id, p_location_id, 'receipt', p_quantity, v_balance, p_reference_number, p_notes, auth.uid());

  perform public.staff_write_audit('factory_material_transactions', p_material_id, 'RECEIPT', null, jsonb_build_object('quantity', p_quantity, 'location_id', p_location_id), null);
end;
$function$;

revoke all on function public.factory_receive_material(uuid,uuid,numeric,text,text) from public;
grant execute on function public.factory_receive_material(uuid,uuid,numeric,text,text) to authenticated;

create or replace function public.factory_issue_material(p_material_id uuid, p_location_id uuid, p_job_id uuid, p_quantity numeric, p_notes text default null)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_balance numeric; v_job public.inhouse_production_requests%rowtype;
begin
  perform public.staff_assert_operational();
  select * into v_job from public.inhouse_production_requests where id = p_job_id;
  if v_job.id is null then raise exception 'Job not found'; end if;
  if not public.staff_factory_record_authorized(v_job.project_id) then raise exception 'You are not authorized to issue material for this job'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'A positive quantity is required'; end if;

  v_balance := public._factory_apply_stock_delta(p_material_id, p_location_id, -p_quantity, 0);
  insert into public.factory_material_transactions (material_id, location_id, job_id, transaction_type, quantity, balance_after, notes, performed_by)
  values (p_material_id, p_location_id, p_job_id, 'issue', p_quantity, v_balance, p_notes, auth.uid());

  perform public.staff_write_audit('factory_material_transactions', p_material_id, 'ISSUE', null, jsonb_build_object('quantity', p_quantity, 'job_id', p_job_id, 'project_id', v_job.project_id), null);
  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id, 'Material issued — qty ' || p_quantity, 'સામગ્રી ઇશ્યૂ — જથ્થો ' || p_quantity);
  end if;
end;
$function$;

revoke all on function public.factory_issue_material(uuid,uuid,uuid,numeric,text) from public;
grant execute on function public.factory_issue_material(uuid,uuid,uuid,numeric,text) to authenticated;

create or replace function public.factory_return_material(p_material_id uuid, p_location_id uuid, p_job_id uuid, p_quantity numeric, p_notes text default null)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_balance numeric; v_job public.inhouse_production_requests%rowtype;
begin
  perform public.staff_assert_operational();
  select * into v_job from public.inhouse_production_requests where id = p_job_id;
  if v_job.id is null then raise exception 'Job not found'; end if;
  if not public.staff_factory_record_authorized(v_job.project_id) then raise exception 'You are not authorized to return material for this job'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'A positive quantity is required'; end if;

  v_balance := public._factory_apply_stock_delta(p_material_id, p_location_id, p_quantity, 0);
  insert into public.factory_material_transactions (material_id, location_id, job_id, transaction_type, quantity, balance_after, notes, performed_by)
  values (p_material_id, p_location_id, p_job_id, 'return', p_quantity, v_balance, p_notes, auth.uid());

  perform public.staff_write_audit('factory_material_transactions', p_material_id, 'RETURN', null, jsonb_build_object('quantity', p_quantity, 'job_id', p_job_id, 'project_id', v_job.project_id), null);
end;
$function$;

revoke all on function public.factory_return_material(uuid,uuid,uuid,numeric,text) from public;
grant execute on function public.factory_return_material(uuid,uuid,uuid,numeric,text) to authenticated;

create or replace function public.factory_reserve_material(p_material_id uuid, p_location_id uuid, p_job_id uuid, p_quantity numeric)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_balance numeric; v_job public.inhouse_production_requests%rowtype;
begin
  perform public.staff_assert_operational();
  select * into v_job from public.inhouse_production_requests where id = p_job_id;
  if v_job.id is null then raise exception 'Job not found'; end if;
  if not public.staff_factory_record_authorized(v_job.project_id) then raise exception 'You are not authorized to reserve material for this job'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'A positive quantity is required'; end if;

  v_balance := public._factory_apply_stock_delta(p_material_id, p_location_id, 0, p_quantity);
  insert into public.factory_material_transactions (material_id, location_id, job_id, transaction_type, quantity, balance_after, performed_by)
  values (p_material_id, p_location_id, p_job_id, 'reservation', p_quantity, v_balance, auth.uid());
end;
$function$;

revoke all on function public.factory_reserve_material(uuid,uuid,uuid,numeric) from public;
grant execute on function public.factory_reserve_material(uuid,uuid,uuid,numeric) to authenticated;

create or replace function public.factory_release_reservation(p_material_id uuid, p_location_id uuid, p_job_id uuid, p_quantity numeric)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_balance numeric; v_job public.inhouse_production_requests%rowtype;
begin
  perform public.staff_assert_operational();
  select * into v_job from public.inhouse_production_requests where id = p_job_id;
  if v_job.id is null then raise exception 'Job not found'; end if;
  if not public.staff_factory_record_authorized(v_job.project_id) then raise exception 'You are not authorized to release a reservation for this job'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'A positive quantity is required'; end if;

  v_balance := public._factory_apply_stock_delta(p_material_id, p_location_id, 0, -p_quantity);
  insert into public.factory_material_transactions (material_id, location_id, job_id, transaction_type, quantity, balance_after, performed_by)
  values (p_material_id, p_location_id, p_job_id, 'release_reservation', p_quantity, v_balance, auth.uid());
end;
$function$;

revoke all on function public.factory_release_reservation(uuid,uuid,uuid,numeric) from public;
grant execute on function public.factory_release_reservation(uuid,uuid,uuid,numeric) to authenticated;

-- Inventory Costing view: opening/received/issued/adjustment/closing per
-- material+location, computed purely from the transaction ledger (never a
-- manually-typed total) for a given date range.
create or replace function public.factory_inventory_costing(p_from date default null, p_to date default null)
returns table(
  material_id uuid, material_code text, material_name text, location_id uuid, location_name text,
  opening_quantity numeric, received_quantity numeric, issued_quantity numeric, adjustment_quantity numeric, closing_quantity numeric
)
language sql stable security definer set search_path to 'public' as $$
  with opening as (
    select t.material_id, t.location_id,
      coalesce(sum(case when t.transaction_type in ('receipt','return') then t.quantity when t.transaction_type = 'issue' then -t.quantity else 0 end), 0) as qty
    from public.factory_material_transactions t
    where p_from is null or t.performed_at::date < p_from
    group by t.material_id, t.location_id
  ),
  period as (
    select t.material_id, t.location_id,
      coalesce(sum(t.quantity) filter (where t.transaction_type in ('receipt','return')), 0) as received,
      coalesce(sum(t.quantity) filter (where t.transaction_type = 'issue'), 0) as issued,
      coalesce(sum(t.quantity) filter (where t.transaction_type = 'adjustment'), 0) as adjustment
    from public.factory_material_transactions t
    where (p_from is null or t.performed_at::date >= p_from) and (p_to is null or t.performed_at::date <= p_to)
    group by t.material_id, t.location_id
  )
  select m.id, m.material_code, m.material_name, l.id, l.name,
    coalesce(o.qty, 0), coalesce(p.received, 0), coalesce(p.issued, 0), coalesce(p.adjustment, 0),
    coalesce(o.qty, 0) + coalesce(p.received, 0) - coalesce(p.issued, 0) + coalesce(p.adjustment, 0)
  from public.factory_materials m
  cross join public.factory_locations l
  left join opening o on o.material_id = m.id and o.location_id = l.id
  left join period p on p.material_id = m.id and p.location_id = l.id
  where m.is_active = true and l.active = true and (o.material_id is not null or p.material_id is not null)
  order by m.material_name, l.name;
$$;

revoke all on function public.factory_inventory_costing(date,date) from public;
grant execute on function public.factory_inventory_costing(date,date) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'factory_material_stock') then
    execute 'alter publication supabase_realtime add table public.factory_material_stock';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'factory_material_transactions') then
    execute 'alter publication supabase_realtime add table public.factory_material_transactions';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Machine master + logs.
-- ---------------------------------------------------------------------
create table public.factory_machines (
  id uuid primary key default gen_random_uuid(),
  machine_code text not null unique,
  machine_name text not null,
  machine_type text,
  location_id uuid references public.factory_locations(id),
  status text not null default 'idle' check (status in ('running', 'idle', 'maintenance', 'breakdown')),
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now()
);

create table public.factory_machine_logs (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references public.factory_machines(id),
  job_id uuid references public.inhouse_production_requests(id),
  operator_id uuid references public.user_profiles(id),
  process text,
  shift text check (shift is null or shift in ('Day', 'Night', 'General')),
  start_time timestamptz not null default now(),
  end_time timestamptz,
  planned_quantity numeric,
  processed_quantity numeric,
  accepted_quantity numeric,
  rejected_quantity numeric,
  downtime_minutes numeric,
  downtime_reason text,
  breakdown_photos text[],
  notes text,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now()
);
create index factory_machine_logs_machine_idx on public.factory_machine_logs(machine_id);
create index factory_machine_logs_job_idx on public.factory_machine_logs(job_id);

alter table public.factory_machines enable row level security;
alter table public.factory_machine_logs enable row level security;
grant select on public.factory_machines to authenticated;
grant select on public.factory_machine_logs to authenticated;
create policy "factory_machines_select" on public.factory_machines for select using (
  staff_is_management() or staff_is_super_admin() or staff_is_factory_staff() or interior_is_org_wide()
);
create policy "factory_machine_logs_select" on public.factory_machine_logs for select using (
  staff_is_management() or staff_is_super_admin() or staff_is_factory_staff() or interior_is_org_wide()
);

create or replace function public.factory_upsert_machine(p_machine_id uuid, p_machine_code text, p_machine_name text, p_machine_type text default null, p_location_id uuid default null)
returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare v_id uuid;
begin
  perform public.staff_assert_operational();
  if not (public.staff_is_management() or public.staff_is_super_admin() or public.staff_is_factory_staff()) then
    raise exception 'You are not authorized to manage the machine master';
  end if;
  if p_machine_code is null or btrim(p_machine_code) = '' then raise exception 'Machine code is required'; end if;
  if p_machine_name is null or btrim(p_machine_name) = '' then raise exception 'Machine name is required'; end if;

  if p_machine_id is null then
    insert into public.factory_machines (machine_code, machine_name, machine_type, location_id, created_by)
    values (p_machine_code, p_machine_name, p_machine_type, p_location_id, auth.uid()) returning id into v_id;
  else
    update public.factory_machines set machine_code = p_machine_code, machine_name = p_machine_name, machine_type = p_machine_type, location_id = p_location_id
    where id = p_machine_id returning id into v_id;
    if v_id is null then raise exception 'Machine not found'; end if;
  end if;
  return v_id;
end;
$function$;

revoke all on function public.factory_upsert_machine(uuid,text,text,text,uuid) from public;
grant execute on function public.factory_upsert_machine(uuid,text,text,text,uuid) to authenticated;

create or replace function public.factory_start_machine_job(p_machine_id uuid, p_job_id uuid default null, p_process text default null, p_shift text default null, p_planned_quantity numeric default null)
returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare v_log_id uuid; v_machine public.factory_machines%rowtype;
begin
  perform public.staff_assert_operational();
  if not (public.staff_is_management() or public.staff_is_super_admin() or public.staff_is_factory_staff()) then
    raise exception 'You are not authorized to operate machines';
  end if;
  select * into v_machine from public.factory_machines where id = p_machine_id for update;
  if v_machine.id is null then raise exception 'Machine not found'; end if;
  if v_machine.status = 'running' then raise exception 'This machine already has a job running'; end if;

  insert into public.factory_machine_logs (machine_id, job_id, operator_id, process, shift, planned_quantity, created_by)
  values (p_machine_id, p_job_id, auth.uid(), p_process, p_shift, p_planned_quantity, auth.uid())
  returning id into v_log_id;

  update public.factory_machines set status = 'running' where id = p_machine_id;
  perform public.staff_write_audit('factory_machine_logs', v_log_id, 'START', null, jsonb_build_object('machine_id', p_machine_id, 'job_id', p_job_id), null);
  return v_log_id;
end;
$function$;

revoke all on function public.factory_start_machine_job(uuid,uuid,text,text,numeric) from public;
grant execute on function public.factory_start_machine_job(uuid,uuid,text,text,numeric) to authenticated;

create or replace function public.factory_stop_machine_job(
  p_log_id uuid, p_processed_quantity numeric default null, p_accepted_quantity numeric default null,
  p_rejected_quantity numeric default null, p_downtime_minutes numeric default null, p_downtime_reason text default null,
  p_breakdown_photos text[] default null, p_notes text default null, p_new_machine_status text default 'idle'
) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_log public.factory_machine_logs%rowtype;
begin
  perform public.staff_assert_operational();
  if p_new_machine_status not in ('idle', 'maintenance', 'breakdown') then raise exception 'Invalid machine status'; end if;
  select * into v_log from public.factory_machine_logs where id = p_log_id for update;
  if v_log.id is null then raise exception 'Machine log not found'; end if;
  if v_log.end_time is not null then raise exception 'This machine job is already stopped'; end if;
  if not (public.staff_is_management() or public.staff_is_super_admin() or public.staff_is_factory_staff()) then
    raise exception 'You are not authorized to operate machines';
  end if;
  if p_new_machine_status = 'breakdown' and (p_downtime_reason is null or btrim(p_downtime_reason) = '') then
    raise exception 'A breakdown reason is required';
  end if;

  update public.factory_machine_logs set
    end_time = now(), processed_quantity = p_processed_quantity, accepted_quantity = p_accepted_quantity,
    rejected_quantity = p_rejected_quantity, downtime_minutes = p_downtime_minutes, downtime_reason = p_downtime_reason,
    breakdown_photos = p_breakdown_photos, notes = p_notes
  where id = p_log_id;

  update public.factory_machines set status = p_new_machine_status where id = v_log.machine_id;
  perform public.staff_write_audit('factory_machine_logs', p_log_id, 'STOP', null, jsonb_build_object('processed_quantity', p_processed_quantity, 'new_status', p_new_machine_status), null);
end;
$function$;

revoke all on function public.factory_stop_machine_job(uuid,numeric,numeric,numeric,numeric,text,text[],text,text) from public;
grant execute on function public.factory_stop_machine_job(uuid,numeric,numeric,numeric,numeric,text,text[],text,text) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'factory_machines') then
    execute 'alter publication supabase_realtime add table public.factory_machines';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'factory_machine_logs') then
    execute 'alter publication supabase_realtime add table public.factory_machine_logs';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Transfer (reuses factory_locations for the "to" side too, plus
--    factory_finished_goods as the only valid item source -- "prevent
--    transfer above available Finished Goods" is enforced by checking the
--    running total already transferred against completed_quantity).
-- ---------------------------------------------------------------------
create table public.factory_transfers (
  id uuid primary key default gen_random_uuid(),
  transfer_number text not null unique,
  from_location_id uuid references public.factory_locations(id),
  to_type text not null check (to_type in ('godown', 'site', 'dispatch', 'other_location')),
  to_location_id uuid references public.factory_locations(id),
  to_description text,
  job_id uuid references public.inhouse_production_requests(id),
  project_id uuid references public.projects(id),
  vehicle_number text,
  transporter text,
  driver_contact text,
  dispatch_date date,
  expected_receipt_date date,
  dispatched_by uuid references public.user_profiles(id),
  dispatch_photos text[],
  received_by uuid references public.user_profiles(id),
  received_at timestamptz,
  pod_path text,
  receipt_photos text[],
  damage_shortage_notes text,
  status text not null default 'Draft' check (status in ('Draft', 'Dispatched', 'In Transit', 'Partially Received', 'Received', 'Disputed')),
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now()
);
create index factory_transfers_job_idx on public.factory_transfers(job_id);

create table public.factory_transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.factory_transfers(id) on delete cascade,
  finished_goods_id uuid references public.factory_finished_goods(id),
  description text not null,
  quantity numeric not null check (quantity > 0),
  package_count int
);

alter table public.factory_transfers enable row level security;
alter table public.factory_transfer_items enable row level security;
grant select on public.factory_transfers to authenticated;
grant select on public.factory_transfer_items to authenticated;
create policy "factory_transfers_select" on public.factory_transfers for select using (staff_factory_record_authorized(project_id));
create policy "factory_transfer_items_select" on public.factory_transfer_items for select using (
  exists (select 1 from public.factory_transfers ft where ft.id = transfer_id and staff_factory_record_authorized(ft.project_id))
);

create or replace function public.factory_create_transfer(
  p_from_location_id uuid, p_to_type text, p_to_location_id uuid, p_to_description text, p_job_id uuid, p_project_id uuid,
  p_vehicle_number text, p_transporter text, p_driver_contact text, p_dispatch_date date, p_expected_receipt_date date, p_items jsonb
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_transfer_id uuid; v_number text; v_item jsonb; v_already_transferred numeric; v_fg_qty numeric;
begin
  perform public.staff_assert_operational();
  if not public.staff_factory_record_authorized(p_project_id) then raise exception 'You are not authorized to create a transfer'; end if;
  if p_to_type not in ('godown', 'site', 'dispatch', 'other_location') then raise exception 'Invalid destination type'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then raise exception 'At least one item is required'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if (v_item->>'finished_goods_id') is not null then
      select completed_quantity into v_fg_qty from public.factory_finished_goods where id = (v_item->>'finished_goods_id')::uuid;
      if v_fg_qty is null then raise exception 'Finished goods record not found'; end if;
      select coalesce(sum(ti.quantity), 0) into v_already_transferred
        from public.factory_transfer_items ti join public.factory_transfers t on t.id = ti.transfer_id
        where ti.finished_goods_id = (v_item->>'finished_goods_id')::uuid and t.status <> 'Disputed';
      if v_already_transferred + coalesce((v_item->>'quantity')::numeric, 0) > v_fg_qty then
        raise exception 'Transfer quantity exceeds available Finished Goods (available %, already transferred %)', v_fg_qty, v_already_transferred;
      end if;
    end if;
  end loop;

  select 'TR-' || lpad((select count(*) + 1 from public.factory_transfers)::text, 6, '0') into v_number;
  insert into public.factory_transfers (
    transfer_number, from_location_id, to_type, to_location_id, to_description, job_id, project_id,
    vehicle_number, transporter, driver_contact, dispatch_date, expected_receipt_date, created_by
  ) values (
    v_number, p_from_location_id, p_to_type, p_to_location_id, p_to_description, p_job_id, p_project_id,
    p_vehicle_number, p_transporter, p_driver_contact, p_dispatch_date, p_expected_receipt_date, auth.uid()
  ) returning id into v_transfer_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.factory_transfer_items (transfer_id, finished_goods_id, description, quantity, package_count)
    values (v_transfer_id, nullif(v_item->>'finished_goods_id', '')::uuid, v_item->>'description', coalesce((v_item->>'quantity')::numeric, 0), nullif(v_item->>'package_count', '')::int);
  end loop;

  perform public.staff_write_audit('factory_transfers', v_transfer_id, 'CREATE', null, jsonb_build_object('to_type', p_to_type, 'project_id', p_project_id), null);
  return v_transfer_id;
end;
$function$;

revoke all on function public.factory_create_transfer(uuid,text,uuid,text,uuid,uuid,text,text,text,date,date,jsonb) from public;
grant execute on function public.factory_create_transfer(uuid,text,uuid,text,uuid,uuid,text,text,text,date,date,jsonb) to authenticated;

create or replace function public.factory_update_transfer_status(
  p_transfer_id uuid, p_status text, p_dispatch_photos text[] default null, p_receipt_photos text[] default null,
  p_pod_path text default null, p_damage_shortage_notes text default null
) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_tr public.factory_transfers%rowtype;
begin
  perform public.staff_assert_operational();
  if p_status not in ('Draft', 'Dispatched', 'In Transit', 'Partially Received', 'Received', 'Disputed') then raise exception 'Invalid status'; end if;
  select * into v_tr from public.factory_transfers where id = p_transfer_id for update;
  if v_tr.id is null then raise exception 'Transfer not found'; end if;
  if not public.staff_factory_record_authorized(v_tr.project_id) then raise exception 'You are not authorized to update this transfer'; end if;
  if p_status = 'Disputed' and (p_damage_shortage_notes is null or btrim(p_damage_shortage_notes) = '') then
    raise exception 'Damage/shortage notes are required to mark a transfer disputed';
  end if;

  update public.factory_transfers set
    status = p_status,
    dispatch_photos = coalesce(p_dispatch_photos, dispatch_photos),
    receipt_photos = coalesce(p_receipt_photos, receipt_photos),
    pod_path = coalesce(p_pod_path, pod_path),
    damage_shortage_notes = coalesce(p_damage_shortage_notes, damage_shortage_notes),
    dispatched_by = case when p_status = 'Dispatched' and dispatched_by is null then auth.uid() else dispatched_by end,
    received_by = case when p_status in ('Received', 'Partially Received') then auth.uid() else received_by end,
    received_at = case when p_status in ('Received', 'Partially Received') and received_at is null then now() else received_at end
  where id = p_transfer_id;

  perform public.staff_write_audit('factory_transfers', p_transfer_id, 'STATUS_CHANGE', jsonb_build_object('status', v_tr.status), jsonb_build_object('status', p_status), null);
end;
$function$;

revoke all on function public.factory_update_transfer_status(uuid,text,text[],text[],text,text) from public;
grant execute on function public.factory_update_transfer_status(uuid,text,text[],text[],text,text) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'factory_transfers') then
    execute 'alter publication supabase_realtime add table public.factory_transfers';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. Drawings -- reuses working_drawing_attachments for the file itself
--    (already generic, already RLS-fixed for Factory staff in v2_51);
--    this table tracks category/version/approval. Every upload is a NEW
--    row -- never update an existing one, so old approved versions are
--    never lost.
-- ---------------------------------------------------------------------
create table public.factory_drawings (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.inhouse_production_requests(id),
  category text not null check (category in (
    'Working Drawing', 'Production Drawing', 'Furniture Detail Drawing', 'Cutting Drawing', 'RCP',
    'Electrical Drawing', 'MEP Drawing', 'Material Specification', 'Job Card', 'Others'
  )),
  custom_category_name text,
  title text not null,
  storage_path text not null,
  version_number int not null default 1,
  parent_drawing_id uuid references public.factory_drawings(id),
  revision_reason text,
  status text not null default 'Draft' check (status in ('Draft', 'Submitted', 'Revision Required', 'Approved', 'Issued for Production')),
  approved_by uuid references public.user_profiles(id),
  approved_at timestamptz,
  approval_notes text,
  uploaded_by uuid not null references public.user_profiles(id),
  uploaded_at timestamptz not null default now()
);
create index factory_drawings_job_idx on public.factory_drawings(job_id);

alter table public.factory_drawings enable row level security;
grant select on public.factory_drawings to authenticated;
create policy "factory_drawings_select" on public.factory_drawings for select using (staff_factory_job_visible(job_id));

create or replace function public.factory_upload_drawing(
  p_job_id uuid, p_category text, p_title text, p_storage_path text, p_custom_category_name text default null,
  p_revision_reason text default null, p_parent_drawing_id uuid default null
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_job public.inhouse_production_requests%rowtype; v_id uuid; v_version int;
begin
  perform public.staff_assert_operational();
  select * into v_job from public.inhouse_production_requests where id = p_job_id;
  if v_job.id is null then raise exception 'Job not found'; end if;
  if not public.staff_factory_record_authorized(v_job.project_id) then raise exception 'You are not authorized to upload a drawing for this job'; end if;
  if p_category = 'Others' and (p_custom_category_name is null or btrim(p_custom_category_name) = '') then
    raise exception 'A custom category name is required when category is Others';
  end if;
  if p_storage_path is null or btrim(p_storage_path) = '' then raise exception 'A file is required'; end if;

  v_version := 1;
  if p_parent_drawing_id is not null then
    select version_number + 1 into v_version from public.factory_drawings where id = p_parent_drawing_id;
    if v_version is null then raise exception 'Parent drawing not found'; end if;
  end if;

  insert into public.factory_drawings (job_id, category, custom_category_name, title, storage_path, version_number, parent_drawing_id, revision_reason, uploaded_by)
  values (p_job_id, p_category, p_custom_category_name, p_title, p_storage_path, v_version, p_parent_drawing_id, p_revision_reason, auth.uid())
  returning id into v_id;

  perform public.staff_write_audit('factory_drawings', v_id, 'UPLOAD', null, jsonb_build_object('category', p_category, 'version', v_version, 'project_id', v_job.project_id), null);
  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id, 'Drawing uploaded: ' || p_title || ' (v' || v_version || ')', 'ડ્રોઈંગ અપલોડ: ' || p_title || ' (v' || v_version || ')');
  end if;
  return v_id;
end;
$function$;

revoke all on function public.factory_upload_drawing(uuid,text,text,text,text,text,uuid) from public;
grant execute on function public.factory_upload_drawing(uuid,text,text,text,text,text,uuid) to authenticated;

create or replace function public.factory_decide_drawing(p_drawing_id uuid, p_decision text, p_notes text default null) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_dr public.factory_drawings%rowtype; v_job public.inhouse_production_requests%rowtype;
begin
  perform public.staff_assert_operational();
  if p_decision not in ('Approved', 'Revision Required') then raise exception 'Invalid decision'; end if;
  select * into v_dr from public.factory_drawings where id = p_drawing_id for update;
  if v_dr.id is null then raise exception 'Drawing not found'; end if;
  select * into v_job from public.inhouse_production_requests where id = v_dr.job_id;
  if not (public.staff_is_management() or public.staff_is_super_admin() or (public.staff_is_factory_staff() and public.staff_is_dept_head()) or public.interior_is_org_wide()) then
    raise exception 'You are not authorized to approve/reject this drawing';
  end if;
  if p_decision = 'Revision Required' and (p_notes is null or btrim(p_notes) = '') then raise exception 'Notes are required when requesting a revision'; end if;

  update public.factory_drawings set status = p_decision, approved_by = auth.uid(), approved_at = now(), approval_notes = p_notes where id = p_drawing_id;
  perform public.staff_write_audit('factory_drawings', p_drawing_id, 'DECIDE', null, jsonb_build_object('decision', p_decision, 'project_id', v_job.project_id), null);
  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id, 'Drawing ' || p_decision || ': ' || v_dr.title, 'ડ્રોઈંગ ' || p_decision || ': ' || v_dr.title);
  end if;
end;
$function$;

revoke all on function public.factory_decide_drawing(uuid,text,text) from public;
grant execute on function public.factory_decide_drawing(uuid,text,text) to authenticated;

create or replace function public.factory_issue_drawing(p_drawing_id uuid) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_dr public.factory_drawings%rowtype; v_job public.inhouse_production_requests%rowtype;
begin
  perform public.staff_assert_operational();
  select * into v_dr from public.factory_drawings where id = p_drawing_id for update;
  if v_dr.id is null then raise exception 'Drawing not found'; end if;
  if v_dr.status <> 'Approved' then raise exception 'Only an Approved drawing can be issued for production'; end if;
  select * into v_job from public.inhouse_production_requests where id = v_dr.job_id;
  if not public.staff_factory_record_authorized(v_job.project_id) then raise exception 'You are not authorized to issue this drawing'; end if;

  update public.factory_drawings set status = 'Issued for Production' where id = p_drawing_id;
  perform public.staff_write_audit('factory_drawings', p_drawing_id, 'ISSUED', null, jsonb_build_object('project_id', v_job.project_id), null);
end;
$function$;

revoke all on function public.factory_issue_drawing(uuid) from public;
grant execute on function public.factory_issue_drawing(uuid) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'factory_drawings') then
    execute 'alter publication supabase_realtime add table public.factory_drawings';
  end if;
end $$;
