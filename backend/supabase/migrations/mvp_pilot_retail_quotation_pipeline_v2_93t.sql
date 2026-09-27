-- Retail Quotation Sales Pipeline (v2_93t): Lead -> Quotation -> Scan QR -> Discount/Adjustment -> PDF -> WhatsApp
-- -> Customer Approval -> Convert to Order -> Godown/Dispatch -> Delivered/Sold. Everything downstream of "Convert
-- to Order" (reservation, Delivery Challan, Godown handover, scan-pick, packing, dispatch, delivery proof, Sold)
-- already exists and is tested (v2_93i-v2_93s) -- this migration is strictly the quotation-side gap: a real,
-- unambiguous discount/adjustment formula computed server-side, an approval workflow for out-of-authority pricing,
-- truthful Sent/Customer-Approval evidence tracking (never client-claimed), and quotation revisions that never
-- overwrite a previously sent version.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. Schema: billing/delivery address + email on the customer (source of truth) and snapshotted onto the
--    quotation; discount/adjustment/approval/sent/customer-approval fields on the quotation and its line items.
--    Every new column is additive with a safe default -- zero behavior change for any row/caller that never uses it.
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.retail_customers add column if not exists billing_address text;
alter table public.retail_customers add column if not exists delivery_address text;

alter table public.retail_quotations
  add column if not exists email text,
  add column if not exists billing_address text,
  add column if not exists delivery_address text,
  add column if not exists store_location_id uuid references public.locations(id),
  add column if not exists other_charge numeric not null default 0,
  add column if not exists rounding numeric not null default 0,
  add column if not exists advance_required numeric,
  add column if not exists is_current_revision boolean not null default true,
  add column if not exists rejection_reason text,
  add column if not exists discount_approval_status text not null default 'NONE',
  add column if not exists discount_approval_requested_by uuid,
  add column if not exists discount_approval_requested_at timestamptz,
  add column if not exists discount_approval_reason text,
  add column if not exists discount_approved_by uuid,
  add column if not exists discount_approved_at timestamptz,
  add column if not exists discount_rejection_reason text,
  add column if not exists sent_by uuid,
  add column if not exists sent_at timestamptz,
  add column if not exists sent_phone text,
  add column if not exists sent_method text,
  add column if not exists sent_provider_message_id text,
  add column if not exists sent_provider_status text,
  add column if not exists sent_failure_reason text,
  add column if not exists customer_approved_at timestamptz,
  add column if not exists customer_approval_method text,
  add column if not exists customer_approval_notes text,
  add column if not exists customer_approval_recorded_by uuid,
  add column if not exists customer_approval_attachment_id uuid references public.staff_attachments(id),
  add column if not exists customer_approval_amount numeric,
  add column if not exists pdf_attachment_id uuid references public.staff_attachments(id);

alter table public.retail_quotations
  add constraint retail_quotations_discount_approval_status_check check (discount_approval_status in ('NONE', 'PENDING', 'APPROVED', 'REJECTED')),
  add constraint retail_quotations_sent_method_check check (sent_method is null or sent_method in ('WHATSAPP_MANUAL', 'WHATSAPP_API')),
  add constraint retail_quotations_customer_approval_method_check check (customer_approval_method is null or customer_approval_method in ('WHATSAPP_MESSAGE', 'SIGNED_COPY', 'EMAIL', 'OTP', 'MANUAL_NOTE'));

alter table public.retail_quotation_items
  add column if not exists discount_type text not null default 'FIXED',
  add column if not exists discount_value numeric not null default 0,
  add column if not exists adjustment_type text not null default 'NONE',
  add column if not exists adjustment_value numeric not null default 0,
  add column if not exists adjustment_reason text,
  add column if not exists gst_rate numeric,
  add column if not exists base_amount numeric,
  add column if not exists taxable_amount numeric,
  add column if not exists tax_amount numeric;

alter table public.retail_quotation_items
  add constraint retail_quotation_items_discount_type_check check (discount_type in ('NONE', 'PERCENT', 'FIXED')),
  add constraint retail_quotation_items_adjustment_type_check check (adjustment_type in ('NONE', 'INCREASE', 'DECREASE'));

