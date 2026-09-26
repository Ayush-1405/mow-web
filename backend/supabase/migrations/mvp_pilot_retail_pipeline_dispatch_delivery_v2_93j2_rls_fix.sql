-- v2_93j2 -- hotfix: retail_deliveries' RLS (created in v2_93a, before Godown/Dispatch staff existed as a concept) never granted
-- Godown or Dispatch staff visibility into the delivery row for an order they are actively handling. Confirmed live: after
-- retail_record_dispatch() correctly sets retail_deliveries.stage = 'OUT_FOR_DELIVERY', a Dispatch employee querying
-- retail_deliveries directly (as any real Dispatch screen would) sees ZERO rows -- the write succeeds (the RPC runs as table owner,
-- SECURITY DEFINER, bypassing RLS) but the read is silently empty for the very team meant to act on it next. Also extends
-- retail_orders_select so Godown/Dispatch staff can read the parent order's customer/address/product details for an order they
-- have an active handover or dispatch record for (never ALL orders) -- required for any real Godown/Dispatch queue screen.
drop policy if exists retail_deliveries_select on public.retail_deliveries;
create policy retail_deliveries_select on public.retail_deliveries for select to authenticated using (
  staff_current_user_ok() and (
    created_by = auth.uid() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))
    or staff_is_godown_staff() or staff_is_dispatch_staff()
    or exists (select 1 from retail_orders o where o.id = retail_deliveries.order_id and (o.created_by = auth.uid() or retail_can_access_customer(o.customer_id)))));

drop policy if exists retail_deliveries_write on public.retail_deliveries;
create policy retail_deliveries_write on public.retail_deliveries for all to authenticated
  using (staff_current_user_ok() and (
    created_by = auth.uid() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))
    or staff_is_godown_staff() or staff_is_dispatch_staff()
    or exists (select 1 from retail_orders o where o.id = retail_deliveries.order_id and o.created_by = auth.uid())))
  with check (staff_current_user_ok() and (
    department_id = staff_current_department_id() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))
    or staff_is_godown_staff() or staff_is_dispatch_staff()));

drop policy if exists retail_orders_select_scoped on public.retail_orders;
create policy retail_orders_select_scoped on public.retail_orders for select to authenticated using (
  staff_current_user_ok() and (
    created_by = auth.uid() or retail_can_access_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))
    or (staff_is_accounts_head() and department_id = staff_current_department_id())
    or (staff_is_godown_staff() and exists (select 1 from retail_godown_handovers h where h.order_id = retail_orders.id))
    or (staff_is_dispatch_staff() and exists (select 1 from retail_dispatch_records dr where dr.order_id = retail_orders.id))));
