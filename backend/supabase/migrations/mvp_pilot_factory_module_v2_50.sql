-- mvp_pilot_factory_module_v2_50
-- Factory/Manufacturing module: job-card + production-stage tracking + QC +
-- rework, built on the EXISTING inhouse_production_requests table (already
-- has status/qc_status/rework_status/packing_status/dispatch_readiness/
-- delivery_status/installation_status columns from its original design) --
-- extended, not duplicated with a parallel factory_jobs table.
--
-- Real gaps found during inspection (not assumed) and fixed here:
--
-- 1. interior_sync_profile_from_user_profile() (built earlier this session
--    for Interior) only auto-creates an Interior `profiles` row for
--    department_id = INTERIOR. inhouse_production_requests.
--    assigned_factory_coordinator/current_responsible_person are FK'd to
--    `profiles(id)` (confirmed via a full FK scan earlier this session),
--    and the existing "Submit to Factory" form's coordinator dropdown is
--    fed by listInteriorPeople() (reads `profiles`) -- so a Factory
--    department employee could NEVER appear in that dropdown at all,
--    exactly the same root-cause bug the Interior round fixed, just never
--    extended to Factory. Fixed by broadening the trigger's department
--    condition.
--
-- 2. inhouse_production_requests_scoped RLS was `interior_is_org_wide() OR
--    interior_is_project_member(project_id)` -- interior_is_org_wide()
--    checks staff_dept_in_hod_scope(INTERIOR's id specifically), which is
--    false for a Factory Department Head (their HOD scope doesn't include
--    Interior). Only Management/Super Admin could ever see a Factory job;
--    a real Factory coordinator/dept head could not, despite
--    FactoryJobOrders.jsx's own comment claiming otherwise. Fixed with a
--    genuine Factory-staff RLS branch.
--
-- 3. submitToFactory() (interiorApi.js) was a raw, frontend-trusted
--    multi-step insert (job row, then a separate purchase_requests status
--    update, then a separate JS-side audit log call) with NO linked task
--    -- Factory never got a Today's Tasks entry, no notification, no
--    conversation thread; "Interior sends work to Factory" was a
--    completely disconnected write with no cross-department visibility at
--    all. Replaced with a single transactional RPC that also creates the
--    actual cross-department task (reusing staff_create_task -- Bridge,
--    Primary+Second Assignee, project/site, notifications, realtime, and
--    the existing Task Conversation feature all come for free) and stores
--    its id as the one linked record, per the explicit "one linked
--    record/task ID, no disconnected duplicates" requirement.

-- ---------------------------------------------------------------------
-- 1. Fix the employee-sync trigger to also cover Factory.
-- ---------------------------------------------------------------------
create or replace function public.interior_sync_profile_from_user_profile()
returns trigger
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_interior_dept uuid;
  v_factory_dept uuid;
  v_dept_label text;
  v_role_code text;
  v_mapped_role text;
begin
  select id into v_interior_dept from public.departments where code = 'INTERIOR';
  select id into v_factory_dept from public.departments where code = 'FACTORY';

  if new.department_id = v_interior_dept then
    v_dept_label := 'Interior';
  elsif new.department_id = v_factory_dept then
    v_dept_label := 'Factory';
  else
    return new;
  end if;

  select r.code into v_role_code from public.roles r where r.id = new.role_id;
  v_mapped_role := case
    when v_role_code = 'management' then 'director'
    when v_role_code = 'dept_head' then 'head'
    else 'employee'
  end;

  insert into public.profiles (auth_id, name, role, department, active)
  values (new.id, new.full_name, v_mapped_role, v_dept_label, new.is_active)
  on conflict (auth_id) do update set
    name = excluded.name,
    active = excluded.active,
    department = excluded.department,
    role = case
      when excluded.role in ('director', 'head') then excluded.role
      when public.profiles.role = 'employee' then excluded.role
      else public.profiles.role
    end;

  return new;
end;
$function$;

-- Backfill: any existing Factory-department user_profiles row with no
-- matching profiles row yet (reported as a row count, not silently
-- applied — matches the established convention from the Interior round).
do $$
declare v_count int;
begin
  insert into public.profiles (auth_id, name, role, department, active)
  select up.id, up.full_name,
    case when r.code = 'management' then 'director' when r.code = 'dept_head' then 'head' else 'employee' end,
    'Factory', up.is_active
  from public.user_profiles up
  join public.roles r on r.id = up.role_id
  join public.departments d on d.id = up.department_id
  where d.code = 'FACTORY' and not exists (select 1 from public.profiles p where p.auth_id = up.id);
  get diagnostics v_count = row_count;
  raise notice 'Factory profiles backfilled: %', v_count;
end $$;

-- ---------------------------------------------------------------------
-- 2. Job-card / stage-tracking columns on the existing job table.
-- ---------------------------------------------------------------------
alter table public.inhouse_production_requests
  add column if not exists current_stage text,
  add column if not exists completion_percentage integer not null default 0,
  add column if not exists linked_task_id uuid references public.staff_tasks(id),
  add column if not exists second_assignee_coordinator uuid references public.profiles(id);

alter table public.inhouse_production_requests
  drop constraint if exists inhouse_production_requests_completion_pct_check;
alter table public.inhouse_production_requests
  add constraint inhouse_production_requests_completion_pct_check check (completion_percentage between 0 and 100);

create index if not exists inhouse_production_requests_coordinator_idx on public.inhouse_production_requests(assigned_factory_coordinator);
create index if not exists inhouse_production_requests_linked_task_idx on public.inhouse_production_requests(linked_task_id);
create index if not exists inhouse_production_requests_status_idx on public.inhouse_production_requests(status);

-- ---------------------------------------------------------------------
-- 3. Production stage tracking (one current-state row per stage per job;
--    full history of every touch is already covered by
--    interior_pilot_audit_log, not duplicated into a second history table).
-- ---------------------------------------------------------------------
create table public.production_stage_updates (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.inhouse_production_requests(id),
  stage text not null check (stage in (
    'Planning','Drawing Pending','Drawing Approved','Material Pending','Material Available',
    'Cutting','Edge Banding','CNC','Carpentry/Assembly','Polishing/Painting','Hardware Fitting',
    'Final Assembly','QC','Packing','Ready for Dispatch','Dispatched','Installed/Completed'
  )),
  status text not null default 'pending' check (status in ('pending','in_progress','completed','skipped','on_hold')),
  assigned_to uuid references public.user_profiles(id),
  planned_start date,
  planned_end date,
  actual_start timestamptz,
  actual_end timestamptz,
  quantity_completed numeric,
  quantity_pending numeric,
  notes text,
  delay_reason text,
  started_by uuid references public.user_profiles(id),
  completed_by uuid references public.user_profiles(id),
  time_spent_minutes integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, stage)
);

