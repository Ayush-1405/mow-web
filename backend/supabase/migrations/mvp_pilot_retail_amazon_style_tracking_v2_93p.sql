-- Amazon-style order tracking (v2_93p): unify the automatic Godown handoff across every fulfilment mode (not just
-- Immediate Delivery), connect Factory job completion back into it, and add the "Godown Head assigns a specific
-- team member" step that was missing. The packing/dispatch/delivery pipeline itself (photo-gated at every stage)
-- already exists and is unchanged by this migration -- this closes the remaining gaps found in a live audit:
-- STOCK items sat at 'RESERVED' forever with nothing to ever move them to 'READY' (confirmed live: every test this
-- session had to fake it with a raw UPDATE, with its own comment admitting no real RPC exists for this); Factory
-- job completion never fed back into retail_fulfilment_items at all; and responsible_user_id was fixed at request
-- creation with no reassignment path.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. retail_confirm_order -- STOCK items are Ready immediately (the stock already physically exists; there is no
--    further real-world wait, unlike FACTORY/OUTSOURCE). FACTORY/OUTSOURCE branches unchanged.
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
      values (p_order_id, v_item.id, 'STOCK', v_qty, 'READY', coalesce((v_ov->>'stock_location_id')::uuid, v_order.location_id), auth.uid())
      on conflict (order_item_id) do nothing;

    elsif v_mode = 'IMMEDIATE_DELIVERY' then
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
  perform public.retail_maybe_auto_request_godown(p_order_id);

  return query select * from public.retail_fulfilment_items where order_id = p_order_id;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. retail_stock_availability -- STOCK items now go straight to 'READY' instead of pausing at 'RESERVED', so the
--    reserved-quantity calculation (which only ever looked at PENDING/RESERVED) must count READY too, or stock
--    already committed to a confirmed order would wrongly show as available again the moment it reaches Ready.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_stock_availability(p_query text default null::text, p_location_id uuid default null::uuid)
returns table(product_id uuid, sku text, name text, category text, image_path text, unit text, location_id uuid, location_name text, on_hand_qty numeric, damaged_qty numeric, incoming_qty numeric, reserved_qty numeric, available_qty numeric, expected_availability_date date, rack_location text)
language sql
stable security definer
set search_path to 'public'
as $function$
  select p.id, p.sku, p.name, p.category, p.image_path, p.unit,
    s.location_id, l.name_en, s.on_hand_qty, s.damaged_qty, s.incoming_qty,
    coalesce(r.reserved, 0) as reserved_qty,
    greatest(s.on_hand_qty - coalesce(r.reserved, 0) - s.damaged_qty, 0) as available_qty,
    s.expected_availability_date, s.rack_location
  from public.retail_products p
  join public.retail_stock s on s.product_id = p.id
  join public.locations l on l.id = s.location_id
  left join lateral (
    select sum(fi.quantity) reserved from public.retail_fulfilment_items fi
      join public.retail_order_items oi on oi.id = fi.order_item_id
     where fi.mode = 'STOCK' and fi.status not in ('CANCELLED') and upper(oi.sku) = upper(p.sku)
  ) r on true
  where p.is_active and (
    staff_current_department_id() in (select id from departments where code = 'RETAIL') or staff_current_department_id() = public.retail_godown_dept_id()
    or staff_has_global_oversight()
    or (staff_is_dept_head() and (staff_dept_in_hod_scope(retail_dept_id()) or staff_dept_in_hod_scope(public.retail_godown_dept_id()))))
    and (p_query is null or btrim(p_query) = '' or p.name ilike '%' || p_query || '%' or p.sku ilike '%' || p_query || '%' or p.category ilike '%' || p_query || '%')
    and (p_location_id is null or s.location_id = p_location_id)
  order by p.name, l.name_en;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. retail_maybe_auto_request_godown -- generalized to fire for ANY confirmed order once every one of its
