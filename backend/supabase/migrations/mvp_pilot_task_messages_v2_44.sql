-- mvp_pilot_task_messages_v2_44
-- Task-wise Reply / Conversation feature. Reuses the existing staff_tasks
-- system end to end: authorization is the SAME participant set that
-- already governs task visibility (staff_task_visible), attachments reuse
-- the existing staff-file-url Edge Function + storage bucket convention
-- (extended, not duplicated), and notifications reuse the existing
-- notifications table/realtime channel/badge — no new chat app, no new
-- storage bucket, no new notification pipeline.
--
-- Discovered while inspecting the existing attachment/visibility code
-- (per the task's explicit "first inspect" instruction) and fixed here as
-- a real, in-scope bug: staff_task_visible() was written in
-- mvp_pilot_staff_task_assignees_v2_41.sql with a comment claiming it
-- "mirrors staff_tasks_select_scoped's own boolean", but the
-- staff_task_assignees-membership clause was only actually added to the
-- staff_tasks_select_scoped POLICY in that same file, never to this
-- function. The same gap (no assignee-membership clause) was independently
-- duplicated into staff_attachments_select_matches_parent and
-- staff_record_attachment's v_has_access check. Net effect: a Second
-- Assignee could see a task in Today's Tasks but could NOT view or attach
-- files to it, and — left unfixed — would have been silently excluded from
-- this new task conversation too, directly violating this feature's
-- explicit "Second Assignee must not be excluded from the thread"
-- requirement. Fixed in all three places below, additively (widens
-- visibility only, narrows nothing).

-- ---------------------------------------------------------------------
-- 1. Fix staff_task_visible() + staff_attachments visibility to actually
--    include Second Assignees, matching staff_tasks_select_scoped.
-- ---------------------------------------------------------------------

create or replace function public.staff_task_visible(p_task_id uuid) returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.staff_tasks t
    where t.id = p_task_id
      and (
        t.assigned_by = auth.uid() or t.assigned_to = auth.uid() or t.current_owner_id = auth.uid() or t.verifier_id = auth.uid()
        or exists (select 1 from public.staff_task_assignees sta where sta.task_id = t.id and sta.user_id = auth.uid() and sta.is_active)
        or public.staff_is_management() or public.staff_is_super_admin()
        or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(t.from_department_id) or public.staff_dept_in_hod_scope(t.to_department_id)))
        or (public.staff_is_supervisor() and (t.from_department_id = public.staff_current_department_id() or t.to_department_id = public.staff_current_department_id()))
        or (public.staff_is_accounts_head() and (t.from_department_id = public.staff_current_department_id() or t.to_department_id = public.staff_current_department_id()))
        or (t.project_id is not null and (public.interior_is_org_wide() or public.interior_is_project_member(t.project_id)))
      )
      and not (
        exists (select 1 from public.departments d where d.id in (t.from_department_id, t.to_department_id) and d.is_confidential_domain = true)
        and not (public.staff_is_management() or public.staff_is_super_admin() or public.staff_is_accounts_head() or public.staff_current_role_code() in ('accounts_employee', 'cfo'))
      )
  );
$$;

drop policy if exists "staff_attachments_select_matches_parent" on public.staff_attachments;
create policy "staff_attachments_select_matches_parent" on public.staff_attachments for select using (
  staff_current_user_ok() and (
    uploaded_by = auth.uid() or staff_is_management() or staff_is_super_admin()
    or (entity_type = 'task' and exists (
      select 1 from staff_tasks t where t.id = staff_attachments.entity_id and (
        t.assigned_by = auth.uid() or t.assigned_to = auth.uid() or t.current_owner_id = auth.uid() or t.verifier_id = auth.uid()
        or exists (select 1 from staff_task_assignees sta where sta.task_id = t.id and sta.user_id = auth.uid() and sta.is_active)
        or (staff_is_dept_head() and (staff_dept_in_hod_scope(t.from_department_id) or staff_dept_in_hod_scope(t.to_department_id)))
        or (staff_is_accounts_head() and (t.from_department_id = staff_current_department_id() or t.to_department_id = staff_current_department_id()))
      )
    ))
    or (entity_type = 'bridge' and exists (
      select 1 from bridges b where b.id = staff_attachments.entity_id and (
        b.from_person_id = auth.uid() or b.to_person_id = auth.uid()
        or (staff_is_dept_head() and (staff_dept_in_hod_scope(b.from_department_id) or staff_dept_in_hod_scope(b.to_department_id)))
      )
    ))
  )
);

create or replace function public.staff_record_attachment(p_entity_type text, p_entity_id uuid, p_file_type text, p_storage_path text, p_original_filename text, p_mime_type text, p_file_size bigint, p_duration_seconds integer default null::integer)
 returns uuid
 language plpgsql
 security definer set search_path to 'public'
as $function$
declare
  v_task public.staff_tasks%rowtype;
  v_bridge public.bridges%rowtype;
  v_has_access boolean := false;
  v_confidential boolean := false;
  v_attachment_id uuid;
  v_max_bytes bigint := 20 * 1024 * 1024;
  v_storage_obj record;
  v_base_mime text := split_part(p_mime_type, ';', 1);
