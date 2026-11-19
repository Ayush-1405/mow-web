-- Central Procurement, part 2: vendors, quotations and comparison, follow-ups, order progress and vendor dispatch, goods receipt
-- (partial and full, with rejections), GRN verification, invoices and payments, closing, emergency approval and Godown
-- low-stock requests. Same rules as part 1: every change goes through a proc_* function that checks the caller and the
-- request's status; the tables themselves stay read-only to users.

begin;

-- ---------------------------------------------------------------------------
-- 1. Structure
-- ---------------------------------------------------------------------------

alter table public.vendor_quotations alter column project_id drop not null;
alter table public.purchase_vendor_selections alter column project_id drop not null;
alter table public.vendor_followups alter column project_id drop not null;
alter table public.purchase_payment_coordination alter column project_id drop not null;

alter table public.vendors
  add column if not exists created_by_user uuid references public.user_profiles(id),
  add column if not exists status_changed_by uuid references public.user_profiles(id),
  add column if not exists status_changed_at timestamptz;
drop index if exists public.vendors_name_mobile_idx;
create unique index vendors_name_mobile_idx on public.vendors (lower(btrim(name)), right(regexp_replace(coalesce(mobile, ''), '[^0-9]', '', 'g'), 10));

alter table public.vendor_quotations add column if not exists created_by_user uuid references public.user_profiles(id);
create unique index if not exists vendor_quotations_request_vendor_number_idx
  on public.vendor_quotations (purchase_request_id, vendor_id, lower(btrim(quotation_number)));

alter table public.purchase_vendor_selections add column if not exists selected_by_user uuid references public.user_profiles(id),
  add column if not exists created_at_ts timestamptz not null default clock_timestamp();

alter table public.vendor_followups add column if not exists created_by_user uuid references public.user_profiles(id),
  add column if not exists contact_mode text;

alter table public.purchase_receipts
  add column if not exists received_by_user uuid references public.user_profiles(id),
  add column if not exists corrective_action text,
  add column if not exists verified_by uuid references public.user_profiles(id),
  add column if not exists verified_at timestamptz;
create unique index if not exists purchase_receipts_grn_number_idx on public.purchase_receipts (grn_number) where grn_number is not null;

alter table public.purchase_payment_coordination
  add column if not exists recorded_by_user uuid references public.user_profiles(id),
  add column if not exists verified_by_user uuid references public.user_profiles(id),
  add column if not exists verified_at timestamptz,
  add column if not exists verification_remarks text;
create unique index if not exists purchase_payment_coordination_one_invoice_idx on public.purchase_payment_coordination (purchase_request_id);

