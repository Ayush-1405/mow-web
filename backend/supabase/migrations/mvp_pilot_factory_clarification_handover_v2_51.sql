-- mvp_pilot_factory_clarification_handover_v2_51
-- Completes the Interior <-> Factory two-way connection: Clarification/
-- Revision (spec 2E) and Completion Handover (2F). Neither existed before
-- this migration -- the prior Factory-module round (v2_50) covered
-- submission, stage tracking, QC and rework only.
--
-- Real gap found during inspection (not assumed): working_drawing_attachments
-- is a generic, already-reused polymorphic attachment table (module +
-- related_record_id), the correct place for clarification proof/revision
-- documents and completion photos -- reusing it, not creating a parallel
-- attachments table. But its RLS (working_drawing_attachments_insert_scoped
-- / _select_scoped) only ever checked interior_is_org_wide() OR
-- interior_is_project_member(project_id) -- a real Factory coordinator
-- assigned to a job on that project could not upload or even see a single
-- attachment for their own linked work. Fixed with an additive Factory-
-- staff branch scoped to jobs they are actually assigned to.

-- ---------------------------------------------------------------------
-- 1. Fix the attachment RLS gap for Factory staff.
-- ---------------------------------------------------------------------
create or replace function public.staff_factory_project_linked(p_project_id uuid) returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select public.staff_is_factory_staff() and exists (
    select 1 from public.inhouse_production_requests r
    where r.project_id = p_project_id
      and (
        r.assigned_factory_coordinator = (select id from public.profiles where auth_id = auth.uid())
        or r.second_assignee_coordinator = (select id from public.profiles where auth_id = auth.uid())
        or r.current_responsible_person = (select id from public.profiles where auth_id = auth.uid())
        or public.staff_is_dept_head()
      )
  );
$$;

drop policy if exists "working_drawing_attachments_insert_scoped" on public.working_drawing_attachments;
create policy "working_drawing_attachments_insert_scoped" on public.working_drawing_attachments for insert with check (
  interior_is_org_wide() or interior_is_project_member(project_id) or staff_factory_project_linked(project_id)
);

drop policy if exists "working_drawing_attachments_select_scoped" on public.working_drawing_attachments;
create policy "working_drawing_attachments_select_scoped" on public.working_drawing_attachments for select using (
  (is_deleted = false and (interior_is_org_wide() or interior_is_project_member(project_id) or staff_factory_project_linked(project_id)))
  or (is_deleted = true and interior_files_can_view_deleted())
);

-- ---------------------------------------------------------------------
-- 2. Clarification / Revision workflow.
-- ---------------------------------------------------------------------
create table public.factory_clarification_requests (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.inhouse_production_requests(id),
  project_id uuid not null references public.projects(id),
  reason text not null,
  related_reference text,
  proof_attachment_path text,
  status text not null default 'open' check (status in ('open', 'revision_uploaded', 'resolved', 'rejected')),
  raised_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  resolved_by uuid references public.user_profiles(id),
  resolved_at timestamptz
);
create index factory_clarification_requests_job_id_idx on public.factory_clarification_requests(job_id);

create table public.factory_clarification_revisions (
  id uuid primary key default gen_random_uuid(),
  clarification_id uuid not null references public.factory_clarification_requests(id),
  revision_number int not null,
  document_path text not null,
  notes text,
  uploaded_by uuid not null references public.user_profiles(id),
  uploaded_at timestamptz not null default now(),
  decision text not null default 'pending' check (decision in ('pending', 'accepted', 'rejected')),
  decided_by uuid references public.user_profiles(id),
  decided_at timestamptz,
  decision_notes text,
  unique (clarification_id, revision_number)
);
create index factory_clarification_revisions_clarification_id_idx on public.factory_clarification_revisions(clarification_id);

alter table public.factory_clarification_requests enable row level security;
alter table public.factory_clarification_revisions enable row level security;
grant select on public.factory_clarification_requests to authenticated;
grant select on public.factory_clarification_revisions to authenticated;

create policy "factory_clarification_requests_select" on public.factory_clarification_requests for select using (staff_factory_job_visible(job_id));
create policy "factory_clarification_revisions_select" on public.factory_clarification_revisions for select using (
  exists (select 1 from public.factory_clarification_requests c where c.id = clarification_id and staff_factory_job_visible(c.job_id))
);

