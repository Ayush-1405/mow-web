-- Bug fix: "Convert to Order" on a Retail quotation failed with "Invalid or inactive assignee" for ANY
-- Management user whose own profile has no home department (profile.department_id IS NULL -- a real, supported
-- shape elsewhere in this app, e.g. AssignTask.jsx's own from_department_id handling). Confirmed live:
-- retail_convert_quotation_to_order() creates a "Verify order" follow-up task via staff_create_task(), passing
-- auth.uid() (whoever clicked Convert) as its assignee unconditionally -- but staff_create_task() requires the
-- assignee to actually belong to the task's destination department (the order's own Retail department), and a
-- department-less Management user can never satisfy that. The same failure would hit a Head/Supervisor from a
-- DIFFERENT department converting a quotation on another department's behalf, not just a department-less user.
--
-- Fix: pick a real, valid assignee for that department instead of blindly using the caller -- in priority order,
-- the caller themselves (if they do belong to the order's department, preserving today's behavior for actual
-- Retail staff), else the quotation's own creator (if they belong to it and are active), else any active member
-- of that department (department head preferred). This can never leave the verification task without a valid
-- assignee, and never silently invents a person -- if a department genuinely has no active staff at all, it
-- raises a clear, honest error instead of the misleading "Invalid or inactive assignee".
create or replace function public.retail_convert_quotation_to_order(p_quotation_id uuid)
 returns retail_orders
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_quotation public.retail_quotations; v_customer public.retail_customers; v_allowed boolean; v_order public.retail_orders;
  v_order_number text; v_task record; v_key text; v_qi record; v_item public.retail_inventory_items;
  v_billing text; v_delivery text; v_assignee uuid;
begin
  perform public.staff_assert_operational();

  select * into v_quotation from public.retail_quotations where id = p_quotation_id;
  if v_quotation is null then raise exception 'Quotation not found'; end if;
  if v_quotation.status <> 'ACCEPTED' then raise exception 'Only an ACCEPTED quotation can be converted to an order'; end if;

  select * into v_order from public.retail_orders where quotation_id = p_quotation_id;
  if v_order.id is not null then return v_order; end if;

  v_allowed := (v_quotation.created_by = auth.uid() or public.staff_has_global_oversight()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_quotation.department_id)));
  if not v_allowed then raise exception 'Not authorized to convert this quotation'; end if;

  for v_qi in select * from public.retail_quotation_items where quotation_id = p_quotation_id and inventory_item_id is not null loop
    select * into v_item from public.retail_inventory_items where id = v_qi.inventory_item_id for update;
    if v_item.status <> 'AVAILABLE' then
      raise exception 'Item % is no longer available (status: %) — cannot convert this quotation', v_item.serial_number, v_item.status;
    end if;
  end loop;

  if v_quotation.customer_id is not null then select * into v_customer from public.retail_customers where id = v_quotation.customer_id; end if;

  v_billing := coalesce(nullif(btrim(v_quotation.billing_address), ''), v_customer.area);
  v_delivery := coalesce(nullif(btrim(v_quotation.delivery_address), ''), v_customer.area);

  v_order_number := 'ORD-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  insert into public.retail_orders (
    department_id, quotation_id, customer_id, order_number, customer_name, phone, total_amount, required_delivery_date,
    delivery_address, billing_address, created_by
  ) values (
    v_quotation.department_id, v_quotation.id, v_quotation.customer_id, v_order_number, v_quotation.customer_name, v_quotation.phone,
    v_quotation.total_amount, v_quotation.expected_delivery, v_delivery, v_billing, auth.uid()
  ) returning * into v_order;

  insert into public.retail_order_items (order_id, item_name, sku, dimensions, finish_color_fabric, customization_notes, product_image_path, quantity, unit_price, discount, tax, line_total, product_id, inventory_item_id)
  select v_order.id, item_name, sku, dimensions, null, customization_notes, product_image_path, quantity, unit_price, discount, tax, line_total, product_id, inventory_item_id
  from public.retail_quotation_items where quotation_id = v_quotation.id;

  update public.retail_inventory_items set status = 'RESERVED', reserved_quotation_id = p_quotation_id, reserved_order_id = v_order.id, updated_at = now()
  where id in (select inventory_item_id from public.retail_quotation_items where quotation_id = p_quotation_id and inventory_item_id is not null);

  for v_qi in select inventory_item_id from public.retail_quotation_items where quotation_id = p_quotation_id and inventory_item_id is not null loop
    perform public.retail_log_status_change('retail_inventory_item', v_qi.inventory_item_id, 'AVAILABLE', 'RESERVED', v_quotation.department_id,
      'Reserved for order ' || v_order_number);
  end loop;

  update public.retail_leads set converted_order_id = v_order.id, status = 'CONVERTED' where id = v_quotation.lead_id;

  -- Pick a real, valid assignee for the order's own department -- see the fix note above.
  if exists (select 1 from public.user_profiles where id = auth.uid() and is_active and department_id = v_order.department_id) then
    v_assignee := auth.uid();
  elsif exists (select 1 from public.user_profiles where id = v_quotation.created_by and is_active and department_id = v_order.department_id) then
    v_assignee := v_quotation.created_by;
  else
    select up.id into v_assignee from public.user_profiles up join public.roles r on r.id = up.role_id
      where up.department_id = v_order.department_id and up.is_active
      order by (r.code = 'dept_head') desc, up.full_name
      limit 1;
  end if;
  if v_assignee is null then raise exception 'No active staff member found in this department to verify the new order'; end if;

  v_key := 'retail_order_verify:' || v_order.id::text;
  select t.task_id, t.task_number into v_task from public.staff_create_task(
    'Verify order ' || v_order_number, 'Check items, pricing and stock/production plan before confirming.', 'GENERAL_TASK', 'HIGH', 'none',
    v_order.department_id, v_order.department_id, v_assignee, coalesce(v_order.required_delivery_date, current_date + 3), null,
    null, v_order_number, null, null, null, null) t;
  update public.staff_tasks set system_key = v_key where id = v_task.task_id;
  update public.retail_orders set linked_task_id = v_task.task_id where id = v_order.id;

  perform public.staff_write_audit('retail_order', v_order.id, 'CREATE_FROM_QUOTATION', null,
    jsonb_build_object('order_number', v_order_number, 'quotation_id', p_quotation_id), v_quotation.department_id);
  return v_order;
end $function$;
