-- Godown stock intake, simplified for low-literacy workers (v2_93o): take one photo -> AI suggests a category/name
-- -> worker taps Confirm (no typing required in the common case) -> a real product code is generated and the item
-- is in stock. retail_products/retail_stock are genuinely greenfield (confirmed live: 0 rows, no writer RPC existed
-- before this migration) -- this is the first-ever intake path for them.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. Schema -- additive only.
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.staff_attachments drop constraint if exists staff_attachments_entity_type_check;
alter table public.staff_attachments add constraint staff_attachments_entity_type_check
  check (entity_type in ('task','bridge','retail_packing','retail_godown_handover','retail_dispatch','retail_delivery',
                          'retail_installation','retail_order_item','retail_product'));

alter table public.retail_products
  add column if not exists suggested_category text,
  add column if not exists suggested_name text,
  add column if not exists suggested_unit text,
  add column if not exists suggested_confidence numeric,
  add column if not exists classified_at timestamptz,
  add column if not exists confirmed_at timestamptz;

-- Real SKUs (post-confirmation) must be unique; placeholder pre-confirmation SKUs (`PENDING-...`) are inherently
-- unique already (derived from a fresh uuid each time), so a partial index on active rows is sufficient and never
-- blocks the placeholder-creation step.
create unique index if not exists retail_products_sku_active_uq on public.retail_products (sku) where is_active;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. staff_record_attachment -- one more branch, scoped to the merged Godown department (mirrors the existing
--    retail_order_item branch's shape exactly, just Godown instead of Retail).
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

  elsif p_entity_type = 'retail_product' then
    select exists(select 1 from public.retail_products where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent product does not exist'; end if;
    select exists(
      select 1 from public.retail_products p where p.id = p_entity_id and (
        p.created_by = auth.uid() or public.staff_is_godown_staff() or public.staff_has_global_oversight()
        or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(public.retail_godown_dept_id()))
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
-- 3. retail_start_stock_intake -- one placeholder product + stock row so a real, stable id exists before the photo.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_start_stock_intake(p_location_id uuid)
returns retail_products
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_allowed boolean; v_product public.retail_products; v_placeholder_sku text;
begin
  perform public.staff_assert_operational();
  v_allowed := (coalesce(public.staff_is_godown_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_godown_dept_id()), false)));
  if not v_allowed then raise exception 'Not authorized to add stock'; end if;
  if not exists (select 1 from public.locations where id = p_location_id and is_active) then
    raise exception 'Invalid location';
  end if;

  v_placeholder_sku := 'PENDING-' || substr(gen_random_uuid()::text, 1, 8);
  insert into public.retail_products (sku, name, unit, created_by)
  values (v_placeholder_sku, 'New item (pending photo)', 'Nos', auth.uid())
  returning * into v_product;

  insert into public.retail_stock (product_id, location_id, on_hand_qty, updated_by)
  values (v_product.id, p_location_id, 0, auth.uid());

  perform public.staff_write_audit('retail_product', v_product.id, 'INTAKE_START', null, jsonb_build_object('location_id', p_location_id), public.retail_godown_dept_id());
  return v_product;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. retail_generate_stock_code -- category prefix + next sequence in that category, defensive against races the
--    same way staff_generate_employee_code already guards its own candidate loop.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_generate_stock_code(p_category text)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_prefix text; v_next int; v_candidate text;
begin
  v_prefix := upper(left(regexp_replace(coalesce(nullif(btrim(p_category), ''), 'ITEM'), '[^A-Za-z]', '', 'g'), 4));
  if v_prefix = '' then v_prefix := 'ITEM'; end if;

  select coalesce(max((regexp_match(sku, '^' || v_prefix || '-([0-9]+)$'))[1]::int), 0) + 1
  into v_next
  from public.retail_products
  where sku ~ ('^' || v_prefix || '-[0-9]+$');

  v_candidate := v_prefix || '-' || lpad(v_next::text, 3, '0');
  while exists (select 1 from public.retail_products where sku = v_candidate) loop
    v_next := v_next + 1;
    v_candidate := v_prefix || '-' || lpad(v_next::text, 3, '0');
  end loop;

  return v_candidate;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. retail_confirm_stock_intake -- requires the photo, generates the real SKU, commits the product live.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_confirm_stock_intake(
  p_product_id uuid, p_category text, p_name text, p_unit text default 'Nos', p_quantity numeric default 1)
returns retail_products
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_product public.retail_products; v_allowed boolean; v_has_photo boolean; v_photo_id uuid; v_sku text;
begin
  perform public.staff_assert_operational();
  select * into v_product from public.retail_products where id = p_product_id for update;
  if v_product.id is null then raise exception 'Product not found'; end if;

  v_allowed := (coalesce(v_product.created_by = auth.uid(), false) or coalesce(public.staff_is_godown_staff(), false)
    or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_godown_dept_id()), false)));
  if not v_allowed then raise exception 'Not authorized to confirm this stock item'; end if;

  if coalesce(btrim(p_category), '') = '' or coalesce(btrim(p_name), '') = '' then
    raise exception 'A category and name are required to confirm this item';
  end if;

  select id into v_photo_id from public.staff_attachments where entity_type = 'retail_product' and entity_id = p_product_id and purpose = 'proof' and is_active order by created_at desc limit 1;
  v_has_photo := v_photo_id is not null;
  if not v_has_photo then raise exception 'A photo of the item is required before it can be confirmed'; end if;

  v_sku := public.retail_generate_stock_code(p_category);

  update public.retail_products set
    sku = v_sku, name = btrim(p_name), category = btrim(p_category), unit = coalesce(nullif(btrim(p_unit), ''), 'Nos'),
    image_path = v_photo_id::text, confirmed_at = now()
  where id = p_product_id returning * into v_product;

  update public.retail_stock set on_hand_qty = greatest(coalesce(p_quantity, 1), 0), updated_by = auth.uid(), updated_at = now()
  where product_id = p_product_id;

  perform public.staff_write_audit('retail_product', p_product_id, 'INTAKE_CONFIRM', null,
    jsonb_build_object('sku', v_sku, 'category', p_category, 'quantity', p_quantity), public.retail_godown_dept_id());
  return v_product;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 6. retail_store_stock_classification -- service_role-only (the AI Edge Function), never callable by a browser
