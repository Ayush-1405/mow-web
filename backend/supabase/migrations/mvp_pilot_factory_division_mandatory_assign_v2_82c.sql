-- Mandatory Factory segment selection (handwritten workflow spec, "segment selection must be mandatory").
-- Rather than rewiring every external department's own creation RPC (Retail/Interior/B2B/R&D all create
-- inhouse_production_requests rows through their own, already-tested paths -- touching those blind risks
-- breaking departments outside this pass's scope, which the brief explicitly says not to do), the mandatory
-- gate is enforced at the one real, safe choke point: factory_job_transition's 'assign' action now refuses to
-- route a Job Card to a worker until a Factory Head/Supervisor has chosen its division (Sofa/Modular/Metal
-- Fabrication) via factory_set_job_division. This is additive -- the function's only change is one new guard
-- line in the existing 'assign' branch; every other action, authorization check and notification is untouched.
create or replace function public.factory_job_transition(p_job_id uuid, p_action text, p_note text default null::text, p_payload jsonb default '{}'::jsonb)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  j public.inhouse_production_requests%rowtype;
  v_uid uuid := auth.uid();
  v_mgr boolean; v_head boolean; v_assigned boolean; v_source boolean;
  v_old text; v_new text; v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_primary uuid; v_second uuid; v_primary_auth uuid; v_second_auth uuid; v_factory uuid;
  v_start date; v_end date; v_dept text; v_event text; v_pname text; v_verified uuid;
