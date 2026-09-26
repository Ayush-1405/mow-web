-- v2_93c -- fixes a real bug found while testing v2_93b: retail_create_walkin/retail_record_followup declare RETURNS TABLE(..., task_id
-- uuid, task_number text), which creates OUT-parameter variables named task_id/task_number that SHADOW the plain staff_tasks.task_number
-- column inside the function body ("column reference task_number is ambiguous"). Both functions now qualify the table alias explicitly.
-- No behavior change other than making the function actually run.

create or replace function public.retail_create_walkin(
  p_customer_name text, p_phone text, p_whatsapp text default null, p_email text default null, p_city text default null,
  p_location_id uuid default null, p_requirement_category text default null, p_interested_products text default null,
  p_room_category text default null, p_approx_budget numeric default null, p_purchase_timeline text default null,
  p_lead_source text default 'walkin', p_salesperson uuid default null, p_customer_type text default 'RETAIL',
  p_notes text default null, p_lead_temperature text default 'WARM', p_next_follow_up_at timestamptz default null)
returns table (lead_id uuid, walkin_number text, customer_id uuid, task_id uuid, task_number text)
language plpgsql security definer set search_path = public as $$
declare
  v_dept uuid := public.retail_dept_id(); v_customer public.retail_customers; v_salesperson uuid; v_salesperson_dept uuid;
  v_lead_id uuid; v_walkin text; v_task record; v_due_date date; v_due_time time; v_key text;
begin
  perform public.staff_assert_operational();
  if coalesce(btrim(p_customer_name), '') = '' then raise exception 'Customer name is required'; end if;
  if p_lead_temperature not in ('HOT', 'WARM', 'COLD') then raise exception 'Invalid lead temperature'; end if;

  v_salesperson := coalesce(p_salesperson, auth.uid());
  select department_id into v_salesperson_dept from public.user_profiles where id = v_salesperson and is_active = true;
  if v_salesperson_dept is distinct from v_dept then raise exception 'Salesperson must be an active Retail team member'; end if;

  v_customer := public.retail_upsert_customer(p_customer_name, p_phone, p_whatsapp, p_email, p_city, null, p_customer_type);
  v_walkin := 'WI-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  insert into public.retail_leads (
    department_id, location_id, customer_id, walkin_number, customer_name, phone, whatsapp, email, city, source,
    requirement_category, interested_products, room_category, approx_budget, purchase_timeline, customer_type,
    lead_temperature, interest_notes, assigned_to, status, next_follow_up_date, next_follow_up_time, created_by
  ) values (
    v_dept, p_location_id, v_customer.id, v_walkin, btrim(p_customer_name), nullif(btrim(p_phone), ''), nullif(btrim(p_whatsapp), ''),
    nullif(btrim(p_email), ''), nullif(btrim(p_city), ''), coalesce(p_lead_source, 'walkin'),
    p_requirement_category, nullif(btrim(p_interested_products), ''), nullif(btrim(p_room_category), ''), p_approx_budget,
    nullif(btrim(p_purchase_timeline), ''), p_customer_type, p_lead_temperature, nullif(btrim(p_notes), ''), v_salesperson, 'NEW',
    (coalesce(p_next_follow_up_at, now() + interval '1 day'))::date, (coalesce(p_next_follow_up_at, now() + interval '1 day'))::time,
    auth.uid()
  ) returning id into v_lead_id;

  v_due_date := (coalesce(p_next_follow_up_at, now() + interval '1 day'))::date;
  v_due_time := (coalesce(p_next_follow_up_at, now() + interval '1 day'))::time;
  v_key := 'retail_followup:lead:' || v_lead_id::text;
  select st.id, st.task_number into v_task from public.staff_tasks st where st.system_key = v_key;
  if v_task.id is null then
    select t.task_id, t.task_number into v_task from public.staff_create_task(
      'Follow up: ' || btrim(p_customer_name), coalesce(p_notes, 'New walk-in — first follow-up'), 'FOLLOW_UP', 'NORMAL', 'none',
      v_dept, v_dept, v_salesperson, v_due_date, v_due_time, null, v_walkin, p_interested_products, null, null, null) t;
    update public.staff_tasks set system_key = v_key where id = v_task.task_id;
  end if;

  update public.retail_leads set linked_task_id = v_task.task_id where id = v_lead_id;
  perform public.staff_write_audit('retail_lead', v_lead_id, 'CREATE_WALKIN',
    null, jsonb_build_object('walkin_number', v_walkin, 'customer_id', v_customer.id, 'assigned_to', v_salesperson), v_dept);
  if v_salesperson <> auth.uid() then
    perform public.staff_notify_assignment(v_salesperson, 'retail_lead', v_lead_id,
      'New walk-in assigned: ' || btrim(p_customer_name), 'નવો વોક-ઇન સોંપાયો: ' || btrim(p_customer_name));
  end if;

  return query select v_lead_id, v_walkin, v_customer.id, v_task.task_id, v_task.task_number;
