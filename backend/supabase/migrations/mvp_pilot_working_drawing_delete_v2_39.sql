-- Secure soft-delete / recycle bin / permanent-delete for Working Drawings files.
-- Covers BOTH source tables the Working Drawings screen merges into one list:
-- `attachments` (stage IN ('Working Drawings','Drawings') -- where new uploads land)
-- and `working_drawing_attachments` (legacy rows from the earlier complex era).

alter table public.attachments
  add column if not exists is_deleted boolean not null default false,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.profiles(id),
  add column if not exists deletion_reason_code text,
  add column if not exists deletion_reason_note text,
  add column if not exists restored_at timestamptz,
  add column if not exists restored_by uuid references public.profiles(id);

alter table public.working_drawing_attachments
  add column if not exists is_deleted boolean not null default false,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.profiles(id),
  add column if not exists deletion_reason_code text,
  add column if not exists deletion_reason_note text,
  add column if not exists restored_at timestamptz,
  add column if not exists restored_by uuid references public.profiles(id);

create index if not exists attachments_is_deleted_idx on public.attachments(project_id, is_deleted);
create index if not exists working_drawing_attachments_is_deleted_idx on public.working_drawing_attachments(project_id, is_deleted);

-- Block direct client writes to the delete/restore columns regardless of the
-- existing permissive *_update_scoped RLS policy (project members can update
-- ordinary columns like title/file_category, but must go through the RPCs
-- below for anything that changes deletion state). SECURITY DEFINER functions
-- below are owned by the migration role and are unaffected by this revoke.
revoke update (is_deleted, deleted_at, deleted_by, deletion_reason_code, deletion_reason_note, restored_at, restored_by)
  on public.attachments from authenticated;
revoke update (is_deleted, deleted_at, deleted_by, deletion_reason_code, deletion_reason_note, restored_at, restored_by)
  on public.working_drawing_attachments from authenticated;

-- Force all hard deletes through the permanent-delete RPC (Management/Super
-- Admin gated). Existing DELETE policies are now redundant/too broad.
revoke delete on public.attachments from authenticated;
revoke delete on public.working_drawing_attachments from authenticated;
drop policy if exists "management can delete attachments" on public.attachments;
drop policy if exists "working_drawing_attachments_delete_scoped" on public.working_drawing_attachments;

create or replace function public.interior_files_can_view_deleted() returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    (select r.code from public.user_profiles up join public.roles r on r.id = up.role_id where up.id = auth.uid())
      in ('management', 'sysadmin', 'dept_head', 'accounts_head', 'cfo'),
    false
  );
$$;

create or replace function public.interior_files_can_purge() returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    (select r.code from public.user_profiles up join public.roles r on r.id = up.role_id where up.id = auth.uid())
      in ('management', 'sysadmin'),
    false
  );
$$;

drop policy if exists "attachments_select_scoped" on public.attachments;
create policy "attachments_select_scoped" on public.attachments for select using (
  (is_deleted = false and (public.interior_is_org_wide() or public.interior_is_project_member(project_id)))
  or (is_deleted = true and public.interior_files_can_view_deleted())
);

drop policy if exists "working_drawing_attachments_select_scoped" on public.working_drawing_attachments;
create policy "working_drawing_attachments_select_scoped" on public.working_drawing_attachments for select using (
  (is_deleted = false and (public.interior_is_org_wide() or public.interior_is_project_member(project_id)))
  or (is_deleted = true and public.interior_files_can_view_deleted())
);

-- Fixed allow-list mirrored exactly by the frontend's reason dropdown.
create or replace function public.interior_valid_deletion_reason(p_code text) returns boolean
  language sql immutable as $$
  select p_code in (
    'WRONG_FILE', 'WRONG_PROJECT', 'DUPLICATE', 'WRONG_VERSION', 'REPLACED',
    'WRONG_CATEGORY', 'CORRUPTED', 'CLIENT_REJECTED', 'NOT_REQUIRED', 'OTHER'
  );
$$;

create or replace function public.delete_project_attachment(
  p_source text, p_attachment_id uuid, p_project_id uuid, p_reason_code text, p_reason_note text
) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_deleted_by uuid;
  v_title text; v_file_name text; v_category text; v_uploaded_by uuid; v_uploaded_at timestamptz;
  v_is_deleted boolean;
begin
  if p_source not in ('attachments', 'working_drawing_attachments') then
    raise exception 'Invalid file source';
  end if;

  if not public.interior_valid_deletion_reason(p_reason_code) then
    raise exception 'Invalid deletion reason';
  end if;
  if length(btrim(coalesce(p_reason_note, ''))) < 10 then
    raise exception 'Detailed reason must be at least 10 characters';
  end if;

  if not (public.interior_is_org_wide() or public.interior_is_project_member(p_project_id)) then
    raise exception 'Not authorized for this project';
  end if;

  if p_source = 'attachments' then
    select title, file_name, file_category, uploaded_by, created_at, is_deleted
      into v_title, v_file_name, v_category, v_uploaded_by, v_uploaded_at, v_is_deleted
      from public.attachments where id = p_attachment_id and project_id = p_project_id;
  else
    select title, file_name, file_category, uploaded_by, uploaded_at, is_deleted
      into v_title, v_file_name, v_category, v_uploaded_by, v_uploaded_at, v_is_deleted
      from public.working_drawing_attachments where id = p_attachment_id and project_id = p_project_id;
  end if;

  if not found then
    raise exception 'File not found for this project';
  end if;
  if v_is_deleted then
    raise exception 'File is already deleted';
  end if;

  select id into v_deleted_by from public.profiles where auth_id = auth.uid();

  if p_source = 'attachments' then
    update public.attachments set
      is_deleted = true, deleted_at = now(), deleted_by = v_deleted_by,
      deletion_reason_code = p_reason_code, deletion_reason_note = p_reason_note
      where id = p_attachment_id;
  else
    update public.working_drawing_attachments set
      is_deleted = true, deleted_at = now(), deleted_by = v_deleted_by,
      deletion_reason_code = p_reason_code, deletion_reason_note = p_reason_note
      where id = p_attachment_id;
  end if;

  insert into public.interior_pilot_audit_log(table_name, record_id, action, detail, project_id)
  values (p_source, p_attachment_id, 'delete', jsonb_build_object(
    'title', v_title, 'file_name', v_file_name, 'file_category', v_category,
    'reason_code', p_reason_code, 'reason_note', p_reason_note,
    'uploaded_by', v_uploaded_by, 'uploaded_at', v_uploaded_at
  ), p_project_id);
