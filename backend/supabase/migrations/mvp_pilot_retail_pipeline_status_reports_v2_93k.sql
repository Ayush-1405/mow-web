-- v2_93k -- one status rollup + salesperson/pipeline/ownership reports + the full customer timeline (packing/godown/dispatch/
-- delivery/installation entries added to the partial version from v2_93h, now that those tables exist).

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. retail_orders.pipeline_status -- system-computed only (no direct client UPDATE grant on this column path; it is only ever set
--    by retail_recompute_order_pipeline_status(), called at the tail of every pipeline RPC). retail_orders.status (BOOKED/CONFIRMED/
--    .../DELIVERED/CANCELLED) is left as-is (v2_2b's original lifecycle column); pipeline_status is the finer-grained "where is this
--    order right now, across every department" read model §15 asks for.
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.retail_orders add column if not exists pipeline_status text not null default 'BOOKED';

create or replace function public.retail_recompute_order_pipeline_status(p_order_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_order public.retail_orders; v_delivery public.retail_deliveries; v_install public.retail_installations;
  v_packing public.retail_packing_records; v_handover public.retail_godown_handovers; v_dispatch public.retail_dispatch_records;
  v_status text; v_not_ready int;
begin
  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order.id is null then return null; end if;
  if v_order.on_hold then
    v_status := 'ON_HOLD';
  elsif v_order.status = 'CANCELLED' then
    v_status := 'CANCELLED';
  else
    select * into v_delivery from public.retail_deliveries where order_id = p_order_id;
    select * into v_install from public.retail_installations where order_id = p_order_id;
    select * into v_packing from public.retail_packing_records where order_id = p_order_id;
    select * into v_handover from public.retail_godown_handovers where order_id = p_order_id and status in ('PENDING', 'ACCEPTED') order by created_at desc limit 1;
    select * into v_dispatch from public.retail_dispatch_records where order_id = p_order_id;

    if v_install.id is not null and v_install.status = 'COMPLETED' then v_status := 'COMPLETED';
    elsif v_delivery.id is not null and v_delivery.stage = 'COMPLETED' then v_status := 'COMPLETED';
    elsif v_install.id is not null then v_status := coalesce(v_delivery.stage, 'INSTALLATION_PENDING');
    elsif v_delivery.id is not null and v_delivery.stage in ('DELIVERY_SUCCESSFUL', 'DELIVERY_PROOF_UPLOADED', 'DELIVERY_FAILED', 'OUT_FOR_DELIVERY', 'ARRIVED_AT_SITE') then
      v_status := v_delivery.stage;
    elsif v_dispatch.id is not null and v_dispatch.dispatched_at is not null then v_status := 'OUT_FOR_DELIVERY';
    elsif v_handover.id is not null and v_handover.status = 'ACCEPTED' then v_status := 'RECEIVED_AT_GODOWN';
    elsif v_handover.id is not null and v_handover.status = 'PENDING' then v_status := 'ASSIGNED_TO_GODOWN';
    elsif v_packing.id is not null and v_packing.status = 'READY_FOR_GODOWN' then v_status := 'READY_FOR_GODOWN';
    elsif v_packing.id is not null then v_status := 'PACKING';
    elsif v_order.status = 'CONFIRMED' then
      select count(*) into v_not_ready from public.retail_fulfilment_items where order_id = p_order_id and status <> 'READY';
      v_status := case when v_not_ready = 0 then 'FULFILMENT_READY' else 'FULFILMENT_PENDING' end;
    else
      v_status := v_order.status;
    end if;
  end if;

  update public.retail_orders set pipeline_status = v_status where id = p_order_id;
  return v_status;
end $$;
revoke all on function public.retail_recompute_order_pipeline_status(uuid) from public, anon, authenticated;

-- back-fill every existing confirmed order once, and wire the recompute into every pipeline RPC that changes state.
do $$
declare r record;
begin
  for r in select id from public.retail_orders where status in ('CONFIRMED', 'DELIVERED') loop
    perform public.retail_recompute_order_pipeline_status(r.id);
  end loop;
end $$;

-- Re-wire every pipeline-advancing RPC to call the recompute at its tail (CREATE OR REPLACE, identical bodies + one added line each).
create or replace function public.retail_confirm_order(p_order_id uuid, p_fulfilment jsonb default '[]'::jsonb)
returns setof public.retail_fulfilment_items language plpgsql security definer set search_path = public as $$
declare
  v_order public.retail_orders; v_allowed boolean; v_item record; v_ov jsonb; v_mode text; v_qty numeric;
  v_proc_dept uuid; v_pr_number text; v_pr_id uuid; v_job record; v_any_stock boolean := false; v_any_factory boolean := false; v_any_outsource boolean := false;
begin
  perform public.staff_assert_operational();
  select * into v_order from public.retail_orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;

  v_allowed := (v_order.created_by = auth.uid() or public.staff_has_global_oversight()
    or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_order.department_id)));
  if not v_allowed then raise exception 'Not authorized to confirm this order'; end if;

  if v_order.fulfilment_locked then
    return query select * from public.retail_fulfilment_items where order_id = p_order_id;
    return;
  end if;
  if not exists (select 1 from public.retail_order_items where order_id = p_order_id) then
    raise exception 'This order has no line items';
  end if;

  select id into v_proc_dept from public.departments where code = 'PROCUREMENT';

  for v_item in select * from public.retail_order_items where order_id = p_order_id order by created_at loop
    v_ov := null;
    select elem into v_ov from jsonb_array_elements(coalesce(p_fulfilment, '[]'::jsonb)) elem where (elem->>'order_item_id')::uuid = v_item.id limit 1;
    v_mode := coalesce(v_ov->>'mode', v_item.fulfilment_mode);
    if v_mode is null or v_mode not in ('STOCK', 'FACTORY', 'OUTSOURCE') then
      raise exception 'A fulfilment mode (Stock / Factory / Outsource) is required for every item — missing for %', v_item.item_name;
    end if;
    v_qty := coalesce((v_ov->>'quantity')::numeric, v_item.quantity);
    update public.retail_order_items set fulfilment_mode = v_mode where id = v_item.id;

    if v_mode = 'STOCK' then
      v_any_stock := true;
      insert into public.retail_fulfilment_items (order_id, order_item_id, mode, quantity, status, stock_location_id, created_by)
      values (p_order_id, v_item.id, 'STOCK', v_qty, 'RESERVED', coalesce((v_ov->>'stock_location_id')::uuid, v_order.location_id), auth.uid())
      on conflict (order_item_id) do nothing;

    elsif v_mode = 'FACTORY' then
      v_any_factory := true;
      select * into v_job from public.factory_create_job_internal(
        auth.uid(), public.retail_dept_id(), 'retail-order-item:' || v_item.id::text, 'retail', v_order.order_number, v_item.id,
        null, v_order.customer_name, v_order.delivery_address, v_item.item_name,
        coalesce((v_ov->>'required_date')::date, v_order.required_delivery_date, current_date + 14), coalesce(v_ov->>'priority', 'Normal'),
        coalesce(v_ov->>'notes', v_item.customization_notes),
        jsonb_build_array(jsonb_build_object('item_name', v_item.item_name, 'quantity', v_qty, 'dimensions', v_item.dimensions,
          'finish', v_item.finish_color_fabric, 'instruction', v_item.customization_notes)),
        null, null, nullif(v_ov->>'factory_location_id', '')::uuid);
      insert into public.retail_fulfilment_items (order_id, order_item_id, mode, quantity, status, job_card_id, created_by)
      values (p_order_id, v_item.id, 'FACTORY', v_qty, 'IN_PROGRESS', v_job.job_id, auth.uid())
      on conflict (order_item_id) do nothing;

    elsif v_mode = 'OUTSOURCE' then
      v_any_outsource := true;
      v_pr_number := 'RPR-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));
      insert into public.retail_procurement_requests (
        request_number, department_id, origin_department_id, order_id, order_item_id, item_name, specification, quantity,
        required_date, target_cost, preferred_vendor, delivery_destination, qc_requirement, created_by
      ) values (
        v_pr_number, v_proc_dept, public.retail_dept_id(), p_order_id, v_item.id, v_item.item_name,
        coalesce(v_ov->>'specification', v_item.customization_notes), v_qty,
        coalesce((v_ov->>'required_date')::date, v_order.required_delivery_date), nullif(v_ov->>'target_cost', '')::numeric,
        nullif(v_ov->>'preferred_vendor', ''), coalesce(nullif(v_ov->>'delivery_destination', ''), v_order.delivery_address), nullif(v_ov->>'qc_requirement', ''), auth.uid()
      ) on conflict (order_item_id) do nothing returning id into v_pr_id;
      if v_pr_id is not null then
        insert into public.retail_fulfilment_items (order_id, order_item_id, mode, quantity, status, procurement_request_id, created_by)
        values (p_order_id, v_item.id, 'OUTSOURCE', v_qty, 'PENDING', v_pr_id, auth.uid());
        perform public.staff_notify_dept_leadership('PROCUREMENT', 'retail_procurement_request', v_pr_id,
          'New procurement request from Retail: ' || v_item.item_name || ' (' || v_order.order_number || ')',
          'રિટેલ તરફથી નવી ખરીદ વિનંતી: ' || v_item.item_name || ' (' || v_order.order_number || ')');
      end if;
    end if;
  end loop;

  update public.retail_orders set status = 'CONFIRMED', confirmed_at = now(), confirmed_by = auth.uid(), fulfilment_locked = true where id = p_order_id;
  insert into public.retail_deliveries (department_id, order_id, delivery_address, created_by)
  values (public.retail_dept_id(), p_order_id, v_order.delivery_address, auth.uid())
  on conflict (order_id) do nothing;

  perform public.staff_write_audit('retail_order', p_order_id, 'CONFIRM_ORDER', jsonb_build_object('status', v_order.status),
    jsonb_build_object('status', 'CONFIRMED', 'has_stock', v_any_stock, 'has_factory', v_any_factory, 'has_outsource', v_any_outsource), public.retail_dept_id());
  perform public.retail_recompute_order_pipeline_status(p_order_id);

  return query select * from public.retail_fulfilment_items where order_id = p_order_id;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. Everything AFTER confirm-order is kept in sync via triggers on the pipeline tables themselves, rather than re-editing the 9
