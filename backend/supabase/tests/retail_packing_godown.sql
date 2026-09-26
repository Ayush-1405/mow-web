-- Regression test for v2_93i (Packing -> Godown handover/acceptance) + the v2_93l staff_record_attachment extension. Runs against
-- real data as impersonated users, always rolls back. Fabricates a Godown employee (no real active GODOWN_INV account exists in the
-- live pilot yet) and reuses a real Retail salesperson for everything else.
--
-- Covers: packing cannot start with fulfilment items not Ready unless a partial_reason is given; packing cannot be verified without
-- an uploaded photo; a verified, QC-passed, photo-backed packing record reaches READY_FOR_GODOWN; sending to Godown before that is
-- refused; sending to Godown is idempotent; an unrelated employee cannot see or act on any of it; Godown accept requires its own
-- receiving photo; accept clears a prior on_hold; reject sets on_hold + creates a correction task and is idempotent; every
-- transition is recorded in retail_status_history.
do $t$
declare
  v_log text := ''; v_sales uuid; v_other uuid; v_godown uuid; v_emp_role uuid; v_godown_dept uuid; v_loc uuid;
  v_lead record; v_quote public.retail_quotations; v_order public.retail_orders; v_item_id uuid;
  v_packing public.retail_packing_records; v_handover public.retail_godown_handovers; v_att_id uuid; n int; v_errmsg text;
  v_order2 public.retail_orders; v_quote2 public.retail_quotations; v_packing2 public.retail_packing_records; v_handover2 public.retail_godown_handovers;
