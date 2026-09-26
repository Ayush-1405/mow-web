-- Immediate Delivery fast-path (v2_93m): a new per-item fulfilment mode that skips Factory/Procurement AND Retail-side
-- packing entirely. The salesperson captures a "Sales Confirmation Product Photo" (new, distinct from the existing
-- packing photo and from retail_order_items.product_image_path, which is a pre-existing unused catalogue-image column);
-- the moment that photo is in place (and payment/approval is valid), the system AUTOMATICALLY creates the Godown
-- fulfilment request -- no manual "Send to Godown" click. Godown then accepts and does the packing itself, reusing the
-- exact same photo-gated retail_start_packing/retail_verify_packing RPCs already built and tested for the standard
-- Retail-packs-first flow (just now additionally permitted for Godown staff). Everything downstream (Dispatch,
-- Delivery, Installation, pipeline_status rollup) is untouched -- it already derives state generically from the same
-- tables regardless of how a handover was created.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. Schema -- additive only.
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.retail_fulfilment_items drop constraint if exists retail_fulfilment_items_mode_check;
alter table public.retail_fulfilment_items add constraint retail_fulfilment_items_mode_check
  check (mode in ('STOCK','FACTORY','OUTSOURCE','IMMEDIATE_DELIVERY'));

alter table public.retail_order_items drop constraint if exists retail_order_items_fulfilment_check;
alter table public.retail_order_items add constraint retail_order_items_fulfilment_check
  check (fulfilment_mode is null or fulfilment_mode in ('STOCK','FACTORY','OUTSOURCE','IMMEDIATE_DELIVERY'));

alter table public.retail_order_items
  add column if not exists sales_photo_captured_at timestamptz,
  add column if not exists sales_photo_captured_by uuid references public.user_profiles(id),
  add column if not exists sales_photo_location text,
  add column if not exists sales_photo_serial text,
  add column if not exists sales_photo_condition_note text,
  add column if not exists sales_photo_notes text;

-- A handover can now exist before its packing record is Ready for Godown (Immediate Delivery: Godown verifies+packs
-- AFTER accepting). Whether a given handover is "standard" (already packed) or "Immediate Delivery" (Godown must still
-- pack) is derived at read time from the linked packing record's own status -- no new discriminator column needed.
alter table public.retail_godown_handovers alter column packing_id drop not null;

alter table public.staff_attachments drop constraint if exists staff_attachments_entity_type_check;
alter table public.staff_attachments add constraint staff_attachments_entity_type_check
  check (entity_type in ('task','bridge','retail_packing','retail_godown_handover','retail_dispatch','retail_delivery',
                          'retail_installation','retail_order_item'));

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. staff_record_attachment -- one more branch, mirroring the existing retail_packing branch's access-check shape.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.staff_record_attachment(
  p_entity_type text, p_entity_id uuid, p_file_type text, p_storage_path text, p_original_filename text, p_mime_type text,
  p_file_size bigint, p_duration_seconds integer default null, p_purpose text default null)