create index production_stage_updates_job_id_idx on public.production_stage_updates(job_id);

-- ---------------------------------------------------------------------
-- 4. Quality control.
-- ---------------------------------------------------------------------
create table public.factory_quality_checks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.inhouse_production_requests(id),
  dimensions_checked boolean not null default false,
  material_checked boolean not null default false,
  finish_checked boolean not null default false,
  hardware_checked boolean not null default false,
  drawing_matched boolean not null default false,
  quantity_checked boolean not null default false,
  result text not null check (result in ('pass','fail','conditional_pass')),
  defect_reason text,
  rework_required boolean not null default false,
  assigned_rework_person uuid references public.user_profiles(id),
  recheck_date date,
  checked_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now()
);

create index factory_quality_checks_job_id_idx on public.factory_quality_checks(job_id);

-- ---------------------------------------------------------------------
-- 5. Rework.
-- ---------------------------------------------------------------------
create table public.factory_rework_records (
  id uuid primary key default gen_random_uuid(),
  rework_number text not null unique,
  quality_check_id uuid references public.factory_quality_checks(id),
  job_id uuid not null references public.inhouse_production_requests(id),
  defect_details text not null,
  responsible_stage text,
  assigned_to uuid references public.user_profiles(id),
  required_completion_date date,
  corrective_action text,
  recheck_result text,
  is_closed boolean not null default false,
  closed_by uuid references public.user_profiles(id),
  closed_at timestamptz,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now()
);

