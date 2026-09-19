-- mvp_pilot_factory_phase2_v2_53
-- Factory dashboard Phase 2: Production Planning, BOM, Cutting Lists,
-- Worker Productivity, Shift Productivity, Wastage, Finished Goods,
-- Packing, Product Time Tracking, Mandatory Product Costing.
--
-- NOT included in this migration, and NOT marked OPEN on the dashboard --
-- confirmed via a real schema scan (no inventory/stock/godown/warehouse/
-- machine table exists anywhere in this database) that Raw Material
-- Availability, Material Issue, Machine Tracking, Transfer and Factory
-- Inventory Costing all fundamentally depend on a real inventory/location/
-- machine ledger that does not exist yet anywhere in the app (not even in
-- the Godown/Inventory department itself). Building a parallel fake ledger
-- just for Factory would violate "reuse the existing architecture, no
-- duplicate tables" and would produce numbers that don't reconcile with
-- the real inventory system whenever it's actually built. Drawings is also
-- deferred this round -- extending Interior's existing working_drawings
-- system for Factory linkage needs its own careful pass, not a rushed one
-- bolted onto this already-large migration.
--
-- All new tables use the SAME staff_factory_job_visible-style authorization
-- as v2_50/v2_51/v2_52, broadened to "any active Factory staff member" (not
-- just a job's named coordinator) for these shop-floor working documents --
-- unlike a Job Order's QC/rework/completion actions (which stay scoped to
-- the assigned coordinator/second-assignee, unchanged), a BOM or cutting
-- list is normally worked by whichever Factory employee is doing that task
-- today, not gated to two named people.

create or replace function public.staff_factory_record_authorized(p_project_id uuid) returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select public.staff_is_management() or public.staff_is_super_admin() or public.staff_is_factory_staff()
    or (p_project_id is not null and (public.interior_is_org_wide() or public.interior_is_project_member(p_project_id)));
$$;