--    other RPCs that can change one of them -- lower-risk (none of those already-tested function bodies are touched) and it also
--    catches any FUTURE writer to these tables automatically, RPC or otherwise.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_trg_recompute_pipeline_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.retail_recompute_order_pipeline_status(coalesce(new.order_id, old.order_id));
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['retail_packing_records', 'retail_godown_handovers', 'retail_dispatch_records', 'retail_deliveries', 'retail_installations', 'retail_fulfilment_items'] loop
    execute format('drop trigger if exists trg_recompute_pipeline_status on public.%I', t);
    execute format('create trigger trg_recompute_pipeline_status after insert or update on public.%I for each row execute function public.retail_trg_recompute_pipeline_status()', t);
  end loop;
end $$;

-- retail_orders itself: on_hold flips also change the rollup (e.g. a Godown rejection). The recompute's own write touches only
-- pipeline_status (a different column), so this never re-fires itself -- the depth guard is extra margin, not a requirement.
create or replace function public.retail_trg_recompute_pipeline_status_self() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.retail_recompute_order_pipeline_status(new.id);
  return new;
end $$;

drop trigger if exists trg_recompute_pipeline_status_order on public.retail_orders;
create trigger trg_recompute_pipeline_status_order after update of on_hold, status on public.retail_orders for each row
  when (pg_trigger_depth() < 2) execute function public.retail_trg_recompute_pipeline_status_self();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. retail_reports_summary -- CREATE OR REPLACE, gains real ownership scoping (confirmed live: the previous version's own comment
--    claimed this was scoped "the same as the dashboard's own counts", but the SQL body had no ownership filter at all -- any
--    authenticated Retail-adjacent caller got org-wide numbers). p_scope defaults to 'own'; 'team'/'all' are gated to dept-head/
--    oversight. Same field set as before (purely additive change to its signature -- two new trailing defaulted params).
-- ---------------------------------------------------------------------------------------------------------------------------------
-- drop the old 2-arg overload FIRST: adding trailing params via a bare CREATE OR REPLACE would create a second overload (the same
-- ambiguous-call class of bug found and fixed in v2_93h2 for retail_upsert_customer), not replace it.
drop function if exists public.retail_reports_summary(date, date);