end;
$function$;

create or replace function public.restore_project_attachment(
  p_source text, p_attachment_id uuid, p_project_id uuid
) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_restored_by uuid;
  v_is_deleted boolean;
  v_title text;
begin
  if p_source not in ('attachments', 'working_drawing_attachments') then
    raise exception 'Invalid file source';
  end if;
  if not public.interior_files_can_view_deleted() then
    raise exception 'Not authorized to restore files';
  end if;

  if p_source = 'attachments' then
    select is_deleted, title into v_is_deleted, v_title from public.attachments where id = p_attachment_id and project_id = p_project_id;
  else
    select is_deleted, title into v_is_deleted, v_title from public.working_drawing_attachments where id = p_attachment_id and project_id = p_project_id;
  end if;

  if not found then
    raise exception 'File not found for this project';
  end if;
  if not v_is_deleted then
    raise exception 'File is not deleted';
  end if;

  select id into v_restored_by from public.profiles where auth_id = auth.uid();

  if p_source = 'attachments' then
    update public.attachments set is_deleted = false, restored_at = now(), restored_by = v_restored_by where id = p_attachment_id;
  else
    update public.working_drawing_attachments set is_deleted = false, restored_at = now(), restored_by = v_restored_by where id = p_attachment_id;
  end if;

  insert into public.interior_pilot_audit_log(table_name, record_id, action, detail, project_id)
  values (p_source, p_attachment_id, 'restore', jsonb_build_object('title', v_title), p_project_id);
end;
$function$;

create or replace function public.finalize_permanent_delete_attachment(
  p_source text, p_attachment_id uuid, p_project_id uuid, p_reason_code text, p_reason_note text
) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_is_deleted boolean;
  v_title text; v_storage_path text;
begin
  if p_source not in ('attachments', 'working_drawing_attachments') then
    raise exception 'Invalid file source';
  end if;
  if not public.interior_files_can_purge() then
    raise exception 'Not authorized to permanently delete files';
  end if;
  if not public.interior_valid_deletion_reason(p_reason_code) then
    raise exception 'Invalid deletion reason';
  end if;
  if length(btrim(coalesce(p_reason_note, ''))) < 10 then
    raise exception 'Detailed reason must be at least 10 characters';
  end if;

  if p_source = 'attachments' then
    select is_deleted, title, storage_path into v_is_deleted, v_title, v_storage_path
      from public.attachments where id = p_attachment_id and project_id = p_project_id;
  else
    select is_deleted, title, storage_path into v_is_deleted, v_title, v_storage_path
      from public.working_drawing_attachments where id = p_attachment_id and project_id = p_project_id;
  end if;

  if not found then
    raise exception 'File not found for this project';
  end if;
  if not v_is_deleted then
    raise exception 'File must be soft-deleted before it can be permanently deleted';
  end if;

  -- The actual Storage object is removed by the caller (via the Storage API,
  -- gated by the interior_attachments_storage_delete_scoped policy below)
  -- BEFORE this runs. This only tombstones the DB row -- storage_path is
  -- nulled so the file stops appearing downloadable, while title/category/
  -- deletion history are kept as a permanent audit record.
  if p_source = 'attachments' then
    update public.attachments set storage_path = null where id = p_attachment_id;
  else
    update public.working_drawing_attachments set storage_path = null where id = p_attachment_id;
  end if;

  insert into public.interior_pilot_audit_log(table_name, record_id, action, detail, project_id)
  values (p_source, p_attachment_id, 'permanent_delete', jsonb_build_object(
    'title', v_title, 'original_storage_path', v_storage_path,
    'reason_code', p_reason_code, 'reason_note', p_reason_note
  ), p_project_id);
end;
$function$;

-- No DELETE policy previously existed on this bucket at all -- nobody could
-- remove any object. This adds one, narrowly: only management/sysadmin, and
-- only for the exact path of a row that is already soft-deleted in one of
-- the two attachment tables (never a folder/wildcard match).
drop policy if exists "interior_attachments_storage_delete_scoped" on storage.objects;
create policy "interior_attachments_storage_delete_scoped" on storage.objects for delete using (
  bucket_id = 'interior-attachments' and public.interior_files_can_purge() and (
    exists (select 1 from public.attachments a where a.storage_path = storage.objects.name and a.is_deleted = true)
    or exists (select 1 from public.working_drawing_attachments w where w.storage_path = storage.objects.name and w.is_deleted = true)
  )
);