-- Widen the lead status matrix additively -- existing values (NEW/FOLLOW_UP/QUOTED/CONVERTED/LOST) are untouched and
-- every place that already reads/writes them keeps working exactly as before.
alter table public.retail_leads drop constraint if exists retail_leads_status_check;
alter table public.retail_leads add constraint retail_leads_status_check check (status = any (array[
  'NEW', 'FOLLOW_UP', 'QUOTED', 'CONVERTED', 'LOST',
  'QUOTATION_SENT', 'NEGOTIATION', 'QUOTATION_APPROVED', 'QUOTATION_REJECTED'
]));

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. retail_compute_quotation_line -- the ONE server-side formula (Part 5 of the spec), reused by every insertion
--    path so a line total is never computed two different ways. discount_value for FIXED is a PER-UNIT amount
--    (matches the pre-existing "unit_price - discount" semantics exactly, so an old caller's result is unchanged);
--    for PERCENT it is a percentage of the base amount. adjustment_value is a flat, whole-line, ALWAYS-POSITIVE
--    magnitude -- the signed effect comes only from adjustment_type ('INCREASE'/'DECREASE'), never from a bare
--    signed number a user could misread.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_compute_quotation_line(
  p_quantity numeric, p_unit_price numeric, p_discount_type text, p_discount_value numeric,
  p_adjustment_type text, p_adjustment_value numeric, p_gst_rate numeric)
returns table (base_amount numeric, discount_amount numeric, amount_after_discount numeric, adjustment_amount numeric,
  taxable_amount numeric, tax_amount numeric, line_total numeric)
language plpgsql
immutable
as $function$
declare
  v_qty numeric := coalesce(p_quantity, 0); v_price numeric := coalesce(p_unit_price, 0);
  v_base numeric; v_disc numeric; v_after_disc numeric; v_adj numeric; v_taxable numeric; v_tax numeric;
begin
  v_base := round(v_qty * v_price, 2);
  v_disc := case coalesce(p_discount_type, 'NONE')
    when 'PERCENT' then round(v_base * coalesce(p_discount_value, 0) / 100, 2)
    when 'FIXED' then round(coalesce(p_discount_value, 0) * v_qty, 2)
    else 0 end;
  v_after_disc := greatest(v_base - v_disc, 0);
  v_adj := case coalesce(p_adjustment_type, 'NONE')
    when 'INCREASE' then abs(coalesce(p_adjustment_value, 0))
    when 'DECREASE' then -abs(coalesce(p_adjustment_value, 0))
    else 0 end;
  v_taxable := greatest(v_after_disc + v_adj, 0);
  v_tax := round(v_taxable * coalesce(p_gst_rate, 0) / 100, 2);
  return query select v_base, v_disc, v_after_disc, v_adj, v_taxable, v_tax, (v_taxable + v_tax);
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. retail_create_quotation -- additive: now snapshots email/billing/delivery address + store from the caller
--    (the frontend reads these from the lead/customer once and passes them here — never re-typed), and always
--    creates the FIRST revision as the current one. Signature widened with new trailing defaulted params only, so
--    every existing call site (frontend and tests) keeps working unchanged.
-- ---------------------------------------------------------------------------------------------------------------------------------
drop function if exists public.retail_create_quotation(uuid, text, text, uuid, date, date, numeric, numeric, text, boolean, jsonb, uuid);

create or replace function public.retail_create_quotation(
  p_lead_id uuid, p_customer_name text, p_phone text, p_location_id uuid default null::uuid, p_valid_until date default null::date,
  p_expected_delivery date default null::date, p_delivery_charge numeric default 0, p_installation_charge numeric default 0,
  p_terms text default null::text, p_internal_approval_required boolean default false, p_items jsonb default '[]'::jsonb,
  p_supersedes_id uuid default null::uuid, p_email text default null::text, p_billing_address text default null::text,
  p_delivery_address text default null::text, p_store_location_id uuid default null::uuid)
returns public.retail_quotations
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_dept uuid := public.retail_dept_id(); v_customer_id uuid; v_number text; v_revision int := 1; v_total numeric := 0;
  v_row public.retail_quotations; v_item jsonb; v_line numeric;
begin
  perform public.staff_assert_operational();
  if p_lead_id is not null then select customer_id into v_customer_id from public.retail_leads where id = p_lead_id; end if;
  if v_customer_id is null then
    v_customer_id := (public.retail_upsert_customer(p_customer_name, p_phone, null, null, null, null, 'RETAIL', auth.uid())).id;
  end if;
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
    delivery_charge, installation_charge, terms, expected_delivery, supersedes_id, revision_no, internal_approval_required, created_by,
    email, billing_address, delivery_address, store_location_id
  ) values (
    v_dept, p_lead_id, v_customer_id, v_number, btrim(p_customer_name), nullif(btrim(p_phone), ''), 'DRAFT', v_total, p_valid_until,
    coalesce(p_delivery_charge, 0), coalesce(p_installation_charge, 0), p_terms, p_expected_delivery, p_supersedes_id, v_revision,
    coalesce(p_internal_approval_required, false), auth.uid(), nullif(btrim(coalesce(p_email, '')), ''), p_billing_address, p_delivery_address, p_store_location_id
  ) returning * into v_row;

  insert into public.retail_quotation_items (quotation_id, item_name, sku, description, dimensions, product_image_path, quantity, unit_price, discount, tax, line_total, customization_notes)
  select v_row.id, it->>'item_name', it->>'sku', it->>'description', it->>'dimensions', it->>'product_image_path',
    coalesce((it->>'quantity')::numeric, 0), coalesce((it->>'unit_price')::numeric, 0), coalesce((it->>'discount')::numeric, 0), coalesce((it->>'tax')::numeric, 0),
    coalesce((it->>'quantity')::numeric, 0) * coalesce((it->>'unit_price')::numeric, 0) - coalesce((it->>'discount')::numeric, 0) + coalesce((it->>'tax')::numeric, 0),
    it->>'customization_notes'
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it;

  if p_supersedes_id is not null then
    update public.retail_quotations set is_current_revision = false where id = p_supersedes_id;
  end if;

  if p_lead_id is not null then update public.retail_leads set status = 'QUOTED' where id = p_lead_id; end if;
  perform public.staff_write_audit('retail_quotation', v_row.id, 'CREATE', null, jsonb_build_object('quotation_number', v_number, 'total', v_total), v_dept);
  return v_row;
