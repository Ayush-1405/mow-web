-- mvp_pilot_daily_update_proof_v2_61
--
-- Lets a Daily Update work item creator require completion proof, exactly
-- like the main Assign Task module -- reusing the SAME staff_tasks lifecycle,
-- the SAME proof_types/staff_attachments tables, and the SAME
-- staff_validate_task_transition completion gate, never a parallel proof
-- system. Three new proof_types codes (note/photo_note/file_note) extend
-- the existing single-scalar proof_type_id model rather than inventing a
-- second config surface; "photo" gets a configurable minimum count instead
-- of always requiring exactly one.
--
-- Existing rows are unaffected: staff_create_project_task already defaults
-- proof_type_id to 'none' for every Daily Update task today, so every
-- historical row keeps its current (no-proof) behaviour unchanged.

-- ---------------------------------------------------------------------
-- 1. New proof_types codes.
-- ---------------------------------------------------------------------
insert into public.proof_types (code, name_en, name_gu)
select 'note', 'Completion Note', 'પૂર્ણતા નોંધ'
where not exists (select 1 from public.proof_types where code = 'note');

insert into public.proof_types (code, name_en, name_gu)
select 'photo_note', 'Photo + Note', 'ફોટો + નોંધ'
where not exists (select 1 from public.proof_types where code = 'photo_note');

insert into public.proof_types (code, name_en, name_gu)
select 'file_note', 'File + Note', 'ફાઇલ + નોંધ'
where not exists (select 1 from public.proof_types where code = 'file_note');

-- ---------------------------------------------------------------------
-- 2. New staff_tasks columns (per-task proof configuration). Existing
--    rows default to minimum_photo_count=1 / allow_multiple_photos=true /
--    proof_verification_required=true -- harmless for every existing row
--    since proof_type_id is already 'none' for all of them; these only
--    take effect once a task's proof_type_id is something other than
--    'none'.
-- ---------------------------------------------------------------------
alter table public.staff_tasks
  add column if not exists proof_instructions text,
  add column if not exists minimum_photo_count integer not null default 1,
  add column if not exists allow_multiple_photos boolean not null default true,
  add column if not exists proof_verification_required boolean not null default true;

alter table public.staff_tasks
  drop constraint if exists staff_tasks_minimum_photo_count_check;
alter table public.staff_tasks
  add constraint staff_tasks_minimum_photo_count_check check (minimum_photo_count between 1 and 10);

comment on column public.staff_tasks.proof_verification_required is
  'Informational per the existing Assign Task rules: every task already always routes COMPLETED -> verifier review -> VERIFIED -> CLOSED regardless of this flag (there is no skip-verification fast path). Captured/displayed for Daily Update tasks; not currently wired to alter the lifecycle.';

-- ---------------------------------------------------------------------
-- 3. Extend the completion-gate trigger for the 3 new proof codes, and
--    make "photo" respect minimum_photo_count instead of a hardcoded 1.
--    Everything else in this function (transition matrix, ON_HOLD/
--    REOPENED reason checks, actor-column side effects) is unchanged.
-- ---------------------------------------------------------------------
create or replace function public.staff_validate_task_transition()
 returns trigger
 language plpgsql
 set search_path to 'pg_catalog', 'public'