--    fulfilment items is Ready (STOCK: immediately; FACTORY: once its job card completes, see the new trigger
--    below; IMMEDIATE_DELIVERY: unchanged, still additionally requires its own Sales Confirmation Photo;
--    OUTSOURCE: correctly never reaches Ready yet -- Procurement has no completion RPC, disclosed limitation).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_maybe_auto_request_godown(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_order public.retail_orders;
  v_godown_dept uuid := public.retail_godown_dept_id();
  v_head uuid;
  v_not_ready int;
  v_photo_missing int;
begin
  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order.id is null or v_order.status <> 'CONFIRMED' or v_order.on_hold then return; end if;

  if not exists (select 1 from public.retail_fulfilment_items where order_id = p_order_id) then return; end if;

  select count(*) into v_not_ready from public.retail_fulfilment_items where order_id = p_order_id and status <> 'READY';
  if v_not_ready > 0 then return; end if;

  select count(*) into v_photo_missing
    from public.retail_order_items oi join public.retail_fulfilment_items fi on fi.order_item_id = oi.id
    where oi.order_id = p_order_id and fi.mode = 'IMMEDIATE_DELIVERY' and oi.sales_photo_captured_at is null;
  if v_photo_missing > 0 then return; end if;

  if v_order.total_amount > 0 and v_order.payment_status = 'PENDING' then return; end if;

  if exists (select 1 from public.retail_godown_handovers where order_id = p_order_id and status in ('PENDING','ACCEPTED')) then
    return;
  end if;

  select up.id into v_head from public.user_profiles up
    join public.roles ro on ro.id = up.role_id
    where up.is_active = true and up.department_id = v_godown_dept and ro.code = 'dept_head'
    order by up.created_at limit 1;
  if v_head is null then
    return;
  end if;

  perform public.retail_send_to_godown(p_order_id, null, v_head, null,
    'Automatic Godown fulfilment request — created once every item on this order was Ready.', true);
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. Factory job completion -> retail_fulfilment_items.status = 'READY'. The one new cross-department connection
--    this pass adds: without it, a Factory-fulfilled retail order had no path to ever reach Godown automatically.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_trg_factory_job_ready()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_fi public.retail_fulfilment_items;
begin
  if new.factory_status = 'completed' and (old.factory_status is distinct from 'completed') and new.source_module = 'retail' then
    select * into v_fi from public.retail_fulfilment_items where job_card_id = new.id;
    if v_fi.id is not null and v_fi.status <> 'READY' then
      update public.retail_fulfilment_items set status = 'READY', updated_at = now() where id = v_fi.id;
      perform public.retail_maybe_auto_request_godown(v_fi.order_id);
    end if;
  end if;
  return new;
end $function$;

drop trigger if exists retail_factory_job_ready_trg on public.inhouse_production_requests;
create trigger retail_factory_job_ready_trg
after update of factory_status on public.inhouse_production_requests
for each row execute function public.retail_trg_factory_job_ready();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. retail_assign_godown_handover -- the "Godown Head assigns a team member" action. Only valid while the
--    handover is still PENDING; once accepted, work has started.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_assign_godown_handover(p_handover_id uuid, p_user_id uuid)
returns retail_godown_handovers
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_row public.retail_godown_handovers; v_allowed boolean; v_target_dept uuid; v_godown_dept uuid := public.retail_godown_dept_id();
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_godown_handovers where id = p_handover_id for update;
  if v_row.id is null then raise exception 'Handover not found'; end if;
  if v_row.status <> 'PENDING' then raise exception 'Only a pending handover can be reassigned'; end if;

  v_allowed := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_godown_dept), false))
    or (coalesce(public.staff_is_supervisor(), false) and public.staff_current_department_id() = v_godown_dept));
  if not v_allowed then raise exception 'Only the Godown Head/Supervisor may assign this request'; end if;

  select department_id into v_target_dept from public.user_profiles where id = p_user_id and is_active = true;
  if v_target_dept is distinct from v_godown_dept then raise exception 'Assignee must be an active Godown team member'; end if;

  update public.retail_godown_handovers set responsible_user_id = p_user_id where id = p_handover_id returning * into v_row;

  perform public.staff_write_audit('retail_godown_handover', p_handover_id, 'ASSIGN', null, jsonb_build_object('responsible_user_id', p_user_id), v_godown_dept);
  perform public.staff_notify_assignment(p_user_id, 'retail_godown_handover', p_handover_id,
    'Assigned to you: Godown handover', 'તમને સોંપાયેલ: ગોડાઉન હેન્ડઓવર');
  return v_row;
end $function$;

grant execute on function public.retail_assign_godown_handover(uuid, uuid) to authenticated;
