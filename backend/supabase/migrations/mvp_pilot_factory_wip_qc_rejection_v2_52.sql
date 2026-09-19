-- mvp_pilot_factory_wip_qc_rejection_v2_52
-- Factory dashboard Phase 1 unlock: WIP Stages, In-process QC, Final QC,
-- Rework and Rejection as genuine standalone cards (each gets its own
-- cross-job board, not just a view nested inside a single Job Order).
-- Reuses the tables/RPCs from v2_50/v2_51 -- no parallel tables created.
--
-- 1. factory_quality_checks never distinguished "In-process QC" from
--    "Final QC" (spec cards #12/#13) -- every check was implicitly the
--    same thing. Added qc_stage, defaulting existing/future plain calls to
--    'final' (preserves the current behavior: factory_submit_completion's
--    QC gate already meant "the check that approves completion", which is
--    what "final" means here) so nothing that already worked changes
--    silently.
-- 2. factory_submit_completion's QC gate is tightened to specifically
--    require a Final QC pass (spec: "Final QC pass mandatory before
--    Finished Goods"), not just any QC record of any stage.
-- 3. Rejection (spec card #15) never existed as a distinct outcome from
--    Rework -- a failed QC could only ever become a rework. Real factories
--    also scrap/reject parts outright; added factory_rejection_records +
--    factory_record_rejection with the same auth/audit/notification
--    pattern as every other Factory RPC.

alter table public.factory_quality_checks
  add column if not exists qc_stage text not null default 'final' check (qc_stage in ('in_process', 'final'));
create index if not exists factory_quality_checks_qc_stage_idx on public.factory_quality_checks(qc_stage);

drop function if exists public.factory_record_quality_check(uuid,boolean,boolean,boolean,boolean,boolean,boolean,text,text,boolean,uuid,date);

create or replace function public.factory_record_quality_check(
  p_job_id uuid, p_dimensions_checked boolean, p_material_checked boolean, p_finish_checked boolean,
  p_hardware_checked boolean, p_drawing_matched boolean, p_quantity_checked boolean,
  p_result text, p_defect_reason text default null, p_rework_required boolean default false,
  p_assigned_rework_person uuid default null, p_recheck_date date default null, p_qc_stage text default 'final'
) returns table(quality_check_id uuid, rework_id uuid, rework_number text)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_job public.inhouse_production_requests%rowtype;
  v_qc_id uuid; v_rework_id uuid; v_rework_number text; v_actor_name text; v_my_profile uuid;
begin
  perform public.staff_assert_operational();
  if p_result not in ('pass','fail','conditional_pass') then raise exception 'Invalid QC result'; end if;
  if p_qc_stage not in ('in_process','final') then raise exception 'Invalid QC stage'; end if;

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
    result, defect_reason, rework_required, assigned_rework_person, recheck_date, checked_by, qc_stage
  ) values (
    p_job_id, p_dimensions_checked, p_material_checked, p_finish_checked, p_hardware_checked, p_drawing_matched, p_quantity_checked,
    p_result, p_defect_reason, p_rework_required, p_assigned_rework_person, p_recheck_date, auth.uid(), p_qc_stage
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
      rework_number, quality_check_id, job_id, defect_details, assigned_to, required_completion_date, created_by
    ) values (
      v_rework_number, v_qc_id, p_job_id, p_defect_reason,
      coalesce((select auth_id from public.profiles where id = p_assigned_rework_person), (select auth_id from public.profiles where id = v_job.assigned_factory_coordinator)),
      p_recheck_date, auth.uid()
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

revoke all on function public.factory_record_quality_check(uuid,boolean,boolean,boolean,boolean,boolean,boolean,text,text,boolean,uuid,date,text) from public;
grant execute on function public.factory_record_quality_check(uuid,boolean,boolean,boolean,boolean,boolean,boolean,text,text,boolean,uuid,date,text) to authenticated;

-- Tighten the completion gate to specifically require a FINAL QC pass.
create or replace function public.factory_submit_completion(
  p_job_id uuid, p_actual_completed_quantity numeric, p_completion_photos text[] default null, p_completion_notes text default null
) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_job public.inhouse_production_requests%rowtype;
  v_my_profile uuid; v_actor_name text; v_latest_qc text;
  v_lead_exec_auth uuid; v_submitter_auth uuid;
begin
  perform public.staff_assert_operational();
  if p_actual_completed_quantity is null or p_actual_completed_quantity <= 0 then
    raise exception 'Actual completed quantity is required';
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
    raise exception 'You are not authorized to submit completion for this job';
  end if;

  select result into v_latest_qc from public.factory_quality_checks where job_id = p_job_id and qc_stage = 'final' order by created_at desc limit 1;
  if v_latest_qc is null or v_latest_qc = 'fail' then
    raise exception 'A Final QC Pass or Conditional Pass is required before completion can be submitted';
  end if;

  update public.inhouse_production_requests set
    actual_completed_quantity = p_actual_completed_quantity,
    completion_photos = p_completion_photos, completion_notes = p_completion_notes,
    completed_by = auth.uid(), completed_at = now(),
    interior_confirmed = false, interior_confirmed_by = null, interior_confirmed_at = null,
    interior_issue_raised = false, final_closed_at = null,
    status = 'Completed', qc_status = v_latest_qc,
    updated_at = now()
  where id = p_job_id;

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();
  select p.auth_id into v_lead_exec_auth from public.projects pr join public.profiles p on p.id = pr.lead_executive_id where pr.id = v_job.project_id;
  select p.auth_id into v_submitter_auth from public.profiles p where p.id = v_job.submitted_by;

  if v_lead_exec_auth is not null then
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
    values (v_lead_exec_auth, 'inhouse_production_requests', p_job_id, v_job.linked_task_id,
      'Factory completed ' || v_job.job_order_number || ' — please confirm', 'ફેક્ટરીએ ' || v_job.job_order_number || ' પૂર્ણ કર્યું — કૃપા કરી પુષ્ટિ કરો');
  end if;
  if v_submitter_auth is not null and v_submitter_auth is distinct from v_lead_exec_auth then
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
    values (v_submitter_auth, 'inhouse_production_requests', p_job_id, v_job.linked_task_id,
      'Factory completed ' || v_job.job_order_number || ' — please confirm', 'ફેક્ટરીએ ' || v_job.job_order_number || ' પૂર્ણ કર્યું — કૃપા કરી પુષ્ટિ કરો');
  end if;

  perform public.staff_write_audit('inhouse_production_requests', p_job_id, 'COMPLETION_SUBMITTED',
    null, jsonb_build_object('actual_completed_quantity', p_actual_completed_quantity, 'qc_status', v_latest_qc, 'project_id', v_job.project_id), null);

  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id,
      'Production completed by ' || v_actor_name || ' — qty ' || p_actual_completed_quantity || ', awaiting Interior confirmation',
      v_actor_name || ' દ્વારા ઉત્પાદન પૂર્ણ — જથ્થો ' || p_actual_completed_quantity || ', ઇન્ટિરિયરની પુષ્ટિ બાકી');
  end if;
end;
$function$;

-- ---------------------------------------------------------------------
-- Rejection.
-- ---------------------------------------------------------------------
create table public.factory_rejection_records (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.inhouse_production_requests(id),
  quality_check_id uuid references public.factory_quality_checks(id),
  rejected_quantity numeric not null check (rejected_quantity > 0),
  reason text not null,
  responsible_stage text,
  disposition text not null default 'scrap' check (disposition in ('scrap', 'return_to_vendor', 'other')),
  photos text[],
  notes text,
  rejected_by uuid not null references public.user_profiles(id),
  rejected_at timestamptz not null default now()
);
create index factory_rejection_records_job_id_idx on public.factory_rejection_records(job_id);

alter table public.factory_rejection_records enable row level security;
grant select on public.factory_rejection_records to authenticated;
create policy "factory_rejection_records_select" on public.factory_rejection_records for select using (staff_factory_job_visible(job_id));

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

revoke all on function public.factory_record_rejection(uuid,numeric,text,text,text,text[],text,uuid) from public;
grant execute on function public.factory_record_rejection(uuid,numeric,text,text,text,text[],text,uuid) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'factory_rejection_records') then
    execute 'alter publication supabase_realtime add table public.factory_rejection_records';
  end if;
end $$;