create or replace function public.retail_reports_summary(
  p_from date default current_date - 30, p_to date default current_date, p_scope text default 'own', p_salesperson_id uuid default auth.uid())
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_result jsonb; v_target uuid; v_own_filter boolean;
begin
  perform public.staff_assert_operational();
  if p_scope not in ('own', 'team', 'all') then raise exception 'Invalid scope'; end if;
  if p_scope in ('team', 'all') and not (coalesce(public.staff_has_global_oversight(), false)
      or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false))) then
    raise exception 'Only Retail Head or Management may view team/all-scope reports';
  end if;
  v_target := coalesce(p_salesperson_id, auth.uid());
  if p_scope = 'own' and v_target <> auth.uid() and not (coalesce(public.staff_has_global_oversight(), false)
      or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false))) then
    raise exception 'Not authorized to view another salesperson''s report';
  end if;
  v_own_filter := (p_scope = 'own');

  select jsonb_build_object(
    'scope', p_scope, 'salesperson_id', case when v_own_filter then v_target else null end,
    'walkins_total', (select count(*) from retail_leads where is_active and created_at::date between p_from and p_to and (not v_own_filter or created_by = v_target)),
    'leads_by_source', (select coalesce(jsonb_object_agg(source, n), '{}'::jsonb) from (select coalesce(source, 'unknown') source, count(*) n from retail_leads where is_active and created_at::date between p_from and p_to and (not v_own_filter or created_by = v_target) group by 1) x),
    'leads_won', (select count(*) from retail_leads where is_active and status = 'CONVERTED' and updated_at::date between p_from and p_to and (not v_own_filter or assigned_to = v_target or created_by = v_target)),
    'leads_lost', (select count(*) from retail_leads where is_active and status = 'LOST' and updated_at::date between p_from and p_to and (not v_own_filter or assigned_to = v_target or created_by = v_target)),
    'followups_overdue', (select count(*) from retail_leads where is_active and next_follow_up_date < current_date and status not in ('CONVERTED', 'LOST') and (not v_own_filter or assigned_to = v_target or created_by = v_target)),
    'quotations_total', (select count(*) from retail_quotations where is_active and created_at::date between p_from and p_to and (not v_own_filter or created_by = v_target)),
    'quotations_accepted', (select count(*) from retail_quotations where is_active and status = 'ACCEPTED' and created_at::date between p_from and p_to and (not v_own_filter or created_by = v_target)),
    'orders_total', (select count(*) from retail_orders where is_active and created_at::date between p_from and p_to and (not v_own_filter or created_by = v_target)),
    'orders_value', (select coalesce(sum(total_amount), 0) from retail_orders where is_active and created_at::date between p_from and p_to and (not v_own_filter or created_by = v_target)),
    'orders_confirmed_value', (select coalesce(sum(total_amount), 0) from retail_orders where is_active and status = 'CONFIRMED' and created_at::date between p_from and p_to and (not v_own_filter or created_by = v_target)),
    'pending_collection', (select coalesce(sum(total_amount - amount_paid), 0) from retail_orders where is_active and payment_status <> 'PAID' and created_at::date between p_from and p_to and (not v_own_filter or created_by = v_target)),
    'factory_linked_orders', (select count(distinct fi.order_id) from retail_fulfilment_items fi join retail_orders o on o.id = fi.order_id where fi.mode = 'FACTORY' and fi.created_at::date between p_from and p_to and (not v_own_filter or o.created_by = v_target)),
    'outsource_linked_orders', (select count(distinct fi.order_id) from retail_fulfilment_items fi join retail_orders o on o.id = fi.order_id where fi.mode = 'OUTSOURCE' and fi.created_at::date between p_from and p_to and (not v_own_filter or o.created_by = v_target)),
    'orders_packed', (select count(*) from retail_packing_records pr join retail_orders o on o.id = pr.order_id where pr.status = 'READY_FOR_GODOWN' and pr.updated_at::date between p_from and p_to and (not v_own_filter or o.created_by = v_target)),
    'orders_assigned_to_godown', (select count(distinct gh.order_id) from retail_godown_handovers gh join retail_orders o on o.id = gh.order_id where gh.created_at::date between p_from and p_to and (not v_own_filter or o.created_by = v_target)),
    'deliveries_completed', (select count(*) from retail_deliveries dl join retail_orders o on o.id = dl.order_id where dl.is_active and dl.stage = 'COMPLETED' and dl.updated_at::date between p_from and p_to and (not v_own_filter or o.created_by = v_target)),
    'deliveries_successful', (select count(*) from retail_deliveries dl join retail_orders o on o.id = dl.order_id where dl.is_active and dl.stage in ('DELIVERY_SUCCESSFUL', 'COMPLETED') and dl.updated_at::date between p_from and p_to and (not v_own_filter or o.created_by = v_target)),
    'deliveries_failed', (select count(*) from retail_delivery_proofs dp join retail_deliveries dl on dl.id = dp.delivery_id join retail_orders o on o.id = dl.order_id where dp.proof_type = 'FAILURE' and dp.created_at::date between p_from and p_to and (not v_own_filter or o.created_by = v_target)),
    'deliveries_partial', (select count(*) from retail_deliveries dl join retail_orders o on o.id = dl.order_id where dl.is_active and dl.stage = 'DELIVERY_PROOF_UPLOADED' and (not v_own_filter or o.created_by = v_target)),
    'deliveries_delayed', (select count(*) from retail_deliveries dl join retail_orders o on o.id = dl.order_id where dl.is_active and dl.delay_reason is not null and dl.stage not in ('DELIVERED', 'COMPLETED') and (not v_own_filter or o.created_by = v_target)),
    'installations_pending', (select count(*) from retail_installations ins join retail_orders o on o.id = ins.order_id where ins.status in ('PENDING', 'IN_PROGRESS', 'PROOF_UPLOADED') and (not v_own_filter or o.created_by = v_target)),
    'installations_completed', (select count(*) from retail_installations ins join retail_orders o on o.id = ins.order_id where ins.status = 'COMPLETED' and ins.completed_at::date between p_from and p_to and (not v_own_filter or o.created_by = v_target)),
    'complaints_open', (select count(*) from retail_complaints c where c.is_active and c.status <> 'RESOLVED' and (not v_own_filter or c.created_by = v_target or c.assigned_to = v_target)),
    'avg_feedback_score', (select round(avg(feedback_score), 2) from retail_deliveries dl join retail_orders o on o.id = dl.order_id where dl.is_active and dl.feedback_score is not null and dl.updated_at::date between p_from and p_to and (not v_own_filter or o.created_by = v_target)),
    'display_updates_total', (select count(*) from retail_display_updates where is_active and created_at::date between p_from and p_to)
  ) into v_result;
  return v_result;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. retail_salesperson_report / retail_pipeline_report / retail_ownership_report
