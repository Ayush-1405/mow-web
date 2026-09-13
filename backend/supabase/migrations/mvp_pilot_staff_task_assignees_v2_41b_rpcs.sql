-- Extends staff_create_task with an optional Second Assignee, and extends
-- staff_accept_task/staff_start_task/staff_complete_task/staff_return_task
-- with a multi-assignee branch -- the single-assignee branch in each is an
-- EXACT copy of that RPC's current body (verified against live
-- pg_get_functiondef output before writing this), so every task created
-- before this feature, and every future single-assignee task, runs through
-- byte-for-byte the same code path as today.

create or replace function public.staff_create_task(
  p_title text, p_description text, p_task_type_code text, p_priority_code text, p_proof_type_code text,
  p_from_department_id uuid, p_to_department_id uuid, p_assigned_to uuid, p_due_date date,
  p_due_time time without time zone default null, p_verifier_id uuid default null,
  p_reference_number text default null, p_requirement_text text default null, p_quantity text default null,
  p_second_assignee uuid default null
)
returns table(task_id uuid, task_number text, bridge_id uuid, bridge_number text)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_caller uuid := auth.uid();
  v_caller_role text;
  v_caller_department uuid;
  v_task_type_id uuid; v_priority_id uuid; v_proof_type_id uuid; v_status_id uuid;
  v_task_id uuid; v_task_number text; v_bridge_id uuid; v_bridge_number text;
  v_is_bridge boolean;
  v_from_confidential boolean; v_to_confidential boolean;
  v_verifier uuid; v_verifier_role text; v_verifier_department uuid;
  v_assignee_department uuid;
  v_second_department uuid;
