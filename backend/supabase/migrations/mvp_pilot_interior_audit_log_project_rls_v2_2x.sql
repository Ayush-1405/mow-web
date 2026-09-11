-- interior_pilot_audit_log_select_scoped only let a caller see rows THEY
-- performed (plus management/dept_head/super_admin) — useless as a shared
-- per-project Activity History, since a PM would only see their own
-- actions, never the designer's or execution's. Widen to also include
-- anyone who is a member of the project the row now belongs to (added by
-- the project_id backfill in mvp_pilot_interior_audit_project_id_v2_2v).
-- Also adds the UPDATE policy the "assign unassigned activity to this
-- project" action needs (elevated roles only, matching the UI gate).
DROP POLICY IF EXISTS "interior_pilot_audit_log_select_scoped" ON public.interior_pilot_audit_log;
CREATE POLICY "interior_pilot_audit_log_select_scoped" ON public.interior_pilot_audit_log FOR SELECT TO authenticated
  USING (staff_current_user_ok() AND (
    performed_by = (SELECT auth.uid())
    OR staff_is_management() OR staff_is_super_admin() OR staff_is_dept_head()
    OR (project_id IS NOT NULL AND public.interior_is_project_member(project_id))
  ));

CREATE POLICY "interior_pilot_audit_log_update_elevated" ON public.interior_pilot_audit_log FOR UPDATE TO authenticated
  USING (staff_current_user_ok() AND (staff_is_management() OR staff_is_super_admin() OR staff_is_dept_head()))
  WITH CHECK (staff_current_user_ok() AND (staff_is_management() OR staff_is_super_admin() OR staff_is_dept_head()));
