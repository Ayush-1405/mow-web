-- mvp_pilot_shared_task_status_v2_60
--
-- Multi-assignee ("Second Assignee") tasks used to run TWO independent
-- lifecycles: every assignee had to individually Accept/Start/Complete
-- (staff_recompute_task_status only advanced the shared staff_tasks.status_id
-- once every active staff_task_assignees row agreed), producing
-- PARTIALLY_ACCEPTED / PARTIALLY_COMPLETED and forcing a second, redundant
-- Accept from whichever assignee acted second. This migration makes a task
-- with N assignees ONE shared task with ONE common lifecycle: any one active
-- assignee's Accept/Start/Complete/Hold/Resume immediately becomes the
-- lifecycle for everyone, staff_tasks.status_id is the single source of
-- truth (never recomputed from per-assignee completion), and single-assignee
-- tasks go through the exact same code path (an assignee count of one is
-- just the trivial case of "any one of them").
--
-- New first-class statuses: ON_HOLD (replaces the old per-assignee
-- individual_status='BLOCKED'/help_requested-only "blocked" concept with a
-- real shared status everyone sees) and REOPENED (verification rejection or
-- a management-initiated reopen after COMPLETED/VERIFIED/CLOSED -- old
-- completion proof and history are preserved, never deleted).
--
-- completion_rule ('BOTH'/'ANY_ONE') is deprecated, not dropped: every task
-- now behaves as ANY_ONE unconditionally, so the column is no longer read by
-- any function. Kept for historical/audit reference only.

-- ---------------------------------------------------------------------
-- 1. New actor/reason columns on staff_tasks -- these, plus status_id, are
--    the complete shared-lifecycle state. staff_task_assignees rows are
--    still written to for richer per-person audit trail (who personally
--    touched their own row) but are never aggregated to decide the shared
--    status any more.
-- ---------------------------------------------------------------------
alter table public.staff_tasks
  add column if not exists accepted_by uuid references public.user_profiles(id),
  add column if not exists started_by uuid references public.user_profiles(id),
  add column if not exists completed_by uuid references public.user_profiles(id),
  add column if not exists completion_note text,
  add column if not exists held_by uuid references public.user_profiles(id),
  add column if not exists held_at timestamptz,
  add column if not exists hold_reason text,
  add column if not exists reopened_by uuid references public.user_profiles(id),
  add column if not exists reopened_at timestamptz,
  add column if not exists reopen_reason text;

comment on column public.staff_tasks.completion_rule is
  'Deprecated as of mvp_pilot_shared_task_status_v2_60 -- every task (single or multi assignee) now uses ANY-ONE shared-lifecycle semantics unconditionally. No function reads this column any more; kept only for historical/audit reference.';

update public.staff_tasks set completion_rule = 'ANY_ONE' where completion_rule is distinct from 'ANY_ONE';
alter table public.staff_tasks alter column completion_rule set default 'ANY_ONE';

comment on function public.staff_recompute_task_status(uuid) is
  'Deprecated as of mvp_pilot_shared_task_status_v2_60 -- no longer called by staff_accept_task/staff_start_task/staff_complete_task (they set staff_tasks.status_id directly, ANY-ONE semantics). Still called by staff_remove_second_assignee as a defensive no-op; safe to leave since no task can reach PARTIALLY_ACCEPTED/PARTIALLY_COMPLETED under the new RPCs.';

-- ---------------------------------------------------------------------
-- 2. New shared statuses.
-- ---------------------------------------------------------------------
insert into public.status_master (code, name_en, name_gu, sort_order)
select 'ON_HOLD', 'On Hold', 'અટકાવેલું', 8
where not exists (select 1 from public.status_master where code = 'ON_HOLD');

insert into public.status_master (code, name_en, name_gu, sort_order)
select 'REOPENED', 'Reopened', 'ફરીથી ખોલાયું', 9
where not exists (select 1 from public.status_master where code = 'REOPENED');

-- ---------------------------------------------------------------------
-- 3. Transition trigger: extend the matrix for ON_HOLD/REOPENED and add
--    mandatory-reason validation for both (defense in depth -- the RPCs
--    below already enforce this before ever attempting the UPDATE).
--    accepted_by/started_by/completed_by/held_by/reopened_by are now set
--    explicitly by each RPC's own UPDATE statement (auth.uid() is always
--    available there); this trigger only maintains the derived
--    current_owner_id/previous_owner_id/timestamp side effects that follow
--    purely from WHICH status was entered, exactly as it always did for
--    ACCEPTED/COMPLETED/RETURNED/VERIFIED/CLOSED.
-- ---------------------------------------------------------------------
create or replace function public.staff_validate_task_transition()
 returns trigger
 language plpgsql
 set search_path to 'pg_catalog', 'public'