begin
  perform public.staff_assert_operational();

  if p_file_type not in ('image','pdf','word','excel','drawing','voice') then
    raise exception 'Unsupported file_type';
  end if;
  if p_file_size is null or p_file_size <= 0 or p_file_size > v_max_bytes then
    raise exception 'File size invalid or exceeds the pilot limit';
  end if;
  if (p_file_type = 'image' and p_mime_type not in ('image/jpeg','image/png','image/webp','image/heic','image/heif'))
     or (p_file_type = 'pdf' and p_mime_type <> 'application/pdf')
     or (p_file_type = 'word' and p_mime_type not in ('application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
     or (p_file_type = 'excel' and p_mime_type not in ('application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
     or (p_file_type = 'drawing' and p_mime_type not in ('application/dxf','application/dwg','image/vnd.dwg','image/vnd.dxf','application/x-dwg','application/x-dxf','application/acad'))
     or (p_file_type = 'voice' and v_base_mime not in ('audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav','audio/x-m4a','audio/aac'))
  then
    raise exception 'mime_type does not match file_type';
  end if;
  if p_file_type = 'voice' and (p_duration_seconds is null or p_duration_seconds <= 0 or p_duration_seconds > 60) then
    raise exception 'Voice messages must be between 1 and 60 seconds';
  end if;

  if p_storage_path not like (auth.uid()::text || '/%') then
    raise exception 'storage_path must be under your own upload prefix';
  end if;

  select * into v_storage_obj from storage.objects where bucket_id = 'staff-attachments' and name = p_storage_path;
  if v_storage_obj.id is null then
    raise exception 'No uploaded object found at storage_path — refusing to record unverified attachment metadata';
  end if;
  if v_storage_obj.metadata ? 'size' and (v_storage_obj.metadata->>'size')::bigint <> p_file_size then
    raise exception 'Declared file_size does not match the uploaded object';
  end if;
  if v_storage_obj.metadata ? 'mimetype' and v_storage_obj.metadata->>'mimetype' <> p_mime_type then
    raise exception 'Declared mime_type does not match the uploaded object';
  end if;

  if p_entity_type = 'task' then
    select * into v_task from public.staff_tasks where id = p_entity_id;
    if v_task.id is null then raise exception 'Parent task does not exist'; end if;
    v_has_access := (
      v_task.assigned_by = auth.uid() or v_task.assigned_to = auth.uid() or v_task.current_owner_id = auth.uid() or v_task.verifier_id = auth.uid()
      or exists (select 1 from public.staff_task_assignees sta where sta.task_id = v_task.id and sta.user_id = auth.uid() and sta.is_active)
      or public.staff_is_management() or public.staff_is_super_admin()
      or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(v_task.from_department_id) or public.staff_dept_in_hod_scope(v_task.to_department_id)))
      or (public.staff_is_accounts_head() and (v_task.from_department_id = public.staff_current_department_id() or v_task.to_department_id = public.staff_current_department_id()))
    );
    select true into v_confidential from public.departments d where d.id in (v_task.from_department_id, v_task.to_department_id) and d.is_confidential_domain = true limit 1;
  elsif p_entity_type = 'bridge' then
    select * into v_bridge from public.bridges where id = p_entity_id;
    if v_bridge.id is null then raise exception 'Parent bridge does not exist'; end if;
    v_has_access := (
      v_bridge.from_person_id = auth.uid() or v_bridge.to_person_id = auth.uid()
      or public.staff_is_management() or public.staff_is_super_admin()
      or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(v_bridge.from_department_id) or public.staff_dept_in_hod_scope(v_bridge.to_department_id)))
    );
  else
    raise exception 'Invalid entity_type';
  end if;

  if not v_has_access then
    raise exception 'You do not have access to attach files to this %', p_entity_type;
  end if;
  if coalesce(v_confidential, false) and not (public.staff_is_management() or public.staff_is_super_admin() or public.staff_is_accounts_head() or public.staff_current_role_code() in ('accounts_employee','cfo')) then
    raise exception 'Attachments on a confidential-domain task are restricted';
  end if;

  insert into public.staff_attachments (entity_type, entity_id, file_type, storage_path, original_filename, mime_type, file_size, duration_seconds, uploaded_by, is_confidential)
  values (p_entity_type, p_entity_id, p_file_type, p_storage_path, p_original_filename, p_mime_type, p_file_size, p_duration_seconds, auth.uid(), coalesce(v_confidential, false))
  returning id into v_attachment_id;

  perform public.staff_write_audit(p_entity_type, p_entity_id, 'ATTACH', null, jsonb_build_object('attachment_id', v_attachment_id, 'file_type', p_file_type), null);

  return v_attachment_id;
end;
$function$;

-- ---------------------------------------------------------------------
-- 2. task_messages + task_message_reads
-- ---------------------------------------------------------------------

create table public.task_messages (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.staff_tasks(id),
  sender_id uuid not null references public.user_profiles(id),
  message_text text,
  reply_to_message_id uuid references public.task_messages(id),
  message_type text not null default 'text' check (message_type in ('text','attachment','voice','system')),
  attachment_name text,
  attachment_path text,
  attachment_type text,
  attachment_size bigint,
  voice_path text,
  voice_duration_seconds integer,
  is_edited boolean not null default false,
  edited_at timestamptz,
  is_deleted boolean not null default false,
  deleted_at timestamptz,
  deleted_by uuid references public.user_profiles(id),
  deletion_reason text,
  created_at timestamptz not null default now(),
  constraint task_messages_has_content check (
    message_type = 'system'
    or (message_text is not null and btrim(message_text) <> '')
    or attachment_path is not null
    or voice_path is not null
  )
);

create index task_messages_task_id_idx on public.task_messages(task_id);
create index task_messages_sender_id_idx on public.task_messages(sender_id);
create index task_messages_created_at_idx on public.task_messages(created_at);
create index task_messages_is_deleted_idx on public.task_messages(is_deleted);
create index task_messages_reply_to_idx on public.task_messages(reply_to_message_id) where reply_to_message_id is not null;

create table public.task_message_reads (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.staff_tasks(id),
  user_id uuid not null references public.user_profiles(id),
  last_read_at timestamptz not null default now(),
  unique (task_id, user_id)
);
create index task_message_reads_user_id_idx on public.task_message_reads(user_id);

alter table public.task_messages enable row level security;
alter table public.task_message_reads enable row level security;

-- SELECT only. Exactly like staff_attachments/staff_task_assignees: no
-- INSERT/UPDATE/DELETE policy at all — every write goes through the
-- SECURITY DEFINER RPCs below, which is the real authorization boundary.
-- An unrelated employee changing task_id in the URL gets an empty result
-- here (staff_task_visible returns false for them), never someone else's
-- conversation.
grant select on public.task_messages to authenticated;
grant select on public.task_message_reads to authenticated;

create policy "task_messages_select_scoped" on public.task_messages for select using (
  staff_current_user_ok() and public.staff_task_visible(task_id)
);

