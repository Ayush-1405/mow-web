-- v2_93k2 -- hotfix: retail_customer_timeline()'s ORDER BY occurred_at failed at every execution ("invalid UNION/INTERSECT/EXCEPT
-- ORDER BY clause ... Only result column names can be used") because none of its UNION ALL branches aliased their columns, so the
-- union had no column literally named occurred_at (Postgres took the unaliased names from the first branch's raw expressions
-- instead). This bug shipped unnoticed in both the v2_93h partial version and the v2_93k full version -- PL/pgSQL doesn't validate a
-- function body until first execution, and no test had actually called this function with real timeline rows until now. Fixed by
-- aliasing the first branch's columns to the function's own RETURNS TABLE names.
create or replace function public.retail_customer_timeline(p_customer_id uuid)
returns table (entry_type text, entity_id uuid, occurred_at timestamptz, title text, status text, linked_task_id uuid)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_assert_operational();
  if not public.retail_can_access_customer(p_customer_id) then raise exception 'Not authorized to view this customer'; end if;
  return query
  select 'LEAD'::text as entry_type, l.id as entity_id, l.created_at as occurred_at, coalesce(l.walkin_number, 'Lead') || ' — ' || l.customer_name as title, l.status as status, l.linked_task_id as linked_task_id
    from public.retail_leads l where l.customer_id = p_customer_id
  union all
  select 'FOLLOWUP', f.id, f.created_at, 'Follow-up (' || f.contact_mode || ')', f.status, f.linked_task_id
    from public.retail_followups f where f.customer_id = p_customer_id
  union all
  select 'QUOTATION', q.id, q.created_at, q.quotation_number || ' (v' || q.revision_no || ')', q.status, null::uuid
    from public.retail_quotations q where q.customer_id = p_customer_id
  union all
  select 'ORDER', o.id, o.created_at, o.order_number, coalesce(o.pipeline_status, o.status), o.linked_task_id
    from public.retail_orders o where o.customer_id = p_customer_id
  union all
  select 'PAYMENT', p.id, p.paid_at, 'Payment received', p.payment_mode, null::uuid
    from public.retail_payments p join public.retail_orders o on o.id = p.order_id where o.customer_id = p_customer_id
  union all
  select 'FULFILMENT', fi.id, fi.created_at, fi.mode || ' fulfilment', fi.status, null::uuid
    from public.retail_fulfilment_items fi join public.retail_orders o on o.id = fi.order_id where o.customer_id = p_customer_id
  union all
  select 'PACKING', pk.id, pk.created_at, 'Packing', pk.status, pk.linked_task_id
    from public.retail_packing_records pk join public.retail_orders o on o.id = pk.order_id where o.customer_id = p_customer_id
  union all
  select 'GODOWN_HANDOVER', gh.id, gh.created_at, 'Godown handover', gh.status, gh.linked_task_id
    from public.retail_godown_handovers gh join public.retail_orders o on o.id = gh.order_id where o.customer_id = p_customer_id
  union all
  select 'DISPATCH', d.id, coalesce(d.dispatched_at, d.created_at), 'Dispatch', case when d.dispatched_at is not null then 'DISPATCHED' else 'PENDING' end, d.linked_task_id
    from public.retail_dispatch_records d join public.retail_orders o on o.id = d.order_id where o.customer_id = p_customer_id
  union all
  select 'DELIVERY', dl.id, dl.updated_at, 'Delivery', dl.stage, dl.linked_task_id
    from public.retail_deliveries dl join public.retail_orders o on o.id = dl.order_id where o.customer_id = p_customer_id
  union all
  select 'DELIVERY_PROOF', dp.id, dp.created_at, 'Delivery proof (' || dp.proof_type || ')', dp.proof_type, null::uuid
    from public.retail_delivery_proofs dp join public.retail_deliveries dl on dl.id = dp.delivery_id join public.retail_orders o on o.id = dl.order_id where o.customer_id = p_customer_id
  union all
  select 'INSTALLATION', ins.id, ins.updated_at, 'Installation', ins.status, ins.linked_task_id
    from public.retail_installations ins join public.retail_orders o on o.id = ins.order_id where o.customer_id = p_customer_id
  union all
  select 'COMPLAINT', c.id, c.created_at, c.description, c.status, null::uuid
    from public.retail_complaints c where c.customer_id = p_customer_id
  union all
  select 'OWNERSHIP_CHANGE', log.id, log.created_at, log.action, log.action, null::uuid
    from public.retail_customer_ownership_log log where log.customer_id = p_customer_id
  order by occurred_at desc;
end $$;