create table if not exists public.purchase_dispatches (
  id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid not null references public.purchase_requests(id),
  purchase_order_id uuid references public.purchase_orders(id),
  transporter text,
  vehicle_number text,
  tracking_number text,
  dispatch_date date,
  expected_arrival date,
  notes text,
  recorded_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists purchase_dispatches_req_idx on public.purchase_dispatches (purchase_request_id);

create table if not exists public.purchase_payments (
  id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid not null references public.purchase_requests(id),
  invoice_id uuid not null references public.purchase_payment_coordination(id),
  amount numeric(14,2) not null check (amount > 0),
  paid_on date not null,
  payment_mode text not null,
  reference text not null,
  recorded_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
create unique index if not exists purchase_payments_reference_idx on public.purchase_payments (invoice_id, lower(btrim(reference)));

alter table public.purchase_dispatches enable row level security;
alter table public.purchase_payments enable row level security;
revoke all on public.purchase_dispatches, public.purchase_payments from anon, authenticated;
grant select on public.purchase_dispatches, public.purchase_payments to authenticated;
drop policy if exists purchase_dispatches_select on public.purchase_dispatches;
create policy purchase_dispatches_select on public.purchase_dispatches for select to authenticated using (public.proc_can_view_request(purchase_request_id));
drop policy if exists purchase_payments_select on public.purchase_payments;
create policy purchase_payments_select on public.purchase_payments for select to authenticated
  using (public.proc_can_view_request(purchase_request_id) and (public.proc_is_accounts() or public.proc_is_procurement_member() or public.staff_has_global_oversight()));

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------

create or replace function public.proc_is_procurement_head()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.proc_is_procurement_member() and public.staff_current_role_code() = 'dept_head', false);
$$;

create or replace function public.proc_accounts_users()
returns uuid[] language sql stable security definer set search_path to 'public' as $$
  select coalesce(array_agg(up.id), '{}') from public.user_profiles up join public.roles r on r.id = up.role_id
   where up.is_active and (r.code in ('accounts_head', 'accounts_employee', 'cfo') or up.department_id = (select id from public.departments where code = 'ACCOUNTS'));
$$;

create or replace function public.proc_godown_users()
returns uuid[] language sql stable security definer set search_path to 'public' as $$
  select coalesce(array_agg(up.id), '{}') from public.user_profiles up where up.is_active and up.department_id = public.retail_godown_dept_id();
$$;

-- Everyone who follows a request: its requester, the requesting department's Heads and the Procurement team.
create or replace function public.proc_followers(p_row public.purchase_requests)
returns uuid[] language sql stable security definer set search_path to 'public' as $$
  select coalesce(array_agg(distinct x), '{}') from unnest(array[p_row.requester_user_id] || public.proc_department_heads(p_row.requesting_department_id)
    || public.proc_procurement_team()) x where x is not null;
$$;

create or replace function public.proc_lock_request(p_request_id uuid)
returns public.purchase_requests language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests;
begin
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null or v_row.proc_status = 'LEGACY' then raise exception 'Request not found'; end if;
  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Vendors
-- ---------------------------------------------------------------------------

create or replace function public.proc_save_vendor(
  p_vendor_id uuid, p_name text, p_contact_person text, p_mobile text, p_email text, p_address text, p_gstin text, p_pan text,
  p_categories text, p_payment_terms text, p_credit_period text, p_lead_time text, p_notes text)
returns public.vendors language plpgsql security definer set search_path to 'public' as $$
declare v_row public.vendors; v_phone text := regexp_replace(coalesce(p_mobile, ''), '[^0-9+]', '', 'g');
  v_gstin text := nullif(upper(btrim(coalesce(p_gstin, ''))), ''); v_pan text := nullif(upper(btrim(coalesce(p_pan, ''))), ''); v_dup text;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_member() or public.staff_has_global_oversight(), false) then raise exception 'Only Procurement can maintain vendors'; end if;
  if btrim(coalesce(p_name, '')) = '' then raise exception 'Company name is required'; end if;
  if length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 10 and 13 then raise exception 'Mobile must be a valid phone number'; end if;
  if v_gstin is not null and v_gstin !~ '^[0-9]{2}[A-Z0-9]{13}$' then raise exception 'GSTIN must be 15 characters'; end if;
  if v_pan is not null and v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then raise exception 'PAN must look like ABCDE1234F'; end if;
  if nullif(btrim(coalesce(p_email, '')), '') is not null and p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Email is not valid'; end if;
  select name into v_dup from public.vendors where id is distinct from p_vendor_id and (
      (v_gstin is not null and gstin = v_gstin)
      or (lower(btrim(name)) = lower(btrim(p_name)) and right(regexp_replace(coalesce(mobile, ''), '[^0-9]', '', 'g'), 10) = right(regexp_replace(v_phone, '[^0-9]', '', 'g'), 10))) limit 1;
  if v_dup is not null then raise exception 'This vendor already exists as %', v_dup; end if;

  if p_vendor_id is null then
    insert into public.vendors (vendor_code, name, contact_person, mobile, email, address, gstin, pan, product_service_category, payment_terms,
      credit_period, lead_time, notes, approved_status, blacklisted, created_by_user)
    values (public.proc_next_number('V'), btrim(p_name), p_contact_person, v_phone, nullif(btrim(coalesce(p_email, '')), ''), p_address, v_gstin, v_pan,
      p_categories, p_payment_terms, p_credit_period, p_lead_time, p_notes, 'Pending Review', false, auth.uid())
    returning * into v_row;
    perform public.staff_write_audit('vendor', v_row.id, 'CREATE', null, to_jsonb(v_row), public.factory_procurement_dept_id(), null);
  else
    update public.vendors set name = btrim(p_name), contact_person = p_contact_person, mobile = v_phone, email = nullif(btrim(coalesce(p_email, '')), ''),
      address = p_address, gstin = v_gstin, pan = v_pan, product_service_category = p_categories, payment_terms = p_payment_terms,
      credit_period = p_credit_period, lead_time = p_lead_time, notes = p_notes, updated_at = now()
     where id = p_vendor_id returning * into v_row;
    if v_row.id is null then raise exception 'Vendor not found'; end if;
    perform public.staff_write_audit('vendor', v_row.id, 'UPDATE', null, to_jsonb(v_row), public.factory_procurement_dept_id(), null);
  end if;
  return v_row;
end $$;

-- Approve, block (with reason) or reactivate. Only the Procurement Head or Management.
create or replace function public.proc_set_vendor_status(p_vendor_id uuid, p_status text, p_reason text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_old public.vendors; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_head() or public.staff_has_global_oversight(), false) then
    raise exception 'Only the Procurement Head or Management can approve or block vendors';
  end if;
  if p_status not in ('Approved', 'Blocked') then raise exception 'Status must be Approved or Blocked'; end if;
  if p_status = 'Blocked' and v_reason is null then raise exception 'A reason is required to block a vendor'; end if;
  select * into v_old from public.vendors where id = p_vendor_id for update;
  if v_old.id is null then raise exception 'Vendor not found'; end if;
  update public.vendors set approved_status = p_status, blacklisted = (p_status = 'Blocked'), blacklist_reason = case when p_status = 'Blocked' then v_reason end,
    status_changed_by = auth.uid(), status_changed_at = now(), updated_at = now()
   where id = p_vendor_id;
  perform public.staff_write_audit('vendor', p_vendor_id, 'STATUS_' || upper(p_status), jsonb_build_object('approved_status', v_old.approved_status),
    jsonb_build_object('approved_status', p_status), public.factory_procurement_dept_id(), v_reason);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Quotations, comparison, vendor selection
-- ---------------------------------------------------------------------------

create or replace function public.proc_add_quotation(
  p_request_id uuid, p_vendor_id uuid, p_quotation_number text, p_quotation_date date, p_validity_date date, p_material_rate numeric,
  p_labour_rate numeric, p_other_charges numeric, p_tax numeric, p_transport numeric, p_installation numeric, p_lead_time_days integer,
  p_payment_terms text, p_warranty text, p_quality_rating numeric)
