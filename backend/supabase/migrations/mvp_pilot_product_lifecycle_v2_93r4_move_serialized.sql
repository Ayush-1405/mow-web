-- Follow-up to v2_93r: retail_move_stock_to_display (from v2_93q) only ever touched the bulk retail_stock table --
-- for a serialized product (one with retail_inventory_items rows) that table is just an unused placeholder,
-- so the function would raise "No source stock found" for exactly the furniture-serial case this spec cares
-- about. Caught while re-running the v2_93q regression suite against the new two-tier model. Fixed by moving
-- specific AVAILABLE serials (by location) when the product is serialized, unchanged bulk behavior otherwise.
create or replace function public.retail_move_stock_to_display(p_product_id uuid, p_to_location_id uuid, p_quantity numeric, p_note text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_allowed boolean; v_src public.retail_stock; v_available numeric; v_reserved numeric; v_qty numeric := coalesce(p_quantity, 0);
  v_product public.retail_products; v_is_serialized boolean; v_moved int := 0; v_item record; v_from_loc uuid;
begin
  perform public.staff_assert_operational();
  v_allowed := (coalesce(public.staff_is_godown_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_godown_dept_id()), false)));
  if not v_allowed then raise exception 'Not authorized to move stock'; end if;
  if v_qty <= 0 then raise exception 'Quantity must be positive'; end if;

  select * into v_product from public.retail_products where id = p_product_id and is_active;
  if v_product.id is null then raise exception 'Product not found'; end if;
  if not exists (select 1 from public.locations where id = p_to_location_id and is_active) then raise exception 'Invalid destination location'; end if;

  select exists (select 1 from public.retail_inventory_items where product_id = p_product_id) into v_is_serialized;

  if v_is_serialized then
    if v_qty <> floor(v_qty) then raise exception 'A serialized item can only be moved in whole units'; end if;
    for v_item in
      select * from public.retail_inventory_items where product_id = p_product_id and status = 'AVAILABLE' and location_id <> p_to_location_id
      order by created_at limit v_qty::int for update
    loop
      v_from_loc := v_item.location_id;
      update public.retail_inventory_items set location_id = p_to_location_id, updated_at = now() where id = v_item.id;
      insert into public.retail_stock_movements (product_id, from_location_id, to_location_id, quantity, reason, moved_by)
      values (p_product_id, v_from_loc, p_to_location_id, 1, p_note, auth.uid());
      perform public.retail_log_status_change('retail_inventory_item', v_item.id, 'AVAILABLE', 'AVAILABLE', public.retail_godown_dept_id(),
        coalesce(p_note, 'Moved to Display'));
      v_moved := v_moved + 1;
    end loop;
    if v_moved < v_qty then raise exception 'Only % available to move', v_moved; end if;

  else
    select * into v_src from public.retail_stock where product_id = p_product_id and location_id <> p_to_location_id and on_hand_qty > 0
      order by on_hand_qty desc limit 1 for update;
    if v_src.id is null then raise exception 'No source stock found for this product'; end if;

    select coalesce(sum(fi.quantity), 0) into v_reserved
      from public.retail_fulfilment_items fi join public.retail_order_items oi on oi.id = fi.order_item_id
      where fi.mode = 'STOCK' and fi.status not in ('CANCELLED') and upper(oi.sku) = upper(v_product.sku);

    v_available := greatest(v_src.on_hand_qty - coalesce(v_reserved, 0) - v_src.damaged_qty, 0);
    if v_qty > v_available then raise exception 'Only % available to move', v_available; end if;

    update public.retail_stock set on_hand_qty = on_hand_qty - v_qty, updated_by = auth.uid(), updated_at = now() where id = v_src.id;

    insert into public.retail_stock (product_id, location_id, on_hand_qty, updated_by)
    values (p_product_id, p_to_location_id, v_qty, auth.uid())
    on conflict (product_id, location_id) do update set on_hand_qty = public.retail_stock.on_hand_qty + excluded.on_hand_qty, updated_by = auth.uid(), updated_at = now();

    insert into public.retail_stock_movements (product_id, from_location_id, to_location_id, quantity, reason, moved_by)
    values (p_product_id, v_src.location_id, p_to_location_id, v_qty, p_note, auth.uid());
  end if;

  perform public.staff_write_audit('retail_product', p_product_id, 'MOVE_TO_DISPLAY', null,
    jsonb_build_object('location_id', p_to_location_id, 'quantity', v_qty, 'serialized', v_is_serialized), public.retail_godown_dept_id());
end $function$;
