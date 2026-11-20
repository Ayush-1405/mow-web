-- Customer details on Production Supply Order Forms.
--
-- * purchase_requests.customer (jsonb): the customer exactly as entered for this order -- name, mobile, alternate mobile,
--   email, GST number, billing address and delivery address (with delivery contact). It is what the printed form shows,
--   so later edits to a customer master never change an order already printed. It is visible to whoever may see the
--   order (existing purchase_requests RLS: requester, the department's Head, Procurement, Management).
-- * The company's existing customer database is retail_customers (Retail): a Retail order is linked to it
--   (retail_customer_id) -- matched by mobile number, so no duplicate is created; a new mobile creates the customer
--   (owned by the requester, as Retail's own screens do); the billing / delivery address is stored on a customer the
--   requester may edit. A customer owned by another salesperson is never modified. Other departments have no customer
--   database: their orders are the record, and proc_search_customers finds customers from earlier orders the user may
--   see (plus Retail customers they may see), so details are reused instead of retyped.
-- * client_name follows the customer name, so every existing screen keeps working.

begin;

alter table public.purchase_requests
  add column if not exists customer jsonb,
  add column if not exists retail_customer_id uuid references public.retail_customers(id) on delete set null;
create index if not exists purchase_requests_customer_mobile_idx on public.purchase_requests ((customer->>'mobile')) where customer is not null;

-- 10-digit Indian mobile (optionally +91 / 0), returned as "+91 XXXXXXXXXX"; null when empty. Raises when invalid.
create or replace function public.proc_norm_mobile(p text, p_label text)
returns text language plpgsql immutable set search_path to 'public' as $$
declare d text := regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g');
begin
  if d = '' then return null; end if;
  if length(d) = 12 and left(d, 2) = '91' then d := right(d, 10); elsif length(d) = 11 and left(d, 1) = '0' then d := right(d, 10); end if;
  if d !~ '^[6-9][0-9]{9}$' then raise exception '% must be a 10-digit mobile number', p_label; end if;
  return '+91 ' || d;
end $$;

create or replace function public.proc_norm_address(p jsonb, p_label text, p_with_contact boolean)
returns jsonb language plpgsql immutable set search_path to 'public' as $$
declare a jsonb := '{}'; v text; pin text;
begin
  foreach v in array array['line1', 'line2', 'city', 'state'] loop
    if nullif(btrim(coalesce(p->>v, '')), '') is not null then a := a || jsonb_build_object(v, left(btrim(p->>v), 300)); end if;
  end loop;
  pin := nullif(btrim(coalesce(p->>'pin', '')), '');
  if pin is not null then
    if pin !~ '^[1-9][0-9]{5}$' then raise exception '% PIN code must be 6 digits', p_label; end if;
    a := a || jsonb_build_object('pin', pin);
  end if;
  if p_with_contact then
    if nullif(btrim(coalesce(p->>'contact_person', '')), '') is not null then a := a || jsonb_build_object('contact_person', left(btrim(p->>'contact_person'), 120)); end if;
    if public.proc_norm_mobile(p->>'contact_phone', 'Delivery contact number') is not null then
      a := a || jsonb_build_object('contact_phone', public.proc_norm_mobile(p->>'contact_phone', 'Delivery contact number'));
    end if;
  end if;
  return a;
end $$;

-- One line of an address, for Retail's customer record and for search results.
create or replace function public.proc_address_text(a jsonb)
returns text language sql immutable set search_path to 'public' as $$
  select nullif(concat_ws(', ', nullif(a->>'line1', ''), nullif(a->>'line2', ''), nullif(a->>'city', ''), nullif(a->>'state', ''),
                          nullif(a->>'pin', '')), '');
$$;

-- Validates and stores the order's customer; links / creates the Retail customer for Retail orders.
-- p_customer null (key absent) leaves the order's customer as it is; an object with an empty name clears it.
create or replace function public.proc_apply_order_customer(p_row public.purchase_requests, p_customer jsonb)
returns public.purchase_requests language plpgsql security definer set search_path to 'public' as $$
declare
  c jsonb; v_name text; v_mobile text; v_alt text; v_email text; v_gst text; v_bill jsonb; v_del jsonb; v_same boolean;
  v_rc uuid; v_norm text; v_existing public.retail_customers; v_row public.purchase_requests := p_row; v_retail boolean;
begin
  if p_customer is null or jsonb_typeof(p_customer) <> 'object' then return p_row; end if;
  v_name := nullif(btrim(coalesce(p_customer->>'name', '')), '');
  if v_name is null then
    update public.purchase_requests set customer = null, retail_customer_id = null where id = p_row.id returning * into v_row;
    return v_row;
  end if;
  v_mobile := public.proc_norm_mobile(p_customer->>'mobile', 'Customer mobile number');
  v_alt := public.proc_norm_mobile(p_customer->>'alt_mobile', 'Alternate mobile number');
  v_email := lower(nullif(btrim(coalesce(p_customer->>'email', '')), ''));
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Customer email address is not valid'; end if;
  v_gst := upper(nullif(btrim(coalesce(p_customer->>'gstin', '')), ''));
  if v_gst is not null and v_gst !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$' then raise exception 'Customer GST number is not valid (15 characters, e.g. 24ABCDE1234F1Z5)'; end if;
  v_bill := public.proc_norm_address(coalesce(p_customer->'billing', '{}'), 'Billing', false);
  v_same := coalesce((p_customer->>'delivery_same_as_billing')::boolean, false);
  v_del := public.proc_norm_address(coalesce(p_customer->'delivery', '{}'), 'Delivery', true);
  if v_same then
    v_del := v_bill || (v_del - 'line1' - 'line2' - 'city' - 'state' - 'pin');   -- keep the delivery contact
  end if;
  c := jsonb_strip_nulls(jsonb_build_object('name', left(v_name, 150), 'mobile', v_mobile, 'alt_mobile', v_alt, 'email', v_email, 'gstin', v_gst,
         'billing', nullif(v_bill, '{}'::jsonb), 'delivery', nullif(v_del, '{}'::jsonb), 'delivery_same_as_billing', v_same));

  -- Retail customer database: link an existing customer the requester may see, or create one for a Retail order.
  v_retail := (select code from public.departments where id = p_row.requesting_department_id) = 'RETAIL';
  v_rc := public.proc_try_uuid(p_customer->>'retail_customer_id');
  if v_rc is not null and not public.retail_can_access_customer(v_rc) then v_rc := null; end if;
  if v_rc is null and v_mobile is not null then
    v_norm := public.retail_normalize_phone(v_mobile);
    select * into v_existing from public.retail_customers where normalized_phone = v_norm and is_active limit 1;
    if v_existing.id is not null then
      -- Same mobile already on file: link it only if the requester may see it; never duplicate it, never change someone else's.
      if public.retail_can_access_customer(v_existing.id) then v_rc := v_existing.id; end if;
    elsif v_retail then
      v_rc := (public.retail_upsert_customer(v_name, v_mobile, null, v_email, coalesce(v_bill->>'city', v_del->>'city'), null, 'RETAIL', auth.uid())).id;
    end if;
  end if;
  if v_rc is not null and public.retail_can_write_customer(v_rc) then
    update public.retail_customers set
      billing_address = coalesce(public.proc_address_text(v_bill), billing_address),
      delivery_address = coalesce(public.proc_address_text(v_del), delivery_address),
      email = coalesce(email, v_email), updated_at = now()
     where id = v_rc;
  end if;

  update public.purchase_requests set customer = c, retail_customer_id = v_rc, client_name = left(v_name, 150) where id = p_row.id returning * into v_row;
  return v_row;
end $$;

-- Customers to pick from while filling an order: Retail customers the user may see, and customers on orders the user
-- may see (newest first), matched on name or mobile. One row per mobile number (or per name when there is none).
create or replace function public.proc_search_customers(p_query text)
returns table (source text, retail_customer_id uuid, customer jsonb, last_used timestamptz)
language plpgsql stable security definer set search_path to 'public' as $$
declare q text := lower(btrim(coalesce(p_query, ''))); d text := regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g');
begin
  if not public.staff_current_user_ok() or length(q) < 2 then return; end if;
  return query
  with orders as (
    select distinct on (coalesce(r.customer->>'mobile', lower(r.customer->>'name')))
           'ORDER'::text as src, r.retail_customer_id as rc, r.customer as cust, coalesce(r.proc_updated_at, r.created_at) as at
      from public.purchase_requests r
     where r.customer is not null and r.proc_status <> 'LEGACY' and public.proc_can_view_request(r.id)
       and (lower(r.customer->>'name') like '%' || q || '%' or (length(d) >= 4 and regexp_replace(coalesce(r.customer->>'mobile', ''), '[^0-9]', '', 'g') like '%' || d || '%'))
     order by coalesce(r.customer->>'mobile', lower(r.customer->>'name')), coalesce(r.proc_updated_at, r.created_at) desc
  ), retail as (
    select 'RETAIL'::text as src, c.id as rc,
           jsonb_strip_nulls(jsonb_build_object('name', c.full_name,
             'mobile', case when c.normalized_phone ~ '^[6-9][0-9]{9}$' then '+91 ' || c.normalized_phone else c.phone end,
             'email', c.email, 'billing', case when c.billing_address is not null then jsonb_build_object('line1', c.billing_address)
                                              when c.city is not null then jsonb_build_object('city', c.city) end,
             'delivery', case when c.delivery_address is not null then jsonb_build_object('line1', c.delivery_address) end)) as cust,
           c.updated_at as at
      from public.retail_customers c
     where c.is_active and c.merged_into_id is null and public.retail_can_access_customer(c.id)
       and (lower(c.full_name) like '%' || q || '%' or (length(d) >= 4 and coalesce(c.normalized_phone, '') like '%' || d || '%'))
  )
  select x.src, x.rc, x.cust, x.at from (
    select o.*, 1 as pref from orders o
    union all
    -- A Retail customer already shown through one of the user's orders (same mobile) is not listed twice.
    select r.*, 2 from retail r where not exists (select 1 from orders o where o.cust->>'mobile' = r.cust->>'mobile' or o.rc = r.rc)
  ) x order by x.pref, x.at desc nulls last limit 15;
end $$;

-- proc_create_order / proc_update_order: the live definitions (v3_05 + v3_08), unchanged except that the order's customer
-- (p_header.customer) is validated and saved right after the items.
CREATE OR REPLACE FUNCTION public.proc_create_order(p_header jsonb, p_items jsonb, p_submit boolean DEFAULT true)
 RETURNS purchase_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_row := public.proc_apply_order_customer(v_row, p_header->'customer');  -- (v3_10) the order's customer

  insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
  values (v_row.id, null, v_status, auth.uid(), public.staff_current_role_code(),
    'Due date ' || to_char(v_required, 'DD-MM-YYYY') || ', priority ' || initcap(v_priority) || coalesce(' (' || v_reason || ')', ''));
  perform public.staff_write_audit('purchase_request', v_row.id, 'CREATE_ORDER', null, to_jsonb(v_row) || jsonb_build_object('items', v_items), v_dept, null);
  perform public.proc_notify_submitted(v_row);
  return v_row;
exception when invalid_datetime_format or datetime_field_overflow then raise exception 'One of the dates is not valid';
end $function$;

CREATE OR REPLACE FUNCTION public.proc_update_order(p_request_id uuid, p_header jsonb, p_items jsonb)
 RETURNS purchase_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_row := public.proc_apply_order_customer(v_row, p_header->'customer');  -- (v3_10) the order's customer
  perform public.staff_write_audit('purchase_request', p_request_id, 'UPDATE_ORDER', v_old, to_jsonb(v_row) || jsonb_build_object('items', v_items), v_row.requesting_department_id, null);
  return v_row;
exception when invalid_datetime_format or datetime_field_overflow then raise exception 'One of the dates is not valid';
end $function$;

revoke all on function public.proc_apply_order_customer(public.purchase_requests, jsonb), public.proc_norm_address(jsonb, text, boolean)
  from public, anon, authenticated;
revoke all on function public.proc_search_customers(text) from public, anon;
grant execute on function public.proc_search_customers(text), public.proc_norm_mobile(text, text), public.proc_address_text(jsonb) to authenticated;

commit;