-- ---------------------------------------------------------------------
-- 1. Production Planning.
-- ---------------------------------------------------------------------
create table public.factory_production_plans (
  id uuid primary key default gen_random_uuid(),
  plan_number text not null unique,
  job_id uuid references public.inhouse_production_requests(id),
  project_id uuid references public.projects(id),
  client text,
  product_item text not null,
  quantity numeric,
  priority text,
  planned_start_date date,
  planned_completion_date date,
  production_sequence int,
  assigned_team uuid references public.user_profiles(id),
  shift text check (shift is null or shift in ('Day', 'Night', 'General')),
  machine_requirement text,
  drawing_status text not null default 'Pending' check (drawing_status in ('Pending', 'Approved')),
  material_availability_status text not null default 'Pending' check (material_availability_status in ('Pending', 'Available', 'Shortage')),
  notes text,
  status text not null default 'Draft' check (status in ('Draft', 'Planned', 'Released', 'In Production', 'On Hold', 'Completed', 'Cancelled')),
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index factory_production_plans_job_id_idx on public.factory_production_plans(job_id);
create index factory_production_plans_project_id_idx on public.factory_production_plans(project_id);
create index factory_production_plans_status_idx on public.factory_production_plans(status);

alter table public.factory_production_plans enable row level security;
grant select on public.factory_production_plans to authenticated;
create policy "factory_production_plans_select" on public.factory_production_plans for select using (staff_factory_record_authorized(project_id));

create or replace function public.factory_save_production_plan(
  p_plan_id uuid, p_job_id uuid, p_project_id uuid, p_client text, p_product_item text, p_quantity numeric,
  p_priority text, p_planned_start_date date, p_planned_completion_date date, p_production_sequence int,
  p_assigned_team uuid, p_shift text, p_machine_requirement text, p_drawing_status text,
  p_material_availability_status text, p_notes text
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_plan_id uuid; v_plan_number text;
begin
  perform public.staff_assert_operational();
  if not public.staff_factory_record_authorized(p_project_id) then
    raise exception 'You are not authorized to create/edit a production plan for this project';
  end if;
  if p_product_item is null or btrim(p_product_item) = '' then raise exception 'Product/item is required'; end if;

  if p_plan_id is null then
    select 'PP-' || lpad((select count(*) + 1 from public.factory_production_plans)::text, 6, '0') into v_plan_number;
    insert into public.factory_production_plans (
      plan_number, job_id, project_id, client, product_item, quantity, priority, planned_start_date, planned_completion_date,
      production_sequence, assigned_team, shift, machine_requirement, drawing_status, material_availability_status, notes, created_by
    ) values (
      v_plan_number, p_job_id, p_project_id, p_client, p_product_item, p_quantity, p_priority, p_planned_start_date, p_planned_completion_date,
      p_production_sequence, p_assigned_team, p_shift, p_machine_requirement, coalesce(p_drawing_status, 'Pending'), coalesce(p_material_availability_status, 'Pending'), p_notes, auth.uid()
    ) returning id into v_plan_id;
  else
    update public.factory_production_plans set
      job_id = p_job_id, project_id = p_project_id, client = p_client, product_item = p_product_item, quantity = p_quantity,
      priority = p_priority, planned_start_date = p_planned_start_date, planned_completion_date = p_planned_completion_date,
      production_sequence = p_production_sequence, assigned_team = p_assigned_team, shift = p_shift,
      machine_requirement = p_machine_requirement, drawing_status = coalesce(p_drawing_status, drawing_status),
      material_availability_status = coalesce(p_material_availability_status, material_availability_status),
      notes = p_notes, updated_at = now()
    where id = p_plan_id
    returning id into v_plan_id;
    if v_plan_id is null then raise exception 'Production plan not found'; end if;
  end if;

  perform public.staff_write_audit('factory_production_plans', v_plan_id, 'SAVE', null,
    jsonb_build_object('product_item', p_product_item, 'project_id', p_project_id), null);
  return v_plan_id;
end;
$function$;

revoke all on function public.factory_save_production_plan(uuid,uuid,uuid,text,text,numeric,text,date,date,int,uuid,text,text,text,text,text) from public;
grant execute on function public.factory_save_production_plan(uuid,uuid,uuid,text,text,numeric,text,date,date,int,uuid,text,text,text,text,text) to authenticated;

create or replace function public.factory_update_production_plan_status(p_plan_id uuid, p_status text, p_reason text default null) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_plan public.factory_production_plans%rowtype;
begin
  perform public.staff_assert_operational();
  if p_status not in ('Draft', 'Planned', 'Released', 'In Production', 'On Hold', 'Completed', 'Cancelled') then
    raise exception 'Invalid status';
  end if;

  select * into v_plan from public.factory_production_plans where id = p_plan_id for update;
  if v_plan.id is null then raise exception 'Production plan not found'; end if;
  if not public.staff_factory_record_authorized(v_plan.project_id) then
    raise exception 'You are not authorized to update this production plan';
  end if;

  if p_status in ('Released', 'In Production') and v_plan.drawing_status <> 'Approved' then
    raise exception 'Cannot release production: drawings are not marked Approved for this plan';
  end if;
  if p_status in ('On Hold', 'Cancelled') and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'A reason is required to place this plan on hold or cancel it';
  end if;

  update public.factory_production_plans set status = p_status, notes = case when p_reason is not null then coalesce(notes || E'\n', '') || '[' || p_status || '] ' || p_reason else notes end, updated_at = now() where id = p_plan_id;

  perform public.staff_write_audit('factory_production_plans', p_plan_id, 'STATUS_CHANGE',
    jsonb_build_object('status', v_plan.status), jsonb_build_object('status', p_status, 'reason', p_reason), null);
end;
$function$;

revoke all on function public.factory_update_production_plan_status(uuid,text,text) from public;
grant execute on function public.factory_update_production_plan_status(uuid,text,text) to authenticated;

-- ---------------------------------------------------------------------
-- 2. BOM.
-- ---------------------------------------------------------------------
create table public.factory_boms (
  id uuid primary key default gen_random_uuid(),
  bom_number text not null unique,
  job_id uuid not null references public.inhouse_production_requests(id),
  status text not null default 'Draft' check (status in ('Draft', 'Submitted', 'Approved', 'Rejected', 'Revised')),
  submitted_by uuid references public.user_profiles(id),
  submitted_at timestamptz,
  approved_by uuid references public.user_profiles(id),
  approved_at timestamptz,
  rejection_reason text,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index factory_boms_job_id_idx on public.factory_boms(job_id);

create table public.factory_bom_items (
  id uuid primary key default gen_random_uuid(),
  bom_id uuid not null references public.factory_boms(id) on delete cascade,
  material_name text not null,
  material_code text,
  category text,
  specification text,
  unit text,
  required_quantity numeric not null check (required_quantity >= 0),
  available_quantity numeric not null default 0 check (available_quantity >= 0),
  reserved_quantity numeric not null default 0 check (reserved_quantity >= 0),
  shortage_quantity numeric generated always as (greatest(required_quantity - available_quantity - reserved_quantity, 0)) stored,
  wastage_allowance numeric,
  approved_substitute text,
  supplier_source text,
  rate numeric,
  amount numeric generated always as (required_quantity * coalesce(rate, 0)) stored,
  notes text
);
create index factory_bom_items_bom_id_idx on public.factory_bom_items(bom_id);

alter table public.factory_boms enable row level security;
alter table public.factory_bom_items enable row level security;
grant select on public.factory_boms to authenticated;
grant select on public.factory_bom_items to authenticated;

create policy "factory_boms_select" on public.factory_boms for select using (staff_factory_job_visible(job_id));
create policy "factory_bom_items_select" on public.factory_bom_items for select using (
  exists (select 1 from public.factory_boms b where b.id = bom_id and staff_factory_job_visible(b.job_id))
);

-- The only sanctioned read path for line items with cost data: callers
-- without costing authorization get every row back with rate/amount
-- nulled out server-side, not merely hidden by the frontend.
create or replace function public.factory_is_costing_authorized() returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_factory_staff() and public.staff_is_dept_head())
    or public.staff_current_role_code() in ('accounts_head', 'cfo');
$$;

create or replace function public.factory_list_bom_items(p_bom_id uuid)
returns table(
  id uuid, bom_id uuid, material_name text, material_code text, category text, specification text, unit text,
  required_quantity numeric, available_quantity numeric, reserved_quantity numeric, shortage_quantity numeric,
  wastage_allowance numeric, approved_substitute text, supplier_source text, rate numeric, amount numeric, notes text
)
language plpgsql security definer set search_path to 'public' as $function$
declare v_authorized boolean;
begin
  if not exists (select 1 from public.factory_boms b where b.id = p_bom_id and staff_factory_job_visible(b.job_id)) then
    raise exception 'BOM not found or not visible to you';
  end if;
  v_authorized := public.factory_is_costing_authorized();
  return query
    select i.id, i.bom_id, i.material_name, i.material_code, i.category, i.specification, i.unit,
      i.required_quantity, i.available_quantity, i.reserved_quantity, i.shortage_quantity, i.wastage_allowance,
      i.approved_substitute, i.supplier_source,
      case when v_authorized then i.rate else null end,
      case when v_authorized then i.amount else null end,
      i.notes
    from public.factory_bom_items i where i.bom_id = p_bom_id;
end;
$function$;

revoke all on function public.factory_list_bom_items(uuid) from public;
grant execute on function public.factory_list_bom_items(uuid) to authenticated;

create or replace function public.factory_save_bom(p_job_id uuid, p_bom_id uuid, p_items jsonb) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_job public.inhouse_production_requests%rowtype;
  v_bom_id uuid; v_bom_number text; v_item jsonb;
begin
  perform public.staff_assert_operational();
  select * into v_job from public.inhouse_production_requests where id = p_job_id;
  if v_job.id is null then raise exception 'Job not found'; end if;
  if not public.staff_factory_record_authorized(v_job.project_id) then
    raise exception 'You are not authorized to save a BOM for this job';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one BOM item is required';
  end if;

  if p_bom_id is null then
    select 'BOM-' || lpad((select count(*) + 1 from public.factory_boms)::text, 6, '0') into v_bom_number;
    insert into public.factory_boms (bom_number, job_id, created_by) values (v_bom_number, p_job_id, auth.uid()) returning id into v_bom_id;
  else
    select id into v_bom_id from public.factory_boms where id = p_bom_id and job_id = p_job_id;
    if v_bom_id is null then raise exception 'BOM not found for this job'; end if;
    if (select status from public.factory_boms where id = v_bom_id) = 'Approved' then
      raise exception 'An approved BOM cannot be edited directly -- it must be revised';
    end if;
    delete from public.factory_bom_items where bom_id = v_bom_id;
    update public.factory_boms set updated_at = now() where id = v_bom_id;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.factory_bom_items (
      bom_id, material_name, material_code, category, specification, unit, required_quantity,
      available_quantity, reserved_quantity, wastage_allowance, approved_substitute, supplier_source, rate, notes
    ) values (
      v_bom_id, v_item->>'material_name', v_item->>'material_code', v_item->>'category', v_item->>'specification', v_item->>'unit',
      coalesce((v_item->>'required_quantity')::numeric, 0),
      coalesce((v_item->>'available_quantity')::numeric, 0),
      coalesce((v_item->>'reserved_quantity')::numeric, 0),
      nullif(v_item->>'wastage_allowance', '')::numeric,
      v_item->>'approved_substitute', v_item->>'supplier_source', nullif(v_item->>'rate', '')::numeric, v_item->>'notes'
    );
  end loop;

  perform public.staff_write_audit('factory_boms', v_bom_id, 'SAVE', null, jsonb_build_object('job_id', p_job_id, 'item_count', jsonb_array_length(p_items), 'project_id', v_job.project_id), null);
  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id, 'BOM saved (' || jsonb_array_length(p_items) || ' items)', 'BOM સાચવ્યું (' || jsonb_array_length(p_items) || ' આઇટમ)');
  end if;
  return v_bom_id;
end;
$function$;

revoke all on function public.factory_save_bom(uuid,uuid,jsonb) from public;
grant execute on function public.factory_save_bom(uuid,uuid,jsonb) to authenticated;

create or replace function public.factory_submit_bom(p_bom_id uuid) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_bom public.factory_boms%rowtype; v_job public.inhouse_production_requests%rowtype;
begin
  perform public.staff_assert_operational();
  select * into v_bom from public.factory_boms where id = p_bom_id for update;
  if v_bom.id is null then raise exception 'BOM not found'; end if;
  select * into v_job from public.inhouse_production_requests where id = v_bom.job_id;
  if not public.staff_factory_record_authorized(v_job.project_id) then raise exception 'You are not authorized to submit this BOM'; end if;
  if v_bom.status not in ('Draft', 'Rejected') then raise exception 'Only a Draft or Rejected BOM can be submitted'; end if;
  update public.factory_boms set status = 'Submitted', submitted_by = auth.uid(), submitted_at = now() where id = p_bom_id;
  perform public.staff_write_audit('factory_boms', p_bom_id, 'SUBMIT', null, jsonb_build_object('project_id', v_job.project_id), null);
end;
$function$;

revoke all on function public.factory_submit_bom(uuid) from public;
grant execute on function public.factory_submit_bom(uuid) to authenticated;

create or replace function public.factory_decide_bom(p_bom_id uuid, p_decision text, p_reason text default null) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_bom public.factory_boms%rowtype; v_job public.inhouse_production_requests%rowtype;
begin
  perform public.staff_assert_operational();
  if p_decision not in ('Approved', 'Rejected') then raise exception 'Invalid decision'; end if;
  select * into v_bom from public.factory_boms where id = p_bom_id for update;
  if v_bom.id is null then raise exception 'BOM not found'; end if;
  select * into v_job from public.inhouse_production_requests where id = v_bom.job_id;
  if not (public.staff_is_management() or public.staff_is_super_admin() or (public.staff_is_factory_staff() and public.staff_is_dept_head())) then
    raise exception 'Only Management, Super Admin or the Factory Department Head may approve/reject a BOM';
  end if;
  if v_bom.status <> 'Submitted' then raise exception 'Only a Submitted BOM can be approved or rejected'; end if;
  if p_decision = 'Rejected' and (p_reason is null or btrim(p_reason) = '') then raise exception 'A rejection reason is required'; end if;

  update public.factory_boms set status = p_decision, approved_by = auth.uid(), approved_at = now(), rejection_reason = case when p_decision = 'Rejected' then p_reason else null end where id = p_bom_id;
  perform public.staff_write_audit('factory_boms', p_bom_id, 'DECIDE', null, jsonb_build_object('decision', p_decision, 'reason', p_reason, 'project_id', v_job.project_id), null);
  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id, 'BOM ' || p_decision || coalesce(': ' || p_reason, ''), 'BOM ' || p_decision || coalesce(': ' || p_reason, ''));
  end if;
