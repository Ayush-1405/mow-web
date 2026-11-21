-- v3_15 Factory Job Cards, end to end: Interior sends a Job Card -> Factory gets it (task + bridge + notification) ->
-- accept (one winner) -> assign -> production item-wise -> material shortage = Procurement order linked to the card ->
-- reminders -> QC fail returns to production -> QC pass -> ready -> dispatch -> receipt -> COMPLETED, task closed.
-- Own fixtures, ALWAYS rolls back (the report is in the error message).

do $t$
declare
  v_log text := ''; n int; v_day date; j public.factory_job_cards; j2 public.factory_job_cards; v_id uuid; v_task public.staff_tasks; r public.purchase_requests;
  v_item1 uuid; v_item2 uuid; v_code text; v_err text;
  r_emp uuid; r_head uuid; r_sup uuid; d_int uuid; d_fac uuid; d_proc uuid; d_ret uuid;
  u_ie uuid := gen_random_uuid(); u_ih uuid := gen_random_uuid(); u_fh uuid := gen_random_uuid(); u_f1 uuid := gen_random_uuid();
  u_f2 uuid := gen_random_uuid(); u_ph uuid := gen_random_uuid(); u_re uuid := gen_random_uuid(); u_p1 uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true); end $f$;
  v_day := public.proc_today_ist();
  select id into r_emp from roles where code = 'employee';
  select id into r_head from roles where code = 'dept_head';
  select id into r_sup from roles where code = 'supervisor';
  select id into d_int from departments where code = 'INTERIOR';
  select id into d_fac from departments where code = 'FACTORY';
  select id into d_proc from departments where code = 'PROCUREMENT';
  select id into d_ret from departments where code = 'RETAIL';
  -- Existing Factory staff would also receive the notifications; park them so the counts below are exact.
  update user_profiles set is_active = false where department_id = d_fac and is_active;
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated'
    from unnest(array[u_ie, u_ih, u_fh, u_f1, u_f2, u_ph, u_re, u_p1]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_ie, 'ZZ-FJ-IE', 'ZZ Interior Employee', r_emp, d_int, '9877700001', false, true),
    (u_ih, 'ZZ-FJ-IH', 'ZZ Interior Head', r_head, d_int, '9877700002', false, true),
    (u_fh, 'ZZ-FJ-FH', 'ZZ Factory Head', r_head, d_fac, '9877700003', false, true),
    (u_f1, 'ZZ-FJ-F1', 'ZZ Factory One', r_emp, d_fac, '9877700004', false, true),
    (u_f2, 'ZZ-FJ-F2', 'ZZ Factory Two', r_emp, d_fac, '9877700005', false, true),
    (u_ph, 'ZZ-FJ-PH', 'ZZ Procurement Head', r_head, d_proc, '9877700006', false, true),
    (u_re, 'ZZ-FJ-RE', 'ZZ Retail Employee', r_emp, d_ret, '9877700007', false, true),
    (u_p1, 'ZZ-FJ-P1', 'ZZ Procurement One', r_emp, d_proc, '9877700008', false, true);
  update procurement_settings set primary_head_user_id = u_ph where id;

  ---------------------------------------------------------------- 1. Interior creates a Job Card
  perform public.zz_as(u_ie); set local role authenticated;
  begin perform public.fjc_create(jsonb_build_object('due_date', v_day + 10), '[]'); v_log := public.zz_chk(v_log, 'a Job Card needs a product', false);
  exception when others then v_log := public.zz_chk(v_log, 'a Job Card needs a product', sqlerrm ilike '%at least one product%'); end;
  begin perform public.fjc_create(jsonb_build_object('due_date', v_day - 1), '[{"product_name":"Sofa","quantity":"1"}]'); v_log := public.zz_chk(v_log, 'due date cannot be in the past', false);
  exception when others then v_log := public.zz_chk(v_log, 'due date cannot be in the past', sqlerrm ilike '%past%'); end;
  begin perform public.fjc_create(jsonb_build_object('due_date', v_day + 10), '[{"product_name":"Sofa","quantity":"0"}]'); v_log := public.zz_chk(v_log, 'quantity must be more than 0', false);
  exception when others then v_log := public.zz_chk(v_log, 'quantity must be more than 0', sqlerrm ilike '%more than 0%'); end;
  j := public.fjc_create(jsonb_build_object('client_name', 'Mr. Shah', 'project_name', 'Shah Villa', 'due_date', v_day + 10, 'priority', 'URGENT',
         'delivery_location', 'Shah Villa, Rajkot', 'special_instructions', 'Handle with care'),
       '[{"product_name":"3 seater sofa","product_category":"Sofa","item_code":"SF-01","quantity":"2","dimensions":"84x36 in","material_spec":"Teak frame","finish_colour":"Walnut","laminate_fabric_hardware":"Velvet fabric"},
         {"product_name":"Centre table","quantity":"1","dimensions":"48x24 in"},
         {"product_name":"","quantity":""}]', 'zz-key-1');
  v_id := j.id;
  j2 := public.fjc_create(jsonb_build_object('due_date', v_day + 10), '[{"product_name":"3 seater sofa","quantity":"2"}]', 'zz-key-1');
  reset role;
  v_log := public.zz_chk(v_log, 'Job Card MW-FJC-YYYY-NNNN, status NEW, from Interior, with its Department Head',
    j.job_card_number ~ ('^MW-FJC-' || extract(year from now() at time zone 'Asia/Kolkata') || '-\d{4}$') and j.status = 'NEW'
    and j.requesting_department_id = d_int and j.department_head_id = any(public.proc_department_heads(d_int)) and j.due_date = v_day + 10 and j.priority = 'URGENT');
  v_log := public.zz_chk(v_log, 'the same submission sent twice returns the first card (no duplicate)', j2.id = v_id
    and (select count(*) from factory_job_cards where idempotency_key = 'zz-key-1') = 1);
  v_log := public.zz_chk(v_log, 'products stored item-wise (empty form row ignored)',
    (select string_agg(line_no || ':' || product_name || ':' || quantity, ',' order by line_no) from factory_job_card_items where job_card_id = v_id) = '1:3 seater sofa:2,2:Centre table:1');
  select id into v_item1 from factory_job_card_items where job_card_id = v_id and line_no = 1;
  select id into v_item2 from factory_job_card_items where job_card_id = v_id and line_no = 2;
  perform public.zz_as(u_ie); set local role authenticated;
  j2 := public.fjc_create(jsonb_build_object('due_date', v_day + 12), '[{"product_name":"Bed","quantity":"1"}]');
  reset role;
  v_log := public.zz_chk(v_log, 'job card numbers never repeat', j2.job_card_number <> j.job_card_number
    and (select count(*) from factory_job_cards) = (select count(distinct job_card_number) from factory_job_cards));

  ---------------------------------------------------------------- 2-3. reaches the Factory: task, bridge, notification
  select * into v_task from staff_tasks where factory_job_card_id = v_id;
  v_log := public.zz_chk(v_log, 'a Factory task exists at once (Interior -> Factory, owned by the Factory Head, due date of the card)',
    v_task.id is not null and v_task.to_department_id = d_fac and v_task.from_department_id = d_int and v_task.assigned_to = u_fh
    and v_task.due_date = v_day + 10 and v_task.reference_number = j.job_card_number and v_task.is_bridge);
  v_log := public.zz_chk(v_log, 'with a Cross-Department Bridge', exists (select 1 from bridges where task_id = v_task.id and from_department_id = d_int and to_department_id = d_fac));
  v_log := public.zz_chk(v_log, 'the Factory Head and Factory staff are notified', (select count(distinct recipient_id) from notifications
    where entity_type = 'FACTORY_JOB_CARD' and entity_id = v_id and recipient_id in (u_fh, u_f1, u_f2)) = 3);
  perform public.zz_as(u_re); set local role authenticated;
  select count(*) into n from factory_job_cards where id = v_id;
  reset role;
  v_log := public.zz_chk(v_log, 'another department (Retail) cannot see the card', n = 0);
  perform public.zz_as(u_f2); set local role authenticated;
  select count(*) into n from factory_job_cards where id = v_id;
  reset role;
  v_log := public.zz_chk(v_log, 'a Factory employee sees the new, unaccepted card', n = 1);

  ---------------------------------------------------------------- 7. files belong to the card
  perform public.zz_as(u_ie); set local role authenticated;
  perform public.fjc_add_file(v_id, 'factory-jobs/' || v_id || '/zz-drawing.pdf', 'Sofa drawing.pdf', 'application/pdf', 'DRAWING');
  perform public.fjc_add_file(v_id, 'factory-jobs/' || v_id || '/zz-photo.jpg', 'Reference.jpg', 'image/jpeg', 'PRODUCT_IMAGE');
  begin perform public.fjc_add_file(v_id, 'factory-jobs/' || j2.id || '/x.pdf', 'x.pdf', 'application/pdf', 'PDF'); v_log := public.zz_chk(v_log, 'a file stored under another card is refused', false);
  exception when others then v_log := public.zz_chk(v_log, 'a file stored under another card is refused', sqlerrm ilike '%not stored under this Job Card%'); end;
  reset role;
  v_log := public.zz_chk(v_log, 'drawings and photos are registered on the card', (select count(*) from factory_job_card_files where job_card_id = v_id) = 2);

  ---------------------------------------------------------------- 4-6. accept (one winner), assign, My Tasks
  perform public.zz_as(u_ie); set local role authenticated;
  begin perform public.fjc_action(v_id, 'accept'); v_log := public.zz_chk(v_log, 'the requester cannot accept for the Factory', false);
  exception when others then v_log := public.zz_chk(v_log, 'the requester cannot accept for the Factory', sqlerrm ilike '%Only the Factory%'); end;
  reset role;
  perform public.zz_as(u_f1); set local role authenticated;
  j := public.fjc_action(v_id, 'accept');
  reset role;
  perform public.zz_as(u_f2); set local role authenticated;
  begin perform public.fjc_action(v_id, 'accept'); v_log := public.zz_chk(v_log, 'a second employee cannot accept the same card', false);
  exception when others then v_log := public.zz_chk(v_log, 'a second employee cannot accept the same card', sqlerrm ilike '%already accepted by ZZ Factory One%'); end;
  select count(*) into n from factory_job_cards where id = v_id;
  reset role;
  v_log := public.zz_chk(v_log, 'once accepted, another Factory employee no longer sees it', n = 0);
  select * into v_task from staff_tasks where factory_job_card_id = v_id;
  v_log := public.zz_chk(v_log, 'accepted: status ACCEPTED, who and when recorded, employee assigned',
    j.status = 'ACCEPTED' and j.accepted_by = u_f1 and j.accepted_at is not null and j.assigned_to = u_f1);
  v_log := public.zz_chk(v_log, 'the task moves to the employee (My Tasks), accepted, bridge accepted',
    v_task.assigned_to = u_f1 and (select code from status_master where id = v_task.status_id) = 'ACCEPTED'
    and exists (select 1 from staff_task_assignees where task_id = v_task.id and user_id = u_f1 and is_active and assignment_role = 'primary')
    and (select acceptance_status from bridges where task_id = v_task.id) = 'ACCEPTED');
  v_log := public.zz_chk(v_log, 'the requesting department is told it was accepted',
    exists (select 1 from notifications where entity_id = v_id and recipient_id = u_ie and title_en like 'Factory accepted%')
    and exists (select 1 from notifications where entity_id = v_id and recipient_id = u_ih and title_en like 'Factory accepted%'));
  perform public.zz_as(u_f1); set local role authenticated;
  begin perform public.fjc_action(v_id, 'assign', jsonb_build_object('assignee', u_f2)); v_log := public.zz_chk(v_log, 'only the Factory Head reassigns', false);
  exception when others then v_log := public.zz_chk(v_log, 'only the Factory Head reassigns', sqlerrm ilike '%Only the Factory Head%'); end;
  begin update staff_tasks set status_id = proc_task_status_id('IN_PROGRESS') where id = v_task.id; v_log := public.zz_chk(v_log, 'the task cannot be moved outside the Job Card', false);
  exception when others then v_log := public.zz_chk(v_log, 'the task cannot be moved outside the Job Card', true); end;
  reset role;
  perform public.zz_as(u_fh); set local role authenticated;
  j := public.fjc_action(v_id, 'assign', jsonb_build_object('assignee', u_f2, 'reason', 'F1 on leave'));
  j := public.fjc_action(v_id, 'assign', jsonb_build_object('assignee', u_f1, 'reason', 'back'));
  reset role;
  v_log := public.zz_chk(v_log, 'the Factory Head reassigns; the task owner follows', j.assigned_to = u_f1
    and (select assigned_to from staff_tasks where id = v_task.id) = u_f1
    and exists (select 1 from staff_task_assignees where task_id = v_task.id and user_id = u_f2 and not is_active));

  ---------------------------------------------------------------- 9. production, item-wise
  perform public.zz_as(u_f1); set local role authenticated;
  begin perform public.fjc_action(v_id, 'progress', jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', v_item1, 'qty_completed', 1))));
        v_log := public.zz_chk(v_log, 'progress needs production started', false);
  exception when others then v_log := public.zz_chk(v_log, 'progress needs production started', sqlerrm ilike '%Start production%'); end;
  j := public.fjc_action(v_id, 'start');
  begin perform public.fjc_action(v_id, 'progress', jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', v_item1, 'qty_completed', 5))));
        v_log := public.zz_chk(v_log, 'completed cannot exceed ordered', false);
  exception when others then v_log := public.zz_chk(v_log, 'completed cannot exceed ordered', sqlerrm ilike '%more than the ordered%'); end;
  j := public.fjc_action(v_id, 'progress', jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', v_item1, 'qty_completed', 1, 'remarks', 'frame done')), 'remarks', 'Cutting done'));
  begin perform public.fjc_action(v_id, 'send_to_qc'); v_log := public.zz_chk(v_log, 'cannot go to QC with quantities pending', false);
  exception when others then v_log := public.zz_chk(v_log, 'cannot go to QC with quantities pending', sqlerrm ilike '%not finished%3 seater sofa 1%Centre table 1%'); end;
  reset role;
  select * into v_task from staff_tasks where factory_job_card_id = v_id;
  v_log := public.zz_chk(v_log, 'production started and in progress (1 of 3 = 33%), task in progress',
    j.status = 'IN_PROGRESS' and j.progress_pct = 33 and j.production_started_at is not null and j.production_remarks = 'Cutting done'
    and (select code from status_master where id = v_task.status_id) = 'IN_PROGRESS'
    and (select remarks from factory_job_card_items where id = v_item1) = 'frame done');

  ---------------------------------------------------------------- 10. missing material -> Procurement order linked to the card
  perform public.zz_as(u_f1); set local role authenticated;
  r := public.fjc_request_material(v_id, '[{"material":"Teak wood","specification":"Grade A, 2 in","quantity":"40","unit":"cft"}]', v_day + 3, 'urgent for frames');
  reset role;
  v_log := public.zz_chk(v_log, 'a normal Procurement order is raised from the Factory, linked to the card',
    r.factory_job_card_id = v_id and r.requesting_department_id = d_fac and r.proc_status in ('PENDING_DEPT_APPROVAL', 'SENT_TO_PROCUREMENT')
    and (select description from purchase_request_items where purchase_request_id = r.id) = 'Teak wood — Grade A, 2 in'
    and exists (select 1 from factory_job_card_events where job_card_id = v_id and action = 'MATERIAL_REQUESTED'));
  v_log := public.zz_chk(v_log, 'production is not marked done by ordering material', (select status from factory_job_cards where id = v_id) = 'IN_PROGRESS');
  perform public.zz_as(u_p1); set local role authenticated;
  perform public.proc_accept_order_task(r.id);
  reset role;
  v_log := public.zz_chk(v_log, 'Procurement progress on that order comes back to the Job Card',
    exists (select 1 from factory_job_card_events where job_card_id = v_id and action = 'MATERIAL_STATUS'));

  ---------------------------------------------------------------- 11. reminders and the revised date
  update factory_job_cards set due_date = v_day - 1 where id = j2.id;
  update factory_job_cards set created_at = now() - interval '3 hours' where id = j2.id;
  n := public.fjc_run_reminders();
  v_log := public.zz_chk(v_log, 'reminders: overdue and awaiting acceptance go to the Factory Head (once a day)',
    exists (select 1 from notifications where entity_id = j2.id and recipient_id = u_fh and title_en like '%overdue%')
    and exists (select 1 from notifications where entity_id = j2.id and recipient_id = u_fh and title_en like '%waiting to be accepted%'));
  select count(*) into n from notifications where entity_id = j2.id and recipient_id = u_fh;
  perform public.fjc_run_reminders();
  v_log := public.zz_chk(v_log, 'running again the same day sends nothing new', (select count(*) from notifications where entity_id = j2.id and recipient_id = u_fh) = n);
  perform public.zz_as(u_f1); set local role authenticated;
  begin perform public.fjc_action(v_id, 'revise_date', jsonb_build_object('date', v_day + 15, 'reason', 'x')); v_log := public.zz_chk(v_log, 'only the Factory Head revises the date', false);
  exception when others then v_log := public.zz_chk(v_log, 'only the Factory Head revises the date', sqlerrm ilike '%Only the Factory Head%'); end;
  reset role;
  perform public.zz_as(u_fh); set local role authenticated;
  begin perform public.fjc_action(v_id, 'revise_date', jsonb_build_object('date', v_day + 15)); v_log := public.zz_chk(v_log, 'a revised date needs a reason', false);
  exception when others then v_log := public.zz_chk(v_log, 'a revised date needs a reason', sqlerrm ilike '%reason%'); end;
  j := public.fjc_action(v_id, 'revise_date', jsonb_build_object('date', v_day + 15, 'reason', 'Teak delivery delayed'));
  reset role;
  v_log := public.zz_chk(v_log, 'revised date kept apart: original due stays, task follows the new date, department head told',
    j.due_date = v_day + 10 and j.revised_due_date = v_day + 15 and (select due_date from staff_tasks where factory_job_card_id = v_id) = v_day + 15
    and exists (select 1 from notifications where entity_id = v_id and recipient_id = u_ih and title_en like 'Factory cannot meet%Teak delivery delayed%'));

  ---------------------------------------------------------------- 12-14. QC
  perform public.zz_as(u_f1); set local role authenticated;
  j := public.fjc_action(v_id, 'progress', jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', v_item1, 'qty_completed', 2), jsonb_build_object('id', v_item2, 'qty_completed', 1))));
  j := public.fjc_action(v_id, 'send_to_qc');
  begin perform public.fjc_action(v_id, 'qc', jsonb_build_object('result', 'PASSED', 'product_quality_ok', true, 'dimensions_ok', true, 'material_ok', true, 'finish_ok', true, 'quantity_ok', true));
        v_log := public.zz_chk(v_log, 'the employee cannot approve QC', false);
  exception when others then v_log := public.zz_chk(v_log, 'the employee cannot approve QC', sqlerrm ilike '%Only the Factory Head%'); end;
  begin perform public.fjc_action(v_id, 'ready'); v_log := public.zz_chk(v_log, 'not ready for dispatch before QC passes', false);
  exception when others then v_log := public.zz_chk(v_log, 'not ready for dispatch before QC passes', sqlerrm ilike '%Quality Check must pass%'); end;
  reset role;
  v_log := public.zz_chk(v_log, 'production 100% -> QUALITY_CHECK, Factory Head told', j.status = 'QUALITY_CHECK' and j.progress_pct = 100
    and exists (select 1 from notifications where entity_id = v_id and recipient_id = u_fh and title_en like 'Quality Check pending%'));
  perform public.zz_as(u_fh); set local role authenticated;
  begin perform public.fjc_action(v_id, 'qc', jsonb_build_object('result', 'FAILED')); v_log := public.zz_chk(v_log, 'a failed QC needs the defects', false);
  exception when others then v_log := public.zz_chk(v_log, 'a failed QC needs the defects', sqlerrm ilike '%defects%'); end;
  begin perform public.fjc_action(v_id, 'qc', jsonb_build_object('result', 'PASSED', 'product_quality_ok', true)); v_log := public.zz_chk(v_log, 'QC passes only with every check verified', false);
  exception when others then v_log := public.zz_chk(v_log, 'QC passes only with every check verified', sqlerrm ilike '%all verified%'); end;
  j := public.fjc_action(v_id, 'qc', jsonb_build_object('result', 'FAILED', 'product_quality_ok', true, 'dimensions_ok', false, 'material_ok', true, 'finish_ok', true, 'quantity_ok', true,
         'defects', 'Sofa arm 2 cm short'));
  reset role;
  v_log := public.zz_chk(v_log, 'failed QC returns the job to production, reason kept, employee told',
    j.status = 'IN_PROGRESS' and j.qc_status = 'FAILED' and (select defects from factory_job_card_qc where job_card_id = v_id and result = 'FAILED') = 'Sofa arm 2 cm short'
    and exists (select 1 from notifications where entity_id = v_id and recipient_id = u_f1 and title_en like 'QC failed%Sofa arm 2 cm short%'));
  perform public.zz_as(u_f1); set local role authenticated;
  j := public.fjc_action(v_id, 'send_to_qc');
  reset role;
  perform public.zz_as(u_fh); set local role authenticated;
  j := public.fjc_action(v_id, 'qc', jsonb_build_object('result', 'PASSED', 'product_quality_ok', true, 'dimensions_ok', true, 'material_ok', true, 'finish_ok', true, 'quantity_ok', true));
  j := public.fjc_action(v_id, 'ready');
  reset role;
  select * into v_task from staff_tasks where factory_job_card_id = v_id;
  v_log := public.zz_chk(v_log, 'QC passed (history of both checks kept) -> READY_FOR_DISPATCH; Factory task done',
    j.status = 'READY_FOR_DISPATCH' and j.qc_status = 'PASSED' and (select count(*) from factory_job_card_qc where job_card_id = v_id) = 2
    and (select code from status_master where id = v_task.status_id) = 'COMPLETED');

  ---------------------------------------------------------------- 15-18. notifications, dispatch, receipt, completed
  v_log := public.zz_chk(v_log, 'requester and requesting Department Head are told it is ready',
    (select count(distinct recipient_id) from notifications where entity_id = v_id and title_en like '%ready for dispatch' and recipient_id in (u_ie, u_ih)) = 2);
  perform public.zz_as(u_ie); set local role authenticated;
  begin perform public.fjc_action(v_id, 'confirm_receipt'); v_log := public.zz_chk(v_log, 'receipt only after dispatch', false);
  exception when others then v_log := public.zz_chk(v_log, 'receipt only after dispatch', sqlerrm ilike '%once the Job Card is dispatched%'); end;
  reset role;
  perform public.zz_as(u_fh); set local role authenticated;
  begin perform public.fjc_action(v_id, 'dispatch', jsonb_build_object('dispatch_date', v_day, 'quantity', 3)); v_log := public.zz_chk(v_log, 'dispatch needs a delivery reference', false);
  exception when others then v_log := public.zz_chk(v_log, 'dispatch needs a delivery reference', sqlerrm ilike '%Delivery reference%'); end;
  begin perform public.fjc_action(v_id, 'dispatch', jsonb_build_object('dispatch_date', v_day, 'quantity', 9, 'delivery_reference', 'CH-1')); v_log := public.zz_chk(v_log, 'cannot dispatch more than made', false);
  exception when others then v_log := public.zz_chk(v_log, 'cannot dispatch more than made', sqlerrm ilike '%Only 3 more%'); end;
  j := public.fjc_action(v_id, 'dispatch', jsonb_build_object('dispatch_date', v_day, 'quantity', 2, 'delivery_reference', 'CH-101', 'transport_details', 'Tempo GJ-03-AB-1234'));
  v_log := public.zz_chk(v_log, 'a part dispatch keeps it ready for dispatch', j.status = 'READY_FOR_DISPATCH');
  j := public.fjc_action(v_id, 'dispatch', jsonb_build_object('dispatch_date', v_day, 'quantity', 1, 'delivery_reference', 'CH-102'));
  reset role;
  v_log := public.zz_chk(v_log, 'dispatch details saved; all dispatched -> DISPATCHED',
    j.status = 'DISPATCHED' and (select count(*) from factory_job_card_dispatches where job_card_id = v_id) = 2
    and (select transport_details from factory_job_card_dispatches where job_card_id = v_id and delivery_reference = 'CH-101') = 'Tempo GJ-03-AB-1234');
  perform public.zz_as(u_f2); set local role authenticated;
  begin perform public.fjc_action(v_id, 'confirm_receipt'); v_log := public.zz_chk(v_log, 'the Factory cannot confirm its own delivery', false);
  exception when others then v_log := public.zz_chk(v_log, 'the Factory cannot confirm its own delivery', true); end;
  reset role;
  perform public.zz_as(u_ie); set local role authenticated;
  j := public.fjc_action(v_id, 'confirm_receipt', jsonb_build_object('remarks', 'All 3 received in good condition'));
  reset role;
  select * into v_task from staff_tasks where factory_job_card_id = v_id;
  v_log := public.zz_chk(v_log, 'the requesting department confirms receipt -> COMPLETED', j.status = 'COMPLETED' and j.received_by = u_ie and j.received_at is not null);
  v_log := public.zz_chk(v_log, 'task closed and bridge closed with it',
    (select code from status_master where id = v_task.status_id) = 'CLOSED' and (select closed_at is not null from bridges where task_id = v_task.id));
  v_log := public.zz_chk(v_log, 'the Factory is told it was received', exists (select 1 from notifications where entity_id = v_id and recipient_id = u_fh and title_en like '%received by%'));

  ---------------------------------------------------------------- history, cancel
  v_log := public.zz_chk(v_log, 'complete history of the card',
    (select string_agg(distinct action, ',' order by action) from factory_job_card_events where job_card_id = v_id)
      = 'ACCEPT,ASSIGN,CONFIRM_RECEIPT,CREATED,DISPATCH,FILE_ADDED,MATERIAL_REQUESTED,MATERIAL_STATUS,PROGRESS,QC,READY,REVISE_DATE,SEND_TO_QC,START'
    and (select count(*) from staff_audit_log where entity_type = 'factory_job_card' and entity_id = v_id) >= 10);
  perform public.zz_as(u_ie); set local role authenticated;
  begin perform public.fjc_action(j2.id, 'cancel', '{}'); v_log := public.zz_chk(v_log, 'cancelling needs a reason', false);
  exception when others then v_log := public.zz_chk(v_log, 'cancelling needs a reason', sqlerrm ilike '%reason%'); end;
  j2 := public.fjc_action(j2.id, 'cancel', jsonb_build_object('reason', 'Client changed the design'));
  reset role;
  v_log := public.zz_chk(v_log, 'the requester cancels a new card; its task disappears',
    j2.status = 'CANCELLED' and not (select is_active from staff_tasks where factory_job_card_id = j2.id));
  begin
    perform public.zz_as(u_ie); set local role authenticated;
    insert into factory_job_cards (job_card_number, requesting_department_id, requested_by, due_date) values ('X', d_int, u_ie, v_day);
    reset role; v_log := public.zz_chk(v_log, 'cards cannot be written directly', false);
  exception when others then reset role; v_log := public.zz_chk(v_log, 'cards cannot be written directly', true); end;

  raise exception E'\n%', v_log;
end $t$;
