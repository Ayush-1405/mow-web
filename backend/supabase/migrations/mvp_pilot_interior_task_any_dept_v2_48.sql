-- mvp_pilot_interior_task_any_dept_v2_48
-- Broadens the Project/Site field from mvp_pilot_interior_task_site_v2_45:
-- that round only showed/required it when From Department = Interior
-- (Interior assigning its own work). This round adds the explicitly
-- different, additive scenario named here: ANY department creating a
-- Bridge task INTO Interior (Accounts -> Interior, Purchase -> Interior,
-- Management Control Tower -> Interior, etc.) may OPTIONALLY tag a
-- project/site too -- and, per this round's repeated explicit instruction
-- ("Project selection must remain optional... must be able to create a
-- general Interior task without selecting a project"), the field is now
-- optional universally, including for Interior's own task creation --
-- superseding v2_45's mandatory-when-from-Interior rule. Disclosed
-- explicitly in the delivery summary, not a silent behavior change.
--
-- Investigated live before writing this: staff_create_task's existing
-- project-authorization check required interior_is_org_wide() or
-- interior_is_project_member() -- which would correctly reject a Purchase/
-- Accounts employee tagging ANY project, since they're neither. The new
-- spec's PERMISSIONS section explicitly asks for this to be relaxed (any
-- authorized task-creator may tag a project — selecting one is just an FK
-- reference on an already-authorized task, not a grant of project access)
-- while explicitly keeping full project data (files/payments/reports)
-- behind the EXISTING projects_select_scoped RLS, untouched here.

-- ---------------------------------------------------------------------
-- 1. Minimal, broadly-accessible project directory for task-assignment
--    selection ONLY -- id/code/customer/location, nothing else (no
--    remarks, next_action, project_value, or any other column). Any
--    operational user may call this; it is NOT a replacement for
--    projects_select_scoped, which still gates the real `projects` table
--    and everything richer (files, payments, timeline, etc.).
-- ---------------------------------------------------------------------
create or replace function public.staff_list_interior_project_options()
returns table(id uuid, project_code text, customer text, location text)
language plpgsql stable security definer set search_path to 'public' as $function$
begin
  perform public.staff_assert_operational();
  return query
    select p.id, p.project_code, p.customer, p.location
    from public.projects p
    where p.archived = false
    order by p.project_code;
end;
$function$;

grant execute on function public.staff_list_interior_project_options() to authenticated;

