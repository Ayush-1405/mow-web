-- v2_89a -- Project-linked Tasks live in the canonical PROJECT chat (no separate Task conversation).  PHASE A: schema + access rules.
--
-- Routing rule (foreign keys only, never names):   task.project_id is not null  ->  the Project's ONE canonical conversation
--                                                  otherwise                    ->  the standalone Task conversation (unchanged)
-- A task in a confidential-domain department (Accounts) keeps its own restricted conversation even when it has a project.
--
-- Two kinds of membership in a project conversation:
--   scope = 'full'  the project team / authorized leadership: reads the whole project timeline
--   scope = 'task'  a task assignee who is NOT on the project team: reads ONLY messages that reference a task they are on
-- Both are enforced by RLS on chat_messages / chat_message_attachments / storage, never only by the UI.

-- ---- participants ----
alter table public.chat_participants add column if not exists scope text not null default 'full';
alter table public.chat_participants drop constraint if exists chat_participants_scope_check;
alter table public.chat_participants add constraint chat_participants_scope_check check (scope in ('full', 'task'));

-- ---- messages: optional links to the record a message is about ----
alter table public.chat_messages add column if not exists project_id uuid references public.projects(id) on delete set null;
alter table public.chat_messages add column if not exists task_id uuid references public.staff_tasks(id) on delete set null;
alter table public.chat_messages add column if not exists job_card_id uuid references public.inhouse_production_requests(id) on delete set null;
alter table public.chat_messages add column if not exists daily_update_id uuid references public.site_reports(id) on delete set null;
alter table public.chat_messages add column if not exists has_attachments boolean not null default false;
alter table public.chat_messages add column if not exists migrated_from_conversation_id uuid;  -- where a moved message used to live (audit + undo)
alter table public.chat_messages add column if not exists migrated_at timestamptz;
create index if not exists chat_msg_task_idx on public.chat_messages (conversation_id, task_id, created_at desc) where task_id is not null;
create index if not exists chat_msg_files_idx on public.chat_messages (conversation_id, created_at desc) where has_attachments;
create index if not exists chat_msg_migrated_idx on public.chat_messages (migrated_from_conversation_id) where migrated_from_conversation_id is not null;

update public.chat_messages m set has_attachments = true where not m.has_attachments and exists (select 1 from public.chat_message_attachments a where a.message_id = m.id);
create or replace function public.chat_att_flag() returns trigger language plpgsql security definer set search_path = public as $$
begin update public.chat_messages set has_attachments = true where id = new.message_id and not has_attachments; return new; end $$;
drop trigger if exists trg_chat_att_flag on public.chat_message_attachments;
create trigger trg_chat_att_flag after insert on public.chat_message_attachments for each row execute function public.chat_att_flag();

-- ---- conversations: migration trail for the old per-task conversations ----
alter table public.chat_conversations add column if not exists migration_status text;
alter table public.chat_conversations drop constraint if exists chat_conversations_migration_status_check;
alter table public.chat_conversations add constraint chat_conversations_migration_status_check check (migration_status is null or migration_status = 'migrated');
alter table public.chat_conversations add column if not exists migrated_to_conversation_id uuid references public.chat_conversations(id);
alter table public.chat_conversations add column if not exists migrated_at timestamptz;

-- ---- who is on which task of a project conversation (drives task-scoped access + task notifications) ----
create table if not exists public.chat_task_members (
  task_id uuid not null references public.staff_tasks(id) on delete cascade,
  user_id uuid not null references public.user_profiles(id),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  role text not null default 'member',
  reason text not null default 'task participant',
  added_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (task_id, user_id)
);
create index if not exists chat_task_members_conv_idx on public.chat_task_members (conversation_id, user_id) where left_at is null;
alter table public.chat_task_members enable row level security;
revoke all on public.chat_task_members from anon, authenticated;   -- SECURITY DEFINER code only; RLS helpers read it as the function owner

-- ================= access helpers =================
create or replace function public.chat_task_uses_project_chat(tk public.staff_tasks)
returns boolean language sql stable security definer set search_path = public as $$
  select tk.project_id is not null
    and exists (select 1 from public.projects p where p.id = tk.project_id)
    and not exists (select 1 from public.departments d where d.id in (tk.from_department_id, tk.to_department_id) and d.is_confidential_domain);
$$;

