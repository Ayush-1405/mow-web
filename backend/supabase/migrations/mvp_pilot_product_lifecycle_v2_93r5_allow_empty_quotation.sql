-- Follow-up to v2_93r: a QR-first quotation (Part 9 of the spec: "Create Quotation" -> "Scan QR / Add Product")
-- genuinely starts with zero items -- items are added afterward via retail_add_quotation_item_from_scan. The old
-- "at least one line item is required" guard blocked this real, intended flow. Relaxed; everything else unchanged.
create or replace function public.retail_create_quotation(
  p_lead_id uuid, p_customer_name text, p_phone text, p_location_id uuid default null::uuid, p_valid_until date default null::date,
  p_expected_delivery date default null::date, p_delivery_charge numeric default 0, p_installation_charge numeric default 0,
  p_terms text default null::text, p_internal_approval_required boolean default false, p_items jsonb default '[]'::jsonb,
  p_supersedes_id uuid default null::uuid)
returns public.retail_quotations
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_dept uuid := public.retail_dept_id(); v_customer_id uuid; v_number text; v_revision int := 1; v_total numeric := 0;
  v_row public.retail_quotations; v_item jsonb; v_line numeric;
begin
  perform public.staff_assert_operational();
  if p_lead_id is not null then select customer_id into v_customer_id from public.retail_leads where id = p_lead_id; end if;
  if v_customer_id is null then
    v_customer_id := (public.retail_upsert_customer(p_customer_name, p_phone, null, null, null, null, 'RETAIL', auth.uid())).id;
  end if;
  if p_supersedes_id is not null then
    select revision_no + 1 into v_revision from public.retail_quotations where id = p_supersedes_id;
    if v_revision is null then raise exception 'Original quotation not found'; end if;
  end if;

  v_number := 'QT-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_line := coalesce((v_item->>'quantity')::numeric, 0) * coalesce((v_item->>'unit_price')::numeric, 0)
              - coalesce((v_item->>'discount')::numeric, 0) + coalesce((v_item->>'tax')::numeric, 0);
    v_total := v_total + v_line;
  end loop;
  v_total := v_total + coalesce(p_delivery_charge, 0) + coalesce(p_installation_charge, 0);

  insert into public.retail_quotations (
    department_id, lead_id, customer_id, quotation_number, customer_name, phone, status, total_amount, valid_until,
    delivery_charge, installation_charge, terms, expected_delivery, supersedes_id, revision_no, internal_approval_required, created_by
  ) values (
    v_dept, p_lead_id, v_customer_id, v_number, btrim(p_customer_name), nullif(btrim(p_phone), ''), 'DRAFT', v_total, p_valid_until,
    coalesce(p_delivery_charge, 0), coalesce(p_installation_charge, 0), p_terms, p_expected_delivery, p_supersedes_id, v_revision,
    coalesce(p_internal_approval_required, false), auth.uid()
  ) returning * into v_row;

  insert into public.retail_quotation_items (quotation_id, item_name, sku, description, dimensions, product_image_path, quantity, unit_price, discount, tax, line_total, customization_notes)
  select v_row.id, it->>'item_name', it->>'sku', it->>'description', it->>'dimensions', it->>'product_image_path',
    coalesce((it->>'quantity')::numeric, 0), coalesce((it->>'unit_price')::numeric, 0), coalesce((it->>'discount')::numeric, 0), coalesce((it->>'tax')::numeric, 0),
    coalesce((it->>'quantity')::numeric, 0) * coalesce((it->>'unit_price')::numeric, 0) - coalesce((it->>'discount')::numeric, 0) + coalesce((it->>'tax')::numeric, 0),
    it->>'customization_notes'
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it;

  if p_lead_id is not null then update public.retail_leads set status = 'QUOTED' where id = p_lead_id; end if;
  perform public.staff_write_audit('retail_quotation', v_row.id, 'CREATE', null, jsonb_build_object('quotation_number', v_number, 'total', v_total), v_dept);
  return v_row;
end $function$;
