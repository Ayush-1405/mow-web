-- Two additive keys on retail_pipeline_report/retail_salesperson_report for the Immediate Delivery fast-path (v2_93m).
create or replace function public.retail_pipeline_report(p_from date default current_date - 30, p_to date default current_date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_result jsonb;
begin
  perform public.staff_assert_operational();
  select jsonb_build_object(
    'lead', jsonb_build_object('count', (select count(*) from retail_leads where is_active and created_at::date between p_from and p_to)),
    'followup', jsonb_build_object('count', (select count(*) from retail_followups where created_at::date between p_from and p_to)),
    'quotation', jsonb_build_object('count', (select count(*) from retail_quotations where is_active and created_at::date between p_from and p_to), 'value', (select coalesce(sum(total_amount),0) from retail_quotations where is_active and created_at::date between p_from and p_to)),
    'confirmed', jsonb_build_object('count', (select count(*) from retail_orders where is_active and status='CONFIRMED' and confirmed_at::date between p_from and p_to), 'value', (select coalesce(sum(total_amount),0) from retail_orders where is_active and status='CONFIRMED' and confirmed_at::date between p_from and p_to)),
    'fulfilment_pending', jsonb_build_object('count', (select count(distinct order_id) from retail_fulfilment_items where status = 'PENDING')),
    'immediate_delivery', jsonb_build_object('count', (select count(*) from retail_fulfilment_items where mode='IMMEDIATE_DELIVERY' and created_at::date between p_from and p_to)),
    'awaiting_product_photo', jsonb_build_object('count', (select count(*) from retail_orders where is_active and pipeline_status='AWAITING_PRODUCT_PHOTO')),
    'factory', jsonb_build_object('count', (select count(*) from retail_fulfilment_items where mode='FACTORY' and created_at::date between p_from and p_to)),
    'procurement', jsonb_build_object('count', (select count(*) from retail_procurement_requests where is_active and created_at::date between p_from and p_to)),
    'stock_reserved', jsonb_build_object('count', (select count(*) from retail_fulfilment_items where mode='STOCK' and status='RESERVED')),
    'packing', jsonb_build_object('count', (select count(*) from retail_packing_records where status <> 'READY_FOR_GODOWN')),
    'godown', jsonb_build_object('count', (select count(*) from retail_godown_handovers where status='PENDING')),
    'delivery_scheduled', jsonb_build_object('count', (select count(*) from retail_deliveries where is_active and stage='DELIVERY_SCHEDULED')),
    'dispatched', jsonb_build_object('count', (select count(*) from retail_dispatch_records where dispatched_at is not null and dispatched_at::date between p_from and p_to)),
    'delivered', jsonb_build_object('count', (select count(*) from retail_deliveries where is_active and stage in ('DELIVERY_SUCCESSFUL','COMPLETED') and updated_at::date between p_from and p_to)),
    'installation', jsonb_build_object('count', (select count(*) from retail_installations where status <> 'COMPLETED')),
    'completed', jsonb_build_object('count', (select count(*) from retail_orders where is_active and pipeline_status='COMPLETED' and updated_at::date between p_from and p_to)),
    'on_hold_or_delayed', jsonb_build_object('count', (select count(*) from retail_orders where is_active and on_hold) + (select count(*) from retail_deliveries where is_active and stage='DELIVERY_FAILED'))
  ) into v_result;
  return v_result;
end $$;

create or replace function public.retail_salesperson_report(p_salesperson_id uuid default auth.uid(), p_from date default current_date - 30, p_to date default current_date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_target uuid := coalesce(p_salesperson_id, auth.uid()); v_result jsonb; v_conv numeric; v_leads_total int; v_leads_won int;
  v_deliv_total int; v_deliv_ontime int;
begin
  perform public.staff_assert_operational();
  if v_target <> auth.uid() and not (coalesce(public.staff_has_global_oversight(), false)
      or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false))) then
    raise exception 'Not authorized to view another salesperson''s report';
  end if;

  select count(*) into v_leads_total from retail_leads where created_by = v_target and created_at::date between p_from and p_to;
  select count(*) into v_leads_won from retail_leads where created_by = v_target and status = 'CONVERTED' and updated_at::date between p_from and p_to;
  v_conv := case when v_leads_total > 0 then round(100.0 * v_leads_won / v_leads_total, 1) else 0 end;

  select count(*) into v_deliv_total from retail_deliveries dl join retail_orders o on o.id = dl.order_id where o.created_by = v_target and dl.stage in ('DELIVERY_SUCCESSFUL', 'COMPLETED') and dl.updated_at::date between p_from and p_to;
  select count(*) into v_deliv_ontime from retail_deliveries dl join retail_orders o on o.id = dl.order_id where o.created_by = v_target and dl.stage in ('DELIVERY_SUCCESSFUL', 'COMPLETED') and dl.scheduled_at is not null and dl.updated_at <= dl.scheduled_at and dl.updated_at::date between p_from and p_to;

  select jsonb_build_object(
    'salesperson_id', v_target,
    'owned_customers', (select count(*) from retail_customers where owner_salesperson_id = v_target and is_active),
    'new_customers', (select count(*) from retail_customers where owner_salesperson_id = v_target and ownership_started_at::date between p_from and p_to),
    'customers_served', (select count(distinct customer_id) from retail_followups where created_by = v_target and created_at::date between p_from and p_to and customer_id is not null),
    'followups_due', (select count(*) from retail_leads where assigned_to = v_target and next_follow_up_date = current_date and status not in ('CONVERTED', 'LOST')),
    'followups_completed', (select count(*) from retail_followups where created_by = v_target and created_at::date between p_from and p_to),
    'followups_overdue', (select count(*) from retail_leads where assigned_to = v_target and next_follow_up_date < current_date and status not in ('CONVERTED', 'LOST')),
    'quotations_total', (select count(*) from retail_quotations where created_by = v_target and created_at::date between p_from and p_to),
    'confirmed_orders', (select count(*) from retail_orders where created_by = v_target and status = 'CONFIRMED' and confirmed_at::date between p_from and p_to),
    'order_value', (select coalesce(sum(total_amount), 0) from retail_orders where created_by = v_target and created_at::date between p_from and p_to),
    'stock_orders', (select count(distinct fi.order_id) from retail_fulfilment_items fi join retail_orders o on o.id = fi.order_id where o.created_by = v_target and fi.mode = 'STOCK'),
    'factory_orders', (select count(distinct fi.order_id) from retail_fulfilment_items fi join retail_orders o on o.id = fi.order_id where o.created_by = v_target and fi.mode = 'FACTORY'),
    'outsource_orders', (select count(distinct fi.order_id) from retail_fulfilment_items fi join retail_orders o on o.id = fi.order_id where o.created_by = v_target and fi.mode = 'OUTSOURCE'),
    'immediate_delivery_orders', (select count(distinct fi.order_id) from retail_fulfilment_items fi join retail_orders o on o.id = fi.order_id where o.created_by = v_target and fi.mode = 'IMMEDIATE_DELIVERY'),
    'awaiting_product_photo', (select count(*) from retail_orders where created_by = v_target and pipeline_status = 'AWAITING_PRODUCT_PHOTO'),
    'orders_packed', (select count(*) from retail_packing_records pr join retail_orders o on o.id = pr.order_id where o.created_by = v_target and pr.status = 'READY_FOR_GODOWN'),
    'orders_assigned_to_godown', (select count(distinct gh.order_id) from retail_godown_handovers gh join retail_orders o on o.id = gh.order_id where o.created_by = v_target),
    'deliveries_due', (select count(*) from retail_deliveries dl join retail_orders o on o.id = dl.order_id where o.created_by = v_target and dl.stage not in ('COMPLETED', 'DELIVERY_FAILED') and dl.scheduled_at::date between p_from and p_to),
    'deliveries_successful', v_deliv_total,
    'deliveries_failed_or_partial', (select count(*) from retail_deliveries dl join retail_orders o on o.id = dl.order_id where o.created_by = v_target and dl.stage in ('DELIVERY_FAILED', 'DELIVERY_PROOF_UPLOADED')),
    'installations_pending', (select count(*) from retail_installations ins join retail_orders o on o.id = ins.order_id where o.created_by = v_target and ins.status <> 'COMPLETED'),
    'installations_completed', (select count(*) from retail_installations ins join retail_orders o on o.id = ins.order_id where o.created_by = v_target and ins.status = 'COMPLETED'),
    'complaints', (select count(*) from retail_complaints where created_by = v_target or assigned_to = v_target),
    'conversion_percent', v_conv,
    'on_time_delivery_percent', case when v_deliv_total > 0 then round(100.0 * v_deliv_ontime / v_deliv_total, 1) else null end
  ) into v_result;
  return v_result;
end $$;
