-- v2_93b -- Retail Stores module, Phase 1 part b: automation RPCs.
--   retail_upsert_customer      -- dedupe by normalized mobile number
--   retail_create_walkin        -- walk-in -> customer + lead + first follow-up task (Today's Tasks) + notification
--   retail_record_followup      -- follow-up entry -> CRM timeline + next reminder task, closes stale reminders on Won/Lost
--   retail_create_quotation     -- quotation + items, revision-linked (never overwrites an older version)
--   retail_convert_quotation_to_order (CREATE OR REPLACE of the existing function) -- prefills the order from the quotation
--   retail_confirm_order        -- THE atomic step: per line item, reserve stock / create a real Factory Job Card / create a
--                                   Procurement Request. Guarded by fulfilment_locked + per-item unique indexes + Factory's own
--                                   idempotency key, so a double-click or a retry after a network error never creates duplicates.
--   retail_advance_delivery     -- delivery timeline stage, with its own coordination task
--   retail_record_daily_update  -- auto-fills the measurable counters from real tables; only free-text fields are hand-entered

create or replace function public.retail_upsert_customer(
  p_full_name text, p_phone text, p_whatsapp text default null, p_email text default null,
  p_city text default null, p_area text default null, p_customer_type text default 'RETAIL')
returns public.retail_customers language plpgsql security definer set search_path = public as $$
declare v_norm text := public.retail_normalize_phone(p_phone); v_row public.retail_customers;
begin
  perform public.staff_assert_operational();
  if coalesce(btrim(p_full_name), '') = '' then raise exception 'Customer name is required'; end if;
  if v_norm is not null then
    select * into v_row from public.retail_customers where normalized_phone = v_norm for update;
  end if;
  if v_row.id is not null then
    update public.retail_customers set
      full_name = coalesce(nullif(btrim(p_full_name), ''), full_name),
      whatsapp = coalesce(nullif(btrim(p_whatsapp), ''), whatsapp),
      email = coalesce(nullif(btrim(p_email), ''), email),
      city = coalesce(nullif(btrim(p_city), ''), city),
      area = coalesce(nullif(btrim(p_area), ''), area)
    where id = v_row.id returning * into v_row;
    return v_row;
  end if;
  insert into public.retail_customers (full_name, phone, normalized_phone, whatsapp, email, city, area, customer_type, created_by)
  values (btrim(p_full_name), nullif(btrim(p_phone), ''), v_norm, nullif(btrim(p_whatsapp), ''), nullif(btrim(p_email), ''),
          nullif(btrim(p_city), ''), nullif(btrim(p_area), ''), coalesce(p_customer_type, 'RETAIL'), auth.uid())
  returning * into v_row;
  return v_row;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_create_walkin(
  p_customer_name text, p_phone text, p_whatsapp text default null, p_email text default null, p_city text default null,
  p_location_id uuid default null, p_requirement_category text default null, p_interested_products text default null,
  p_room_category text default null, p_approx_budget numeric default null, p_purchase_timeline text default null,
  p_lead_source text default 'walkin', p_salesperson uuid default null, p_customer_type text default 'RETAIL',
  p_notes text default null, p_lead_temperature text default 'WARM', p_next_follow_up_at timestamptz default null)
returns table (lead_id uuid, walkin_number text, customer_id uuid, task_id uuid, task_number text)
language plpgsql security definer set search_path = public as $$
declare
  v_dept uuid := public.retail_dept_id(); v_customer public.retail_customers; v_salesperson uuid; v_salesperson_dept uuid;
  v_lead_id uuid; v_walkin text; v_task record; v_due_date date; v_due_time time; v_key text;
begin
  perform public.staff_assert_operational();
  if coalesce(btrim(p_customer_name), '') = '' then raise exception 'Customer name is required'; end if;
  if p_lead_temperature not in ('HOT', 'WARM', 'COLD') then raise exception 'Invalid lead temperature'; end if;

  v_salesperson := coalesce(p_salesperson, auth.uid());
  select department_id into v_salesperson_dept from public.user_profiles where id = v_salesperson and is_active = true;
  if v_salesperson_dept is distinct from v_dept then raise exception 'Salesperson must be an active Retail team member'; end if;

  v_customer := public.retail_upsert_customer(p_customer_name, p_phone, p_whatsapp, p_email, p_city, null, p_customer_type);
  v_walkin := 'WI-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  insert into public.retail_leads (
    department_id, location_id, customer_id, walkin_number, customer_name, phone, whatsapp, email, city, source,
    requirement_category, interested_products, room_category, approx_budget, purchase_timeline, customer_type,
    lead_temperature, interest_notes, assigned_to, status, next_follow_up_date, next_follow_up_time, created_by
  ) values (
    v_dept, p_location_id, v_customer.id, v_walkin, btrim(p_customer_name), nullif(btrim(p_phone), ''), nullif(btrim(p_whatsapp), ''),
    nullif(btrim(p_email), ''), nullif(btrim(p_city), ''), coalesce(p_lead_source, 'walkin'),
    p_requirement_category, nullif(btrim(p_interested_products), ''), nullif(btrim(p_room_category), ''), p_approx_budget,
    nullif(btrim(p_purchase_timeline), ''), p_customer_type, p_lead_temperature, nullif(btrim(p_notes), ''), v_salesperson, 'NEW',
    (coalesce(p_next_follow_up_at, now() + interval '1 day'))::date, (coalesce(p_next_follow_up_at, now() + interval '1 day'))::time,
    auth.uid()
  ) returning id into v_lead_id;

  v_due_date := (coalesce(p_next_follow_up_at, now() + interval '1 day'))::date;
  v_due_time := (coalesce(p_next_follow_up_at, now() + interval '1 day'))::time;
  v_key := 'retail_followup:lead:' || v_lead_id::text;
  select id, task_number into v_task from public.staff_tasks where system_key = v_key;
  if v_task.id is null then
    select t.task_id, t.task_number into v_task from public.staff_create_task(
      'Follow up: ' || btrim(p_customer_name), coalesce(p_notes, 'New walk-in — first follow-up'), 'FOLLOW_UP', 'NORMAL', 'none',
      v_dept, v_dept, v_salesperson, v_due_date, v_due_time, null, v_walkin, p_interested_products, null, null, null) t;
    update public.staff_tasks set system_key = v_key where id = v_task.task_id;
  end if;

  update public.retail_leads set linked_task_id = v_task.task_id where id = v_lead_id;
  perform public.staff_write_audit('retail_lead', v_lead_id, 'CREATE_WALKIN',
    null, jsonb_build_object('walkin_number', v_walkin, 'customer_id', v_customer.id, 'assigned_to', v_salesperson), v_dept);
  if v_salesperson <> auth.uid() then
    perform public.staff_notify_assignment(v_salesperson, 'retail_lead', v_lead_id,
      'New walk-in assigned: ' || btrim(p_customer_name), 'નવો વોક-ઇન સોંપાયો: ' || btrim(p_customer_name));
  end if;

  return query select v_lead_id, v_walkin, v_customer.id, v_task.task_id, v_task.task_number;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_record_followup(
  p_lead_id uuid, p_contact_mode text, p_outcome text default null, p_customer_response text default null,
  p_products_discussed text default null, p_expected_decision_date date default null, p_revised_budget numeric default null,
  p_notes text default null, p_next_action text default null, p_next_follow_up_at timestamptz default null,
  p_status text default 'CONTACTED', p_lost_reason text default null)
