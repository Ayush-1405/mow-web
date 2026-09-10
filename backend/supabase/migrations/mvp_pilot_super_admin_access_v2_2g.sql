-- Mood of Wood — Staff Pilot — Super Admin (sysadmin) read/write access.
--
-- The `sysadmin` role already existed in `roles` but was never wired into
-- any RLS policy or into lib/access.js — a sysadmin user currently sees
-- ZERO department dashboards and zero rows on staff_tasks/bridges/
-- user_profiles, since every existing policy only recognizes
-- staff_is_management() (role='management'), not sysadmin. This migration
-- gives Super Admin the SAME broad visibility Management already has,
-- with ONE deliberate exception: confidential Finance data (Accounts/
-- Finance department rows) stays exactly as restricted as it already is —
-- per the project's architecture doc, "System Admin does not see Finance
-- by default... a deliberate, logged, one-off decision, never a
-- side-effect of being an admin." staff_is_super_admin() is therefore
-- added ONLY to each policy's general-visibility branch, never to the
-- confidential-domain allow-list — staff_tasks_select_scoped's existing
-- confidential block (`NOT (staff_is_management() OR staff_is_accounts_
-- head() OR role IN ('accounts_employee','cfo'))`) is left untouched, so
-- Super Admin is still excluded from Accounts-domain rows exactly as
-- before.
--
-- Scope of this pass: SELECT-level visibility on the core engine
-- (staff_tasks, bridges, user_profiles, staff_audit_log) matching
-- Management's existing scope, plus full SELECT/INSERT/UPDATE on every
-- retail_* and interior_pilot_* table this project added (none of which
-- are confidential-domain tables). It does NOT yet touch the write-side
-- RPCs (staff_create_task, staff_accept_task, etc.) — those have their
-- own internal role checks not yet audited for sysadmin, or
-- staff_attachments' nested-EXISTS policy — both flagged as follow-up
-- work, not silently left undone.
--
-- Idempotent (DROP POLICY IF EXISTS + CREATE POLICY, CREATE OR REPLACE
-- FUNCTION). Existing policies are recreated with the exact same
-- predicate plus one added OR-clause — never loosened beyond that.

CREATE OR REPLACE FUNCTION public.staff_is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.staff_current_role_code() = 'sysadmin';
$function$;

GRANT EXECUTE ON FUNCTION public.staff_is_super_admin() TO authenticated;

-- staff_tasks: add to the general-visibility branch only; the confidential
-- block below is copied verbatim, unchanged.
DROP POLICY IF EXISTS staff_tasks_select_scoped ON public.staff_tasks;
CREATE POLICY staff_tasks_select_scoped ON public.staff_tasks FOR SELECT
USING (
  staff_current_user_ok() AND (
    assigned_by = auth.uid() OR assigned_to = auth.uid() OR current_owner_id = auth.uid() OR verifier_id = auth.uid()
    OR staff_is_management() OR staff_is_super_admin()
    OR (staff_is_dept_head() AND (staff_dept_in_hod_scope(from_department_id) OR staff_dept_in_hod_scope(to_department_id)))
    OR (staff_is_accounts_head() AND (from_department_id = staff_current_department_id() OR to_department_id = staff_current_department_id()))
  ) AND NOT (
    EXISTS (SELECT 1 FROM public.departments d WHERE d.id = ANY (ARRAY[staff_tasks.from_department_id, staff_tasks.to_department_id]) AND d.is_confidential_domain = true)
    AND NOT (staff_is_management() OR staff_is_accounts_head() OR staff_current_role_code() = ANY (ARRAY['accounts_employee', 'cfo']))
  )
);

DROP POLICY IF EXISTS bridges_select_scoped ON public.bridges;
CREATE POLICY bridges_select_scoped ON public.bridges FOR SELECT
USING (
  staff_current_user_ok() AND (
    from_person_id = auth.uid() OR to_person_id = auth.uid()
    OR staff_is_management() OR staff_is_super_admin()
    OR (staff_is_dept_head() AND (staff_dept_in_hod_scope(from_department_id) OR staff_dept_in_hod_scope(to_department_id)))
  )
);

DROP POLICY IF EXISTS user_profiles_select_hod_scope ON public.user_profiles;
CREATE POLICY user_profiles_select_hod_scope ON public.user_profiles FOR SELECT
USING (
  staff_current_user_ok() AND is_active = true AND (
    staff_is_management() OR staff_is_super_admin()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
    OR (staff_is_accounts_head() AND department_id = staff_current_department_id())
  )
);

DROP POLICY IF EXISTS staff_audit_log_select_scoped ON public.staff_audit_log;
CREATE POLICY staff_audit_log_select_scoped ON public.staff_audit_log FOR SELECT
USING (
  staff_current_user_ok() AND (
    staff_is_management() OR staff_is_super_admin()
    OR (staff_is_dept_head() AND department_id IS NOT NULL AND staff_dept_in_hod_scope(department_id))
  )
);

