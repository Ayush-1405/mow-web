-- v3_13: proc_place_order_with_vendors failed from the app with "DELETE requires a WHERE clause": Supabase's API runs
-- with pg_safeupdate, which refuses a DELETE without WHERE -- also on the function's own temporary table. Same function,
-- only that statement changed (delete ... where true). No data is touched.
begin;
create or replace function public.proc_place_order_with_vendors(p_request_id uuid, p_allocations jsonb, p_details jsonb)
returns public.purchase_orders language plpgsql security definer set search_path to 'public' as $$
declare
  r public.purchase_requests; v_po public.purchase_orders; a jsonb; v_item public.purchase_request_items; v_vendor public.vendors;
  v_n integer := 0; v_items integer; v_order_date date; v_late text := nullif(btrim(coalesce(p_details->>'late_reason', '')), '');
  v_lead uuid; v_lead_ref text; v_lead_quote text; v_total numeric := 0; v_any_amount boolean := false; v_max_exp date; v_rate numeric; v_amount numeric;
  v_exp date; v_ref text; v_split text; v_late_any boolean := false;
begin
  perform public.staff_assert_operational();
  if not public.proc_can_work_order(p_request_id) then
    raise exception 'Only the Procurement employee handling this order, or a Procurement Head / Supervisor, can place it';
  end if;
  select * into r from public.purchase_requests where id = p_request_id for update;
  if r.id is null then raise exception 'Order not found'; end if;
  if exists (select 1 from public.purchase_orders where purchase_request_id = p_request_id and is_current) or exists (select 1 from public.purchase_vendor_allocations where purchase_request_id = p_request_id) then
    raise exception 'The order for this request has already been confirmed';
  end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then raise exception 'Choose a vendor for every line'; end if;
  select count(*) into v_items from public.purchase_request_items where purchase_request_id = p_request_id;
  v_order_date := coalesce(nullif(p_details->>'order_date', '')::date, public.proc_today_ist());

  create temporary table if not exists zz_alloc (item_id uuid primary key, vendor_id uuid, ref text, quote text, rate numeric, amount numeric, exp date) on commit drop;
  delete from zz_alloc where true;
  for a in select * from jsonb_array_elements(p_allocations) loop
    select * into v_item from public.purchase_request_items where id = public.proc_try_uuid(a->>'item_id') and purchase_request_id = p_request_id;
    if v_item.id is null then raise exception 'A line does not belong to this order'; end if;
    select * into v_vendor from public.vendors where id = public.proc_try_uuid(a->>'vendor_id');
    if v_vendor.id is null then raise exception 'Choose a vendor for line %', v_item.line_no; end if;
    if not public.proc_vendor_selectable(v_vendor) then raise exception 'Vendor % is blocked or inactive', v_vendor.name; end if;
    v_ref := nullif(btrim(coalesce(a->>'vendor_po_reference', '')), '');
    if v_ref is null then raise exception 'Vendor PO / reference number is required for %', v_vendor.name; end if;
    v_exp := nullif(a->>'expected_delivery_date', '')::date;
    if v_exp is null then raise exception 'Expected delivery date is required for %', v_vendor.name; end if;
    if v_exp < v_order_date then raise exception 'Expected delivery cannot be before the order date'; end if;
    v_rate := nullif(btrim(coalesce(a->>'rate', '')), '')::numeric;
    if v_rate is not null and v_rate < 0 then raise exception 'Rate cannot be negative'; end if;
    v_amount := case when v_rate is not null then round(v_rate * coalesce(v_item.quantity, 1), 2) else v_item.amount end;
    begin
      insert into zz_alloc values (v_item.id, v_vendor.id, v_ref, nullif(btrim(coalesce(a->>'quotation_reference', '')), ''), v_rate, v_amount, v_exp);
    exception when unique_violation then raise exception 'Line % has more than one vendor', v_item.line_no; end;
    v_n := v_n + 1;
    if v_exp > r.required_by_date then v_late_any := true; end if;
  end loop;
  if v_n <> v_items then raise exception 'Choose a vendor for every line (% of % chosen)', v_n, v_items; end if;
  -- One vendor, one reference: the same vendor on several lines must carry the same PO / reference.
  if exists (select 1 from zz_alloc group by vendor_id having count(distinct lower(ref)) > 1) then
    raise exception 'Use one PO / reference number per vendor';
  end if;
  if v_late_any and v_late is null then
    raise exception 'Expected delivery is after the department''s due date (%) — give the reason or agree a new commitment', to_char(r.required_by_date, 'DD-MM-YYYY');
  end if;

  -- The main vendor (most lines, then highest value) carries the order's purchase order; every line keeps its own vendor.
  select z.vendor_id, min(z.ref), min(z.quote) into v_lead, v_lead_ref, v_lead_quote from zz_alloc z
   group by z.vendor_id order by count(*) desc, sum(coalesce(z.amount, 0)) desc limit 1;
  select coalesce(sum(amount), 0), bool_or(amount is not null), max(exp) into v_total, v_any_amount, v_max_exp from zz_alloc;
  select * into v_vendor from public.vendors where id = v_lead;
  v_po := public.proc_confirm_order(p_request_id, v_vendor.name, v_vendor.mobile, v_lead_quote, v_lead_ref, v_order_date, null,
    case when v_any_amount and v_total > 0 then v_total end, v_max_exp, coalesce(nullif(p_details->>'payment_terms', ''), v_vendor.payment_terms),
    nullif(btrim(coalesce(p_details->>'remarks', '')), ''), nullif(btrim(coalesce(p_details->>'scope_of_work', '')), ''));
  update public.purchase_orders set vendor_id = v_lead, vendor_contact = coalesce(vendor_contact, v_vendor.mobile) where id = v_po.id returning * into v_po;

  insert into public.purchase_vendor_allocations (purchase_request_id, item_id, vendor_id, purchase_order_id, vendor_po_reference, quotation_reference, rate, amount,
    expected_delivery_date, created_by)
  select p_request_id, z.item_id, z.vendor_id, v_po.id, z.ref, z.quote, z.rate, z.amount, z.exp, auth.uid() from zz_alloc z;
  update public.purchase_request_items i set rate = coalesce(z.rate, i.rate), amount = coalesce(z.amount, i.amount) from zz_alloc z where i.id = z.item_id;

  select string_agg(v.name || ' (' || x.n || ' line' || case when x.n > 1 then 's' else '' end || ', ' || x.ref || ')', '; ' order by x.n desc)
    into v_split from (select vendor_id, count(*) n, min(ref) ref from zz_alloc group by vendor_id) x join public.vendors v on v.id = x.vendor_id;
  insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
  values (p_request_id, 'ORDER_PLACED', 'ORDER_PLACED', auth.uid(), public.staff_current_role_code(),
    'Vendors: ' || v_split || case when v_late_any then '. Delivery after the due date agreed: ' || v_late else '' end);
  return v_po;
exception when invalid_datetime_format or datetime_field_overflow then raise exception 'A date is not valid';
  when invalid_text_representation then raise exception 'A rate is not a number';
end $$;
commit;
