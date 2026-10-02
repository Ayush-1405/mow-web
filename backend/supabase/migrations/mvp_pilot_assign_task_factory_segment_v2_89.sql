-- Assign Task -> Factory Segment + Job Card routing (handwritten spec). Design notes, disclosed:
--
-- staff_create_task() (the one generic task-creation RPC every department's Assign Task screen already calls)
-- is deliberately LEFT UNTOUCHED -- its signature is already 16 positional params and widening it risks the
-- exact "could not choose a best candidate function" overload trap this project hit earlier (CREATE OR REPLACE
-- with an added parameter creates a new overload, it does not replace). Instead this follows the SAME two-step
-- pattern factory_create_task() itself already uses internally (create the generic task, then UPDATE its
-- Factory-specific columns): a new staff_set_task_factory_context() RPC the frontend calls immediately after
-- staff_create_task() returns a task_id, whenever To Department resolves to Factory.
--
-- "Factory Segment" is FOUR choices (Sofa / Modular / Metal Fabrication / Material to Order), but only three of
-- them are real production_divisions rows -- Material to Order has no division and no Job Card concept. Rather
-- than add a 4th fake division row, factory_segment_code carries the authoritative choice as its own text value;
-- division_id is resolved from it (null for MATERIAL_ORDER).
--
-- "Authorized Factory Admin" (the third role Part 4 allows) is not a role this schema models separately from
-- Factory Head/Supervisor -- disclosed, not silently assumed; factory_is_leadership_user() checks Head/
-- Supervisor/global-oversight only.
--
-- Segment-level Supervisor scoping ("Segment Supervisor sees tasks belonging to their segment/team", Part 7) is
-- NOT added here -- staff_can_view_task() already gives a Factory supervisor every task routed to the Factory
-- DEPARTMENT (confirmed live, unchanged), but there is no existing "this supervisor owns this segment" table to
-- scope it any tighter, and inventing one is materially new schema beyond what this pass covers. Disclosed, not
-- silently left broken: a Sofa supervisor today still sees a Modular task the same way they already see every
-- other cross-segment Factory task before this change.

-- 1. staff_tasks gains the Factory-segment columns. Additive, nullable -- every existing task (including every
--    non-Factory task in every other department) keeps working unchanged.
alter table public.staff_tasks add column if not exists division_id uuid references public.production_divisions(id);
alter table public.staff_tasks add column if not exists factory_segment_code text
  check (factory_segment_code in ('SOFA', 'MODULAR', 'METAL_FAB', 'MATERIAL_ORDER'));
alter table public.staff_tasks add column if not exists task_link_type text
  check (task_link_type in ('job_card', 'general')) default 'general';

create index if not exists staff_tasks_division_idx on public.staff_tasks (division_id) where division_id is not null;
create index if not exists staff_tasks_job_card_idx on public.staff_tasks (job_card_id) where job_card_id is not null;

-- 2. factory_is_leadership_user -- the "Factory Head, relevant Supervisor or authorized Factory Admin" check,
--    for an ARBITRARY target user (the chosen assignee), not just the caller -- staff_is_dept_head()/
--    staff_is_supervisor() only ever answer for auth.uid(), so this reimplements the same role-family logic
--    (staff_role_family/staff_current_role_code, already used by staff_has_global_oversight()) parametrized.
create or replace function public.factory_is_leadership_user(p_user_id uuid)
returns boolean
language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    (select public.staff_role_family(r.code) from public.user_profiles up join public.roles r on r.id = up.role_id
       where up.id = p_user_id and up.is_active) is not null
    or exists (
      select 1 from public.user_profiles up join public.roles r on r.id = up.role_id
      where up.id = p_user_id and up.is_active and up.department_id = public.factory_dept_id()
        and r.code in ('dept_head', 'supervisor')
    ), false);
$$;
grant execute on function public.factory_is_leadership_user(uuid) to authenticated;

-- 3. factory_list_segment_leadership -- who an EXTERNAL department (not Factory itself) may assign a Factory
--    task to: Factory Head + Supervisors only (Part 4, rule 1). Open to any authenticated operational user
--    (not gated to Factory staff) precisely because it is Interior/Retail/Accounts/etc. who need to call it.
create or replace function public.factory_list_segment_leadership()
returns table(id uuid, employee_code text, full_name text, role_label_en text, role_label_gu text)
language sql stable security definer set search_path to 'public' as $$
  select up.id, up.employee_code, up.full_name, r.name_en, r.name_gu
  from public.user_profiles up
  join public.roles r on r.id = up.role_id
  where up.is_active and not up.is_deleted and up.department_id = public.factory_dept_id()
    and r.code in ('dept_head', 'supervisor')
  order by r.code, up.full_name;
$$;
grant execute on function public.factory_list_segment_leadership() to authenticated;

