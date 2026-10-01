-- Real, separate per-segment creation + field-level photo proof (handwritten spec: dedicated Sofa/Modular/Metal
-- Fabrication/Material-to-Order pages, each with its own "New Job" form and photos tied to specific field
-- sections, not one generic upload box at the bottom).
--
-- Design choice, disclosed: the three production segments' extended spec fields (sofa type/foam density/fabric
-- code, board type/laminate/edge band, metal grade/weld type/paint code, ...) do not share a column shape and
-- most are optional/segment-specific -- adding 80+ narrow typed columns across inhouse_production_requests for
-- fields most rows will never use is bad schema design. A single additive `segment_specs jsonb` column holds
-- them instead; `po_received/po_number/po_date` stay real typed columns because they're common to all three
-- segments, genuinely filtered/reported on, and map to the handwritten note's own "PO Received" field.
alter table public.inhouse_production_requests add column if not exists po_received boolean;
alter table public.inhouse_production_requests add column if not exists po_number text;
alter table public.inhouse_production_requests add column if not exists po_date date;
alter table public.inhouse_production_requests add column if not exists segment_specs jsonb not null default '{}'::jsonb;

-- Field-level photo proof needs a photo tied to a specific form SECTION (PO photo vs Product photo vs Drawing
-- photo) on the SAME parent record -- a generic column, usable by any entity_type later, not Factory-only.
alter table public.staff_attachments add column if not exists section_key text;

alter table public.staff_attachments drop constraint if exists staff_attachments_entity_type_check;
alter table public.staff_attachments add constraint staff_attachments_entity_type_check
  check (entity_type in ('task', 'bridge', 'retail_packing', 'retail_godown_handover', 'retail_dispatch', 'retail_delivery',
                          'retail_installation', 'retail_order_item', 'retail_product', 'retail_inventory_item', 'retail_quotation',
                          'retail_delivery_challan', 'factory_material_request', 'factory_job_card_stage', 'factory_job_card_field'));

-- staff_record_attachment gains the 'factory_job_card_field' branch (parent = inhouse_production_requests,
-- mirrors the same job-visibility rule already used for 'factory_job_card_stage').
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

  elsif p_entity_type = 'factory_material_request' then
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

-- staff_set_attachment_section -- tags an already-recorded attachment with which form section it proves (the
-- client calls this right after uploadTaskProof() succeeds). Restricted to the uploader (or oversight) so it
-- can never be used to re-tag someone else's photo.
create or replace function public.staff_set_attachment_section(p_attachment_id uuid, p_section_key text)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_row public.staff_attachments%rowtype;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.staff_attachments where id = p_attachment_id and is_active;
  if v_row.id is null then raise exception 'Attachment not found'; end if;
  if v_row.uploaded_by <> auth.uid() and not public.staff_has_global_oversight() then
    raise exception 'Only the uploader may tag this attachment''s section';
  end if;
  if p_section_key is not null and length(p_section_key) > 60 then raise exception 'section_key too long'; end if;
  update public.staff_attachments set section_key = nullif(btrim(coalesce(p_section_key, '')), '') where id = p_attachment_id;
end $function$;

-- factory_job_cards_v -- append po_received/po_number/po_date/segment_specs (safe trailing-column addition).
create or replace view public.factory_job_cards_v with (security_invoker = true) as
select
  r.id, r.job_order_number, r.factory_status, r.status as legacy_status,
  r.source_department_id, d.name_en as source_department_name, d.name_gu as source_department_name_gu,
  r.source_module, r.source_reference,
  r.project_id, coalesce(r.project_code, pr.project_code) as project_code,
  coalesce(r.customer_name, pr.customer) as customer_name, coalesce(r.site_location, pr.location) as site_location,
  r.product_item,
  coalesce(ic.item_count, case when r.product_item is not null then 1 else 0 end) as item_count,
  ic.total_qty, ic.qty_summary,
  r.required_completion_date as required_date, r.priority, r.current_stage, r.completion_percentage,
  r.assigned_factory_coordinator, public.factory_person_name(r.assigned_factory_coordinator) as assigned_name,
  r.second_assignee_coordinator, public.factory_person_name(r.second_assignee_coordinator) as second_name,
  coalesce(fc.file_count, 0) as file_count, coalesce(fc.drawing_count, 0) as drawing_count,
  ( (case when r.required_completion_date is null then 1 else 0 end)
  + (case when coalesce(ic.item_count, 0) = 0 then 1 else 0 end)
  + (case when coalesce(fc.drawing_count, 0) = 0 then 1 else 0 end)
  + (case when coalesce(ic.missing_qty, 0) > 0 then 1 else 0 end)
  + (case when coalesce(ic.missing_spec, 0) > 0 then 1 else 0 end) ) as missing_count,
  (r.factory_status not in ('completed', 'cancelled')
    and (r.factory_status = 'blocked'
         or (r.required_completion_date is not null and r.required_completion_date < (now() at time zone 'Asia/Kolkata')::date))) as is_delayed,
  (r.factory_status = 'blocked') as is_blocked,
  r.viewed_at, r.requested_by, public.factory_user_name(r.requested_by) as requested_by_name,
  r.clarification_note, r.blocked_reason, r.factory_location_id, r.production_department,
  r.created_at, r.updated_at, r.ready_at, r.completed_at, r.is_test_data,
  ic.all_items, r.production_start_date as planned_start, r.expected_completion_date as expected_end,
  r.division_id, pd.code as division_code, pd.name_en as division_name_en, pd.name_gu as division_name_gu,
  r.po_received, r.po_number, r.po_date, r.segment_specs
