-- Factory Task Management (Phase 1c) -- ties Factory Job Cards to the ONE existing task engine
-- (staff_tasks / staff_task_assignees / status_master) instead of creating a parallel one.
--
-- Task source of truth  : public.staff_tasks (+ staff_task_assignees for primary/secondary)
-- Job Card              : public.inhouse_production_requests (unchanged parent)
-- Leadership queue      : DERIVED from Job Card status (factory_my_actions) -- never stored, so it can
--                         not duplicate, go stale, or depend on which leader happens to exist.
-- Production work       : real staff_tasks rows, created idempotently (system_key) and synced on reassign.
--
-- Task status mapping (existing state machine is reused and stays enforced by the
-- staff_validate_task_transition trigger):
--   pending_acceptance = ASSIGNED / RETURNED / REOPENED     accepted = ACCEPTED
--   in_progress        = IN_PROGRESS                        blocked / waiting = ON_HOLD (reason required)
--   ready_for_review   = COMPLETED                          completed = VERIFIED / CLOSED
--   rejected           = RETURNED (reason required)         cancelled = is_active=false + audit (history kept)

-- ---------------------------------------------------------------------------
-- 1. Stage configuration (previously only a constant in the UI)
-- ---------------------------------------------------------------------------
create table if not exists public.factory_production_stages (
  code text primary key,
  name_en text not null,
  name_gu text not null,
  sort_order integer not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.factory_production_stages enable row level security;
drop policy if exists factory_production_stages_select on public.factory_production_stages;
create policy factory_production_stages_select on public.factory_production_stages
  for select to authenticated using (public.staff_current_user_ok());
revoke all on table public.factory_production_stages from public, anon, authenticated;
grant select on table public.factory_production_stages to authenticated;

insert into public.factory_production_stages (code, name_en, name_gu, sort_order) values
  ('Requirement Verification', 'Requirement Verification', 'જરૂરિયાત ચકાસણી', 10),
  ('Drawing/BOM Verification', 'Drawing / BOM Verification', 'ડ્રોઇંગ / BOM ચકાસણી', 20),
  ('Material Check',           'Material Check',            'મટીરીયલ ચકાસણી', 30),
  ('Cutting',                  'Cutting',                   'કટિંગ', 40),
  ('Edge Banding',             'Edge Banding',              'એજ બેન્ડિંગ', 50),
  ('CNC',                      'CNC / Drilling',            'સીએનસી / ડ્રિલિંગ', 60),
  ('Carpentry/Assembly',       'Carpentry / Assembly',      'સુથારી / એસેમ્બલી', 70),
  ('Polishing/Painting',       'Polishing / Finishing',     'પોલિશ / ફિનિશિંગ', 80),
  ('Upholstery',               'Upholstery',                'અપહોલ્સ્ટરી', 85),
  ('Hardware Fitting',         'Hardware Fitting',          'હાર્ડવેર ફિટિંગ', 90),
  ('Final Assembly',           'Final Assembly',            'ફાઇનલ એસેમ્બલી', 100),
  ('In-process QC',            'In-process QC',             'ઇન-પ્રોસેસ QC', 110),
  ('Final QC',                 'Final QC',                  'ફાઇનલ QC', 120),
  ('Packing',                  'Packing',                   'પેકિંગ', 130),
  ('Ready for Dispatch',       'Ready for Dispatch',        'ડિસ્પેચ માટે તૈયાર', 140),
  ('Installation',             'Installation',              'ઇન્સ્ટોલેશન', 150)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Nullable Factory relationships on the existing task table
-- ---------------------------------------------------------------------------
alter table public.staff_tasks
  add column if not exists job_card_id uuid references public.inhouse_production_requests(id) on delete set null,
  add column if not exists job_card_item_id uuid references public.factory_job_items(id) on delete set null,
  add column if not exists production_stage text,
  add column if not exists factory_location_id uuid references public.factory_locations(id),
  add column if not exists production_department text,
  add column if not exists requires_acceptance boolean not null default true,
  add column if not exists total_quantity numeric,
  add column if not exists completed_quantity numeric,
  add column if not exists start_date date,
  add column if not exists system_key text;

alter table public.staff_tasks drop constraint if exists staff_tasks_factory_qty_check;
alter table public.staff_tasks add constraint staff_tasks_factory_qty_check
  check (total_quantity is null or completed_quantity is null or (completed_quantity >= 0 and completed_quantity <= total_quantity));

create unique index if not exists staff_tasks_system_key_uq on public.staff_tasks (system_key) where system_key is not null;
create index if not exists staff_tasks_job_card_idx on public.staff_tasks (job_card_id) where job_card_id is not null;
create index if not exists staff_tasks_to_dept_active_idx on public.staff_tasks (to_department_id, is_active);

-- ---------------------------------------------------------------------------
-- 3. Helpers + visibility
-- ---------------------------------------------------------------------------
create or replace function public.factory_dept_id() returns uuid
  language sql stable security definer set search_path = public
as $$ select id from public.departments where code = 'FACTORY' $$;

-- A person who is an active assignee of ANY task linked to a Job Card can open that Job Card
-- (drawings, items, specification) even when they are not the Job Card's own coordinator.
create or replace function public.factory_job_visible_row(r public.inhouse_production_requests)
  returns boolean language sql stable security definer set search_path = public
as $$
  select public.factory_ai_is_reviewer()
    or r.requested_by = auth.uid()
    or (r.source_department_id is not null
        and r.source_department_id = public.staff_current_department_id()
        and r.source_department_id is distinct from (select id from public.departments where code = 'INTERIOR'))
    or (public.staff_is_factory_staff()
        and public.factory_my_profile_id() in (r.assigned_factory_coordinator, r.second_assignee_coordinator, r.current_responsible_person))
    or exists (
      select 1 from public.staff_tasks t
      join public.staff_task_assignees a on a.task_id = t.id
      where t.job_card_id = r.id and t.is_active and a.is_active and a.user_id = auth.uid()
    );
$$;

-- ---------------------------------------------------------------------------
-- 4. Close the direct-write hole on Job Cards.
-- inhouse_production_requests_scoped is FOR ALL and authenticated holds UPDATE, so an Interior
-- org-wide user or Factory head could PATCH factory_status / assignees straight through the REST
-- API. Workflow columns may now only change from inside the SECURITY DEFINER Factory RPCs
-- (where current_user is the function owner, not 'authenticated').
-- ---------------------------------------------------------------------------
create or replace function public.factory_guard_job_write() returns trigger
  language plpgsql set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.factory_status is distinct from old.factory_status
       or new.assigned_factory_coordinator is distinct from old.assigned_factory_coordinator
       or new.second_assignee_coordinator is distinct from old.second_assignee_coordinator
       or new.current_responsible_person is distinct from old.current_responsible_person
       or new.completion_percentage is distinct from old.completion_percentage
       or new.linked_task_id is distinct from old.linked_task_id
       or new.assigned_by is distinct from old.assigned_by
       or new.accepted_by is distinct from old.accepted_by
       or new.source_department_id is distinct from old.source_department_id then
      raise exception 'Job Card workflow fields can only be changed through the Factory workflow.' using errcode = '42501';
    end if;
    -- Legacy free-text status (old Job Orders screen) stays available to Factory leadership only.
    if new.status is distinct from old.status and not public.factory_ai_is_reviewer() then
      raise exception 'Only Factory leadership can change the Job Card status.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists aaa_factory_guard_job_write on public.inhouse_production_requests;
create trigger aaa_factory_guard_job_write before update on public.inhouse_production_requests
  for each row execute function public.factory_guard_job_write();

-- ---------------------------------------------------------------------------
-- 5. Idempotent assignee sync (soft-removes, never deletes history)
-- ---------------------------------------------------------------------------
create or replace function public.factory_sync_task_assignees(p_task uuid, p_primary uuid, p_second uuid, p_reason text default null)
  returns void language plpgsql security definer set search_path = public
as $$
declare
  t public.staff_tasks%rowtype;
  v_code text; v_fac uuid := public.factory_dept_id(); v_actor uuid := auth.uid();
  v_cur_p uuid; v_cur_s uuid; v_ind text; v_acc text; v_changed boolean := false;
  v_old jsonb; v_actor_name text; v_new_status uuid;
begin
  select * into t from public.staff_tasks where id = p_task for update;
  if t.id is null then raise exception 'Task not found'; end if;
  select code into v_code from public.status_master where id = t.status_id;
  if not t.is_active or v_code not in ('ASSIGNED', 'RETURNED', 'ACCEPTED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED') then
    raise exception 'This task can no longer be reassigned (status %)', v_code;
  end if;
  if p_primary is null then raise exception 'A primary assignee is required'; end if;
  if p_second is not null and p_second = p_primary then
    raise exception 'Primary and Second Assignee must be different people. / મુખ્ય અને બીજી જવાબદાર વ્યક્તિ અલગ હોવી જોઈએ.';
  end if;
  if not exists (select 1 from public.user_profiles where id = p_primary and is_active and department_id = v_fac) then
    raise exception 'Primary assignee must be an active Factory employee';
  end if;
  if p_second is not null and not exists (select 1 from public.user_profiles where id = p_second and is_active and department_id = v_fac) then
    raise exception 'Second assignee must be an active Factory employee';
  end if;

  select user_id into v_cur_p from public.staff_task_assignees where task_id = p_task and assignment_role = 'primary' and is_active limit 1;
  select user_id into v_cur_s from public.staff_task_assignees where task_id = p_task and assignment_role = 'secondary' and is_active limit 1;
  v_old := jsonb_build_object('primary', v_cur_p, 'second', v_cur_s);

  -- A person joining mid-flight continues from the task's current state instead of re-accepting.
  v_ind := case v_code when 'IN_PROGRESS' then 'IN_PROGRESS' when 'ACCEPTED' then 'ACCEPTED' when 'ON_HOLD' then 'BLOCKED' else 'ASSIGNED' end;
  v_acc := case when v_code in ('ACCEPTED', 'IN_PROGRESS', 'ON_HOLD') then 'ACCEPTED' else 'PENDING' end;

  if v_cur_p is distinct from p_primary then
    update public.staff_task_assignees set is_active = false, removed_at = now(), removed_by = v_actor,
      removal_reason = coalesce(nullif(btrim(p_reason), ''), 'Reassigned')
      where task_id = p_task and assignment_role = 'primary' and is_active;
    insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by, acceptance_status, individual_status)
    values (p_task, p_primary, 'primary', v_actor, v_acc, v_ind)
    on conflict (task_id, user_id) do update set assignment_role = 'primary', is_active = true, removed_at = null, removed_by = null,
      removal_reason = null, assigned_by = v_actor, assigned_at = now(), acceptance_status = v_acc, individual_status = v_ind,
      accepted_at = case when v_acc = 'ACCEPTED' then now() else null end, completed_at = null, completion_note = null;
    update public.staff_tasks set assigned_to = p_primary, current_owner_id = p_primary, previous_owner_id = t.assigned_to, assigned_at = now()
      where id = p_task;
    if v_code = 'RETURNED' then
      select id into v_new_status from public.status_master where code = 'ASSIGNED';
      update public.staff_tasks set status_id = v_new_status, return_reason = null where id = p_task;
    end if;
    perform public.staff_notify_assignment(p_primary, 'task', p_task, 'Task assigned to you: ' || t.task_number || ' — ' || t.title, 'કાર્ય તમને સોંપાયું: ' || t.task_number || ' — ' || t.title);
    if v_cur_p is not null then
      perform public.staff_notify_assignment(v_cur_p, 'task', p_task, 'Reassigned away from you: ' || t.task_number, 'તમારી પાસેથી ફરીથી સોંપાયું: ' || t.task_number);
    end if;
    v_changed := true;
  end if;

  if v_cur_s is distinct from p_second then
    if v_cur_s is not null and v_cur_s is distinct from p_primary then
      update public.staff_task_assignees set is_active = false, removed_at = now(), removed_by = v_actor,
        removal_reason = coalesce(nullif(btrim(p_reason), ''), 'Second assignee changed')
        where task_id = p_task and assignment_role = 'secondary' and is_active;
      perform public.staff_notify_assignment(v_cur_s, 'task', p_task, 'You were removed from task ' || t.task_number, 'તમને કાર્ય ' || t.task_number || ' માંથી દૂર કરાયા');
    end if;
    if p_second is not null then
      insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by, acceptance_status, individual_status)
      values (p_task, p_second, 'secondary', v_actor, v_acc, v_ind)
      on conflict (task_id, user_id) do update set assignment_role = 'secondary', is_active = true, removed_at = null, removed_by = null,
        removal_reason = null, assigned_by = v_actor, assigned_at = now(), acceptance_status = v_acc, individual_status = v_ind,
        accepted_at = case when v_acc = 'ACCEPTED' then now() else null end, completed_at = null, completion_note = null;
      perform public.staff_notify_assignment(p_second, 'task', p_task, 'You were added to task ' || t.task_number || ' as Second Assignee', 'તમને કાર્ય ' || t.task_number || ' માં બીજા જવાબદાર તરીકે ઉમેરાયા');
    end if;
    v_changed := true;
  end if;

  if v_changed then
    select full_name into v_actor_name from public.user_profiles where id = v_actor;
    perform public.staff_write_audit('task', p_task, 'FACTORY_ASSIGNMENT', v_old, jsonb_build_object('primary', p_primary, 'second', p_second, 'reason', p_reason), t.to_department_id, p_reason);
    perform public.staff_post_system_task_message(p_task, 'Assignment updated by ' || coalesce(v_actor_name, 'Factory'), 'સોંપણી અપડેટ કરી: ' || coalesce(v_actor_name, 'ફેક્ટરી'));
  end if;