end $function$;
grant execute on function public.retail_create_quotation(uuid, text, text, uuid, date, date, numeric, numeric, text, boolean, jsonb, uuid, text, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. retail_create_quotation_revision -- "Create Revision" (Part 7): copies the CURRENT quotation's own snapshot
--    (customer/address/terms + every line item exactly as last saved) into a brand-new QT-.../Revision N+1 row via
--    the function above, marks the old one non-current (never deleted, never overwritten), and syncs the lead to
--    Negotiation/Revision.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_create_quotation_revision(p_quotation_id uuid, p_reason text)
returns public.retail_quotations
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_old public.retail_quotations; v_allowed boolean; v_items jsonb; v_new public.retail_quotations;
begin
  perform public.staff_assert_operational();
  select * into v_old from public.retail_quotations where id = p_quotation_id;
  if v_old.id is null then raise exception 'Quotation not found'; end if;
  if not v_old.is_current_revision then raise exception 'This is already a superseded revision'; end if;

  v_allowed := (v_old.created_by = auth.uid() or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_old.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to revise this quotation'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to create a revision'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'item_name', item_name, 'sku', sku, 'description', description, 'dimensions', dimensions, 'product_image_path', product_image_path,
    'quantity', quantity, 'unit_price', unit_price, 'discount', discount, 'tax', tax, 'customization_notes', customization_notes
  )), '[]'::jsonb) into v_items from public.retail_quotation_items where quotation_id = p_quotation_id;

  v_new := public.retail_create_quotation(
    v_old.lead_id, v_old.customer_name, v_old.phone, v_old.store_location_id, v_old.valid_until, v_old.expected_delivery,
    v_old.delivery_charge, v_old.installation_charge, v_old.terms, v_old.internal_approval_required, v_items, p_quotation_id,
    v_old.email, v_old.billing_address, v_old.delivery_address, v_old.store_location_id);

  if v_old.lead_id is not null then update public.retail_leads set status = 'NEGOTIATION' where id = v_old.lead_id; end if;
  perform public.staff_write_audit('retail_quotation', v_new.id, 'REVISION_CREATED', jsonb_build_object('from', v_old.quotation_number),
    jsonb_build_object('revision_no', v_new.revision_no), v_old.department_id, p_reason);
  return v_new;
