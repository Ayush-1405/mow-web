-- Official order-form printing after Procurement acceptance.
--
-- * Accepting the Procurement task also accepts the ORDER (SENT_TO_PROCUREMENT -> ACCEPTED_BY_PROCUREMENT), so the
--   "Print order form" button is there the moment someone accepts.
-- * Who may print and confirm Order Placed: the Procurement employee handling the order (task accepted by them), or a
--   Procurement Head / Supervisor (proc_can_work_order). Accepting stays open to every active Procurement member.
-- * Print history: purchase_print_logs gains the task, the template used, the output (browser print or PDF), the stored
--   PDF and a separate "it really printed" confirmation -- opening the print dialog is never taken as proof of paper.
-- * Template: the order form chosen when the order was raised (Interior small / Retail large); the Procurement Head may
--   override it per order with a reason (purchase_requests.print_template).
-- * Order Placed for order forms needs only what the paper process has: vendor, vendor PO / reference number, order date
--   and expected delivery; contact, quotation, amount, terms and remarks are optional (still validated when given).
--   Printing never places or completes an order.

begin;

-- ---------------------------------------------------------------------------
-- 1. Structure
-- ---------------------------------------------------------------------------

alter table public.purchase_requests add column if not exists print_template text;
do $$ begin
  alter table public.purchase_requests add constraint purchase_requests_print_template_check check (print_template in ('INTERIOR', 'RETAIL'));
exception when duplicate_object then null; end $$;

alter table public.purchase_print_logs
  add column if not exists task_id uuid references public.staff_tasks(id) on delete set null,
  add column if not exists template text,
  add column if not exists output text not null default 'PRINT',
  add column if not exists pdf_storage_path text,
  add column if not exists print_confirmed_at timestamptz,
  add column if not exists print_confirmed_by uuid references public.user_profiles(id);
do $$ begin
  alter table public.purchase_print_logs add constraint purchase_print_logs_output_check check (output in ('PRINT', 'PDF'));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. Who may work an accepted order
-- ---------------------------------------------------------------------------

create or replace function public.proc_can_work_order(p_request_id uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.proc_is_procurement_authorized(), false)
      or (coalesce(public.proc_is_procurement_member(), false) and exists (
            select 1 from public.staff_tasks t where t.purchase_request_id = p_request_id and t.is_active
               and t.assigned_to = auth.uid() and t.accepted_by is not null));
$$;

-- The template an order prints on: the Procurement Head's override, else the form chosen when it was raised, else by
-- department (Interior -> Interior, everyone else -> Retail).
create or replace function public.proc_order_template(p_row public.purchase_requests)
returns text language sql stable security definer set search_path to 'public' as $$
  select coalesce(p_row.print_template, p_row.order_form_type,
                  case when (select code from public.departments where id = p_row.requesting_department_id) = 'INTERIOR' then 'INTERIOR' else 'RETAIL' end);
$$;

-- ---------------------------------------------------------------------------
-- 3. Accepting the task accepts the order
-- ---------------------------------------------------------------------------

create or replace function public.proc_accept_order_task(p_request_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.purchase_requests; t public.staff_tasks; v_name text; v_head uuid := public.proc_procurement_head_user(); v_user uuid; v_mine boolean := false;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_member(), false) then raise exception 'Only Procurement staff can accept order tasks'; end if;
  select * into r from public.purchase_requests where id = p_request_id for update;
  if r.id is null then raise exception 'Order not found'; end if;
  if not (r.proc_status = any(public.proc_due_watch_statuses())) then
    raise exception 'Order % is not with Procurement (%)', r.request_number, public.proc_status_label(r.proc_status);
  end if;
  perform public.proc_sync_order_task(p_request_id);
  select * into t from public.staff_tasks where purchase_request_id = p_request_id for update;
  if t.id is null then raise exception 'This order has no Procurement task'; end if;
  if t.accepted_by is not null then
    -- The owner pressing Accept again (e.g. after a clarification came back) only accepts the order.
    if t.assigned_to = auth.uid() and r.proc_status = 'SENT_TO_PROCUREMENT' then
      v_mine := true;
    else
      raise exception 'This order task was already accepted by %', coalesce((select full_name from public.user_profiles where id = t.accepted_by), 'someone else');
    end if;
  end if;
  select full_name into v_name from public.user_profiles where id = auth.uid();
  if not v_mine then
    perform public.proc_take_order_task(t.id, auth.uid(), auth.uid(), null);
    insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
    values (r.id, r.proc_status, r.proc_status, auth.uid(), public.staff_current_role_code(), 'Task ' || t.task_number || ' accepted by ' || v_name);
    perform public.staff_write_audit('task', t.id, 'ACCEPT', jsonb_build_object('status', 'ASSIGNED'), jsonb_build_object('status', 'IN_PROGRESS', 'accepted_by', auth.uid()),
      t.to_department_id, 'Order ' || r.request_number);
  end if;

  -- The order itself is accepted by Procurement now (unless it is waiting for a clarification from the requester).
  if r.proc_status = 'SENT_TO_PROCUREMENT' then
    update public.purchase_requests set proc_decided_by = auth.uid(), proc_decided_at = now(), proc_decision_remarks = null where id = r.id;
    perform public.proc_set_status(r.id, 'SENT_TO_PROCUREMENT', 'ACCEPTED_BY_PROCUREMENT', 'Accepted by ' || v_name || ' (Procurement task ' || t.task_number || ')');
    perform public.proc_notify_users(public.proc_department_heads(r.requesting_department_id), r.id,
      'Procurement accepted order ' || r.request_number || ': ' || r.material_name || ' — handled by ' || v_name,
      'ઓર્ડર ' || r.request_number || ' ખરીદી વિભાગે સ્વીકાર્યો');
  end if;

  if not v_mine then
    for v_user in select distinct x from unnest(array[v_head] || public.proc_procurement_team()) x where x is not null loop
      perform public.staff_notify_assignment(v_user, 'PURCHASE_REQUEST', r.id, v_name || ' accepted order ' || r.request_number || ' (due ' || to_char(r.required_by_date, 'DD-MM-YYYY') || ')',
        v_name || ' એ ઓર્ડર ' || r.request_number || ' સ્વીકાર્યો');
    end loop;
  end if;
  perform public.staff_notify_assignment(r.requester_user_id, 'PURCHASE_REQUEST', r.id,
    'Procurement accepted your order ' || r.request_number || '. It is being handled by ' || v_name || ' (Procurement)',
    'તમારો ઓર્ડર ' || r.request_number || ' સ્વીકારાયો; ' || v_name || ' સંભાળે છે');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Printing