end $$;

-- Create the production task for a Job Card once; afterwards only sync its assignees.
create or replace function public.factory_sync_job_task(p_job uuid, p_primary_auth uuid, p_second_auth uuid, p_note text default null)
  returns uuid language plpgsql security definer set search_path = public
as $$
declare
  j public.inhouse_production_requests%rowtype; v_task uuid; v_new record; v_fac uuid := public.factory_dept_id(); v_prio text;
begin
  select * into j from public.inhouse_production_requests where id = p_job for update;
  if j.id is null then raise exception 'Job Card not found'; end if;
  v_task := j.linked_task_id;
  if v_task is null then select id into v_task from public.staff_tasks where system_key = 'job_assign:' || p_job::text; end if;

  if v_task is null then
    v_prio := case when j.priority = 'Emergency' then 'URGENT' else upper(j.priority) end;
    select * into v_new from public.staff_create_task(
      'Factory Production: ' || coalesce(j.product_item, j.job_order_number),
      coalesce(j.special_instructions, 'Factory Job Card ' || j.job_order_number),
      'FACTORY_REQUEST', v_prio, 'none', v_fac, v_fac, p_primary_auth,
      coalesce(j.expected_completion_date, j.required_completion_date, current_date + 7), null, null, j.job_order_number, '', coalesce(j.quantity::text, ''),
      p_second_auth, j.project_id);
    v_task := v_new.task_id;
    update public.staff_tasks set job_card_id = p_job, system_key = 'job_assign:' || p_job::text, factory_location_id = j.factory_location_id,
      production_department = j.production_department, start_date = j.production_start_date, total_quantity = j.quantity, requires_acceptance = true
      where id = v_task;
  else
    update public.staff_tasks set job_card_id = coalesce(job_card_id, p_job), system_key = coalesce(system_key, 'job_assign:' || p_job::text),
      factory_location_id = coalesce(factory_location_id, j.factory_location_id) where id = v_task;
    perform public.factory_sync_task_assignees(v_task, p_primary_auth, p_second_auth, p_note);
  end if;

  update public.inhouse_production_requests set linked_task_id = v_task where id = p_job and linked_task_id is distinct from v_task;
  return v_task;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Job Card progress (real counts; no free-typed percentage)
