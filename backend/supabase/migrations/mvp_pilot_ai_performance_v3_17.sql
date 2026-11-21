-- v3_17: AI Employee Performance -- task-by-task points, permanent monthly snapshots, review workflow, goals, company report.
--
-- How it works
--   * perf_eval() is the ONE scoring engine. It reads the real task records (staff_tasks, staff_task_assignees, staff_audit_log,
--     task_messages, factory_job_card_qc) for one person and one month and returns every task with its points and a plain
--     explanation. It is deterministic SQL: the AI never invents a number.
--   * Each task is counted once per person (bridges / job cards / order tasks are all the same staff_tasks row), and only for the
--     person who actually held it. Creating tasks earns nothing. Cancelled, reassigned-away, returned and colleague-completed
--     tasks are listed but not scored. A delay a Head or Management verifies as "not their fault" is not penalised.
--   * perf_generate_month() freezes a month into perf_monthly_reports + perf_report_tasks (one current version per person and
--     month, never overwritten). A correction is a new version with a reason; the old version stays, marked SUPERSEDED.
--   * The written review is added afterwards by the perf-ai-review edge function (Gemini/Claude) from the frozen facts only.
--   * Workflow: DRAFT (AI generated) -> SHARED (Head reviewed, feedback + goals; employee can now see it) -> RESPONDED
--     (employee comment) -> FINAL (Management). AI never issues warnings or penalties.
--   * Read access: yourself (your own monthly report once shared), Heads for their departments, Management for everything,
--     and people Management grants access to (HR) for all or one department. All writes go through the functions below.

-- ---------------------------------------------------------------- configuration
create table if not exists public.perf_settings (
  id integer primary key default 1 check (id = 1),
  min_tasks integer not null default 3 check (min_tasks between 1 and 50),
  prior_score numeric not null default 70 check (prior_score between 0 and 100),
  prior_weight numeric not null default 2 check (prior_weight between 0 and 20),
  priority_factors jsonb not null default '{"LOW": 0.8, "NORMAL": 1, "HIGH": 1.2, "URGENT": 1.4}',
  cross_department_factor numeric not null default 1.1 check (cross_department_factor between 1 and 2),
  updated_by uuid references public.user_profiles(id),
  updated_at timestamptz not null default now()
);
insert into public.perf_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.perf_frameworks (
  id uuid primary key default gen_random_uuid(),
  department_id uuid unique references public.departments(id),   -- null = company default
  w_completion numeric not null default 30 check (w_completion >= 0),
  w_deadline numeric not null default 20 check (w_deadline >= 0),
  w_quality numeric not null default 25 check (w_quality >= 0),
  w_ownership numeric not null default 15 check (w_ownership >= 0),
  w_collaboration numeric not null default 10 check (w_collaboration >= 0),
  focus_areas text[] not null default '{}',
  updated_by uuid references public.user_profiles(id),
  updated_at timestamptz not null default now(),
  constraint perf_frameworks_total_100 check (w_completion + w_deadline + w_quality + w_ownership + w_collaboration = 100)
);
create unique index if not exists perf_frameworks_default_uidx on public.perf_frameworks ((true)) where department_id is null;

insert into public.perf_frameworks (department_id, focus_areas)
select null, array['Task completion', 'Deadlines', 'Work quality', 'Ownership and updates', 'Collaboration']
where not exists (select 1 from public.perf_frameworks where department_id is null);

insert into public.perf_frameworks (department_id, w_completion, w_deadline, w_quality, w_ownership, w_collaboration, focus_areas)
select d.id, x.c, x.dl, x.q, x.o, x.cl, x.f
  from (values
    ('INTERIOR', 30, 20, 25, 10, 15, array['Design completion', 'Site coordination', 'Client updates', 'BOQ accuracy', 'Project deadlines', 'Execution quality']),
    ('PROCUREMENT', 30, 25, 20, 15, 10, array['Purchase request processing', 'Vendor coordination', 'Purchase order accuracy', 'Delivery follow-up', 'Due date management', 'Purchase documentation']),
    ('FACTORY', 30, 20, 30, 12, 8, array['Production completion', 'Job Card handling', 'Production quality', 'QC pass percentage', 'Production deadlines', 'Material coordination']),
    ('RETAIL', 30, 20, 20, 15, 15, array['Customer handling', 'Sales support', 'Store operations', 'Order processing', 'Stock coordination']),
    ('MARKETING', 30, 25, 20, 15, 10, array['Campaign execution', 'Content delivery', 'Marketing task completion', 'Reporting', 'Lead generation where verified']),
    ('ACCOUNTS', 25, 25, 30, 10, 10, array['Transaction processing', 'Documentation', 'Reconciliation', 'Accuracy', 'Deadline management']),
    ('HR_ADMIN', 30, 20, 20, 15, 15, array['Employee coordination', 'Recruitment tasks', 'Attendance administration', 'Employee support', 'Documentation'])
  ) as x(code, c, dl, q, o, cl, f)
  join public.departments d on d.code = x.code
 where not exists (select 1 from public.perf_frameworks pf where pf.department_id = d.id);

-- People Management lets read performance reports (e.g. HR): all departments (department_id null) or one department.
create table if not exists public.perf_viewers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profiles(id),
  department_id uuid references public.departments(id),
  is_active boolean not null default true,
  granted_by uuid references public.user_profiles(id),
  granted_at timestamptz not null default now(),
  revoked_by uuid references public.user_profiles(id),
  revoked_at timestamptz
);
create unique index if not exists perf_viewers_active_uidx on public.perf_viewers (user_id, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)) where is_active;

-- A delay a Head / Management has checked and accepted as not the person's fault.
create table if not exists public.perf_delay_excuses (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.staff_tasks(id),
  user_id uuid not null references public.user_profiles(id),
  reason_code text not null check (reason_code in ('OTHER_DEPARTMENT', 'MANAGEMENT_APPROVAL', 'VENDOR_DELAY', 'MATERIAL_SHORTAGE', 'SYSTEM_FAILURE', 'OTHER_VERIFIED')),
  note text not null,
  verified_by uuid not null references public.user_profiles(id),
  verified_at timestamptz not null default now(),
  is_active boolean not null default true,
  revoked_by uuid references public.user_profiles(id),
  revoked_at timestamptz
);
create unique index if not exists perf_delay_excuses_active_uidx on public.perf_delay_excuses (task_id, user_id) where is_active;

-- ---------------------------------------------------------------- monthly snapshots
create table if not exists public.perf_monthly_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profiles(id),
  department_id uuid references public.departments(id),
  period_month date not null check (period_month = date_trunc('month', period_month)::date),
  version integer not null default 1,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'SHARED', 'RESPONDED', 'FINAL', 'SUPERSEDED')),
  overall_score numeric,
  raw_score numeric,
  scored_tasks integer not null default 0,
  category_scores jsonb not null default '{}',
  metrics jsonb not null default '{}',
  comparison jsonb,
  task_ids uuid[] not null default '{}',
  framework jsonb not null,
  calculation_version text not null,
  generated_at timestamptz not null default now(),
  generated_by uuid references public.user_profiles(id),
  recalc_reason text,
  supersedes_id uuid references public.perf_monthly_reports(id),
  superseded_at timestamptz,
  ai_status text not null default 'PENDING' check (ai_status in ('PENDING', 'DONE', 'FAILED', 'NOT_NEEDED')),
  ai_review jsonb,
  ai_model text,
  ai_generated_at timestamptz,
  ai_error text,
  head_feedback text,
  head_reviewed_by uuid references public.user_profiles(id),
  head_reviewed_at timestamptz,
  employee_response text,
  employee_responded_at timestamptz,
  finalized_by uuid references public.user_profiles(id),
  finalized_at timestamptz,
  unique (user_id, period_month, version)
);
create unique index if not exists perf_monthly_reports_current_uidx on public.perf_monthly_reports (user_id, period_month) where status <> 'SUPERSEDED';
create index if not exists perf_monthly_reports_month_idx on public.perf_monthly_reports (period_month, department_id);

create table if not exists public.perf_report_tasks (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.perf_monthly_reports(id),
  task_id uuid not null references public.staff_tasks(id),
  task_number text,
  title text,
  outcome text not null,
  scored boolean not null,
  weight numeric,
  points numeric,
  available jsonb not null default '{}',
  earned jsonb not null default '{}',
  explanation text[] not null default '{}',
  facts jsonb not null default '{}',
  unique (report_id, task_id)
);
create index if not exists perf_report_tasks_task_idx on public.perf_report_tasks (task_id);

create table if not exists public.perf_goals (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.perf_monthly_reports(id),
  user_id uuid not null references public.user_profiles(id),
  target_month date not null check (target_month = date_trunc('month', target_month)::date),
  goal_type text not null check (goal_type in ('REDUCE_OVERDUE', 'IMPROVE_ON_TIME', 'IMPROVE_QUALITY', 'REDUCE_REWORK', 'IMPROVE_UPDATES', 'IMPROVE_COLLABORATION', 'CUSTOM')),
  target_value numeric,
  description text not null,
  status text not null default 'OPEN' check (status in ('OPEN', 'ACHIEVED', 'NOT_ACHIEVED', 'NOT_MEASURABLE', 'NO_DATA')),
  achieved_value numeric,
  evaluated_at timestamptz,
  evaluated_report_id uuid references public.perf_monthly_reports(id),
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists perf_goals_user_month_idx on public.perf_goals (user_id, target_month);

create table if not exists public.perf_company_reports (
  id uuid primary key default gen_random_uuid(),
  period_month date not null check (period_month = date_trunc('month', period_month)::date),
  version integer not null default 1,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'FINAL', 'SUPERSEDED')),
  metrics jsonb not null,
  calculation_version text not null,
  generated_at timestamptz not null default now(),
  generated_by uuid references public.user_profiles(id),
  recalc_reason text,
  supersedes_id uuid references public.perf_company_reports(id),
  superseded_at timestamptz,
  ai_status text not null default 'PENDING' check (ai_status in ('PENDING', 'DONE', 'FAILED')),
  ai_summary jsonb,
  ai_model text,
  ai_generated_at timestamptz,
  ai_error text,
  management_note text,
  finalized_by uuid references public.user_profiles(id),
  finalized_at timestamptz,
  unique (period_month, version)
);
create unique index if not exists perf_company_reports_current_uidx on public.perf_company_reports (period_month) where status <> 'SUPERSEDED';

-- Append-only history of everything that happens to a report.
create table if not exists public.perf_audit (
  id bigserial primary key,
  report_id uuid,
  company_report_id uuid,
  user_id uuid,
  action text not null,
  detail jsonb,
  performed_by uuid,
  performed_at timestamptz not null default now()
);
create index if not exists perf_audit_report_idx on public.perf_audit (report_id);

-- ---------------------------------------------------------------- immutability
create or replace function public.perf_guard_report() returns trigger language plpgsql set search_path to 'public' as $$
begin
  if tg_op = 'DELETE' then raise exception 'Monthly performance reports are permanent and cannot be deleted'; end if;
  if (new.user_id, new.department_id, new.period_month, new.version, new.overall_score, new.raw_score, new.scored_tasks, new.category_scores,
      new.metrics, new.comparison, new.task_ids, new.framework, new.calculation_version, new.generated_at, new.generated_by, new.recalc_reason, new.supersedes_id)
     is distinct from
     (old.user_id, old.department_id, old.period_month, old.version, old.overall_score, old.raw_score, old.scored_tasks, old.category_scores,
      old.metrics, old.comparison, old.task_ids, old.framework, old.calculation_version, old.generated_at, old.generated_by, old.recalc_reason, old.supersedes_id) then
    raise exception 'The scores of a saved monthly report cannot be changed -- recalculate to create a new version';
  end if;
  if old.status = 'SUPERSEDED' then raise exception 'A superseded report version cannot be changed'; end if;
  if old.status = 'FINAL' and new.status <> 'SUPERSEDED' then raise exception 'A final report cannot be changed -- recalculate to create a new version'; end if;
  if old.ai_status = 'DONE' and new.ai_review is distinct from old.ai_review then raise exception 'The AI review of a report is written once'; end if;
  if old.head_feedback is not null and new.head_feedback is distinct from old.head_feedback then raise exception 'Head feedback is already saved'; end if;
  if old.employee_response is not null and new.employee_response is distinct from old.employee_response then raise exception 'The employee response is already saved'; end if;
  return new;
