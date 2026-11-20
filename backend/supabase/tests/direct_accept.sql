-- Procurement takes orders directly (v3_11): no Department Head approval needed. Own fixtures; ALWAYS rolls back.

do $t$
declare
  v_log text := ''; n int; v_day date; v_id uuid; v_id2 uuid; v_eid uuid; v_task uuid; v_res jsonb;
  r_emp uuid; r_head uuid; d_mkt uuid; d_proc uuid; d_ret uuid;
  u_e uuid := gen_random_uuid(); u_h uuid := gen_random_uuid(); u_p1 uuid := gen_random_uuid(); u_p2 uuid := gen_random_uuid();
  u_ph uuid := gen_random_uuid(); u_r uuid := gen_random_uuid();
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_as(p_user uuid) returns void language plpgsql as $f$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true); end $f$;
  v_day := public.proc_today_ist();
  select id into r_emp from roles where code = 'employee';
  select id into r_head from roles where code = 'dept_head';
  select id into d_mkt from departments where code = 'MARKETING';
  select id into d_proc from departments where code = 'PROCUREMENT';
  select id into d_ret from departments where code = 'RETAIL';
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_e, u_h, u_p1, u_p2, u_ph, u_r]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_e, 'ZZ-DA-E', 'ZZ Marketing Employee', r_emp, d_mkt, '9888800001', false, true),
    (u_h, 'ZZ-DA-H', 'ZZ Marketing Head', r_head, d_mkt, '9888800002', false, true),
    (u_p1, 'ZZ-DA-1', 'ZZ Procurement One', r_emp, d_proc, '9888800003', false, true),
    (u_p2, 'ZZ-DA-2', 'ZZ Procurement Two', r_emp, d_proc, '9888800004', false, true),
    (u_ph, 'ZZ-DA-P', 'ZZ Procurement Head', r_head, d_proc, '9888800005', false, true),
    (u_r, 'ZZ-DA-R', 'ZZ Retail Employee', r_emp, d_ret, '9888800006', false, true);
  update procurement_settings set primary_head_user_id = u_ph where id;

  ---------------------------------------------------------------- raised -> Procurement sees it at once
  perform public.zz_as(u_e); set local role authenticated;
  v_id := (public.proc_create_order(jsonb_build_object('form_type', 'RETAIL', 'client_name', 'ZZ Client', 'required_completion_date', v_day + 10,
    'delivery_location', 'ahmdabad', 'priority', 'HIGH'), '[{"item_code":"kjau","description":"Standee","qty_size":"5 nos"}]')).id;
  reset role;
  select id into v_task from staff_tasks where purchase_request_id = v_id;
  perform public.zz_as(u_p2); set local role authenticated;
  select count(*) into n from staff_task_scope_v where id = v_task and scope_mine;
  v_log := public.zz_chk(v_log, 'a Procurement employee sees the new order in My Tasks before any Department Head approval',
    n = 1 and (select can_accept and stage = 'OPEN' from public.proc_order_task_info(array[v_id])));
  reset role;

  ---------------------------------------------------------------- who may not take it
  perform public.zz_as(u_e); set local role authenticated;
  begin perform public.proc_accept_order_task(v_id); v_log := public.zz_chk(v_log, 'the requester cannot accept it', false);
  exception when others then v_log := public.zz_chk(v_log, 'the requester cannot accept it', sqlerrm ilike '%Only Procurement staff%'); end;
  reset role;
  perform public.zz_as(u_r); set local role authenticated;
  begin perform public.proc_accept_order_task(v_id); v_log := public.zz_chk(v_log, 'another department''s employee cannot accept it', false);
  exception when others then v_log := public.zz_chk(v_log, 'another department''s employee cannot accept it', true); end;
  reset role;

  ---------------------------------------------------------------- a Procurement employee takes it directly
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.staff_accept_task(v_task);
  exception when others then v_log := public.zz_chk(v_log, 'direct accept: ' || sqlerrm, false); end;
  reset role;
  v_log := public.zz_chk(v_log, 'accepted without Department Head approval: Accepted, assigned to that employee, IN PROGRESS',
    (select proc_status from purchase_requests where id = v_id) = 'ACCEPTED_BY_PROCUREMENT' and (select proc_decided_by from purchase_requests where id = v_id) = u_p1
    and (select assigned_to = u_p1 and accepted_by = u_p1 from staff_tasks where id = v_task)
    and (select sm.code from staff_tasks t join status_master sm on sm.id = t.status_id where t.id = v_task) = 'IN_PROGRESS'
    and (select sent_to_procurement_at is not null and proc_assigned_to = u_p1 from purchase_requests where id = v_id));
  v_log := public.zz_chk(v_log, 'history says it was taken without Department Head approval',
    (select count(*) from purchase_request_status_history where purchase_request_id = v_id and from_status = 'PENDING_DEPT_APPROVAL'
       and to_status = 'ACCEPTED_BY_PROCUREMENT' and remarks like 'Accepted directly by ZZ Procurement One%Department Head approval not required') = 1);
  v_log := public.zz_chk(v_log, 'the department''s Head and the requester are told',
    (select count(*) from notifications where entity_id = v_id and recipient_id = u_h and title_en like '%taken directly; your approval was not needed%') = 1
    and (select count(*) from notifications where entity_id = v_id and recipient_id = u_e and title_en like 'Procurement accepted your order%') = 1);
  perform public.zz_as(u_p2); set local role authenticated;
  begin perform public.proc_accept_order_task(v_id); v_log := public.zz_chk(v_log, 'a second employee cannot take it', false);
  exception when others then v_log := public.zz_chk(v_log, 'a second employee cannot take it', sqlerrm ilike '%already accepted by ZZ Procurement One%'); end;
  reset role;
  perform public.zz_as(u_h); set local role authenticated;
  begin perform public.proc_dept_decision(v_id, 'APPROVE', null); v_log := public.zz_chk(v_log, 'the Head''s approval is no longer needed (and no longer possible)', false);
  exception when others then v_log := public.zz_chk(v_log, 'the Head''s approval is no longer needed (and no longer possible)', sqlerrm ilike '%not waiting for department approval%'); end;
  reset role;
  perform public.zz_as(u_p1); set local role authenticated;
  begin v_res := public.proc_record_order_print(v_id, 'PRINT');
        v_log := public.zz_chk(v_log, 'the employee prints the order form straight away', (select proc_status from purchase_requests where id = v_id) = 'DOCUMENT_GENERATED');
  exception when others then v_log := public.zz_chk(v_log, 'print: ' || sqlerrm, false); end;
  reset role;

  ---------------------------------------------------------------- the Head can still act until Procurement takes it
  perform public.zz_as(u_e); set local role authenticated;
  v_id2 := (public.proc_create_order(jsonb_build_object('form_type', 'RETAIL', 'client_name', 'ZZ Client 2', 'required_completion_date', v_day + 10,
    'delivery_location', 'Office'), '[{"description":"Banner","qty_size":"2 nos"}]')).id;
  reset role;
  perform public.zz_as(u_h); set local role authenticated; perform public.proc_dept_decision(v_id2, 'REJECT', 'ZZ not this month'); reset role;
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.proc_accept_order_task(v_id2); v_log := public.zz_chk(v_log, 'an order the Head rejected cannot be taken', false);
  exception when others then v_log := public.zz_chk(v_log, 'an order the Head rejected cannot be taken', sqlerrm ilike '%not with Procurement%'); end;
  reset role;

  ---------------------------------------------------------------- emergency orders still go to Management first
  perform public.zz_as(u_e); set local role authenticated;
  v_eid := (public.proc_create_order(jsonb_build_object('form_type', 'RETAIL', 'client_name', 'ZZ Client 3', 'required_completion_date', v_day + 2,
    'delivery_location', 'Office', 'priority', 'EMERGENCY', 'urgency_reason', 'ZZ event tomorrow'), '[{"description":"Flex","qty_size":"1"}]')).id;
  reset role;
  perform public.zz_as(u_p1); set local role authenticated;
  begin perform public.proc_accept_order_task(v_eid); v_log := public.zz_chk(v_log, 'an emergency order still needs Management first', false);
  exception when others then v_log := public.zz_chk(v_log, 'an emergency order still needs Management first', sqlerrm ilike '%not with Procurement%'); end;
  reset role;

  raise exception E'\n%', v_log;
end $t$;
