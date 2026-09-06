-- mvp_pilot_assignable_users_all_v2_1g.sql
-- DRAFT ONLY — NOT EXECUTED. For review.
--
-- Adds ONE new, additive, read-only RPC: public.staff_list_assignable_users_all().
-- Does not alter public.staff_list_assignable_users, or any other existing
-- function, policy, table, or grant. Idempotent (CREATE OR REPLACE + re-appliable
-- REVOKE/GRANT), safe to re-run.
--
-- Purpose: return every active user across every department the CALLING user is
-- authorized to see, for the Assign Task screen's new cross-department,
-- searchable assignee picker. Authorization is an explicit role allow-list
-- (never NOT IN) mirroring the same rules already enforced by
-- staff_list_assignable_users and staff_create_task:
--
--   management                          -> all active departments, including Accounts
--   accounts_head / cfo / accounts_employee -> their own (Accounts) department only
--   dept_head / supervisor / employee   -> all active NON-CONFIDENTIAL departments
--                                          (not limited to HOD scope)
--   any other role (e.g. sysadmin)      -> zero rows (falls through the allow-list)
--
-- A user row with department_id IS NULL (the seed management profile,
-- MOW-MGMT-001, currently has no department) is excluded from the results —
-- it is not a valid assignee regardless of who is asking.

BEGIN;

CREATE OR REPLACE FUNCTION public.staff_list_assignable_users_all()
RETURNS TABLE(
  id uuid,
  employee_code text,
  full_name text,
  department_id uuid,
  role_label_en text,
  role_label_gu text,
  is_active boolean
)
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
  SELECT up.id, up.employee_code, up.full_name, up.department_id, r.name_en, r.name_gu, up.is_active
  FROM public.user_profiles up
  JOIN public.roles r ON r.id = up.role_id
  JOIN public.departments d ON d.id = up.department_id
  WHERE up.is_active = true
    AND d.is_active = true
    AND up.department_id IS NOT NULL
    AND (
      -- management: every active department, including confidential ones
      (v_caller_role = 'management')
      -- Accounts roles: their own department only (confidential or not)
      OR (v_caller_role IN ('accounts_head', 'cfo', 'accounts_employee')
          AND d.id = v_caller_department)
      -- dept_head / supervisor / employee: every active NON-confidential
      -- department, deliberately not limited to HOD scope for this directory
      OR (v_caller_role IN ('dept_head', 'supervisor', 'employee')
          AND NOT d.is_confidential_domain)
      -- every other role (sysadmin, or any future/unrecognized code):
      -- no branch above matches, so no rows are returned
    )
  ORDER BY d.code, up.full_name;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_list_assignable_users_all() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_list_assignable_users_all() TO authenticated;

COMMIT;

-- Post-apply, read-only verification to run before/after (not part of this file's
-- execution — for the operator to run manually):
--
-- 1) Function exists, correct signature, SECURITY DEFINER, search_path pinned:
--   select p.proname, p.prosecdef, p.proconfig
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'staff_list_assignable_users_all';
--
-- 2) Grants are exactly as intended:
--   select has_function_privilege('authenticated', 'public.staff_list_assignable_users_all()', 'EXECUTE') as authenticated_ok,
--          has_function_privilege('anon',          'public.staff_list_assignable_users_all()', 'EXECUTE') as anon_ok,
--          has_function_privilege('public',        'public.staff_list_assignable_users_all()', 'EXECUTE') as public_ok;
--   -- expected: authenticated_ok = true, anon_ok = false, public_ok = false
--
-- 3) staff_list_assignable_users (existing, approved function) is byte-for-byte
--    unchanged — compare pg_get_functiondef before and after this migration.
--
-- 4) No other function, policy, or table was touched — diff pg_proc/pg_policies
--    row counts and staff_audit_log before/after (this migration writes no
--    audit rows and touches no data table).
