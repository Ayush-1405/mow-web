-- Central Procurement (procurement_v3_01): department request -> Department Head -> Procurement -> print -> order, plus the
-- permission walls around it. Creates its own users, Interior profiles and project, impersonates each through SET LOCAL ROLE
-- authenticated + request.jwt.claims, and ALWAYS rolls back (the report is in the error message). Run it on the dev database.

do $t$
declare
  v_log text := ''; n int; v_err text; v_id uuid; v_id2 uuid; v_rid uuid; v_rid2 uuid; v_pr public.purchase_requests; v_po public.purchase_orders;
  d_int uuid; d_proc uuid; d_ret uuid; r_emp uuid; r_head uuid; r_sup uuid; r_mgmt uuid;
  u_e1 uuid := gen_random_uuid(); u_e2 uuid := gen_random_uuid(); u_h1 uuid := gen_random_uuid(); u_pm uuid := gen_random_uuid();
  u_pemp uuid := gen_random_uuid(); u_phead uuid := gen_random_uuid(); u_mgmt uuid := gen_random_uuid();
  u_r1 uuid := gen_random_uuid(); u_rh uuid := gen_random_uuid();
  ip_e1 uuid := gen_random_uuid(); ip_pm uuid := gen_random_uuid(); v_project uuid := gen_random_uuid(); v_contact jsonb; v_tomorrow date;
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true); end $f$;
  v_tomorrow := (now() at time zone 'Asia/Kolkata')::date + 7;

  ---------------------------------------------------------------- fixtures
  select id into d_int from departments where code = 'INTERIOR';
  select id into d_proc from departments where code = 'PROCUREMENT';
  select id into d_ret from departments where code = 'RETAIL';
  select id into r_emp from roles where code = 'employee';
  select id into r_head from roles where code = 'dept_head';
  select id into r_sup from roles where code = 'supervisor';
  select id into r_mgmt from roles where code = 'management';
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated'
    from unnest(array[u_e1, u_e2, u_h1, u_pm, u_pemp, u_phead, u_mgmt, u_r1, u_rh]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_e1, 'ZZE1', 'Test Interior Employee', r_emp, d_int, null, false, true),
    (u_e2, 'ZZE2', 'Test Other Interior Employee', r_emp, d_int, null, false, true),
    (u_h1, 'ZZH1', 'Test Interior Head', r_head, d_int, null, false, true),
    (u_pm, 'ZZPM', 'Test Project Manager', r_emp, d_int, null, false, true),
    (u_pemp, 'ZZP0', 'Test Procurement Employee', r_emp, d_proc, '+91 98000 00002', false, true),
    (u_phead, 'ZZPH', 'Test Procurement Head', r_head, d_proc, '+91 98000 00001', false, true),
    (u_mgmt, 'ZZMG', 'Test Director', r_mgmt, null, null, false, true),
    (u_r1, 'ZZR1', 'Test Retail Employee', r_emp, d_ret, null, false, true),
    (u_rh, 'ZZRH', 'Test Retail Head', r_head, d_ret, null, false, true);
  -- The test's head is the primary Procurement Head (otherwise a real, longer-serving head on the database is the contact).
  update procurement_settings set primary_head_user_id = u_phead where id;
  -- A trigger may already have created each user's Interior profile; make sure both exist with the right role.
  insert into profiles (auth_id, name, role) values (u_e1, 'Test Interior Employee', 'execution')
    on conflict (auth_id) do update set role = excluded.role returning id into ip_e1;
  insert into profiles (auth_id, name, role) values (u_pm, 'Test Project Manager', 'pm')
    on conflict (auth_id) do update set role = excluded.role returning id into ip_pm;
  insert into projects (id, project_code, customer, location, project_manager_id, execution_id) values (v_project, 'ZZ-PRJ-1', 'Test Customer', 'Test Site', ip_pm, ip_e1);
  v_log := public.zz_chk(v_log, 'fixture: departments, roles, 9 users, Interior profiles and a project', d_int is not null and d_proc is not null and d_ret is not null and r_mgmt is not null);

  ---------------------------------------------------------------- 1. Interior employee raises a request
  perform public.zz_as(u_e1); set local role authenticated;
  begin
    v_pr := public.proc_create_request(v_project, 'Plywood 18mm BWP', 'Board', 'Century, 8x4', 25, 'sheet', v_tomorrow, 'HIGH', 'For kitchen', 'Test Site', 'MATERIAL');
    v_id := v_pr.id;
    v_log := public.zz_chk(v_log, 'T1  Interior employee creates a request -> Pending Department Approval, PR number generated',
      v_pr.proc_status = 'PENDING_DEPT_APPROVAL' and v_pr.request_number like 'PR-______-____' and v_pr.requesting_department_id = d_int);
  exception when others then v_log := public.zz_chk(v_log, 'T1  create request: ' || sqlerrm, false); end;
  begin perform public.proc_create_request(v_project, 'Plywood 18mm BWP', 'Board', null, 25, 'sheet', v_tomorrow, 'HIGH', null, 'Test Site', 'MATERIAL');
        v_log := public.zz_chk(v_log, 'T15 the same open request twice is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'T15 the same open request twice is refused (' || sqlerrm || ')', sqlerrm ilike '%already open%'); end;
  begin perform public.proc_create_request(v_project, '', 'Board', null, 0, 'sheet', v_tomorrow, 'HIGH', null, 'Test Site', 'MATERIAL');
        v_log := public.zz_chk(v_log, 'request validation: empty material is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'request validation: empty material is refused', sqlerrm ilike '%required%'); end;
  begin perform public.proc_dept_decision(v_id, 'APPROVE', null); v_log := public.zz_chk(v_log, 'T2  the requester cannot approve their own request', false);
  exception when others then v_log := public.zz_chk(v_log, 'T2  the requester cannot approve their own request', true); end;
  reset role;
  v_log := public.zz_chk(v_log, 'T1  the Interior Head was notified', (select count(*) from notifications where recipient_id = u_h1 and entity_type = 'PURCHASE_REQUEST' and entity_id = v_id) = 1);
  v_log := public.zz_chk(v_log, 'T1  history and audit written', (select count(*) from purchase_request_status_history where purchase_request_id = v_id) = 1
      and (select count(*) from staff_audit_log where entity_id = v_id and action = 'CREATE' and performed_by = u_e1) = 1);

  ---------------------------------------------------------------- 2. nobody but the Head, and not Procurement yet
  perform public.zz_as(u_e2); set local role authenticated;
  begin perform public.proc_dept_decision(v_id, 'APPROVE', null); v_log := public.zz_chk(v_log, 'T2  another Interior employee cannot approve', false);
  exception when others then v_log := public.zz_chk(v_log, 'T2  another Interior employee cannot approve', sqlerrm ilike '%Head%'); end;
  select count(*) into n from purchase_requests where id = v_id;
  v_log := public.zz_chk(v_log, 'visibility: an Interior employee outside the project cannot see the request', n = 0);
  reset role;
  perform public.zz_as(u_phead); set local role authenticated;
  begin perform public.proc_procurement_decision(v_id, 'ACCEPT', null); v_log := public.zz_chk(v_log, 'T2  Procurement cannot act before the Department Head approves', false);
  exception when others then v_log := public.zz_chk(v_log, 'T2  Procurement cannot act before the Department Head approves', sqlerrm ilike '%not waiting for Procurement%'); end;
  reset role;
  perform public.zz_as(u_r1); set local role authenticated;
  select count(*) into n from purchase_requests where id = v_id;
  v_log := public.zz_chk(v_log, 'visibility: a Retail employee cannot see an Interior request', n = 0);
  reset role;

  ---------------------------------------------------------------- 3. Interior Head approves -> straight to Procurement
  perform public.zz_as(u_h1); set local role authenticated;
  begin perform public.proc_dept_decision(v_id, 'REJECT', '  '); v_log := public.zz_chk(v_log, 'rejecting needs a reason', false);
  exception when others then v_log := public.zz_chk(v_log, 'rejecting needs a reason', sqlerrm ilike '%reason%'); end;
  begin perform public.proc_dept_decision(v_id, 'APPROVE', 'OK for kitchen');
        select * into v_pr from purchase_requests where id = v_id;
        v_log := public.zz_chk(v_log, 'T3  Interior Head approves -> Sent to Procurement, approver and time recorded',
          v_pr.proc_status = 'SENT_TO_PROCUREMENT' and v_pr.dept_decided_by = u_h1 and v_pr.dept_decided_at is not null and v_pr.sent_to_procurement_at is not null);
  exception when others then v_log := public.zz_chk(v_log, 'T3  approve: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'T3  history shows Approved by Department Head then Sent to Procurement',
    (select string_agg(to_status, '>' order by created_at) from purchase_request_status_history where purchase_request_id = v_id) like 'PENDING_DEPT_APPROVAL>APPROVED_BY_DEPT_HEAD>SENT_TO_PROCUREMENT');
  v_log := public.zz_chk(v_log, 'T3  the Procurement team was notified', (select count(*) from notifications where entity_id = v_id and recipient_id in (u_phead, u_pemp)) = 2);

  ---------------------------------------------------------------- 4/5. Procurement acceptance
  perform public.zz_as(u_pemp); set local role authenticated;
  select count(*) into n from purchase_requests where id = v_id;
  v_log := public.zz_chk(v_log, 'a Procurement employee can see the request', n = 1);
  begin perform public.proc_procurement_decision(v_id, 'ACCEPT', null); v_log := public.zz_chk(v_log, 'T4  a Procurement employee (not Head/Supervisor) cannot accept', false);
  exception when others then v_log := public.zz_chk(v_log, 'T4  a Procurement employee (not Head/Supervisor) cannot accept', sqlerrm ilike '%authorised Procurement%'); end;
  reset role;
  perform public.zz_as(u_phead); set local role authenticated;
  begin perform public.proc_confirm_order(v_id, 'Shree Timber', '9876543210', 'Q-1', 'ZZPO-1', current_date, 25, 20000, v_tomorrow, '30 days', 'ok');
        v_log := public.zz_chk(v_log, 'T6  order cannot be confirmed before acceptance and print', false);
  exception when others then v_log := public.zz_chk(v_log, 'T6  order cannot be confirmed before acceptance and print', sqlerrm ilike '%Print the purchase document%'); end;
  begin perform public.proc_record_print(v_id, 'PURCHASE_REQUEST'); v_log := public.zz_chk(v_log, 'printing before acceptance is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'printing before acceptance is refused', sqlerrm ilike '%after Procurement accepts%'); end;
  begin perform public.proc_procurement_decision(v_id, 'ACCEPT', 'Will source');
        select * into v_pr from purchase_requests where id = v_id;
        v_log := public.zz_chk(v_log, 'T5  Procurement Head accepts -> Accepted by Procurement, user and time recorded',
          v_pr.proc_status = 'ACCEPTED_BY_PROCUREMENT' and v_pr.proc_decided_by = u_phead and v_pr.proc_decided_at is not null);
  exception when others then v_log := public.zz_chk(v_log, 'T5  accept: ' || sqlerrm, false); end;
  begin perform public.proc_confirm_order(v_id, 'Shree Timber', '9876543210', 'Q-1', 'ZZPO-1', current_date, 25, 20000, v_tomorrow, '30 days', 'ok');
        v_log := public.zz_chk(v_log, 'T6  accepted but not printed: order confirmation is still blocked', false);
  exception when others then v_log := public.zz_chk(v_log, 'T6  accepted but not printed: order confirmation is still blocked', sqlerrm ilike '%Print the purchase document%'); end;
  reset role;

  perform public.zz_as(u_e1); set local role authenticated;
  begin perform public.proc_record_print(v_id, 'PURCHASE_REQUEST'); v_log := public.zz_chk(v_log, 'the requester cannot record a Procurement print', false);
  exception when others then v_log := public.zz_chk(v_log, 'the requester cannot record a Procurement print', true); end;
  reset role;

  ---------------------------------------------------------------- 7. print recorded -> order unlocked
  perform public.zz_as(u_phead); set local role authenticated;
  begin perform public.proc_record_print(v_id, 'PURCHASE_REQUEST'); perform public.proc_record_print(v_id, 'PURCHASE_REQUEST');
        select * into v_pr from purchase_requests where id = v_id;
        v_log := public.zz_chk(v_log, 'T7  print recorded -> Document Generated, version 1, first PRINT_INITIATED then REPRINT',
          v_pr.proc_status = 'DOCUMENT_GENERATED' and v_pr.document_version = 1
          and (select string_agg(action, '>' order by printed_at, action) from purchase_print_logs where purchase_request_id = v_id) in ('PRINT_INITIATED>REPRINT', 'PRINT_INITIATED>PRINT_INITIATED') is not false
          and (select count(*) from purchase_print_logs where purchase_request_id = v_id and printed_by = u_phead and document_type = 'PURCHASE_REQUEST') = 2
          and (select count(*) from purchase_print_logs where purchase_request_id = v_id and action = 'PRINT_INITIATED') = 1);
  exception when others then v_log := public.zz_chk(v_log, 'T7  print: ' || sqlerrm, false); end;

  ---------------------------------------------------------------- 8. validation
  begin perform public.proc_confirm_order(v_id, 'Shree Timber', '', 'Q-1', 'ZZPO-1', current_date, 25, 20000, v_tomorrow, '30 days', 'ok');
        v_log := public.zz_chk(v_log, 'T8  missing vendor contact is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'T8  missing vendor contact is refused', sqlerrm ilike '%phone%'); end;
  begin perform public.proc_confirm_order(v_id, 'Shree Timber', '9876543210', '', 'ZZPO-1', current_date, 25, 20000, v_tomorrow, '30 days', 'ok');
        v_log := public.zz_chk(v_log, 'T8  missing quotation reference is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'T8  missing quotation reference is refused', sqlerrm ilike '%quotation%'); end;
  begin perform public.proc_confirm_order(v_id, 'Shree Timber', '9876543210', 'Q-1', 'ZZPO-1', current_date, 25, 20000, current_date - 1, '30 days', 'ok');
        v_log := public.zz_chk(v_log, 'T8  delivery before the order date is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'T8  delivery before the order date is refused', sqlerrm ilike '%before the order date%'); end;
  begin perform public.proc_confirm_order(v_id, 'Shree Timber', '9876543210', 'Q-1', 'ZZPO-1', current_date, 25, 30000, v_tomorrow, '30 days', 'ok');
        v_log := public.zz_chk(v_log, 'approval limit: Rs 30,000 (above Rs 25,000) needs Management approval first', false);
  exception when others then v_log := public.zz_chk(v_log, 'approval limit: Rs 30,000 (above Rs 25,000) needs Management approval first', sqlerrm ilike '%Management approval%'); end;
  begin perform public.proc_request_amount_approval(v_id, 30000, 'Best quote');
        v_log := public.zz_chk(v_log, 'Procurement asks Management to approve Rs 30,000', true);
  exception when others then v_log := public.zz_chk(v_log, 'ask for approval: ' || sqlerrm, false); end;
  begin perform public.proc_decide_amount_approval(v_id, 'APPROVED', null); v_log := public.zz_chk(v_log, 'Procurement cannot approve its own amount', false);
  exception when others then v_log := public.zz_chk(v_log, 'Procurement cannot approve its own amount', sqlerrm ilike '%Only Management%'); end;
  reset role;
  perform public.zz_as(u_mgmt); set local role authenticated;
  begin perform public.proc_decide_amount_approval(v_id, 'APPROVED', 'ok');
        v_log := public.zz_chk(v_log, 'Management approves the amount', (select count(*) from purchase_approvals where purchase_request_id = v_id and decision = 'APPROVED' and approved_amount = 30000 and decided_by_user = u_mgmt) = 1);
  exception when others then v_log := public.zz_chk(v_log, 'management approval: ' || sqlerrm, false); end;
  reset role;

  ---------------------------------------------------------------- 9. valid confirmation, exactly once
  perform public.zz_as(u_phead); set local role authenticated;
  begin v_po := public.proc_confirm_order(v_id, 'Shree Timber', '+91 98765 43210', 'Q-17', 'ZZPO-1', current_date, 25, 30000, v_tomorrow, '30 days credit', 'Best landed rate');
        select * into v_pr from purchase_requests where id = v_id;
        v_log := public.zz_chk(v_log, 'T9  valid confirmation -> Order Placed, PO saved with vendor, amount, confirmer',
          v_pr.proc_status = 'ORDER_PLACED' and v_po.po_number = 'ZZPO-1' and v_po.total_order_value = 30000 and v_po.confirmed_by = u_phead and v_po.vendor_id is not null);
  exception when others then v_log := public.zz_chk(v_log, 'T9  confirm: ' || sqlerrm, false); end;
  begin perform public.proc_confirm_order(v_id, 'Shree Timber', '9876543210', 'Q-17', 'ZZPO-2', current_date, 25, 20000, v_tomorrow, '30 days', 'again');
        v_log := public.zz_chk(v_log, 'T9  a second confirmation of the same request is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'T9  a second confirmation of the same request is refused', sqlerrm ilike '%already been confirmed%'); end;
  begin perform public.proc_record_print(v_id, 'PURCHASE_ORDER');
        v_log := public.zz_chk(v_log, 'the purchase order document print is recorded and linked to the PO', (select count(*) from purchase_print_logs where purchase_order_id = v_po.id) = 1);
  exception when others then v_log := public.zz_chk(v_log, 'PO print: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'T9  exactly one purchase order exists for the request', (select count(*) from purchase_orders where purchase_request_id = v_id) = 1);
  v_log := public.zz_chk(v_log, 'vendor was added to the vendor list once', (select count(*) from vendors where name = 'Shree Timber') = 1);

  ---------------------------------------------------------------- 10/11. notifications and contact
  v_log := public.zz_chk(v_log, 'T10 order notification reached Interior Head, project manager, requester and Procurement employee',
    (select count(distinct recipient_id) from notifications where entity_id = v_id and title_en like 'Order placed%' and recipient_id in (u_h1, u_pm, u_e1, u_pemp)) = 4);
  v_log := public.zz_chk(v_log, 'T10 the message carries PO, vendor, project, Procurement Head name and phone',
    (select bool_and(title_en like '%ZZPO-1%' and title_en like '%Shree Timber%' and title_en like '%ZZ-PRJ-1%' and title_en like '%Test Procurement Head%' and title_en like '%98000 00001%')
       from notifications where entity_id = v_id and title_en like 'Order placed%'));
  perform public.zz_as(u_e1); set local role authenticated;
  v_contact := public.proc_procurement_contact();
  v_log := public.zz_chk(v_log, 'T11 the requester sees the active Procurement Head''s name and phone', v_contact->>'name' = 'Test Procurement Head' and v_contact->>'phone' = '+91 98000 00001' and not (v_contact->>'phone_missing')::boolean);
  reset role;
  update user_profiles set phone = null where id = u_phead;
  perform public.zz_as(u_e1); set local role authenticated;
  v_contact := public.proc_procurement_contact();
  v_log := public.zz_chk(v_log, 'T11 with no phone on the profile: no number shown, phone_missing flagged', v_contact->>'phone' is null and (v_contact->>'phone_missing')::boolean);
  reset role;
  update user_profiles set phone = '+91 98000 00001' where id = u_phead;

  ---------------------------------------------------------------- 12. bypass attempts
  perform public.zz_as(u_e1); set local role authenticated;
  begin insert into purchase_orders (purchase_request_id, po_number, status) values (v_id, 'ZZ-BYPASS', 'ORDER_PLACED');
        v_log := public.zz_chk(v_log, 'T12 an employee cannot insert a purchase order directly', false);
  exception when others then v_log := public.zz_chk(v_log, 'T12 an employee cannot insert a purchase order directly', sqlerrm ilike '%permission denied%'); end;
  update purchase_requests set proc_status = 'CLOSED' where id = v_id;
  get diagnostics n = row_count;
  v_log := public.zz_chk(v_log, 'T12 an employee cannot change a Procurement status directly', n = 0);
  begin insert into purchase_requests (project_id, request_number, purchase_source, status, proc_status, requester_user_id) values (v_project, 'ZZ-FAKE-1', 'in_house', 'Draft', 'SENT_TO_PROCUREMENT', u_e1);
        v_log := public.zz_chk(v_log, 'T12 a direct insert cannot fake a Procurement request (forced to LEGACY)', (select proc_status from purchase_requests where request_number = 'ZZ-FAKE-1') = 'LEGACY'
          and (select requester_user_id from purchase_requests where request_number = 'ZZ-FAKE-1') is null);
  exception when others then v_log := public.zz_chk(v_log, 'T12 fake request: ' || sqlerrm, false); end;
  begin update purchase_requests set proc_status = 'SENT_TO_PROCUREMENT' where request_number = 'ZZ-FAKE-1';
        v_log := public.zz_chk(v_log, 'T12 a LEGACY row cannot be promoted into Procurement', false);
  exception when others then v_log := public.zz_chk(v_log, 'T12 a LEGACY row cannot be promoted into Procurement', sqlerrm ilike '%Procurement workflow%'); end;
  begin update purchase_requests set notes = 'in-house note' where request_number = 'ZZ-FAKE-1';
        v_log := public.zz_chk(v_log, 'Interior''s own (LEGACY / in-house) records stay editable by project members', (select notes from purchase_requests where request_number = 'ZZ-FAKE-1') = 'in-house note');
  exception when others then v_log := public.zz_chk(v_log, 'legacy edit: ' || sqlerrm, false); end;
  begin insert into vendors (name) values ('ZZ Vendor'); v_log := public.zz_chk(v_log, 'an employee cannot add vendors', false);
  exception when others then v_log := public.zz_chk(v_log, 'an employee cannot add vendors', true); end;
  reset role;
  perform public.zz_as(u_phead); set local role authenticated;
  begin insert into purchase_orders (purchase_request_id, po_number, status) values (v_id, 'ZZ-BYPASS-2', 'ORDER_PLACED');
        v_log := public.zz_chk(v_log, 'T12 even the Procurement Head cannot write purchase orders outside the workflow', false);
  exception when others then v_log := public.zz_chk(v_log, 'T12 even the Procurement Head cannot write purchase orders outside the workflow', sqlerrm ilike '%permission denied%'); end;
  reset role;

  ---------------------------------------------------------------- 16. another department: Retail, with return and clarification
  perform public.zz_as(u_r1); set local role authenticated;
  begin v_pr := public.proc_create_request(null, 'Display stands', 'Fixtures', 'Black metal', 4, 'piece', v_tomorrow, 'NORMAL', null, 'Showroom 1', 'FINISHED_GOODS');
        v_rid := v_pr.id;
        v_log := public.zz_chk(v_log, 'T16 a Retail employee raises a request with no project', v_pr.proc_status = 'PENDING_DEPT_APPROVAL' and v_pr.requesting_department_id = d_ret);
  exception when others then v_log := public.zz_chk(v_log, 'T16 retail create: ' || sqlerrm, false); end;
  reset role;
  perform public.zz_as(u_h1); set local role authenticated;
  begin perform public.proc_dept_decision(v_rid, 'APPROVE', null); v_log := public.zz_chk(v_log, 'T16 the Interior Head cannot approve a Retail request', false);
  exception when others then v_log := public.zz_chk(v_log, 'T16 the Interior Head cannot approve a Retail request', sqlerrm ilike '%Head%'); end;
  reset role;
  perform public.zz_as(u_rh); set local role authenticated;
  begin perform public.proc_dept_decision(v_rid, 'RETURN', 'Add size');
        v_log := public.zz_chk(v_log, 'T16 Retail Head returns it for correction', (select proc_status from purchase_requests where id = v_rid) = 'RETURNED_FOR_CORRECTION');
  exception when others then v_log := public.zz_chk(v_log, 'T16 return: ' || sqlerrm, false); end;
  reset role;
  perform public.zz_as(u_r1); set local role authenticated;
  begin perform public.proc_update_request(v_rid, 'Display stands', 'Fixtures', 'Black metal, 6 ft', 4, 'piece', v_tomorrow, 'NORMAL', null, 'Showroom 1', 'FINISHED_GOODS');
        perform public.proc_submit_request(v_rid);
        v_log := public.zz_chk(v_log, 'T16 the requester corrects and resubmits', (select proc_status from purchase_requests where id = v_rid) = 'PENDING_DEPT_APPROVAL');
  exception when others then v_log := public.zz_chk(v_log, 'T16 correct/resubmit: ' || sqlerrm, false); end;
  reset role;
  perform public.zz_as(u_rh); set local role authenticated;
  begin perform public.proc_dept_decision(v_rid, 'APPROVE', null);
        v_log := public.zz_chk(v_log, 'T16 Retail Head approves -> Sent to Procurement', (select proc_status from purchase_requests where id = v_rid) = 'SENT_TO_PROCUREMENT');
  exception when others then v_log := public.zz_chk(v_log, 'T16 retail approve: ' || sqlerrm, false); end;
  reset role;
  perform public.zz_as(u_phead); set local role authenticated;
  begin perform public.proc_procurement_decision(v_rid, 'CLARIFY', 'Which finish?');
        v_log := public.zz_chk(v_log, 'Procurement asks for clarification', (select proc_status from purchase_requests where id = v_rid) = 'CLARIFICATION_REQUIRED');
  exception when others then v_log := public.zz_chk(v_log, 'clarify: ' || sqlerrm, false); end;
  reset role;
  perform public.zz_as(u_r1); set local role authenticated;
  begin perform public.proc_answer_clarification(v_rid, 'Powder-coated black');
        v_log := public.zz_chk(v_log, 'the requester answers -> back with Procurement', (select proc_status from purchase_requests where id = v_rid) = 'SENT_TO_PROCUREMENT');
  exception when others then v_log := public.zz_chk(v_log, 'answer: ' || sqlerrm, false); end;
  select count(*) into n from purchase_requests where id = v_rid;
  v_log := public.zz_chk(v_log, 'the requester can track their own request', n = 1);
  reset role;
  perform public.zz_as(u_phead); set local role authenticated;
  begin perform public.proc_procurement_decision(v_rid, 'HOLD', 'Budget'); perform public.proc_procurement_decision(v_rid, 'RESUME', null);
        perform public.proc_procurement_decision(v_rid, 'REJECT', 'Use existing stock');
        v_log := public.zz_chk(v_log, 'hold, resume and reject (with reason) work', (select proc_status from purchase_requests where id = v_rid) = 'REJECTED_BY_PROCUREMENT');
  exception when others then v_log := public.zz_chk(v_log, 'hold/resume/reject: ' || sqlerrm, false); end;
  reset role;

  ---------------------------------------------------------------- duplicates, drafts, cancel, PO numbers, realtime
  perform public.zz_as(u_r1); set local role authenticated;
  begin v_pr := public.proc_create_request(null, 'Display stands', 'Fixtures', null, 4, 'piece', v_tomorrow, 'NORMAL', null, 'Showroom 1', 'FINISHED_GOODS', false, null, false);
        v_rid2 := v_pr.id;
        v_log := public.zz_chk(v_log, 'T15 a rejected request no longer blocks a new identical one; saved as Draft', v_pr.proc_status = 'DRAFT');
        perform public.proc_cancel_request(v_rid2, 'Not needed');
        v_log := public.zz_chk(v_log, 'the requester can cancel their draft (with reason)', (select proc_status from purchase_requests where id = v_rid2) = 'CANCELLED');
  exception when others then v_log := public.zz_chk(v_log, 'draft/cancel: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'T15 PO numbers are unique (case-insensitive) in the database', exists (select 1 from pg_indexes where indexname = 'purchase_orders_po_number_idx'));
  v_log := public.zz_chk(v_log, 'T17 requests, orders and history are published for live updates',
    (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('purchase_requests', 'purchase_orders', 'purchase_request_status_history')) = 3);

  raise exception E'\n%', v_log;
end $t$;