-- Read receipts are private to their own owner — nobody, including
-- Management, needs to see WHEN someone else read a message, only whether
-- their own messages are unread (covered by staff_task_unread_message_counts
-- reading the SENDER's own side, which never needs another user's reads row).
create policy "task_message_reads_select_own" on public.task_message_reads for select using (
  user_id = auth.uid()
);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'task_messages') then
    execute 'alter publication supabase_realtime add table public.task_messages';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'task_message_reads') then
    execute 'alter publication supabase_realtime add table public.task_message_reads';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. notifications gains task_id/sender_id (nullable, additive) so a
--    task_message notification can be deep-linked and attributed without
--    re-parsing title text — every existing notification row/INSERT site
--    is unaffected (both columns simply stay null for them).
-- ---------------------------------------------------------------------

alter table public.notifications
  add column if not exists task_id uuid references public.staff_tasks(id),
  add column if not exists sender_id uuid references public.user_profiles(id);

create index if not exists notifications_task_id_idx on public.notifications(task_id) where task_id is not null;

-- ---------------------------------------------------------------------
-- 4. Internal helper: post a system activity message into a task's
--    conversation. Not exposed to authenticated directly (REVOKEd below) —
--    only called from inside the other SECURITY DEFINER task RPCs, which
--    already re-verify the actor's authorization to perform that action
--    before this ever runs. Does not create a notification of its own —
--    each calling RPC already sends its own status-change notification, so
--    this would only duplicate it.
-- ---------------------------------------------------------------------

create or replace function public.staff_post_system_task_message(p_task_id uuid, p_text_en text, p_text_gu text)
returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  insert into public.task_messages (task_id, sender_id, message_text, message_type)
  values (p_task_id, auth.uid(), p_text_en || ' / ' || p_text_gu, 'system');
end;
$function$;

revoke all on function public.staff_post_system_task_message(uuid, text, text) from public;

-- ---------------------------------------------------------------------
-- 5. staff_send_task_message — the main reply RPC.
-- ---------------------------------------------------------------------

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

  -- Cheap double-submit guard: only fires when the SAME sender posts the
  -- SAME non-empty text on the SAME task again within 5 seconds (e.g. a
  -- double click racing the disabled-button state) — never blocks a
  -- genuinely repeated later message.
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

  -- Notify every active participant except the sender, deduplicated so
  -- someone holding two roles (e.g. verifier who is also the assigner)
  -- gets exactly one notification.
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

-- ---------------------------------------------------------------------
-- 6. Edit / delete / read-tracking / unread-count / stats RPCs.
-- ---------------------------------------------------------------------

create or replace function public.staff_edit_task_message(p_message_id uuid, p_new_text text)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare
  v_msg public.task_messages%rowtype;
  v_text text := btrim(coalesce(p_new_text, ''));
begin
  perform public.staff_assert_operational();
  select * into v_msg from public.task_messages where id = p_message_id for update;
  if v_msg.id is null then raise exception 'Message not found'; end if;
  if v_msg.message_type = 'system' then raise exception 'System messages cannot be edited'; end if;
  if v_msg.sender_id <> auth.uid() then raise exception 'You can only edit your own messages'; end if;
  if v_msg.is_deleted then raise exception 'This message was removed and cannot be edited'; end if;
  if v_msg.created_at < now() - interval '15 minutes' then
    raise exception 'This message can no longer be edited (15-minute edit window has passed)';
  end if;
  if v_text = '' then raise exception 'Message text cannot be empty'; end if;

  update public.task_messages set message_text = v_text, is_edited = true, edited_at = now() where id = p_message_id;
  perform public.staff_write_audit('task_message', p_message_id, 'EDIT', jsonb_build_object('message_text', v_msg.message_text), jsonb_build_object('message_text', v_text), null);
end;
$function$;

create or replace function public.staff_delete_task_message(p_message_id uuid, p_reason text)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare
  v_msg public.task_messages%rowtype;
  v_task public.staff_tasks%rowtype;
begin
  perform public.staff_assert_operational();
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to remove a message';
  end if;

  select * into v_msg from public.task_messages where id = p_message_id for update;
  if v_msg.id is null then raise exception 'Message not found'; end if;
  if v_msg.message_type = 'system' then raise exception 'System messages cannot be removed'; end if;
  if v_msg.is_deleted then raise exception 'This message was already removed'; end if;

  select * into v_task from public.staff_tasks where id = v_msg.task_id;
  if not (
    v_msg.sender_id = auth.uid() or public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_task.to_department_id))
  ) then
    raise exception 'You are not authorized to remove this message';
  end if;

  update public.task_messages set is_deleted = true, deleted_at = now(), deleted_by = auth.uid(), deletion_reason = btrim(p_reason)
  where id = p_message_id;

  perform public.staff_write_audit('task_message', p_message_id, 'DELETE', null, jsonb_build_object('reason', btrim(p_reason)), v_task.to_department_id, btrim(p_reason));
end;
$function$;

