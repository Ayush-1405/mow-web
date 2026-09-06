-- mvp_pilot_reassign_cross_department_bridge_v2_1o
-- Applied directly to the live project (bykmyttaesuyjwvtnxks) on 2026-09-06.
--
-- Feature: staff_reassign_task previously only let Management/HOD hand an
-- existing task to a different assignee WITHIN the same to_department_id
-- (`New assignee must belong to the task's destination department`). There
-- was no way to move an existing task to an employee in a different
-- department short of closing it and creating a brand new one.
--
-- This adds an optional p_new_to_department_id parameter. When it differs
-- from the task's current to_department_id, the function:
--   - requires p_new_assigned_to (an employee in the new department — a
--     department change with no new assignee would leave the task pointed
--     at someone in the wrong department),
--   - re-validates the new assignee/verifier against the NEW department
--     using the exact same rules staff_create_task already uses,
--   - re-checks the confidential-domain rule staff_create_task enforces
--     (no cross-department Bridge into/out of a confidential department),
--   - and mirrors the Bridge bookkeeping staff_create_task already does:
--       * task was already a Bridge -> update the existing bridges row's
--         to_department_id/to_person_id,
--       * task was a same-department task, new department differs from its
--         from_department -> INSERT a new bridges row and flip is_bridge,
--       * new department equals the task's own from_department (moving a
--         Bridge back to its origin) -> deactivate the bridge row and flip
--         is_bridge back off.
--
-- Authorization is unchanged at the top: only Management, or a Dept Head
-- whose HOD scope covers the task's CURRENT to_department_id, may reassign
-- at all — same as before. No additional authority over the destination
-- department is required, mirroring staff_create_task (a caller only needs
-- authority over the FROM side; the destination is validated for
-- confidentiality/assignee-membership, not caller ownership).
--
-- Backward compatible: p_new_to_department_id defaults to NULL and every
-- existing caller (Supabase RPC calls pass named args as a JSON object) that
-- omits it keeps the exact same same-department-only behavior as before.
--
-- IMPORTANT: Postgres identifies a function by name + argument list, so
-- CREATE OR REPLACE with a different parameter list does NOT replace the
-- old 4-arg staff_reassign_task — it creates a second overload. PostgREST
-- then can't disambiguate a 2-arg call (both overloads match) and every
-- reassignment call starts failing. The old overload must be dropped first.
DROP FUNCTION IF EXISTS public.staff_reassign_task(uuid, text, uuid, uuid);

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
    public.staff_is_management()
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
      IF v_from_confidential AND v_caller_role NOT IN ('management','cfo','accounts_head','accounts_employee') THEN
        RAISE EXCEPTION 'Only Accounts roles or Management may reassign a task within a confidential department';
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
    -- Department moved but the verifier wasn't re-specified: re-check the
    -- EXISTING verifier against the new destination the same way a freshly
    -- chosen one would be, so a bridge move can never silently leave behind
    -- a verifier who has no authority over the new destination department.
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
      -- New destination is the task's own origin department: it stops being
      -- a cross-department Bridge, so any existing bridge row is retired.
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
