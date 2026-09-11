-- "voice" proof-type tasks can NEVER be completed — the existing
-- staff_validate_task_transition trigger unconditionally rejects that
-- transition ("Voice proof is not enabled in this pilot"), a deliberate,
-- pre-existing constraint. Letting a task be CREATED with proof_type=
-- 'voice' was a dead end with no warning until the assignee tried to
-- finish it. Deactivating it here removes it from every proof-type
-- picker going forward (every screen already filters .eq('is_active',
-- true)) — existing tasks already created with it are handled by the
-- frontend showing a clear message instead of a broken uploader.
UPDATE public.proof_types SET is_active = false WHERE code = 'voice';

-- staff_complete_task had no way to satisfy a 'customer_confirmation'
-- proof requirement except by attaching an arbitrary file (the trigger's
-- OR condition) — there was no path to actually set
-- customer_confirmation_text, even though the column and the check both
-- already existed. Setting it in the SAME UPDATE that changes status
-- means the BEFORE UPDATE trigger sees the new value when it validates
-- the transition, same statement.
CREATE OR REPLACE FUNCTION public.staff_complete_task(p_task_id uuid, p_customer_confirmation_text text DEFAULT NULL::text)
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
  IF v_old_code <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'Task must be IN_PROGRESS to complete (currently %)', v_old_code;
  END IF;
  IF v_task.current_owner_id <> auth.uid() THEN
    RAISE EXCEPTION 'Only the current owner may complete this task';
  END IF;

  SELECT id INTO v_status_id FROM public.status_master WHERE code = 'COMPLETED';
  UPDATE public.staff_tasks
  SET status_id = v_status_id,
      customer_confirmation_text = COALESCE(p_customer_confirmation_text, customer_confirmation_text)
  WHERE id = p_task_id;

  IF v_task.is_bridge THEN
    UPDATE public.bridges SET completed_at = now() WHERE task_id = p_task_id;
  END IF;

  PERFORM public.staff_write_audit('task', p_task_id, 'COMPLETE', jsonb_build_object('status', v_old_code), jsonb_build_object('status','COMPLETED'), v_task.to_department_id);
  INSERT INTO public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  VALUES (v_task.verifier_id, 'task', p_task_id, 'Ready for verification: ' || v_task.task_number, 'ચકાસણી માટે તૈયાર: ' || v_task.task_number);
END;
$function$;

-- Unsticks the specific test task ("sample", TSK-000017) — it was created
-- with the now-disabled voice proof type, which would never have let it
-- complete. Switched to photo, which the UI already fully supports.
UPDATE public.staff_tasks
SET proof_type_id = (SELECT id FROM public.proof_types WHERE code = 'photo')
WHERE task_number = 'TSK-000017';