returns table (followup_id uuid, task_id uuid, task_number text)
language plpgsql security definer set search_path = public as $$
declare
  v_lead public.retail_leads; v_prev uuid; v_followup_id uuid; v_task record; v_key text; v_lead_status text;
  v_open_statuses constant text[] := array['NEW','CONTACTED','FOLLOW_UP_DUE','INTERESTED','QUOTATION_REQUESTED','QUOTATION_SENT','NEGOTIATION','DECISION_PENDING','ON_HOLD'];
begin
  perform public.staff_assert_operational();
  select * into v_lead from public.retail_leads where id = p_lead_id for update;
  if v_lead.id is null then raise exception 'Lead not found'; end if;
  if not (v_lead.assigned_to = auth.uid() or v_lead.created_by = auth.uid() or public.staff_has_global_oversight()
          or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_lead.department_id))) then
    raise exception 'Not authorized to record a follow-up on this lead';
  end if;
  if p_contact_mode not in ('CALL', 'WHATSAPP', 'VISIT', 'EMAIL') then raise exception 'Invalid contact mode'; end if;
  if p_status not in ('NEW','CONTACTED','FOLLOW_UP_DUE','INTERESTED','QUOTATION_REQUESTED','QUOTATION_SENT','NEGOTIATION','DECISION_PENDING','WON','LOST','NOT_RESPONDING','ON_HOLD') then
    raise exception 'Invalid follow-up status';
  end if;

  select id into v_prev from public.retail_followups where lead_id = p_lead_id order by created_at desc limit 1;

  insert into public.retail_followups (
    department_id, lead_id, customer_id, previous_followup_id, contact_mode, outcome, customer_response, products_discussed,
    expected_decision_date, revised_budget, notes, next_action, next_follow_up_at, status, lost_reason, created_by
  ) values (
    v_lead.department_id, p_lead_id, v_lead.customer_id, v_prev, p_contact_mode, p_outcome, p_customer_response, p_products_discussed,
    p_expected_decision_date, p_revised_budget, p_notes, p_next_action, p_next_follow_up_at, p_status, p_lost_reason, auth.uid()
  ) returning id into v_followup_id;

  v_lead_status := case when p_status = 'WON' then v_lead.status when p_status = 'LOST' then 'LOST'
    when p_status in ('QUOTATION_REQUESTED', 'QUOTATION_SENT', 'NEGOTIATION') then 'QUOTED' else 'FOLLOW_UP' end;
  update public.retail_leads set status = v_lead_status,
    next_follow_up_date = p_next_follow_up_at::date, next_follow_up_time = p_next_follow_up_at::time
  where id = p_lead_id;

  -- close whatever reminder task was still open for this lead: this follow-up entry supersedes it, whatever the outcome.
  if v_lead.linked_task_id is not null then
    update public.staff_tasks set is_active = false where id = v_lead.linked_task_id and is_active = true
      and status_id not in (select id from public.status_master where code in ('CLOSED', 'VERIFIED'));
  end if;
  update public.retail_leads set linked_task_id = null where id = p_lead_id;

  -- a new reminder is created ONLY when the lead is still open and a next follow-up time was actually given.
  if p_next_follow_up_at is not null and p_status = any(v_open_statuses) then
    v_key := 'retail_followup:' || v_followup_id::text;
    select id, task_number into v_task from public.staff_tasks where system_key = v_key;
    if v_task.id is null then
      select tk.task_id, tk.task_number into v_task from public.staff_create_task(
        'Follow up: ' || v_lead.customer_name, coalesce(p_next_action, 'Scheduled follow-up'), 'FOLLOW_UP', 'NORMAL', 'none',
        v_lead.department_id, v_lead.department_id, v_lead.assigned_to, p_next_follow_up_at::date, p_next_follow_up_at::time,
        null, v_lead.walkin_number, p_products_discussed, null, null, null) tk;
      update public.staff_tasks set system_key = v_key where id = v_task.task_id;
    end if;
    update public.retail_followups set linked_task_id = v_task.task_id where id = v_followup_id;
    update public.retail_leads set linked_task_id = v_task.task_id where id = p_lead_id;
    if v_lead.assigned_to <> auth.uid() then
      perform public.staff_notify_assignment(v_lead.assigned_to, 'retail_lead', p_lead_id,
        'Next follow-up scheduled: ' || v_lead.customer_name, 'આગલું ફોલો-અપ નક્કી થયું: ' || v_lead.customer_name);
    end if;
  end if;

  perform public.staff_write_audit('retail_lead', p_lead_id, 'FOLLOW_UP',
    jsonb_build_object('previous_status', v_lead.status), jsonb_build_object('status', p_status, 'followup_id', v_followup_id), v_lead.department_id);

  return query select v_followup_id, v_task.task_id, v_task.task_number;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_create_quotation(
  p_lead_id uuid, p_customer_name text, p_phone text, p_location_id uuid default null, p_valid_until date default null,
  p_expected_delivery date default null, p_delivery_charge numeric default 0, p_installation_charge numeric default 0,
  p_terms text default null, p_internal_approval_required boolean default false, p_items jsonb default '[]'::jsonb,
  p_supersedes_id uuid default null)