end;
$function$;

revoke all on function public.factory_decide_bom(uuid,text,text) from public;
grant execute on function public.factory_decide_bom(uuid,text,text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Cutting Lists.
-- ---------------------------------------------------------------------
create table public.factory_cutting_lists (
  id uuid primary key default gen_random_uuid(),
  list_number text not null unique,
  job_id uuid not null references public.inhouse_production_requests(id),
  drawing_reference text,
  revision_number int not null default 1,
  parent_list_id uuid references public.factory_cutting_lists(id),
  status text not null default 'Draft' check (status in ('Draft', 'Approved')),
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now()
);
create index factory_cutting_lists_job_id_idx on public.factory_cutting_lists(job_id);

create table public.factory_cutting_list_items (
  id uuid primary key default gen_random_uuid(),
  cutting_list_id uuid not null references public.factory_cutting_lists(id) on delete cascade,
  part_name text not null,
  material text,
  length numeric,
  width numeric,
  thickness numeric,
  quantity numeric not null check (quantity > 0),
  edge_band_sides text,
  grain_direction text,
  machine_process text,
  remarks text,
  attachment_path text
);
create index factory_cutting_list_items_list_id_idx on public.factory_cutting_list_items(cutting_list_id);

alter table public.factory_cutting_lists enable row level security;
alter table public.factory_cutting_list_items enable row level security;
grant select on public.factory_cutting_lists to authenticated;
grant select on public.factory_cutting_list_items to authenticated;
create policy "factory_cutting_lists_select" on public.factory_cutting_lists for select using (staff_factory_job_visible(job_id));
create policy "factory_cutting_list_items_select" on public.factory_cutting_list_items for select using (
  exists (select 1 from public.factory_cutting_lists c where c.id = cutting_list_id and staff_factory_job_visible(c.job_id))
);

create or replace function public.factory_save_cutting_list(p_job_id uuid, p_drawing_reference text, p_items jsonb) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_job public.inhouse_production_requests%rowtype;
  v_list_id uuid; v_list_number text; v_item jsonb;
begin
  perform public.staff_assert_operational();
  select * into v_job from public.inhouse_production_requests where id = p_job_id;
  if v_job.id is null then raise exception 'Job not found'; end if;
  if not public.staff_factory_record_authorized(v_job.project_id) then raise exception 'You are not authorized to save a cutting list for this job'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then raise exception 'At least one cutting list item is required'; end if;

  select 'CL-' || lpad((select count(*) + 1 from public.factory_cutting_lists)::text, 6, '0') into v_list_number;
  insert into public.factory_cutting_lists (list_number, job_id, drawing_reference, created_by) values (v_list_number, p_job_id, p_drawing_reference, auth.uid()) returning id into v_list_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.factory_cutting_list_items (cutting_list_id, part_name, material, length, width, thickness, quantity, edge_band_sides, grain_direction, machine_process, remarks)
    values (
      v_list_id, v_item->>'part_name', v_item->>'material',
      nullif(v_item->>'length', '')::numeric, nullif(v_item->>'width', '')::numeric, nullif(v_item->>'thickness', '')::numeric,
      coalesce((v_item->>'quantity')::numeric, 1), v_item->>'edge_band_sides', v_item->>'grain_direction', v_item->>'machine_process', v_item->>'remarks'
    );
  end loop;

  perform public.staff_write_audit('factory_cutting_lists', v_list_id, 'CREATE', null, jsonb_build_object('job_id', p_job_id, 'item_count', jsonb_array_length(p_items), 'project_id', v_job.project_id), null);
  return v_list_id;
end;
$function$;

revoke all on function public.factory_save_cutting_list(uuid,text,jsonb) from public;
grant execute on function public.factory_save_cutting_list(uuid,text,jsonb) to authenticated;

create or replace function public.factory_copy_cutting_list_as_revision(p_list_id uuid) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_src public.factory_cutting_lists%rowtype;
  v_job public.inhouse_production_requests%rowtype;
  v_new_id uuid; v_new_number text;
begin
  perform public.staff_assert_operational();
  select * into v_src from public.factory_cutting_lists where id = p_list_id;
  if v_src.id is null then raise exception 'Cutting list not found'; end if;
  select * into v_job from public.inhouse_production_requests where id = v_src.job_id;
  if not public.staff_factory_record_authorized(v_job.project_id) then raise exception 'You are not authorized to revise this cutting list'; end if;

  select 'CL-' || lpad((select count(*) + 1 from public.factory_cutting_lists)::text, 6, '0') into v_new_number;
  insert into public.factory_cutting_lists (list_number, job_id, drawing_reference, revision_number, parent_list_id, created_by)
  values (v_new_number, v_src.job_id, v_src.drawing_reference, v_src.revision_number + 1, coalesce(v_src.parent_list_id, v_src.id), auth.uid())
  returning id into v_new_id;

  insert into public.factory_cutting_list_items (cutting_list_id, part_name, material, length, width, thickness, quantity, edge_band_sides, grain_direction, machine_process, remarks, attachment_path)
  select v_new_id, part_name, material, length, width, thickness, quantity, edge_band_sides, grain_direction, machine_process, remarks, attachment_path
  from public.factory_cutting_list_items where cutting_list_id = p_list_id;

  perform public.staff_write_audit('factory_cutting_lists', v_new_id, 'REVISION_CREATED', null, jsonb_build_object('parent_list_id', p_list_id, 'revision_number', v_src.revision_number + 1, 'project_id', v_job.project_id), null);
  return v_new_id;
end;
$function$;

revoke all on function public.factory_copy_cutting_list_as_revision(uuid) from public;
grant execute on function public.factory_copy_cutting_list_as_revision(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Shift dimension on stage updates (for Shift Productivity).
-- ---------------------------------------------------------------------
alter table public.production_stage_updates add column if not exists shift text check (shift is null or shift in ('Day', 'Night', 'General'));

-- ---------------------------------------------------------------------
-- 5. Wastage.
-- ---------------------------------------------------------------------
create table public.factory_wastage_records (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.inhouse_production_requests(id),
  material_name text not null,
  process_stage text,
  issued_quantity numeric,
  used_quantity numeric,
  returned_quantity numeric,
  wastage_quantity numeric not null check (wastage_quantity >= 0),
  reason text not null,
  reusable boolean not null default false,
  approved_by uuid references public.user_profiles(id),
  photos text[],
  notes text,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now()
);
create index factory_wastage_records_job_id_idx on public.factory_wastage_records(job_id);
alter table public.factory_wastage_records enable row level security;
grant select on public.factory_wastage_records to authenticated;
create policy "factory_wastage_records_select" on public.factory_wastage_records for select using (staff_factory_job_visible(job_id));

create or replace function public.factory_record_wastage(
  p_job_id uuid, p_material_name text, p_wastage_quantity numeric, p_reason text, p_process_stage text default null,
  p_issued_quantity numeric default null, p_used_quantity numeric default null, p_returned_quantity numeric default null,
  p_reusable boolean default false, p_photos text[] default null, p_notes text default null
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare v_job public.inhouse_production_requests%rowtype; v_id uuid;
begin
  perform public.staff_assert_operational();
  if p_material_name is null or btrim(p_material_name) = '' then raise exception 'Material name is required'; end if;
  if p_wastage_quantity is null or p_wastage_quantity < 0 then raise exception 'A valid wastage quantity is required'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'A wastage reason is required'; end if;

  select * into v_job from public.inhouse_production_requests where id = p_job_id;
  if v_job.id is null then raise exception 'Job not found'; end if;
  if not public.staff_factory_record_authorized(v_job.project_id) then raise exception 'You are not authorized to record wastage for this job'; end if;

  insert into public.factory_wastage_records (job_id, material_name, process_stage, issued_quantity, used_quantity, returned_quantity, wastage_quantity, reason, reusable, approved_by, photos, notes, created_by)
  values (p_job_id, p_material_name, p_process_stage, p_issued_quantity, p_used_quantity, p_returned_quantity, p_wastage_quantity, p_reason, p_reusable, case when public.staff_is_dept_head() or public.staff_is_management() then auth.uid() else null end, p_photos, p_notes, auth.uid())
  returning id into v_id;

  perform public.staff_write_audit('factory_wastage_records', v_id, 'RECORDED', null, jsonb_build_object('material_name', p_material_name, 'wastage_quantity', p_wastage_quantity, 'project_id', v_job.project_id), null);
  return v_id;
end;
$function$;

revoke all on function public.factory_record_wastage(uuid,text,numeric,text,text,numeric,numeric,numeric,boolean,text[],text) from public;
grant execute on function public.factory_record_wastage(uuid,text,numeric,text,text,numeric,numeric,numeric,boolean,text[],text) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Finished Goods.
-- ---------------------------------------------------------------------
create table public.factory_finished_goods (
  id uuid primary key default gen_random_uuid(),
  fg_number text not null unique,
  job_id uuid not null references public.inhouse_production_requests(id),
  quality_check_id uuid references public.factory_quality_checks(id),
  completed_quantity numeric not null check (completed_quantity > 0),
  storage_location text,
  barcode text,
  photos text[],
  notes text,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now()
);
create index factory_finished_goods_job_id_idx on public.factory_finished_goods(job_id);
alter table public.factory_finished_goods enable row level security;
grant select on public.factory_finished_goods to authenticated;
create policy "factory_finished_goods_select" on public.factory_finished_goods for select using (staff_factory_job_visible(job_id));

create or replace function public.factory_record_finished_goods(
  p_job_id uuid, p_completed_quantity numeric, p_storage_location text default null, p_barcode text default null,
  p_photos text[] default null, p_notes text default null
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare v_job public.inhouse_production_requests%rowtype; v_qc_id uuid; v_qc_result text; v_id uuid;
begin
  perform public.staff_assert_operational();
  if p_completed_quantity is null or p_completed_quantity <= 0 then raise exception 'Completed quantity is required'; end if;

  select * into v_job from public.inhouse_production_requests where id = p_job_id;
  if v_job.id is null then raise exception 'Job not found'; end if;
  if not public.staff_factory_record_authorized(v_job.project_id) then raise exception 'You are not authorized to record finished goods for this job'; end if;

  select id, result into v_qc_id, v_qc_result from public.factory_quality_checks where job_id = p_job_id and qc_stage = 'final' order by created_at desc limit 1;
  if v_qc_result is null or v_qc_result = 'fail' then
    raise exception 'A Final QC Pass or Conditional Pass is required before this item can enter Finished Goods';
  end if;

  insert into public.factory_finished_goods (fg_number, job_id, quality_check_id, completed_quantity, storage_location, barcode, photos, notes, created_by)
  values ('FG-' || lpad((select count(*) + 1 from public.factory_finished_goods)::text, 6, '0'), p_job_id, v_qc_id, p_completed_quantity, p_storage_location, p_barcode, p_photos, p_notes, auth.uid())
  returning id into v_id;

  perform public.staff_write_audit('factory_finished_goods', v_id, 'RECORDED', null, jsonb_build_object('completed_quantity', p_completed_quantity, 'project_id', v_job.project_id), null);
  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id, 'Finished goods recorded — qty ' || p_completed_quantity, 'તૈયાર માલ નોંધાયો — જથ્થો ' || p_completed_quantity);
  end if;
  return v_id;
end;
$function$;

revoke all on function public.factory_record_finished_goods(uuid,numeric,text,text,text[],text) from public;
grant execute on function public.factory_record_finished_goods(uuid,numeric,text,text,text[],text) to authenticated;

-- ---------------------------------------------------------------------
-- 7. Packing.
-- ---------------------------------------------------------------------
create table public.factory_packing_records (
  id uuid primary key default gen_random_uuid(),
  packing_number text not null unique,
  job_id uuid not null references public.inhouse_production_requests(id),
  finished_goods_id uuid references public.factory_finished_goods(id),
  packed_quantity numeric,
  package_count int,
  package_dimensions text,
  package_weight numeric,
  packing_material text,
  checklist jsonb,
  barcode text,
  photos text[],
  status text not null default 'Pending' check (status in ('Pending', 'In Progress', 'Packed', 'Ready for Transfer')),
  packed_by uuid references public.user_profiles(id),
  packed_at timestamptz,
  notes text,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now()
);
create index factory_packing_records_job_id_idx on public.factory_packing_records(job_id);
alter table public.factory_packing_records enable row level security;
grant select on public.factory_packing_records to authenticated;
create policy "factory_packing_records_select" on public.factory_packing_records for select using (staff_factory_job_visible(job_id));

create or replace function public.factory_save_packing(
  p_job_id uuid, p_packing_id uuid, p_finished_goods_id uuid, p_packed_quantity numeric, p_package_count int,
  p_package_dimensions text, p_package_weight numeric, p_packing_material text, p_checklist jsonb, p_barcode text,
  p_photos text[], p_status text, p_notes text
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare v_job public.inhouse_production_requests%rowtype; v_id uuid; v_number text;
begin
  perform public.staff_assert_operational();
  if p_status not in ('Pending', 'In Progress', 'Packed', 'Ready for Transfer') then raise exception 'Invalid status'; end if;

  select * into v_job from public.inhouse_production_requests where id = p_job_id;
  if v_job.id is null then raise exception 'Job not found'; end if;
  if not public.staff_factory_record_authorized(v_job.project_id) then raise exception 'You are not authorized to record packing for this job'; end if;

  if p_packing_id is null then
    select 'PK-' || lpad((select count(*) + 1 from public.factory_packing_records)::text, 6, '0') into v_number;
    insert into public.factory_packing_records (
      packing_number, job_id, finished_goods_id, packed_quantity, package_count, package_dimensions, package_weight,
      packing_material, checklist, barcode, photos, status, packed_by, packed_at, notes, created_by
    ) values (
      v_number, p_job_id, p_finished_goods_id, p_packed_quantity, p_package_count, p_package_dimensions, p_package_weight,
      p_packing_material, p_checklist, p_barcode, p_photos, p_status,
      case when p_status in ('Packed', 'Ready for Transfer') then auth.uid() else null end,
      case when p_status in ('Packed', 'Ready for Transfer') then now() else null end,
      p_notes, auth.uid()
    ) returning id into v_id;
  else
    update public.factory_packing_records set
      finished_goods_id = p_finished_goods_id, packed_quantity = p_packed_quantity, package_count = p_package_count,
      package_dimensions = p_package_dimensions, package_weight = p_package_weight, packing_material = p_packing_material,
      checklist = p_checklist, barcode = p_barcode, photos = p_photos, status = p_status,
      packed_by = case when p_status in ('Packed', 'Ready for Transfer') then auth.uid() else packed_by end,
      packed_at = case when p_status in ('Packed', 'Ready for Transfer') and packed_at is null then now() else packed_at end,
      notes = p_notes
    where id = p_packing_id and job_id = p_job_id
    returning id into v_id;
    if v_id is null then raise exception 'Packing record not found for this job'; end if;
  end if;

  perform public.staff_write_audit('factory_packing_records', v_id, 'SAVE', null, jsonb_build_object('status', p_status, 'project_id', v_job.project_id), null);
  return v_id;
end;
$function$;

revoke all on function public.factory_save_packing(uuid,uuid,uuid,numeric,int,text,numeric,text,jsonb,text,text[],text,text) from public;
grant execute on function public.factory_save_packing(uuid,uuid,uuid,numeric,int,text,numeric,text,jsonb,text,text[],text,text) to authenticated;

-- ---------------------------------------------------------------------
-- 8. Mandatory Product Costing -- restricted RLS (no rows at all for an
--    unauthorized viewer, not just hidden fields).
-- ---------------------------------------------------------------------
create table public.factory_product_costing (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.inhouse_production_requests(id),
  material_cost numeric not null default 0,
  hardware_cost numeric not null default 0,
  labour_cost numeric not null default 0,
  machine_cost numeric not null default 0,
  outsource_cost numeric not null default 0,
  packing_cost numeric not null default 0,
  transport_cost numeric not null default 0,
  other_cost numeric not null default 0,
  total_actual_cost numeric generated always as (material_cost + hardware_cost + labour_cost + machine_cost + outsource_cost + packing_cost + transport_cost + other_cost) stored,
  estimated_cost numeric,
  variance numeric generated always as ((material_cost + hardware_cost + labour_cost + machine_cost + outsource_cost + packing_cost + transport_cost + other_cost) - coalesce(estimated_cost, 0)) stored,
  approval_status text not null default 'Draft' check (approval_status in ('Draft', 'Submitted', 'Approved')),
  notes text,
  updated_by uuid references public.user_profiles(id),
  updated_at timestamptz not null default now()
);
alter table public.factory_product_costing enable row level security;
grant select on public.factory_product_costing to authenticated;
create policy "factory_product_costing_select" on public.factory_product_costing for select using (factory_is_costing_authorized());

create or replace function public.factory_save_product_costing(
  p_job_id uuid, p_material_cost numeric, p_hardware_cost numeric, p_labour_cost numeric, p_machine_cost numeric,
  p_outsource_cost numeric, p_packing_cost numeric, p_transport_cost numeric, p_other_cost numeric,
  p_estimated_cost numeric, p_notes text
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare v_id uuid;
begin
  perform public.staff_assert_operational();
  if not public.factory_is_costing_authorized() then
    raise exception 'You are not authorized to record product costing';
  end if;
  if not exists (select 1 from public.inhouse_production_requests where id = p_job_id) then raise exception 'Job not found'; end if;

  insert into public.factory_product_costing (job_id, material_cost, hardware_cost, labour_cost, machine_cost, outsource_cost, packing_cost, transport_cost, other_cost, estimated_cost, notes, updated_by)
  values (p_job_id, coalesce(p_material_cost,0), coalesce(p_hardware_cost,0), coalesce(p_labour_cost,0), coalesce(p_machine_cost,0), coalesce(p_outsource_cost,0), coalesce(p_packing_cost,0), coalesce(p_transport_cost,0), coalesce(p_other_cost,0), p_estimated_cost, p_notes, auth.uid())
  on conflict (job_id) do update set
    material_cost = excluded.material_cost, hardware_cost = excluded.hardware_cost, labour_cost = excluded.labour_cost,
    machine_cost = excluded.machine_cost, outsource_cost = excluded.outsource_cost, packing_cost = excluded.packing_cost,
    transport_cost = excluded.transport_cost, other_cost = excluded.other_cost, estimated_cost = excluded.estimated_cost,
    notes = excluded.notes, updated_by = auth.uid(), updated_at = now()
  returning id into v_id;

  perform public.staff_write_audit('factory_product_costing', v_id, 'SAVE', null, jsonb_build_object('job_id', p_job_id), null);
  return v_id;
end;
$function$;

revoke all on function public.factory_save_product_costing(uuid,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text) from public;
grant execute on function public.factory_save_product_costing(uuid,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text) to authenticated;

-- ---------------------------------------------------------------------
-- 9. Worker / Shift Productivity / Product Time Tracking -- computed,
--    read-only functions over EXISTING tables. No manual entry of any
--    calculated percentage is possible because there is no write path --
--    only these STABLE functions.
-- ---------------------------------------------------------------------
create or replace function public.factory_worker_productivity(p_from date default null, p_to date default null)
returns table(
  employee_id uuid, employee_name text, assigned_jobs bigint, completed_stages bigint,
  planned_minutes numeric, actual_minutes numeric, qc_accepted bigint, qc_rejected bigint, rework_count bigint
)
language sql stable security definer set search_path to 'public' as $$
  with my_stages as (
    select s.* from public.production_stage_updates s
    where (p_from is null or s.updated_at::date >= p_from) and (p_to is null or s.updated_at::date <= p_to)
  ),
  by_emp as (
    select assigned_to as employee_id, count(distinct job_id) as assigned_jobs,
      count(*) filter (where status = 'completed') as completed_stages,
      sum(extract(epoch from (coalesce(planned_end, actual_end) - coalesce(planned_start, actual_start))) / 60) filter (where planned_start is not null and planned_end is not null) as planned_minutes,
      sum(extract(epoch from (actual_end - actual_start)) / 60) filter (where actual_start is not null and actual_end is not null) as actual_minutes
    from my_stages where assigned_to is not null group by assigned_to
  ),
  qc_by_emp as (
    select checked_by as employee_id,
      count(*) filter (where result in ('pass','conditional_pass')) as qc_accepted,
      count(*) filter (where result = 'fail') as qc_rejected
    from public.factory_quality_checks where (p_from is null or created_at::date >= p_from) and (p_to is null or created_at::date <= p_to)
    group by checked_by
  ),
  rework_by_emp as (
    select assigned_to as employee_id, count(*) as rework_count from public.factory_rework_records
    where (p_from is null or created_at::date >= p_from) and (p_to is null or created_at::date <= p_to)
    group by assigned_to
  )
  select up.id, up.full_name, coalesce(e.assigned_jobs, 0), coalesce(e.completed_stages, 0),
    coalesce(e.planned_minutes, 0), coalesce(e.actual_minutes, 0), coalesce(q.qc_accepted, 0), coalesce(q.qc_rejected, 0), coalesce(r.rework_count, 0)
  from public.user_profiles up
  left join by_emp e on e.employee_id = up.id
  left join qc_by_emp q on q.employee_id = up.id
  left join rework_by_emp r on r.employee_id = up.id
  join public.departments d on d.id = up.department_id and d.code = 'FACTORY'
  where up.is_active = true and (e.employee_id is not null or q.employee_id is not null or r.employee_id is not null)
  order by up.full_name;
$$;

revoke all on function public.factory_worker_productivity(date,date) from public;
grant execute on function public.factory_worker_productivity(date,date) to authenticated;

create or replace function public.factory_shift_productivity(p_from date default null, p_to date default null)
returns table(
  shift_date date, shift text, jobs_touched bigint, stages_completed bigint,
  qc_pass bigint, qc_fail bigint, rework_count bigint, rejection_count bigint
)
language sql stable security definer set search_path to 'public' as $$
  with stage_rows as (
    select updated_at::date as d, coalesce(shift, 'General') as sh, job_id, status
    from public.production_stage_updates
    where (p_from is null or updated_at::date >= p_from) and (p_to is null or updated_at::date <= p_to)
  ),
  qc_rows as (
    select created_at::date as d, job_id, result from public.factory_quality_checks
    where (p_from is null or created_at::date >= p_from) and (p_to is null or created_at::date <= p_to)
  ),
  rework_rows as (
    select created_at::date as d from public.factory_rework_records
    where (p_from is null or created_at::date >= p_from) and (p_to is null or created_at::date <= p_to)
  ),
  rejection_rows as (
    select rejected_at::date as d from public.factory_rejection_records
    where (p_from is null or rejected_at::date >= p_from) and (p_to is null or rejected_at::date <= p_to)
  )
  select s.d, s.sh, count(distinct s.job_id), count(*) filter (where s.status = 'completed'),
    coalesce((select count(*) from qc_rows q where q.d = s.d and q.result in ('pass','conditional_pass')), 0),
    coalesce((select count(*) from qc_rows q where q.d = s.d and q.result = 'fail'), 0),
    coalesce((select count(*) from rework_rows r where r.d = s.d), 0),
    coalesce((select count(*) from rejection_rows rj where rj.d = s.d), 0)
  from stage_rows s
  group by s.d, s.sh
  order by s.d desc, s.sh;
$$;

revoke all on function public.factory_shift_productivity(date,date) from public;
grant execute on function public.factory_shift_productivity(date,date) to authenticated;

create or replace function public.factory_product_time_tracking(p_job_id uuid default null)
returns table(
  job_id uuid, job_order_number text, product_item text, stage text, planned_start date, planned_end date,
  actual_start timestamptz, actual_end timestamptz, planned_minutes numeric, actual_minutes numeric,
  delay_minutes numeric, started_by_name text, completed_by_name text, delay_reason text
)
language sql stable security definer set search_path to 'public' as $$
  select r.id, r.job_order_number, r.product_item, s.stage, s.planned_start, s.planned_end, s.actual_start, s.actual_end,
    case when s.planned_start is not null and s.planned_end is not null then extract(epoch from (s.planned_end::timestamptz - s.planned_start::timestamptz)) / 60 else null end,
    case when s.actual_start is not null and s.actual_end is not null then extract(epoch from (s.actual_end - s.actual_start)) / 60 else null end,
    case when s.planned_end is not null and s.actual_end is not null and s.actual_end::date > s.planned_end
      then extract(epoch from (s.actual_end - s.planned_end::timestamptz)) / 60 else 0 end,
    sb.full_name, cb.full_name, s.delay_reason
  from public.production_stage_updates s
  join public.inhouse_production_requests r on r.id = s.job_id
  left join public.user_profiles sb on sb.id = s.started_by
  left join public.user_profiles cb on cb.id = s.completed_by
  where staff_factory_job_visible(s.job_id) and (p_job_id is null or s.job_id = p_job_id)
  order by r.job_order_number, s.stage;
$$;

revoke all on function public.factory_product_time_tracking(uuid) from public;
grant execute on function public.factory_product_time_tracking(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 10. Realtime.
-- ---------------------------------------------------------------------
do $$
declare v_table text;
begin
  foreach v_table in array array['factory_production_plans','factory_boms','factory_bom_items','factory_cutting_lists','factory_cutting_list_items','factory_wastage_records','factory_finished_goods','factory_packing_records','factory_product_costing'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = v_table) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end $$;
