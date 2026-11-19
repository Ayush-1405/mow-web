-- Production Supply Order Forms: a department places one ORDER with many items, on the Interior (compact) or Retail
-- (large, with rate and amount) form. It reuses the Procurement workflow from v3_01/v3_02: the order is a purchase_requests
-- row, its lines are purchase_request_items, and it goes Department Head -> Procurement -> print -> order placed.
-- Adds: multi-item orders, form type and client/sales/vendor fields, order attachments, Procurement "return for
-- correction", delivered/completed steps for simple orders, and amendments with history after the order is placed.

begin;

-- ---------------------------------------------------------------------------
-- 1. Structure
-- ---------------------------------------------------------------------------

alter table public.purchase_requests
  add column if not exists order_form_type text,
  add column if not exists client_name text,
  add column if not exists sales_person_name text,
  add column if not exists preferred_vendor_name text,
  add column if not exists delivery_date date,
  add column if not exists delivered_to_client_at date,
  add column if not exists order_total numeric(14,2),
  add column if not exists urgency_reason text;
do $$ begin
  alter table public.purchase_requests add constraint purchase_requests_order_form_type_check check (order_form_type in ('INTERIOR', 'RETAIL'));
exception when duplicate_object then null; end $$;

alter table public.purchase_request_items
  add column if not exists line_no integer,
  add column if not exists qty_size text,
  add column if not exists rate numeric(14,2),
  add column if not exists amount numeric(14,2),
  add column if not exists line_remarks text;

alter table public.purchase_attachments alter column project_id drop not null;

-- Order files (drawings, PDFs, photos): orders/<request id>/<file>. Visible to whoever can see the request.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('procurement-orders', 'procurement-orders', false, 20971520,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf', 'application/dxf', 'application/dwg',
        'image/vnd.dwg', 'image/vnd.dxf', 'application/x-dwg', 'application/x-dxf', 'application/acad'])
on conflict (id) do nothing;

drop policy if exists proc_order_files_select on storage.objects;
create policy proc_order_files_select on storage.objects for select to authenticated
  using (bucket_id = 'procurement-orders' and split_part(name, '/', 1) = 'orders'
         and public.proc_can_view_request(public.proc_try_uuid(split_part(name, '/', 2))));
drop policy if exists proc_order_files_insert on storage.objects;
create policy proc_order_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'procurement-orders' and split_part(name, '/', 1) = 'orders'
              and public.proc_can_view_request(public.proc_try_uuid(split_part(name, '/', 2))));

-- ---------------------------------------------------------------------------
-- 2. Creating and editing an order
-- ---------------------------------------------------------------------------

-- Checks the items and returns them normalised: [{line_no, item_code, description, qty_size, quantity, rate, amount, remarks}].
create or replace function public.proc_normalise_order_items(p_items jsonb)
returns jsonb language plpgsql immutable set search_path to 'public' as $$
declare v_item jsonb; v_out jsonb := '[]'; v_n integer := 0; v_qty numeric; v_rate numeric; v_amount numeric;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Add at least one item'; end if;
  if jsonb_array_length(p_items) > 50 then raise exception 'An order can have at most 50 items'; end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_n := v_n + 1;
    if btrim(coalesce(v_item->>'description', '')) = '' then raise exception 'Item %: description is required', v_n; end if;
    if btrim(coalesce(v_item->>'qty_size', '')) = '' then raise exception 'Item %: quantity / size is required', v_n; end if;
    v_qty := nullif(btrim(coalesce(v_item->>'quantity', '')), '')::numeric;
    v_rate := nullif(btrim(coalesce(v_item->>'rate', '')), '')::numeric;
    if coalesce(v_qty, 0) < 0 or coalesce(v_rate, 0) < 0 then raise exception 'Item %: quantity and rate cannot be negative', v_n; end if;
    v_amount := case when v_qty is not null and v_rate is not null then round(v_qty * v_rate, 2) end;
    v_out := v_out || jsonb_build_array(jsonb_build_object('line_no', v_n, 'item_code', nullif(btrim(coalesce(v_item->>'item_code', '')), ''),
      'description', btrim(v_item->>'description'), 'qty_size', btrim(v_item->>'qty_size'), 'quantity', v_qty, 'rate', v_rate, 'amount', v_amount,
      'remarks', nullif(btrim(coalesce(v_item->>'remarks', '')), '')));
  end loop;
  return v_out;