create or replace function public.staff_mark_task_messages_read(p_task_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  perform public.staff_assert_operational();
  if not public.staff_task_visible(p_task_id) then
    raise exception 'Task not found or not accessible';
  end if;
  insert into public.task_message_reads (task_id, user_id, last_read_at)
  values (p_task_id, auth.uid(), now())
  on conflict (task_id, user_id) do update set last_read_at = excluded.last_read_at;
end;
$function$;

-- One caller-scoped round trip covering every task they participate in —
-- used by Today's Tasks / task cards / Department Dashboard to show a
-- per-task "Reply (N)" badge without an extra query per task.
create or replace function public.staff_task_unread_message_counts()
returns table(task_id uuid, unread_count bigint)
language sql stable security definer set search_path to 'public' as $$
  select m.task_id, count(*)
  from public.task_messages m
  left join public.task_message_reads r on r.task_id = m.task_id and r.user_id = auth.uid()
  where m.is_deleted = false
    and m.message_type <> 'system'
    and m.sender_id <> auth.uid()
    and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
    and public.staff_task_visible(m.task_id)
  group by m.task_id;
$$;

create or replace function public.staff_task_conversation_stats(p_task_id uuid)
returns table(total_replies bigint, last_reply_at timestamptz, last_reply_by_name text, unread_count bigint)
language plpgsql stable security definer set search_path to 'public' as $function$
begin
  if not public.staff_task_visible(p_task_id) then
    raise exception 'Task not found or not accessible';
  end if;
  return query
    with msgs as (
      select * from public.task_messages where task_id = p_task_id and is_deleted = false and message_type <> 'system'
    ), reads as (
      select last_read_at from public.task_message_reads where task_id = p_task_id and user_id = auth.uid()
    )
    select
      (select count(*) from msgs),
      (select m.created_at from msgs m order by m.created_at desc limit 1),
      (select up.full_name from msgs m join public.user_profiles up on up.id = m.sender_id order by m.created_at desc limit 1),
      (select count(*) from msgs where sender_id <> auth.uid() and created_at > coalesce((select last_read_at from reads), '-infinity'::timestamptz));
end;
$function$;

-- ---------------------------------------------------------------------
-- 7. Wire a system activity message into every status-changing RPC that
--    already exists. Each body below is copied EXACTLY from the live
--    definition (verified via pg_get_functiondef before writing this),
--    with one declaration + one `perform` line added — never a rewrite of
--    the underlying logic. Posting a reply/system message never changes
--    task status, owner, or due date, and none of these additions touch
--    any authorization check already in these functions.
-- ---------------------------------------------------------------------

create or replace function public.staff_accept_task(p_task_id uuid)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid;
  v_assignee_count int; v_my_row record; v_active_count int; v_accepted_count int; v_new_code text;
  v_actor_name text;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;
  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  select count(*) into v_assignee_count from public.staff_task_assignees where task_id = p_task_id and is_active;

  if v_assignee_count <= 1 then
    if v_old_code not in ('ASSIGNED','RETURNED') then
      raise exception 'Task must be ASSIGNED or RETURNED to accept (currently %)', v_old_code;
    end if;
    if v_task.assigned_to <> auth.uid() then
      raise exception 'Only the assignee may accept this task';
    end if;

    select id into v_status_id from public.status_master where code = 'ACCEPTED';
    update public.staff_tasks set status_id = v_status_id where id = p_task_id;

    if v_task.is_bridge then
      update public.bridges set acceptance_status = 'ACCEPTED', accepted_at = now() where task_id = p_task_id;
    end if;

    perform public.staff_write_audit('task', p_task_id, 'ACCEPT', jsonb_build_object('status', v_old_code), jsonb_build_object('status','ACCEPTED'), v_task.to_department_id);
    perform public.staff_post_system_task_message(p_task_id, 'Task accepted by ' || v_actor_name, v_actor_name || ' દ્વારા કાર્ય સ્વીકારાયું');
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_task.assigned_by, 'task', p_task_id, 'Task accepted: ' || v_task.task_number, 'કામ સ્વીકાર્યું: ' || v_task.task_number);
    return;
  end if;

  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;
  if v_my_row.id is null then
    raise exception 'You are not an active assignee on this task';
  end if;
  if v_my_row.acceptance_status = 'ACCEPTED' then
    raise exception 'You have already accepted this task';
  end if;

  update public.staff_task_assignees set acceptance_status = 'ACCEPTED', accepted_at = now(),
    individual_status = case when individual_status = 'ASSIGNED' then 'ACCEPTED' else individual_status end
    where id = v_my_row.id;

  select count(*), count(*) filter (where acceptance_status = 'ACCEPTED')
    into v_active_count, v_accepted_count
    from public.staff_task_assignees where task_id = p_task_id and is_active;

  v_new_code := case when v_accepted_count = v_active_count then 'ACCEPTED' else 'PARTIALLY_ACCEPTED' end;
  select id into v_status_id from public.status_master where code = v_new_code;
  update public.staff_tasks set status_id = v_status_id where id = p_task_id;

  if v_task.is_bridge and v_new_code = 'ACCEPTED' then
    update public.bridges set acceptance_status = 'ACCEPTED', accepted_at = now() where task_id = p_task_id;
  end if;

  perform public.staff_write_audit('task', p_task_id, 'ACCEPT', jsonb_build_object('status', v_old_code, 'user_id', auth.uid()), jsonb_build_object('status', v_new_code), v_task.to_department_id);
  perform public.staff_post_system_task_message(p_task_id, 'Accepted by ' || v_actor_name, v_actor_name || ' દ્વારા સ્વીકારાયું');
  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  values (v_task.assigned_by, 'task', p_task_id, 'Task accepted: ' || v_task.task_number, 'કામ સ્વીકાર્યું: ' || v_task.task_number);
end;
$function$;

create or replace function public.staff_start_task(p_task_id uuid)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid;
  v_assignee_count int; v_my_row record; v_actor_name text;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;
  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  select count(*) into v_assignee_count from public.staff_task_assignees where task_id = p_task_id and is_active;

  if v_assignee_count <= 1 then
    if v_old_code <> 'ACCEPTED' then
      raise exception 'Task must be ACCEPTED to start (currently %)', v_old_code;
    end if;
    if v_task.current_owner_id <> auth.uid() then
      raise exception 'Only the current owner may start this task';
    end if;

    select id into v_status_id from public.status_master where code = 'IN_PROGRESS';
    update public.staff_tasks set status_id = v_status_id where id = p_task_id;

    perform public.staff_write_audit('task', p_task_id, 'START', jsonb_build_object('status', v_old_code), jsonb_build_object('status','IN_PROGRESS'), v_task.to_department_id);
    perform public.staff_post_system_task_message(p_task_id, 'Task marked in progress by ' || v_actor_name, v_actor_name || ' દ્વારા કાર્ય પ્રગતિમાં ચિહ્નિત');
    return;
  end if;

  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;
  if v_my_row.id is null then
    raise exception 'You are not an active assignee on this task';
  end if;
  if v_my_row.individual_status <> 'ACCEPTED' then
    raise exception 'You must accept this task before starting it (your status is currently %)', v_my_row.individual_status;
  end if;

  update public.staff_task_assignees set individual_status = 'IN_PROGRESS' where id = v_my_row.id;

  if v_old_code in ('ASSIGNED','PARTIALLY_ACCEPTED','ACCEPTED') then
    select id into v_status_id from public.status_master where code = 'IN_PROGRESS';
    update public.staff_tasks set status_id = v_status_id where id = p_task_id;
  end if;

  perform public.staff_write_audit('task', p_task_id, 'START', jsonb_build_object('status', v_old_code, 'user_id', auth.uid()), jsonb_build_object('individual_status','IN_PROGRESS'), v_task.to_department_id);
  perform public.staff_post_system_task_message(p_task_id, v_actor_name || ' started their part', v_actor_name || ' એ પોતાનો ભાગ શરૂ કર્યો');