create or replace function public.factory_request_clarification(
  p_job_id uuid, p_reason text, p_related_reference text default null, p_proof_attachment_path text default null
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_job public.inhouse_production_requests%rowtype;
  v_my_profile uuid; v_clar_id uuid; v_actor_name text;
  v_lead_exec_auth uuid; v_submitter_auth uuid;
begin
  perform public.staff_assert_operational();
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A clarification reason is required';
  end if;

  select * into v_job from public.inhouse_production_requests where id = p_job_id;
  if v_job.id is null then raise exception 'Job not found'; end if;
  select id into v_my_profile from public.profiles where auth_id = auth.uid();

  if not (
    public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_factory_staff() and (
      v_job.assigned_factory_coordinator = v_my_profile or v_job.second_assignee_coordinator = v_my_profile
      or v_job.current_responsible_person = v_my_profile or public.staff_is_dept_head()
    ))
  ) then
    raise exception 'You are not authorized to raise a clarification for this job';
  end if;

  insert into public.factory_clarification_requests (job_id, project_id, reason, related_reference, proof_attachment_path, raised_by)
  values (p_job_id, v_job.project_id, p_reason, p_related_reference, p_proof_attachment_path, auth.uid())
  returning id into v_clar_id;

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();

  select p.auth_id into v_lead_exec_auth from public.projects pr join public.profiles p on p.id = pr.lead_executive_id where pr.id = v_job.project_id;
  select p.auth_id into v_submitter_auth from public.profiles p where p.id = v_job.submitted_by;

  if v_lead_exec_auth is not null then
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
    values (v_lead_exec_auth, 'inhouse_production_requests', p_job_id, v_job.linked_task_id,
      'Factory needs clarification on ' || v_job.job_order_number || ': ' || p_reason,
      'ફેક્ટરીને ' || v_job.job_order_number || ' પર સ્પષ્ટતા જોઈએ છે: ' || p_reason);
  end if;
  if v_submitter_auth is not null and v_submitter_auth is distinct from v_lead_exec_auth then
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
    values (v_submitter_auth, 'inhouse_production_requests', p_job_id, v_job.linked_task_id,
      'Factory needs clarification on ' || v_job.job_order_number || ': ' || p_reason,
      'ફેક્ટરીને ' || v_job.job_order_number || ' પર સ્પષ્ટતા જોઈએ છે: ' || p_reason);
  end if;

  perform public.staff_write_audit('factory_clarification_requests', v_clar_id, 'CLARIFICATION_REQUESTED',
    null, jsonb_build_object('job_id', p_job_id, 'reason', p_reason, 'project_id', v_job.project_id), null);

  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id,
      'Clarification requested by ' || v_actor_name || ': ' || p_reason,
      v_actor_name || ' દ્વારા સ્પષ્ટતા મંગાઈ: ' || p_reason);
  end if;

  return v_clar_id;
end;
$function$;

revoke all on function public.factory_request_clarification(uuid,text,text,text) from public;
grant execute on function public.factory_request_clarification(uuid,text,text,text) to authenticated;