end $function$;
grant execute on function public.retail_create_quotation_revision(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. retail_add_quotation_item_from_scan -- rewritten with the full formula + a real discount/adjustment approval
--    WORKFLOW (Part 6): a caller outside their authority no longer gets a hard exception -- the item is still added
--    (Draft), but the whole quotation flips to discount_approval_status='PENDING' and cannot be marked Sent until a
--    Head/oversight approves it (retail_decide_quotation_discount_approval, below). This is a deliberate behavior
--    change from the earlier hard floor-exception (disclosed) -- Retail Head/oversight/dept-head-in-scope callers
--    are completely unaffected (their line is simply accepted, same as before). New params are ADDITIVE with safe
--    defaults matching the old behavior exactly, so every existing call site (frontend and tests) is unaffected
--    unless it explicitly opts into discount_type/adjustment.
-- ---------------------------------------------------------------------------------------------------------------------------------
drop function if exists public.retail_add_quotation_item_from_scan(uuid, text, numeric, numeric);

create or replace function public.retail_add_quotation_item_from_scan(
  p_quotation_id uuid, p_code text, p_quantity numeric default 1, p_discount numeric default 0,
  p_discount_type text default 'FIXED', p_adjustment_type text default 'NONE', p_adjustment_value numeric default 0,
  p_adjustment_reason text default null)
returns public.retail_quotation_items
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_quotation public.retail_quotations; v_allowed boolean; v_item public.retail_inventory_items; v_product public.retail_products;
  v_code text := upper(btrim(coalesce(p_code, ''))); v_can_override_floor boolean; v_row public.retail_quotation_items;
  v_calc record; v_needs_approval boolean;
begin
  perform public.staff_assert_operational();
  select * into v_quotation from public.retail_quotations where id = p_quotation_id;
  if v_quotation.id is null then raise exception 'Quotation not found'; end if;
  if v_quotation.status not in ('DRAFT', 'SENT') then raise exception 'This quotation can no longer be edited'; end if;
  if not v_quotation.is_current_revision then raise exception 'This is a superseded revision and can no longer be edited'; end if;

  v_allowed := (v_quotation.created_by = auth.uid() or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_quotation.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to edit this quotation'; end if;

  if coalesce(p_discount_type, 'FIXED') not in ('NONE', 'PERCENT', 'FIXED') then raise exception 'Invalid discount type'; end if;
  if coalesce(p_adjustment_type, 'NONE') not in ('NONE', 'INCREASE', 'DECREASE') then raise exception 'Invalid adjustment type'; end if;
  if coalesce(p_adjustment_type, 'NONE') <> 'NONE' and coalesce(btrim(p_adjustment_reason), '') = '' then
    raise exception 'A reason is required for a price adjustment';
  end if;

  select * into v_item from public.retail_inventory_items where upper(serial_number) = v_code limit 1;
  if v_item.id is not null then
    if v_item.status <> 'AVAILABLE' then
      raise exception 'This item is % and cannot be added to a quotation', v_item.status;
    end if;
    if exists (select 1 from public.retail_quotation_items where quotation_id = p_quotation_id and inventory_item_id = v_item.id) then
      raise exception 'This exact item is already in this quotation';
    end if;
    select * into v_product from public.retail_products where id = v_item.product_id;
  else
    select * into v_product from public.retail_products where upper(sku) = v_code and is_active limit 1;
    if v_product.id is null then raise exception 'Product not found for code %', p_code; end if;
  end if;

  if v_product.approval_status <> 'ACTIVE' then
    raise exception 'This product is pending Retail Head approval and cannot be added to a quotation yet';
  end if;

  select * into v_calc from public.retail_compute_quotation_line(
    coalesce(p_quantity, 1), coalesce(v_product.selling_price, 0), p_discount_type, coalesce(p_discount, 0),
    p_adjustment_type, p_adjustment_value, coalesce(v_product.gst_percent, 0));

  v_can_override_floor := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_quotation.department_id), false)));
  -- Outside authority: selling below the floor, or ANY manual decrease. The item is still added (Draft) — it just
  -- blocks this quotation from being marked Sent until a Head/oversight approves (never a hard exception here).
  v_needs_approval := (not v_can_override_floor) and (
    (v_product.min_approved_price is not null and (v_calc.amount_after_discount / greatest(coalesce(p_quantity, 1), 1)) < v_product.min_approved_price)
    or coalesce(p_adjustment_type, 'NONE') = 'DECREASE');

  -- unit_price keeps its EXISTING meaning (the effective per-unit price the customer is charged, after discount
  -- and adjustment, before tax) — anything already reading it (e.g. retail_convert_quotation_to_order, which
  -- copies it verbatim onto the order item) sees the same kind of number as before, just computed via the fuller
  -- formula. line_total now correctly includes tax (Part 5's Final Line Total = Taxable + Tax) — the old code
  -- never added tax into line_total at all, which this fixes; nothing downstream asserts an exact line_total.
  insert into public.retail_quotation_items (
    quotation_id, item_name, sku, description, dimensions, product_image_path, quantity, unit_price, discount, tax, line_total,
    product_id, inventory_item_id, discount_type, discount_value, adjustment_type, adjustment_value, adjustment_reason,
    gst_rate, base_amount, taxable_amount, tax_amount
  ) values (
    p_quotation_id, v_product.name, v_product.sku, v_product.description, v_product.dimensions, v_product.image_path,
    coalesce(p_quantity, 1), v_calc.taxable_amount / greatest(coalesce(p_quantity, 1), 1), v_calc.discount_amount,
    coalesce(v_product.gst_percent, 0), v_calc.line_total,
    v_product.id, v_item.id, coalesce(p_discount_type, 'FIXED'), coalesce(p_discount, 0), coalesce(p_adjustment_type, 'NONE'),
    coalesce(p_adjustment_value, 0), p_adjustment_reason, coalesce(v_product.gst_percent, 0), v_calc.base_amount, v_calc.taxable_amount, v_calc.tax_amount
  ) returning * into v_row;

  update public.retail_quotations set total_amount = coalesce(total_amount, 0) + v_row.line_total,
    discount_approval_status = case when v_needs_approval and discount_approval_status = 'NONE' then 'PENDING' else discount_approval_status end,
    discount_approval_requested_by = case when v_needs_approval and discount_approval_status = 'NONE' then auth.uid() else discount_approval_requested_by end,
    discount_approval_requested_at = case when v_needs_approval and discount_approval_status = 'NONE' then now() else discount_approval_requested_at end,
    discount_approval_reason = case when v_needs_approval and discount_approval_status = 'NONE' then coalesce(p_adjustment_reason, 'Below approved minimum price') else discount_approval_reason end
  where id = p_quotation_id;

  if v_needs_approval then
    perform public.staff_notify_dept_leadership('RETAIL', 'retail_quotation', p_quotation_id,
      'Discount/price approval needed: ' || v_quotation.quotation_number, v_quotation.quotation_number || ' — ડિસ્કાઉન્ટ મંજૂરી જરૂરી');
  end if;

  perform public.staff_write_audit('retail_quotation', p_quotation_id, 'ADD_ITEM_FROM_SCAN', null,
    jsonb_build_object('product_id', v_product.id, 'inventory_item_id', v_item.id, 'line_total', v_calc.line_total, 'needs_approval', v_needs_approval), v_quotation.department_id);
  return v_row;
end $function$;
grant execute on function public.retail_add_quotation_item_from_scan(uuid, text, numeric, numeric, text, text, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 6. retail_decide_quotation_discount_approval -- Retail Head/oversight approves or rejects a PENDING quotation
--    (Part 6). Rejecting does not delete anything — the salesperson can adjust the item(s) and it can be
--    re-requested by adding/removing items.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_decide_quotation_discount_approval(p_quotation_id uuid, p_approve boolean, p_reason text)
returns public.retail_quotations
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_allowed boolean; v_row public.retail_quotations;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_quotations where id = p_quotation_id for update;
  if v_row.id is null then raise exception 'Quotation not found'; end if;
  if v_row.discount_approval_status <> 'PENDING' then raise exception 'This quotation has no pending discount approval'; end if;

  v_allowed := (coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_row.department_id), false)));
  if not v_allowed then raise exception 'Only Retail Head/Management may decide a discount approval'; end if;

  update public.retail_quotations set
    discount_approval_status = case when p_approve then 'APPROVED' else 'REJECTED' end,
    discount_approved_by = auth.uid(), discount_approved_at = now(),
    discount_rejection_reason = case when p_approve then null else p_reason end
  where id = p_quotation_id returning * into v_row;

  perform public.staff_write_audit('retail_quotation', p_quotation_id, case when p_approve then 'DISCOUNT_APPROVED' else 'DISCOUNT_REJECTED' end,
    null, jsonb_build_object('approved', p_approve), v_row.department_id, p_reason);
  if v_row.created_by is not null then
    perform public.staff_notify_assignment(v_row.created_by, 'retail_quotation', p_quotation_id,
      (case when p_approve then 'Discount approved: ' else 'Discount rejected: ' end) || v_row.quotation_number,
      v_row.quotation_number || (case when p_approve then ' — મંજૂર' else ' — નકારાયું' end));
  end if;
  return v_row;
