-- Regression test for v2_93h (salesperson-wise customer ownership). Runs against real data as impersonated users, always rolls back.
-- Fabricates temporary auth.users/user_profiles fixture rows for every plain salesperson it needs (the live pilot only has 2 active
-- Retail accounts today, one of them a dept_head) -- inserted and used only inside this same rolled-back transaction, never persisted.
-- Real accounts are used only for the two elevated-role checks (an actual dept_head, an actual management user).
--
-- Covers: creator/owner visibility, an unrelated colleague in the SAME department cannot see the customer (the actual bug this
-- migration fixes), the real Retail dept_head and management both see it anyway, a PERMANENT transfer changes the owner and is
-- fully logged while existing child rows (leads) keep pointing at the same customer, the new owner gains visibility through that
-- link, duplicate detection withholds contact details from someone with no access but still names the owner, a BACKUP grant lets a
-- third person see and act, someone outside the department stays blocked even after all that, and merge repoints every child row
-- and is idempotent.
do $t$
declare
  v_log text := ''; v_a uuid; v_stranger uuid; v_b uuid; v_c uuid; v_d uuid; v_mgmt uuid; v_dept_head uuid;
  v_emp_role uuid; v_retail_dept uuid; v_other_dept uuid;
  v_lead record; v_customer_id uuid; v_n int; v_row record; v_res record; v_dup_id uuid; v_errmsg text;
