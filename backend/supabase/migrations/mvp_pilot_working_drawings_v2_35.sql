-- Working Drawings module: consolidates Design, Design Approval, Design
-- Lock, Drawings, and Material Selection into one project-wise, room/area-
-- wise flow (Design Brief -> Design Development -> Design Approval ->
-- Material Approval -> Design Lock -> Working Drawings -> Internal
-- Checking -> Final Approval -> Issued for Execution).
--
-- Nothing existing is touched or migrated: the old `attachments`
-- (stage=Design/Drawings) and `project_changes` rows stay exactly where
-- they are and are surfaced read-only ("Legacy") in the new screen. This
-- guarantees no historical record can be lost by a migration step, because
-- there isn't one.
--
-- Access mirrors every other project-linked table this session
-- (interior_is_org_wide() OR interior_is_project_member(project_id),
-- mvp_pilot_interior_project_rls_v2_2w.sql) -- no finer per-role split
-- invented, consistent with every other module in this schema.

-- ---------------------------------------------------------------------
-- 1. working_drawing_areas -- the room/area entity everything hangs off
-- ---------------------------------------------------------------------
CREATE TABLE public.working_drawing_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  area_type text NOT NULL,
  custom_area_type text,
  area_name text,
  floor text,
  current_stage text NOT NULL DEFAULT 'Design Brief',
  assigned_designer_id uuid REFERENCES public.profiles(id),
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX working_drawing_areas_project_id_idx ON public.working_drawing_areas(project_id);
CREATE INDEX working_drawing_areas_current_stage_idx ON public.working_drawing_areas(current_stage);
CREATE INDEX working_drawing_areas_assigned_designer_idx ON public.working_drawing_areas(assigned_designer_id);
CREATE TRIGGER working_drawing_areas_touch_updated_at
  BEFORE UPDATE ON public.working_drawing_areas
  FOR EACH ROW EXECUTE FUNCTION public.project_materials_touch_updated_at();

-- ---------------------------------------------------------------------
-- 2. design_briefs -- one per area
-- ---------------------------------------------------------------------
CREATE TABLE public.design_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  area_id uuid NOT NULL UNIQUE REFERENCES public.working_drawing_areas(id),
  client_requirements text,
  functional_requirements text,
  style_theme text,
  colour_preference text,
  storage_requirements text,
  appliance_details text,
  site_measurements text,
  budget_reference text,
  special_requirements text,
  designer_notes text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX design_briefs_project_id_idx ON public.design_briefs(project_id);
CREATE TRIGGER design_briefs_touch_updated_at
  BEFORE UPDATE ON public.design_briefs
  FOR EACH ROW EXECUTE FUNCTION public.project_materials_touch_updated_at();

-- ---------------------------------------------------------------------
-- 3. design_versions -- immutable version chain per area
-- ---------------------------------------------------------------------
CREATE TABLE public.design_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  area_id uuid NOT NULL REFERENCES public.working_drawing_areas(id),
  design_title text,
  version_number text NOT NULL,
  revision_number integer NOT NULL DEFAULT 0,
  design_stage text NOT NULL,
  created_by uuid REFERENCES public.profiles(id),
  submitted_by uuid REFERENCES public.profiles(id),
  submission_date date,
  change_request_id uuid,
  reason_for_change text,
  client_feedback text,
  internal_feedback text,
  change_description text,
  previous_version_id uuid REFERENCES public.design_versions(id),
  is_current boolean NOT NULL DEFAULT true,
  approval_status text NOT NULL DEFAULT 'Draft',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX design_versions_project_id_idx ON public.design_versions(project_id);
CREATE INDEX design_versions_area_id_idx ON public.design_versions(area_id);
CREATE INDEX design_versions_approval_status_idx ON public.design_versions(approval_status);
CREATE INDEX design_versions_previous_version_id_idx ON public.design_versions(previous_version_id);
CREATE UNIQUE INDEX design_versions_one_current_idx ON public.design_versions(area_id) WHERE is_current = true;

-- ---------------------------------------------------------------------
-- 4. design_change_requests -- the client/internal/site/management split
--    the spec's change-count math needs. Old project_changes rows are
--    NOT migrated here -- they stay in project_changes and are shown
--    read-only, tagged Legacy, alongside these.
-- ---------------------------------------------------------------------
CREATE TABLE public.design_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  area_id uuid NOT NULL REFERENCES public.working_drawing_areas(id),
  change_type text NOT NULL,
  description text NOT NULL,
  requested_by uuid REFERENCES public.profiles(id),
  requested_date date NOT NULL DEFAULT CURRENT_DATE,
  resulting_version_id uuid REFERENCES public.design_versions(id),
  post_lock boolean NOT NULL DEFAULT false,
  cost_impact numeric,
  timeline_impact text,
  status text NOT NULL DEFAULT 'Open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX design_change_requests_project_id_idx ON public.design_change_requests(project_id);