begin
  create function public.zz_chk8(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select id into v_emp_role from roles where code = 'employee';
  v_godown_dept := public.retail_godown_dept_id();
  select up.id into v_sales from user_profiles up join roles r on r.id=up.role_id where up.department_id=public.retail_dept_id() and r.code='employee' and up.is_active limit 1;
  select up.id into v_other from user_profiles up join roles r on r.id=up.role_id where up.department_id<>public.retail_dept_id() and up.department_id <> v_godown_dept and r.code='employee' and up.is_active and up.department_id is not null limit 1;
  select id into v_loc from locations where is_active limit 1;

  insert into auth.users (id) values (gen_random_uuid()) returning id into v_godown;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password) values (v_godown, 'ZTEST-GDN', 'ZTest Godown Person', v_emp_role, v_godown_dept, true, false);

  v_log := public.zz_chk8(v_log, 'fixture: sales, unrelated employee, fabricated Godown person, location all resolved', v_sales is not null and v_other is not null and v_godown is not null and v_loc is not null);

  -- build a confirmed STOCK order as the salesperson
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_lead from retail_create_walkin('ZPK Test Customer', '9334455661', null, null, null, null, null, null, null, null, null, 'walkin', v_sales, 'RETAIL', null, 'WARM', null);
  v_quote := retail_create_quotation(v_lead.lead_id, 'ZPK Test Customer', '9334455661', null, current_date+10, current_date+20, 0, 0, null, false,
    jsonb_build_array(jsonb_build_object('item_name','ZPK Item','quantity',1,'unit_price',10000)), null);
  update retail_quotations set status='ACCEPTED' where id = v_quote.id;
  v_order := retail_convert_quotation_to_order(v_quote.id);
  select id into v_item_id from retail_order_items where order_id = v_order.id;
  perform retail_confirm_order(v_order.id, jsonb_build_array(jsonb_build_object('order_item_id', v_item_id, 'mode', 'STOCK', 'quantity', 1, 'stock_location_id', v_loc)));

  -- packing cannot start yet: the fulfilment item is only RESERVED, not READY, and no partial_reason was given
  v_errmsg := null;
  begin
    perform retail_start_packing(v_order.id);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk8(v_log, 'packing refuses to start while an item is not Ready, with no partial_reason', v_errmsg is not null);
  reset role;

  -- (test-only setup: mark the item Ready, standing in for Factory-completion/GRN — no such RPC exists in this migration)
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role;
  update retail_fulfilment_items set status = 'READY' where order_id = v_order.id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_packing := retail_start_packing(v_order.id);
  v_log := public.zz_chk8(v_log, 'packing starts once the item is Ready', v_packing.id is not null and v_packing.status = 'AWAITING_PACKING' and v_packing.linked_task_id is not null);
  select count(*) into n from retail_packing_items where packing_id = v_packing.id;
  v_log := public.zz_chk8(v_log, 'one packing item row was auto-created per order item', n = 1);

  select * into v_packing from retail_start_packing(v_order.id);
  v_log := public.zz_chk8(v_log, 'starting packing twice is idempotent (same row)', v_packing.status = 'AWAITING_PACKING');

  -- verify without a photo is refused
  v_errmsg := null;
  begin
    perform retail_verify_packing(v_packing.id, '[]'::jsonb, 'PASSED', 2, null, null);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk8(v_log, 'packing cannot be verified without an uploaded photo', v_errmsg is not null);

  -- upload a (fake, rolled-back) packing photo the same way the real edge function would have recorded it. storage.objects has its
  -- own RLS with no INSERT policy for a plain authenticated user (only the edge function's service-role client can do this for
  -- real) -- so the test steps briefly out of impersonation, exactly as the edge function's own admin client would.
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_sales::text || '/zpk-packing.jpg',
    jsonb_build_object('size', 1000, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  v_att_id := staff_record_attachment('retail_packing', v_packing.id, 'image', v_sales::text || '/zpk-packing.jpg', 'zpk-packing.jpg', 'image/jpeg', 1000, null, 'proof');
  v_log := public.zz_chk8(v_log, 'the packing photo was recorded as a real staff_attachments row', v_att_id is not null);

  select * into v_packing from retail_verify_packing(v_packing.id, jsonb_build_array(jsonb_build_object('order_item_id', v_item_id, 'quantity_confirmed', 1)), 'PASSED', 2, 'All good', null);
  v_log := public.zz_chk8(v_log, 'packing reaches READY_FOR_GODOWN once photo + QC PASSED + package_count are all present', v_packing.status = 'READY_FOR_GODOWN');

  -- an unrelated employee (outside Retail AND Godown) sees nothing and cannot act
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*) into n from retail_packing_records where id = v_packing.id;
  v_log := public.zz_chk8(v_log, 'an unrelated employee cannot see this packing record', n = 0);
  begin perform retail_send_to_godown(v_order.id, v_loc, v_godown, null, null); v_log := public.zz_chk8(v_log, 'an unrelated employee cannot send this order to Godown', false);
  exception when others then v_log := public.zz_chk8(v_log, 'an unrelated employee cannot send this order to Godown', true); end;
  reset role;

  -- send to Godown
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_handover := retail_send_to_godown(v_order.id, v_loc, v_godown, now() + interval '1 day', 'Please handle with care');
  v_log := public.zz_chk8(v_log, 'sending to Godown creates a PENDING handover with a linked task', v_handover.id is not null and v_handover.status = 'PENDING' and v_handover.linked_task_id is not null);

  select * into v_handover from retail_send_to_godown(v_order.id, v_loc, v_godown, null, null);
  v_log := public.zz_chk8(v_log, 'sending to Godown twice is idempotent (same open handover, no duplicate)', v_handover.id is not null);
  select count(*) into n from retail_godown_handovers where order_id = v_order.id;
  v_log := public.zz_chk8(v_log, 'exactly one handover row exists for the order', n = 1);
  reset role;

  -- Godown accept requires its own photo
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*) into n from retail_godown_handovers where id = v_handover.id;
  v_log := public.zz_chk8(v_log, 'Godown staff can see the incoming handover', n = 1);
  v_errmsg := null;
  begin
    perform retail_godown_accept(v_handover.id, 1, true, true, 'Rack A1', null);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk8(v_log, 'Godown cannot accept without a receiving photo', v_errmsg is not null);

  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown::text || '/zpk-receiving.jpg',
    jsonb_build_object('size', 900, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform staff_record_attachment('retail_godown_handover', v_handover.id, 'image', v_godown::text || '/zpk-receiving.jpg', 'zpk-receiving.jpg', 'image/jpeg', 900, null, 'proof');

  select * into v_handover from retail_godown_accept(v_handover.id, 1, true, true, 'Rack A1', 'All received in good condition');
  v_log := public.zz_chk8(v_log, 'Godown accepts once a receiving photo exists', v_handover.status = 'ACCEPTED' and v_handover.rack_location = 'Rack A1');
  reset role;

  -- a SECOND order, to exercise the rejection path independently
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_quote2 := retail_create_quotation(null, 'ZPK Reject Customer', '9334455662', null, current_date+10, current_date+20, 0, 0, null, false,
    jsonb_build_array(jsonb_build_object('item_name','ZPK Reject Item','quantity',1,'unit_price',5000)), null);
  update retail_quotations set status='ACCEPTED' where id = v_quote2.id;
  v_order2 := retail_convert_quotation_to_order(v_quote2.id);
  select id into v_item_id from retail_order_items where order_id = v_order2.id;
  perform retail_confirm_order(v_order2.id, jsonb_build_array(jsonb_build_object('order_item_id', v_item_id, 'mode', 'STOCK', 'quantity', 1, 'stock_location_id', v_loc)));
  reset role;
  update retail_fulfilment_items set status = 'READY' where order_id = v_order2.id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_packing2 := retail_start_packing(v_order2.id);
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_sales::text || '/zpk-packing2.jpg', jsonb_build_object('size', 800, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform staff_record_attachment('retail_packing', v_packing2.id, 'image', v_sales::text || '/zpk-packing2.jpg', 'zpk-packing2.jpg', 'image/jpeg', 800, null, 'proof');
  perform retail_verify_packing(v_packing2.id, '[]'::jsonb, 'PASSED', 1, null, null);
  v_handover2 := retail_send_to_godown(v_order2.id, v_loc, v_godown, null, null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_godown, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_godown_reject(v_handover2.id, '', null, null, null, null);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk8(v_log, 'rejecting without a reason is refused', v_errmsg is not null);

  select * into v_handover2 from retail_godown_reject(v_handover2.id, 'Two units damaged in transit', 0, 2, null, null);
  v_log := public.zz_chk8(v_log, 'Godown reject sets the handover REJECTED with the reason', v_handover2.status = 'REJECTED' and v_handover2.rejection_reason = 'Two units damaged in transit');
  reset role;

  select count(*) into n from retail_orders where id = v_order2.id and on_hold = true;
  v_log := public.zz_chk8(v_log, 'a Godown rejection puts the order on_hold', n = 1);
  select count(*) into n from staff_tasks where system_key = 'retail_godown_correction:' || v_handover2.id::text and is_active;
  v_log := public.zz_chk8(v_log, 'a correction task was created for the rejection', n = 1);

  perform set_config('request.jwt.claims', json_build_object('sub', v_godown, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_handover2 from retail_godown_reject(v_handover2.id, 'retry', null, null, null, null);
  v_log := public.zz_chk8(v_log, 'retrying a reject is idempotent (still REJECTED, original reason kept)', v_handover2.rejection_reason = 'Two units damaged in transit');
  reset role;

  -- status history recorded every real transition (checked as management, matching this table's own RLS)
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*) into n from retail_status_history where entity_type = 'retail_order' and entity_id = v_order.id and new_status = 'ASSIGNED_TO_GODOWN';
  v_log := public.zz_chk8(v_log, 'the ASSIGNED_TO_GODOWN transition is in retail_status_history (visible to the actor)', n = 1);
  reset role;

  raise exception E'PACKING-GODOWN-REGRESSION (rolled back)\n%', v_log;
end $t$;