create index factory_rework_records_job_id_idx on public.factory_rework_records(job_id);

-- ---------------------------------------------------------------------
-- 6. Access helpers + RLS.
-- ---------------------------------------------------------------------
create or replace function public.staff_is_factory_staff() returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.user_profiles up join public.departments d on d.id = up.department_id
    where up.id = auth.uid() and up.is_active = true and d.code = 'FACTORY'
  );
$$;

create or replace function public.staff_factory_job_visible(p_job_id uuid) returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.inhouse_production_requests r
    where r.id = p_job_id
      and (
        public.interior_is_org_wide() or public.interior_is_project_member(r.project_id)
        or (public.staff_is_factory_staff() and (
          r.assigned_factory_coordinator = (select id from public.profiles where auth_id = auth.uid())
          or r.second_assignee_coordinator = (select id from public.profiles where auth_id = auth.uid())
          or r.current_responsible_person = (select id from public.profiles where auth_id = auth.uid())
          or public.staff_is_dept_head()
        ))
      )
  );
$$;

-- Widen the existing policy (additive OR-branch only — nothing already
-- granted is removed) so Factory staff can actually reach jobs assigned to
-- them, or all Factory jobs for a Factory Department Head.
drop policy if exists "inhouse_production_requests_scoped" on public.inhouse_production_requests;
create policy "inhouse_production_requests_scoped" on public.inhouse_production_requests for all using (
  interior_is_org_wide() or interior_is_project_member(project_id)
  or (staff_is_factory_staff() and (
    assigned_factory_coordinator = (select id from public.profiles where auth_id = auth.uid())
    or second_assignee_coordinator = (select id from public.profiles where auth_id = auth.uid())
    or current_responsible_person = (select id from public.profiles where auth_id = auth.uid())
    or staff_is_dept_head()
  ))
);

alter table public.production_stage_updates enable row level security;
alter table public.factory_quality_checks enable row level security;
alter table public.factory_rework_records enable row level security;

grant select on public.production_stage_updates to authenticated;
grant select on public.factory_quality_checks to authenticated;
grant select on public.factory_rework_records to authenticated;

create policy "production_stage_updates_select" on public.production_stage_updates for select using (staff_factory_job_visible(job_id));
create policy "factory_quality_checks_select" on public.factory_quality_checks for select using (staff_factory_job_visible(job_id));
create policy "factory_rework_records_select" on public.factory_rework_records for select using (staff_factory_job_visible(job_id));

-- ---------------------------------------------------------------------
-- 7. staff_submit_to_factory — the ONE linked-record creation path.
--    p_assigned_factory_coordinator / p_second_assignee are `profiles.id`
--    (Interior-space), matching the existing form and the column's own FK
--    — resolved to their `user_profiles.id` (auth-space) internally before
--    calling staff_create_task, which needs the auth-space id.
-- ---------------------------------------------------------------------
create or replace function public.staff_submit_to_factory(
  p_project_id uuid, p_purchase_request_id uuid, p_factory_location_id uuid, p_product_item text,
  p_design_version_id uuid, p_working_drawing_version_id uuid, p_bom_reference text,
  p_quantity numeric, p_unit text, p_required_completion_date date, p_delivery_site_date date,
  p_assigned_factory_coordinator uuid, p_second_assignee uuid default null,
  p_special_instructions text default null, p_quality_requirements text default null,
  p_finishing_requirements text default null, p_packing_requirements text default null,
  p_installation_requirement text default null, p_production_department text default null
)
returns table(job_id uuid, job_order_number text, task_id uuid, task_number text, already_submitted boolean)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_existing record;
  v_job_id uuid; v_job_order_number text;
  v_factory_dept uuid; v_interior_dept uuid;
  v_task record;
  v_project_code text; v_project_customer text;
  v_coordinator_auth uuid; v_second_auth uuid; v_caller_profile uuid;
