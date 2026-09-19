-- mvp_pilot_factory_stage_simplified_v2_71
--
-- Supports the simplified stage-button Job Card UI:
--   1. A distinct 'rework' status (additive to the existing 5) so a stage
--      marked for rework is visually and structurally distinguishable from
--      'on_hold' (spec calls for 5 separate colours: grey/blue/orange/red/
--      green -- on_hold was already orange, so rework needs its own value,
--      not reused).
--   2. Client-acknowledgement columns on production_stage_updates, used by
--      the Fitting/Installation stage panel (real, structured boolean +
--      actor + timestamp, not text folded into notes).
--   3. factory_set_client_acknowledged -- new, narrowly-scoped RPC, same
--      authorization block as factory_update_stage (copied, not weakened).
--
-- No existing row is touched. No table is dropped. No existing stage name
-- or status value is removed -- both CHECK constraints are widened, never
-- narrowed.

alter table public.production_stage_updates drop constraint if exists production_stage_updates_status_check;
alter table public.production_stage_updates add constraint production_stage_updates_status_check
  check (status = any (array['pending','in_progress','completed','skipped','on_hold','rework']));

alter table public.production_stage_updates add column if not exists client_acknowledged boolean not null default false;
alter table public.production_stage_updates add column if not exists client_acknowledged_by uuid references public.user_profiles(id);
alter table public.production_stage_updates add column if not exists client_acknowledged_at timestamptz;

-- factory_update_stage's own p_status validation must accept 'rework' too
-- (it checks before ever reaching the table's CHECK constraint).
create or replace function public.factory_update_stage(
  p_job_id uuid, p_stage text, p_status text, p_assigned_to uuid default null, p_quantity_completed numeric default null,
  p_quantity_pending numeric default null, p_notes text default null, p_delay_reason text default null,
  p_planned_start date default null, p_planned_end date default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_job public.inhouse_production_requests%rowtype;
  v_existing public.production_stage_updates%rowtype;
  v_actor_name text; v_my_profile uuid;
  v_done_stages int; v_completion int;
begin
  perform public.staff_assert_operational();
  if p_status not in ('pending','in_progress','completed','skipped','on_hold','rework') then
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

create or replace function public.factory_set_client_acknowledged(p_job_id uuid, p_stage text, p_acknowledged boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_job public.inhouse_production_requests%rowtype;
  v_my_profile uuid;
begin
  perform public.staff_assert_operational();
  select * into v_job from public.inhouse_production_requests where id = p_job_id;
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

  update public.production_stage_updates
  set client_acknowledged = p_acknowledged,
      client_acknowledged_by = case when p_acknowledged then auth.uid() else null end,
      client_acknowledged_at = case when p_acknowledged then now() else null end
  where job_id = p_job_id and stage = p_stage;

  perform public.staff_write_audit('production_stage_updates', p_job_id, 'CLIENT_ACKNOWLEDGED',
    null, jsonb_build_object('stage', p_stage, 'acknowledged', p_acknowledged), null);
end;
$function$;

grant execute on function public.factory_set_client_acknowledged(uuid, text, boolean) to authenticated;
