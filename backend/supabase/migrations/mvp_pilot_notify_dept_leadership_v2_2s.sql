-- Notifies every active Management user plus the Department Head of the
-- given department — used so a Daily Update (and anything similar later)
-- reaches leadership without the submitter's own client needing to read
-- other people's user_profiles rows (RLS already restricts a plain
-- employee to their own row; this runs SECURITY DEFINER precisely so that
-- restriction doesn't get in the way of a legitimate "tell my leadership"
-- notification). Mirrors staff_notify_assignment's shape (same
-- notifications insert, same "never notify yourself" rule) but fans out
-- to a role-based set instead of one named recipient.
CREATE OR REPLACE FUNCTION public.staff_notify_dept_leadership(
  p_department_code text, p_entity_type text, p_entity_id uuid, p_title_en text, p_title_gu text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_department_id uuid; r record;
BEGIN
  PERFORM public.staff_assert_operational();
  SELECT id INTO v_department_id FROM public.departments WHERE code = p_department_code;

  FOR r IN
    SELECT up.id FROM public.user_profiles up
    JOIN public.roles ro ON ro.id = up.role_id
    WHERE up.is_active = true
      AND up.id <> auth.uid()
      AND (
        ro.code = 'management'
        OR (ro.code = 'dept_head' AND v_department_id IS NOT NULL AND up.department_id = v_department_id)
      )
  LOOP
    INSERT INTO public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    VALUES (r.id, p_entity_type, p_entity_id, p_title_en, p_title_gu);
  END LOOP;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.staff_notify_dept_leadership(text, text, uuid, text, text) TO authenticated;