returns uuid language plpgsql security definer set search_path = public as $$
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
        or public.staff_is_dispatch_staff() or public.staff_has_global_oversight()
        or (public.staff_is_dept_head() and staff_dept_in_hod_scope(dr.department_id))
      )) into v_has_access;

  elsif p_entity_type = 'retail_delivery' then
    select exists(select 1 from public.retail_deliveries where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent delivery record does not exist'; end if;
    select exists(
      select 1 from public.retail_deliveries dl join public.retail_orders o on o.id = dl.order_id where dl.id = p_entity_id and (
        dl.created_by = auth.uid() or o.created_by = auth.uid() or public.retail_can_access_customer(o.customer_id)
        or public.staff_is_dispatch_staff() or public.staff_has_global_oversight()
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
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. retail_confirm_order -- one more per-item branch: IMMEDIATE_DELIVERY creates no Factory job, no Procurement request.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_confirm_order(p_order_id uuid, p_fulfilment jsonb default '[]'::jsonb)
returns setof retail_fulfilment_items
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_order public.retail_orders; v_allowed boolean; v_item record; v_ov jsonb; v_mode text; v_qty numeric;
  v_proc_dept uuid; v_pr_number text; v_pr_id uuid; v_job record; v_any_stock boolean := false; v_any_factory boolean := false;
  v_any_outsource boolean := false; v_any_immediate boolean := false;
begin
  perform public.staff_assert_operational();
  select * into v_order from public.retail_orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;

  v_allowed := (v_order.created_by = auth.uid() or public.staff_has_global_oversight()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_order.department_id)));
  if not v_allowed then raise exception 'Not authorized to confirm this order'; end if;

  if v_order.fulfilment_locked then
    return query select * from public.retail_fulfilment_items where order_id = p_order_id;
    return;
  end if;
  if not exists (select 1 from public.retail_order_items where order_id = p_order_id) then
    raise exception 'This order has no line items';
  end if;

  select id into v_proc_dept from public.departments where code = 'PROCUREMENT';

  for v_item in select * from public.retail_order_items where order_id = p_order_id order by created_at loop
    v_ov := null;
    select elem into v_ov from jsonb_array_elements(coalesce(p_fulfilment, '[]'::jsonb)) elem where (elem->>'order_item_id')::uuid = v_item.id limit 1;
    v_mode := coalesce(v_ov->>'mode', v_item.fulfilment_mode);
    if v_mode is null or v_mode not in ('STOCK', 'FACTORY', 'OUTSOURCE', 'IMMEDIATE_DELIVERY') then
      raise exception 'A fulfilment mode (Stock / Factory / Outsource / Immediate Delivery) is required for every item — missing for %', v_item.item_name;
    end if;
    v_qty := coalesce((v_ov->>'quantity')::numeric, v_item.quantity);
    update public.retail_order_items set fulfilment_mode = v_mode where id = v_item.id;

    if v_mode = 'STOCK' then
      v_any_stock := true;
      insert into public.retail_fulfilment_items (order_id, order_item_id, mode, quantity, status, stock_location_id, created_by)
      values (p_order_id, v_item.id, 'STOCK', v_qty, 'RESERVED', coalesce((v_ov->>'stock_location_id')::uuid, v_order.location_id), auth.uid())
      on conflict (order_item_id) do nothing;

    elsif v_mode = 'IMMEDIATE_DELIVERY' then
      -- No Factory job card, no Procurement request — this item skips straight to an automatic Godown fulfilment
      -- request once its Sales Confirmation Product Photo is captured (see retail_maybe_auto_request_godown()).
      v_any_immediate := true;
      insert into public.retail_fulfilment_items (order_id, order_item_id, mode, quantity, status, created_by)
      values (p_order_id, v_item.id, 'IMMEDIATE_DELIVERY', v_qty, 'PENDING', auth.uid())
      on conflict (order_item_id) do nothing;

    elsif v_mode = 'FACTORY' then
      v_any_factory := true;
      select * into v_job from public.factory_create_job_internal(
        auth.uid(), public.retail_dept_id(), 'retail-order-item:' || v_item.id::text, 'retail', v_order.order_number, v_item.id,
        null, v_order.customer_name, v_order.delivery_address, v_item.item_name,
        coalesce((v_ov->>'required_date')::date, v_order.required_delivery_date, current_date + 14), coalesce(v_ov->>'priority', 'Normal'),
        coalesce(v_ov->>'notes', v_item.customization_notes),
        jsonb_build_array(jsonb_build_object('item_name', v_item.item_name, 'quantity', v_qty, 'dimensions', v_item.dimensions,
          'finish', v_item.finish_color_fabric, 'instruction', v_item.customization_notes)),
        null, null, nullif(v_ov->>'factory_location_id', '')::uuid);
      insert into public.retail_fulfilment_items (order_id, order_item_id, mode, quantity, status, job_card_id, created_by)
      values (p_order_id, v_item.id, 'FACTORY', v_qty, 'IN_PROGRESS', v_job.job_id, auth.uid())
      on conflict (order_item_id) do nothing;

    elsif v_mode = 'OUTSOURCE' then
      v_any_outsource := true;
      v_pr_number := 'RPR-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));
      insert into public.retail_procurement_requests (
        request_number, department_id, origin_department_id, order_id, order_item_id, item_name, specification, quantity,
        required_date, target_cost, preferred_vendor, delivery_destination, qc_requirement, created_by
      ) values (
        v_pr_number, v_proc_dept, public.retail_dept_id(), p_order_id, v_item.id, v_item.item_name,
        coalesce(v_ov->>'specification', v_item.customization_notes), v_qty,
        coalesce((v_ov->>'required_date')::date, v_order.required_delivery_date), nullif(v_ov->>'target_cost', '')::numeric,
        nullif(v_ov->>'preferred_vendor', ''), coalesce(nullif(v_ov->>'delivery_destination', ''), v_order.delivery_address), nullif(v_ov->>'qc_requirement', ''), auth.uid()
      ) on conflict (order_item_id) do nothing returning id into v_pr_id;
      if v_pr_id is not null then
        insert into public.retail_fulfilment_items (order_id, order_item_id, mode, quantity, status, procurement_request_id, created_by)
        values (p_order_id, v_item.id, 'OUTSOURCE', v_qty, 'PENDING', v_pr_id, auth.uid());
        perform public.staff_notify_dept_leadership('PROCUREMENT', 'retail_procurement_request', v_pr_id,
          'New procurement request from Retail: ' || v_item.item_name || ' (' || v_order.order_number || ')',
          'રિટેલ તરફથી નવી ખરીદ વિનંતી: ' || v_item.item_name || ' (' || v_order.order_number || ')');
      end if;
    end if;
  end loop;

  update public.retail_orders set status = 'CONFIRMED', confirmed_at = now(), confirmed_by = auth.uid(), fulfilment_locked = true where id = p_order_id;
  insert into public.retail_deliveries (department_id, order_id, delivery_address, created_by)
  values (public.retail_dept_id(), p_order_id, v_order.delivery_address, auth.uid())
  on conflict (order_id) do nothing;

  perform public.staff_write_audit('retail_order', p_order_id, 'CONFIRM_ORDER', jsonb_build_object('status', v_order.status),
    jsonb_build_object('status', 'CONFIRMED', 'has_stock', v_any_stock, 'has_factory', v_any_factory, 'has_outsource', v_any_outsource,
      'has_immediate_delivery', v_any_immediate), public.retail_dept_id());
  perform public.retail_recompute_order_pipeline_status(p_order_id);

  return query select * from public.retail_fulfilment_items where order_id = p_order_id;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. retail_send_to_godown -- new optional p_allow_before_packing param. Default false preserves 100% of current
--    behavior for every existing caller (the frontend never passes it). Must DROP the old 5-arg signature first —
--    CREATE OR REPLACE with an added parameter creates a co-existing overload rather than replacing it (bit this
--    project twice already this session; see retail_upsert_customer's own fix).
-- ---------------------------------------------------------------------------------------------------------------------------------
drop function if exists public.retail_send_to_godown(uuid, uuid, uuid, timestamptz, text);

create or replace function public.retail_send_to_godown(
  p_order_id uuid, p_godown_location_id uuid, p_responsible_user_id uuid,
  p_expected_handover_at timestamp with time zone default null, p_notes text default null,
  p_allow_before_packing boolean default false)
returns retail_godown_handovers
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_order public.retail_orders; v_packing public.retail_packing_records; v_allowed boolean; v_godown_dept uuid := public.retail_godown_dept_id();
  v_responsible_dept uuid; v_row public.retail_godown_handovers; v_key text; v_task_id uuid; v_task_number text;
begin
  perform public.staff_assert_operational();
  select * into v_order from public.retail_orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;

  v_allowed := (coalesce(v_order.created_by = auth.uid(), false) or coalesce(public.retail_can_write_customer(v_order.customer_id), false)
    or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_order.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to assign this order to Godown'; end if;

  select * into v_row from public.retail_godown_handovers where order_id = p_order_id and status in ('PENDING', 'ACCEPTED');
  if v_row.id is not null then return v_row; end if; -- idempotent while one is already open

  select * into v_packing from public.retail_packing_records where order_id = p_order_id;
  if v_packing.id is null then
    if p_allow_before_packing then
      -- Immediate Delivery: no packing has happened yet — auto-create the (already idempotent) packing record so
      -- Godown has something to accept against and later verify+pack itself.
      v_packing := public.retail_start_packing(p_order_id);
    else
      raise exception 'Packing must be verified (Ready for Godown) before assigning to Godown';
    end if;
  elsif v_packing.status <> 'READY_FOR_GODOWN' and not p_allow_before_packing then
    raise exception 'Packing must be verified (Ready for Godown) before assigning to Godown';
  end if;

  select department_id into v_responsible_dept from public.user_profiles where id = p_responsible_user_id and is_active = true;
  if v_responsible_dept is distinct from v_godown_dept then raise exception 'Responsible person must be an active Godown team member'; end if;

  insert into public.retail_godown_handovers (order_id, packing_id, department_id, origin_department_id, godown_location_id,
    responsible_user_id, expected_handover_at, notes, created_by)
  values (p_order_id, v_packing.id, v_godown_dept, v_order.department_id, p_godown_location_id, p_responsible_user_id, p_expected_handover_at, p_notes, auth.uid())
  returning * into v_row;

  v_key := 'retail_godown_handover:' || v_row.id::text;
  select tk.task_id, tk.task_number into v_task_id, v_task_number from public.staff_create_task(
    case when p_allow_before_packing then 'Immediate Delivery: receive & pack order ' || v_order.order_number || ' at Godown'
         else 'Receive order ' || v_order.order_number || ' at Godown' end,
    coalesce(p_notes, case when p_allow_before_packing then 'Verify stock, confirm quantities/condition, then pack and upload a packing photo.'
                            else 'Verify packages, condition and quantity; upload a receiving photo.' end),
    'GENERAL_TASK', 'HIGH', 'photo', v_order.department_id, v_godown_dept, p_responsible_user_id,
    coalesce(p_expected_handover_at::date, current_date + 1), p_expected_handover_at::time, null, v_order.order_number, null, null, null, null) tk;
  update public.staff_tasks set system_key = v_key where id = v_task_id;
  update public.retail_godown_handovers set linked_task_id = v_task_id where id = v_row.id returning * into v_row;

  perform public.retail_log_status_change('retail_order', p_order_id, v_order.status, 'ASSIGNED_TO_GODOWN', v_godown_dept, p_notes);
  perform public.staff_write_audit('retail_godown_handover', v_row.id, 'CREATE', null,
    jsonb_build_object('order_id', p_order_id, 'responsible_user_id', p_responsible_user_id, 'immediate_delivery', p_allow_before_packing), v_godown_dept);
  perform public.staff_notify_assignment(p_responsible_user_id, 'retail_godown_handover', v_row.id,
    'Incoming handover: order ' || v_order.order_number, v_order.order_number || ' — ગોડાઉન હેન્ડઓવર આવી રહ્યું છે');
  return v_row;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. retail_maybe_auto_request_godown -- the automatic trigger. Called from retail_record_sales_photo_meta (photo is
--    usually the last precondition) and from retail_record_payment (in case payment clears last). Fully idempotent:
--    safe to call redundantly from both directions, from a retry, or after a page refresh.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_maybe_auto_request_godown(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_order public.retail_orders;
  v_ready boolean;
  v_godown_dept uuid := public.retail_godown_dept_id();
  v_head uuid;
begin
  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order.id is null or v_order.status <> 'CONFIRMED' or v_order.on_hold then return; end if;

  -- Every IMMEDIATE_DELIVERY item on this order must have its Sales Confirmation Product Photo captured.
  if not exists (select 1 from public.retail_fulfilment_items where order_id = p_order_id and mode = 'IMMEDIATE_DELIVERY') then
    return; -- nothing to do for this order
  end if;
  select not exists (
    select 1 from public.retail_order_items oi
    join public.retail_fulfilment_items fi on fi.order_item_id = oi.id
    where oi.order_id = p_order_id and fi.mode = 'IMMEDIATE_DELIVERY' and oi.sales_photo_captured_at is null
  ) into v_ready;
  if not v_ready then return; end if;

  -- Payment/approval valid: simplest faithful reading given no dedicated approval workflow exists yet — either some
  -- payment has been recorded, or the order simply has no amount to collect. Disclosed as the chosen interpretation.
  if v_order.total_amount > 0 and v_order.payment_status = 'PENDING' then return; end if;

  if exists (select 1 from public.retail_godown_handovers where order_id = p_order_id and status in ('PENDING','ACCEPTED')) then
    return; -- already requested — retail_send_to_godown is idempotent too, but skip the extra call
  end if;

  select up.id into v_head from public.user_profiles up
    join public.roles ro on ro.id = up.role_id
    where up.is_active = true and up.department_id = v_godown_dept and ro.code = 'dept_head'
    order by up.created_at limit 1;
  if v_head is null then
    -- No Godown Head configured yet — leave this order at AWAITING_PRODUCT_PHOTO's next natural state
    -- (ASSIGNED_TO_GODOWN cannot be reached without a responsible person); nothing more this pass can do safely.
    return;
  end if;

  perform public.retail_send_to_godown(p_order_id, null, v_head, null,
    'Automatic Immediate Delivery request — created when the Sales Confirmation Product Photo was captured.', true);
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 6. retail_record_sales_photo_meta -- requires the photo to already be uploaded (same no-photo-no-progress pattern
--    as packing/godown/dispatch/delivery), records its metadata, then fires the automatic trigger.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_record_sales_photo_meta(
  p_order_item_id uuid, p_location text default null, p_serial text default null,
  p_condition_note text default null, p_notes text default null)
returns retail_order_items
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_item public.retail_order_items; v_order public.retail_orders; v_allowed boolean; v_has_photo boolean;
begin
  perform public.staff_assert_operational();
  select * into v_item from public.retail_order_items where id = p_order_item_id for update;
  if v_item.id is null then raise exception 'Order item not found'; end if;
  select * into v_order from public.retail_orders where id = v_item.order_id;

  v_allowed := (coalesce(v_order.created_by = auth.uid(), false) or coalesce(public.retail_can_write_customer(v_order.customer_id), false)
    or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_order.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to record a sales photo on this item'; end if;

  select exists (select 1 from public.staff_attachments a where a.entity_type = 'retail_order_item' and a.entity_id = p_order_item_id
    and a.purpose = 'proof' and a.is_active) into v_has_photo;
  if not v_has_photo then raise exception 'A Sales Confirmation Product Photo is required before it can be confirmed'; end if;

  update public.retail_order_items set
    sales_photo_captured_at = now(), sales_photo_captured_by = auth.uid(),
    sales_photo_location = coalesce(p_location, sales_photo_location), sales_photo_serial = coalesce(p_serial, sales_photo_serial),
    sales_photo_condition_note = coalesce(p_condition_note, sales_photo_condition_note), sales_photo_notes = coalesce(p_notes, sales_photo_notes)
  where id = p_order_item_id returning * into v_item;

  perform public.staff_write_audit('retail_order_item', p_order_item_id, 'SALES_PHOTO_CONFIRMED', null,
    jsonb_build_object('order_id', v_item.order_id), v_order.department_id);
  perform public.retail_recompute_order_pipeline_status(v_item.order_id);
  perform public.retail_maybe_auto_request_godown(v_item.order_id);

  return v_item;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 7. retail_record_payment -- one added line: payment clearing can also be the last precondition to satisfy.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_record_payment(p_order_id uuid, p_amount numeric, p_payment_mode text default null, p_note text default null)
returns retail_orders
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_order public.retail_orders;
  v_allowed boolean;
  v_new_paid numeric(12,2);
  v_new_status text;
begin
  perform public.staff_assert_operational();

  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be positive';
  end if;

  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order is null then
    raise exception 'Order not found';
  end if;

  v_allowed := (
    v_order.created_by = auth.uid()
    or public.staff_is_management()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_order.department_id))
  );
  if not v_allowed then
    raise exception 'Not authorized to record a payment on this order';
  end if;

  insert into public.retail_payments (order_id, amount, payment_mode, note, created_by)
  values (p_order_id, p_amount, p_payment_mode, p_note, auth.uid());

  v_new_paid := v_order.amount_paid + p_amount;
  v_new_status := case
    when v_new_paid >= v_order.total_amount and v_order.total_amount > 0 then 'PAID'
    when v_new_paid > 0 then 'PARTIAL'
    else 'PENDING'
  end;

  update public.retail_orders
  set amount_paid = v_new_paid, payment_status = v_new_status
  where id = p_order_id
  returning * into v_order;

  perform public.retail_maybe_auto_request_godown(p_order_id);

  return v_order;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 8. retail_godown_accept -- if the linked packing isn't Ready for Godown yet (Immediate Delivery), create Godown's
--    own verify+pack task, assigned to Godown (not to whoever auto-triggered the request).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_godown_accept(p_handover_id uuid, p_packages_received integer, p_quantity_verified boolean, p_condition_verified boolean, p_rack_location text default null, p_notes text default null)
returns retail_godown_handovers
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_row public.retail_godown_handovers; v_allowed boolean; v_has_photo boolean;
  v_packing public.retail_packing_records; v_order public.retail_orders; v_task_id uuid; v_task_number text; v_key text;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_godown_handovers where id = p_handover_id for update;
  if v_row.id is null then raise exception 'Handover not found'; end if;
  if v_row.status = 'ACCEPTED' then return v_row; end if; -- idempotent
  if v_row.status <> 'PENDING' then raise exception 'This handover is not pending'; end if;

  v_allowed := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_row.department_id), false))
    or (coalesce(public.staff_is_godown_staff(), false) and (coalesce(v_row.responsible_user_id = auth.uid(), false) or v_row.responsible_user_id is null)));
  if not v_allowed then raise exception 'Not authorized to accept this handover'; end if;

  select exists (select 1 from public.staff_attachments a where a.entity_type = 'retail_godown_handover' and a.entity_id = p_handover_id
    and a.purpose = 'proof' and a.is_active) into v_has_photo;
  if not v_has_photo then raise exception 'A receiving photo is required before this handover can be accepted'; end if;

  update public.retail_godown_handovers set status = 'ACCEPTED', accepted_by = auth.uid(), accepted_at = now(),
    packages_received = p_packages_received, quantity_verified = p_quantity_verified, condition_verified = p_condition_verified,
    rack_location = p_rack_location, notes = coalesce(p_notes, notes)
  where id = p_handover_id returning * into v_row;

  update public.retail_orders set on_hold = false, on_hold_reason = null where id = v_row.order_id and on_hold;

  -- Immediate Delivery: the linked packing record isn't Ready for Godown yet — Godown itself still has to verify
  -- stock and pack. Give Godown its own real, assigned task for that (retail_start_packing's own task, created
  -- automatically back when the order's photo was confirmed, was assigned to the salesperson — not Godown).
  if v_row.packing_id is not null then
    select * into v_packing from public.retail_packing_records where id = v_row.packing_id;
    if v_packing.id is not null and v_packing.status <> 'READY_FOR_GODOWN' then
      v_key := 'retail_godown_packing:' || v_packing.id::text;
      if not exists (select 1 from public.staff_tasks where system_key = v_key) then
        select * into v_order from public.retail_orders where id = v_row.order_id;
        select tk.task_id, tk.task_number into v_task_id, v_task_number from public.staff_create_task(
          'Verify & pack order ' || v_order.order_number || ' at Godown',
          'Verify stock, confirm quantities/condition, then pack and upload a packing photo before dispatch.',
          'GENERAL_TASK', 'HIGH', 'photo', v_row.department_id, v_row.department_id,
          coalesce(v_row.responsible_user_id, auth.uid()), current_date + 1, null, null, v_order.order_number, null, null, null, null) tk;
        update public.staff_tasks set system_key = v_key where id = v_task_id;
        update public.retail_packing_records set linked_task_id = coalesce(linked_task_id, v_task_id) where id = v_packing.id;
      end if;
    end if;
  end if;

  perform public.retail_log_status_change('retail_order', v_row.order_id, 'ASSIGNED_TO_GODOWN', 'RECEIVED_AT_GODOWN', v_row.department_id, p_notes);
  perform public.staff_write_audit('retail_godown_handover', p_handover_id, 'ACCEPT', null,
    jsonb_build_object('packages_received', p_packages_received, 'rack_location', p_rack_location), v_row.department_id);
  return v_row;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 9. retail_start_packing / retail_verify_packing -- widen authorization to also permit Godown staff (additive only:
--    every existing Retail-side authorization clause is unchanged, this only adds who ELSE may act).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_start_packing(p_order_id uuid, p_partial_reason text default null)
returns retail_packing_records
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_order public.retail_orders; v_allowed boolean; v_row public.retail_packing_records; v_not_ready int; v_key text; v_task_id uuid; v_task_number text;
begin
  perform public.staff_assert_operational();
  select * into v_order from public.retail_orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;

  v_allowed := (coalesce(v_order.created_by = auth.uid(), false) or coalesce(public.retail_can_write_customer(v_order.customer_id), false)
    or coalesce(public.staff_has_global_oversight(), false) or coalesce(public.staff_is_godown_staff(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_order.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to start packing on this order'; end if;

  select * into v_row from public.retail_packing_records where order_id = p_order_id;
  if v_row.id is not null then return v_row; end if; -- idempotent

  if v_order.status <> 'CONFIRMED' then raise exception 'Order must be confirmed before packing can start'; end if;

  select count(*) into v_not_ready from public.retail_fulfilment_items where order_id = p_order_id and status <> 'READY' and mode <> 'IMMEDIATE_DELIVERY';
  if v_not_ready > 0 and coalesce(btrim(p_partial_reason), '') = '' then
    raise exception 'Not every item is Ready yet (%) — provide a partial_reason to start packing anyway', v_not_ready;
  end if;

  insert into public.retail_packing_records (order_id, department_id, status, partial_reason, created_by)
  values (p_order_id, v_order.department_id, 'AWAITING_PACKING', nullif(btrim(p_partial_reason), ''), auth.uid())
  returning * into v_row;

  insert into public.retail_packing_items (packing_id, order_item_id, quantity_confirmed)
  select v_row.id, oi.id, 0 from public.retail_order_items oi where oi.order_id = p_order_id
  on conflict (packing_id, order_item_id) do nothing;

  v_key := 'retail_packing:' || v_row.id::text;
  select tk.task_id, tk.task_number into v_task_id, v_task_number from public.staff_create_task(
    'Pack order ' || v_order.order_number, 'Confirm items/quantities, QC, and upload a packing photo before sending to Godown.',
    'GENERAL_TASK', 'HIGH', 'photo', v_order.department_id, v_order.department_id, auth.uid(), current_date + 2, null,
    null, v_order.order_number, null, null, null, null) tk;
  update public.staff_tasks set system_key = v_key where id = v_task_id;
  update public.retail_packing_records set linked_task_id = v_task_id where id = v_row.id returning * into v_row;

  perform public.retail_log_status_change('retail_order', p_order_id, v_order.status, 'PACKING_STARTED', v_order.department_id, p_partial_reason);
  perform public.staff_write_audit('retail_packing', v_row.id, 'START', null, jsonb_build_object('order_id', p_order_id), v_order.department_id);
  return v_row;
end $function$;

create or replace function public.retail_verify_packing(p_packing_id uuid, p_items jsonb default '[]'::jsonb, p_qc_status text default 'PASSED'::text, p_package_count integer default null::integer, p_condition_notes text default null::text, p_missing_damaged_note text default null::text)
returns retail_packing_records
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_row public.retail_packing_records; v_order public.retail_orders; v_allowed boolean; v_has_photo boolean; v_it jsonb; v_new_status text;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_packing_records where id = p_packing_id for update;
  if v_row.id is null then raise exception 'Packing record not found'; end if;
  select * into v_order from public.retail_orders where id = v_row.order_id;

  v_allowed := (coalesce(v_row.created_by = auth.uid(), false) or coalesce(public.retail_can_write_customer(v_order.customer_id), false)
    or coalesce(public.staff_has_global_oversight(), false) or coalesce(public.staff_is_godown_staff(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_row.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to verify this packing record'; end if;
  if p_qc_status not in ('PENDING', 'PASSED', 'FAILED') then raise exception 'Invalid QC status'; end if;

  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into public.retail_packing_items (packing_id, order_item_id, quantity_confirmed)
    values (p_packing_id, (v_it->>'order_item_id')::uuid, coalesce((v_it->>'quantity_confirmed')::numeric, 0))
    on conflict (packing_id, order_item_id) do update set quantity_confirmed = excluded.quantity_confirmed;
  end loop;

  select exists (select 1 from public.staff_attachments a where a.entity_type = 'retail_packing' and a.entity_id = p_packing_id
    and a.purpose = 'proof' and a.is_active) into v_has_photo;
  if not v_has_photo then raise exception 'A current packing photo is required before packing can be verified'; end if;

  v_new_status := case when p_qc_status = 'PASSED' and coalesce(p_package_count, 0) > 0 then 'READY_FOR_GODOWN' else 'VERIFIED' end;

  update public.retail_packing_records set
    status = v_new_status, qc_status = p_qc_status, package_count = coalesce(p_package_count, package_count),
    condition_notes = coalesce(p_condition_notes, condition_notes), missing_damaged_note = coalesce(p_missing_damaged_note, missing_damaged_note),
    packed_by = auth.uid(), packed_at = now()
  where id = p_packing_id returning * into v_row;

  perform public.retail_log_status_change('retail_packing', p_packing_id, 'IN_PROGRESS', v_new_status, v_row.department_id, p_condition_notes);
  perform public.staff_write_audit('retail_packing', p_packing_id, 'VERIFY', null, jsonb_build_object('status', v_new_status, 'qc_status', p_qc_status), v_row.department_id);
  return v_row;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 10. retail_recompute_order_pipeline_status -- one more branch: AWAITING_PRODUCT_PHOTO before the existing
--     FULFILMENT_READY/FULFILMENT_PENDING fallback. Every downstream branch (Godown/Dispatch/Delivery/Installation)
--     is unchanged — it already derives generically from the same tables regardless of how a handover was created.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_recompute_order_pipeline_status(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_order public.retail_orders; v_delivery public.retail_deliveries; v_install public.retail_installations;
  v_packing public.retail_packing_records; v_handover public.retail_godown_handovers; v_dispatch public.retail_dispatch_records;
  v_status text; v_not_ready int; v_awaiting_photo boolean;
begin
  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order.id is null then return null; end if;
  if v_order.on_hold then
    v_status := 'ON_HOLD';
  elsif v_order.status = 'CANCELLED' then
    v_status := 'CANCELLED';
  else
    select * into v_delivery from public.retail_deliveries where order_id = p_order_id;
    select * into v_install from public.retail_installations where order_id = p_order_id;
    select * into v_packing from public.retail_packing_records where order_id = p_order_id;
    select * into v_handover from public.retail_godown_handovers where order_id = p_order_id and status in ('PENDING', 'ACCEPTED') order by created_at desc limit 1;
    select * into v_dispatch from public.retail_dispatch_records where order_id = p_order_id;

    if v_install.id is not null and v_install.status = 'COMPLETED' then v_status := 'COMPLETED';
    elsif v_delivery.id is not null and v_delivery.stage = 'COMPLETED' then v_status := 'COMPLETED';
    elsif v_install.id is not null then v_status := coalesce(v_delivery.stage, 'INSTALLATION_PENDING');
    elsif v_delivery.id is not null and v_delivery.stage in ('DELIVERY_SUCCESSFUL', 'DELIVERY_PROOF_UPLOADED', 'DELIVERY_FAILED', 'OUT_FOR_DELIVERY', 'ARRIVED_AT_SITE') then
      v_status := v_delivery.stage;
    elsif v_dispatch.id is not null and v_dispatch.dispatched_at is not null then v_status := 'OUT_FOR_DELIVERY';
    elsif v_handover.id is not null and v_handover.status = 'ACCEPTED' then v_status := 'RECEIVED_AT_GODOWN';
    elsif v_handover.id is not null and v_handover.status = 'PENDING' then v_status := 'ASSIGNED_TO_GODOWN';
    elsif v_packing.id is not null and v_packing.status = 'READY_FOR_GODOWN' then v_status := 'READY_FOR_GODOWN';
    elsif v_packing.id is not null then v_status := 'PACKING';
    elsif v_order.status = 'CONFIRMED' then
      select exists (
        select 1 from public.retail_order_items oi join public.retail_fulfilment_items fi on fi.order_item_id = oi.id
        where oi.order_id = p_order_id and fi.mode = 'IMMEDIATE_DELIVERY' and oi.sales_photo_captured_at is null
      ) into v_awaiting_photo;
      if v_awaiting_photo then
        v_status := 'AWAITING_PRODUCT_PHOTO';
      else
        select count(*) into v_not_ready from public.retail_fulfilment_items where order_id = p_order_id and status <> 'READY';
        v_status := case when v_not_ready = 0 then 'FULFILMENT_READY' else 'FULFILMENT_PENDING' end;
      end if;
    else
      v_status := v_order.status;
    end if;
  end if;

  update public.retail_orders set pipeline_status = v_status where id = p_order_id;
  return v_status;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 11. Read helper for the salesperson's "action needed" view — every IMMEDIATE_DELIVERY item with its photo/handover
--     status, RLS-equivalent scoped by the same ownership rule as everything else in this module.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_immediate_delivery_queue()
returns table (
  order_item_id uuid, order_id uuid, order_number text, customer_name text, item_name text, quantity numeric,
  sales_photo_captured_at timestamptz, handover_id uuid, handover_status text, packing_status text
)
language sql stable security definer set search_path = public as $$
  select oi.id, o.id, o.order_number, o.customer_name, oi.item_name, oi.quantity,
    oi.sales_photo_captured_at, h.id, h.status, p.status
  from public.retail_order_items oi
  join public.retail_orders o on o.id = oi.order_id
  join public.retail_fulfilment_items fi on fi.order_item_id = oi.id and fi.mode = 'IMMEDIATE_DELIVERY'
  left join public.retail_godown_handovers h on h.order_id = o.id and h.status in ('PENDING','ACCEPTED')
  left join public.retail_packing_records p on p.order_id = o.id
  where o.is_active and (
    o.created_by = auth.uid() or public.retail_can_access_customer(o.customer_id)
    or public.staff_is_godown_staff() or public.staff_has_global_oversight()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(o.department_id))
  )
  order by o.created_at desc;
$$;

grant execute on function public.retail_maybe_auto_request_godown(uuid) to authenticated;
grant execute on function public.retail_record_sales_photo_meta(uuid, text, text, text, text) to authenticated;
grant execute on function public.retail_send_to_godown(uuid, uuid, uuid, timestamptz, text, boolean) to authenticated;
grant execute on function public.retail_immediate_delivery_queue() to authenticated;
