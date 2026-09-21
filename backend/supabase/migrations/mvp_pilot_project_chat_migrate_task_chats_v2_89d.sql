-- v2_89d -- fold every existing Project-linked Task conversation into its canonical Project chat. Safe to run any number of times.
--
--  * messages are MOVED (same id, author, text, created_at, edit / delete state, mentions, reply-to, attachments) and gain task_id / project_id /
--    job_card_id / daily_update_id; nothing is copied, so nothing can be duplicated, and each keeps `migrated_from_conversation_id`
--  * the old conversation is kept, archived and read-only: migration_status = 'migrated', migrated_to_conversation_id = <project chat>
--  * users keep their read position (no unread inflation); old CHAT notifications are re-pointed (no new ones are created)
--  * chat_undo_task_chat_migration(old_conversation) puts everything back
-- Not callable from the browser.

create or replace function public.chat_migrate_task_chat(p_conv uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.chat_conversations%rowtype; tk public.staff_tasks%rowtype; v_dest uuid; n_msgs int := 0; n_atts int := 0; v_max timestamptz;
begin
  perform set_config('app.chat_silent', '1', true);
  select * into c from public.chat_conversations where id = p_conv;
  if c.id is null or c.type not in ('task', 'bridge') or c.task_id is null then return jsonb_build_object('status', 'skipped', 'reason', 'not a task conversation'); end if;
  if c.migration_status = 'migrated' then return jsonb_build_object('status', 'already_migrated', 'destination', c.migrated_to_conversation_id); end if;
  select * into tk from public.staff_tasks where id = c.task_id;
  if tk.id is null or not public.chat_task_uses_project_chat(tk) then return jsonb_build_object('status', 'skipped', 'reason', 'standalone or restricted task keeps its own chat'); end if;
  begin
    v_dest := public.chat_sync_task_in_project(tk, false);
    if v_dest is null then raise exception 'no project conversation for task %', tk.id; end if;

    -- read state: an existing member keeps the position they had in the old chat; anyone new starts caught up (no unread inflation)
    update public.chat_participants d set last_read_at = greatest(coalesce(d.last_read_at, d.joined_at),
        coalesce((select coalesce(o.last_read_at, o.joined_at) from public.chat_participants o where o.conversation_id = c.id and o.user_id = d.user_id),
                 (select max(m.created_at) from public.chat_messages m where m.conversation_id = c.id)))
      where d.conversation_id = v_dest and d.left_at is null;

    update public.chat_messages set conversation_id = v_dest, project_id = tk.project_id, task_id = tk.id, job_card_id = tk.job_card_id,
           daily_update_id = case when tk.source_module = 'daily_site_update' then tk.source_site_report_id end,
           migrated_from_conversation_id = c.id, migrated_at = now()
     where conversation_id = c.id;
    get diagnostics n_msgs = row_count;
    update public.chat_message_attachments set conversation_id = v_dest where conversation_id = c.id;
    get diagnostics n_atts = row_count;

    select max(created_at) into v_max from public.chat_messages where conversation_id = v_dest and not is_system and deleted_at is null;
    update public.chat_conversations set last_message_at = greatest(last_message_at, v_max) where id = v_dest;
    update public.chat_conversations set is_active = false, archived_at = coalesce(archived_at, now()), migration_status = 'migrated', migrated_to_conversation_id = v_dest, migrated_at = now()
     where id = c.id;
    insert into public.chat_legacy_audit (event, legacy_type, legacy_id, conversation_id, detail)
    values ('task_chat_migrated', 'task_conversation', c.id, v_dest,
            jsonb_build_object('task_id', tk.id, 'task_number', tk.task_number, 'project_id', tk.project_id, 'messages', n_msgs, 'attachments', n_atts, 'was_bridge', c.type = 'bridge'));
    return jsonb_build_object('status', 'migrated', 'destination', v_dest, 'messages', n_msgs, 'attachments', n_atts);
  exception when others then
    insert into public.chat_legacy_audit (event, legacy_type, legacy_id, detail)
    values ('task_chat_migration_failed', 'task_conversation', c.id, jsonb_build_object('task_id', c.task_id, 'reason', left(sqlerrm, 300)));
    return jsonb_build_object('status', 'failed', 'reason', left(sqlerrm, 200));
  end;
end $$;

create or replace function public.chat_migrate_project_task_chats()
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; res jsonb; n_total int; n_new int := 0; n_dup int := 0; n_skip int := 0; n_fail int := 0; m_new int := 0; a_new int := 0; n_notif int := 0; v_report jsonb; v_failed jsonb := '[]'::jsonb;
begin
  perform set_config('app.chat_silent', '1', true);
  select count(*) into n_total from public.chat_conversations c join public.staff_tasks t on t.id = c.task_id
   where c.type in ('task', 'bridge') and public.chat_task_uses_project_chat(t);
  for r in select c.id from public.chat_conversations c join public.staff_tasks t on t.id = c.task_id
            where c.type in ('task', 'bridge') and public.chat_task_uses_project_chat(t) order by c.created_at, c.id loop
    res := public.chat_migrate_task_chat(r.id);
    case res ->> 'status'
      when 'migrated' then n_new := n_new + 1; m_new := m_new + (res ->> 'messages')::int; a_new := a_new + (res ->> 'attachments')::int;
      when 'already_migrated' then n_dup := n_dup + 1;
      when 'failed' then n_fail := n_fail + 1; v_failed := v_failed || jsonb_build_array(jsonb_build_object('conversation', r.id, 'reason', res ->> 'reason'));
      else n_skip := n_skip + 1;
    end case;
  end loop;

  -- unread CHAT notifications that pointed at an archived task chat now open the project chat (re-pointed, none created)
  update public.notifications n set entity_id = c.migrated_to_conversation_id, task_id = coalesce(n.task_id, c.task_id)
    from public.chat_conversations c where n.entity_type = 'CHAT' and n.entity_id = c.id and c.migration_status = 'migrated';
  get diagnostics n_notif = row_count;

  v_report := jsonb_build_object(
    'type', 'task_chat_migration', 'ran_at', now(),
    'project_task_conversations_total', n_total, 'migrated_this_run', n_new, 'already_migrated_skipped', n_dup, 'skipped_other', n_skip, 'failed', n_fail, 'failures', v_failed,
    'migrated_total', (select count(*) from public.chat_conversations where migration_status = 'migrated'),
    'messages_moved_this_run', m_new, 'attachments_moved_this_run', a_new,
    'messages_moved_total', (select count(*) from public.chat_messages where migrated_from_conversation_id is not null),
    'attachments_moved_total', (select count(*) from public.chat_message_attachments a join public.chat_messages m on m.id = a.message_id where m.migrated_from_conversation_id is not null),
    'messages_left_behind_in_migrated_conversations', (select count(*) from public.chat_messages m join public.chat_conversations c on c.id = m.conversation_id where c.migration_status = 'migrated'),
    'moved_messages_without_task_id', (select count(*) from public.chat_messages where migrated_from_conversation_id is not null and task_id is null),
    'notifications_repointed', n_notif,
    'reconciles', n_total = (select count(*) from public.chat_conversations where migration_status = 'migrated') + n_fail + n_skip,
    'standalone_task_conversations_kept', (select count(*) from public.chat_conversations c where c.type in ('task', 'bridge') and c.migration_status is null),
    'project_conversations', (select count(*) from public.chat_conversations where type = 'project'),
    'duplicate_project_chats', (select count(*) from (select project_id from public.chat_conversations where type = 'project' group by 1 having count(*) > 1) z));
  insert into public.chat_legacy_runs (report) values (v_report);
  return v_report;
end $$;

create or replace function public.chat_undo_task_chat_migration(p_conv uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.chat_conversations%rowtype; n int := 0; v_active boolean;
begin
  select * into c from public.chat_conversations where id = p_conv;
  if c.id is null or c.migration_status is distinct from 'migrated' then return jsonb_build_object('status', 'nothing_to_undo'); end if;
  update public.chat_messages set conversation_id = p_conv, migrated_from_conversation_id = null, migrated_at = null where migrated_from_conversation_id = p_conv;
  get diagnostics n = row_count;
  update public.chat_message_attachments a set conversation_id = p_conv from public.chat_messages m where m.id = a.message_id and m.conversation_id = p_conv;
  select t.is_active into v_active from public.staff_tasks t where t.id = c.task_id;
  update public.chat_conversations set migration_status = null, migrated_to_conversation_id = null, migrated_at = null, is_active = coalesce(v_active, true), archived_at = null where id = p_conv;
  insert into public.chat_legacy_audit (event, legacy_type, legacy_id, conversation_id, detail)
  values ('task_chat_migration_undone', 'task_conversation', p_conv, c.migrated_to_conversation_id, jsonb_build_object('messages', n));
  return jsonb_build_object('status', 'undone', 'messages', n);
end $$;

revoke all on function public.chat_migrate_task_chat(uuid), public.chat_migrate_project_task_chats(), public.chat_undo_task_chat_migration(uuid) from public, anon, authenticated;