exception when invalid_text_representation then raise exception 'Quantity and rate must be numbers';
end $$;

create or replace function public.proc_write_order_items(p_row public.purchase_requests, p_items jsonb)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  delete from public.purchase_request_items where purchase_request_id = p_row.id;
  insert into public.purchase_request_items (project_id, purchase_request_id, line_no, item_name, item_code, description, qty_size, quantity, rate, amount,
    line_remarks, unit, required_at_location, required_by_date, status)
  select p_row.project_id, p_row.id, (i->>'line_no')::int, left(i->>'description', 200), i->>'item_code', i->>'description', i->>'qty_size',
    (i->>'quantity')::numeric, (i->>'rate')::numeric, (i->>'amount')::numeric, i->>'remarks', null, p_row.delivery_location, p_row.required_by_date, 'Requested'
  from jsonb_array_elements(p_items) i;
end $$;

-- Header fields: project_id, form_type, client_name, sales_person_name, vendor_name, required_completion_date, delivery_date,
-- delivery_location, remarks, priority, procurement_category, is_emergency, emergency_reason.
create or replace function public.proc_create_order(p_header jsonb, p_items jsonb, p_submit boolean default true)
returns public.purchase_requests language plpgsql security definer set search_path to 'public' as $$
declare
  v_dept uuid := public.staff_current_department_id(); v_items jsonb; v_row public.purchase_requests; v_status text; v_key text; v_dup text;
  v_project uuid := public.proc_try_uuid(p_header->>'project_id'); v_required date; v_delivery date; v_n integer; v_total numeric;
  v_emergency boolean := coalesce((p_header->>'is_emergency')::boolean, false); v_form text := upper(coalesce(p_header->>'form_type', ''));
  v_priority text := upper(coalesce(nullif(p_header->>'priority', ''), 'NORMAL'));
  v_reason text := nullif(btrim(coalesce(p_header->>'urgency_reason', p_header->>'emergency_reason', '')), '');
