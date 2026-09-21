-- v2_89c -- read side of the redesign: chat list, unread, search, details, task references. Every query is scope-aware
-- (a task-scoped member never sees, counts, previews or searches messages of tasks they are not on).

create or replace function public.chat_list_conversations(p_types text[] default null, p_unread_only boolean default false, p_conversation uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_out jsonb;
begin
  perform public.staff_assert_operational();
  select coalesce(jsonb_agg(x.o order by x.ts desc), '[]'::jsonb) into v_out from (
    select jsonb_build_object(
        'id', c.id, 'type', c.type,
        'title', case when c.type = 'direct' then coalesce(peer.full_name, c.title) else c.title end,
        'peer_id', peer.id, 'department', d.name_en, 'is_active', c.is_active, 'muted', p.muted, 'scope', p.scope,
        'last_message_at', lm.created_at, 'sort_at', coalesce(lm.created_at, c.created_at), 'last_message_preview', lm.preview,
        'last_sender', ls.full_name, 'last_task_number', lm.task_number, 'unread', u.n,
        'task_id', c.task_id, 'job_card_id', c.job_card_id, 'project_id', c.project_id,
        'project_code', case when c.type = 'project' then pj.project_code end, 'client', case when c.type = 'project' then pj.customer end,
        'site', case when c.type = 'project' then pj.location end, 'stage', case when c.type = 'project' then pj.stage end
      ) as o, coalesce(lm.created_at, c.created_at) as ts
    from public.chat_participants p
    join public.chat_conversations c on c.id = p.conversation_id
    left join public.departments d on d.id = c.department_id
    left join public.projects pj on pj.id = c.project_id and c.type = 'project'
    left join lateral (select up.id, up.full_name from public.chat_participants p2 join public.user_profiles up on up.id = p2.user_id
                       where c.type = 'direct' and p2.conversation_id = c.id and p2.user_id <> v_me limit 1) peer on true
    left join lateral (select m.created_at, m.sender_id, t.task_number,
                              case when m.deleted_at is not null then 'Message deleted' when m.body <> '' then left(m.body, 80) else '📎 Attachment' end as preview
                         from public.chat_messages m left join public.staff_tasks t on t.id = m.task_id
                        where m.conversation_id = c.id and not m.is_system and public.chat_msg_visible_to(c.id, m.task_id, v_me)
                        order by m.created_at desc, m.id desc limit 1) lm on true
    left join public.user_profiles ls on ls.id = lm.sender_id
    left join lateral (select count(*) as n from public.chat_messages m
                       where m.conversation_id = c.id and m.created_at > coalesce(p.last_read_at, p.joined_at) and m.sender_id is distinct from v_me
                         and not m.is_system and m.deleted_at is null and public.chat_msg_visible_to(c.id, m.task_id, v_me)) u on true
    where p.user_id = v_me and p.left_at is null and c.migration_status is null
      and (p_conversation is null or c.id = p_conversation)
      and (p_types is null or c.type = any (p_types))
      and (not coalesce(p_unread_only, false) or u.n > 0)
      and (c.type <> 'department' or lm.created_at is not null or exists (select 1 from public.chat_participants x where x.conversation_id = c.id and x.left_at is null and x.user_id <> v_me))
  ) x;
  return v_out;
end $$;

create or replace function public.chat_unread_total()
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(sum(u.n), 0)::int from public.chat_participants p
  join public.chat_conversations c on c.id = p.conversation_id and c.migration_status is null
  left join lateral (select count(*) as n from public.chat_messages m where m.conversation_id = c.id and m.created_at > coalesce(p.last_read_at, p.joined_at)
                     and m.sender_id is distinct from auth.uid() and not m.is_system and m.deleted_at is null
                     and public.chat_msg_visible_to(c.id, m.task_id, auth.uid())) u on true
  where public.staff_current_user_ok() and p.user_id = auth.uid() and p.left_at is null and not p.muted;
$$;

-- unread per TASK (task-card badge): standalone task chats + task-referenced messages inside project chats
create or replace function public.chat_task_unread_counts()
returns table(task_id uuid, unread_count bigint) language sql stable security definer set search_path = public as $$
  select t.tid, count(*)::bigint from (
    select c.task_id as tid from public.chat_participants p
      join public.chat_conversations c on c.id = p.conversation_id and c.type in ('task', 'bridge') and c.task_id is not null and c.migration_status is null
      join public.chat_messages m on m.conversation_id = c.id
     where public.staff_current_user_ok() and p.user_id = auth.uid() and p.left_at is null and m.created_at > coalesce(p.last_read_at, p.joined_at)
       and m.sender_id is distinct from auth.uid() and not m.is_system and m.deleted_at is null
    union all
    select m.task_id from public.chat_participants p
      join public.chat_conversations c on c.id = p.conversation_id and c.type = 'project'
      join public.chat_messages m on m.conversation_id = c.id and m.task_id is not null
     where public.staff_current_user_ok() and p.user_id = auth.uid() and p.left_at is null and m.created_at > coalesce(p.last_read_at, p.joined_at)
       and m.sender_id is distinct from auth.uid() and not m.is_system and m.deleted_at is null and public.chat_msg_visible_to(c.id, m.task_id, auth.uid())
  ) t group by t.tid;
$$;

create or replace function public.chat_mark_read(p_conversation uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_latest uuid; v_current uuid;
begin
  if not public.chat_is_participant(p_conversation) then return false; end if;
  select m.id into v_latest from public.chat_messages m
   where m.conversation_id = p_conversation and public.chat_msg_visible_to(m.conversation_id, m.task_id, auth.uid()) order by m.created_at desc, m.id desc limit 1;
  select p.last_read_message_id into v_current from public.chat_participants p where p.conversation_id = p_conversation and p.user_id = auth.uid();
  if v_latest is null or v_latest is not distinct from v_current then return false; end if;
  update public.chat_participants set last_read_at = now(), last_read_message_id = v_latest where conversation_id = p_conversation and user_id = auth.uid();
  update public.notifications set is_read = true, read_at = now() where recipient_id = auth.uid() and entity_type = 'CHAT' and entity_id = p_conversation and not is_read;
  return true;
end $$;

create or replace function public.chat_search_messages(p_query text, p_conversation uuid default null, p_limit integer default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_q text := btrim(coalesce(p_query, ''));
begin
  perform public.staff_assert_operational();
  if char_length(v_q) < 2 then return '[]'::jsonb; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'conversation_id', m.conversation_id, 'conversation_title',
            case when c.type = 'direct' then coalesce((select up.full_name from public.chat_participants p2 join public.user_profiles up on up.id = p2.user_id where p2.conversation_id = c.id and p2.user_id <> auth.uid() limit 1), c.title) else c.title end,
            'sender', up.full_name, 'created_at', m.created_at, 'body', left(m.body, 200), 'task_id', m.task_id, 'task_number', t.task_number) order by m.created_at desc), '[]'::jsonb)
    from (select * from public.chat_messages mm where mm.deleted_at is null and not mm.is_system and mm.body ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%'
            and public.chat_can_read_msg(mm.conversation_id, mm.task_id) and (p_conversation is null or mm.conversation_id = p_conversation)
          order by mm.created_at desc limit least(greatest(coalesce(p_limit, 30), 1), 100)) m
    join public.chat_conversations c on c.id = m.conversation_id left join public.user_profiles up on up.id = m.sender_id left join public.staff_tasks t on t.id = m.task_id);