end $$;
drop trigger if exists trg_perf_guard_report on public.perf_monthly_reports;
create trigger trg_perf_guard_report before update or delete on public.perf_monthly_reports for each row execute function public.perf_guard_report();

create or replace function public.perf_guard_company() returns trigger language plpgsql set search_path to 'public' as $$
begin
  if tg_op = 'DELETE' then raise exception 'Company performance reports are permanent and cannot be deleted'; end if;
  if (new.period_month, new.version, new.metrics, new.calculation_version, new.generated_at, new.generated_by, new.recalc_reason, new.supersedes_id)
     is distinct from (old.period_month, old.version, old.metrics, old.calculation_version, old.generated_at, old.generated_by, old.recalc_reason, old.supersedes_id) then
    raise exception 'The figures of a saved company report cannot be changed -- regenerate to create a new version';
  end if;
  if old.status = 'SUPERSEDED' then raise exception 'A superseded company report cannot be changed'; end if;
  if old.status = 'FINAL' and new.status <> 'SUPERSEDED' then raise exception 'A final company report cannot be changed'; end if;
  if old.ai_status = 'DONE' and new.ai_summary is distinct from old.ai_summary then raise exception 'The AI summary is written once'; end if;
  return new;
end $$;
drop trigger if exists trg_perf_guard_company on public.perf_company_reports;
create trigger trg_perf_guard_company before update or delete on public.perf_company_reports for each row execute function public.perf_guard_company();

create or replace function public.perf_guard_append_only() returns trigger language plpgsql set search_path to 'public' as $$
begin
  raise exception '% rows are permanent and cannot be changed or deleted', tg_table_name;
end $$;
drop trigger if exists trg_perf_guard_tasks on public.perf_report_tasks;
create trigger trg_perf_guard_tasks before update or delete on public.perf_report_tasks for each row execute function public.perf_guard_append_only();
drop trigger if exists trg_perf_guard_audit on public.perf_audit;
create trigger trg_perf_guard_audit before update or delete on public.perf_audit for each row execute function public.perf_guard_append_only();

create or replace function public.perf_guard_goal() returns trigger language plpgsql set search_path to 'public' as $$
begin
  if tg_op = 'DELETE' then raise exception 'Goals are permanent and cannot be deleted'; end if;
  if (new.report_id, new.user_id, new.target_month, new.goal_type, new.target_value, new.description, new.created_by, new.created_at)
     is distinct from (old.report_id, old.user_id, old.target_month, old.goal_type, old.target_value, old.description, old.created_by, old.created_at) then
    raise exception 'A saved goal cannot be changed';
  end if;
  return new;
end $$;
drop trigger if exists trg_perf_guard_goal on public.perf_goals;
create trigger trg_perf_guard_goal before update or delete on public.perf_goals for each row execute function public.perf_guard_goal();

-- ---------------------------------------------------------------- access helpers
create or replace function public.perf_month(p date) returns date language sql immutable as $$ select date_trunc('month', p)::date $$;

create or replace function public.perf_current_month() returns date language sql stable as $$
  select date_trunc('month', (now() at time zone 'Asia/Kolkata'))::date $$;

create or replace function public.perf_is_management() returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.staff_current_user_ok() and public.staff_has_global_oversight(), false) $$;

-- HR / other people Management granted access to: all departments or this one.
create or replace function public.perf_is_granted(p_department uuid) returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.perf_viewers v where v.user_id = auth.uid() and v.is_active
                  and (v.department_id is null or v.department_id = p_department)) $$;

create or replace function public.perf_is_head_of(p_user uuid) returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.staff_current_user_ok() and p_user <> auth.uid() and public.staff_is_dept_head()
    and public.staff_dept_in_hod_scope((select department_id from public.user_profiles where id = p_user)), false) $$;

create or replace function public.perf_can_view_user(p_user uuid) returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.staff_current_user_ok() and (
      p_user = auth.uid() or public.perf_is_management() or public.perf_is_head_of(p_user)
      or public.perf_is_granted((select department_id from public.user_profiles where id = p_user))), false) $$;

-- Who may review (feedback, goals, excuse a delay): the person's Head, or Management. Never yourself.
create or replace function public.perf_can_review_user(p_user uuid) returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(p_user <> auth.uid() and (public.perf_is_management() or public.perf_is_head_of(p_user)), false) $$;

create or replace function public.perf_can_read_report(r public.perf_monthly_reports) returns boolean language sql stable security definer set search_path to 'public' as $$
  select case
    when r.user_id = auth.uid() and not public.perf_is_management()
      then r.status in ('SHARED', 'RESPONDED', 'FINAL') or (r.status = 'SUPERSEDED' and r.head_reviewed_at is not null)
    else public.perf_can_view_user(r.user_id) end $$;

create or replace function public.perf_framework_for(p_department uuid) returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('department_id', f.department_id, 'completion', f.w_completion, 'deadline', f.w_deadline, 'quality', f.w_quality,
           'ownership', f.w_ownership, 'collaboration', f.w_collaboration, 'focus_areas', to_jsonb(f.focus_areas),
           'settings', (select jsonb_build_object('min_tasks', s.min_tasks, 'prior_score', s.prior_score, 'prior_weight', s.prior_weight,
                          'priority_factors', s.priority_factors, 'cross_department_factor', s.cross_department_factor) from public.perf_settings s where s.id = 1))
    from public.perf_frameworks f
   where f.department_id = p_department or f.department_id is null
   order by (f.department_id is null) limit 1 $$;

create or replace function public.perf_log(p_report uuid, p_company uuid, p_user uuid, p_action text, p_detail jsonb)
returns void language sql security definer set search_path to 'public' as $$
  insert into public.perf_audit (report_id, company_report_id, user_id, action, detail, performed_by) values (p_report, p_company, p_user, p_action, p_detail, auth.uid()) $$;

-- Works from the monthly schedule too (no signed-in user), so it writes the notification itself.
create or replace function public.perf_notify(p_users uuid[], p_type text, p_entity uuid, p_en text, p_gu text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v uuid;
begin
  foreach v in array (select array(select distinct x from unnest(coalesce(p_users, '{}')) x where x is not null)) loop
    if v is distinct from auth.uid() and exists (select 1 from public.user_profiles where id = v and is_active) then
      insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu, sender_id)
      values (v, p_type, p_entity, left(p_en, 300), left(p_gu, 300), auth.uid());
    end if;
  end loop;
end $$;

create or replace function public.perf_management_users() returns uuid[] language sql stable security definer set search_path to 'public' as $$
  select coalesce(array_agg(u.id), '{}') from public.user_profiles u join public.roles r on r.id = u.role_id
   where u.is_active and not coalesce(u.is_deleted, false) and public.staff_role_family(r.code) = 'management' $$;

