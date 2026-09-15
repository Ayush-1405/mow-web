-- mvp_pilot_user_merge_delete_v2_46
-- Duplicate-user merge + secure soft-delete/restore for User Management.
--
-- Investigated live before writing this (pg_constraint / information_schema):
--   - user_profiles.id === auth.users.id (same UUID) throughout this app.
--   - Interior's own `profiles.id` is a SEPARATE id space, linked via
--     profiles.auth_id -> user_profiles.id (UNIQUE already enforced).
--   - Exactly two id spaces to repoint on a merge: auth-space
--     (user_profiles.id) and Interior-space (profiles.id).
--   - Comprehensive FK scan (information_schema.table_constraints /
--     constraint_column_usage) found every table+column referencing either
--     space -- ~100 columns across 60+ tables. Of those, exactly FOUR carry
--     a UNIQUE constraint on (entity, user) and need conflict-safe merge
--     logic rather than a plain UPDATE: staff_task_assignees(task_id,
--     user_id), task_message_reads(task_id,user_id),
--     project_members(project_id,profile_id), user_location_access(user_id,
--     location_id). Every other column is a plain attribution/ownership
--     column with no uniqueness risk.
--   - interior_sync_profile_from_user_profile() (existing trigger, Lead
--     Executive round) already keeps profiles.active in sync with
--     user_profiles.is_active -- deactivating the old user_profiles row
--     automatically deactivates its matching Interior profiles row too, so
--     this migration never touches profiles.active directly.
--   - "Prevent future login" in this app's actual architecture IS
--     user_profiles.is_active=false -- staff_assert_operational() and every
--     Edge Function (staff-login included) already gate on it. No need to
--     touch auth.users or the service-role Admin API for this feature.

-- ---------------------------------------------------------------------
-- 1. user_profiles gains merge/soft-delete tracking columns (additive,
--    nullable -- zero impact on any existing row).
-- ---------------------------------------------------------------------
alter table public.user_profiles
  add column if not exists is_deleted boolean not null default false,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.user_profiles(id),
  add column if not exists deletion_reason_code text,
  add column if not exists deletion_reason_note text,
  add column if not exists merged_into_user_id uuid references public.user_profiles(id),
  add column if not exists archived_at timestamptz,
  add column if not exists restored_at timestamptz,
  add column if not exists restored_by uuid references public.user_profiles(id),
  add column if not exists restore_reason text;

create index if not exists user_profiles_is_deleted_idx on public.user_profiles(is_deleted);
create index if not exists user_profiles_merged_into_idx on public.user_profiles(merged_into_user_id) where merged_into_user_id is not null;

-- Case-insensitive uniqueness at the database level -- closes the one real
-- gap in an otherwise already-solid defense (staff-create-user already
-- normalizes to upper(trim()) and pre-checks via .ilike() before insert;
-- this is the last-resort DB-level backstop against a race between two
-- simultaneous creates that differ only by case).
create unique index if not exists user_profiles_employee_code_ci_idx on public.user_profiles (upper(employee_code));