CREATE INDEX design_change_requests_area_id_idx ON public.design_change_requests(area_id);
CREATE TRIGGER design_change_requests_touch_updated_at
  BEFORE UPDATE ON public.design_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.project_materials_touch_updated_at();

-- ---------------------------------------------------------------------
-- 5. design_approvals -- one row per approve/reject decision
-- ---------------------------------------------------------------------
CREATE TABLE public.design_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  area_id uuid NOT NULL REFERENCES public.working_drawing_areas(id),
  design_version_id uuid NOT NULL REFERENCES public.design_versions(id),
  version_number text,
  stage_at_approval text,
  decision text NOT NULL,
  decided_by uuid REFERENCES public.profiles(id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  remarks text,
  conditions text,
  approval_method text,
  proof_storage_path text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX design_approvals_project_id_idx ON public.design_approvals(project_id);
CREATE INDEX design_approvals_area_id_idx ON public.design_approvals(area_id);
CREATE INDEX design_approvals_design_version_id_idx ON public.design_approvals(design_version_id);

-- ---------------------------------------------------------------------
-- 6. design_locks -- room-wise lock record
-- ---------------------------------------------------------------------
CREATE TABLE public.design_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  area_id uuid NOT NULL REFERENCES public.working_drawing_areas(id),
  locked_version_id uuid REFERENCES public.design_versions(id),
  lock_date date NOT NULL DEFAULT CURRENT_DATE,
  locked_by uuid REFERENCES public.profiles(id),
  client_approved_date date,
  material_approval_status_snapshot text,
  final_specifications text,
  final_measurements text,
  final_finish text,
  lock_remarks text,
  client_confirmation text,
  exception_reason text,
  exception_by uuid REFERENCES public.profiles(id),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX design_locks_project_id_idx ON public.design_locks(project_id);
CREATE INDEX design_locks_area_id_idx ON public.design_locks(area_id);
CREATE UNIQUE INDEX design_locks_one_active_idx ON public.design_locks(area_id) WHERE is_active = true;

-- ---------------------------------------------------------------------
-- 7. working_drawings + drawing_versions
-- ---------------------------------------------------------------------
CREATE TABLE public.working_drawings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  area_id uuid NOT NULL REFERENCES public.working_drawing_areas(id),
  drawing_number text NOT NULL,
  drawing_title text,
  drawing_type text NOT NULL,
  related_design_version_id uuid REFERENCES public.design_versions(id),
  prepared_by uuid REFERENCES public.profiles(id),
  checked_by uuid REFERENCES public.profiles(id),
  approved_by uuid REFERENCES public.profiles(id),
  drawing_date date,
  checked_date date,
  approval_date date,
  issue_date date,
  status text NOT NULL DEFAULT 'Draft',
  issued_to text,
  issue_purpose text,
  remarks text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX working_drawings_project_id_idx ON public.working_drawings(project_id);
CREATE INDEX working_drawings_area_id_idx ON public.working_drawings(area_id);
CREATE INDEX working_drawings_status_idx ON public.working_drawings(status);
CREATE TRIGGER working_drawings_touch_updated_at
  BEFORE UPDATE ON public.working_drawings
  FOR EACH ROW EXECUTE FUNCTION public.project_materials_touch_updated_at();

CREATE TABLE public.drawing_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  drawing_id uuid NOT NULL REFERENCES public.working_drawings(id),
  version_number text NOT NULL,
  revision_number integer NOT NULL DEFAULT 0,
  previous_version_id uuid REFERENCES public.drawing_versions(id),
  is_current boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'Draft',
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drawing_versions_project_id_idx ON public.drawing_versions(project_id);
CREATE INDEX drawing_versions_drawing_id_idx ON public.drawing_versions(drawing_id);
CREATE UNIQUE INDEX drawing_versions_one_current_idx ON public.drawing_versions(drawing_id) WHERE is_current = true;
-- "Only one current Issued for Execution drawing version should exist for
-- the same drawing at one time" -- enforced at the DB level, not just UI.
CREATE UNIQUE INDEX drawing_versions_one_issued_idx ON public.drawing_versions(drawing_id) WHERE status = 'Issued for Execution';

-- ---------------------------------------------------------------------
-- 8. drawing_checklist_items (catalog/template) + drawing_checklist_results
--    (versioned per area x item, so history/reopen are real rows)
-- ---------------------------------------------------------------------
CREATE TABLE public.drawing_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  item_text_en text NOT NULL,
  item_text_gu text,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drawing_checklist_items_category_idx ON public.drawing_checklist_items(category);

CREATE TABLE public.drawing_checklist_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  area_id uuid NOT NULL REFERENCES public.working_drawing_areas(id),
  checklist_item_id uuid NOT NULL REFERENCES public.drawing_checklist_items(id),
  status text NOT NULL DEFAULT 'Not Started',
  checked_by uuid REFERENCES public.profiles(id),
  checked_date date,
  remarks text,
  proof_storage_path text,
  reopen_reason text,
  previous_result_id uuid REFERENCES public.drawing_checklist_results(id),
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drawing_checklist_results_project_id_idx ON public.drawing_checklist_results(project_id);
CREATE INDEX drawing_checklist_results_area_id_idx ON public.drawing_checklist_results(area_id);
CREATE UNIQUE INDEX drawing_checklist_results_current_idx ON public.drawing_checklist_results(area_id, checklist_item_id) WHERE is_current = true;

-- ---------------------------------------------------------------------
-- 9. drawing_issues -- Final Issue for Execution
-- ---------------------------------------------------------------------
CREATE TABLE public.drawing_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  area_id uuid NOT NULL REFERENCES public.working_drawing_areas(id),
  drawing_id uuid REFERENCES public.working_drawings(id),
  drawing_version_id uuid REFERENCES public.drawing_versions(id),
  design_version_id uuid REFERENCES public.design_versions(id),
  material_approval_status_snapshot text,
  issued_by uuid REFERENCES public.profiles(id),
  issued_to text,
  department_or_vendor text,
  issue_date date NOT NULL DEFAULT CURRENT_DATE,
  execution_start_date date,
  notes text,
  receiver_ack boolean NOT NULL DEFAULT false,
  ack_date date,
  superseded_at timestamptz,
  supersede_reason text,
  cost_impact numeric,
  timeline_impact text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drawing_issues_project_id_idx ON public.drawing_issues(project_id);
CREATE INDEX drawing_issues_area_id_idx ON public.drawing_issues(area_id);

-- ---------------------------------------------------------------------
-- 10. working_drawing_attachments -- shared attachment table for every
--     sub-module except Material Selection (which keeps its own table,
--     merged at the read layer).
-- ---------------------------------------------------------------------
CREATE TABLE public.working_drawing_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  area_id uuid NOT NULL REFERENCES public.working_drawing_areas(id),
  module text NOT NULL,
  related_record_id uuid,
  file_category text NOT NULL DEFAULT 'Other',
  file_name text NOT NULL,
  original_file_name text,
  storage_path text,
  file_type text,
  file_size bigint,
  description text,
  uploaded_by uuid REFERENCES public.profiles(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX working_drawing_attachments_project_id_idx ON public.working_drawing_attachments(project_id);
CREATE INDEX working_drawing_attachments_area_id_idx ON public.working_drawing_attachments(area_id);
CREATE INDEX working_drawing_attachments_module_record_idx ON public.working_drawing_attachments(module, related_record_id);

-- ---------------------------------------------------------------------
-- 11. Additive columns on existing tables (backward compatible)
-- ---------------------------------------------------------------------
ALTER TABLE public.material_selections ADD COLUMN area_id uuid REFERENCES public.working_drawing_areas(id);
CREATE INDEX material_selections_area_id_idx ON public.material_selections(area_id);

ALTER TABLE public.tasks ADD COLUMN area_id uuid REFERENCES public.working_drawing_areas(id);
ALTER TABLE public.tasks ADD COLUMN related_module text;
ALTER TABLE public.tasks ADD COLUMN related_record_id uuid;
ALTER TABLE public.tasks ADD COLUMN priority text;

-- ---------------------------------------------------------------------
-- 12. RLS -- same org-wide-or-project-member pattern as every other
--     project-linked table this session.
-- ---------------------------------------------------------------------
ALTER TABLE public.working_drawing_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.design_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.working_drawings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drawing_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drawing_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drawing_checklist_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drawing_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.working_drawing_attachments ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.working_drawing_areas TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.design_briefs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.design_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.design_change_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.design_approvals TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.design_locks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.working_drawings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.drawing_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.drawing_checklist_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.drawing_checklist_results TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.drawing_issues TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.working_drawing_attachments TO authenticated;

CREATE POLICY "working_drawing_areas_scoped" ON public.working_drawing_areas FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

CREATE POLICY "design_briefs_scoped" ON public.design_briefs FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

CREATE POLICY "design_versions_scoped" ON public.design_versions FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

CREATE POLICY "design_change_requests_scoped" ON public.design_change_requests FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

CREATE POLICY "design_approvals_scoped" ON public.design_approvals FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

CREATE POLICY "design_locks_scoped" ON public.design_locks FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

CREATE POLICY "working_drawings_scoped" ON public.working_drawings FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

CREATE POLICY "drawing_versions_scoped" ON public.drawing_versions FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

CREATE POLICY "drawing_issues_scoped" ON public.drawing_issues FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

CREATE POLICY "drawing_checklist_results_scoped" ON public.drawing_checklist_results FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

CREATE POLICY "working_drawing_attachments_select_scoped" ON public.working_drawing_attachments FOR SELECT TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
CREATE POLICY "working_drawing_attachments_insert_scoped" ON public.working_drawing_attachments FOR INSERT TO authenticated
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
-- Matches the existing "management can delete attachments" convention.
CREATE POLICY "working_drawing_attachments_delete_scoped" ON public.working_drawing_attachments FOR DELETE TO authenticated
  USING (public.interior_is_org_wide());

-- drawing_checklist_items: a catalog table (no project_id), like `materials`.
-- Everyone with the module needs to READ it to fill in results; only
-- org-wide (Dept Head/Management) manage the template itself.
CREATE POLICY "drawing_checklist_items_select" ON public.drawing_checklist_items FOR SELECT TO authenticated
  USING (true);
CREATE POLICY "drawing_checklist_items_insert" ON public.drawing_checklist_items FOR INSERT TO authenticated
  WITH CHECK (public.interior_is_org_wide());
CREATE POLICY "drawing_checklist_items_update" ON public.drawing_checklist_items FOR UPDATE TO authenticated
  USING (public.interior_is_org_wide()) WITH CHECK (public.interior_is_org_wide());
CREATE POLICY "drawing_checklist_items_delete" ON public.drawing_checklist_items FOR DELETE TO authenticated
  USING (public.interior_is_org_wide());

-- Storage: projects/{project_id}/working-drawings/{area_id}/{module}/{record_id}/{file}
-- already matches the existing interior_storage_project_id() helper's
-- assumption (project_id is path segment 2) -- no new storage policy needed.

-- ---------------------------------------------------------------------
-- 13. Seed the checklist catalog verbatim from the spec (117 items across
--     7 categories). English only for the item text itself -- the user
--     did not supply Gujarati translations for each checklist line, so
--     none are invented here; the surrounding screen chrome (category
--     names, statuses, actions) uses the bilingual vocabulary the user
--     did give, wired up in i18n.js.
-- ---------------------------------------------------------------------
INSERT INTO public.drawing_checklist_items (category, item_text_en, sort_order) VALUES
('General', 'Project and client details verified', 1),
('General', 'Correct room/area selected', 2),
('General', 'Latest site measurements used', 3),
('General', 'Drawing scale mentioned', 4),
('General', 'Units mentioned', 5),
('General', 'Drawing number mentioned', 6),
('General', 'Version/revision number mentioned', 7),
('General', 'Drawing date mentioned', 8),
('General', 'North direction shown where required', 9),
('General', 'Room dimensions verified', 10),
('General', 'Floor-to-ceiling height verified', 11),
('General', 'Existing site conditions verified', 12),
('General', 'Civil dimensions verified', 13),
('General', 'All notes readable', 14),
('General', 'Designer name added', 15),
('General', 'Checked-by name added', 16),
('General', 'Approval status shown', 17),

('Design', 'Design brief completed', 1),
('Design', 'Latest client requirements incorporated', 2),
('Design', 'Latest approved design version used', 3),
('Design', 'Client changes incorporated', 4),
('Design', 'Internal changes incorporated', 5),
('Design', 'Approval stage recorded', 6),
('Design', 'Approved version recorded', 7),
('Design', 'Change count verified', 8),
('Design', 'Approval proof uploaded', 9),
('Design', 'Design approval remarks resolved', 10),
('Design', 'No unresolved design requests', 11),
('Design', 'Final design marked correctly', 12),

('Material', 'Material name entered', 1),
('Material', 'Material code entered', 2),
('Material', 'Material category entered', 3),
('Material', 'Brand entered where applicable', 4),
('Material', 'Colour and finish entered', 5),
('Material', 'Thickness/specification entered', 6),
('Material', 'Material photo uploaded', 7),
('Material', 'Catalogue/specification attached', 8),
('Material', 'Room/application mapped', 9),
('Material', 'Material approval obtained', 10),
('Material', 'Approval proof uploaded', 11),
('Material', 'Rejected materials replaced', 12),
('Material', 'Final materials marked', 13),
('Material', 'Material schedule matches drawings', 14),
('Material', 'Hardware specifications completed', 15),

('Technical Drawing', 'Furniture dimensions complete', 1),
('Technical Drawing', 'Internal dimensions complete', 2),
('Technical Drawing', 'Elevations complete', 3),
('Technical Drawing', 'Sections complete', 4),
('Technical Drawing', 'Joinery details complete', 5),
('Technical Drawing', 'Material thickness shown', 6),
('Technical Drawing', 'Edge-banding details shown', 7),
('Technical Drawing', 'Laminate/veneer direction shown', 8),
('Technical Drawing', 'Hardware details shown', 9),
('Technical Drawing', 'Handle/profile details shown', 10),
('Technical Drawing', 'Drawer/channel details shown', 11),
('Technical Drawing', 'Shutter-opening direction shown', 12),
('Technical Drawing', 'Electrical points coordinated', 13),
('Technical Drawing', 'Plumbing points coordinated', 14),
('Technical Drawing', 'Appliance sizes verified', 15),
('Technical Drawing', 'Ventilation requirements checked', 16),
('Technical Drawing', 'Service/access gaps provided', 17),
('Technical Drawing', 'Skirting details shown', 18),
('Technical Drawing', 'Ceiling coordination completed', 19),
('Technical Drawing', 'Flooring coordination completed', 20),
('Technical Drawing', 'Site tolerance considered', 21),
('Technical Drawing', 'Installation clearance checked', 22),
('Technical Drawing', 'Loose-furniture placement checked', 23),
('Technical Drawing', 'Drawing notes complete', 24),
('Technical Drawing', 'BOQ/material schedule coordinated', 25),
('Technical Drawing', 'Production feasibility checked', 26),

('Kitchen', 'Final kitchen measurements verified', 1),
('Kitchen', 'Platform height verified', 2),
('Kitchen', 'Countertop dimensions verified', 3),
('Kitchen', 'Sink position verified', 4),
('Kitchen', 'Hob position verified', 5),
('Kitchen', 'Chimney position verified', 6),
('Kitchen', 'Refrigerator size verified', 7),
('Kitchen', 'Dishwasher position verified', 8),
('Kitchen', 'Microwave/oven size verified', 9),
('Kitchen', 'Electrical points verified', 10),
('Kitchen', 'Plumbing and drainage verified', 11),
('Kitchen', 'Gas-line position verified', 12),
('Kitchen', 'Basket/accessory selection approved', 13),
('Kitchen', 'Shutter material approved', 14),
('Kitchen', 'Countertop material approved', 15),
('Kitchen', 'Handle/profile approved', 16),
('Kitchen', 'Hardware brand approved', 17),
('Kitchen', 'Corner utilisation checked', 18),
('Kitchen', 'Service clearance checked', 19),

('Wardrobe/Bedroom', 'Wardrobe size verified', 1),
('Wardrobe/Bedroom', 'Internal layout approved', 2),
('Wardrobe/Bedroom', 'Hanging space checked', 3),
('Wardrobe/Bedroom', 'Drawer details checked', 4),
('Wardrobe/Bedroom', 'Loft details checked', 5),
('Wardrobe/Bedroom', 'Shutter type approved', 6),
('Wardrobe/Bedroom', 'Mirror provision checked', 7),
('Wardrobe/Bedroom', 'Handle/profile approved', 8),
('Wardrobe/Bedroom', 'Hardware approved', 9),
('Wardrobe/Bedroom', 'Bed size verified', 10),
('Wardrobe/Bedroom', 'Side-table dimensions verified', 11),
('Wardrobe/Bedroom', 'Electrical points coordinated', 12),
('Wardrobe/Bedroom', 'Material and finish approved', 13),

('Final Issue', 'Final design approved', 1),
('Final Issue', 'Final material selections approved', 2),
('Final Issue', 'Design locked', 3),
('Final Issue', 'Latest drawing version selected', 4),
('Final Issue', 'Internal technical check completed', 5),
('Final Issue', 'Project Manager approval completed', 6),
('Final Issue', 'Client approval completed where required', 7),
('Final Issue', 'Drawing files uploaded', 8),
('Final Issue', 'PDF output checked', 9),
('Final Issue', 'Source/CAD file uploaded', 10),
('Final Issue', 'Superseded drawings marked', 11),
('Final Issue', 'Execution team/vendor selected', 12),
('Final Issue', 'Issue date recorded', 13),
('Final Issue', 'Issued-for-execution confirmation completed', 14),
('Final Issue', 'Receiver acknowledgement recorded', 15);