begin
  perform public.staff_assert_operational();
  if v_dept is null then raise exception 'Your profile has no department, so an order cannot be placed'; end if;
  if v_form not in ('INTERIOR', 'RETAIL') then raise exception 'Choose the Interior or Retail order form'; end if;
  v_items := public.proc_normalise_order_items(p_items);
  v_n := jsonb_array_length(v_items);
  v_required := nullif(p_header->>'required_completion_date', '')::date;
  v_delivery := nullif(p_header->>'delivery_date', '')::date;
  if v_required is null then raise exception 'Required completion date is required'; end if;
  if v_required < (now() at time zone 'Asia/Kolkata')::date then raise exception 'Required completion date cannot be in the past'; end if;
  if v_delivery is not null and v_delivery < v_required then raise exception 'Delivery date cannot be before the completion date'; end if;
  if btrim(coalesce(p_header->>'delivery_location', '')) = '' then raise exception 'Delivery location is required'; end if;
  if v_priority not in ('NORMAL', 'HIGH', 'URGENT', 'EMERGENCY') then raise exception 'Priority must be Normal, High, Urgent or Emergency'; end if;
  -- Emergency priority is the emergency purchase (Management approves before Procurement); the old is_emergency flag means the same.
  if v_emergency then v_priority := 'EMERGENCY'; end if;
  v_emergency := v_priority = 'EMERGENCY';
  if v_priority in ('URGENT', 'EMERGENCY') and v_reason is null then raise exception 'Give the reason for urgency'; end if;
  if v_project is not null and not (public.interior_is_org_wide() or public.interior_is_project_member(v_project)) then
    raise exception 'You are not a member of this project';
  end if;
  select sum((i->>'amount')::numeric) into v_total from jsonb_array_elements(v_items) i;

  v_key := md5(concat_ws('|', v_dept, v_project, v_form, v_required, (select string_agg(lower(i->>'description') || '#' || lower(i->>'qty_size'), ';')
                                                                       from jsonb_array_elements(v_items) i)));
  select request_number into v_dup from public.purchase_requests where dedupe_key = v_key
     and proc_status not in ('LEGACY', 'REJECTED_BY_DEPT_HEAD', 'REJECTED_BY_PROCUREMENT', 'EMERGENCY_REJECTED', 'CANCELLED', 'CLOSED') limit 1;
  if v_dup is not null then raise exception 'The same order is already open as %', v_dup; end if;

  v_status := case when not coalesce(p_submit, true) then 'DRAFT' when v_emergency then 'EMERGENCY_APPROVAL_PENDING' else 'PENDING_DEPT_APPROVAL' end;
  insert into public.purchase_requests (project_id, request_number, purchase_source, priority, purpose, notes, requested_by, created_by, request_date,
    status, requesting_department_id, requester_user_id, proc_status, procurement_category, material_name, material_category, quantity, unit,
    required_by_date, delivery_location, remarks, is_emergency, emergency_reason, dedupe_key, proc_updated_at,
    order_form_type, client_name, sales_person_name, preferred_vendor_name, delivery_date, order_total, urgency_reason)
  values (v_project, public.proc_next_number('PR'), 'Procurement', v_priority,
    left(v_items->0->>'description', 150) || case when v_n > 1 then ' + ' || (v_n - 1) || ' more' else '' end, p_header->>'remarks',
    public.interior_current_profile_id(), public.interior_current_profile_id(), (now() at time zone 'Asia/Kolkata')::date, 'Procurement',
    v_dept, auth.uid(), v_status, coalesce(nullif(p_header->>'procurement_category', ''), 'MATERIAL'),
    left(v_items->0->>'description', 150) || case when v_n > 1 then ' + ' || (v_n - 1) || ' more' else '' end, 'Order', v_n, case when v_n = 1 then 'item' else 'items' end,
    v_required, btrim(p_header->>'delivery_location'), nullif(btrim(coalesce(p_header->>'remarks', '')), ''), v_emergency,
    case when v_emergency then v_reason end, v_key, now(),
    v_form, nullif(btrim(coalesce(p_header->>'client_name', '')), ''), nullif(btrim(coalesce(p_header->>'sales_person_name', '')), ''),
    nullif(btrim(coalesce(p_header->>'vendor_name', '')), ''), v_delivery, v_total, case when v_priority <> 'NORMAL' then v_reason end)
  returning * into v_row;
  perform public.proc_write_order_items(v_row, v_items);

  insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
  values (v_row.id, null, v_status, auth.uid(), public.staff_current_role_code(),
    'Due date ' || to_char(v_required, 'DD-MM-YYYY') || ', priority ' || initcap(v_priority) || coalesce(' (' || v_reason || ')', ''));
  perform public.staff_write_audit('purchase_request', v_row.id, 'CREATE_ORDER', null, to_jsonb(v_row) || jsonb_build_object('items', v_items), v_dept, null);
  perform public.proc_notify_submitted(v_row);
  return v_row;
exception when invalid_datetime_format or datetime_field_overflow then raise exception 'One of the dates is not valid';
end $$;

-- The requester edits a draft or an order returned for correction (by the Head or by Procurement).
create or replace function public.proc_update_order(p_request_id uuid, p_header jsonb, p_items jsonb)
returns public.purchase_requests language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_items jsonb; v_n integer; v_required date; v_delivery date; v_total numeric; v_old jsonb;
  v_priority text; v_reason text := nullif(btrim(coalesce(p_header->>'urgency_reason', p_header->>'emergency_reason', '')), '');