-- ---------------------------------------------------------------------
-- 2. Internal transfer helper -- NOT exposed to authenticated directly
--    (REVOKEd below). Moves every operational reference from p_old_user_id
--    to p_new_user_id across BOTH id spaces, conflict-safely on the four
--    unique-constrained relationship tables, and returns a table+column
--    -wise row-count report. Used by both staff_merge_duplicate_user and
--    staff_delete_user (when a replacement employee is given).
-- ---------------------------------------------------------------------
create or replace function public.staff_transfer_user_data(p_old_user_id uuid, p_new_user_id uuid)
returns table(table_name text, column_name text, rows_moved bigint)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_old_profile_id uuid;
  v_new_profile_id uuid;
  v_pair text[];
  v_col text;
  v_count bigint;
  v_row record;
  v_conflict_count bigint;
  v_conflicted_task_ids uuid[] := '{}';
  -- Simple auth-space (user_profiles.id) columns -- plain repoint, no
  -- uniqueness risk. staff_tasks is handled separately below (it must
  -- exclude any task flagged as a staff_task_assignees conflict).
  v_auth_cols text[][] := array[
    array['bridges','from_person_id'], array['bridges','to_person_id'], array['bridges','verified_by'],
    array['interior_payment_records','created_by'], array['interior_pilot_audit_log','performed_by'],
    array['notifications','recipient_id'], array['notifications','sender_id'],
    array['push_subscriptions','user_id'],
    array['retail_complaints','assigned_to'], array['retail_complaints','created_by'],
    array['retail_leads','assigned_to'], array['retail_leads','created_by'],
    array['retail_orders','created_by'], array['retail_payments','created_by'], array['retail_quotations','created_by'],
    array['retail_sales_targets','created_by'], array['retail_sales_targets','user_id'],
    array['retail_store_ops_logs','created_by'],
    array['retail_vm_tasks','assigned_to'], array['retail_vm_tasks','created_by'],
    array['staff_attachments','uploaded_by'], array['staff_audit_log','performed_by'],
    array['task_messages','deleted_by'], array['task_messages','sender_id'],
    array['user_profiles','created_by'], array['user_profiles','reports_to']
  ];
  -- Interior-space (profiles.id) columns -- plain repoint.
  v_profile_cols text[][] := array[
    array['activity_logs','user_id'], array['attachments','deleted_by'], array['attachments','restored_by'], array['attachments','uploaded_by'],
    array['customer_feedback','created_by'],
    array['design_approvals','decided_by'], array['design_briefs','created_by'], array['design_briefs','updated_by'],
    array['design_change_requests','requested_by'], array['design_locks','exception_by'], array['design_locks','locked_by'],
    array['design_versions','created_by'], array['design_versions','submitted_by'],
    array['drawing_checklist_results','checked_by'], array['drawing_issues','issued_by'], array['drawing_versions','created_by'],
    array['handovers','updated_by'],
    array['inhouse_production_requests','assigned_factory_coordinator'], array['inhouse_production_requests','current_responsible_person'], array['inhouse_production_requests','submitted_by'],
    array['material_selection_attachments','uploaded_by'],
    array['material_selections','approved_by'], array['material_selections','created_by'], array['material_selections','responsible_designer_id'], array['material_selections','updated_by'],
    array['materials','created_by'],
    array['project_changes','approved_by'], array['project_materials','requested_by'], array['project_requests','created_by'],
    array['projects','created_by'], array['projects','designer_id'], array['projects','execution_id'], array['projects','executive_assistant_id'], array['projects','lead_executive_id'], array['projects','project_manager_id'],
    array['purchase_approvals','decided_by'], array['purchase_approvals','submitted_by'],
    array['purchase_attachments','uploaded_by'],
    array['purchase_checklist_results','checked_by'], array['purchase_checklist_results','responsible_person'],
    array['purchase_costing','created_by'], array['purchase_costing','updated_by'],
    array['purchase_orders','approved_by'], array['purchase_orders','created_by'],
    array['purchase_payment_coordination','created_by'],
    array['purchase_receipts','created_by'], array['purchase_receipts','received_by'],
    array['purchase_requests','assigned_purchase_person'], array['purchase_requests','created_by'], array['purchase_requests','requested_by'], array['purchase_requests','updated_by'],
    array['purchase_vendor_selections','approved_by'],
    array['site_reports','submitted_by'], array['snags','assigned_to'],
    array['tasks','assigned_to'], array['tasks','created_by'],
    array['vendor_followups','created_by'], array['vendor_quotations','created_by'], array['vendors','created_by'],
    array['working_drawing_areas','assigned_designer_id'], array['working_drawing_areas','created_by'],
    array['working_drawing_attachments','deleted_by'], array['working_drawing_attachments','restored_by'], array['working_drawing_attachments','uploaded_by'],
    array['working_drawings','approved_by'], array['working_drawings','checked_by'], array['working_drawings','created_by'], array['working_drawings','prepared_by']
  ];
