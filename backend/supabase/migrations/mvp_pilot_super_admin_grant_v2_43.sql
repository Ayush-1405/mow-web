-- Grants full Super Admin access to the confirmed MOW-CTR-001 account, and
-- completes several pre-existing gaps in sysadmin coverage discovered live
-- while verifying this would actually work end to end:
--   - staff_list_assignable_departments/_users_all/_users(uuid) never had a
--     sysadmin branch at all (one of them says so in its own comment: "every
--     other role (sysadmin,...) no branch above matches, so no rows are
--     returned") -- a Super Admin could not browse departments or the staff
--     directory, or (via staff_create_task) create/assign a task, at all.
--   - staff_tasks_select_scoped / staff_task_visible() / staff_record_
--     attachment() already grant sysadmin general access, but their
--     confidential-domain bypass clause only ever checked management/
--     accounts roles -- sysadmin was silently excluded from confidential
--     (Accounts & Finance) data despite the general clause allowing it.
-- Every change below is additive: existing roles' access is unchanged.

-- 1. Department + directory listing RPCs: sysadmin now gets the same
--    "every active department, including confidential" branch management has.
create or replace function public.staff_list_assignable_departments() returns table(
  id uuid, code text, name_en text, name_gu text, is_confidential_domain boolean, is_active boolean
)
language plpgsql stable security definer set search_path to 'public' as $function$
declare
  v_caller_role text := public.staff_current_role_code();
  v_caller_department uuid := public.staff_current_department_id();
begin
  perform public.staff_assert_operational();

  return query
  select d.id, d.code, d.name_en, d.name_gu, d.is_confidential_domain, d.is_active
  from public.departments d
  where d.is_active = true
    and (
      (v_caller_role in ('management', 'sysadmin'))
      or (v_caller_role in ('accounts_head', 'cfo', 'accounts_employee') and d.id = v_caller_department)
      or (v_caller_role in ('dept_head', 'supervisor', 'employee') and not d.is_confidential_domain)
    )
  order by d.code;
end;
$function$;

create or replace function public.staff_list_assignable_users_all() returns table(
  id uuid, employee_code text, full_name text, department_id uuid, role_label_en text, role_label_gu text, is_active boolean
)
language plpgsql stable security definer set search_path to 'public' as $function$
declare
  v_caller_role text := public.staff_current_role_code();
  v_caller_department uuid := public.staff_current_department_id();
begin
  perform public.staff_assert_operational();

  return query
  select up.id, up.employee_code, up.full_name, up.department_id, r.name_en, r.name_gu, up.is_active
  from public.user_profiles up
  join public.roles r on r.id = up.role_id
  join public.departments d on d.id = up.department_id
  where up.is_active = true
    and d.is_active = true
    and up.department_id is not null
    and (
      (v_caller_role in ('management', 'sysadmin'))
      or (v_caller_role in ('accounts_head', 'cfo', 'accounts_employee') and d.id = v_caller_department)
      or (v_caller_role in ('dept_head', 'supervisor', 'employee') and not d.is_confidential_domain)
    )
  order by d.code, up.full_name;
end;
$function$;

create or replace function public.staff_list_assignable_users(p_department_id uuid default null) returns table(
  id uuid, employee_code text, full_name text, department_id uuid, role_label_en text, role_label_gu text, is_active boolean
)
language plpgsql stable security definer set search_path to 'public' as $function$
declare
  v_target uuid := coalesce(p_department_id, public.staff_current_department_id());
  v_confidential boolean;
  v_caller_role text := public.staff_current_role_code();
begin
  perform public.staff_assert_operational();

  if not exists (select 1 from public.departments where id = v_target and is_active = true) then
    raise exception 'Invalid department';
  end if;
  select is_confidential_domain into v_confidential from public.departments where id = v_target;

  if public.staff_is_management() or public.staff_is_super_admin() then
    null;
  elsif v_caller_role in ('accounts_head', 'cfo', 'accounts_employee') then
    if v_target <> public.staff_current_department_id() then
      raise exception 'Accounts roles may only browse their own Accounts department directory';
    end if;
  elsif public.staff_is_dept_head() then
    if not public.staff_dept_in_hod_scope(v_target) then
      raise exception 'Department is outside your authorized scope';
    end if;
  else
    if v_confidential then
      raise exception 'This department''s directory is restricted';
    end if;
  end if;

  if v_confidential and not (public.staff_is_management() or public.staff_is_super_admin() or v_caller_role in ('accounts_head', 'cfo', 'accounts_employee')) then
    raise exception 'This department''s directory is restricted';
  end if;

  return query
  select up.id, up.employee_code, up.full_name, up.department_id, r.name_en, r.name_gu, up.is_active
  from public.user_profiles up
  join public.roles r on r.id = up.role_id
  where up.department_id = v_target and up.is_active = true
  order by up.full_name;
end;
$function$;

-- 2. staff_create_task: sysadmin can create/assign a task from any
--    from_department (same tier as management), and is exempt from the
--    same-department confidential restriction (same tier as Accounts roles/
--    management) -- matches "View and assign all tasks" / "View all Bridge
--    tasks". Every other branch, and the cross-department confidential
--    bridge prohibition (which applies even to management), is unchanged.
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

-- 3. Confidential-domain visibility parity for sysadmin (a deliberate,
--    explicitly-requested change -- confidential Accounts/Finance data was
--    previously restricted to Management/Accounts roles only, by design;
--    Super Admin now gets the same read access, transactional approval
--    workflows are untouched since neither of these is a write path).
create or replace function public.staff_task_visible(p_task_id uuid) returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.staff_tasks t
    where t.id = p_task_id
      and (
        t.assigned_by = auth.uid() or t.assigned_to = auth.uid() or t.current_owner_id = auth.uid() or t.verifier_id = auth.uid()
        or public.staff_is_management() or public.staff_is_super_admin()
        or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(t.from_department_id) or public.staff_dept_in_hod_scope(t.to_department_id)))
        or (public.staff_is_supervisor() and (t.from_department_id = public.staff_current_department_id() or t.to_department_id = public.staff_current_department_id()))
        or (public.staff_is_accounts_head() and (t.from_department_id = public.staff_current_department_id() or t.to_department_id = public.staff_current_department_id()))
        or (t.project_id is not null and (public.interior_is_org_wide() or public.interior_is_project_member(t.project_id)))
      )
      and not (
        exists (select 1 from public.departments d where d.id in (t.from_department_id, t.to_department_id) and d.is_confidential_domain = true)
        and not (public.staff_is_management() or public.staff_is_super_admin() or public.staff_is_accounts_head() or public.staff_current_role_code() in ('accounts_employee', 'cfo'))
      )
  );
