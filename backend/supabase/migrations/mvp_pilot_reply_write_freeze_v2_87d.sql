-- v2_87d -- Reply -> Chat consolidation, PHASE C: the old Reply system becomes READ-ONLY. Nothing is dropped.
--   * public.task_messages / task_message_reads stay in place (verification period); a trigger refuses new writes
--   * the four Reply RPCs no longer write; task events ("Task accepted / reassigned ...") are posted into the task's Chat instead
--   * account-merge maintenance (staff_transfer_user_data) still works and now also moves Chat authorship

-- ---- task events go to Chat (staff_post_system_task_message is called by ~30 task / factory / interior workflow functions) ----
create or replace function public.staff_post_system_task_message(p_task_id uuid, p_text_en text, p_text_gu text)
returns void language plpgsql security definer set search_path = public as $$
declare v_conv uuid;
begin
  select id into v_conv from public.chat_conversations where task_id = p_task_id and type in ('task', 'bridge');
  if v_conv is null then v_conv := public.chat_sync_task(p_task_id); end if;
  if v_conv is null then return; end if;
  insert into public.chat_messages (conversation_id, sender_id, body, is_system, context)
  values (v_conv, auth.uid(), left(p_text_en || ' / ' || p_text_gu, 4000), true, jsonb_build_object('source', 'task_event'));
end $$;

-- ---- old write RPCs: refuse, with a pointer to Chat ----
create or replace function public.staff_send_task_message(p_task_id uuid, p_message_text text, p_reply_to_message_id uuid default null, p_attachment_metadata jsonb default null)
returns table(id uuid, task_id uuid, sender_id uuid, message_text text, reply_to_message_id uuid, message_type text, attachment_name text, attachment_path text,
              attachment_type text, attachment_size bigint, voice_path text, voice_duration_seconds integer, is_edited boolean, edited_at timestamptz, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Task replies have moved to Chat. Open the task''s Chat to send a message. / કાર્ય જવાબો હવે ચેટમાં છે. સંદેશ મોકલવા કાર્યની ચેટ ખોલો.';
end $$;

create or replace function public.staff_edit_task_message(p_message_id uuid, p_new_text text)
returns void language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Task replies have moved to Chat and can be edited there. / કાર્ય જવાબો હવે ચેટમાં છે.';
end $$;

create or replace function public.staff_delete_task_message(p_message_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Task replies have moved to Chat and can be removed there. / કાર્ય જવાબો હવે ચેટમાં છે.';
end $$;

-- read markers now live on the chat participant; an old cached page calling this must not error
create or replace function public.staff_mark_task_messages_read(p_task_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_assert_operational();
end $$;

-- ---- belt and braces: even a SECURITY DEFINER path cannot write the legacy table ----
create or replace function public.task_messages_freeze() returns trigger language plpgsql set search_path = public as $$
begin
  -- FK cascade when a task row itself is hard-deleted by an administrator (depth > 1 = fired by the RI trigger)
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  -- account-merge maintenance changes ONLY who a row is attributed to
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'sender_id' - 'deleted_by') = (to_jsonb(old) - 'sender_id' - 'deleted_by') then return new; end if;
  raise exception 'Replies are read-only: this conversation now lives in Chat.';
end $$;
drop trigger if exists trg_task_messages_freeze on public.task_messages;
create trigger trg_task_messages_freeze before insert or update or delete on public.task_messages for each row execute function public.task_messages_freeze();

-- ---- account merge: move Chat authorship too ----
do $$
declare v_old text; v_new text;
begin
  v_old := pg_get_functiondef('public.staff_transfer_user_data(uuid, uuid)'::regprocedure);
  v_new := replace(v_old, $q$array['task_messages','deleted_by'], array['task_messages','sender_id'],$q$,
    $q$array['task_messages','deleted_by'], array['task_messages','sender_id'], array['chat_messages','sender_id'], array['chat_messages','deleted_by'], array['chat_message_attachments','uploaded_by'],$q$);
  if v_new = v_old then raise exception 'staff_transfer_user_data patch did not apply'; end if;
  execute v_new;
end $$;

insert into public.chat_legacy_audit (event, legacy_type, detail) values
  ('reply_write_disabled', 'task_messages', jsonb_build_object('trigger', 'trg_task_messages_freeze',
     'rpcs', jsonb_build_array('staff_send_task_message', 'staff_edit_task_message', 'staff_delete_task_message'), 'redirected', jsonb_build_array('staff_post_system_task_message'),
     'legacy_tables_kept', jsonb_build_array('task_messages', 'task_message_reads')));
