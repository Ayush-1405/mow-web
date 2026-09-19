-- mvp_pilot_factory_storage_access_v2_70
--
-- Real, pre-existing gap found while wiring drawing preview/download into
-- the Factory Job Card: the `interior-attachments` Storage bucket's INSERT
-- and SELECT policies are gated ONLY by
-- interior_is_org_wide() OR interior_is_project_member(...) -- there has
-- never been a Factory-staff branch. Every factory upload/read this whole
-- session (uploadFactoryAttachment: QC photos, rework/rejection photos,
-- machine breakdown photos, clarification proofs, and now drawings) has
-- only ever worked for a caller who ALSO happens to be an Interior project
-- member or org-wide viewer -- a Factory Coordinator/QC/Worker who is
-- purely Factory staff could never actually open or upload these files,
-- even though the corresponding DB rows (factory_drawings,
-- factory_quality_checks, etc.) were correctly visible to them.
--
-- Fixed at the storage-policy level (not per-screen), using the exact same
-- staff_factory_record_authorized() function factory_upload_drawing and
-- every other factory_* write RPC already uses -- same trust model,
-- applied consistently to file access, not a new/looser standard.

create or replace function public.interior_storage_factory_authorized(path text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  parts text[];
  v_project_id uuid;
begin
  parts := storage.foldername(path);
  if parts is null or array_length(parts, 1) < 3 or parts[3] <> 'factory' then
    return false;
  end if;
  v_project_id := public.interior_storage_project_id(path);
  if v_project_id is null then return false; end if;
  return public.staff_factory_record_authorized(v_project_id);
end;
$function$;

drop policy if exists interior_attachments_storage_select_scoped on storage.objects;
create policy interior_attachments_storage_select_scoped on storage.objects for select
  using (bucket_id = 'interior-attachments' and (
    interior_is_org_wide() or interior_is_project_member(interior_storage_project_id(name))
    or interior_storage_factory_authorized(name)
  ));

drop policy if exists interior_attachments_storage_insert_scoped on storage.objects;
create policy interior_attachments_storage_insert_scoped on storage.objects for insert
  with check (bucket_id = 'interior-attachments' and (
    interior_is_org_wide() or interior_is_project_member(interior_storage_project_id(name))
    or interior_storage_factory_authorized(name)
  ));
