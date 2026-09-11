-- Adds project_id to the pilot's own Interior audit table so an Activity
-- History tab can filter by .eq('project_id', currentProjectId) instead of
-- resolving record_id -> table_name -> project_id at read time. Nullable:
-- old rows are backfilled where the table_name/record_id pair reliably
-- resolves to a project; anything that can't be resolved (e.g. a deleted
-- project_members row) stays null and surfaces in the "Unassigned
-- Activity" filter instead of being silently guessed at.
ALTER TABLE public.interior_pilot_audit_log ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id);
CREATE INDEX IF NOT EXISTS idx_interior_pilot_audit_log_project_id ON public.interior_pilot_audit_log(project_id);

-- Backfill: one UPDATE per table_name whose id space maps to a real
-- project-scoped table. Each is a narrow, reversible best-effort fill —
-- never touches rows that already have a project_id.
UPDATE public.interior_pilot_audit_log a
SET project_id = t.project_id
FROM public.attachments t
WHERE a.project_id IS NULL AND a.table_name = 'attachments' AND a.record_id = t.id;

UPDATE public.interior_pilot_audit_log a
SET project_id = t.project_id
FROM public.snags t
WHERE a.project_id IS NULL AND a.table_name = 'snags' AND a.record_id = t.id;

UPDATE public.interior_pilot_audit_log a
SET project_id = t.project_id
FROM public.tasks t
WHERE a.project_id IS NULL AND a.table_name = 'tasks' AND a.record_id = t.id;

UPDATE public.interior_pilot_audit_log a
SET project_id = t.project_id
FROM public.project_materials t
WHERE a.project_id IS NULL AND a.table_name = 'project_materials' AND a.record_id = t.id;

UPDATE public.interior_pilot_audit_log a
SET project_id = a.record_id
WHERE a.project_id IS NULL AND a.table_name = 'projects';

-- project_members rows: current members resolve directly; a since-removed
-- member's audit row (table_name='project_members', action='remove_member')
-- has no surviving row to join against, so it's left null on purpose —
-- correctly landing in "Unassigned Activity" rather than a wrong guess.
UPDATE public.interior_pilot_audit_log a
SET project_id = t.project_id
FROM public.project_members t
WHERE a.project_id IS NULL AND a.table_name = 'project_members' AND a.record_id = t.id;