-- ---------------------------------------------------------------- the scoring engine
create or replace function public.perf_eval(p_user uuid, p_month date, p_as_of timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_m date := date_trunc('month', p_month)::date;
  v_start timestamptz := (v_m::timestamp) at time zone 'Asia/Kolkata';
  v_end timestamptz := ((v_m + interval '1 month')::timestamp) at time zone 'Asia/Kolkata';
  v_cut timestamptz := least(((v_m + interval '1 month')::timestamp) at time zone 'Asia/Kolkata', p_as_of);
  v_dept uuid; v_fw jsonb; s jsonb;
  w_c numeric; w_d numeric; w_q numeric; w_o numeric; w_l numeric;
  r record;
  v_due timestamptz; v_done boolean; v_user_done boolean; v_done_at timestamptz; v_outcome text; v_scored boolean;
  v_cross boolean; v_msgs int; v_msgs_before_due int; v_attach int; v_reopen int; v_qc_n int; v_qc_pass int; v_flag_before_due int;
  v_excuse record; v_already text; v_verified boolean; v_acc timestamptz; v_late_days numeric;
  e_c numeric; e_d numeric; e_q numeric; e_o numeric; e_l numeric;  -- earned share 0..1, null = not scored (no evidence)
  v_weight numeric; v_avail numeric; v_earned numeric; v_points numeric; v_expl text[];
  v_rows jsonb := '[]'; v_task_ids uuid[] := '{}';
  -- totals
  t_w numeric := 0; t_wp numeric := 0; n_scored int := 0;
  c_av numeric[] := array[0,0,0,0,0]; c_ea numeric[] := array[0,0,0,0,0];
  m_completed int := 0; m_on_time int := 0; m_late int := 0; m_open_overdue int := 0; m_carried int := 0; m_pending int := 0;
  m_cancelled int := 0; m_reassigned int := 0; m_colleague int := 0; m_returned int := 0; m_excused int := 0;
  m_cross_done int := 0; m_own_done int := 0; m_hours numeric := 0; m_hours_n int := 0;
  v_raw numeric; v_overall numeric; v_cat jsonb;
begin
  select department_id into v_dept from public.user_profiles where id = p_user;
  v_fw := public.perf_framework_for(v_dept); s := v_fw -> 'settings';
  w_c := (v_fw ->> 'completion')::numeric; w_d := (v_fw ->> 'deadline')::numeric; w_q := (v_fw ->> 'quality')::numeric;
  w_o := (v_fw ->> 'ownership')::numeric; w_l := (v_fw ->> 'collaboration')::numeric;

  for r in
    with cand as (
      select a.task_id,
             bool_or(a.is_active) as a_active,
             max(a.individual_status) filter (where a.is_active) as ind_status,
             max(a.completed_at) filter (where a.is_active) as a_completed_at,
             min(a.accepted_at) as a_accepted_at,
             min(a.assigned_at) as a_assigned_at,
             max(a.removed_at) filter (where not a.is_active) as a_removed_at,
             max(a.assignment_role) filter (where a.is_active) as a_role
        from public.staff_task_assignees a where a.user_id = p_user group by a.task_id
      union all
      select t0.id, true, null, null, null, t0.assigned_at, null, 'primary'
        from public.staff_tasks t0
       where t0.assigned_to = p_user and not exists (select 1 from public.staff_task_assignees a2 where a2.task_id = t0.id)
    )
    select t.id, t.task_number, t.title, t.is_active, t.updated_at, t.due_date, t.due_time, t.completed_at, t.completed_by, t.verified_at,
           t.closed_at, t.accepted_at, t.accepted_by, t.started_at, t.assigned_at, t.from_department_id, t.to_department_id, t.is_bridge,
           t.proof_verification_required, t.requires_acceptance, t.factory_job_card_id, t.created_at, t.hold_reason,
           coalesce((select max(l.performed_at) from public.staff_audit_log l where l.entity_type = 'task' and l.entity_id = t.id and l.action = 'DELETE'), t.updated_at) as cancelled_at,
           c.a_active, c.ind_status, c.a_completed_at, c.a_accepted_at, c.a_assigned_at, c.a_removed_at, c.a_role,
           sm.code as status_code, coalesce(pm.code, 'NORMAL') as priority_code
      from cand c
      join public.staff_tasks t on t.id = c.task_id
      join public.status_master sm on sm.id = t.status_id
      left join public.priority_master pm on pm.id = t.priority_id
     where not coalesce(t.is_test_data, false) and t.created_at < v_cut
     order by t.due_date, t.task_number
  loop
    v_due := (r.due_date + coalesce(r.due_time, time '23:59:59')) at time zone 'Asia/Kolkata';
    v_done := r.status_code in ('COMPLETED', 'VERIFIED', 'CLOSED');
    v_user_done := v_done and (r.completed_by = p_user or r.ind_status = 'COMPLETED' or (r.completed_by is null and r.a_role = 'primary'));
    v_done_at := coalesce(r.a_completed_at, r.completed_at);
    v_outcome := null;

    if not r.is_active then
      if r.cancelled_at >= v_start and r.cancelled_at < v_cut then v_outcome := 'CANCELLED'; end if;
    elsif not r.a_active then
      if r.a_removed_at >= v_start and r.a_removed_at < v_cut then v_outcome := 'REASSIGNED_AWAY'; end if;
    elsif v_user_done then
      if v_done_at >= v_start and v_done_at < v_cut then v_outcome := 'COMPLETED'; end if;
    elsif v_done then
      if r.completed_at >= v_start and r.completed_at < v_cut then v_outcome := 'COMPLETED_BY_COLLEAGUE'; end if;
    elsif r.status_code = 'RETURNED' then
      if exists (select 1 from public.staff_audit_log l where l.entity_type = 'task' and l.entity_id = r.id and l.action = 'RETURN'
                    and l.performed_by = p_user and l.performed_at >= v_start and l.performed_at < v_cut) then v_outcome := 'RETURNED'; end if;
    elsif coalesce(r.a_assigned_at, r.assigned_at) < v_cut then
      if v_due >= v_start and v_due < v_cut then v_outcome := 'OVERDUE_OPEN';
      elsif v_due < v_start then v_outcome := 'CARRIED_OVERDUE';
      else v_outcome := 'PENDING'; end if;
    end if;
    continue when v_outcome is null;

    v_cross := r.from_department_id is distinct from r.to_department_id or r.is_bridge;
    -- task comments: Chat (where they live now) plus the older task replies that were never imported into Chat
    select count(*), count(*) filter (where x.created_at < v_due) into v_msgs, v_msgs_before_due from (
      select c.created_at from public.chat_messages c
       where c.sender_id = p_user and not coalesce(c.is_system, false) and c.deleted_at is null and c.created_at < v_cut
         and (c.task_id = r.id or c.conversation_id in (select cc.id from public.chat_conversations cc where cc.task_id = r.id))
      union all
      select m.created_at from public.task_messages m
       where m.task_id = r.id and m.sender_id = p_user and not coalesce(m.is_deleted, false) and m.created_at < v_cut
         and not exists (select 1 from public.chat_messages c2 where c2.legacy_source_id = m.id)) x;
    select count(*) filter (where l.action = 'ATTACH' and l.performed_by = p_user),
           count(*) filter (where l.action = 'REOPEN'),
           count(*) filter (where l.action in ('BLOCKED', 'REQUEST_HELP', 'HOLD') and l.performed_by = p_user and l.performed_at < v_due)
      into v_attach, v_reopen, v_flag_before_due
      from public.staff_audit_log l where l.entity_type = 'task' and l.entity_id = r.id and l.performed_at < v_cut;
    v_qc_n := 0; v_qc_pass := 0;
    if r.factory_job_card_id is not null then
      select count(*), count(*) filter (where q.result = 'PASSED') into v_qc_n, v_qc_pass
        from public.factory_job_card_qc q where q.job_card_id = r.factory_job_card_id and q.created_at < v_cut;
    end if;
    select * into v_excuse from public.perf_delay_excuses x where x.task_id = r.id and x.user_id = p_user and x.is_active;
    if v_outcome = 'OVERDUE_OPEN' and v_excuse.id is not null then v_outcome := 'EXCUSED'; end if;

    e_c := null; e_d := null; e_q := null; e_o := null; e_l := null; v_expl := '{}'; v_late_days := null; v_already := null;
    v_scored := v_outcome in ('COMPLETED', 'OVERDUE_OPEN');

    if v_outcome = 'COMPLETED' then
      v_verified := r.verified_at is not null or r.closed_at is not null or r.status_code in ('VERIFIED', 'CLOSED') or not coalesce(r.proof_verification_required, true);
      if v_verified then e_c := 1; v_expl := array_append(v_expl, ('Completed and verified')::text);
      else e_c := 0.6; v_expl := array_append(v_expl, ('Completed, still waiting for verification (60% of completion points until it is verified)')::text); end if;

      select to_char(pr.period_month, 'Mon YYYY') into v_already
        from public.perf_report_tasks rt join public.perf_monthly_reports pr on pr.id = rt.report_id
       where rt.task_id = r.id and pr.user_id = p_user and pr.status <> 'SUPERSEDED' and pr.period_month < v_m and rt.outcome = 'OVERDUE_OPEN'
       limit 1;
      if v_already is not null then
        v_expl := array_append(v_expl, (('Deadline not scored again: the missed due date was already counted in the ' || v_already || ' report'))::text);
      elsif v_excuse.id is not null and v_done_at > v_due then
        v_expl := array_append(v_expl, (('Late, but the delay was verified as not their fault: ' || v_excuse.note))::text);
      elsif v_done_at <= v_due then
        e_d := 1; v_expl := array_append(v_expl, ('Finished on or before the due date')::text);
      else
        v_late_days := ceil(extract(epoch from (v_done_at - v_due)) / 86400.0);
        e_d := case when v_late_days <= 1 then 0.7 when v_late_days <= 3 then 0.5 when v_late_days <= 7 then 0.25 else 0 end;
        v_expl := array_append(v_expl, (('Finished ' || v_late_days || ' day(s) late'))::text);
        if v_msgs_before_due + v_flag_before_due > 0 then
          e_d := least(1, e_d + 0.2); v_expl := array_append(v_expl, ('Raised the delay before the due date (+20% of deadline points)')::text);
        end if;
      end if;

      if v_reopen > 0 or v_qc_n > 0 or v_verified then
        e_q := case when v_reopen > 0 or v_verified then greatest(0, 1 - 0.4 * v_reopen) end;
        if v_qc_n > 0 then e_q := case when e_q is null then v_qc_pass::numeric / v_qc_n else (e_q + v_qc_pass::numeric / v_qc_n) / 2 end; end if;
        if v_reopen > 0 then v_expl := array_append(v_expl, (('Sent back for rework ' || v_reopen || ' time(s)'))::text);
        elsif v_verified then v_expl := array_append(v_expl, ('Accepted by the checker without rework')::text); end if;
        if v_qc_n > 0 then v_expl := array_append(v_expl, (('Factory QC: ' || v_qc_pass || ' of ' || v_qc_n || ' checks passed'))::text); end if;
      else
        v_expl := array_append(v_expl, ('Quality not scored yet: no check recorded')::text);
      end if;
      m_completed := m_completed + 1;
      if v_done_at <= v_due then m_on_time := m_on_time + 1; else m_late := m_late + 1; end if;
      if v_cross then m_cross_done := m_cross_done + 1; else m_own_done := m_own_done + 1; end if;
      if v_done_at > coalesce(r.a_assigned_at, r.assigned_at) then
        m_hours := m_hours + extract(epoch from (v_done_at - coalesce(r.a_assigned_at, r.assigned_at))) / 3600.0; m_hours_n := m_hours_n + 1;
      end if;
    elsif v_outcome = 'OVERDUE_OPEN' then
      e_c := 0; e_d := 0;
      v_expl := array_append(v_expl, (('Not finished by the due date (' || to_char(v_due at time zone 'Asia/Kolkata', 'DD Mon') || ')'))::text);
      if r.status_code = 'ON_HOLD' then v_expl := array_append(v_expl, (('On hold: ' || coalesce(nullif(r.hold_reason, ''), 'no reason given') || ' -- a Head can mark this delay as not their fault'))::text); end if;
      if v_msgs_before_due + v_flag_before_due > 0 then e_d := 0.2; v_expl := array_append(v_expl, ('Raised the delay before the due date (+20% of deadline points)')::text); end if;
      m_open_overdue := m_open_overdue + 1;
    end if;

    if v_scored then
      v_acc := coalesce(r.a_accepted_at, case when r.accepted_by = p_user then r.accepted_at end);
      e_o := 0;
      if not coalesce(r.requires_acceptance, true) then e_o := e_o + 0.4; v_expl := array_append(v_expl, ('No acceptance step needed')::text);
      elsif v_acc is not null and v_acc <= coalesce(r.a_assigned_at, r.assigned_at) + interval '24 hours' then e_o := e_o + 0.4; v_expl := array_append(v_expl, ('Accepted within a day')::text);
      elsif v_acc is not null and v_acc <= coalesce(r.a_assigned_at, r.assigned_at) + interval '72 hours' then e_o := e_o + 0.2; v_expl := array_append(v_expl, ('Accepted within three days')::text);
      elsif v_acc is not null then v_expl := array_append(v_expl, ('Accepted late')::text);
      else v_expl := array_append(v_expl, ('Not accepted')::text); end if;
      if r.started_at is not null and r.started_at <= v_due then e_o := e_o + 0.3;
      elsif r.started_at is not null then e_o := e_o + 0.15; v_expl := array_append(v_expl, ('Started after the due date')::text); end if;
      if v_msgs + v_attach > 0 then e_o := e_o + 0.3; v_expl := array_append(v_expl, (('Gave ' || (v_msgs + v_attach) || ' update(s) / attachment(s)'))::text);
      else v_expl := array_append(v_expl, ('No progress update or attachment on the task')::text); end if;

      if v_cross then
        e_l := case when v_msgs > 0 then 1 when v_outcome = 'COMPLETED' then 0.5 else 0 end;
        v_expl := array_append(v_expl, (case when v_msgs > 0 then 'Cross-department task with communication on the task'
                                 else 'Cross-department task without any message on the task' end)::text);
      elsif v_msgs > 0 then
        e_l := 1;
      end if;

      v_weight := coalesce((s -> 'priority_factors' ->> r.priority_code)::numeric, 1)
                  * case when v_cross then coalesce((s ->> 'cross_department_factor')::numeric, 1) else 1 end;
      v_avail := case when e_c is not null then w_c else 0 end + case when e_d is not null then w_d else 0 end + case when e_q is not null then w_q else 0 end
               + case when e_o is not null then w_o else 0 end + case when e_l is not null then w_l else 0 end;
      v_earned := coalesce(e_c * w_c, 0) + coalesce(e_d * w_d, 0) + coalesce(e_q * w_q, 0) + coalesce(e_o * w_o, 0) + coalesce(e_l * w_l, 0);
      if v_avail > 0 then
        v_points := round(100 * v_earned / v_avail, 1);
        if v_avail < 100 then v_expl := array_append(v_expl, (('Scored on the ' || v_avail || ' points that had evidence, scaled to 100'))::text); end if;
        t_w := t_w + v_weight; t_wp := t_wp + v_weight * v_points; n_scored := n_scored + 1;
        if e_c is not null then c_av[1] := c_av[1] + v_weight; c_ea[1] := c_ea[1] + v_weight * e_c; end if;
        if e_d is not null then c_av[2] := c_av[2] + v_weight; c_ea[2] := c_ea[2] + v_weight * e_d; end if;
        if e_q is not null then c_av[3] := c_av[3] + v_weight; c_ea[3] := c_ea[3] + v_weight * e_q; end if;
        if e_o is not null then c_av[4] := c_av[4] + v_weight; c_ea[4] := c_ea[4] + v_weight * e_o; end if;
        if e_l is not null then c_av[5] := c_av[5] + v_weight; c_ea[5] := c_ea[5] + v_weight * e_l; end if;
      else
        v_scored := false; v_points := null;
      end if;
    else
      v_weight := null; v_points := null; v_avail := null;
      v_expl := array_append(v_expl, (case v_outcome
        when 'CANCELLED' then 'Cancelled -- not counted as done or failed'
        when 'REASSIGNED_AWAY' then 'Moved to someone else -- counted for the person who holds it'
        when 'COMPLETED_BY_COLLEAGUE' then 'Completed by a colleague on the same task -- counted for them'
        when 'RETURNED' then 'Returned (declined) by this person -- not scored'
        when 'EXCUSED' then 'Overdue, but the delay was verified as not their fault: ' || coalesce(v_excuse.note, '')
        when 'CARRIED_OVERDUE' then 'Still open from an earlier month -- its missed due date was counted in that month'
        when 'PENDING' then 'Open, not due yet -- not scored'
        else v_outcome end)::text);
      case v_outcome
        when 'CANCELLED' then m_cancelled := m_cancelled + 1;
        when 'REASSIGNED_AWAY' then m_reassigned := m_reassigned + 1;
        when 'COMPLETED_BY_COLLEAGUE' then m_colleague := m_colleague + 1;
        when 'RETURNED' then m_returned := m_returned + 1;
        when 'EXCUSED' then m_excused := m_excused + 1;
        when 'CARRIED_OVERDUE' then m_carried := m_carried + 1;
        when 'PENDING' then m_pending := m_pending + 1;
        else null;
      end case;
    end if;

    v_task_ids := v_task_ids || r.id;
    v_rows := v_rows || jsonb_build_object(
      'task_id', r.id, 'task_number', r.task_number, 'title', r.title, 'outcome', v_outcome, 'scored', v_scored,
      'weight', round(v_weight, 2), 'points', v_points,
      'available', jsonb_strip_nulls(jsonb_build_object('completion', case when v_scored and e_c is not null then w_c end, 'deadline', case when v_scored and e_d is not null then w_d end,
                     'quality', case when v_scored and e_q is not null then w_q end, 'ownership', case when v_scored and e_o is not null then w_o end,
                     'collaboration', case when v_scored and e_l is not null then w_l end)),
      'earned', jsonb_strip_nulls(jsonb_build_object('completion', case when v_scored then round(e_c * w_c, 1) end, 'deadline', case when v_scored then round(e_d * w_d, 1) end,
                     'quality', case when v_scored then round(e_q * w_q, 1) end, 'ownership', case when v_scored then round(e_o * w_o, 1) end,
                     'collaboration', case when v_scored then round(e_l * w_l, 1) end)),
      'explanation', to_jsonb(v_expl),
      'facts', jsonb_build_object('status', r.status_code, 'priority', r.priority_code, 'due_at', v_due, 'completed_at', case when v_user_done then v_done_at end,
                     'days_late', v_late_days, 'cross_department', v_cross, 'department_id', r.to_department_id, 'from_department_id', r.from_department_id,
                     'reopened', v_reopen, 'messages', v_msgs, 'attachments', v_attach, 'qc_checks', v_qc_n, 'qc_passed', v_qc_pass,
                     'excuse', case when v_excuse.id is not null then jsonb_build_object('reason', v_excuse.reason_code, 'note', v_excuse.note) end,
                     'role', coalesce(r.a_role, 'primary')));
  end loop;

  v_raw := case when t_w > 0 then round(t_wp / t_w, 1) end;
  v_overall := case when n_scored >= coalesce((s ->> 'min_tasks')::int, 3) and v_raw is not null
                    then round((n_scored * v_raw + coalesce((s ->> 'prior_weight')::numeric, 2) * coalesce((s ->> 'prior_score')::numeric, 70))
                               / (n_scored + coalesce((s ->> 'prior_weight')::numeric, 2)), 1) end;
  v_cat := jsonb_build_object(
    'completion', case when c_av[1] > 0 then round(100 * c_ea[1] / c_av[1], 1) end,
    'deadline', case when c_av[2] > 0 then round(100 * c_ea[2] / c_av[2], 1) end,
    'quality', case when c_av[3] > 0 then round(100 * c_ea[3] / c_av[3], 1) end,
    'ownership', case when c_av[4] > 0 then round(100 * c_ea[4] / c_av[4], 1) end,
    'collaboration', case when c_av[5] > 0 then round(100 * c_ea[5] / c_av[5], 1) end);

  return jsonb_build_object(
    'user_id', p_user, 'department_id', v_dept, 'period_month', v_m, 'as_of', v_cut, 'calculation_version', 'perf-v1',
    'framework', v_fw - 'settings', 'settings', s,
    'overall_score', v_overall, 'raw_score', v_raw, 'scored_tasks', n_scored,
    'confidence', case when v_overall is null then 'INSUFFICIENT' when n_scored < 6 then 'LOW' else 'OK' end,
    'category_scores', v_cat,
    'metrics', jsonb_build_object(
      'tasks_assigned', (select count(distinct a.task_id) from public.staff_task_assignees a join public.staff_tasks t on t.id = a.task_id
                          where a.user_id = p_user and a.assigned_at >= v_start and a.assigned_at < v_cut and not coalesce(t.is_test_data, false)),
      'completed', m_completed, 'completed_on_time', m_on_time, 'completed_late', m_late,
      'on_time_rate', case when m_completed > 0 then round(100.0 * m_on_time / m_completed, 1) end,
      'overdue_in_month', m_open_overdue, 'overdue_carried', m_carried, 'overdue', m_open_overdue + m_carried + m_excused,
      'pending', m_open_overdue + m_carried + m_excused + m_pending, 'pending_not_due', m_pending,
      'excused_delays', m_excused, 'cancelled', m_cancelled, 'reassigned_away', m_reassigned, 'completed_by_colleague', m_colleague,
      'returned', m_returned,
      'reopened', (select count(*) from public.staff_audit_log l where l.entity_type = 'task' and l.action = 'REOPEN' and l.performed_at >= v_start and l.performed_at < v_cut
                    and l.entity_id = any(v_task_ids)),
      'avg_completion_hours', case when m_hours_n > 0 then round(m_hours / m_hours_n, 1) end,
      'department_contribution', m_own_done, 'cross_department_contribution', m_cross_done,
      'tasks_created', (select count(*) from public.staff_tasks t where t.assigned_by = p_user and t.created_at >= v_start and t.created_at < v_cut and not coalesce(t.is_test_data, false)),
      'verified_for_others', (select count(*) from public.staff_audit_log l where l.entity_type = 'task' and l.action = 'VERIFY' and l.performed_by = p_user
                               and l.performed_at >= v_start and l.performed_at < v_cut),
      'messages', (select count(*) from public.chat_messages c where c.sender_id = p_user and not coalesce(c.is_system, false) and c.deleted_at is null
                    and c.created_at >= v_start and c.created_at < v_cut)
                + (select count(*) from public.task_messages m where m.sender_id = p_user and not coalesce(m.is_deleted, false) and m.created_at >= v_start and m.created_at < v_cut
                    and not exists (select 1 from public.chat_messages c2 where c2.legacy_source_id = m.id))),
    'task_ids', to_jsonb(v_task_ids),
    'tasks', v_rows);
end $$;

-- ---------------------------------------------------------------- live views
create or replace function public.perf_live(p_user uuid default null, p_month date default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_user uuid := coalesce(p_user, auth.uid()); v_month date := public.perf_month(coalesce(p_month, public.perf_current_month())); v jsonb; v_prev jsonb;
begin
  if not public.perf_can_view_user(v_user) then raise exception 'You can only see your own performance, or your team''s if you are their Head'; end if;
  v := public.perf_eval(v_user, v_month, now());
  select jsonb_build_object('period_month', r.period_month, 'overall_score', r.overall_score, 'category_scores', r.category_scores, 'source', 'report')
    into v_prev from public.perf_monthly_reports r
   where r.user_id = v_user and r.period_month = (v_month - interval '1 month')::date and r.status <> 'SUPERSEDED';
  if v_prev is null then
    select jsonb_build_object('period_month', (v_month - interval '1 month')::date, 'overall_score', e -> 'overall_score', 'category_scores', e -> 'category_scores', 'source', 'live')
      into v_prev from (select public.perf_eval(v_user, (v_month - interval '1 month')::date, now()) e) x;
  end if;
  return v || jsonb_build_object('previous', v_prev,
    'person', (select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'employee_code', u.employee_code, 'department_id', u.department_id,
                 'role', r.name_en, 'reports_to', (select m.full_name from public.user_profiles m where m.id = u.reports_to))
                 from public.user_profiles u left join public.roles r on r.id = u.role_id where u.id = v_user),
    'can_review', public.perf_can_review_user(v_user),
    'reports', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'period_month', x.period_month, 'version', x.version, 'status', x.status,
                   'overall_score', x.overall_score, 'ai_status', x.ai_status) order by x.period_month desc, x.version desc), '[]')
                  from public.perf_monthly_reports x where x.user_id = v_user and public.perf_can_read_report(x)));