-- This project's own tables: add staff_is_super_admin() alongside
-- staff_is_management() in every SELECT/INSERT/UPDATE policy. None of
-- these are confidential-domain tables, so no carve-out is needed here.
DO $do$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'retail_leads', 'retail_quotations', 'retail_orders', 'retail_vm_tasks',
    'retail_store_ops_logs', 'retail_complaints', 'retail_sales_targets',
    'interior_payment_records'
  ]
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I', tbl || '_select_scoped', tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (
         staff_current_user_ok() AND (
           created_by = auth.uid()
           OR staff_is_management() OR staff_is_super_admin()
           OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
           OR (staff_is_accounts_head() AND department_id = staff_current_department_id())
         )
       )', tbl || '_select_scoped', tbl
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_insert_scoped', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (
         staff_current_user_ok() AND (
           department_id = staff_current_department_id()
           OR staff_is_management() OR staff_is_super_admin()
           OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
         )
       )', tbl || '_insert_scoped', tbl
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_update_scoped', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE USING (
         staff_current_user_ok() AND (
           created_by = auth.uid()
           OR staff_is_management() OR staff_is_super_admin()
           OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
         )
       ) WITH CHECK (
         department_id = staff_current_department_id() OR staff_is_management() OR staff_is_super_admin()
         OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
       )', tbl || '_update_scoped', tbl
    );
  END LOOP;
END;
$do$;

-- retail_leads/vm_tasks/complaints have an extra assigned_to = auth.uid()
-- clause in their original SELECT/UPDATE policies — restore that (the
-- loop above used the simpler created_by-only shape) so this migration
-- never narrows what those three tables already granted.
DROP POLICY IF EXISTS retail_leads_select_scoped ON public.retail_leads;
CREATE POLICY retail_leads_select_scoped ON public.retail_leads FOR SELECT
USING (staff_current_user_ok() AND (created_by = auth.uid() OR assigned_to = auth.uid() OR staff_is_management() OR staff_is_super_admin() OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id)) OR (staff_is_accounts_head() AND department_id = staff_current_department_id())));
DROP POLICY IF EXISTS retail_leads_update_scoped ON public.retail_leads;
CREATE POLICY retail_leads_update_scoped ON public.retail_leads FOR UPDATE
USING (staff_current_user_ok() AND (created_by = auth.uid() OR assigned_to = auth.uid() OR staff_is_management() OR staff_is_super_admin() OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))))
WITH CHECK (department_id = staff_current_department_id() OR staff_is_management() OR staff_is_super_admin() OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id)));

DROP POLICY IF EXISTS retail_vm_tasks_select_scoped ON public.retail_vm_tasks;
CREATE POLICY retail_vm_tasks_select_scoped ON public.retail_vm_tasks FOR SELECT
USING (staff_current_user_ok() AND (created_by = auth.uid() OR assigned_to = auth.uid() OR staff_is_management() OR staff_is_super_admin() OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))));
DROP POLICY IF EXISTS retail_vm_tasks_update_scoped ON public.retail_vm_tasks;
CREATE POLICY retail_vm_tasks_update_scoped ON public.retail_vm_tasks FOR UPDATE
USING (staff_current_user_ok() AND (created_by = auth.uid() OR assigned_to = auth.uid() OR staff_is_management() OR staff_is_super_admin() OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))))
WITH CHECK (department_id = staff_current_department_id() OR staff_is_management() OR staff_is_super_admin() OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id)));

DROP POLICY IF EXISTS retail_complaints_select_scoped ON public.retail_complaints;
CREATE POLICY retail_complaints_select_scoped ON public.retail_complaints FOR SELECT
USING (staff_current_user_ok() AND (created_by = auth.uid() OR assigned_to = auth.uid() OR staff_is_management() OR staff_is_super_admin() OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))));
DROP POLICY IF EXISTS retail_complaints_update_scoped ON public.retail_complaints;
CREATE POLICY retail_complaints_update_scoped ON public.retail_complaints FOR UPDATE
USING (staff_current_user_ok() AND (created_by = auth.uid() OR assigned_to = auth.uid() OR staff_is_management() OR staff_is_super_admin() OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))))
WITH CHECK (department_id = staff_current_department_id() OR staff_is_management() OR staff_is_super_admin() OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id)));

-- retail_sales_targets: write stays dept_head/management-only by design
-- (Sales Targets card) — Super Admin joins that same restricted list
-- rather than the generic member-write shape the loop above applied.
DROP POLICY IF EXISTS retail_sales_targets_insert_scoped ON public.retail_sales_targets;
CREATE POLICY retail_sales_targets_insert_scoped ON public.retail_sales_targets FOR INSERT
WITH CHECK (staff_current_user_ok() AND (staff_is_management() OR staff_is_super_admin() OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))));
DROP POLICY IF EXISTS retail_sales_targets_update_scoped ON public.retail_sales_targets;
CREATE POLICY retail_sales_targets_update_scoped ON public.retail_sales_targets FOR UPDATE
USING (staff_current_user_ok() AND (staff_is_management() OR staff_is_super_admin() OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))))
WITH CHECK (staff_is_management() OR staff_is_super_admin() OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id)));

-- interior_pilot_audit_log: read scope only (append-only table, no
-- update policy exists to extend).
DROP POLICY IF EXISTS interior_pilot_audit_log_select_scoped ON public.interior_pilot_audit_log;
CREATE POLICY interior_pilot_audit_log_select_scoped ON public.interior_pilot_audit_log FOR SELECT
USING (staff_current_user_ok() AND (performed_by = auth.uid() OR staff_is_management() OR staff_is_super_admin() OR staff_is_dept_head()));