begin
  perform public.staff_assert_operational();
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null or v_row.order_form_type is null then raise exception 'Order not found'; end if;
  if v_row.requester_user_id is distinct from auth.uid() then raise exception 'Only the person who placed this order can edit it'; end if;
  if v_row.proc_status not in ('DRAFT', 'RETURNED_FOR_CORRECTION') then raise exception 'Only a draft or a returned order can be edited'; end if;
  v_items := public.proc_normalise_order_items(p_items);
  v_n := jsonb_array_length(v_items);
  v_required := nullif(p_header->>'required_completion_date', '')::date;
  v_delivery := nullif(p_header->>'delivery_date', '')::date;
  if v_required is null or v_required < (now() at time zone 'Asia/Kolkata')::date then raise exception 'Required completion date must be today or later'; end if;
  if v_delivery is not null and v_delivery < v_required then raise exception 'Delivery date cannot be before the completion date'; end if;
  if btrim(coalesce(p_header->>'delivery_location', '')) = '' then raise exception 'Delivery location is required'; end if;
  v_priority := upper(coalesce(nullif(p_header->>'priority', ''), v_row.priority, 'NORMAL'));
  if v_priority not in ('NORMAL', 'HIGH', 'URGENT', 'EMERGENCY') then raise exception 'Priority must be Normal, High, Urgent or Emergency'; end if;
  if (v_priority = 'EMERGENCY') <> v_row.is_emergency then raise exception 'Emergency can only be chosen when the order is first created'; end if;
  if v_priority in ('URGENT', 'EMERGENCY') and v_reason is null then raise exception 'Give the reason for urgency'; end if;
  select sum((i->>'amount')::numeric) into v_total from jsonb_array_elements(v_items) i;
  v_old := to_jsonb(v_row) || jsonb_build_object('items', (select jsonb_agg(to_jsonb(it) order by it.line_no) from public.purchase_request_items it where it.purchase_request_id = p_request_id));
  update public.purchase_requests set
    material_name = left(v_items->0->>'description', 150) || case when v_n > 1 then ' + ' || (v_n - 1) || ' more' else '' end,
    purpose = left(v_items->0->>'description', 150) || case when v_n > 1 then ' + ' || (v_n - 1) || ' more' else '' end,
    quantity = v_n, unit = case when v_n = 1 then 'item' else 'items' end, required_by_date = v_required, delivery_date = v_delivery,
    delivery_location = btrim(p_header->>'delivery_location'), remarks = nullif(btrim(coalesce(p_header->>'remarks', '')), ''),
    notes = p_header->>'remarks', client_name = nullif(btrim(coalesce(p_header->>'client_name', '')), ''),
    sales_person_name = nullif(btrim(coalesce(p_header->>'sales_person_name', '')), ''), preferred_vendor_name = nullif(btrim(coalesce(p_header->>'vendor_name', '')), ''),
    order_form_type = coalesce(nullif(upper(p_header->>'form_type'), ''), order_form_type), order_total = v_total, proc_updated_at = now(),
    priority = v_priority, urgency_reason = case when v_priority <> 'NORMAL' then v_reason end,
    emergency_reason = case when is_emergency then coalesce(v_reason, emergency_reason) else emergency_reason end
   where id = p_request_id returning * into v_row;
  perform public.proc_write_order_items(v_row, v_items);
  perform public.staff_write_audit('purchase_request', p_request_id, 'UPDATE_ORDER', v_old, to_jsonb(v_row) || jsonb_build_object('items', v_items), v_row.requesting_department_id, null);
  return v_row;
exception when invalid_datetime_format or datetime_field_overflow then raise exception 'One of the dates is not valid';
end $$;