end $$;

-- Small summary for the dashboard strip on every department page.
create or replace function public.perf_my_summary()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v jsonb; v_month date := public.perf_current_month();
begin
  if not public.staff_current_user_ok() then return null; end if;
  v := public.perf_eval(auth.uid(), v_month, now());
  return jsonb_build_object('period_month', v_month, 'overall_score', v -> 'overall_score', 'confidence', v -> 'confidence', 'scored_tasks', v -> 'scored_tasks',
    'completed', v -> 'metrics' -> 'completed', 'pending', v -> 'metrics' -> 'pending', 'overdue', v -> 'metrics' -> 'overdue',
    'is_management', public.perf_is_management(),
    'can_see_team', public.perf_is_management() or public.staff_is_dept_head() or exists (select 1 from public.perf_viewers pv where pv.user_id = auth.uid() and pv.is_active),
    'reviews_waiting', (select count(*) from public.perf_monthly_reports r where r.status = 'DRAFT' and public.perf_can_review_user(r.user_id)),
    'my_new_report', (select r.id from public.perf_monthly_reports r where r.user_id = auth.uid() and r.status = 'SHARED' order by r.period_month desc limit 1));
end $$;

-- Everyone the caller may see, with live scores for a month (and the saved report if there is one).
create or replace function public.perf_team(p_month date default null, p_department uuid default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_month date := public.perf_month(coalesce(p_month, public.perf_current_month())); v_out jsonb := '[]'; u record; e jsonb; rep record;
begin
  if not public.staff_current_user_ok() then raise exception 'Not signed in'; end if;
  for u in
    select up.id, up.full_name, up.employee_code, up.department_id, d.name_en as department, r.name_en as role
      from public.user_profiles up left join public.departments d on d.id = up.department_id left join public.roles r on r.id = up.role_id
     where up.is_active and not coalesce(up.is_deleted, false) and coalesce(r.code, '') <> 'sysadmin'
       and (p_department is null or up.department_id = p_department)
       and up.id <> auth.uid() and public.perf_can_view_user(up.id)
     order by d.name_en, up.full_name
  loop
    select * into rep from public.perf_monthly_reports x where x.user_id = u.id and x.period_month = v_month and x.status <> 'SUPERSEDED';
    if rep.id is not null then
      v_out := v_out || jsonb_build_object('user_id', u.id, 'full_name', u.full_name, 'employee_code', u.employee_code, 'department_id', u.department_id,
        'department', u.department, 'role', u.role, 'source', 'report', 'report_id', rep.id, 'status', rep.status, 'ai_status', rep.ai_status,
        'overall_score', rep.overall_score, 'scored_tasks', rep.scored_tasks, 'category_scores', rep.category_scores, 'metrics', rep.metrics, 'comparison', rep.comparison);
    else
      e := public.perf_eval(u.id, v_month, now());
      v_out := v_out || jsonb_build_object('user_id', u.id, 'full_name', u.full_name, 'employee_code', u.employee_code, 'department_id', u.department_id,
        'department', u.department, 'role', u.role, 'source', 'live', 'overall_score', e -> 'overall_score', 'scored_tasks', e -> 'scored_tasks',
        'category_scores', e -> 'category_scores', 'metrics', e -> 'metrics');
    end if;
  end loop;
  return jsonb_build_object('period_month', v_month, 'people', v_out);
end $$;

-- ---------------------------------------------------------------- monthly generation
create or replace function public.perf_goal_value(p_goal text, p_eval jsonb) returns numeric language sql immutable as $$
  select case p_goal
    when 'REDUCE_OVERDUE' then (p_eval -> 'metrics' ->> 'overdue')::numeric
    when 'IMPROVE_ON_TIME' then (p_eval -> 'metrics' ->> 'on_time_rate')::numeric
    when 'IMPROVE_QUALITY' then (p_eval -> 'category_scores' ->> 'quality')::numeric
    when 'REDUCE_REWORK' then (p_eval -> 'metrics' ->> 'reopened')::numeric
    when 'IMPROVE_UPDATES' then (p_eval -> 'category_scores' ->> 'ownership')::numeric
    when 'IMPROVE_COLLABORATION' then (p_eval -> 'category_scores' ->> 'collaboration')::numeric
  end $$;

create or replace function public.perf_generate_month_internal(p_month date, p_reason text default null, p_only_user uuid default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_month date := public.perf_month(p_month); v_prev_month date := (public.perf_month(p_month) - interval '1 month')::date;
  u record; v_old record; v_prev record; e jsonb; v_id uuid; v_version int; v_cmp jsonb; g record; v_val numeric; v_goal_out jsonb;
  v_created int := 0; v_skipped int := 0; v_heads uuid[]; v_dept_counts jsonb := '{}'; v_mgmt_count int := 0; k text;
begin
  if v_month >= public.perf_current_month() then raise exception 'A month can only be saved after it has ended'; end if;
  for u in
    select up.id, up.full_name, up.department_id, r.code as role_code
      from public.user_profiles up left join public.roles r on r.id = up.role_id
     where up.is_active and not coalesce(up.is_deleted, false) and coalesce(r.code, '') <> 'sysadmin'
       and (p_only_user is null or up.id = p_only_user)
       and up.created_at < ((v_month + interval '1 month')::timestamp) at time zone 'Asia/Kolkata'
  loop
    select * into v_old from public.perf_monthly_reports x where x.user_id = u.id and x.period_month = v_month and x.status <> 'SUPERSEDED';
    if v_old.id is not null and p_reason is null then v_skipped := v_skipped + 1; continue; end if;
    v_version := coalesce((select max(version) from public.perf_monthly_reports x where x.user_id = u.id and x.period_month = v_month), 0) + 1;
    if v_old.id is not null then
      update public.perf_monthly_reports set status = 'SUPERSEDED', superseded_at = now() where id = v_old.id;
    end if;

    e := public.perf_eval(u.id, v_month, now());

    select * into v_prev from public.perf_monthly_reports x where x.user_id = u.id and x.period_month = v_prev_month and x.status <> 'SUPERSEDED';
    v_cmp := null;
    if v_prev.id is not null then
      v_cmp := jsonb_build_object('previous_report_id', v_prev.id, 'previous_month', v_prev_month,
        'previous_score', v_prev.overall_score, 'current_score', e -> 'overall_score',
        'score_change', case when v_prev.overall_score is not null and (e ->> 'overall_score') is not null then round((e ->> 'overall_score')::numeric - v_prev.overall_score, 1) end,
        'category_change', (select jsonb_object_agg(c, case when (v_prev.category_scores ->> c) is not null and (e -> 'category_scores' ->> c) is not null
                              then round((e -> 'category_scores' ->> c)::numeric - (v_prev.category_scores ->> c)::numeric, 1) end)
                             from unnest(array['completion', 'deadline', 'quality', 'ownership', 'collaboration']) c),
        'overdue_change', ((e -> 'metrics' ->> 'overdue')::int - coalesce((v_prev.metrics ->> 'overdue')::int, 0)),
        'reopened_change', ((e -> 'metrics' ->> 'reopened')::int - coalesce((v_prev.metrics ->> 'reopened')::int, 0)),
        'completed_change', ((e -> 'metrics' ->> 'completed')::int - coalesce((v_prev.metrics ->> 'completed')::int, 0)),
        'comparable', v_prev.overall_score is not null and (e ->> 'overall_score') is not null);
    end if;

    -- goals set last month for this month
    v_goal_out := '[]';
    for g in select * from public.perf_goals x where x.user_id = u.id and x.target_month = v_month order by x.created_at loop
      v_val := public.perf_goal_value(g.goal_type, e);
      v_goal_out := v_goal_out || jsonb_build_object('goal_id', g.id, 'goal_type', g.goal_type, 'description', g.description, 'target_value', g.target_value,
        'achieved_value', v_val,
        'status', case when g.goal_type = 'CUSTOM' then 'NOT_MEASURABLE' when v_val is null or g.target_value is null then 'NO_DATA'
                       when g.goal_type in ('REDUCE_OVERDUE', 'REDUCE_REWORK') then case when v_val <= g.target_value then 'ACHIEVED' else 'NOT_ACHIEVED' end
                       else case when v_val >= g.target_value then 'ACHIEVED' else 'NOT_ACHIEVED' end end);
    end loop;

    insert into public.perf_monthly_reports (user_id, department_id, period_month, version, overall_score, raw_score, scored_tasks, category_scores, metrics,
        comparison, task_ids, framework, calculation_version, generated_by, recalc_reason, supersedes_id, ai_status, ai_review)
    values (u.id, u.department_id, v_month, v_version, (e ->> 'overall_score')::numeric, (e ->> 'raw_score')::numeric, (e ->> 'scored_tasks')::int,
        e -> 'category_scores', (e -> 'metrics') || jsonb_build_object('confidence', e -> 'confidence', 'goals', v_goal_out),
        v_cmp, array(select (jsonb_array_elements_text(e -> 'task_ids'))::uuid), (e -> 'framework') || jsonb_build_object('settings', e -> 'settings'),
        e ->> 'calculation_version', auth.uid(), p_reason, v_old.id,
        case when jsonb_array_length(e -> 'tasks') = 0 then 'NOT_NEEDED' else 'PENDING' end,
        case when jsonb_array_length(e -> 'tasks') = 0 then jsonb_build_object('overall_summary', 'There is insufficient data to evaluate this month: no tasks were assigned, completed or due.', 'insufficient', true) end)
    returning id into v_id;

    insert into public.perf_report_tasks (report_id, task_id, task_number, title, outcome, scored, weight, points, available, earned, explanation, facts)
    select v_id, (x ->> 'task_id')::uuid, x ->> 'task_number', x ->> 'title', x ->> 'outcome', (x ->> 'scored')::boolean, (x ->> 'weight')::numeric,
           (x ->> 'points')::numeric, x -> 'available', x -> 'earned', array(select jsonb_array_elements_text(x -> 'explanation')), x -> 'facts'
      from jsonb_array_elements(e -> 'tasks') x;

    for g in select value as gv from jsonb_array_elements(v_goal_out) loop
      update public.perf_goals set status = g.gv ->> 'status', achieved_value = (g.gv ->> 'achieved_value')::numeric, evaluated_at = now(), evaluated_report_id = v_id
       where id = (g.gv ->> 'goal_id')::uuid;
    end loop;

    perform public.perf_log(v_id, null, u.id, case when v_old.id is null then 'GENERATED' else 'RECALCULATED' end,
      jsonb_build_object('month', v_month, 'version', v_version, 'score', e -> 'overall_score', 'reason', p_reason, 'replaces', v_old.id));
    v_created := v_created + 1;
    if u.role_code = 'dept_head' or coalesce(array_length(public.proc_department_heads(u.department_id), 1), 0) = 0 then
      v_mgmt_count := v_mgmt_count + 1;
    else
      v_dept_counts := jsonb_set(v_dept_counts, array[u.department_id::text], to_jsonb(coalesce((v_dept_counts ->> u.department_id::text)::int, 0) + 1));
    end if;
  end loop;

  for k in select jsonb_object_keys(v_dept_counts) loop
    perform public.perf_notify(public.proc_department_heads(k::uuid), 'PERF_TEAM', k::uuid,
      (v_dept_counts ->> k) || ' monthly AI review(s) for ' || to_char(v_month, 'Mon YYYY') || ' are waiting for your review',
      to_char(v_month, 'Mon YYYY') || ' ની ' || (v_dept_counts ->> k) || ' માસિક AI સમીક્ષા તમારી સમીક્ષા માટે બાકી છે');
  end loop;
  if v_created > 0 then
    perform public.perf_notify(public.perf_management_users(), 'PERF_CONTROL', gen_random_uuid(),
      'Monthly AI performance for ' || to_char(v_month, 'Mon YYYY') || ' is saved (' || v_created || ' people' ||
        case when v_mgmt_count > 0 then ', ' || v_mgmt_count || ' need a Management review' else '' end || ')',
      to_char(v_month, 'Mon YYYY') || ' નું માસિક AI પ્રદર્શન સાચવ્યું (' || v_created || ' વ્યક્તિ)');
  end if;
  return jsonb_build_object('month', v_month, 'created', v_created, 'skipped', v_skipped);
end $$;

create or replace function public.perf_generate_month(p_month date)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.perf_is_management() then raise exception 'Only Management can save a month'; end if;
  return public.perf_generate_month_internal(p_month, null, null);
end $$;

create or replace function public.perf_recalculate(p_user uuid, p_month date, p_reason text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.perf_is_management() then raise exception 'Only Management can recalculate a saved month'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'Please give the reason for the recalculation'; end if;
  if not exists (select 1 from public.perf_monthly_reports where user_id = p_user and period_month = public.perf_month(p_month) and status <> 'SUPERSEDED') then
    raise exception 'There is no saved report for this person and month yet';
  end if;
  return public.perf_generate_month_internal(p_month, btrim(p_reason), p_user);
end $$;

-- ---------------------------------------------------------------- AI review (written by the perf-ai-review edge function)
-- The frozen facts the AI is allowed to use. Only for Management or the person's Head.
create or replace function public.perf_ai_input(p_report uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare r public.perf_monthly_reports; v_prev public.perf_monthly_reports;
begin
  select * into r from public.perf_monthly_reports where id = p_report;
  if r.id is null then raise exception 'Report not found'; end if;
  if not (public.perf_is_management() or public.perf_is_head_of(r.user_id)) then raise exception 'Only Management or the Head can write this AI review'; end if;
  select * into v_prev from public.perf_monthly_reports x where x.user_id = r.user_id and x.period_month = (r.period_month - interval '1 month')::date and x.status <> 'SUPERSEDED';
  return jsonb_build_object(
    'report_id', r.id, 'status', r.status, 'ai_status', r.ai_status, 'month', to_char(r.period_month, 'FMMonth YYYY'),
    'employee', (select jsonb_build_object('name', u.full_name, 'employee_code', u.employee_code, 'designation', ro.name_en, 'department', d.name_en)
                   from public.user_profiles u left join public.roles ro on ro.id = u.role_id left join public.departments d on d.id = r.department_id where u.id = r.user_id),
    'framework', r.framework - 'settings', 'overall_score', r.overall_score, 'raw_score', r.raw_score, 'scored_tasks', r.scored_tasks,
    'category_scores', r.category_scores, 'metrics', r.metrics, 'comparison', r.comparison,
    'previous_month', case when v_prev.id is not null then jsonb_build_object('overall_score', v_prev.overall_score, 'category_scores', v_prev.category_scores) end,
    'tasks', (select coalesce(jsonb_agg(jsonb_build_object('task_number', t.task_number, 'title', left(t.title, 160), 'outcome', t.outcome, 'scored', t.scored,
                 'points', t.points, 'earned', t.earned, 'available', t.available, 'explanation', to_jsonb(t.explanation),
                 'priority', t.facts ->> 'priority', 'days_late', t.facts -> 'days_late', 'cross_department', t.facts -> 'cross_department',
                 'reopened', t.facts -> 'reopened') order by t.points desc nulls last), '[]') from public.perf_report_tasks t where t.report_id = r.id));
end $$;

create or replace function public.perf_save_ai_review(p_report uuid, p_review jsonb, p_model text, p_error text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.perf_monthly_reports;
begin
  select * into r from public.perf_monthly_reports where id = p_report for update;
  if r.id is null then raise exception 'Report not found'; end if;
  if not (public.perf_is_management() or public.perf_is_head_of(r.user_id)) then raise exception 'Only Management or the Head can write this AI review'; end if;
  if r.status = 'SUPERSEDED' then raise exception 'This report version has been replaced'; end if;
  if r.ai_status = 'DONE' then raise exception 'The AI review for this report is already written'; end if;
  if p_error is not null then
    update public.perf_monthly_reports set ai_status = 'FAILED', ai_error = left(p_error, 300) where id = p_report;
    perform public.perf_log(p_report, null, r.user_id, 'AI_FAILED', jsonb_build_object('error', left(p_error, 300)));
    return;
  end if;
  if p_review is null or jsonb_typeof(p_review) <> 'object' or nullif(p_review ->> 'overall_summary', '') is null then raise exception 'The AI review is empty'; end if;
  update public.perf_monthly_reports set ai_status = 'DONE', ai_review = p_review, ai_model = left(p_model, 80), ai_generated_at = now(), ai_error = null where id = p_report;
  perform public.perf_log(p_report, null, r.user_id, 'AI_REVIEW_WRITTEN', jsonb_build_object('model', p_model));
end $$;

-- ---------------------------------------------------------------- review workflow
create or replace function public.perf_head_review(p_report uuid, p_feedback text, p_goals jsonb default '[]')
returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.perf_monthly_reports; g jsonb; v_n int := 0;
begin
  select * into r from public.perf_monthly_reports where id = p_report for update;
  if r.id is null then raise exception 'Report not found'; end if;
  if not public.perf_can_review_user(r.user_id) then raise exception 'Only the person''s Head or Management can review this report'; end if;
  if r.status <> 'DRAFT' then raise exception 'This report has already been reviewed'; end if;
  if nullif(btrim(coalesce(p_feedback, '')), '') is null then raise exception 'Please write your feedback'; end if;
  for g in select value from jsonb_array_elements(coalesce(p_goals, '[]')) loop
    if nullif(btrim(coalesce(g ->> 'description', '')), '') is null then raise exception 'Each goal needs a description'; end if;
    insert into public.perf_goals (report_id, user_id, target_month, goal_type, target_value, description, created_by)
    values (r.id, r.user_id, (r.period_month + interval '1 month')::date, coalesce(nullif(g ->> 'goal_type', ''), 'CUSTOM'),
            nullif(g ->> 'target_value', '')::numeric, btrim(g ->> 'description'), auth.uid());
    v_n := v_n + 1;
  end loop;
  update public.perf_monthly_reports set status = 'SHARED', head_feedback = btrim(p_feedback), head_reviewed_by = auth.uid(), head_reviewed_at = now() where id = p_report;
  perform public.perf_log(p_report, null, r.user_id, 'HEAD_REVIEWED', jsonb_build_object('goals', v_n));
  perform public.perf_notify(array[r.user_id], 'PERF_REVIEW', r.id,
    'Your ' || to_char(r.period_month, 'Mon YYYY') || ' performance review is ready' || case when v_n > 0 then ' (' || v_n || ' goal(s) for next month)' else '' end,
    'તમારી ' || to_char(r.period_month, 'Mon YYYY') || ' ની કામગીરી સમીક્ષા તૈયાર છે');
end $$;

create or replace function public.perf_employee_respond(p_report uuid, p_response text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.perf_monthly_reports;
begin
  select * into r from public.perf_monthly_reports where id = p_report for update;
  if r.id is null or r.user_id <> auth.uid() then raise exception 'You can only respond to your own review'; end if;
  if r.status <> 'SHARED' then raise exception 'This review is not open for a response'; end if;
  if nullif(btrim(coalesce(p_response, '')), '') is null then raise exception 'Please write your response'; end if;
  update public.perf_monthly_reports set status = 'RESPONDED', employee_response = btrim(p_response), employee_responded_at = now() where id = p_report;
  perform public.perf_log(p_report, null, r.user_id, 'EMPLOYEE_RESPONDED', null);
  perform public.perf_notify(array_append(array(select x from unnest(public.proc_department_heads(r.department_id)) x), r.head_reviewed_by), 'PERF_REVIEW', r.id,
    (select full_name from public.user_profiles where id = r.user_id) || ' responded to their ' || to_char(r.period_month, 'Mon YYYY') || ' review',
    (select full_name from public.user_profiles where id = r.user_id) || ' એ ' || to_char(r.period_month, 'Mon YYYY') || ' ની સમીક્ષાનો જવાબ આપ્યો');
end $$;

create or replace function public.perf_finalize_report(p_report uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.perf_monthly_reports;
begin
  if not public.perf_is_management() then raise exception 'Only Management can finalise a review'; end if;
  select * into r from public.perf_monthly_reports where id = p_report for update;
  if r.id is null then raise exception 'Report not found'; end if;
  if r.status not in ('SHARED', 'RESPONDED') then raise exception 'A review can be finalised after the Head has reviewed it'; end if;
  update public.perf_monthly_reports set status = 'FINAL', finalized_by = auth.uid(), finalized_at = now() where id = p_report;
  perform public.perf_log(p_report, null, r.user_id, 'FINALIZED', null);
  perform public.perf_notify(array[r.user_id], 'PERF_REVIEW', r.id, 'Your ' || to_char(r.period_month, 'Mon YYYY') || ' performance review is final',
    'તમારી ' || to_char(r.period_month, 'Mon YYYY') || ' ની સમીક્ષા અંતિમ થઈ');
end $$;

create or replace function public.perf_report_detail(p_report uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare r public.perf_monthly_reports;
begin
  select * into r from public.perf_monthly_reports where id = p_report;
  if r.id is null or not public.perf_can_read_report(r) then raise exception 'Report not found or not shared with you yet'; end if;
  return to_jsonb(r) || jsonb_build_object(
    'person', (select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'employee_code', u.employee_code, 'designation', ro.name_en, 'department', d.name_en,
                 'reports_to', (select m.full_name from public.user_profiles m where m.id = u.reports_to))
                 from public.user_profiles u left join public.roles ro on ro.id = u.role_id left join public.departments d on d.id = r.department_id where u.id = r.user_id),
    'head_reviewer', (select full_name from public.user_profiles where id = r.head_reviewed_by),
    'finalized_by_name', (select full_name from public.user_profiles where id = r.finalized_by),
    'tasks', (select coalesce(jsonb_agg(to_jsonb(t) - 'report_id' order by t.scored desc, t.points desc nulls last, t.task_number), '[]') from public.perf_report_tasks t where t.report_id = r.id),
    'goals_set', (select coalesce(jsonb_agg(to_jsonb(g) order by g.created_at), '[]') from public.perf_goals g where g.report_id = r.id),
    'versions', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'version', x.version, 'status', x.status, 'overall_score', x.overall_score,
                   'generated_at', x.generated_at, 'recalc_reason', x.recalc_reason) order by x.version), '[]')
                   from public.perf_monthly_reports x where x.user_id = r.user_id and x.period_month = r.period_month and public.perf_can_read_report(x)),
    'can_review', public.perf_can_review_user(r.user_id) and r.status = 'DRAFT',
    'can_respond', r.user_id = auth.uid() and r.status = 'SHARED',
    'can_finalize', public.perf_is_management() and r.status in ('SHARED', 'RESPONDED'),
    'can_write_ai', (public.perf_is_management() or public.perf_is_head_of(r.user_id)) and r.ai_status in ('PENDING', 'FAILED') and r.status <> 'SUPERSEDED',
    'can_recalculate', public.perf_is_management() and r.status <> 'SUPERSEDED',
    'history', case when public.perf_is_management() then (select coalesce(jsonb_agg(jsonb_build_object('action', a.action, 'at', a.performed_at,
                   'by', (select full_name from public.user_profiles where id = a.performed_by), 'detail', a.detail) order by a.performed_at), '[]')
                   from public.perf_audit a where a.report_id in (select x.id from public.perf_monthly_reports x where x.user_id = r.user_id and x.period_month = r.period_month)) end);
end $$;

-- ---------------------------------------------------------------- verified delays
create or replace function public.perf_excuse_delay(p_task uuid, p_user uuid, p_reason_code text, p_note text)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.perf_can_review_user(p_user) then raise exception 'Only the person''s Head or Management can verify a delay'; end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'Please write what caused the delay'; end if;
  if not exists (select 1 from public.staff_task_assignees a where a.task_id = p_task and a.user_id = p_user)
     and not exists (select 1 from public.staff_tasks t where t.id = p_task and t.assigned_to = p_user) then
    raise exception 'This person is not on that task';
  end if;
  update public.perf_delay_excuses set is_active = false, revoked_by = auth.uid(), revoked_at = now() where task_id = p_task and user_id = p_user and is_active;
  insert into public.perf_delay_excuses (task_id, user_id, reason_code, note, verified_by) values (p_task, p_user, p_reason_code, btrim(p_note), auth.uid());
  perform public.perf_log(null, null, p_user, 'DELAY_VERIFIED', jsonb_build_object('task_id', p_task, 'reason', p_reason_code, 'note', btrim(p_note)));
end $$;

create or replace function public.perf_revoke_excuse(p_task uuid, p_user uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.perf_can_review_user(p_user) then raise exception 'Only the person''s Head or Management can change this'; end if;
  update public.perf_delay_excuses set is_active = false, revoked_by = auth.uid(), revoked_at = now() where task_id = p_task and user_id = p_user and is_active;
  perform public.perf_log(null, null, p_user, 'DELAY_EXCUSE_REMOVED', jsonb_build_object('task_id', p_task));
end $$;

-- ---------------------------------------------------------------- configuration by Management
create or replace function public.perf_save_framework(p_department uuid, p_completion numeric, p_deadline numeric, p_quality numeric, p_ownership numeric,
  p_collaboration numeric, p_focus text[])
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.perf_is_management() then raise exception 'Only Management can change the scoring'; end if;
  if p_completion + p_deadline + p_quality + p_ownership + p_collaboration <> 100 then raise exception 'The five weights must add up to 100'; end if;
  if p_department is null then
    update public.perf_frameworks set w_completion = p_completion, w_deadline = p_deadline, w_quality = p_quality, w_ownership = p_ownership,
      w_collaboration = p_collaboration, focus_areas = coalesce(p_focus, '{}'), updated_by = auth.uid(), updated_at = now() where department_id is null;
  else
    insert into public.perf_frameworks (department_id, w_completion, w_deadline, w_quality, w_ownership, w_collaboration, focus_areas, updated_by)
    values (p_department, p_completion, p_deadline, p_quality, p_ownership, p_collaboration, coalesce(p_focus, '{}'), auth.uid())
    on conflict (department_id) do update set w_completion = excluded.w_completion, w_deadline = excluded.w_deadline, w_quality = excluded.w_quality,
      w_ownership = excluded.w_ownership, w_collaboration = excluded.w_collaboration, focus_areas = excluded.focus_areas, updated_by = auth.uid(), updated_at = now();
  end if;
  perform public.perf_log(null, null, null, 'FRAMEWORK_CHANGED', jsonb_build_object('department_id', p_department, 'weights',
    jsonb_build_array(p_completion, p_deadline, p_quality, p_ownership, p_collaboration), 'focus', to_jsonb(p_focus)));
end $$;

create or replace function public.perf_save_settings(p_min_tasks int, p_prior_score numeric, p_prior_weight numeric, p_priority_factors jsonb, p_cross_factor numeric)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.perf_is_management() then raise exception 'Only Management can change the scoring'; end if;
  update public.perf_settings set min_tasks = p_min_tasks, prior_score = p_prior_score, prior_weight = p_prior_weight,
    priority_factors = coalesce(p_priority_factors, priority_factors), cross_department_factor = p_cross_factor, updated_by = auth.uid(), updated_at = now() where id = 1;
  perform public.perf_log(null, null, null, 'SETTINGS_CHANGED', jsonb_build_object('min_tasks', p_min_tasks, 'prior_score', p_prior_score, 'prior_weight', p_prior_weight,
    'priority_factors', p_priority_factors, 'cross_department_factor', p_cross_factor));
end $$;

create or replace function public.perf_set_viewer(p_user uuid, p_department uuid, p_active boolean)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.perf_is_management() then raise exception 'Only Management can give access to performance reports'; end if;
  update public.perf_viewers set is_active = false, revoked_by = auth.uid(), revoked_at = now()
   where user_id = p_user and department_id is not distinct from p_department and is_active;
  if p_active then insert into public.perf_viewers (user_id, department_id, granted_by) values (p_user, p_department, auth.uid()); end if;
  perform public.perf_log(null, null, p_user, case when p_active then 'ACCESS_GRANTED' else 'ACCESS_REMOVED' end, jsonb_build_object('department_id', p_department));
end $$;

-- ---------------------------------------------------------------- company report
create or replace function public.perf_company_metrics(p_month date)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_month date := public.perf_month(p_month);
  v_start timestamptz := (v_month::timestamp) at time zone 'Asia/Kolkata';
  v_end timestamptz := ((v_month + interval '1 month')::timestamp) at time zone 'Asia/Kolkata';
  v_people jsonb; v_depts jsonb; v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  -- one row per person from the saved monthly reports, with a within-department percentile when 3+ people in that department have a score
  with rep as (
    select r.*, u.full_name, u.employee_code, d.name_en as department
      from public.perf_monthly_reports r join public.user_profiles u on u.id = r.user_id left join public.departments d on d.id = r.department_id
     where r.period_month = v_month and r.status <> 'SUPERSEDED'),
  ranked as (
    select rep.*, count(overall_score) over (partition by department_id) as dept_scored,
           rank() over (partition by department_id order by overall_score desc nulls last) as dept_rank,
           case when overall_score is not null then percent_rank() over (partition by department_id, (overall_score is not null) order by overall_score) end as pr
      from rep)
  select coalesce(jsonb_agg(jsonb_build_object('report_id', id, 'user_id', user_id, 'full_name', full_name, 'employee_code', employee_code,
           'department_id', department_id, 'department', department, 'overall_score', overall_score, 'scored_tasks', scored_tasks,
           'dept_rank', case when overall_score is not null then dept_rank end,
           'dept_percentile', case when overall_score is not null and dept_scored >= 3 then round(100 * pr) end,
           'category_scores', category_scores, 'completed', (metrics ->> 'completed')::int, 'pending', (metrics ->> 'pending')::int,
           'overdue', (metrics ->> 'overdue')::int, 'on_time_rate', (metrics ->> 'on_time_rate')::numeric, 'reopened', (metrics ->> 'reopened')::int,
           'score_change', comparison -> 'score_change', 'status', status) order by department, dept_rank), '[]')
    into v_people from ranked;

  select coalesce(jsonb_agg(x order by x ->> 'department'), '[]') into v_depts from (
    select jsonb_build_object('department_id', p ->> 'department_id', 'department', p ->> 'department', 'people', count(*),
             'scored_people', count(p -> 'overall_score') filter (where p ->> 'overall_score' is not null),
             'avg_score', round(avg((p ->> 'overall_score')::numeric), 1),
             'completed', sum((p ->> 'completed')::int), 'pending', sum((p ->> 'pending')::int), 'overdue', sum((p ->> 'overdue')::int),
             'avg_on_time_rate', round(avg((p ->> 'on_time_rate')::numeric), 1),
             'avg_quality', round(avg((p -> 'category_scores' ->> 'quality')::numeric), 1)) as x
      from jsonb_array_elements(v_people) p group by p ->> 'department_id', p ->> 'department') q;

  return jsonb_build_object(
    'period_month', v_month, 'generated_from', 'saved monthly reports + live open-work snapshot at generation time',
    'overview', jsonb_build_object(
      'active_employees', jsonb_array_length(v_people),
      'scored_employees', (select count(*) from jsonb_array_elements(v_people) p where p ->> 'overall_score' is not null),
      'avg_score', (select round(avg((p ->> 'overall_score')::numeric), 1) from jsonb_array_elements(v_people) p),
      'tasks_assigned', (select count(*) from public.staff_tasks t where t.is_active and not coalesce(t.is_test_data, false) and t.created_at >= v_start and t.created_at < v_end),
      'tasks_completed', (select count(*) from public.staff_tasks t where t.is_active and not coalesce(t.is_test_data, false) and t.completed_at >= v_start and t.completed_at < v_end),
      'open_tasks_now', (select count(*) from public.staff_tasks t join public.status_master s on s.id = t.status_id
                          where t.is_active and not coalesce(t.is_test_data, false) and s.code not in ('COMPLETED', 'VERIFIED', 'CLOSED')),
      'overdue_tasks_now', (select count(*) from public.staff_tasks t join public.status_master s on s.id = t.status_id
                          where t.is_active and not coalesce(t.is_test_data, false) and s.code not in ('COMPLETED', 'VERIFIED', 'CLOSED') and t.due_date < v_today)),
    'departments', v_depts,
    'people', v_people,
    'most_improved', (select coalesce(jsonb_agg(p order by (p ->> 'score_change')::numeric desc), '[]') from (
        select p from jsonb_array_elements(v_people) p where (p ->> 'score_change') is not null and (p ->> 'score_change')::numeric > 0
        order by (p ->> 'score_change')::numeric desc limit 5) z),
    'needs_support', (select coalesce(jsonb_agg(p), '[]') from jsonb_array_elements(v_people) p
        where (p ->> 'overall_score')::numeric < 50 or (p ->> 'overdue')::int >= 3),
    'trend', (select coalesce(jsonb_agg(jsonb_build_object('month', m.period_month, 'avg_score', m.avg_score, 'people', m.n) order by m.period_month), '[]') from (
        select r.period_month, round(avg(r.overall_score), 1) as avg_score, count(*) as n from public.perf_monthly_reports r
         where r.status <> 'SUPERSEDED' and r.period_month > (v_month - interval '12 months')::date and r.period_month <= v_month group by r.period_month) m),
    'backlog_by_department', (select coalesce(jsonb_agg(jsonb_build_object('department', d.name_en, 'open', x.open, 'overdue', x.overdue) order by x.overdue desc, x.open desc), '[]') from (
        select t.to_department_id, count(*) as open, count(*) filter (where t.due_date < v_today) as overdue
          from public.staff_tasks t join public.status_master s on s.id = t.status_id
         where t.is_active and not coalesce(t.is_test_data, false) and s.code not in ('COMPLETED', 'VERIFIED', 'CLOSED') group by t.to_department_id) x
         left join public.departments d on d.id = x.to_department_id),
    'repeated_delays', (select coalesce(jsonb_agg(jsonb_build_object('from', fd.name_en, 'to', td.name_en, 'late_or_overdue', x.n) order by x.n desc), '[]') from (
        select t.from_department_id, t.to_department_id, count(*) as n
          from public.staff_tasks t join public.status_master s on s.id = t.status_id
         where t.is_active and not coalesce(t.is_test_data, false)
           and ((t.due_date + coalesce(t.due_time, time '23:59:59')) at time zone 'Asia/Kolkata') >= v_start
           and ((t.due_date + coalesce(t.due_time, time '23:59:59')) at time zone 'Asia/Kolkata') < v_end
           and (t.completed_at > ((t.due_date + coalesce(t.due_time, time '23:59:59')) at time zone 'Asia/Kolkata')
                or (t.completed_at is null and s.code not in ('COMPLETED', 'VERIFIED', 'CLOSED')))
         group by 1, 2 having count(*) >= 2) x
         left join public.departments fd on fd.id = x.from_department_id left join public.departments td on td.id = x.to_department_id),
    'procurement_bottlenecks', (select coalesce(jsonb_agg(jsonb_build_object('stage', x.proc_status, 'open', x.n, 'overdue', x.late) order by x.n desc), '[]') from (
        select pr.proc_status, count(*) as n,
               count(*) filter (where pr.overdue_since is not null or pr.required_by_date < v_today) as late
          from public.purchase_requests pr
         where pr.archived_at is null and not coalesce(pr.is_test_data, false)
           and coalesce(pr.proc_status, 'LEGACY') not in ('LEGACY', 'DRAFT', 'CLOSED', 'CANCELLED', 'REJECTED_BY_DEPT_HEAD', 'REJECTED_BY_PROCUREMENT', 'EMERGENCY_REJECTED')
         group by 1) x),
    'factory_bottlenecks', (select coalesce(jsonb_agg(jsonb_build_object('stage', x.status, 'open', x.n, 'overdue', x.late) order by x.n desc), '[]') from (
        select j.status, count(*) as n, count(*) filter (where coalesce(j.revised_due_date, j.due_date) < v_today) as late
          from public.factory_job_cards j where j.status not in ('DISPATCHED', 'COMPLETED', 'CANCELLED') group by j.status) x),
    'coordination_issues', (select coalesce(jsonb_agg(jsonb_build_object('from', fd.name_en, 'to', td.name_en, 'overdue_open', x.n) order by x.n desc), '[]') from (
        select t.from_department_id, t.to_department_id, count(*) as n
          from public.staff_tasks t join public.status_master s on s.id = t.status_id
         where t.is_active and not coalesce(t.is_test_data, false) and (t.is_bridge or t.from_department_id <> t.to_department_id)
           and s.code not in ('COMPLETED', 'VERIFIED', 'CLOSED') and t.due_date < v_today group by 1, 2) x
         left join public.departments fd on fd.id = x.from_department_id left join public.departments td on td.id = x.to_department_id));
end $$;

create or replace function public.perf_generate_company_report_internal(p_month date, p_reason text default null)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v_month date := public.perf_month(p_month); v_old record; v_id uuid; v_version int;
begin
  if v_month >= public.perf_current_month() then raise exception 'A month can only be reported after it has ended'; end if;
  if not exists (select 1 from public.perf_monthly_reports where period_month = v_month and status <> 'SUPERSEDED') then
    raise exception 'Save the month''s employee reports first';
  end if;
  select * into v_old from public.perf_company_reports where period_month = v_month and status <> 'SUPERSEDED';
  if v_old.id is not null and p_reason is null then return v_old.id; end if;
  v_version := coalesce((select max(version) from public.perf_company_reports where period_month = v_month), 0) + 1;
  if v_old.id is not null then update public.perf_company_reports set status = 'SUPERSEDED', superseded_at = now() where id = v_old.id; end if;
  insert into public.perf_company_reports (period_month, version, metrics, calculation_version, generated_by, recalc_reason, supersedes_id)
  values (v_month, v_version, public.perf_company_metrics(v_month), 'perf-v1', auth.uid(), p_reason, v_old.id) returning id into v_id;
  perform public.perf_log(null, v_id, null, case when v_old.id is null then 'COMPANY_GENERATED' else 'COMPANY_REGENERATED' end,
    jsonb_build_object('month', v_month, 'version', v_version, 'reason', p_reason));
  perform public.perf_notify(public.perf_management_users(), 'PERF_COMPANY', v_id,
    'Management performance report for ' || to_char(v_month, 'Mon YYYY') || ' is ready for review',
    to_char(v_month, 'Mon YYYY') || ' નો મેનેજમેન્ટ પ્રદર્શન અહેવાલ સમીક્ષા માટે તૈયાર છે');
  return v_id;
end $$;

create or replace function public.perf_generate_company_report(p_month date, p_reason text default null)
returns uuid language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.perf_is_management() then raise exception 'Only Management can create the company report'; end if;
  return public.perf_generate_company_report_internal(p_month, nullif(btrim(coalesce(p_reason, '')), ''));
end $$;

create or replace function public.perf_company_report(p_month date)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare c public.perf_company_reports;
begin
  if not (public.perf_is_management() or exists (select 1 from public.perf_viewers v where v.user_id = auth.uid() and v.is_active and v.department_id is null)) then
    raise exception 'Only Management can see the company report';
  end if;
  select * into c from public.perf_company_reports where period_month = public.perf_month(p_month) and status <> 'SUPERSEDED';
  if c.id is null then return null; end if;
  return to_jsonb(c) || jsonb_build_object('can_finalize', public.perf_is_management() and c.status = 'DRAFT',
    'versions', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'version', x.version, 'status', x.status, 'generated_at', x.generated_at, 'recalc_reason', x.recalc_reason) order by x.version), '[]')
                   from public.perf_company_reports x where x.period_month = c.period_month));
