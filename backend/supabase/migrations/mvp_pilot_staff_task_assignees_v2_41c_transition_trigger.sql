-- staff_validate_task_transition() enforces a strict allow-list of
-- staff_tasks.status_id transitions -- discovered live when the new
-- multi-assignee branches tried to set PARTIALLY_ACCEPTED/PARTIALLY_COMPLETED,
-- which the original list has no entry for at all (it predates this
-- feature). Extends the whitelist with exactly the 5 new pairs the
-- multi-assignee accept/start/complete branches need; every existing pair,
-- the proof-attachment checks, and the CASE block that stamps
-- accepted_at/started_at/completed_at/etc. are untouched -- those already
-- fall through to "no side effect" for the two new codes (ELSE NULL).
create or replace function public.staff_validate_task_transition()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public' as $function$
declare v_old_code text; v_new_code text; v_proof_code text; v_sender uuid;
begin
  if new.status_id = old.status_id then return new; end if;

  select code into v_old_code from public.status_master where id = old.status_id;
  select code into v_new_code from public.status_master where id = new.status_id;

  if not (
    (v_old_code = 'ASSIGNED'    and v_new_code in ('ACCEPTED','RETURNED','PARTIALLY_ACCEPTED')) or
    (v_old_code = 'PARTIALLY_ACCEPTED' and v_new_code in ('ACCEPTED','IN_PROGRESS')) or
    (v_old_code = 'ACCEPTED'    and v_new_code in ('IN_PROGRESS','RETURNED')) or
    (v_old_code = 'IN_PROGRESS' and v_new_code in ('COMPLETED','RETURNED','PARTIALLY_COMPLETED')) or
    (v_old_code = 'PARTIALLY_COMPLETED' and v_new_code = 'COMPLETED') or
    (v_old_code = 'COMPLETED'   and v_new_code in ('VERIFIED','RETURNED')) or
    (v_old_code = 'VERIFIED'    and v_new_code = 'CLOSED') or
    (v_old_code = 'RETURNED'    and v_new_code in ('ASSIGNED','ACCEPTED'))
  ) then
    raise exception 'Invalid task status transition: % -> %', v_old_code, v_new_code;
  end if;

  if v_new_code = 'RETURNED' and (new.return_reason is null or btrim(new.return_reason) = '') then
    raise exception 'return_reason is required when returning a task';
  end if;

  if v_new_code = 'COMPLETED' then
    select code into v_proof_code from public.proof_types where id = new.proof_type_id;
    if v_proof_code = 'photo' then
      if not exists (select 1 from public.staff_attachments where entity_type='task' and entity_id=new.id and is_active=true and file_type='image') then
        raise exception 'A photo attachment is required to complete this task';
      end if;
    elsif v_proof_code = 'document' then
      if not exists (select 1 from public.staff_attachments where entity_type='task' and entity_id=new.id and is_active=true and file_type in ('pdf','word','excel','drawing')) then
        raise exception 'A document attachment (PDF/Word/Excel/drawing) is required to complete this task';
      end if;
    elsif v_proof_code = 'barcode' then
      if not exists (select 1 from public.staff_attachments where entity_type='task' and entity_id=new.id and is_active=true and file_type='image') then
        raise exception 'A barcode evidence image is required to complete this task';
      end if;
    elsif v_proof_code = 'customer_confirmation' then
      if new.customer_confirmation_text is null and not exists (select 1 from public.staff_attachments where entity_type='task' and entity_id=new.id and is_active=true) then
        raise exception 'Customer confirmation text or an attachment is required to complete this task';
      end if;
    elsif v_proof_code = 'voice' then
      if not exists (select 1 from public.staff_attachments where entity_type='task' and entity_id=new.id and is_active=true and file_type='voice') then
        raise exception 'A voice note is required to complete this task';
      end if;
    end if;
  end if;

  if v_new_code = 'CLOSED' and new.closed_by is null and old.closed_by is null then
    raise exception 'closed_by is required when closing a task';
  end if;

  case v_new_code
    when 'ACCEPTED' then
      new.previous_owner_id := old.current_owner_id;
      new.current_owner_id  := new.assigned_to;
      new.accepted_at := now();
    when 'IN_PROGRESS' then
      new.started_at := now();
    when 'COMPLETED' then
      new.previous_owner_id := old.current_owner_id;
      new.current_owner_id  := new.verifier_id;
      new.completed_at := now();
    when 'RETURNED' then
      new.previous_owner_id := old.current_owner_id;
      if new.is_bridge then
        select from_person_id into v_sender from public.bridges where task_id = new.id;
        if v_sender is null then raise exception 'Bridge sender could not be resolved for task %', new.id; end if;
        new.current_owner_id := v_sender;
      else
        new.current_owner_id := new.assigned_by;
      end if;
    when 'VERIFIED' then
      if new.verified_by is null then new.verified_by := auth.uid(); end if;
      new.verified_at := now();
    when 'CLOSED' then
      if new.closed_by is null then new.closed_by := auth.uid(); end if;
      new.closed_at := now();
    else null;
  end case;

  return new;
end;
$function$;
