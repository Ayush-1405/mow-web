-- Production Supply Order Forms (v3_05): multi-item orders, both form types, approvals, Procurement return-for-correction,
-- print, order placed, amendment with history, delivered, completed, attachments, bypass blocks. Own fixtures, ALWAYS
-- rolls back (the report is in the error message).

do $t$
declare
  v_log text := ''; n int; v_pr public.purchase_requests; v_id uuid; v_rid uuid; v_ctx record; v_po public.purchase_orders; v_day date;
  r_emp uuid; r_head uuid; d_int uuid; d_proc uuid; d_ret uuid;
  u_e uuid := gen_random_uuid(); u_h uuid := gen_random_uuid(); u_ph uuid := gen_random_uuid(); u_r uuid := gen_random_uuid(); u_rh uuid := gen_random_uuid();
  v_items jsonb := '[{"item_code":"SF-01","description":"3 seater sofa, teak frame","qty_size":"1 no, 84x36 in","quantity":"1","rate":"42000"},
                     {"description":"Centre table, walnut finish","qty_size":"1 no","quantity":"1","rate":"18500"},
                     {"item_code":"CU-07","description":"Cushions, velvet","qty_size":"4 nos","quantity":"4","rate":"1250.50"}]';
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true); end $f$;
  v_day := (now() at time zone 'Asia/Kolkata')::date;
  select id into r_emp from roles where code = 'employee';
  select id into r_head from roles where code = 'dept_head';
  select id into d_int from departments where code = 'INTERIOR';
  select id into d_proc from departments where code = 'PROCUREMENT';
  select id into d_ret from departments where code = 'RETAIL';
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_e, u_h, u_ph, u_r, u_rh]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_e, 'ZZ-OF-E', 'ZZ Interior Employee', r_emp, d_int, '9822200001', false, true),
    (u_h, 'ZZ-OF-H', 'ZZ Interior Head', r_head, d_int, '9822200002', false, true),
    (u_ph, 'ZZ-OF-P', 'ZZ Procurement Head', r_head, d_proc, '9822200003', false, true),
    (u_r, 'ZZ-OF-R', 'ZZ Retail Employee', r_emp, d_ret, '9822200004', false, true),
    (u_rh, 'ZZ-OF-RH', 'ZZ Retail Head', r_head, d_ret, '9822200005', false, true);

  ---------------------------------------------------------------- create
  perform public.zz_as(u_e); set local role authenticated;
  begin perform public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'required_completion_date', v_day + 10, 'delivery_location', 'Site'), '[]');
        v_log := public.zz_chk(v_log, 'an order with no items is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'an order with no items is refused', sqlerrm ilike '%at least one item%'); end;
  begin perform public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'required_completion_date', v_day + 10, 'delivery_location', 'Site'), '[{"description":"x"}]');
        v_log := public.zz_chk(v_log, 'an item without quantity / size is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'an item without quantity / size is refused', sqlerrm ilike '%quantity / size%'); end;
  begin perform public.proc_create_order(jsonb_build_object('form_type', 'OTHER', 'required_completion_date', v_day + 10, 'delivery_location', 'Site'), v_items);
        v_log := public.zz_chk(v_log, 'an unknown form type is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'an unknown form type is refused', sqlerrm ilike '%Interior or Retail%'); end;
  begin
    v_pr := public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'client_name', 'Mr. Shah', 'sales_person_name', 'Ravi', 'vendor_name', 'Shree Furniture',
      'required_completion_date', v_day + 10, 'delivery_date', v_day + 12, 'delivery_location', 'Shah residence, Rajkot', 'remarks', 'Match sample'), v_items);
    v_id := v_pr.id;
    v_log := public.zz_chk(v_log, 'Interior order with 3 items -> Pending Department Approval, PR number, total Rs 65,502',
      v_pr.proc_status = 'PENDING_DEPT_APPROVAL' and v_pr.request_number like 'PR-______-____' and v_pr.order_total = 65502.00 and v_pr.order_form_type = 'INTERIOR');
  exception when others then v_log := public.zz_chk(v_log, 'create order: ' || sqlerrm, false); end;
  v_log := public.zz_chk(v_log, 'items stored in order with amounts = qty x rate',
    (select string_agg(line_no || ':' || coalesce(amount::text, '-'), ',' order by line_no) from purchase_request_items where purchase_request_id = v_id) = '1:42000.00,2:18500.00,3:5002.00');
  begin perform public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'required_completion_date', v_day + 10, 'delivery_location', 'Site'), v_items);
        v_log := public.zz_chk(v_log, 'the same order twice is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'the same order twice is refused', sqlerrm ilike '%already open%'); end;
  begin insert into purchase_request_items (purchase_request_id, item_name, status) values (v_id, 'sneaky', 'Requested');
        v_log := public.zz_chk(v_log, 'items cannot be added directly to an order', false);
  exception when others then v_log := public.zz_chk(v_log, 'items cannot be added directly to an order', true); end;
  reset role;
  v_log := public.zz_chk(v_log, 'the Interior Head is notified', (select count(*) from notifications where recipient_id = u_h and entity_id = v_id) = 1);

  ---------------------------------------------------------------- head approves -> Procurement returns -> requester corrects
  perform public.zz_as(u_rh); set local role authenticated;
  begin perform public.proc_dept_decision(v_id, 'APPROVE', null); v_log := public.zz_chk(v_log, 'the Retail Head cannot approve an Interior order', false);
  exception when others then v_log := public.zz_chk(v_log, 'the Retail Head cannot approve an Interior order', true); end;
  reset role;
  perform public.zz_as(u_h); set local role authenticated; perform public.proc_dept_decision(v_id, 'APPROVE', 'OK'); reset role;
  v_log := public.zz_chk(v_log, 'Head approval sends it to Procurement and notifies them', (select proc_status from purchase_requests where id = v_id) = 'SENT_TO_PROCUREMENT'
    and (select count(*) from notifications where recipient_id = u_ph and entity_id = v_id) >= 1);
  perform public.zz_as(u_ph); set local role authenticated;
  begin perform public.proc_procurement_decision(v_id, 'RETURN', null); v_log := public.zz_chk(v_log, 'returning needs a reason', false);
  exception when others then v_log := public.zz_chk(v_log, 'returning needs a reason', sqlerrm ilike '%reason%'); end;
  perform public.proc_procurement_decision(v_id, 'RETURN', 'Add size of centre table');
  reset role;
  v_log := public.zz_chk(v_log, 'Procurement returns for correction; requester and Head notified', (select proc_status from purchase_requests where id = v_id) = 'RETURNED_FOR_CORRECTION'
    and (select count(*) from notifications where entity_id = v_id and recipient_id in (u_e, u_h) and title_en like '%returned order%') = 2);
  perform public.zz_as(u_e); set local role authenticated;
  begin perform public.proc_update_order(v_id, jsonb_build_object('form_type', 'INTERIOR', 'client_name', 'Mr. Shah', 'required_completion_date', v_day + 10,
          'delivery_location', 'Shah residence, Rajkot'), jsonb_set(v_items, '{1,qty_size}', '"1 no, 48x24 in"'));
        perform public.proc_submit_request(v_id);
        v_log := public.zz_chk(v_log, 'the requester corrects the items and resubmits -> back to the Head',
          (select proc_status from purchase_requests where id = v_id) = 'PENDING_DEPT_APPROVAL'
          and (select qty_size from purchase_request_items where purchase_request_id = v_id and line_no = 2) = '1 no, 48x24 in');
  exception when others then v_log := public.zz_chk(v_log, 'correct and resubmit: ' || sqlerrm, false); end;
  reset role;
  perform public.zz_as(u_h); set local role authenticated; perform public.proc_dept_decision(v_id, 'APPROVE', null); reset role;

  ---------------------------------------------------------------- accept -> print -> placed
  perform public.zz_as(u_ph); set local role authenticated;
  perform public.proc_procurement_decision(v_id, 'ACCEPT', null);
  reset role;
  v_log := public.zz_chk(v_log, 'acceptance notifies the requester and the Head', (select count(*) from notifications where entity_id = v_id and recipient_id in (u_e, u_h) and title_en like 'Procurement accepted order%') = 2);
  perform public.zz_as(u_ph); set local role authenticated;
  begin perform public.proc_confirm_order(v_id, 'Shree Furniture', '9876500111', 'Q-77', 'ZZPO-OF-1', v_day, 3, 65502, v_day + 12, '50% advance', 'ok');
        v_log := public.zz_chk(v_log, 'order cannot be placed before printing', false);
  exception when others then v_log := public.zz_chk(v_log, 'order cannot be placed before printing', sqlerrm ilike '%Print%'); end;
  perform public.proc_record_print(v_id, 'PURCHASE_REQUEST');
  reset role;
  -- Rs 65,502 is above Procurement's own limit: Management approval is part of the rule, approved here directly.
  insert into purchase_approvals (purchase_request_id, approval_level, decision, approved_amount, requested_amount) values (v_id, 'MANAGEMENT', 'APPROVED', 65502, 65502);
  perform public.zz_as(u_ph); set local role authenticated;
  begin v_po := public.proc_confirm_order(v_id, 'Shree Furniture', '9876500111', 'Q-77', 'ZZPO-OF-1', v_day, 3, 65502, v_day + 12, '50% advance', 'Best finish');
        v_log := public.zz_chk(v_log, 'printed order is placed -> Order Placed', (select proc_status from purchase_requests where id = v_id) = 'ORDER_PLACED');
  exception when others then v_log := public.zz_chk(v_log, 'place order: ' || sqlerrm, false); end;
  begin perform public.proc_amend_order(v_id, '{"expected_delivery_date":"2099-01-01"}', ' '); v_log := public.zz_chk(v_log, 'an amendment needs a reason', false);
  exception when others then v_log := public.zz_chk(v_log, 'an amendment needs a reason', sqlerrm ilike '%reason%'); end;
  begin perform public.proc_amend_order(v_id, '{"total_order_value":"1"}', 'try'); v_log := public.zz_chk(v_log, 'the order amount cannot be amended', false);
  exception when others then v_log := public.zz_chk(v_log, 'the order amount cannot be amended', sqlerrm ilike '%cannot be amended%'); end;
  begin perform public.proc_amend_order(v_id, jsonb_build_object('expected_delivery_date', v_day + 15), 'Vendor asked for 3 more days');
        v_log := public.zz_chk(v_log, 'amendment saved with history entry',
          (select expected_delivery_date from purchase_orders where purchase_request_id = v_id) = v_day + 15
          and (select count(*) from purchase_request_status_history where purchase_request_id = v_id and remarks like 'Amended:%') = 1);
  exception when others then v_log := public.zz_chk(v_log, 'amend: ' || sqlerrm, false); end;
  begin perform public.proc_mark_delivered(v_id, v_day, null);
        perform public.proc_finish_order_task(v_id, 'Delivered to the client');  -- (v3_07) task marked done first
        perform public.proc_complete_order(v_id, 'Done');
        v_log := public.zz_chk(v_log, 'delivered to client, then completed', (select proc_status from purchase_requests where id = v_id) = 'CLOSED'
          and (select delivered_to_client_at from purchase_requests where id = v_id) = v_day);
  exception when others then v_log := public.zz_chk(v_log, 'deliver/complete: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'the amendment keeps old and new values in the audit log',
    (select count(*) from staff_audit_log where entity_id = v_po.id and action = 'AMEND' and (old_value->>'expected_delivery_date')::date = v_day + 12
       and (new_value->>'expected_delivery_date')::date = v_day + 15) = 1);
  v_log := public.zz_chk(v_log, 'the full history is recorded in order',
    (select string_agg(to_status, '>' order by created_at) from purchase_request_status_history where purchase_request_id = v_id) =
    'PENDING_DEPT_APPROVAL>APPROVED_BY_DEPT_HEAD>SENT_TO_PROCUREMENT>RETURNED_FOR_CORRECTION>PENDING_DEPT_APPROVAL>APPROVED_BY_DEPT_HEAD>SENT_TO_PROCUREMENT>ACCEPTED_BY_PROCUREMENT>DOCUMENT_GENERATED>ORDER_PLACED>ORDER_PLACED>RECEIVED>RECEIVED>CLOSED');

  ---------------------------------------------------------------- Retail form, context, attachments
  perform public.zz_as(u_r); set local role authenticated;
  begin v_pr := public.proc_create_order(jsonb_build_object('form_type', 'RETAIL', 'client_name', 'Mrs. Patel', 'sales_person_name', 'Nita',
            'required_completion_date', v_day + 20, 'delivery_location', 'Showroom'), '[{"item_code":"BD-2","description":"King bed","qty_size":"1 no","quantity":"1","rate":"55000"}]');
        v_rid := v_pr.id;
        v_log := public.zz_chk(v_log, 'Retail order on the Retail form', v_pr.order_form_type = 'RETAIL' and v_pr.order_total = 55000);
  exception when others then v_log := public.zz_chk(v_log, 'retail order: ' || sqlerrm, false); end;
  select * into v_ctx from public.proc_request_context(array[v_rid]);
  v_log := public.zz_chk(v_log, 'form context carries the Department Head and item count', v_ctx.department_head_name is not null
    and v_ctx.department_head_name = public.staff_department_head_public(d_ret) and v_ctx.item_count = 1);
  reset role;
  insert into storage.objects (bucket_id, name, owner, metadata) values ('procurement-orders', 'orders/' || v_rid || '/drawing.pdf', u_r, '{"mimetype":"application/pdf","size":1000}');
  perform public.zz_as(u_r); set local role authenticated;
  begin perform public.proc_add_order_attachment(v_rid, 'orders/' || v_rid || '/drawing.pdf', 'drawing.pdf', 'application/pdf', 1000, null);
        v_log := public.zz_chk(v_log, 'a drawing is attached to the order', (select count(*) from purchase_attachments where purchase_request_id = v_rid and module = 'order') = 1);
  exception when others then v_log := public.zz_chk(v_log, 'attach: ' || sqlerrm, false); end;
  begin perform public.proc_add_order_attachment(v_rid, 'orders/' || v_id || '/x.pdf', 'x.pdf', 'application/pdf', 1, null);
        v_log := public.zz_chk(v_log, 'a file stored under another order is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'a file stored under another order is refused', true); end;
  select count(*) into n from purchase_requests where id = v_id;
  v_log := public.zz_chk(v_log, 'a Retail employee cannot see the Interior order', n = 0);
  reset role;

  raise exception E'\n%', v_log;
end $t$;
