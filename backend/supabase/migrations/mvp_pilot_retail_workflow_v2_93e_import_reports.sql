-- v2_93e -- Retail Stores module, Phase 2b: controlled Excel/CSV import for leads (Supabase stays the single source of truth -- import is a
-- one-time, audited RPC call, never a live data path), and the read-side aggregates the Reports screen needs (every number here is a plain
-- COUNT/SUM over RLS-scoped rows, so a chart can never show something the caller isn't authorized to see).

-- ---------------------------------------------------------------------------------------------------------------------------------
-- retail_import_leads: p_rows is the ALREADY column-mapped array the frontend built after the user matched spreadsheet columns to
-- fields. p_dry_run=true only validates and reports duplicates/errors (used for the Preview step); p_dry_run=false actually creates the
-- customers+leads and writes one audit row summarizing the whole batch. Duplicate detection is by normalized phone, both against existing
-- retail_customers and within the same file (two rows in the same sheet with the same number are flagged, not silently both imported).
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_import_leads(p_rows jsonb, p_dry_run boolean default true)
returns table (row_index integer, outcome text, reason text, customer_name text, phone text, lead_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_dept uuid := public.retail_dept_id(); v_row jsonb; v_i integer := -1; v_name text; v_phone text; v_norm text;
  v_seen text[] := '{}'; v_customer public.retail_customers; v_lead_id uuid; v_created integer := 0; v_dupe integer := 0; v_err integer := 0;
begin
  perform public.staff_assert_operational();
  if not (staff_current_department_id() = v_dept or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(v_dept))) then
    raise exception 'Not authorized to import Retail leads';
  end if;
  if jsonb_typeof(coalesce(p_rows, 'null'::jsonb)) <> 'array' then raise exception 'Rows must be a list'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'Import is limited to 2000 rows at a time'; end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    v_name := nullif(btrim(v_row ->> 'customer_name'), '');
    v_phone := nullif(btrim(v_row ->> 'phone'), '');
    v_norm := public.retail_normalize_phone(v_phone);

    if v_name is null then
      row_index := v_i; outcome := 'ERROR'; reason := 'Customer name is required'; customer_name := v_name; phone := v_phone; lead_id := null;
      v_err := v_err + 1; return next; continue;
    end if;
    if v_norm is not null and v_norm = any(v_seen) then
      row_index := v_i; outcome := 'DUPLICATE'; reason := 'Duplicate phone number within this file'; customer_name := v_name; phone := v_phone; lead_id := null;
      v_dupe := v_dupe + 1; return next; continue;
    end if;
    if v_norm is not null and exists (select 1 from public.retail_customers c where c.normalized_phone = v_norm) then
      row_index := v_i; outcome := 'DUPLICATE'; reason := 'A customer with this phone number already exists'; customer_name := v_name; phone := v_phone; lead_id := null;
      v_dupe := v_dupe + 1; if v_norm is not null then v_seen := array_append(v_seen, v_norm); end if; continue;
    end if;
    if v_norm is not null then v_seen := array_append(v_seen, v_norm); end if;

    if p_dry_run then
      row_index := v_i; outcome := 'WILL_IMPORT'; reason := null; customer_name := v_name; phone := v_phone; lead_id := null;
      v_created := v_created + 1; return next; continue;
    end if;

    v_customer := public.retail_upsert_customer(v_name, v_phone, nullif(btrim(v_row ->> 'whatsapp'), ''), nullif(btrim(v_row ->> 'email'), ''),
      nullif(btrim(v_row ->> 'city'), ''), null, coalesce(nullif(btrim(v_row ->> 'customer_type'), ''), 'RETAIL'));
    insert into public.retail_leads (department_id, customer_id, customer_name, phone, email, city, source, requirement_category, interest_notes, status, created_by)
    values (v_dept, v_customer.id, v_name, v_phone, nullif(btrim(v_row ->> 'email'), ''), nullif(btrim(v_row ->> 'city'), ''),
      coalesce(nullif(btrim(v_row ->> 'source'), ''), 'import'),
      case when nullif(btrim(v_row ->> 'requirement_category'), '') in
        ('LOOSE_FURNITURE','SOFA','BED','DINING','OFFICE_FURNITURE','MODULAR_KITCHEN','WARDROBE','COMPLETE_INTERIOR','BULK_CORPORATE','CUSTOMIZED','OTHER')
        then v_row ->> 'requirement_category' else null end,
      nullif(btrim(v_row ->> 'notes'), ''), 'NEW', auth.uid())
    returning id into v_lead_id;

    row_index := v_i; outcome := 'IMPORTED'; reason := null; customer_name := v_name; phone := v_phone; lead_id := v_lead_id;
    v_created := v_created + 1; return next;
  end loop;

  if not p_dry_run then
    perform public.staff_write_audit('retail_lead_import', gen_random_uuid(), 'IMPORT',
      null, jsonb_build_object('imported', v_created, 'duplicates', v_dupe, 'errors', v_err, 'total_rows', jsonb_array_length(p_rows)), v_dept);
  end if;
  return;
end $$;
revoke execute on function public.retail_import_leads(jsonb, boolean) from public, anon;
grant execute on function public.retail_import_leads(jsonb, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- retail_reports_summary: the small set of live, click-through-able numbers the Reports screen shows. p_from/p_to bound created_at
-- (inclusive); every underlying query is scoped the same as the dashboard's own counts (own/team/all, by role) -- a report can never show
-- a number the caller could not otherwise see by opening the matching list.
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retail_reports_summary(p_from date default current_date - 30, p_to date default current_date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_scope_leads text; v_scope_orders text; v_result jsonb;
begin
  perform public.staff_assert_operational();
  select jsonb_build_object(
    'walkins_total', (select count(*) from retail_leads where is_active and created_at::date between p_from and p_to),
    'leads_by_source', (select coalesce(jsonb_object_agg(source, n), '{}'::jsonb) from (select coalesce(source, 'unknown') source, count(*) n from retail_leads where is_active and created_at::date between p_from and p_to group by 1) x),
    'leads_won', (select count(*) from retail_leads where is_active and status = 'CONVERTED' and updated_at::date between p_from and p_to),
    'leads_lost', (select count(*) from retail_leads where is_active and status = 'LOST' and updated_at::date between p_from and p_to),
    'followups_overdue', (select count(*) from retail_leads where is_active and next_follow_up_date < current_date and status not in ('CONVERTED', 'LOST')),
    'quotations_total', (select count(*) from retail_quotations where is_active and created_at::date between p_from and p_to),
    'quotations_accepted', (select count(*) from retail_quotations where is_active and status = 'ACCEPTED' and created_at::date between p_from and p_to),
    'orders_total', (select count(*) from retail_orders where is_active and created_at::date between p_from and p_to),
    'orders_value', (select coalesce(sum(total_amount), 0) from retail_orders where is_active and created_at::date between p_from and p_to),
    'orders_confirmed_value', (select coalesce(sum(total_amount), 0) from retail_orders where is_active and status = 'CONFIRMED' and created_at::date between p_from and p_to),
    'pending_collection', (select coalesce(sum(total_amount - amount_paid), 0) from retail_orders where is_active and payment_status <> 'PAID' and created_at::date between p_from and p_to),
    'factory_linked_orders', (select count(distinct fi.order_id) from retail_fulfilment_items fi where fi.mode = 'FACTORY' and fi.created_at::date between p_from and p_to),
    'outsource_linked_orders', (select count(distinct fi.order_id) from retail_fulfilment_items fi where fi.mode = 'OUTSOURCE' and fi.created_at::date between p_from and p_to),
    'deliveries_completed', (select count(*) from retail_deliveries where is_active and stage = 'COMPLETED' and updated_at::date between p_from and p_to),
    'deliveries_delayed', (select count(*) from retail_deliveries where is_active and delay_reason is not null and stage not in ('DELIVERED', 'COMPLETED')),
    'avg_feedback_score', (select round(avg(feedback_score), 2) from retail_deliveries where is_active and feedback_score is not null and updated_at::date between p_from and p_to),
    'display_updates_total', (select count(*) from retail_display_updates where is_active and created_at::date between p_from and p_to)
  ) into v_result;
  return v_result;
end $$;
revoke execute on function public.retail_reports_summary(date, date) from public, anon;
grant execute on function public.retail_reports_summary(date, date) to authenticated;