returns public.vendor_quotations language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_q public.vendor_quotations; v_total numeric;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_member(), false) then raise exception 'Only Procurement can record quotations'; end if;
  v_row := public.proc_lock_request(p_request_id);
  if v_row.proc_status not in ('ACCEPTED_BY_PROCUREMENT', 'DOCUMENT_GENERATED') then raise exception 'Quotations are collected after Procurement accepts the request and before the order'; end if;
  if not exists (select 1 from public.vendors where id = p_vendor_id and not coalesce(blacklisted, false)) then raise exception 'Choose an active vendor'; end if;
  if btrim(coalesce(p_quotation_number, '')) = '' then raise exception 'Quotation number is required'; end if;
  if p_quotation_date is null then raise exception 'Quotation date is required'; end if;
  if p_validity_date is not null and p_validity_date < p_quotation_date then raise exception 'Validity cannot end before the quotation date'; end if;
  if coalesce(p_material_rate, 0) < 0 or coalesce(p_labour_rate, 0) < 0 or coalesce(p_other_charges, 0) < 0 or coalesce(p_tax, 0) < 0
     or coalesce(p_transport, 0) < 0 or coalesce(p_installation, 0) < 0 then raise exception 'Amounts cannot be negative'; end if;
  v_total := coalesce(p_material_rate, 0) + coalesce(p_labour_rate, 0) + coalesce(p_other_charges, 0) + coalesce(p_tax, 0) + coalesce(p_transport, 0) + coalesce(p_installation, 0);
  if v_total <= 0 then raise exception 'The quotation total must be more than zero'; end if;
  if p_quality_rating is not null and p_quality_rating not between 1 and 5 then raise exception 'Quality rating must be 1 to 5'; end if;
  insert into public.vendor_quotations (project_id, purchase_request_id, vendor_id, quotation_number, quotation_date, validity_date, material_rate, labour_rate,
    other_charges, tax, transport, installation, lead_time_days, payment_terms, warranty, quality_rating, created_by_user)
  values (v_row.project_id, p_request_id, p_vendor_id, btrim(p_quotation_number), p_quotation_date, p_validity_date, p_material_rate, p_labour_rate,
    p_other_charges, p_tax, p_transport, p_installation, p_lead_time_days, p_payment_terms, p_warranty, p_quality_rating, auth.uid())
  returning * into v_q;
  perform public.staff_write_audit('vendor_quotation', v_q.id, 'CREATE', null, to_jsonb(v_q), v_row.requesting_department_id, null);
  return v_q;
end $$;

-- Pick the quotation the order will follow. Choosing anything but the cheapest valid quotation needs a written justification.
create or replace function public.proc_select_quotation(p_request_id uuid, p_quotation_id uuid, p_reason text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_q public.vendor_quotations; v_lowest numeric; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_authorized(), false) then raise exception 'Only an authorised Procurement user can select the vendor'; end if;
  v_row := public.proc_lock_request(p_request_id);
  if v_row.proc_status not in ('ACCEPTED_BY_PROCUREMENT', 'DOCUMENT_GENERATED') then raise exception 'The vendor is selected before the order is placed'; end if;
  select * into v_q from public.vendor_quotations where id = p_quotation_id and purchase_request_id = p_request_id;
  if v_q.id is null then raise exception 'Quotation not found for this request'; end if;
  if v_q.validity_date is not null and v_q.validity_date < (now() at time zone 'Asia/Kolkata')::date then raise exception 'This quotation has expired'; end if;
  select min(total_landed_cost) into v_lowest from public.vendor_quotations
   where purchase_request_id = p_request_id and (validity_date is null or validity_date >= (now() at time zone 'Asia/Kolkata')::date);
  if v_q.total_landed_cost > v_lowest and v_reason is null then raise exception 'This is not the lowest quotation: write why it was chosen'; end if;
  insert into public.purchase_vendor_selections (project_id, purchase_request_id, selected_vendor_id, selected_quotation_id, selection_reason, approved_amount,
    approval_date, is_lowest_bid, justification_text, selected_by_user)
  values (v_row.project_id, p_request_id, v_q.vendor_id, v_q.id, v_reason, v_q.total_landed_cost, (now() at time zone 'Asia/Kolkata')::date,
    v_q.total_landed_cost <= v_lowest, v_reason, auth.uid());
  perform public.staff_write_audit('purchase_request', p_request_id, 'VENDOR_SELECTED', null,
    jsonb_build_object('quotation_id', v_q.id, 'vendor_id', v_q.vendor_id, 'amount', v_q.total_landed_cost), v_row.requesting_department_id, v_reason);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Follow-ups, order progress, vendor dispatch
-- ---------------------------------------------------------------------------