as $function$
declare v_old_code text; v_new_code text; v_proof_code text; v_sender uuid;
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
    if v_proof_code = 'photo' then
      if not exists (select 1 from public.staff_attachments where entity_type='task' and entity_id=new.id and is_active=true and file_type='image') then
        raise exception 'A photo attachment is required to complete this task';
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
        -- Resume: clear the hold marker, but never touch started_by/
        -- started_at -- resuming is not a fresh "start", so the original
        -- starter stays attributed.
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
-- 4. staff_accept_task -- ANY active assignee accepts once for everyone.
--    Row-locked via `for update` on both staff_tasks and the caller's own
--    staff_task_assignees row, so two simultaneous Accept calls serialize;
--    the second sees the already-updated status and gets a clear,
--    specific error instead of a duplicate/blind update.
-- ---------------------------------------------------------------------
create or replace function public.staff_accept_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid; v_actor_name text; v_my_row record; v_row record;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;
  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;
  if v_my_row.id is null then
    raise exception 'You are not an active assignee on this task';
  end if;

  if v_old_code not in ('ASSIGNED','RETURNED','REOPENED') then
    if v_old_code in ('ACCEPTED','IN_PROGRESS','ON_HOLD','COMPLETED','VERIFIED','CLOSED') then
      raise exception 'This task was already accepted by %', coalesce((select full_name from public.user_profiles where id = v_task.accepted_by), 'another assignee');
    end if;
    raise exception 'Task must be ASSIGNED, RETURNED, or REOPENED to accept (currently %)', v_old_code;
  end if;

  update public.staff_task_assignees set acceptance_status = 'ACCEPTED', accepted_at = now(),
    individual_status = case when individual_status in ('ASSIGNED','REJECTED') then 'ACCEPTED' else individual_status end
    where id = v_my_row.id;

  select id into v_status_id from public.status_master where code = 'ACCEPTED';
  update public.staff_tasks set status_id = v_status_id, accepted_by = auth.uid()
    where id = p_task_id and status_id = v_task.status_id;

  if v_task.is_bridge then
    update public.bridges set acceptance_status = 'ACCEPTED', accepted_at = now() where task_id = p_task_id;
  end if;

  perform public.staff_write_audit('task', p_task_id, 'ACCEPT', jsonb_build_object('status', v_old_code), jsonb_build_object('status','ACCEPTED','accepted_by', auth.uid()), v_task.to_department_id);
  perform public.staff_post_system_task_message(p_task_id, 'Accepted by ' || v_actor_name, v_actor_name || ' દ્વારા સ્વીકારાયું');

  perform public.staff_notify_assignment(v_task.assigned_by, 'task', p_task_id, 'Task accepted: ' || v_task.task_number, 'કામ સ્વીકાર્યું: ' || v_task.task_number);
  for v_row in select user_id from public.staff_task_assignees where task_id = p_task_id and is_active loop
    perform public.staff_notify_assignment(v_row.user_id, 'task', p_task_id, v_actor_name || ' accepted shared task ' || v_task.task_number, v_actor_name || ' એ સહિયારું કાર્ય સ્વીકાર્યું ' || v_task.task_number);
  end loop;
end;
$function$;

-- ---------------------------------------------------------------------
-- 5. staff_start_task -- ANY active assignee starts once for everyone.
--    Allowed from ACCEPTED or REOPENED (no forced re-accept after reopen).
-- ---------------------------------------------------------------------
create or replace function public.staff_start_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid; v_actor_name text; v_my_row record; v_row record;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;
  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;
  if v_my_row.id is null then
    raise exception 'You are not an active assignee on this task';
  end if;

  if v_old_code not in ('ACCEPTED','REOPENED') then
    if v_old_code = 'IN_PROGRESS' then
      raise exception 'This task was already started by %', coalesce((select full_name from public.user_profiles where id = v_task.started_by), 'another assignee');
    end if;
    raise exception 'Task must be ACCEPTED (or REOPENED) to start (currently %)', v_old_code;
  end if;

  update public.staff_task_assignees set individual_status = 'IN_PROGRESS' where id = v_my_row.id;

  select id into v_status_id from public.status_master where code = 'IN_PROGRESS';
  update public.staff_tasks set status_id = v_status_id, started_by = auth.uid(), started_at = now()
    where id = p_task_id and status_id = v_task.status_id;

  perform public.staff_write_audit('task', p_task_id, 'START', jsonb_build_object('status', v_old_code), jsonb_build_object('status','IN_PROGRESS','started_by', auth.uid()), v_task.to_department_id);
  perform public.staff_post_system_task_message(p_task_id, 'Task started by ' || v_actor_name, v_actor_name || ' દ્વારા કાર્ય શરૂ કરાયું');

  for v_row in select user_id from public.staff_task_assignees where task_id = p_task_id and is_active loop
    perform public.staff_notify_assignment(v_row.user_id, 'task', p_task_id, v_actor_name || ' started shared task ' || v_task.task_number, v_actor_name || ' એ સહિયારું કાર્ય શરૂ કર્યું ' || v_task.task_number);
  end loop;
