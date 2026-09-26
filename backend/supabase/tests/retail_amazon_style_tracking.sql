-- Regression test for v2_93p (unified automatic Godown handoff + Head assigns a team member). Runs against real
-- data as impersonated users, always rolls back. Covers: a STOCK-only order auto-fires the Godown request
-- immediately on confirm (no packing/manual "send to godown" step); a FACTORY-only order does NOT auto-fire until
-- its job card's factory_status becomes 'completed', and does fire immediately once it does (exercising the new
-- trigger); retail_assign_godown_handover reassigns a PENDING handover and notifies the new assignee; it is
-- refused once the handover is ACCEPTED; a plain Godown employee (not Head/Supervisor/oversight) cannot assign.
do $t$
declare
  v_log text := ''; v_sales uuid; v_godown_head uuid; v_godown_worker uuid; v_other uuid; v_emp_role uuid; v_head_role uuid;
  v_godown_dept uuid; v_loc uuid; v_errmsg text; n int;
  v_lead1 record; v_quote1 public.retail_quotations; v_order1 public.retail_orders; v_item1 uuid;
  v_quote2 public.retail_quotations; v_order2 public.retail_orders; v_item2 uuid; v_job_card_id uuid;
  v_handover public.retail_godown_handovers;
begin
  create function public.zz_chk_amz(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select id into v_emp_role from roles where code = 'employee';
  select id into v_head_role from roles where code = 'dept_head';
  v_godown_dept := public.retail_godown_dept_id();
  select up.id into v_sales from user_profiles up join roles r on r.id=up.role_id where up.department_id=public.retail_dept_id() and r.code='employee' and up.is_active limit 1;
  select up.id into v_other from user_profiles up join roles r on r.id=up.role_id where up.department_id<>public.retail_dept_id() and up.department_id <> v_godown_dept and r.code='employee' and up.is_active and up.department_id is not null limit 1;
  select id into v_loc from locations where is_active limit 1;

  insert into auth.users (id) values (gen_random_uuid()) returning id into v_godown_head;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password)
    values (v_godown_head, 'ZTEST-AMZ-HEAD', 'ZTest Amazon Godown Head', v_head_role, v_godown_dept, true, false);
  insert into auth.users (id) values (gen_random_uuid()) returning id into v_godown_worker;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password)
    values (v_godown_worker, 'ZTEST-AMZ-WORKER', 'ZTest Amazon Godown Worker', v_emp_role, v_godown_dept, true, false);

  v_log := public.zz_chk_amz(v_log, 'fixture: sales, Godown head+worker, unrelated employee, location resolved',
    v_sales is not null and v_godown_head is not null and v_godown_worker is not null and v_other is not null and v_loc is not null);

  -- ===== STOCK-only order: should auto-fire the Godown request the instant it's confirmed, no packing step =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_lead1 from retail_create_walkin('ZAMZ Order1', '9556677881', null, null, null, null, null, null, null, null, null, 'walkin', v_sales, 'RETAIL', null, 'WARM', null);
  v_quote1 := retail_create_quotation(v_lead1.lead_id, 'ZAMZ Order1', '9556677881', null, current_date+10, current_date+20, 0, 0, null, false,
    jsonb_build_array(jsonb_build_object('item_name','ZAMZ Item1','quantity',1,'unit_price',0)), null);
  update retail_quotations set status='ACCEPTED' where id = v_quote1.id;
  v_order1 := retail_convert_quotation_to_order(v_quote1.id);
  select id into v_item1 from retail_order_items where order_id = v_order1.id;

  perform retail_confirm_order(v_order1.id, jsonb_build_array(jsonb_build_object('order_item_id', v_item1, 'mode', 'STOCK', 'quantity', 1, 'stock_location_id', v_loc)));

  select count(*) into n from retail_fulfilment_items where order_id = v_order1.id and mode = 'STOCK' and status = 'READY';
  v_log := public.zz_chk_amz(v_log, 'a STOCK fulfilment item is READY immediately at confirm (no manual step)', n = 1);
  select count(*) into n from retail_godown_handovers where order_id = v_order1.id and status = 'PENDING';
  v_log := public.zz_chk_amz(v_log, 'a STOCK-only order auto-fires the Godown request immediately on confirm', n = 1);
  select * into v_handover from retail_godown_handovers where order_id = v_order1.id;
  -- picked responsible person is whichever active Godown dept_head exists (may be a real onboarded head, not
  -- necessarily this test's own fixture, since a real Godown Head now exists in the live pilot data) -- the real
  -- invariant is that SOME real person + task were assigned, not which specific person the auto-pick landed on.
  v_log := public.zz_chk_amz(v_log, 'the auto-created handover has a real responsible person and a linked task', v_handover.responsible_user_id is not null and v_handover.linked_task_id is not null);
  reset role;

  -- ===== retail_assign_godown_handover: Head assigns a specific worker =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_assign_godown_handover(v_handover.id, v_godown_worker);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_amz(v_log, 'an unrelated employee cannot assign a Godown handover', v_errmsg is not null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_worker, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_assign_godown_handover(v_handover.id, v_godown_worker);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_amz(v_log, 'a plain Godown employee (not Head/Supervisor/oversight) cannot assign a handover', v_errmsg is not null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  v_handover := retail_assign_godown_handover(v_handover.id, v_godown_worker);
  v_log := public.zz_chk_amz(v_log, 'the Godown Head reassigns the pending handover to a specific worker', v_handover.responsible_user_id = v_godown_worker);
  reset role;

  -- accept as the newly-assigned worker, then confirm reassignment is refused post-acceptance
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_worker, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role;
  insert into storage.objects (bucket_id, name, metadata) values ('staff-attachments', v_godown_worker::text || '/zamz-receive.jpg', jsonb_build_object('size', 500, 'mimetype', 'image/jpeg'));
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_worker, 'role', 'authenticated')::text, true); set local role authenticated;
  perform staff_record_attachment('retail_godown_handover', v_handover.id, 'image', v_godown_worker::text || '/zamz-receive.jpg', 'zamz-receive.jpg', 'image/jpeg', 500, null, 'proof');
  v_handover := retail_godown_accept(v_handover.id, 1, true, true, 'Rack Z9', null);
  v_log := public.zz_chk_amz(v_log, 'the newly-assigned worker can accept (proves the reassignment actually took effect)', v_handover.status = 'ACCEPTED');
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_godown_head, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_assign_godown_handover(v_handover.id, v_godown_worker);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk_amz(v_log, 'reassigning is refused once the handover is ACCEPTED', v_errmsg is not null);
  reset role;

  -- ===== FACTORY-only order: must NOT auto-fire until the job card completes =====
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  v_quote2 := retail_create_quotation(null, 'ZAMZ Order2', '9556677882', null, current_date+10, current_date+20, 0, 0, null, false,
    jsonb_build_array(jsonb_build_object('item_name','ZAMZ Item2','quantity',1,'unit_price',0)), null);
  update retail_quotations set status='ACCEPTED' where id = v_quote2.id;
  v_order2 := retail_convert_quotation_to_order(v_quote2.id);
  select id into v_item2 from retail_order_items where order_id = v_order2.id;
  perform retail_confirm_order(v_order2.id, jsonb_build_array(jsonb_build_object('order_item_id', v_item2, 'mode', 'FACTORY', 'required_date', (current_date+20)::text)));

  select count(*) into n from retail_godown_handovers where order_id = v_order2.id;
  v_log := public.zz_chk_amz(v_log, 'a FACTORY-only order does NOT auto-fire the Godown request before its job card completes', n = 0);

  select job_card_id into v_job_card_id from retail_fulfilment_items where order_id = v_order2.id;
  reset role;

  -- simulate Factory completing the job card (the real completion RPC is Factory's own, out of scope here — this
  -- exercises the NEW TRIGGER's reaction to the status change, which is the actual thing under test).
  update inhouse_production_requests set factory_status = 'completed' where id = v_job_card_id;

  select status into n from retail_fulfilment_items where order_id = v_order2.id and status = 'READY';
  select count(*) into n from retail_fulfilment_items where order_id = v_order2.id and status = 'READY';
  v_log := public.zz_chk_amz(v_log, 'the fulfilment item becomes READY the instant the job card completes (new trigger)', n = 1);
  select count(*) into n from retail_godown_handovers where order_id = v_order2.id and status = 'PENDING';
  v_log := public.zz_chk_amz(v_log, 'a FACTORY-only order auto-fires the Godown request immediately once its job card completes', n = 1);

  raise exception E'AMAZON-STYLE-TRACKING-REGRESSION (rolled back)\n%', v_log;
end $t$;