create or replace function public.proc_add_followup(p_request_id uuid, p_notes text, p_contact_mode text, p_next_date date, p_escalate boolean)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_vendor uuid;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_member(), false) then raise exception 'Only Procurement can record vendor follow-ups'; end if;
  v_row := public.proc_lock_request(p_request_id);
  if v_row.proc_status not in ('ACCEPTED_BY_PROCUREMENT', 'DOCUMENT_GENERATED', 'ORDER_PLACED', 'VENDOR_CONFIRMED', 'IN_PRODUCTION', 'READY_FOR_DISPATCH',
                               'IN_TRANSIT', 'DELAYED', 'PARTIALLY_RECEIVED') then
    raise exception 'Follow-ups are recorded while the purchase is open with a vendor';
  end if;
  if btrim(coalesce(p_notes, '')) = '' then raise exception 'Write what was discussed'; end if;
  if p_next_date is not null and p_next_date < (now() at time zone 'Asia/Kolkata')::date then raise exception 'The next follow-up date cannot be in the past'; end if;
  select vendor_id into v_vendor from public.purchase_orders where purchase_request_id = p_request_id and is_current;
  insert into public.vendor_followups (project_id, purchase_request_id, vendor_id, follow_up_date, next_follow_up_date, notes, escalation_status, created_by_user, contact_mode)
  values (v_row.project_id, p_request_id, v_vendor, (now() at time zone 'Asia/Kolkata')::date, p_next_date, btrim(p_notes),
    case when coalesce(p_escalate, false) then 'Escalated' else 'Open' end, auth.uid(), p_contact_mode);
  if coalesce(p_escalate, false) then
    perform public.proc_notify_users(public.proc_management_users() || public.proc_department_heads(public.factory_procurement_dept_id()), p_request_id,
      'Vendor escalation on ' || v_row.request_number || ': ' || btrim(p_notes), 'વેન્ડર એસ્કેલેશન: ' || v_row.request_number);
  end if;
end $$;

-- Vendor confirmed -> in production -> ready -> in transit, or delayed, with dispatch details when goods leave the vendor.
create or replace function public.proc_update_progress(
  p_request_id uuid, p_to_status text, p_remarks text, p_transporter text default null, p_vehicle_number text default null,
  p_tracking_number text default null, p_dispatch_date date default null, p_expected_arrival date default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_po uuid; v_ok boolean; v_remarks text := nullif(btrim(coalesce(p_remarks, '')), '');
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_member(), false) then raise exception 'Only Procurement can update order progress'; end if;
  v_row := public.proc_lock_request(p_request_id);
  v_ok := case v_row.proc_status
    when 'ORDER_PLACED' then p_to_status in ('VENDOR_CONFIRMED', 'IN_PRODUCTION', 'READY_FOR_DISPATCH', 'IN_TRANSIT', 'DELAYED')
    when 'VENDOR_CONFIRMED' then p_to_status in ('IN_PRODUCTION', 'READY_FOR_DISPATCH', 'IN_TRANSIT', 'DELAYED')
    when 'IN_PRODUCTION' then p_to_status in ('READY_FOR_DISPATCH', 'IN_TRANSIT', 'DELAYED')
    when 'READY_FOR_DISPATCH' then p_to_status in ('IN_TRANSIT', 'DELAYED')
    when 'IN_TRANSIT' then p_to_status in ('DELAYED')
    when 'DELAYED' then p_to_status in ('VENDOR_CONFIRMED', 'IN_PRODUCTION', 'READY_FOR_DISPATCH', 'IN_TRANSIT')
    when 'PARTIALLY_RECEIVED' then p_to_status in ('IN_TRANSIT', 'DELAYED')
    else false end;
  if not v_ok then raise exception 'Cannot move from % to %', v_row.proc_status, p_to_status; end if;
  if p_to_status = 'DELAYED' and v_remarks is null then raise exception 'Write the reason for the delay'; end if;
  if p_to_status = 'IN_TRANSIT' then
    if btrim(coalesce(p_transporter, '')) = '' and btrim(coalesce(p_tracking_number, '')) = '' then raise exception 'Give the transporter or a tracking number'; end if;
    if p_expected_arrival is null then raise exception 'Expected arrival date is required'; end if;
    if p_dispatch_date is not null and p_expected_arrival < p_dispatch_date then raise exception 'Arrival cannot be before dispatch'; end if;
    select id into v_po from public.purchase_orders where purchase_request_id = p_request_id and is_current;
    insert into public.purchase_dispatches (purchase_request_id, purchase_order_id, transporter, vehicle_number, tracking_number, dispatch_date, expected_arrival, notes, recorded_by)
    values (p_request_id, v_po, nullif(btrim(coalesce(p_transporter, '')), ''), nullif(btrim(coalesce(p_vehicle_number, '')), ''),
      nullif(btrim(coalesce(p_tracking_number, '')), ''), coalesce(p_dispatch_date, (now() at time zone 'Asia/Kolkata')::date), p_expected_arrival, v_remarks, auth.uid());
  end if;
  perform public.proc_set_status(p_request_id, v_row.proc_status, p_to_status, v_remarks);
  if p_to_status in ('IN_TRANSIT', 'DELAYED') then
    perform public.proc_notify_users(public.proc_followers(v_row) || public.proc_godown_users(), p_request_id,
      case p_to_status when 'IN_TRANSIT' then 'On the way: ' || v_row.request_number || ' ' || v_row.material_name || ', expected ' || to_char(p_expected_arrival, 'DD Mon YYYY')
                       else 'Delayed: ' || v_row.request_number || ' ' || v_row.material_name || ' - ' || v_remarks end,
      case p_to_status when 'IN_TRANSIT' then 'રસ્તામાં: ' || v_row.request_number else 'વિલંબ: ' || v_row.request_number end);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Goods receipt (GRN): partial and full, rejections, verification
-- ---------------------------------------------------------------------------

create or replace function public.proc_record_grn(
  p_request_id uuid, p_received_qty numeric, p_accepted_qty numeric, p_rejected_qty numeric, p_damaged_qty numeric, p_receipt_location text,
  p_qc_remarks text, p_rejection_reason text, p_corrective_action text, p_replacement_required boolean)