returns public.retail_quotations language plpgsql security definer set search_path = public as $$
declare
  v_dept uuid := public.retail_dept_id(); v_customer_id uuid; v_number text; v_revision int := 1; v_total numeric := 0;
  v_row public.retail_quotations; v_item jsonb; v_line numeric;
begin
  perform public.staff_assert_operational();
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then raise exception 'At least one line item is required'; end if;
  if p_lead_id is not null then select customer_id into v_customer_id from public.retail_leads where id = p_lead_id; end if;
  if p_supersedes_id is not null then
    select revision_no + 1 into v_revision from public.retail_quotations where id = p_supersedes_id;
    if v_revision is null then raise exception 'Original quotation not found'; end if;
  end if;

  v_number := 'QT-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_line := coalesce((v_item->>'quantity')::numeric, 0) * coalesce((v_item->>'unit_price')::numeric, 0)
              - coalesce((v_item->>'discount')::numeric, 0) + coalesce((v_item->>'tax')::numeric, 0);
    v_total := v_total + v_line;
  end loop;
  v_total := v_total + coalesce(p_delivery_charge, 0) + coalesce(p_installation_charge, 0);

  insert into public.retail_quotations (
    department_id, lead_id, customer_id, quotation_number, customer_name, phone, status, total_amount, valid_until,
    delivery_charge, installation_charge, terms, expected_delivery, supersedes_id, revision_no, internal_approval_required, created_by
  ) values (
    v_dept, p_lead_id, v_customer_id, v_number, btrim(p_customer_name), nullif(btrim(p_phone), ''), 'DRAFT', v_total, p_valid_until,
    coalesce(p_delivery_charge, 0), coalesce(p_installation_charge, 0), p_terms, p_expected_delivery, p_supersedes_id, v_revision,
    coalesce(p_internal_approval_required, false), auth.uid()
  ) returning * into v_row;

  insert into public.retail_quotation_items (quotation_id, item_name, sku, description, dimensions, product_image_path, quantity, unit_price, discount, tax, line_total, customization_notes)
  select v_row.id, it->>'item_name', it->>'sku', it->>'description', it->>'dimensions', it->>'product_image_path',
    coalesce((it->>'quantity')::numeric, 0), coalesce((it->>'unit_price')::numeric, 0), coalesce((it->>'discount')::numeric, 0), coalesce((it->>'tax')::numeric, 0),
    coalesce((it->>'quantity')::numeric, 0) * coalesce((it->>'unit_price')::numeric, 0) - coalesce((it->>'discount')::numeric, 0) + coalesce((it->>'tax')::numeric, 0),
    it->>'customization_notes'
  from jsonb_array_elements(p_items) it;

  if p_lead_id is not null then update public.retail_leads set status = 'QUOTED' where id = p_lead_id; end if;
  perform public.staff_write_audit('retail_quotation', v_row.id, 'CREATE', null, jsonb_build_object('quotation_number', v_number, 'total', v_total), v_dept);
  return v_row;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Extends the EXISTING function (v2_2b): copies the richer item/customer fields, links the order's own verification task, and is