begin
  create function public.zz_chk7(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select id into v_emp_role from roles where code = 'employee';
  v_retail_dept := public.retail_dept_id();
  select id into v_other_dept from departments where code not in ('RETAIL') and is_confidential_domain = false limit 1;
  select up.id into v_dept_head from user_profiles up join roles r on r.id = up.role_id where up.department_id = v_retail_dept and r.code = 'dept_head' and up.is_active limit 1;
  select up.id into v_mgmt from user_profiles up join roles r on r.id = up.role_id where r.code = 'management' and up.is_active limit 1;

  -- A, Stranger, B, C are all fabricated plain 'employee'-role Retail salespeople, so this test is never at the mercy of how many
  -- real Retail accounts happen to exist (or what role they hold) in the live pilot.
  insert into auth.users (id) values (gen_random_uuid()) returning id into v_a;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password) values (v_a, 'ZTEST-A', 'ZTest Owner Person', v_emp_role, v_retail_dept, true, false);
  insert into auth.users (id) values (gen_random_uuid()) returning id into v_stranger;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password) values (v_stranger, 'ZTEST-S', 'ZTest Stranger Colleague', v_emp_role, v_retail_dept, true, false);
  insert into auth.users (id) values (gen_random_uuid()) returning id into v_b;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password) values (v_b, 'ZTEST-B', 'ZTest New Owner', v_emp_role, v_retail_dept, true, false);
  insert into auth.users (id) values (gen_random_uuid()) returning id into v_c;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password) values (v_c, 'ZTEST-C', 'ZTest Backup Person', v_emp_role, v_retail_dept, true, false);
  insert into auth.users (id) values (gen_random_uuid()) returning id into v_d;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password) values (v_d, 'ZTEST-D', 'ZTest Outsider Person', v_emp_role, v_other_dept, true, false);

  v_log := public.zz_chk7(v_log, 'fixture: A/Stranger/B/C (fabricated Retail employees), D (fabricated outsider), a real dept_head and a real management user all resolved',
    v_a is not null and v_stranger is not null and v_b is not null and v_c is not null and v_d is not null and v_dept_head is not null and v_mgmt is not null);

  -- Salesperson A creates a walk-in -> becomes the owner.
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_lead from retail_create_walkin('ZOWN CustomerA', '9001100011', null, null, 'Surat', null, null, null, null, null, null, 'walkin', v_a, 'RETAIL', null, 'WARM', null);
  v_customer_id := v_lead.customer_id;
  select count(*) into v_n from retail_customers where id = v_customer_id and owner_salesperson_id = v_a;
  v_log := public.zz_chk7(v_log, 'walk-in creator becomes owner_salesperson_id', v_n = 1);
  select count(*) into v_n from retail_customer_ownership_log where customer_id = v_customer_id and action = 'CREATED';
  v_log := public.zz_chk7(v_log, 'a CREATED ownership-log row was written', v_n = 1);
  select count(*) into v_n from retail_customers where id = v_customer_id;
  v_log := public.zz_chk7(v_log, 'owner can see their own new customer', v_n = 1);
  reset role;

  -- A plain colleague, same department, no relation to this customer -- must NOT see it. This is the actual bug this migration fixes.
  perform set_config('request.jwt.claims', json_build_object('sub', v_stranger, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*) into v_n from retail_customers where id = v_customer_id;
  v_log := public.zz_chk7(v_log, 'an unrelated colleague in the SAME department cannot see the customer', v_n = 0);
  select count(*) into v_n from retail_leads where id = v_lead.lead_id;
  v_log := public.zz_chk7(v_log, 'an unrelated colleague cannot see the linked lead either', v_n = 0);
  reset role;

  -- The real Retail dept_head and a real management user both see it anyway (oversight, unaffected by ownership).
  perform set_config('request.jwt.claims', json_build_object('sub', v_dept_head, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*) into v_n from retail_customers where id = v_customer_id;
  v_log := public.zz_chk7(v_log, 'the Retail Head (dept_head) can see any Retail customer', v_n = 1);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_mgmt, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*) into v_n from retail_customers where id = v_customer_id;
  v_log := public.zz_chk7(v_log, 'management can see any Retail customer', v_n = 1);
  reset role;

  -- A permanently transfers the customer to B.
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_res from retail_transfer_customer(v_customer_id, v_b, 'PERMANENT', current_date, null, 'Territory realignment');
  v_log := public.zz_chk7(v_log, 'permanent transfer sets the new owner', v_res.owner_salesperson_id = v_b and v_res.previous_owner_id = v_a);
  reset role;

  select count(*) into v_n from retail_customer_ownership_log where customer_id = v_customer_id and action = 'TRANSFERRED' and previous_owner_id = v_a and new_owner_id = v_b;
  v_log := public.zz_chk7(v_log, 'the transfer is permanently logged with old and new owner', v_n = 1);
  select count(*) into v_n from retail_leads where id = v_lead.lead_id and customer_id = v_customer_id;
  v_log := public.zz_chk7(v_log, 'the existing lead still points at the SAME customer after transfer (nothing silently re-linked)', v_n = 1);

  -- B is now the owner -- gains visibility to both the customer and the (still assigned_to=A) lead, purely through customer ownership.
  perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*) into v_n from retail_customers where id = v_customer_id;
  v_log := public.zz_chk7(v_log, 'the new owner can now see the customer', v_n = 1);
  select count(*) into v_n from retail_leads where id = v_lead.lead_id;
  v_log := public.zz_chk7(v_log, 'the new owner can now see the pre-existing lead via customer ownership', v_n = 1);
  reset role;

  -- Duplicate detection: C (no access) checks the same phone -- gets a match, the owner's NAME, but no contact details.
  perform set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_row from retail_check_duplicate_customer('ZOWN CustomerA', '9001100011') limit 1;
  v_log := public.zz_chk7(v_log, 'duplicate check finds the match by phone', v_row.match_reason = 'PHONE' and v_row.customer_id = v_customer_id);
  v_log := public.zz_chk7(v_log, 'duplicate check names the owner but withholds phone from someone with no access', v_row.owner_id = v_b and v_row.can_view_contact = false and v_row.phone is null);
  reset role;

  -- B grants C a BACKUP role.
  perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true); set local role authenticated;
  perform retail_transfer_customer(v_customer_id, v_c, 'BACKUP', current_date, null, 'Covering while B is on leave');
  reset role;

  -- C now has real write access -- can record a follow-up on A's original lead, which C has no other connection to.
  perform set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true); set local role authenticated;
  v_errmsg := null;
  begin
    select * into v_res from retail_record_followup(v_lead.lead_id, 'CALL', 'Backup coverage call', null, null, null, null, null, null, null, 'CONTACTED', null);
  exception when others then v_errmsg := sqlerrm; end;
  v_log := public.zz_chk7(v_log, 'a BACKUP grant lets a third person record a follow-up they would otherwise be blocked from', v_errmsg is null);
  select count(*) into v_n from retail_customers where id = v_customer_id;
  v_log := public.zz_chk7(v_log, 'the BACKUP grant also gives read access to the customer itself', v_n = 1);
  reset role;

  -- D has no relation whatsoever (different department entirely) -- still fully blocked, even after all the above.
  perform set_config('request.jwt.claims', json_build_object('sub', v_d, 'role', 'authenticated')::text, true); set local role authenticated;
  select count(*) into v_n from retail_customers where id = v_customer_id;
  v_log := public.zz_chk7(v_log, 'an unrelated employee in a different department still sees nothing', v_n = 0);
  v_errmsg := null;
  begin
    perform retail_record_followup(v_lead.lead_id, 'CALL', null, null, null, null, null, null, null, null, 'CONTACTED', null);
    v_log := public.zz_chk7(v_log, 'an unrelated employee cannot record a follow-up', false);
  exception when others then
    v_log := public.zz_chk7(v_log, 'an unrelated employee cannot record a follow-up', true);
  end;
  reset role;

  -- Merge: management merges a genuine duplicate customer into the primary; every child row repoints; the duplicate is soft-merged.
  -- (raw INSERT here, not RETURNING: a STABLE, self-referencing RLS policy function on retail_customers cannot see a row inserted by
  -- the SAME statement, so `INSERT ... RETURNING` as a non-owner role would spuriously fail here -- irrelevant to real app code, which
  -- only ever creates customers via the retail_upsert_customer RPC, running as the table owner and so exempt from RLS entirely.)
  v_dup_id := gen_random_uuid();
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgmt, 'role', 'authenticated')::text, true); set local role authenticated;
  insert into retail_customers (id, full_name, phone, normalized_phone, city, created_by, owner_salesperson_id, ownership_status, ownership_started_at)
  values (v_dup_id, 'ZOWN CustomerA Dup', '9001100099', '9001100099', 'Surat', v_mgmt, v_mgmt, 'OWNED', now());
  update retail_leads set customer_id = v_dup_id where id = v_lead.lead_id; -- simulate a lead that got attached to the wrong (duplicate) customer

  select * into v_res from retail_merge_customers(v_customer_id, v_dup_id, 'Confirmed same person, duplicate walk-in entry');
  select count(*) into v_n from retail_leads where id = v_lead.lead_id and customer_id = v_customer_id;
  v_log := public.zz_chk7(v_log, 'merge repoints the lead back to the primary customer', v_n = 1);
  select count(*) into v_n from retail_customers where id = v_dup_id and merged_into_id = v_customer_id and ownership_status = 'MERGED' and is_active = false;
  v_log := public.zz_chk7(v_log, 'the duplicate is soft-merged, not deleted', v_n = 1);

  select * into v_res from retail_merge_customers(v_customer_id, v_dup_id, 'retry');
  select count(*) into v_n from retail_customer_ownership_log where customer_id = v_customer_id and action = 'MERGED';
  v_log := public.zz_chk7(v_log, 'retrying the merge is idempotent (still exactly one MERGED log row)', v_n = 1);
  reset role;

  raise exception E'OWNERSHIP-REGRESSION (rolled back)\n%', v_log;
end $t$;