begin
  perform public.staff_assert_operational();
  v_caller_role := public.staff_current_role_code();
  v_caller_department := public.staff_current_department_id();

  if not exists (select 1 from public.departments where id = p_from_department_id and is_active = true) then
    raise exception 'Invalid from_department';
  end if;
  if not exists (select 1 from public.departments where id = p_to_department_id and is_active = true) then
    raise exception 'Invalid to_department';
  end if;
  select is_confidential_domain into v_from_confidential from public.departments where id = p_from_department_id;
  select is_confidential_domain into v_to_confidential from public.departments where id = p_to_department_id;
  v_is_bridge := (p_from_department_id <> p_to_department_id);

  if v_is_bridge then
    if v_from_confidential or v_to_confidential then
      raise exception 'Cross-department Bridges into/out of a confidential department are disabled in this pilot';
    end if;
  else
    if v_from_confidential and v_caller_role not in ('management','cfo','accounts_head','accounts_employee') then
      raise exception 'Only Accounts roles or Management may create tasks within a confidential department';
    end if;
  end if;

  if v_caller_role in ('employee','supervisor') then
    if p_from_department_id <> v_caller_department then
      raise exception 'You may only create tasks from your own department';
    end if;
  elsif v_caller_role = 'dept_head' then
    if not public.staff_dept_in_hod_scope(p_from_department_id) then
      raise exception 'from_department is outside your authorized scope';
    end if;
  elsif v_caller_role = 'management' then
    null;
  elsif v_caller_role in ('cfo','accounts_head','accounts_employee') then
    if p_from_department_id <> v_caller_department then
      raise exception 'Accounts roles may only create tasks within their own Accounts department';
    end if;
  else
    raise exception 'Your role is not authorized to create tasks in this pilot';
  end if;

  select department_id into v_assignee_department from public.user_profiles where id = p_assigned_to and is_active = true;
  if v_assignee_department is null then
    raise exception 'Invalid or inactive assignee';
  end if;
  if v_assignee_department is distinct from p_to_department_id then
    raise exception 'assigned_to must belong to the selected destination department';
  end if;

  -- Second Assignee (new, additive): same active/department rules as the
  -- Primary, plus "must be a different person" -- exact bilingual message
  -- from the request, checked here so the whole creation raises/rolls back
  -- rather than silently proceeding with one person.
  if p_second_assignee is not null then
    if p_second_assignee = p_assigned_to then
      raise exception 'Primary and Second Assignee must be different people. / મુખ્ય અને બીજી જવાબદાર વ્યક્તિ અલગ હોવી જોઈએ.';
    end if;
    select department_id into v_second_department from public.user_profiles where id = p_second_assignee and is_active = true;
    if v_second_department is null then
      raise exception 'Invalid or inactive second assignee';
    end if;
    if v_second_department is distinct from p_to_department_id then
      raise exception 'second assignee must belong to the selected destination department';
    end if;
  end if;

  v_verifier := coalesce(p_verifier_id, v_caller);
  v_verifier_role := public.staff_user_role_code(v_verifier);
  if v_verifier_role is null then
    raise exception 'Invalid or inactive verifier';
  end if;

  if v_verifier <> v_caller then
    if v_caller_role in ('management','dept_head') then
      null;
    elsif v_caller_role in ('employee','supervisor')
          and v_verifier_role = 'dept_head'
          and public.staff_user_dept_in_hod_scope(v_verifier, v_caller_department) then
      null;
    else
      raise exception 'You may only set yourself or your own Department Head as verifier';
    end if;
  end if;

  select department_id into v_verifier_department from public.user_profiles where id = v_verifier;
  if not (
    v_verifier = v_caller
    or v_verifier_role = 'management'
    or v_verifier_department = p_to_department_id
    or (v_verifier_role = 'dept_head' and public.staff_user_dept_in_hod_scope(v_verifier, p_to_department_id))
    or (v_verifier_role = 'dept_head' and public.staff_user_dept_in_hod_scope(v_verifier, v_caller_department))
  ) then
    raise exception 'verifier_id is not authorized for the destination department';
  end if;

  select id into v_task_type_id from public.task_types where code = p_task_type_code and is_active = true;
  if v_task_type_id is null then raise exception 'Invalid task_type_code'; end if;
  select id into v_priority_id from public.priority_master where code = p_priority_code and is_active = true;
  if v_priority_id is null then raise exception 'Invalid priority_code'; end if;
  select id into v_proof_type_id from public.proof_types where code = p_proof_type_code and is_active = true;
  if v_proof_type_id is null then raise exception 'Invalid proof_type_code'; end if;
  select id into v_status_id from public.status_master where code = 'ASSIGNED';

  insert into public.staff_tasks as inserted_task (
    title, description, task_type_id, priority_id, status_id, proof_type_id,
    from_department_id, to_department_id, assigned_by, assigned_to, verifier_id,
    current_owner_id, reference_number, requirement_text, quantity, due_date, due_time
  ) values (
    p_title, p_description, v_task_type_id, v_priority_id, v_status_id, v_proof_type_id,
    p_from_department_id, p_to_department_id, v_caller, p_assigned_to, v_verifier,
    p_assigned_to, p_reference_number, p_requirement_text, p_quantity, p_due_date, p_due_time
  ) returning inserted_task.id, inserted_task.task_number, inserted_task.is_bridge into v_task_id, v_task_number, v_is_bridge;

  if v_is_bridge then
    insert into public.bridges as inserted_bridge (task_id, from_department_id, to_department_id, from_person_id, to_person_id, requirement_text, quantity)
    values (v_task_id, p_from_department_id, p_to_department_id, v_caller, p_assigned_to, coalesce(p_requirement_text, p_title), p_quantity)
    returning inserted_bridge.id, inserted_bridge.bridge_number into v_bridge_id, v_bridge_number;
  end if;

  insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by)
  values (v_task_id, p_assigned_to, 'primary', v_caller);

  if p_second_assignee is not null then
    insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by)
    values (v_task_id, p_second_assignee, 'secondary', v_caller);
  end if;

  perform public.staff_write_audit('task', v_task_id, 'CREATE', null,
    jsonb_build_object('task_number', v_task_number, 'is_bridge', v_is_bridge, 'assigned_to', p_assigned_to, 'second_assignee', p_second_assignee), p_to_department_id);

  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  values (
    p_assigned_to, 'task', v_task_id,
    case when p_second_assignee is not null then 'You have been assigned a new task as Primary Assignee: ' || p_title else 'New task assigned: ' || v_task_number end,
    case when p_second_assignee is not null then 'તમને મુખ્ય જવાબદાર તરીકે નવું કામ સોંપવામાં આવ્યું છે: ' || p_title else 'નવું કામ સોંપાયું: ' || v_task_number end
  );

  if p_second_assignee is not null then
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (
      p_second_assignee, 'task', v_task_id,
      'You have been added to a task as Second Assignee: ' || p_title,
      'તમને બીજી જવાબદાર વ્યક્તિ તરીકે કામમાં ઉમેરવામાં આવ્યા છે: ' || p_title
    );
  end if;

  return query select v_task_id, v_task_number, v_bridge_id, v_bridge_number;
