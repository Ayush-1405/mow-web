-- mvp_pilot_admin_password_reset_fix_v2_2w
--
-- Fixes a bug in the staff-reset-password Edge Function introduced in
-- v2_2v: it called admin.from("user_profiles").update(...) directly with
-- the service-role client, but service_role only has INSERT/SELECT grants
-- on public.user_profiles in this project -- every UPDATE goes through a
-- SECURITY DEFINER RPC owned by `postgres` instead (see
-- staff_complete_password_change, staff_set_user_active,
-- staff_update_user_profile). That mismatch produced "permission denied
-- for table user_profiles" and a 500 on every reset attempt.
--
-- staff_mark_password_reset() mirrors staff_complete_password_change()
-- exactly (same shape, same audit call, same grant -- EXECUTE to
-- service_role only, never to `authenticated`): it sets
-- must_change_password = true for the target (forcing them to pick their
-- own password on next login, same as a freshly created account) and
-- writes the PASSWORD_RESET audit row, in one SECURITY DEFINER call the
-- Edge Function's service-role client CAN execute.

CREATE OR REPLACE FUNCTION public.staff_mark_password_reset(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_department_id uuid;
BEGIN
  UPDATE public.user_profiles SET must_change_password = true WHERE id = p_user_id
  RETURNING department_id INTO v_department_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  PERFORM public.staff_write_audit('user_profiles', p_user_id, 'PASSWORD_RESET', NULL, NULL, v_department_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_mark_password_reset(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_mark_password_reset(uuid) TO service_role;