returns public.purchase_receipts language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_po public.purchase_orders; v_done numeric; v_outstanding numeric; v_rec public.purchase_receipts; v_to text;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.staff_is_godown_staff() or public.proc_is_procurement_authorized(), false) then
    raise exception 'Goods are received by Godown (or an authorised Procurement user)';
  end if;
  v_row := public.proc_lock_request(p_request_id);
  if v_row.proc_status not in ('ORDER_PLACED', 'VENDOR_CONFIRMED', 'IN_PRODUCTION', 'READY_FOR_DISPATCH', 'IN_TRANSIT', 'DELAYED', 'PARTIALLY_RECEIVED') then
    raise exception 'Goods can be received only for an open order';
  end if;
  select * into v_po from public.purchase_orders where purchase_request_id = p_request_id and is_current;
  if p_received_qty is null or p_received_qty <= 0 then raise exception 'Received quantity must be more than zero'; end if;
  if coalesce(p_accepted_qty, -1) < 0 or coalesce(p_rejected_qty, -1) < 0 then raise exception 'Accepted and rejected quantities are required'; end if;
  if p_accepted_qty + p_rejected_qty <> p_received_qty then raise exception 'Accepted plus rejected must equal received'; end if;
  if coalesce(p_damaged_qty, 0) < 0 or coalesce(p_damaged_qty, 0) > p_rejected_qty then raise exception 'Damaged quantity must be part of the rejected quantity'; end if;
  if p_rejected_qty > 0 and btrim(coalesce(p_rejection_reason, '')) = '' then raise exception 'Give the reason for rejecting material'; end if;
  if btrim(coalesce(p_receipt_location, '')) = '' then raise exception 'Receipt location is required'; end if;
  select coalesce(sum(qty_accepted), 0) into v_done from public.purchase_receipts where purchase_request_id = p_request_id;
  v_outstanding := v_po.ordered_quantity - v_done;
  if p_accepted_qty > v_outstanding then raise exception 'Only % is still outstanding on this order', v_outstanding; end if;

  insert into public.purchase_receipts (project_id, purchase_request_id, po_id, grn_number, receipt_location, receipt_date, qty_ordered, qty_received,
    qty_accepted, qty_rejected, qty_short, damage_qty, qc_status, qc_remarks, rejection_reason, replacement_required, received_by_user, corrective_action)
  values (v_row.project_id, p_request_id, v_po.id, public.proc_next_number('GRN'), btrim(p_receipt_location), (now() at time zone 'Asia/Kolkata')::date,
    v_po.ordered_quantity, p_received_qty, p_accepted_qty, p_rejected_qty, v_outstanding - p_accepted_qty, coalesce(p_damaged_qty, 0),
    case when p_rejected_qty > 0 then 'Partly rejected' else 'Accepted' end, p_qc_remarks, nullif(btrim(coalesce(p_rejection_reason, '')), ''),
    coalesce(p_replacement_required, false), auth.uid(), nullif(btrim(coalesce(p_corrective_action, '')), ''))
  returning * into v_rec;

  v_to := case when v_done + p_accepted_qty >= v_po.ordered_quantity then 'RECEIVED' else 'PARTIALLY_RECEIVED' end;
  if v_to <> v_row.proc_status then perform public.proc_set_status(p_request_id, v_row.proc_status, v_to, v_rec.grn_number); end if;
  perform public.staff_write_audit('purchase_receipt', v_rec.id, 'GRN', null, to_jsonb(v_rec), v_row.requesting_department_id, null);
  perform public.proc_notify_users(public.proc_followers(v_row), p_request_id,
    case when v_to = 'RECEIVED' then 'Received in full: ' else 'Partly received: ' end || v_row.request_number || ' ' || v_row.material_name
      || ' (' || (v_done + p_accepted_qty) || ' of ' || v_po.ordered_quantity || ' ' || v_row.unit || ' accepted' || case when p_rejected_qty > 0 then ', ' || p_rejected_qty || ' rejected' else '' end || ')',
    'માલ પ્રાપ્ત: ' || v_row.request_number);
  return v_rec;
end $$;