end;
$function$;

create or replace function public.staff_accept_task(p_task_id uuid)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid;
  v_assignee_count int; v_my_row record; v_active_count int; v_accepted_count int; v_new_code text;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;

  select count(*) into v_assignee_count from public.staff_task_assignees where task_id = p_task_id and is_active;

  if v_assignee_count <= 1 then
    -- Exact original single-assignee body.
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
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_task.assigned_by, 'task', p_task_id, 'Task accepted: ' || v_task.task_number, 'કામ સ્વીકાર્યું: ' || v_task.task_number);
    return;
  end if;

  -- Multi-assignee: only the caller's own row changes; overall status is
  -- recomputed from every active assignee's acceptance_status.
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

  select count(*), count(*) filter (where acceptance_status = 'ACCEPTED')
    into v_active_count, v_accepted_count
    from public.staff_task_assignees where task_id = p_task_id and is_active;

  v_new_code := case when v_accepted_count = v_active_count then 'ACCEPTED' else 'PARTIALLY_ACCEPTED' end;
  select id into v_status_id from public.status_master where code = v_new_code;
  update public.staff_tasks set status_id = v_status_id where id = p_task_id;

  if v_task.is_bridge and v_new_code = 'ACCEPTED' then
    update public.bridges set acceptance_status = 'ACCEPTED', accepted_at = now() where task_id = p_task_id;
  end if;

  perform public.staff_write_audit('task', p_task_id, 'ACCEPT', jsonb_build_object('status', v_old_code, 'user_id', auth.uid()), jsonb_build_object('status', v_new_code), v_task.to_department_id);
  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  values (v_task.assigned_by, 'task', p_task_id, 'Task accepted: ' || v_task.task_number, 'કામ સ્વીકાર્યું: ' || v_task.task_number);
end;
$function$;

create or replace function public.staff_start_task(p_task_id uuid)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid;
  v_assignee_count int; v_my_row record;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;

  select count(*) into v_assignee_count from public.staff_task_assignees where task_id = p_task_id and is_active;

  if v_assignee_count <= 1 then
    if v_old_code <> 'ACCEPTED' then
      raise exception 'Task must be ACCEPTED to start (currently %)', v_old_code;
    end if;
    if v_task.current_owner_id <> auth.uid() then
      raise exception 'Only the current owner may start this task';
    end if;

    select id into v_status_id from public.status_master where code = 'IN_PROGRESS';
    update public.staff_tasks set status_id = v_status_id where id = p_task_id;

    perform public.staff_write_audit('task', p_task_id, 'START', jsonb_build_object('status', v_old_code), jsonb_build_object('status','IN_PROGRESS'), v_task.to_department_id);
    return;
  end if;

  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;
  if v_my_row.id is null then
    raise exception 'You are not an active assignee on this task';
  end if;
  if v_my_row.individual_status <> 'ACCEPTED' then
    raise exception 'You must accept this task before starting it (your status is currently %)', v_my_row.individual_status;
  end if;

  update public.staff_task_assignees set individual_status = 'IN_PROGRESS' where id = v_my_row.id;

  if v_old_code in ('ASSIGNED','PARTIALLY_ACCEPTED','ACCEPTED') then
    select id into v_status_id from public.status_master where code = 'IN_PROGRESS';
    update public.staff_tasks set status_id = v_status_id where id = p_task_id;
  end if;

  perform public.staff_write_audit('task', p_task_id, 'START', jsonb_build_object('status', v_old_code, 'user_id', auth.uid()), jsonb_build_object('individual_status','IN_PROGRESS'), v_task.to_department_id);
