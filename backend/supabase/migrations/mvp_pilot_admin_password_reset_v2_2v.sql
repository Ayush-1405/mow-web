-- mvp_pilot_admin_password_reset_v2_2v
--
-- Adds staff_authorize_password_reset(): the server-side authorization
-- check behind a new "Reset Password" action on the User Management
-- roster (UserCreation.jsx), for when a staff member has forgotten their
-- password and cannot use the self-service Change Password screen (which
-- requires being logged in with the OLD password already).
--
-- Setting a Supabase Auth password can only be done with the service-role
-- key (auth.admin.updateUserById), which lives only in an Edge Function --
-- never in a plain SQL RPC. So the work is split the same way
-- staff-password-change already splits self-service password changes:
--   - THIS function is called through a client scoped to the caller's own
--     verified session (so auth.uid() resolves to the real caller, same as
--     every other RPC below), and does ONLY the authorization check -- the
--     SAME scope rule staff_set_user_active already uses: Management/
--     Sysadmin may reset anyone; a Dept Head only within
--     staff_dept_in_hod_scope(), and never for an elevated role
--     (management/cfo/accounts_head/sysadmin). Raises on failure, returns
--     void on success -- it never touches the password itself.
--   - The staff-reset-password Edge Function calls this RPC first, and
--     only on success calls admin.auth.admin.updateUserById(), sets
--     must_change_password = true (so the new temporary password must be
--     changed by the user on next login, same as at account creation), and
--     writes its own staff_audit_log row directly via the service-role
--     client (mirrors how staff-create-user already writes its own
--     CREATE_USER audit row).
--
-- A caller can never reset their own password through this path -- that is
-- what the existing self-service Change Password screen is for.

CREATE OR REPLACE FUNCTION public.staff_authorize_password_reset(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_role text := public.staff_current_role_code();
  v_target public.user_profiles%ROWTYPE;
  v_target_role text;
BEGIN
  PERFORM public.staff_assert_operational();

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Use Change Password to update your own password';
  END IF;

  SELECT * INTO v_target FROM public.user_profiles WHERE id = p_user_id;
  IF v_target.id IS NULL THEN RAISE EXCEPTION 'User not found'; END IF;
  v_target_role := public.staff_user_role_code(p_user_id);

  IF v_caller_role IN ('management', 'sysadmin') THEN
    NULL;
  ELSIF v_caller_role = 'dept_head' THEN
    IF v_target_role IN ('management','cfo','accounts_head','sysadmin') THEN
      RAISE EXCEPTION 'You are not authorized to reset this user''s password';
    END IF;
    IF NOT public.staff_dept_in_hod_scope(v_target.department_id) THEN
      RAISE EXCEPTION 'This user is outside your authorized scope';
    END IF;
  ELSE
    RAISE EXCEPTION 'You are not authorized to reset a password';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_authorize_password_reset(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_authorize_password_reset(uuid) TO authenticated;
