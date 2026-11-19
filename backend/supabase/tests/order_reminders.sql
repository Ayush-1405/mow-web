-- Due dates, deadlines and automatic reminders (v3_06). Own fixtures; time is simulated by moving the stage start back in
-- the order's history and by moving the due date. ALWAYS rolls back (the report is in the error message), so no reminder,
-- notification or push request survives it.
--
-- Covers the brief's final checks: 1 order with a due date, 2 due date visible to Procurement, 3 acceptance reminders,
-- 4 accepted-not-placed reminders, 5 3-day / 1-day reminders, 6 overdue, 7 Management escalation, 8 no duplicates,
-- 9 reminders stop when the stage is done, 10 the server-side schedule exists (runs with every app closed).

do $t$
declare
  v_log text := ''; n int; m int; v_pr public.purchase_requests; v_id uuid; v_eid uuid; v_ctx record; v_day date; v_res jsonb; v_rem uuid;
  r_emp uuid; r_head uuid; r_sup uuid; r_mgmt uuid; d_int uuid; d_proc uuid;
  u_e uuid := gen_random_uuid(); u_h uuid := gen_random_uuid(); u_ph uuid := gen_random_uuid(); u_ps uuid := gen_random_uuid(); u_m uuid := gen_random_uuid();
  v_items jsonb := '[{"item_code":"HW-01","description":"Hinges, soft close","qty_size":"20 nos","quantity":"20","rate":"250"},
                     {"description":"Drawer channels 18 in","qty_size":"10 pairs","quantity":"10","rate":"400"}]';
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true); end $f$;
  create function public.zz_rem(p_req uuid, p_kind text, p_user uuid) returns int language sql as $f$
    select count(*)::int from public.procurement_reminders where purchase_request_id = p_req and kind = p_kind and (p_user is null or recipient_id = p_user) $f$;
  v_day := public.proc_today_ist();
  select id into r_emp from roles where code = 'employee';
  select id into r_head from roles where code = 'dept_head';
  select id into r_sup from roles where code = 'supervisor';
  select id into r_mgmt from roles where code = 'management';
  select id into d_int from departments where code = 'INTERIOR';
  select id into d_proc from departments where code = 'PROCUREMENT';
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_e, u_h, u_ph, u_ps, u_m]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_e, 'ZZ-RM-E', 'ZZ Interior Employee', r_emp, d_int, '9833300001', false, true),
    (u_h, 'ZZ-RM-H', 'ZZ Interior Head', r_head, d_int, '9833300002', false, true),
    (u_ph, 'ZZ-RM-P', 'ZZ Procurement Head', r_head, d_proc, '9833300003', false, true),
    (u_ps, 'ZZ-RM-S', 'ZZ Procurement Staff', r_sup, d_proc, '9833300004', false, true),
    (u_m, 'ZZ-RM-M', 'ZZ Management', r_mgmt, (select department_id from user_profiles up join roles r on r.id = up.role_id where r.code = 'management' limit 1), '9833300005', false, true);
  -- Deterministic: the test head is the primary Procurement Head, and reminders may go out at any hour on any day.
  perform public.zz_as(u_m); set local role authenticated;
  begin perform public.proc_set_primary_head(u_ph);
        v_log := public.zz_chk(v_log, 'Management sets the primary Procurement Head', true);
  exception when others then v_log := public.zz_chk(v_log, 'Management sets the primary Procurement Head: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'the primary head is the reminder head', public.proc_procurement_head_user() = u_ph);
  update procurement_settings set primary_head_user_id = u_ph, reminders_enabled = true, reminder_working_days = '{1,2,3,4,5,6,7}',
    reminder_window_start = '00:00', reminder_window_end = '23:59:59' where id;
  delete from procurement_holidays where holiday_date = v_day;

  ---------------------------------------------------------------- 1. order with a due date and priority
  perform public.zz_as(u_e); set local role authenticated;
  begin perform public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'delivery_location', 'Site'), v_items);
        v_log := public.zz_chk(v_log, '1  an order without a due date is refused', false);
  exception when others then v_log := public.zz_chk(v_log, '1  an order without a due date is refused', sqlerrm ilike '%completion date is required%'); end;
  begin perform public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'required_completion_date', v_day + 3, 'delivery_location', 'Site', 'priority', 'URGENT'), v_items);
        v_log := public.zz_chk(v_log, '1  Urgent without a reason is refused', false);
  exception when others then v_log := public.zz_chk(v_log, '1  Urgent without a reason is refused', sqlerrm ilike '%reason for urgency%'); end;
  begin
    v_pr := public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'required_completion_date', v_day + 3, 'delivery_location', 'Site, Rajkot',
      'priority', 'URGENT', 'urgency_reason', 'Site handover on Friday'), v_items);
    v_id := v_pr.id;
    v_log := public.zz_chk(v_log, '1  Urgent order with due date saved (due, priority, reason, history note)',
      v_pr.required_by_date = v_day + 3 and v_pr.priority = 'URGENT' and v_pr.urgency_reason = 'Site handover on Friday'
      and (select remarks from purchase_request_status_history where purchase_request_id = v_id order by created_at limit 1)
          = 'Due date ' || to_char(v_day + 3, 'DD-MM-YYYY') || ', priority Urgent (Site handover on Friday)');
  exception when others then v_log := public.zz_chk(v_log, '1  create: ' || sqlerrm, false); end;
  begin
    v_pr := public.proc_create_order(jsonb_build_object('form_type', 'INTERIOR', 'required_completion_date', v_day + 1, 'delivery_location', 'Site',
      'priority', 'EMERGENCY', 'urgency_reason', 'Water leak'), '[{"description":"Plumbing kit","qty_size":"1 set"}]');
    v_eid := v_pr.id;
    v_log := public.zz_chk(v_log, '1  Emergency priority goes to Management approval first', v_pr.is_emergency and v_pr.proc_status = 'EMERGENCY_APPROVAL_PENDING');
  exception when others then v_log := public.zz_chk(v_log, '1  emergency: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, '9  no Procurement reminders while the order is with its department', (select count(*) from procurement_reminders where purchase_request_id in (v_id, v_eid)) = 0);

  ---------------------------------------------------------------- 2-3. arrival and acceptance reminders
  perform public.zz_as(u_h); set local role authenticated; perform public.proc_dept_decision(v_id, 'APPROVE', null); reset role;
  v_log := public.zz_chk(v_log, '2  on arrival the Procurement Head and team get one message with the due date and action',
    public.zz_rem(v_id, 'ACCEPT_NEW', u_ph) = 1 and public.zz_rem(v_id, 'ACCEPT_NEW', u_ps) = 1
    and (select count(*) from notifications where entity_id = v_id and recipient_id = u_ph) = 1
    and (select title_en from notifications where entity_id = v_id and recipient_id = u_ph) like
        'New order: Order ' || (select request_number from purchase_requests where id = v_id) || ' (%) is waiting for Procurement. Due ' || to_char(v_day + 3, 'DD-MM-YYYY') || ' (in 3 days). Priority: Urgent.%Action: accept%');
  perform public.proc_check_order_reminders(v_id);
  v_log := public.zz_chk(v_log, '3  no 2-hour reminder before 2 hours', public.zz_rem(v_id, 'ACCEPT_2H', null) = 0);

  update purchase_request_status_history set created_at = now() - interval '3 hours' where purchase_request_id = v_id and to_status = 'SENT_TO_PROCUREMENT';
  insert into procurement_holidays (holiday_date, name) values (v_day, 'ZZ test holiday');
  perform public.proc_check_order_reminders(v_id);
  v_log := public.zz_chk(v_log, '3  on a company holiday the 2-hour reminder waits', public.zz_rem(v_id, 'ACCEPT_2H', null) = 0);
  delete from procurement_holidays where holiday_date = v_day;
  update procurement_settings set reminder_working_days = (select array_agg(d) from unnest('{1,2,3,4,5,6,7}'::smallint[]) d where d <> extract(isodow from v_day)) where id;
  perform public.proc_check_order_reminders(v_id);
  v_log := public.zz_chk(v_log, '3  on a non-working weekday the 2-hour reminder waits', public.zz_rem(v_id, 'ACCEPT_2H', null) = 0);
  update procurement_settings set reminder_working_days = '{1,2,3,4,5,6,7}' where id;
  perform public.proc_check_order_reminders(v_id);
  v_log := public.zz_chk(v_log, '3  after 2 hours (working time) the 2-hour reminder goes out', public.zz_rem(v_id, 'ACCEPT_2H', u_ph) = 1 and public.zz_rem(v_id, 'ACCEPT_2H', u_ps) = 1);
  perform public.proc_check_order_reminders(v_id); perform public.proc_check_order_reminders(v_id);
  v_log := public.zz_chk(v_log, '8  running again sends no duplicates', public.zz_rem(v_id, 'ACCEPT_2H', u_ph) = 1 and public.zz_rem(v_id, 'ACCEPT_NEW', u_ph) = 1);

  update purchase_request_status_history set created_at = now() - interval '50 hours' where purchase_request_id = v_id and to_status = 'SENT_TO_PROCUREMENT';
  perform public.proc_check_order_reminders(v_id);
  v_log := public.zz_chk(v_log, '3  after 24 hours the escalation goes to the Procurement Head',
    public.zz_rem(v_id, 'ACCEPT_24H', u_ph) = 1 and (select title_en from notifications n join procurement_reminders x on x.notification_id = n.id
      where x.purchase_request_id = v_id and x.kind = 'ACCEPT_24H' and x.recipient_id = u_ph) like 'ESCALATION:%not been accepted for 2 days%');
  v_log := public.zz_chk(v_log, '8  no daily reminder on the same day as the 24-hour escalation', public.zz_rem(v_id, 'ACCEPT_DAILY', null) = 0);
  update procurement_reminders set created_at = now() - interval '1 day' where purchase_request_id = v_id and kind = 'ACCEPT_24H';
  perform public.proc_check_order_reminders(v_id); perform public.proc_check_order_reminders(v_id);
  v_log := public.zz_chk(v_log, '3  next day: one daily overdue-acceptance reminder', public.zz_rem(v_id, 'ACCEPT_DAILY', u_ph) = 1);

  ---------------------------------------------------------------- 4. accepted, not yet placed
  perform public.zz_as(u_ps); set local role authenticated; perform public.proc_procurement_decision(v_id, 'ACCEPT', null); reset role;
  v_log := public.zz_chk(v_log, '4  the person who accepts is assigned, and gets the "confirm Order Placed" reminder at once',
    (select proc_assigned_to from purchase_requests where id = v_id) = u_ps and public.zz_rem(v_id, 'PLACE_NOW', u_ps) = 1 and public.zz_rem(v_id, 'PLACE_NOW', u_ph) = 1);
  select count(*) into n from procurement_reminders where purchase_request_id = v_id and kind like 'ACCEPT%';
  perform public.proc_check_order_reminders(v_id);
  v_log := public.zz_chk(v_log, '9  acceptance reminders stop once accepted', (select count(*) from procurement_reminders where purchase_request_id = v_id and kind like 'ACCEPT%') = n);
  update purchase_request_status_history set created_at = now() - interval '25 hours' where purchase_request_id = v_id and to_status = 'ACCEPTED_BY_PROCUREMENT';
  perform public.proc_check_order_reminders(v_id);
  v_log := public.zz_chk(v_log, '4  24 hours after acceptance without Order Placed: escalation to the Head and the assigned staff',
    public.zz_rem(v_id, 'PLACE_24H', u_ph) = 1 and public.zz_rem(v_id, 'PLACE_24H', u_ps) = 1);
  v_log := public.zz_chk(v_log, '4  only the Head and the assigned staff, not the whole team, once assigned',
    (select count(distinct recipient_id) from procurement_reminders where purchase_request_id = v_id and kind = 'PLACE_24H') = 2);

  ---------------------------------------------------------------- 5. due in 3 days / 1 day / today (order placed meanwhile)
  v_log := public.zz_chk(v_log, '5  3 days before the due date: reminder', public.zz_rem(v_id, 'DUE_3D', u_ph) = 1 and public.zz_rem(v_id, 'DUE_3D', u_ps) = 1);
  perform public.zz_as(u_ps); set local role authenticated;
  perform public.proc_record_print(v_id, 'PURCHASE_REQUEST');
  begin perform public.proc_confirm_order(v_id, 'Hettich Dealer', '9876500222', 'Q-12', 'ZZPO-RM-1', v_day, 30, 9000, v_day + 2, 'Cash', 'ok');
        v_log := public.zz_chk(v_log, '4  Order Placed confirmed', (select proc_status from purchase_requests where id = v_id) = 'ORDER_PLACED');
  exception when others then v_log := public.zz_chk(v_log, '4  place order: ' || sqlerrm, false); end;
  reset role;
  -- (u_ps confirmed it, and nobody is notified of their own action.)
  v_log := public.zz_chk(v_log, '4  Order Placed reaches the requester, the Department Head and the Procurement Head',
    (select count(distinct recipient_id) from notifications where entity_id = v_id and title_en like 'Order placed%' and recipient_id in (u_e, u_h, u_ph)) = 3);
  select count(*) into n from procurement_reminders where purchase_request_id = v_id and kind like 'PLACE%';
  update procurement_reminders set created_at = now() - interval '1 day' where purchase_request_id = v_id and kind like 'PLACE%';
  perform public.proc_check_order_reminders(v_id);
  v_log := public.zz_chk(v_log, '9  placement reminders stop once Order Placed is confirmed', (select count(*) from procurement_reminders where purchase_request_id = v_id and kind like 'PLACE%') = n);
  update purchase_requests set required_by_date = v_day + 1 where id = v_id;
  perform public.proc_check_order_reminders(v_id);
  v_log := public.zz_chk(v_log, '5  1 day before the due date: reminder', public.zz_rem(v_id, 'DUE_1D', u_ph) = 1 and public.zz_rem(v_id, 'DUE_1D', u_ps) = 1
    and (select title_en from notifications n join procurement_reminders x on x.notification_id = n.id where x.purchase_request_id = v_id and x.kind = 'DUE_1D' and x.recipient_id = u_ph)
        like 'Due tomorrow:%Status: Order Placed.%');
  update purchase_requests set required_by_date = v_day where id = v_id;
  perform public.proc_check_order_reminders(v_id);
  v_log := public.zz_chk(v_log, '5  on the due date: reminder', public.zz_rem(v_id, 'DUE_TODAY', u_ph) = 1);

  ---------------------------------------------------------------- 6-7. overdue and escalation
  update purchase_requests set required_by_date = v_day - 1 where id = v_id;
  perform public.proc_check_order_reminders(v_id);
  v_log := public.zz_chk(v_log, '6  overdue: marked OVERDUE in history, status unchanged',
    (select overdue_since from purchase_requests where id = v_id) = v_day and (select proc_status from purchase_requests where id = v_id) = 'ORDER_PLACED'
    and (select count(*) from purchase_request_status_history where purchase_request_id = v_id and remarks like 'OVERDUE: due date%') = 1);
  v_log := public.zz_chk(v_log, '6  overdue reminder to the Procurement Head, the assigned staff and the Department Head',
    public.zz_rem(v_id, 'OVERDUE', u_ph) = 1 and public.zz_rem(v_id, 'OVERDUE', u_ps) = 1 and public.zz_rem(v_id, 'OVERDUE', u_h) = 1);
  v_log := public.zz_chk(v_log, '7  no Management escalation at 1 day overdue', public.zz_rem(v_id, 'ESC_MGMT_2D', null) = 0);
  update purchase_requests set required_by_date = v_day - 2 where id = v_id;
  perform public.proc_check_order_reminders(v_id); perform public.proc_check_order_reminders(v_id);
  v_log := public.zz_chk(v_log, '7  2 days overdue: Management is notified once', public.zz_rem(v_id, 'ESC_MGMT_2D', u_m) = 1 and public.zz_rem(v_id, 'ESC_CRITICAL_5D', null) = 0);
  update purchase_requests set required_by_date = v_day - 5 where id = v_id;
  perform public.proc_check_order_reminders(v_id); perform public.proc_check_order_reminders(v_id);
  v_log := public.zz_chk(v_log, '7  5 days overdue: critical escalation to Management and the Department Head',
    public.zz_rem(v_id, 'ESC_CRITICAL_5D', u_m) = 1 and public.zz_rem(v_id, 'ESC_CRITICAL_5D', u_h) = 1
    and (select title_en from notifications n join procurement_reminders x on x.notification_id = n.id where x.purchase_request_id = v_id and x.kind = 'ESC_CRITICAL_5D' and x.recipient_id = u_m)
        like 'CRITICAL:%5 days overdue%');
  v_log := public.zz_chk(v_log, '8  each reminder is stored once per order, kind, cycle and person',
    (select count(*) from (select 1 from procurement_reminders where purchase_request_id = v_id group by kind, cycle_key, recipient_id having count(*) > 1) d) = 0);

  ---------------------------------------------------------------- delivery tracking, retries
  select id into v_rem from procurement_reminders where purchase_request_id = v_id and kind = 'ESC_CRITICAL_5D' and recipient_id = u_m;
  update notifications set delivery_status = 'failed' where id = (select notification_id from procurement_reminders where id = v_rem);
  insert into procurement_reminders (purchase_request_id, kind, cycle_key, recipient_id, message_en, message_gu, status, attempts, updated_at)
  values (v_id, 'OVERDUE', 'zz-retry', u_ph, 'ZZ retry me', 'ZZ', 'FAILED', 1, now() - interval '1 hour');
  update user_profiles set is_active = false where id = u_ps;
  insert into procurement_reminders (purchase_request_id, kind, cycle_key, recipient_id, message_en, message_gu, status, attempts, updated_at)
  values (v_id, 'OVERDUE', 'zz-inactive', u_ps, 'ZZ inactive', 'ZZ', 'FAILED', 4, now() - interval '1 hour');
  v_res := public.proc_run_reminders();
  update user_profiles set is_active = true where id = u_ps;
  v_log := public.zz_chk(v_log, 'retry: a failed reminder is sent by the next run', (select status from procurement_reminders where purchase_request_id = v_id and cycle_key = 'zz-retry') = 'SENT'
    and (select count(*) from notifications where recipient_id = u_ph and title_en = 'ZZ retry me') = 1);
  v_log := public.zz_chk(v_log, 'retry: gives up after 5 attempts', (select status || ':' || attempts from procurement_reminders where purchase_request_id = v_id and cycle_key = 'zz-inactive') = 'GAVE_UP:5');
  v_log := public.zz_chk(v_log, 'delivery status is tracked and a failed phone push is retried',
    (select push_attempts from procurement_reminders where id = v_rem) = 1 and (select push_status from procurement_reminders where id = v_rem) = 'retrying');
  v_log := public.zz_chk(v_log, 'each run is logged', (select count(*) from procurement_reminder_runs where finished_at is not null and orders_checked >= 1) >= 1 and (v_res->>'errors')::int = 0);

  ---------------------------------------------------------------- department visibility, expected-date change
  perform public.zz_as(u_ps); set local role authenticated;
  perform public.proc_update_progress(v_id, 'DELAYED', 'Vendor short of stock');
  perform public.proc_amend_order(v_id, jsonb_build_object('expected_delivery_date', v_day + 4), 'Vendor restock on Thursday');
  reset role;
  v_log := public.zz_chk(v_log, 'the requester is alerted when the expected delivery date changes',
    (select count(*) from notifications where recipient_id = u_e and entity_id = v_id and title_en like 'Expected delivery changed%' || to_char(v_day + 4, 'DD-MM-YYYY') || '%') = 1);
  perform public.zz_as(u_e); set local role authenticated;
  select * into v_ctx from public.proc_request_context(array[v_id]);
  v_log := public.zz_chk(v_log, 'the department sees expected delivery, delay reason, assigned staff and the latest update',
    v_ctx.expected_delivery_date = v_day + 4 and v_ctx.delay_reason = 'Vendor short of stock' and v_ctx.assigned_to_name = 'ZZ Procurement Staff'
    and v_ctx.latest_update like '%Amended: Vendor restock on Thursday');
  select count(*) into n from procurement_reminders where purchase_request_id = v_id;
  v_log := public.zz_chk(v_log, 'a requester does not see Procurement''s reminder history', n = 0);
  begin perform public.proc_run_reminders(); v_log := public.zz_chk(v_log, 'staff cannot run the reminder job directly', false);
  exception when others then v_log := public.zz_chk(v_log, 'staff cannot run the reminder job directly', sqlerrm ilike '%permission denied%'); end;
  begin perform public.proc_run_reminders_now(); v_log := public.zz_chk(v_log, 'staff cannot use "Run now"', false);
  exception when others then v_log := public.zz_chk(v_log, 'staff cannot use "Run now"', sqlerrm ilike '%Procurement Head or Management%'); end;
  -- A direct write either errors (guard) or matches no row (RLS allows writes to legacy rows only); either way nothing changes.
  begin update purchase_requests set proc_assigned_to = u_e where id = v_id; exception when others then null; end;
  begin perform public.proc_set_holiday(v_day + 30, 'ZZ', false); v_log := public.zz_chk(v_log, 'staff cannot set holidays', false);
  exception when others then v_log := public.zz_chk(v_log, 'staff cannot set holidays', true); end;
  reset role;
  v_log := public.zz_chk(v_log, 'assignment cannot be changed directly', (select proc_assigned_to from purchase_requests where id = v_id) = u_ps);
  perform public.zz_as(u_ph); set local role authenticated;
  begin
    perform public.proc_set_holiday(v_day + 30, 'ZZ Festival', false);
    perform public.proc_set_reminder_settings(true, '{1,2,3,4,5,6,7}', '00:00', '23:59:59');
    v_res := public.proc_reminder_overview();
    v_log := public.zz_chk(v_log, 'the Procurement Head manages holidays and sees the schedule and last run',
      v_res->'holidays' @> jsonb_build_array(jsonb_build_object('date', v_day + 30, 'name', 'ZZ Festival')) and (v_res->>'schedule_active')::boolean
      and v_res->'last_run' is not null and v_res->>'head_name' = 'ZZ Procurement Head');
  exception when others then v_log := public.zz_chk(v_log, 'head settings: ' || sqlerrm, false); end;
  begin perform public.proc_assign_request(v_id, u_e); v_log := public.zz_chk(v_log, 'orders can only be assigned to Procurement staff', false);
  exception when others then v_log := public.zz_chk(v_log, 'orders can only be assigned to Procurement staff', sqlerrm ilike '%Procurement staff%'); end;
  select count(*) into n from procurement_reminders where purchase_request_id = v_id;
  v_log := public.zz_chk(v_log, 'Procurement sees the reminder history', n > 0);

  ---------------------------------------------------------------- 9. delivered: due-date reminders stop
  perform public.proc_mark_delivered(v_id, v_day, null);
  reset role;
  select count(*) into n from procurement_reminders where purchase_request_id = v_id;
  update purchase_requests set required_by_date = v_day - 9 where id = v_id;
  perform public.proc_check_order_reminders(v_id);
  perform public.proc_run_reminders();
  v_log := public.zz_chk(v_log, '9  once delivered, no more due-date or overdue reminders', (select count(*) from procurement_reminders where purchase_request_id = v_id) = n);

  ---------------------------------------------------------------- 10. server-side schedule
  v_log := public.zz_chk(v_log, '10 pg_cron runs the reminder job every 15 minutes (no browser needed)',
    exists (select 1 from cron.job where jobname = 'procurement-order-reminders' and schedule = '*/15 * * * *' and active
              and command ilike '%proc_run_reminders()%'));

  raise exception E'\n%', v_log;
end $t$;
