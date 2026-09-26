-- v2_93j3 -- hotfix: v2_93j2's retail_orders_select policy referenced retail_godown_handovers/retail_dispatch_records directly via
-- EXISTS, and THOSE tables' own SELECT policies reference retail_orders back via EXISTS -- Postgres detected the cycle live
-- ("infinite recursion detected in policy for relation retail_orders") the moment any retail_orders row was touched. Fixed by
-- routing the check through a SECURITY DEFINER helper: its internal lookups run as the table owner, which is exempt from RLS on
-- these tables (relforcerowsecurity is off everywhere in this schema), so the cycle never re-enters retail_orders' own policy --
-- exactly the same bypass-by-design every other *_can_access_* helper in this module already relies on.
create or replace function public.retail_order_pipeline_staff_visible(p_order_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select (public.staff_is_godown_staff() and exists (select 1 from public.retail_godown_handovers h where h.order_id = p_order_id))
      or (public.staff_is_dispatch_staff() and exists (select 1 from public.retail_dispatch_records dr where dr.order_id = p_order_id));
$$;
revoke all on function public.retail_order_pipeline_staff_visible(uuid) from public, anon;
grant execute on function public.retail_order_pipeline_staff_visible(uuid) to authenticated;

drop policy if exists retail_orders_select_scoped on public.retail_orders;
create policy retail_orders_select_scoped on public.retail_orders for select to authenticated using (
  staff_current_user_ok() and (
    created_by = auth.uid() or retail_can_access_customer(customer_id)
    or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(department_id))
    or (staff_is_accounts_head() and department_id = staff_current_department_id())
    or retail_order_pipeline_staff_visible(id)));