end $$;

create or replace function public.chat_conversation_details(p_conversation uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c public.chat_conversations%rowtype; v_me uuid := auth.uid(); v_parts jsonb; v_ctx jsonb := '{}'::jsonb; v_can boolean; v_manage boolean; v_peer text; v_scope text; v_my_tasks uuid[];
begin
  if not public.chat_is_participant(p_conversation) then raise exception 'Conversation not found'; end if;
  select * into c from public.chat_conversations where id = p_conversation;
  if c.migration_status = 'migrated' then   -- the old per-task conversation: the client redirects to the project chat
    return jsonb_build_object('id', c.id, 'type', c.type, 'title', c.title, 'is_active', false, 'migrated_to_conversation_id', c.migrated_to_conversation_id,
      'task_id', c.task_id, 'participants', '[]'::jsonb, 'context', '{}'::jsonb, 'i_can_post', false, 'i_can_manage', false, 'notice', null);
  end if;
  select p.scope into v_scope from public.chat_participants p where p.conversation_id = p_conversation and p.user_id = v_me;
  select coalesce(array_agg(tm.task_id), '{}') into v_my_tasks from public.chat_task_members tm where tm.conversation_id = p_conversation and tm.user_id = v_me and tm.left_at is null;
  select coalesce(jsonb_agg(jsonb_build_object('user_id', p.user_id, 'name', up.full_name, 'employee_code', up.employee_code, 'department', d.name_en,
           'role_label', ro.name_en, 'chat_role', p.role, 'scope', p.scope, 'active', p.left_at is null and up.is_active, 'joined_at', p.joined_at, 'left_at', p.left_at) order by up.full_name), '[]'::jsonb)
    into v_parts from public.chat_participants p join public.user_profiles up on up.id = p.user_id
    join public.roles ro on ro.id = up.role_id left join public.departments d on d.id = up.department_id
    where p.conversation_id = p_conversation
      and (v_scope = 'full' or p.user_id = v_me or exists (select 1 from public.chat_task_members tm where tm.conversation_id = p_conversation and tm.user_id = p.user_id and tm.left_at is null and tm.task_id = any (v_my_tasks)));
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
    'my_scope', coalesce(v_scope, 'full'), 'my_task_ids', to_jsonb(v_my_tasks),
    'i_can_post', coalesce(v_can, false), 'i_can_manage', (coalesce(v_manage, false) and v_scope = 'full') or public.staff_is_management() or public.staff_is_super_admin(),
    'notice', case when v_scope = 'task' then 'You can see only the messages about the task(s) you are working on in this project.'
                   when c.management_visible then 'This is a company work conversation and may be visible to authorized Management. Messages are stored on company servers and are not end-to-end encrypted.' else null end);
