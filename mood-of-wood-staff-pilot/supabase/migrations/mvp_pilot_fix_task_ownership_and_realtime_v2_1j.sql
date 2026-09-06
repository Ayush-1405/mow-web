-- mvp_pilot_fix_task_ownership_and_realtime_v2_1j
-- Applied directly to the live project (bykmyttaesuyjwvtnxks) on 2026-09-06.
--
-- Bug: staff_create_task set current_owner_id to the caller (assigner)
-- instead of the assignee at INSERT time. Every later lifecycle transition
-- is correctly handled by the staff_validate_task_transition trigger (it
-- re-derives current_owner_id on ACCEPTED/COMPLETED/RETURNED/etc.), so this
-- was the single break point: a freshly assigned employee's task had
-- current_owner_id pointing at their manager, not at them, so the
-- frontend's "is this task mine to act on" check hid the Accept/Return
-- buttons on their own brand-new task.
--
-- Fix: current_owner_id := p_assigned_to at creation (was v_caller).
-- Also includes a one-time data fix for tasks already stuck in this state,
-- and enables Realtime (postgres_changes) for staff_tasks/bridges/
-- notifications so the UI can move off manual-refresh-only.

CREATE OR REPLACE FUNCTION public.staff_create_task(p_title text, p_description text, p_task_type_code text, p_priority_code text, p_proof_type_code text, p_from_department_id uuid, p_to_department_id uuid, p_assigned_to uuid, p_due_date date, p_due_time time without time zone DEFAULT NULL::time without time zone, p_verifier_id uuid DEFAULT NULL::uuid, p_reference_number text DEFAULT NULL::text, p_requirement_text text DEFAULT NULL::text, p_quantity text DEFAULT NULL::text)
 RETURNS TABLE(task_id uuid, task_number text, bridge_id uuid, bridge_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_caller_role text;
  v_caller_department uuid;
  v_task_type_id uuid; v_priority_id uuid; v_proof_type_id uuid; v_status_id uuid;
  v_task_id uuid; v_task_number text; v_bridge_id uuid; v_bridge_number text;
  v_is_bridge boolean;
  v_from_confidential boolean; v_to_confidential boolean;
  v_verifier uuid; v_verifier_role text; v_verifier_department uuid;
  v_assignee_department uuid;
BEGIN
  PERFORM public.staff_assert_operational();
  v_caller_role := public.staff_current_role_code();
  v_caller_department := public.staff_current_department_id();

  IF NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_from_department_id AND is_active = true) THEN
    RAISE EXCEPTION 'Invalid from_department';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_to_department_id AND is_active = true) THEN
    RAISE EXCEPTION 'Invalid to_department';
  END IF;
  SELECT is_confidential_domain INTO v_from_confidential FROM public.departments WHERE id = p_from_department_id;
  SELECT is_confidential_domain INTO v_to_confidential FROM public.departments WHERE id = p_to_department_id;
  v_is_bridge := (p_from_department_id <> p_to_department_id);

  IF v_is_bridge THEN
    IF v_from_confidential OR v_to_confidential THEN
      RAISE EXCEPTION 'Cross-department Bridges into/out of a confidential department are disabled in this pilot';
    END IF;
  ELSE
    IF v_from_confidential AND v_caller_role NOT IN ('management','cfo','accounts_head','accounts_employee') THEN
      RAISE EXCEPTION 'Only Accounts roles or Management may create tasks within a confidential department';
    END IF;
  END IF;

  IF v_caller_role IN ('employee','supervisor') THEN
    IF p_from_department_id <> v_caller_department THEN
      RAISE EXCEPTION 'You may only create tasks from your own department';
    END IF;
  ELSIF v_caller_role = 'dept_head' THEN
    IF NOT public.staff_dept_in_hod_scope(p_from_department_id) THEN
      RAISE EXCEPTION 'from_department is outside your authorized scope';
    END IF;
  ELSIF v_caller_role = 'management' THEN
    NULL;
  ELSIF v_caller_role IN ('cfo','accounts_head','accounts_employee') THEN
    IF p_from_department_id <> v_caller_department THEN
      RAISE EXCEPTION 'Accounts roles may only create tasks within their own Accounts department';
    END IF;
  ELSE
    RAISE EXCEPTION 'Your role is not authorized to create tasks in this pilot';
  END IF;

  SELECT department_id INTO v_assignee_department FROM public.user_profiles WHERE id = p_assigned_to AND is_active = true;
  IF v_assignee_department IS NULL THEN
    RAISE EXCEPTION 'Invalid or inactive assignee';
  END IF;
  IF v_assignee_department IS DISTINCT FROM p_to_department_id THEN
    RAISE EXCEPTION 'assigned_to must belong to the selected destination department';
  END IF;

  v_verifier := COALESCE(p_verifier_id, v_caller);
  IF v_verifier <> v_caller AND NOT (v_caller_role IN ('management','dept_head')) THEN
    RAISE EXCEPTION 'Only Management or a Department Head may assign a verifier other than themselves';
  END IF;
  v_verifier_role := public.staff_user_role_code(v_verifier);
  IF v_verifier_role IS NULL THEN
    RAISE EXCEPTION 'Invalid or inactive verifier';
  END IF;
  SELECT department_id INTO v_verifier_department FROM public.user_profiles WHERE id = v_verifier;
  IF NOT (
    v_verifier = v_caller
    OR v_verifier_role = 'management'
    OR v_verifier_department = p_to_department_id
    OR (v_verifier_role = 'dept_head' AND public.staff_user_dept_in_hod_scope(v_verifier, p_to_department_id))
  ) THEN
    RAISE EXCEPTION 'verifier_id is not authorized for the destination department';
  END IF;

  SELECT id INTO v_task_type_id FROM public.task_types WHERE code = p_task_type_code AND is_active = true;
  IF v_task_type_id IS NULL THEN RAISE EXCEPTION 'Invalid task_type_code'; END IF;
  SELECT id INTO v_priority_id FROM public.priority_master WHERE code = p_priority_code AND is_active = true;
  IF v_priority_id IS NULL THEN RAISE EXCEPTION 'Invalid priority_code'; END IF;
  SELECT id INTO v_proof_type_id FROM public.proof_types WHERE code = p_proof_type_code AND is_active = true;
  IF v_proof_type_id IS NULL THEN RAISE EXCEPTION 'Invalid proof_type_code'; END IF;
  SELECT id INTO v_status_id FROM public.status_master WHERE code = 'ASSIGNED';

  INSERT INTO public.staff_tasks AS inserted_task (
    title, description, task_type_id, priority_id, status_id, proof_type_id,
    from_department_id, to_department_id, assigned_by, assigned_to, verifier_id,
    current_owner_id, reference_number, due_date, due_time
  ) VALUES (
    p_title, p_description, v_task_type_id, v_priority_id, v_status_id, v_proof_type_id,
    p_from_department_id, p_to_department_id, v_caller, p_assigned_to, v_verifier,
    p_assigned_to, p_reference_number, p_due_date, p_due_time
  ) RETURNING inserted_task.id, inserted_task.task_number, inserted_task.is_bridge INTO v_task_id, v_task_number, v_is_bridge;

  IF v_is_bridge THEN
    INSERT INTO public.bridges (task_id, from_department_id, to_department_id, from_person_id, to_person_id, requirement_text, quantity)
    VALUES (v_task_id, p_from_department_id, p_to_department_id, v_caller, p_assigned_to, COALESCE(p_requirement_text, p_title), p_quantity)
    RETURNING id, bridge_number INTO v_bridge_id, v_bridge_number;
  END IF;

  PERFORM public.staff_write_audit('task', v_task_id, 'CREATE', NULL,
    jsonb_build_object('task_number', v_task_number, 'is_bridge', v_is_bridge, 'assigned_to', p_assigned_to), p_to_department_id);

  INSERT INTO public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  VALUES (p_assigned_to, 'task', v_task_id, 'New task assigned: ' || v_task_number, 'નવું કામ સોંપાયું: ' || v_task_number);

  RETURN QUERY SELECT v_task_id, v_task_number, v_bridge_id, v_bridge_number;
END;
$function$;

-- One-time data fix for tasks already stuck with wrong ownership.
UPDATE public.staff_tasks
SET current_owner_id = assigned_to
WHERE current_owner_id IS DISTINCT FROM assigned_to
  AND status_id = (SELECT id FROM public.status_master WHERE code = 'ASSIGNED');

-- Enable Realtime (postgres_changes) for the tables the UI needs to watch
-- live. RLS stays the enforcement boundary — Realtime re-checks each
-- table's existing SELECT policy per subscriber, so no policy changes.
ALTER PUBLICATION supabase_realtime ADD TABLE public.staff_tasks, public.bridges, public.notifications;
