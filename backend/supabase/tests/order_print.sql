-- Official order-form printing (v3_08): accepting the task accepts the order and unlocks printing; who may print; print
-- history with task, template and output; reprints never duplicate; PDF record; "it printed" confirmation; template
-- override by the Procurement Head; simplified Order Placed for order forms. Own fixtures; ALWAYS rolls back.

do $t$
declare
  v_log text := ''; n int; v_day date; v_id uuid; v_rid uuid; v_res jsonb; v_res2 jsonb; v_po public.purchase_orders; v_count_before int;
  r_emp uuid; r_head uuid; d_int uuid; d_proc uuid; d_ret uuid;
  u_e uuid := gen_random_uuid(); u_h uuid := gen_random_uuid(); u_ph uuid := gen_random_uuid(); u_p1 uuid := gen_random_uuid();
  u_p2 uuid := gen_random_uuid(); u_r uuid := gen_random_uuid(); u_rh uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true); end $f$;
  v_day := public.proc_today_ist();
  select id into r_emp from roles where code = 'employee';
  select id into r_head from roles where code = 'dept_head';
  select id into d_int from departments where code = 'INTERIOR';
  select id into d_proc from departments where code = 'PROCUREMENT';
  select id into d_ret from departments where code = 'RETAIL';
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_e, u_h, u_ph, u_p1, u_p2, u_r, u_rh]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_e, 'ZZ-PF-E', 'ZZ Interior Employee', r_emp, d_int, '9855500001', false, true),
    (u_h, 'ZZ-PF-H', 'ZZ Interior Head', r_head, d_int, '9855500002', false, true),
    (u_ph, 'ZZ-PF-P', 'ZZ Procurement Head', r_head, d_proc, '9855500003', false, true),
    (u_p1, 'ZZ-PF-1', 'ZZ Procurement One', r_emp, d_proc, '9855500004', false, true),
    (u_p2, 'ZZ-PF-2', 'ZZ Procurement Two', r_emp, d_proc, '9855500005', false, true),
    (u_r, 'ZZ-PF-R', 'ZZ Retail Employee', r_emp, d_ret, '9855500006', false, true),
    (u_rh, 'ZZ-PF-RH', 'ZZ Retail Head', r_head, d_ret, '9855500007', false, true);
  update procurement_settings set primary_head_user_id = u_ph where id;

  ---------------------------------------------------------------- 1-3. order, approval, accept -> print available
  perform public.zz_as(u_e); set local role authenticated;
  v_id := (public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'client_name', 'Kamlesh Bhai', 'sales_person_name', 'Chandni',
    'vendor_name', 'Shree Furniture', 'required_completion_date', v_day + 6, 'delivery_date', v_day + 8, 'delivery_location', 'Kamlesh Bhai site'),
    '[{"description":"Dining table, 4 seater","qty_size":"1 no"},{"description":"Chairs, cushioned","qty_size":"4 nos","remarks":"Match the sample"}]')).id;
  reset role;
  perform public.zz_as(u_h); set local role authenticated; perform public.proc_dept_decision(v_id, 'APPROVE', null); reset role;
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.proc_record_order_print(v_id, 'PRINT'); v_log := public.zz_chk(v_log, 'nobody prints before the task is accepted', false);
  exception when others then v_log := public.zz_chk(v_log, 'nobody prints before the task is accepted', true); end;
  perform public.staff_accept_task((select id from staff_tasks where purchase_request_id = v_id));
  reset role;
  v_log := public.zz_chk(v_log, 'accepting the task accepts the order (Accepted - awaiting print), by that employee',
    (select proc_status from purchase_requests where id = v_id) = 'ACCEPTED_BY_PROCUREMENT' and (select proc_decided_by from purchase_requests where id = v_id) = u_p1
    and (select count(*) from notifications where entity_id = v_id and recipient_id = u_h and title_en like 'Procurement accepted order%') = 1
    and (select count(*) from notifications where entity_id = v_id and recipient_id = u_e and title_en like 'Procurement accepted your order%handled by ZZ Procurement One%') = 1);
  perform public.zz_as(u_p1); set local role authenticated; v_log := public.zz_chk(v_log, 'the employee who accepted may print and confirm', public.proc_can_work_order(v_id)); reset role;
  perform public.zz_as(u_p2); set local role authenticated;
  v_log := public.zz_chk(v_log, 'another Procurement employee may not', not public.proc_can_work_order(v_id));
  begin perform public.proc_record_order_print(v_id, 'PRINT'); v_log := public.zz_chk(v_log, 'another Procurement employee cannot print it', false);
  exception when others then v_log := public.zz_chk(v_log, 'another Procurement employee cannot print it', sqlerrm ilike '%handling this order%'); end;
  reset role;
  perform public.zz_as(u_e); set local role authenticated;
  begin perform public.proc_record_order_print(v_id, 'PRINT'); v_log := public.zz_chk(v_log, 'the requester cannot print the official form', false);
  exception when others then v_log := public.zz_chk(v_log, 'the requester cannot print the official form', true); end;
  reset role;

  ---------------------------------------------------------------- 4-6, 14-15. print, reprint, history
  select count(*) into v_count_before from purchase_requests;
  perform public.zz_as(u_p1); set local role authenticated;
  v_res := public.proc_record_order_print(v_id, 'PRINT');
  v_res2 := public.proc_record_order_print(v_id, 'PRINT');
  reset role;
  v_log := public.zz_chk(v_log, 'first print: Interior template, version 1, PRINT_INITIATED; order moves to Printed',
    v_res->>'template' = 'INTERIOR' and (v_res->>'document_version')::int = 1 and v_res->>'action' = 'PRINT_INITIATED'
    and (select proc_status from purchase_requests where id = v_id) = 'DOCUMENT_GENERATED');
  v_log := public.zz_chk(v_log, 'print history keeps order, task, printer, time, template and output',
    (select count(*) from purchase_print_logs where purchase_request_id = v_id) = 2
    and (select bool_and(task_id = (select id from staff_tasks where purchase_request_id = v_id) and printed_by = u_p1 and template = 'INTERIOR'
                         and output = 'PRINT' and printed_at is not null and print_confirmed_at is null)
           from purchase_print_logs where purchase_request_id = v_id));
  v_log := public.zz_chk(v_log, 'printing again is a REPRINT and never creates another order', v_res2->>'action' = 'REPRINT'
    and (select count(*) from purchase_requests) = v_count_before and (select document_version from purchase_requests where id = v_id) = 1);
  v_log := public.zz_chk(v_log, 'printing alone does not place the order', (select proc_status from purchase_requests where id = v_id) = 'DOCUMENT_GENERATED'
    and not exists (select 1 from purchase_orders where purchase_request_id = v_id));

  ---------------------------------------------------------------- PDF and "it printed"
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.proc_record_order_print(v_id, 'PDF', 'orders/' || gen_random_uuid() || '/x.pdf'); v_log := public.zz_chk(v_log, 'a PDF stored under another order is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'a PDF stored under another order is refused', sqlerrm ilike '%not stored under this order%'); end;
  begin perform public.proc_record_order_print(v_id, 'PDF', 'orders/' || v_id || '/printed/none.pdf'); v_log := public.zz_chk(v_log, 'a PDF that was not uploaded is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'a PDF that was not uploaded is refused', sqlerrm ilike '%not uploaded%'); end;
  reset role;
  insert into storage.objects (bucket_id, name, owner, metadata) values ('procurement-orders', 'orders/' || v_id || '/printed/form-v1.pdf', u_p1, '{"mimetype":"application/pdf","size":2000}');
  perform public.zz_as(u_p1); set local role authenticated;
  v_res := public.proc_record_order_print(v_id, 'PDF', 'orders/' || v_id || '/printed/form-v1.pdf');
  reset role;
  v_log := public.zz_chk(v_log, 'the downloaded PDF is recorded with its stored copy',
    (select output = 'PDF' and pdf_storage_path = 'orders/' || v_id || '/printed/form-v1.pdf' from purchase_print_logs where id = (v_res->>'log_id')::uuid));
  perform public.zz_as(u_p2); set local role authenticated;
  begin perform public.proc_confirm_print((v_res2->>'log_id')::uuid); v_log := public.zz_chk(v_log, 'someone else cannot confirm the print', false);
  exception when others then v_log := public.zz_chk(v_log, 'someone else cannot confirm the print', true); end;
  reset role;
  perform public.zz_as(u_p1); set local role authenticated;
  perform public.proc_confirm_print((v_res2->>'log_id')::uuid);
  begin perform public.proc_confirm_print((v_res->>'log_id')::uuid); v_log := public.zz_chk(v_log, 'a PDF is not "confirmed printed"', false);
  exception when others then v_log := public.zz_chk(v_log, 'a PDF is not "confirmed printed"', true); end;
  reset role;
  v_log := public.zz_chk(v_log, 'the printer confirms the paper came out (kept apart from print initiation)',
    (select print_confirmed_by = u_p1 and print_confirmed_at is not null from purchase_print_logs where id = (v_res2->>'log_id')::uuid)
    and (select print_confirmed_at is null from purchase_print_logs where id = (select id from purchase_print_logs where purchase_request_id = v_id order by printed_at limit 1)));

  ---------------------------------------------------------------- template override
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.proc_set_print_template(v_id, 'RETAIL', 'needs rates'); v_log := public.zz_chk(v_log, 'an employee cannot change the template', false);
  exception when others then v_log := public.zz_chk(v_log, 'an employee cannot change the template', true); end;
  reset role;
  perform public.zz_as(u_ph); set local role authenticated;
  begin perform public.proc_set_print_template(v_id, 'RETAIL', ''); v_log := public.zz_chk(v_log, 'a template change needs a reason', false);
  exception when others then v_log := public.zz_chk(v_log, 'a template change needs a reason', sqlerrm ilike '%reason%'); end;
  -- v3_14: an Interior department order always prints on the Interior PO form (the override for other departments is in
  -- form_by_department.sql).
  begin perform public.proc_set_print_template(v_id, 'RETAIL', 'Vendor needs the rate sheet');
        v_log := public.zz_chk(v_log, 'an Interior order cannot be switched to the Retail form', false);
  exception when others then v_log := public.zz_chk(v_log, 'an Interior order cannot be switched to the Retail form', sqlerrm ilike '%always use the Interior PO form%'); end;
  v_res := public.proc_record_order_print(v_id, 'PRINT');
  reset role;
  v_log := public.zz_chk(v_log, 'the next print still uses the Interior form',
    v_res->>'template' = 'INTERIOR' and (select print_template from purchase_requests where id = v_id) is null);

  ---------------------------------------------------------------- 16-17. Order Placed by the employee, minimal fields
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.proc_confirm_order(v_id, null, null, null, ' ', v_day, null, null, v_day + 5, null, null);
        v_log := public.zz_chk(v_log, 'the vendor PO / reference number is required', false);
  exception when others then v_log := public.zz_chk(v_log, 'the vendor PO / reference number is required', sqlerrm ilike '%reference number%'); end;
  begin perform public.proc_confirm_order(v_id, null, null, null, 'ZZPO-PF-1', v_day, null, null, null, null, null);
        v_log := public.zz_chk(v_log, 'the expected delivery date is required', false);
  exception when others then v_log := public.zz_chk(v_log, 'the expected delivery date is required', sqlerrm ilike '%expected delivery%'); end;
  begin perform public.proc_confirm_order(v_id, null, '123', null, 'ZZPO-PF-1', v_day, null, null, v_day + 5, null, null);
        v_log := public.zz_chk(v_log, 'a vendor phone, when given, must be valid', false);
  exception when others then v_log := public.zz_chk(v_log, 'a vendor phone, when given, must be valid', sqlerrm ilike '%valid phone%'); end;
  begin v_po := public.proc_confirm_order(v_id, null, null, null, 'ZZPO-PF-1', v_day, null, null, v_day + 5, null, null);
  exception when others then v_log := public.zz_chk(v_log, 'confirm: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'the employee confirms Order Placed with vendor (from the order), PO number and expected date',
    (select proc_status from purchase_requests where id = v_id) = 'ORDER_PLACED' and v_po.po_number = 'ZZPO-PF-1' and v_po.expected_delivery_date = v_day + 5
    and (select name from vendors where id = v_po.vendor_id) = 'Shree Furniture' and v_po.ordered_quantity = 2 and v_po.confirmed_by = u_p1);
  v_log := public.zz_chk(v_log, 'Order Placed reaches the requester, Department Head and Procurement Head',
    (select count(distinct recipient_id) from notifications where entity_id = v_id and title_en like 'Order placed%' and recipient_id in (u_e, u_h, u_ph)) = 3);
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.proc_confirm_order(v_id, 'X', null, null, 'ZZPO-PF-9', v_day, null, null, v_day + 5, null, null);
        v_log := public.zz_chk(v_log, 'Order Placed cannot be confirmed twice', false);
  exception when others then v_log := public.zz_chk(v_log, 'Order Placed cannot be confirmed twice', sqlerrm ilike '%already been confirmed%'); end;
  reset role;

  ---------------------------------------------------------------- 7-9. Retail order -> Retail template, rates and amount
  perform public.zz_as(u_r); set local role authenticated;
  v_rid := (public.proc_create_order(jsonb_build_object('form_type', 'RETAIL', 'client_name', 'Mrs. Patel', 'sales_person_name', 'Nita',
    'required_completion_date', v_day + 10, 'delivery_location', 'Showroom'),
    '[{"item_code":"BD-1","description":"King bed","qty_size":"1","quantity":"1","rate":"42000"},
      {"item_code":"BD-2","description":"Side table","qty_size":"2","quantity":"2","rate":"6500"},
      {"item_code":"BD-3","description":"Mattress","qty_size":"1","quantity":"1","rate":"18000"},
      {"item_code":"BD-4","description":"Dresser","qty_size":"1","quantity":"1","rate":"21000"},
      {"item_code":"BD-5","description":"Pillows","qty_size":"4","quantity":"4","rate":"900"},
      {"item_code":"BD-6","description":"Bed runner","qty_size":"1","quantity":"1","rate":"2500"}]')).id;
  reset role;
  perform public.zz_as(u_rh); set local role authenticated; perform public.proc_dept_decision(v_rid, 'APPROVE', null); reset role;
  perform public.zz_as(u_p2); set local role authenticated;
  perform public.proc_accept_order_task(v_rid);
  v_res := public.proc_record_order_print(v_rid, 'PRINT');
  reset role;
  v_log := public.zz_chk(v_log, 'a Retail order prints on the Retail template with all six lines and the total',
    v_res->>'template' = 'RETAIL' and (select count(*) from purchase_request_items where purchase_request_id = v_rid) = 6
    and (select order_total from purchase_requests where id = v_rid) = 100100.00);
  -- Rs 1,00,100 is above Procurement's own limit: Management approves first, as for any order.
  insert into purchase_approvals (purchase_request_id, approval_level, decision, approved_amount, requested_amount) values (v_rid, 'MANAGEMENT', 'APPROVED', 100100, 100100);
  perform public.zz_as(u_p2); set local role authenticated;
  begin perform public.proc_confirm_order(v_rid, 'Sleepwell Dealer', '9876500444', null, 'ZZPO-PF-2', v_day, null, null, v_day - 1, null, null);
        v_log := public.zz_chk(v_log, 'expected delivery before the order date is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'expected delivery before the order date is refused', sqlerrm ilike '%before the order date%'); end;
  begin v_po := public.proc_confirm_order(v_rid, 'Sleepwell Dealer', '9876500444', null, 'ZZPO-PF-2', v_day, null, null, v_day + 7, null, null);
  exception when others then v_log := public.zz_chk(v_log, 'retail confirm: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'the Retail order total is the order amount when none is typed', v_po.total_order_value = 100100.00 and v_po.ordered_quantity = 6);

  raise exception E'\n%', v_log;
end $t$;