-- itself idempotent (a quotation converted twice returns the SAME order rather than creating a second one).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_convert_quotation_to_order(p_quotation_id uuid)
returns public.retail_orders language plpgsql security definer set search_path = public as $$
declare
  v_quotation public.retail_quotations; v_customer public.retail_customers; v_allowed boolean; v_order public.retail_orders;
  v_order_number text; v_task record; v_key text;
begin
  perform public.staff_assert_operational();

  select * into v_quotation from public.retail_quotations where id = p_quotation_id;
  if v_quotation is null then raise exception 'Quotation not found'; end if;
  if v_quotation.status <> 'ACCEPTED' then raise exception 'Only an ACCEPTED quotation can be converted to an order'; end if;

  select * into v_order from public.retail_orders where quotation_id = p_quotation_id;
  if v_order.id is not null then return v_order; end if; -- idempotent: already converted

  v_allowed := (v_quotation.created_by = auth.uid() or public.staff_has_global_oversight()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_quotation.department_id)));
  if not v_allowed then raise exception 'Not authorized to convert this quotation'; end if;

  if v_quotation.customer_id is not null then select * into v_customer from public.retail_customers where id = v_quotation.customer_id; end if;
  v_order_number := 'ORD-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  insert into public.retail_orders (
    department_id, quotation_id, customer_id, order_number, customer_name, phone, total_amount, required_delivery_date,
    delivery_address, billing_address, created_by
  ) values (
    v_quotation.department_id, v_quotation.id, v_quotation.customer_id, v_order_number, v_quotation.customer_name, v_quotation.phone,
    v_quotation.total_amount, v_quotation.expected_delivery, v_customer.area, v_customer.area, auth.uid()
  ) returning * into v_order;

  insert into public.retail_order_items (order_id, item_name, sku, dimensions, finish_color_fabric, customization_notes, product_image_path, quantity, unit_price, discount, tax, line_total)
  select v_order.id, item_name, sku, dimensions, null, customization_notes, product_image_path, quantity, unit_price, discount, tax, line_total
  from public.retail_quotation_items where quotation_id = v_quotation.id;

  update public.retail_leads set converted_order_id = v_order.id, status = 'CONVERTED' where id = v_quotation.lead_id;

  -- a lightweight internal "verify this order" task, same idempotent pattern as everywhere else -- what Today's Tasks shows before confirm.
  v_key := 'retail_order_verify:' || v_order.id::text;
  select t.task_id, t.task_number into v_task from public.staff_create_task(
    'Verify order ' || v_order_number, 'Check items, pricing and stock/production plan before confirming.', 'GENERAL_TASK', 'HIGH', 'none',
    v_order.department_id, v_order.department_id, auth.uid(), coalesce(v_order.required_delivery_date, current_date + 3), null,
    null, v_order_number, null, null, null, null) t;
  update public.staff_tasks set system_key = v_key where id = v_task.task_id;
  update public.retail_orders set linked_task_id = v_task.task_id where id = v_order.id;

  perform public.staff_write_audit('retail_order', v_order.id, 'CREATE_FROM_QUOTATION', null,
    jsonb_build_object('order_number', v_order_number, 'quotation_id', p_quotation_id), v_quotation.department_id);
  return v_order;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_confirm_order(p_order_id uuid, p_fulfilment jsonb default '[]'::jsonb)
