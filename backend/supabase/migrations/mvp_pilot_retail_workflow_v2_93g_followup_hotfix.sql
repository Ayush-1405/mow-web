-- v2_93g -- HOTFIX for retail_record_followup(), found while building the quotation-approval RPC (v2_93f) and verified live before this
-- fix, not assumed:
--
-- BUG 1 (authorization bypass): the ownership check was
--   `if not (v_lead.assigned_to = auth.uid() or v_lead.created_by = auth.uid() or staff_has_global_oversight()
--            or (staff_is_dept_head() and staff_dept_in_hod_scope(...))) then raise exception ...`
--   retail_leads.assigned_to IS NULLable (a lead can be unassigned via the "Assign To" dropdown in RetailLeads.jsx). When it is NULL,
--   `assigned_to = auth.uid()` evaluates to SQL NULL, not false. Under three-valued logic, `NULL or false or false or false` is NULL, and
--   PL/pgSQL's `IF NULL THEN` is treated as false -- so the `raise exception` never fires. CONFIRMED live: an employee from a completely
--   unrelated department could call retail_record_followup() on any unassigned lead. Fixed by coalescing every branch to false.
--
-- BUG 2 (crash + silent data loss on legitimate use): `v_task` was declared as a bare `record` and only ever assigned inside
--   `if p_next_follow_up_at is not null and p_status = any(v_open_statuses) then ... end if;`. Marking a lead WON, LOST or
--   NOT_RESPONDING (which correctly needs no next follow-up date -- see RetailLeads.jsx's FollowUpModal, `needsNext =
--   !['WON','LOST','NOT_RESPONDING'].includes(status)`) skips that block entirely, leaving v_task unassigned, and the final
--   `return query select v_followup_id, v_task.task_id, v_task.task_number` then raises "record v_task is not assigned yet". Since the
--   whole RPC call is one transaction, that crash rolled back the follow-up INSERT too -- every legitimate WON/LOST/NOT_RESPONDING
--   follow-up was silently lost. CONFIRMED live as the authenticated lead owner, not just in theory. Fixed by using plain nullable
--   scalar variables instead of a record, so they are always well-defined (NULL when no task exists) instead of "unassigned".
create or replace function public.retail_record_followup(
  p_lead_id uuid, p_contact_mode text, p_outcome text default null, p_customer_response text default null, p_products_discussed text default null,
  p_expected_decision_date date default null, p_revised_budget numeric default null, p_notes text default null, p_next_action text default null,
  p_next_follow_up_at timestamptz default null, p_status text default 'CONTACTED', p_lost_reason text default null)
returns table (followup_id uuid, task_id uuid, task_number text)
language plpgsql security definer set search_path = public as $$
declare
  v_lead public.retail_leads; v_prev uuid; v_followup_id uuid; v_task_id uuid; v_task_number text; v_key text; v_lead_status text;
  v_open_statuses constant text[] := array['NEW','CONTACTED','FOLLOW_UP_DUE','INTERESTED','QUOTATION_REQUESTED','QUOTATION_SENT','NEGOTIATION','DECISION_PENDING','ON_HOLD'];
begin
  perform public.staff_assert_operational();
  select * into v_lead from public.retail_leads where id = p_lead_id for update;
  if v_lead.id is null then raise exception 'Lead not found'; end if;
  if not (coalesce(v_lead.assigned_to = auth.uid(), false) or coalesce(v_lead.created_by = auth.uid(), false)
          or coalesce(public.staff_has_global_oversight(), false)
          or (coalesce(public.staff_is_dept_head(), false) and coalesce(public.staff_dept_in_hod_scope(v_lead.department_id), false))) then
    raise exception 'Not authorized to record a follow-up on this lead';
  end if;
  if p_contact_mode not in ('CALL', 'WHATSAPP', 'VISIT', 'EMAIL') then raise exception 'Invalid contact mode'; end if;
  if p_status not in ('NEW','CONTACTED','FOLLOW_UP_DUE','INTERESTED','QUOTATION_REQUESTED','QUOTATION_SENT','NEGOTIATION','DECISION_PENDING','WON','LOST','NOT_RESPONDING','ON_HOLD') then
    raise exception 'Invalid follow-up status';
  end if;

  select id into v_prev from public.retail_followups where lead_id = p_lead_id order by created_at desc limit 1;

  insert into public.retail_followups (
    department_id, lead_id, customer_id, previous_followup_id, contact_mode, outcome, customer_response, products_discussed,
    expected_decision_date, revised_budget, notes, next_action, next_follow_up_at, status, lost_reason, created_by
  ) values (
    v_lead.department_id, p_lead_id, v_lead.customer_id, v_prev, p_contact_mode, p_outcome, p_customer_response, p_products_discussed,
    p_expected_decision_date, p_revised_budget, p_notes, p_next_action, p_next_follow_up_at, p_status, p_lost_reason, auth.uid()
  ) returning id into v_followup_id;

  v_lead_status := case when p_status = 'WON' then v_lead.status when p_status = 'LOST' then 'LOST'
    when p_status in ('QUOTATION_REQUESTED', 'QUOTATION_SENT', 'NEGOTIATION') then 'QUOTED' else 'FOLLOW_UP' end;
  update public.retail_leads set status = v_lead_status,
    next_follow_up_date = p_next_follow_up_at::date, next_follow_up_time = p_next_follow_up_at::time
  where id = p_lead_id;

  if v_lead.linked_task_id is not null then
    update public.staff_tasks set is_active = false where id = v_lead.linked_task_id and is_active = true
      and status_id not in (select id from public.status_master where code in ('CLOSED', 'VERIFIED'));
  end if;
  update public.retail_leads set linked_task_id = null where id = p_lead_id;

  if p_next_follow_up_at is not null and p_status = any(v_open_statuses) then
    v_key := 'retail_followup:' || v_followup_id::text;
    select st.id, st.task_number into v_task_id, v_task_number from public.staff_tasks st where st.system_key = v_key;
    if v_task_id is null then
      select tk.task_id, tk.task_number into v_task_id, v_task_number from public.staff_create_task(
        'Follow up: ' || v_lead.customer_name, coalesce(p_next_action, 'Scheduled follow-up'), 'FOLLOW_UP', 'NORMAL', 'none',
        v_lead.department_id, v_lead.department_id, v_lead.assigned_to, p_next_follow_up_at::date, p_next_follow_up_at::time,
        null, v_lead.walkin_number, p_products_discussed, null, null, null) tk;
      update public.staff_tasks set system_key = v_key where id = v_task_id;
    end if;
    update public.retail_followups set linked_task_id = v_task_id where id = v_followup_id;
    update public.retail_leads set linked_task_id = v_task_id where id = p_lead_id;
    if v_lead.assigned_to is distinct from auth.uid() and v_lead.assigned_to is not null then
      perform public.staff_notify_assignment(v_lead.assigned_to, 'retail_lead', p_lead_id,
        'Next follow-up scheduled: ' || v_lead.customer_name, 'આગલું ફોલો-અપ નક્કી થયું: ' || v_lead.customer_name);
    end if;
  end if;

  perform public.staff_write_audit('retail_lead', p_lead_id, 'FOLLOW_UP',
    jsonb_build_object('previous_status', v_lead.status), jsonb_build_object('status', p_status, 'followup_id', v_followup_id), v_lead.department_id);

  return query select v_followup_id, v_task_id, v_task_number;
end $$;
revoke execute on function public.retail_record_followup(uuid, text, text, text, text, date, numeric, text, text, timestamptz, text, text) from public, anon;
grant execute on function public.retail_record_followup(uuid, text, text, text, text, date, numeric, text, text, timestamptz, text, text) to authenticated;