end $$;

-- the tasks a message can point at (only ones the caller may see)
create or replace function public.chat_task_refs(p_tasks uuid[])
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_assert_operational();
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'task_id', t.id, 'task_number', t.task_number, 'title', t.title, 'status', s.name_en, 'status_code', s.code, 'priority', pm.name_en, 'due_date', t.due_date,
      'owning_department', dt.name_en, 'from_department', df.name_en, 'is_bridge', t.is_bridge, 'project_id', t.project_id, 'job_card_id', t.job_card_id,
      'source_module', t.source_module, 'primary_assignee', (select u.full_name from public.user_profiles u where u.id = t.assigned_to),
      'second_assignee', (select u.full_name from public.staff_task_assignees a join public.user_profiles u on u.id = a.user_id
                           where a.task_id = t.id and a.is_active and a.user_id is distinct from t.assigned_to limit 1))), '[]'::jsonb)
    from public.staff_tasks t join public.status_master s on s.id = t.status_id
    left join public.priority_master pm on pm.id = t.priority_id left join public.departments dt on dt.id = t.to_department_id left join public.departments df on df.id = t.from_department_id
    where t.id = any (coalesce(p_tasks, '{}'))
      and (public.staff_can_view_task(t) or exists (select 1 from public.chat_task_members tm where tm.task_id = t.id and tm.user_id = auth.uid() and tm.left_at is null)));
end $$;

-- Job Cards of the project the caller may see: a SAFE linked reference (Factory people keep their own job chat; nothing is merged)
create or replace function public.chat_project_jobs(p_project uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_assert_operational();
  if not exists (select 1 from public.chat_conversations c where c.type = 'project' and c.project_id = p_project and public.chat_is_full_participant(c.id)) then raise exception 'Conversation not found'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'job_order_number', r.job_order_number, 'product', r.product_item, 'stage', r.current_stage, 'status', r.factory_status)
            order by r.created_at desc), '[]'::jsonb)
          from public.inhouse_production_requests r where r.project_id = p_project and public.factory_job_visible_row(r));
end $$;