begin
  perform public.staff_assert_operational();
  if not (public.interior_is_org_wide() or public.interior_is_project_member(p_project_id)) then
    raise exception 'You are not authorized to submit work to Factory for this project';
  end if;
  if p_assigned_factory_coordinator is null then
    raise exception 'An Assigned Factory Coordinator is required';
  end if;

  -- inhouse_production_requests.submitted_by is FK'd to profiles(id)
  -- (Interior-space), not auth.uid() -- resolve the caller's own profiles
  -- row rather than inserting the raw auth-space id.
  select id into v_caller_profile from public.profiles where auth_id = auth.uid();
  if v_caller_profile is null then
    raise exception 'Your staff profile could not be resolved -- please contact an administrator';
  end if;

  select * into v_existing from public.inhouse_production_requests where purchase_request_id = p_purchase_request_id;
  if v_existing.id is not null then
    return query select v_existing.id, v_existing.job_order_number, v_existing.linked_task_id,
      (select st.task_number from public.staff_tasks st where st.id = v_existing.linked_task_id), true;
    return;
  end if;

  select id into v_factory_dept from public.departments where code = 'FACTORY';
  select id into v_interior_dept from public.departments where code = 'INTERIOR';
  select project_code, customer into v_project_code, v_project_customer from public.projects where id = p_project_id;
  if v_project_code is null then raise exception 'Invalid project'; end if;

  select auth_id into v_coordinator_auth from public.profiles where id = p_assigned_factory_coordinator;
  if v_coordinator_auth is null then
    raise exception 'The selected Factory Coordinator has no linked staff login and cannot be assigned a task';
  end if;
  if p_second_assignee is not null then
    select auth_id into v_second_auth from public.profiles where id = p_second_assignee;
    if v_second_auth is null then
      raise exception 'The selected Second Assignee has no linked staff login and cannot be assigned a task';
    end if;
  end if;

  select 'JO-' || lpad((select count(*) + 1 from public.inhouse_production_requests)::text, 6, '0') into v_job_order_number;

  insert into public.inhouse_production_requests (
    project_id, purchase_request_id, factory_location_id, product_item, design_version_id, working_drawing_version_id,
    bom_reference, quantity, unit, required_completion_date, delivery_site_date,
    assigned_factory_coordinator, second_assignee_coordinator,
    special_instructions, quality_requirements, finishing_requirements, packing_requirements, installation_requirement,
    production_department, job_order_number, status, current_stage, completion_percentage, submitted_by, submitted_at
  ) values (
    p_project_id, p_purchase_request_id, p_factory_location_id, p_product_item, p_design_version_id, p_working_drawing_version_id,
    p_bom_reference, p_quantity, p_unit, p_required_completion_date, p_delivery_site_date,
    p_assigned_factory_coordinator, p_second_assignee,
    p_special_instructions, p_quality_requirements, p_finishing_requirements, p_packing_requirements, p_installation_requirement,
    p_production_department, v_job_order_number, 'Submitted to Factory', 'Planning', 0, v_caller_profile, now()
  ) returning id into v_job_id;

  update public.purchase_requests set status = 'In-house Submitted' where id = p_purchase_request_id;

  -- One linked record: the real cross-department task. staff_create_task
  -- already handles the Bridge, Primary+Second Assignee, project/site
  -- linkage, notifications and realtime — nothing duplicated here.
  select * into v_task from public.staff_create_task(
    'Factory Production: ' || p_product_item,
    coalesce(p_special_instructions, 'Interior production requirement — ' || v_project_code || ' — ' || v_project_customer),
    'FACTORY_REQUEST', 'NORMAL', 'none', v_interior_dept, v_factory_dept, v_coordinator_auth,
    p_required_completion_date, null, null, v_job_order_number, coalesce(p_bom_reference, ''), coalesce(p_quantity::text, ''),
    v_second_auth, p_project_id
  );

  update public.inhouse_production_requests set linked_task_id = v_task.task_id where id = v_job_id;

  perform public.staff_write_audit('inhouse_production_requests', v_job_id, 'SUBMIT_TO_FACTORY',
    null, jsonb_build_object('job_order_number', v_job_order_number, 'task_id', v_task.task_id, 'project_id', p_project_id, 'coordinator', p_assigned_factory_coordinator), v_factory_dept);

  return query select v_job_id, v_job_order_number, v_task.task_id, v_task.task_number, false;
