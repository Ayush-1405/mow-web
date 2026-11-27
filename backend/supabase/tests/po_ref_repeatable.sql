-- v3_34 The same vendor PO / reference number can be used on more than one order (vendors reuse one reference for a day's orders).
-- A Procurement Head confirms two different requests with the same PO / reference; both are saved and each keeps its own order.
-- The rest of the confirm checks still apply (a PO / reference is still required). Own fixtures; ALWAYS rolls back.
do $t$
declare
  v_log text := ''; msg text; pr1 uuid; pr2 uuid; pr3 uuid; r_head uuid; d_proc uuid; d_int uuid;
  u_head uuid := gen_random_uuid(); u_req uuid := gen_random_uuid(); r_emp uuid;
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;
  create function public.zz_confirm(p_user uuid, p_id uuid, p_po text) returns text language plpgsql as $f$
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal1')::text, true);
      set local role authenticated;
      perform public.proc_confirm_order(p_id, 'ZZ Vendor', '9888880399', 'Q-1', p_po, current_date, 2, 1500, current_date + 5, '30 days', 'ok');
      reset role;
      return null;
    exception when others then
      reset role;
      return sqlerrm;
    end $f$;

  select id into r_head from roles where code = 'dept_head';
  select id into r_emp from roles where code = 'employee';
  select id into d_proc from departments where code = 'PROCUREMENT' limit 1;
  select id into d_int from departments where code = 'INTERIOR' limit 1;
  insert into auth.users (id, email, aud, role) select u, 'zz-' || u || '@test.invalid', 'authenticated', 'authenticated' from unnest(array[u_head, u_req]) u;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, phone, must_change_password, is_active) values
    (u_head, 'ZZ-PO-H', 'ZZ Procurement Head', r_head, d_proc, '9888880301', false, true),
    (u_req,  'ZZ-PO-R', 'ZZ Interior Staff',   r_emp,  d_int,  '9888880302', false, true);

  -- three requests ready to be placed (document printed)
  insert into purchase_requests (request_number, purchase_source, requester_user_id, requesting_department_id, request_date, status, proc_status,
                                 material_name, quantity, unit, required_by_date, priority)
  select 'ZZ-PO-' || i, 'Procurement', u_req, d_int, current_date, 'Procurement', 'DOCUMENT_GENERATED', 'ZZ item ' || i, 2, 'pcs', current_date + 5, 'NORMAL'
    from generate_series(1, 3) i;
  select id into pr1 from purchase_requests where request_number = 'ZZ-PO-1';
  select id into pr2 from purchase_requests where request_number = 'ZZ-PO-2';
  select id into pr3 from purchase_requests where request_number = 'ZZ-PO-3';
  insert into purchase_print_logs (purchase_request_id, document_type, document_version, action, printed_by)
  select x, 'PURCHASE_REQUEST', 1, 'PRINT_INITIATED', u_head from unnest(array[pr1, pr2, pr3]) x;

  msg := public.zz_confirm(u_head, pr1, 'Sep 05');
  v_log := public.zz_chk(v_log, 'first order placed with PO / ref "Sep 05" (' || coalesce(msg, 'ok') || ')', msg is null);
  msg := public.zz_confirm(u_head, pr2, 'Sep 05');
  v_log := public.zz_chk(v_log, 'a SECOND order can use the same PO / ref "Sep 05" (' || coalesce(msg, 'ok') || ')', msg is null);
  msg := public.zz_confirm(u_head, pr3, 'SEP 05');
  v_log := public.zz_chk(v_log, '... and a third, typed in capitals (' || coalesce(msg, 'ok') || ')', msg is null);
  v_log := public.zz_chk(v_log, 'each request has its own order, all placed',
    (select count(distinct purchase_request_id) from purchase_orders where lower(po_number) = 'sep 05' and purchase_request_id in (pr1, pr2, pr3)) = 3
    and (select count(*) from purchase_requests where id in (pr1, pr2, pr3) and proc_status = 'ORDER_PLACED') = 3);
  msg := public.zz_confirm(u_head, pr1, 'Sep 06');
  v_log := public.zz_chk(v_log, 'the same request still cannot be confirmed twice (' || coalesce(msg, 'it worked') || ')', msg ilike '%already been confirmed%');
  v_log := public.zz_chk(v_log, 'the unique PO index is gone; a search index remains',
    not exists (select 1 from pg_indexes where indexname = 'purchase_orders_po_number_idx')
    and exists (select 1 from pg_indexes where indexname = 'purchase_orders_po_number_search_idx'));

  raise exception E'\n%', v_log;
end $t$;
