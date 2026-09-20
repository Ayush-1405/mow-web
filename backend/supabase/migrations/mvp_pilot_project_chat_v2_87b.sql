-- v2_87b -- Project Chat + Chat-side replacements for the Reply features (unread counts, notifications, legacy-link resolver).
-- Access is decided here, in the database. Project membership is derived from the project's own assignment columns, never from
-- a client-supplied list.

-- ============ who may open a project chat ============
create or replace function public.chat_can_open_project(p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.staff_current_user_ok()
    and exists (select 1 from public.projects p where p.id = p_project)
    and (
      public.staff_is_management() or public.staff_is_super_admin()
      or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope((select id from public.departments where code = 'INTERIOR')))
      or (public.staff_current_role_code() = 'supervisor' and public.staff_current_department_id() = (select id from public.departments where code = 'INTERIOR'))
      or public.interior_is_project_member(p_project)
      or exists (select 1 from public.chat_conversations c where c.type = 'project' and c.project_id = p_project and public.chat_is_participant(c.id))
    );
$$;

-- ============ canonical conversation + participants (one per project) ============
create or replace function public.chat_sync_project(p_project uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare pr public.projects%rowtype; v_conv uuid; v_users uuid[]; v_roles text[]; v_int uuid := (select id from public.departments where code = 'INTERIOR');
begin
  select * into pr from public.projects where id = p_project;
  if pr.id is null then return null; end if;
  insert into public.chat_conversations (type, title, project_id, created_by, department_id, is_active, archived_at, management_visible)
  values ('project', pr.project_code || ' — ' || coalesce(nullif(btrim(pr.customer), ''), 'Project'), pr.id,
          (select up.id from public.profiles pf join public.user_profiles up on up.id = pf.auth_id where pf.id = pr.created_by),
          v_int, not coalesce(pr.archived, false), case when coalesce(pr.archived, false) then now() end, true)
  on conflict (project_id) where type = 'project' do update
    set title = excluded.title, is_active = excluded.is_active,
        archived_at = case when excluded.is_active then null else coalesce(public.chat_conversations.archived_at, now()) end
  returning id into v_conv;

  -- Eligible = the people ACTUALLY assigned to the project (+ the Interior department head + the purchase person on its purchase
  -- requests). People who merely hold a task on the project are deliberately NOT added: they keep their own Task Chat.
  with c as (
    select pf.auth_id as uid, 1 as pr, 'primary_assignee'::text as role from public.profiles pf where pf.id = pr.lead_executive_id
    union all select pf.auth_id, 2, 'second_assignee' from public.profiles pf where pf.id = pr.executive_assistant_id
    union all select pf.auth_id, 3, 'member' from public.profiles pf where pf.id in (pr.execution_id, pr.designer_id, pr.project_manager_id)
    union all select pf.auth_id, 3, 'member' from public.project_members m join public.profiles pf on pf.id = m.profile_id where m.project_id = pr.id
    union all select pf.auth_id, 4, 'task_creator' from public.profiles pf where pf.id = pr.created_by
    union all select pf.auth_id, 4, 'member' from public.purchase_requests r join public.profiles pf on pf.id = r.assigned_purchase_person where r.project_id = pr.id
    union all select up.id, 5, 'department_head' from public.user_profiles up join public.roles ro on ro.id = up.role_id
              where ro.code = 'dept_head' and up.department_id = v_int
  ), d as (
    select distinct on (c.uid) c.uid, c.role from c join public.user_profiles up on up.id = c.uid and up.is_active
    where c.uid is not null order by c.uid, c.pr
  )
  select array_agg(uid), array_agg(role) into v_users, v_roles from d;
  perform public.chat_reconcile(v_conv, coalesce(v_users, '{}'), coalesce(v_roles, '{}'), 'project participant');
  return v_conv;
end $$;

create or replace function public.chat_open_project(p_project uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_conv uuid; v_role text := public.staff_current_role_code();
begin
  perform public.staff_assert_operational();
  if not public.chat_can_open_project(p_project) then raise exception 'Project chat is limited to the people working on this project'; end if;
  v_conv := public.chat_sync_project(p_project);
  if v_conv is null then raise exception 'Project not found or you do not have access'; end if;
  if not public.chat_is_participant(v_conv) then
    -- authorized leadership only (the guard above already limited who reaches here): a logged, explicit join
    perform public.chat_upsert_participant(v_conv, auth.uid(),
      case when v_role = 'dept_head' then 'department_head' when v_role = 'supervisor' then 'supervisor' else 'management' end, 'manual: opened from project');
    insert into public.chat_access_log (conversation_id, user_id, action, reason) values (v_conv, auth.uid(), 'project_open', 'opened from project');
  end if;
  return v_conv;
end $$;

-- keep membership in step with the project's own data
create or replace function public.chat_trg_project() returns trigger language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  begin
    if tg_table_name = 'projects' then v_id := coalesce(new.id, old.id);
    else v_id := coalesce(new.project_id, old.project_id); end if;
    if v_id is not null then perform public.chat_sync_project(v_id); end if;
  exception when others then raise warning 'chat sync (project) failed: %', sqlerrm;
  end;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_chat_project on public.projects;
create trigger trg_chat_project after insert or update of project_code, customer, archived, lead_executive_id, executive_assistant_id, execution_id, designer_id, project_manager_id, created_by
  on public.projects for each row execute function public.chat_trg_project();
drop trigger if exists trg_chat_project_members on public.project_members;
create trigger trg_chat_project_members after insert or update or delete on public.project_members for each row execute function public.chat_trg_project();
drop trigger if exists trg_chat_project_purchase on public.purchase_requests;
create trigger trg_chat_project_purchase after insert or update of assigned_purchase_person, project_id on public.purchase_requests
  for each row when (new.project_id is not null) execute function public.chat_trg_project();

-- ============ project search (only projects the caller may open) ============
create or replace function public.chat_search_projects(p_query text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_q text := btrim(coalesce(p_query, ''));
begin
  perform public.staff_assert_operational();
  return (select coalesce(jsonb_agg(x.o order by x.k desc), '[]'::jsonb) from (
    select jsonb_build_object('project_id', p.id, 'project_code', p.project_code, 'client', p.customer, 'site', p.location, 'stage', p.stage,
             'archived', coalesce(p.archived, false), 'conversation_id', c.id, 'is_member', c.id is not null and public.chat_is_participant(c.id)) as o,
           coalesce(c.last_message_at, p.created_at) as k
    from public.projects p left join public.chat_conversations c on c.type = 'project' and c.project_id = p.id
    where public.chat_can_open_project(p.id)
      and (v_q = '' or p.project_code ilike '%' || v_q || '%' or p.customer ilike '%' || v_q || '%' or p.location ilike '%' || v_q || '%')
    order by coalesce(c.last_message_at, p.created_at) desc limit 30) x);
end $$;

-- tasks of the project the CALLER may see (links out to each Task Chat; nothing is copied into the project chat)
create or replace function public.chat_project_tasks(p_project uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_assert_operational();
  if not exists (select 1 from public.chat_conversations c where c.type = 'project' and c.project_id = p_project and public.chat_is_participant(c.id)) then
    raise exception 'Conversation not found';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'task_number', t.task_number, 'title', t.title, 'status', s.name_en, 'due_date', t.due_date,
            'is_bridge', t.is_bridge) order by t.created_at desc), '[]'::jsonb)
          from public.staff_tasks t join public.status_master s on s.id = t.status_id
          where t.project_id = p_project and t.is_active and public.staff_can_view_task(t));