end;
$function$;

revoke all on function public.staff_submit_to_factory(uuid,uuid,uuid,text,uuid,uuid,text,numeric,text,date,date,uuid,uuid,text,text,text,text,text,text) from public;
grant execute on function public.staff_submit_to_factory(uuid,uuid,uuid,text,uuid,uuid,text,numeric,text,date,date,uuid,uuid,text,text,text,text,text,text) to authenticated;

-- ---------------------------------------------------------------------
-- 8. Stage update / QC / rework RPCs.
-- ---------------------------------------------------------------------
create or replace function public.factory_update_stage(
  p_job_id uuid, p_stage text, p_status text, p_assigned_to uuid default null,
  p_quantity_completed numeric default null, p_quantity_pending numeric default null,
  p_notes text default null, p_delay_reason text default null,
  p_planned_start date default null, p_planned_end date default null
) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_job public.inhouse_production_requests%rowtype;
  v_existing public.production_stage_updates%rowtype;
  v_actor_name text; v_my_profile uuid;
  v_done_stages int; v_completion int;
begin
  perform public.staff_assert_operational();
  if p_status not in ('pending','in_progress','completed','skipped','on_hold') then
    raise exception 'Invalid stage status';
  end if;

  select * into v_job from public.inhouse_production_requests where id = p_job_id for update;
  if v_job.id is null then raise exception 'Job not found'; end if;
  select id into v_my_profile from public.profiles where auth_id = auth.uid();

  if not (
    public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_factory_staff() and (
      v_job.assigned_factory_coordinator = v_my_profile or v_job.second_assignee_coordinator = v_my_profile
      or v_job.current_responsible_person = v_my_profile or public.staff_is_dept_head()
    ))
  ) then
    raise exception 'You are not authorized to update this job''s production stage';
  end if;

  select * into v_existing from public.production_stage_updates where job_id = p_job_id and stage = p_stage;

  insert into public.production_stage_updates (
    job_id, stage, status, assigned_to, planned_start, planned_end,
    actual_start, actual_end, quantity_completed, quantity_pending, notes, delay_reason,
    started_by, completed_by, updated_at
  ) values (
    p_job_id, p_stage, p_status, p_assigned_to, p_planned_start, p_planned_end,
    case when p_status = 'in_progress' and v_existing.actual_start is null then now() else v_existing.actual_start end,
    case when p_status = 'completed' then now() else v_existing.actual_end end,
    p_quantity_completed, p_quantity_pending, p_notes, p_delay_reason,
    case when p_status = 'in_progress' and v_existing.started_by is null then auth.uid() else v_existing.started_by end,
    case when p_status = 'completed' then auth.uid() else v_existing.completed_by end,
    now()
  )
  on conflict (job_id, stage) do update set
    status = excluded.status,
    assigned_to = coalesce(excluded.assigned_to, production_stage_updates.assigned_to),
    planned_start = coalesce(excluded.planned_start, production_stage_updates.planned_start),
    planned_end = coalesce(excluded.planned_end, production_stage_updates.planned_end),
    actual_start = excluded.actual_start,
    actual_end = excluded.actual_end,
    quantity_completed = coalesce(excluded.quantity_completed, production_stage_updates.quantity_completed),
    quantity_pending = coalesce(excluded.quantity_pending, production_stage_updates.quantity_pending),
    notes = coalesce(excluded.notes, production_stage_updates.notes),
    delay_reason = excluded.delay_reason,
    started_by = excluded.started_by,
    completed_by = excluded.completed_by,
    updated_at = now();

  select count(*) into v_done_stages from public.production_stage_updates where job_id = p_job_id and status = 'completed';
  v_completion := round((v_done_stages::numeric / 17) * 100);

  update public.inhouse_production_requests set current_stage = p_stage, completion_percentage = v_completion, updated_at = now() where id = p_job_id;

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();
  perform public.staff_write_audit('production_stage_updates', p_job_id, 'STAGE_UPDATE',
    jsonb_build_object('stage', p_stage, 'previous_status', v_existing.status),
    jsonb_build_object('status', p_status, 'quantity_completed', p_quantity_completed, 'notes', p_notes, 'delay_reason', p_delay_reason, 'project_id', v_job.project_id),
    null);

  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id,
      'Production stage "' || p_stage || '" ' || p_status || ' — ' || v_actor_name || coalesce(': ' || p_notes, ''),
      v_actor_name || ' દ્વારા ઉત્પાદન તબક્કો "' || p_stage || '" ' || p_status || coalesce(': ' || p_notes, ''));
  end if;
