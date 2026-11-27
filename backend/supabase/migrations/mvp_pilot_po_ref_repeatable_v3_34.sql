-- v3_34 PO / reference numbers may repeat.
--
-- Vendors and the factory reuse the same PO / reference (for example one reference for every order placed with them that day), so
-- "Purchase order number ... is already used" blocked real orders. Removed: the unique index purchase_orders_po_number_idx and the
-- matching check in proc_confirm_order. Nothing looks an order up by its PO number alone (orders are always found by id / request),
-- so repeats are safe. A plain (non-unique) index keeps PO search fast. proc_confirm_order is otherwise exactly the live
-- definition. No data changes.

drop index if exists public.purchase_orders_po_number_idx;
create index if not exists purchase_orders_po_number_search_idx on public.purchase_orders (lower(po_number)) where po_number is not null;

CREATE OR REPLACE FUNCTION public.proc_confirm_order(p_request_id uuid, p_vendor_name text, p_vendor_contact text, p_quotation_reference text, p_po_number text, p_order_date date, p_ordered_quantity numeric, p_amount numeric, p_expected_delivery_date date, p_payment_terms text, p_remarks text, p_scope_of_work text DEFAULT NULL::text)
 RETURNS purchase_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.purchase_requests; v_po public.purchase_orders; v_vendor uuid; v_phone text; v_limit numeric; v_contact jsonb;
  v_recipients uuid[]; v_msg text; v_form boolean; v_qty numeric; v_amount numeric; v_vendor_name text := btrim(coalesce(p_vendor_name, ''));