-- ---------------------------------------------------------------------------
create or replace function public.factory_job_progress_calc(p_job uuid) returns jsonb
  language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'total',       count(*),
    'done',        count(*) filter (where s.code in ('VERIFIED', 'CLOSED')),
    'review',      count(*) filter (where s.code = 'COMPLETED'),
    'in_progress', count(*) filter (where s.code = 'IN_PROGRESS'),
    'blocked',     count(*) filter (where s.code = 'ON_HOLD'),
    'pending',     count(*) filter (where s.code in ('ASSIGNED', 'ACCEPTED', 'RETURNED', 'REOPENED', 'PARTIALLY_ACCEPTED')),
    'overdue',     count(*) filter (where t.due_date < (now() at time zone 'Asia/Kolkata')::date and s.code not in ('COMPLETED', 'VERIFIED', 'CLOSED')),
    'qty_total',   sum(t.total_quantity),
    'qty_done',    sum(t.completed_quantity),
    'next_due',    min(t.due_date) filter (where s.code not in ('COMPLETED', 'VERIFIED', 'CLOSED'))
  )
  from public.staff_tasks t join public.status_master s on s.id = t.status_id
  where t.job_card_id = p_job and t.is_active;
$$;

create or replace function public.factory_job_progress_many(p_jobs uuid[]) returns table(job_id uuid, progress jsonb)
  language sql stable security definer set search_path = public
as $$
  select j, public.factory_job_progress_calc(j) from unnest(p_jobs) j where public.staff_factory_job_visible(j);
$$;

-- Moves the Job Card along from what its tasks are actually doing.
create or replace function public.factory_recompute_job_progress(p_job uuid) returns void
  language plpgsql security definer set search_path = public
as $$
declare v_st text; g jsonb; v_open int; v_finished int; v_inprog int; v_new text; v_no text;
begin
  select factory_status, job_order_number into v_st, v_no from public.inhouse_production_requests where id = p_job for update;
  if v_st is null then return; end if;
  g := public.factory_job_progress_calc(p_job);
  v_inprog := (g ->> 'in_progress')::int;
  v_finished := (g ->> 'review')::int + (g ->> 'done')::int;
  v_open := (g ->> 'total')::int - v_finished;
  v_new := v_st;
  if (g ->> 'total')::int = 0 then return; end if;
  if v_st in ('assigned', 'in_production') and v_open = 0 and v_finished > 0 then v_new := 'ready_for_review';
  elsif v_st = 'ready_for_review' and v_open > 0 then v_new := 'in_production';
  elsif v_st = 'assigned' and v_inprog > 0 then v_new := 'in_production';
  end if;
  if v_new is distinct from v_st then
    update public.inhouse_production_requests set factory_status = v_new, updated_at = now(),
      ready_at = case when v_new = 'ready_for_review' then now() else ready_at end where id = p_job;
    perform public.factory_log_event(p_job, 'auto_progress', v_st, v_new, 'Updated automatically from task progress', auth.uid());
    if v_new = 'ready_for_review' then
      perform public.factory_notify_managers(p_job, 'Job Card ' || v_no || ': all tasks are complete — ready for review', 'જોબ કાર્ડ ' || v_no || ': બધાં કાર્યો પૂર્ણ — સમીક્ષા માટે તૈયાર');
    end if;
  end if;
end $$;

-- Fires on every real task status / active change (independent of any browser being open).
create or replace function public.factory_task_after_change() returns trigger
  language plpgsql security definer set search_path = public
as $$
declare
  v_fac uuid := public.factory_dept_id(); v_code text; v_old_code text; v_actor uuid := auth.uid();
  v_en text; v_gu text; v_reason text;