end;
$function$;

revoke all on function public.factory_update_stage(uuid,text,text,uuid,numeric,numeric,text,text,date,date) from public;
grant execute on function public.factory_update_stage(uuid,text,text,uuid,numeric,numeric,text,text,date,date) to authenticated;

create or replace function public.factory_record_quality_check(
  p_job_id uuid, p_dimensions_checked boolean, p_material_checked boolean, p_finish_checked boolean,
  p_hardware_checked boolean, p_drawing_matched boolean, p_quantity_checked boolean,
  p_result text, p_defect_reason text default null, p_rework_required boolean default false,
  p_assigned_rework_person uuid default null, p_recheck_date date default null
) returns table(quality_check_id uuid, rework_id uuid, rework_number text)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_job public.inhouse_production_requests%rowtype;
  v_qc_id uuid; v_rework_id uuid; v_rework_number text; v_actor_name text; v_my_profile uuid;
begin
  perform public.staff_assert_operational();
  if p_result not in ('pass','fail','conditional_pass') then raise exception 'Invalid QC result'; end if;

  select * into v_job from public.inhouse_production_requests where id = p_job_id for update;
  if v_job.id is null then raise exception 'Job not found'; end if;
  select id into v_my_profile from public.profiles where auth_id = auth.uid();

  if not (
    public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_factory_staff() and (
      v_job.assigned_factory_coordinator = v_my_profile or v_job.second_assignee_coordinator = v_my_profile
      or v_job.current_responsible_person = v_my_profile or public.staff_is_dept_head()
    ))
  ) then
    raise exception 'You are not authorized to record QC for this job';
  end if;
  if p_rework_required and (p_defect_reason is null or btrim(p_defect_reason) = '') then
    raise exception 'A defect/rejection reason is required when rework is needed';
  end if;

  insert into public.factory_quality_checks (
    job_id, dimensions_checked, material_checked, finish_checked, hardware_checked, drawing_matched, quantity_checked,
    result, defect_reason, rework_required, assigned_rework_person, recheck_date, checked_by
  ) values (
    p_job_id, p_dimensions_checked, p_material_checked, p_finish_checked, p_hardware_checked, p_drawing_matched, p_quantity_checked,
    p_result, p_defect_reason, p_rework_required, p_assigned_rework_person, p_recheck_date, auth.uid()
  ) returning id into v_qc_id;

  update public.inhouse_production_requests set
    qc_status = p_result,
    rework_status = case when p_rework_required then 'Rework Required' else rework_status end,
    status = case when p_rework_required then 'Rework' else status end,
    updated_at = now()
  where id = p_job_id;

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  if p_rework_required then
    select 'RW-' || lpad((select count(*) + 1 from public.factory_rework_records)::text, 6, '0') into v_rework_number;
    insert into public.factory_rework_records (
      rework_number, quality_check_id, job_id, defect_details, assigned_to, required_completion_date, created_by
    ) values (
      v_rework_number, v_qc_id, p_job_id, p_defect_reason,
      coalesce((select auth_id from public.profiles where id = p_assigned_rework_person), (select auth_id from public.profiles where id = v_job.assigned_factory_coordinator)),
      p_recheck_date, auth.uid()
    ) returning id into v_rework_id;
  end if;

  perform public.staff_write_audit('factory_quality_checks', v_qc_id, 'QC_RECORDED',
    null, jsonb_build_object('result', p_result, 'rework_required', p_rework_required, 'defect_reason', p_defect_reason, 'job_id', p_job_id, 'project_id', v_job.project_id), null);

  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id,
      'QC ' || p_result || ' by ' || v_actor_name || case when p_rework_required then ' — rework required: ' || p_defect_reason else '' end,
      v_actor_name || ' દ્વારા QC ' || p_result || case when p_rework_required then ' — રિવર્ક જરૂરી: ' || p_defect_reason else '' end);
  end if;

  return query select v_qc_id, v_rework_id, v_rework_number;