create or replace function public.interior_upload_clarification_revision(
  p_clarification_id uuid, p_document_path text, p_notes text default null
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_clar public.factory_clarification_requests%rowtype;
  v_job public.inhouse_production_requests%rowtype;
  v_next_rev int; v_rev_id uuid; v_actor_name text;
  v_coord_auth uuid; v_second_auth uuid;
begin
  perform public.staff_assert_operational();
  if p_document_path is null or btrim(p_document_path) = '' then
    raise exception 'A revised document is required';
  end if;

  select * into v_clar from public.factory_clarification_requests where id = p_clarification_id for update;
  if v_clar.id is null then raise exception 'Clarification not found'; end if;
  if v_clar.status not in ('open', 'rejected') then
    raise exception 'This clarification is not awaiting a revision (status: %)', v_clar.status;
  end if;

  select * into v_job from public.inhouse_production_requests where id = v_clar.job_id;
  if not (public.interior_is_org_wide() or public.interior_is_project_member(v_clar.project_id)) then
    raise exception 'You are not authorized to respond to this clarification';
  end if;

  select coalesce(max(revision_number), 0) + 1 into v_next_rev from public.factory_clarification_revisions where clarification_id = p_clarification_id;

  insert into public.factory_clarification_revisions (clarification_id, revision_number, document_path, notes, uploaded_by)
  values (p_clarification_id, v_next_rev, p_document_path, p_notes, auth.uid())
  returning id into v_rev_id;

  update public.factory_clarification_requests set status = 'revision_uploaded' where id = p_clarification_id;

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();
  select auth_id into v_coord_auth from public.profiles where id = v_job.assigned_factory_coordinator;
  select auth_id into v_second_auth from public.profiles where id = v_job.second_assignee_coordinator;

  if v_coord_auth is not null then
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
    values (v_coord_auth, 'inhouse_production_requests', v_clar.job_id, v_job.linked_task_id,
      'Revision ' || v_next_rev || ' uploaded for ' || v_job.job_order_number, 'સુધારો ' || v_next_rev || ' અપલોડ થયો: ' || v_job.job_order_number);
  end if;
  if v_second_auth is not null and v_second_auth is distinct from v_coord_auth then
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
    values (v_second_auth, 'inhouse_production_requests', v_clar.job_id, v_job.linked_task_id,
      'Revision ' || v_next_rev || ' uploaded for ' || v_job.job_order_number, 'સુધારો ' || v_next_rev || ' અપલોડ થયો: ' || v_job.job_order_number);
  end if;

  perform public.staff_write_audit('factory_clarification_revisions', v_rev_id, 'REVISION_UPLOADED',
    null, jsonb_build_object('clarification_id', p_clarification_id, 'revision_number', v_next_rev, 'project_id', v_clar.project_id), null);

  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id,
      'Revision ' || v_next_rev || ' uploaded by ' || v_actor_name || coalesce(': ' || p_notes, ''),
      v_actor_name || ' દ્વારા સુધારો ' || v_next_rev || ' અપલોડ થયો' || coalesce(': ' || p_notes, ''));
  end if;

  return v_rev_id;
end;
$function$;

revoke all on function public.interior_upload_clarification_revision(uuid,text,text) from public;
grant execute on function public.interior_upload_clarification_revision(uuid,text,text) to authenticated;

create or replace function public.factory_decide_clarification_revision(
  p_revision_id uuid, p_decision text, p_notes text default null
) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_rev public.factory_clarification_revisions%rowtype;
  v_clar public.factory_clarification_requests%rowtype;
  v_job public.inhouse_production_requests%rowtype;
  v_my_profile uuid; v_actor_name text;
  v_lead_exec_auth uuid; v_submitter_auth uuid;
begin
  perform public.staff_assert_operational();
  if p_decision not in ('accepted', 'rejected') then raise exception 'Invalid decision'; end if;

  select * into v_rev from public.factory_clarification_revisions where id = p_revision_id for update;
  if v_rev.id is null then raise exception 'Revision not found'; end if;
  select * into v_clar from public.factory_clarification_requests where id = v_rev.clarification_id for update;
  select * into v_job from public.inhouse_production_requests where id = v_clar.job_id;
  select id into v_my_profile from public.profiles where auth_id = auth.uid();

  if not (
    public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_factory_staff() and (
      v_job.assigned_factory_coordinator = v_my_profile or v_job.second_assignee_coordinator = v_my_profile
      or v_job.current_responsible_person = v_my_profile or public.staff_is_dept_head()
    ))
  ) then
    raise exception 'You are not authorized to decide on this revision';
  end if;

  update public.factory_clarification_revisions set decision = p_decision, decided_by = auth.uid(), decided_at = now(), decision_notes = p_notes where id = p_revision_id;
  update public.factory_clarification_requests set
    status = case when p_decision = 'accepted' then 'resolved' else 'rejected' end,
    resolved_by = case when p_decision = 'accepted' then auth.uid() else resolved_by end,
    resolved_at = case when p_decision = 'accepted' then now() else resolved_at end
  where id = v_clar.id;

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();
  select p.auth_id into v_lead_exec_auth from public.projects pr join public.profiles p on p.id = pr.lead_executive_id where pr.id = v_clar.project_id;
  select p.auth_id into v_submitter_auth from public.profiles p where p.id = v_job.submitted_by;

  if v_lead_exec_auth is not null then
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
    values (v_lead_exec_auth, 'inhouse_production_requests', v_clar.job_id, v_job.linked_task_id,
      'Revision ' || p_decision || ' for ' || v_job.job_order_number, 'સુધારો ' || p_decision || ': ' || v_job.job_order_number);
  end if;
  if v_submitter_auth is not null and v_submitter_auth is distinct from v_lead_exec_auth then
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
    values (v_submitter_auth, 'inhouse_production_requests', v_clar.job_id, v_job.linked_task_id,
      'Revision ' || p_decision || ' for ' || v_job.job_order_number, 'સુધારો ' || p_decision || ': ' || v_job.job_order_number);
  end if;

  perform public.staff_write_audit('factory_clarification_revisions', p_revision_id, 'REVISION_' || upper(p_decision),
    null, jsonb_build_object('clarification_id', v_clar.id, 'notes', p_notes, 'project_id', v_clar.project_id), null);

  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id,
      'Revision ' || p_decision || ' by ' || v_actor_name || coalesce(': ' || p_notes, ''),
      v_actor_name || ' દ્વારા સુધારો ' || p_decision || coalesce(': ' || p_notes, ''));
  end if;
