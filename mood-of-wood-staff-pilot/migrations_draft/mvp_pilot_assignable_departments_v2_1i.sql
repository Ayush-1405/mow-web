-- mvp_pilot_assignable_departments_v2_1i.sql
-- Additive, read-only-effect migration: adds ONE new RPC,
-- public.staff_list_assignable_departments(), so the frontend's To
-- Department dropdown can list authorized departments directly instead
-- of deriving them from staff_list_assignable_users_all()'s result
-- (which silently drops departments that currently have zero users).
--
-- Does NOT alter staff_list_assignable_users_all() or any other existing
-- function, table, policy, or grant. Modeled on the same role-visibility
-- rules already enforced in staff_list_assignable_users_all(), with one
-- necessary difference: Accounts roles see only their OWN department
-- (not "any confidential department"), and Management sees all active
-- departments including confidential ones -- exactly as specified.

BEGIN;

CREATE OR REPLACE FUNCTION public.staff_list_assignable_departments()
 RETURNS TABLE(
   id uuid,
   code text,
   name_en text,
   name_gu text,
   is_confidential_domain boolean,
   is_active boolean
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_role text := public.staff_current_role_code();
  v_caller_department uuid := public.staff_current_department_id();
BEGIN
  PERFORM public.staff_assert_operational();

  RETURN QUERY
  SELECT d.id, d.code, d.name_en, d.name_gu, d.is_confidential_domain, d.is_active
  FROM public.departments d
  WHERE d.is_active = true
    AND (
      -- management: every active department, including confidential ones
      (v_caller_role = 'management')
      -- Accounts roles: their own active department only
      OR (v_caller_role IN ('accounts_head', 'cfo', 'accounts_employee')
          AND d.id = v_caller_department)
      -- dept_head / supervisor / employee: every active NON-confidential department
      OR (v_caller_role IN ('dept_head', 'supervisor', 'employee')
          AND NOT d.is_confidential_domain)
      -- every other / unrecognized role code: no branch matches, zero rows
    )
  ORDER BY d.code;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_list_assignable_departments() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_list_assignable_departments() FROM anon;
GRANT EXECUTE ON FUNCTION public.staff_list_assignable_departments() TO authenticated;

COMMIT;
