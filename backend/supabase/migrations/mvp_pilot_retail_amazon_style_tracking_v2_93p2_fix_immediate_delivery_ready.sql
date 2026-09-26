-- Fixes a real regression introduced by 93p's generalization: IMMEDIATE_DELIVERY fulfilment items are inserted at
-- status='PENDING' and NOTHING ever moves them to 'READY' (by original design, that mode's readiness signal is
-- always the Sales Confirmation Product Photo, never the generic status column). 93p's blanket "every item must be
-- status='READY'" check therefore permanently blocked every Immediate Delivery order from ever auto-firing again.
-- Caught by re-running retail_immediate_delivery.sql immediately after 93p, before this was ever shipped as final.
create or replace function public.retail_maybe_auto_request_godown(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_order public.retail_orders;
  v_godown_dept uuid := public.retail_godown_dept_id();
  v_head uuid;
  v_not_ready int;
begin
  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order.id is null or v_order.status <> 'CONFIRMED' or v_order.on_hold then return; end if;

  if not exists (select 1 from public.retail_fulfilment_items where order_id = p_order_id) then return; end if;

  -- "ready" means status='READY' for STOCK/FACTORY/OUTSOURCE items (OUTSOURCE never reaches this yet -- no GRN
  -- concept exists, correctly blocking auto-fire until that's built); IMMEDIATE_DELIVERY items are ready once
  -- their own Sales Confirmation Product Photo is captured -- their generic status column is never used for
  -- readiness, exactly as originally designed.
  select count(*) into v_not_ready
    from public.retail_fulfilment_items fi
    join public.retail_order_items oi on oi.id = fi.order_item_id
    where fi.order_id = p_order_id and (
      (fi.mode = 'IMMEDIATE_DELIVERY' and oi.sales_photo_captured_at is null)
      or (fi.mode <> 'IMMEDIATE_DELIVERY' and fi.status <> 'READY')
    );
  if v_not_ready > 0 then return; end if;

  if v_order.total_amount > 0 and v_order.payment_status = 'PENDING' then return; end if;

  if exists (select 1 from public.retail_godown_handovers where order_id = p_order_id and status in ('PENDING','ACCEPTED')) then
    return;
  end if;

  select up.id into v_head from public.user_profiles up
    join public.roles ro on ro.id = up.role_id
    where up.is_active = true and up.department_id = v_godown_dept and ro.code = 'dept_head'
    order by up.created_at limit 1;
  if v_head is null then
    return;
  end if;

  perform public.retail_send_to_godown(p_order_id, null, v_head, null,
    'Automatic Godown fulfilment request — created once every item on this order was Ready.', true);
end $function$;
