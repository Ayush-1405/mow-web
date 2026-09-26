-- v2_93f -- Retail Stores module: quotation internal-approval workflow. internal_approval_required / internal_approved_by /
-- internal_approved_at already exist on retail_quotations (v2_93a) but had no RPC and no UI wired to them -- a quotation flagged as
-- needing internal approval could be silently accepted/converted to an order without anyone with authority ever approving it. This closes
-- that: retail_approve_quotation() is the only path that can set internal_approved_by/at, and it is restricted to Retail dept-head/
-- management/global-oversight, same authorization shape as every other retail RPC.
create or replace function public.retail_approve_quotation(p_quotation_id uuid, p_approved boolean, p_notes text default null)
returns public.retail_quotations language plpgsql security definer set search_path = public as $$
declare v_dept uuid := public.retail_dept_id(); v_row public.retail_quotations; v_old jsonb;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.retail_quotations where id = p_quotation_id and is_active for update;
  if v_row.id is null then raise exception 'Quotation not found'; end if;
  if not v_row.internal_approval_required then raise exception 'This quotation does not require internal approval'; end if;
  if v_row.internal_approved_at is not null then return v_row; end if; -- idempotent: already decided, no-op on retry

  -- NOTE: staff_is_management()/staff_is_dept_head()/staff_has_global_oversight() can return NULL (not false) for roles outside their
  -- mapping (staff_role_family() falls through to `else null`) -- under three-valued logic, `not (false or null)` is NULL, and a bare
  -- `if not (...) then raise` treats NULL as false and silently skips the exception. Every branch is coalesced to false here so the guard
  -- can never be bypassed this way.
  if not (coalesce(staff_has_global_oversight(), false)
          or (coalesce(staff_is_dept_head(), false) and coalesce(staff_dept_in_hod_scope(v_dept), false))
          or coalesce(staff_is_management(), false)) then
    raise exception 'Not authorized to approve Retail quotations';
  end if;

  v_old := to_jsonb(v_row);
  if p_approved then
    update public.retail_quotations set internal_approved_by = auth.uid(), internal_approved_at = now()
      where id = p_quotation_id returning * into v_row;
  else
    update public.retail_quotations set status = 'REJECTED' where id = p_quotation_id returning * into v_row;
  end if;

  perform public.staff_write_audit('retail_quotation', p_quotation_id, case when p_approved then 'APPROVE' else 'REJECT' end,
    v_old, to_jsonb(v_row), v_dept, p_notes);
  perform public.staff_notify_assignment(v_row.created_by, 'retail_quotation', p_quotation_id,
    (case when p_approved then 'Quotation approved: ' else 'Quotation rejected: ' end) || v_row.quotation_number,
    (case when p_approved then 'ભાવપત્રક મંજૂર: ' else 'ભાવપત્રક નકારાયું: ' end) || v_row.quotation_number);
  return v_row;
end $$;
revoke execute on function public.retail_approve_quotation(uuid, boolean, text) from public, anon;
grant execute on function public.retail_approve_quotation(uuid, boolean, text) to authenticated;
