-- staff_complete_task(uuid) and staff_complete_task(uuid, text DEFAULT NULL)
-- are genuinely ambiguous to call with just one argument (Postgres treats
-- the arity-1 exact match and the arity-2-with-default match as equally
-- valid candidates for a 1-arg call, confirmed live: "function ... is not
-- unique"). The real frontend caller (TodayTasks.jsx) never actually needs
-- the default -- completeWithProof always passes both params explicitly
-- (even NULL), and the plain complete button always calls the 1-arg form.
-- Recreating without the default removes the ambiguity with zero frontend
-- impact.
drop function if exists public.staff_complete_task(uuid, text);

create or replace function public.staff_complete_task(p_task_id uuid, p_customer_confirmation_text text)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid;
  v_assignee_count int; v_my_row record; v_active_count int; v_completed_count int; v_all_done boolean;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;

  update public.staff_tasks set customer_confirmation_text = p_customer_confirmation_text where id = p_task_id;

  select count(*) into v_assignee_count from public.staff_task_assignees where task_id = p_task_id and is_active;

  if v_assignee_count <= 1 then
    if v_old_code <> 'IN_PROGRESS' then
      raise exception 'Task must be IN_PROGRESS to complete (currently %)', v_old_code;
    end if;
    if v_task.current_owner_id <> auth.uid() then
      raise exception 'Only the current owner may complete this task';
    end if;

    select id into v_status_id from public.status_master where code = 'COMPLETED';
    update public.staff_tasks set status_id = v_status_id where id = p_task_id;

    if v_task.is_bridge then
      update public.bridges set completed_at = now() where task_id = p_task_id;
    end if;

    perform public.staff_write_audit('task', p_task_id, 'COMPLETE', jsonb_build_object('status', v_old_code), jsonb_build_object('status','COMPLETED'), v_task.to_department_id);
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_task.verifier_id, 'task', p_task_id, 'Ready for verification: ' || v_task.task_number, 'ચકાસણી માટે તૈયાર: ' || v_task.task_number);
    return;
  end if;

  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;
  if v_my_row.id is null then
    raise exception 'You are not an active assignee on this task';
  end if;
  if v_my_row.individual_status <> 'IN_PROGRESS' then
    raise exception 'Task must be IN_PROGRESS to complete (your status is currently %)', v_my_row.individual_status;
  end if;

  update public.staff_task_assignees set individual_status = 'COMPLETED', completed_at = now(), completion_note = p_customer_confirmation_text where id = v_my_row.id;

  if v_task.completion_rule = 'ANY_ONE' then
    v_all_done := true;
  else
    select count(*), count(*) filter (where individual_status = 'COMPLETED')
      into v_active_count, v_completed_count
      from public.staff_task_assignees where task_id = p_task_id and is_active;
    v_all_done := (v_completed_count = v_active_count);
  end if;

  if v_all_done and v_old_code not in ('COMPLETED','VERIFIED','CLOSED') then
    select id into v_status_id from public.status_master where code = 'COMPLETED';
    update public.staff_tasks set status_id = v_status_id where id = p_task_id;
    if v_task.is_bridge then
      update public.bridges set completed_at = now() where task_id = p_task_id;
    end if;
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_task.verifier_id, 'task', p_task_id, 'Ready for verification: ' || v_task.task_number, 'ચકાસણી માટે તૈયાર: ' || v_task.task_number);
  elsif not v_all_done then
    select id into v_status_id from public.status_master where code = 'PARTIALLY_COMPLETED';
    update public.staff_tasks set status_id = v_status_id where id = p_task_id;
  end if;

  perform public.staff_write_audit('task', p_task_id, 'COMPLETE', jsonb_build_object('status', v_old_code, 'user_id', auth.uid()), jsonb_build_object('individual_status','COMPLETED', 'all_done', v_all_done), v_task.to_department_id);
end;
$function$;
