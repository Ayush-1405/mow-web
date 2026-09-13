-- Material Selection module for Interior Projects — room-wise material
-- choices with an approval workflow, revision history (a "replace" never
-- overwrites the old row, it inserts a new one referencing it), and
-- attachments. No existing table covers this: project_materials/materials
-- track purchasing quantity/status, not room-wise choices.
--
-- Access mirrors every other project-linked table this session already
-- built (interior_is_org_wide() OR interior_is_project_member(project_id),
-- mvp_pilot_interior_project_rls_v2_2w.sql) — no finer per-role split
-- (e.g. "only Designer creates, only PM approves") exists anywhere else in
-- this schema, so none is invented here either; approval/final-lock get
-- the same access as create/edit, consistent with precedent.

CREATE TABLE public.material_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  selection_date date NOT NULL,
  selected_by_type text,
  selected_by_name text,
  responsible_designer_id uuid REFERENCES public.profiles(id),
  area_type text NOT NULL,
  custom_area_type text,
  area_name text,
  floor text,
  room_number text,
  material_name text NOT NULL,
  material_code text NOT NULL,
  material_category text NOT NULL,
  custom_material_category text,
  material_type text,
  brand text,
  vendor_name text,
  colour text,
  finish text,
  texture text,
  dimensions text,
  thickness text,
  unit text,
  quantity numeric,
  rate numeric,
  estimated_amount numeric,
  usage_application text,
  description text,
  remarks text,
  approval_status text NOT NULL DEFAULT 'Draft',
  client_approval_date date,
  approved_by uuid REFERENCES public.profiles(id),
  client_remarks text,
  internal_remarks text,
  change_reason text,
  previous_selection_id uuid REFERENCES public.material_selections(id),
  revision_number integer NOT NULL DEFAULT 1,
  is_final boolean NOT NULL DEFAULT false,
  design_lock_note text,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_by uuid REFERENCES public.profiles(id),
  updated_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE INDEX material_selections_project_id_idx ON public.material_selections(project_id);
CREATE INDEX material_selections_area_type_idx ON public.material_selections(area_type);
CREATE INDEX material_selections_material_code_idx ON public.material_selections(material_code);
CREATE INDEX material_selections_approval_status_idx ON public.material_selections(approval_status);
CREATE INDEX material_selections_previous_selection_id_idx ON public.material_selections(previous_selection_id);

CREATE TRIGGER material_selections_touch_updated_at
  BEFORE UPDATE ON public.material_selections
  FOR EACH ROW EXECUTE FUNCTION public.project_materials_touch_updated_at();

CREATE TABLE public.material_selection_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  material_selection_id uuid NOT NULL REFERENCES public.material_selections(id),
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

CREATE INDEX material_selection_attachments_project_id_idx ON public.material_selection_attachments(project_id);
CREATE INDEX material_selection_attachments_selection_id_idx ON public.material_selection_attachments(material_selection_id);

ALTER TABLE public.material_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_selection_attachments ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.material_selections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.material_selection_attachments TO authenticated;

CREATE POLICY "material_selections_scoped" ON public.material_selections FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

CREATE POLICY "material_selection_attachments_select_scoped" ON public.material_selection_attachments FOR SELECT TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
CREATE POLICY "material_selection_attachments_insert_scoped" ON public.material_selection_attachments FOR INSERT TO authenticated
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
-- Delete matches the existing "management can delete attachments" convention
-- on the generic `attachments` table, using this session's own org-wide
-- check (a superset: external head/director roles + pilot Management/
-- Super Admin/Interior Dept Head) rather than the narrower external-only
-- is_management().
CREATE POLICY "material_selection_attachments_delete_scoped" ON public.material_selection_attachments FOR DELETE TO authenticated
  USING (public.interior_is_org_wide());

-- ---------------------------------------------------------------------
-- Storage RLS fix — NOT specific to Material Selection. The existing
-- interior-attachments bucket policies are bucket-wide
-- (bucket_id = 'interior-attachments' AND auth.role() = 'authenticated'),
-- so ANY authenticated user can already generate a signed URL for ANY
-- project's file today, regardless of the table-level project RLS built
-- earlier this session. Every interior attachment path already embeds its
-- project_id as the 2nd path segment (projects/{project_id}/...,
-- including this module's projects/{project_id}/material-selection/...),
-- so the same id can be checked at the storage layer.
CREATE OR REPLACE FUNCTION public.interior_storage_project_id(path text)
RETURNS uuid
LANGUAGE plpgsql STABLE
AS $$
DECLARE parts text[]; result uuid;
BEGIN
  parts := storage.foldername(path);
  IF parts IS NULL OR array_length(parts, 1) < 2 THEN RETURN NULL; END IF;
  BEGIN
    result := parts[2]::uuid;
  EXCEPTION WHEN others THEN RETURN NULL;
  END;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.interior_storage_project_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.interior_storage_project_id(text) TO authenticated;

DROP POLICY IF EXISTS "interior_attachments_storage_select" ON storage.objects;
DROP POLICY IF EXISTS "interior_attachments_storage_insert" ON storage.objects;

CREATE POLICY "interior_attachments_storage_select_scoped" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'interior-attachments'
    AND (
      public.interior_is_org_wide()
      OR public.interior_is_project_member(public.interior_storage_project_id(name))
    )
  );

CREATE POLICY "interior_attachments_storage_insert_scoped" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'interior-attachments'
    AND (
      public.interior_is_org_wide()
      OR public.interior_is_project_member(public.interior_storage_project_id(name))
    )
  );