--    session. Writes only the SUGGESTED fields -- retail_confirm_stock_intake (a human tap) is what actually
--    commits the SKU/name/category live. Mirrors factory_ai_store_extraction's own "AI can only ever suggest,
--    never commit" separation.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_store_stock_classification(
  p_product_id uuid, p_category text, p_product_name text, p_unit text, p_confidence numeric)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.retail_products set
    suggested_category = p_category, suggested_name = p_product_name, suggested_unit = p_unit,
    suggested_confidence = p_confidence, classified_at = now()
  where id = p_product_id;
end $function$;

revoke all on function public.retail_store_stock_classification(uuid, text, text, text, numeric) from public, authenticated;
grant execute on function public.retail_store_stock_classification(uuid, text, text, text, numeric) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 7. retail_stock_intake_queue -- a worker's own recent intakes (confirmed + still-pending-confirmation), for the
--    "what did I just add" list on the new simplified Godown home screen.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_stock_intake_queue()
returns table (product_id uuid, sku text, name text, category text, suggested_category text, suggested_name text,
  suggested_unit text, suggested_confidence numeric, on_hand_qty numeric, confirmed_at timestamptz, created_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $$
  select p.id, p.sku, p.name, p.category, p.suggested_category, p.suggested_name, p.suggested_unit, p.suggested_confidence,
    coalesce(s.on_hand_qty, 0), p.confirmed_at, p.created_at
  from public.retail_products p
  left join public.retail_stock s on s.product_id = p.id
  where p.is_active and (
    p.created_by = auth.uid() or public.staff_is_godown_staff() or public.staff_has_global_oversight()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(public.retail_godown_dept_id()))
  )
  order by p.created_at desc limit 50;
$$;

grant execute on function public.retail_start_stock_intake(uuid) to authenticated;
grant execute on function public.retail_generate_stock_code(text) to authenticated;
grant execute on function public.retail_confirm_stock_intake(uuid, text, text, text, numeric) to authenticated;
grant execute on function public.retail_stock_intake_queue() to authenticated;
