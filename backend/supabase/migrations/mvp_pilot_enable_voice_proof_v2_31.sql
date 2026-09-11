-- Voice proof is now fully supported — the recording infrastructure
-- (VoiceRecorder.jsx, uploadTaskProof's "voice" fileType, staff-file-url's
-- MIME_WHITELIST.voice, staff_record_attachment) already existed and
-- already worked for the "attach a voice note anytime" flow in
-- TaskDetail.jsx's AttachmentsList — the ONLY thing actually missing was
-- this trigger unconditionally rejecting COMPLETED for proof_code='voice'
-- instead of checking for a voice attachment, same as every other proof
-- type here. Re-activating proof_types.voice makes it selectable again
-- when creating a task.
UPDATE public.proof_types SET is_active = true WHERE code = 'voice';

CREATE OR REPLACE FUNCTION public.staff_validate_task_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_old_code text; v_new_code text; v_proof_code text; v_sender uuid;
BEGIN
  IF NEW.status_id = OLD.status_id THEN RETURN NEW; END IF;

  SELECT code INTO v_old_code FROM public.status_master WHERE id = OLD.status_id;
  SELECT code INTO v_new_code FROM public.status_master WHERE id = NEW.status_id;

  IF NOT (
    (v_old_code = 'ASSIGNED'    AND v_new_code IN ('ACCEPTED','RETURNED'))     OR
    (v_old_code = 'ACCEPTED'    AND v_new_code IN ('IN_PROGRESS','RETURNED')) OR
    (v_old_code = 'IN_PROGRESS' AND v_new_code IN ('COMPLETED','RETURNED'))   OR
    (v_old_code = 'COMPLETED'   AND v_new_code IN ('VERIFIED','RETURNED'))    OR
    (v_old_code = 'VERIFIED'    AND v_new_code = 'CLOSED')                    OR
    (v_old_code = 'RETURNED'    AND v_new_code IN ('ASSIGNED','ACCEPTED'))
  ) THEN
    RAISE EXCEPTION 'Invalid task status transition: % -> %', v_old_code, v_new_code;
  END IF;

  IF v_new_code = 'RETURNED' AND (NEW.return_reason IS NULL OR btrim(NEW.return_reason) = '') THEN
    RAISE EXCEPTION 'return_reason is required when returning a task';
  END IF;

  IF v_new_code = 'COMPLETED' THEN
    SELECT code INTO v_proof_code FROM public.proof_types WHERE id = NEW.proof_type_id;
    IF v_proof_code = 'photo' THEN
      IF NOT EXISTS (SELECT 1 FROM public.staff_attachments WHERE entity_type='task' AND entity_id=NEW.id AND is_active=true AND file_type='image') THEN
        RAISE EXCEPTION 'A photo attachment is required to complete this task';
      END IF;
    ELSIF v_proof_code = 'document' THEN
      IF NOT EXISTS (SELECT 1 FROM public.staff_attachments WHERE entity_type='task' AND entity_id=NEW.id AND is_active=true AND file_type IN ('pdf','word','excel','drawing')) THEN
        RAISE EXCEPTION 'A document attachment (PDF/Word/Excel/drawing) is required to complete this task';
      END IF;
    ELSIF v_proof_code = 'barcode' THEN
      IF NOT EXISTS (SELECT 1 FROM public.staff_attachments WHERE entity_type='task' AND entity_id=NEW.id AND is_active=true AND file_type='image') THEN
        RAISE EXCEPTION 'A barcode evidence image is required to complete this task';
      END IF;
    ELSIF v_proof_code = 'customer_confirmation' THEN
      IF NEW.customer_confirmation_text IS NULL AND NOT EXISTS (SELECT 1 FROM public.staff_attachments WHERE entity_type='task' AND entity_id=NEW.id AND is_active=true) THEN
        RAISE EXCEPTION 'Customer confirmation text or an attachment is required to complete this task';
      END IF;
    ELSIF v_proof_code = 'voice' THEN
      IF NOT EXISTS (SELECT 1 FROM public.staff_attachments WHERE entity_type='task' AND entity_id=NEW.id AND is_active=true AND file_type='voice') THEN
        RAISE EXCEPTION 'A voice note is required to complete this task';
      END IF;
    END IF;
  END IF;

  IF v_new_code = 'CLOSED' AND NEW.closed_by IS NULL AND OLD.closed_by IS NULL THEN
    RAISE EXCEPTION 'closed_by is required when closing a task';
  END IF;

  CASE v_new_code
    WHEN 'ACCEPTED' THEN
      NEW.previous_owner_id := OLD.current_owner_id;
      NEW.current_owner_id  := NEW.assigned_to;
      NEW.accepted_at := now();
    WHEN 'IN_PROGRESS' THEN
      NEW.started_at := now();
    WHEN 'COMPLETED' THEN
      NEW.previous_owner_id := OLD.current_owner_id;
      NEW.current_owner_id  := NEW.verifier_id;
      NEW.completed_at := now();
    WHEN 'RETURNED' THEN
      NEW.previous_owner_id := OLD.current_owner_id;
      IF NEW.is_bridge THEN
        SELECT from_person_id INTO v_sender FROM public.bridges WHERE task_id = NEW.id;
        IF v_sender IS NULL THEN RAISE EXCEPTION 'Bridge sender could not be resolved for task %', NEW.id; END IF;
        NEW.current_owner_id := v_sender;
      ELSE
        NEW.current_owner_id := NEW.assigned_by;
      END IF;
    WHEN 'VERIFIED' THEN
      IF NEW.verified_by IS NULL THEN NEW.verified_by := auth.uid(); END IF;
      NEW.verified_at := now();
    WHEN 'CLOSED' THEN
      IF NEW.closed_by IS NULL THEN NEW.closed_by := auth.uid(); END IF;
      NEW.closed_at := now();
    ELSE NULL;
  END CASE;

  RETURN NEW;
END;
$function$;
