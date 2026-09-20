-- v2_86 -- task documents: CSV / TXT, and an idempotent staff_record_attachment. Applied to the live project.
--
-- ROOT CAUSE of "PUT /storage/v1/object/upload/sign/... 400" for .dwg:
--   HTTP 400 { "statusCode": "415", "error": "invalid_mime_type", "message": "mime type application/octet-stream is not supported" }
--   For a File/Blob the Supabase SDK sends file.type as the multipart Content-Type and IGNORES the contentType option. Browsers report
--   .dwg / .dxf as "" (=> application/octet-stream). The bucket (correctly) does not allow octet-stream, and the client only fixed the
--   MIME it told the Edge Function / RPC, not the one on the actual PUT. Fixed in the client (File re-typed to the canonical MIME) and
--   in staff-file-url (returns the canonical content_type for the approved extension). No arbitrary octet-stream is allowed.

update storage.buckets
   set allowed_mime_types = (select array_agg(distinct x) from unnest(allowed_mime_types || array['text/csv', 'text/plain']) x)
 where id = 'staff-attachments';

-- staff_record_attachment(): word += text/plain, excel += text/csv; a retry that records the same object again returns the
-- existing attachment row instead of creating a second one. (Full definition is live; only those two changes vs v2_83.)
--   word  : application/msword, ...wordprocessingml.document, text/plain
--   excel : application/vnd.ms-excel, ...spreadsheetml.sheet, text/csv
--   select id into v_attachment_id from public.staff_attachments
--    where storage_path = p_storage_path and entity_id = p_entity_id and is_active;  if found -> return it
