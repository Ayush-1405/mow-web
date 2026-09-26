-- Regression test for retail_approve_quotation() (mvp_pilot_retail_workflow_v2_93f.sql). Runs against real data as impersonated users,
-- always rolls back. Covers: a quotation flagged internal_approval_required=true starts unapproved; a plain sales employee (not
-- dept-head/management/global-oversight) CANNOT approve it (this caught a real NULL-vs-false three-valued-logic auth bypass during
-- development -- see the coalesce() wrapping in the migration -- so this check is load-bearing, not decorative); management CAN approve;
-- approving is idempotent (retrying does not change the recorded approver); exactly one audit row is written, not one per retry.
do $t$
declare
  v_log text := ''; v_sales uuid; v_mgmt uuid; v_lead record; v_quote public.retail_quotations; v_res public.retail_quotations; n int;
begin
  create function public.zz_chk6(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select up.id into v_sales from user_profiles up join roles r on r.id=up.role_id where up.department_id=public.retail_dept_id() and r.code='employee' and up.is_active limit 1;
  select up.id into v_mgmt from user_profiles up join roles r on r.id=up.role_id where r.code='management' and up.is_active limit 1;
  v_log := public.zz_chk6(v_log, 'fixture: sales + management found', v_sales is not null and v_mgmt is not null);

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_lead from retail_create_walkin('ZQA Approve Test', '9778899001', null, null, null, null, null, null, null, null, null, 'walkin', v_sales, 'RETAIL', null, 'WARM', null);
  v_quote := retail_create_quotation(v_lead.lead_id, 'ZQA Approve Test', '9778899001', null, current_date+10, current_date+20, 0, 0, null, true,
    jsonb_build_array(jsonb_build_object('item_name','Test Item','quantity',1,'unit_price',5000)), null);
  v_log := public.zz_chk6(v_log, 'quotation created with internal_approval_required=true, not yet approved', v_quote.internal_approval_required and v_quote.internal_approved_at is null);

  begin
    perform retail_approve_quotation(v_quote.id, true, null);
    v_log := public.zz_chk6(v_log, 'a plain sales employee cannot approve (load-bearing: caught a real NULL-bypass during dev)', false);
  exception when others then
    v_log := public.zz_chk6(v_log, 'a plain sales employee cannot approve (load-bearing: caught a real NULL-bypass during dev)', true);
  end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_mgmt, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_res from retail_approve_quotation(v_quote.id, true, 'looks good');
  v_log := public.zz_chk6(v_log, 'management can approve; approver/time now set', v_res.internal_approved_by = v_mgmt and v_res.internal_approved_at is not null);

  select * into v_res from retail_approve_quotation(v_quote.id, true, 'again');
  v_log := public.zz_chk6(v_log, 'retrying approval is idempotent (still the same approver)', v_res.internal_approved_by = v_mgmt);

  select count(*) into n from staff_audit_log where entity_type='retail_quotation' and entity_id=v_quote.id and action='APPROVE';
  v_log := public.zz_chk6(v_log, 'exactly one APPROVE audit row (retry did not write a second)', n = 1);
  reset role;

  raise exception E'QUOTATION-APPROVAL-REGRESSION (rolled back)\n%', v_log;
end $t$;