end $$;

-- link a project-chat message to a task of the same project (never creates a task; never copies the message)
create or replace function public.chat_link_message_task(p_message uuid, p_task uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m public.chat_messages%rowtype; c public.chat_conversations%rowtype; tk public.staff_tasks%rowtype;
begin
  perform public.staff_assert_operational();
  select * into m from public.chat_messages where id = p_message;
  if m.id is null then raise exception 'Message not found'; end if;
  select * into c from public.chat_conversations where id = m.conversation_id;
  if c.type <> 'project' or not public.chat_can_post(c.id) then raise exception 'You cannot link messages in this conversation'; end if;
  select * into tk from public.staff_tasks where id = p_task;
  if tk.id is null or tk.project_id is distinct from c.project_id or not public.staff_can_view_task(tk) then raise exception 'That task is not available for this project'; end if;
  update public.chat_messages set context = context || jsonb_build_object('linked_task_id', tk.id, 'linked_task_number', tk.task_number, 'linked_by', auth.uid(), 'linked_at', now())
   where id = p_message;
  insert into public.chat_access_log (conversation_id, user_id, action, reason) values (c.id, auth.uid(), 'link_task', p_message::text || ' -> ' || tk.task_number);
end $$;

-- ============ task chat carries its project as context ============
create or replace function public.chat_sync_task(p_task uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare tk public.staff_tasks%rowtype; v_conv uuid; v_type text; v_restricted boolean; v_users uuid[]; v_roles text[];
begin
  select * into tk from public.staff_tasks where id = p_task;
  if tk.id is null then return null; end if;
  v_type := case when tk.is_bridge then 'bridge' else 'task' end;
  insert into public.chat_conversations (type, title, task_id, created_by, department_id, is_active, archived_at, project_id)
  values (v_type, tk.task_number || ' — ' || tk.title, tk.id, tk.assigned_by, tk.to_department_id, tk.is_active, case when tk.is_active then null else now() end, tk.project_id)
  on conflict (task_id) where type in ('task', 'bridge') do update
    set title = excluded.title, type = excluded.type, department_id = excluded.department_id, is_active = excluded.is_active, project_id = excluded.project_id,
        archived_at = case when excluded.is_active then null else coalesce(public.chat_conversations.archived_at, now()) end
  returning id into v_conv;
  v_restricted := exists (select 1 from public.departments d where d.id in (tk.from_department_id, tk.to_department_id) and d.is_confidential_domain);
  with c as (
    select tk.assigned_by as uid, 1 as pr, 'task_creator'::text as role
    union all select tk.assigned_to, 2, 'primary_assignee'
    union all select a.user_id, 2, case a.assignment_role when 'primary' then 'primary_assignee' else 'second_assignee' end
              from public.staff_task_assignees a where a.task_id = tk.id and a.is_active
    union all select tk.verifier_id, 4, case ro.code when 'supervisor' then 'supervisor' when 'dept_head' then 'department_head' else 'member' end
              from public.user_profiles v join public.roles ro on ro.id = v.role_id where v.id = tk.verifier_id
    union all select up.id, 5, 'department_head' from public.user_profiles up join public.roles ro on ro.id = up.role_id
              where ro.code = 'dept_head' and up.department_id = tk.to_department_id
    union all select up.id, 5, 'department_head' from public.user_profiles up join public.roles ro on ro.id = up.role_id
              where tk.is_bridge and ro.code = 'dept_head' and up.department_id = tk.from_department_id
  ), d as (
    select distinct on (c.uid) c.uid, c.role from c join public.user_profiles up on up.id = c.uid and up.is_active
    where c.uid is not null and (not v_restricted or public.chat_conf_ok(c.uid)) order by c.uid, c.pr
  )
  select array_agg(uid), array_agg(role) into v_users, v_roles from d;
  perform public.chat_reconcile(v_conv, coalesce(v_users, '{}'), coalesce(v_roles, '{}'), case when tk.is_bridge then 'bridge task participant' else 'task participant' end);
  return v_conv;
end $$;

-- ============ details: project header + project link on task chats ============
create or replace function public.chat_conversation_details(p_conversation uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c public.chat_conversations%rowtype; v_me uuid := auth.uid(); v_parts jsonb; v_ctx jsonb := '{}'::jsonb; v_can boolean; v_manage boolean; v_peer text;
begin
  if not public.chat_is_participant(p_conversation) then raise exception 'Conversation not found'; end if;
  select * into c from public.chat_conversations where id = p_conversation;
  select coalesce(jsonb_agg(jsonb_build_object('user_id', p.user_id, 'name', up.full_name, 'employee_code', up.employee_code, 'department', d.name_en,
           'role_label', ro.name_en, 'chat_role', p.role, 'active', p.left_at is null and up.is_active, 'joined_at', p.joined_at, 'left_at', p.left_at) order by up.full_name), '[]'::jsonb)
    into v_parts from public.chat_participants p join public.user_profiles up on up.id = p.user_id
    join public.roles ro on ro.id = up.role_id left join public.departments d on d.id = up.department_id where p.conversation_id = p_conversation;
  select p.can_post and c.is_active, p.can_manage into v_can, v_manage from public.chat_participants p where p.conversation_id = p_conversation and p.user_id = v_me;
  if c.type = 'project' then
    select jsonb_build_object('kind', 'project', 'project_id', pj.id, 'project_code', pj.project_code, 'client', pj.customer, 'site', pj.location, 'stage', pj.stage,
      'archived', coalesce(pj.archived, false), 'frozen', coalesce(pj.frozen, false), 'department', 'Interior',
      'lead_executive', (select name from public.profiles where id = pj.lead_executive_id),
      'executive_assistant', (select name from public.profiles where id = pj.executive_assistant_id))
    into v_ctx from public.projects pj where pj.id = c.project_id;
  elsif c.task_id is not null then
    select jsonb_build_object('kind', case when t.is_bridge then 'bridge' else 'task' end, 'task_id', t.id, 'task_number', t.task_number, 'title', t.title,
      'status', s.name_en, 'due_date', t.due_date, 'owning_department', dt.name_en, 'from_department', df.name_en, 'to_department', dt.name_en, 'is_bridge', t.is_bridge,
      'assignees', (select coalesce(jsonb_agg(u.full_name order by a.assignment_role), '[]'::jsonb) from public.staff_task_assignees a join public.user_profiles u on u.id = a.user_id where a.task_id = t.id and a.is_active),
      'project_id', t.project_id, 'project_code', pj.project_code, 'source_module', t.source_module, 'job_card_id', t.job_card_id,
      'can_open_project', t.project_id is not null and public.chat_can_open_project(t.project_id))
    into v_ctx from public.staff_tasks t join public.status_master s on s.id = t.status_id
    left join public.departments dt on dt.id = t.to_department_id left join public.departments df on df.id = t.from_department_id
    left join public.projects pj on pj.id = t.project_id where t.id = c.task_id;
  elsif c.job_card_id is not null then
    select jsonb_build_object('kind', 'job_card', 'job_card_id', j.id, 'job_order_number', j.job_order_number, 'customer', j.customer_name, 'project_code', j.project_code,
      'product', j.product_item, 'stage', j.current_stage, 'required_date', j.required_completion_date, 'status', j.factory_status)
    into v_ctx from public.inhouse_production_requests j where j.id = c.job_card_id;
  end if;
  if c.type = 'direct' then
    select up.full_name into v_peer from public.chat_participants p join public.user_profiles up on up.id = p.user_id where p.conversation_id = c.id and p.user_id <> v_me limit 1;
  end if;
  return jsonb_build_object(
    'id', c.id, 'type', c.type, 'title', case when c.type = 'direct' then coalesce(v_peer, c.title) else c.title end,
    'department', (select name_en from public.departments where id = c.department_id), 'is_active', c.is_active,
    'management_visible', c.management_visible, 'participants', v_parts, 'context', coalesce(v_ctx, '{}'::jsonb),
    'i_can_post', coalesce(v_can, false), 'i_can_manage', coalesce(v_manage, false) or public.staff_is_management() or public.staff_is_super_admin(),
    'notice', case when c.management_visible then 'This is a company work conversation and may be visible to authorized Management. Messages are stored on company servers and are not end-to-end encrypted.' else null end);
end $$;

-- ============ list rows: project fields (project chats only) ============
do $$
declare v_old text; v_new text;
begin
  v_old := pg_get_functiondef('public.chat_list_conversations(text[], boolean, uuid)'::regprocedure);
  v_new := replace(v_old, $q$'unread', u.n, 'task_id', c.task_id, 'job_card_id', c.job_card_id$q$,
    $q$'unread', u.n, 'task_id', c.task_id, 'job_card_id', c.job_card_id, 'project_id', c.project_id,
        'project_code', case when c.type = 'project' then pj.project_code end, 'client', case when c.type = 'project' then pj.customer end,
        'site', case when c.type = 'project' then pj.location end, 'stage', case when c.type = 'project' then pj.stage end$q$);
  v_new := replace(v_new, $q$    left join public.departments d on d.id = c.department_id
$q$, $q$    left join public.departments d on d.id = c.department_id
    left join public.projects pj on pj.id = c.project_id and c.type = 'project'
$q$);
  if v_new = v_old or position('pj.project_code' in v_new) = 0 or position('left join public.projects pj' in v_new) = 0 then raise exception 'chat_list_conversations patch did not apply'; end if;
  execute v_new;
end $$;

-- ============ notifications: work chats notify their other members (one collapsed unread notification per conversation) ============
do $$
declare v_old text; v_new text;
begin
  v_old := pg_get_functiondef('public.chat_send_message(uuid, text, uuid, uuid[], jsonb)'::regprocedure);
  v_new := replace(v_old, $q$  if v_conv.type = 'direct' then
$q$, $q$  if v_conv.type in ('task', 'bridge', 'job_card', 'project') then
    for r in select p.user_id, (p.user_id = any (v_ment)) as mentioned from public.chat_participants p
             where p.conversation_id = p_conversation and p.left_at is null and p.user_id <> v_me loop
      perform public.chat_notify(r.user_id, p_conversation,
        coalesce(v_name, 'Someone') || case when r.mentioned then ' mentioned you in ' else ' sent a message in ' end || v_conv.title,
        coalesce(v_name, 'કોઈએ') || case when r.mentioned then ' એ તમને ઉલ્લેખ કર્યો: ' else ' એ સંદેશ મોકલ્યો: ' end || v_conv.title);
    end loop;
  elsif v_conv.type = 'direct' then
$q$);
  if v_new = v_old then raise exception 'chat_send_message patch did not apply'; end if;
  execute v_new;
end $$;

-- ============ unread per task (replaces staff_task_unread_message_counts, which read the legacy table) ============
create or replace function public.chat_task_unread_counts()
returns table(task_id uuid, unread_count bigint) language sql stable security definer set search_path = public as $$
  select c.task_id, count(*)::bigint
  from public.chat_participants p
  join public.chat_conversations c on c.id = p.conversation_id and c.type in ('task', 'bridge') and c.task_id is not null
  join public.chat_messages m on m.conversation_id = c.id
  where public.staff_current_user_ok() and p.user_id = auth.uid() and p.left_at is null
    and m.created_at > coalesce(p.last_read_at, p.joined_at) and m.sender_id is distinct from auth.uid() and not m.is_system and m.deleted_at is null
  group by c.task_id;
$$;

-- old bundles still in a browser cache keep working, now against Chat
create or replace function public.staff_task_unread_message_counts()
returns table(task_id uuid, unread_count bigint) language sql stable security definer set search_path = public as $$
  select * from public.chat_task_unread_counts();
$$;

-- ============ old Reply links / notifications -> the migrated Chat message ============
create or replace function public.chat_resolve_legacy(p_kind text, p_id uuid, p_task uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_task uuid; v_conv uuid; v_msg uuid;
begin
  perform public.staff_assert_operational();
  if p_kind = 'task_message' then
    select m.task_id into v_task from public.task_messages m where m.id = p_id;
    v_task := coalesce(v_task, p_task);
    if v_task is null then raise exception 'This reply could not be matched to a chat'; end if;
    v_conv := public.chat_open_task(v_task);
    select cm.id into v_msg from public.chat_messages cm where cm.legacy_source_type = 'task_message' and cm.legacy_source_id = p_id and cm.conversation_id = v_conv;
    return jsonb_build_object('conversation_id', v_conv, 'message_id', v_msg, 'task_id', v_task);
  elsif p_kind = 'task' then return jsonb_build_object('conversation_id', public.chat_open_task(p_id), 'task_id', p_id);
  elsif p_kind = 'project' then return jsonb_build_object('conversation_id', public.chat_open_project(p_id), 'project_id', p_id);
  elsif p_kind = 'job_card' then return jsonb_build_object('conversation_id', public.chat_open_job(p_id), 'job_card_id', p_id);
  end if;
  raise exception 'Unknown link type';
end $$;

-- grants: callable by signed-in users only (each function re-checks who they are)
revoke all on function public.chat_can_open_project(uuid), public.chat_open_project(uuid), public.chat_search_projects(text), public.chat_project_tasks(uuid),
  public.chat_link_message_task(uuid, uuid), public.chat_task_unread_counts(), public.chat_resolve_legacy(text, uuid, uuid), public.chat_sync_project(uuid) from public, anon;
grant execute on function public.chat_can_open_project(uuid), public.chat_open_project(uuid), public.chat_search_projects(text), public.chat_project_tasks(uuid),
  public.chat_link_message_task(uuid, uuid), public.chat_task_unread_counts(), public.chat_resolve_legacy(text, uuid, uuid) to authenticated;
-- chat_sync_project is internal (triggers / migration) -- not callable by clients