-- old Reply links / old task-chat links -> the project chat with the task as context
create or replace function public.chat_resolve_legacy(p_kind text, p_id uuid, p_task uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_task uuid; r jsonb; v_msg uuid;
begin
  perform public.staff_assert_operational();
  if p_kind = 'task_message' then
    select m.task_id into v_task from public.task_messages m where m.id = p_id;
    v_task := coalesce(v_task, p_task);
    if v_task is null then raise exception 'This reply could not be matched to a chat'; end if;
    r := public.chat_open_task_chat(v_task);
    select cm.id into v_msg from public.chat_messages cm where cm.legacy_source_type = 'task_message' and cm.legacy_source_id = p_id
       and cm.conversation_id = (r ->> 'conversation_id')::uuid and public.chat_msg_visible_to(cm.conversation_id, cm.task_id, auth.uid());
    return r || jsonb_build_object('message_id', v_msg);
  elsif p_kind = 'task' then return public.chat_open_task_chat(p_id);
  elsif p_kind = 'project' then return jsonb_build_object('conversation_id', public.chat_open_project(p_id), 'project_id', p_id);
  elsif p_kind = 'job_card' then return jsonb_build_object('conversation_id', public.chat_open_job(p_id), 'job_card_id', p_id);
  end if;
  raise exception 'Unknown link type';
end $$;

-- delete: a message you cannot read cannot be deleted
do $$
declare v_old text; v_new text;
begin
  v_old := pg_get_functiondef('public.chat_delete_message(uuid, text)'::regprocedure);
  v_new := replace(v_old, 'not public.chat_is_participant(m.conversation_id)', 'not public.chat_can_read_msg(m.conversation_id, m.task_id)');
  if v_new = v_old then raise exception 'chat_delete_message patch did not apply'; end if;
  execute v_new;
  v_old := pg_get_functiondef('public.chat_management_directory(text, text)'::regprocedure);
  v_new := replace(v_old, 'where cc.management_visible and cc.type <> ''ai_assistant''', 'where cc.management_visible and cc.type <> ''ai_assistant'' and cc.migration_status is null');
  if v_new = v_old then raise exception 'chat_management_directory patch did not apply'; end if;
  execute v_new;
end $$;

-- task events ("accepted", "reassigned" ...) land in the project chat, referenced to the task, for project tasks
create or replace function public.staff_post_system_task_message(p_task_id uuid, p_text_en text, p_text_gu text)
returns void language plpgsql security definer set search_path = public as $$
declare tk public.staff_tasks%rowtype; v_conv uuid;
begin
  select * into tk from public.staff_tasks where id = p_task_id;
  if tk.id is null then return; end if;
  if public.chat_task_uses_project_chat(tk) then
    select id into v_conv from public.chat_conversations where type = 'project' and project_id = tk.project_id;
    if v_conv is null then v_conv := public.chat_sync_project(tk.project_id); end if;
    if v_conv is null then return; end if;
    insert into public.chat_messages (conversation_id, sender_id, body, is_system, context, project_id, task_id, job_card_id, daily_update_id)
    values (v_conv, auth.uid(), left(p_text_en || ' / ' || p_text_gu, 4000), true, jsonb_build_object('source', 'task_event'), tk.project_id, tk.id, tk.job_card_id,
            case when tk.source_module = 'daily_site_update' then tk.source_site_report_id end);
  else
    select id into v_conv from public.chat_conversations where task_id = p_task_id and type in ('task', 'bridge');
    if v_conv is null then v_conv := public.chat_sync_task(p_task_id); end if;
    if v_conv is null then return; end if;
    insert into public.chat_messages (conversation_id, sender_id, body, is_system, context, task_id)
    values (v_conv, auth.uid(), left(p_text_en || ' / ' || p_text_gu, 4000), true, jsonb_build_object('source', 'task_event'), tk.id);
  end if;
end $$;

revoke all on function public.chat_task_refs(uuid[]), public.chat_project_jobs(uuid) from public, anon;
grant execute on function public.chat_task_refs(uuid[]), public.chat_project_jobs(uuid) to authenticated;
