-- Delete Task — soft-delete (is_active = false), restricted to the person
-- who originally created the task (assigned_by, set from auth.uid() at
-- creation time in staff_create_task). Matches the app's existing
-- convention: no direct client writes to staff_tasks, only through
-- approved staff_* SECURITY DEFINER RPCs; and soft-delete via is_active,
-- never a real DELETE, so the audit trail / any linked bridge survives.
-- TodayTasks.jsx's own list query already filters .eq("is_active", true),
-- so a deleted task simply stops appearing there once this runs.
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
  IF v_task.assigned_by <> auth.uid() THEN
    RAISE EXCEPTION 'Only the person who created this task may delete it';
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