end;
$function$;

create or replace function public.staff_complete_task(p_task_id uuid)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid;
  v_assignee_count int; v_my_row record; v_active_count int; v_completed_count int; v_all_done boolean;
  v_actor_name text;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;
  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  select count(*) into v_assignee_count from public.staff_task_assignees where task_id = p_task_id and is_active;

  if v_assignee_count <= 1 then
    if v_old_code <> 'IN_PROGRESS' then
      raise exception 'Task must be IN_PROGRESS to complete (currently %)', v_old_code;
    end if;
    if v_task.current_owner_id <> auth.uid() then
      raise exception 'Only the current owner may complete this task';
    end if;

    select id into v_status_id from public.status_master where code = 'COMPLETED';
    update public.staff_tasks set status_id = v_status_id where id = p_task_id;

    if v_task.is_bridge then
      update public.bridges set completed_at = now() where task_id = p_task_id;
    end if;

    perform public.staff_write_audit('task', p_task_id, 'COMPLETE', jsonb_build_object('status', v_old_code), jsonb_build_object('status','COMPLETED'), v_task.to_department_id);
    perform public.staff_post_system_task_message(p_task_id, 'Task completed by ' || v_actor_name || ' — verification requested', v_actor_name || ' દ્વારા કાર્ય પૂર્ણ — ચકાસણી માટે વિનંતી');
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_task.verifier_id, 'task', p_task_id, 'Ready for verification: ' || v_task.task_number, 'ચકાસણી માટે તૈયાર: ' || v_task.task_number);
    return;
  end if;

  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;
  if v_my_row.id is null then
    raise exception 'You are not an active assignee on this task';
  end if;
  if v_my_row.individual_status <> 'IN_PROGRESS' then
    raise exception 'Task must be IN_PROGRESS to complete (your status is currently %)', v_my_row.individual_status;
  end if;

  update public.staff_task_assignees set individual_status = 'COMPLETED', completed_at = now() where id = v_my_row.id;

  if v_task.completion_rule = 'ANY_ONE' then
    v_all_done := true;
  else
    select count(*), count(*) filter (where individual_status = 'COMPLETED')
      into v_active_count, v_completed_count
      from public.staff_task_assignees where task_id = p_task_id and is_active;
    v_all_done := (v_completed_count = v_active_count);
  end if;

  if v_all_done and v_old_code not in ('COMPLETED','VERIFIED','CLOSED') then
    select id into v_status_id from public.status_master where code = 'COMPLETED';
    update public.staff_tasks set status_id = v_status_id where id = p_task_id;
    if v_task.is_bridge then
      update public.bridges set completed_at = now() where task_id = p_task_id;
    end if;
    perform public.staff_post_system_task_message(p_task_id, 'Task completed by ' || v_actor_name || ' — verification requested', v_actor_name || ' દ્વારા કાર્ય પૂર્ણ — ચકાસણી માટે વિનંતી');
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_task.verifier_id, 'task', p_task_id, 'Ready for verification: ' || v_task.task_number, 'ચકાસણી માટે તૈયાર: ' || v_task.task_number);
  elsif not v_all_done then
    select id into v_status_id from public.status_master where code = 'PARTIALLY_COMPLETED';
    update public.staff_tasks set status_id = v_status_id where id = p_task_id;
    perform public.staff_post_system_task_message(p_task_id, v_actor_name || ' completed their part', v_actor_name || ' એ પોતાનો ભાગ પૂર્ણ કર્યો');
  end if;

  perform public.staff_write_audit('task', p_task_id, 'COMPLETE', jsonb_build_object('status', v_old_code, 'user_id', auth.uid()), jsonb_build_object('individual_status','COMPLETED', 'all_done', v_all_done), v_task.to_department_id);
end;
$function$;

