-- Regression test for v2_93j (Dispatch -> Delivery proof/partial/failure -> Installation -> Completion). Runs against real data as
-- impersonated users, always rolls back. Fabricates Godown/Dispatch employees (no real active accounts exist yet in either
-- department) and reuses a real Retail salesperson for everything else.
--
-- Covers: retail_advance_delivery now REFUSES the dispatch/delivery/installation stages (closing the real, live bypass this
-- migration found); dispatch requires the checklist complete OR a management-recorded exception, and a real dispatch photo;
-- delivery proof requires a real photo; a full delivery reaches DELIVERY_SUCCESSFUL; a partial delivery does NOT (and creates a
-- pending-delivery task); a failed delivery keeps a FAILURE proof row and full history; an installation-required order cannot
-- reach COMPLETED before its own photo + explicit customer confirmation; a non-installation order completes via
-- retail_complete_order only once DELIVERY_SUCCESSFUL; unrelated employees are blocked throughout.
do $t$
declare
  v_log text := ''; v_sales uuid; v_other uuid; v_godown uuid; v_dispatch uuid; v_mgmt uuid; v_emp_role uuid;
  v_godown_dept uuid; v_dispatch_dept uuid; v_loc uuid; v_errmsg text; n int; v_all_delivered boolean;
  -- order 1: full happy path incl. installation
  v_lead1 record; v_quote1 public.retail_quotations; v_order1 public.retail_orders; v_item1 uuid;
  v_handover1 public.retail_godown_handovers; v_dispatchrec1 public.retail_dispatch_records; v_delivery1 public.retail_deliveries; v_install1 public.retail_installations;
  -- order 2: checklist exception + partial delivery + completion
  v_quote2 public.retail_quotations; v_order2 public.retail_orders; v_item2 uuid;
  v_handover2 public.retail_godown_handovers; v_dispatchrec2 public.retail_dispatch_records; v_delivery2 public.retail_deliveries;
  -- order 3: delivery failure
  v_quote3 public.retail_quotations; v_order3 public.retail_orders; v_item3 uuid;
  v_handover3 public.retail_godown_handovers; v_dispatchrec3 public.retail_dispatch_records; v_delivery3 public.retail_deliveries;
