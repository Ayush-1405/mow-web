-- mvp_pilot_fix_voice_mime_match_v2_1s
--
-- Fixes every voice-note recording failing with "Declared mime_type does
-- not match the uploaded object" (staff_record_attachment).
--
-- Root cause, confirmed live via postgres_logs and storage.objects:
-- MediaRecorder in Chrome/Android produces mime type
-- "audio/webm;codecs=opus". The frontend passes that full string as
-- p_mime_type to both the upload PUT and this RPC. Supabase Storage
-- strips the ";codecs=opus" parameter before persisting
-- storage.objects.metadata->>'mimetype' (confirmed: two real uploads
-- both landed as bare "audio/webm"). This function's whitelist check
-- already accounts for that (v_base_mime, stripped via split_part before
-- the MIME_WHITELIST-equivalent comparison), but the later
-- storage-metadata-matches-declaration check compared the stored
-- (stripped) value against the RAW p_mime_type (with the codec
-- parameter still attached) instead of against v_base_mime — an
-- asymmetric comparison that can never succeed for any mime type that
-- carries a codec/charset parameter. image/pdf/word/excel/drawing never
-- hit this because none of those mime types ever carry one; voice always
-- did. The only change below is comparing against v_base_mime instead of
-- p_mime_type on that one line — every other line is byte-identical to
-- the currently deployed function.
CREATE OR REPLACE FUNCTION public.staff_record_attachment(p_entity_type text, p_entity_id uuid, p_file_type text, p_storage_path text, p_original_filename text, p_mime_type text, p_file_size bigint, p_duration_seconds integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_task public.staff_tasks%ROWTYPE;
  v_bridge public.bridges%ROWTYPE;
  v_has_access boolean := false;
  v_confidential boolean := false;
  v_attachment_id uuid;
  v_max_bytes bigint := 20 * 1024 * 1024;
  v_storage_obj record;
  v_base_mime text := split_part(p_mime_type, ';', 1);
BEGIN
  PERFORM public.staff_assert_operational();

  IF p_file_type NOT IN ('image','pdf','word','excel','drawing','voice') THEN
    RAISE EXCEPTION 'Unsupported file_type';
  END IF;
  IF p_file_size IS NULL OR p_file_size <= 0 OR p_file_size > v_max_bytes THEN
    RAISE EXCEPTION 'File size invalid or exceeds the pilot limit';
  END IF;
  IF (p_file_type = 'image' AND p_mime_type NOT IN ('image/jpeg','image/png','image/webp','image/heic','image/heif'))
     OR (p_file_type = 'pdf' AND p_mime_type <> 'application/pdf')
     OR (p_file_type = 'word' AND p_mime_type NOT IN ('application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
     OR (p_file_type = 'excel' AND p_mime_type NOT IN ('application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
     OR (p_file_type = 'drawing' AND p_mime_type NOT IN ('application/dxf','application/dwg','image/vnd.dwg','image/vnd.dxf','application/x-dwg','application/x-dxf','application/acad'))
     OR (p_file_type = 'voice' AND v_base_mime NOT IN ('audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav','audio/x-m4a','audio/aac'))
  THEN
    RAISE EXCEPTION 'mime_type does not match file_type';
  END IF;
  IF p_file_type = 'voice' AND (p_duration_seconds IS NULL OR p_duration_seconds <= 0 OR p_duration_seconds > 60) THEN
    RAISE EXCEPTION 'Voice messages must be between 1 and 60 seconds';
  END IF;

  IF p_storage_path NOT LIKE (auth.uid()::text || '/%') THEN
    RAISE EXCEPTION 'storage_path must be under your own upload prefix';
  END IF;

  SELECT * INTO v_storage_obj FROM storage.objects WHERE bucket_id = 'staff-attachments' AND name = p_storage_path;
  IF v_storage_obj.id IS NULL THEN
    RAISE EXCEPTION 'No uploaded object found at storage_path — refusing to record unverified attachment metadata';
  END IF;
  IF v_storage_obj.metadata ? 'size' AND (v_storage_obj.metadata->>'size')::bigint <> p_file_size THEN
    RAISE EXCEPTION 'Declared file_size does not match the uploaded object';
  END IF;
  -- Fixed: compare against v_base_mime (stripped of any ;codecs=/;charset=
  -- parameter), matching what Storage actually persists, instead of the
  -- raw p_mime_type which still carries that parameter for MediaRecorder
  -- output. This was the sole cause of every voice upload failing here.
  IF v_storage_obj.metadata ? 'mimetype' AND v_storage_obj.metadata->>'mimetype' <> v_base_mime THEN
    RAISE EXCEPTION 'Declared mime_type does not match the uploaded object';
  END IF;

  IF p_entity_type = 'task' THEN
    SELECT * INTO v_task FROM public.staff_tasks WHERE id = p_entity_id;
    IF v_task.id IS NULL THEN RAISE EXCEPTION 'Parent task does not exist'; END IF;
    v_has_access := (
      v_task.assigned_by = auth.uid() OR v_task.assigned_to = auth.uid() OR v_task.current_owner_id = auth.uid() OR v_task.verifier_id = auth.uid()
      OR public.staff_is_management()
      OR (public.staff_is_dept_head() AND (public.staff_dept_in_hod_scope(v_task.from_department_id) OR public.staff_dept_in_hod_scope(v_task.to_department_id)))
      OR (public.staff_is_accounts_head() AND (v_task.from_department_id = public.staff_current_department_id() OR v_task.to_department_id = public.staff_current_department_id()))
    );
    SELECT true INTO v_confidential FROM public.departments d WHERE d.id IN (v_task.from_department_id, v_task.to_department_id) AND d.is_confidential_domain = true LIMIT 1;
  ELSIF p_entity_type = 'bridge' THEN
    SELECT * INTO v_bridge FROM public.bridges WHERE id = p_entity_id;
    IF v_bridge.id IS NULL THEN RAISE EXCEPTION 'Parent bridge does not exist'; END IF;
    v_has_access := (
      v_bridge.from_person_id = auth.uid() OR v_bridge.to_person_id = auth.uid()
      OR public.staff_is_management()
      OR (public.staff_is_dept_head() AND (public.staff_dept_in_hod_scope(v_bridge.from_department_id) OR public.staff_dept_in_hod_scope(v_bridge.to_department_id)))
    );
  ELSE
    RAISE EXCEPTION 'Invalid entity_type';
  END IF;

  IF NOT v_has_access THEN
    RAISE EXCEPTION 'You do not have access to attach files to this %', p_entity_type;
  END IF;
  IF COALESCE(v_confidential, false) AND NOT (public.staff_is_management() OR public.staff_is_accounts_head() OR public.staff_current_role_code() IN ('accounts_employee','cfo')) THEN
    RAISE EXCEPTION 'Attachments on a confidential-domain task are restricted';
  END IF;

  INSERT INTO public.staff_attachments (entity_type, entity_id, file_type, storage_path, original_filename, mime_type, file_size, duration_seconds, uploaded_by, is_confidential)
  VALUES (p_entity_type, p_entity_id, p_file_type, p_storage_path, p_original_filename, p_mime_type, p_file_size, p_duration_seconds, auth.uid(), COALESCE(v_confidential, false))
  RETURNING id INTO v_attachment_id;

  PERFORM public.staff_write_audit(p_entity_type, p_entity_id, 'ATTACH', NULL, jsonb_build_object('attachment_id', v_attachment_id, 'file_type', p_file_type), NULL);

  RETURN v_attachment_id;
END;
$function$;