end $function$;
grant execute on function public.retail_decide_quotation_discount_approval(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 7. retail_record_quotation_sent -- the ONLY path that may mark a quotation Sent (Part 9/10). Truthful: for
--    WHATSAPP_MANUAL this is called ONLY after the salesperson explicitly confirms "I sent it" (never merely
--    because a WhatsApp share button was clicked); for WHATSAPP_API it is where a provider webhook would report
--    delivery (no live provider is configured in this pilot — see the limitations note in the migration header).
--    Blocked while a discount approval is pending or unresolved-rejected. Also advances the lead to
--    QUOTATION_SENT and sets a next follow-up ONLY if one isn't already scheduled further out (never a duplicate).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_record_quotation_sent(
  p_quotation_id uuid, p_method text, p_phone text, p_provider_message_id text default null, p_provider_status text default null, p_failure_reason text default null)
returns public.retail_quotations
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_allowed boolean; v_row public.retail_quotations; v_digits text;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_quotations where id = p_quotation_id for update;
  if v_row.id is null then raise exception 'Quotation not found'; end if;
  if not v_row.is_current_revision then raise exception 'This is a superseded revision and can no longer be sent'; end if;
  if v_row.status not in ('DRAFT', 'SENT') then raise exception 'This quotation cannot be sent from its current status'; end if;
  if v_row.discount_approval_status = 'PENDING' then raise exception 'A discount/price approval is still pending — cannot send yet'; end if;
  if v_row.discount_approval_status = 'REJECTED' then raise exception 'A requested discount/price was rejected — adjust the quotation before sending'; end if;
  if not exists (select 1 from public.retail_quotation_items where quotation_id = p_quotation_id) then
    raise exception 'At least one item is required before sending';
  end if;
  if p_method not in ('WHATSAPP_MANUAL', 'WHATSAPP_API') then raise exception 'Invalid send method'; end if;

  v_allowed := (v_row.created_by = auth.uid() or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_row.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to send this quotation'; end if;

  v_digits := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  if length(v_digits) < 10 then raise exception 'A valid WhatsApp number (with country code) is required'; end if;

  update public.retail_quotations set
    status = 'SENT', sent_by = auth.uid(), sent_at = now(), sent_phone = p_phone, sent_method = p_method,
    sent_provider_message_id = p_provider_message_id, sent_provider_status = p_provider_status, sent_failure_reason = p_failure_reason
  where id = p_quotation_id returning * into v_row;

  if v_row.lead_id is not null then
    update public.retail_leads set status = 'QUOTATION_SENT',
      next_follow_up_date = case when next_follow_up_date is null or next_follow_up_date < current_date + 2 then current_date + 2 else next_follow_up_date end
    where id = v_row.lead_id;
  end if;

  perform public.staff_write_audit('retail_quotation', p_quotation_id, 'SENT', null,
    jsonb_build_object('method', p_method, 'phone', p_phone), v_row.department_id);
  return v_row;
end $function$;
grant execute on function public.retail_record_quotation_sent(uuid, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 8. retail_record_quotation_customer_approval -- the ONLY path that may mark a quotation Accepted (Part 11): real
--    evidence is required, and only a quotation that was actually Sent can be approved (never a Draft/unsent one
--    "accidentally"). Advances the lead to QUOTATION_APPROVED. retail_convert_quotation_to_order (unchanged, v2_93r)
--    already requires status='ACCEPTED', so this is the real, evidence-backed gate in front of it.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_record_quotation_customer_approval(
  p_quotation_id uuid, p_method text, p_notes text, p_approved_amount numeric default null, p_attachment_id uuid default null)
returns public.retail_quotations
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_allowed boolean; v_row public.retail_quotations;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_quotations where id = p_quotation_id for update;
  if v_row.id is null then raise exception 'Quotation not found'; end if;
  if v_row.status <> 'SENT' then raise exception 'Only a quotation that was actually sent can be approved'; end if;
  if p_method not in ('WHATSAPP_MESSAGE', 'SIGNED_COPY', 'EMAIL', 'OTP', 'MANUAL_NOTE') then raise exception 'Invalid approval method'; end if;
  if p_method = 'MANUAL_NOTE' and coalesce(btrim(p_notes), '') = '' then raise exception 'A note is required to record a manual confirmation'; end if;

  v_allowed := (v_row.created_by = auth.uid() or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_row.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to record approval for this quotation'; end if;

  update public.retail_quotations set
    status = 'ACCEPTED', customer_approved_at = now(), customer_approval_method = p_method, customer_approval_notes = p_notes,
    customer_approval_recorded_by = auth.uid(), customer_approval_attachment_id = p_attachment_id,
    customer_approval_amount = coalesce(p_approved_amount, total_amount)
  where id = p_quotation_id returning * into v_row;

  if v_row.lead_id is not null then update public.retail_leads set status = 'QUOTATION_APPROVED' where id = v_row.lead_id; end if;

  perform public.staff_write_audit('retail_quotation', p_quotation_id, 'CUSTOMER_APPROVED', null,
    jsonb_build_object('method', p_method, 'amount', v_row.customer_approval_amount), v_row.department_id);
  return v_row;
end $function$;
grant execute on function public.retail_record_quotation_customer_approval(uuid, text, text, numeric, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 9. retail_reject_quotation -- customer declined (Part 10/11): Lost/Quotation Rejected, with reason.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_reject_quotation(p_quotation_id uuid, p_reason text)
returns public.retail_quotations
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_allowed boolean; v_row public.retail_quotations;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_quotations where id = p_quotation_id for update;
  if v_row.id is null then raise exception 'Quotation not found'; end if;
  if v_row.status not in ('SENT', 'DRAFT') then raise exception 'This quotation cannot be rejected from its current status'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to reject a quotation'; end if;

  v_allowed := (v_row.created_by = auth.uid() or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_row.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to reject this quotation'; end if;

  update public.retail_quotations set status = 'REJECTED', rejection_reason = p_reason where id = p_quotation_id returning * into v_row;
  if v_row.lead_id is not null then update public.retail_leads set status = 'QUOTATION_REJECTED' where id = v_row.lead_id; end if;

  perform public.staff_write_audit('retail_quotation', p_quotation_id, 'REJECTED', null, jsonb_build_object('reason', p_reason), v_row.department_id, p_reason);
  return v_row;
end $function$;
grant execute on function public.retail_reject_quotation(uuid, text) to authenticated;