end;
$function$;

create or replace function public.staff_complete_task(p_task_id uuid)
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

  update public.staff_task_assignees set individual_status = 'COMPLETED', completed_at = now() where id = v_my_row.id;

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

create or replace function public.staff_return_task(p_task_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid; v_allowed boolean := false;
  v_assignee_count int; v_my_row record;
begin
  perform public.staff_assert_operational();
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A return reason is required';
  end if;

  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;

  select count(*) into v_assignee_count from public.staff_task_assignees where task_id = p_task_id and is_active;

  if v_assignee_count <= 1 then
    if v_old_code = 'ASSIGNED' then
      v_allowed := (v_task.assigned_to = auth.uid()) or public.staff_is_super_admin();
    elsif v_old_code in ('ACCEPTED','IN_PROGRESS') then
      v_allowed := (v_task.current_owner_id = auth.uid()) or public.staff_is_super_admin();
    elsif v_old_code = 'COMPLETED' then
      v_allowed := (v_task.verifier_id = auth.uid() or public.staff_is_management() or public.staff_is_super_admin()
                    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_task.to_department_id)));
    else
      raise exception 'Task cannot be returned from status %', v_old_code;
    end if;

    if not v_allowed then
      raise exception 'You are not authorized to return this task at its current stage';
    end if;

    select id into v_status_id from public.status_master where code = 'RETURNED';
    update public.staff_tasks set status_id = v_status_id, return_reason = p_reason where id = p_task_id;

    if v_task.is_bridge then
      update public.bridges set acceptance_status = 'RETURNED', return_reason = p_reason where task_id = p_task_id;
    end if;

    perform public.staff_write_audit('task', p_task_id, 'RETURN', jsonb_build_object('status', v_old_code), jsonb_build_object('status','RETURNED','reason',p_reason), v_task.to_department_id);
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_task.assigned_by, 'task', p_task_id, 'Task returned: ' || v_task.task_number, 'કામ પરત: ' || v_task.task_number);
    return;
  end if;

  -- Multi-assignee: this is "reject my own part" -- the other assignee's
  -- row and the overall status are untouched.
  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;
  if v_my_row.id is null then
    raise exception 'You are not an active assignee on this task';
  end if;
  if v_my_row.individual_status = 'COMPLETED' then
    raise exception 'You have already completed your part of this task';
  end if;

  update public.staff_task_assignees set acceptance_status = 'REJECTED', individual_status = 'REJECTED' where id = v_my_row.id;

  perform public.staff_write_audit('task', p_task_id, 'RETURN', jsonb_build_object('user_id', auth.uid(), 'status', v_my_row.individual_status), jsonb_build_object('individual_status','REJECTED','reason',p_reason), v_task.to_department_id, p_reason);
  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  values (v_task.assigned_by, 'task', p_task_id, 'An assignee returned their part: ' || v_task.task_number, 'એક વ્યક્તિએ પોતાનો ભાગ પરત કર્યો: ' || v_task.task_number);
end;
$function$;

create or replace function public.staff_reassign_task(p_task_id uuid, p_reason text, p_new_assigned_to uuid default null, p_new_verifier_id uuid default null, p_new_to_department_id uuid default null)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_old_assignee uuid; v_new_dept uuid;
  v_new_verifier_role text; v_new_verifier_department uuid;
  v_caller_role text;
  v_new_to_department_id uuid; v_dept_changed boolean; v_new_is_bridge boolean;
  v_from_confidential boolean; v_new_to_confidential boolean;
