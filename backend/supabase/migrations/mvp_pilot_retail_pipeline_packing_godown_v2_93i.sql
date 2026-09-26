-- v2_93i -- Retail fulfilment pipeline, stage 1: Packing -> Godown handover/acceptance.
--
-- Confirmed live before this migration: no packing table, no godown handover table, no dispatch table, no delivery-proof/
-- installation table anywhere in the schema (retail_deliveries.stage and retail_procurement_requests.status contain the WORDS
-- 'DISPATCHED'/'GRN_QC' in their CHECK constraints, but nothing backs them). GODOWN_INV and DISPATCH are real, separate departments
-- (confirmed live, grouped under the same department_group_id) -- this migration is the first real workflow for GODOWN_INV.
--
-- Also introduces retail_status_history + retail_log_status_change here (moved earlier than originally planned) because Packing is
-- the first pipeline stage that needs "record every transition" -- every later migration in this pipeline reuses the same helper
-- rather than each stage inventing its own logging.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 0. department helpers -- same one-liner shape as retail_dept_id()/staff_is_factory_staff(), nothing new invented.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_godown_dept_id() returns uuid
language sql stable security definer set search_path = public as $$ select id from public.departments where code = 'GODOWN_INV'; $$;
create or replace function public.retail_dispatch_dept_id() returns uuid
language sql stable security definer set search_path = public as $$ select id from public.departments where code = 'DISPATCH'; $$;

create or replace function public.staff_is_godown_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_profiles up where up.id = auth.uid() and up.is_active and up.department_id = public.retail_godown_dept_id());
$$;
create or replace function public.staff_is_dispatch_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_profiles up where up.id = auth.uid() and up.is_active and up.department_id = public.retail_dispatch_dept_id());
$$;
revoke all on function public.retail_godown_dept_id() from public, anon;
revoke all on function public.retail_dispatch_dept_id() from public, anon;
revoke all on function public.staff_is_godown_staff() from public, anon;
revoke all on function public.staff_is_dispatch_staff() from public, anon;
grant execute on function public.retail_godown_dept_id() to authenticated;
grant execute on function public.retail_dispatch_dept_id() to authenticated;
grant execute on function public.staff_is_godown_staff() to authenticated;
grant execute on function public.staff_is_dispatch_staff() to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. retail_orders -- on_hold flag (a Godown rejection sets this; Dispatch checks it and refuses to proceed while it's true).
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.retail_orders add column if not exists on_hold boolean not null default false;
alter table public.retail_orders add column if not exists on_hold_reason text;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. retail_status_history -- append-only "one controlled status service" ledger. Every pipeline RPC from here on calls
--    retail_log_status_change() at its own transition; nothing writes to this table any other way (not even the direct-write RLS
--    escape hatch other tables get -- this one is RPC/internal-helper-only, full stop).
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_status_history (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  previous_status text,
  new_status text not null,
  changed_by uuid not null references public.user_profiles(id),
  changed_by_role text,
  department_id uuid references public.departments(id),
  notes text,
  proof_attachment_id uuid references public.staff_attachments(id),
  created_at timestamptz not null default now()
);
create index if not exists retail_status_history_entity_idx on public.retail_status_history (entity_type, entity_id, created_at desc);

create or replace function public.retail_log_status_change(
  p_entity_type text, p_entity_id uuid, p_previous text, p_new text, p_department_id uuid default null,
  p_notes text default null, p_proof_attachment_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.retail_status_history (entity_type, entity_id, previous_status, new_status, changed_by, changed_by_role, department_id, notes, proof_attachment_id)
  values (p_entity_type, p_entity_id, p_previous, p_new, auth.uid(), public.staff_current_role_code(), p_department_id, p_notes, p_proof_attachment_id);
end $$;
-- internal helper only -- called from inside other SECURITY DEFINER RPCs (which run as the table owner, so no grant is needed for
-- that), never exposed for a client to call directly and forge history for an entity it has no relation to.
revoke all on function public.retail_log_status_change(text, uuid, text, text, uuid, text, uuid) from public, anon, authenticated;

alter table public.retail_status_history enable row level security;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'retail_status_history') then
    alter publication supabase_realtime add table public.retail_status_history;
  end if;
end $$;
create policy retail_status_history_select on public.retail_status_history for select to authenticated using (
  staff_current_user_ok() and (changed_by = auth.uid() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))));
