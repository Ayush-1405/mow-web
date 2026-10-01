-- Latest handwritten-spec redesign, section 2: the "Material to be Ordered" page must show Material / Requesting
-- Department / Order-PO / Party Name / Person Name / Priority as six distinct feature buttons, EACH with its own
-- mandatory photo proof -- not one combined form with a single photo box at the bottom (what
-- mvp_pilot_factory_divisions_material_v2_82b.sql built). This is purely additive: the existing combined-form
-- create flow, factory_create_material_request, factory_update_material_request_status and the single overall
-- ProofPhotoUpload all keep working unchanged for any already-open request; this just adds the two missing real
-- columns, a field-level photo entity_type (mirrors 'factory_job_card_field' from v2_84 exactly), and a patch RPC
-- so each of the six sections can be edited and photographed on its own.

-- 1. party_name / person_name -- the two fields the handwritten note lists that factory_material_requests never
--    had a column for (it already has material/requesting_department_id/order_po_reference/priority).
alter table public.factory_material_requests add column if not exists party_name text;
alter table public.factory_material_requests add column if not exists person_name text;

-- 2. 'factory_material_request_field' -- field-level photo proof on a Material to Order request, same generic
--    section_key tagging staff_set_attachment_section already provides.
alter table public.staff_attachments drop constraint if exists staff_attachments_entity_type_check;
alter table public.staff_attachments add constraint staff_attachments_entity_type_check
  check (entity_type in ('task', 'bridge', 'retail_packing', 'retail_godown_handover', 'retail_dispatch', 'retail_delivery',
                          'retail_installation', 'retail_order_item', 'retail_product', 'retail_inventory_item', 'retail_quotation',
                          'retail_delivery_challan', 'factory_material_request', 'factory_job_card_stage', 'factory_job_card_field',
                          'factory_material_request_field'));