-- ---------------------------------------------------------------------
-- 2. staff_create_task: drop the from=Interior-mandatory rule, relax the
--    project-tag authorization to "exists and active" (matching the new
--    minimal-selection permission model), and re-wire the notification
--    text to the two exact bilingual templates this round specifies,
--    scoped to to_department=Interior so every other department's
--    existing notification wording is completely unchanged.
-- ---------------------------------------------------------------------
create or replace function public.staff_create_task(
  p_title text, p_description text, p_task_type_code text, p_priority_code text, p_proof_type_code text,
  p_from_department_id uuid, p_to_department_id uuid, p_assigned_to uuid, p_due_date date,
  p_due_time time without time zone default null, p_verifier_id uuid default null,
  p_reference_number text default null, p_requirement_text text default null, p_quantity text default null,
  p_second_assignee uuid default null, p_project_id uuid default null
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
  v_interior_dept_id uuid;
  v_project_code text; v_project_customer text; v_project_location text; v_project_archived boolean;
  v_title_en text; v_title_gu text;
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
    if v_from_confidential and v_caller_role not in ('management', 'sysadmin', 'cfo', 'accounts_head', 'accounts_employee') then
      raise exception 'Only Accounts roles or Management may create tasks within a confidential department';
    end if;
  end if;

  if v_caller_role in ('employee', 'supervisor') then
    if p_from_department_id <> v_caller_department then
      raise exception 'You may only create tasks from your own department';
    end if;
  elsif v_caller_role = 'dept_head' then
    if not public.staff_dept_in_hod_scope(p_from_department_id) then
      raise exception 'from_department is outside your authorized scope';
    end if;
  elsif v_caller_role in ('management', 'sysadmin') then
    null;
  elsif v_caller_role in ('cfo', 'accounts_head', 'accounts_employee') then
    if p_from_department_id <> v_caller_department then
      raise exception 'Accounts roles may only create tasks within their own Accounts department';
    end if;
  else
    raise exception 'Your role is not authorized to create tasks in this pilot';
  end if;

  select id into v_interior_dept_id from public.departments where code = 'INTERIOR';

  -- Project/Site: always optional, for every department, including
  -- Interior itself (supersedes v2_45's from=Interior-mandatory rule).
  -- Validated (exists + active) whenever provided, but NOT gated by
  -- Interior project membership/org-wide — any caller who is already
  -- authorized to create THIS task (checked above) may tag a project on
  -- it; tagging a project is metadata, not a grant of project access.
  if p_project_id is not null then
    select project_code, customer, location, archived into v_project_code, v_project_customer, v_project_location, v_project_archived
      from public.projects where id = p_project_id;
    if v_project_code is null then
      raise exception 'Invalid Project/Site';
    end if;
    if v_project_archived then
      raise exception 'This Project/Site is archived and cannot receive new tasks. / આ પ્રોજેક્ટ/સાઇટ આર્કાઇવ કરેલ છે અને નવા કાર્યો સ્વીકારી શકાતી નથી.';
    end if;
  end if;

  select department_id into v_assignee_department from public.user_profiles where id = p_assigned_to and is_active = true;
  if v_assignee_department is null then
    raise exception 'Invalid or inactive assignee';
  end if;
  if v_assignee_department is distinct from p_to_department_id then
    raise exception 'assigned_to must belong to the selected destination department';
  end if;

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
    if v_caller_role in ('management', 'sysadmin', 'dept_head') then
      null;
    elsif v_caller_role in ('employee', 'supervisor')
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
    or v_verifier_role in ('management', 'sysadmin')
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
    current_owner_id, reference_number, requirement_text, quantity, due_date, due_time,
    project_id, source_module
  ) values (
    p_title, p_description, v_task_type_id, v_priority_id, v_status_id, v_proof_type_id,
    p_from_department_id, p_to_department_id, v_caller, p_assigned_to, v_verifier,
    p_assigned_to, p_reference_number, p_requirement_text, p_quantity, p_due_date, p_due_time,
    p_project_id, case when p_project_id is not null then 'assign_task' else null end
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
    jsonb_build_object('task_number', v_task_number, 'is_bridge', v_is_bridge, 'assigned_to', p_assigned_to, 'second_assignee', p_second_assignee, 'project_id', p_project_id, 'from_department_id', p_from_department_id, 'to_department_id', p_to_department_id), p_to_department_id);

  -- Notification text: Interior-directed tasks (any source department) get
  -- this round's two exact templates; every other department keeps the
  -- byte-for-byte original wording (zero behavior change for them).
  if p_to_department_id = v_interior_dept_id then
    if p_project_id is not null then
      v_title_en := 'New task assigned: ' || p_title || ' — ' || v_project_code || ' / ' || v_project_customer;
      v_title_gu := 'નવું કામ સોંપાયું: ' || p_title || ' — ' || v_project_code || ' / ' || v_project_customer;
    else
      v_title_en := 'New general Interior task assigned: ' || p_title;
      v_title_gu := 'નવું સામાન્ય ઇન્ટિરિયર કાર્ય સોંપાયું: ' || p_title;
    end if;
  else
    v_title_en := case when p_second_assignee is not null then 'You have been assigned a new task as Primary Assignee: ' || p_title else 'New task assigned: ' || v_task_number end;
    v_title_gu := case when p_second_assignee is not null then 'તમને મુખ્ય જવાબદાર તરીકે નવું કામ સોંપવામાં આવ્યું છે: ' || p_title else 'નવું કામ સોંપાયું: ' || v_task_number end;
  end if;

  insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
  values (p_assigned_to, 'task', v_task_id, v_task_id, v_title_en, v_title_gu);

  if p_second_assignee is not null then
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
    values (
      p_second_assignee, 'task', v_task_id, v_task_id,
      case when p_to_department_id = v_interior_dept_id then v_title_en else 'You have been added to a task as Second Assignee: ' || p_title end,
      case when p_to_department_id = v_interior_dept_id then v_title_gu else 'તમને બીજી જવાબદાર વ્યક્તિ તરીકે કામમાં ઉમેરવામાં આવ્યા છે: ' || p_title end
    );
  end if;

  return query select v_task_id, v_task_number, v_bridge_id, v_bridge_number;
end;
$function$;

-- ---------------------------------------------------------------------
-- 3. staff_change_task_project: same relaxation (project must simply
--    exist and be active — no Interior-membership gate on the corrector),
--    consistent with the new permission model. The actor-authorization
--    check just above it (assigner/dept head/management) is untouched.
-- ---------------------------------------------------------------------
create or replace function public.staff_change_task_project(p_task_id uuid, p_new_project_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype;
  v_old_project_id uuid;
  v_old_code text; v_new_code text; v_old_customer text; v_new_customer text;
  v_actor_name text;
  v_recipient record;
begin
  perform public.staff_assert_operational();
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to change the Project/Site';
  end if;

  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;

  if not (
    v_task.assigned_by = auth.uid() or public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_task.to_department_id))
  ) then
    raise exception 'You are not authorized to change this task''s Project/Site';
  end if;

  select project_code, customer into v_new_code, v_new_customer from public.projects where id = p_new_project_id and archived = false;
  if v_new_code is null then
    raise exception 'Invalid or archived Project/Site';
  end if;

  v_old_project_id := v_task.project_id;
  if v_old_project_id is not null then
    select project_code, customer into v_old_code, v_old_customer from public.projects where id = v_old_project_id;
  end if;

  update public.staff_tasks set project_id = p_new_project_id where id = p_task_id;

  perform public.staff_write_audit('task', p_task_id, 'CHANGE_PROJECT',
    jsonb_build_object('project_id', v_old_project_id, 'project_code', v_old_code),
    jsonb_build_object('project_id', p_new_project_id, 'project_code', v_new_code, 'reason', p_reason),
    v_task.to_department_id, p_reason);

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();
  perform public.staff_post_system_task_message(p_task_id,
    'Project/Site corrected from ' || coalesce(v_old_code, '—') || ' to ' || v_new_code || ' by ' || v_actor_name || ': ' || p_reason,
    v_actor_name || ' દ્વારા પ્રોજેક્ટ/સાઇટ ' || coalesce(v_old_code, '—') || ' થી ' || v_new_code || ' માં સુધારાયું: ' || p_reason);

  for v_recipient in
    select distinct r.id from (
      select v_task.assigned_by as id
      union select v_task.verifier_id
      union select v_task.current_owner_id
      union select user_id from public.staff_task_assignees where task_id = p_task_id and is_active
    ) r
    where r.id is not null
      and exists (select 1 from public.user_profiles up where up.id = r.id and up.is_active = true)
  loop
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, sender_id, title_en, title_gu)
    values (v_recipient.id, 'task', p_task_id, p_task_id, auth.uid(),
      'Task Project/Site corrected to ' || v_new_code || ': ' || v_task.title,
      'કાર્યનું પ્રોજેક્ટ/સાઇટ ' || v_new_code || ' માં સુધારાયું: ' || v_task.title);
  end loop;
end;
$function$;
