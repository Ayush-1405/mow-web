-- mvp_pilot_factory_qc_photos_v2_54
-- Real gap found by inspecting the live schema (not assumed): despite the
-- spec requiring photo evidence to be mandatory on Failed QC and on
-- Rework before/after proof, factory_quality_checks had NO photo column
-- at all, and factory_rework_records had none either. factory_
-- rejection_records already had a photos column (v2_50) but no frontend
-- ever wired an upload to it. This migration adds the missing columns and
-- makes the photo requirement a real server-side gate, not just a UI hint.

alter table public.factory_quality_checks add column if not exists photos text[];
alter table public.factory_rework_records add column if not exists before_photos text[];
alter table public.factory_rework_records add column if not exists after_photos text[];

-- factory_record_quality_check: photos now required when result = 'fail'.
drop function if exists public.factory_record_quality_check(uuid,boolean,boolean,boolean,boolean,boolean,boolean,text,text,boolean,uuid,date,text);

create or replace function public.factory_record_quality_check(
  p_job_id uuid, p_dimensions_checked boolean, p_material_checked boolean, p_finish_checked boolean,
  p_hardware_checked boolean, p_drawing_matched boolean, p_quantity_checked boolean,
  p_result text, p_defect_reason text default null, p_rework_required boolean default false,
  p_assigned_rework_person uuid default null, p_recheck_date date default null, p_qc_stage text default 'final',
  p_photos text[] default null
) returns table(quality_check_id uuid, rework_id uuid, rework_number text)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_job public.inhouse_production_requests%rowtype;
  v_qc_id uuid; v_rework_id uuid; v_rework_number text; v_actor_name text; v_my_profile uuid;
begin
  perform public.staff_assert_operational();
  if p_result not in ('pass','fail','conditional_pass') then raise exception 'Invalid QC result'; end if;
  if p_qc_stage not in ('in_process','final') then raise exception 'Invalid QC stage'; end if;
  if p_result = 'fail' and (p_photos is null or array_length(p_photos, 1) is null or array_length(p_photos, 1) = 0) then
    raise exception 'At least one photo is required when QC result is Fail';
  end if;

  select * into v_job from public.inhouse_production_requests where id = p_job_id for update;
  if v_job.id is null then raise exception 'Job not found'; end if;
  select id into v_my_profile from public.profiles where auth_id = auth.uid();

  if not (
    public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_factory_staff() and (
      v_job.assigned_factory_coordinator = v_my_profile or v_job.second_assignee_coordinator = v_my_profile
      or v_job.current_responsible_person = v_my_profile or public.staff_is_dept_head()
    ))
  ) then
    raise exception 'You are not authorized to record QC for this job';
  end if;
  if p_rework_required and (p_defect_reason is null or btrim(p_defect_reason) = '') then
    raise exception 'A defect/rejection reason is required when rework is needed';
  end if;

  insert into public.factory_quality_checks (
    job_id, dimensions_checked, material_checked, finish_checked, hardware_checked, drawing_matched, quantity_checked,
    result, defect_reason, rework_required, assigned_rework_person, recheck_date, checked_by, qc_stage, photos
  ) values (
    p_job_id, p_dimensions_checked, p_material_checked, p_finish_checked, p_hardware_checked, p_drawing_matched, p_quantity_checked,
    p_result, p_defect_reason, p_rework_required, p_assigned_rework_person, p_recheck_date, auth.uid(), p_qc_stage, p_photos
  ) returning id into v_qc_id;

  update public.inhouse_production_requests set
    qc_status = p_result,
    rework_status = case when p_rework_required then 'Rework Required' else rework_status end,
    status = case when p_rework_required then 'Rework' else status end,
    updated_at = now()
  where id = p_job_id;

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  if p_rework_required then
    select 'RW-' || lpad((select count(*) + 1 from public.factory_rework_records)::text, 6, '0') into v_rework_number;
    insert into public.factory_rework_records (
      rework_number, quality_check_id, job_id, defect_details, assigned_to, required_completion_date, created_by, before_photos
    ) values (
      v_rework_number, v_qc_id, p_job_id, p_defect_reason,
      coalesce((select auth_id from public.profiles where id = p_assigned_rework_person), (select auth_id from public.profiles where id = v_job.assigned_factory_coordinator)),
      p_recheck_date, auth.uid(), p_photos
    ) returning id into v_rework_id;
  end if;

  perform public.staff_write_audit('factory_quality_checks', v_qc_id, 'QC_RECORDED',
    null, jsonb_build_object('result', p_result, 'qc_stage', p_qc_stage, 'rework_required', p_rework_required, 'defect_reason', p_defect_reason, 'job_id', p_job_id, 'project_id', v_job.project_id), null);

  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id,
      initcap(replace(p_qc_stage, '_', ' ')) || ' QC ' || p_result || ' by ' || v_actor_name || case when p_rework_required then ' — rework required: ' || p_defect_reason else '' end,
      v_actor_name || ' દ્વારા ' || initcap(replace(p_qc_stage, '_', ' ')) || ' QC ' || p_result || case when p_rework_required then ' — રિવર્ક જરૂરી: ' || p_defect_reason else '' end);
  end if;

  return query select v_qc_id, v_rework_id, v_rework_number;
