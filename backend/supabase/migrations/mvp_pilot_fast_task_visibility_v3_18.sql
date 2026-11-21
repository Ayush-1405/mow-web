-- v3_18: faster task lists -- the SAME visibility rules, worked out once per request instead of once per task.
--
-- Before: the staff_tasks policy called staff_can_view_task(row) for every task in the company, and each call re-read the
-- caller's profile and role ~10 times (about 2.6 ms per task -> ~270 ms for 101 tasks, growing with every new task). The
-- assignee / bridge / task message / attachment policies did the same through staff_task_visible(task_id).
-- After: staff_viewer_ctx() gathers the caller's facts once (an InitPlan: "(select ...)" in a policy runs once per query) and
-- staff_can_view_task_as(row, ctx) applies exactly the rules of staff_can_view_task with no further lookups.
-- staff_can_view_task / staff_task_visible are left unchanged for the functions that call them directly.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'staff_viewer' and typnamespace = 'public'::regnamespace) then
    create type public.staff_viewer as (
      uid uuid, ok boolean, global boolean, restricted boolean, head boolean, sup boolean, acc boolean, dept uuid,
      hod_depts uuid[], conf_depts uuid[], my_tasks uuid[], projects uuid[]);
  end if;
end $$;

create or replace function public.staff_viewer_ctx()
returns public.staff_viewer language plpgsql stable security definer set search_path to 'public' as $$
declare v public.staff_viewer; v_uid uuid := auth.uid(); v_prof uuid;
begin
  v.uid := v_uid;
  v.ok := public.staff_current_user_ok();
  if not coalesce(v.ok, false) then v.ok := false; return v; end if;
  v.global := coalesce(public.staff_has_global_oversight(), false);
  v.restricted := coalesce(public.staff_has_capability('can_view_restricted_finance'), false);
  v.head := coalesce(public.staff_is_dept_head(), false);
  v.sup := coalesce(public.staff_is_supervisor(), false);
  v.acc := coalesce(public.staff_is_accounts_head(), false);
  v.dept := public.staff_current_department_id();
  v.conf_depts := array(select d.id from public.departments d where d.is_confidential_domain);
  v.hod_depts := case when v.head then array(select d.id from public.departments d where public.staff_user_dept_in_hod_scope(v_uid, d.id)) else '{}'::uuid[] end;
  v.my_tasks := array(select a.task_id from public.staff_task_assignees a where a.user_id = v_uid and a.is_active);
  v_prof := public.interior_current_profile_id();
  v.projects := case when v_prof is null then '{}'::uuid[] else array(
      select p.id from public.projects p where v_prof in (p.project_manager_id, p.designer_id, p.execution_id, p.lead_executive_id, p.executive_assistant_id)
      union select pm.project_id from public.project_members pm where pm.profile_id = v_prof) end;
  return v;
end $$;

-- Exactly staff_can_view_task(t), reading the caller's facts from c. Plain SQL with no lookups, so it is cheap per row.
create or replace function public.staff_can_view_task_as(t public.staff_tasks, c public.staff_viewer)
returns boolean language sql stable as $$
  select coalesce(c.ok, false) and (
    (c.global and (not (t.from_department_id = any(c.conf_depts) or t.to_department_id = any(c.conf_depts)) or c.restricted))
    or (
      (not (t.from_department_id = any(c.conf_depts) or t.to_department_id = any(c.conf_depts)) or c.restricted)
      and (
        t.assigned_by = c.uid or t.assigned_to = c.uid or t.current_owner_id = c.uid or t.verifier_id = c.uid
        or t.id = any(c.my_tasks)
        or (c.head and (t.to_department_id = any(c.hod_depts) or (t.is_bridge and t.from_department_id = any(c.hod_depts))))
        or (c.sup and t.to_department_id = c.dept)
        or (c.acc and (t.from_department_id = c.dept or t.to_department_id = c.dept))
        or (t.project_id is not null and t.to_department_id = c.dept and t.project_id = any(c.projects))
      )
    )
  )
$$;

-- anon keeps execute (as with the old helpers): for a signed-out caller the context is ok = false, so nothing is visible
grant execute on function public.staff_viewer_ctx() to authenticated, anon;
grant execute on function public.staff_can_view_task_as(public.staff_tasks, public.staff_viewer) to authenticated, anon;

-- staff_tasks: same rule, caller facts computed once per query
drop policy if exists staff_tasks_select_scoped on public.staff_tasks;
create policy staff_tasks_select_scoped on public.staff_tasks for select to authenticated
  using (public.staff_can_view_task_as(staff_tasks.*, (select public.staff_viewer_ctx())));

-- the other four: "the task is visible" = the task row passes the staff_tasks policy above
drop policy if exists staff_task_assignees_select_scoped on public.staff_task_assignees;
create policy staff_task_assignees_select_scoped on public.staff_task_assignees for select
  using (user_id = (select auth.uid())
         or exists (select 1 from public.staff_tasks t where t.id = staff_task_assignees.task_id
                     and public.staff_can_view_task_as(t, (select public.staff_viewer_ctx()))));

drop policy if exists bridges_select_scoped on public.bridges;
create policy bridges_select_scoped on public.bridges for select to authenticated
  using ((select public.staff_current_user_ok()) and (from_person_id = (select auth.uid()) or to_person_id = (select auth.uid())
         or exists (select 1 from public.staff_tasks t where t.id = bridges.task_id
                     and public.staff_can_view_task_as(t, (select public.staff_viewer_ctx())))));

drop policy if exists task_messages_select_scoped on public.task_messages;
create policy task_messages_select_scoped on public.task_messages for select
  using ((select public.staff_current_user_ok())
         and exists (select 1 from public.staff_tasks t where t.id = task_messages.task_id
                     and public.staff_can_view_task_as(t, (select public.staff_viewer_ctx()))));

drop policy if exists staff_attachments_select_matches_parent on public.staff_attachments;
create policy staff_attachments_select_matches_parent on public.staff_attachments for select to authenticated
  using ((select public.staff_current_user_ok()) and (
    uploaded_by = (select auth.uid()) or (select public.staff_is_management()) or (select public.staff_is_super_admin())
    or (entity_type = 'task' and exists (select 1 from public.staff_tasks t where t.id = staff_attachments.entity_id
                                          and public.staff_can_view_task_as(t, (select public.staff_viewer_ctx()))))
    or (entity_type = 'bridge' and exists (select 1 from public.bridges b where b.id = staff_attachments.entity_id
          and (b.from_person_id = (select auth.uid()) or b.to_person_id = (select auth.uid())
               or exists (select 1 from public.staff_tasks t where t.id = b.task_id
                           and public.staff_can_view_task_as(t, (select public.staff_viewer_ctx()))))))));