end;
$function$;

revoke all on function public.factory_decide_clarification_revision(uuid,text,text) from public;
grant execute on function public.factory_decide_clarification_revision(uuid,text,text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Completion Handover.
-- ---------------------------------------------------------------------
alter table public.inhouse_production_requests
  add column if not exists actual_completed_quantity numeric,
  add column if not exists completion_notes text,
  add column if not exists completion_photos text[],
  add column if not exists completed_by uuid references public.user_profiles(id),
  add column if not exists completed_at timestamptz,
  add column if not exists interior_confirmed boolean not null default false,
  add column if not exists interior_confirmed_by uuid references public.user_profiles(id),
  add column if not exists interior_confirmed_at timestamptz,
  add column if not exists interior_issue_raised boolean not null default false,
  add column if not exists interior_issue_notes text,
  add column if not exists final_closed_at timestamptz;

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

  select result into v_latest_qc from public.factory_quality_checks where job_id = p_job_id order by created_at desc limit 1;
  if v_latest_qc is null or v_latest_qc = 'fail' then
    raise exception 'QC approval (Pass or Conditional Pass) is required before completion can be submitted';
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

revoke all on function public.factory_submit_completion(uuid,numeric,text[],text) from public;
grant execute on function public.factory_submit_completion(uuid,numeric,text[],text) to authenticated;

create or replace function public.interior_confirm_completion(p_job_id uuid, p_notes text default null) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_job public.inhouse_production_requests%rowtype;
  v_actor_name text; v_coord_auth uuid; v_second_auth uuid;
begin
  perform public.staff_assert_operational();
  select * into v_job from public.inhouse_production_requests where id = p_job_id for update;
  if v_job.id is null then raise exception 'Job not found'; end if;
  if not (public.interior_is_org_wide() or public.interior_is_project_member(v_job.project_id)) then
    raise exception 'You are not authorized to confirm completion for this job';
  end if;
  if v_job.completed_at is null then
    raise exception 'Factory has not submitted a completion for this job yet';
  end if;
  if v_job.final_closed_at is not null then
    raise exception 'This job is already closed';
  end if;

  update public.inhouse_production_requests set
    interior_confirmed = true, interior_confirmed_by = auth.uid(), interior_confirmed_at = now(),
    interior_issue_raised = false, final_closed_at = now(), updated_at = now()
  where id = p_job_id;

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();
  select auth_id into v_coord_auth from public.profiles where id = v_job.assigned_factory_coordinator;
  select auth_id into v_second_auth from public.profiles where id = v_job.second_assignee_coordinator;

  if v_coord_auth is not null then
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
    values (v_coord_auth, 'inhouse_production_requests', p_job_id, v_job.linked_task_id,
      'Interior confirmed completion of ' || v_job.job_order_number, 'ઇન્ટિરિયરે ' || v_job.job_order_number || ' ની પૂર્ણતા પુષ્ટિ કરી');
  end if;
  if v_second_auth is not null and v_second_auth is distinct from v_coord_auth then
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
    values (v_second_auth, 'inhouse_production_requests', p_job_id, v_job.linked_task_id,
      'Interior confirmed completion of ' || v_job.job_order_number, 'ઇન્ટિરિયરે ' || v_job.job_order_number || ' ની પૂર્ણતા પુષ્ટિ કરી');
  end if;

  perform public.staff_write_audit('inhouse_production_requests', p_job_id, 'COMPLETION_CONFIRMED',
    null, jsonb_build_object('notes', p_notes, 'project_id', v_job.project_id), null);

  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id,
      'Completion confirmed by Interior (' || v_actor_name || ') — job closed' || coalesce(': ' || p_notes, ''),
      'ઇન્ટિરિયર (' || v_actor_name || ') દ્વારા પૂર્ણતા પુષ્ટિ — કામ બંધ' || coalesce(': ' || p_notes, ''));
  end if;
