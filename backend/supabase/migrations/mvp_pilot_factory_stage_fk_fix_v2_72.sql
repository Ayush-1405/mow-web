-- mvp_pilot_factory_stage_fk_fix_v2_72
--
-- Root cause of "production_stage_updates_assigned_to_fkey" violation:
-- production_stage_updates.assigned_to references user_profiles(id) (the
-- auth-space id), but the Job Card's "Start Stage" action passed
-- job.assigned_factory_coordinator, which is a profiles(id) value (the
-- Interior-roster space) -- the same two-ID-space distinction this app has
-- hit before (factory_record_quality_check already resolves
-- assigned_rework_person the correct way; factory_update_stage never did).
--
-- Fixed at the RPC level, not just the one caller that hit it, so every
-- current and future caller (including the WIP Stages board) is protected
-- the same way: p_assigned_to now accepts EITHER a user_profiles.id (the
-- FK's own space) or a profiles.id (the space every employee dropdown in
-- this app actually returns) and resolves to the correct user_profiles.id
-- before insert. A value that resolves to neither raises one clear,
-- friendly exception instead of the raw FK error reaching the UI.
--
-- Also adds stage_data jsonb for the stage-specific fields (Drawing
-- revision/approver, Cutting machine/operator, Packing package count, etc.)
-- -- one additive column, not dozens of new narrow ones, per the requested
-- "stage_data JSONB or properly normalized stage fields" option. Existing
-- rows default to '{}'::jsonb; nothing is overwritten or lost.

alter table public.production_stage_updates add column if not exists stage_data jsonb not null default '{}'::jsonb;

create or replace function public.factory_update_stage(
  p_job_id uuid, p_stage text, p_status text, p_assigned_to uuid default null, p_quantity_completed numeric default null,
  p_quantity_pending numeric default null, p_notes text default null, p_delay_reason text default null,
  p_planned_start date default null, p_planned_end date default null, p_stage_data jsonb default null
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
  v_resolved_assigned_to uuid;
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

  -- Resolve p_assigned_to to the FK's own space (user_profiles.id), whether
  -- the caller passed that directly or a profiles.id instead. Never insert
  -- an unresolved value -- fail with a clear message instead.
  if p_assigned_to is not null then
    select id into v_resolved_assigned_to from public.user_profiles where id = p_assigned_to;
    if v_resolved_assigned_to is null then
      select auth_id into v_resolved_assigned_to from public.profiles where id = p_assigned_to;
    end if;
    if v_resolved_assigned_to is null then
      raise exception 'Selected employee could not be found. Please choose a valid employee from the list.';
    end if;
  else
    v_resolved_assigned_to := null;
  end if;

  select * into v_existing from public.production_stage_updates where job_id = p_job_id and stage = p_stage;

  insert into public.production_stage_updates (
    job_id, stage, status, assigned_to, planned_start, planned_end,
    actual_start, actual_end, quantity_completed, quantity_pending, notes, delay_reason, stage_data,
    started_by, completed_by, updated_at
  ) values (
    p_job_id, p_stage, p_status, v_resolved_assigned_to, p_planned_start, p_planned_end,
    case when p_status = 'in_progress' and v_existing.actual_start is null then now() else v_existing.actual_start end,
    case when p_status = 'completed' then now() else v_existing.actual_end end,
    p_quantity_completed, p_quantity_pending, p_notes, p_delay_reason,
    coalesce(p_stage_data, '{}'::jsonb),
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
    stage_data = case when p_stage_data is not null then production_stage_updates.stage_data || p_stage_data else production_stage_updates.stage_data end,
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

drop function if exists public.factory_update_stage(uuid, text, text, uuid, numeric, numeric, text, text, date, date);
