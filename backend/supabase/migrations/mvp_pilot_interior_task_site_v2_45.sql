-- mvp_pilot_interior_task_site_v2_45
-- Project/Site-wise task assignment for the Interior Projects Department,
-- layered onto the GENERAL Assign Task flow (staff_create_task /
-- AssignTask.jsx) -- staff_tasks.project_id, its RLS branch, and the
-- separate staff_create_project_task RPC (used only by Daily Site Update)
-- already existed from mvp_pilot_daily_update_tasks_v2_38.sql; this
-- migration is what's actually missing: the MAIN Assign Task path has
-- never accepted or validated a project_id at all. projects_select_scoped
-- (interior_is_org_wide() OR interior_is_project_member(id)) already
-- implements the exact authorized-project-list rule this feature needs, so
-- the dropdown itself needs no new RLS -- only staff_create_task's
-- SERVER-SIDE validation is genuinely new here.

-- ---------------------------------------------------------------------
-- 1. staff_create_task: add p_project_id. Must DROP the old 15-arg
--    signature first -- CREATE OR REPLACE with one new trailing default
--    parameter creates a SECOND overload instead of replacing it (the
--    exact ambiguous-overload trap this session already hit once with
--    staff_complete_task) -- confirmed the current live signature via
--    pg_get_functiondef before writing this DROP.
-- ---------------------------------------------------------------------
drop function public.staff_create_task(text,text,text,text,text,uuid,uuid,uuid,date,time without time zone,uuid,text,text,text,uuid);

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

  -- Project/Site (Interior Projects Department). Required whenever the
  -- task originates FROM Interior; validated server-side regardless of
  -- department if a project_id is passed at all -- project name/client/
  -- location are NEVER trusted from the frontend, only looked up here by
  -- id. A caller who is neither org-wide nor a member of the chosen
  -- project is rejected even if they somehow submit its id directly.
  select id into v_interior_dept_id from public.departments where code = 'INTERIOR';
  if p_from_department_id = v_interior_dept_id and p_project_id is null then
    raise exception 'Select Project/Site is required for Interior Projects tasks. / ઇન્ટિરિયર કાર્યો માટે પ્રોજેક્ટ/સાઇટ પસંદ કરવું જરૂરી છે.';
  end if;
  if p_project_id is not null then
    select project_code, customer, location, archived into v_project_code, v_project_customer, v_project_location, v_project_archived
      from public.projects where id = p_project_id;
    if v_project_code is null then
      raise exception 'Invalid Project/Site';
    end if;
    if v_project_archived then
      raise exception 'This Project/Site is archived and cannot receive new tasks. / આ પ્રોજેક્ટ/સાઇટ આર્કાઇવ કરેલ છે અને નવા કાર્યો સ્વીકારી શકાતી નથી.';
    end if;
    if not (public.interior_is_org_wide() or public.interior_is_project_member(p_project_id)) then
      raise exception 'You are not authorized to assign tasks on this Project/Site';
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
    jsonb_build_object('task_number', v_task_number, 'is_bridge', v_is_bridge, 'assigned_to', p_assigned_to, 'second_assignee', p_second_assignee, 'project_id', p_project_id), p_to_department_id);

  -- Assignment notifications: when project-linked, lead with the
  -- Project/Site context exactly as specified ("New task assigned for
  -- MOW-105 — Sattya Choudhary, Vadodara: {Task Title}"); otherwise
  -- byte-for-byte the original non-project text (zero behavior change for
  -- every other department).
  if p_project_id is not null then
    v_title_en := 'New task assigned for ' || v_project_code || ' — ' || v_project_customer || coalesce(', ' || nullif(v_project_location, ''), '') || ': ' || p_title;
    v_title_gu := v_project_code || ' — ' || v_project_customer || coalesce(', ' || nullif(v_project_location, ''), '') || ' માટે નવું કામ સોંપાયું: ' || p_title;
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
      case when p_project_id is not null then v_title_en else 'You have been added to a task as Second Assignee: ' || p_title end,
      case when p_project_id is not null then v_title_gu else 'તમને બીજી જવાબદાર વ્યક્તિ તરીકે કામમાં ઉમેરવામાં આવ્યા છે: ' || p_title end
    );
  end if;

  return query select v_task_id, v_task_number, v_bridge_id, v_bridge_number;
