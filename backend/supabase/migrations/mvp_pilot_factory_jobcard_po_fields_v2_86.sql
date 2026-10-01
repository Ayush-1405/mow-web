-- Widens factory_job_update_details() to also accept po_received/po_number/po_date (added as real columns in
-- mvp_pilot_factory_segment_pages_v2_84.sql but never editable after creation until now) -- needed by the new
-- "PO Received" section on the Job Card page. Same signature, same authorization rule, just three more
-- whitelisted patch keys.
create or replace function public.factory_job_update_details(p_job_id uuid, p_patch jsonb)
 returns void
 language plpgsql security definer set search_path to 'public' as $function$
declare j public.inhouse_production_requests%rowtype; v_mgr boolean; v_src boolean;
begin
  perform public.staff_assert_operational();
  select * into j from public.inhouse_production_requests where id = p_job_id for update;
  if j.id is null then raise exception 'Job Card not found'; end if;
  v_mgr := public.factory_ai_is_reviewer();
  v_src := (j.requested_by = auth.uid() or (j.source_department_id is not null and j.source_department_id = public.staff_current_department_id()))
           and j.factory_status in ('pending_verification', 'needs_clarification');
  if not (v_mgr or v_src) then raise exception 'You are not authorized to edit this Job Card'; end if;
  if p_patch ? 'priority' and not v_mgr then raise exception 'Only Factory managers can change priority'; end if;
  if p_patch ? 'priority' and (p_patch ->> 'priority') not in ('Normal', 'High', 'Urgent', 'Emergency') then raise exception 'Invalid priority'; end if;

  update public.inhouse_production_requests set
    required_completion_date = case when p_patch ? 'required_date' then nullif(p_patch ->> 'required_date', '')::date else required_completion_date end,
    priority = case when p_patch ? 'priority' then p_patch ->> 'priority' else priority end,
    special_instructions = case when p_patch ? 'notes' then nullif(btrim(p_patch ->> 'notes'), '') else special_instructions end,
    customer_name = case when p_patch ? 'customer_name' then nullif(btrim(p_patch ->> 'customer_name'), '') else customer_name end,
    site_location = case when p_patch ? 'site_location' then nullif(btrim(p_patch ->> 'site_location'), '') else site_location end,
    po_received = case when p_patch ? 'po_received' then (p_patch ->> 'po_received')::boolean else po_received end,
    po_number = case when p_patch ? 'po_number' then nullif(btrim(p_patch ->> 'po_number'), '') else po_number end,
    po_date = case when p_patch ? 'po_date' then nullif(p_patch ->> 'po_date', '')::date else po_date end,
    updated_at = now()
  where id = p_job_id;
  perform public.factory_log_event(p_job_id, case when p_patch ? 'priority' then 'priority_changed' else 'details_updated' end, null, null,
    (select string_agg(k, ', ') from jsonb_object_keys(p_patch) k), auth.uid());
end $function$;