begin
  perform public.staff_assert_operational();
  if not public.proc_can_work_order(p_request_id) then
    raise exception 'Only the Procurement employee handling this order, or a Procurement Head / Supervisor, can confirm it';
  end if;
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found'; end if;
  if v_row.proc_status = 'ORDER_PLACED' or exists (select 1 from public.purchase_orders where purchase_request_id = p_request_id and is_current) then
    raise exception 'The order for this request has already been confirmed';
  end if;
  if v_row.proc_status <> 'DOCUMENT_GENERATED'
     or not exists (select 1 from public.purchase_print_logs where purchase_request_id = p_request_id and document_type = 'PURCHASE_REQUEST') then
    raise exception 'Print the purchase document before confirming the order';
  end if;
  v_form := v_row.order_form_type is not null;
  if v_vendor_name = '' then v_vendor_name := btrim(coalesce(v_row.preferred_vendor_name, '')); end if;

  v_phone := nullif(regexp_replace(coalesce(p_vendor_contact, ''), '[^0-9+]', '', 'g'), '');
  if v_vendor_name = '' then raise exception 'Vendor name is required'; end if;
  if v_phone is null and not v_form then raise exception 'Vendor contact must be a valid phone number'; end if;
  if v_phone is not null and length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 10 and 13 then raise exception 'Vendor contact must be a valid phone number'; end if;
  if btrim(coalesce(p_quotation_reference, '')) = '' and not v_form then raise exception 'Vendor quotation reference is required'; end if;
  if btrim(coalesce(p_po_number, '')) = '' then raise exception 'Vendor PO / reference number is required'; end if;
  if p_order_date is null then raise exception 'Order date is required'; end if;
  v_qty := coalesce(p_ordered_quantity, case when v_form then v_row.quantity end);
  if v_qty is null or v_qty <= 0 then raise exception 'Ordered quantity must be more than zero'; end if;
  v_amount := coalesce(p_amount, case when v_form then v_row.order_total end);
  if v_amount is not null and v_amount <= 0 then raise exception 'Final purchase amount must be more than zero'; end if;
  if v_amount is null and not v_form then raise exception 'Final purchase amount must be more than zero'; end if;
  if p_expected_delivery_date is null then raise exception 'Expected delivery date is required'; end if;
  if p_expected_delivery_date < p_order_date then raise exception 'Expected delivery cannot be before the order date'; end if;
  if btrim(coalesce(p_payment_terms, '')) = '' and not v_form then raise exception 'Payment terms are required'; end if;
  if btrim(coalesce(p_remarks, '')) = '' and not v_form then raise exception 'Procurement remarks are required'; end if;
  if v_row.procurement_category in ('LABOUR', 'TURNKEY', 'JOB_WORK', 'SERVICE') and btrim(coalesce(p_scope_of_work, '')) = '' then
    raise exception 'Scope of work is required for a work order';
  end if;

  select max_amount into v_limit from public.procurement_approval_limits where approver = 'PROCUREMENT_HEAD';
  if v_limit is not null and v_amount is not null and v_amount > v_limit and not exists (
       select 1 from public.purchase_approvals where purchase_request_id = p_request_id and approval_level = 'MANAGEMENT'
          and decision = 'APPROVED' and approved_amount >= v_amount) then
    raise exception 'Orders above Rs % need Management approval first', v_limit;
  end if;

  if v_phone is not null then
    select id into v_vendor from public.vendors
     where lower(btrim(name)) = lower(v_vendor_name) and right(regexp_replace(coalesce(mobile, ''), '[^0-9]', '', 'g'), 10) = right(regexp_replace(v_phone, '[^0-9]', '', 'g'), 10)
     limit 1;
  else
    select id into v_vendor from public.vendors where lower(btrim(name)) = lower(v_vendor_name) order by created_at limit 1;
  end if;
  if v_vendor is null then
    insert into public.vendors (vendor_code, name, mobile, approved_status, notes)
    values (public.proc_next_number('V'), v_vendor_name, v_phone, 'Pending Review', 'Added at order confirmation for ' || v_row.request_number)
    returning id into v_vendor;
  elsif exists (select 1 from public.vendors where id = v_vendor and coalesce(blacklisted, false)) then
    raise exception 'This vendor is blocked';
  end if;

  insert into public.purchase_orders (project_id, purchase_request_id, vendor_id, order_type, po_number, version_number, is_current, order_date,
    total_order_value, delivery_location, expected_delivery_date, payment_terms, status, created_by, vendor_contact, quotation_reference,
    ordered_quantity, remarks, confirmed_by, confirmed_at, approved_by, scope_of_work)
  values (v_row.project_id, p_request_id, v_vendor,
    case when v_row.procurement_category in ('LABOUR', 'TURNKEY', 'JOB_WORK', 'SERVICE') then 'WORK_ORDER' else 'PURCHASE_ORDER' end, btrim(p_po_number), 1, true, p_order_date,
    v_amount, v_row.delivery_location, p_expected_delivery_date, nullif(btrim(coalesce(p_payment_terms, '')), ''), 'ORDER_PLACED', public.interior_current_profile_id(),
    v_phone, nullif(btrim(coalesce(p_quotation_reference, '')), ''), v_qty, nullif(btrim(coalesce(p_remarks, '')), ''), auth.uid(), now(),
    public.interior_current_profile_id(), nullif(btrim(coalesce(p_scope_of_work, '')), ''))
  returning * into v_po;

  update public.purchase_requests set order_confirmed_by = auth.uid(), order_confirmed_at = now() where id = p_request_id;
  perform public.proc_set_status(p_request_id, 'DOCUMENT_GENERATED', 'ORDER_PLACED', coalesce(nullif(btrim(coalesce(p_remarks, '')), ''), 'Order placed, PO ' || btrim(p_po_number)));

  v_contact := public.proc_procurement_contact();
  v_msg := 'Order placed for ' || v_row.request_number
    || coalesce(' (' || (select project_code from public.projects where id = v_row.project_id) || ')', '')
    || ': ' || v_row.material_name || ', ' || v_qty || ' ' || coalesce(v_row.unit, '')
    || '. Vendor ' || v_vendor_name || ', PO ' || btrim(p_po_number) || ', ordered ' || to_char(p_order_date, 'DD-MM-YYYY')
    || ', expected ' || to_char(p_expected_delivery_date, 'DD-MM-YYYY') || '. Procurement Head: '
    || coalesce(v_contact->>'name', 'not set') || coalesce(' (' || (v_contact->>'phone') || ')', ' (phone not set)')
    || '. Your purchase request has been successfully processed and the order has been placed. You can coordinate directly with the Procurement Head for further updates.';
  v_recipients := public.proc_department_heads(v_row.requesting_department_id) || array[v_row.requester_user_id] || public.proc_procurement_team()
    || array[public.proc_procurement_head_user()];
  if v_row.project_id is not null then v_recipients := v_recipients || public.proc_project_manager_user(v_row.project_id); end if;
  select coalesce(array_agg(distinct x), '{}') into v_recipients from unnest(v_recipients) x where x is not null;
  perform public.proc_notify_users(v_recipients, p_request_id, v_msg,
    'ઓર્ડર મૂકાયો: ' || v_row.request_number || ', ' || v_row.material_name || ', PO ' || btrim(p_po_number));
  perform public.staff_write_audit('purchase_order', v_po.id, 'ORDER_PLACED', null, to_jsonb(v_po), v_row.requesting_department_id, p_remarks);
  return v_po;
end $function$;