begin
  if p_old_user_id = p_new_user_id then
    raise exception 'Cannot transfer a user''s data to themselves';
  end if;

  select id into v_old_profile_id from public.profiles where auth_id = p_old_user_id;
  select id into v_new_profile_id from public.profiles where auth_id = p_new_user_id;

  -- ---- staff_task_assignees (unique task_id,user_id) ----
  -- Same task, both old and new already active on it, DIFFERENT roles
  -- (e.g. old=Primary, new=Secondary or vice versa): flagged for manual
  -- review, never silently reassigned -- per the explicit "flag it for
  -- review instead of silently changing responsibility" requirement. Any
  -- such task is also excluded from the staff_tasks scalar-column repoint
  -- below, so assigned_to/current_owner_id never drifts out of sync with
  -- the (deliberately untouched) staff_task_assignees row.
  v_conflict_count := 0;
  for v_row in
    select o.task_id, o.id as old_row_id, o.assignment_role as old_role, n.id as new_row_id, n.assignment_role as new_role
    from public.staff_task_assignees o
    left join public.staff_task_assignees n on n.task_id = o.task_id and n.user_id = p_new_user_id and n.is_active
    where o.user_id = p_old_user_id and o.is_active
  loop
    if v_row.new_row_id is null then
      update public.staff_task_assignees set user_id = p_new_user_id where id = v_row.old_row_id;
    elsif v_row.old_role = v_row.new_role then
      -- Defensive only (blocked by a unique partial index for 'primary');
      -- retire the old duplicate row, keep the surviving one.
      update public.staff_task_assignees set is_active = false, removed_at = now(), removed_by = auth.uid(), removal_reason = 'Merged duplicate account' where id = v_row.old_row_id;
    else
      v_conflict_count := v_conflict_count + 1;
      v_conflicted_task_ids := array_append(v_conflicted_task_ids, v_row.task_id);
    end if;
  end loop;
  table_name := 'staff_task_assignees'; column_name := 'user_id'; rows_moved := (select count(*) from public.staff_task_assignees where user_id = p_new_user_id);
  return next;
  if v_conflict_count > 0 then
    table_name := 'staff_task_assignees'; column_name := 'CONFLICT_role_mismatch_needs_review'; rows_moved := v_conflict_count;
    return next;
  end if;

  -- staff_tasks: same generic repoint as v_auth_cols, but excluding any
  -- task with an unresolved staff_task_assignees conflict above.
  foreach v_col in array array['assigned_by','assigned_to','closed_by','current_owner_id','delay_responsible_user_id','previous_owner_id','verified_by','verifier_id'] loop
    execute format('update public.staff_tasks set %I = $1 where %I = $2 and not (id = any($3))', v_col, v_col)
      using p_new_user_id, p_old_user_id, v_conflicted_task_ids;
    get diagnostics v_count = row_count;
    if v_count > 0 then
      table_name := 'staff_tasks'; column_name := v_col; rows_moved := v_count;
      return next;
    end if;
  end loop;

  -- ---- task_message_reads (unique task_id,user_id) ----
  for v_row in
    select o.task_id, o.id as old_row_id, o.last_read_at as old_read, n.id as new_row_id, n.last_read_at as new_read
    from public.task_message_reads o
    left join public.task_message_reads n on n.task_id = o.task_id and n.user_id = p_new_user_id
    where o.user_id = p_old_user_id
  loop
    if v_row.new_row_id is null then
      update public.task_message_reads set user_id = p_new_user_id where id = v_row.old_row_id;
    else
      if v_row.old_read > v_row.new_read then
        update public.task_message_reads set last_read_at = v_row.old_read where id = v_row.new_row_id;
      end if;
      delete from public.task_message_reads where id = v_row.old_row_id;
    end if;
  end loop;
  table_name := 'task_message_reads'; column_name := 'user_id'; rows_moved := (select count(*) from public.task_message_reads where user_id = p_new_user_id);
  return next;

  -- ---- user_location_access (unique user_id,location_id) ----
  for v_row in
    select o.location_id, o.id as old_row_id, o.access_type as old_type, n.id as new_row_id
    from public.user_location_access o
    left join public.user_location_access n on n.location_id = o.location_id and n.user_id = p_new_user_id
    where o.user_id = p_old_user_id
  loop
    if v_row.new_row_id is null then
      update public.user_location_access set user_id = p_new_user_id where id = v_row.old_row_id;
    else
      if v_row.old_type = 'primary' then
        update public.user_location_access set access_type = 'primary' where id = v_row.new_row_id;
      end if;
      delete from public.user_location_access where id = v_row.old_row_id;
    end if;
  end loop;
  table_name := 'user_location_access'; column_name := 'user_id'; rows_moved := (select count(*) from public.user_location_access where user_id = p_new_user_id);
  return next;

  -- ---- Remaining simple auth-space columns ----
  foreach v_pair slice 1 in array v_auth_cols loop
    execute format('update public.%I set %I = $1 where %I = $2', v_pair[1], v_pair[2], v_pair[2])
      using p_new_user_id, p_old_user_id;
    get diagnostics v_count = row_count;
    if v_count > 0 then
      table_name := v_pair[1]; column_name := v_pair[2]; rows_moved := v_count;
      return next;
    end if;
  end loop;

  -- ---- Interior-space (profiles.id) ----
  if v_old_profile_id is not null and v_new_profile_id is not null then
    -- project_members (unique project_id,profile_id)
    for v_row in
      select o.project_id, o.id as old_row_id, n.id as new_row_id
      from public.project_members o
      left join public.project_members n on n.project_id = o.project_id and n.profile_id = v_new_profile_id
      where o.profile_id = v_old_profile_id
    loop
      if v_row.new_row_id is null then
        update public.project_members set profile_id = v_new_profile_id where id = v_row.old_row_id;
      else
        delete from public.project_members where id = v_row.old_row_id;
      end if;
    end loop;
    table_name := 'project_members'; column_name := 'profile_id'; rows_moved := (select count(*) from public.project_members where profile_id = v_new_profile_id);
    return next;

    foreach v_pair slice 1 in array v_profile_cols loop
      execute format('update public.%I set %I = $1 where %I = $2', v_pair[1], v_pair[2], v_pair[2])
        using v_new_profile_id, v_old_profile_id;
      get diagnostics v_count = row_count;
      if v_count > 0 then
        table_name := v_pair[1]; column_name := v_pair[2]; rows_moved := v_count;
        return next;
      end if;
    end loop;
  end if;

  return;
