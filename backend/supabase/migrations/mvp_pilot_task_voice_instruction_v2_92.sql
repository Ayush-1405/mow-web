-- v2_92 -- Voice instruction on tasks (record at "Assign Task" -> stored -> permanently linked -> playable by everyone who can see the task).
--
-- Uses the EXISTING normalized attachment system (public.staff_attachments + private bucket "staff-attachments" + signed URLs minted by the
-- staff-file-url edge function); no second storage mechanism, no blob: URLs, no base64 in a table.
--
-- Root causes fixed here (database side):
--  * staff_record_attachment compared the DECLARED mime type with the stored object's mime type as raw strings. Browsers record
--    "audio/webm;codecs=opus" while Storage keeps "audio/webm", so a perfectly good recording was refused ("Declared mime_type does not
--    match the uploaded object") and left behind as an unlinked storage object (16 such recordings exist). Both sides are now compared by
--    base type.
--  * There was no way to tell a voice INSTRUCTION (recorded when the task is assigned) from a voice NOTE / completion proof, so the UI
--    could not present it as "Voice Instruction". staff_attachments.purpose now says which it is.
--  * Removing / replacing a recording, and deleting a task, did not archive the attachment. They do now (soft-archive with who / when / why;
--    the storage object is retained per the retention policy).

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. Columns, indexes, realtime
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.staff_attachments add column if not exists purpose text;
alter table public.staff_attachments add column if not exists storage_bucket text not null default 'staff-attachments';
alter table public.staff_attachments add column if not exists removed_at timestamptz;
alter table public.staff_attachments add column if not exists removed_by uuid references public.user_profiles(id);
alter table public.staff_attachments add column if not exists removal_reason text;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.staff_attachments'::regclass and conname = 'staff_attachments_purpose_check') then
    alter table public.staff_attachments add constraint staff_attachments_purpose_check check (purpose is null or purpose in ('instruction', 'proof', 'note'));
  end if;
end $$;

create index if not exists staff_attachments_entity_idx on public.staff_attachments (entity_type, entity_id) where is_active;
create index if not exists staff_attachments_path_idx on public.staff_attachments (storage_path);
create index if not exists staff_attachments_instruction_idx on public.staff_attachments (entity_id) where is_active and purpose = 'instruction';

-- Existing voice recordings made while assigning (uploaded by the task's own assigner shortly after the task was created) are instructions.
update public.staff_attachments a set purpose = 'instruction'
  from public.staff_tasks t
 where a.entity_type = 'task' and a.entity_id = t.id and a.file_type = 'voice' and a.purpose is null
   and a.uploaded_by = t.assigned_by and a.created_at <= t.created_at + interval '15 minutes';

-- The assignee's open Today's Tasks list learns about a new instruction instantly (RLS still decides who receives the event).
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'staff_attachments') then
    alter publication supabase_realtime add table public.staff_attachments;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. staff_record_attachment: base-type mime comparison + purpose ('instruction' rules) + one active instruction per task
-- ---------------------------------------------------------------------------------------------------------------------------------
drop function if exists public.staff_record_attachment(text, uuid, text, text, text, text, bigint, integer);

create or replace function public.staff_record_attachment(
  p_entity_type text, p_entity_id uuid, p_file_type text, p_storage_path text, p_original_filename text, p_mime_type text, p_file_size bigint,
  p_duration_seconds integer default null, p_purpose text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_task public.staff_tasks%rowtype;
  v_bridge public.bridges%rowtype;
  v_has_access boolean := false;
  v_confidential boolean := false;
  v_attachment_id uuid;
  v_max_bytes bigint := 20 * 1024 * 1024;
  v_storage_obj record;
  v_base_mime text := lower(btrim(split_part(p_mime_type, ';', 1)));
  v_obj_mime text;
  v_old record;
begin
  perform public.staff_assert_operational();

  if p_file_type not in ('image','pdf','word','excel','drawing','voice') then
    raise exception 'Unsupported file_type';
  end if;
  if p_purpose is not null and p_purpose not in ('instruction', 'proof', 'note') then
    raise exception 'Unsupported attachment purpose';
  end if;
  if p_file_size is null or p_file_size <= 0 or p_file_size > v_max_bytes then
    raise exception 'File size invalid or exceeds the pilot limit';
  end if;
  if p_file_type = 'voice' and p_file_size > 5 * 1024 * 1024 then
    raise exception 'Voice messages are limited to 5 MB';
  end if;
  if (p_file_type = 'image' and v_base_mime not in ('image/jpeg','image/png','image/webp','image/heic','image/heif'))
     or (p_file_type = 'pdf' and v_base_mime <> 'application/pdf')
     or (p_file_type = 'word' and v_base_mime not in ('application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain'))
     or (p_file_type = 'excel' and v_base_mime not in ('application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv'))
     or (p_file_type = 'drawing' and v_base_mime not in ('application/dxf','application/dwg','image/vnd.dwg','image/vnd.dxf','application/x-dwg','application/x-dxf','application/acad'))
     or (p_file_type = 'voice' and v_base_mime not in ('audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav','audio/x-m4a','audio/aac'))
  then
    raise exception 'mime_type does not match file_type';
  end if;
  if p_file_type = 'voice' and (p_duration_seconds is null or p_duration_seconds <= 0 or p_duration_seconds > 60) then
    raise exception 'Voice messages must be between 1 and 60 seconds';
  end if;
  if p_purpose = 'instruction' and (p_file_type <> 'voice' or p_entity_type <> 'task') then
    raise exception 'Only a voice recording on a task can be a voice instruction';
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
  -- Compare BASE types: a browser records "audio/webm;codecs=opus", Storage keeps "audio/webm" -- the same file.
  if v_storage_obj.metadata ? 'mimetype' then
    v_obj_mime := lower(btrim(split_part(v_storage_obj.metadata->>'mimetype', ';', 1)));
    if v_obj_mime <> v_base_mime then
      raise exception 'Declared mime_type does not match the uploaded object';
    end if;
  end if;
  -- the same object may be recorded once: a retry after a lost response must not create a second attachment row
  select id into v_attachment_id from public.staff_attachments where storage_path = p_storage_path and entity_id = p_entity_id and is_active;
  if v_attachment_id is not null then return v_attachment_id; end if;

  if p_entity_type = 'task' then
    select * into v_task from public.staff_tasks where id = p_entity_id;
    if v_task.id is null then raise exception 'Parent task does not exist'; end if;
    v_has_access := public.staff_can_view_task(v_task);
    select true into v_confidential from public.departments d where d.id in (v_task.from_department_id, v_task.to_department_id) and d.is_confidential_domain = true limit 1;
  elsif p_entity_type = 'bridge' then
    select * into v_bridge from public.bridges where id = p_entity_id;
    if v_bridge.id is null then raise exception 'Parent bridge does not exist'; end if;
    v_has_access := v_bridge.from_person_id = auth.uid() or v_bridge.to_person_id = auth.uid() or public.staff_task_visible(v_bridge.task_id);
  else
    raise exception 'Invalid entity_type';
  end if;

  if not v_has_access then
    raise exception 'You do not have access to attach files to this %', p_entity_type;
  end if;
  if coalesce(v_confidential, false) and not public.staff_has_capability('can_view_restricted_finance') then
    raise exception 'Attachments on a confidential-domain task are restricted';
  end if;
  -- A voice INSTRUCTION belongs to whoever assigns the task (or someone who manages it), not to the person doing the work.
  if p_purpose = 'instruction' and not (
       v_task.assigned_by = auth.uid()
       or public.staff_has_global_oversight()
       or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_task.to_department_id))) then
    raise exception 'Only the person who assigned this task (or a manager) can add its voice instruction';
  end if;

  -- One active instruction per task: recording a new one replaces (archives) the previous.
  if p_purpose = 'instruction' then
    for v_old in select id, storage_path from public.staff_attachments where entity_type = 'task' and entity_id = p_entity_id and purpose = 'instruction' and is_active loop
      update public.staff_attachments set is_active = false, removed_at = now(), removed_by = auth.uid(), removal_reason = 'replaced by a new voice instruction' where id = v_old.id;
      perform public.staff_write_audit('task', p_entity_id, 'ATTACH_REPLACE', jsonb_build_object('attachment_id', v_old.id), null, null, 'voice instruction replaced');
    end loop;
  end if;

  insert into public.staff_attachments (entity_type, entity_id, file_type, storage_path, original_filename, mime_type, file_size, duration_seconds, uploaded_by, is_confidential, purpose, storage_bucket)
  values (p_entity_type, p_entity_id, p_file_type, p_storage_path, p_original_filename, p_mime_type, p_file_size, p_duration_seconds, auth.uid(), coalesce(v_confidential, false), p_purpose, 'staff-attachments')
  returning id into v_attachment_id;

  perform public.staff_write_audit(p_entity_type, p_entity_id, 'ATTACH', null,
    jsonb_build_object('attachment_id', v_attachment_id, 'file_type', p_file_type, 'purpose', p_purpose), null);

  return v_attachment_id;