end $$;

create or replace function public.perf_company_ai_input(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare c public.perf_company_reports;
begin
  if not public.perf_is_management() then raise exception 'Only Management can write the company AI summary'; end if;
  select * into c from public.perf_company_reports where id = p_id;
  if c.id is null or c.status = 'SUPERSEDED' then raise exception 'Company report not found'; end if;
  return jsonb_build_object('id', c.id, 'month', to_char(c.period_month, 'FMMonth YYYY'), 'ai_status', c.ai_status,
    -- names and scores of people stay in the report; the AI summary works from department figures and bottlenecks
    'metrics', (c.metrics - 'people' - 'most_improved' - 'needs_support')
               || jsonb_build_object('most_improved_count', jsonb_array_length(coalesce(c.metrics -> 'most_improved', '[]')),
                                     'needs_support_count', jsonb_array_length(coalesce(c.metrics -> 'needs_support', '[]'))));
end $$;

create or replace function public.perf_save_company_ai(p_id uuid, p_summary jsonb, p_model text, p_error text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare c public.perf_company_reports;
begin
  if not public.perf_is_management() then raise exception 'Only Management can write the company AI summary'; end if;
  select * into c from public.perf_company_reports where id = p_id for update;
  if c.id is null or c.status = 'SUPERSEDED' then raise exception 'Company report not found'; end if;
  if c.ai_status = 'DONE' then raise exception 'The AI summary is already written'; end if;
  if p_error is not null then
    update public.perf_company_reports set ai_status = 'FAILED', ai_error = left(p_error, 300) where id = p_id; return;
  end if;
  if p_summary is null or nullif(p_summary ->> 'overview', '') is null then raise exception 'The AI summary is empty'; end if;
  update public.perf_company_reports set ai_status = 'DONE', ai_summary = p_summary, ai_model = left(p_model, 80), ai_generated_at = now(), ai_error = null where id = p_id;
  perform public.perf_log(null, p_id, null, 'COMPANY_AI_WRITTEN', jsonb_build_object('model', p_model));
end $$;

create or replace function public.perf_finalize_company_report(p_id uuid, p_note text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.perf_is_management() then raise exception 'Only Management can finalise the company report'; end if;
  update public.perf_company_reports set status = 'FINAL', finalized_by = auth.uid(), finalized_at = now(), management_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_id and status = 'DRAFT';
  if not found then raise exception 'Only a draft company report can be finalised'; end if;
  perform public.perf_log(null, p_id, null, 'COMPANY_FINALIZED', jsonb_build_object('note', p_note));
end $$;

-- A Head's view of one department for a month: saved reports + that department's part of the company report.
create or replace function public.perf_department_view(p_month date, p_department uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_month date := public.perf_month(p_month); c public.perf_company_reports;
begin
  if not (public.perf_is_management() or public.perf_is_granted(p_department)
          or (public.staff_current_user_ok() and public.staff_is_dept_head() and public.staff_dept_in_hod_scope(p_department))) then
    raise exception 'You can only see your own department';
  end if;
  select * into c from public.perf_company_reports where period_month = v_month and status <> 'SUPERSEDED';
  return jsonb_build_object('period_month', v_month, 'department_id', p_department,
    'stats', (select x from jsonb_array_elements(c.metrics -> 'departments') x where x ->> 'department_id' = p_department::text),
    'ai_summary', (select x from jsonb_array_elements(c.ai_summary -> 'departments') x where x ->> 'department_id' = p_department::text),
    'company_report_status', c.status);
end $$;

-- ---------------------------------------------------------------- monthly schedule (1st of the month, 06:00 IST)
create or replace function public.perf_run_monthly()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_month date := (public.perf_current_month() - interval '1 month')::date; v jsonb; v_c uuid;
begin
  v := public.perf_generate_month_internal(v_month, null, null);
  if exists (select 1 from public.perf_monthly_reports where period_month = v_month and status <> 'SUPERSEDED') then
    v_c := public.perf_generate_company_report_internal(v_month, null);
  end if;
  return v || jsonb_build_object('company_report_id', v_c);
end $$;

-- ---------------------------------------------------------------- deep links for the new notifications
create or replace function public.notification_deep_link(p_type text, p_id uuid, p_task uuid default null::uuid)
returns text language sql immutable set search_path to 'public' as $function$
  select coalesce(case p_type
    when 'task' then '/tasks?focus=' || p_id::text
    when 'task_message' then case when p_task is not null then '/chat?legacy_message=' || p_id::text || '&legacy_task=' || p_task::text else '/chat?legacy_message=' || p_id::text end
    when 'project' then '/interior-projects/detail/' || p_id::text
    when 'snag' then '/interior-projects/site-execution'
    when 'interior_task' then '/interior-projects/tasks'
    when 'site_report' then '/interior-projects/daily-updates'
    when 'retail_lead' then '/retail/leads'
    when 'retail_complaint' then '/retail/complaints'
    when 'retail_vm_task' then '/retail/display'
    when 'FACTORY_AI_REQUEST' then '/factory-requests'
    when 'FACTORY_JOB' then '/factory-job/' || p_id::text
    when 'FACTORY_JOB_CARD' then '/factory-job-cards/' || p_id::text
    when 'CHAT' then case when p_task is not null then '/chat?c=' || p_id::text || '&task=' || p_task::text else '/chat?c=' || p_id::text end
    when 'PURCHASE_REQUEST' then '/purchase-requests/' || p_id::text
    when 'PERF_REVIEW' then '/performance/report/' || p_id::text
    when 'PERF_TEAM' then '/performance/team'
    when 'PERF_CONTROL' then '/performance/control'
    when 'PERF_COMPANY' then '/performance/control?tab=company'
    else null
  end, '/');
$function$;

-- ---------------------------------------------------------------- RLS: read-only tables, all writes through the functions above
alter table public.perf_settings enable row level security;
alter table public.perf_frameworks enable row level security;
alter table public.perf_viewers enable row level security;
alter table public.perf_delay_excuses enable row level security;
alter table public.perf_monthly_reports enable row level security;
alter table public.perf_report_tasks enable row level security;
alter table public.perf_goals enable row level security;
alter table public.perf_company_reports enable row level security;
alter table public.perf_audit enable row level security;

drop policy if exists perf_settings_read on public.perf_settings;
create policy perf_settings_read on public.perf_settings for select to authenticated using (public.staff_current_user_ok());
drop policy if exists perf_frameworks_read on public.perf_frameworks;
create policy perf_frameworks_read on public.perf_frameworks for select to authenticated using (public.staff_current_user_ok());
drop policy if exists perf_viewers_read on public.perf_viewers;
create policy perf_viewers_read on public.perf_viewers for select to authenticated using (user_id = auth.uid() or public.perf_is_management());
drop policy if exists perf_excuses_read on public.perf_delay_excuses;
create policy perf_excuses_read on public.perf_delay_excuses for select to authenticated using (public.perf_can_view_user(user_id));
drop policy if exists perf_reports_read on public.perf_monthly_reports;
create policy perf_reports_read on public.perf_monthly_reports for select to authenticated using (public.perf_can_read_report(perf_monthly_reports.*));
drop policy if exists perf_report_tasks_read on public.perf_report_tasks;
create policy perf_report_tasks_read on public.perf_report_tasks for select to authenticated
  using (exists (select 1 from public.perf_monthly_reports r where r.id = report_id and public.perf_can_read_report(r)));
drop policy if exists perf_goals_read on public.perf_goals;
create policy perf_goals_read on public.perf_goals for select to authenticated
  using (exists (select 1 from public.perf_monthly_reports r where r.id = report_id and public.perf_can_read_report(r)));
drop policy if exists perf_company_read on public.perf_company_reports;
create policy perf_company_read on public.perf_company_reports for select to authenticated
  using (public.perf_is_management() or exists (select 1 from public.perf_viewers v where v.user_id = auth.uid() and v.is_active and v.department_id is null));
drop policy if exists perf_audit_read on public.perf_audit;
create policy perf_audit_read on public.perf_audit for select to authenticated using (public.perf_is_management());

revoke all on public.perf_settings, public.perf_frameworks, public.perf_viewers, public.perf_delay_excuses, public.perf_monthly_reports,
  public.perf_report_tasks, public.perf_goals, public.perf_company_reports, public.perf_audit from anon;
revoke insert, update, delete, truncate on public.perf_settings, public.perf_frameworks, public.perf_viewers, public.perf_delay_excuses, public.perf_monthly_reports,
  public.perf_report_tasks, public.perf_goals, public.perf_company_reports, public.perf_audit from authenticated;
grant select on public.perf_settings, public.perf_frameworks, public.perf_viewers, public.perf_delay_excuses, public.perf_monthly_reports,
  public.perf_report_tasks, public.perf_goals, public.perf_company_reports, public.perf_audit to authenticated;

-- internal functions: not callable from the app
revoke all on function public.perf_eval(uuid, date, timestamptz), public.perf_generate_month_internal(date, text, uuid),
  public.perf_generate_company_report_internal(date, text), public.perf_run_monthly(), public.perf_company_metrics(date),
  public.perf_notify(uuid[], text, uuid, text, text), public.perf_log(uuid, uuid, uuid, text, jsonb), public.perf_management_users()
  from public, anon, authenticated;
-- app functions: signed-in users (each checks who is asking)
revoke all on function public.perf_live(uuid, date), public.perf_my_summary(), public.perf_team(date, uuid), public.perf_generate_month(date),
  public.perf_recalculate(uuid, date, text), public.perf_ai_input(uuid), public.perf_save_ai_review(uuid, jsonb, text, text),
  public.perf_head_review(uuid, text, jsonb), public.perf_employee_respond(uuid, text), public.perf_finalize_report(uuid), public.perf_report_detail(uuid),
  public.perf_excuse_delay(uuid, uuid, text, text), public.perf_revoke_excuse(uuid, uuid),
  public.perf_save_framework(uuid, numeric, numeric, numeric, numeric, numeric, text[]), public.perf_save_settings(int, numeric, numeric, jsonb, numeric),
  public.perf_set_viewer(uuid, uuid, boolean), public.perf_generate_company_report(date, text), public.perf_company_report(date),
  public.perf_save_company_ai(uuid, jsonb, text, text), public.perf_finalize_company_report(uuid, text), public.perf_department_view(date, uuid),
  public.perf_company_ai_input(uuid)
  from public, anon;
grant execute on function public.perf_live(uuid, date), public.perf_my_summary(), public.perf_team(date, uuid), public.perf_generate_month(date),
  public.perf_recalculate(uuid, date, text), public.perf_ai_input(uuid), public.perf_save_ai_review(uuid, jsonb, text, text),
  public.perf_head_review(uuid, text, jsonb), public.perf_employee_respond(uuid, text), public.perf_finalize_report(uuid), public.perf_report_detail(uuid),
  public.perf_excuse_delay(uuid, uuid, text, text), public.perf_revoke_excuse(uuid, uuid),
  public.perf_save_framework(uuid, numeric, numeric, numeric, numeric, numeric, text[]), public.perf_save_settings(int, numeric, numeric, jsonb, numeric),
  public.perf_set_viewer(uuid, uuid, boolean), public.perf_generate_company_report(date, text), public.perf_company_report(date),
  public.perf_save_company_ai(uuid, jsonb, text, text), public.perf_finalize_company_report(uuid, text), public.perf_department_view(date, uuid),
  public.perf_company_ai_input(uuid)
  to authenticated;

do $do$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'perf-monthly-reports';
    perform cron.schedule('perf-monthly-reports', '30 0 1 * *', 'select public.perf_run_monthly();');
  end if;
end $do$;
