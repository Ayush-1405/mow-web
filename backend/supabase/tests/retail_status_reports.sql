-- Regression test for v2_93k (pipeline_status rollup + reports + full customer timeline). Runs against real data as impersonated
-- users, always rolls back. Fabricates Godown/Dispatch employees, reuses a real Retail salesperson.
--
-- Covers: pipeline_status tracks the order automatically through packing -> godown -> dispatch -> delivered -> completed with no
-- manual field to edit; retail_reports_summary defaults to 'own' scope and a plain employee cannot escalate to 'team'/'all'; a
-- salesperson cannot view another salesperson's report without oversight; retail_pipeline_report returns real stage counts;
-- retail_ownership_report is management/dept-head only; retail_customer_timeline includes an entry from every connected stage.
do $t$
declare
  v_log text := ''; v_sales uuid; v_other uuid; v_godown uuid; v_dispatch uuid; v_mgmt uuid; v_emp_role uuid;
  v_godown_dept uuid; v_dispatch_dept uuid; v_loc uuid; v_errmsg text; n int;
  v_lead record; v_quote public.retail_quotations; v_order public.retail_orders; v_item_id uuid;
  v_packing public.retail_packing_records; v_handover public.retail_godown_handovers; v_dispatchrec public.retail_dispatch_records;
  v_delivery public.retail_deliveries; v_summary jsonb; v_sp_report jsonb; v_pipe_report jsonb; v_own_report jsonb;
