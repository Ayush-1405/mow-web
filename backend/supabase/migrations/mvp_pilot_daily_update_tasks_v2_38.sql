-- Person-wise task assignment from Daily Site Updates, wired into the
-- REAL cross-department task system (staff_tasks + its staff_accept_task/
-- staff_start_task/staff_complete_task/... RPCs and the generic
-- notifications table) rather than Interior's own thin `tasks` table --
-- TodayTasks.jsx only renders staff_tasks as full cards with the Accept/
-- Start/Complete/Verify/Close workflow; Interior's own `tasks` table is
-- only ever shown there as a bare link-out line. See the plan's Context
-- section for the full investigation.
--
-- Every new column is nullable and additive -- zero impact on any other
-- department's existing staff_tasks rows (all NULL for them). No existing
-- RLS clause is removed, only one new OR-branch added. staff_create_task
-- itself is untouched; this adds a NEW function instead.

-- ---------------------------------------------------------------------
-- 1. Additive columns + indexes + duplicate-prevention
-- ---------------------------------------------------------------------
ALTER TABLE public.staff_tasks ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id);
ALTER TABLE public.staff_tasks ADD COLUMN IF NOT EXISTS source_module text;
ALTER TABLE public.staff_tasks ADD COLUMN IF NOT EXISTS source_site_report_id uuid REFERENCES public.site_reports(id);
ALTER TABLE public.staff_tasks ADD COLUMN IF NOT EXISTS source_work_item_id uuid;
ALTER TABLE public.staff_tasks ADD COLUMN IF NOT EXISTS source_type text;

CREATE INDEX IF NOT EXISTS staff_tasks_project_id_idx ON public.staff_tasks(project_id);
CREATE INDEX IF NOT EXISTS staff_tasks_source_site_report_id_idx ON public.staff_tasks(source_site_report_id);

-- A repeat call for the same report/work-item/assignee triple hits this
-- constraint instead of creating a second task -- real DB-level dedup,
-- not just a disabled Send button.
CREATE UNIQUE INDEX IF NOT EXISTS staff_tasks_daily_update_dedup_idx
  ON public.staff_tasks(source_site_report_id, source_work_item_id, assigned_to)
  WHERE source_site_report_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. RLS -- one additive OR-branch on the existing SELECT policy so any
--    project teammate (not just assignor/assignee/dept-scoped roles, all
--    already covered) can see a project-linked task, matching how every
--    other Interior-linked table already works. Nothing existing removed.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "staff_tasks_select_scoped" ON public.staff_tasks;
CREATE POLICY "staff_tasks_select_scoped" ON public.staff_tasks FOR SELECT TO authenticated
USING (
  staff_current_user_ok()
  AND (
    assigned_by = (SELECT auth.uid())
    OR assigned_to = (SELECT auth.uid())
    OR current_owner_id = (SELECT auth.uid())
    OR verifier_id = (SELECT auth.uid())
    OR staff_is_management()
    OR staff_is_super_admin()
    OR (staff_is_dept_head() AND (staff_dept_in_hod_scope(from_department_id) OR staff_dept_in_hod_scope(to_department_id)))
    OR (staff_is_supervisor() AND (from_department_id = staff_current_department_id() OR to_department_id = staff_current_department_id()))
    OR (staff_is_accounts_head() AND (from_department_id = staff_current_department_id() OR to_department_id = staff_current_department_id()))
    OR (project_id IS NOT NULL AND (interior_is_org_wide() OR interior_is_project_member(project_id)))
  )
  AND (
    NOT (
      EXISTS (
        SELECT 1 FROM departments d
        WHERE d.id = ANY (ARRAY[staff_tasks.from_department_id, staff_tasks.to_department_id])
          AND d.is_confidential_domain = true
      )
      AND NOT (staff_is_management() OR staff_is_accounts_head() OR staff_current_role_code() = ANY (ARRAY['accounts_employee','cfo']))
    )
  )
);