-- ---------------------------------------------------------------------------------------------------------------------------------
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

create or replace function public.retail_ownership_report()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_result jsonb;
begin
  perform public.staff_assert_operational();
  if not (coalesce(public.staff_has_global_oversight(), false)
      or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_dept_id()), false))) then
    raise exception 'Only Retail Head or Management may view the ownership report';
  end if;
  select jsonb_build_object(
    'by_owner', (select coalesce(jsonb_agg(jsonb_build_object('owner_id', owner_salesperson_id, 'owner_name', up.full_name, 'customer_count', n)), '[]'::jsonb)
      from (select owner_salesperson_id, count(*) n from retail_customers where is_active group by owner_salesperson_id) x
      left join user_profiles up on up.id = x.owner_salesperson_id),
    'transferred_count', (select count(*) from retail_customer_ownership_log where action = 'TRANSFERRED'),
    'shared_backup_count', (select count(*) from retail_customer_access where is_active and access_type in ('BACKUP', 'TEMPORARY')),
    'readonly_shared_count', (select count(*) from retail_customer_access where is_active and access_type = 'READONLY'),
    'unassigned_customers', (select count(*) from retail_customers where is_active and owner_salesperson_id is null),
    'duplicate_alerts_open', (select count(*) from retail_customer_access_requests where status = 'PENDING'),
    'customers_without_future_followup', (select count(*) from retail_customers c where c.is_active and not exists (
      select 1 from retail_leads l where l.customer_id = c.id and l.next_follow_up_date >= current_date and l.status not in ('CONVERTED','LOST')))
  ) into v_result;
  return v_result;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. retail_customer_timeline -- CREATE OR REPLACE of the v2_93h partial version: adds packing/godown/dispatch/delivery/
--    installation entries now that those tables exist. Same signature, same access check.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_customer_timeline(p_customer_id uuid)
returns table (entry_type text, entity_id uuid, occurred_at timestamptz, title text, status text, linked_task_id uuid)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_assert_operational();
  if not public.retail_can_access_customer(p_customer_id) then raise exception 'Not authorized to view this customer'; end if;
  -- the first branch's column ALIASES become the UNION's own output column names -- required for "order by occurred_at" below to
  -- resolve at all (confirmed live: without these aliases, PL/pgSQL only catches this at first EXECUTION, not at CREATE time, and
  -- this function had shipped with exactly that bug, unexercised, since the partial version in v2_93h).
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

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 6. grants
-- ---------------------------------------------------------------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'retail_confirm_order(uuid, jsonb)',
    'retail_reports_summary(date, date, text, uuid)',
    'retail_salesperson_report(uuid, date, date)',
    'retail_pipeline_report(date, date)',
    'retail_ownership_report()',
    'retail_customer_timeline(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
