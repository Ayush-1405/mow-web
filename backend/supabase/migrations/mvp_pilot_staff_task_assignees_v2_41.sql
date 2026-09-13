-- Second Assignee for staff_tasks: one task, up to two people, independent
-- acceptance/work status per person. staff_tasks.assigned_to stays the
-- Primary Assignee (unchanged, backward compatible) -- this table is the
-- actual multi-person model.

create table public.staff_task_assignees (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.staff_tasks(id),
  user_id uuid not null references public.user_profiles(id),
  assignment_role text not null check (assignment_role in ('primary', 'secondary')),
  assigned_by uuid,
  assigned_at timestamptz not null default now(),
  acceptance_status text not null default 'PENDING' check (acceptance_status in ('PENDING', 'ACCEPTED', 'REJECTED')),
  accepted_at timestamptz,
  individual_status text not null default 'ASSIGNED' check (individual_status in ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'REJECTED')),
  completed_at timestamptz,
  completion_note text,
  is_active boolean not null default true,
  removed_at timestamptz,
  removed_by uuid,
  removal_reason text,
  unique (task_id, user_id)
);

create index staff_task_assignees_task_id_idx on public.staff_task_assignees(task_id);
create index staff_task_assignees_user_id_idx on public.staff_task_assignees(user_id) where is_active;

-- Only one active Primary Assignee per task, ever.
create unique index staff_task_assignees_one_active_primary_idx
  on public.staff_task_assignees(task_id)
  where assignment_role = 'primary' and is_active;

alter table public.staff_tasks
  add column completion_rule text not null default 'BOTH' check (completion_rule in ('BOTH', 'ANY_ONE', 'VERIFIER_DECISION'));

insert into public.status_master (code, name_en, name_gu, is_active)
select 'PARTIALLY_ACCEPTED', 'Partially Accepted', 'આંશિક સ્વીકાર', true
where not exists (select 1 from public.status_master where code = 'PARTIALLY_ACCEPTED');

insert into public.status_master (code, name_en, name_gu, is_active)
select 'PARTIALLY_COMPLETED', 'Partially Completed', 'આંશિક પૂર્ણ', true
where not exists (select 1 from public.status_master where code = 'PARTIALLY_COMPLETED');

-- Backfill: every existing task's current assigned_to becomes its Primary
-- Assignee row here. assigned_to/status_id on staff_tasks are NOT touched --
-- this is a read-only-to-staff_tasks, insert-only-to-the-new-table backfill.
insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by, assigned_at, acceptance_status, accepted_at, individual_status, completed_at)
select
  st.id, st.assigned_to, 'primary', st.assigned_by, st.created_at,
  case when sm.code in ('ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'VERIFIED', 'CLOSED') then 'ACCEPTED' else 'PENDING' end,
  case when sm.code in ('ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'VERIFIED', 'CLOSED') then st.accepted_at end,
  case
    when sm.code in ('COMPLETED', 'VERIFIED', 'CLOSED') then 'COMPLETED'
    when sm.code = 'IN_PROGRESS' then 'IN_PROGRESS'
    when sm.code = 'ACCEPTED' then 'ACCEPTED'
    else 'ASSIGNED'
  end,
  case when sm.code in ('COMPLETED', 'VERIFIED', 'CLOSED') then st.completed_at end
from public.staff_tasks st
join public.status_master sm on sm.id = st.status_id
where st.assigned_to is not null;

-- RLS: same visibility as the parent task (mirrors staff_tasks_select_scoped's
-- own boolean, extracted so it isn't duplicated ad hoc), or the assignee row
-- is the caller's own. No INSERT/UPDATE/DELETE policy at all -- exactly like
-- staff_tasks itself -- every write goes through the SECURITY DEFINER RPCs
-- below, which is the actual enforcement against self-insertion.
create or replace function public.staff_task_visible(p_task_id uuid) returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.staff_tasks t
    where t.id = p_task_id
      and (
        t.assigned_by = auth.uid() or t.assigned_to = auth.uid() or t.current_owner_id = auth.uid() or t.verifier_id = auth.uid()
        or public.staff_is_management() or public.staff_is_super_admin()
        or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(t.from_department_id) or public.staff_dept_in_hod_scope(t.to_department_id)))
        or (public.staff_is_supervisor() and (t.from_department_id = public.staff_current_department_id() or t.to_department_id = public.staff_current_department_id()))
        or (public.staff_is_accounts_head() and (t.from_department_id = public.staff_current_department_id() or t.to_department_id = public.staff_current_department_id()))
        or (t.project_id is not null and (public.interior_is_org_wide() or public.interior_is_project_member(t.project_id)))
      )
      and not (
        exists (select 1 from public.departments d where d.id in (t.from_department_id, t.to_department_id) and d.is_confidential_domain = true)
        and not (public.staff_is_management() or public.staff_is_accounts_head() or public.staff_current_role_code() in ('accounts_employee', 'cfo'))
      )
  );
$$;

alter table public.staff_task_assignees enable row level security;

-- A newly created table grants nothing to `authenticated` by default (unlike
-- staff_tasks, whose SELECT grant predates this migration) -- without this,
-- the RLS policy below would never even be reached and every SELECT would
-- fail with a plain permission-denied, not a filtered-empty-result.
grant select on public.staff_task_assignees to authenticated;

create policy "staff_task_assignees_select_scoped" on public.staff_task_assignees for select using (
  user_id = auth.uid() or public.staff_task_visible(task_id)
);

-- Extends staff_tasks' own SELECT policy so a Second Assignee sees the task
-- in Today's Tasks -- the literal fix for the previously scalar-only
-- (assigned_to/current_owner_id/verifier_id/assigned_by) visibility check.
drop policy if exists "staff_tasks_select_scoped" on public.staff_tasks;
create policy "staff_tasks_select_scoped" on public.staff_tasks for select using (
  staff_current_user_ok() and (
    assigned_by = auth.uid() or assigned_to = auth.uid() or current_owner_id = auth.uid() or verifier_id = auth.uid()
    or id in (select task_id from public.staff_task_assignees where user_id = auth.uid() and is_active)
    or staff_is_management() or staff_is_super_admin()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(from_department_id) or staff_dept_in_hod_scope(to_department_id)))
    or (staff_is_supervisor() and (from_department_id = staff_current_department_id() or to_department_id = staff_current_department_id()))
    or (staff_is_accounts_head() and (from_department_id = staff_current_department_id() or to_department_id = staff_current_department_id()))
    or (project_id is not null and (interior_is_org_wide() or interior_is_project_member(project_id)))
  ) and not (
    exists (select 1 from departments d where d.id = any(array[staff_tasks.from_department_id, staff_tasks.to_department_id]) and d.is_confidential_domain = true)
    and not (staff_is_management() or staff_is_accounts_head() or staff_current_role_code() = any(array['accounts_employee'::text, 'cfo'::text]))
  )
);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'staff_task_assignees') then
    execute 'alter publication supabase_realtime add table public.staff_task_assignees';
  end if;
end $$;