-- ---------------------------------------------------------------------
-- 3. New RPC -- staff_create_project_task. A separate function from
--    staff_create_task (zero risk to AssignTask.jsx's existing, heavily-
--    validated flow). Authorization is PROJECT MEMBERSHIP, not the
--    generic cross-department matrix: a Daily Update assigning work to a
--    fellow project teammate is a project-scoped action, matching every
--    other Interior-linked table's RLS convention this session, not an
--    arbitrary free-form department-to-department delegation (that is
--    what AssignTask.jsx / staff_create_task remain for).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_create_project_task(
  p_project_id uuid,
  p_title text,
  p_description text,
  p_assigned_to uuid,
  p_due_date date,
  p_priority_code text,
  p_source_site_report_id uuid,
  p_source_work_item_id uuid,
  p_source_type text
)
RETURNS TABLE(task_id uuid, task_number text, already_existed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_priority_id uuid; v_task_type_id uuid; v_proof_type_id uuid; v_status_id uuid;
  v_from_dept uuid; v_to_dept uuid;
  v_is_bridge boolean;
  v_task_id uuid; v_task_number text;
  v_project_code text; v_project_customer text;
  v_existing_id uuid;
BEGIN
  PERFORM public.staff_assert_operational();

  IF NOT (public.interior_is_org_wide() OR public.interior_is_project_member(p_project_id)) THEN
    RAISE EXCEPTION 'You are not authorized to assign tasks on this project';
  END IF;

  SELECT project_code, customer INTO v_project_code, v_project_customer FROM public.projects WHERE id = p_project_id;
  IF v_project_code IS NULL THEN
    RAISE EXCEPTION 'Invalid project';
  END IF;

  SELECT department_id INTO v_to_dept FROM public.user_profiles WHERE id = p_assigned_to AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or inactive assignee';
  END IF;
  v_from_dept := public.staff_current_department_id();
  -- Management/Director-role assignees have no home department (confirmed
  -- in this pilot's real data) -- fall back to the caller's own department
  -- so a same-department, non-bridge task is created rather than violating
  -- the NOT NULL to_department_id column.
  v_to_dept := COALESCE(v_to_dept, v_from_dept);
  IF v_from_dept IS NULL THEN
    RAISE EXCEPTION 'Your staff account has no department -- cannot create a task';
  END IF;
  v_is_bridge := (v_from_dept <> v_to_dept);

  SELECT id INTO v_task_type_id FROM public.task_types WHERE code = 'GENERAL_TASK' AND is_active = true;
  SELECT id INTO v_priority_id FROM public.priority_master WHERE code = p_priority_code AND is_active = true;
  IF v_priority_id IS NULL THEN
    SELECT id INTO v_priority_id FROM public.priority_master WHERE code = 'NORMAL' AND is_active = true;
  END IF;
  SELECT id INTO v_proof_type_id FROM public.proof_types WHERE code = 'none' AND is_active = true;
  SELECT id INTO v_status_id FROM public.status_master WHERE code = 'ASSIGNED';

  INSERT INTO public.staff_tasks AS inserted_task (
    title, description, task_type_id, priority_id, status_id, proof_type_id,
    from_department_id, to_department_id, assigned_by, assigned_to, verifier_id,
    current_owner_id, due_date, project_id, source_module, source_site_report_id,
    source_work_item_id, source_type
  ) VALUES (
    p_title, p_description, v_task_type_id, v_priority_id, v_status_id, v_proof_type_id,
    v_from_dept, v_to_dept, v_caller, p_assigned_to, v_caller,
    p_assigned_to, p_due_date, p_project_id, 'daily_site_update', p_source_site_report_id,
    p_source_work_item_id, p_source_type
  )
  ON CONFLICT (source_site_report_id, source_work_item_id, assigned_to) WHERE source_site_report_id IS NOT NULL
  DO NOTHING
  RETURNING inserted_task.id, inserted_task.task_number INTO v_task_id, v_task_number;

  IF v_task_id IS NULL THEN
    -- Conflict hit -- a task for this exact report/work-item/assignee
    -- already exists (double-click / resubmit). Return it instead of
    -- creating a duplicate or erroring.
    -- Table alias required: the function's own OUT parameter `task_number`
    -- (from RETURNS TABLE) is implicitly in scope here too, so an
    -- unqualified `task_number` is ambiguous against staff_tasks.task_number.
    SELECT st.id, st.task_number INTO v_existing_id, v_task_number FROM public.staff_tasks st
      WHERE st.source_site_report_id = p_source_site_report_id
        AND st.source_work_item_id = p_source_work_item_id
        AND st.assigned_to = p_assigned_to;
    RETURN QUERY SELECT v_existing_id, v_task_number, true;
    RETURN;
  END IF;

  IF v_is_bridge THEN
    INSERT INTO public.bridges (task_id, from_department_id, to_department_id, from_person_id, to_person_id, requirement_text)
    VALUES (v_task_id, v_from_dept, v_to_dept, v_caller, p_assigned_to, p_title);
  END IF;

  PERFORM public.staff_write_audit('task', v_task_id, 'CREATE', NULL,
    jsonb_build_object('task_number', v_task_number, 'assigned_to', p_assigned_to, 'project_id', p_project_id, 'source_type', p_source_type),
    v_to_dept);

  INSERT INTO public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  VALUES (
    p_assigned_to, 'task', v_task_id,
    'You have been assigned a new project task: ' || p_title || ' — ' || v_project_code,
    'તમને નવું પ્રોજેક્ટ કામ સોંપવામાં આવ્યું છે: ' || p_title || ' — ' || v_project_code
  );

  RETURN QUERY SELECT v_task_id, v_task_number, false;
END;
$function$;

REVOKE ALL ON FUNCTION public.staff_create_project_task(uuid, text, text, uuid, date, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_create_project_task(uuid, text, text, uuid, date, text, uuid, uuid, text) TO authenticated;
