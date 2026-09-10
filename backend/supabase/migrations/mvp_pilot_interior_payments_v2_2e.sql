-- Mood of Wood — Staff Pilot — Interior Projects: payments + pilot audit log.
--
-- The separate, already-live Interior Projects system (projects/tasks/
-- site_reports/snags/materials/project_materials/project_changes/
-- handovers/customer_feedback/attachments/activity_logs/project_members/
-- its own profiles table) has NO payment ledger at all, so "Payment
-- Follow-up" cannot be read/write integration like the other 13 Interior
-- cards — it needs one genuinely new, pilot-owned table. This migration
-- does NOT create, alter, or touch any table belonging to that external
-- system; interior_payment_records.project_id is stored as a plain uuid
-- (no FK) since that system's schema is explicitly out of bounds.
--
-- Also adds interior_pilot_audit_log: since the external system has no
-- audit trail of its own, every write this pilot app makes into it (via
-- frontend/src/lib/interiorApi.js) logs a row here, so at least everything
-- done through THIS app's UI is traceable.
--
-- RLS mirrors the exact same staff_current_user_ok/staff_is_management/
-- staff_is_dept_head/staff_dept_in_hod_scope pattern as every other pilot
-- table. Purely additive, idempotent, safe to run twice.

CREATE TABLE IF NOT EXISTS public.interior_payment_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.departments(id),
  project_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL,
  payment_type text CHECK (payment_type IN ('advance','milestone','final')),
  due_date date,
  received_date date,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RECEIVED','OVERDUE')),
  note text,
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS public.interior_pilot_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name text NOT NULL,
  record_id uuid,
  action text NOT NULL,
  detail jsonb,
  performed_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.user_profiles(id),
  performed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_interior_payment_records_department_id ON public.interior_payment_records(department_id);
CREATE INDEX IF NOT EXISTS idx_interior_payment_records_project_id ON public.interior_payment_records(project_id);
CREATE INDEX IF NOT EXISTS idx_interior_pilot_audit_log_record_id ON public.interior_pilot_audit_log(record_id);
CREATE INDEX IF NOT EXISTS idx_interior_pilot_audit_log_performed_by ON public.interior_pilot_audit_log(performed_by);

DROP TRIGGER IF EXISTS trg_touch_updated_at ON public.interior_payment_records;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON public.interior_payment_records
FOR EACH ROW EXECUTE FUNCTION public.staff_touch_updated_at();

ALTER TABLE public.interior_payment_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interior_pilot_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS interior_payment_records_select_scoped ON public.interior_payment_records;
CREATE POLICY interior_payment_records_select_scoped ON public.interior_payment_records FOR SELECT
USING (
  staff_current_user_ok() AND (
    created_by = auth.uid()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
    OR (staff_is_accounts_head() AND department_id = staff_current_department_id())
  )
);
DROP POLICY IF EXISTS interior_payment_records_insert_scoped ON public.interior_payment_records;
CREATE POLICY interior_payment_records_insert_scoped ON public.interior_payment_records FOR INSERT
WITH CHECK (
  staff_current_user_ok() AND (
    department_id = staff_current_department_id()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
);
DROP POLICY IF EXISTS interior_payment_records_update_scoped ON public.interior_payment_records;
CREATE POLICY interior_payment_records_update_scoped ON public.interior_payment_records FOR UPDATE
USING (
  staff_current_user_ok() AND (
    created_by = auth.uid()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
)
WITH CHECK (
  department_id = staff_current_department_id() OR staff_is_management()
  OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
);
GRANT SELECT, INSERT, UPDATE ON public.interior_payment_records TO authenticated;

-- Append-only audit log: any operational user may log their own action;
-- reading is restricted to Interior Management/Dept Head scope so a plain
-- member can't browse everyone else's audit trail.
DROP POLICY IF EXISTS interior_pilot_audit_log_select_scoped ON public.interior_pilot_audit_log;
CREATE POLICY interior_pilot_audit_log_select_scoped ON public.interior_pilot_audit_log FOR SELECT
USING (
  staff_current_user_ok() AND (
    performed_by = auth.uid()
    OR staff_is_management()
    OR staff_is_dept_head()
  )
);
DROP POLICY IF EXISTS interior_pilot_audit_log_insert_own ON public.interior_pilot_audit_log;
CREATE POLICY interior_pilot_audit_log_insert_own ON public.interior_pilot_audit_log FOR INSERT
WITH CHECK (staff_current_user_ok() AND performed_by = auth.uid());
GRANT SELECT, INSERT ON public.interior_pilot_audit_log TO authenticated;
