-- Follow-up to v2_93r: retail_report_item_damage's "photo required" check matched ANY existing proof photo on the
-- item, including its ORIGINAL intake photo (present on every serialized item from day one, uploaded by whoever
-- did the stock intake). That made the gate meaningless for any normally-intaken item. Caught while testing: a
-- Godown Head could report damage with zero new evidence, reusing an old photo uploaded by a different worker.
-- Fixed by requiring the damage photo to have been uploaded by the reporter themselves -- a real, fresh photo of
-- the actual damage, not an old unrelated one.
create or replace function public.retail_report_item_damage(p_inventory_item_id uuid, p_reason text)
returns public.retail_inventory_items
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_item public.retail_inventory_items; v_allowed boolean; v_has_photo boolean; v_order public.retail_orders; v_prev_status text;
begin
  perform public.staff_assert_operational();
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to report damage'; end if;
  select * into v_item from public.retail_inventory_items where id = p_inventory_item_id for update;
  if v_item.id is null then raise exception 'Item not found'; end if;
  v_prev_status := v_item.status;

  v_allowed := (coalesce(public.staff_is_godown_staff(), false) or coalesce(public.staff_has_global_oversight(), false) or coalesce(public.staff_is_dept_head(), false));
  if not v_allowed then raise exception 'Not authorized to report damage'; end if;

  select exists (select 1 from public.staff_attachments where entity_type = 'retail_inventory_item' and entity_id = p_inventory_item_id
    and purpose = 'proof' and is_active and uploaded_by = auth.uid()) into v_has_photo;
  if not v_has_photo then raise exception 'A damage photo (taken by you, just now) is required'; end if;

  update public.retail_inventory_items set status = 'DAMAGED', damage_reason = p_reason, updated_at = now() where id = p_inventory_item_id returning * into v_item;
  perform public.retail_log_status_change('retail_inventory_item', p_inventory_item_id, v_prev_status, 'DAMAGED', public.retail_godown_dept_id(), p_reason);

  if v_item.reserved_order_id is not null then
    select * into v_order from public.retail_orders where id = v_item.reserved_order_id;
    update public.retail_orders set on_hold = true, on_hold_reason = 'Damaged item: ' || v_item.serial_number || ' — ' || p_reason where id = v_item.reserved_order_id;
    if v_order.created_by is not null then
      perform public.staff_notify_assignment(v_order.created_by, 'retail_inventory_item', p_inventory_item_id,
        'Item damaged: ' || v_item.serial_number || ' (' || v_order.order_number || ')', v_order.order_number || ' — વસ્તુ ક્ષતિગ્રસ્ત મળી');
    end if;
    perform public.staff_notify_dept_leadership('RETAIL', 'retail_inventory_item', p_inventory_item_id,
      'Item damaged: ' || v_item.serial_number || ' (' || v_order.order_number || ')', v_order.order_number || ' — વસ્તુ ક્ષતિગ્રસ્ત મળી');
  end if;

  perform public.staff_write_audit('retail_inventory_item', p_inventory_item_id, 'DAMAGE_REPORT', null, jsonb_build_object('reason', p_reason), public.retail_godown_dept_id());
  return v_item;
end $function$;