begin
  perform public.staff_assert_operational();
  v_caller_role := public.staff_current_role_code();

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required for reassignment';
  end if;

  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;

  if v_old_code not in ('ASSIGNED','RETURNED','ACCEPTED','IN_PROGRESS') then
    raise exception 'Task cannot be reassigned from status % — only ASSIGNED, RETURNED, ACCEPTED, or IN_PROGRESS may be reassigned', v_old_code;
  end if;

  if not (
    public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_task.to_department_id))
  ) then
    raise exception 'You are not authorized to reassign this task';
  end if;

  v_old_assignee := v_task.assigned_to;
  v_new_to_department_id := coalesce(p_new_to_department_id, v_task.to_department_id);
  v_dept_changed := (p_new_to_department_id is not null and p_new_to_department_id is distinct from v_task.to_department_id);

  if v_dept_changed then
    if not exists (select 1 from public.departments where id = v_new_to_department_id and is_active = true) then
      raise exception 'Invalid destination department';
    end if;
    if p_new_assigned_to is null then
      raise exception 'A new assignee is required when changing the destination department';
    end if;

    select is_confidential_domain into v_from_confidential from public.departments where id = v_task.from_department_id;
    select is_confidential_domain into v_new_to_confidential from public.departments where id = v_new_to_department_id;
    v_new_is_bridge := (v_task.from_department_id <> v_new_to_department_id);

    if v_new_is_bridge then
      if v_from_confidential or v_new_to_confidential then
        raise exception 'Cross-department Bridges into/out of a confidential department are disabled in this pilot';
      end if;
    else
      if v_from_confidential and v_caller_role not in ('management','cfo','accounts_head','accounts_employee','sysadmin') then
        raise exception 'Only Accounts roles, Management, or Super Admin may reassign a task within a confidential department';
      end if;
    end if;
  end if;

  if p_new_assigned_to is not null then
    select department_id into v_new_dept from public.user_profiles where id = p_new_assigned_to and is_active = true;
    if v_new_dept is null then raise exception 'Invalid or inactive new assignee'; end if;
    if v_new_dept is distinct from v_new_to_department_id then
      raise exception 'New assignee must belong to the destination department';
    end if;
  end if;

  if p_new_verifier_id is not null then
    v_new_verifier_role := public.staff_user_role_code(p_new_verifier_id);
    if v_new_verifier_role is null then
      raise exception 'Invalid or inactive new verifier';
    end if;
    select department_id into v_new_verifier_department from public.user_profiles where id = p_new_verifier_id;
    if not (
      v_new_verifier_role = 'management'
      or v_new_verifier_department = v_new_to_department_id
      or (v_new_verifier_role = 'dept_head' and public.staff_user_dept_in_hod_scope(p_new_verifier_id, v_new_to_department_id))
    ) then
      raise exception 'new verifier is not authorized for the destination department';
    end if;
  elsif v_dept_changed then
    v_new_verifier_role := public.staff_user_role_code(v_task.verifier_id);
    select department_id into v_new_verifier_department from public.user_profiles where id = v_task.verifier_id;
    if not (
      v_task.verifier_id = v_task.assigned_by
      or v_new_verifier_role = 'management'
      or v_new_verifier_department = v_new_to_department_id
      or (v_new_verifier_role = 'dept_head' and public.staff_user_dept_in_hod_scope(v_task.verifier_id, v_new_to_department_id))
    ) then
      raise exception 'The existing verifier is not authorized for the new destination department — specify a new verifier';
    end if;
  end if;

  update public.staff_tasks set
    to_department_id = v_new_to_department_id,
    is_bridge = case when v_dept_changed then v_new_is_bridge else is_bridge end,
    assigned_to = coalesce(p_new_assigned_to, assigned_to),
    verifier_id = coalesce(p_new_verifier_id, verifier_id),
    current_owner_id = case
      when p_new_assigned_to is not null and (v_old_code in ('ACCEPTED','IN_PROGRESS') or v_dept_changed) then p_new_assigned_to
      else current_owner_id
    end
  where id = p_task_id;

  -- Keep staff_task_assignees' Primary row in sync so it never drifts from
  -- staff_tasks.assigned_to (additive -- everything else in this RPC is unchanged).
  if p_new_assigned_to is not null and p_new_assigned_to <> v_old_assignee then
    update public.staff_task_assignees set is_active = false, removed_at = now(), removed_by = auth.uid(), removal_reason = 'Reassigned'
      where task_id = p_task_id and assignment_role = 'primary' and is_active;
    insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by)
    values (p_task_id, p_new_assigned_to, 'primary', auth.uid());
  end if;

  if v_dept_changed then
    if v_new_is_bridge then
      if v_task.is_bridge then
        update public.bridges set
          to_department_id = v_new_to_department_id,
          to_person_id = p_new_assigned_to
        where task_id = p_task_id;
      else
        insert into public.bridges as inserted_bridge (task_id, from_department_id, to_department_id, from_person_id, to_person_id, requirement_text)
        values (p_task_id, v_task.from_department_id, v_new_to_department_id, auth.uid(), p_new_assigned_to, coalesce(v_task.description, v_task.title));
      end if;
    else
      update public.bridges set is_active = false where task_id = p_task_id and is_active = true;
    end if;
  elsif v_task.is_bridge and p_new_assigned_to is not null then
    update public.bridges set to_person_id = p_new_assigned_to where task_id = p_task_id;
  end if;

  perform public.staff_write_audit('task', p_task_id, 'REASSIGN',
    jsonb_build_object('assigned_to', v_old_assignee, 'verifier_id', v_task.verifier_id, 'to_department_id', v_task.to_department_id, 'status', v_old_code),
    jsonb_build_object('assigned_to', coalesce(p_new_assigned_to, v_old_assignee), 'verifier_id', coalesce(p_new_verifier_id, v_task.verifier_id), 'to_department_id', v_new_to_department_id, 'reason', p_reason),
    v_new_to_department_id, p_reason);

  if p_new_assigned_to is not null and p_new_assigned_to <> v_old_assignee then
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_old_assignee, 'task', p_task_id, 'Reassigned away from you: ' || v_task.task_number, 'તમારી પાસેથી ફરીથી સોંપાયું: ' || v_task.task_number);
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (p_new_assigned_to, 'task', p_task_id, 'Task reassigned to you: ' || v_task.task_number, 'તમને કામ ફરીથી સોંપાયું: ' || v_task.task_number);
  end if;