-- staff_record_attachment gains the 'factory_material_request_field' branch -- identical visibility rule to the
-- existing 'factory_material_request' branch (same parent table, same entity_id), just a second entity_type that
-- maps to it so field-level photos are distinguishable from the request's own general attachments.
CREATE OR REPLACE FUNCTION public.staff_record_attachment(p_entity_type text, p_entity_id uuid, p_file_type text, p_storage_path text, p_original_filename text, p_mime_type text, p_file_size bigint, p_duration_seconds integer DEFAULT NULL::integer, p_purpose text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_task public.staff_tasks%rowtype;
  v_bridge public.bridges%rowtype;
  v_has_access boolean := false;
  v_exists boolean := false;
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
  if v_storage_obj.metadata ? 'mimetype' then
    v_obj_mime := lower(btrim(split_part(v_storage_obj.metadata->>'mimetype', ';', 1)));
    if v_obj_mime <> v_base_mime then
      raise exception 'Declared mime_type does not match the uploaded object';
    end if;
  end if;
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

  elsif p_entity_type = 'retail_packing' then
    select exists(select 1 from public.retail_packing_records where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent packing record does not exist'; end if;
    select exists(
      select 1 from public.retail_packing_records p join public.retail_orders o on o.id = p.order_id where p.id = p_entity_id and (
        p.created_by = auth.uid() or o.created_by = auth.uid() or public.retail_can_write_customer(o.customer_id)
        or public.staff_is_godown_staff() or public.staff_has_global_oversight()
        or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(p.department_id) or public.staff_dept_in_hod_scope(public.retail_godown_dept_id())))
      )) into v_has_access;

  elsif p_entity_type = 'retail_godown_handover' then
    select exists(select 1 from public.retail_godown_handovers where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent godown handover does not exist'; end if;
    select exists(
      select 1 from public.retail_godown_handovers h join public.retail_orders o on o.id = h.order_id where h.id = p_entity_id and (
        h.created_by = auth.uid() or h.responsible_user_id = auth.uid() or o.created_by = auth.uid() or public.retail_can_access_customer(o.customer_id)
        or public.staff_is_godown_staff() or public.staff_has_global_oversight()
        or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(h.department_id) or public.staff_dept_in_hod_scope(h.origin_department_id)))
      )) into v_has_access;

  elsif p_entity_type = 'retail_dispatch' then
    select exists(select 1 from public.retail_dispatch_records where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent dispatch record does not exist'; end if;
    select exists(
      select 1 from public.retail_dispatch_records dr join public.retail_orders o on o.id = dr.order_id where dr.id = p_entity_id and (
        dr.created_by = auth.uid() or o.created_by = auth.uid() or public.retail_can_access_customer(o.customer_id)
        or public.staff_is_dispatch_staff() or public.staff_is_godown_staff() or public.staff_has_global_oversight()
        or (public.staff_is_dept_head() and staff_dept_in_hod_scope(dr.department_id))
      )) into v_has_access;

  elsif p_entity_type = 'retail_delivery' then
    select exists(select 1 from public.retail_deliveries where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent delivery record does not exist'; end if;
    select exists(
      select 1 from public.retail_deliveries dl join public.retail_orders o on o.id = dl.order_id where dl.id = p_entity_id and (
        dl.created_by = auth.uid() or o.created_by = auth.uid() or public.retail_can_access_customer(o.customer_id)
        or public.staff_is_dispatch_staff() or public.staff_is_godown_staff() or public.staff_has_global_oversight()
        or (public.staff_is_dept_head() and staff_dept_in_hod_scope(dl.department_id))
      )) into v_has_access;

  elsif p_entity_type = 'retail_installation' then
    select exists(select 1 from public.retail_installations where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent installation record does not exist'; end if;
    select exists(
      select 1 from public.retail_installations ins join public.retail_orders o on o.id = ins.order_id where ins.id = p_entity_id and (
        ins.created_by = auth.uid() or o.created_by = auth.uid() or public.retail_can_access_customer(o.customer_id)
        or public.staff_has_global_oversight() or (public.staff_is_dept_head() and staff_dept_in_hod_scope(o.department_id))
      )) into v_has_access;

  elsif p_entity_type = 'retail_order_item' then
    select exists(select 1 from public.retail_order_items where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent order item does not exist'; end if;
    select exists(
      select 1 from public.retail_order_items oi join public.retail_orders o on o.id = oi.order_id where oi.id = p_entity_id and (
        o.created_by = auth.uid() or public.retail_can_write_customer(o.customer_id)
        or public.staff_has_global_oversight() or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(o.department_id))
      )) into v_has_access;

  elsif p_entity_type = 'retail_product' then
    select exists(select 1 from public.retail_products where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent product does not exist'; end if;
    select exists(
      select 1 from public.retail_products p where p.id = p_entity_id and (
        p.created_by = auth.uid() or public.staff_is_godown_staff() or public.staff_has_global_oversight()
        or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(public.retail_godown_dept_id()))
      )) into v_has_access;

  elsif p_entity_type = 'retail_inventory_item' then
    select exists(select 1 from public.retail_inventory_items where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent inventory item does not exist'; end if;
    select exists(
      select 1 from public.retail_inventory_items ii where ii.id = p_entity_id and (
        ii.created_by = auth.uid() or public.staff_is_godown_staff() or public.staff_has_global_oversight()
        or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(public.retail_godown_dept_id()) or public.staff_dept_in_hod_scope(public.retail_dept_id())))
        or exists (select 1 from public.retail_orders o where o.id in (ii.reserved_order_id, ii.sold_order_id) and (
              o.created_by = auth.uid() or public.retail_can_write_customer(o.customer_id)))
      )) into v_has_access;

  elsif p_entity_type = 'retail_quotation' then
    select exists(select 1 from public.retail_quotations where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent quotation does not exist'; end if;
    select exists(
      select 1 from public.retail_quotations q where q.id = p_entity_id and (
        q.created_by = auth.uid() or public.retail_can_write_customer(q.customer_id)
        or public.staff_has_global_oversight() or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(q.department_id))
      )) into v_has_access;

  elsif p_entity_type = 'retail_delivery_challan' then
    select exists(select 1 from public.retail_delivery_challans where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent Delivery Challan does not exist'; end if;
    select exists(
      select 1 from public.retail_delivery_challans dc join public.retail_orders o on o.id = dc.order_id where dc.id = p_entity_id and (
        dc.created_by = auth.uid() or o.created_by = auth.uid() or public.retail_can_write_customer(o.customer_id)
        or public.staff_is_godown_staff() or public.staff_has_global_oversight()
        or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(o.department_id) or public.staff_dept_in_hod_scope(public.retail_godown_dept_id())))
      )) into v_has_access;

  elsif p_entity_type in ('factory_material_request', 'factory_material_request_field') then
    select exists(
      select 1 from public.factory_material_requests mr where mr.id = p_entity_id and (
        mr.created_by = auth.uid() or mr.requested_by = auth.uid()
        or public.staff_is_factory_staff() or public.staff_current_department_id() = public.factory_procurement_dept_id()
        or public.staff_has_global_oversight() or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(mr.requesting_department_id))
      )) into v_has_access;
    if not v_has_access then
      select exists(select 1 from public.factory_material_requests where id = p_entity_id) into v_exists;
      if not v_exists then raise exception 'Parent material request does not exist'; end if;
    end if;

  elsif p_entity_type = 'factory_job_card_stage' then
    select exists(
      select 1 from public.job_card_stage_updates su join public.inhouse_production_requests r on r.id = su.job_id
      where su.id = p_entity_id and (
        public.staff_is_factory_staff() or public.staff_has_global_oversight()
        or (public.factory_my_profile_id() is not null and public.factory_my_profile_id() in (r.assigned_factory_coordinator, r.second_assignee_coordinator, r.current_responsible_person))
        or r.requested_by = auth.uid() or (r.source_department_id is not null and r.source_department_id = public.staff_current_department_id())
      )) into v_has_access;
    if not v_has_access then
      select exists(select 1 from public.job_card_stage_updates where id = p_entity_id) into v_exists;
      if not v_exists then raise exception 'Parent production stage does not exist'; end if;
    end if;

  elsif p_entity_type = 'factory_job_card_field' then
    select exists(
      select 1 from public.inhouse_production_requests r where r.id = p_entity_id and (
        public.staff_is_factory_staff() or public.staff_has_global_oversight()
        or (public.factory_my_profile_id() is not null and public.factory_my_profile_id() in (r.assigned_factory_coordinator, r.second_assignee_coordinator, r.current_responsible_person))
        or r.requested_by = auth.uid() or (r.source_department_id is not null and r.source_department_id = public.staff_current_department_id())
      )) into v_has_access;
    if not v_has_access then
      select exists(select 1 from public.inhouse_production_requests where id = p_entity_id) into v_exists;
      if not v_exists then raise exception 'Parent Job Card does not exist'; end if;
    end if;

  else
    raise exception 'Invalid entity_type';
  end if;

  if not v_has_access then
    raise exception 'You do not have access to attach files to this %', p_entity_type;
  end if;
  if coalesce(v_confidential, false) and not public.staff_has_capability('can_view_restricted_finance') then
    raise exception 'Attachments on a confidential-domain task are restricted';
  end if;
  if p_purpose = 'instruction' and not (
       v_task.assigned_by = auth.uid()
       or public.staff_has_global_oversight()
       or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_task.to_department_id))) then
    raise exception 'Only the person who assigned this task (or a manager) can add its voice instruction';
  end if;

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
$function$;