grant select on public.retail_status_history to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. retail_packing_records / retail_packing_items -- one row per order; "no photo -> cannot reach READY_FOR_GODOWN" is enforced
--    inside retail_verify_packing() itself (it checks staff_attachments directly), not left to the UI to remember.
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_packing_records (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.retail_orders(id),
  department_id uuid not null references public.departments(id),
  status text not null default 'AWAITING_PACKING' check (status in ('AWAITING_PACKING', 'IN_PROGRESS', 'PROOF_UPLOADED', 'VERIFIED', 'READY_FOR_GODOWN')),
  packed_by uuid references public.user_profiles(id),
  packed_at timestamptz,
  package_count integer,
  barcode_ref text,
  qc_status text not null default 'PENDING' check (qc_status in ('PENDING', 'PASSED', 'FAILED')),
  condition_notes text,
  missing_damaged_note text,
  partial_reason text,
  linked_task_id uuid references public.staff_tasks(id),
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_active boolean not null default true
);
create unique index if not exists retail_packing_records_order_uq on public.retail_packing_records (order_id);
create trigger trg_touch_updated_at before update on public.retail_packing_records for each row execute function public.staff_touch_updated_at();

create table if not exists public.retail_packing_items (
  id uuid primary key default gen_random_uuid(),
  packing_id uuid not null references public.retail_packing_records(id) on delete cascade,
  order_item_id uuid not null references public.retail_order_items(id),
  quantity_confirmed numeric(12,2),
  created_at timestamptz not null default now()
);
create unique index if not exists retail_packing_items_uq on public.retail_packing_items (packing_id, order_item_id);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. retail_godown_handovers -- Retail -> Godown. Multiple rows per order are allowed (a rejected handover can be resent after
--    fixing the issue), but at most one PENDING/ACCEPTED row per order at a time (partial unique index below).
-- ---------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.retail_godown_handovers (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.retail_orders(id),
  packing_id uuid not null references public.retail_packing_records(id),
  department_id uuid not null references public.departments(id), -- GODOWN_INV (receiving)
  origin_department_id uuid not null references public.departments(id), -- RETAIL
  godown_location_id uuid references public.locations(id),
  responsible_user_id uuid references public.user_profiles(id),
  expected_handover_at timestamptz,
  status text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'REJECTED')),
  accepted_by uuid references public.user_profiles(id),
  accepted_at timestamptz,
  packages_received integer,
  quantity_verified boolean,
  condition_verified boolean,
  rack_location text,
  notes text,
  rejection_reason text,
  rejection_missing_qty numeric(12,2),
  rejection_damaged_qty numeric(12,2),
  linked_task_id uuid references public.staff_tasks(id),
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_active boolean not null default true
);
create unique index if not exists retail_godown_handovers_open_uq on public.retail_godown_handovers (order_id) where status in ('PENDING', 'ACCEPTED');
create index if not exists retail_godown_handovers_order_idx on public.retail_godown_handovers (order_id);
create trigger trg_touch_updated_at before update on public.retail_godown_handovers for each row execute function public.staff_touch_updated_at();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['retail_packing_records', 'retail_packing_items', 'retail_godown_handovers'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

create policy retail_packing_records_select on public.retail_packing_records for select to authenticated using (
  staff_current_user_ok() and (
    created_by = auth.uid() or staff_is_godown_staff()
    or exists (select 1 from public.retail_orders o where o.id = retail_packing_records.order_id and (o.created_by = auth.uid() or retail_can_access_customer(o.customer_id)))
    or staff_has_global_oversight()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(department_id) or staff_dept_in_hod_scope(retail_godown_dept_id())))));
create policy retail_packing_records_write on public.retail_packing_records for all to authenticated
  using (staff_current_user_ok() and staff_has_global_oversight()) with check (staff_current_user_ok() and staff_has_global_oversight());
-- (writes normally happen only via the SECURITY DEFINER RPCs below; direct writes are management-only, same defense-in-depth
-- pattern retail_fulfilment_items already uses.)

create policy retail_packing_items_select on public.retail_packing_items for select to authenticated using (
  staff_current_user_ok() and exists (select 1 from public.retail_packing_records p where p.id = retail_packing_items.packing_id and (
    p.created_by = auth.uid() or staff_is_godown_staff()
    or exists (select 1 from public.retail_orders o where o.id = p.order_id and (o.created_by = auth.uid() or retail_can_access_customer(o.customer_id)))
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(p.department_id)))));
create policy retail_packing_items_write on public.retail_packing_items for all to authenticated
  using (staff_current_user_ok() and staff_has_global_oversight()) with check (staff_current_user_ok() and staff_has_global_oversight());