-- Records a file already uploaded to procurement-orders/orders/<request id>/... against the order.
create or replace function public.proc_add_order_attachment(p_request_id uuid, p_storage_path text, p_file_name text, p_file_type text, p_file_size bigint, p_description text)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_id uuid;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.purchase_requests where id = p_request_id;
  if v_row.id is null or not public.proc_can_view_request(p_request_id) then raise exception 'Order not found'; end if;
  if not (v_row.requester_user_id = auth.uid() or public.proc_is_procurement_member()) then raise exception 'Only the requester or Procurement can attach files'; end if;
  if v_row.proc_status in ('CLOSED', 'CANCELLED', 'REJECTED_BY_DEPT_HEAD', 'REJECTED_BY_PROCUREMENT', 'EMERGENCY_REJECTED') then raise exception 'This order is closed'; end if;
  if p_storage_path not like 'orders/' || p_request_id::text || '/%' then raise exception 'The file is not stored under this order'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'procurement-orders' and name = p_storage_path) then raise exception 'The file was not uploaded'; end if;
  insert into public.purchase_attachments (project_id, purchase_request_id, module, file_category, file_name, original_file_name, storage_path, file_type, file_size, description)
  values (v_row.project_id, p_request_id, 'order', 'Drawing / Reference', btrim(p_file_name), btrim(p_file_name), p_storage_path, p_file_type, p_file_size, p_description)
  returning id into v_id;
  perform public.staff_write_audit('purchase_request', p_request_id, 'ATTACH_FILE', null, jsonb_build_object('file', p_file_name), v_row.requesting_department_id, null);
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Procurement: accept / reject / return for correction / clarify / hold / resume
-- ---------------------------------------------------------------------------

create or replace function public.proc_procurement_decision(p_request_id uuid, p_decision text, p_remarks text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_remarks text := nullif(btrim(coalesce(p_remarks, '')), ''); v_to text;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_authorized(), false) then raise exception 'Only an authorised Procurement user can do this'; end if;
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found'; end if;
  if p_decision in ('REJECT', 'CLARIFY', 'HOLD', 'RETURN') and v_remarks is null then raise exception 'A reason is required'; end if;

  if p_decision = 'RESUME' then
    if v_row.proc_status <> 'ON_HOLD' then raise exception 'Only a request on hold can be resumed'; end if;
    v_to := 'SENT_TO_PROCUREMENT';
  else
    if v_row.proc_status <> 'SENT_TO_PROCUREMENT' then raise exception 'This request is not waiting for Procurement'; end if;
    v_to := case p_decision when 'ACCEPT' then 'ACCEPTED_BY_PROCUREMENT' when 'REJECT' then 'REJECTED_BY_PROCUREMENT'
                            when 'CLARIFY' then 'CLARIFICATION_REQUIRED' when 'HOLD' then 'ON_HOLD'
                            when 'RETURN' then 'RETURNED_FOR_CORRECTION' end;
    if v_to is null then raise exception 'Decision must be ACCEPT, REJECT, RETURN, CLARIFY, HOLD or RESUME'; end if;
  end if;

  update public.purchase_requests set proc_decided_by = auth.uid(), proc_decided_at = now(), proc_decision_remarks = v_remarks where id = p_request_id;
  perform public.proc_set_status(p_request_id, v_row.proc_status, v_to, v_remarks);
  perform public.proc_notify_users(array[v_row.requester_user_id] || case when v_to in ('ACCEPTED_BY_PROCUREMENT', 'REJECTED_BY_PROCUREMENT', 'RETURNED_FOR_CORRECTION')
                                                                          then public.proc_department_heads(v_row.requesting_department_id) else '{}'::uuid[] end,
    p_request_id,
    case v_to when 'ACCEPTED_BY_PROCUREMENT' then 'Procurement accepted order ' || v_row.request_number || ': ' || v_row.material_name
              when 'REJECTED_BY_PROCUREMENT' then 'Procurement rejected order ' || v_row.request_number || ': ' || v_remarks
              when 'RETURNED_FOR_CORRECTION' then 'Procurement returned order ' || v_row.request_number || ' for correction: ' || v_remarks
              when 'CLARIFICATION_REQUIRED' then 'Procurement needs clarification on ' || v_row.request_number || ': ' || v_remarks
              when 'ON_HOLD' then 'Order ' || v_row.request_number || ' is on hold: ' || v_remarks
              else 'Order ' || v_row.request_number || ' is back with Procurement' end,
    'ઓર્ડર ' || v_row.request_number || ' અપડેટ');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Delivered, completed, amendments
-- ---------------------------------------------------------------------------

