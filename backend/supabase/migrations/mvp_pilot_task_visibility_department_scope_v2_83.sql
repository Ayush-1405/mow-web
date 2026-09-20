-- Task visibility / department isolation (v2_83). Applied to the live project; kept here for repo parity.
--
-- ROOT CAUSE (Factory Head could read Interior tasks):
--   interior_is_org_wide() trusted profiles.role IN ('head','director','purchase','crm') without asking which
--   DEPARTMENT the person belongs to. The Interior/Factory roster sync (and interior_ensure_profile) gives every
--   dept_head -- Factory included -- profiles.role = 'head', and staff_tasks_select_scoped let interior_is_org_wide()
--   users read every task that carries a project_id. The same helper guards ~50 Interior tables, so a Factory head
--   also read Interior projects, purchase data, etc. Interior module roles now only count inside Interior.
--
-- After this migration ONE function, staff_can_view_task(), decides task visibility for RLS, staff_task_visible(),
-- attachments, bridges, staff_record_attachment() and the Factory RPCs.

create or replace function public.interior_is_org_wide() returns boolean
  language sql stable security definer set search_path = public
as $$
  select public.staff_is_management() or public.staff_is_super_admin()
    or (
      public.staff_current_department_id() = (select id from public.departments where code = 'INTERIOR')
      and coalesce(public.current_user_role() in ('head', 'director', 'purchase', 'crm'), false)
    )
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope((select id from public.departments where code = 'INTERIOR')));
$$;

create or replace function public.staff_can_view_task(t public.staff_tasks) returns boolean
  language sql stable security definer set search_path = public
as $$
  select public.staff_current_user_ok() and (
    public.staff_is_management() or public.staff_is_super_admin()
    or (
      not (
        exists (select 1 from public.departments d where d.id in (t.from_department_id, t.to_department_id) and d.is_confidential_domain)
        and not (public.staff_is_accounts_head() or public.staff_current_role_code() in ('accounts_employee', 'cfo'))
      )
      and (
        t.assigned_by = auth.uid() or t.assigned_to = auth.uid() or t.current_owner_id = auth.uid() or t.verifier_id = auth.uid()
        or exists (select 1 from public.staff_task_assignees a where a.task_id = t.id and a.user_id = auth.uid() and a.is_active)
        or (public.staff_is_dept_head() and (
              public.staff_dept_in_hod_scope(t.to_department_id)
              or (t.is_bridge and public.staff_dept_in_hod_scope(t.from_department_id))))
        or (public.staff_is_supervisor() and t.to_department_id = public.staff_current_department_id())
        or (public.staff_is_accounts_head() and (t.from_department_id = public.staff_current_department_id() or t.to_department_id = public.staff_current_department_id()))
        or (t.project_id is not null and t.to_department_id = public.staff_current_department_id() and public.interior_is_project_member(t.project_id))
      )
    )
  );
$$;

create or replace function public.staff_task_visible(p_task_id uuid) returns boolean
  language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.staff_tasks t where t.id = p_task_id and public.staff_can_view_task(t));
$$;

drop policy if exists staff_tasks_select_scoped on public.staff_tasks;
create policy staff_tasks_select_scoped on public.staff_tasks
  for select to authenticated using (public.staff_can_view_task(staff_tasks.*));

drop policy if exists bridges_select_scoped on public.bridges;
create policy bridges_select_scoped on public.bridges
  for select to authenticated using (
    public.staff_current_user_ok()
    and (from_person_id = (select auth.uid()) or to_person_id = (select auth.uid()) or public.staff_task_visible(task_id))
  );

drop policy if exists staff_attachments_select_matches_parent on public.staff_attachments;
create policy staff_attachments_select_matches_parent on public.staff_attachments
  for select to authenticated using (
    public.staff_current_user_ok()
    and (
      uploaded_by = auth.uid() or public.staff_is_management() or public.staff_is_super_admin()
      or (entity_type = 'task' and public.staff_task_visible(entity_id))
      or (entity_type = 'bridge' and exists (
            select 1 from public.bridges b
            where b.id = staff_attachments.entity_id
              and (b.from_person_id = auth.uid() or b.to_person_id = auth.uid() or public.staff_task_visible(b.task_id))))
    )
  );

-- staff_record_attachment(): the hand-copied access rule now calls staff_can_view_task() / staff_task_visible().
-- (Full function body applied live; see the deployed definition -- only the v_has_access assignments changed:
--    task   : v_has_access := public.staff_can_view_task(v_task);
--    bridge : v_has_access := from_person_id = auth.uid() or to_person_id = auth.uid() or public.staff_task_visible(v_bridge.task_id);)

create or replace function public.staff_task_is_mine(t public.staff_tasks) returns boolean
  language sql stable security definer set search_path = public
as $$
  select t.assigned_to = auth.uid() or t.current_owner_id = auth.uid()
    or exists (select 1 from public.staff_task_assignees a where a.task_id = t.id and a.user_id = auth.uid() and a.is_active);
$$;
create or replace function public.staff_task_in_dept_scope(t public.staff_tasks) returns boolean
  language sql stable security definer set search_path = public
as $$
  select (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(t.to_department_id))
    or (public.staff_is_supervisor() and t.to_department_id = public.staff_current_department_id())
    or (public.staff_is_accounts_head() and t.to_department_id = public.staff_current_department_id());
$$;
create or replace function public.staff_task_in_team(t public.staff_tasks) returns boolean
  language sql stable security definer set search_path = public
as $$
  select (public.staff_is_dept_head() or public.staff_is_supervisor()) and public.staff_task_in_dept_scope(t)
    and exists (
      select 1 from public.user_profiles up
      where up.reports_to = auth.uid()
        and (up.id = t.assigned_to or exists (select 1 from public.staff_task_assignees a where a.task_id = t.id and a.user_id = up.id and a.is_active))
    );
$$;
create or replace function public.staff_task_bridge_in(t public.staff_tasks) returns boolean
  language sql stable security definer set search_path = public
as $$ select t.is_bridge and public.staff_task_in_dept_scope(t); $$;
create or replace function public.staff_task_bridge_sent(t public.staff_tasks) returns boolean
  language sql stable security definer set search_path = public
as $$
  select t.is_bridge and (t.assigned_by = auth.uid() or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(t.from_department_id)));
$$;

create or replace view public.staff_task_scope_v with (security_invoker = true) as
select t.*,
  public.staff_task_is_mine(t)        as scope_mine,
  (t.assigned_by = auth.uid())        as scope_created,
  public.staff_task_in_dept_scope(t)  as scope_department,
  public.staff_task_in_team(t)        as scope_team,
  public.staff_task_bridge_in(t)      as scope_bridge_in,
  public.staff_task_bridge_sent(t)    as scope_bridge_sent,
  (public.staff_is_management() or public.staff_is_super_admin()) as scope_all
from public.staff_tasks t;

revoke all on public.staff_task_scope_v from public, anon;
grant select on public.staff_task_scope_v to authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'staff_can_view_task(public.staff_tasks)', 'staff_task_is_mine(public.staff_tasks)', 'staff_task_in_dept_scope(public.staff_tasks)',
    'staff_task_in_team(public.staff_tasks)', 'staff_task_bridge_in(public.staff_tasks)', 'staff_task_bridge_sent(public.staff_tasks)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