create policy retail_godown_handovers_select on public.retail_godown_handovers for select to authenticated using (
  staff_current_user_ok() and (
    created_by = auth.uid() or responsible_user_id = auth.uid() or staff_is_godown_staff()
    or exists (select 1 from public.retail_orders o where o.id = retail_godown_handovers.order_id and (o.created_by = auth.uid() or retail_can_access_customer(o.customer_id)))
    or staff_has_global_oversight()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(department_id) or staff_dept_in_hod_scope(origin_department_id)))));
create policy retail_godown_handovers_write on public.retail_godown_handovers for all to authenticated
  using (staff_current_user_ok() and staff_has_global_oversight()) with check (staff_current_user_ok() and staff_has_global_oversight());

grant select, insert, update, delete on public.retail_packing_records, public.retail_packing_items, public.retail_godown_handovers to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 6. RPCs
-- ---------------------------------------------------------------------------------------------------------------------------------

-- retail_start_packing -- idempotent create-or-fetch. Requires the order CONFIRMED and (by default) every fulfilment item READY;
-- p_partial_reason is the one explicit, logged escape hatch for starting packing before everything is ready (never silent).
create or replace function public.retail_start_packing(p_order_id uuid, p_partial_reason text default null)
returns public.retail_packing_records language plpgsql security definer set search_path = public as $$
declare v_order public.retail_orders; v_allowed boolean; v_row public.retail_packing_records; v_not_ready int; v_key text; v_task_id uuid; v_task_number text;
begin
  perform public.staff_assert_operational();
  select * into v_order from public.retail_orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;

  v_allowed := (coalesce(v_order.created_by = auth.uid(), false) or coalesce(public.retail_can_write_customer(v_order.customer_id), false)
    or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_order.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to start packing on this order'; end if;

  select * into v_row from public.retail_packing_records where order_id = p_order_id;
  if v_row.id is not null then return v_row; end if; -- idempotent

  if v_order.status <> 'CONFIRMED' then raise exception 'Order must be confirmed before packing can start'; end if;

  select count(*) into v_not_ready from public.retail_fulfilment_items where order_id = p_order_id and status <> 'READY';
  if v_not_ready > 0 and coalesce(btrim(p_partial_reason), '') = '' then
    raise exception 'Not every item is Ready yet (%) — provide a partial_reason to start packing anyway', v_not_ready;
  end if;

  insert into public.retail_packing_records (order_id, department_id, status, partial_reason, created_by)
  values (p_order_id, v_order.department_id, 'AWAITING_PACKING', nullif(btrim(p_partial_reason), ''), auth.uid())
  returning * into v_row;

  insert into public.retail_packing_items (packing_id, order_item_id, quantity_confirmed)
  select v_row.id, oi.id, 0 from public.retail_order_items oi where oi.order_id = p_order_id
  on conflict (packing_id, order_item_id) do nothing;

  v_key := 'retail_packing:' || v_row.id::text;
  select tk.task_id, tk.task_number into v_task_id, v_task_number from public.staff_create_task(
    'Pack order ' || v_order.order_number, 'Confirm items/quantities, QC, and upload a packing photo before sending to Godown.',
    'GENERAL_TASK', 'HIGH', 'photo', v_order.department_id, v_order.department_id, auth.uid(), current_date + 2, null,
    null, v_order.order_number, null, null, null, null) tk;
  update public.staff_tasks set system_key = v_key where id = v_task_id;
  update public.retail_packing_records set linked_task_id = v_task_id where id = v_row.id returning * into v_row;

  perform public.retail_log_status_change('retail_order', p_order_id, v_order.status, 'PACKING_STARTED', v_order.department_id, p_partial_reason);
  perform public.staff_write_audit('retail_packing', v_row.id, 'START', null, jsonb_build_object('order_id', p_order_id), v_order.department_id);
  return v_row;
end $$;

-- retail_verify_packing -- requires an already-uploaded packing photo (staff_attachments, entity_type='retail_packing',
-- purpose='proof') before it will move the record to READY_FOR_GODOWN. Also records the confirmed per-item quantities.
create or replace function public.retail_verify_packing(
  p_packing_id uuid, p_items jsonb default '[]'::jsonb, p_qc_status text default 'PASSED', p_package_count integer default null,
  p_condition_notes text default null, p_missing_damaged_note text default null)
returns public.retail_packing_records language plpgsql security definer set search_path = public as $$
declare v_row public.retail_packing_records; v_order public.retail_orders; v_allowed boolean; v_has_photo boolean; v_it jsonb; v_new_status text;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_packing_records where id = p_packing_id for update;
  if v_row.id is null then raise exception 'Packing record not found'; end if;
  select * into v_order from public.retail_orders where id = v_row.order_id;

  v_allowed := (coalesce(v_row.created_by = auth.uid(), false) or coalesce(public.retail_can_write_customer(v_order.customer_id), false)
    or coalesce(public.staff_has_global_oversight(), false)
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
  return v_row;
end $$;

-- retail_send_to_godown -- requires packing READY_FOR_GODOWN. Idempotent while a PENDING/ACCEPTED handover already exists for the
-- order (partial unique index); a NEW handover is only created after a prior one was REJECTED (a genuine resend).
create or replace function public.retail_send_to_godown(
  p_order_id uuid, p_godown_location_id uuid, p_responsible_user_id uuid, p_expected_handover_at timestamptz default null, p_notes text default null)
returns public.retail_godown_handovers language plpgsql security definer set search_path = public as $$
declare v_order public.retail_orders; v_packing public.retail_packing_records; v_allowed boolean; v_godown_dept uuid := public.retail_godown_dept_id();
  v_responsible_dept uuid; v_row public.retail_godown_handovers; v_key text; v_task_id uuid; v_task_number text;
begin
  perform public.staff_assert_operational();
  select * into v_order from public.retail_orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;

  v_allowed := (coalesce(v_order.created_by = auth.uid(), false) or coalesce(public.retail_can_write_customer(v_order.customer_id), false)
    or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_order.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to assign this order to Godown'; end if;

  select * into v_row from public.retail_godown_handovers where order_id = p_order_id and status in ('PENDING', 'ACCEPTED');
  if v_row.id is not null then return v_row; end if; -- idempotent while one is already open

  select * into v_packing from public.retail_packing_records where order_id = p_order_id;
  if v_packing.id is null or v_packing.status <> 'READY_FOR_GODOWN' then
    raise exception 'Packing must be verified (Ready for Godown) before assigning to Godown';
  end if;

  select department_id into v_responsible_dept from public.user_profiles where id = p_responsible_user_id and is_active = true;
  if v_responsible_dept is distinct from v_godown_dept then raise exception 'Responsible person must be an active Godown team member'; end if;

  insert into public.retail_godown_handovers (order_id, packing_id, department_id, origin_department_id, godown_location_id,
    responsible_user_id, expected_handover_at, notes, created_by)
  values (p_order_id, v_packing.id, v_godown_dept, v_order.department_id, p_godown_location_id, p_responsible_user_id, p_expected_handover_at, p_notes, auth.uid())
  returning * into v_row;

  v_key := 'retail_godown_handover:' || v_row.id::text;
  select tk.task_id, tk.task_number into v_task_id, v_task_number from public.staff_create_task(
    'Receive order ' || v_order.order_number || ' at Godown', coalesce(p_notes, 'Verify packages, condition and quantity; upload a receiving photo.'),
    'GENERAL_TASK', 'HIGH', 'photo', v_order.department_id, v_godown_dept, p_responsible_user_id,
    coalesce(p_expected_handover_at::date, current_date + 1), p_expected_handover_at::time, null, v_order.order_number, null, null, null, null) tk;
  update public.staff_tasks set system_key = v_key where id = v_task_id;
  update public.retail_godown_handovers set linked_task_id = v_task_id where id = v_row.id returning * into v_row;

  perform public.retail_log_status_change('retail_order', p_order_id, v_order.status, 'ASSIGNED_TO_GODOWN', v_godown_dept, p_notes);
  perform public.staff_write_audit('retail_godown_handover', v_row.id, 'CREATE', null, jsonb_build_object('order_id', p_order_id, 'responsible_user_id', p_responsible_user_id), v_godown_dept);
  perform public.staff_notify_assignment(p_responsible_user_id, 'retail_godown_handover', v_row.id,
    'Incoming handover: order ' || v_order.order_number, v_order.order_number || ' — ગોડાઉન હેન્ડઓવર આવી રહ્યું છે');
  return v_row;
end $$;

-- retail_godown_accept -- Godown staff only, requires a receiving photo already uploaded. Clears any prior on_hold from a rejection.
create or replace function public.retail_godown_accept(
  p_handover_id uuid, p_packages_received integer, p_quantity_verified boolean, p_condition_verified boolean,
  p_rack_location text default null, p_notes text default null)
returns public.retail_godown_handovers language plpgsql security definer set search_path = public as $$
declare v_row public.retail_godown_handovers; v_allowed boolean; v_has_photo boolean;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_godown_handovers where id = p_handover_id for update;
  if v_row.id is null then raise exception 'Handover not found'; end if;
  if v_row.status = 'ACCEPTED' then return v_row; end if; -- idempotent
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

  update public.retail_orders set on_hold = false, on_hold_reason = null where id = v_row.order_id and on_hold;

  perform public.retail_log_status_change('retail_order', v_row.order_id, 'ASSIGNED_TO_GODOWN', 'RECEIVED_AT_GODOWN', v_row.department_id, p_notes);
  perform public.staff_write_audit('retail_godown_handover', p_handover_id, 'ACCEPT', null,
    jsonb_build_object('packages_received', p_packages_received, 'rack_location', p_rack_location), v_row.department_id);
  return v_row;
end $$;

-- retail_godown_reject -- puts the order on_hold, notifies Retail + the return department + Management, creates a correction task.
create or replace function public.retail_godown_reject(
  p_handover_id uuid, p_reason text, p_missing_qty numeric default null, p_damaged_qty numeric default null,
  p_return_department_id uuid default null, p_responsible_user_id uuid default null)
returns public.retail_godown_handovers language plpgsql security definer set search_path = public as $$
declare v_row public.retail_godown_handovers; v_order public.retail_orders; v_allowed boolean; v_return_dept uuid; v_key text; v_task_id uuid; v_task_number text;
begin
  perform public.staff_assert_operational();
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A rejection reason is required'; end if;
  select * into v_row from public.retail_godown_handovers where id = p_handover_id for update;
  if v_row.id is null then raise exception 'Handover not found'; end if;
  if v_row.status = 'REJECTED' then return v_row; end if; -- idempotent
  if v_row.status <> 'PENDING' then raise exception 'This handover is not pending'; end if;
  select * into v_order from public.retail_orders where id = v_row.order_id;

  v_allowed := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_row.department_id), false))
    or (coalesce(public.staff_is_godown_staff(), false) and (coalesce(v_row.responsible_user_id = auth.uid(), false) or v_row.responsible_user_id is null)));
  if not v_allowed then raise exception 'Not authorized to reject this handover'; end if;

  v_return_dept := coalesce(p_return_department_id, v_row.origin_department_id);
  update public.retail_godown_handovers set status = 'REJECTED', rejection_reason = p_reason,
    rejection_missing_qty = p_missing_qty, rejection_damaged_qty = p_damaged_qty
  where id = p_handover_id returning * into v_row;

  update public.retail_orders set on_hold = true, on_hold_reason = p_reason where id = v_row.order_id;

  v_key := 'retail_godown_correction:' || v_row.id::text;
  select tk.task_id, tk.task_number into v_task_id, v_task_number from public.staff_create_task(
    'Correction needed: order ' || v_order.order_number, p_reason, 'GENERAL_TASK', 'URGENT', 'none',
    v_row.department_id, v_return_dept, coalesce(p_responsible_user_id, v_order.created_by), current_date + 1, null,
    null, v_order.order_number, null, null, null, null) tk;
  update public.staff_tasks set system_key = v_key where id = v_task_id;

  perform public.retail_log_status_change('retail_order', v_row.order_id, 'ASSIGNED_TO_GODOWN', 'GODOWN_REJECTED', v_row.department_id, p_reason);
  perform public.staff_write_audit('retail_godown_handover', p_handover_id, 'REJECT', null,
    jsonb_build_object('reason', p_reason, 'missing_qty', p_missing_qty, 'damaged_qty', p_damaged_qty), v_row.department_id);
  perform public.staff_notify_assignment(v_order.created_by, 'retail_godown_handover', p_handover_id,
    'Godown rejected order ' || v_order.order_number, v_order.order_number || ' — ગોડાઉન દ્વારા નકારાયું');
  perform public.staff_notify_dept_leadership('RETAIL', 'retail_godown_handover', p_handover_id,
    'Godown rejected order ' || v_order.order_number, v_order.order_number || ' — ગોડાઉન દ્વારા નકારાયું');
  return v_row;
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'retail_start_packing(uuid, text)',
    'retail_verify_packing(uuid, jsonb, text, integer, text, text)',
    'retail_send_to_godown(uuid, uuid, uuid, timestamptz, text)',
    'retail_godown_accept(uuid, integer, boolean, boolean, text, text)',
    'retail_godown_reject(uuid, text, numeric, numeric, uuid, uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
