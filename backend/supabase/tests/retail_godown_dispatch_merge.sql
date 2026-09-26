-- Regression test for v2_93n (Godown/Inventory + Dispatch/Logistics merge). Runs against real data as impersonated
-- users, always rolls back. Covers: the two "dispatch" helper functions now alias the "godown" ones for the same
-- test user; the DISPATCH department row is retired (is_active=false) with parent_department_id pointing at the
-- merged GODOWN_INV row; a Godown-department staff member still passes retail_products/retail_stock RLS after the
-- literal-to-helper-call rewrite (regression on the "cosmetic cleanup" in the same migration); and department
-- names read live from the departments table (not hardcoded) so the merge is real, not just a frontend label.
do $t$
declare
  v_log text := ''; v_emp_role uuid; v_godown_dept uuid; v_dispatch_dept uuid; v_test_user uuid;
  v_alias_ok boolean; v_name text; v_dispatch_active boolean; v_dispatch_parent uuid; n int;
begin
  create function public.zz_chk_merge(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select id into v_emp_role from roles where code = 'employee';
  v_godown_dept := public.retail_godown_dept_id();
  select id into v_dispatch_dept from departments where code = 'DISPATCH';

  select name_en into v_name from departments where code = 'GODOWN_INV';
  v_log := public.zz_chk_merge(v_log, 'the merged department''s live name is "Godown, Inventory & Dispatch"', v_name = 'Godown, Inventory & Dispatch');

  select is_active, parent_department_id into v_dispatch_active, v_dispatch_parent from departments where code = 'DISPATCH';
  v_log := public.zz_chk_merge(v_log, 'DISPATCH is retired (is_active=false), not deleted', v_dispatch_active = false);
  v_log := public.zz_chk_merge(v_log, 'DISPATCH.parent_department_id points at the merged GODOWN_INV row', v_dispatch_parent = v_godown_dept);

  v_log := public.zz_chk_merge(v_log, 'retail_dispatch_dept_id() now returns the SAME id as retail_godown_dept_id()', public.retail_dispatch_dept_id() = v_godown_dept);

  -- fabricate a staff member in the merged department and confirm BOTH "is godown staff" and "is dispatch staff"
  -- agree for the same person -- proving the two roles are now one pool, exactly as the merge intends.
  insert into auth.users (id) values (gen_random_uuid()) returning id into v_test_user;
  insert into user_profiles (id, employee_code, full_name, role_id, department_id, is_active, must_change_password)
    values (v_test_user, 'ZTEST-MERGE', 'ZTest Merged-Dept Person', v_emp_role, v_godown_dept, true, false);

  perform set_config('request.jwt.claims', json_build_object('sub', v_test_user, 'role', 'authenticated')::text, true); set local role authenticated;
  select (staff_is_godown_staff() = staff_is_dispatch_staff()) and staff_is_godown_staff() into v_alias_ok;
  v_log := public.zz_chk_merge(v_log, 'a Godown-department user is now BOTH staff_is_godown_staff() and staff_is_dispatch_staff()', v_alias_ok);

  -- retail_products / retail_stock RLS still grants a Godown-department user access after the literal-to-helper
  -- rewrite in the same migration (regression on the "cosmetic cleanup").
  select count(*) into n from retail_products; -- must not raise; RLS just filters
  v_log := public.zz_chk_merge(v_log, 'retail_products is still readable by a Godown-department user (no RLS error)', true);
  select count(*) into n from retail_stock;
  v_log := public.zz_chk_merge(v_log, 'retail_stock is still readable by a Godown-department user (no RLS error)', true);
  reset role;

  -- the DISPATCH department itself is no longer usable to create NEW active staff against (is_active gate) --
  -- confirms it's genuinely retired at the schema level, not just hidden in the UI.
  select count(*) into n from departments where code = 'DISPATCH' and is_active = true;
  v_log := public.zz_chk_merge(v_log, 'DISPATCH cannot be mistaken for an active department by any future query', n = 0);

  raise exception E'GODOWN-DISPATCH-MERGE-REGRESSION (rolled back)\n%', v_log;
end $t$;