end;
$function$;

revoke all on function public.staff_transfer_user_data(uuid, uuid) from public;

-- ---------------------------------------------------------------------
-- 3. staff_merge_duplicate_user -- Super Admin only, transactional
--    (a PL/pgSQL function body IS the transaction -- any RAISE rolls back
--    everything already done inside it).
-- ---------------------------------------------------------------------
create or replace function public.staff_merge_duplicate_user(p_old_employee_code text, p_surviving_employee_code text, p_reason text)
returns table(table_name text, column_name text, rows_moved bigint)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_old record; v_new record;
  v_old_code text := upper(btrim(p_old_employee_code));
  v_new_code text := upper(btrim(p_surviving_employee_code));
begin
  perform public.staff_assert_operational();
  if not public.staff_is_super_admin() then
    raise exception 'Only Super Admin may merge duplicate user accounts';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception 'A detailed merge reason (at least 10 characters) is required';
  end if;

  select * into v_old from public.user_profiles where upper(employee_code) = v_old_code for update;
  if v_old.id is null then raise exception 'Old employee code % not found', v_old_code; end if;
  select * into v_new from public.user_profiles where upper(employee_code) = v_new_code for update;
  if v_new.id is null then raise exception 'Surviving employee code % not found', v_new_code; end if;
  if v_old.id = v_new.id then raise exception 'Old and surviving employee codes resolve to the same user'; end if;
  if v_old.is_deleted then raise exception 'Employee % has already been merged/deleted', v_old_code; end if;
  if not v_new.is_active or v_new.is_deleted then raise exception 'Surviving employee % is not active', v_new_code; end if;

  return query select * from public.staff_transfer_user_data(v_old.id, v_new.id);

  update public.user_profiles set
    is_active = false, is_deleted = true, deleted_at = now(), deleted_by = auth.uid(),
    deletion_reason_code = 'duplicate_user', deletion_reason_note = p_reason,
    merged_into_user_id = v_new.id, archived_at = now()
  where id = v_old.id;

  perform public.staff_write_audit('user_merge', v_new.id, 'MERGE',
    jsonb_build_object('old_employee_code', v_old_code, 'old_user_id', v_old.id, 'old_full_name', v_old.full_name),
    jsonb_build_object('surviving_employee_code', v_new_code, 'surviving_user_id', v_new.id, 'surviving_full_name', v_new.full_name, 'reason', p_reason),
    v_new.department_id, p_reason);

  insert into public.interior_pilot_audit_log (table_name, record_id, action, detail, performed_by)
  values ('user_profiles', v_new.id, 'merge_duplicate_user',
    jsonb_build_object(
      'note', v_old_code || ' was merged into ' || v_new_code || '.',
      'old_employee_code', v_old_code, 'old_user_id', v_old.id,
      'surviving_employee_code', v_new_code, 'surviving_user_id', v_new.id,
      'reason', p_reason
    ), auth.uid());
end;
$function$;