begin
  if new.job_card_id is null and new.to_department_id is distinct from v_fac then return new; end if;

  if tg_op = 'INSERT' then
    if new.job_card_id is not null then perform public.factory_recompute_job_progress(new.job_card_id); end if;
    return new;
  end if;

  if new.status_id is not distinct from old.status_id and new.is_active is not distinct from old.is_active and new.job_card_id is not distinct from old.job_card_id then return new; end if;

  select code into v_code from public.status_master where id = new.status_id;
  select code into v_old_code from public.status_master where id = old.status_id;

  if new.is_active and new.status_id is distinct from old.status_id and new.to_department_id = v_fac then
    if v_code = 'ON_HOLD' then
      v_reason := new.hold_reason;
      v_en := 'Task blocked: ' || new.task_number || coalesce(' — ' || v_reason, '');
      v_gu := 'કાર્ય અટક્યું: ' || new.task_number || coalesce(' — ' || v_reason, '');
    elsif v_code = 'COMPLETED' then
      v_en := 'Ready for review: ' || new.task_number || ' — ' || new.title;
      v_gu := 'સમીક્ષા માટે તૈયાર: ' || new.task_number || ' — ' || new.title;
    elsif v_code = 'RETURNED' then
      v_reason := new.return_reason;
      v_en := 'Task rejected / returned: ' || new.task_number || coalesce(' — ' || v_reason, '');
      v_gu := 'કાર્ય પરત / અસ્વીકાર: ' || new.task_number || coalesce(' — ' || v_reason, '');
    end if;
    if v_en is not null then
      -- Factory leadership only (not every employee), never the actor, and never the people the
      -- task RPCs already notified (creator/verifier) -- so one event = one notification each.
      insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
      select up.id, 'task', new.id, new.id, v_en, v_gu
        from public.user_profiles up join public.roles ro on ro.id = up.role_id
        where up.is_active and up.department_id = v_fac and ro.code in ('dept_head', 'supervisor')
          and up.id is distinct from v_actor and up.id is distinct from new.assigned_by and up.id is distinct from new.verifier_id;
    end if;
  end if;

  if new.job_card_id is not null then perform public.factory_recompute_job_progress(new.job_card_id); end if;
  if old.job_card_id is not null and old.job_card_id is distinct from new.job_card_id then perform public.factory_recompute_job_progress(old.job_card_id); end if;
  return new;
end $$;
drop trigger if exists trg_factory_task_after_change on public.staff_tasks;
create trigger trg_factory_task_after_change after insert or update of status_id, is_active, job_card_id on public.staff_tasks
  for each row execute function public.factory_task_after_change();

-- ---------------------------------------------------------------------------
-- 7. Job Card transitions: assignment now syncs (no delete of history); completion / cancel cascade.
--    Same signature as Phase 1 so CREATE OR REPLACE is an in-place upgrade.
-- ---------------------------------------------------------------------------
create or replace function public.factory_job_transition(p_job_id uuid, p_action text, p_note text default null, p_payload jsonb default '{}'::jsonb)
  returns text language plpgsql security definer set search_path = public
as $$
declare
  j public.inhouse_production_requests%rowtype;
  v_uid uuid := auth.uid();
  v_mgr boolean; v_head boolean; v_assigned boolean; v_source boolean;
  v_old text; v_new text; v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_primary uuid; v_second uuid; v_primary_auth uuid; v_second_auth uuid; v_factory uuid;
  v_start date; v_end date; v_dept text; v_event text; v_pname text; v_verified uuid;