-- 4. staff_set_task_factory_context -- called right after staff_create_task() whenever To Department resolved
--    to Factory. Re-validates everything server-side (never trusts the frontend's own gating): segment is a
--    real choice, a linked Job Card belongs to the SAME segment and isn't closed, and -- the one rule that
--    actually needs enforcing here since staff_create_task()'s own assignee list is department-wide, not
--    role-scoped -- an EXTERNAL department's caller may only have assigned to Factory Head/Supervisor.
create or replace function public.staff_set_task_factory_context(
  p_task_id uuid, p_factory_segment_code text, p_job_card_id uuid default null, p_task_link_type text default 'general'
) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  t public.staff_tasks%rowtype;
  v_fac uuid := public.factory_dept_id();
  v_division public.production_divisions%rowtype;
  v_job public.inhouse_production_requests%rowtype;
  v_caller_dept uuid := public.staff_current_department_id();
  v_second uuid;
begin
  perform public.staff_assert_operational();
  select * into t from public.staff_tasks where id = p_task_id for update;
  if t.id is null then raise exception 'Task not found'; end if;
  if not (t.assigned_by = auth.uid() or public.staff_has_global_oversight()) then
    raise exception 'Only the person who created this task may set its Factory routing';
  end if;
  if t.to_department_id <> v_fac then raise exception 'This task is not assigned to Factory'; end if;

  if coalesce(p_factory_segment_code, '') not in ('SOFA', 'MODULAR', 'METAL_FAB', 'MATERIAL_ORDER') then
    raise exception 'Please select a Factory Segment';
  end if;
  if coalesce(p_task_link_type, 'general') not in ('job_card', 'general') then raise exception 'Invalid task link type'; end if;

  if p_factory_segment_code = 'MATERIAL_ORDER' then
    if p_job_card_id is not null then raise exception 'Material to Order tasks cannot be linked to a Job Card'; end if;
    v_division.id := null;
  else
    select * into v_division from public.production_divisions where code = p_factory_segment_code and is_active;
    if v_division.id is null then raise exception 'Please select a Factory Segment'; end if;
    if p_task_link_type = 'job_card' then
      if p_job_card_id is null then raise exception 'Please select a Job Card or choose General Factory Task'; end if;
      select * into v_job from public.inhouse_production_requests r where r.id = p_job_card_id and public.factory_job_visible_row(r);
      if v_job.id is null then raise exception 'Job Card not found or not accessible'; end if;
      if v_job.factory_status in ('completed', 'cancelled') then raise exception 'Tasks cannot be linked to a closed Job Card'; end if;
      if v_job.division_id is distinct from v_division.id then raise exception 'This Job Card belongs to another Factory Segment'; end if;
    elsif p_job_card_id is not null then
      raise exception 'Please select a Job Card or choose General Factory Task';
    end if;
  end if;

  -- The one real assignee-authorization gate staff_create_task() itself does not apply: when the CALLER is
  -- from outside Factory, the person they assigned to must be Factory Head/Supervisor (Part 4, rule 1). A
  -- Factory-internal caller (Head/Supervisor assigning within their own department) may assign to any Factory
  -- worker -- staff_create_task()'s own department-scoped assignee list already enforced that boundary.
  if v_caller_dept is distinct from v_fac and not public.staff_has_global_oversight() then
    if not public.factory_is_leadership_user(t.assigned_to) then
      raise exception 'Selected assignee is not authorized for this Factory Segment';
    end if;
  end if;

  update public.staff_tasks set
    division_id = v_division.id, factory_segment_code = p_factory_segment_code,
    job_card_id = p_job_card_id, task_link_type = coalesce(p_task_link_type, 'general')
  where id = p_task_id;

  perform public.staff_write_audit('task', p_task_id, 'FACTORY_SEGMENT_SET', null,
    jsonb_build_object('factory_segment_code', p_factory_segment_code, 'job_card_id', p_job_card_id, 'task_link_type', p_task_link_type), v_fac);

  if v_job.id is not null then
    perform public.factory_log_event(v_job.id, 'task_created', v_job.factory_status, v_job.factory_status,
      'Task ' || coalesce(t.task_number, '') || ': ' || t.title, auth.uid());
  end if;

  -- Notifications (Part 8): primary + second assignee, and Factory Head regardless of segment (no persistent
  -- segment-supervisor mapping exists to notify a specific segment's supervisor by segment alone -- disclosed
  -- above; Factory Head already sees and is notified of every Factory task either way).
  perform public.staff_notify_assignment(t.assigned_to, 'task', p_task_id,
    t.title || ' — ' || p_factory_segment_code, t.title || ' — ' || p_factory_segment_code);
  select user_id into v_second from public.staff_task_assignees
    where task_id = p_task_id and is_active and user_id <> t.assigned_to limit 1;
  if v_second is not null then
    perform public.staff_notify_assignment(v_second, 'task', p_task_id,
      t.title || ' — ' || p_factory_segment_code, t.title || ' — ' || p_factory_segment_code);
  end if;
  perform public.staff_notify_dept_leadership('FACTORY', 'task', p_task_id,
    'New Factory task (' || p_factory_segment_code || '): ' || t.title,
    'નવું ફેક્ટરી ટાસ્ક (' || p_factory_segment_code || '): ' || t.title);
end $function$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'staff_set_task_factory_context(uuid, text, uuid, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