end;
$function$;

-- ---------------------------------------------------------------------
-- New: Second Assignee management (add / replace / remove) and the one
-- genuinely new individual-status verb, "Blocked" (no existing analog for
-- a multi-assignee task -- staff_request_help remains untouched and still
-- covers this for single-assignee tasks).
-- ---------------------------------------------------------------------

create or replace function public.staff_add_second_assignee(p_task_id uuid, p_second_assignee uuid)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_dept uuid;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;

  if not (
    public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_task.to_department_id))
    or v_task.assigned_by = auth.uid()
  ) then
    raise exception 'You are not authorized to manage assignees on this task';
  end if;

  if p_second_assignee = v_task.assigned_to then
    raise exception 'Primary and Second Assignee must be different people. / મુખ્ય અને બીજી જવાબદાર વ્યક્તિ અલગ હોવી જોઈએ.';
  end if;
  if exists (select 1 from public.staff_task_assignees where task_id = p_task_id and is_active and assignment_role = 'secondary') then
    raise exception 'This task already has an active Second Assignee — use replace instead';
  end if;

  select department_id into v_dept from public.user_profiles where id = p_second_assignee and is_active = true;
  if v_dept is null then raise exception 'Invalid or inactive second assignee'; end if;
  if v_dept is distinct from v_task.to_department_id then raise exception 'second assignee must belong to the task''s destination department'; end if;

  insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by)
  values (p_task_id, p_second_assignee, 'secondary', auth.uid())
  on conflict (task_id, user_id) do update set is_active = true, removed_at = null, removed_by = null, removal_reason = null,
    acceptance_status = 'PENDING', accepted_at = null, individual_status = 'ASSIGNED', completed_at = null, completion_note = null;

  perform public.staff_write_audit('task', p_task_id, 'ADD_SECOND_ASSIGNEE', null, jsonb_build_object('second_assignee', p_second_assignee), v_task.to_department_id);
  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  values (p_second_assignee, 'task', p_task_id, 'You have been added to a task as Second Assignee: ' || v_task.title, 'તમને બીજી જવાબદાર વ્યક્તિ તરીકે કામમાં ઉમેરવામાં આવ્યા છે: ' || v_task.title);