end;
$function$;

-- ---------------------------------------------------------------------
-- 2. staff_send_task_message: reply notifications now include the
--    Project/Site context when the task is project-linked. Same
--    signature, no overload risk -- CREATE OR REPLACE only changes the
--    notification-title construction; every other line is unchanged from
--    the version verified live in the previous round.
-- ---------------------------------------------------------------------

create or replace function public.staff_send_task_message(
  p_task_id uuid,
  p_message_text text,
  p_reply_to_message_id uuid default null,
  p_attachment_metadata jsonb default null
)
returns table(
  id uuid, task_id uuid, sender_id uuid, message_text text, reply_to_message_id uuid, message_type text,
  attachment_name text, attachment_path text, attachment_type text, attachment_size bigint,
  voice_path text, voice_duration_seconds integer, is_edited boolean, edited_at timestamptz, created_at timestamptz
)
language plpgsql security definer set search_path to 'public' as $function$
#variable_conflict use_column
declare
  v_task public.staff_tasks%rowtype;
  v_text text := btrim(coalesce(p_message_text, ''));
  v_kind text;
  v_storage_path text;
  v_filename text;
  v_file_type text;
  v_file_size bigint;
  v_duration integer;
  v_storage_obj record;
  v_message_type text;
  v_message_id uuid;
  v_actor_name text;
  v_preview text;
  v_title_en text;
  v_title_gu text;
  v_recipient record;
  v_project_code text; v_project_customer text;
  v_task_ref text;