create or replace function public.proc_verify_grn(p_request_id uuid, p_remarks text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests;
begin
  perform public.staff_assert_operational();
  if not coalesce((public.staff_is_godown_staff() and public.staff_current_role_code() in ('dept_head', 'supervisor')) or public.proc_is_procurement_head(), false) then
    raise exception 'GRN is verified by the Godown Head/Supervisor or the Procurement Head';
  end if;
  v_row := public.proc_lock_request(p_request_id);
  if v_row.proc_status <> 'RECEIVED' then raise exception 'Only a fully received order can be verified'; end if;
  if exists (select 1 from public.purchase_receipts where purchase_request_id = p_request_id and received_by_user = auth.uid()) and not public.proc_is_procurement_head() then
    raise exception 'The person who received the goods cannot also verify the GRN';
  end if;
  update public.purchase_receipts set verified_by = auth.uid(), verified_at = now() where purchase_request_id = p_request_id and verified_at is null;
  perform public.proc_set_status(p_request_id, 'RECEIVED', 'GRN_VERIFIED', p_remarks);
  perform public.proc_notify_users(public.proc_followers(v_row) || public.proc_accounts_users(), p_request_id,
    'Goods received and verified: ' || v_row.request_number || ' ' || v_row.material_name, 'માલ પ્રાપ્ત અને ચકાસાયો: ' || v_row.request_number);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Invoice, payment, closing
-- ---------------------------------------------------------------------------

create or replace function public.proc_record_invoice(p_request_id uuid, p_invoice_number text, p_invoice_date date, p_amount numeric, p_tax numeric, p_due_date date)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_id uuid;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_member(), false) then raise exception 'Only Procurement records vendor invoices'; end if;
  v_row := public.proc_lock_request(p_request_id);
  if v_row.proc_status <> 'GRN_VERIFIED' then raise exception 'The invoice is recorded after the GRN is verified'; end if;
  if exists (select 1 from public.purchase_payment_coordination where purchase_request_id = p_request_id) then raise exception 'An invoice is already recorded for this request'; end if;
  if btrim(coalesce(p_invoice_number, '')) = '' or p_invoice_date is null or p_due_date is null then raise exception 'Invoice number, invoice date and due date are required'; end if;
  if p_amount is null or p_amount <= 0 or coalesce(p_tax, 0) < 0 then raise exception 'Invoice amount must be more than zero and tax cannot be negative'; end if;
  if p_due_date < p_invoice_date then raise exception 'Due date cannot be before the invoice date'; end if;
  insert into public.purchase_payment_coordination (project_id, purchase_request_id, invoice_number, invoice_date, invoice_amount, tax_amount, paid_amount,
    pending_amount, due_date, status, payment_request_date, submitted_to_accounts, accounts_acknowledgement, recorded_by_user)
  values (v_row.project_id, p_request_id, btrim(p_invoice_number), p_invoice_date, p_amount, coalesce(p_tax, 0), 0, p_amount + coalesce(p_tax, 0), p_due_date,
    'Submitted to Accounts', (now() at time zone 'Asia/Kolkata')::date, true, false, auth.uid())
  returning id into v_id;
  perform public.staff_write_audit('purchase_invoice', v_id, 'CREATE', null, jsonb_build_object('invoice_number', p_invoice_number, 'amount', p_amount, 'tax', p_tax), v_row.requesting_department_id, null);
  perform public.proc_notify_users(public.proc_accounts_users(), p_request_id,
    'Invoice to verify: ' || v_row.request_number || ', ' || btrim(p_invoice_number) || ', Rs ' || (p_amount + coalesce(p_tax, 0)), 'ઇન્વોઇસ ચકાસો: ' || v_row.request_number);
end $$;

-- Accounts compares the invoice with the purchase order. An invoice above the order value needs a written reason.
create or replace function public.proc_verify_invoice(p_request_id uuid, p_decision text, p_remarks text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_inv public.purchase_payment_coordination; v_po numeric; v_remarks text := nullif(btrim(coalesce(p_remarks, '')), '');
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_accounts(), false) then raise exception 'Only Accounts can verify invoices'; end if;
  v_row := public.proc_lock_request(p_request_id);
  if v_row.proc_status <> 'GRN_VERIFIED' then raise exception 'No invoice is waiting for verification'; end if;
  select * into v_inv from public.purchase_payment_coordination where purchase_request_id = p_request_id for update;
  if v_inv.id is null then raise exception 'Procurement has not recorded the invoice yet'; end if;
  select total_order_value into v_po from public.purchase_orders where purchase_request_id = p_request_id and is_current;
  if p_decision = 'REJECT' then
    if v_remarks is null then raise exception 'A reason is required'; end if;
    delete from public.purchase_payment_coordination where id = v_inv.id;
    perform public.staff_write_audit('purchase_invoice', v_inv.id, 'REJECTED', to_jsonb(v_inv), null, v_row.requesting_department_id, v_remarks);
    perform public.proc_notify_users(public.proc_procurement_team(), p_request_id, 'Accounts rejected the invoice for ' || v_row.request_number || ': ' || v_remarks, 'ઇન્વોઇસ નામંજૂર: ' || v_row.request_number);
    return;
  end if;
  if p_decision <> 'APPROVE' then raise exception 'Decision must be APPROVE or REJECT'; end if;
  if v_inv.invoice_amount > v_po and v_remarks is null then raise exception 'The invoice is above the order value: write why it is accepted'; end if;
  update public.purchase_payment_coordination set verified_by_user = auth.uid(), verified_at = now(), verification_remarks = v_remarks,
    accounts_acknowledgement = true, status = 'Payment Pending', updated_at = now() where id = v_inv.id;
  perform public.proc_set_status(p_request_id, 'GRN_VERIFIED', 'INVOICE_VERIFIED', v_remarks);
  perform public.proc_set_status(p_request_id, 'INVOICE_VERIFIED', 'PAYMENT_PENDING', null);
end $$;