end $$;

create or replace function public.retail_record_followup(
  p_lead_id uuid, p_contact_mode text, p_outcome text default null, p_customer_response text default null,
  p_products_discussed text default null, p_expected_decision_date date default null, p_revised_budget numeric default null,
  p_notes text default null, p_next_action text default null, p_next_follow_up_at timestamptz default null,
  p_status text default 'CONTACTED', p_lost_reason text default null)
returns table (followup_id uuid, task_id uuid, task_number text)
language plpgsql security definer set search_path = public as $$
declare
  v_lead public.retail_leads; v_prev uuid; v_followup_id uuid; v_task record; v_key text; v_lead_status text;
  v_open_statuses constant text[] := array['NEW','CONTACTED','FOLLOW_UP_DUE','INTERESTED','QUOTATION_REQUESTED','QUOTATION_SENT','NEGOTIATION','DECISION_PENDING','ON_HOLD'];
begin
  perform public.staff_assert_operational();
  select * into v_lead from public.retail_leads where id = p_lead_id for update;
  if v_lead.id is null then raise exception 'Lead not found'; end if;
  if not (v_lead.assigned_to = auth.uid() or v_lead.created_by = auth.uid() or public.staff_has_global_oversight()
          or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_lead.department_id))) then
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
    select st.id, st.task_number into v_task from public.staff_tasks st where st.system_key = v_key;
    if v_task.id is null then
      select tk.task_id, tk.task_number into v_task from public.staff_create_task(
        'Follow up: ' || v_lead.customer_name, coalesce(p_next_action, 'Scheduled follow-up'), 'FOLLOW_UP', 'NORMAL', 'none',
        v_lead.department_id, v_lead.department_id, v_lead.assigned_to, p_next_follow_up_at::date, p_next_follow_up_at::time,
        null, v_lead.walkin_number, p_products_discussed, null, null, null) tk;
      update public.staff_tasks set system_key = v_key where id = v_task.task_id;
    end if;
    update public.retail_followups set linked_task_id = v_task.task_id where id = v_followup_id;
    update public.retail_leads set linked_task_id = v_task.task_id where id = p_lead_id;
    if v_lead.assigned_to <> auth.uid() then
      perform public.staff_notify_assignment(v_lead.assigned_to, 'retail_lead', p_lead_id,
        'Next follow-up scheduled: ' || v_lead.customer_name, 'આગલું ફોલો-અપ નક્કી થયું: ' || v_lead.customer_name);
    end if;
  end if;

  perform public.staff_write_audit('retail_lead', p_lead_id, 'FOLLOW_UP',
    jsonb_build_object('previous_status', v_lead.status), jsonb_build_object('status', p_status, 'followup_id', v_followup_id), v_lead.department_id);

  return query select v_followup_id, v_task.task_id, v_task.task_number;
end $$;
