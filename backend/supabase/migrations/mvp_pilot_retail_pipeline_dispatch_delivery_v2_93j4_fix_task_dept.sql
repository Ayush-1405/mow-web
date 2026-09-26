-- v2_93j4 -- hotfix: retail_record_delivery_proof()'s pending-delivery task (created when a delivery is only PARTIAL) passed
-- p_from_department_id = v_delivery.department_id (always RETAIL) to staff_create_task(), but the actual caller authorized to
-- record delivery proof is Dispatch staff (or oversight/dept-head) -- staff_create_task's own authority check requires the CALLER's
-- department to match p_from_department_id ("You may only create tasks from your own department"), so a genuine Dispatch employee
-- correctly recording a partial delivery hit a hard failure and the whole call rolled back (confirmed live). Fixed to route it as
-- the Bridge it actually is -- Dispatch flagging an issue back to Retail -- exactly like retail_record_dispatch() already does for
-- its own task (DISPATCH -> RETAIL), instead of the mismatched RETAIL -> RETAIL it had before.
create or replace function public.retail_record_delivery_proof(
  p_order_id uuid, p_site_representative_name text, p_pod_method text, p_pod_reference text default null,
  p_items jsonb default '[]'::jsonb, p_condition_notes text default null)
returns public.retail_deliveries language plpgsql security definer set search_path = public as $$
declare
  v_order public.retail_orders; v_delivery public.retail_deliveries; v_allowed boolean; v_has_photo boolean;
  v_it jsonb; v_ordered numeric; v_delivered numeric; v_all_delivered boolean := true; v_new_stage text; v_key text; v_task_id uuid;
begin
  perform public.staff_assert_operational();
  if p_pod_method not in ('SIGNATURE', 'OTP', 'PHOTO_CONFIRM') then raise exception 'Invalid proof-of-delivery method'; end if;
  select * into v_order from public.retail_orders where id = p_order_id;
  if v_order.id is null then raise exception 'Order not found'; end if;
  select * into v_delivery from public.retail_deliveries where order_id = p_order_id for update;
  if v_delivery.id is null or not exists (select 1 from public.retail_dispatch_records where order_id = p_order_id and dispatched_at is not null) then
    raise exception 'Order has not been dispatched yet';
  end if;

  v_allowed := (coalesce(public.staff_is_dispatch_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_delivery.department_id), false)));
  if not v_allowed then raise exception 'Not authorized to record delivery proof'; end if;

  select exists (select 1 from public.staff_attachments a where a.entity_type = 'retail_delivery' and a.entity_id = v_delivery.id
    and a.purpose = 'proof' and a.is_active) into v_has_photo;
  if not v_has_photo then raise exception 'A delivery-site photo is required before delivery proof can be recorded'; end if;

  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select quantity into v_ordered from public.retail_order_items where id = (v_it->>'order_item_id')::uuid;
    v_delivered := coalesce((v_it->>'quantity_delivered')::numeric, 0);
    insert into public.retail_delivery_items (delivery_id, order_item_id, quantity_delivered, quantity_pending, condition)
    values (v_delivery.id, (v_it->>'order_item_id')::uuid, v_delivered, greatest(coalesce(v_ordered, v_delivered) - v_delivered, 0), v_it->>'condition')
    on conflict (delivery_id, order_item_id) do update set quantity_delivered = excluded.quantity_delivered,
      quantity_pending = excluded.quantity_pending, condition = excluded.condition, updated_at = now();
  end loop;

  select bool_and(quantity_pending <= 0) into v_all_delivered from public.retail_delivery_items where delivery_id = v_delivery.id;
  v_new_stage := case when coalesce(v_all_delivered, false) then 'DELIVERY_SUCCESSFUL' else 'DELIVERY_PROOF_UPLOADED' end;

  update public.retail_deliveries set stage = v_new_stage where id = v_delivery.id returning * into v_delivery;

  insert into public.retail_delivery_proofs (delivery_id, proof_type, site_representative_name, delivered_by, pod_method, pod_reference, condition_notes, created_by)
  values (v_delivery.id, 'DELIVERY', p_site_representative_name, auth.uid(), p_pod_method, p_pod_reference, p_condition_notes, auth.uid());

  if v_new_stage = 'DELIVERY_PROOF_UPLOADED' then
    v_key := 'retail_pending_delivery:' || p_order_id::text;
    if not exists (select 1 from public.staff_tasks where system_key = v_key and is_active) then
      select tk.task_id into v_task_id from public.staff_create_task(
        'Pending delivery: ' || v_order.order_number, 'Some items were not fully delivered — arrange the remaining quantity.',
        'DELIVERY', 'URGENT', 'photo', public.retail_dispatch_dept_id(), v_delivery.department_id, v_order.created_by, current_date + 2, null,
        null, v_order.order_number, null, null, null, null) tk;
      update public.staff_tasks set system_key = v_key where id = v_task_id;
    end if;
  end if;

  perform public.retail_log_status_change('retail_order', p_order_id, 'OUT_FOR_DELIVERY', v_new_stage, v_delivery.department_id, p_condition_notes);
  perform public.staff_write_audit('retail_order', p_order_id, 'DELIVERY_PROOF', null, jsonb_build_object('stage', v_new_stage), v_delivery.department_id);
  return v_delivery;
end $$;