end;
$function$;

revoke all on function public.interior_confirm_completion(uuid,text) from public;
grant execute on function public.interior_confirm_completion(uuid,text) to authenticated;

create or replace function public.interior_raise_completion_issue(p_job_id uuid, p_issue_notes text) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_job public.inhouse_production_requests%rowtype;
  v_actor_name text; v_coord_auth uuid; v_second_auth uuid;
begin
  perform public.staff_assert_operational();
  if p_issue_notes is null or btrim(p_issue_notes) = '' then
    raise exception 'An issue description is required';
  end if;

  select * into v_job from public.inhouse_production_requests where id = p_job_id for update;
  if v_job.id is null then raise exception 'Job not found'; end if;
  if not (public.interior_is_org_wide() or public.interior_is_project_member(v_job.project_id)) then
    raise exception 'You are not authorized to raise a completion issue for this job';
  end if;
  if v_job.completed_at is null then
    raise exception 'Factory has not submitted a completion for this job yet';
  end if;
  if v_job.final_closed_at is not null then
    raise exception 'This job is already closed';
  end if;

  update public.inhouse_production_requests set
    interior_issue_raised = true, interior_issue_notes = p_issue_notes,
    completed_at = null, completed_by = null, status = 'Rework', updated_at = now()
  where id = p_job_id;

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();
  select auth_id into v_coord_auth from public.profiles where id = v_job.assigned_factory_coordinator;
  select auth_id into v_second_auth from public.profiles where id = v_job.second_assignee_coordinator;

  if v_coord_auth is not null then
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
    values (v_coord_auth, 'inhouse_production_requests', p_job_id, v_job.linked_task_id,
      'Interior raised an issue on ' || v_job.job_order_number || ': ' || p_issue_notes,
      'ઇન્ટિરિયરે ' || v_job.job_order_number || ' પર સમસ્યા ઉઠાવી: ' || p_issue_notes);
  end if;
  if v_second_auth is not null and v_second_auth is distinct from v_coord_auth then
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
    values (v_second_auth, 'inhouse_production_requests', p_job_id, v_job.linked_task_id,
      'Interior raised an issue on ' || v_job.job_order_number || ': ' || p_issue_notes,
      'ઇન્ટિરિયરે ' || v_job.job_order_number || ' પર સમસ્યા ઉઠાવી: ' || p_issue_notes);
  end if;

  perform public.staff_write_audit('inhouse_production_requests', p_job_id, 'COMPLETION_ISSUE_RAISED',
    null, jsonb_build_object('issue_notes', p_issue_notes, 'project_id', v_job.project_id), null);

  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id,
      'Completion issue raised by Interior (' || v_actor_name || '): ' || p_issue_notes,
      'ઇન્ટિરિયર (' || v_actor_name || ') દ્વારા પૂર્ણતા સમસ્યા ઉઠાવાઈ: ' || p_issue_notes);
  end if;
end;
$function$;

revoke all on function public.interior_raise_completion_issue(uuid,text) from public;
grant execute on function public.interior_raise_completion_issue(uuid,text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Realtime for the two new tables.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'factory_clarification_requests') then
    execute 'alter publication supabase_realtime add table public.factory_clarification_requests';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'factory_clarification_revisions') then
    execute 'alter publication supabase_realtime add table public.factory_clarification_revisions';
  end if;
end $$;