end;
$function$;

create or replace function public.staff_replace_second_assignee(p_task_id uuid, p_new_second_assignee uuid, p_reason text)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_dept uuid; v_old_row record;
begin
  perform public.staff_assert_operational();
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to replace an assignee';
  end if;

  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;

  if not (
    public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_task.to_department_id))
    or v_task.assigned_by = auth.uid()
  ) then
    raise exception 'You are not authorized to manage assignees on this task';
  end if;

  select * into v_old_row from public.staff_task_assignees where task_id = p_task_id and assignment_role = 'secondary' and is_active for update;
  if v_old_row.id is null then raise exception 'This task has no active Second Assignee to replace'; end if;

  if p_new_second_assignee = v_task.assigned_to then
    raise exception 'Primary and Second Assignee must be different people. / મુખ્ય અને બીજી જવાબદાર વ્યક્તિ અલગ હોવી જોઈએ.';
  end if;
  select department_id into v_dept from public.user_profiles where id = p_new_second_assignee and is_active = true;
  if v_dept is null then raise exception 'Invalid or inactive second assignee'; end if;
  if v_dept is distinct from v_task.to_department_id then raise exception 'second assignee must belong to the task''s destination department'; end if;

  update public.staff_task_assignees set is_active = false, removed_at = now(), removed_by = auth.uid(), removal_reason = p_reason where id = v_old_row.id;

  insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by)
  values (p_task_id, p_new_second_assignee, 'secondary', auth.uid())
  on conflict (task_id, user_id) do update set is_active = true, removed_at = null, removed_by = null, removal_reason = null,
    acceptance_status = 'PENDING', accepted_at = null, individual_status = 'ASSIGNED', completed_at = null, completion_note = null;

  perform public.staff_write_audit('task', p_task_id, 'REPLACE_SECOND_ASSIGNEE',
    jsonb_build_object('previous_second_assignee', v_old_row.user_id), jsonb_build_object('new_second_assignee', p_new_second_assignee, 'reason', p_reason), v_task.to_department_id, p_reason);

  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  values (v_old_row.user_id, 'task', p_task_id, 'You have been removed from a task: ' || v_task.title, 'તમને કામમાંથી દૂર કરવામાં આવ્યા છે: ' || v_task.title);
  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  values (p_new_second_assignee, 'task', p_task_id, 'You have been added to a task as Second Assignee: ' || v_task.title, 'તમને બીજી જવાબદાર વ્યક્તિ તરીકે કામમાં ઉમેરવામાં આવ્યા છે: ' || v_task.title);
end;
$function$;

create or replace function public.staff_remove_second_assignee(p_task_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_row record;
begin
  perform public.staff_assert_operational();
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to remove an assignee';
  end if;

  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;

  if not (
    public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_task.to_department_id))
    or v_task.assigned_by = auth.uid()
  ) then
    raise exception 'You are not authorized to manage assignees on this task';
  end if;

  select * into v_old_row from public.staff_task_assignees where task_id = p_task_id and assignment_role = 'secondary' and is_active for update;
  if v_old_row.id is null then raise exception 'This task has no active Second Assignee to remove'; end if;

  update public.staff_task_assignees set is_active = false, removed_at = now(), removed_by = auth.uid(), removal_reason = p_reason where id = v_old_row.id;

  -- Overall status recomputed the same way accept/complete already do, in
  -- case removing this person's still-pending status was the only thing
  -- holding the aggregate at PARTIALLY_ACCEPTED/PARTIALLY_COMPLETED.
  perform public.staff_recompute_task_status(p_task_id);

  perform public.staff_write_audit('task', p_task_id, 'REMOVE_SECOND_ASSIGNEE', jsonb_build_object('removed_assignee', v_old_row.user_id), jsonb_build_object('reason', p_reason), v_task.to_department_id, p_reason);
  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  values (v_old_row.user_id, 'task', p_task_id, 'You have been removed from a task: ' || v_task.title, 'તમને કામમાંથી દૂર કરવામાં આવ્યા છે: ' || v_task.title);
