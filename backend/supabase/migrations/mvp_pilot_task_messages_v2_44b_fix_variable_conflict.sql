-- mvp_pilot_task_messages_v2_44b_fix_variable_conflict
-- Live-tested bug found immediately after applying v2_44: staff_send_task_message
-- declares RETURNS TABLE(id uuid, task_id uuid, sender_id uuid, message_text text,
-- ...) — PL/pgSQL auto-declares each of those as an implicit OUT-parameter
-- variable in the function's own namespace. Several bare (unqualified) column
-- references in the function body ("where id = p_reply_to_message_id and
-- task_id = p_task_id", "where id = p_task_id", the double-submit guard's
-- "task_id =", "sender_id =", "message_text =", "created_at >") happen to
-- share names with those OUT parameters, and PL/pgSQL's default
-- variable_conflict='error' setting correctly refused to guess which one was
-- meant, surfacing as "column reference \"id\" is ambiguous" on the very
-- first live test call. Fixed with #variable_conflict use_column — safe here
-- because the function body never reads/assigns those OUT-parameter names
-- directly by bare identifier anywhere (only via the final RETURN QUERY's
-- fully-qualified tm.* columns), so every bare reference in the body was
-- always meant as the table column.

create or replace function public.staff_send_task_message(
  p_task_id uuid,
  p_message_text text,
  p_reply_to_message_id uuid default null,
  p_attachment_metadata jsonb default null
)
returns table(
  id uuid, task_id uuid, sender_id uuid, message_text text, reply_to_message_id uuid, message_type text,
  attachment_name text, attachment_path text, attachment_type text, attachment_size bigint,
  voice_path text, voice_duration_seconds integer, is_edited boolean, edited_at timestamptz, created_at timestamptz
)
language plpgsql security definer set search_path to 'public' as $function$
#variable_conflict use_column
declare
  v_task public.staff_tasks%rowtype;
  v_text text := btrim(coalesce(p_message_text, ''));
  v_kind text;
  v_storage_path text;
  v_filename text;
  v_file_type text;
  v_file_size bigint;
  v_duration integer;
  v_storage_obj record;
  v_message_type text;
  v_message_id uuid;
  v_actor_name text;
  v_preview text;
  v_title_en text;
  v_title_gu text;
  v_recipient record;
begin
  perform public.staff_assert_operational();

  if not public.staff_task_visible(p_task_id) then
    raise exception 'Task not found or not accessible';
  end if;
  select * into v_task from public.staff_tasks where id = p_task_id;

  if p_reply_to_message_id is not null and not exists (
    select 1 from public.task_messages where id = p_reply_to_message_id and task_id = p_task_id
  ) then
    raise exception 'The message being replied to does not belong to this task';
  end if;

  if p_attachment_metadata is not null then
    v_kind := p_attachment_metadata->>'kind';
    if v_kind not in ('attachment', 'voice') then
      raise exception 'Invalid attachment metadata';
    end if;
    v_storage_path := p_attachment_metadata->>'storage_path';
    v_filename := p_attachment_metadata->>'filename';
    v_file_type := p_attachment_metadata->>'file_type';
    v_file_size := (p_attachment_metadata->>'file_size')::bigint;
    v_duration := nullif(p_attachment_metadata->>'duration_seconds', '')::integer;

    if v_storage_path is null or v_filename is null or v_file_type is null or v_file_size is null or v_file_size <= 0 then
      raise exception 'Incomplete attachment metadata';
    end if;
    if v_storage_path not like (auth.uid()::text || '/%') then
      raise exception 'storage_path must be under your own upload prefix';
    end if;
    if v_kind = 'voice' and (v_duration is null or v_duration <= 0 or v_duration > 60) then
      raise exception 'Voice messages must be between 1 and 60 seconds';
    end if;

    select * into v_storage_obj from storage.objects where bucket_id = 'staff-attachments' and name = v_storage_path;
    if v_storage_obj.id is null then
      raise exception 'No uploaded object found at storage_path — refusing to record an unverified attachment';
    end if;
    if v_storage_obj.metadata ? 'size' and (v_storage_obj.metadata->>'size')::bigint <> v_file_size then
      raise exception 'Declared file_size does not match the uploaded object';
    end if;

    v_message_type := v_kind;
  else
    v_message_type := 'text';
  end if;

  if v_text = '' and p_attachment_metadata is null then
    raise exception 'A message, attachment, or voice message is required. / સંદેશ, ફાઇલ અથવા વોઇસ મેસેજ જરૂરી છે.';
  end if;

  if v_text <> '' and exists (
    select 1 from public.task_messages
    where task_id = p_task_id and sender_id = auth.uid() and message_text = v_text
      and created_at > now() - interval '5 seconds'
  ) then
    raise exception 'This message was already sent. / આ સંદેશ પહેલેથી મોકલાયો છે.';
  end if;

  insert into public.task_messages (
    task_id, sender_id, message_text, reply_to_message_id, message_type,
    attachment_name, attachment_path, attachment_type, attachment_size,
    voice_path, voice_duration_seconds
  ) values (
    p_task_id, auth.uid(), nullif(v_text, ''), p_reply_to_message_id, v_message_type,
    case when v_kind = 'attachment' then v_filename end,
    case when v_kind = 'attachment' then v_storage_path end,
    case when v_kind = 'attachment' then v_file_type end,
    case when v_kind = 'attachment' then v_file_size end,
    case when v_kind = 'voice' then v_storage_path end,
    case when v_kind = 'voice' then v_duration end
  ) returning task_messages.id into v_message_id;

  perform public.staff_write_audit('task_message', v_message_id, 'CREATE', null,
    jsonb_build_object('task_id', p_task_id, 'message_type', v_message_type), v_task.to_department_id);

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  if v_text <> '' then
    v_preview := left(v_text, 60) || case when length(v_text) > 60 then '…' else '' end;
    v_title_en := v_actor_name || ' replied on task ' || v_task.task_number || ': ' || v_preview;
    v_title_gu := v_actor_name || ' એ કાર્ય ' || v_task.task_number || ' પર જવાબ આપ્યો: ' || v_preview;
  elsif v_kind = 'voice' then
    v_title_en := v_actor_name || ' sent a voice reply on task ' || v_task.task_number || '.';
    v_title_gu := v_actor_name || ' એ કાર્ય ' || v_task.task_number || ' પર વોઇસ જવાબ મોકલ્યો.';
  else
    v_title_en := v_actor_name || ' shared a file on task ' || v_task.task_number || '.';
    v_title_gu := v_actor_name || ' એ કાર્ય ' || v_task.task_number || ' પર ફાઇલ શેર કરી.';
  end if;

  for v_recipient in
    select distinct r.id from (
      select v_task.assigned_by as id
      union select v_task.verifier_id
      union select v_task.current_owner_id
      union select user_id from public.staff_task_assignees where task_id = p_task_id and is_active
    ) r
    where r.id is not null and r.id <> auth.uid()
      and exists (select 1 from public.user_profiles up where up.id = r.id and up.is_active = true)
  loop
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, sender_id, title_en, title_gu)
    values (v_recipient.id, 'task_message', v_message_id, p_task_id, auth.uid(), v_title_en, v_title_gu);
  end loop;

  return query
    select tm.id, tm.task_id, tm.sender_id, tm.message_text, tm.reply_to_message_id, tm.message_type,
           tm.attachment_name, tm.attachment_path, tm.attachment_type, tm.attachment_size,
           tm.voice_path, tm.voice_duration_seconds, tm.is_edited, tm.edited_at, tm.created_at
    from public.task_messages tm where tm.id = v_message_id;
end;
$function$;