returns setof public.retail_fulfilment_items language plpgsql security definer set search_path = public as $$
declare
  v_order public.retail_orders; v_allowed boolean; v_item record; v_ov jsonb; v_mode text; v_qty numeric;
  v_proc_dept uuid; v_pr_number text; v_pr_id uuid; v_job record; v_any_stock boolean := false; v_any_factory boolean := false; v_any_outsource boolean := false;
begin
  perform public.staff_assert_operational();
  select * into v_order from public.retail_orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;

  v_allowed := (v_order.created_by = auth.uid() or public.staff_has_global_oversight()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_order.department_id)));
  if not v_allowed then raise exception 'Not authorized to confirm this order'; end if;

  -- safely retryable: a second call after the first already succeeded is a no-op read, never a second split.
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
    if v_mode is null or v_mode not in ('STOCK', 'FACTORY', 'OUTSOURCE') then
      raise exception 'A fulfilment mode (Stock / Factory / Outsource) is required for every item — missing for %', v_item.item_name;
    end if;
    v_qty := coalesce((v_ov->>'quantity')::numeric, v_item.quantity);
    update public.retail_order_items set fulfilment_mode = v_mode where id = v_item.id;

    if v_mode = 'STOCK' then
      v_any_stock := true;
      insert into public.retail_fulfilment_items (order_id, order_item_id, mode, quantity, status, stock_location_id, created_by)
      values (p_order_id, v_item.id, 'STOCK', v_qty, 'RESERVED', coalesce((v_ov->>'stock_location_id')::uuid, v_order.location_id), auth.uid())
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
    jsonb_build_object('status', 'CONFIRMED', 'has_stock', v_any_stock, 'has_factory', v_any_factory, 'has_outsource', v_any_outsource), public.retail_dept_id());

  return query select * from public.retail_fulfilment_items where order_id = p_order_id;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_advance_delivery(p_order_id uuid, p_stage text, p_notes text default null, p_scheduled_at timestamptz default null)