end;
$function$;

-- Shared aggregate recompute, used by staff_remove_second_assignee (accept/
-- start/complete already recompute inline right after their own write).
create or replace function public.staff_recompute_task_status(p_task_id uuid)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_old_code text; v_status_id uuid; v_active_count int; v_accepted_count int; v_completed_count int; v_task public.staff_tasks%rowtype;
begin
  select * into v_task from public.staff_tasks where id = p_task_id;
  select code into v_old_code from public.status_master where id = v_task.status_id;
  if v_old_code not in ('ASSIGNED','ACCEPTED','PARTIALLY_ACCEPTED','IN_PROGRESS','PARTIALLY_COMPLETED') then
    return; -- already COMPLETED/VERIFIED/CLOSED/RETURNED -- nothing to recompute
  end if;

  select count(*), count(*) filter (where acceptance_status = 'ACCEPTED'), count(*) filter (where individual_status = 'COMPLETED')
    into v_active_count, v_accepted_count, v_completed_count
    from public.staff_task_assignees where task_id = p_task_id and is_active;

  if v_active_count = 0 then return; end if;

  if v_completed_count = v_active_count then
    select id into v_status_id from public.status_master where code = 'COMPLETED';
  elsif v_accepted_count = v_active_count and v_old_code not in ('IN_PROGRESS','PARTIALLY_COMPLETED') then
    select id into v_status_id from public.status_master where code = 'ACCEPTED';
  elsif v_accepted_count > 0 and v_accepted_count < v_active_count then
    select id into v_status_id from public.status_master where code = 'PARTIALLY_ACCEPTED';
  else
    return;
  end if;

  update public.staff_tasks set status_id = v_status_id where id = p_task_id;
end;
$function$;

create or replace function public.staff_set_task_blocked(p_task_id uuid, p_blocked boolean, p_note text)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_assignee_count int; v_my_row record;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;

  select count(*) into v_assignee_count from public.staff_task_assignees where task_id = p_task_id and is_active;

  if v_assignee_count <= 1 then
    -- Single-assignee: unchanged existing concept (staff_request_help).
    update public.staff_tasks set help_requested = p_blocked where id = p_task_id;
    perform public.staff_write_audit('task', p_task_id, 'BLOCKED', null, jsonb_build_object('help_requested', p_blocked, 'note', p_note), v_task.to_department_id, p_note);
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_task.assigned_by, 'task', p_task_id, 'Help requested on task: ' || v_task.task_number, 'કામ પર મદદ માંગી: ' || v_task.task_number);
    return;
  end if;

  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;
  if v_my_row.id is null then
    raise exception 'You are not an active assignee on this task';
  end if;

  update public.staff_task_assignees set individual_status = case when p_blocked then 'BLOCKED' else 'IN_PROGRESS' end where id = v_my_row.id;

  perform public.staff_write_audit('task', p_task_id, 'BLOCKED', jsonb_build_object('user_id', auth.uid()), jsonb_build_object('blocked', p_blocked, 'note', p_note), v_task.to_department_id, p_note);
  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  values (v_task.assigned_by, 'task', p_task_id,
    case when p_blocked then 'An assignee is blocked on task: ' || v_task.task_number else 'An assignee resumed work on task: ' || v_task.task_number end,
    case when p_blocked then 'એક વ્યક્તિ કામ પર અટકી ગઈ: ' || v_task.task_number else 'એક વ્યક્તિએ કામ ફરી શરૂ કર્યું: ' || v_task.task_number end);
end;
$function$;