-- For orders delivered straight to the client or site (no Godown receipt): Procurement records the delivery.
create or replace function public.proc_mark_delivered(p_request_id uuid, p_delivered_on date, p_remarks text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_member(), false) then raise exception 'Only Procurement can record delivery'; end if;
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Order not found'; end if;
  if v_row.proc_status not in ('ORDER_PLACED', 'VENDOR_CONFIRMED', 'IN_PRODUCTION', 'READY_FOR_DISPATCH', 'IN_TRANSIT', 'DELAYED', 'PARTIALLY_RECEIVED') then
    raise exception 'Delivery can be recorded only for a placed order';
  end if;
  if p_delivered_on is null or p_delivered_on > (now() at time zone 'Asia/Kolkata')::date then raise exception 'Give the delivery date (today or earlier)'; end if;
  update public.purchase_requests set delivered_to_client_at = p_delivered_on where id = p_request_id;
  perform public.proc_set_status(p_request_id, v_row.proc_status, 'RECEIVED', coalesce(nullif(btrim(coalesce(p_remarks, '')), ''), 'Delivered on ' || to_char(p_delivered_on, 'DD Mon YYYY')));
  perform public.proc_notify_users(public.proc_followers(v_row), p_request_id, 'Delivered: order ' || v_row.request_number || ' ' || v_row.material_name,
    'ડિલિવર થયું: ' || v_row.request_number);
end $$;

-- Completed: a delivered order (with or without the GRN / invoice / payment steps) is closed by Procurement.
create or replace function public.proc_complete_order(p_request_id uuid, p_remarks text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_authorized(), false) then raise exception 'Only an authorised Procurement user can complete an order'; end if;
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Order not found'; end if;
  if v_row.proc_status not in ('RECEIVED', 'GRN_VERIFIED', 'PAID') then raise exception 'Only a delivered order can be completed'; end if;
  if v_row.is_emergency and v_row.emergency_reviewed_at is null then raise exception 'An emergency order needs Management''s post-purchase review first'; end if;
  perform public.proc_set_status(p_request_id, v_row.proc_status, 'CLOSED', p_remarks);
  perform public.proc_notify_users(array[v_row.requester_user_id], p_request_id, 'Order completed: ' || v_row.request_number, 'ઓર્ડર પૂર્ણ: ' || v_row.request_number);
end $$;

-- After the order is placed nothing is overwritten silently: allowed changes go through here with a reason, and the old and
-- new values are kept in the audit log and the order's history.
create or replace function public.proc_amend_order(p_request_id uuid, p_changes jsonb, p_reason text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_po public.purchase_orders; v_new public.purchase_orders; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key text; v_phone text;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_authorized(), false) then raise exception 'Only an authorised Procurement user can amend an order'; end if;
  if v_reason is null then raise exception 'A reason for the amendment is required'; end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key not in ('expected_delivery_date', 'vendor_contact', 'payment_terms', 'remarks') then raise exception 'Field % cannot be amended', v_key; end if;
  end loop;
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null or v_row.proc_status in ('CLOSED', 'CANCELLED') then raise exception 'Only an open placed order can be amended'; end if;
  select * into v_po from public.purchase_orders where purchase_request_id = p_request_id and is_current for update;
  if v_po.id is null then raise exception 'No order has been placed yet'; end if;
  if p_changes ? 'vendor_contact' then
    v_phone := regexp_replace(coalesce(p_changes->>'vendor_contact', ''), '[^0-9+]', '', 'g');
    if length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 10 and 13 then raise exception 'Vendor contact must be a valid phone number'; end if;
  end if;
  if p_changes ? 'expected_delivery_date' and (p_changes->>'expected_delivery_date')::date < v_po.order_date then raise exception 'Expected delivery cannot be before the order date'; end if;
  update public.purchase_orders set
    expected_delivery_date = coalesce((p_changes->>'expected_delivery_date')::date, expected_delivery_date),
    vendor_contact = coalesce(v_phone, vendor_contact),
    payment_terms = coalesce(nullif(btrim(coalesce(p_changes->>'payment_terms', '')), ''), payment_terms),
    remarks = coalesce(nullif(btrim(coalesce(p_changes->>'remarks', '')), ''), remarks)
   where id = v_po.id returning * into v_new;
  insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
  values (p_request_id, v_row.proc_status, v_row.proc_status, auth.uid(), public.staff_current_role_code(), 'Amended: ' || v_reason);
  perform public.staff_write_audit('purchase_order', v_po.id, 'AMEND', to_jsonb(v_po), to_jsonb(v_new), v_row.requesting_department_id, v_reason);
  if v_new.expected_delivery_date is distinct from v_po.expected_delivery_date then
    perform public.proc_notify_users(public.proc_followers(v_row), p_request_id,
      'Expected delivery changed for order ' || v_row.request_number || ': ' || coalesce(to_char(v_po.expected_delivery_date, 'DD-MM-YYYY'), 'not set')
        || ' -> ' || to_char(v_new.expected_delivery_date, 'DD-MM-YYYY') || ' (due date ' || to_char(v_row.required_by_date, 'DD-MM-YYYY') || '). Reason: ' || v_reason,
      'ઓર્ડર ' || v_row.request_number || ' ની અપેક્ષિત ડિલિવરી બદલાઈ: ' || to_char(v_new.expected_delivery_date, 'DD-MM-YYYY'));
  else
    perform public.proc_notify_users(public.proc_followers(v_row), p_request_id, 'Order ' || v_row.request_number || ' amended: ' || v_reason,
      'ઓર્ડર ' || v_row.request_number || ' માં ફેરફાર');
  end if;