create or replace function public.staff_complete_task(p_task_id uuid, p_customer_confirmation_text text)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid;
  v_assignee_count int; v_my_row record; v_active_count int; v_completed_count int; v_all_done boolean;
  v_actor_name text;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;
  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  update public.staff_tasks set customer_confirmation_text = p_customer_confirmation_text where id = p_task_id;

  select count(*) into v_assignee_count from public.staff_task_assignees where task_id = p_task_id and is_active;

  if v_assignee_count <= 1 then
    if v_old_code <> 'IN_PROGRESS' then
      raise exception 'Task must be IN_PROGRESS to complete (currently %)', v_old_code;
    end if;
    if v_task.current_owner_id <> auth.uid() then
      raise exception 'Only the current owner may complete this task';
    end if;

    select id into v_status_id from public.status_master where code = 'COMPLETED';
    update public.staff_tasks set status_id = v_status_id where id = p_task_id;

    if v_task.is_bridge then
      update public.bridges set completed_at = now() where task_id = p_task_id;
    end if;

    perform public.staff_write_audit('task', p_task_id, 'COMPLETE', jsonb_build_object('status', v_old_code), jsonb_build_object('status','COMPLETED'), v_task.to_department_id);
    perform public.staff_post_system_task_message(p_task_id, 'Task completed by ' || v_actor_name || ' — verification requested', v_actor_name || ' દ્વારા કાર્ય પૂર્ણ — ચકાસણી માટે વિનંતી');
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_task.verifier_id, 'task', p_task_id, 'Ready for verification: ' || v_task.task_number, 'ચકાસણી માટે તૈયાર: ' || v_task.task_number);
    return;
  end if;

  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;
  if v_my_row.id is null then
    raise exception 'You are not an active assignee on this task';
  end if;
  if v_my_row.individual_status <> 'IN_PROGRESS' then
    raise exception 'Task must be IN_PROGRESS to complete (your status is currently %)', v_my_row.individual_status;
  end if;

  update public.staff_task_assignees set individual_status = 'COMPLETED', completed_at = now(), completion_note = p_customer_confirmation_text where id = v_my_row.id;

  if v_task.completion_rule = 'ANY_ONE' then
    v_all_done := true;
  else
    select count(*), count(*) filter (where individual_status = 'COMPLETED')
      into v_active_count, v_completed_count
      from public.staff_task_assignees where task_id = p_task_id and is_active;
    v_all_done := (v_completed_count = v_active_count);
  end if;

  if v_all_done and v_old_code not in ('COMPLETED','VERIFIED','CLOSED') then
    select id into v_status_id from public.status_master where code = 'COMPLETED';
    update public.staff_tasks set status_id = v_status_id where id = p_task_id;
    if v_task.is_bridge then
      update public.bridges set completed_at = now() where task_id = p_task_id;
    end if;
    perform public.staff_post_system_task_message(p_task_id, 'Task completed by ' || v_actor_name || ' — verification requested', v_actor_name || ' દ્વારા કાર્ય પૂર્ણ — ચકાસણી માટે વિનંતી');
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_task.verifier_id, 'task', p_task_id, 'Ready for verification: ' || v_task.task_number, 'ચકાસણી માટે તૈયાર: ' || v_task.task_number);
  elsif not v_all_done then
    select id into v_status_id from public.status_master where code = 'PARTIALLY_COMPLETED';
    update public.staff_tasks set status_id = v_status_id where id = p_task_id;
    perform public.staff_post_system_task_message(p_task_id, v_actor_name || ' completed their part', v_actor_name || ' એ પોતાનો ભાગ પૂર્ણ કર્યો');
  end if;

  perform public.staff_write_audit('task', p_task_id, 'COMPLETE', jsonb_build_object('status', v_old_code, 'user_id', auth.uid()), jsonb_build_object('individual_status','COMPLETED', 'all_done', v_all_done), v_task.to_department_id);
end;
$function$;

create or replace function public.staff_verify_task(p_task_id uuid)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid; v_actor_name text;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;
  if v_old_code <> 'COMPLETED' then
    raise exception 'Task must be COMPLETED to verify (currently %)', v_old_code;
  end if;
  if not (
    v_task.verifier_id = auth.uid() or public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_task.to_department_id))
  ) then
    raise exception 'You are not authorized to verify this task';
  end if;

  select id into v_status_id from public.status_master where code = 'VERIFIED';
  update public.staff_tasks set status_id = v_status_id, verified_by = auth.uid() where id = p_task_id;

  if v_task.is_bridge then
    update public.bridges set verified_by = auth.uid(), verified_at = now() where task_id = p_task_id;
  end if;

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();
  perform public.staff_write_audit('task', p_task_id, 'VERIFY', jsonb_build_object('status', v_old_code), jsonb_build_object('status','VERIFIED'), v_task.to_department_id);
  perform public.staff_post_system_task_message(p_task_id, 'Task verified by ' || v_actor_name, v_actor_name || ' દ્વારા કાર્ય ચકાસાયું');
end;
$function$;

create or replace function public.staff_close_task(p_task_id uuid)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid; v_actor_name text;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;
  if v_old_code <> 'VERIFIED' then
    raise exception 'Task must be VERIFIED to close (currently %)', v_old_code;
  end if;
  if not (
    v_task.verifier_id = auth.uid() or public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_task.to_department_id))
  ) then
    raise exception 'You are not authorized to close this task';
  end if;

  select id into v_status_id from public.status_master where code = 'CLOSED';
  update public.staff_tasks set status_id = v_status_id, closed_by = auth.uid() where id = p_task_id;

  if v_task.is_bridge then
    update public.bridges set closed_at = now() where task_id = p_task_id;
  end if;

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();
  perform public.staff_write_audit('task', p_task_id, 'CLOSE', jsonb_build_object('status', v_old_code), jsonb_build_object('status','CLOSED'), v_task.to_department_id);
  perform public.staff_post_system_task_message(p_task_id, 'Task closed by ' || v_actor_name, v_actor_name || ' દ્વારા કાર્ય બંધ કરાયું');
end;
$function$;

