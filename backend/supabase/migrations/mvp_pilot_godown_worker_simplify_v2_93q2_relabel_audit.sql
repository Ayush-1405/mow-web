-- Small follow-up to v2_93q: "Reprint with audit reason" (Part 4 of the pilot's QR spec) -- a real audit-logged
-- record every time a label is reprinted, not just a client-side re-render of the same QR image.
create or replace function public.retail_log_label_reprint(p_product_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_allowed boolean;
begin
  perform public.staff_assert_operational();
  if not exists (select 1 from public.retail_products where id = p_product_id and is_active) then
    raise exception 'Product not found';
  end if;
  v_allowed := (coalesce(public.staff_is_godown_staff(), false) or coalesce(public.staff_has_global_oversight(), false)
    or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(public.retail_godown_dept_id()), false)));
  if not v_allowed then raise exception 'Not authorized to reprint this label'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to reprint a label'; end if;

  perform public.staff_write_audit('retail_product', p_product_id, 'LABEL_REPRINT', null, null, public.retail_godown_dept_id(), p_reason);
end $function$;

grant execute on function public.retail_log_label_reprint(uuid, text) to authenticated;
