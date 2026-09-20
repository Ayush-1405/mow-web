-- v2_87c -- Reply -> Chat consolidation, PHASE B: the migration itself. Safe to run any number of times.
--
--   * every legacy reply (public.task_messages) becomes ONE chat message (unique on legacy_source_type + legacy_source_id)
--   * original sender, text, created_at, edited_at, delete state, reply-to relationship and project / job-card / bridge / daily-update context are kept
--   * attachments are linked to the ORIGINAL private object (bucket staff-attachments) -- nothing is copied, no signed URL is stored
--   * anything that cannot be mapped goes to chat_legacy_review (never dropped, never shown to ordinary users)
--   * no notifications are created, unread state is not inflated, the legacy table is not modified
-- Not callable from the browser: run it from the SQL editor / a migration.

create or replace function public.chat_migrate_legacy_replies()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record; tk public.staff_tasks%rowtype; o record;
  v_conv uuid; v_msg uuid; v_ctx jsonb; v_touched uuid[] := '{}';
  n_total int; n_new int := 0; n_dup int := 0; n_review int := 0; n_unresolved_parent int;
  a_new int := 0; a_dup int := 0; a_missing int := 0; v_path text; v_att uuid; v_report jsonb;
begin
  perform set_config('app.chat_silent', '1', true);
  select count(*) into n_total from public.task_messages;

  for r in select * from public.task_messages order by created_at, id loop
    begin
      -- 1. already migrated? (re-run) -- nothing is inserted twice
      select id into v_msg from public.chat_messages where legacy_source_type = 'task_message' and legacy_source_id = r.id;
      if v_msg is not null then
        n_dup := n_dup + 1;
        select conversation_id into v_conv from public.chat_messages where id = v_msg;
      else
        -- 2. resolve the destination from the reply's actual parent (never assumed)
        select * into tk from public.staff_tasks where id = r.task_id;
        if tk.id is null then
          insert into public.chat_legacy_review (legacy_reply_id, sender_id, legacy_created_at, task_id, reason, suggested_destination)
          values (r.id, r.sender_id, r.created_at, r.task_id, 'parent task no longer exists', 'none: keep in the read-only legacy table')
          on conflict (legacy_reply_id) do update set reason = excluded.reason, detected_at = now();
          insert into public.chat_legacy_audit (event, legacy_type, legacy_id, detail) values ('migration_failed', 'task_message', r.id, jsonb_build_object('reason', 'parent task no longer exists'));
          n_review := n_review + 1;
          continue;
        end if;
        v_conv := public.chat_sync_task(tk.id);
        if v_conv is null then raise exception 'no conversation could be created for task %', tk.id; end if;

        v_ctx := jsonb_strip_nulls(jsonb_build_object(
          'source', 'legacy_reply', 'legacy_message_type', r.message_type,
          'task_id', tk.id, 'task_number', tk.task_number, 'is_bridge', tk.is_bridge,
          'project_id', tk.project_id, 'project_code', (select project_code from public.projects where id = tk.project_id),
          'job_card_id', tk.job_card_id, 'job_order_number', (select job_order_number from public.inhouse_production_requests where id = tk.job_card_id),
          'site_report_id', tk.source_site_report_id,
          'from_department', (select name_en from public.departments where id = tk.from_department_id),
          'to_department', (select name_en from public.departments where id = tk.to_department_id),
          'badge', case when tk.source_module = 'daily_site_update' then 'Daily Site Update' end,
          'voice_duration_seconds', r.voice_duration_seconds));

        insert into public.chat_messages (conversation_id, sender_id, body, mentions, is_system, created_at, edited_at, deleted_at, deleted_by, delete_reason,
                                          legacy_source_type, legacy_source_id, imported_at, context)
        values (v_conv, r.sender_id, coalesce(r.message_text, ''), '{}', r.message_type = 'system', r.created_at,
                case when r.is_edited then coalesce(r.edited_at, r.created_at) end,
                case when r.is_deleted then coalesce(r.deleted_at, now()) end, case when r.is_deleted then r.deleted_by end, r.deletion_reason,
                'task_message', r.id, now(), v_ctx)
        on conflict (legacy_source_type, legacy_source_id) where legacy_source_id is not null do nothing
        returning id into v_msg;
        if v_msg is null then n_dup := n_dup + 1; else
          n_new := n_new + 1;
          insert into public.chat_legacy_audit (event, legacy_type, legacy_id, conversation_id, message_id, detail)
          values ('reply_migrated', 'task_message', r.id, v_conv, v_msg,
                  jsonb_build_object('destination', case when tk.is_bridge then 'bridge_chat' else 'task_chat' end, 'task_id', tk.id, 'project_id', tk.project_id, 'job_card_id', tk.job_card_id,
                                     'daily_site_update', tk.source_module = 'daily_site_update', 'original_created_at', r.created_at));
        end if;
        update public.chat_legacy_review set status = 'resolved', resolved_at = now() where legacy_reply_id = r.id and status = 'open';
      end if;
      v_touched := array_append(v_touched, v_conv);

      -- 3. attachment / voice: link the ORIGINAL private object (idempotent)
      v_path := coalesce(r.attachment_path, r.voice_path);
      if v_path is not null then
        select * into o from storage.objects where bucket_id = 'staff-attachments' and name = v_path;
        if o.id is null then
          a_missing := a_missing + 1;
          insert into public.chat_legacy_audit (event, legacy_type, legacy_id, conversation_id, message_id, detail)
          values ('migration_failed', 'task_message_attachment', r.id, v_conv, v_msg, jsonb_build_object('reason', 'storage object missing', 'path', v_path));
        else
          insert into public.chat_message_attachments (message_id, conversation_id, storage_path, file_name, mime_type, file_size, uploaded_by, created_at, bucket, legacy_source_type, legacy_source_id)
          values (v_msg, v_conv, v_path, left(coalesce(r.attachment_name, 'voice-message'), 200),
                  coalesce(r.attachment_type, o.metadata ->> 'mimetype', 'application/octet-stream'),
                  greatest(coalesce(r.attachment_size, (o.metadata ->> 'size')::bigint, 1), 1), r.sender_id, r.created_at, 'staff-attachments', 'task_message', r.id)
          on conflict do nothing returning id into v_att;
          if v_att is null then a_dup := a_dup + 1; else
            a_new := a_new + 1;
            insert into public.chat_legacy_audit (event, legacy_type, legacy_id, conversation_id, message_id, detail)
            values ('attachment_linked', 'task_message_attachment', r.id, v_conv, v_msg, jsonb_build_object('path', v_path, 'bucket', 'staff-attachments'));
          end if;
        end if;
      end if;
    exception when others then
      insert into public.chat_legacy_review (legacy_reply_id, sender_id, legacy_created_at, task_id, reason, suggested_destination)
      values (r.id, r.sender_id, r.created_at, r.task_id, left(sqlerrm, 300), 'task chat for ' || r.task_id::text)
      on conflict (legacy_reply_id) do update set reason = excluded.reason, detected_at = now();
      insert into public.chat_legacy_audit (event, legacy_type, legacy_id, detail) values ('migration_failed', 'task_message', r.id, jsonb_build_object('reason', left(sqlerrm, 300)));
      n_review := n_review + 1;
    end;
    v_msg := null; v_att := null; v_conv := null;
  end loop;

  -- 4. reply-to relationships (second pass, so the parent always exists)
  update public.chat_messages cm set reply_to_id = p.id
    from public.task_messages tm join public.chat_messages p on p.legacy_source_type = 'task_message' and p.legacy_source_id = tm.reply_to_message_id
   where cm.legacy_source_type = 'task_message' and cm.legacy_source_id = tm.id and tm.reply_to_message_id is not null and cm.reply_to_id is null
     and p.conversation_id = cm.conversation_id;
  select count(*) into n_unresolved_parent from public.task_messages tm join public.chat_messages cm on cm.legacy_source_type = 'task_message' and cm.legacy_source_id = tm.id
   where tm.reply_to_message_id is not null and cm.reply_to_id is null;

  -- 5. conversation list activity: newest real message wins; imported history never pushes a conversation "to the top as new"
  v_touched := (select coalesce(array_agg(distinct x), '{}') from unnest(v_touched) x);
  update public.chat_conversations c set last_message_at = x.created_at, last_message_sender = x.sender_id,
         last_message_preview = case when x.body <> '' then left(x.body, 80) else '📎 Attachment' end
    from (select distinct on (m.conversation_id) m.conversation_id, m.created_at, m.sender_id, m.body from public.chat_messages m
           where not m.is_system and m.deleted_at is null and m.conversation_id = any (v_touched)
           order by m.conversation_id, m.created_at desc, m.id desc) x
   where c.id = x.conversation_id and (c.last_message_at is null or x.created_at > c.last_message_at);

  -- 6. read state: legacy read markers where they exist, otherwise the imported history counts as already seen (no unread inflation)
  update public.chat_participants p set last_read_at = greatest(coalesce(p.last_read_at, p.joined_at),
           coalesce((select lr.last_read_at from public.task_message_reads lr join public.chat_conversations c on c.task_id = lr.task_id
                      where c.id = p.conversation_id and c.type in ('task', 'bridge') and lr.user_id = p.user_id), w.max_legacy))
    from (select m.conversation_id, max(m.created_at) as max_legacy from public.chat_messages m
           where m.legacy_source_type = 'task_message' and m.conversation_id = any (v_touched) group by 1) w
   where p.conversation_id = w.conversation_id and p.left_at is null;

  -- 7. reconciliation report
  v_report := jsonb_build_object(
    'ran_at', now(),
    'legacy_replies_total', n_total,
    'migrated_this_run', n_new, 'already_migrated_skipped', n_dup, 'unresolved_review_this_run', n_review,
    'migrated_total', (select count(*) from public.chat_messages where legacy_source_type = 'task_message'),
    'review_open_total', (select count(*) from public.chat_legacy_review where status = 'open'),
    'reconciles', n_total = (select count(*) from public.chat_messages where legacy_source_type = 'task_message') + (select count(*) from public.chat_legacy_review where status = 'open'),
    'unresolved_reply_to', n_unresolved_parent,
    'by_source', (select jsonb_build_object(
        'task', count(*) filter (where not t.is_bridge and t.source_module is distinct from 'daily_site_update' and t.job_card_id is null),
        'bridge', count(*) filter (where t.is_bridge),
        'daily_site_update', count(*) filter (where t.source_module = 'daily_site_update'),
        'job_card_linked_task', count(*) filter (where t.job_card_id is not null),
        'linked_to_project', count(*) filter (where t.project_id is not null),
        'missing_parent', (select count(*) from public.task_messages x where not exists (select 1 from public.staff_tasks y where y.id = x.task_id)))
      from public.task_messages m join public.staff_tasks t on t.id = m.task_id),
    'by_message_type', (select coalesce(jsonb_object_agg(message_type, n), '{}') from (select message_type, count(*) n from public.task_messages group by 1) z),
    'attachments', jsonb_build_object(
        'legacy_total', (select count(*) from public.task_messages where attachment_path is not null or voice_path is not null),
        'linked_total', (select count(*) from public.chat_message_attachments where legacy_source_type = 'task_message'),
        'linked_this_run', a_new, 'already_linked_skipped', a_dup, 'missing_object', a_missing),
    'conversations', (select coalesce(jsonb_object_agg(type, n), '{}') from (select type, count(*) n from public.chat_conversations group by 1) z),
    'conversations_receiving_history', (select count(distinct conversation_id) from public.chat_messages where legacy_source_type = 'task_message'));
  insert into public.chat_legacy_runs (report) values (v_report);
  return v_report;
end $$;

-- one canonical Project Chat per project (idempotent; participants come from the project's own assignments)
create or replace function public.chat_backfill_project_chats()
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  perform set_config('app.chat_silent', '1', true);
  for r in select id from public.projects loop
    if public.chat_sync_project(r.id) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

revoke all on function public.chat_migrate_legacy_replies(), public.chat_backfill_project_chats() from public, anon, authenticated;