create or replace function public.staff_return_task(p_task_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_status_id uuid; v_allowed boolean := false;
  v_assignee_count int; v_my_row record; v_actor_name text;
begin
  perform public.staff_assert_operational();
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A return reason is required';
  end if;

  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;
  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  select count(*) into v_assignee_count from public.staff_task_assignees where task_id = p_task_id and is_active;

  if v_assignee_count <= 1 then
    if v_old_code = 'ASSIGNED' then
      v_allowed := (v_task.assigned_to = auth.uid()) or public.staff_is_super_admin();
    elsif v_old_code in ('ACCEPTED','IN_PROGRESS') then
      v_allowed := (v_task.current_owner_id = auth.uid()) or public.staff_is_super_admin();
    elsif v_old_code = 'COMPLETED' then
      v_allowed := (v_task.verifier_id = auth.uid() or public.staff_is_management() or public.staff_is_super_admin()
                    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_task.to_department_id)));
    else
      raise exception 'Task cannot be returned from status %', v_old_code;
    end if;

    if not v_allowed then
      raise exception 'You are not authorized to return this task at its current stage';
    end if;

    select id into v_status_id from public.status_master where code = 'RETURNED';
    update public.staff_tasks set status_id = v_status_id, return_reason = p_reason where id = p_task_id;

    if v_task.is_bridge then
      update public.bridges set acceptance_status = 'RETURNED', return_reason = p_reason where task_id = p_task_id;
    end if;

    perform public.staff_write_audit('task', p_task_id, 'RETURN', jsonb_build_object('status', v_old_code), jsonb_build_object('status','RETURNED','reason',p_reason), v_task.to_department_id);
    perform public.staff_post_system_task_message(p_task_id, 'Task returned by ' || v_actor_name || ': ' || p_reason, v_actor_name || ' દ્વારા કાર્ય પરત: ' || p_reason);
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_task.assigned_by, 'task', p_task_id, 'Task returned: ' || v_task.task_number, 'કામ પરત: ' || v_task.task_number);
    return;
  end if;

  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;
  if v_my_row.id is null then
    raise exception 'You are not an active assignee on this task';
  end if;
  if v_my_row.individual_status = 'COMPLETED' then
    raise exception 'You have already completed your part of this task';
  end if;

  update public.staff_task_assignees set acceptance_status = 'REJECTED', individual_status = 'REJECTED' where id = v_my_row.id;

  perform public.staff_write_audit('task', p_task_id, 'RETURN', jsonb_build_object('user_id', auth.uid(), 'status', v_my_row.individual_status), jsonb_build_object('individual_status','REJECTED','reason',p_reason), v_task.to_department_id, p_reason);
  perform public.staff_post_system_task_message(p_task_id, v_actor_name || ' returned their part: ' || p_reason, v_actor_name || ' એ પોતાનો ભાગ પરત કર્યો: ' || p_reason);
  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  values (v_task.assigned_by, 'task', p_task_id, 'An assignee returned their part: ' || v_task.task_number, 'એક વ્યક્તિએ પોતાનો ભાગ પરત કર્યો: ' || v_task.task_number);
end;
$function$;

create or replace function public.staff_reassign_task(p_task_id uuid, p_reason text, p_new_assigned_to uuid default null, p_new_verifier_id uuid default null, p_new_to_department_id uuid default null)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_old_code text; v_old_assignee uuid; v_new_dept uuid;
  v_new_verifier_role text; v_new_verifier_department uuid;
  v_caller_role text;
  v_new_to_department_id uuid; v_dept_changed boolean; v_new_is_bridge boolean;
  v_from_confidential boolean; v_new_to_confidential boolean;
  v_actor_name text; v_old_name text; v_new_name text;
begin
  perform public.staff_assert_operational();
  v_caller_role := public.staff_current_role_code();

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required for reassignment';
  end if;

  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select code into v_old_code from public.status_master where id = v_task.status_id;

  if v_old_code not in ('ASSIGNED','RETURNED','ACCEPTED','IN_PROGRESS') then
    raise exception 'Task cannot be reassigned from status % — only ASSIGNED, RETURNED, ACCEPTED, or IN_PROGRESS may be reassigned', v_old_code;
  end if;

  if not (
    public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_task.to_department_id))
  ) then
    raise exception 'You are not authorized to reassign this task';
  end if;

  v_old_assignee := v_task.assigned_to;
  v_new_to_department_id := coalesce(p_new_to_department_id, v_task.to_department_id);
  v_dept_changed := (p_new_to_department_id is not null and p_new_to_department_id is distinct from v_task.to_department_id);

  if v_dept_changed then
    if not exists (select 1 from public.departments where id = v_new_to_department_id and is_active = true) then
      raise exception 'Invalid destination department';
    end if;
    if p_new_assigned_to is null then
      raise exception 'A new assignee is required when changing the destination department';
    end if;

    select is_confidential_domain into v_from_confidential from public.departments where id = v_task.from_department_id;
    select is_confidential_domain into v_new_to_confidential from public.departments where id = v_new_to_department_id;
    v_new_is_bridge := (v_task.from_department_id <> v_new_to_department_id);

    if v_new_is_bridge then
      if v_from_confidential or v_new_to_confidential then
        raise exception 'Cross-department Bridges into/out of a confidential department are disabled in this pilot';
      end if;
    else
      if v_from_confidential and v_caller_role not in ('management','cfo','accounts_head','accounts_employee','sysadmin') then
        raise exception 'Only Accounts roles, Management, or Super Admin may reassign a task within a confidential department';
      end if;
    end if;
  end if;

  if p_new_assigned_to is not null then
    select department_id into v_new_dept from public.user_profiles where id = p_new_assigned_to and is_active = true;
    if v_new_dept is null then raise exception 'Invalid or inactive new assignee'; end if;
    if v_new_dept is distinct from v_new_to_department_id then
      raise exception 'New assignee must belong to the destination department';
    end if;
  end if;

  if p_new_verifier_id is not null then
    v_new_verifier_role := public.staff_user_role_code(p_new_verifier_id);
    if v_new_verifier_role is null then
      raise exception 'Invalid or inactive new verifier';
    end if;
    select department_id into v_new_verifier_department from public.user_profiles where id = p_new_verifier_id;
    if not (
      v_new_verifier_role = 'management'
      or v_new_verifier_department = v_new_to_department_id
      or (v_new_verifier_role = 'dept_head' and public.staff_user_dept_in_hod_scope(p_new_verifier_id, v_new_to_department_id))
    ) then
      raise exception 'new verifier is not authorized for the destination department';
    end if;
  elsif v_dept_changed then
    v_new_verifier_role := public.staff_user_role_code(v_task.verifier_id);
    select department_id into v_new_verifier_department from public.user_profiles where id = v_task.verifier_id;
    if not (
      v_task.verifier_id = v_task.assigned_by
      or v_new_verifier_role = 'management'
      or v_new_verifier_department = v_new_to_department_id
      or (v_new_verifier_role = 'dept_head' and public.staff_user_dept_in_hod_scope(v_task.verifier_id, v_new_to_department_id))
    ) then
      raise exception 'The existing verifier is not authorized for the new destination department — specify a new verifier';
    end if;
  end if;

  update public.staff_tasks set
    to_department_id = v_new_to_department_id,
    is_bridge = case when v_dept_changed then v_new_is_bridge else is_bridge end,
    assigned_to = coalesce(p_new_assigned_to, assigned_to),
    verifier_id = coalesce(p_new_verifier_id, verifier_id),
    current_owner_id = case
      when p_new_assigned_to is not null and (v_old_code in ('ACCEPTED','IN_PROGRESS') or v_dept_changed) then p_new_assigned_to
      else current_owner_id
    end
  where id = p_task_id;

  if p_new_assigned_to is not null and p_new_assigned_to <> v_old_assignee then
    update public.staff_task_assignees set is_active = false, removed_at = now(), removed_by = auth.uid(), removal_reason = 'Reassigned'
      where task_id = p_task_id and assignment_role = 'primary' and is_active;
    insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by)
    values (p_task_id, p_new_assigned_to, 'primary', auth.uid());
  end if;

  if v_dept_changed then
    if v_new_is_bridge then
      if v_task.is_bridge then
        update public.bridges set
          to_department_id = v_new_to_department_id,
          to_person_id = p_new_assigned_to
        where task_id = p_task_id;
      else
        insert into public.bridges as inserted_bridge (task_id, from_department_id, to_department_id, from_person_id, to_person_id, requirement_text)
        values (p_task_id, v_task.from_department_id, v_new_to_department_id, auth.uid(), p_new_assigned_to, coalesce(v_task.description, v_task.title));
      end if;
    else
      update public.bridges set is_active = false where task_id = p_task_id and is_active = true;
    end if;
  elsif v_task.is_bridge and p_new_assigned_to is not null then
    update public.bridges set to_person_id = p_new_assigned_to where task_id = p_task_id;
  end if;

  perform public.staff_write_audit('task', p_task_id, 'REASSIGN',
    jsonb_build_object('assigned_to', v_old_assignee, 'verifier_id', v_task.verifier_id, 'to_department_id', v_task.to_department_id, 'status', v_old_code),
    jsonb_build_object('assigned_to', coalesce(p_new_assigned_to, v_old_assignee), 'verifier_id', coalesce(p_new_verifier_id, v_task.verifier_id), 'to_department_id', v_new_to_department_id, 'reason', p_reason),
    v_new_to_department_id, p_reason);

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();
  if p_new_assigned_to is not null and p_new_assigned_to <> v_old_assignee then
    select full_name into v_old_name from public.user_profiles where id = v_old_assignee;
    select full_name into v_new_name from public.user_profiles where id = p_new_assigned_to;
    perform public.staff_post_system_task_message(p_task_id,
      'Reassigned from ' || coalesce(v_old_name, '—') || ' to ' || coalesce(v_new_name, '—') || ' by ' || v_actor_name,
      v_actor_name || ' દ્વારા ' || coalesce(v_old_name, '—') || ' થી ' || coalesce(v_new_name, '—') || ' ને ફરીથી સોંપાયું');
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_old_assignee, 'task', p_task_id, 'Reassigned away from you: ' || v_task.task_number, 'તમારી પાસેથી ફરીથી સોંપાયું: ' || v_task.task_number);
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (p_new_assigned_to, 'task', p_task_id, 'Task reassigned to you: ' || v_task.task_number, 'તમને કામ ફરીથી સોંપાયું: ' || v_task.task_number);
  else
    perform public.staff_post_system_task_message(p_task_id, 'Task updated by ' || v_actor_name, v_actor_name || ' દ્વારા કાર્ય અપડેટ કરાયું');
  end if;
