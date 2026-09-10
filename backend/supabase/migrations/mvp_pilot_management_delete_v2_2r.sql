-- Broaden staff_delete_task: previously creator-only, now ALSO usable by
-- Management, Super Admin, or a Department Head whose HOD scope covers the
-- task's destination department — matching the same authorization shape
-- already used by staff_close_task / staff_verify_task in this file. A
-- plain employee who neither created the task nor holds one of those
-- roles is still refused (RAISE EXCEPTION, not silently ignored).
CREATE OR REPLACE FUNCTION public.staff_delete_task(p_task_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_task public.staff_tasks%ROWTYPE; v_old_code text;
BEGIN
  PERFORM public.staff_assert_operational();
  SELECT * INTO v_task FROM public.staff_tasks WHERE id = p_task_id FOR UPDATE;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;
  IF NOT v_task.is_active THEN RAISE EXCEPTION 'Task is already deleted'; END IF;

  IF NOT (
    v_task.assigned_by = auth.uid()
    OR public.staff_is_management()
    OR public.staff_is_super_admin()
    OR (public.staff_is_dept_head() AND public.staff_dept_in_hod_scope(v_task.to_department_id))
  ) THEN
    RAISE EXCEPTION 'Only the person who created this task, or Management/Admin/the Department Head, may delete it';
  END IF;

  SELECT code INTO v_old_code FROM public.status_master WHERE id = v_task.status_id;

  UPDATE public.staff_tasks SET is_active = false WHERE id = p_task_id;

  IF v_task.is_bridge THEN
    UPDATE public.bridges SET is_active = false WHERE task_id = p_task_id AND is_active = true;
  END IF;

  PERFORM public.staff_write_audit('task', p_task_id, 'DELETE',
    jsonb_build_object('status', v_old_code, 'is_active', true),
    jsonb_build_object('is_active', false),
    v_task.to_department_id);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.staff_delete_task(uuid) TO authenticated;

-- Delete Interior Project — restricted to Management, Super Admin, or the
-- Interior Department Head (via HOD scope). No PM/Designer/Execution
-- profile, however senior their role inside a single project, can delete
-- a project — this check is entirely on the STAFF PILOT role (roles.code
-- via user_profiles), not the separate Interior functional role.
--
-- projects is an external, pre-existing system whose own RLS is
-- intentionally left untouched elsewhere in this pilot (it's wide open —
-- a documented, known residual risk). A SECURITY DEFINER function doesn't
-- touch that RLS at all; it just adds one new, narrowly-gated write path
-- that bypasses it under its own explicit check, same as every other
-- staff_* RPC in this app already does for its own tables. Soft-delete via
-- archived = true, mirroring the exact convention every existing project
-- list query already filters on (.eq("archived", false)).
CREATE OR REPLACE FUNCTION public.staff_delete_interior_project(p_project_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_project public.projects%ROWTYPE; v_interior_dept_id uuid;
BEGIN
  PERFORM public.staff_assert_operational();
  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id FOR UPDATE;
  IF v_project.id IS NULL THEN RAISE EXCEPTION 'Project not found'; END IF;
  IF v_project.archived THEN RAISE EXCEPTION 'Project is already deleted'; END IF;

  SELECT id INTO v_interior_dept_id FROM public.departments WHERE code = 'INTERIOR';

  IF NOT (
    public.staff_is_management()
    OR public.staff_is_super_admin()
    OR (public.staff_is_dept_head() AND v_interior_dept_id IS NOT NULL AND public.staff_dept_in_hod_scope(v_interior_dept_id))
  ) THEN
    RAISE EXCEPTION 'Only Management, Super Admin, or the Interior Department Head may delete a project';
  END IF;

  UPDATE public.projects SET archived = true WHERE id = p_project_id;

  INSERT INTO public.interior_pilot_audit_log (table_name, record_id, action, detail)
  VALUES ('projects', p_project_id, 'delete',
    jsonb_build_object('project_code', v_project.project_code, 'customer', v_project.customer, 'stage', v_project.stage));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.staff_delete_interior_project(uuid) TO authenticated;
