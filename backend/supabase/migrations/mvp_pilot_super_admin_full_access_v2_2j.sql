-- Mood of Wood — Staff Pilot — Super Admin full access: tasks, roster,
-- role changes, department management.
--
-- Continues the pattern from mvp_pilot_super_admin_access_v2_2g.sql: the
-- SAME systemic gap (staff_is_management() checked everywhere, sysadmin
-- checked nowhere) also existed in every task-lifecycle RPC and the
-- roster RPC — not just table RLS. Fixed here, in the SAME narrow way:
-- staff_is_super_admin() added ONLY where staff_is_management() already
-- had an override branch (return/verify/close/reassign, the supervisory
-- actions) — accept/start/complete intentionally have NO management
-- override today (they represent the assignee's own work), so none is
-- added for Super Admin either; extending that would be a bigger, separate
-- decision than "match what Management already has."
--
-- Also adds:
--   - staff_update_user_role(): the one real gap UserCreation.jsx exposed
--     — there was no way to change an existing user's role at all, by
--     anyone, ever. Sysadmin may set any role; Management may set any
--     role except sysadmin (matches the existing role_creation_rules
--     spirit: a Dept Head can never create/promote to Management/CFO/
--     Accounts Head/System Admin — Management itself stops one level
--     short of minting a new System Admin).
--   - staff_create_department() / staff_update_department(): Super Admin-
--     only. "Delete" is deliberately NOT offered — a department is
--     referenced by user_profiles/staff_tasks/bridges/task_types across
--     the whole app; is_active := false (already supported) is the safe
--     equivalent, matching how a user is "deleted" via deactivation, not
--     a real DELETE.
--
-- Idempotent (CREATE OR REPLACE FUNCTION). No table, column, or existing
-- row is altered.

CREATE OR REPLACE FUNCTION public.staff_list_department_roster()
RETURNS TABLE(id uuid, employee_code text, full_name text, phone text, department_id uuid, role_code text, role_name_en text, role_name_gu text, is_active boolean, must_change_password boolean, created_at timestamp with time zone)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_role text := public.staff_current_role_code();
  v_caller_department uuid := public.staff_current_department_id();
BEGIN
  PERFORM public.staff_assert_operational();
  RETURN QUERY
  SELECT up.id, up.employee_code, up.full_name, up.phone, up.department_id, r.code, r.name_en, r.name_gu, up.is_active, up.must_change_password, up.created_at
  FROM public.user_profiles up
  JOIN public.roles r ON r.id = up.role_id
  WHERE (
    v_caller_role IN ('management', 'sysadmin')
    OR (v_caller_role = 'dept_head' AND public.staff_dept_in_hod_scope(up.department_id))
    OR (v_caller_role IN ('accounts_head','cfo') AND up.department_id = v_caller_department)
  )
  ORDER BY up.full_name;
END;
$function$;

CREATE OR REPLACE FUNCTION public.staff_close_task(p_task_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_task public.staff_tasks%ROWTYPE; v_old_code text; v_status_id uuid;
BEGIN
  PERFORM public.staff_assert_operational();
  SELECT * INTO v_task FROM public.staff_tasks WHERE id = p_task_id FOR UPDATE;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;
  SELECT code INTO v_old_code FROM public.status_master WHERE id = v_task.status_id;
  IF v_old_code <> 'VERIFIED' THEN
    RAISE EXCEPTION 'Task must be VERIFIED to close (currently %)', v_old_code;
  END IF;
  IF NOT (
    v_task.verifier_id = auth.uid() OR public.staff_is_management() OR public.staff_is_super_admin()
    OR (public.staff_is_dept_head() AND public.staff_dept_in_hod_scope(v_task.to_department_id))
  ) THEN
    RAISE EXCEPTION 'You are not authorized to close this task';
  END IF;

  SELECT id INTO v_status_id FROM public.status_master WHERE code = 'CLOSED';
  UPDATE public.staff_tasks SET status_id = v_status_id, closed_by = auth.uid() WHERE id = p_task_id;

  IF v_task.is_bridge THEN
    UPDATE public.bridges SET closed_at = now() WHERE task_id = p_task_id;
  END IF;

  PERFORM public.staff_write_audit('task', p_task_id, 'CLOSE', jsonb_build_object('status', v_old_code), jsonb_build_object('status','CLOSED'), v_task.to_department_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.staff_verify_task(p_task_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_task public.staff_tasks%ROWTYPE; v_old_code text; v_status_id uuid;
BEGIN
  PERFORM public.staff_assert_operational();
  SELECT * INTO v_task FROM public.staff_tasks WHERE id = p_task_id FOR UPDATE;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;
  SELECT code INTO v_old_code FROM public.status_master WHERE id = v_task.status_id;
  IF v_old_code <> 'COMPLETED' THEN
    RAISE EXCEPTION 'Task must be COMPLETED to verify (currently %)', v_old_code;
  END IF;
  IF NOT (
    v_task.verifier_id = auth.uid() OR public.staff_is_management() OR public.staff_is_super_admin()
    OR (public.staff_is_dept_head() AND public.staff_dept_in_hod_scope(v_task.to_department_id))
  ) THEN
    RAISE EXCEPTION 'You are not authorized to verify this task';
  END IF;

  SELECT id INTO v_status_id FROM public.status_master WHERE code = 'VERIFIED';
  UPDATE public.staff_tasks SET status_id = v_status_id, verified_by = auth.uid() WHERE id = p_task_id;

  IF v_task.is_bridge THEN
    UPDATE public.bridges SET verified_by = auth.uid(), verified_at = now() WHERE task_id = p_task_id;
  END IF;

  PERFORM public.staff_write_audit('task', p_task_id, 'VERIFY', jsonb_build_object('status', v_old_code), jsonb_build_object('status','VERIFIED'), v_task.to_department_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.staff_return_task(p_task_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_task public.staff_tasks%ROWTYPE; v_old_code text; v_status_id uuid; v_allowed boolean := false;
BEGIN
  PERFORM public.staff_assert_operational();
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A return reason is required';
  END IF;

  SELECT * INTO v_task FROM public.staff_tasks WHERE id = p_task_id FOR UPDATE;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;
  SELECT code INTO v_old_code FROM public.status_master WHERE id = v_task.status_id;

  IF v_old_code = 'ASSIGNED' THEN
    v_allowed := (v_task.assigned_to = auth.uid()) OR public.staff_is_super_admin();
  ELSIF v_old_code IN ('ACCEPTED','IN_PROGRESS') THEN
    v_allowed := (v_task.current_owner_id = auth.uid()) OR public.staff_is_super_admin();
  ELSIF v_old_code = 'COMPLETED' THEN
    v_allowed := (v_task.verifier_id = auth.uid() OR public.staff_is_management() OR public.staff_is_super_admin()
                  OR (public.staff_is_dept_head() AND public.staff_dept_in_hod_scope(v_task.to_department_id)));
  ELSE
    RAISE EXCEPTION 'Task cannot be returned from status %', v_old_code;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'You are not authorized to return this task at its current stage';
  END IF;

  SELECT id INTO v_status_id FROM public.status_master WHERE code = 'RETURNED';
  UPDATE public.staff_tasks SET status_id = v_status_id, return_reason = p_reason WHERE id = p_task_id;

  IF v_task.is_bridge THEN
    UPDATE public.bridges SET acceptance_status = 'RETURNED', return_reason = p_reason WHERE task_id = p_task_id;
  END IF;

  PERFORM public.staff_write_audit('task', p_task_id, 'RETURN', jsonb_build_object('status', v_old_code), jsonb_build_object('status','RETURNED','reason',p_reason), v_task.to_department_id);
  INSERT INTO public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  VALUES (v_task.assigned_by, 'task', p_task_id, 'Task returned: ' || v_task.task_number, 'કામ પરત: ' || v_task.task_number);
END;
$function$;

CREATE OR REPLACE FUNCTION public.staff_reassign_task(p_task_id uuid, p_reason text, p_new_assigned_to uuid DEFAULT NULL::uuid, p_new_verifier_id uuid DEFAULT NULL::uuid, p_new_to_department_id uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_task public.staff_tasks%ROWTYPE; v_old_code text; v_old_assignee uuid; v_new_dept uuid;
  v_new_verifier_role text; v_new_verifier_department uuid;
  v_caller_role text;
  v_new_to_department_id uuid; v_dept_changed boolean; v_new_is_bridge boolean;
  v_from_confidential boolean; v_new_to_confidential boolean;
BEGIN
  PERFORM public.staff_assert_operational();
  v_caller_role := public.staff_current_role_code();

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required for reassignment';
  END IF;

  SELECT * INTO v_task FROM public.staff_tasks WHERE id = p_task_id FOR UPDATE;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;
  SELECT code INTO v_old_code FROM public.status_master WHERE id = v_task.status_id;

  IF v_old_code NOT IN ('ASSIGNED','RETURNED','ACCEPTED','IN_PROGRESS') THEN
    RAISE EXCEPTION 'Task cannot be reassigned from status % — only ASSIGNED, RETURNED, ACCEPTED, or IN_PROGRESS may be reassigned', v_old_code;
  END IF;

  IF NOT (
    public.staff_is_management() OR public.staff_is_super_admin()
    OR (public.staff_is_dept_head() AND public.staff_dept_in_hod_scope(v_task.to_department_id))
  ) THEN
    RAISE EXCEPTION 'You are not authorized to reassign this task';
  END IF;

  v_old_assignee := v_task.assigned_to;
  v_new_to_department_id := COALESCE(p_new_to_department_id, v_task.to_department_id);
  v_dept_changed := (p_new_to_department_id IS NOT NULL AND p_new_to_department_id IS DISTINCT FROM v_task.to_department_id);

  IF v_dept_changed THEN
    IF NOT EXISTS (SELECT 1 FROM public.departments WHERE id = v_new_to_department_id AND is_active = true) THEN
      RAISE EXCEPTION 'Invalid destination department';
    END IF;
    IF p_new_assigned_to IS NULL THEN
      RAISE EXCEPTION 'A new assignee is required when changing the destination department';
    END IF;

    SELECT is_confidential_domain INTO v_from_confidential FROM public.departments WHERE id = v_task.from_department_id;
    SELECT is_confidential_domain INTO v_new_to_confidential FROM public.departments WHERE id = v_new_to_department_id;
    v_new_is_bridge := (v_task.from_department_id <> v_new_to_department_id);

    IF v_new_is_bridge THEN
      IF v_from_confidential OR v_new_to_confidential THEN
        RAISE EXCEPTION 'Cross-department Bridges into/out of a confidential department are disabled in this pilot';
      END IF;
    ELSE
      IF v_from_confidential AND v_caller_role NOT IN ('management','cfo','accounts_head','accounts_employee','sysadmin') THEN
        RAISE EXCEPTION 'Only Accounts roles, Management, or Super Admin may reassign a task within a confidential department';
      END IF;
    END IF;
  END IF;

  IF p_new_assigned_to IS NOT NULL THEN
    SELECT department_id INTO v_new_dept FROM public.user_profiles WHERE id = p_new_assigned_to AND is_active = true;
    IF v_new_dept IS NULL THEN RAISE EXCEPTION 'Invalid or inactive new assignee'; END IF;
    IF v_new_dept IS DISTINCT FROM v_new_to_department_id THEN
      RAISE EXCEPTION 'New assignee must belong to the destination department';
    END IF;
  END IF;

  IF p_new_verifier_id IS NOT NULL THEN
    v_new_verifier_role := public.staff_user_role_code(p_new_verifier_id);
    IF v_new_verifier_role IS NULL THEN
      RAISE EXCEPTION 'Invalid or inactive new verifier';
    END IF;
    SELECT department_id INTO v_new_verifier_department FROM public.user_profiles WHERE id = p_new_verifier_id;
    IF NOT (
      v_new_verifier_role = 'management'
      OR v_new_verifier_department = v_new_to_department_id
      OR (v_new_verifier_role = 'dept_head' AND public.staff_user_dept_in_hod_scope(p_new_verifier_id, v_new_to_department_id))
    ) THEN
      RAISE EXCEPTION 'new verifier is not authorized for the destination department';
    END IF;
  ELSIF v_dept_changed THEN
    v_new_verifier_role := public.staff_user_role_code(v_task.verifier_id);
    SELECT department_id INTO v_new_verifier_department FROM public.user_profiles WHERE id = v_task.verifier_id;
    IF NOT (
      v_task.verifier_id = v_task.assigned_by
      OR v_new_verifier_role = 'management'
      OR v_new_verifier_department = v_new_to_department_id
      OR (v_new_verifier_role = 'dept_head' AND public.staff_user_dept_in_hod_scope(v_task.verifier_id, v_new_to_department_id))
    ) THEN
      RAISE EXCEPTION 'The existing verifier is not authorized for the new destination department — specify a new verifier';
    END IF;
  END IF;

  UPDATE public.staff_tasks SET
    to_department_id = v_new_to_department_id,
    is_bridge = CASE WHEN v_dept_changed THEN v_new_is_bridge ELSE is_bridge END,
    assigned_to = COALESCE(p_new_assigned_to, assigned_to),
    verifier_id = COALESCE(p_new_verifier_id, verifier_id),
    current_owner_id = CASE
      WHEN p_new_assigned_to IS NOT NULL AND (v_old_code IN ('ACCEPTED','IN_PROGRESS') OR v_dept_changed) THEN p_new_assigned_to
      ELSE current_owner_id
    END
  WHERE id = p_task_id;

  IF v_dept_changed THEN
    IF v_new_is_bridge THEN
      IF v_task.is_bridge THEN
        UPDATE public.bridges SET
          to_department_id = v_new_to_department_id,
          to_person_id = p_new_assigned_to
        WHERE task_id = p_task_id;
      ELSE
        INSERT INTO public.bridges AS inserted_bridge (task_id, from_department_id, to_department_id, from_person_id, to_person_id, requirement_text)
        VALUES (p_task_id, v_task.from_department_id, v_new_to_department_id, auth.uid(), p_new_assigned_to, COALESCE(v_task.description, v_task.title));
      END IF;
    ELSE
      UPDATE public.bridges SET is_active = false WHERE task_id = p_task_id AND is_active = true;
    END IF;
  ELSIF v_task.is_bridge AND p_new_assigned_to IS NOT NULL THEN
    UPDATE public.bridges SET to_person_id = p_new_assigned_to WHERE task_id = p_task_id;
  END IF;

  PERFORM public.staff_write_audit('task', p_task_id, 'REASSIGN',
    jsonb_build_object('assigned_to', v_old_assignee, 'verifier_id', v_task.verifier_id, 'to_department_id', v_task.to_department_id, 'status', v_old_code),
    jsonb_build_object('assigned_to', COALESCE(p_new_assigned_to, v_old_assignee), 'verifier_id', COALESCE(p_new_verifier_id, v_task.verifier_id), 'to_department_id', v_new_to_department_id, 'reason', p_reason),
    v_new_to_department_id, p_reason);

  IF p_new_assigned_to IS NOT NULL AND p_new_assigned_to <> v_old_assignee THEN
    INSERT INTO public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    VALUES (v_old_assignee, 'task', p_task_id, 'Reassigned away from you: ' || v_task.task_number, 'તમારી પાસેથી ફરીથી સોંપાયું: ' || v_task.task_number);
    INSERT INTO public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    VALUES (p_new_assigned_to, 'task', p_task_id, 'Task reassigned to you: ' || v_task.task_number, 'તમને કામ ફરીથી સોંપાયું: ' || v_task.task_number);
  END IF;
END;
$function$;

-- New: change an existing user's role. Sysadmin -> any role. Management ->
-- any role except sysadmin (mirrors role_creation_rules never letting a
-- Dept Head mint Management/CFO/Accounts Head/System Admin — Management
-- itself stops one level short of minting a new System Admin).
CREATE OR REPLACE FUNCTION public.staff_update_user_role(p_user_id uuid, p_new_role_code text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_role text := public.staff_current_role_code();
  v_new_role_id uuid;
  v_old_role_code text;
BEGIN
  PERFORM public.staff_assert_operational();

  IF v_caller_role NOT IN ('sysadmin', 'management') THEN
    RAISE EXCEPTION 'Only Super Admin or Management may change a user''s role';
  END IF;
  IF v_caller_role = 'management' AND p_new_role_code = 'sysadmin' THEN
    RAISE EXCEPTION 'Management may not grant the System Admin role';
  END IF;

  SELECT id INTO v_new_role_id FROM public.roles WHERE code = p_new_role_code AND is_active = true;
  IF v_new_role_id IS NULL THEN RAISE EXCEPTION 'Unknown or inactive role code'; END IF;

  SELECT r.code INTO v_old_role_code FROM public.user_profiles up JOIN public.roles r ON r.id = up.role_id WHERE up.id = p_user_id;
  IF v_old_role_code IS NULL THEN RAISE EXCEPTION 'User not found'; END IF;

  UPDATE public.user_profiles SET role_id = v_new_role_id WHERE id = p_user_id;
  PERFORM public.staff_write_audit('user_profile', p_user_id, 'ROLE_CHANGE', jsonb_build_object('role', v_old_role_code), jsonb_build_object('role', p_new_role_code), NULL);
END;
$function$;

-- New: department management, Super Admin only. Create + update — no
-- delete (a department is referenced across user_profiles/staff_tasks/
-- bridges/task_types; is_active := false via staff_update_department is
-- the safe equivalent, same pattern as deactivating a user).
CREATE OR REPLACE FUNCTION public.staff_create_department(
  p_code text, p_name_en text, p_name_gu text,
  p_department_group_id uuid DEFAULT NULL, p_parent_department_id uuid DEFAULT NULL,
  p_head_role_code text DEFAULT 'dept_head', p_is_confidential_domain boolean DEFAULT false
)
RETURNS public.departments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_dept public.departments;
BEGIN
  PERFORM public.staff_assert_operational();
  IF public.staff_current_role_code() <> 'sysadmin' THEN
    RAISE EXCEPTION 'Only Super Admin may create a department';
  END IF;
  IF p_code IS NULL OR btrim(p_code) = '' OR p_name_en IS NULL OR btrim(p_name_en) = '' OR p_name_gu IS NULL OR btrim(p_name_gu) = '' THEN
    RAISE EXCEPTION 'code, name_en, and name_gu are required';
  END IF;

  INSERT INTO public.departments (code, name_en, name_gu, department_group_id, parent_department_id, head_role_code, is_confidential_domain, is_control_tower, is_active)
  VALUES (upper(btrim(p_code)), p_name_en, p_name_gu, p_department_group_id, p_parent_department_id, p_head_role_code, p_is_confidential_domain, false, true)
  RETURNING * INTO v_dept;

  PERFORM public.staff_write_audit('department', v_dept.id, 'CREATE', NULL, jsonb_build_object('code', v_dept.code, 'name_en', v_dept.name_en), NULL);
  RETURN v_dept;
END;
$function$;

CREATE OR REPLACE FUNCTION public.staff_update_department(
  p_department_id uuid, p_name_en text DEFAULT NULL, p_name_gu text DEFAULT NULL,
  p_is_active boolean DEFAULT NULL, p_department_group_id uuid DEFAULT NULL, p_parent_department_id uuid DEFAULT NULL
)
RETURNS public.departments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_dept public.departments;
BEGIN
  PERFORM public.staff_assert_operational();
  IF public.staff_current_role_code() <> 'sysadmin' THEN
    RAISE EXCEPTION 'Only Super Admin may modify a department';
  END IF;

  UPDATE public.departments SET
    name_en = COALESCE(p_name_en, name_en),
    name_gu = COALESCE(p_name_gu, name_gu),
    is_active = COALESCE(p_is_active, is_active),
    department_group_id = CASE WHEN p_department_group_id IS NOT NULL THEN p_department_group_id ELSE department_group_id END,
    parent_department_id = CASE WHEN p_parent_department_id IS NOT NULL THEN p_parent_department_id ELSE parent_department_id END
  WHERE id = p_department_id
  RETURNING * INTO v_dept;

  IF v_dept.id IS NULL THEN RAISE EXCEPTION 'Department not found'; END IF;
  PERFORM public.staff_write_audit('department', p_department_id, 'UPDATE', NULL, jsonb_build_object('name_en', v_dept.name_en, 'is_active', v_dept.is_active), NULL);
  RETURN v_dept;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.staff_update_user_role(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_create_department(text, text, text, uuid, uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_update_department(uuid, text, text, boolean, uuid, uuid) TO authenticated;