begin
  perform public.staff_assert_operational();
  select * into j from public.inhouse_production_requests where id = p_job_id for update;
  if j.id is null then raise exception 'Job Card not found'; end if;

  v_old := j.factory_status;
  v_mgr := public.factory_ai_is_reviewer();
  v_head := public.factory_is_head();
  v_assigned := public.factory_my_profile_id() is not null
    and public.factory_my_profile_id() in (j.assigned_factory_coordinator, j.second_assignee_coordinator, j.current_responsible_person);
  v_source := j.requested_by = v_uid or (j.source_department_id is not null and j.source_department_id = public.staff_current_department_id());
  v_new := v_old;
  v_event := p_action;

  case p_action
    when 'accept' then
      if not v_mgr then raise exception 'You are not authorized to accept Job Cards'; end if;
      if v_old <> 'pending_verification' then raise exception 'Only a Job Card awaiting verification can be accepted'; end if;
      v_new := 'accepted';
      update public.inhouse_production_requests set accepted_at = now(), accepted_by = v_uid, viewed_at = coalesce(viewed_at, now()) where id = p_job_id;
    when 'return' then
      if not v_mgr then raise exception 'You are not authorized to return Job Cards'; end if;
      if v_old not in ('pending_verification', 'accepted', 'assigned') then raise exception 'This Job Card can no longer be returned'; end if;
      if v_note is null then raise exception 'Please say what needs clarification'; end if;
      v_new := 'needs_clarification';
      update public.inhouse_production_requests set clarification_note = v_note, clarification_requested_at = now() where id = p_job_id;
    when 'resubmit' then
      if not (v_source or v_mgr) then raise exception 'You are not authorized to re-submit this Job Card'; end if;
      if v_old <> 'needs_clarification' then raise exception 'Only a returned Job Card can be re-submitted'; end if;
      v_new := 'pending_verification';
      update public.inhouse_production_requests set clarification_note = null, viewed_at = null where id = p_job_id;
    when 'assign' then
      if not v_mgr then raise exception 'You are not authorized to assign Factory staff'; end if;
      if v_old not in ('accepted', 'assigned', 'in_production', 'blocked') then raise exception 'Accept the Job Card before assigning it'; end if;
      v_primary := nullif(p_payload ->> 'primary_profile_id', '')::uuid;
      v_second := nullif(p_payload ->> 'second_profile_id', '')::uuid;
      v_start := nullif(p_payload ->> 'planned_start', '')::date;
      v_end := nullif(p_payload ->> 'expected_end', '')::date;
      v_dept := nullif(btrim(coalesce(p_payload ->> 'production_department', '')), '');
      if v_primary is null then raise exception 'Please choose the primary responsible person'; end if;
      if v_second is not null and v_second = v_primary then raise exception 'Primary and second assignee must be different people'; end if;
      select id into v_factory from public.departments where code = 'FACTORY';
      select up.id into v_primary_auth from public.profiles p join public.user_profiles up on up.id = p.auth_id
        where p.id = v_primary and up.is_active and up.department_id = v_factory;
      if v_primary_auth is null then raise exception 'Selected employee could not be found in the Factory team. Please choose a valid employee from the list.'; end if;
      if v_second is not null then
        select up.id into v_second_auth from public.profiles p join public.user_profiles up on up.id = p.auth_id
          where p.id = v_second and up.is_active and up.department_id = v_factory;
        if v_second_auth is null then raise exception 'Selected second assignee could not be found in the Factory team.'; end if;
      end if;
      if v_start is not null and v_end is not null and v_end < v_start then raise exception 'Expected completion cannot be before the planned start'; end if;

      v_new := case when v_old = 'accepted' then 'assigned' else v_old end;
      update public.inhouse_production_requests set
        assigned_factory_coordinator = v_primary, second_assignee_coordinator = v_second, current_responsible_person = v_primary,
        production_department = coalesce(v_dept, production_department), production_start_date = coalesce(v_start, production_start_date),
        expected_completion_date = coalesce(v_end, expected_completion_date), assigned_at = now(), assigned_by = v_uid
      where id = p_job_id;
      select * into j from public.inhouse_production_requests where id = p_job_id;

      -- Creates the task once, then only syncs assignees (soft-remove + audit). Never duplicates.
      perform public.factory_sync_job_task(p_job_id, v_primary_auth, v_second_auth, v_note);
      v_pname := public.factory_person_name(v_primary);
      v_note := coalesce(v_note, 'Assigned to ' || coalesce(v_pname, 'team'));
    when 'start' then
      if not (v_mgr or v_assigned) then raise exception 'You are not authorized to start this Job Card'; end if;
      if v_old <> 'assigned' then raise exception 'Only an assigned Job Card can be started'; end if;
      v_new := 'in_production';
    when 'block' then
      if not (v_mgr or v_assigned) then raise exception 'You are not authorized to block this Job Card'; end if;
      if v_old not in ('assigned', 'in_production') then raise exception 'Only active work can be blocked'; end if;
      if v_note is null then raise exception 'Please give the reason it is blocked'; end if;
      v_new := 'blocked';
      update public.inhouse_production_requests set blocked_reason = v_note, blocked_from = v_old, delay_reason = v_note where id = p_job_id;
    when 'unblock' then
      if not (v_mgr or v_assigned) then raise exception 'You are not authorized to unblock this Job Card'; end if;
      if v_old <> 'blocked' then raise exception 'This Job Card is not blocked'; end if;
      v_new := coalesce(nullif(j.blocked_from, ''), 'in_production');
      update public.inhouse_production_requests set blocked_reason = null, blocked_from = null, delay_reason = null where id = p_job_id;
    when 'mark_ready' then
      if not (v_mgr or v_assigned) then raise exception 'You are not authorized to mark this Job Card ready'; end if;
      if v_old <> 'in_production' then raise exception 'Only work in production can be marked ready'; end if;
      v_new := 'ready_for_review';
      update public.inhouse_production_requests set ready_at = now() where id = p_job_id;
    when 'complete' then
      if not v_head then raise exception 'Only the Factory Head or Admin can approve completion'; end if;
      if v_old <> 'ready_for_review' then raise exception 'Only work that is ready for review can be completed'; end if;
      v_new := 'completed';
      update public.inhouse_production_requests set completed_at = now(), completed_by = v_uid, actual_completion_date = current_date, completion_percentage = 100, factory_status = 'completed' where id = p_job_id;
      select id into v_verified from public.status_master where code = 'VERIFIED';
      update public.staff_tasks set status_id = v_verified, verified_by = v_uid
        where job_card_id = p_job_id and is_active and status_id = (select id from public.status_master where code = 'COMPLETED');
    when 'cancel' then
      if not v_head then raise exception 'Only the Factory Head or Admin can cancel a Job Card'; end if;
      if v_old in ('completed', 'cancelled') then raise exception 'This Job Card is already closed'; end if;
      if v_note is null then raise exception 'Please give a reason for cancelling'; end if;
      v_new := 'cancelled';
      update public.inhouse_production_requests set cancelled_reason = v_note, factory_status = 'cancelled' where id = p_job_id;
      -- Open linked tasks are withdrawn (kept, not deleted) so nothing stays in anyone's Today Tasks.
      update public.staff_tasks set is_active = false
        where job_card_id = p_job_id and is_active
          and status_id in (select id from public.status_master where code in ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'ON_HOLD', 'RETURNED', 'REOPENED', 'PARTIALLY_ACCEPTED'));
    when 'reopen' then
      if not v_head then raise exception 'Only the Factory Head or Admin can reopen a Job Card'; end if;
      if v_old not in ('completed', 'cancelled') then raise exception 'Only a closed Job Card can be reopened'; end if;
      if v_note is null then raise exception 'Please give a reason for reopening'; end if;
      v_new := case when v_old = 'completed' then 'in_production' else 'pending_verification' end;
      update public.inhouse_production_requests set completed_at = null, completed_by = null, actual_completion_date = null, cancelled_reason = null, viewed_at = null where id = p_job_id;
    else
      raise exception 'Unknown action';
  end case;

  update public.inhouse_production_requests set factory_status = v_new, updated_at = now() where id = p_job_id;
  select * into j from public.inhouse_production_requests where id = p_job_id;

  perform public.factory_log_event(p_job_id, v_event, v_old, v_new, v_note, v_uid);
  perform public.staff_write_audit('inhouse_production_requests', p_job_id, 'FACTORY_' || upper(p_action), jsonb_build_object('status', v_old), jsonb_build_object('status', v_new, 'note', v_note), j.source_department_id, null);

  if p_action = 'accept' then
    perform public.factory_notify_user(j.requested_by, p_job_id, 'Your Factory request ' || j.job_order_number || ' was accepted', 'તમારી ફેક્ટરી વિનંતી ' || j.job_order_number || ' સ્વીકારવામાં આવી');
  elsif p_action = 'return' then
    perform public.factory_notify_user(j.requested_by, p_job_id, 'Clarification needed on ' || j.job_order_number || ': ' || v_note, j.job_order_number || ' પર સ્પષ્ટતા જરૂરી: ' || v_note);
  elsif p_action = 'resubmit' then
    perform public.factory_notify_managers(p_job_id, 'Job Card ' || j.job_order_number || ' was re-submitted after correction', 'જોબ કાર્ડ ' || j.job_order_number || ' સુધારા પછી ફરી સબમિટ થયું');
  elsif p_action = 'block' then
    perform public.factory_notify_managers(p_job_id, 'Job Card ' || j.job_order_number || ' is blocked: ' || v_note, 'જોબ કાર્ડ ' || j.job_order_number || ' અટકેલું છે: ' || v_note);
  elsif p_action = 'mark_ready' then
    perform public.factory_notify_managers(p_job_id, 'Job Card ' || j.job_order_number || ' is ready for review', 'જોબ કાર્ડ ' || j.job_order_number || ' સમીક્ષા માટે તૈયાર છે');
  elsif p_action = 'complete' then
    perform public.factory_notify_user(j.requested_by, p_job_id, 'Your Factory request ' || j.job_order_number || ' is completed', 'તમારી ફેક્ટરી વિનંતી ' || j.job_order_number || ' પૂર્ણ થઈ');
  end if;

  return v_new;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Create / cancel Factory tasks (with or without a Job Card)
-- ---------------------------------------------------------------------------
create or replace function public.factory_create_task(p jsonb)
  returns table(task_id uuid, task_number text)
  language plpgsql security definer set search_path = public