create or replace function public.chat_is_full_participant(p_conv uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.staff_current_user_ok() and exists (
    select 1 from public.chat_participants p where p.conversation_id = p_conv and p.user_id = auth.uid() and p.left_at is null and p.scope = 'full');
$$;

-- can THIS user see a message that belongs to (conversation, task)?  full members: yes.  task-scoped members: only their own tasks.
create or replace function public.chat_msg_visible_to(p_conv uuid, p_task uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.chat_participants p where p.conversation_id = p_conv and p.user_id = p_user and p.left_at is null
      and (p.scope = 'full' or (p_task is not null and exists (
        select 1 from public.chat_task_members tm where tm.conversation_id = p_conv and tm.task_id = p_task and tm.user_id = p_user and tm.left_at is null))));
$$;

create or replace function public.chat_can_read_msg(p_conv uuid, p_task uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.staff_current_user_ok() and public.chat_msg_visible_to(p_conv, p_task, auth.uid());
$$;

-- ================= RLS =================
drop policy if exists chat_messages_select on public.chat_messages;
create policy chat_messages_select on public.chat_messages for select to authenticated using (public.chat_can_read_msg(conversation_id, task_id));

drop policy if exists chat_attachments_select on public.chat_message_attachments;
create policy chat_attachments_select on public.chat_message_attachments for select to authenticated using (
  exists (select 1 from public.chat_messages m where m.id = chat_message_attachments.message_id and m.deleted_at is null and public.chat_can_read_msg(m.conversation_id, m.task_id)));

-- a task-scoped member sees only their own row; full members see everyone (read markers, member list)
drop policy if exists chat_participants_select on public.chat_participants;
create policy chat_participants_select on public.chat_participants for select to authenticated using (user_id = auth.uid() or public.chat_is_full_participant(conversation_id));

-- storage: files are keyed by the conversation they were UPLOADED in; a moved message keeps its file, so read access follows the MESSAGE
drop policy if exists chat_attachments_storage_select on storage.objects;
create policy chat_attachments_storage_select on storage.objects for select to authenticated using (
  bucket_id = 'chat-attachments' and (
    exists (select 1 from public.chat_message_attachments a join public.chat_messages m on m.id = a.message_id
             where a.storage_path = storage.objects.name and a.bucket = 'chat-attachments' and m.deleted_at is null and public.chat_can_read_msg(m.conversation_id, m.task_id))
    or ((storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and public.chat_is_full_participant(((storage.foldername(name))[1])::uuid))));

-- ================= membership functions =================
create or replace function public.chat_upsert_participant(p_conv uuid, p_user uuid, p_role text, p_reason text, p_can_post boolean default true, p_manage boolean default false)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_ex public.chat_participants%rowtype; v_conv public.chat_conversations%rowtype; v_added boolean := false;
begin
  if p_user is null or not exists (select 1 from public.user_profiles where id = p_user and is_active) then return false; end if;
  select * into v_ex from public.chat_participants where conversation_id = p_conv and user_id = p_user;
  if v_ex.user_id is null then
    insert into public.chat_participants (conversation_id, user_id, role, added_by, added_reason, can_post, can_manage, can_add_members, last_read_at, scope)
    values (p_conv, p_user, p_role, auth.uid(), p_reason, p_can_post, p_manage, p_manage, now(), 'full');
    perform public.chat_audit(p_conv, p_user, 'added', p_reason, auth.uid());
    v_added := true;
  elsif v_ex.left_at is not null then
    update public.chat_participants set left_at = null, role = p_role, can_post = p_can_post, can_manage = p_manage, can_add_members = p_manage, scope = 'full',
      joined_at = now(), last_read_at = now(), added_by = auth.uid(), added_reason = p_reason
      where conversation_id = p_conv and user_id = p_user;
    perform public.chat_audit(p_conv, p_user, 'rejoined', p_reason, auth.uid());
    v_added := true;
  elsif v_ex.role is distinct from p_role or v_ex.can_post is distinct from p_can_post or v_ex.scope <> 'full' then
    update public.chat_participants set role = p_role, can_post = p_can_post, scope = 'full' where conversation_id = p_conv and user_id = p_user;
    perform public.chat_audit(p_conv, p_user, case when v_ex.scope <> 'full' then 'promoted_to_full' else 'role_changed' end, p_role, auth.uid());
  end if;
  if v_added then
    select * into v_conv from public.chat_conversations where id = p_conv;
    if v_conv.type in ('job_card', 'bridge') or (v_conv.type = 'task' and v_conv.created_at < now() - interval '2 minutes') then
      perform public.chat_notify(p_user, p_conv, 'You were added to a work chat: ' || v_conv.title, 'તમને વર્ક ચેટમાં ઉમેરવામાં આવ્યા: ' || v_conv.title);
    end if;
  end if;
  return v_added;
end $$;

create or replace function public.chat_upsert_scoped(p_conv uuid, p_user uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_ex public.chat_participants%rowtype;
begin
  if p_user is null or not exists (select 1 from public.user_profiles where id = p_user and is_active) then return false; end if;
  select * into v_ex from public.chat_participants where conversation_id = p_conv and user_id = p_user;
  if v_ex.user_id is null then
    insert into public.chat_participants (conversation_id, user_id, role, added_by, added_reason, can_post, can_manage, can_add_members, last_read_at, scope)
    values (p_conv, p_user, 'member', auth.uid(), p_reason, true, false, false, now(), 'task');
    perform public.chat_audit(p_conv, p_user, 'added', 'task-scoped: ' || p_reason, auth.uid());
    return true;
  elsif v_ex.left_at is not null then
    update public.chat_participants set left_at = null, role = 'member', can_post = true, can_manage = false, can_add_members = false, scope = 'task',
      joined_at = now(), last_read_at = now(), added_by = auth.uid(), added_reason = p_reason where conversation_id = p_conv and user_id = p_user;
    perform public.chat_audit(p_conv, p_user, 'rejoined', 'task-scoped: ' || p_reason, auth.uid());
    return true;
  end if;
  return false;   -- already an active member (full or scoped): never downgrade
end $$;

-- project team reconciliation must leave task-scoped members alone (they are managed by chat_refresh_scoped)
create or replace function public.chat_reconcile(p_conv uuid, p_users uuid[], p_roles text[], p_reason text, p_keep_management boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare i int; r record;
begin
  for i in 1 .. coalesce(array_length(p_users, 1), 0) loop
    perform public.chat_upsert_participant(p_conv, p_users[i], p_roles[i], p_reason);
  end loop;
  for r in select user_id from public.chat_participants
           where conversation_id = p_conv and left_at is null and scope = 'full' and not (user_id = any (coalesce(p_users, '{}')))
             and not (p_keep_management and role = 'management') and coalesce(added_reason, '') not like 'manual%' loop
    perform public.chat_remove_participant(p_conv, r.user_id, 'no longer eligible');
  end loop;
end $$;

-- keep task-scoped members in step with chat_task_members
create or replace function public.chat_refresh_scoped(p_conv uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if not exists (select 1 from public.chat_conversations where id = p_conv and type = 'project') then return; end if;
  for r in select distinct tm.user_id from public.chat_task_members tm where tm.conversation_id = p_conv and tm.left_at is null loop
    if not exists (select 1 from public.chat_participants p where p.conversation_id = p_conv and p.user_id = r.user_id and p.left_at is null) then
      perform public.chat_upsert_scoped(p_conv, r.user_id, 'task participant');
    end if;
  end loop;
  for r in select p.user_id from public.chat_participants p
           where p.conversation_id = p_conv and p.scope = 'task' and p.left_at is null and coalesce(p.added_reason, '') not like 'manual%'
             and not exists (select 1 from public.chat_task_members tm where tm.conversation_id = p_conv and tm.user_id = p.user_id and tm.left_at is null) loop
    perform public.chat_remove_participant(p_conv, r.user_id, 'no longer on any task of this project');
  end loop;
end $$;

-- notifications: optional task the message is about (so the click can open the right Task context)
drop function if exists public.chat_notify(uuid, uuid, text, text);
create or replace function public.chat_notify(p_user uuid, p_conv uuid, p_en text, p_gu text, p_task uuid default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.chat_silent() or p_user is null or p_user is not distinct from auth.uid() then return; end if;
  if not exists (select 1 from public.user_profiles where id = p_user and is_active) then return; end if;
  if exists (select 1 from public.chat_participants where conversation_id = p_conv and user_id = p_user and (muted or left_at is not null)) then return; end if;
  if exists (select 1 from public.notifications n where n.recipient_id = p_user and n.entity_type = 'CHAT' and n.entity_id = p_conv and not n.is_read) then return; end if;
  insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu) values (p_user, 'CHAT', p_conv, p_task, p_en, p_gu);
end $$;

revoke all on function public.chat_task_uses_project_chat(public.staff_tasks), public.chat_upsert_scoped(uuid, uuid, text), public.chat_refresh_scoped(uuid) from public, anon, authenticated;
revoke all on function public.chat_is_full_participant(uuid), public.chat_msg_visible_to(uuid, uuid, uuid), public.chat_can_read_msg(uuid, uuid) from public, anon, authenticated;
grant execute on function public.chat_is_full_participant(uuid), public.chat_can_read_msg(uuid, uuid) to authenticated;   -- evaluated inside RLS as the caller
-- chat_msg_visible_to takes an arbitrary user id, so clients can never call it (RLS reaches it only through chat_can_read_msg, as the function owner)
revoke all on function public.chat_notify(uuid, uuid, text, text, uuid) from public, anon, authenticated;
