-- mvp_pilot_fix_multi_accept_regression_v2_49
-- Live bug, reproduced directly against real data before writing this fix:
-- a two-assignee task where the Primary had already accepted AND started
-- (individual_status IN_PROGRESS, overall staff_tasks.status_id =
-- IN_PROGRESS) -- a completely normal state, since the two assignees never
-- have to act in lockstep. When the Second Assignee then accepted for the
-- first time, staff_accept_task's multi-assignee branch recomputed the
-- overall status from acceptance counts ALONE (both now ACCEPTED ->
-- "ACCEPTED") and blindly overwrote staff_tasks.status_id with it,
-- attempting an IN_PROGRESS -> ACCEPTED transition. staff_validate_task_
-- transition() correctly rejected that (it's a regression, not a real
-- transition), which surfaced to the browser as a raw 400 on every Accept
-- click for that assignee -- confirmed live via a direct rollback-wrapped
-- call reproducing the exact "Invalid task status transition: IN_PROGRESS
-- -> ACCEPTED" exception.
--
-- Fix: reuse staff_recompute_task_status() (already existed, already used
-- by staff_remove_second_assignee, already correctly guards this exact
-- case -- it only moves the overall status to ACCEPTED when the current
-- status isn't already IN_PROGRESS/PARTIALLY_COMPLETED, and simply no-ops
-- otherwise) instead of the naive inline recompute-and-overwrite. The
-- bridges.acceptance_status mirror now checks the task's ACTUAL resulting
-- status after the recompute, not a pre-recompute guess.

create or replace function public.staff_accept_task(p_task_id uuid)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid;
  v_assignee_count int; v_my_row record; v_active_count int; v_accepted_count int; v_new_code text;
  v_actor_name text;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;
  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  select count(*) into v_assignee_count from public.staff_task_assignees where task_id = p_task_id and is_active;

  if v_assignee_count <= 1 then
    if v_old_code not in ('ASSIGNED','RETURNED') then
      raise exception 'Task must be ASSIGNED or RETURNED to accept (currently %)', v_old_code;
    end if;
    if v_task.assigned_to <> auth.uid() then
      raise exception 'Only the assignee may accept this task';
    end if;

    select id into v_status_id from public.status_master where code = 'ACCEPTED';
    update public.staff_tasks set status_id = v_status_id where id = p_task_id;

    if v_task.is_bridge then
      update public.bridges set acceptance_status = 'ACCEPTED', accepted_at = now() where task_id = p_task_id;
    end if;

    perform public.staff_write_audit('task', p_task_id, 'ACCEPT', jsonb_build_object('status', v_old_code), jsonb_build_object('status','ACCEPTED'), v_task.to_department_id);
    perform public.staff_post_system_task_message(p_task_id, 'Task accepted by ' || v_actor_name, v_actor_name || ' દ્વારા કાર્ય સ્વીકારાયું');
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_task.assigned_by, 'task', p_task_id, 'Task accepted: ' || v_task.task_number, 'કામ સ્વીકાર્યું: ' || v_task.task_number);
    return;
  end if;

  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;
  if v_my_row.id is null then
    raise exception 'You are not an active assignee on this task';
  end if;
  if v_my_row.acceptance_status = 'ACCEPTED' then
    raise exception 'You have already accepted this task';
  end if;

  update public.staff_task_assignees set acceptance_status = 'ACCEPTED', accepted_at = now(),
    individual_status = case when individual_status = 'ASSIGNED' then 'ACCEPTED' else individual_status end
    where id = v_my_row.id;

  -- Safe recompute: no-ops if the task already progressed past
  -- acceptance (e.g. the other assignee already started/completed their
  -- part) instead of blindly forcing the overall status back to ACCEPTED.
  perform public.staff_recompute_task_status(p_task_id);

  select sm.code into v_new_code from public.staff_tasks st join public.status_master sm on sm.id = st.status_id where st.id = p_task_id;

  if v_task.is_bridge and v_new_code = 'ACCEPTED' then
    update public.bridges set acceptance_status = 'ACCEPTED', accepted_at = now() where task_id = p_task_id;
  end if;

  perform public.staff_write_audit('task', p_task_id, 'ACCEPT', jsonb_build_object('status', v_old_code, 'user_id', auth.uid()), jsonb_build_object('status', v_new_code), v_task.to_department_id);
  perform public.staff_post_system_task_message(p_task_id, 'Accepted by ' || v_actor_name, v_actor_name || ' દ્વારા સ્વીકારાયું');
  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  values (v_task.assigned_by, 'task', p_task_id, 'Task accepted: ' || v_task.task_number, 'કામ સ્વીકાર્યું: ' || v_task.task_number);
end;
$function$;