returns public.retail_deliveries language plpgsql security definer set search_path = public as $$
declare v_order public.retail_orders; v_row public.retail_deliveries; v_task record; v_key text;
begin
  perform public.staff_assert_operational();
  if p_stage not in ('ORDER_READY','PAYMENT_CLEARANCE','SITE_READINESS','DELIVERY_SCHEDULED','VEHICLE_ASSIGNED','DISPATCHED','DELIVERED','INSTALLATION','CUSTOMER_CONFIRMATION','COMPLETED') then
    raise exception 'Invalid delivery stage';
  end if;
  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if not (v_order.created_by = auth.uid() or public.staff_has_global_oversight() or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_order.department_id))) then
    raise exception 'Not authorized to update this delivery';
  end if;

  insert into public.retail_deliveries (department_id, order_id, delivery_address, created_by)
  values (v_order.department_id, p_order_id, v_order.delivery_address, auth.uid())
  on conflict (order_id) do nothing;

  update public.retail_deliveries set stage = p_stage, delay_reason = case when p_stage = 'DELIVERED' then null else delay_reason end,
    scheduled_at = coalesce(p_scheduled_at, scheduled_at), customer_confirmed = (p_stage = 'CUSTOMER_CONFIRMATION' or p_stage = 'COMPLETED') or customer_confirmed
  where order_id = p_order_id returning * into v_row;

  if p_stage = 'DELIVERY_SCHEDULED' then
    v_key := 'retail_delivery:' || v_row.id::text;
    if not exists (select 1 from public.staff_tasks where system_key = v_key) then
      select t.task_id into v_task from public.staff_create_task(
        'Coordinate delivery: ' || v_order.order_number, coalesce(p_notes, 'Delivery scheduled'), 'DELIVERY', 'HIGH', 'none',
        v_order.department_id, v_order.department_id, v_order.created_by, coalesce(p_scheduled_at::date, current_date + 1), p_scheduled_at::time,
        null, v_order.order_number, null, null, null, null) t;
      update public.staff_tasks set system_key = v_key where id = v_task.task_id;
      update public.retail_deliveries set linked_task_id = v_task.task_id where id = v_row.id;
    end if;
  end if;

  perform public.staff_write_audit('retail_order', p_order_id, 'DELIVERY_STAGE', null, jsonb_build_object('stage', p_stage), v_order.department_id);
  if p_stage = 'DELAYED' or p_stage is null then null; end if; -- (delay_reason set via a direct authorized UPDATE from the UI when needed)
  return v_row;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_record_daily_update(
  p_location_id uuid, p_display_update_note text default null, p_delivery_coordination_note text default null,
  p_problems text default null, p_tomorrow_priority text default null, p_notes text default null)