as $$
declare
  v_fac uuid := public.factory_dept_id(); v_uid uuid := auth.uid();
  v_title text := nullif(btrim(coalesce(p ->> 'title', '')), '');
  v_primary uuid := nullif(p ->> 'primary_user', '')::uuid;
  v_second uuid := nullif(p ->> 'second_user', '')::uuid;
  v_job uuid := nullif(p ->> 'job_card_id', '')::uuid;
  v_item uuid := nullif(p ->> 'job_card_item_id', '')::uuid;
  v_stage text := nullif(btrim(coalesce(p ->> 'production_stage', '')), '');
  v_due date := nullif(p ->> 'due_date', '')::date;
  v_start date := nullif(p ->> 'start_date', '')::date;
  v_prio text := coalesce(nullif(p ->> 'priority_code', ''), 'NORMAL');
  v_proof text := coalesce(nullif(p ->> 'proof_type_code', ''), 'none');
  v_req boolean := coalesce((p ->> 'requires_acceptance')::boolean, true);
  v_qty numeric := nullif(p ->> 'total_quantity', '')::numeric;
  v_location uuid := nullif(p ->> 'factory_location_id', '')::uuid;
  v_dept text := nullif(btrim(coalesce(p ->> 'production_department', '')), '');
  j public.inhouse_production_requests%rowtype; v_new record; v_type text; v_accepted uuid;
#variable_conflict use_column
begin
  perform public.staff_assert_operational();
  if not public.factory_ai_is_reviewer() then raise exception 'You are not authorized to create Factory tasks'; end if;
  if v_title is null then raise exception 'Please enter a task title'; end if;
  if v_primary is null then raise exception 'Please choose the primary assignee'; end if;
  if v_due is null then raise exception 'Please choose a due date'; end if;
  if v_start is not null and v_due < v_start then raise exception 'Due date cannot be before the start date'; end if;

  if v_job is not null then
    select * into j from public.inhouse_production_requests r where r.id = v_job and public.factory_job_visible_row(r);
    if j.id is null then raise exception 'Job Card not found or not accessible'; end if;
    if j.factory_status in ('cancelled', 'completed') then raise exception 'Tasks cannot be added to a % Job Card', j.factory_status; end if;
    if v_item is not null and not exists (select 1 from public.factory_job_items where id = v_item and job_id = v_job) then
      raise exception 'The selected item does not belong to this Job Card';
    end if;
    v_location := coalesce(v_location, j.factory_location_id);
  else
    v_item := null;
  end if;
  if v_stage is not null and not exists (select 1 from public.factory_production_stages where code = v_stage and is_active) then
    raise exception 'Unknown production stage';
  end if;

  v_type := case when v_job is not null then 'FACTORY_REQUEST' else 'GENERAL_TASK' end;
  select * into v_new from public.staff_create_task(
    v_title, nullif(btrim(coalesce(p ->> 'description', '')), ''), v_type, v_prio, v_proof, v_fac, v_fac, v_primary, v_due, null,
    nullif(p ->> 'verifier_id', '')::uuid, case when v_job is not null then j.job_order_number else null end, null,
    case when v_qty is not null then v_qty::text else null end, v_second, case when v_job is not null then j.project_id else null end);

  update public.staff_tasks set job_card_id = v_job, job_card_item_id = v_item, production_stage = v_stage, factory_location_id = v_location,
    production_department = coalesce(v_dept, case when v_job is not null then j.production_department end), requires_acceptance = v_req,
    total_quantity = v_qty, start_date = v_start, proof_instructions = nullif(btrim(coalesce(p ->> 'proof_instructions', '')), '')
    where id = v_new.task_id;

  if not v_req then
    update public.staff_task_assignees set acceptance_status = 'ACCEPTED', accepted_at = now(), individual_status = 'ACCEPTED' where task_id = v_new.task_id and is_active;
    select id into v_accepted from public.status_master where code = 'ACCEPTED';
    update public.staff_tasks set status_id = v_accepted, accepted_by = v_primary where id = v_new.task_id;
  end if;

  perform public.staff_write_audit('task', v_new.task_id, 'FACTORY_TASK_CREATE', null,
    jsonb_build_object('job_card_id', v_job, 'item', v_item, 'stage', v_stage, 'requires_acceptance', v_req), v_fac);
  if v_job is not null then
    perform public.factory_log_event(v_job, 'task_created', j.factory_status, j.factory_status, 'Task ' || v_new.task_number || ': ' || v_title, v_uid);
  end if;
  return query select v_new.task_id, v_new.task_number;
end $$;

create or replace function public.factory_cancel_task(p_task uuid, p_reason text) returns void
  language plpgsql security definer set search_path = public
as $$
declare t public.staff_tasks%rowtype; v_code text; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); r record; v_name text;
begin
  perform public.staff_assert_operational();
  if not public.factory_ai_is_reviewer() then raise exception 'You are not authorized to cancel Factory tasks'; end if;
  if v_reason is null then raise exception 'Please give a reason for cancelling'; end if;
  select * into t from public.staff_tasks where id = p_task for update;
  if t.id is null or t.to_department_id is distinct from public.factory_dept_id() then raise exception 'Factory task not found'; end if;
  select code into v_code from public.status_master where id = t.status_id;
  if not t.is_active then raise exception 'This task is already cancelled'; end if;
  if v_code in ('VERIFIED', 'CLOSED') then raise exception 'A completed task cannot be cancelled'; end if;

  update public.staff_tasks set is_active = false where id = p_task;
  perform public.staff_write_audit('task', p_task, 'FACTORY_TASK_CANCEL', jsonb_build_object('status', v_code), jsonb_build_object('reason', v_reason), t.to_department_id, v_reason);
  select full_name into v_name from public.user_profiles where id = auth.uid();
  perform public.staff_post_system_task_message(p_task, 'Cancelled by ' || coalesce(v_name, 'Factory') || ': ' || v_reason, 'રદ કર્યું: ' || v_reason);
  for r in select user_id from public.staff_task_assignees where task_id = p_task and is_active loop
    perform public.staff_notify_assignment(r.user_id, 'task', p_task, 'Task cancelled: ' || t.task_number || ' — ' || v_reason, 'કાર્ય રદ: ' || t.task_number || ' — ' || v_reason);
  end loop;
end $$;

-- Factory leadership can also reassign a task (e.g. after an employee rejects it) without needing Dept-Head rights.
create or replace function public.factory_reassign_task(p_task uuid, p_primary uuid, p_second uuid, p_reason text) returns void
  language plpgsql security definer set search_path = public
as $$
begin
  perform public.staff_assert_operational();
  if not public.factory_ai_is_reviewer() then raise exception 'You are not authorized to assign Factory staff'; end if;
  if not exists (select 1 from public.staff_tasks where id = p_task and to_department_id = public.factory_dept_id()) then raise exception 'Factory task not found'; end if;
  perform public.factory_sync_task_assignees(p_task, p_primary, p_second, p_reason);
end $$;

-- ---------------------------------------------------------------------------
-- 9. Reads: job search, task list (single visibility rule), overview
-- ---------------------------------------------------------------------------
create or replace function public.factory_search_job_cards(p_q text default null, p_include_closed boolean default false, p_limit integer default 20)
  returns table(id uuid, job_order_number text, source_reference text, customer_name text, project_code text, product_item text,
                factory_status text, required_date date, current_stage text, factory_location_id uuid, source_department_name text)
  language sql stable set search_path = public
