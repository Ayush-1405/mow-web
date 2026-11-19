-- Central Procurement part 2 (procurement_v3_02): vendors, quotations and comparison, follow-ups, progress and dispatch,
-- partial and full goods receipt with rejections, GRN verification, invoice, payments, closing, emergency purchases, work
-- orders and Factory low-stock requests. Own fixtures, impersonation per step, ALWAYS rolls back. Run it on the dev database.

do $t$
declare
  v_log text := ''; n int; v_id uuid; v_eid uuid; v_wid uuid; v_v1 uuid; v_v2 uuid; v_q1 uuid; v_q2 uuid; v_pr public.purchase_requests;
  v_vendor public.vendors; v_q public.vendor_quotations; v_po public.purchase_orders; v_rec public.purchase_receipts;
  d_fac uuid; d_proc uuid; d_god uuid; d_acc uuid; r_emp uuid; r_head uuid; r_sup uuid; r_mgmt uuid; r_acc uuid; v_day date;
  u_f1 uuid := gen_random_uuid(); u_fh uuid := gen_random_uuid(); u_ph uuid := gen_random_uuid(); u_pe uuid := gen_random_uuid();
  u_g1 uuid := gen_random_uuid(); u_gh uuid := gen_random_uuid(); u_a1 uuid := gen_random_uuid(); u_m uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true); end $f$;
  v_day := (now() at time zone 'Asia/Kolkata')::date;

  select id into d_fac from departments where code = 'FACTORY';
  select id into d_proc from departments where code = 'PROCUREMENT';
  select id into d_god from departments where code = 'GODOWN_INV';
  select id into d_acc from departments where code = 'ACCOUNTS';
  select id into r_emp from roles where code = 'employee';
  select id into r_head from roles where code = 'dept_head';
  select id into r_sup from roles where code = 'supervisor';
  select id into r_mgmt from roles where code = 'management';
  select id into r_acc from roles where code = 'accounts_employee';
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated'
    from unnest(array[u_f1, u_fh, u_ph, u_pe, u_g1, u_gh, u_a1, u_m]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_f1, 'ZZF1', 'Test Factory Employee', r_emp, d_fac, null, false, true),
    (u_fh, 'ZZFH', 'Test Factory Head', r_head, d_fac, null, false, true),
    (u_ph, 'ZZPH', 'Test Procurement Head', r_head, d_proc, '+91 98000 00001', false, true),
    (u_pe, 'ZZPE', 'Test Procurement Employee', r_emp, d_proc, null, false, true),
    (u_g1, 'ZZG1', 'Test Godown Employee', r_emp, d_god, null, false, true),
    (u_gh, 'ZZGH', 'Test Godown Head', r_head, d_god, null, false, true),
    (u_a1, 'ZZA1', 'Test Accounts Employee', r_acc, d_acc, null, false, true),
    (u_m, 'ZZM1', 'Test Director', r_mgmt, null, null, false, true);
  v_log := public.zz_chk(v_log, 'fixture: Factory, Procurement, Godown, Accounts and Management users', d_fac is not null and d_god is not null and d_acc is not null and r_acc is not null);

  -- a Factory request taken to "accepted by Procurement"
  perform public.zz_as(u_f1); set local role authenticated;
  v_pr := public.proc_create_request(null, 'MDF 12mm', 'Board', 'Pre-laminated white', 10, 'sheet', v_day + 10, 'NORMAL', null, 'Factory store', 'RAW_MATERIAL');
  v_id := v_pr.id; reset role;
  perform public.zz_as(u_fh); set local role authenticated; perform public.proc_dept_decision(v_id, 'APPROVE', null); reset role;
  perform public.zz_as(u_ph); set local role authenticated; perform public.proc_procurement_decision(v_id, 'ACCEPT', null); reset role;
  v_log := public.zz_chk(v_log, 'Factory request approved by Factory Head and accepted by Procurement', (select proc_status from purchase_requests where id = v_id) = 'ACCEPTED_BY_PROCUREMENT');

  ---------------------------------------------------------------- vendors
  perform public.zz_as(u_f1); set local role authenticated;
  begin perform public.proc_save_vendor(null, 'ZZ Boards', null, '9876500001', null, null, null, null, null, null, null, null, null);
        v_log := public.zz_chk(v_log, 'a Factory employee cannot add vendors', false);
  exception when others then v_log := public.zz_chk(v_log, 'a Factory employee cannot add vendors', sqlerrm ilike '%Only Procurement%'); end;
  reset role;
  perform public.zz_as(u_pe); set local role authenticated;
  begin perform public.proc_save_vendor(null, 'ZZ Boards', null, '9876500001', null, null, 'BADGST', null, null, null, null, null, null);
        v_log := public.zz_chk(v_log, 'vendor validation: a malformed GSTIN is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'vendor validation: a malformed GSTIN is refused', sqlerrm ilike '%GSTIN%'); end;
  begin v_vendor := public.proc_save_vendor(null, 'ZZ Boards', 'Ramesh', '+91 98765 00001', 'sales@zzboards.test', 'Rajkot', '24ABCDE1234F1Z5', 'ABCDE1234F', 'Boards', '30 days', '30', '5 days', null);
        v_v1 := v_vendor.id;
        v_log := public.zz_chk(v_log, 'Procurement staff add a vendor; it starts as Pending Review with a vendor code', v_vendor.approved_status = 'Pending Review' and v_vendor.vendor_code like 'V-%');
        v_vendor := public.proc_save_vendor(null, 'ZZ Laminates', 'Suresh', '9876500002', null, 'Morbi', null, null, 'Boards', '15 days', null, null, null);
        v_v2 := v_vendor.id;
  exception when others then v_log := public.zz_chk(v_log, 'add vendor: ' || sqlerrm, false); end;
  begin perform public.proc_save_vendor(null, 'zz boards ', null, '98765-00001', null, null, null, null, null, null, null, null, null);
        v_log := public.zz_chk(v_log, 'a duplicate vendor (same name and mobile) is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'a duplicate vendor (same name and mobile) is refused', sqlerrm ilike '%already exists%'); end;
  begin perform public.proc_set_vendor_status(v_v1, 'Approved', null); v_log := public.zz_chk(v_log, 'a Procurement employee cannot approve vendors', false);
  exception when others then v_log := public.zz_chk(v_log, 'a Procurement employee cannot approve vendors', sqlerrm ilike '%Procurement Head%'); end;
  reset role;
  perform public.zz_as(u_ph); set local role authenticated;
  perform public.proc_set_vendor_status(v_v1, 'Approved', null);
  begin perform public.proc_set_vendor_status(v_v2, 'Blocked', ' ');
        v_log := public.zz_chk(v_log, 'blocking needs a reason', false);
  exception when others then v_log := public.zz_chk(v_log, 'blocking needs a reason', sqlerrm ilike '%reason%'); end;
  v_log := public.zz_chk(v_log, 'the Procurement Head approves a vendor', (select approved_status from vendors where id = v_v1) = 'Approved');

  ---------------------------------------------------------------- quotations and comparison
  begin v_q := public.proc_add_quotation(v_id, v_v1, 'ZQ-1', v_day, v_day + 15, 8000, 0, 0, 1440, 500, 0, 5, '30 days', '1 year', 4); v_q1 := v_q.id;
        v_q := public.proc_add_quotation(v_id, v_v2, 'ZQ-2', v_day, v_day + 15, 7500, 0, 0, 1350, 300, 0, 9, 'Advance', 'None', 3); v_q2 := v_q.id;
        v_log := public.zz_chk(v_log, 'two quotations recorded with their landed totals', (select total_landed_cost from vendor_quotations where id = v_q1) = 9940
          and (select total_landed_cost from vendor_quotations where id = v_q2) = 9150);
  exception when others then v_log := public.zz_chk(v_log, 'quotations: ' || sqlerrm, false); end;
  begin perform public.proc_add_quotation(v_id, v_v1, 'zq-1', v_day, null, 1, 0, 0, 0, 0, 0, null, null, null, null);
        v_log := public.zz_chk(v_log, 'the same quotation number from the same vendor is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'the same quotation number from the same vendor is refused', true); end;
  begin perform public.proc_select_quotation(v_id, v_q1, null); v_log := public.zz_chk(v_log, 'choosing a dearer quotation needs a justification', false);
  exception when others then v_log := public.zz_chk(v_log, 'choosing a dearer quotation needs a justification', sqlerrm ilike '%not the lowest%'); end;
  begin perform public.proc_select_quotation(v_id, v_q1, 'Better quality and credit terms');
        v_log := public.zz_chk(v_log, 'vendor selected with justification, recorded as not-lowest', (select count(*) from purchase_vendor_selections where purchase_request_id = v_id and is_lowest_bid = false and selected_by_user = u_ph) = 1);
  exception when others then v_log := public.zz_chk(v_log, 'select quotation: ' || sqlerrm, false); end;
  perform public.proc_set_vendor_status(v_v2, 'Blocked', 'Late deliveries');
  v_log := public.zz_chk(v_log, 'the Procurement Head blocks a vendor with a reason', (select blacklisted and blacklist_reason = 'Late deliveries' from vendors where id = v_v2));
  begin perform public.proc_add_quotation(v_id, v_v2, 'ZQ-3', v_day, null, 100, 0, 0, 0, 0, 0, null, null, null, null);
        v_log := public.zz_chk(v_log, 'a blocked vendor cannot quote', false);
  exception when others then v_log := public.zz_chk(v_log, 'a blocked vendor cannot quote', sqlerrm ilike '%active vendor%'); end;

  -- order
  perform public.proc_record_print(v_id, 'PURCHASE_REQUEST');
  begin perform public.proc_confirm_order(v_id, 'ZZ Laminates', '9876500002', 'ZQ-2', 'ZZPO-L1', v_day, 10, 9150, v_day + 7, 'Advance', 'test');
        v_log := public.zz_chk(v_log, 'a blocked vendor cannot receive an order', false);
  exception when others then v_log := public.zz_chk(v_log, 'a blocked vendor cannot receive an order', sqlerrm ilike '%blocked%'); end;
  v_po := public.proc_confirm_order(v_id, 'ZZ Boards', '9876500001', 'ZQ-1', 'ZZPO-L1', v_day, 10, 9000, v_day + 7, '30 days', 'Selected for quality');
  v_log := public.zz_chk(v_log, 'order placed with the existing vendor record (no duplicate vendor)', v_po.vendor_id = v_v1 and (select count(*) from vendors where name = 'ZZ Boards') = 1);
  reset role;

  ---------------------------------------------------------------- follow-up, progress, dispatch
  perform public.zz_as(u_pe); set local role authenticated;
  begin perform public.proc_add_followup(v_id, 'Called, will dispatch Monday', 'Phone', v_day - 1, false);
        v_log := public.zz_chk(v_log, 'a follow-up date in the past is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'a follow-up date in the past is refused', sqlerrm ilike '%past%'); end;
  begin perform public.proc_add_followup(v_id, 'Vendor not answering', 'Phone', v_day + 1, true);
        v_log := public.zz_chk(v_log, 'follow-up saved; an escalation notifies Management', (select count(*) from vendor_followups where purchase_request_id = v_id and escalation_status = 'Escalated' and vendor_id = v_v1) = 1);
  exception when others then v_log := public.zz_chk(v_log, 'follow-up: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'Management received the escalation', (select count(*) from notifications where recipient_id = u_m and entity_id = v_id and title_en like 'Vendor escalation%') = 1);
  perform public.zz_as(u_f1); set local role authenticated;
  begin perform public.proc_update_progress(v_id, 'VENDOR_CONFIRMED', null); v_log := public.zz_chk(v_log, 'the requester cannot change order progress', false);
  exception when others then v_log := public.zz_chk(v_log, 'the requester cannot change order progress', sqlerrm ilike '%Only Procurement%'); end;
  reset role;
  perform public.zz_as(u_pe); set local role authenticated;
  begin perform public.proc_update_progress(v_id, 'IN_TRANSIT', null); v_log := public.zz_chk(v_log, 'In Transit needs transporter/tracking and arrival date', false);
  exception when others then v_log := public.zz_chk(v_log, 'In Transit needs transporter/tracking and arrival date', sqlerrm ilike '%transporter%'); end;
  begin perform public.proc_update_progress(v_id, 'PAID', null); v_log := public.zz_chk(v_log, 'an invalid jump (Order Placed -> Paid) is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'an invalid jump (Order Placed -> Paid) is refused', sqlerrm ilike '%Cannot move%'); end;
  begin perform public.proc_update_progress(v_id, 'VENDOR_CONFIRMED', 'Confirmed on call');
        perform public.proc_update_progress(v_id, 'DELAYED', 'Truck strike');
        perform public.proc_update_progress(v_id, 'IN_TRANSIT', null, 'VRL Logistics', 'GJ03AB1234', 'LR-5521', v_day, v_day + 3);
        v_log := public.zz_chk(v_log, 'progress: Vendor Confirmed -> Delayed -> In Transit, with dispatch details saved',
          (select proc_status from purchase_requests where id = v_id) = 'IN_TRANSIT'
          and (select count(*) from purchase_dispatches where purchase_request_id = v_id and tracking_number = 'LR-5521' and purchase_order_id = v_po.id) = 1);
  exception when others then v_log := public.zz_chk(v_log, 'progress: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'the requester and Godown were told about the delay and the dispatch',
    (select count(*) from notifications where entity_id = v_id and recipient_id = u_f1 and (title_en like 'Delayed:%' or title_en like 'On the way:%')) = 2
    and (select count(*) from notifications where entity_id = v_id and recipient_id = u_g1 and title_en like 'On the way:%') = 1);

  ---------------------------------------------------------------- GRN: partial, rejection, full, verification
  perform public.zz_as(u_f1); set local role authenticated;
  begin perform public.proc_record_grn(v_id, 4, 4, 0, 0, 'Factory store', null, null, null, false); v_log := public.zz_chk(v_log, 'the requester cannot record goods receipt', false);
  exception when others then v_log := public.zz_chk(v_log, 'the requester cannot record goods receipt', sqlerrm ilike '%Godown%'); end;
  reset role;
  perform public.zz_as(u_g1); set local role authenticated;
  select count(*) into n from purchase_requests where id = v_id;
  v_log := public.zz_chk(v_log, 'Godown can see an ordered request', n = 1);
  begin perform public.proc_record_grn(v_id, 6, 4, 1, 0, 'Godown', null, 'x', null, false); v_log := public.zz_chk(v_log, 'accepted + rejected must equal received', false);
  exception when others then v_log := public.zz_chk(v_log, 'accepted + rejected must equal received', sqlerrm ilike '%must equal%'); end;
  begin perform public.proc_record_grn(v_id, 6, 4, 2, 1, 'Godown', 'Edges chipped', null, null, true); v_log := public.zz_chk(v_log, 'rejecting material needs a reason', false);
  exception when others then v_log := public.zz_chk(v_log, 'rejecting material needs a reason', sqlerrm ilike '%reason%'); end;
  begin v_rec := public.proc_record_grn(v_id, 6, 4, 2, 1, 'Godown', 'Edges chipped', 'Damaged in transit', 'Vendor to replace 2 sheets', true);
        v_log := public.zz_chk(v_log, 'partial delivery: GRN number, 4 accepted, 2 rejected, 6 still outstanding -> Partially Received',
          v_rec.grn_number like 'GRN-______-____' and v_rec.qty_short = 6 and v_rec.qty_rejected = 2 and v_rec.corrective_action is not null
          and (select proc_status from purchase_requests where id = v_id) = 'PARTIALLY_RECEIVED');
  exception when others then v_log := public.zz_chk(v_log, 'partial GRN: ' || sqlerrm, false); end;
  begin perform public.proc_record_grn(v_id, 7, 7, 0, 0, 'Godown', null, null, null, false); v_log := public.zz_chk(v_log, 'cannot accept more than the outstanding quantity', false);
  exception when others then v_log := public.zz_chk(v_log, 'cannot accept more than the outstanding quantity', sqlerrm ilike '%outstanding%'); end;
  begin perform public.proc_record_grn(v_id, 6, 6, 0, 0, 'Godown', 'OK', null, null, false);
        v_log := public.zz_chk(v_log, 'full delivery -> Received (10 of 10 accepted across two GRNs)',
          (select proc_status from purchase_requests where id = v_id) = 'RECEIVED' and (select sum(qty_accepted) from purchase_receipts where purchase_request_id = v_id) = 10);
  exception when others then v_log := public.zz_chk(v_log, 'full GRN: ' || sqlerrm, false); end;
  begin perform public.proc_verify_grn(v_id, null); v_log := public.zz_chk(v_log, 'a Godown employee cannot verify the GRN', false);
  exception when others then v_log := public.zz_chk(v_log, 'a Godown employee cannot verify the GRN', true); end;
  reset role;
  perform public.zz_as(u_gh); set local role authenticated;
  begin perform public.proc_verify_grn(v_id, 'Checked');
        v_log := public.zz_chk(v_log, 'the Godown Head verifies the GRN -> GRN Verified', (select proc_status from purchase_requests where id = v_id) = 'GRN_VERIFIED'
          and (select count(*) from purchase_receipts where purchase_request_id = v_id and verified_by = u_gh) = 2);
  exception when others then v_log := public.zz_chk(v_log, 'verify GRN: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'the requesting department was told the goods are verified',
    (select count(*) from notifications where entity_id = v_id and recipient_id in (u_f1, u_fh) and title_en like 'Goods received and verified%') = 2);

  ---------------------------------------------------------------- invoice and payments
  perform public.zz_as(u_a1); set local role authenticated;
  begin perform public.proc_record_invoice(v_id, 'INV-9', v_day, 9500, 0, v_day + 30); v_log := public.zz_chk(v_log, 'Accounts does not record vendor invoices (Procurement does)', false);
  exception when others then v_log := public.zz_chk(v_log, 'Accounts does not record vendor invoices (Procurement does)', sqlerrm ilike '%Only Procurement%'); end;
  reset role;
  perform public.zz_as(u_pe); set local role authenticated;
  begin perform public.proc_record_invoice(v_id, 'INV-9', v_day, 9500, 0, v_day + 30);
        v_log := public.zz_chk(v_log, 'Procurement records the invoice; Accounts is notified', (select count(*) from purchase_payment_coordination where purchase_request_id = v_id and pending_amount = 9500) = 1);
  exception when others then v_log := public.zz_chk(v_log, 'invoice: ' || sqlerrm, false); end;
  begin perform public.proc_verify_invoice(v_id, 'APPROVE', 'ok'); v_log := public.zz_chk(v_log, 'Procurement cannot verify its own invoice', false);
  exception when others then v_log := public.zz_chk(v_log, 'Procurement cannot verify its own invoice', sqlerrm ilike '%Only Accounts%'); end;
  reset role;
  v_log := public.zz_chk(v_log, 'Accounts was notified of the invoice', (select count(*) from notifications where recipient_id = u_a1 and entity_id = v_id and title_en like 'Invoice to verify%') = 1);
  perform public.zz_as(u_a1); set local role authenticated;
  select count(*) into n from purchase_requests where id = v_id;
  v_log := public.zz_chk(v_log, 'Accounts can see the request', n = 1);
  begin perform public.proc_verify_invoice(v_id, 'APPROVE', null); v_log := public.zz_chk(v_log, 'an invoice above the order value needs a written reason', false);
  exception when others then v_log := public.zz_chk(v_log, 'an invoice above the order value needs a written reason', sqlerrm ilike '%above the order value%'); end;
  begin perform public.proc_verify_invoice(v_id, 'APPROVE', 'Freight added, agreed by Procurement');
        v_log := public.zz_chk(v_log, 'Accounts verifies the invoice -> Payment Pending', (select proc_status from purchase_requests where id = v_id) = 'PAYMENT_PENDING');
  exception when others then v_log := public.zz_chk(v_log, 'verify invoice: ' || sqlerrm, false); end;
  begin perform public.proc_record_payment(v_id, 5000, v_day, 'NEFT', 'UTR001');
        v_log := public.zz_chk(v_log, 'part payment -> Partially Paid, Rs 4,500 outstanding', (select proc_status from purchase_requests where id = v_id) = 'PARTIALLY_PAID'
          and (select pending_amount from purchase_payment_coordination where purchase_request_id = v_id) = 4500);
  exception when others then v_log := public.zz_chk(v_log, 'part payment: ' || sqlerrm, false); end;
  begin perform public.proc_record_payment(v_id, 5000, v_day, 'NEFT', 'UTR002'); v_log := public.zz_chk(v_log, 'paying more than is due is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'paying more than is due is refused', sqlerrm ilike '%still due%'); end;
  begin perform public.proc_record_payment(v_id, 1000, v_day, 'NEFT', 'utr001 '); v_log := public.zz_chk(v_log, 'the same payment reference twice is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'the same payment reference twice is refused', true); end;
  begin perform public.proc_record_payment(v_id, 4500, v_day, 'NEFT', 'UTR003');
        v_log := public.zz_chk(v_log, 'final payment -> Paid', (select proc_status from purchase_requests where id = v_id) = 'PAID' and (select count(*) from purchase_payments where purchase_request_id = v_id) = 2);
  exception when others then v_log := public.zz_chk(v_log, 'final payment: ' || sqlerrm, false); end;
  reset role;
  perform public.zz_as(u_f1); set local role authenticated;
  select count(*) into n from purchase_payments where purchase_request_id = v_id;
  v_log := public.zz_chk(v_log, 'the requester cannot see payment records', n = 0);
  reset role;
  perform public.zz_as(u_ph); set local role authenticated;
  -- (v3_07) the Procurement task is marked done before the purchase can be closed.
  begin perform public.proc_finish_order_task(v_id, 'Paid and goods verified');
        perform public.proc_close_request(v_id, 'Done');
        v_log := public.zz_chk(v_log, 'Procurement closes the paid purchase -> Closed', (select proc_status from purchase_requests where id = v_id) = 'CLOSED');
  exception when others then v_log := public.zz_chk(v_log, 'close: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'the whole lifecycle is in the history, in order',
    (select string_agg(to_status, '>' order by created_at) from purchase_request_status_history where purchase_request_id = v_id) =
    'PENDING_DEPT_APPROVAL>APPROVED_BY_DEPT_HEAD>SENT_TO_PROCUREMENT>ACCEPTED_BY_PROCUREMENT>DOCUMENT_GENERATED>ORDER_PLACED>VENDOR_CONFIRMED>DELAYED>IN_TRANSIT>PARTIALLY_RECEIVED>RECEIVED>GRN_VERIFIED>INVOICE_VERIFIED>PAYMENT_PENDING>PARTIALLY_PAID>PAID>PAID>CLOSED');

  ---------------------------------------------------------------- emergency purchase
  perform public.zz_as(u_f1); set local role authenticated;
  begin v_pr := public.proc_create_request(null, 'Hydraulic hose', 'Spare part', 'Press machine', 1, 'piece', v_day + 1, 'URGENT', null, 'Factory', 'MACHINERY', true, 'Press stopped, production halted');
        v_eid := v_pr.id;
        v_log := public.zz_chk(v_log, 'an emergency request goes to Emergency Approval Pending', v_pr.proc_status = 'EMERGENCY_APPROVAL_PENDING');
  exception when others then v_log := public.zz_chk(v_log, 'emergency create: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'Management and the Factory Head were notified of the emergency',
    (select count(*) from notifications where entity_id = v_eid and recipient_id in (u_m, u_fh) and title_en like 'EMERGENCY%') = 2);
  perform public.zz_as(u_fh); set local role authenticated;
  begin perform public.proc_emergency_decision(v_eid, 'APPROVE', null); v_log := public.zz_chk(v_log, 'a Department Head cannot approve an emergency', false);
  exception when others then v_log := public.zz_chk(v_log, 'a Department Head cannot approve an emergency', sqlerrm ilike '%Only Management%'); end;
  begin perform public.proc_dept_decision(v_eid, 'APPROVE', null); v_log := public.zz_chk(v_log, 'the normal department approval does not apply to an emergency', false);
  exception when others then v_log := public.zz_chk(v_log, 'the normal department approval does not apply to an emergency', true); end;
  reset role;
  perform public.zz_as(u_m); set local role authenticated;
  begin perform public.proc_review_emergency(v_eid, 'Fine'); v_log := public.zz_chk(v_log, 'the post-purchase review waits until the order exists', false);
  exception when others then v_log := public.zz_chk(v_log, 'the post-purchase review waits until the order exists', sqlerrm ilike '%after the order%'); end;
  begin perform public.proc_emergency_decision(v_eid, 'APPROVE', 'Go ahead');
        v_log := public.zz_chk(v_log, 'Management approves the emergency -> straight to Procurement', (select proc_status from purchase_requests where id = v_eid) = 'SENT_TO_PROCUREMENT'
          and (select emergency_decided_by from purchase_requests where id = v_eid) = u_m);
  exception when others then v_log := public.zz_chk(v_log, 'emergency approve: ' || sqlerrm, false); end;
  reset role;

  ---------------------------------------------------------------- work order (labour)
  perform public.zz_as(u_f1); set local role authenticated;
  v_pr := public.proc_create_request(null, 'Polishing labour', 'Labour', '2 polishers for 5 days', 10, 'man-day', v_day + 5, 'NORMAL', null, 'Factory', 'LABOUR');
  v_wid := v_pr.id; reset role;
  perform public.zz_as(u_fh); set local role authenticated; perform public.proc_dept_decision(v_wid, 'APPROVE', null); reset role;
  perform public.zz_as(u_ph); set local role authenticated;
  perform public.proc_procurement_decision(v_wid, 'ACCEPT', null); perform public.proc_record_print(v_wid, 'PURCHASE_REQUEST');
  begin perform public.proc_confirm_order(v_wid, 'ZZ Labour Co', '9876500003', 'LQ-1', 'ZZWO-1', v_day, 10, 8000, v_day + 5, 'Weekly', 'ok');
        v_log := public.zz_chk(v_log, 'a labour work order needs a scope of work', false);
  exception when others then v_log := public.zz_chk(v_log, 'a labour work order needs a scope of work', sqlerrm ilike '%Scope of work%'); end;
  begin v_po := public.proc_confirm_order(v_wid, 'ZZ Labour Co', '9876500003', 'LQ-1', 'ZZWO-1', v_day, 10, 8000, v_day + 5, 'Weekly', 'ok', 'Polish 40 chairs, PU finish, 5 days');
        v_log := public.zz_chk(v_log, 'labour order is saved as a WORK_ORDER with its scope', v_po.order_type = 'WORK_ORDER' and v_po.scope_of_work like 'Polish 40 chairs%');
  exception when others then v_log := public.zz_chk(v_log, 'work order: ' || sqlerrm, false); end;
  reset role;

  ---------------------------------------------------------------- low stock -> requests
  insert into factory_materials (material_code, material_name, category, unit, reorder_level, is_active, created_by) values ('ZZ-M1', 'ZZ Fevicol 50kg', 'Adhesive', 'drum', 3, true, u_fh);
  perform public.zz_as(u_f1); set local role authenticated;
  begin n := public.proc_raise_low_stock_requests();
        v_log := public.zz_chk(v_log, 'low stock: one request raised for a material at/below reorder level, waiting for the Head',
          n >= 1 and (select count(*) from purchase_requests where material_name = 'ZZ Fevicol 50kg' and proc_status = 'PENDING_DEPT_APPROVAL' and procurement_category = 'RAW_MATERIAL') = 1);
        n := public.proc_raise_low_stock_requests();
        v_log := public.zz_chk(v_log, 'low stock: running it again does not duplicate the open request', (select count(*) from purchase_requests where material_name = 'ZZ Fevicol 50kg') = 1);
  exception when others then v_log := public.zz_chk(v_log, 'low stock: ' || sqlerrm, false); end;
  reset role;
  perform public.zz_as(u_a1); set local role authenticated;
  begin perform public.proc_raise_low_stock_requests(); v_log := public.zz_chk(v_log, 'Accounts cannot raise low-stock requests', false);
  exception when others then v_log := public.zz_chk(v_log, 'Accounts cannot raise low-stock requests', true); end;
  reset role;

  ---------------------------------------------------------------- bypass on the new tables
  perform public.zz_as(u_ph); set local role authenticated;
  begin insert into purchase_receipts (purchase_request_id, qty_received) values (v_id, 1); v_log := public.zz_chk(v_log, 'no direct GRN inserts', false);
  exception when others then v_log := public.zz_chk(v_log, 'no direct GRN inserts', sqlerrm ilike '%permission denied%'); end;
  begin insert into purchase_payments (purchase_request_id, invoice_id, amount, paid_on, payment_mode, reference, recorded_by)
          select v_id, id, 1, v_day, 'x', 'x', u_ph from purchase_payment_coordination where purchase_request_id = v_id;
        v_log := public.zz_chk(v_log, 'no direct payment inserts', false);
  exception when others then v_log := public.zz_chk(v_log, 'no direct payment inserts', sqlerrm ilike '%permission denied%'); end;
  begin update vendor_quotations set tax = 1 where purchase_request_id = v_id; get diagnostics n = row_count;
        v_log := public.zz_chk(v_log, 'no direct quotation edits', false);
  exception when others then v_log := public.zz_chk(v_log, 'no direct quotation edits', sqlerrm ilike '%permission denied%'); end;
  reset role;

  raise exception E'\n%', v_log;
end $t$;