begin
  create function public.zz_chkA(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select id into v_emp_role from roles where code = 'employee';
  v_godown_dept := public.retail_godown_dept_id(); v_dispatch_dept := public.retail_dispatch_dept_id();
  select up.id into v_sales from user_profiles up join roles r on r.id=up.role_id where up.department_id=public.retail_dept_id() and r.code='employee' and up.is_active limit 1;
  select up.id into v_other from user_profiles up join roles r on r.id=up.role_id where up.department_id not in (public.retail_dept_id(), v_godown_dept, v_dispatch_dept) and r.code='employee' and up.is_active and up.department_id is not null limit 1;
  select up.id into v_mgmt from user_profiles up join roles r on r.id=up.role_id where r.code='management' and up.is_active limit 1;
  select id into v_loc from locations where is_active limit 1;

  insert into auth.users (id) values (gen_random_uuid()) returning id into v_godown;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password) values (v_godown, 'ZTEST-GDNB', 'ZTest Godown PersonB', v_emp_role, v_godown_dept, true, false);
  insert into auth.users (id) values (gen_random_uuid()) returning id into v_dispatch;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password) values (v_dispatch, 'ZTEST-DSPB', 'ZTest Dispatch PersonB', v_emp_role, v_dispatch_dept, true, false);

  v_log := public.zz_chkA(v_log, 'fixture: sales, unrelated, fabricated Godown+Dispatch people, management, location resolved',
    v_sales is not null and v_other is not null and v_godown is not null and v_dispatch is not null and v_mgmt is not null and v_loc is not null);

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_lead from retail_create_walkin('ZSR Order', '9223300111', null, null, null, null, null, null, null, null, null, 'walkin', v_sales, 'RETAIL', null, 'WARM', null);
  v_quote := retail_create_quotation(v_lead.lead_id, 'ZSR Order', '9223300111', null, current_date+10, current_date+20, 0, 0, null, false,
    jsonb_build_array(jsonb_build_object('item_name','ZSR Item','quantity',1,'unit_price',9000)), null);
  update retail_quotations set status='ACCEPTED' where id = v_quote.id;
  v_order := retail_convert_quotation_to_order(v_quote.id);
  select id into v_item_id from retail_order_items where order_id = v_order.id;
  perform retail_confirm_order(v_order.id, jsonb_build_array(jsonb_build_object('order_item_id', v_item_id, 'mode', 'STOCK', 'quantity', 1, 'stock_location_id', v_loc)));

  select count(*) into n from retail_orders where id = v_order.id and pipeline_status = 'FULFILMENT_PENDING';
  v_log := public.zz_chkA(v_log, 'pipeline_status starts FULFILMENT_PENDING right after confirm (item not yet Ready)', n = 1);
  reset role;

  update retail_fulfilment_items set status = 'READY' where order_id = v_order.id;
  select count(*) into n from retail_orders where id = v_order.id and pipeline_status = 'FULFILMENT_READY';
  v_log := public.zz_chkA(v_log, 'pipeline_status becomes FULFILMENT_READY once the item is Ready (trigger-driven)', n = 1);

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_packing := retail_start_packing(v_order.id);
  select count(*) into n from retail_orders where id = v_order.id and pipeline_status = 'PACKING';
  v_log := public.zz_chkA(v_log, 'pipeline_status becomes PACKING once packing starts', n = 1);
  reset role;

  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_sales::text || '/zsr-pack.jpg', jsonb_build_object('size', 500, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_packing', v_packing.id, 'image', v_sales::text || '/zsr-pack.jpg', 'zsr-pack.jpg', 'image/jpeg', 500, null, 'proof');
  perform retail_verify_packing(v_packing.id, '[]'::jsonb, 'PASSED', 1, null, null);
  v_handover := retail_send_to_godown(v_order.id, v_loc, v_godown, null, null);
  select count(*) into n from retail_orders where id = v_order.id and pipeline_status = 'ASSIGNED_TO_GODOWN';
  v_log := public.zz_chkA(v_log, 'pipeline_status becomes ASSIGNED_TO_GODOWN', n = 1);
  reset role;

  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown::text || '/zsr-receive.jpg', jsonb_build_object('size', 500, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_godown_handover', v_handover.id, 'image', v_godown::text || '/zsr-receive.jpg', 'zsr-receive.jpg', 'image/jpeg', 500, null, 'proof');
  perform retail_godown_accept(v_handover.id, 1, true, true, 'Rack C1', null);
  select count(*) into n from retail_orders where id = v_order.id and pipeline_status = 'RECEIVED_AT_GODOWN';
  v_log := public.zz_chkA(v_log, 'pipeline_status becomes RECEIVED_AT_GODOWN', n = 1);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_dispatch, 'role', 'authenticated')::text, true); set local role authenticated;
  v_dispatchrec := retail_start_dispatch(v_order.id);
  perform retail_pre_dispatch_checklist(v_order.id, jsonb_build_object(
    'correct_order', true, 'correct_customer_address', true, 'quantity_checked', true, 'packing_checked', true, 'condition_checked', true,
    'documents_checked', true, 'payment_clearance_checked', true, 'site_confirmed', true, 'vehicle_assigned', true), null);
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_dispatch::text || '/zsr-dispatch.jpg', jsonb_build_object('size', 500, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_dispatch, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_dispatch', v_dispatchrec.id, 'image', v_dispatch::text || '/zsr-dispatch.jpg', 'zsr-dispatch.jpg', 'image/jpeg', 500, null, 'proof');
  v_dispatchrec := retail_record_dispatch(v_dispatchrec.id, 'GJ-01-ZZ-0001', 'Self', 1, 'CH-ZSR', null, null);
  select count(*) into n from retail_orders where id = v_order.id and pipeline_status = 'OUT_FOR_DELIVERY';
  v_log := public.zz_chkA(v_log, 'pipeline_status becomes OUT_FOR_DELIVERY', n = 1);
  reset role;

  select id into v_delivery from retail_deliveries where order_id = v_order.id;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_sales::text || '/zsr-delivered.jpg', jsonb_build_object('size', 500, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_delivery', v_delivery.id, 'image', v_sales::text || '/zsr-delivered.jpg', 'zsr-delivered.jpg', 'image/jpeg', 500, null, 'proof');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_dispatch, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_record_delivery_proof(v_order.id, 'Site Rep', 'SIGNATURE', 'SIG-ZSR', jsonb_build_array(jsonb_build_object('order_item_id', v_item_id, 'quantity_delivered', 1)), null);
  select count(*) into n from retail_orders where id = v_order.id and pipeline_status = 'DELIVERY_SUCCESSFUL';
  v_log := public.zz_chkA(v_log, 'pipeline_status becomes DELIVERY_SUCCESSFUL', n = 1);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_complete_order(v_order.id);
  select count(*) into n from retail_orders where id = v_order.id and pipeline_status = 'COMPLETED';
  v_log := public.zz_chkA(v_log, 'pipeline_status becomes COMPLETED, the single source of truth throughout', n = 1);

  -- reports_summary: default scope is 'own'
  select retail_reports_summary(current_date - 365, current_date) into v_summary;
  v_log := public.zz_chkA(v_log, 'reports_summary defaults to own scope', v_summary->>'scope' = 'own');
  v_log := public.zz_chkA(v_log, 'reports_summary own-scope counts include this order', (v_summary->>'orders_total')::int >= 1);

  v_errmsg := null;
  begin
    perform retail_reports_summary(current_date - 365, current_date, 'all', null);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chkA(v_log, 'a plain salesperson cannot escalate reports_summary to all-scope', v_errmsg is not null);

  v_errmsg := null;
  begin
    perform retail_salesperson_report(v_other, current_date - 30, current_date);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chkA(v_log, 'a salesperson cannot view another person''s salesperson_report', v_errmsg is not null);

  select retail_salesperson_report(v_sales, current_date - 365, current_date) into v_sp_report;
  v_log := public.zz_chkA(v_log, 'salesperson_report returns real owned_customers/order data for the caller''s own id', (v_sp_report->>'owned_customers')::int >= 1);

  v_errmsg := null;
  begin
    perform retail_ownership_report();
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chkA(v_log, 'a plain salesperson cannot view the ownership report', v_errmsg is not null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_mgmt, 'role', 'authenticated')::text, true); set local role authenticated;
  select retail_pipeline_report(current_date - 365, current_date) into v_pipe_report;
  v_log := public.zz_chkA(v_log, 'pipeline_report returns a real completed-stage count', ((v_pipe_report->'completed')->>'count')::int >= 1);
  select retail_ownership_report() into v_own_report;
  v_log := public.zz_chkA(v_log, 'management can view the ownership report', v_own_report ? 'by_owner');
  reset role;

  -- customer timeline covers every connected stage for this one order
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(distinct entry_type) into n from retail_customer_timeline(v_order.customer_id)
    where entry_type in ('LEAD','QUOTATION','ORDER','FULFILMENT','PACKING','GODOWN_HANDOVER','DISPATCH','DELIVERY','DELIVERY_PROOF');
  v_log := public.zz_chkA(v_log, 'customer_timeline includes an entry from every connected pipeline stage (9 distinct types)', n = 9);
  reset role;

  raise exception E'STATUS-REPORTS-REGRESSION (rolled back)\n%', v_log;
end $t$;