returns public.retail_daily_updates language plpgsql security definer set search_path = public as $$
declare v_dept uuid := public.retail_dept_id(); v_today date := current_date; v_row public.retail_daily_updates;
  v_walkins int; v_followups int; v_quotes int; v_orders int; v_sales numeric; v_collection numeric;
begin
  perform public.staff_assert_operational();
  select count(*) into v_walkins from public.retail_leads where created_by = auth.uid() and created_at::date = v_today and (p_location_id is null or location_id = p_location_id);
  select count(*) into v_followups from public.retail_followups where created_by = auth.uid() and created_at::date = v_today;
  select count(*) into v_quotes from public.retail_quotations where created_by = auth.uid() and created_at::date = v_today;
  select count(*), coalesce(sum(total_amount), 0) into v_orders, v_sales from public.retail_orders where created_by = auth.uid() and created_at::date = v_today;
  select coalesce(sum(p.amount), 0) into v_collection from public.retail_payments p join public.retail_orders o on o.id = p.order_id
    where p.created_by = auth.uid() and p.paid_at::date = v_today;

  insert into public.retail_daily_updates (
    department_id, location_id, employee_id, update_date, walkins_count, followups_count, quotations_count, orders_count,
    sales_value, collection_amount, display_update_note, delivery_coordination_note, problems, tomorrow_priority, notes
  ) values (
    v_dept, p_location_id, auth.uid(), v_today, v_walkins, v_followups, v_quotes, v_orders, v_sales, v_collection,
    p_display_update_note, p_delivery_coordination_note, p_problems, p_tomorrow_priority, p_notes
  )
  on conflict (employee_id, location_id, update_date) do update set
    walkins_count = excluded.walkins_count, followups_count = excluded.followups_count, quotations_count = excluded.quotations_count,
    orders_count = excluded.orders_count, sales_value = excluded.sales_value, collection_amount = excluded.collection_amount,
    display_update_note = excluded.display_update_note, delivery_coordination_note = excluded.delivery_coordination_note,
    problems = excluded.problems, tomorrow_priority = excluded.tomorrow_priority, notes = excluded.notes
  returning * into v_row;
  return v_row;
end $$;

revoke execute on function
  public.retail_upsert_customer(text, text, text, text, text, text, text),
  public.retail_create_walkin(text, text, text, text, text, uuid, text, text, text, numeric, text, text, uuid, text, text, text, timestamptz),
  public.retail_record_followup(uuid, text, text, text, text, date, numeric, text, text, timestamptz, text, text),
  public.retail_create_quotation(uuid, text, text, uuid, date, date, numeric, numeric, text, boolean, jsonb, uuid),
  public.retail_confirm_order(uuid, jsonb),
  public.retail_advance_delivery(uuid, text, text, timestamptz),
  public.retail_record_daily_update(uuid, text, text, text, text, text)
  from public, anon;
grant execute on function
  public.retail_upsert_customer(text, text, text, text, text, text, text),
  public.retail_create_walkin(text, text, text, text, text, uuid, text, text, text, numeric, text, text, uuid, text, text, text, timestamptz),
  public.retail_record_followup(uuid, text, text, text, text, date, numeric, text, text, timestamptz, text, text),
  public.retail_create_quotation(uuid, text, text, uuid, date, date, numeric, numeric, text, boolean, jsonb, uuid),
  public.retail_confirm_order(uuid, jsonb),
  public.retail_advance_delivery(uuid, text, text, timestamptz),
  public.retail_record_daily_update(uuid, text, text, text, text, text)
  to authenticated;