create or replace function public.proc_record_payment(p_request_id uuid, p_amount numeric, p_paid_on date, p_payment_mode text, p_reference text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_inv public.purchase_payment_coordination; v_paid numeric; v_due numeric; v_to text;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_accounts(), false) then raise exception 'Only Accounts can record payments'; end if;
  v_row := public.proc_lock_request(p_request_id);
  if v_row.proc_status not in ('PAYMENT_PENDING', 'PARTIALLY_PAID') then raise exception 'This request is not waiting for payment'; end if;
  select * into v_inv from public.purchase_payment_coordination where purchase_request_id = p_request_id for update;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if p_paid_on is null or btrim(coalesce(p_payment_mode, '')) = '' or btrim(coalesce(p_reference, '')) = '' then raise exception 'Payment date, mode and reference are required'; end if;
  v_due := v_inv.invoice_amount + coalesce(v_inv.tax_amount, 0);
  v_paid := coalesce(v_inv.paid_amount, 0) + p_amount;
  if v_paid > v_due then raise exception 'This is more than the Rs % still due', v_due - coalesce(v_inv.paid_amount, 0); end if;
  insert into public.purchase_payments (purchase_request_id, invoice_id, amount, paid_on, payment_mode, reference, recorded_by)
  values (p_request_id, v_inv.id, p_amount, p_paid_on, btrim(p_payment_mode), btrim(p_reference), auth.uid());
  v_to := case when v_paid >= v_due then 'PAID' else 'PARTIALLY_PAID' end;
  update public.purchase_payment_coordination set paid_amount = v_paid, pending_amount = v_due - v_paid, payment_reference = btrim(p_reference),
    status = case when v_to = 'PAID' then 'Paid' else 'Partially Paid' end, final_settlement_status = case when v_to = 'PAID' then 'Settled' end, updated_at = now()
   where id = v_inv.id;
  if v_to <> v_row.proc_status then perform public.proc_set_status(p_request_id, v_row.proc_status, v_to, 'Rs ' || p_amount || ' ' || btrim(p_reference)); end if;
  perform public.staff_write_audit('purchase_payment', v_inv.id, 'PAYMENT', null, jsonb_build_object('amount', p_amount, 'reference', p_reference, 'paid_total', v_paid), v_row.requesting_department_id, null);
  perform public.proc_notify_users(public.proc_procurement_team(), p_request_id,
    case when v_to = 'PAID' then 'Paid in full: ' else 'Part payment made: ' end || v_row.request_number || ' (Rs ' || v_paid || ' of ' || v_due || ')', 'ચુકવણી: ' || v_row.request_number);
end $$;

create or replace function public.proc_close_request(p_request_id uuid, p_remarks text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_authorized(), false) then raise exception 'Only an authorised Procurement user can close a purchase'; end if;
  v_row := public.proc_lock_request(p_request_id);
  if v_row.proc_status <> 'PAID' then raise exception 'Only a fully paid purchase can be closed'; end if;
  if v_row.is_emergency and v_row.emergency_reviewed_at is null then raise exception 'An emergency purchase needs Management''s post-purchase review before closing'; end if;
  perform public.proc_set_status(p_request_id, 'PAID', 'CLOSED', p_remarks);
  perform public.proc_notify_users(array[v_row.requester_user_id], p_request_id, 'Purchase closed: ' || v_row.request_number, 'ખરીદી બંધ: ' || v_row.request_number);
end $$;

-- ---------------------------------------------------------------------------
-- 8. Emergency procurement
-- ---------------------------------------------------------------------------

-- Management approves (straight to Procurement) or rejects an emergency request, and reviews it after the purchase.
create or replace function public.proc_emergency_decision(p_request_id uuid, p_decision text, p_remarks text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_remarks text := nullif(btrim(coalesce(p_remarks, '')), '');
begin
  perform public.staff_assert_operational();
  if not coalesce(public.staff_has_global_oversight(), false) then raise exception 'Only Management can decide an emergency purchase'; end if;
  v_row := public.proc_lock_request(p_request_id);
  if v_row.proc_status <> 'EMERGENCY_APPROVAL_PENDING' then raise exception 'This request is not waiting for emergency approval'; end if;
  if v_row.requester_user_id = auth.uid() then raise exception 'You cannot approve your own request'; end if;
  if p_decision = 'REJECT' and v_remarks is null then raise exception 'A reason is required'; end if;
  update public.purchase_requests set emergency_decided_by = auth.uid(), emergency_decided_at = now(),
    dept_decided_by = auth.uid(), dept_decided_at = now(), dept_decision_remarks = v_remarks where id = p_request_id;
  if p_decision = 'APPROVE' then
    perform public.proc_set_status(p_request_id, 'EMERGENCY_APPROVAL_PENDING', 'SENT_TO_PROCUREMENT', coalesce(v_remarks, 'Emergency approved'));
    update public.purchase_requests set sent_to_procurement_at = now() where id = p_request_id;
    perform public.proc_notify_users(public.proc_procurement_team() || public.proc_department_heads(v_row.requesting_department_id) || array[v_row.requester_user_id], p_request_id,
      'EMERGENCY approved, now with Procurement: ' || v_row.request_number || ' ' || v_row.material_name, 'તાત્કાલિક ખરીદી મંજૂર: ' || v_row.request_number);
  elsif p_decision = 'REJECT' then
    perform public.proc_set_status(p_request_id, 'EMERGENCY_APPROVAL_PENDING', 'EMERGENCY_REJECTED', v_remarks);
    perform public.proc_notify_users(array[v_row.requester_user_id], p_request_id, 'Emergency request ' || v_row.request_number || ' rejected: ' || v_remarks,
      'તાત્કાલિક વિનંતી નામંજૂર: ' || v_row.request_number);
  else
    raise exception 'Decision must be APPROVE or REJECT';
  end if;
end $$;

create or replace function public.proc_review_emergency(p_request_id uuid, p_note text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.staff_has_global_oversight(), false) then raise exception 'Only Management reviews emergency purchases'; end if;
  v_row := public.proc_lock_request(p_request_id);
  if not v_row.is_emergency then raise exception 'This is not an emergency purchase'; end if;
  if v_row.order_confirmed_at is null then raise exception 'The review is done after the order is placed'; end if;
  if btrim(coalesce(p_note, '')) = '' then raise exception 'Write the review'; end if;
  update public.purchase_requests set emergency_review_note = btrim(p_note), emergency_reviewed_by = auth.uid(), emergency_reviewed_at = now() where id = p_request_id;
  perform public.staff_write_audit('purchase_request', p_request_id, 'EMERGENCY_REVIEW', null, jsonb_build_object('note', p_note), v_row.requesting_department_id, null);
end $$;

-- ---------------------------------------------------------------------------
-- 9. Godown / Factory low stock -> purchase requests
-- ---------------------------------------------------------------------------

-- Raises one request per raw material at or below its reorder level that has no open request yet. It goes through the
-- caller's Department Head like any other request.
create or replace function public.proc_raise_low_stock_requests()
returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_m record; v_n integer := 0; v_dept uuid := public.staff_current_department_id(); v_open boolean;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.staff_is_godown_staff() or public.staff_is_factory_staff(), false) then raise exception 'Only Godown or Factory staff can raise low-stock requests'; end if;
  for v_m in
    select m.material_name, m.unit, m.reorder_level, coalesce(sum(s.quantity_on_hand - s.reserved_quantity), 0) as available
      from public.factory_materials m left join public.factory_material_stock s on s.material_id = m.id
     where m.is_active and coalesce(m.reorder_level, 0) > 0 and not coalesce(m.is_test_data, false)
     group by m.id, m.material_name, m.unit, m.reorder_level
    having coalesce(sum(s.quantity_on_hand - s.reserved_quantity), 0) <= m.reorder_level
  loop
    select exists (select 1 from public.purchase_requests where requesting_department_id = v_dept and lower(material_name) = lower(v_m.material_name)
      and proc_status not in ('LEGACY', 'REJECTED_BY_DEPT_HEAD', 'REJECTED_BY_PROCUREMENT', 'EMERGENCY_REJECTED', 'CANCELLED', 'CLOSED', 'RECEIVED', 'GRN_VERIFIED',
                              'INVOICE_VERIFIED', 'PAYMENT_PENDING', 'PARTIALLY_PAID', 'PAID')) into v_open;
    if not v_open then
      perform public.proc_create_request(null, v_m.material_name, 'Raw material', 'Low stock: ' || v_m.available || ' ' || coalesce(v_m.unit, '') || ' left, reorder level ' || v_m.reorder_level,
        greatest(v_m.reorder_level * 2 - v_m.available, 1), coalesce(nullif(v_m.unit, ''), 'unit'), (now() at time zone 'Asia/Kolkata')::date + 7, 'HIGH',
        'Raised automatically from the low-stock check', 'Godown', 'RAW_MATERIAL');
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- 10. Grants, realtime
-- ---------------------------------------------------------------------------