begin
  perform public.staff_assert_operational();

  if not public.staff_task_visible(p_task_id) then
    raise exception 'Task not found or not accessible';
  end if;
  select * into v_task from public.staff_tasks where id = p_task_id;

  if p_reply_to_message_id is not null and not exists (
    select 1 from public.task_messages where id = p_reply_to_message_id and task_id = p_task_id
  ) then
    raise exception 'The message being replied to does not belong to this task';
  end if;

  if p_attachment_metadata is not null then
    v_kind := p_attachment_metadata->>'kind';
    if v_kind not in ('attachment', 'voice') then
      raise exception 'Invalid attachment metadata';
    end if;
    v_storage_path := p_attachment_metadata->>'storage_path';
    v_filename := p_attachment_metadata->>'filename';
    v_file_type := p_attachment_metadata->>'file_type';
    v_file_size := (p_attachment_metadata->>'file_size')::bigint;
    v_duration := nullif(p_attachment_metadata->>'duration_seconds', '')::integer;

    if v_storage_path is null or v_filename is null or v_file_type is null or v_file_size is null or v_file_size <= 0 then
      raise exception 'Incomplete attachment metadata';
    end if;
    if v_storage_path not like (auth.uid()::text || '/%') then
      raise exception 'storage_path must be under your own upload prefix';
    end if;
    if v_kind = 'voice' and (v_duration is null or v_duration <= 0 or v_duration > 60) then
      raise exception 'Voice messages must be between 1 and 60 seconds';
    end if;

    select * into v_storage_obj from storage.objects where bucket_id = 'staff-attachments' and name = v_storage_path;
    if v_storage_obj.id is null then
      raise exception 'No uploaded object found at storage_path — refusing to record an unverified attachment';
    end if;
    if v_storage_obj.metadata ? 'size' and (v_storage_obj.metadata->>'size')::bigint <> v_file_size then
      raise exception 'Declared file_size does not match the uploaded object';
    end if;

    v_message_type := v_kind;
  else
    v_message_type := 'text';
  end if;

  if v_text = '' and p_attachment_metadata is null then
    raise exception 'A message, attachment, or voice message is required. / સંદેશ, ફાઇલ અથવા વોઇસ મેસેજ જરૂરી છે.';
  end if;

  if v_text <> '' and exists (
    select 1 from public.task_messages
    where task_id = p_task_id and sender_id = auth.uid() and message_text = v_text
      and created_at > now() - interval '5 seconds'
  ) then
    raise exception 'This message was already sent. / આ સંદેશ પહેલેથી મોકલાયો છે.';
  end if;

  insert into public.task_messages (
    task_id, sender_id, message_text, reply_to_message_id, message_type,
    attachment_name, attachment_path, attachment_type, attachment_size,
    voice_path, voice_duration_seconds
  ) values (
    p_task_id, auth.uid(), nullif(v_text, ''), p_reply_to_message_id, v_message_type,
    case when v_kind = 'attachment' then v_filename end,
    case when v_kind = 'attachment' then v_storage_path end,
    case when v_kind = 'attachment' then v_file_type end,
    case when v_kind = 'attachment' then v_file_size end,
    case when v_kind = 'voice' then v_storage_path end,
    case when v_kind = 'voice' then v_duration end
  ) returning task_messages.id into v_message_id;

  perform public.staff_write_audit('task_message', v_message_id, 'CREATE', null,
    jsonb_build_object('task_id', p_task_id, 'message_type', v_message_type), v_task.to_department_id);

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  v_task_ref := v_task.task_number;
  if v_task.project_id is not null then
    select project_code, customer into v_project_code, v_project_customer from public.projects where id = v_task.project_id;
    if v_project_code is not null then
      v_task_ref := v_task.task_number || ' (' || v_project_code || ' — ' || v_project_customer || ')';
    end if;
  end if;

  if v_text <> '' then
    v_preview := left(v_text, 60) || case when length(v_text) > 60 then '…' else '' end;
    v_title_en := v_actor_name || ' replied on task ' || v_task_ref || ': ' || v_preview;
    v_title_gu := v_actor_name || ' એ કાર્ય ' || v_task_ref || ' પર જવાબ આપ્યો: ' || v_preview;
  elsif v_kind = 'voice' then
    v_title_en := v_actor_name || ' sent a voice reply on task ' || v_task_ref || '.';
    v_title_gu := v_actor_name || ' એ કાર્ય ' || v_task_ref || ' પર વોઇસ જવાબ મોકલ્યો.';
  else
    v_title_en := v_actor_name || ' shared a file on task ' || v_task_ref || '.';
    v_title_gu := v_actor_name || ' એ કાર્ય ' || v_task_ref || ' પર ફાઇલ શેર કરી.';
  end if;

  for v_recipient in
    select distinct r.id from (
      select v_task.assigned_by as id
      union select v_task.verifier_id
      union select v_task.current_owner_id
      union select user_id from public.staff_task_assignees where task_id = p_task_id and is_active
    ) r
    where r.id is not null and r.id <> auth.uid()
      and exists (select 1 from public.user_profiles up where up.id = r.id and up.is_active = true)
  loop
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, sender_id, title_en, title_gu)
    values (v_recipient.id, 'task_message', v_message_id, p_task_id, auth.uid(), v_title_en, v_title_gu);
  end loop;

  return query
    select tm.id, tm.task_id, tm.sender_id, tm.message_text, tm.reply_to_message_id, tm.message_type,
           tm.attachment_name, tm.attachment_path, tm.attachment_type, tm.attachment_size,
           tm.voice_path, tm.voice_duration_seconds, tm.is_edited, tm.edited_at, tm.created_at
    from public.task_messages tm where tm.id = v_message_id;
end;
$function$;

-- ---------------------------------------------------------------------
-- 3. staff_change_task_project — corrects a wrongly-selected Project/Site
--    after creation. Restricted to the original assigner, Interior Dept
--    Head (in HOD scope), Management, or Super Admin — never a normal
--    assignee. Mandatory reason, full audit trail (old/new/who/when/why),
--    notifies every active participant, and posts a system message into
--    the task's own conversation (reusing staff_post_system_task_message
--    from the Reply/Conversation feature) so the correction is visible in
--    the same timeline everything else already lives in.
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
  if not (public.interior_is_org_wide() or public.interior_is_project_member(p_new_project_id)) then
    raise exception 'You are not authorized to assign tasks on this Project/Site';
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

-- ---------------------------------------------------------------------
-- 4. Indexes per spec §5 (project_id/created_at already exist from
--    v2_38/earlier FK-index migrations — these four are additive,
--    idempotent, and safe regardless).
-- ---------------------------------------------------------------------
create index if not exists staff_tasks_assigned_to_idx on public.staff_tasks(assigned_to);
create index if not exists staff_tasks_due_date_idx on public.staff_tasks(due_date);
create index if not exists staff_tasks_status_id_idx on public.staff_tasks(status_id);
create index if not exists staff_tasks_created_at_idx on public.staff_tasks(created_at);
