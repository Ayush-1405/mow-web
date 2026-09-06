-- mvp_pilot_roster_and_user_status_v2_1k
-- Applied directly to the live project (bykmyttaesuyjwvtnxks) on 2026-09-06.
--
-- Adds the RPCs behind the Team/Roster screen:
--   staff_list_department_roster() — user_profiles_select_hod_scope only
--     returns is_active=true rows, which hides exactly the deactivated
--     accounts a Dept Head/Management would need to see to reactivate them,
--     so this is a scoped SECURITY DEFINER function instead of a direct
--     table query (same scoping as staff_list_assignable_users_all, minus
--     the is_active filter).
--   staff_set_user_active(user_id, is_active, reason) — deactivate/
--     reactivate. Management: anyone. Dept Head: only within hod_scope,
--     and never an elevated role (management/cfo/accounts_head/sysadmin).
--     Cannot target yourself. Reason is mandatory and audited.
--   staff_update_user_profile(user_id, full_name, phone) — deliberately
--     limited to non-authorization-sensitive fields. role_id/department_id
--     are NOT editable here — changing either after the fact would leave
--     existing tasks/RLS assumptions (e.g. assigned_to's department) out of
--     sync with no migration path, so that's left out of this pilot pass.

CREATE OR REPLACE FUNCTION public.staff_list_department_roster()
 RETURNS TABLE(id uuid, employee_code text, full_name text, phone text, department_id uuid, role_code text, role_name_en text, role_name_gu text, is_active boolean, must_change_password boolean, created_at timestamptz)
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
    v_caller_role = 'management'
    OR (v_caller_role = 'dept_head' AND public.staff_dept_in_hod_scope(up.department_id))
    OR (v_caller_role IN ('accounts_head','cfo') AND up.department_id = v_caller_department)
  )
  ORDER BY up.full_name;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_list_department_roster() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_list_department_roster() TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_set_user_active(p_user_id uuid, p_is_active boolean, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_caller_role text := public.staff_current_role_code();
  v_target public.user_profiles%ROWTYPE;
  v_target_role text;
BEGIN
  PERFORM public.staff_assert_operational();
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;
  IF p_user_id = v_caller THEN
    RAISE EXCEPTION 'You cannot change your own active status';
  END IF;

  SELECT * INTO v_target FROM public.user_profiles WHERE id = p_user_id;
  IF v_target.id IS NULL THEN RAISE EXCEPTION 'User not found'; END IF;
  v_target_role := public.staff_user_role_code(p_user_id);

  IF v_caller_role = 'management' THEN
    NULL;
  ELSIF v_caller_role = 'dept_head' THEN
    IF v_target_role IN ('management','cfo','accounts_head','sysadmin') THEN
      RAISE EXCEPTION 'You are not authorized to change this user''s status';
    END IF;
    IF NOT public.staff_dept_in_hod_scope(v_target.department_id) THEN
      RAISE EXCEPTION 'This user is outside your authorized scope';
    END IF;
  ELSE
    RAISE EXCEPTION 'You are not authorized to change user status';
  END IF;

  UPDATE public.user_profiles SET is_active = p_is_active WHERE id = p_user_id;

  PERFORM public.staff_write_audit('user_profile', p_user_id, CASE WHEN p_is_active THEN 'ACTIVATE' ELSE 'DEACTIVATE' END,
    jsonb_build_object('is_active', v_target.is_active), jsonb_build_object('is_active', p_is_active),
    v_target.department_id, p_reason);
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_set_user_active(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_set_user_active(uuid, boolean, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_update_user_profile(p_user_id uuid, p_full_name text, p_phone text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_role text := public.staff_current_role_code();
  v_target public.user_profiles%ROWTYPE;
BEGIN
  PERFORM public.staff_assert_operational();
  IF p_full_name IS NULL OR btrim(p_full_name) = '' THEN
    RAISE EXCEPTION 'Full name is required';
  END IF;

  SELECT * INTO v_target FROM public.user_profiles WHERE id = p_user_id;
  IF v_target.id IS NULL THEN RAISE EXCEPTION 'User not found'; END IF;

  IF NOT (
    v_caller_role = 'management'
    OR (v_caller_role = 'dept_head' AND public.staff_dept_in_hod_scope(v_target.department_id))
  ) THEN
    RAISE EXCEPTION 'You are not authorized to edit this user';
  END IF;

  UPDATE public.user_profiles
  SET full_name = btrim(p_full_name), phone = NULLIF(btrim(COALESCE(p_phone, '')), '')
  WHERE id = p_user_id;

  PERFORM public.staff_write_audit('user_profile', p_user_id, 'UPDATE_PROFILE',
    jsonb_build_object('full_name', v_target.full_name, 'phone', v_target.phone),
    jsonb_build_object('full_name', p_full_name, 'phone', p_phone),
    v_target.department_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_update_user_profile(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_update_user_profile(uuid, text, text) TO authenticated;