end;
$function$;

-- ---------------------------------------------------------------------
-- 6. staff_complete_task -- ANY active assignee completes once for
--    everyone (gated on the SHARED status being IN_PROGRESS, not on the
--    caller's own individual_status -- the other assignee may never have
--    personally clicked Start, and that must not block completion).
--    Proof (staff_attachments, entity_id = task id) was already shared by
--    design before this migration -- unchanged here.
-- ---------------------------------------------------------------------
create or replace function public.staff_complete_task(p_task_id uuid, p_customer_confirmation_text text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid; v_actor_name text; v_my_row record; v_row record;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;
  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;
  if v_my_row.id is null then
    raise exception 'You are not an active assignee on this task';
  end if;

  if v_old_code <> 'IN_PROGRESS' then
    if v_old_code in ('COMPLETED','VERIFIED','CLOSED') then
      raise exception 'This task was already completed by %', coalesce((select full_name from public.user_profiles where id = v_task.completed_by), 'another assignee');
    end if;
    raise exception 'Task must be IN_PROGRESS to complete (currently %)', v_old_code;
  end if;

  update public.staff_task_assignees set individual_status = 'COMPLETED', completed_at = now(), completion_note = p_customer_confirmation_text
    where id = v_my_row.id;

  select id into v_status_id from public.status_master where code = 'COMPLETED';
  update public.staff_tasks set status_id = v_status_id, completed_by = auth.uid(),
    customer_confirmation_text = p_customer_confirmation_text,
    completion_note = coalesce(p_customer_confirmation_text, completion_note)
    where id = p_task_id and status_id = v_task.status_id;

  if v_task.is_bridge then
    update public.bridges set completed_at = now() where task_id = p_task_id;
  end if;

  perform public.staff_write_audit('task', p_task_id, 'COMPLETE', jsonb_build_object('status', v_old_code), jsonb_build_object('status','COMPLETED','completed_by', auth.uid()), v_task.to_department_id);
  perform public.staff_post_system_task_message(p_task_id, 'Task completed by ' || v_actor_name || ' — verification requested', v_actor_name || ' દ્વારા કાર્ય પૂર્ણ — ચકાસણી માટે વિનંતી');

  perform public.staff_notify_assignment(v_task.verifier_id, 'task', p_task_id, 'Ready for verification: ' || v_task.task_number, 'ચકાસણી માટે તૈયાર: ' || v_task.task_number);
  for v_row in select user_id from public.staff_task_assignees where task_id = p_task_id and is_active loop
    perform public.staff_notify_assignment(v_row.user_id, 'task', p_task_id, v_actor_name || ' completed shared task ' || v_task.task_number, v_actor_name || ' એ સહિયારું કાર્ય પૂર્ણ કર્યું ' || v_task.task_number);
  end loop;
end;
$function$;

create or replace function public.staff_complete_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.staff_complete_task(p_task_id, null);
end;
$function$;

-- ---------------------------------------------------------------------
-- 7. staff_set_task_blocked -- now a real shared ON_HOLD status (was:
--    a per-assignee individual_status='BLOCKED'/help_requested flag that
--    never changed the shared status_id). p_blocked=true requires a
--    reason and only fires from IN_PROGRESS; p_blocked=false (Resume)
--    only fires from ON_HOLD and deliberately does NOT touch started_by/
--    started_at. staff_request_help (a separate, lighter "I need help"
--    ping that never changes status_id) is unaffected by this change.
-- ---------------------------------------------------------------------
create or replace function public.staff_set_task_blocked(p_task_id uuid, p_blocked boolean, p_note text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid; v_actor_name text; v_my_row record; v_row record;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;
  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;
  if v_my_row.id is null then
    raise exception 'You are not an active assignee on this task';
  end if;

  if p_blocked then
    if v_old_code <> 'IN_PROGRESS' then
      if v_old_code = 'ON_HOLD' then
        raise exception 'This task is already on hold (placed on hold by %)', coalesce((select full_name from public.user_profiles where id = v_task.held_by), 'another assignee');
      end if;
      raise exception 'Only an IN_PROGRESS task can be put on hold (currently %)', v_old_code;
    end if;
    if p_note is null or btrim(p_note) = '' then
      raise exception 'A reason is required to put this task on hold';
    end if;

    select id into v_status_id from public.status_master where code = 'ON_HOLD';
    update public.staff_tasks set status_id = v_status_id, held_by = auth.uid(), held_at = now(), hold_reason = p_note
      where id = p_task_id and status_id = v_task.status_id;
    update public.staff_task_assignees set individual_status = 'BLOCKED' where id = v_my_row.id;

    perform public.staff_write_audit('task', p_task_id, 'HOLD', jsonb_build_object('status', v_old_code), jsonb_build_object('status','ON_HOLD','held_by', auth.uid(), 'reason', p_note), v_task.to_department_id, p_note);
    perform public.staff_post_system_task_message(p_task_id, v_actor_name || ' put this task on hold: ' || p_note, v_actor_name || ' એ આ કાર્ય અટકાવ્યું: ' || p_note);
    perform public.staff_notify_assignment(v_task.assigned_by, 'task', p_task_id, 'Task on hold: ' || v_task.task_number, 'કાર્ય અટકાવાયું: ' || v_task.task_number);
    for v_row in select user_id from public.staff_task_assignees where task_id = p_task_id and is_active loop
      perform public.staff_notify_assignment(v_row.user_id, 'task', p_task_id, v_actor_name || ' put shared task ' || v_task.task_number || ' on hold', v_actor_name || ' એ સહિયારું કાર્ય અટકાવ્યું ' || v_task.task_number);
    end loop;
  else
    if v_old_code <> 'ON_HOLD' then
      raise exception 'Task is not currently on hold (status %)', v_old_code;
    end if;

    select id into v_status_id from public.status_master where code = 'IN_PROGRESS';
    update public.staff_tasks set status_id = v_status_id where id = p_task_id and status_id = v_task.status_id;
    update public.staff_task_assignees set individual_status = 'IN_PROGRESS' where id = v_my_row.id;

    perform public.staff_write_audit('task', p_task_id, 'RESUME', jsonb_build_object('status', v_old_code), jsonb_build_object('status','IN_PROGRESS','resumed_by', auth.uid()), v_task.to_department_id, p_note);
    perform public.staff_post_system_task_message(p_task_id, v_actor_name || ' resumed this task', v_actor_name || ' એ કાર્ય ફરી શરૂ કર્યું');
    for v_row in select user_id from public.staff_task_assignees where task_id = p_task_id and is_active loop
      perform public.staff_notify_assignment(v_row.user_id, 'task', p_task_id, v_actor_name || ' resumed shared task ' || v_task.task_number, v_actor_name || ' એ સહિયારું કાર્ય ફરી શરૂ કર્યું ' || v_task.task_number);
    end loop;
  end if;
end;
$function$;

-- ---------------------------------------------------------------------
-- 8. staff_return_task -- simplified to the shared model: ANY active
--    assignee may return an ASSIGNED/ACCEPTED/IN_PROGRESS/ON_HOLD task
--    (previously only the scalar assigned_to/current_owner_id could, and
--    a multi-assignee task instead marked only the caller's own row
--    REJECTED without ever touching the shared status). COMPLETED is no
--    longer handled here -- verification rejection now goes through the
--    dedicated staff_reopen_task below, which produces REOPENED (not
--    RETURNED) and preserves the existing completion proof.
-- ---------------------------------------------------------------------
create or replace function public.staff_return_task(p_task_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid; v_actor_name text; v_my_row record; v_row record;
begin
  perform public.staff_assert_operational();
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A return reason is required';
  end if;

  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;
  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;

  if v_old_code not in ('ASSIGNED','ACCEPTED','IN_PROGRESS','ON_HOLD') then
    raise exception 'Task cannot be returned from status %', v_old_code;
  end if;
  if v_my_row.id is null and not public.staff_is_super_admin() then
    raise exception 'You are not authorized to return this task at its current stage';
  end if;

  select id into v_status_id from public.status_master where code = 'RETURNED';
  update public.staff_tasks set status_id = v_status_id, return_reason = p_reason
    where id = p_task_id and status_id = v_task.status_id;

  if v_task.is_bridge then
    update public.bridges set acceptance_status = 'RETURNED', return_reason = p_reason where task_id = p_task_id;
  end if;

  perform public.staff_write_audit('task', p_task_id, 'RETURN', jsonb_build_object('status', v_old_code), jsonb_build_object('status','RETURNED','reason', p_reason), v_task.to_department_id, p_reason);
  perform public.staff_post_system_task_message(p_task_id, 'Task returned by ' || v_actor_name || ': ' || p_reason, v_actor_name || ' દ્વારા કાર્ય પરત: ' || p_reason);
  perform public.staff_notify_assignment(v_task.assigned_by, 'task', p_task_id, 'Task returned: ' || v_task.task_number, 'કામ પરત: ' || v_task.task_number);
  for v_row in select user_id from public.staff_task_assignees where task_id = p_task_id and is_active loop
    perform public.staff_notify_assignment(v_row.user_id, 'task', p_task_id, v_actor_name || ' returned shared task ' || v_task.task_number, v_actor_name || ' એ સહિયારું કાર્ય પરત કર્યું ' || v_task.task_number);
  end loop;
end;
$function$;

-- ---------------------------------------------------------------------
-- 9. staff_reopen_task -- new. Covers both "verifier rejects a COMPLETED
--    task" and "management reopens a VERIFIED/CLOSED task": either way
--    the shared status becomes REOPENED for every active assignee, the
--    reason is mandatory, and the previous completion proof/history is
--    left completely untouched (only status_id/reopened_by/reopened_at/
--    reopen_reason change).
-- ---------------------------------------------------------------------
create or replace function public.staff_reopen_task(p_task_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid; v_actor_name text; v_row record;
begin
  perform public.staff_assert_operational();
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to reopen this task';
  end if;

  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;

  if v_old_code not in ('COMPLETED','VERIFIED','CLOSED') then
    raise exception 'Task must be COMPLETED, VERIFIED, or CLOSED to reopen (currently %)', v_old_code;
  end if;

  if not (
    v_task.verifier_id = auth.uid() or v_task.assigned_by = auth.uid()
    or public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_task.to_department_id))
  ) then
    raise exception 'You are not authorized to reopen this task';
  end if;

  select id into v_status_id from public.status_master where code = 'REOPENED';
  update public.staff_tasks set status_id = v_status_id, reopened_by = auth.uid(), reopened_at = now(), reopen_reason = p_reason
    where id = p_task_id and status_id = v_task.status_id;

  -- Give every active assignee a fresh individual slate to resume from --
  -- the task-level completion_by/completed_at/proof stay exactly as they
  -- were, satisfying "preserve the previous completion proof and history".
  update public.staff_task_assignees set individual_status = 'IN_PROGRESS'
    where task_id = p_task_id and is_active and individual_status = 'COMPLETED';

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();
  perform public.staff_write_audit('task', p_task_id, 'REOPEN', jsonb_build_object('status', v_old_code), jsonb_build_object('status','REOPENED','reason', p_reason), v_task.to_department_id, p_reason);
  perform public.staff_post_system_task_message(p_task_id, 'Task reopened by ' || v_actor_name || ': ' || p_reason, v_actor_name || ' દ્વારા કાર્ય ફરીથી ખોલાયું: ' || p_reason);

  perform public.staff_notify_assignment(v_task.assigned_by, 'task', p_task_id, 'Task reopened: ' || v_task.task_number, 'કાર્ય ફરીથી ખોલાયું: ' || v_task.task_number);
  for v_row in select user_id from public.staff_task_assignees where task_id = p_task_id and is_active loop
    perform public.staff_notify_assignment(v_row.user_id, 'task', p_task_id, 'Task ' || v_task.task_number || ' was reopened: ' || p_reason, 'કાર્ય ' || v_task.task_number || ' ફરીથી ખોલાયું: ' || p_reason);
  end loop;
end;
$function$;

-- ---------------------------------------------------------------------
-- 10. Small, additive extensions to two existing functions so they stay
--     consistent with the shared model:
--     - staff_reassign_task can now also reassign a task that is
--       ON_HOLD/REOPENED (previously only ASSIGNED/RETURNED/ACCEPTED/
--       IN_PROGRESS -- those two statuses didn't exist before).
--     - staff_request_help (the separate, lighter "I need help" ping,
--       unaffected otherwise) now also authorizes any active assignee,
--       not only the legacy scalar assigned_to/current_owner_id -- a
--       Second Assignee could not previously request help at all.
-- ---------------------------------------------------------------------
create or replace function public.staff_reassign_task(p_task_id uuid, p_reason text, p_new_assigned_to uuid DEFAULT NULL::uuid, p_new_verifier_id uuid DEFAULT NULL::uuid, p_new_to_department_id uuid DEFAULT NULL::uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_old_assignee uuid; v_new_dept uuid;
  v_new_verifier_role text; v_new_verifier_department uuid;
  v_caller_role text;
  v_new_to_department_id uuid; v_dept_changed boolean; v_new_is_bridge boolean;
  v_from_confidential boolean; v_new_to_confidential boolean;
  v_actor_name text; v_old_name text; v_new_name text;
begin
  perform public.staff_assert_operational();
  v_caller_role := public.staff_current_role_code();

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required for reassignment';
  end if;

  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;

  if v_old_code not in ('ASSIGNED','RETURNED','ACCEPTED','IN_PROGRESS','ON_HOLD','REOPENED') then
    raise exception 'Task cannot be reassigned from status % — only ASSIGNED, RETURNED, ACCEPTED, IN_PROGRESS, ON_HOLD, or REOPENED may be reassigned', v_old_code;
  end if;

  if not (
    public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_task.to_department_id))
  ) then
    raise exception 'You are not authorized to reassign this task';
  end if;

  v_old_assignee := v_task.assigned_to;
  v_new_to_department_id := coalesce(p_new_to_department_id, v_task.to_department_id);
  v_dept_changed := (p_new_to_department_id is not null and p_new_to_department_id is distinct from v_task.to_department_id);

  if v_dept_changed then
    if not exists (select 1 from public.departments where id = v_new_to_department_id and is_active = true) then
      raise exception 'Invalid destination department';
    end if;
    if p_new_assigned_to is null then
      raise exception 'A new assignee is required when changing the destination department';
    end if;

    select is_confidential_domain into v_from_confidential from public.departments where id = v_task.from_department_id;
    select is_confidential_domain into v_new_to_confidential from public.departments where id = v_new_to_department_id;
    v_new_is_bridge := (v_task.from_department_id <> v_new_to_department_id);

    if v_new_is_bridge then
      if v_from_confidential or v_new_to_confidential then
        raise exception 'Cross-department Bridges into/out of a confidential department are disabled in this pilot';
      end if;
    else
      if v_from_confidential and v_caller_role not in ('management','cfo','accounts_head','accounts_employee','sysadmin') then
        raise exception 'Only Accounts roles, Management, or Super Admin may reassign a task within a confidential department';
      end if;
    end if;
  end if;

  if p_new_assigned_to is not null then
    select department_id into v_new_dept from public.user_profiles where id = p_new_assigned_to and is_active = true;
    if v_new_dept is null then raise exception 'Invalid or inactive new assignee'; end if;
    if v_new_dept is distinct from v_new_to_department_id then
      raise exception 'New assignee must belong to the destination department';
    end if;
  end if;

  if p_new_verifier_id is not null then
    v_new_verifier_role := public.staff_user_role_code(p_new_verifier_id);
    if v_new_verifier_role is null then
      raise exception 'Invalid or inactive new verifier';
    end if;
    select department_id into v_new_verifier_department from public.user_profiles where id = p_new_verifier_id;
    if not (
      v_new_verifier_role = 'management'
      or v_new_verifier_department = v_new_to_department_id
      or (v_new_verifier_role = 'dept_head' and public.staff_user_dept_in_hod_scope(p_new_verifier_id, v_new_to_department_id))
    ) then
      raise exception 'new verifier is not authorized for the destination department';
    end if;
  elsif v_dept_changed then
    v_new_verifier_role := public.staff_user_role_code(v_task.verifier_id);
    select department_id into v_new_verifier_department from public.user_profiles where id = v_task.verifier_id;
    if not (
      v_task.verifier_id = v_task.assigned_by
      or v_new_verifier_role = 'management'
      or v_new_verifier_department = v_new_to_department_id
      or (v_new_verifier_role = 'dept_head' and public.staff_user_dept_in_hod_scope(v_task.verifier_id, v_new_to_department_id))
    ) then
      raise exception 'The existing verifier is not authorized for the new destination department — specify a new verifier';
    end if;
  end if;

  update public.staff_tasks set
    to_department_id = v_new_to_department_id,
    is_bridge = case when v_dept_changed then v_new_is_bridge else is_bridge end,
    assigned_to = coalesce(p_new_assigned_to, assigned_to),
    verifier_id = coalesce(p_new_verifier_id, verifier_id),
    current_owner_id = case
      when p_new_assigned_to is not null and (v_old_code in ('ACCEPTED','IN_PROGRESS') or v_dept_changed) then p_new_assigned_to
      else current_owner_id
    end,
    assigned_at = case when p_new_assigned_to is not null and p_new_assigned_to <> v_old_assignee then now() else assigned_at end
  where id = p_task_id;

  if p_new_assigned_to is not null and p_new_assigned_to <> v_old_assignee then
    update public.staff_task_assignees set is_active = false, removed_at = now(), removed_by = auth.uid(), removal_reason = 'Reassigned'
      where task_id = p_task_id and assignment_role = 'primary' and is_active;
    insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by)
    values (p_task_id, p_new_assigned_to, 'primary', auth.uid());
  end if;

  if v_dept_changed then
    if v_new_is_bridge then
      if v_task.is_bridge then
        update public.bridges set
          to_department_id = v_new_to_department_id,
          to_person_id = p_new_assigned_to
        where task_id = p_task_id;
      else
        insert into public.bridges as inserted_bridge (task_id, from_department_id, to_department_id, from_person_id, to_person_id, requirement_text)
        values (p_task_id, v_task.from_department_id, v_new_to_department_id, auth.uid(), p_new_assigned_to, coalesce(v_task.description, v_task.title));
      end if;
    else
      update public.bridges set is_active = false where task_id = p_task_id and is_active = true;
    end if;
  elsif v_task.is_bridge and p_new_assigned_to is not null then
    update public.bridges set to_person_id = p_new_assigned_to where task_id = p_task_id;
  end if;

  perform public.staff_write_audit('task', p_task_id, 'REASSIGN',
    jsonb_build_object('assigned_to', v_old_assignee, 'verifier_id', v_task.verifier_id, 'to_department_id', v_task.to_department_id, 'status', v_old_code),
    jsonb_build_object('assigned_to', coalesce(p_new_assigned_to, v_old_assignee), 'verifier_id', coalesce(p_new_verifier_id, v_task.verifier_id), 'to_department_id', v_new_to_department_id, 'reason', p_reason),
    v_new_to_department_id, p_reason);

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();
  if p_new_assigned_to is not null and p_new_assigned_to <> v_old_assignee then
    select full_name into v_old_name from public.user_profiles where id = v_old_assignee;
    select full_name into v_new_name from public.user_profiles where id = p_new_assigned_to;
    perform public.staff_post_system_task_message(p_task_id,
      'Reassigned from ' || coalesce(v_old_name, '—') || ' to ' || coalesce(v_new_name, '—') || ' by ' || v_actor_name,
      v_actor_name || ' દ્વારા ' || coalesce(v_old_name, '—') || ' થી ' || coalesce(v_new_name, '—') || ' ને ફરીથી સોંપાયું');
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_old_assignee, 'task', p_task_id, 'Reassigned away from you: ' || v_task.task_number, 'તમારી પાસેથી ફરીથી સોંપાયું: ' || v_task.task_number);
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (p_new_assigned_to, 'task', p_task_id, 'Task reassigned to you: ' || v_task.task_number, 'તમને કામ ફરીથી સોંપાયું: ' || v_task.task_number);
  else
    perform public.staff_post_system_task_message(p_task_id, 'Task updated by ' || v_actor_name, v_actor_name || ' દ્વારા કાર્ય અપડેટ કરાયું');
  end if;