-- 3. factory_update_material_request_fields -- the per-field patch RPC the six new sections save through.
--    Allowed keys: material, requesting_department_id, order_po_reference, party_name, person_name, priority.
--    Same authorization as factory_update_material_request_status (creator/requester/Factory staff/Procurement/
--    oversight/scoped dept head) so no new access rule is introduced.
create or replace function public.factory_update_material_request_fields(p_id uuid, p_patch jsonb)
returns public.factory_material_requests
language plpgsql security definer set search_path to 'public' as $function$
declare v_row public.factory_material_requests; v_allowed boolean;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.factory_material_requests where id = p_id for update;
  if v_row.id is null then raise exception 'Material request not found'; end if;

  v_allowed := (coalesce(public.staff_is_factory_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or public.staff_current_department_id() = public.factory_procurement_dept_id()
    or v_row.created_by = auth.uid() or v_row.requested_by = auth.uid());
  if not v_allowed then raise exception 'Not authorized to update this material request'; end if;

  if p_patch ? 'priority' and (p_patch ->> 'priority') not in ('Normal', 'High', 'Urgent', 'Emergency') then raise exception 'Invalid priority'; end if;
  if p_patch ? 'material' and coalesce(btrim(p_patch ->> 'material'), '') = '' then raise exception 'Material is required'; end if;

  update public.factory_material_requests set
    material = case when p_patch ? 'material' then btrim(p_patch ->> 'material') else material end,
    requesting_department_id = case when p_patch ? 'requesting_department_id' then (p_patch ->> 'requesting_department_id')::uuid else requesting_department_id end,
    order_po_reference = case when p_patch ? 'order_po_reference' then nullif(btrim(p_patch ->> 'order_po_reference'), '') else order_po_reference end,
    party_name = case when p_patch ? 'party_name' then nullif(btrim(p_patch ->> 'party_name'), '') else party_name end,
    person_name = case when p_patch ? 'person_name' then nullif(btrim(p_patch ->> 'person_name'), '') else person_name end,
    priority = case when p_patch ? 'priority' then p_patch ->> 'priority' else priority end,
    updated_at = now()
  where id = p_id returning * into v_row;

  perform public.staff_write_audit('factory_material_request', p_id, 'FIELDS_UPDATE', null, p_patch, null);

  return v_row;
end $function$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'factory_update_material_request_fields(uuid, jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
