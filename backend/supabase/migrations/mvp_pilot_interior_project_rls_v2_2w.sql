-- Project-membership RLS for the Interior Projects module. Previously
-- every project-linked table here was wide open (qual: true) — a
-- documented standing decision since this is a separate, pre-existing
-- system. The user has now explicitly asked for real DB-level scoping:
-- a PM/Designer/Execution person should only reach their own assigned
-- project(s); Head/Director/Purchase/CRM (the org-wide functional roles
-- Purchase Board and Client Communication already depend on seeing
-- everything) and the pilot's own Management/Interior-Dept-Head keep
-- full visibility. Built on the external system's OWN existing helpers
-- (current_user_role(), is_management()) plus the pilot's staff_is_*
-- functions already used throughout staff_tasks RLS — no duplicated logic.

CREATE OR REPLACE FUNCTION public.interior_current_profile_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT id FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.interior_is_org_wide()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT coalesce(public.current_user_role() IN ('head', 'director', 'purchase', 'crm'), false)
    OR public.staff_is_management()
    OR public.staff_is_super_admin()
    OR (public.staff_is_dept_head() AND public.staff_dept_in_hod_scope(
          (SELECT id FROM public.departments WHERE code = 'INTERIOR')
        ));
$$;

CREATE OR REPLACE FUNCTION public.interior_is_project_member(p_project_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id
      AND public.interior_current_profile_id() IN (p.project_manager_id, p.designer_id, p.execution_id)
  ) OR EXISTS (
    SELECT 1 FROM public.project_members pm
    WHERE pm.project_id = p_project_id AND pm.profile_id = public.interior_current_profile_id()
  );
$$;

REVOKE ALL ON FUNCTION public.interior_current_profile_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.interior_is_org_wide() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.interior_is_project_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.interior_current_profile_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.interior_is_org_wide() TO authenticated;
GRANT EXECUTE ON FUNCTION public.interior_is_project_member(uuid) TO authenticated;

-- ---------- projects (consolidating pre-existing duplicate policies) ----------
DROP POLICY IF EXISTS "authenticated users can create projects" ON public.projects;
DROP POLICY IF EXISTS "team can create projects" ON public.projects;
DROP POLICY IF EXISTS "authenticated users can view projects" ON public.projects;
DROP POLICY IF EXISTS "team can read projects" ON public.projects;
DROP POLICY IF EXISTS "authenticated users can update projects" ON public.projects;
DROP POLICY IF EXISTS "team can update projects" ON public.projects;

CREATE POLICY "projects_insert_scoped" ON public.projects FOR INSERT TO authenticated
  WITH CHECK (public.interior_is_org_wide() OR public.current_user_role() = 'pm');
CREATE POLICY "projects_select_scoped" ON public.projects FOR SELECT TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(id));
CREATE POLICY "projects_update_scoped" ON public.projects FOR UPDATE TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(id));
-- "only directors and head can delete projects" (DELETE, is_management()) — already correctly scoped, untouched.

-- ---------- attachments ----------
DROP POLICY IF EXISTS "authenticated users can view attachments" ON public.attachments;
DROP POLICY IF EXISTS "authenticated users can upload attachments" ON public.attachments;
DROP POLICY IF EXISTS "authenticated users can update attachments" ON public.attachments;

CREATE POLICY "attachments_select_scoped" ON public.attachments FOR SELECT TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
CREATE POLICY "attachments_insert_scoped" ON public.attachments FOR INSERT TO authenticated
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
CREATE POLICY "attachments_update_scoped" ON public.attachments FOR UPDATE TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
-- "management can delete attachments" (DELETE, is_management()) — untouched.

-- ---------- snags / tasks / site_reports / project_changes / project_requests / handovers / customer_feedback ----------
-- Same shape each: a single pre-existing ALL/qual:true policy, replaced
-- with the same ALL command scoped to org-wide-or-project-member.
DROP POLICY IF EXISTS "authenticated users can manage snags" ON public.snags;
CREATE POLICY "snags_scoped" ON public.snags FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