end;
$function$;

create or replace function public.staff_request_help(p_task_id uuid, p_note text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_task public.staff_tasks%ROWTYPE; v_old_code text;
BEGIN
  PERFORM public.staff_assert_operational();
  SELECT * INTO v_task FROM public.staff_tasks WHERE id = p_task_id FOR UPDATE;
  IF v_task.id IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;
  SELECT code INTO v_old_code FROM public.status_master WHERE id = v_task.status_id;
  IF v_old_code = 'CLOSED' THEN
    RAISE EXCEPTION 'Cannot request help on a closed task';
  END IF;
  IF v_task.current_owner_id <> auth.uid() AND v_task.assigned_to <> auth.uid()
     AND NOT EXISTS (SELECT 1 FROM public.staff_task_assignees WHERE task_id = p_task_id AND user_id = auth.uid() AND is_active) THEN
    RAISE EXCEPTION 'Only the assignee or current owner may request help on this task';
  END IF;

  UPDATE public.staff_tasks SET help_requested = true WHERE id = p_task_id;

  PERFORM public.staff_write_audit('task', p_task_id, 'REQUEST_HELP', NULL, jsonb_build_object('note', p_note), v_task.to_department_id);
  INSERT INTO public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  VALUES (v_task.assigned_by, 'task', p_task_id, 'Help requested: ' || v_task.task_number, 'મદદ માંગી: ' || v_task.task_number);
END;
$function$;

-- ---------------------------------------------------------------------
-- 11. Close the one real gap found while auditing task-creation paths:
--     staff_create_task already inserts a primary staff_task_assignees
--     row for every new task, but staff_create_project_task (used by
--     Interior Daily Updates' per-person work items) never did -- every
--     task it created would have had ZERO staff_task_assignees rows,
--     which the new shared-model RPCs above require to identify "an
--     active assignee". Purely additive; matches staff_create_task's
--     existing pattern exactly.
-- ---------------------------------------------------------------------
create or replace function public.staff_create_project_task(p_project_id uuid, p_title text, p_description text, p_assigned_to uuid, p_due_date date, p_priority_code text, p_source_site_report_id uuid, p_source_work_item_id uuid, p_source_type text)
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

-- ---------------------------------------------------------------------
-- 12. Existing-data migration.
--     (a) Backfill a primary staff_task_assignees row for every task that
--         has none at all (legacy single-assignee tasks created before
--         staff_task_assignees existed) -- inferred acceptance/individual
--         status from the task's own current status_id/accepted_at/
--         completed_at (all correctly populated already for these, since
--         the old code always set them directly for a single assignee).
--     (b) Backfill accepted_by/started_by/completed_by from the first
--         matching ACCEPT/START/COMPLETE row in staff_audit_log per task
--         -- real historical actor + timestamp, not a guess -- for every
--         task, single- or multi-assignee alike.
--     (c) Backfill completion_note from the existing customer_confirmation_text.
--     (d) Resolve the 3 tasks left mid-flight under the old "everyone
--         must agree" model (2x PARTIALLY_ACCEPTED, 1x
--         PARTIALLY_COMPLETED) to the shared status the ANY-ONE rule
--         says they should already be at, per "if any assignee already
--         accepted/completed, migrate the shared task accordingly".
--     (e) Resolve the 1 task left with a per-assignee BLOCKED
--         individual_status (no shared equivalent existed before this
--         migration) to the new shared ON_HOLD status, using the real
--         actor/time recorded in staff_audit_log at the time.
--     Nothing here deletes or overwrites replies, attachments, or audit
--     history -- only staff_tasks/staff_task_assignees columns that were
--     previously null or stuck are filled in.
-- ---------------------------------------------------------------------
insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by, assigned_at, acceptance_status, accepted_at, individual_status, completed_at)
select st.id, st.assigned_to, 'primary', st.assigned_by, st.assigned_at,
  case when st.accepted_at is not null then 'ACCEPTED' else 'PENDING' end,
  st.accepted_at,
  case
    when sm.code in ('COMPLETED','VERIFIED','CLOSED') then 'COMPLETED'
    when sm.code = 'IN_PROGRESS' then 'IN_PROGRESS'
    when st.accepted_at is not null then 'ACCEPTED'
    else 'ASSIGNED'
  end,
  st.completed_at