exception when invalid_datetime_format or datetime_field_overflow then raise exception 'The date is not valid';
end $$;

-- ---------------------------------------------------------------------------
-- 5. Context for screens and printed forms: add the Department Head and item count
-- ---------------------------------------------------------------------------

drop function if exists public.proc_request_context(uuid[]);
create function public.proc_request_context(p_request_ids uuid[])
returns table (request_id uuid, department_code text, department_name text, requester_name text, requester_phone text,
  dept_approver_name text, procurement_decider_name text, order_confirmed_by_name text, project_code text, customer text, project_location text,
  department_head_name text, item_count integer)
language sql stable security definer set search_path to 'public' as $$
  select r.id, d.code, d.name_en, rq.full_name, rq.phone, da.full_name, pd.full_name, oc.full_name, p.project_code, p.customer, p.location,
         public.staff_department_head_public(r.requesting_department_id),
         (select count(*)::int from public.purchase_request_items i where i.purchase_request_id = r.id)
    from public.purchase_requests r
    left join public.departments d on d.id = r.requesting_department_id
    left join public.user_profiles rq on rq.id = r.requester_user_id
    left join public.user_profiles da on da.id = r.dept_decided_by
    left join public.user_profiles pd on pd.id = r.proc_decided_by
    left join public.user_profiles oc on oc.id = r.order_confirmed_by
    left join public.projects p on p.id = r.project_id
   where r.id = any(p_request_ids) and public.proc_can_view_request(r.id);
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.proc_write_order_items(public.purchase_requests, jsonb) from public, anon, authenticated;
revoke all on function public.proc_normalise_order_items(jsonb), public.proc_create_order(jsonb, jsonb, boolean), public.proc_update_order(uuid, jsonb, jsonb),
  public.proc_add_order_attachment(uuid, text, text, text, bigint, text), public.proc_procurement_decision(uuid, text, text),
  public.proc_mark_delivered(uuid, date, text), public.proc_complete_order(uuid, text), public.proc_amend_order(uuid, jsonb, text),
  public.proc_request_context(uuid[]) from public, anon;
grant execute on function public.proc_normalise_order_items(jsonb), public.proc_create_order(jsonb, jsonb, boolean), public.proc_update_order(uuid, jsonb, jsonb),
  public.proc_add_order_attachment(uuid, text, text, text, bigint, text), public.proc_procurement_decision(uuid, text, text),
  public.proc_mark_delivered(uuid, date, text), public.proc_complete_order(uuid, text), public.proc_amend_order(uuid, jsonb, text),
  public.proc_request_context(uuid[]) to authenticated;

commit;