revoke all on function public.staff_merge_duplicate_user(text, text, text) from public;
grant execute on function public.staff_merge_duplicate_user(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Deletion-impact preview (for the confirmation modal) + secure delete.
-- ---------------------------------------------------------------------
create or replace function public.staff_user_deletion_impact(p_user_id uuid)
returns table(open_task_count bigint, active_project_count bigint, assigned_project_count bigint, created_data_count bigint, requires_replacement boolean)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_profile_id uuid;
  v_open_tasks bigint; v_active_projects bigint; v_assigned_projects bigint; v_created bigint;
begin
  perform public.staff_assert_operational();
  if not (public.staff_is_management() or public.staff_is_super_admin()) then
    raise exception 'Not authorized';
  end if;

  select id into v_profile_id from public.profiles where auth_id = p_user_id;

  select count(*) into v_open_tasks from public.staff_tasks st
    join public.status_master sm on sm.id = st.status_id
    where (st.assigned_to = p_user_id or st.current_owner_id = p_user_id or st.verifier_id = p_user_id)
      and sm.code not in ('CLOSED');

  select count(*) into v_active_projects from public.projects p
    where v_profile_id is not null and p.archived = false
      and v_profile_id in (p.lead_executive_id, p.executive_assistant_id, p.project_manager_id);

  select count(*) into v_assigned_projects from public.project_members pm
    join public.projects p on p.id = pm.project_id
    where v_profile_id is not null and pm.profile_id = v_profile_id and p.archived = false;

  select count(*) into v_created from public.staff_tasks where assigned_by = p_user_id;

  return query select v_open_tasks, v_active_projects, v_assigned_projects, v_created,
    (v_open_tasks > 0 or v_active_projects > 0 or v_assigned_projects > 0);
end;
$function$;

grant execute on function public.staff_user_deletion_impact(uuid) to authenticated;

create or replace function public.staff_delete_user(p_user_id uuid, p_reason_code text, p_reason_note text, p_replacement_user_id uuid default null)
returns table(table_name text, column_name text, rows_moved bigint)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_caller uuid := auth.uid();
  v_target record; v_replacement record;
  v_caller_role text; v_target_role text;
  v_impact record;
  v_active_sysadmins int;
begin
  perform public.staff_assert_operational();
  v_caller_role := public.staff_current_role_code();
  if not (public.staff_is_management() or public.staff_is_super_admin()) then
    raise exception 'Only Management or Super Admin may delete a user';
  end if;
  if p_reason_code is null or btrim(p_reason_code) = '' then
    raise exception 'A deletion reason is required';
  end if;
  if p_reason_note is null or length(btrim(p_reason_note)) < 10 then
    raise exception 'A detailed reason (at least 10 characters) is required';
  end if;
  if p_user_id = v_caller then
    raise exception 'You cannot delete your own account';
  end if;

  select * into v_target from public.user_profiles where id = p_user_id for update;
  if v_target.id is null then raise exception 'User not found'; end if;
  if v_target.is_deleted then raise exception 'This user has already been deleted'; end if;

  v_target_role := public.staff_user_role_code(p_user_id);

  if v_target_role in ('sysadmin', 'management') and not public.staff_is_super_admin() then
    raise exception 'Only Super Admin may delete a Management or Super Admin account';
  end if;

  if v_target_role = 'sysadmin' then
    select count(*) into v_active_sysadmins from public.user_profiles up
      join public.roles r on r.id = up.role_id
      where r.code = 'sysadmin' and up.is_active = true and up.is_deleted = false and up.id <> p_user_id;
    if v_active_sysadmins = 0 then
      raise exception 'Cannot delete the last active Super Admin account';
    end if;
  end if;

  select * into v_impact from public.staff_user_deletion_impact(p_user_id);

  if v_impact.requires_replacement and p_replacement_user_id is null then
    raise exception 'This user has active responsibilities (% open task(s), % active project role(s), % project membership(s)) — a Replacement Employee is required before deletion',
      v_impact.open_task_count, v_impact.active_project_count, v_impact.assigned_project_count;
  end if;

  if p_replacement_user_id is not null then
    select * into v_replacement from public.user_profiles where id = p_replacement_user_id;
    if v_replacement.id is null or not v_replacement.is_active or v_replacement.is_deleted then
      raise exception 'Replacement employee is invalid or inactive';
    end if;
    if v_replacement.id = p_user_id then
      raise exception 'Replacement employee must be different from the user being deleted';
    end if;
    return query select * from public.staff_transfer_user_data(p_user_id, p_replacement_user_id);
  end if;

  update public.user_profiles set
    is_active = false, is_deleted = true, deleted_at = now(), deleted_by = v_caller,
    deletion_reason_code = p_reason_code, deletion_reason_note = p_reason_note,
    merged_into_user_id = p_replacement_user_id, archived_at = now()
  where id = p_user_id;

  perform public.staff_write_audit('user_profiles', p_user_id, 'DELETE_USER',
    jsonb_build_object('employee_code', v_target.employee_code, 'full_name', v_target.full_name),
    jsonb_build_object('reason_code', p_reason_code, 'reason_note', p_reason_note, 'replacement_user_id', p_replacement_user_id),
    v_target.department_id, p_reason_note);
end;
$function$;

revoke all on function public.staff_delete_user(uuid, text, text, uuid) from public;
grant execute on function public.staff_delete_user(uuid, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Restore (undo a soft-delete/deactivation -- NOT an "undo merge").
-- ---------------------------------------------------------------------
create or replace function public.staff_list_deleted_users()
returns table(id uuid, employee_code text, full_name text, department_id uuid, role_id uuid, deleted_at timestamptz, deleted_by uuid, deletion_reason_code text, deletion_reason_note text, merged_into_user_id uuid, merged_into_employee_code text)
language plpgsql security definer set search_path to 'public' as $function$
begin
  perform public.staff_assert_operational();
  if not (public.staff_is_management() or public.staff_is_super_admin()) then
    raise exception 'Not authorized';
  end if;
  return query
    select up.id, up.employee_code, up.full_name, up.department_id, up.role_id, up.deleted_at, up.deleted_by,
           up.deletion_reason_code, up.deletion_reason_note, up.merged_into_user_id, m.employee_code
    from public.user_profiles up
    left join public.user_profiles m on m.id = up.merged_into_user_id
    where up.is_deleted = true
    order by up.deleted_at desc;
end;
$function$;

grant execute on function public.staff_list_deleted_users() to authenticated;

create or replace function public.staff_restore_user(p_user_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_target record; v_dup_count int;
begin
  perform public.staff_assert_operational();
  if not public.staff_is_super_admin() then
    raise exception 'Only Super Admin may restore a deleted user';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception 'A restore reason (at least 10 characters) is required';
  end if;

  select * into v_target from public.user_profiles where id = p_user_id for update;
  if v_target.id is null then raise exception 'User not found'; end if;
  if not v_target.is_deleted then raise exception 'This user is not deleted'; end if;
  if v_target.merged_into_user_id is not null then
    raise exception 'This account was merged into another surviving account — restoring it requires an explicit Undo Merge workflow, not a plain restore';
  end if;

  select count(*) into v_dup_count from public.user_profiles
    where upper(employee_code) = upper(v_target.employee_code) and is_active = true and is_deleted = false and id <> p_user_id;
  if v_dup_count > 0 then
    raise exception 'Employee code % is already in use by another active user', v_target.employee_code;
  end if;

  update public.user_profiles set
    is_active = true, is_deleted = false, restored_at = now(), restored_by = auth.uid(), restore_reason = p_reason
  where id = p_user_id;

  perform public.staff_write_audit('user_profiles', p_user_id, 'RESTORE_USER',
    jsonb_build_object('was_deleted_at', v_target.deleted_at, 'deletion_reason_note', v_target.deletion_reason_note),
    jsonb_build_object('restore_reason', p_reason), v_target.department_id, p_reason);
end;
$function$;

revoke all on function public.staff_restore_user(uuid, text) from public;
grant execute on function public.staff_restore_user(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Roster/active-user visibility: exclude soft-deleted users everywhere
--    the app already lists "active" employees, without touching any
--    existing RLS clause (purely an additive is_deleted=false filter).
-- ---------------------------------------------------------------------
create or replace function public.staff_list_assignable_users_all()
 RETURNS TABLE(id uuid, employee_code text, full_name text, department_id uuid, role_label_en text, role_label_gu text, is_active boolean)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
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
  where up.is_active = true and up.is_deleted = false
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

create or replace function public.interior_list_active_employees()
returns table(id uuid, auth_id uuid, name text, employee_code text, role text, role_label_en text, role_label_gu text, department_name text, active boolean)
language sql stable security definer set search_path to 'public' as $$
  select p.id, p.auth_id, p.name, up.employee_code, p.role, r.name_en, r.name_gu, d.name_en, p.active
  from public.profiles p
  left join public.user_profiles up on up.id = p.auth_id
  left join public.roles r on r.id = up.role_id
  left join public.departments d on d.id = up.department_id
  where p.active = true and (up.id is null or (up.is_active = true and up.is_deleted = false))
  order by p.name;
$$;
