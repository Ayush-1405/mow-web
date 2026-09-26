-- Regression test for the v2_93g hotfix to retail_record_followup(). Runs against real data as impersonated users, always rolls back.
-- BUG 1 (auth bypass): an unrelated employee could record a follow-up on ANY lead whose assigned_to had been cleared to NULL (a real,
-- reachable state via RetailLeads.jsx's "Assign To: —" option), because `NULL or false or false` is SQL NULL, not false, and PL/pgSQL's
-- `if not (...)` treats a NULL condition as "don't raise". BUG 2 (crash + data loss): marking a follow-up WON/LOST/NOT_RESPONDING (which
-- legitimately needs no next follow-up date) crashed with "record v_task is not assigned yet" and rolled back the whole follow-up.
do $t$
declare
  v_log text := ''; v_owner uuid; v_stranger uuid; v_lead record; v_lead2 record; v_errmsg text; v_res record; n int;
begin
  create function public.zz_chk5(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select up.id into v_owner from user_profiles up join roles r on r.id=up.role_id where up.department_id=public.retail_dept_id() and r.code='employee' and up.is_active limit 1;
  select up.id into v_stranger from user_profiles up join roles r on r.id=up.role_id where up.department_id<>public.retail_dept_id() and r.code='employee' and up.is_active and up.department_id is not null limit 1;
  v_log := public.zz_chk5(v_log, 'fixture: owner + unrelated stranger found', v_owner is not null and v_stranger is not null);

  -- BUG 1: unassigned lead, unrelated stranger
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_lead from retail_create_walkin('ZHOTFIX Unassigned', '9667788991', null, null, null, null, null, null, null, null, null, 'walkin', null, 'RETAIL', null, 'WARM', null);
  update retail_leads set assigned_to = null where id = v_lead.lead_id;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_stranger, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    perform retail_record_followup(v_lead.lead_id, 'CALL', null, null, null, null, null, null, null, now() + interval '1 day', 'WON', null);
  exception when others then v_errmsg := SQLERRM; end;
  reset role;
  v_log := public.zz_chk5(v_log, 'unrelated employee is blocked from an unassigned lead they have no connection to', v_errmsg = 'Not authorized to record a follow-up on this lead');

  select count(*) into n from retail_followups where lead_id = v_lead.lead_id;
  v_log := public.zz_chk5(v_log, 'the blocked attempt truly wrote nothing', n = 0);

  -- BUG 2: legit owner marks WON/LOST/NOT_RESPONDING with no next follow-up date
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_lead2 from retail_create_walkin('ZHOTFIX Won Path', '9667788992', null, null, null, null, null, null, null, null, null, 'walkin', v_owner, 'RETAIL', null, 'WARM', null);

  v_errmsg := null;
  select * into v_res from retail_record_followup(v_lead2.lead_id, 'CALL', null, null, null, null, null, null, null, null, 'WON', null);
  v_log := public.zz_chk5(v_log, 'marking WON with no next date succeeds (no crash)', v_res.followup_id is not null);
  v_log := public.zz_chk5(v_log, 'no reminder task is created for a closed-out WON follow-up', v_res.task_id is null);

  select count(*) into n from retail_followups where lead_id = v_lead2.lead_id and status = 'WON';
  v_log := public.zz_chk5(v_log, 'the WON follow-up row actually persisted (not rolled back)', n = 1);

  -- LOST and NOT_RESPONDING take the same skipped-task code path -- confirm both too
  v_errmsg := null;
  begin
    perform retail_record_followup(v_lead2.lead_id, 'CALL', null, null, null, null, null, null, null, null, 'LOST', 'Bought elsewhere');
  exception when others then v_errmsg := SQLERRM; end;
  v_log := public.zz_chk5(v_log, 'marking LOST with no next date succeeds (no crash)', v_errmsg is null);

  begin
    perform retail_record_followup(v_lead2.lead_id, 'CALL', null, null, null, null, null, null, null, null, 'NOT_RESPONDING', null);
  exception when others then v_errmsg := SQLERRM; end;
  v_log := public.zz_chk5(v_log, 'marking NOT_RESPONDING with no next date succeeds (no crash)', v_errmsg is null);
  reset role;

  raise exception E'FOLLOWUP-HOTFIX-REGRESSION (rolled back)\n%', v_log;
end $t$;