end;
$function$;

revoke all on function public.factory_record_quality_check(uuid,boolean,boolean,boolean,boolean,boolean,boolean,text,text,boolean,uuid,date,text,text[]) from public;
grant execute on function public.factory_record_quality_check(uuid,boolean,boolean,boolean,boolean,boolean,boolean,text,text,boolean,uuid,date,text,text[]) to authenticated;

-- factory_close_rework: after_photos now required to close.
drop function if exists public.factory_close_rework(uuid,text,text);

create or replace function public.factory_close_rework(p_rework_id uuid, p_recheck_result text, p_corrective_action text default null, p_after_photos text[] default null)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_rw public.factory_rework_records%rowtype;
  v_job public.inhouse_production_requests%rowtype;
  v_actor_name text; v_my_profile uuid;
begin
  perform public.staff_assert_operational();
  if p_recheck_result is null or btrim(p_recheck_result) = '' then
    raise exception 'A recheck result is required to close a rework';
  end if;
  if p_after_photos is null or array_length(p_after_photos, 1) is null or array_length(p_after_photos, 1) = 0 then
    raise exception 'At least one after-rework photo is required to close a rework';
  end if;

  select * into v_rw from public.factory_rework_records where id = p_rework_id for update;
  if v_rw.id is null then raise exception 'Rework record not found'; end if;
  if v_rw.is_closed then raise exception 'This rework is already closed'; end if;
  select * into v_job from public.inhouse_production_requests where id = v_rw.job_id;
  select id into v_my_profile from public.profiles where auth_id = auth.uid();

  if not (
    public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_factory_staff() and (v_rw.assigned_to = auth.uid() or public.staff_is_dept_head()))
  ) then
    raise exception 'You are not authorized to close this rework';
  end if;

  update public.factory_rework_records set
    recheck_result = p_recheck_result,
    corrective_action = coalesce(p_corrective_action, corrective_action),
    after_photos = p_after_photos,
    is_closed = true, closed_by = auth.uid(), closed_at = now()
  where id = p_rework_id;

  update public.inhouse_production_requests set rework_status = 'Rework Closed', status = 'Work in Progress' where id = v_rw.job_id and status = 'Rework';

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();
  perform public.staff_write_audit('factory_rework_records', p_rework_id, 'REWORK_CLOSED',
    null, jsonb_build_object('recheck_result', p_recheck_result, 'project_id', v_job.project_id), null);

  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id,
      'Rework ' || v_rw.rework_number || ' closed by ' || v_actor_name || ': ' || p_recheck_result,
      v_actor_name || ' દ્વારા રિવર્ક ' || v_rw.rework_number || ' બંધ: ' || p_recheck_result);
  end if;