as $$
  select v.id, v.job_order_number, v.source_reference, v.customer_name, v.project_code, v.product_item, v.factory_status,
         v.required_date, v.current_stage, v.factory_location_id, v.source_department_name
  from public.factory_job_cards_v v
  where not v.is_test_data
    and (p_include_closed or v.factory_status not in ('cancelled', 'completed'))
    and v.factory_status <> 'cancelled' -- cancelled cards are never offered
    and (coalesce(btrim(p_q), '') = ''
      or v.job_order_number ilike '%' || btrim(p_q) || '%' or v.source_reference ilike '%' || btrim(p_q) || '%'
      or v.customer_name ilike '%' || btrim(p_q) || '%' or v.project_code ilike '%' || btrim(p_q) || '%'
      or v.product_item ilike '%' || btrim(p_q) || '%'
      or exists (select 1 from public.factory_job_items i where i.job_id = v.id and i.item_name ilike '%' || btrim(p_q) || '%'))
  order by v.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

create or replace function public.factory_tasks_list(p_tab text default 'open', p_search text default null, p_limit integer default 300)
  returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_fac uuid := public.factory_dept_id(); v_uid uuid := auth.uid(); v_today date := (now() at time zone 'Asia/Kolkata')::date;
        v_q text := nullif(btrim(coalesce(p_search, '')), ''); v_out jsonb;
begin
  perform public.staff_assert_operational();
  select coalesce(jsonb_agg(x.o order by x.sort_group, x.due, x.upd desc), '[]'::jsonb) into v_out from (
    select jsonb_build_object(
        'id', st.id, 'task_number', st.task_number, 'title', st.title, 'description', st.description,
        'status', s.code, 'priority', pm.code, 'due_date', st.due_date, 'start_date', st.start_date,
        'job_card_id', st.job_card_id, 'job_order_number', j.job_order_number, 'customer_name', j.customer_name,
        'item_id', st.job_card_item_id, 'item_name', it.item_name, 'stage', st.production_stage,
        'primary_id', st.assigned_to, 'primary_name', pu.full_name,
        'second_id', a2.user_id, 'second_name', su.full_name,
        'verifier_id', st.verifier_id, 'verifier_name', vu.full_name,
        'blocker', case when s.code = 'ON_HOLD' then st.hold_reason end,
        'return_reason', case when s.code = 'RETURNED' then st.return_reason end,
        'total_quantity', st.total_quantity, 'completed_quantity', st.completed_quantity,
        'started_at', st.started_at, 'completed_at', st.completed_at, 'updated_at', st.updated_at,
        'requires_acceptance', st.requires_acceptance, 'proof_required', pt.code <> 'none',
        'is_mine', mine.user_id is not null, 'my_acceptance', mine.acceptance_status,
        'i_verify', st.verifier_id = v_uid,
        'is_overdue', st.due_date < v_today and s.code not in ('COMPLETED', 'VERIFIED', 'CLOSED'),
        'production_department', st.production_department
      ) as o,
      st.due_date as due, st.updated_at as upd, 0 as sort_group
    from public.staff_tasks st
    join public.status_master s on s.id = st.status_id
    join public.priority_master pm on pm.id = st.priority_id
    join public.proof_types pt on pt.id = st.proof_type_id
    left join public.inhouse_production_requests j on j.id = st.job_card_id
    left join public.factory_job_items it on it.id = st.job_card_item_id
    left join public.user_profiles pu on pu.id = st.assigned_to
    left join public.user_profiles vu on vu.id = st.verifier_id
    left join lateral (select user_id from public.staff_task_assignees a where a.task_id = st.id and a.assignment_role = 'secondary' and a.is_active limit 1) a2 on true
    left join public.user_profiles su on su.id = a2.user_id
    left join lateral (select a.user_id, a.acceptance_status from public.staff_task_assignees a where a.task_id = st.id and a.user_id = v_uid and a.is_active limit 1) mine on true
    where st.is_active and st.to_department_id = v_fac and public.staff_task_visible(st.id)
      and (case coalesce(p_tab, 'open')
        when 'my' then mine.user_id is not null and (s.code not in ('VERIFIED', 'CLOSED') or st.completed_at >= (v_today::timestamp at time zone 'Asia/Kolkata'))
        when 'team' then mine.user_id is null and s.code not in ('VERIFIED', 'CLOSED')
        when 'jobcard' then st.job_card_id is not null and s.code not in ('VERIFIED', 'CLOSED')
        when 'standalone' then st.job_card_id is null and s.code not in ('VERIFIED', 'CLOSED')
        when 'blocked' then s.code = 'ON_HOLD'
        when 'completed' then s.code in ('VERIFIED', 'CLOSED')
        else s.code not in ('VERIFIED', 'CLOSED') or st.completed_at >= (v_today::timestamp at time zone 'Asia/Kolkata')
      end)
      and (v_q is null or st.title ilike '%' || v_q || '%' or st.task_number ilike '%' || v_q || '%'
           or j.job_order_number ilike '%' || v_q || '%' or j.customer_name ilike '%' || v_q || '%' or pu.full_name ilike '%' || v_q || '%')
    order by st.due_date, st.updated_at desc
    limit least(greatest(coalesce(p_limit, 300), 1), 500)
  ) x;
  return v_out;
end $$;

create or replace function public.factory_work_overview(p_filters jsonb default '{}'::jsonb) returns jsonb
  language plpgsql stable security definer set search_path = public
as $$
declare
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_fac uuid := public.factory_dept_id(); v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_loc uuid := nullif(f ->> 'location', '')::uuid;   v_dept text := nullif(f ->> 'production_department', '');
  v_sup uuid := nullif(f ->> 'supervisor', '')::uuid; v_emp uuid := nullif(f ->> 'employee', '')::uuid;
  v_src uuid := nullif(f ->> 'source_department', '')::uuid; v_job uuid := nullif(f ->> 'job', '')::uuid;
  v_status text := nullif(f ->> 'status', '');        v_stage text := nullif(f ->> 'stage', '');
  v_prio text := nullif(f ->> 'priority', '');
  v_from date := nullif(f ->> 'from', '')::date;      v_to date := nullif(f ->> 'to', '')::date;
  v_delayed boolean := coalesce((f ->> 'delayed_only')::boolean, false);
  v_tasks jsonb; v_jobs jsonb; v_counts jsonb; v_people jsonb;