end;
$function$;

revoke all on function public.factory_record_quality_check(uuid,boolean,boolean,boolean,boolean,boolean,boolean,text,text,boolean,uuid,date) from public;
grant execute on function public.factory_record_quality_check(uuid,boolean,boolean,boolean,boolean,boolean,boolean,text,text,boolean,uuid,date) to authenticated;

create or replace function public.factory_close_rework(p_rework_id uuid, p_recheck_result text, p_corrective_action text default null)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_rw public.factory_rework_records%rowtype;
  v_job public.inhouse_production_requests%rowtype;
  v_actor_name text; v_my_profile uuid;
begin
  perform public.staff_assert_operational();
  if p_recheck_result is null or btrim(p_recheck_result) = '' then
    raise exception 'A recheck result is required to close a rework';
  end if;

  select * into v_rw from public.factory_rework_records where id = p_rework_id for update;
  if v_rw.id is null then raise exception 'Rework record not found'; end if;
  if v_rw.is_closed then raise exception 'This rework is already closed'; end if;
  select * into v_job from public.inhouse_production_requests where id = v_rw.job_id;
  select id into v_my_profile from public.profiles where auth_id = auth.uid();

  if not (
    public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_factory_staff() and (v_rw.assigned_to = auth.uid() or public.staff_is_dept_head()))
  ) then
    raise exception 'You are not authorized to close this rework';
  end if;

  update public.factory_rework_records set
    recheck_result = p_recheck_result,
    corrective_action = coalesce(p_corrective_action, corrective_action),
    is_closed = true, closed_by = auth.uid(), closed_at = now()
  where id = p_rework_id;

  update public.inhouse_production_requests set rework_status = 'Rework Closed', status = 'Work in Progress' where id = v_rw.job_id and status = 'Rework';

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();
  perform public.staff_write_audit('factory_rework_records', p_rework_id, 'REWORK_CLOSED',
    null, jsonb_build_object('recheck_result', p_recheck_result, 'project_id', v_job.project_id), null);

  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id,
      'Rework ' || v_rw.rework_number || ' closed by ' || v_actor_name || ': ' || p_recheck_result,
      v_actor_name || ' દ્વારા રિવર્ક ' || v_rw.rework_number || ' બંધ: ' || p_recheck_result);
  end if;
end;
$function$;

revoke all on function public.factory_close_rework(uuid,text,text) from public;
grant execute on function public.factory_close_rework(uuid,text,text) to authenticated;

-- ---------------------------------------------------------------------
-- 9. Realtime.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'inhouse_production_requests') then
    execute 'alter publication supabase_realtime add table public.inhouse_production_requests';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'production_stage_updates') then
    execute 'alter publication supabase_realtime add table public.production_stage_updates';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'factory_quality_checks') then
    execute 'alter publication supabase_realtime add table public.factory_quality_checks';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'factory_rework_records') then
    execute 'alter publication supabase_realtime add table public.factory_rework_records';
  end if;
end $$;