end;
$$;

revoke execute on function public.staff_record_attachment(text, uuid, text, text, text, text, bigint, integer, text) from public, anon;
grant execute on function public.staff_record_attachment(text, uuid, text, text, text, text, bigint, integer, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. Remove / archive an attachment (used by "Remove" and "Re-record" on a voice instruction)
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.staff_remove_attachment(p_attachment_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare a public.staff_attachments%rowtype; t public.staff_tasks%rowtype;
begin
  perform public.staff_assert_operational();
  select * into a from public.staff_attachments where id = p_attachment_id and is_active;
  if a.id is null then raise exception 'Attachment not found'; end if;
  if a.entity_type = 'task' then select * into t from public.staff_tasks where id = a.entity_id; end if;
  if not (
       a.uploaded_by = auth.uid()
       or (t.id is not null and t.assigned_by = auth.uid())
       or (t.id is not null and public.staff_has_global_oversight() and public.staff_has_capability('can_delete_records'))
       or (t.id is not null and public.staff_is_dept_head() and public.staff_dept_in_hod_scope(t.to_department_id))) then
    raise exception 'You are not allowed to remove this attachment';
  end if;
  update public.staff_attachments set is_active = false, removed_at = now(), removed_by = auth.uid(), removal_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = a.id;
  perform public.staff_write_audit(a.entity_type, a.entity_id, 'ATTACH_REMOVE',
    jsonb_build_object('attachment_id', a.id, 'file_type', a.file_type, 'purpose', a.purpose), jsonb_build_object('is_active', false), null, nullif(btrim(coalesce(p_reason, '')), ''));
end $$;

revoke execute on function public.staff_remove_attachment(uuid, text) from public, anon;
grant execute on function public.staff_remove_attachment(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. Voice instructions for a batch of tasks (one round trip for a whole list); only tasks the caller may see; includes the recorder's name
--    (user_profiles is not readable by an ordinary assignee, so the name is resolved here).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.staff_task_voice_instructions(p_task_ids uuid[])
returns table (id uuid, task_id uuid, mime_type text, file_size bigint, duration_seconds integer, original_filename text, recorded_by uuid, recorded_by_name text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select a.id, a.entity_id, a.mime_type, a.file_size, a.duration_seconds, a.original_filename, a.uploaded_by, up.full_name, a.created_at
    from public.staff_attachments a
    join public.user_profiles up on up.id = a.uploaded_by
   where public.staff_current_user_ok()
     and a.entity_type = 'task' and a.entity_id = any (p_task_ids) and a.file_type = 'voice' and a.purpose = 'instruction' and a.is_active
     and public.staff_task_visible(a.entity_id);
$$;

revoke execute on function public.staff_task_voice_instructions(uuid[]) from public, anon;
grant execute on function public.staff_task_voice_instructions(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. Deleting a task archives its attachments (rows kept for audit; hidden from every list). The task DELETE is already audited.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function pg_temp.patch_fn(p_sig regprocedure, p_regex text, p_to text, p_already text default null) returns void language plpgsql as $$
declare d text;
begin
  d := pg_get_functiondef(p_sig);
  if position(coalesce(p_already, p_to) in d) > 0 then return; end if;
  if d !~* p_regex then raise exception 'patch anchor not found in %: %', p_sig, left(p_regex, 80); end if;
  execute regexp_replace(d, p_regex, replace(p_to, '\', '\\'), 'i');
end $$;

select pg_temp.patch_fn('public.staff_delete_task(uuid)'::regprocedure,
  'UPDATE public\.staff_tasks SET is_active = false WHERE id = p_task_id;',
  'UPDATE public.staff_tasks SET is_active = false WHERE id = p_task_id;
  UPDATE public.staff_attachments SET is_active = false, removed_at = now(), removed_by = auth.uid(), removal_reason = ''task deleted'' WHERE entity_type = ''task'' AND entity_id = p_task_id AND is_active;');
