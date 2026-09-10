-- Mood of Wood — Staff Pilot — Interior Head Dashboard support.
--
-- Brings the staff pilot's Interior module up to the spec in
-- md/MOOD-OF-WOOD-SYSTEM.md, working against the SAME separate, live
-- Interior Projects system already integrated (projects/site_reports/
-- snags/tasks/materials/project_materials/project_changes/handovers/
-- customer_feedback/attachments/activity_logs/project_requests/profiles).
-- Three small, purely additive gaps, closed exactly as that doc's own
-- Section 10 recommends:
--
--   1. project_materials had NO unique constraint on (site_report_id,
--      material) despite the doc documenting one as existing — added here
--      so a re-sent/reloaded daily report genuinely cannot create a
--      duplicate material request (doc: "the database refuses it").
--   2. projects had no columns for the 4-point Design Freeze checklist
--      (final 3D / drawing / specifications / customer approval) the doc
--      requires before `frozen` can be set — added as 4 nullable booleans,
--      alongside a narrow interior_can_freeze_project() check.
--   3. Every staff-pilot Interior user (user_profiles) has NO matching row
--      in that separate system's own `profiles` table, so every
--      attribution field (submitted_by, assigned_to, uploaded_by,
--      requested_by, created_by, user_id — all FK'd to profiles(id)) would
--      either have to stay NULL forever or hard-fail on insert.
--      interior_ensure_profile() provisions/refreshes exactly one row in
--      `profiles` for the calling user, idempotently, so those fields can
--      finally be populated correctly. Nothing in the existing `profiles`
--      table is altered for any OTHER (non-caller) row.
--
-- Also adds a private Storage bucket + policies for real Interior
-- attachment uploads (that system's own attachments.storage_path column
-- already existed, but no bucket did).
--
-- This migration does NOT rename, drop, or change the meaning of any
-- existing column, and does not touch that external system's RLS on its
-- existing tables. Idempotent — safe to run twice.

-- 1. Duplicate-request guard.
CREATE UNIQUE INDEX IF NOT EXISTS project_materials_site_report_material_uidx
  ON public.project_materials (site_report_id, material)
  WHERE site_report_id IS NOT NULL;

-- 2. Design Freeze 4-point checklist.
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS freeze_check_3d boolean;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS freeze_check_drawing boolean;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS freeze_check_specs boolean;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS freeze_check_customer_approval boolean;

CREATE OR REPLACE FUNCTION public.interior_can_freeze_project(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(freeze_check_3d, false) AND COALESCE(freeze_check_drawing, false)
    AND COALESCE(freeze_check_specs, false) AND COALESCE(freeze_check_customer_approval, false)
  FROM public.projects WHERE id = p_project_id;
$function$;

-- 3. Provision/refresh the calling staff-pilot user's row in the external
-- profiles table, keyed by auth_id = auth.uid() (never by email — an
-- Employee-Code login has no email the two systems could collide on).
-- SECURITY DEFINER because a plain INSERT/UPDATE grant on `profiles` would
-- let any authenticated caller edit ANYONE's profile row; this function
-- only ever touches the row matching the CALLER's own auth.uid().
-- profiles.role is constrained to director/head/pm/designer/execution/
-- purchase/crm — a vocabulary the staff pilot's own roles table (management/
-- dept_head/supervisor/employee/...) doesn't carry the granularity to
-- always map automatically. management -> director and dept_head -> head
-- are unambiguous; anyone else must pass p_functional_role themselves (the
-- frontend asks once, "which of these do you do day to day", and never
-- again — interior_get_my_profile() lets it skip asking if already set).
CREATE OR REPLACE FUNCTION public.interior_ensure_profile(p_functional_role text DEFAULT NULL)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_profile public.profiles;
  v_staff record;
  v_role text;
BEGIN
  PERFORM public.staff_assert_operational();

  SELECT up.full_name, up.phone, r.code AS role_code
  INTO v_staff
  FROM public.user_profiles up
  LEFT JOIN public.roles r ON r.id = up.role_id
  WHERE up.id = auth.uid();

  IF v_staff IS NULL THEN
    RAISE EXCEPTION 'No staff pilot profile for current user';
  END IF;

  v_role := CASE
    WHEN v_staff.role_code = 'management' THEN 'director'
    WHEN v_staff.role_code = 'dept_head' THEN 'head'
    WHEN p_functional_role IN ('pm', 'designer', 'execution', 'purchase', 'crm') THEN p_functional_role
    ELSE NULL
  END;

  IF v_role IS NULL THEN
    -- Neither management/dept_head nor a valid explicit choice — leave the
    -- existing row (if any) untouched rather than writing a role the CHECK
    -- constraint would reject or silently guessing wrong; the caller
    -- re-asks for p_functional_role and retries.
    SELECT * INTO v_profile FROM public.profiles WHERE auth_id = auth.uid();
    IF v_profile IS NULL THEN
      RAISE EXCEPTION 'A functional role (pm/designer/execution/purchase/crm) is required for this user';
    END IF;
    RETURN v_profile;
  END IF;

  INSERT INTO public.profiles (auth_id, name, role, department, phone, active)
  VALUES (auth.uid(), v_staff.full_name, v_role, 'Interior', v_staff.phone, true)
  ON CONFLICT (auth_id) DO UPDATE SET
    name = EXCLUDED.name, phone = EXCLUDED.phone, active = true,
    role = CASE WHEN public.profiles.role IN ('director', 'head') THEN public.profiles.role ELSE EXCLUDED.role END
  RETURNING * INTO v_profile;

  RETURN v_profile;
END;
$function$;

CREATE OR REPLACE FUNCTION public.interior_get_my_profile()
RETURNS public.profiles
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT * FROM public.profiles WHERE auth_id = auth.uid();
$function$;

GRANT EXECUTE ON FUNCTION public.interior_can_freeze_project(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.interior_ensure_profile(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.interior_get_my_profile() TO authenticated;

-- Storage bucket for real Interior attachment uploads (that table's own
-- storage_path column already existed with nowhere to point).
INSERT INTO storage.buckets (id, name, public)
VALUES ('interior-attachments', 'interior-attachments', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS interior_attachments_storage_select ON storage.objects;
CREATE POLICY interior_attachments_storage_select ON storage.objects FOR SELECT
USING (bucket_id = 'interior-attachments' AND auth.role() = 'authenticated');
DROP POLICY IF EXISTS interior_attachments_storage_insert ON storage.objects;
CREATE POLICY interior_attachments_storage_insert ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'interior-attachments' AND auth.role() = 'authenticated');