from public.staff_tasks st
join public.status_master sm on sm.id = st.status_id
where not exists (select 1 from public.staff_task_assignees sta where sta.task_id = st.id);

update public.staff_tasks st set accepted_by = fa.performed_by
from (
  select distinct on (entity_id) entity_id, performed_by
  from public.staff_audit_log
  where entity_type = 'task' and action = 'ACCEPT'
  order by entity_id, performed_at asc
) fa
where st.id = fa.entity_id and st.accepted_by is null;

update public.staff_tasks st set started_by = fa.performed_by
from (
  select distinct on (entity_id) entity_id, performed_by
  from public.staff_audit_log
  where entity_type = 'task' and action = 'START'
  order by entity_id, performed_at asc
) fa
where st.id = fa.entity_id and st.started_by is null;

update public.staff_tasks st set completed_by = fa.performed_by
from (
  select distinct on (entity_id) entity_id, performed_by
  from public.staff_audit_log
  where entity_type = 'task' and action = 'COMPLETE'
  order by entity_id, performed_at asc
) fa
where st.id = fa.entity_id and st.completed_by is null;

update public.staff_tasks set completion_note = customer_confirmation_text
  where completion_note is null and customer_confirmation_text is not null;

update public.staff_tasks
set status_id = (select id from public.status_master where code = 'ACCEPTED')
where status_id = (select id from public.status_master where code = 'PARTIALLY_ACCEPTED');

update public.staff_tasks
set status_id = (select id from public.status_master where code = 'COMPLETED')
where status_id = (select id from public.status_master where code = 'PARTIALLY_COMPLETED');

update public.staff_tasks
set status_id = (select id from public.status_master where code = 'ON_HOLD'),
    held_by = 'd36baf53-8410-472b-9449-da8552b12d65',
    held_at = '2026-09-18 11:39:00.04132+00'::timestamptz,
    hold_reason = 'Migrated from legacy per-assignee hold (no reason text was recorded under the old workflow)'
where id = 'e627eea7-ebc3-4efc-b189-ea8fa64b4f50'
  and status_id = (select id from public.status_master where code = 'IN_PROGRESS');