DROP POLICY IF EXISTS "authenticated users can manage tasks" ON public.tasks;
CREATE POLICY "tasks_scoped" ON public.tasks FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

DROP POLICY IF EXISTS "authenticated users can manage site reports" ON public.site_reports;
CREATE POLICY "site_reports_scoped" ON public.site_reports FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

DROP POLICY IF EXISTS "authenticated users can manage changes" ON public.project_changes;
CREATE POLICY "project_changes_scoped" ON public.project_changes FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

DROP POLICY IF EXISTS "authenticated users can manage requests" ON public.project_requests;
CREATE POLICY "project_requests_scoped" ON public.project_requests FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

DROP POLICY IF EXISTS "authenticated users can manage handovers" ON public.handovers;
CREATE POLICY "handovers_scoped" ON public.handovers FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

DROP POLICY IF EXISTS "authenticated users can manage feedback" ON public.customer_feedback;
CREATE POLICY "customer_feedback_scoped" ON public.customer_feedback FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

-- ---------- project_members ----------
DROP POLICY IF EXISTS "authenticated users can manage project members" ON public.project_members;
DROP POLICY IF EXISTS "authenticated users can view project members" ON public.project_members;
CREATE POLICY "project_members_scoped" ON public.project_members FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

-- ---------- project_materials ----------
-- "purchase updates/deletes project materials" already role-scoped
-- (purchase/director/head) — untouched. Only the wide-open read/insert
-- policies are tightened.
DROP POLICY IF EXISTS "read project materials" ON public.project_materials;
DROP POLICY IF EXISTS "request project materials" ON public.project_materials;
CREATE POLICY "project_materials_select_scoped" ON public.project_materials FOR SELECT TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
CREATE POLICY "project_materials_insert_scoped" ON public.project_materials FOR INSERT TO authenticated
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

-- ---------- materials (catalog table, no project_id column — org-wide only) ----------
DROP POLICY IF EXISTS "authenticated users can manage materials" ON public.materials;
CREATE POLICY "materials_org_wide" ON public.materials FOR ALL TO authenticated
  USING (public.interior_is_org_wide())
  WITH CHECK (public.interior_is_org_wide());

-- ---------- activity_logs (project_id nullable — scoped rows only; org-wide sees all) ----------
DROP POLICY IF EXISTS "authenticated users can view activity logs" ON public.activity_logs;
DROP POLICY IF EXISTS "authenticated users can create activity logs" ON public.activity_logs;
CREATE POLICY "activity_logs_select_scoped" ON public.activity_logs FOR SELECT TO authenticated
  USING (public.interior_is_org_wide() OR (project_id IS NOT NULL AND public.interior_is_project_member(project_id)));
CREATE POLICY "activity_logs_insert_scoped" ON public.activity_logs FOR INSERT TO authenticated
  WITH CHECK (public.interior_is_org_wide() OR (project_id IS NOT NULL AND public.interior_is_project_member(project_id)));

-- ---------- interior_payment_records (pilot-owned; additive widen only) ----------
-- Already scoped by department/management/dept_head/created_by — this
-- just ALSO lets an actual project team member see their own project's
-- payment follow-ups, which the existing department-only scoping missed
-- for a plain PM/Designer/Execution person.
DROP POLICY IF EXISTS "interior_payment_records_select_scoped" ON public.interior_payment_records;
CREATE POLICY "interior_payment_records_select_scoped" ON public.interior_payment_records FOR SELECT TO authenticated
  USING (staff_current_user_ok() AND (
    created_by = (SELECT auth.uid())
    OR staff_is_management() OR staff_is_super_admin()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
    OR (staff_is_accounts_head() AND (department_id = staff_current_department_id()))
    OR public.interior_is_project_member(project_id)
  ));
