-- mvp_pilot_fk_indexes_v2_1r
--
-- Adds covering indexes for every foreign key on the pilot's own tables
-- that the Supabase performance linter (0001_unindexed_foreign_keys)
-- flagged. Purely additive — no query result ever changes, only lookup/
-- join speed as data volume grows. Deliberately scoped to staff_*/pilot
-- tables only; the pre-existing Interior-dashboard tables (activity_logs,
-- attachments, tasks, projects, etc.) are a separate system per
-- docs/mood-of-wood-architecture.md and are intentionally left untouched.
CREATE INDEX IF NOT EXISTS idx_bridges_from_department_id ON public.bridges(from_department_id);
CREATE INDEX IF NOT EXISTS idx_bridges_from_person_id ON public.bridges(from_person_id);
CREATE INDEX IF NOT EXISTS idx_bridges_to_department_id ON public.bridges(to_department_id);
CREATE INDEX IF NOT EXISTS idx_bridges_to_person_id ON public.bridges(to_person_id);
CREATE INDEX IF NOT EXISTS idx_bridges_verified_by ON public.bridges(verified_by);

CREATE INDEX IF NOT EXISTS idx_departments_department_group_id ON public.departments(department_group_id);
CREATE INDEX IF NOT EXISTS idx_departments_parent_department_id ON public.departments(parent_department_id);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_id ON public.notifications(recipient_id);

CREATE INDEX IF NOT EXISTS idx_role_creation_rules_creatable_role_id ON public.role_creation_rules(creatable_role_id);

CREATE INDEX IF NOT EXISTS idx_staff_attachments_uploaded_by ON public.staff_attachments(uploaded_by);

CREATE INDEX IF NOT EXISTS idx_staff_audit_log_department_id ON public.staff_audit_log(department_id);
CREATE INDEX IF NOT EXISTS idx_staff_audit_log_performed_by ON public.staff_audit_log(performed_by);

CREATE INDEX IF NOT EXISTS idx_staff_tasks_assigned_by ON public.staff_tasks(assigned_by);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_assigned_to ON public.staff_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_closed_by ON public.staff_tasks(closed_by);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_current_owner_id ON public.staff_tasks(current_owner_id);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_delay_responsible_user_id ON public.staff_tasks(delay_responsible_user_id);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_from_department_id ON public.staff_tasks(from_department_id);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_previous_owner_id ON public.staff_tasks(previous_owner_id);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_priority_id ON public.staff_tasks(priority_id);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_proof_type_id ON public.staff_tasks(proof_type_id);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_status_id ON public.staff_tasks(status_id);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_task_type_id ON public.staff_tasks(task_type_id);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_to_department_id ON public.staff_tasks(to_department_id);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_verified_by ON public.staff_tasks(verified_by);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_verifier_id ON public.staff_tasks(verifier_id);

CREATE INDEX IF NOT EXISTS idx_task_types_department_id ON public.task_types(department_id);

CREATE INDEX IF NOT EXISTS idx_user_location_access_granted_by ON public.user_location_access(granted_by);
CREATE INDEX IF NOT EXISTS idx_user_location_access_location_id ON public.user_location_access(location_id);

CREATE INDEX IF NOT EXISTS idx_user_profiles_created_by ON public.user_profiles(created_by);
CREATE INDEX IF NOT EXISTS idx_user_profiles_department_id ON public.user_profiles(department_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_home_location_id ON public.user_profiles(home_location_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_reports_to ON public.user_profiles(reports_to);
CREATE INDEX IF NOT EXISTS idx_user_profiles_role_id ON public.user_profiles(role_id);
