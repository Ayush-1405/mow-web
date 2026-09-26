-- Regression test for v2_93m (Immediate Delivery fast-path: Sales Confirmation Photo -> automatic Godown request ->
-- Godown-side verify+pack). Runs against real data as impersonated users, always rolls back. Reuses a real Retail
-- salesperson and the fabricated Godown employee pattern from retail_packing_godown.sql.
--
-- Covers: confirming an item as IMMEDIATE_DELIVERY creates no Factory job/no Procurement request; pipeline_status is
-- AWAITING_PRODUCT_PHOTO until the photo is captured; no Godown handover exists before the photo; capturing the photo
-- (order total = 0, so payment/approval is trivially valid) automatically creates exactly one handover with no manual
-- "Send to Godown" click; the auto-request is idempotent under retry; an unrelated employee cannot trigger it on
-- someone else's item; Godown accept still requires its own receiving photo (unchanged rule); Godown itself can now
-- complete retail_verify_packing on the auto-created packing record (previously would have failed with "Not
-- authorized"), and packing still refuses without its own photo (unchanged rule, now exercised by a Godown actor).
do $t$
declare
  v_log text := ''; v_sales uuid; v_other uuid; v_godown uuid; v_emp_role uuid; v_head_role uuid; v_godown_dept uuid;
  v_lead record; v_quote public.retail_quotations; v_order public.retail_orders; v_item_id uuid;
  v_item public.retail_order_items; v_handover public.retail_godown_handovers; v_packing public.retail_packing_records;
  v_att_id uuid; n int; v_errmsg text; v_pipeline text;
begin
  create function public.zz_chk_imm(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select id into v_emp_role from roles where code = 'employee';
  select id into v_head_role from roles where code = 'dept_head';
  v_godown_dept := public.retail_godown_dept_id();
  select up.id into v_sales from user_profiles up join roles r on r.id=up.role_id where up.department_id=public.retail_dept_id() and r.code='employee' and up.is_active limit 1;
  select up.id into v_other from user_profiles up join roles r on r.id=up.role_id where up.department_id<>public.retail_dept_id() and up.department_id <> v_godown_dept and r.code='employee' and up.is_active and up.department_id is not null limit 1;

  -- fabricate a Godown DEPT HEAD (retail_maybe_auto_request_godown picks the Godown department head as the default
  -- responsible person -- no real Godown head exists in the live pilot data yet).
  insert into auth.users (id) values (gen_random_uuid()) returning id into v_godown;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password)
    values (v_godown, 'ZTEST-IMD-GDN', 'ZTest Immediate-Delivery Godown Head', v_head_role, v_godown_dept, true, false);

  v_log := public.zz_chk_imm(v_log, 'fixture: sales, unrelated employee, fabricated Godown head all resolved', v_sales is not null and v_other is not null and v_godown is not null);

  -- confirmed order, one item, IMMEDIATE_DELIVERY, zero price (so payment/approval is trivially valid — this test
  -- isolates the photo-only trigger path; retail_record_payment's own trigger hook is exercised implicitly by the
  -- fact this function is additive and the standard-flow regression suite already re-runs retail_record_payment).
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_lead from retail_create_walkin('ZIMD Test Customer', '9334455671', null, null, null, null, null, null, null, null, null, 'walkin', v_sales, 'RETAIL', null, 'WARM', null);
  v_quote := retail_create_quotation(v_lead.lead_id, 'ZIMD Test Customer', '9334455671', null, current_date+10, current_date+20, 0, 0, null, false,
    jsonb_build_array(jsonb_build_object('item_name','ZIMD Item','quantity',1,'unit_price',0)), null);
  update retail_quotations set status='ACCEPTED' where id = v_quote.id;
  v_order := retail_convert_quotation_to_order(v_quote.id);
  select id into v_item_id from retail_order_items where order_id = v_order.id;

  perform retail_confirm_order(v_order.id, jsonb_build_array(jsonb_build_object('order_item_id', v_item_id, 'mode', 'IMMEDIATE_DELIVERY')));

  select count(*) into n from retail_fulfilment_items where order_id = v_order.id and mode = 'IMMEDIATE_DELIVERY' and status = 'PENDING';
  v_log := public.zz_chk_imm(v_log, 'confirming as IMMEDIATE_DELIVERY creates the fulfilment_items row (PENDING)', n = 1);
  select count(*) into n from inhouse_production_requests where source_module = 'retail' and source_reference = v_order.order_number;
  v_log := public.zz_chk_imm(v_log, 'no Factory job card was created for an IMMEDIATE_DELIVERY item', n = 0);
  select count(*) into n from retail_procurement_requests where order_id = v_order.id;
  v_log := public.zz_chk_imm(v_log, 'no Procurement request was created for an IMMEDIATE_DELIVERY item', n = 0);

  select pipeline_status into v_pipeline from retail_orders where id = v_order.id;
  v_log := public.zz_chk_imm(v_log, 'pipeline_status is AWAITING_PRODUCT_PHOTO before the sales photo is captured', v_pipeline = 'AWAITING_PRODUCT_PHOTO');

  select count(*) into n from retail_godown_handovers where order_id = v_order.id;
  v_log := public.zz_chk_imm(v_log, 'no Godown handover exists yet — nothing auto-fires before the photo', n = 0);

  -- recording the photo metadata is refused before the photo itself has been uploaded
  v_errmsg := null;
  begin
    perform retail_record_sales_photo_meta(v_item_id, 'Front display', null, null, null);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_imm(v_log, 'sales photo metadata is refused before a photo is uploaded', v_errmsg is not null);

  -- an unrelated employee cannot touch this item at all
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_record_sales_photo_meta(v_item_id, null, null, null, null);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_imm(v_log, 'an unrelated employee cannot record a sales photo on someone else''s item', v_errmsg is not null);
  reset role;

  -- upload the Sales Confirmation Product Photo (same pattern as every other proof photo in this suite)
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_sales::text || '/zimd-sales.jpg',
    jsonb_build_object('size', 700, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  v_att_id := staff_record_attachment('retail_order_item', v_item_id, 'image', v_sales::text || '/zimd-sales.jpg', 'zimd-sales.jpg', 'image/jpeg', 700, null, 'proof');
  v_log := public.zz_chk_imm(v_log, 'the Sales Confirmation Product Photo was recorded as a real staff_attachments row', v_att_id is not null);

  -- capturing the photo metadata is the automatic trigger: no manual "Send to Godown" click anywhere in this test.
  select * into v_item from retail_record_sales_photo_meta(v_item_id, 'Front display', 'SN-ZIMD-1', 'Minor scuff, disclosed', 'Handle with care');
  v_log := public.zz_chk_imm(v_log, 'sales photo metadata recorded, captured_at set', v_item.sales_photo_captured_at is not null and v_item.sales_photo_serial = 'SN-ZIMD-1');

  select count(*) into n from retail_godown_handovers where order_id = v_order.id and status = 'PENDING';
  v_log := public.zz_chk_imm(v_log, 'a Godown handover was created AUTOMATICALLY the moment the photo was captured', n = 1);
  select * into v_handover from retail_godown_handovers where order_id = v_order.id;
  v_log := public.zz_chk_imm(v_log, 'the auto-created handover is assigned to the Godown department head and has a linked task', v_handover.responsible_user_id = v_godown and v_handover.linked_task_id is not null);

  select pipeline_status into v_pipeline from retail_orders where id = v_order.id;
  v_log := public.zz_chk_imm(v_log, 'pipeline_status has moved on from AWAITING_PRODUCT_PHOTO', v_pipeline = 'ASSIGNED_TO_GODOWN');

  -- retry from both directions: idempotent, never a second handover
  perform retail_maybe_auto_request_godown(v_order.id);
  perform retail_record_sales_photo_meta(v_item_id, null, null, null, null);
  select count(*) into n from retail_godown_handovers where order_id = v_order.id;
  v_log := public.zz_chk_imm(v_log, 'retrying the trigger from either direction is idempotent — still exactly one handover', n = 1);
  reset role;

  -- Godown accept still requires its OWN receiving photo (unchanged rule)
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_godown_accept(v_handover.id, 1, true, true, null, null);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_imm(v_log, 'Godown cannot accept an Immediate Delivery handover without its own receiving photo', v_errmsg is not null);

  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown::text || '/zimd-receiving.jpg',
    jsonb_build_object('size', 650, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform staff_record_attachment('retail_godown_handover', v_handover.id, 'image', v_godown::text || '/zimd-receiving.jpg', 'zimd-receiving.jpg', 'image/jpeg', 650, null, 'proof');

  select * into v_handover from retail_godown_accept(v_handover.id, 1, true, true, 'Rack Z1', 'Verified on-site');
  v_log := public.zz_chk_imm(v_log, 'Godown accepts once its own receiving photo exists', v_handover.status = 'ACCEPTED');

  select * into v_packing from retail_packing_records where id = v_handover.packing_id;
  v_log := public.zz_chk_imm(v_log, 'accepting created/linked a packing record still awaiting packing (not pre-packed)', v_packing.id is not null and v_packing.status = 'AWAITING_PACKING');
  select count(*) into n from staff_tasks where system_key = 'retail_godown_packing:' || v_packing.id::text and to_department_id = v_godown_dept and is_active;
  v_log := public.zz_chk_imm(v_log, 'a Godown-assigned verify-and-pack task was created (not assigned back to the salesperson)', n = 1);

  -- Godown itself completes the SAME photo-gated packing RPC used by the standard flow — the widened authorization
  -- (staff_is_godown_staff()) is what makes this succeed where it would previously have raised "Not authorized".
  v_errmsg := null;
  begin
    perform retail_verify_packing(v_packing.id, jsonb_build_array(jsonb_build_object('order_item_id', v_item_id, 'quantity_confirmed', 1)), 'PASSED', 1, null, null);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_imm(v_log, 'packing still refuses without ITS OWN photo, even for Godown staff (unchanged rule)', v_errmsg is not null);

  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown::text || '/zimd-packing.jpg',
    jsonb_build_object('size', 600, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform staff_record_attachment('retail_packing', v_packing.id, 'image', v_godown::text || '/zimd-packing.jpg', 'zimd-packing.jpg', 'image/jpeg', 600, null, 'proof');

  select * into v_packing from retail_verify_packing(v_packing.id, jsonb_build_array(jsonb_build_object('order_item_id', v_item_id, 'quantity_confirmed', 1)), 'PASSED', 1, 'Good condition', null);
  v_log := public.zz_chk_imm(v_log, 'Godown staff can now complete packing verification (previously would have been "Not authorized")', v_packing.status = 'READY_FOR_GODOWN');
  reset role;

  raise exception E'IMMEDIATE-DELIVERY-REGRESSION (rolled back)\n%', v_log;
end $t$;