$$;

drop policy if exists "staff_tasks_select_scoped" on public.staff_tasks;
create policy "staff_tasks_select_scoped" on public.staff_tasks for select using (
  staff_current_user_ok() and (
    assigned_by = auth.uid() or assigned_to = auth.uid() or current_owner_id = auth.uid() or verifier_id = auth.uid()
    or id in (select task_id from public.staff_task_assignees where user_id = auth.uid() and is_active)
    or staff_is_management() or staff_is_super_admin()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(from_department_id) or staff_dept_in_hod_scope(to_department_id)))
    or (staff_is_supervisor() and (from_department_id = staff_current_department_id() or to_department_id = staff_current_department_id()))
    or (staff_is_accounts_head() and (from_department_id = staff_current_department_id() or to_department_id = staff_current_department_id()))
    or (project_id is not null and (interior_is_org_wide() or interior_is_project_member(project_id)))
  ) and not (
    exists (select 1 from departments d where d.id = any(array[staff_tasks.from_department_id, staff_tasks.to_department_id]) and d.is_confidential_domain = true)
    and not (staff_is_management() or staff_is_super_admin() or staff_is_accounts_head() or staff_current_role_code() = any(array['accounts_employee'::text, 'cfo'::text]))
  )
);

create or replace function public.staff_record_attachment(
  p_entity_type text, p_entity_id uuid, p_file_type text, p_storage_path text,
  p_original_filename text, p_mime_type text, p_file_size bigint, p_duration_seconds integer default null
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype;
  v_bridge public.bridges%rowtype;
  v_has_access boolean := false;
  v_confidential boolean := false;
  v_attachment_id uuid;
  v_max_bytes bigint := 20 * 1024 * 1024;
  v_storage_obj record;
  v_base_mime text := split_part(p_mime_type, ';', 1);
begin
  perform public.staff_assert_operational();

  if p_file_type not in ('image','pdf','word','excel','drawing','voice') then
    raise exception 'Unsupported file_type';
  end if;
  if p_file_size is null or p_file_size <= 0 or p_file_size > v_max_bytes then
    raise exception 'File size invalid or exceeds the pilot limit';
  end if;
  if (p_file_type = 'image' and p_mime_type not in ('image/jpeg','image/png','image/webp','image/heic','image/heif'))
     or (p_file_type = 'pdf' and p_mime_type <> 'application/pdf')
     or (p_file_type = 'word' and p_mime_type not in ('application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
     or (p_file_type = 'excel' and p_mime_type not in ('application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
     or (p_file_type = 'drawing' and p_mime_type not in ('application/dxf','application/dwg','image/vnd.dwg','image/vnd.dxf','application/x-dwg','application/x-dxf','application/acad'))
     or (p_file_type = 'voice' and v_base_mime not in ('audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav','audio/x-m4a','audio/aac'))
  then
    raise exception 'mime_type does not match file_type';
  end if;
  if p_file_type = 'voice' and (p_duration_seconds is null or p_duration_seconds <= 0 or p_duration_seconds > 60) then
    raise exception 'Voice messages must be between 1 and 60 seconds';
  end if;

  if p_storage_path not like (auth.uid()::text || '/%') then
    raise exception 'storage_path must be under your own upload prefix';
  end if;

  select * into v_storage_obj from storage.objects where bucket_id = 'staff-attachments' and name = p_storage_path;
  if v_storage_obj.id is null then
    raise exception 'No uploaded object found at storage_path — refusing to record unverified attachment metadata';
  end if;
  if v_storage_obj.metadata ? 'size' and (v_storage_obj.metadata->>'size')::bigint <> p_file_size then
    raise exception 'Declared file_size does not match the uploaded object';
  end if;
  if v_storage_obj.metadata ? 'mimetype' and v_storage_obj.metadata->>'mimetype' <> v_base_mime then
    raise exception 'Declared mime_type does not match the uploaded object';
  end if;

  if p_entity_type = 'task' then
    select * into v_task from public.staff_tasks where id = p_entity_id;
    if v_task.id is null then raise exception 'Parent task does not exist'; end if;
    v_has_access := (
      v_task.assigned_by = auth.uid() or v_task.assigned_to = auth.uid() or v_task.current_owner_id = auth.uid() or v_task.verifier_id = auth.uid()
      or public.staff_is_management() or public.staff_is_super_admin()
      or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(v_task.from_department_id) or public.staff_dept_in_hod_scope(v_task.to_department_id)))
      or (public.staff_is_accounts_head() and (v_task.from_department_id = public.staff_current_department_id() or v_task.to_department_id = public.staff_current_department_id()))
    );
    select true into v_confidential from public.departments d where d.id in (v_task.from_department_id, v_task.to_department_id) and d.is_confidential_domain = true limit 1;
  elsif p_entity_type = 'bridge' then
    select * into v_bridge from public.bridges where id = p_entity_id;
    if v_bridge.id is null then raise exception 'Parent bridge does not exist'; end if;
    v_has_access := (
      v_bridge.from_person_id = auth.uid() or v_bridge.to_person_id = auth.uid()
      or public.staff_is_management() or public.staff_is_super_admin()
      or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(v_bridge.from_department_id) or public.staff_dept_in_hod_scope(v_bridge.to_department_id)))
    );
  else
    raise exception 'Invalid entity_type';
  end if;

  if not v_has_access then
    raise exception 'You do not have access to attach files to this %', p_entity_type;
  end if;
  if coalesce(v_confidential, false) and not (public.staff_is_management() or public.staff_is_super_admin() or public.staff_is_accounts_head() or public.staff_current_role_code() in ('accounts_employee','cfo')) then
    raise exception 'Attachments on a confidential-domain task are restricted';
  end if;

  insert into public.staff_attachments (entity_type, entity_id, file_type, storage_path, original_filename, mime_type, file_size, duration_seconds, uploaded_by, is_confidential)
  values (p_entity_type, p_entity_id, p_file_type, p_storage_path, p_original_filename, p_mime_type, p_file_size, p_duration_seconds, auth.uid(), coalesce(v_confidential, false))
  returning id into v_attachment_id;

  perform public.staff_write_audit(p_entity_type, p_entity_id, 'ATTACH', null, jsonb_build_object('attachment_id', v_attachment_id, 'file_type', p_file_type), null);

  return v_attachment_id;
end;
$function$;

-- 4. The actual, one-time role grant -- resolved strictly by employee_code,
--    never by name. Idempotent (checking the current role before writing),
--    duplicate-safe (aborts with a clear exception instead of guessing),
--    audited.
do $$
declare
  v_matches int;
  v_user record;
  v_sysadmin_role_id uuid;
  v_control_tower_dept uuid;
  v_performed_by uuid;
begin
  -- Attributed to an existing authorised Management account (this pilot's
  -- one active 'management' user) rather than the affected user themselves
  -- or a NULL system actor (interior_pilot_audit_log.performed_by is
  -- NOT NULL and there is no dedicated system-actor concept). Falls back to
  -- the affected user's own id only if no Management account exists yet.
  select id into v_performed_by from public.user_profiles where role_id = (select id from public.roles where code = 'management') and is_active = true limit 1;
  select count(*) into v_matches from public.user_profiles where employee_code = 'MOW-CTR-001' and is_active = true;
  if v_matches = 0 then
    raise exception 'No active user found with employee_code = MOW-CTR-001 -- aborting, nothing changed';
  elsif v_matches > 1 then
    raise exception 'Duplicate active users found with employee_code = MOW-CTR-001 (% rows) -- aborting, resolve the duplicate before retrying', v_matches;
  end if;

  select * into v_user from public.user_profiles where employee_code = 'MOW-CTR-001' and is_active = true;

  select id into v_sysadmin_role_id from public.roles where code = 'sysadmin';
  if v_sysadmin_role_id is null then
    raise exception 'No role with code = sysadmin exists -- aborting, nothing changed';
  end if;

  select id into v_control_tower_dept from public.departments where code = 'CONTROL_TOWER';
  if v_user.department_id is distinct from v_control_tower_dept then
    raise exception 'Expected % (MOW-CTR-001) to be in Management Control Tower, found a different department -- aborting as a safety check', v_user.full_name;
  end if;

  if v_user.role_id = v_sysadmin_role_id then
    -- Already Super Admin -- idempotent no-op, no duplicate audit entry.
    return;
  end if;

  update public.user_profiles set role_id = v_sysadmin_role_id where id = v_user.id;

  insert into public.interior_pilot_audit_log (table_name, record_id, action, detail, project_id, performed_by)
  values ('user_profiles', v_user.id, 'grant_super_admin', jsonb_build_object(
    'employee_code', 'MOW-CTR-001',
    'user_id', v_user.id,
    'previous_role_id', v_user.role_id,
    'new_role_id', v_sysadmin_role_id,
    'previous_department_id', v_user.department_id,
    'current_department_id', v_user.department_id,
    'changed_by', coalesce(v_performed_by::text, 'system_migration'),
    'reason', 'Authorised Management Control Tower Super Admin access',
    'migration', 'mvp_pilot_super_admin_grant_v2_43'
  ), null, coalesce(v_performed_by, v_user.id));
end $$;
