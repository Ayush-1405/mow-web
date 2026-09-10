-- Mood of Wood — Staff Pilot — Department pages / Management Control Tower
-- rollout (Phase 1: navigation, page structure, dashboards, access).
--
-- WHY THIS IS THE ONLY MIGRATION FOR THIS PHASE
-- ----------------------------------------------------------------------
-- The existing schema already fully models the required access structure:
--   - departments.is_control_tower       -> Management Control Tower flag
--   - departments.is_confidential_domain -> Accounts/Finance restriction
--   - departments.department_group_id    -> shared-Head department groups
--                                            (Retail+Franchise, Marketing+
--                                            E-commerce, Godown+Dispatch)
--   - departments.parent_department_id   -> Customer-Service-under-Retail-
--                                            Head dual-reporting pattern
--   - staff_dept_in_hod_scope() / staff_user_dept_in_hod_scope() already
--     implement exactly this group/parent expansion for a dept_head, and
--     already gate staff_tasks, bridges, staff_attachments, and
--     user_profiles via RLS.
--   - staff_list_department_roster() already restricts the team roster to
--     Management / Department Head / Accounts Head / CFO.
-- All 15 departments (including Management Control Tower and Accounts/
-- Finance) are already seeded with these flags set correctly. No new
-- table, enum, or RLS policy is required to reproduce the department
-- ownership/role hierarchy from the rollout spec — see lib/access.js in
-- the frontend for the client-side mirror of this same logic (used only
-- to decide what to render; the real boundary stays server-side, here).
--
-- The one real gap: the Department Dashboard standard requires showing
-- "Department Head" on every department's page, including to a plain
-- Department Member — but staff_list_department_roster() is deliberately
-- restricted to elevated roles, and user_profiles has no broader SELECT
-- policy. Rather than loosen either of those (both are working, reviewed,
-- and used elsewhere), this migration adds ONE new, narrow, read-only
-- function that reveals only a department head's name (nothing else —
-- not phone, not employee_code) to a caller already authorized to view
-- that specific department under the exact same rule used everywhere
-- else: Management, or their own department, or (for a dept_head) a
-- department in their HOD scope.
--
-- Safe to run twice: CREATE OR REPLACE FUNCTION and GRANT are both
-- idempotent. Purely additive — no existing table, column, function,
-- trigger, policy, or route is modified, renamed, or dropped.

CREATE OR REPLACE FUNCTION public.staff_department_head_public(p_department_id uuid)
RETURNS TABLE(full_name text, role_name_en text, role_name_gu text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_role text := public.staff_current_role_code();
  v_caller_department uuid := public.staff_current_department_id();
  v_allowed boolean;
BEGIN
  PERFORM public.staff_assert_operational();

  v_allowed := (
    v_caller_role = 'management'
    OR p_department_id = v_caller_department
    OR (v_caller_role = 'dept_head' AND public.staff_dept_in_hod_scope(p_department_id))
    OR (v_caller_role IN ('accounts_head', 'cfo') AND p_department_id = v_caller_department)
  );

  IF NOT v_allowed THEN
    RETURN; -- Not authorized for this department: return zero rows, not an error.
  END IF;

  RETURN QUERY
  SELECT up.full_name, r.name_en, r.name_gu
  FROM public.user_profiles up
  JOIN public.roles r ON r.id = up.role_id
  WHERE up.department_id = p_department_id
    AND r.code = 'dept_head'
    AND up.is_active = true
  LIMIT 1;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.staff_department_head_public(uuid) TO authenticated;
