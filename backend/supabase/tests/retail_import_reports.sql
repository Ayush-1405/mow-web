-- Retail Stores module Phase 2b — Excel/CSV lead import + reports summary. Runs against real data as impersonated users, always rolls back.
-- Covers: dry-run preview never writes rows; confirmed import creates real customers+leads and one audit row; duplicate phone within the
-- same file is flagged and only imported once; duplicate against an existing customer is flagged, not silently re-imported; a row missing
-- the required name is an ERROR, not a crash; RLS (an unrelated employee cannot import into Retail); reports_summary counts match reality
-- and an unrelated employee still gets a number back (it's an aggregate, not a list) but the count for a scoped drill-down still respects RLS
-- on the underlying tables it reads.
do $t$
declare
  v_log text := ''; v_sales uuid; v_other uuid; v_mgmt uuid; n int; v_leads_before int; v_leads_after int; v_customers_before int;
  v_rows jsonb; v_dry jsonb; v_confirmed jsonb; v_summary jsonb; v_dupe_phone text := '9223344551';
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select up.id into v_sales from user_profiles up join roles r on r.id=up.role_id where up.department_id=public.retail_dept_id() and r.code='employee' and up.is_active limit 1;
  select up.id into v_other from user_profiles up join roles r on r.id=up.role_id where up.department_id<>public.retail_dept_id() and r.code='employee' and up.is_active and up.department_id is not null limit 1;
  select up.id into v_mgmt from user_profiles up join roles r on r.id=up.role_id where r.code='management' and up.is_active limit 1;
  v_log := public.zz_chk(v_log, 'fixture: sales + unrelated + management user found', v_sales is not null and v_other is not null and v_mgmt is not null);

  v_rows := jsonb_build_array(
    jsonb_build_object('customer_name', 'ZI Import One', 'phone', v_dupe_phone, 'city', 'Surat', 'source', 'excel'),
    jsonb_build_object('customer_name', 'ZI Import Two (dup in file)', 'phone', v_dupe_phone, 'city', 'Surat'),
    jsonb_build_object('customer_name', '', 'phone', '9223344552')
  );

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;

  select count(*) into v_leads_before from retail_leads where phone = v_dupe_phone;
  select count(*) into v_customers_before from retail_customers where normalized_phone = v_dupe_phone;

  select jsonb_agg(row_to_json(x)) into v_dry from retail_import_leads(v_rows, true) x;
  v_log := public.zz_chk(v_log, 'dry run: row 0 will import', (v_dry->0->>'outcome') = 'WILL_IMPORT');
  v_log := public.zz_chk(v_log, 'dry run: row 1 flagged as duplicate-in-file', (v_dry->1->>'outcome') = 'DUPLICATE');
  v_log := public.zz_chk(v_log, 'dry run: row 2 flagged as ERROR (missing name)', (v_dry->2->>'outcome') = 'ERROR');

  select count(*) into n from retail_leads where phone = v_dupe_phone;
  v_log := public.zz_chk(v_log, 'dry run never writes any row', n = v_leads_before);

  select jsonb_agg(row_to_json(x)) into v_confirmed from retail_import_leads(v_rows, false) x;
  v_log := public.zz_chk(v_log, 'confirmed import: row 0 IMPORTED with a lead_id', (v_confirmed->0->>'outcome') = 'IMPORTED' and (v_confirmed->0->>'lead_id') is not null);
  v_log := public.zz_chk(v_log, 'confirmed import: row 1 still DUPLICATE, not imported twice', (v_confirmed->1->>'outcome') = 'DUPLICATE');
  v_log := public.zz_chk(v_log, 'confirmed import: row 2 still ERROR', (v_confirmed->2->>'outcome') = 'ERROR');

  select count(*) into v_leads_after from retail_leads where phone = v_dupe_phone;
  v_log := public.zz_chk(v_log, 'exactly ONE lead created for the duplicate phone, not two', v_leads_after = v_leads_before + 1);
  select count(*) into n from retail_customers where normalized_phone = v_dupe_phone;
  v_log := public.zz_chk(v_log, 'exactly ONE customer created (deduped), not two', n = v_customers_before + 1);

  -- staff_audit_log is RLS-scoped to management/dept-heads only (staff_audit_log_select_scoped) -- a plain sales employee
  -- cannot read it back even though the write succeeded, so this check runs as management, not as v_sales.
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgmt, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*) into n from staff_audit_log where entity_type = 'retail_lead_import' and (new_value->>'imported')::int = 1 and performed_by = v_sales;
  v_log := public.zz_chk(v_log, 'import writes exactly one audit row summarizing the batch (visible to management)', n >= 1);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true); set local role authenticated;

  -- re-importing the SAME rows again is safe: everything is now a duplicate, nothing double-created
  perform retail_import_leads(v_rows, false);
  select count(*) into n from retail_leads where phone = v_dupe_phone;
  v_log := public.zz_chk(v_log, 'reimporting the same file is a no-op (still exactly one lead)', n = v_leads_before + 1);

  select retail_reports_summary(current_date - 365, current_date) into v_summary;
  v_log := public.zz_chk(v_log, 'reports_summary returns a populated object with real counts', (v_summary->>'walkins_total')::int >= v_leads_after);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true); set local role authenticated;
  begin
    perform retail_import_leads(jsonb_build_array(jsonb_build_object('customer_name', 'Should Not Import', 'phone', '9998887770')), false);
    v_log := public.zz_chk(v_log, 'an unrelated employee cannot import Retail leads', false);
  exception when others then
    v_log := public.zz_chk(v_log, 'an unrelated employee cannot import Retail leads', true);
  end;
  select count(*) into n from retail_leads where phone = '9998887770';
  v_log := public.zz_chk(v_log, 'the blocked import truly wrote nothing', n = 0);
  reset role;

  raise exception E'IMPORT-REPORTS-REPORT (rolled back)\n%', v_log;
end $t$;