begin
  create function public.zz_chk9(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select id into v_emp_role from roles where code = 'employee';
  v_godown_dept := public.retail_godown_dept_id(); v_dispatch_dept := public.retail_dispatch_dept_id();
  select up.id into v_sales from user_profiles up join roles r on r.id=up.role_id where up.department_id=public.retail_dept_id() and r.code='employee' and up.is_active limit 1;
  select up.id into v_other from user_profiles up join roles r on r.id=up.role_id where up.department_id not in (public.retail_dept_id(), v_godown_dept, v_dispatch_dept) and r.code='employee' and up.is_active and up.department_id is not null limit 1;
  select up.id into v_mgmt from user_profiles up join roles r on r.id=up.role_id where r.code='management' and up.is_active limit 1;
  select id into v_loc from locations where is_active limit 1;

  insert into auth.users (id) values (gen_random_uuid()) returning id into v_godown;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password) values (v_godown, 'ZTEST-GDN2', 'ZTest Godown Person2', v_emp_role, v_godown_dept, true, false);
  insert into auth.users (id) values (gen_random_uuid()) returning id into v_dispatch;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password) values (v_dispatch, 'ZTEST-DSP', 'ZTest Dispatch Person', v_emp_role, v_dispatch_dept, true, false);

  v_log := public.zz_chk9(v_log, 'fixture: sales, unrelated, fabricated Godown+Dispatch people, management, location resolved',
    v_sales is not null and v_other is not null and v_godown is not null and v_dispatch is not null and v_mgmt is not null and v_loc is not null);

  -- ===== ORDER 1: full happy path, installation required =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_lead1 from retail_create_walkin('ZDD Order1', '9445566771', null, null, null, null, null, null, null, null, null, 'walkin', v_sales, 'RETAIL', null, 'WARM', null);
  v_quote1 := retail_create_quotation(v_lead1.lead_id, 'ZDD Order1', '9445566771', null, current_date+10, current_date+20, 0, 0, null, false,
    jsonb_build_array(jsonb_build_object('item_name','ZDD Item1','quantity',1,'unit_price',15000)), null);
  update retail_quotations set status='ACCEPTED' where id = v_quote1.id;
  v_order1 := retail_convert_quotation_to_order(v_quote1.id);
  update retail_orders set installation_required = true where id = v_order1.id;
  select id into v_item1 from retail_order_items where order_id = v_order1.id;
  perform retail_confirm_order(v_order1.id, jsonb_build_array(jsonb_build_object('order_item_id', v_item1, 'mode', 'STOCK', 'quantity', 1, 'stock_location_id', v_loc)));
  reset role;
  update retail_fulfilment_items set status = 'READY' where order_id = v_order1.id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_start_packing(v_order1.id);
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_sales::text || '/zdd1-pack.jpg', jsonb_build_object('size', 700, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform staff_record_attachment('retail_packing', (select id from retail_packing_records where order_id = v_order1.id), 'image', v_sales::text || '/zdd1-pack.jpg', 'zdd1-pack.jpg', 'image/jpeg', 700, null, 'proof');
  perform retail_verify_packing((select id from retail_packing_records where order_id = v_order1.id), '[]'::jsonb, 'PASSED', 1, null, null);
  v_handover1 := retail_send_to_godown(v_order1.id, v_loc, v_godown, null, null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_godown, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown::text || '/zdd1-receive.jpg', jsonb_build_object('size', 600, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_godown_handover', v_handover1.id, 'image', v_godown::text || '/zdd1-receive.jpg', 'zdd1-receive.jpg', 'image/jpeg', 600, null, 'proof');
  perform retail_godown_accept(v_handover1.id, 1, true, true, 'Rack B1', null);
  reset role;

  -- the old free-form RPC can no longer set a guarded stage -- the actual bypass this migration closes
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_advance_delivery(v_order1.id, 'DISPATCHED', null, null);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk9(v_log, 'retail_advance_delivery no longer accepts DISPATCHED (the bypass is closed)', v_errmsg is not null);
  begin
    perform retail_advance_delivery(v_order1.id, 'COMPLETED', null, null);
    v_log := public.zz_chk9(v_log, 'retail_advance_delivery no longer accepts COMPLETED', false);
  exception when others then
    v_log := public.zz_chk9(v_log, 'retail_advance_delivery no longer accepts COMPLETED', true);
  end;
  reset role;

  -- dispatch itself is a Dispatch/Godown-staff action, not the salesperson's — matching the "Godown/Dispatch users" permission
  -- boundary in the spec (§20).
  perform set_config('request.jwt.claims', json_build_object('sub', v_dispatch, 'role', 'authenticated')::text, true); set local role authenticated;
  v_dispatchrec1 := retail_start_dispatch(v_order1.id);
  v_log := public.zz_chk9(v_log, 'dispatch starts once Godown has accepted', v_dispatchrec1.id is not null);

  v_errmsg := null;
  begin
    perform retail_record_dispatch(v_dispatchrec1.id, 'GJ-01-AB-1234', 'Self', 1, 'CH-001', null, null);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk9(v_log, 'dispatch is refused without a completed checklist or exception', v_errmsg is not null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_pre_dispatch_checklist(v_order1.id, jsonb_build_object(
    'correct_order', true, 'correct_customer_address', true, 'quantity_checked', true, 'packing_checked', true, 'condition_checked', true,
    'documents_checked', true, 'payment_clearance_checked', true, 'site_confirmed', true, 'vehicle_assigned', true), null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_dispatch, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_record_dispatch(v_dispatchrec1.id, 'GJ-01-AB-1234', 'Self', 1, 'CH-001', null, null);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk9(v_log, 'dispatch is still refused without a dispatch photo, even with checklist complete', v_errmsg is not null);
  reset role;

  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_dispatch::text || '/zdd1-dispatch.jpg', jsonb_build_object('size', 650, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_dispatch, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_dispatch', v_dispatchrec1.id, 'image', v_dispatch::text || '/zdd1-dispatch.jpg', 'zdd1-dispatch.jpg', 'image/jpeg', 650, null, 'proof');
  v_dispatchrec1 := retail_record_dispatch(v_dispatchrec1.id, 'GJ-01-AB-1234', 'Self', 1, 'CH-001', null, 'Handled carefully');
  v_log := public.zz_chk9(v_log, 'dispatch succeeds once checklist + photo are both present', v_dispatchrec1.dispatched_at is not null);
  select count(*) into n from retail_deliveries where order_id = v_order1.id and stage = 'OUT_FOR_DELIVERY';
  v_log := public.zz_chk9(v_log, 'the order moves to OUT_FOR_DELIVERY', n = 1);
  reset role;

  -- (explicitly re-asserting the actor here rather than relying on GUC carryover across statements)
  perform set_config('request.jwt.claims', json_build_object('sub', v_dispatch, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_record_delivery_proof(v_order1.id, 'Mr. Site Owner', 'SIGNATURE', 'SIG-001', jsonb_build_array(jsonb_build_object('order_item_id', v_item1, 'quantity_delivered', 1)), null);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk9(v_log, 'delivery proof is refused without a delivery-site photo', v_errmsg is not null);
  reset role;

  select id into v_delivery1 from retail_deliveries where order_id = v_order1.id;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_sales::text || '/zdd1-delivered.jpg', jsonb_build_object('size', 720, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_delivery', v_delivery1.id, 'image', v_sales::text || '/zdd1-delivered.jpg', 'zdd1-delivered.jpg', 'image/jpeg', 720, null, 'proof');
  reset role;
  -- recording the actual proof (as opposed to uploading the photo) is a Dispatch-staff action, same boundary as dispatch itself.
  perform set_config('request.jwt.claims', json_build_object('sub', v_dispatch, 'role', 'authenticated')::text, true); set local role authenticated;
  v_delivery1 := retail_record_delivery_proof(v_order1.id, 'Mr. Site Owner', 'SIGNATURE', 'SIG-001', jsonb_build_array(jsonb_build_object('order_item_id', v_item1, 'quantity_delivered', 1)), 'Good condition');
  v_log := public.zz_chk9(v_log, 'a FULL delivery reaches DELIVERY_SUCCESSFUL', v_delivery1.stage = 'DELIVERY_SUCCESSFUL');
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_complete_order(v_order1.id);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk9(v_log, 'retail_complete_order refuses an installation-required order', v_errmsg is not null);

  v_install1 := retail_start_installation(v_order1.id);
  v_log := public.zz_chk9(v_log, 'installation starts once delivery is successful', v_install1.id is not null and v_install1.status = 'IN_PROGRESS');

  v_errmsg := null;
  begin
    perform retail_record_installation(v_install1.id, 'Team A', null, null);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk9(v_log, 'installation record is refused without a proof photo', v_errmsg is not null);
  reset role;

  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_sales::text || '/zdd1-install.jpg', jsonb_build_object('size', 680, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_installation', v_install1.id, 'image', v_sales::text || '/zdd1-install.jpg', 'zdd1-install.jpg', 'image/jpeg', 680, null, 'proof');
  v_install1 := retail_record_installation(v_install1.id, 'Team A', null, null);
  v_log := public.zz_chk9(v_log, 'installation reaches PROOF_UPLOADED once the photo exists', v_install1.status = 'PROOF_UPLOADED');

  v_errmsg := null;
  begin
    perform retail_complete_order(v_order1.id);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk9(v_log, 'the order STILL cannot be completed before customer confirmation of installation', v_errmsg is not null);

  v_install1 := retail_confirm_installation(v_install1.id, true, 5);
  v_log := public.zz_chk9(v_log, 'confirming installation completes it', v_install1.status = 'COMPLETED' and v_install1.customer_confirmed);
  select count(*) into n from retail_deliveries where order_id = v_order1.id and stage = 'COMPLETED';
  v_log := public.zz_chk9(v_log, 'the delivery reaches COMPLETED only after installation is confirmed', n = 1);
  reset role;

  -- ===== ORDER 2: checklist EXCEPTION (management-recorded) + PARTIAL delivery, no installation =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_quote2 := retail_create_quotation(null, 'ZDD Order2', '9445566772', null, current_date+10, current_date+20, 0, 0, null, false,
    jsonb_build_array(jsonb_build_object('item_name','ZDD Item2','quantity',2,'unit_price',5000)), null);
  update retail_quotations set status='ACCEPTED' where id = v_quote2.id;
  v_order2 := retail_convert_quotation_to_order(v_quote2.id);
  select id into v_item2 from retail_order_items where order_id = v_order2.id;
  perform retail_confirm_order(v_order2.id, jsonb_build_array(jsonb_build_object('order_item_id', v_item2, 'mode', 'STOCK', 'quantity', 2, 'stock_location_id', v_loc)));
  reset role;
  update retail_fulfilment_items set status = 'READY' where order_id = v_order2.id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_start_packing(v_order2.id);
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_sales::text || '/zdd2-pack.jpg', jsonb_build_object('size', 500, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_packing', (select id from retail_packing_records where order_id = v_order2.id), 'image', v_sales::text || '/zdd2-pack.jpg', 'zdd2-pack.jpg', 'image/jpeg', 500, null, 'proof');
  perform retail_verify_packing((select id from retail_packing_records where order_id = v_order2.id), '[]'::jsonb, 'PASSED', 1, null, null);
  v_handover2 := retail_send_to_godown(v_order2.id, v_loc, v_godown, null, null);
  reset role;

  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown::text || '/zdd2-receive.jpg', jsonb_build_object('size', 500, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_godown_handover', v_handover2.id, 'image', v_godown::text || '/zdd2-receive.jpg', 'zdd2-receive.jpg', 'image/jpeg', 500, null, 'proof');
  perform retail_godown_accept(v_handover2.id, 1, true, true, 'Rack B2', null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_dispatch, 'role', 'authenticated')::text, true); set local role authenticated;
  v_dispatchrec2 := retail_start_dispatch(v_order2.id);

  v_errmsg := null;
  begin
    perform retail_pre_dispatch_checklist(v_order2.id, '{}'::jsonb, 'Vehicle inspection skipped, urgent same-day delivery');
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk9(v_log, 'a Dispatch employee (not management/dept-head) cannot record a checklist exception', v_errmsg is not null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_mgmt, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_pre_dispatch_checklist(v_order2.id, '{}'::jsonb, 'Vehicle inspection skipped, urgent same-day delivery — approved by management');
  reset role;

  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_dispatch::text || '/zdd2-dispatch.jpg', jsonb_build_object('size', 500, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_dispatch, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_dispatch', v_dispatchrec2.id, 'image', v_dispatch::text || '/zdd2-dispatch.jpg', 'zdd2-dispatch.jpg', 'image/jpeg', 500, null, 'proof');
  v_dispatchrec2 := retail_record_dispatch(v_dispatchrec2.id, 'GJ-01-CD-5678', 'Self', 1, 'CH-002', null, null);
  v_log := public.zz_chk9(v_log, 'a management-recorded exception lets dispatch proceed without the checklist', v_dispatchrec2.dispatched_at is not null);
  reset role;

  select id into v_delivery2 from retail_deliveries where order_id = v_order2.id;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_sales::text || '/zdd2-delivered.jpg', jsonb_build_object('size', 500, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_delivery', v_delivery2.id, 'image', v_sales::text || '/zdd2-delivered.jpg', 'zdd2-delivered.jpg', 'image/jpeg', 500, null, 'proof');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_dispatch, 'role', 'authenticated')::text, true); set local role authenticated;
  v_delivery2 := retail_record_delivery_proof(v_order2.id, 'Site Rep', 'OTP', '4821', jsonb_build_array(jsonb_build_object('order_item_id', v_item2, 'quantity_delivered', 1)), 'Only 1 of 2 delivered');
  v_log := public.zz_chk9(v_log, 'a PARTIAL delivery (1 of 2) does NOT reach DELIVERY_SUCCESSFUL', v_delivery2.stage = 'DELIVERY_PROOF_UPLOADED');
  select count(*) into n from staff_tasks where system_key = 'retail_pending_delivery:' || v_order2.id::text and is_active;
  v_log := public.zz_chk9(v_log, 'a pending-delivery task was created for the remaining quantity', n = 1);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_complete_order(v_order2.id);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk9(v_log, 'a partially delivered order cannot be completed', v_errmsg is not null);
  reset role;

  -- deliver the remaining unit
  perform set_config('request.jwt.claims', json_build_object('sub', v_dispatch, 'role', 'authenticated')::text, true); set local role authenticated;
  v_delivery2 := retail_record_delivery_proof(v_order2.id, 'Site Rep', 'OTP', '4821', jsonb_build_array(jsonb_build_object('order_item_id', v_item2, 'quantity_delivered', 2)), 'Remaining unit delivered');
  v_log := public.zz_chk9(v_log, 'delivering the remaining quantity now reaches DELIVERY_SUCCESSFUL', v_delivery2.stage = 'DELIVERY_SUCCESSFUL');
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_delivery2 := retail_complete_order(v_order2.id);
  v_log := public.zz_chk9(v_log, 'a non-installation order completes once fully delivered', v_delivery2.stage = 'COMPLETED');
  reset role;

  -- ===== ORDER 3: delivery FAILURE, + unauthorized checks =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_quote3 := retail_create_quotation(null, 'ZDD Order3', '9445566773', null, current_date+10, current_date+20, 0, 0, null, false,
    jsonb_build_array(jsonb_build_object('item_name','ZDD Item3','quantity',1,'unit_price',3000)), null);
  update retail_quotations set status='ACCEPTED' where id = v_quote3.id;
  v_order3 := retail_convert_quotation_to_order(v_quote3.id);
  select id into v_item3 from retail_order_items where order_id = v_order3.id;
  perform retail_confirm_order(v_order3.id, jsonb_build_array(jsonb_build_object('order_item_id', v_item3, 'mode', 'STOCK', 'quantity', 1, 'stock_location_id', v_loc)));
  reset role;
  update retail_fulfilment_items set status = 'READY' where order_id = v_order3.id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_start_packing(v_order3.id);
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_sales::text || '/zdd3-pack.jpg', jsonb_build_object('size', 500, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_packing', (select id from retail_packing_records where order_id = v_order3.id), 'image', v_sales::text || '/zdd3-pack.jpg', 'zdd3-pack.jpg', 'image/jpeg', 500, null, 'proof');
  perform retail_verify_packing((select id from retail_packing_records where order_id = v_order3.id), '[]'::jsonb, 'PASSED', 1, null, null);
  v_handover3 := retail_send_to_godown(v_order3.id, v_loc, v_godown, null, null);
  reset role;

  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown::text || '/zdd3-receive.jpg', jsonb_build_object('size', 500, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_godown_handover', v_handover3.id, 'image', v_godown::text || '/zdd3-receive.jpg', 'zdd3-receive.jpg', 'image/jpeg', 500, null, 'proof');
  perform retail_godown_accept(v_handover3.id, 1, true, true, 'Rack B3', null);
  reset role;

  -- an unrelated employee cannot start dispatch, even now that Godown accepted
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_start_dispatch(v_order3.id);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk9(v_log, 'an unrelated employee cannot start dispatch', v_errmsg is not null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_dispatch, 'role', 'authenticated')::text, true); set local role authenticated;
  v_dispatchrec3 := retail_start_dispatch(v_order3.id);
  perform retail_pre_dispatch_checklist(v_order3.id, jsonb_build_object(
    'correct_order', true, 'correct_customer_address', true, 'quantity_checked', true, 'packing_checked', true, 'condition_checked', true,
    'documents_checked', true, 'payment_clearance_checked', true, 'site_confirmed', true, 'vehicle_assigned', true), null);
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_dispatch::text || '/zdd3-dispatch.jpg', jsonb_build_object('size', 500, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_dispatch, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_dispatch', v_dispatchrec3.id, 'image', v_dispatch::text || '/zdd3-dispatch.jpg', 'zdd3-dispatch.jpg', 'image/jpeg', 500, null, 'proof');
  v_dispatchrec3 := retail_record_dispatch(v_dispatchrec3.id, 'GJ-01-EF-9012', 'Self', 1, 'CH-003', null, null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_record_delivery_failure(v_order3.id, 'Customer unreachable', current_date + 1);
    v_log := public.zz_chk9(v_log, 'an unrelated employee cannot record a delivery failure', false);
  exception when others then
    v_log := public.zz_chk9(v_log, 'an unrelated employee cannot record a delivery failure', true);
  end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_dispatch, 'role', 'authenticated')::text, true); set local role authenticated;
  v_delivery3 := retail_record_delivery_failure(v_order3.id, 'Customer unreachable at site', current_date + 1);
  v_log := public.zz_chk9(v_log, 'a delivery failure sets DELIVERY_FAILED and keeps the reason', v_delivery3.stage = 'DELIVERY_FAILED' and v_delivery3.delay_reason = 'Customer unreachable at site');
  select count(*) into n from retail_delivery_proofs where delivery_id = v_delivery3.id and proof_type = 'FAILURE';
  v_log := public.zz_chk9(v_log, 'a FAILURE proof row was kept as history', n = 1);
  reset role;

  raise exception E'DISPATCH-DELIVERY-REGRESSION (rolled back)\n%', v_log;
end $t$;