begin
  perform public.staff_assert_operational();
  select * into j from public.inhouse_production_requests where id = p_job_id for update;
  if j.id is null then raise exception 'Job Card not found'; end if;

  v_old := j.factory_status;
  v_mgr := public.factory_ai_is_reviewer();
  v_head := public.factory_is_head();
  v_assigned := public.factory_my_profile_id() is not null
    and public.factory_my_profile_id() in (j.assigned_factory_coordinator, j.second_assignee_coordinator, j.current_responsible_person);
  v_source := j.requested_by = v_uid or (j.source_department_id is not null and j.source_department_id = public.staff_current_department_id());
  v_new := v_old;
  v_event := p_action;

  case p_action
    when 'accept' then
      if not v_mgr then raise exception 'You are not authorized to accept Job Cards'; end if;
      if v_old <> 'pending_verification' then raise exception 'Only a Job Card awaiting verification can be accepted'; end if;
      v_new := 'accepted';
      update public.inhouse_production_requests set accepted_at = now(), accepted_by = v_uid, viewed_at = coalesce(viewed_at, now()) where id = p_job_id;
    when 'return' then
      if not v_mgr then raise exception 'You are not authorized to return Job Cards'; end if;
      if v_old not in ('pending_verification', 'accepted', 'assigned') then raise exception 'This Job Card can no longer be returned'; end if;
      if v_note is null then raise exception 'Please say what needs clarification'; end if;
      v_new := 'needs_clarification';
      update public.inhouse_production_requests set clarification_note = v_note, clarification_requested_at = now() where id = p_job_id;
    when 'resubmit' then
      if not (v_source or v_mgr) then raise exception 'You are not authorized to re-submit this Job Card'; end if;
      if v_old <> 'needs_clarification' then raise exception 'Only a returned Job Card can be re-submitted'; end if;
      v_new := 'pending_verification';
      update public.inhouse_production_requests set clarification_note = null, viewed_at = null where id = p_job_id;
    when 'assign' then
      if not v_mgr then raise exception 'You are not authorized to assign Factory staff'; end if;
      if v_old not in ('accepted', 'assigned', 'in_production', 'blocked') then raise exception 'Accept the Job Card before assigning it'; end if;
      if j.division_id is null then raise exception 'Select a Factory segment (Sofa / Modular / Metal Fabrication) before assigning workers'; end if;
      v_primary := nullif(p_payload ->> 'primary_profile_id', '')::uuid;
      v_second := nullif(p_payload ->> 'second_profile_id', '')::uuid;
      v_start := nullif(p_payload ->> 'planned_start', '')::date;
      v_end := nullif(p_payload ->> 'expected_end', '')::date;
      v_dept := nullif(btrim(coalesce(p_payload ->> 'production_department', '')), '');
      if v_primary is null then raise exception 'Please choose the primary responsible person'; end if;
      if v_second is not null and v_second = v_primary then raise exception 'Primary and second assignee must be different people'; end if;
      select id into v_factory from public.departments where code = 'FACTORY';
      select up.id into v_primary_auth from public.profiles p join public.user_profiles up on up.id = p.auth_id
        where p.id = v_primary and up.is_active and up.department_id = v_factory;
      if v_primary_auth is null then raise exception 'Selected employee could not be found in the Factory team. Please choose a valid employee from the list.'; end if;
      if v_second is not null then
        select up.id into v_second_auth from public.profiles p join public.user_profiles up on up.id = p.auth_id
          where p.id = v_second and up.is_active and up.department_id = v_factory;
        if v_second_auth is null then raise exception 'Selected second assignee could not be found in the Factory team.'; end if;
      end if;
      if v_start is not null and v_end is not null and v_end < v_start then raise exception 'Expected completion cannot be before the planned start'; end if;

      v_new := case when v_old = 'accepted' then 'assigned' else v_old end;
      update public.inhouse_production_requests set
        assigned_factory_coordinator = v_primary, second_assignee_coordinator = v_second, current_responsible_person = v_primary,
        production_department = coalesce(v_dept, production_department), production_start_date = coalesce(v_start, production_start_date),
        expected_completion_date = coalesce(v_end, expected_completion_date), assigned_at = now(), assigned_by = v_uid
      where id = p_job_id;
      select * into j from public.inhouse_production_requests where id = p_job_id;

      perform public.factory_sync_job_task(p_job_id, v_primary_auth, v_second_auth, v_note);
      v_pname := public.factory_person_name(v_primary);
      v_note := coalesce(v_note, 'Assigned to ' || coalesce(v_pname, 'team'));
    when 'start' then
      if not (v_mgr or v_assigned) then raise exception 'You are not authorized to start this Job Card'; end if;
      if v_old <> 'assigned' then raise exception 'Only an assigned Job Card can be started'; end if;
      v_new := 'in_production';
    when 'block' then
      if not (v_mgr or v_assigned) then raise exception 'You are not authorized to block this Job Card'; end if;
      if v_old not in ('assigned', 'in_production') then raise exception 'Only active work can be blocked'; end if;
      if v_note is null then raise exception 'Please give the reason it is blocked'; end if;
      v_new := 'blocked';
      update public.inhouse_production_requests set blocked_reason = v_note, blocked_from = v_old, delay_reason = v_note where id = p_job_id;
    when 'unblock' then
      if not (v_mgr or v_assigned) then raise exception 'You are not authorized to unblock this Job Card'; end if;
      if v_old <> 'blocked' then raise exception 'This Job Card is not blocked'; end if;
      v_new := coalesce(nullif(j.blocked_from, ''), 'in_production');
      update public.inhouse_production_requests set blocked_reason = null, blocked_from = null, delay_reason = null where id = p_job_id;
    when 'mark_ready' then
      if not (v_mgr or v_assigned) then raise exception 'You are not authorized to mark this Job Card ready'; end if;
      if v_old <> 'in_production' then raise exception 'Only work in production can be marked ready'; end if;
      v_new := 'ready_for_review';
      update public.inhouse_production_requests set ready_at = now() where id = p_job_id;
    when 'complete' then
      if not v_head then raise exception 'Only the Factory Head or Admin can approve completion'; end if;
      if v_old <> 'ready_for_review' then raise exception 'Only work that is ready for review can be completed'; end if;
      v_new := 'completed';
      update public.inhouse_production_requests set completed_at = now(), completed_by = v_uid, actual_completion_date = current_date, completion_percentage = 100, factory_status = 'completed' where id = p_job_id;
      select id into v_verified from public.status_master where code = 'VERIFIED';
      update public.staff_tasks set status_id = v_verified, verified_by = v_uid
        where job_card_id = p_job_id and is_active and status_id = (select id from public.status_master where code = 'COMPLETED');
    when 'cancel' then
      if not v_head then raise exception 'Only the Factory Head or Admin can cancel a Job Card'; end if;
      if v_old in ('completed', 'cancelled') then raise exception 'This Job Card is already closed'; end if;
      if v_note is null then raise exception 'Please give a reason for cancelling'; end if;
      v_new := 'cancelled';
      update public.inhouse_production_requests set cancelled_reason = v_note, factory_status = 'cancelled' where id = p_job_id;
      update public.staff_tasks set is_active = false
        where job_card_id = p_job_id and is_active
          and status_id in (select id from public.status_master where code in ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'ON_HOLD', 'RETURNED', 'REOPENED', 'PARTIALLY_ACCEPTED'));
    when 'reopen' then
      if not v_head then raise exception 'Only the Factory Head or Admin can reopen a Job Card'; end if;
      if v_old not in ('completed', 'cancelled') then raise exception 'Only a closed Job Card can be reopened'; end if;
      if v_note is null then raise exception 'Please give a reason for reopening'; end if;
      v_new := case when v_old = 'completed' then 'in_production' else 'pending_verification' end;
      update public.inhouse_production_requests set completed_at = null, completed_by = null, actual_completion_date = null, cancelled_reason = null, viewed_at = null where id = p_job_id;
    else
      raise exception 'Unknown action';
  end case;

  update public.inhouse_production_requests set factory_status = v_new, updated_at = now() where id = p_job_id;
  select * into j from public.inhouse_production_requests where id = p_job_id;

  perform public.factory_log_event(p_job_id, v_event, v_old, v_new, v_note, v_uid);
  perform public.staff_write_audit('inhouse_production_requests', p_job_id, 'FACTORY_' || upper(p_action), jsonb_build_object('status', v_old), jsonb_build_object('status', v_new, 'note', v_note), j.source_department_id, null);

  if p_action = 'accept' then
    perform public.factory_notify_user(j.requested_by, p_job_id, 'Your Factory request ' || j.job_order_number || ' was accepted', 'તમારી ફેક્ટરી વિનંતી ' || j.job_order_number || ' સ્વીકારવામાં આવી');
  elsif p_action = 'return' then
    perform public.factory_notify_user(j.requested_by, p_job_id, 'Clarification needed on ' || j.job_order_number || ': ' || v_note, j.job_order_number || ' પર સ્પષ્ટતા જરૂરી: ' || v_note);
  elsif p_action = 'resubmit' then
    perform public.factory_notify_managers(p_job_id, 'Job Card ' || j.job_order_number || ' was re-submitted after correction', 'જોબ કાર્ડ ' || j.job_order_number || ' સુધારા પછી ફરી સબમિટ થયું');
  elsif p_action = 'block' then
    perform public.factory_notify_managers(p_job_id, 'Job Card ' || j.job_order_number || ' is blocked: ' || v_note, 'જોબ કાર્ડ ' || j.job_order_number || ' અટકેલું છે: ' || v_note);
  elsif p_action = 'mark_ready' then
    perform public.factory_notify_managers(p_job_id, 'Job Card ' || j.job_order_number || ' is ready for review', 'જોબ કાર્ડ ' || j.job_order_number || ' સમીક્ષા માટે તૈયાર છે');
  elsif p_action = 'complete' then
    perform public.factory_notify_user(j.requested_by, p_job_id, 'Your Factory request ' || j.job_order_number || ' is completed', 'તમારી ફેક્ટરી વિનંતી ' || j.job_order_number || ' પૂર્ણ થઈ');
  end if;

  return v_new;
end $function$;