as $function$
declare v_old_code text; v_new_code text; v_proof_code text; v_sender uuid; v_photo_count int; v_min_photos int;
begin
  if new.status_id = old.status_id then return new; end if;

  select code into v_old_code from public.status_master where id = old.status_id;
  select code into v_new_code from public.status_master where id = new.status_id;

  if not (
    (v_old_code = 'ASSIGNED'    and v_new_code in ('ACCEPTED','RETURNED','PARTIALLY_ACCEPTED')) or
    (v_old_code = 'PARTIALLY_ACCEPTED' and v_new_code in ('ACCEPTED','IN_PROGRESS')) or
    (v_old_code = 'ACCEPTED'    and v_new_code in ('IN_PROGRESS','RETURNED')) or
    (v_old_code = 'IN_PROGRESS' and v_new_code in ('COMPLETED','RETURNED','PARTIALLY_COMPLETED','ON_HOLD')) or
    (v_old_code = 'ON_HOLD'     and v_new_code in ('IN_PROGRESS','RETURNED')) or
    (v_old_code = 'PARTIALLY_COMPLETED' and v_new_code = 'COMPLETED') or
    (v_old_code = 'COMPLETED'   and v_new_code in ('VERIFIED','RETURNED','REOPENED')) or
    (v_old_code = 'VERIFIED'    and v_new_code in ('CLOSED','REOPENED')) or
    (v_old_code = 'CLOSED'      and v_new_code = 'REOPENED') or
    (v_old_code = 'RETURNED'    and v_new_code in ('ASSIGNED','ACCEPTED')) or
    (v_old_code = 'REOPENED'    and v_new_code in ('ACCEPTED','IN_PROGRESS'))
  ) then
    raise exception 'Invalid task status transition: % -> %', v_old_code, v_new_code;
  end if;

  if v_new_code = 'RETURNED' and (new.return_reason is null or btrim(new.return_reason) = '') then
    raise exception 'return_reason is required when returning a task';
  end if;

  if v_new_code = 'ON_HOLD' and (new.hold_reason is null or btrim(new.hold_reason) = '') then
    raise exception 'hold_reason is required when putting a task on hold';
  end if;

  if v_new_code = 'REOPENED' and (new.reopen_reason is null or btrim(new.reopen_reason) = '') then
    raise exception 'reopen_reason is required when reopening a task';
  end if;

  if v_new_code = 'COMPLETED' then
    select code into v_proof_code from public.proof_types where id = new.proof_type_id;
    v_min_photos := greatest(coalesce(new.minimum_photo_count, 1), 1);

    if v_proof_code = 'photo' then
      select count(*) into v_photo_count from public.staff_attachments where entity_type='task' and entity_id=new.id and is_active=true and file_type='image';
      if v_photo_count < v_min_photos then
        raise exception 'At least % photo attachment(s) are required to complete this task (% uploaded)', v_min_photos, v_photo_count;
      end if;
    elsif v_proof_code = 'document' then
      if not exists (select 1 from public.staff_attachments where entity_type='task' and entity_id=new.id and is_active=true and file_type in ('pdf','word','excel','drawing')) then
        raise exception 'A document attachment (PDF/Word/Excel/drawing) is required to complete this task';
      end if;
    elsif v_proof_code = 'barcode' then
      if not exists (select 1 from public.staff_attachments where entity_type='task' and entity_id=new.id and is_active=true and file_type='image') then
        raise exception 'A barcode evidence image is required to complete this task';
      end if;
    elsif v_proof_code = 'customer_confirmation' then
      if new.customer_confirmation_text is null and not exists (select 1 from public.staff_attachments where entity_type='task' and entity_id=new.id and is_active=true) then
        raise exception 'Customer confirmation text or an attachment is required to complete this task';
      end if;
    elsif v_proof_code = 'voice' then
      if not exists (select 1 from public.staff_attachments where entity_type='task' and entity_id=new.id and is_active=true and file_type='voice') then
        raise exception 'A voice note is required to complete this task';
      end if;
    elsif v_proof_code = 'note' then
      if coalesce(btrim(new.completion_note), '') = '' then
        raise exception 'A completion note is required to complete this task';
      end if;
    elsif v_proof_code = 'photo_note' then
      select count(*) into v_photo_count from public.staff_attachments where entity_type='task' and entity_id=new.id and is_active=true and file_type='image';
      if v_photo_count < v_min_photos then
        raise exception 'At least % photo attachment(s) are required to complete this task (% uploaded)', v_min_photos, v_photo_count;
      end if;
      if coalesce(btrim(new.completion_note), '') = '' then
        raise exception 'A completion note is required to complete this task';
      end if;
    elsif v_proof_code = 'file_note' then
      if not exists (select 1 from public.staff_attachments where entity_type='task' and entity_id=new.id and is_active=true and file_type in ('pdf','word','excel','drawing')) then
        raise exception 'A document attachment is required to complete this task';
      end if;
      if coalesce(btrim(new.completion_note), '') = '' then
        raise exception 'A completion note is required to complete this task';
      end if;
    end if;
  end if;

  if v_new_code = 'CLOSED' and new.closed_by is null and old.closed_by is null then
    raise exception 'closed_by is required when closing a task';
  end if;

  case v_new_code
    when 'ACCEPTED' then
      new.previous_owner_id := old.current_owner_id;
      new.current_owner_id  := new.assigned_to;
      new.accepted_at := now();
    when 'IN_PROGRESS' then
      if v_old_code = 'ON_HOLD' then
        new.held_by := null; new.held_at := null; new.hold_reason := null;
      end if;
    when 'COMPLETED' then
      new.previous_owner_id := old.current_owner_id;
      new.current_owner_id  := new.verifier_id;
      new.completed_at := now();
    when 'RETURNED' then
      new.previous_owner_id := old.current_owner_id;
      if new.is_bridge then
        select from_person_id into v_sender from public.bridges where task_id = new.id;
        if v_sender is null then raise exception 'Bridge sender could not be resolved for task %', new.id; end if;
        new.current_owner_id := v_sender;
      else
        new.current_owner_id := new.assigned_by;
      end if;
    when 'VERIFIED' then
      if new.verified_by is null then new.verified_by := auth.uid(); end if;
      new.verified_at := now();
    when 'CLOSED' then
      if new.closed_by is null then new.closed_by := auth.uid(); end if;
      new.closed_at := now();
    else null;
  end case;

  return new;
