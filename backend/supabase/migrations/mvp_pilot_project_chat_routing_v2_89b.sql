-- v2_89b -- routing (Project Task -> Project chat), opening a Task's chat, and sending task-referenced messages.

-- who belongs to a task (creator, assignees, verifier, destination / source department heads)
create or replace function public.chat_task_member_rows(tk public.staff_tasks)
returns table(uid uuid, role text, pr int) language sql stable security definer set search_path = public as $$
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
  )
  select distinct on (c.uid) c.uid, c.role, c.pr from c join public.user_profiles up on up.id = c.uid and up.is_active
  where c.uid is not null order by c.uid, c.pr;
$$;

-- project team reconciliation, now followed by the task-scoped members
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
  perform public.chat_refresh_scoped(v_conv);
  return v_conv;
end $$;

-- a Project Task: ONE conversation per project. Its people become task members (task-scoped access unless they are on the project team).
create or replace function public.chat_sync_task_in_project(tk public.staff_tasks, p_auto_migrate boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_conv uuid; r record; v_old uuid;
begin
  v_conv := public.chat_sync_project(tk.project_id);
  if v_conv is null then return null; end if;
  for r in select * from public.chat_task_member_rows(tk) loop
    insert into public.chat_task_members (task_id, user_id, conversation_id, role, reason) values (tk.id, r.uid, v_conv, r.role, 'task participant')
    on conflict (task_id, user_id) do update
      set conversation_id = excluded.conversation_id, left_at = null,
          role = case when public.chat_task_members.reason like 'manual%' then public.chat_task_members.role else excluded.role end;
  end loop;
  update public.chat_task_members set left_at = now()
   where task_id = tk.id and left_at is null and reason not like 'manual%' and user_id not in (select uid from public.chat_task_member_rows(tk));
  perform public.chat_refresh_scoped(v_conv);
  if p_auto_migrate then   -- a task that just GOT a project: fold its old standalone conversation into the project chat
    select id into v_old from public.chat_conversations where task_id = tk.id and type in ('task', 'bridge') and migration_status is null;
    if v_old is not null then perform public.chat_migrate_task_chat(v_old); end if;
  end if;
  return v_conv;
end $$;

-- the routing rule: task.project_id -> project chat; otherwise the standalone task conversation
create or replace function public.chat_sync_task(p_task uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare tk public.staff_tasks%rowtype; v_conv uuid; v_type text; v_restricted boolean; v_users uuid[]; v_roles text[];
begin
  select * into tk from public.staff_tasks where id = p_task;
  if tk.id is null then return null; end if;
  if public.chat_task_uses_project_chat(tk) then return public.chat_sync_task_in_project(tk, true); end if;
  v_type := case when tk.is_bridge then 'bridge' else 'task' end;
  insert into public.chat_conversations (type, title, task_id, created_by, department_id, is_active, archived_at, project_id)
  values (v_type, tk.task_number || ' — ' || tk.title, tk.id, tk.assigned_by, tk.to_department_id, tk.is_active, case when tk.is_active then null else now() end, tk.project_id)
  on conflict (task_id) where type in ('task', 'bridge') do update
    set title = excluded.title, type = excluded.type, department_id = excluded.department_id, is_active = excluded.is_active, project_id = excluded.project_id,
        archived_at = case when excluded.is_active then null else coalesce(public.chat_conversations.archived_at, now()) end
  returning id into v_conv;
  v_restricted := exists (select 1 from public.departments d where d.id in (tk.from_department_id, tk.to_department_id) and d.is_confidential_domain);
  select array_agg(m.uid), array_agg(m.role) into v_users, v_roles from public.chat_task_member_rows(tk) m where (not v_restricted or public.chat_conf_ok(m.uid));
  perform public.chat_reconcile(v_conv, coalesce(v_users, '{}'), coalesce(v_roles, '{}'), case when tk.is_bridge then 'bridge task participant' else 'task participant' end);
  return v_conv;
end $$;

-- the Chat button on a task: returns WHERE to go (a project chat + the task as context, or the standalone task chat)
create or replace function public.chat_open_task_chat(p_task uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare tk public.staff_tasks%rowtype; v_conv uuid; v_role text := public.staff_current_role_code();
begin
  perform public.staff_assert_operational();
  select * into tk from public.staff_tasks where id = p_task;
  if tk.id is null or not public.staff_can_view_task(tk) then raise exception 'Task not found or you do not have access'; end if;
  v_conv := public.chat_sync_task(p_task);
  if v_conv is null then raise exception 'Task not found or you do not have access'; end if;
  if public.chat_task_uses_project_chat(tk) then
    -- being able to VIEW a task never opens the whole project timeline: only the project team / leadership get that
    if not public.chat_is_full_participant(v_conv)
       and not exists (select 1 from public.chat_task_members tm where tm.task_id = tk.id and tm.user_id = auth.uid() and tm.left_at is null) then
      if public.chat_can_open_project(tk.project_id) then
        perform public.chat_open_project(tk.project_id);
      elsif v_role in ('dept_head', 'supervisor', 'management', 'sysadmin') then
        insert into public.chat_task_members (task_id, user_id, conversation_id, role, reason)
        values (tk.id, auth.uid(), v_conv, case v_role when 'dept_head' then 'department_head' when 'supervisor' then 'supervisor' else 'management' end, 'manual: opened from task')
        on conflict (task_id, user_id) do update set left_at = null, conversation_id = excluded.conversation_id;
        perform public.chat_upsert_scoped(v_conv, auth.uid(), 'manual: opened from task');
      else
        raise exception 'Chat is limited to the people working on this task';
      end if;
    end if;
    return jsonb_build_object('conversation_id', v_conv, 'project_id', tk.project_id, 'task_id', tk.id, 'mode', 'project');
  end if;
  if not public.chat_is_participant(v_conv) then
    if v_role in ('dept_head', 'supervisor', 'management', 'sysadmin') then
      perform public.chat_upsert_participant(v_conv, auth.uid(), case v_role when 'dept_head' then 'department_head' when 'supervisor' then 'supervisor' else 'management' end, 'manual: opened from task');
    else
      raise exception 'Chat is limited to the people working on this task';
    end if;
  end if;
  return jsonb_build_object('conversation_id', v_conv, 'project_id', tk.project_id, 'task_id', tk.id, 'mode', 'task');
end $$;

create or replace function public.chat_open_task(p_task uuid)
returns uuid language sql security definer set search_path = public as $$
  select (public.chat_open_task_chat(p_task) ->> 'conversation_id')::uuid;
$$;

-- project-level RPCs: "member" means FULL member (a task-scoped assignee never opens the whole project)
do $$
declare v_name text; v_old text; v_new text;
begin
  foreach v_name in array array['chat_can_open_project(uuid)', 'chat_open_project(uuid)', 'chat_search_projects(text)', 'chat_project_tasks(uuid)', 'chat_link_message_task(uuid, uuid)'] loop
    v_old := pg_get_functiondef(('public.' || v_name)::regprocedure);
    v_new := replace(v_old, 'public.chat_is_participant(', 'public.chat_is_full_participant(');
    v_new := replace(v_new, 'if c.type <> ''project'' or not public.chat_can_post(c.id) then', 'if c.type <> ''project'' or not public.chat_can_post(c.id) or not public.chat_is_full_participant(c.id) then');
    if v_new <> v_old then execute v_new; end if;
  end loop;
end $$;

-- ============ send: a message may reference the task / job card / daily update it is about ============
drop function if exists public.chat_send_message(uuid, text, uuid, uuid[], jsonb);
create or replace function public.chat_send_message(
  p_conversation uuid, p_body text default '', p_reply_to uuid default null, p_mentions uuid[] default '{}', p_attachments jsonb default '[]'::jsonb,
  p_task uuid default null, p_job uuid default null, p_daily uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid(); v_body text := btrim(coalesce(p_body, '')); v_conv public.chat_conversations%rowtype; v_id uuid; v_name text;
  v_ment uuid[]; a jsonb; v_obj record; v_reply_sender uuid; v_scope text; tk public.staff_tasks%rowtype; v_task uuid; v_job uuid; v_daily uuid; v_taskno text; r record;
  v_att_ok text[] := array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv','application/dxf','application/dwg',
    'image/vnd.dwg','image/vnd.dxf','application/x-dwg','application/x-dxf','application/acad'];
begin
  perform public.staff_assert_operational();
  if not public.chat_can_post(p_conversation) then raise exception 'You cannot post in this conversation'; end if;
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array' then raise exception 'Invalid attachments'; end if;
  if v_body = '' and jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) = 0 then raise exception 'Write a message or attach a file'; end if;
  if char_length(v_body) > 4000 then raise exception 'Message is too long (4000 characters max)'; end if;
  if jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 5 then raise exception 'At most 5 attachments per message'; end if;
  select * into v_conv from public.chat_conversations where id = p_conversation;
  select scope into v_scope from public.chat_participants where conversation_id = p_conversation and user_id = v_me and left_at is null;
  select full_name into v_name from public.user_profiles where id = v_me;

  -- what is this message about?  (foreign keys only)
  if v_conv.type in ('task', 'bridge') then
    v_task := v_conv.task_id;
  elsif v_conv.type = 'project' then
    if p_task is not null then
      select * into tk from public.staff_tasks where id = p_task;
      if tk.id is null or tk.project_id is distinct from v_conv.project_id then raise exception 'That task does not belong to this project'; end if;
      if v_scope = 'task' then
        if not exists (select 1 from public.chat_task_members tm where tm.conversation_id = p_conversation and tm.task_id = tk.id and tm.user_id = v_me and tm.left_at is null) then
          raise exception 'You are not on that task';
        end if;
      elsif not public.staff_can_view_task(tk) then
        raise exception 'That task is not available to you';
      end if;
      v_task := tk.id; v_job := tk.job_card_id;
      v_daily := case when tk.source_module = 'daily_site_update' then tk.source_site_report_id end;
    elsif v_scope = 'task' then
      raise exception 'Choose the task this message is about';
    else
      if p_job is not null then
        if not exists (select 1 from public.inhouse_production_requests j where j.id = p_job and j.project_id = v_conv.project_id) then raise exception 'That job card is not part of this project'; end if;
        v_job := p_job;
      end if;
      if p_daily is not null then
        if not exists (select 1 from public.site_reports s where s.id = p_daily and s.project_id = v_conv.project_id) then raise exception 'That daily update is not part of this project'; end if;
        v_daily := p_daily;
      end if;
    end if;
  end if;

  if p_reply_to is not null then
    select sender_id into v_reply_sender from public.chat_messages where id = p_reply_to and conversation_id = p_conversation and public.chat_msg_visible_to(conversation_id, task_id, v_me);
    if not found then raise exception 'The message you are replying to is not in this conversation'; end if;
  end if;
  -- mentions: only active participants of THIS conversation who are allowed to see this message
  select coalesce(array_agg(distinct p.user_id), '{}') into v_ment from public.chat_participants p
    where p.conversation_id = p_conversation and p.left_at is null and p.user_id = any (coalesce(p_mentions, '{}')) and p.user_id <> v_me
      and public.chat_msg_visible_to(p_conversation, v_task, p.user_id);

  insert into public.chat_messages (conversation_id, sender_id, body, reply_to_id, mentions, project_id, task_id, job_card_id, daily_update_id)
  values (p_conversation, v_me, v_body, p_reply_to, v_ment, v_conv.project_id, v_task, v_job, v_daily) returning id into v_id;

  for a in select * from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) loop
    if (a ->> 'path') is null or (a ->> 'path') not like (p_conversation::text || '/%') then raise exception 'Attachment path is not valid for this conversation'; end if;
    if not ((a ->> 'mime') = any (v_att_ok)) then raise exception 'This file type is not allowed'; end if;
    select o.metadata into v_obj from storage.objects o where o.bucket_id = 'chat-attachments' and o.name = (a ->> 'path');
    if not found then raise exception 'Uploaded file not found'; end if;
    if (v_obj.metadata ->> 'size')::bigint <> (a ->> 'size')::bigint or (v_obj.metadata ->> 'size')::bigint > 15728640 then raise exception 'Attachment size is not valid'; end if;
    insert into public.chat_message_attachments (message_id, conversation_id, storage_path, file_name, mime_type, file_size, uploaded_by)
    values (v_id, p_conversation, a ->> 'path', left(coalesce(a ->> 'name', 'file'), 200), a ->> 'mime', (a ->> 'size')::bigint, v_me);
  end loop;

  -- a project conversation is read by people with different scopes, so it never stores a conversation-wide preview
  if v_conv.type = 'project' then
    update public.chat_conversations set last_message_at = now() where id = p_conversation;
  else
    update public.chat_conversations set last_message_at = now(), last_message_sender = v_me,
      last_message_preview = case when v_body <> '' then left(v_body, 80) else '📎 Attachment' end where id = p_conversation;
  end if;
  update public.chat_participants set last_read_at = now(), last_read_message_id = v_id where conversation_id = p_conversation and user_id = v_me;

  -- notifications never contain message text; one collapsed unread notification per conversation
  if v_task is not null then select task_number into v_taskno from public.staff_tasks where id = v_task; end if;
  if v_conv.type = 'project' and v_task is not null then
    -- task message: the task's people + anyone mentioned (NOT every project member)
    for r in select u.uid, bool_or(u.mentioned) as mentioned from (
               select tm.user_id as uid, false as mentioned from public.chat_task_members tm
                where tm.conversation_id = p_conversation and tm.task_id = v_task and tm.left_at is null and tm.role <> 'department_head'
               union all select x, true from unnest(v_ment) x) u
             where u.uid <> v_me group by u.uid loop
      perform public.chat_notify(r.uid, p_conversation,
        coalesce(v_name, 'Someone') || case when r.mentioned then ' mentioned you on ' else ' sent a message on ' end || coalesce(v_taskno, 'a task') || ' in ' || v_conv.title,
        coalesce(v_name, 'કોઈએ') || case when r.mentioned then ' એ તમને ઉલ્લેખ કર્યો: ' else ' એ સંદેશ મોકલ્યો: ' end || coalesce(v_taskno, '') || ' · ' || v_conv.title, v_task);
    end loop;
  elsif v_conv.type in ('task', 'bridge', 'job_card', 'project') then
    for r in select p.user_id, (p.user_id = any (v_ment)) as mentioned from public.chat_participants p
             where p.conversation_id = p_conversation and p.left_at is null and p.user_id <> v_me and p.scope = 'full' loop
      perform public.chat_notify(r.user_id, p_conversation,
        coalesce(v_name, 'Someone') || case when r.mentioned then ' mentioned you in ' else ' sent a message in ' end || v_conv.title,
        coalesce(v_name, 'કોઈએ') || case when r.mentioned then ' એ તમને ઉલ્લેખ કર્યો: ' else ' એ સંદેશ મોકલ્યો: ' end || v_conv.title, v_task);
    end loop;
  elsif v_conv.type = 'direct' then
    for r in select user_id from public.chat_participants where conversation_id = p_conversation and left_at is null and user_id <> v_me loop
      perform public.chat_notify(r.user_id, p_conversation, 'New message from ' || coalesce(v_name, 'a colleague'), coalesce(v_name, 'સહકર્મી') || ' તરફથી નવો સંદેશ');
    end loop;
  else
    for r in select unnest(v_ment) as user_id loop
      perform public.chat_notify(r.user_id, p_conversation, coalesce(v_name, 'Someone') || ' mentioned you in ' || v_conv.title, coalesce(v_name, 'કોઈએ') || ' એ તમને ઉલ્લેખ કર્યો: ' || v_conv.title);
    end loop;
  end if;
  if v_reply_sender is not null and v_reply_sender <> v_me and not (v_reply_sender = any (v_ment)) and v_conv.type <> 'direct'
     and public.chat_msg_visible_to(p_conversation, v_task, v_reply_sender) then
    perform public.chat_notify(v_reply_sender, p_conversation, coalesce(v_name, 'Someone') || ' replied to your message in ' || v_conv.title,
      coalesce(v_name, 'કોઈએ') || ' એ તમારા સંદેશનો જવાબ આપ્યો: ' || v_conv.title, v_task);
  end if;
  return v_id;
end $$;
revoke all on function public.chat_send_message(uuid, text, uuid, uuid[], jsonb, uuid, uuid, uuid) from public, anon;
grant execute on function public.chat_send_message(uuid, text, uuid, uuid[], jsonb, uuid, uuid, uuid) to authenticated;
revoke all on function public.chat_task_member_rows(public.staff_tasks), public.chat_sync_task_in_project(public.staff_tasks, boolean) from public, anon, authenticated;
revoke all on function public.chat_open_task_chat(uuid), public.chat_open_task(uuid) from public, anon;
grant execute on function public.chat_open_task_chat(uuid), public.chat_open_task(uuid) to authenticated;
