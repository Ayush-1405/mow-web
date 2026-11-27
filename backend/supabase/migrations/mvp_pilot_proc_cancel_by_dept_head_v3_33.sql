-- v3_33 Cancel (delete) a purchase order: the requesting department's head may cancel, and an order can be cancelled until the
-- goods arrive.
--
-- Before: only the requester (early stages) or Procurement / Management (up to "document generated") could cancel, so an order
-- already placed with a vendor could not be cancelled by anyone, and a Department Head could not cancel their own department's
-- order at all.
-- Now:
--   * the requester, while the request is still with them or their head (unchanged);
--   * Procurement, Management, or a head of the department that raised the order, at any stage before goods arrive:
--     from department approval up to placed / vendor confirmed / in production / ready for dispatch / in transit / delayed.
--   * Nobody once anything has been received, verified or paid (PARTIALLY_RECEIVED onward), or once it is already closed,
--     rejected or cancelled.
-- A reason is still required. The requester, the department's heads and (once Procurement has it) the assigned buyer are notified;
-- for an order already placed the message reminds them to tell the vendor. The order's task is closed by the existing sync
-- (proc_on_order_history -> proc_sync_order_task), and the history is kept. No table or grant changes.

create or replace function public.proc_cancel_request(p_request_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row public.purchase_requests;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_placed boolean;
  v_head boolean;
  v_notify uuid[];
begin
  perform public.staff_assert_operational();
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found'; end if;
  if v_reason is null then raise exception 'A reason is required'; end if;

  v_head := auth.uid() = any(public.proc_department_heads(v_row.requesting_department_id))
            or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_row.requesting_department_id), false));

  if v_row.proc_status in ('DRAFT', 'PENDING_DEPT_APPROVAL', 'RETURNED_FOR_CORRECTION', 'CLARIFICATION_REQUIRED') and v_row.requester_user_id = auth.uid() then
    null;
  elsif v_row.proc_status in ('PENDING_DEPT_APPROVAL', 'RETURNED_FOR_CORRECTION', 'APPROVED_BY_DEPT_HEAD', 'EMERGENCY_APPROVAL_PENDING',
                              'SENT_TO_PROCUREMENT', 'CLARIFICATION_REQUIRED', 'ON_HOLD', 'ACCEPTED_BY_PROCUREMENT', 'DOCUMENT_GENERATED',
                              'ORDER_PLACED', 'VENDOR_CONFIRMED', 'IN_PRODUCTION', 'READY_FOR_DISPATCH', 'IN_TRANSIT', 'DELAYED')
        and (public.proc_is_procurement_authorized() or public.staff_has_global_oversight() or v_head) then
    null;
  elsif v_row.proc_status in ('PARTIALLY_RECEIVED', 'RECEIVED', 'GRN_VERIFIED', 'INVOICE_VERIFIED', 'PAYMENT_PENDING', 'PARTIALLY_PAID', 'PAID') then
    raise exception 'This order cannot be cancelled: goods have already been received. Use a return or adjustment instead.';
  else
    raise exception 'This request cannot be cancelled by you at this stage';
  end if;

  v_placed := v_row.proc_status in ('ORDER_PLACED', 'VENDOR_CONFIRMED', 'IN_PRODUCTION', 'READY_FOR_DISPATCH', 'IN_TRANSIT', 'DELAYED');
  perform public.proc_set_status(p_request_id, v_row.proc_status, 'CANCELLED', v_reason);

  v_notify := array[v_row.requester_user_id] || public.proc_department_heads(v_row.requesting_department_id)
              || case when v_row.proc_assigned_to is not null then array[v_row.proc_assigned_to] else '{}'::uuid[] end;
  perform public.proc_notify_users(
    array(select distinct u from unnest(v_notify) u where u is not null and u <> auth.uid()), p_request_id,
    'Request ' || v_row.request_number || ' was cancelled: ' || v_reason
      || case when v_placed then ' -- it was already placed with the vendor; please inform the vendor.' else '' end,
    'વિનંતી ' || v_row.request_number || ' રદ: ' || v_reason
      || case when v_placed then ' -- વેન્ડરને ઓર્ડર અપાઈ ગયો હતો; વેન્ડરને જાણ કરો.' else '' end);
end $function$;