revoke all on function public.proc_accounts_users(), public.proc_godown_users(), public.proc_followers(public.purchase_requests),
  public.proc_lock_request(uuid) from public, anon, authenticated;
revoke all on function public.proc_is_procurement_head(), public.proc_save_vendor(uuid, text, text, text, text, text, text, text, text, text, text, text, text),
  public.proc_set_vendor_status(uuid, text, text),
  public.proc_add_quotation(uuid, uuid, text, date, date, numeric, numeric, numeric, numeric, numeric, numeric, integer, text, text, numeric),
  public.proc_select_quotation(uuid, uuid, text), public.proc_add_followup(uuid, text, text, date, boolean),
  public.proc_update_progress(uuid, text, text, text, text, text, date, date),
  public.proc_record_grn(uuid, numeric, numeric, numeric, numeric, text, text, text, text, boolean), public.proc_verify_grn(uuid, text),
  public.proc_record_invoice(uuid, text, date, numeric, numeric, date), public.proc_verify_invoice(uuid, text, text),
  public.proc_record_payment(uuid, numeric, date, text, text), public.proc_close_request(uuid, text), public.proc_emergency_decision(uuid, text, text),
  public.proc_review_emergency(uuid, text), public.proc_raise_low_stock_requests() from public, anon;
grant execute on function public.proc_is_procurement_head(), public.proc_save_vendor(uuid, text, text, text, text, text, text, text, text, text, text, text, text),
  public.proc_set_vendor_status(uuid, text, text),
  public.proc_add_quotation(uuid, uuid, text, date, date, numeric, numeric, numeric, numeric, numeric, numeric, integer, text, text, numeric),
  public.proc_select_quotation(uuid, uuid, text), public.proc_add_followup(uuid, text, text, date, boolean),
  public.proc_update_progress(uuid, text, text, text, text, text, date, date),
  public.proc_record_grn(uuid, numeric, numeric, numeric, numeric, text, text, text, text, boolean), public.proc_verify_grn(uuid, text),
  public.proc_record_invoice(uuid, text, date, numeric, numeric, date), public.proc_verify_invoice(uuid, text, text),
  public.proc_record_payment(uuid, numeric, date, text, text), public.proc_close_request(uuid, text), public.proc_emergency_decision(uuid, text, text),
  public.proc_review_emergency(uuid, text), public.proc_raise_low_stock_requests() to authenticated;

do $$
declare v_tbl text;
begin
  foreach v_tbl in array array['purchase_receipts', 'purchase_dispatches', 'purchase_payment_coordination', 'vendor_quotations', 'vendor_followups', 'vendors'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_tbl) then
      execute format('alter publication supabase_realtime add table public.%I', v_tbl);
    end if;
  end loop;
end $$;

commit;