from public.inhouse_production_requests r
left join public.departments d on d.id = r.source_department_id
left join public.projects pr on pr.id = r.project_id
left join public.production_divisions pd on pd.id = r.division_id
left join lateral (
  select count(*) as item_count, sum(i.quantity) as total_qty,
    string_agg(coalesce(i.quantity::text, '?') || ' ' || coalesce(i.unit, '') || ' ' || i.item_name, ', ' order by i.line_no) filter (where i.line_no <= 3) as qty_summary,
    count(*) filter (where i.quantity is null or i.quantity <= 0) as missing_qty,
    count(*) filter (where i.material is null or i.dimensions is null) as missing_spec,
    string_agg(i.item_name, ', ' order by i.line_no) as all_items
  from public.factory_job_items i where i.job_id = r.id
) ic on true
left join lateral (
  select count(*) as file_count,
    count(*) filter (where f.category in ('Working Drawing', 'Production Drawing', '3D Drawing', 'Normal Drawing', 'Reference Drawing',
      'Furniture Detail Drawing', 'Cutting Drawing', 'Approved Design', 'RCP', 'Electrical Drawing', 'MEP Drawing')) as drawing_count
  from public.factory_drawings f where f.job_id = r.id and f.status <> 'Superseded'
) fc on true;

-- factory_create_segment_job -- the real, dedicated "New Sofa/Modular/Metal Fabrication Job" creation path,
-- reusing factory_create_job_internal (the SAME tested helper every other creation path -- interior, retail,
-- AI intake -- already uses for numbering, idempotent dedup, item insertion, event/audit logging and manager
-- notification) rather than duplicating that logic.
create or replace function public.factory_create_segment_job(
  p_division_code text, p_customer_name text, p_product_item text, p_quantity numeric, p_unit text default 'Nos',
  p_required_date date default null, p_priority text default 'Normal', p_notes text default null,
  p_po_received boolean default null, p_po_number text default null, p_po_date date default null,
  p_segment_specs jsonb default '{}'::jsonb, p_idempotency_key text default null
) returns table(job_id uuid, job_order_number text, already_submitted boolean)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_division public.production_divisions%rowtype;
  v_dept uuid;
  v_result record;
begin
  perform public.staff_assert_operational();
  if not (coalesce(public.staff_is_factory_staff(), false) or coalesce(public.staff_has_global_oversight(), false)) then
    raise exception 'Only Factory staff may create a Job Card directly';
  end if;

  select * into v_division from public.production_divisions where code = p_division_code and is_active;
  if v_division.id is null then raise exception 'Invalid Factory segment'; end if;
  if coalesce(btrim(p_product_item), '') = '' then raise exception 'Product is required'; end if;
  if coalesce(p_quantity, 0) <= 0 then raise exception 'A positive quantity is required'; end if;
  if p_required_date is null then raise exception 'Delivery date is required'; end if;
  if coalesce(p_priority, 'Normal') not in ('Normal', 'High', 'Urgent', 'Emergency') then raise exception 'Invalid priority'; end if;

  select id into v_dept from public.departments where code = 'FACTORY';

  select * into v_result from public.factory_create_job_internal(
    auth.uid(), v_dept, p_idempotency_key, 'manual', null, null, null, p_customer_name, null, p_product_item,
    p_required_date, coalesce(p_priority, 'Normal'), p_notes,
    jsonb_build_array(jsonb_build_object('item_name', p_product_item, 'quantity', p_quantity, 'unit', coalesce(p_unit, 'Nos'))),
    null, null, null
  );

  if not v_result.already_submitted then
    update public.inhouse_production_requests set
      division_id = v_division.id, po_received = p_po_received, po_number = nullif(btrim(coalesce(p_po_number, '')), ''),
      po_date = p_po_date, segment_specs = coalesce(p_segment_specs, '{}'::jsonb)
    where id = v_result.job_id;
    perform public.factory_log_event(v_result.job_id, 'division_set', null, v_division.name_en,
      'Created directly in the ' || v_division.name_en || ' segment', auth.uid());
  end if;

  return query select v_result.job_id, v_result.job_order_number, v_result.already_submitted;
end $function$;

-- factory_update_segment_specs -- the creation flow's Step 2 (and later edits): merges new keys into
-- segment_specs without clobbering ones already set, same authorization as every other Job Card edit.
create or replace function public.factory_update_segment_specs(p_job_id uuid, p_specs jsonb)
returns public.inhouse_production_requests
language plpgsql security definer set search_path to 'public' as $function$
declare
  j public.inhouse_production_requests%rowtype;
  v_allowed boolean;
begin
  perform public.staff_assert_operational();
  select * into j from public.inhouse_production_requests where id = p_job_id for update;
  if j.id is null then raise exception 'Job Card not found'; end if;

  v_allowed := public.factory_ai_is_reviewer() or j.requested_by = auth.uid() or (
    public.factory_my_profile_id() is not null
    and public.factory_my_profile_id() in (j.assigned_factory_coordinator, j.second_assignee_coordinator, j.current_responsible_person)
  );
  if not v_allowed then raise exception 'You are not authorized to edit this Job Card'; end if;
  if jsonb_typeof(p_specs) <> 'object' then raise exception 'Specifications must be a set of fields'; end if;

  update public.inhouse_production_requests set segment_specs = coalesce(segment_specs, '{}'::jsonb) || p_specs, updated_at = now()
  where id = p_job_id returning * into j;
  return j;
end $function$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'factory_create_segment_job(text, text, text, numeric, text, date, text, text, boolean, text, date, jsonb, text)',
    'staff_set_attachment_section(uuid, text)',
    'factory_update_segment_specs(uuid, jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