end;
$function$;

revoke all on function public.factory_close_rework(uuid,text,text,text[]) from public;
grant execute on function public.factory_close_rework(uuid,text,text,text[]) to authenticated;

-- factory_record_rejection: photos now mandatory (rejection is always
-- "evidence-required" per spec, unlike QC where only the Fail branch is).
create or replace function public.factory_record_rejection(
  p_job_id uuid, p_rejected_quantity numeric, p_reason text, p_responsible_stage text default null,
  p_disposition text default 'scrap', p_photos text[] default null, p_notes text default null, p_quality_check_id uuid default null
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_job public.inhouse_production_requests%rowtype;
  v_my_profile uuid; v_actor_name text; v_rej_id uuid;
  v_lead_exec_auth uuid; v_submitter_auth uuid;
begin
  perform public.staff_assert_operational();
  if p_rejected_quantity is null or p_rejected_quantity <= 0 then raise exception 'Rejected quantity is required'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'A rejection reason is required'; end if;
  if p_disposition not in ('scrap', 'return_to_vendor', 'other') then raise exception 'Invalid disposition'; end if;
  if p_photos is null or array_length(p_photos, 1) is null or array_length(p_photos, 1) = 0 then
    raise exception 'At least one photo is required to record a rejection';
  end if;

  select * into v_job from public.inhouse_production_requests where id = p_job_id for update;
  if v_job.id is null then raise exception 'Job not found'; end if;
  select id into v_my_profile from public.profiles where auth_id = auth.uid();

  if not (
    public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_factory_staff() and (
      v_job.assigned_factory_coordinator = v_my_profile or v_job.second_assignee_coordinator = v_my_profile
      or v_job.current_responsible_person = v_my_profile or public.staff_is_dept_head()
    ))
  ) then
    raise exception 'You are not authorized to record a rejection for this job';
  end if;

  insert into public.factory_rejection_records (job_id, quality_check_id, rejected_quantity, reason, responsible_stage, disposition, photos, notes, rejected_by)
  values (p_job_id, p_quality_check_id, p_rejected_quantity, p_reason, p_responsible_stage, p_disposition, p_photos, p_notes, auth.uid())
  returning id into v_rej_id;

  update public.inhouse_production_requests set rework_status = coalesce(rework_status, 'Rejection Recorded'), updated_at = now() where id = p_job_id;

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();
  select p.auth_id into v_lead_exec_auth from public.projects pr join public.profiles p on p.id = pr.lead_executive_id where pr.id = v_job.project_id;
  select p.auth_id into v_submitter_auth from public.profiles p where p.id = v_job.submitted_by;

  if v_lead_exec_auth is not null then
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
    values (v_lead_exec_auth, 'inhouse_production_requests', p_job_id, v_job.linked_task_id,
      'Rejection recorded on ' || v_job.job_order_number || ': ' || p_reason, 'નકારેલ ' || v_job.job_order_number || ': ' || p_reason);
  end if;
  if v_submitter_auth is not null and v_submitter_auth is distinct from v_lead_exec_auth then
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
    values (v_submitter_auth, 'inhouse_production_requests', p_job_id, v_job.linked_task_id,
      'Rejection recorded on ' || v_job.job_order_number || ': ' || p_reason, 'નકારેલ ' || v_job.job_order_number || ': ' || p_reason);
  end if;

  perform public.staff_write_audit('factory_rejection_records', v_rej_id, 'REJECTION_RECORDED',
    null, jsonb_build_object('rejected_quantity', p_rejected_quantity, 'reason', p_reason, 'disposition', p_disposition, 'job_id', p_job_id, 'project_id', v_job.project_id), null);

  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id,
      'Rejection recorded by ' || v_actor_name || ' — qty ' || p_rejected_quantity || ': ' || p_reason,
      v_actor_name || ' દ્વારા નકારેલ — જથ્થો ' || p_rejected_quantity || ': ' || p_reason);
  end if;

  return v_rej_id;
end;
$function$;