end;
$function$;

-- ---------------------------------------------------------------------
-- 4. staff_create_project_task -- new optional proof-config params,
--    defaulting to today's exact behaviour (proof_type_code='none') so
--    every existing caller (InteriorDailyUpdates.jsx, before its own
--    frontend update lands) keeps working unmodified. proof_instructions
--    is required (at the RPC layer, not a table-wide CHECK constraint --
--    that would also apply to staff_create_task/Assign Task, which has no
--    such field to fill it in) whenever proof_type_code isn't 'none'.
-- ---------------------------------------------------------------------
create or replace function public.staff_create_project_task(
  p_project_id uuid, p_title text, p_description text, p_assigned_to uuid, p_due_date date, p_priority_code text,
  p_source_site_report_id uuid, p_source_work_item_id uuid, p_source_type text,
  p_proof_type_code text default 'none', p_proof_instructions text default null,
  p_minimum_photo_count integer default 1, p_allow_multiple_photos boolean default true,
  p_proof_verification_required boolean default true
)
 returns TABLE(task_id uuid, task_number text, already_existed boolean)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_caller uuid := auth.uid();
  v_priority_id uuid; v_task_type_id uuid; v_proof_type_id uuid; v_status_id uuid;
  v_from_dept uuid; v_to_dept uuid;
  v_is_bridge boolean;
  v_task_id uuid; v_task_number text;
  v_project_code text; v_project_customer text;
  v_existing_id uuid;
  v_min_photos integer;
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
  v_to_dept := COALESCE(v_to_dept, v_from_dept);
  IF v_from_dept IS NULL THEN
    RAISE EXCEPTION 'Your staff account has no department -- cannot create a task';
  END IF;
  v_is_bridge := (v_from_dept <> v_to_dept);

  SELECT id INTO v_proof_type_id FROM public.proof_types WHERE code = coalesce(p_proof_type_code, 'none') AND is_active = true;
  IF v_proof_type_id IS NULL THEN
    RAISE EXCEPTION 'Invalid proof_type_code';
  END IF;
  IF p_proof_type_code IS DISTINCT FROM 'none' AND (p_proof_instructions IS NULL OR btrim(p_proof_instructions) = '') THEN
    RAISE EXCEPTION 'Proof instructions are required when proof is required';
  END IF;
  v_min_photos := greatest(least(coalesce(p_minimum_photo_count, 1), 10), 1);

  SELECT id INTO v_task_type_id FROM public.task_types WHERE code = 'GENERAL_TASK' AND is_active = true;
  SELECT id INTO v_priority_id FROM public.priority_master WHERE code = p_priority_code AND is_active = true;
  IF v_priority_id IS NULL THEN
    SELECT id INTO v_priority_id FROM public.priority_master WHERE code = 'NORMAL' AND is_active = true;
  END IF;
  SELECT id INTO v_status_id FROM public.status_master WHERE code = 'ASSIGNED';

  INSERT INTO public.staff_tasks AS inserted_task (
    title, description, task_type_id, priority_id, status_id, proof_type_id,
    from_department_id, to_department_id, assigned_by, assigned_to, verifier_id,
    current_owner_id, due_date, project_id, source_module, source_site_report_id,
    source_work_item_id, source_type,
    proof_instructions, minimum_photo_count, allow_multiple_photos, proof_verification_required
  ) VALUES (
    p_title, p_description, v_task_type_id, v_priority_id, v_status_id, v_proof_type_id,
    v_from_dept, v_to_dept, v_caller, p_assigned_to, v_caller,
    p_assigned_to, p_due_date, p_project_id, 'daily_site_update', p_source_site_report_id,
    p_source_work_item_id, p_source_type,
    nullif(btrim(coalesce(p_proof_instructions, '')), ''), v_min_photos, coalesce(p_allow_multiple_photos, true), coalesce(p_proof_verification_required, true)
  )
  ON CONFLICT (source_site_report_id, source_work_item_id, assigned_to) WHERE source_site_report_id IS NOT NULL
  DO NOTHING
  RETURNING inserted_task.id, inserted_task.task_number INTO v_task_id, v_task_number;

  IF v_task_id IS NULL THEN
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

  INSERT INTO public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by)
  VALUES (v_task_id, p_assigned_to, 'primary', v_caller);

  PERFORM public.staff_write_audit('task', v_task_id, 'CREATE', NULL,
    jsonb_build_object('task_number', v_task_number, 'assigned_to', p_assigned_to, 'project_id', p_project_id, 'source_type', p_source_type, 'proof_type_code', p_proof_type_code),
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
