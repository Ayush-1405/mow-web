-- Retail Stores module Phase 1 — end-to-end workflow test. Runs against REAL data as impersonated users (SET LOCAL ROLE authenticated +
-- request.jwt.claims) and ALWAYS rolls back (the report is in the error message). Covers: walk-in -> customer dedupe -> follow-up
-- lifecycle (task open/close) -> quotation -> accepted quotation converts to a prefilled order (idempotent) -> confirming a MIXED order
-- (one Factory item, one Outsource item) creates a real Factory Job Card and a real Procurement Request, is itself idempotent on retry,
-- and RLS: Retail Head sees the team, an unrelated employee sees nothing and cannot call the RPC, Management sees everything,
-- Procurement sees the request routed to them.
do $t$
declare
  v_log text := ''; v_ret uuid := public.retail_dept_id(); v_sales uuid; v_head uuid; v_other uuid; v_mgmt uuid;
  v_walkin record; v_lead_id uuid; v_fu record; v_quote public.retail_quotations; v_order public.retail_orders;
  v_items jsonb; n int; v_job_count int; v_pr_count int; v_status text;
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select up.id into v_sales from user_profiles up join roles r on r.id=up.role_id where up.department_id=v_ret and r.code='employee' and up.is_active limit 1;
  select up.id into v_head from user_profiles up join roles r on r.id=up.role_id where up.department_id=v_ret and r.code='dept_head' and up.is_active limit 1;
  select up.id into v_mgmt from user_profiles up join roles r on r.id=up.role_id where r.code='management' and up.is_active limit 1;
  select up.id into v_other from user_profiles up join roles r on r.id=up.role_id where up.department_id<>v_ret and r.code='employee' and up.is_active and up.department_id is not null limit 1;
  v_log := public.zz_chk(v_log, 'fixture: retail salesperson/head, management, unrelated user found', v_sales is not null and v_head is not null and v_mgmt is not null and v_other is not null);

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select * into v_walkin from public.retail_create_walkin('ZW Test Customer', '9998887771', '9998887771', null, 'Gandhinagar',
    null, 'SOFA', 'L-shape sofa', 'Living room', 55000, '1 month', 'walkin', v_sales, 'RETAIL', 'wants leather', 'HOT', now() + interval '2 days');
  v_lead_id := v_walkin.lead_id;
  v_log := public.zz_chk(v_log, 'walk-in creates a lead + customer + first follow-up task', v_walkin.lead_id is not null and v_walkin.customer_id is not null and v_walkin.task_id is not null);
  select count(*) into n from retail_customers where normalized_phone = '9998887771';
  v_log := public.zz_chk(v_log, 'exactly one customer row for the normalized phone', n = 1);
  select count(*) into n from staff_tasks where system_key = 'retail_followup:lead:' || v_lead_id::text and is_active;
  v_log := public.zz_chk(v_log, 'the follow-up task is a real Today''s Tasks row (system_key)', n = 1);

  perform public.retail_create_walkin('ZW Test Customer Again', '+91 99988-87771', null, null, null, null, null, null, null, null, null, 'walkin', v_sales, 'RETAIL', null, 'WARM', null);
  select count(*) into n from retail_customers where normalized_phone = '9998887771';
  v_log := public.zz_chk(v_log, 'a differently-formatted duplicate phone reuses the SAME customer (dedupe works)', n = 1);

  select * into v_fu from public.retail_record_followup(v_lead_id, 'CALL', 'Discussed budget', 'Interested', 'L-shape sofa', null, 60000,
    'Wants leather finish', 'Send quotation', now() + interval '1 day', 'QUOTATION_REQUESTED', null);
  v_log := public.zz_chk(v_log, 'follow-up recorded and a NEW reminder task created', v_fu.followup_id is not null and v_fu.task_id is not null);
  select count(*) into n from staff_tasks where system_key = 'retail_followup:lead:' || v_lead_id::text and is_active;
  v_log := public.zz_chk(v_log, 'the FIRST follow-up task was closed (no duplicate open reminder)', n = 0);
  select count(*) into n from staff_tasks where system_key = 'retail_followup:' || v_fu.followup_id::text and is_active;
  v_log := public.zz_chk(v_log, 'the SECOND follow-up has exactly one open reminder task', n = 1);

  v_items := jsonb_build_array(
    jsonb_build_object('item_name', 'L-Sofa 3-seater', 'sku', 'SOF-3S', 'quantity', 1, 'unit_price', 45000, 'discount', 1000, 'tax', 2160),
    jsonb_build_object('item_name', 'Coffee Table', 'sku', 'CT-01', 'quantity', 1, 'unit_price', 8000, 'discount', 0, 'tax', 384));
  v_quote := public.retail_create_quotation(v_lead_id, 'ZW Test Customer', '9998887771', null, current_date + 15, current_date + 30, 500, 1500, 'Standard terms', false, v_items, null);
  v_log := public.zz_chk(v_log, 'quotation created with computed total', v_quote.id is not null and v_quote.total_amount = (44000+8000+2160+384+500+1500));
  select count(*) into n from retail_quotation_items where quotation_id = v_quote.id;
  v_log := public.zz_chk(v_log, 'quotation has 2 line items', n = 2);

  update retail_quotations set status = 'ACCEPTED' where id = v_quote.id;
  v_order := public.retail_convert_quotation_to_order(v_quote.id);
  v_log := public.zz_chk(v_log, 'accepted quotation converts to a prefilled order (customer+items copied)', v_order.id is not null and v_order.customer_id = v_walkin.customer_id and v_order.total_amount = v_quote.total_amount);
  select count(*) into n from retail_order_items where order_id = v_order.id;
  v_log := public.zz_chk(v_log, 'order items copied from the quotation (2)', n = 2);
  select count(*) into n from staff_tasks where system_key = 'retail_order_verify:' || v_order.id::text;
  v_log := public.zz_chk(v_log, 'an order-verification task was created', n = 1);

  declare v_order2 public.retail_orders;
  begin
    v_order2 := public.retail_convert_quotation_to_order(v_quote.id);
    v_log := public.zz_chk(v_log, 'converting the same quotation twice returns the SAME order (no duplicate)', v_order2.id = v_order.id);
  end;

  declare v_it1 uuid; v_it2 uuid; v_fulfilment jsonb;
  begin
    select id into v_it1 from retail_order_items where order_id = v_order.id and item_name = 'L-Sofa 3-seater';
    select id into v_it2 from retail_order_items where order_id = v_order.id and item_name = 'Coffee Table';
    v_fulfilment := jsonb_build_array(
      jsonb_build_object('order_item_id', v_it1, 'mode', 'FACTORY', 'required_date', (current_date + 20)::text),
      jsonb_build_object('order_item_id', v_it2, 'mode', 'OUTSOURCE', 'preferred_vendor', 'ZZ Vendor', 'target_cost', 6000));
    perform public.retail_confirm_order(v_order.id, v_fulfilment);
  end;
  reset role;

  select status into v_status from retail_orders where id = v_order.id;
  v_log := public.zz_chk(v_log, 'order is CONFIRMED and locked', v_status = 'CONFIRMED');
  select count(*) into v_job_count from inhouse_production_requests where source_module = 'retail' and source_reference = v_order.order_number;
  v_log := public.zz_chk(v_log, 'a REAL Factory Job Card was created for the FACTORY item', v_job_count = 1);
  select count(*) into v_pr_count from retail_procurement_requests where order_id = v_order.id;
  v_log := public.zz_chk(v_log, 'a Procurement Request was created for the OUTSOURCE item', v_pr_count = 1);
  select count(*) into n from retail_fulfilment_items where order_id = v_order.id;
  v_log := public.zz_chk(v_log, 'two fulfilment rows exist (one per line item, no duplicates)', n = 2);
  select count(*) into n from retail_deliveries where order_id = v_order.id;
  v_log := public.zz_chk(v_log, 'a delivery timeline row was auto-created', n = 1);

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform public.retail_confirm_order(v_order.id, '[]'::jsonb);
  reset role;
  select count(*) into v_job_count from inhouse_production_requests where source_module = 'retail' and source_reference = v_order.order_number;
  select count(*) into v_pr_count from retail_procurement_requests where order_id = v_order.id;
  select count(*) into n from retail_fulfilment_items where order_id = v_order.id;
  v_log := public.zz_chk(v_log, 'RE-CONFIRMING the same order creates NO duplicate job card/procurement/fulfilment rows', v_job_count = 1 and v_pr_count = 1 and n = 2);

  perform set_config('request.jwt.claims', json_build_object('sub', v_head, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*) into n from retail_leads where id = v_lead_id;
  v_log := public.zz_chk(v_log, 'Retail Head sees a lead created by a team member', n = 1);
  select count(*) into n from retail_orders where id = v_order.id;
  v_log := public.zz_chk(v_log, 'Retail Head sees the team''s order', n = 1);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*) into n from retail_leads where id = v_lead_id;
  v_log := public.zz_chk(v_log, 'unrelated employee (another department) sees NOTHING of this lead', n = 0);
  select count(*) into n from retail_orders where id = v_order.id;
  v_log := public.zz_chk(v_log, 'unrelated employee sees NOTHING of this order', n = 0);
  begin perform public.retail_confirm_order(v_order.id, '[]'::jsonb); v_log := public.zz_chk(v_log, 'unrelated employee cannot call retail_confirm_order on it', false);
  exception when others then v_log := public.zz_chk(v_log, 'unrelated employee cannot call retail_confirm_order on it', true); end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_mgmt, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*) into n from retail_orders where id = v_order.id;
  v_log := public.zz_chk(v_log, 'Management (global oversight) sees the order', n = 1);
  select count(*) into n from retail_leads where department_id = v_ret;
  v_log := public.zz_chk(v_log, 'Management sees ALL Retail leads, not just one', n >= 2);
  reset role;

  declare v_proc uuid;
  begin
    select up.id into v_proc from user_profiles up join roles r on r.id=up.role_id join departments d on d.id=up.department_id where d.code='PROCUREMENT' and r.code='dept_head' and up.is_active limit 1;
    if v_proc is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', v_proc, 'role', 'authenticated')::text, true); set local role authenticated;
      select count(*) into n from retail_procurement_requests where order_id = v_order.id;
      v_log := public.zz_chk(v_log, 'Procurement dept head sees the retail-originated procurement request', n = 1);
      reset role;
    else
      v_log := v_log || 'SKIP  no active Procurement dept head to test with' || E'\n';
    end if;
  end;

  raise exception E'RETAIL-WORKFLOW-REPORT (rolled back)\n%', v_log;
end $t$;