begin
  perform public.staff_assert_operational();
  if not public.factory_ai_is_reviewer() then raise exception 'You are not authorized to view the Factory overview'; end if;

  -- Cards: always the whole Factory (unfiltered), never Accounts (confidential) tasks.
  with bt as (
    select st.*, s.code as scode from public.staff_tasks st join public.status_master s on s.id = st.status_id
    where st.is_active and st.to_department_id = v_fac
      and not exists (select 1 from public.departments d where d.id in (st.from_department_id, st.to_department_id) and d.is_confidential_domain)
  ), bj as (select * from public.factory_job_cards_v where not is_test_data and factory_status <> 'cancelled')
  select jsonb_build_object(
    'new_job_cards',      (select count(*) from bj where factory_status = 'pending_verification'),
    'pending_acceptance', (select count(*) from bt where scode = 'ASSIGNED'),
    'active_tasks',       (select count(*) from bt where scode not in ('COMPLETED', 'VERIFIED', 'CLOSED')),
    'in_production',      (select count(*) from bj where factory_status = 'in_production'),
    'blocked',            (select count(*) from bt where scode = 'ON_HOLD') + (select count(*) from bj where factory_status = 'blocked'),
    'delayed',            (select count(*) from bt where due_date < v_today and scode not in ('COMPLETED', 'VERIFIED', 'CLOSED'))
                          + (select count(*) from bj where is_delayed and factory_status not in ('completed')),
    'ready_for_review',   (select count(*) from bt where scode = 'COMPLETED') + (select count(*) from bj where factory_status = 'ready_for_review'),
    'completed_today',    (select count(*) from bt where scode in ('COMPLETED', 'VERIFIED', 'CLOSED') and (completed_at at time zone 'Asia/Kolkata')::date = v_today)
  ) into v_counts;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', st.id, 'task_number', st.task_number, 'title', st.title, 'status', s.code, 'priority', pm.code,
      'due_date', st.due_date, 'stage', st.production_stage, 'job_card_id', st.job_card_id, 'job_order_number', j.job_order_number,
      'customer_name', j.customer_name, 'project_code', j.project_code, 'item_name', it.item_name,
      'source_department_name', j.source_department_name,
      'primary_id', st.assigned_to, 'primary_name', pu.full_name,
      'second_id', a2.user_id, 'second_name', su.full_name, 'verifier_id', st.verifier_id, 'verifier_name', vu.full_name,
      'blocker', case when s.code = 'ON_HOLD' then st.hold_reason end,
      'is_overdue', st.due_date < v_today and s.code not in ('COMPLETED', 'VERIFIED', 'CLOSED'),
      'total_quantity', st.total_quantity, 'completed_quantity', st.completed_quantity, 'updated_at', st.updated_at
    ) order by st.due_date, st.updated_at desc), '[]'::jsonb) into v_tasks
  from public.staff_tasks st
    join public.status_master s on s.id = st.status_id
    join public.priority_master pm on pm.id = st.priority_id
    left join public.factory_job_cards_v j on j.id = st.job_card_id
    left join public.factory_job_items it on it.id = st.job_card_item_id
    left join public.user_profiles pu on pu.id = st.assigned_to
    left join public.user_profiles vu on vu.id = st.verifier_id
    left join lateral (select user_id from public.staff_task_assignees a where a.task_id = st.id and a.assignment_role = 'secondary' and a.is_active limit 1) a2 on true
    left join public.user_profiles su on su.id = a2.user_id
  where st.is_active and st.to_department_id = v_fac
    and not exists (select 1 from public.departments d where d.id in (st.from_department_id, st.to_department_id) and d.is_confidential_domain)
    and (v_loc is null or st.factory_location_id = v_loc) and (v_dept is null or st.production_department = v_dept)
    and (v_sup is null or st.verifier_id = v_sup)
    and (v_emp is null or exists (select 1 from public.staff_task_assignees a where a.task_id = st.id and a.user_id = v_emp and a.is_active))
    and (v_job is null or st.job_card_id = v_job) and (v_status is null or s.code = v_status) and (v_stage is null or st.production_stage = v_stage)
    and (v_prio is null or pm.code = v_prio) and (v_from is null or st.due_date >= v_from) and (v_to is null or st.due_date <= v_to)
    and (not v_delayed or (st.due_date < v_today and s.code not in ('COMPLETED', 'VERIFIED', 'CLOSED')))
    and (v_src is null or j.source_department_id = v_src);

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', v.id, 'job_order_number', v.job_order_number, 'factory_status', v.factory_status, 'customer_name', v.customer_name,
      'project_code', v.project_code, 'product_item', v.product_item, 'source_department_name', v.source_department_name,
      'required_date', v.required_date, 'current_stage', v.current_stage, 'priority', v.priority, 'is_delayed', v.is_delayed,
      'is_blocked', v.is_blocked, 'assigned_name', v.assigned_name, 'second_name', v.second_name, 'updated_at', v.updated_at,
      'progress', public.factory_job_progress_calc(v.id)
    ) order by v.required_date nulls last, v.updated_at desc), '[]'::jsonb) into v_jobs
  from public.factory_job_cards_v v
  where not v.is_test_data and v.factory_status <> 'cancelled'
    and (v_loc is null or v.factory_location_id = v_loc) and (v_dept is null or v.production_department = v_dept)
    and (v_src is null or v.source_department_id = v_src) and (v_job is null or v.id = v_job) and (v_stage is null or v.current_stage = v_stage)
    and (v_prio is null or (case when v.priority = 'Emergency' then 'URGENT' else upper(v.priority) end) = v_prio)
    and (v_from is null or v.required_date >= v_from) and (v_to is null or v.required_date <= v_to)
    and (not v_delayed or v.is_delayed)
    and ((v_status is null and v_emp is null and v_sup is null) or exists (select 1 from jsonb_array_elements(v_tasks) tt where (tt ->> 'job_card_id')::uuid = v.id));

  select coalesce(jsonb_agg(jsonb_build_object('id', up.id, 'name', up.full_name, 'role', ro.code) order by up.full_name), '[]'::jsonb) into v_people
  from public.user_profiles up join public.roles ro on ro.id = up.role_id where up.is_active and up.department_id = v_fac;

  return jsonb_build_object('counts', v_counts, 'tasks', v_tasks, 'jobs', v_jobs, 'people', v_people);
end $$;

-- ---------------------------------------------------------------------------
-- 10. Grants (explicit revoke from public/anon first -- same pattern as the rest of Factory)
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'factory_dept_id()', 'factory_sync_task_assignees(uuid,uuid,uuid,text)', 'factory_sync_job_task(uuid,uuid,uuid,text)',
    'factory_job_progress_calc(uuid)', 'factory_recompute_job_progress(uuid)', 'factory_task_after_change()', 'factory_guard_job_write()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'factory_job_progress_many(uuid[])', 'factory_create_task(jsonb)', 'factory_cancel_task(uuid,text)', 'factory_reassign_task(uuid,uuid,uuid,text)',
    'factory_search_job_cards(text,boolean,integer)', 'factory_tasks_list(text,text,integer)', 'factory_work_overview(jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Realtime: the task tables already publish; make sure the stage config is not needed there.