-- ---------------------------------------------------------------------------

-- Same as v3_01, except: the employee handling the order may print too, and each log row records the task and template.
create or replace function public.proc_record_print(p_request_id uuid, p_document_type text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_po public.purchase_orders; v_version integer; v_action text; v_task uuid; v_log uuid; v_template text;
begin
  perform public.staff_assert_operational();
  if not public.proc_can_work_order(p_request_id) then
    raise exception 'Only the Procurement employee handling this order, or a Procurement Head / Supervisor, can print it';
  end if;
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found'; end if;
  select id into v_task from public.staff_tasks where purchase_request_id = p_request_id;
  v_template := case when v_row.order_form_type is not null or v_row.print_template is not null then public.proc_order_template(v_row) end;

  if p_document_type = 'PURCHASE_REQUEST' then
    if v_row.proc_status in ('LEGACY', 'DRAFT', 'PENDING_DEPT_APPROVAL', 'RETURNED_FOR_CORRECTION', 'REJECTED_BY_DEPT_HEAD', 'APPROVED_BY_DEPT_HEAD',
                             'SENT_TO_PROCUREMENT', 'CLARIFICATION_REQUIRED', 'ON_HOLD', 'REJECTED_BY_PROCUREMENT', 'CANCELLED', 'EMERGENCY_APPROVAL_PENDING',
                             'EMERGENCY_REJECTED') then
      raise exception 'The document can be printed only after Procurement accepts the request';
    end if;
    v_action := case when v_row.document_version = 0 then 'PRINT_INITIATED' else 'REPRINT' end;
    v_version := greatest(v_row.document_version, 1);
    if v_row.document_version = 0 then
      update public.purchase_requests set document_version = 1, document_generated_at = now() where id = p_request_id;
    end if;
    insert into public.purchase_print_logs (purchase_request_id, document_type, document_version, action, printed_by, task_id, template)
    values (p_request_id, 'PURCHASE_REQUEST', v_version, v_action, auth.uid(), v_task, v_template) returning id into v_log;
    if v_row.proc_status = 'ACCEPTED_BY_PROCUREMENT' then
      perform public.proc_set_status(p_request_id, 'ACCEPTED_BY_PROCUREMENT', 'DOCUMENT_GENERATED', null);
    end if;
  elsif p_document_type = 'PURCHASE_ORDER' then
    select * into v_po from public.purchase_orders where purchase_request_id = p_request_id and is_current;
    if v_po.id is null then raise exception 'No purchase order has been confirmed for this request yet'; end if;
    v_version := coalesce(nullif(regexp_replace(coalesce(v_po.version_number, ''), '[^0-9]', '', 'g'), '')::int, 1);
    v_action := case when exists (select 1 from public.purchase_print_logs where purchase_order_id = v_po.id) then 'REPRINT' else 'PRINT_INITIATED' end;
    insert into public.purchase_print_logs (purchase_request_id, purchase_order_id, document_type, document_version, action, printed_by, task_id, template)
    values (p_request_id, v_po.id, 'PURCHASE_ORDER', v_version, v_action, auth.uid(), v_task, v_template) returning id into v_log;
  else
    raise exception 'Unknown document type %', p_document_type;
  end if;
  perform public.staff_write_audit('purchase_document', p_request_id, v_action,
    null, jsonb_build_object('document_type', p_document_type, 'document_version', v_version, 'template', v_template), v_row.requesting_department_id, null);
  return jsonb_build_object('document_version', v_version, 'action', v_action, 'log_id', v_log, 'template', v_template);
end $$;

-- The official order form: printed through the browser (p_output PRINT) or downloaded as a PDF (p_output PDF, with the
-- stored copy's path when the upload worked). Repeating it only adds history rows -- never another order.
create or replace function public.proc_record_order_print(p_request_id uuid, p_output text, p_pdf_path text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_res jsonb; v_path text := nullif(btrim(coalesce(p_pdf_path, '')), '');
begin
  if coalesce(p_output, '') not in ('PRINT', 'PDF') then raise exception 'Output must be PRINT or PDF'; end if;
  if v_path is not null then
    if v_path not like 'orders/' || p_request_id::text || '/%' then raise exception 'The PDF is not stored under this order'; end if;
    if not exists (select 1 from storage.objects where bucket_id = 'procurement-orders' and name = v_path) then raise exception 'The PDF was not uploaded'; end if;
  end if;
  v_res := public.proc_record_print(p_request_id, 'PURCHASE_REQUEST');
  update public.purchase_print_logs set output = p_output, pdf_storage_path = v_path where id = (v_res->>'log_id')::uuid;
  return v_res || jsonb_build_object('output', p_output);
end $$;

-- "Yes, it printed": the person who printed (or the handler / a lead) confirms the paper came out.
create or replace function public.proc_confirm_print(p_log_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_log public.purchase_print_logs;
begin
  perform public.staff_assert_operational();
  select * into v_log from public.purchase_print_logs where id = p_log_id for update;
  if v_log.id is null then raise exception 'Print record not found'; end if;
  if v_log.printed_by <> auth.uid() and not public.proc_can_work_order(v_log.purchase_request_id) then
    raise exception 'Only the person who printed it can confirm the print';
  end if;
  if v_log.output <> 'PRINT' then raise exception 'Only a print (not a PDF) is confirmed'; end if;
  update public.purchase_print_logs set print_confirmed_at = coalesce(print_confirmed_at, now()), print_confirmed_by = coalesce(print_confirmed_by, auth.uid())
   where id = p_log_id;
end $$;

-- Procurement Head / Management: print an exceptional order on the other form.
create or replace function public.proc_set_print_template(p_request_id uuid, p_template text, p_reason text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.purchase_requests; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_old text;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_head() or public.staff_has_global_oversight(), false) then
    raise exception 'Only the Procurement Head or Management can change the order form template';
  end if;
  if coalesce(p_template, '') not in ('INTERIOR', 'RETAIL') then raise exception 'Template must be INTERIOR or RETAIL'; end if;
  if v_reason is null then raise exception 'A reason is required to change the template'; end if;
  select * into r from public.purchase_requests where id = p_request_id for update;
  if r.id is null or r.proc_status = 'LEGACY' then raise exception 'Order not found'; end if;
  v_old := public.proc_order_template(r);
  if v_old = p_template then raise exception 'The order already uses this template'; end if;
  update public.purchase_requests set print_template = p_template where id = p_request_id;
  insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
  values (p_request_id, r.proc_status, r.proc_status, auth.uid(), public.staff_current_role_code(),
          'Order form changed from ' || initcap(v_old) || ' to ' || initcap(p_template) || ': ' || v_reason);
  perform public.staff_write_audit('purchase_request', p_request_id, 'PRINT_TEMPLATE', jsonb_build_object('template', v_old),
    jsonb_build_object('template', p_template), r.requesting_department_id, v_reason);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Order Placed
-- ---------------------------------------------------------------------------

-- As v3_01, plus: the employee handling the order may confirm it; for order forms only vendor, PO / reference number,
-- order date and expected delivery are required (the rest is validated when given); a vendor without a phone is matched
-- by name.
create or replace function public.proc_confirm_order(
  p_request_id uuid, p_vendor_name text, p_vendor_contact text, p_quotation_reference text, p_po_number text, p_order_date date,
  p_ordered_quantity numeric, p_amount numeric, p_expected_delivery_date date, p_payment_terms text, p_remarks text,
  p_scope_of_work text default null)
returns public.purchase_orders language plpgsql security definer set search_path to 'public' as $$
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
  if exists (select 1 from public.purchase_orders where lower(po_number) = lower(btrim(p_po_number))) then
    raise exception 'Purchase order number % is already used', btrim(p_po_number);
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
end $$;

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.proc_can_work_order(uuid), public.proc_order_template(public.purchase_requests), public.proc_record_order_print(uuid, text, text),
  public.proc_confirm_print(uuid), public.proc_set_print_template(uuid, text, text) from public, anon;
grant execute on function public.proc_can_work_order(uuid), public.proc_record_order_print(uuid, text, text), public.proc_confirm_print(uuid),
  public.proc_set_print_template(uuid, text, text) to authenticated;
revoke all on function public.proc_order_template(public.purchase_requests) from authenticated;

commit;