end;
$function$;

create or replace function public.staff_set_task_blocked(p_task_id uuid, p_blocked boolean, p_note text)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_task public.staff_tasks%rowtype; v_assignee_count int; v_my_row record; v_actor_name text;
begin
  perform public.staff_assert_operational();
  select * into v_task from public.staff_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'Task not found'; end if;
  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  select count(*) into v_assignee_count from public.staff_task_assignees where task_id = p_task_id and is_active;

  if v_assignee_count <= 1 then
    update public.staff_tasks set help_requested = p_blocked where id = p_task_id;
    perform public.staff_write_audit('task', p_task_id, 'BLOCKED', null, jsonb_build_object('help_requested', p_blocked, 'note', p_note), v_task.to_department_id, p_note);
    perform public.staff_post_system_task_message(p_task_id,
      case when p_blocked then v_actor_name || ' marked this task as blocked' else v_actor_name || ' resumed work' end,
      case when p_blocked then v_actor_name || ' એ આ કાર્યને અટકેલું ચિહ્નિત કર્યું' else v_actor_name || ' એ કામ ફરી શરૂ કર્યું' end);
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_task.assigned_by, 'task', p_task_id, 'Help requested on task: ' || v_task.task_number, 'કામ પર મદદ માંગી: ' || v_task.task_number);
    return;
  end if;

  select * into v_my_row from public.staff_task_assignees where task_id = p_task_id and user_id = auth.uid() and is_active for update;
  if v_my_row.id is null then
    raise exception 'You are not an active assignee on this task';
  end if;

  update public.staff_task_assignees set individual_status = case when p_blocked then 'BLOCKED' else 'IN_PROGRESS' end where id = v_my_row.id;

  perform public.staff_write_audit('task', p_task_id, 'BLOCKED', jsonb_build_object('user_id', auth.uid()), jsonb_build_object('blocked', p_blocked, 'note', p_note), v_task.to_department_id, p_note);
  perform public.staff_post_system_task_message(p_task_id,
    case when p_blocked then v_actor_name || ' marked their part as blocked' else v_actor_name || ' resumed their part' end,
    case when p_blocked then v_actor_name || ' એ પોતાનો ભાગ અટકેલો ચિહ્નિત કર્યો' else v_actor_name || ' એ પોતાનો ભાગ ફરી શરૂ કર્યો' end);
  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  values (v_task.assigned_by, 'task', p_task_id,
    case when p_blocked then 'An assignee is blocked on task: ' || v_task.task_number else 'An assignee resumed work on task: ' || v_task.task_number end,
    case when p_blocked then 'એક વ્યક્તિ કામ પર અટકી ગઈ: ' || v_task.task_number else 'એક વ્યક્તિએ કામ ફરી શરૂ કર્યું: ' || v_task.task_number end);
end;
$function$;
