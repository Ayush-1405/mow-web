-- mvp_pilot_factory_ai_intake_v2_75
--
-- Phase 1 of the AI-powered Factory intake system ("Task/Excel/Document ->
-- Claude Extraction -> AI Draft Request -> Head/Supervisor/Admin Verify ->
-- Factory Job Auto-created" -- Sections 1-6 of the spec; assignment
-- suggestions, material suggestions, production planning, the triage inbox,
-- automated communication and reports are later phases, by explicit
-- agreement).
--
-- DESIGN DECISIONS (why the schema looks like this):
--
-- 1. factory_ai_requests is a NEW, standalone table -- not bolted onto
--    inhouse_production_requests -- because a request can come from ANY
--    department (Retail, HR, Accounts...), not only from a Purchase
--    Request, and because "the Job Card must not become active until
--    Verify & Accept" is trivially true when no Job Card row exists yet at
--    all pre-acceptance (no special draft status anywhere else in the app
--    has to learn to filter it out of dashboards/reports).
--
-- 2. Its own actor columns (created_by, reviewed_by) use user_profiles(id)
--    (the universal auth-space id every employee has), NOT profiles(id).
--    profiles rows are auto-synced only for Interior and Factory department
--    employees (see interior_sync_profile_from_user_profile()) -- a Retail
--    or HR employee submitting a request has no profiles row at all, so
--    keying this new table's own identity columns to profiles would silently
--    break for most of the very departments this feature is meant to serve.
--
-- 3. Once a request is Accepted, a REAL inhouse_production_requests row is
--    created (via factory_ai_accept_request below) -- it becomes an
--    ordinary Factory Job, inheriting the entire existing stage system, Job
--    Card UI, dashboard and reports for free. This requires
--    inhouse_production_requests.purchase_request_id to become nullable
--    (it is currently NOT NULL, tying every job to a Purchase Request) --
--    the UNIQUE constraint stays and is unaffected (Postgres UNIQUE already
--    treats multiple NULLs as non-conflicting).
--
-- 4. All writes to the 3 new tables go through SECURITY DEFINER RPCs, never
--    direct table access -- the exact same "SELECT-only RLS, RPC for every
--    mutation" pattern already used by factory_drawings/production_stage_updates
--    elsewhere in this schema. The two RPCs the Edge Function itself calls
--    (factory_ai_store_extraction, factory_ai_mark_failed) are additionally
--    revoked from `authenticated`/`anon` and granted only to `service_role`
--    -- an ordinary logged-in user calling them directly is rejected at the
--    grant level, not merely by an internal check, so AI results can never
--    be forged by a client pretending to be the pipeline.
--
-- No existing table is dropped, no existing column is removed or narrowed,
-- and no existing row is touched by this migration.

-- ---------------------------------------------------------------------
-- 1. inhouse_production_requests: make room for a non-Purchase-sourced job.
-- ---------------------------------------------------------------------
alter table public.inhouse_production_requests alter column purchase_request_id drop not null;
alter table public.inhouse_production_requests add column if not exists source_department_id uuid references public.departments(id);
alter table public.inhouse_production_requests add column if not exists ai_request_id uuid;

-- ---------------------------------------------------------------------
-- 2. factory_ai_requests -- the "Factory Request" record (Section 4).
-- ---------------------------------------------------------------------
create table public.factory_ai_requests (
  id uuid primary key default gen_random_uuid(),
  request_number text not null unique,
  idempotency_key text not null unique,

  source_department_id uuid not null references public.departments(id),
  source_record_type text,
  source_record_id uuid,
  project_id uuid references public.projects(id),

  work_title text not null,
  work_description text,
  priority text not null default 'Normal' check (priority in ('Normal', 'High', 'Urgent', 'Emergency')),
  required_date date,

  status text not null default 'uploaded' check (status in (
    'uploaded', 'processing', 'extracted', 'needs_review', 'accepted', 'rejected', 'failed'
  )),

  ai_model text,
  ai_prompt_version text,
  ai_extraction jsonb,
  ai_confidence_overall numeric,
  ai_processed_at timestamptz,
  ai_failure_reason text,
  ai_served_from_cache boolean not null default false,

  verified_extraction jsonb,
  clarification_note text,
  rejection_reason text,

  factory_job_id uuid references public.inhouse_production_requests(id),

  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_by uuid references public.user_profiles(id),
  reviewed_at timestamptz,

  is_test_data boolean not null default false,
  test_batch_id text
);
create index factory_ai_requests_status_idx on public.factory_ai_requests(status);
create index factory_ai_requests_project_idx on public.factory_ai_requests(project_id);
create index factory_ai_requests_source_dept_idx on public.factory_ai_requests(source_department_id);
create index factory_ai_requests_created_by_idx on public.factory_ai_requests(created_by);

alter table public.inhouse_production_requests add constraint inhouse_production_requests_ai_request_id_fkey
  foreign key (ai_request_id) references public.factory_ai_requests(id);

-- ---------------------------------------------------------------------
-- 3. factory_ai_attachments -- the uploaded source file(s) (Section 2).
-- ---------------------------------------------------------------------
create table public.factory_ai_attachments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.factory_ai_requests(id) on delete cascade,
  storage_path text not null,
  original_file_name text not null,
  mime_type text,
  file_size bigint,
  checksum text,
  uploaded_by uuid not null references public.user_profiles(id),
  uploaded_at timestamptz not null default now()
);
create index factory_ai_attachments_request_idx on public.factory_ai_attachments(request_id);
create index factory_ai_attachments_checksum_idx on public.factory_ai_attachments(checksum);

-- ---------------------------------------------------------------------
-- 4. factory_ai_request_corrections -- audit trail of human edits to the
--    extraction (Section 15: "never overwrite the original extracted
--    result -- store corrections separately or preserve version history").
-- ---------------------------------------------------------------------
create table public.factory_ai_request_corrections (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.factory_ai_requests(id) on delete cascade,
  corrected_fields jsonb not null,
  corrected_by uuid not null references public.user_profiles(id),
  corrected_at timestamptz not null default now()
);
create index factory_ai_request_corrections_request_idx on public.factory_ai_request_corrections(request_id);

-- ---------------------------------------------------------------------
-- 5. Storage: a dedicated bucket, separate from interior-attachments.
--    interior-attachments' RLS trust model is Interior-project/Factory-job
--    specific; this feature must work for a Retail/HR/Accounts employee who
--    has neither, so it gets its own simple, narrowly-scoped bucket instead
--    of overloading (or weakening) an existing one.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
  values ('factory-ai-attachments', 'factory-ai-attachments', false)
  on conflict (id) do nothing;

create policy "factory_ai_attachments_storage_insert" on storage.objects
  for insert
  with check (
    bucket_id = 'factory-ai-attachments'
    and exists (select 1 from public.user_profiles up where up.id = auth.uid() and up.is_active = true)
  );

create policy "factory_ai_attachments_storage_select" on storage.objects
  for select
  using (
    bucket_id = 'factory-ai-attachments'
    and (
      public.staff_is_management() or public.staff_is_super_admin()
      or exists (
        select 1 from public.factory_ai_attachments a
        join public.factory_ai_requests r on r.id = a.request_id
        where a.storage_path = storage.objects.name
          and (
            r.created_by = auth.uid()
            or (public.staff_is_factory_staff() and (public.staff_is_dept_head() or public.staff_is_supervisor()))
            or (r.source_department_id = public.staff_current_department_id() and (public.staff_is_dept_head() or public.staff_is_supervisor()))
          )
      )
    )
  );

-- ---------------------------------------------------------------------
-- 6. RLS -- SELECT only. Every mutation goes through a SECURITY DEFINER
--    RPC below (same convention as factory_drawings / production_stage_updates).
-- ---------------------------------------------------------------------
alter table public.factory_ai_requests enable row level security;
grant select on public.factory_ai_requests to authenticated;
create policy "factory_ai_requests_select" on public.factory_ai_requests for select using (
  created_by = auth.uid()
  or public.staff_is_management() or public.staff_is_super_admin()
  or (public.staff_is_factory_staff() and (public.staff_is_dept_head() or public.staff_is_supervisor()))
  or (source_department_id = public.staff_current_department_id() and (public.staff_is_dept_head() or public.staff_is_supervisor()))
);

alter table public.factory_ai_attachments enable row level security;
grant select on public.factory_ai_attachments to authenticated;
create policy "factory_ai_attachments_select" on public.factory_ai_attachments for select using (
  exists (
    select 1 from public.factory_ai_requests r where r.id = request_id and (
      r.created_by = auth.uid()
      or public.staff_is_management() or public.staff_is_super_admin()
      or (public.staff_is_factory_staff() and (public.staff_is_dept_head() or public.staff_is_supervisor()))
      or (r.source_department_id = public.staff_current_department_id() and (public.staff_is_dept_head() or public.staff_is_supervisor()))
    )
  )
);

alter table public.factory_ai_request_corrections enable row level security;
grant select on public.factory_ai_request_corrections to authenticated;
create policy "factory_ai_request_corrections_select" on public.factory_ai_request_corrections for select using (
  exists (
    select 1 from public.factory_ai_requests r where r.id = request_id and (
      r.created_by = auth.uid()
      or public.staff_is_management() or public.staff_is_super_admin()
      or (public.staff_is_factory_staff() and (public.staff_is_dept_head() or public.staff_is_supervisor()))
      or (r.source_department_id = public.staff_current_department_id() and (public.staff_is_dept_head() or public.staff_is_supervisor()))
    )
  )
);

-- ---------------------------------------------------------------------
-- 7. Shared authorization helper -- "Factory Head, Production Supervisor
--    or Factory Admin" (Admin == company-wide management/sysadmin, the
--    same "admin" tier used by every other Factory RPC in this schema --
--    there is no separate role code for it).
-- ---------------------------------------------------------------------
create or replace function public.factory_ai_is_reviewer()
returns boolean
language sql stable security definer set search_path to 'public'
as $function$
  select public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_factory_staff() and (public.staff_is_dept_head() or public.staff_is_supervisor()));
$function$;

-- ---------------------------------------------------------------------
-- 8. factory_ai_submit_request -- Section 1's "Send to Factory" button.
--    Idempotent on p_idempotency_key (client generates one uuid per form
--    session and reuses it across retries of the same submission).
-- ---------------------------------------------------------------------
create or replace function public.factory_ai_submit_request(
  p_idempotency_key text, p_project_id uuid, p_work_title text, p_work_description text default null,
  p_required_date date default null, p_priority text default 'Normal'
)
returns table(request_id uuid, request_number text, already_submitted boolean)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_existing record;
  v_dept_id uuid;
  v_id uuid; v_number text;
begin
  perform public.staff_assert_operational();
  if coalesce(btrim(p_work_title), '') = '' then raise exception 'A work title or instruction is required'; end if;
  if p_priority not in ('Normal', 'High', 'Urgent', 'Emergency') then raise exception 'Invalid priority'; end if;

  select * into v_existing from public.factory_ai_requests where idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    return query select v_existing.id, v_existing.request_number, true;
    return;
  end if;

  select department_id into v_dept_id from public.user_profiles where id = auth.uid();
  if v_dept_id is null then raise exception 'Your department could not be resolved -- please contact an administrator'; end if;

  select 'FR-' || lpad((select count(*) + 1 from public.factory_ai_requests)::text, 6, '0') into v_number;

  insert into public.factory_ai_requests (
    request_number, idempotency_key, source_department_id, project_id, work_title, work_description,
    priority, required_date, status, created_by
  ) values (
    v_number, p_idempotency_key, v_dept_id, p_project_id, btrim(p_work_title), p_work_description,
    p_priority, p_required_date, 'uploaded', auth.uid()
  ) returning id into v_id;

  perform public.staff_write_audit('factory_ai_requests', v_id, 'CREATE', null,
    jsonb_build_object('request_number', v_number, 'project_id', p_project_id, 'source_department_id', v_dept_id), v_dept_id, null);

  return query select v_id, v_number, false;
end;
$function$;
revoke all on function public.factory_ai_submit_request(text, uuid, text, text, date, text) from public;
grant execute on function public.factory_ai_submit_request(text, uuid, text, text, date, text) to authenticated;

-- ---------------------------------------------------------------------
-- 9. factory_ai_add_attachment -- one call per uploaded file.
-- ---------------------------------------------------------------------
create or replace function public.factory_ai_add_attachment(
  p_request_id uuid, p_storage_path text, p_original_file_name text, p_mime_type text default null,
  p_file_size bigint default null, p_checksum text default null
)
returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_request public.factory_ai_requests%rowtype;
  v_id uuid;
begin
  perform public.staff_assert_operational();
  select * into v_request from public.factory_ai_requests where id = p_request_id;
  if v_request.id is null then raise exception 'Request not found'; end if;
  if v_request.created_by <> auth.uid() then raise exception 'You are not authorized to attach a file to this request'; end if;
  if p_storage_path is null or btrim(p_storage_path) = '' then raise exception 'A file is required'; end if;

  insert into public.factory_ai_attachments (request_id, storage_path, original_file_name, mime_type, file_size, checksum, uploaded_by)
  values (p_request_id, p_storage_path, p_original_file_name, p_mime_type, p_file_size, p_checksum, auth.uid())
  returning id into v_id;

  return v_id;
end;
$function$;
revoke all on function public.factory_ai_add_attachment(uuid, text, text, text, bigint, text) from public;
grant execute on function public.factory_ai_add_attachment(uuid, text, text, text, bigint, text) to authenticated;

-- ---------------------------------------------------------------------
-- 10. factory_ai_notify_reviewers -- Factory Head + Production Supervisor
--     (Factory department) + company-wide Management/Sysadmin. Deliberately
--     NOT a widening of the existing staff_notify_dept_leadership() (that
--     function is used by unrelated Interior features and does not include
--     supervisors -- changing it would change notification behaviour for
--     those features too, outside this request's scope).
-- ---------------------------------------------------------------------
create or replace function public.factory_ai_notify_reviewers(p_request_id uuid, p_title_en text, p_title_gu text)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_factory_dept uuid;
  r record;
begin
  select id into v_factory_dept from public.departments where code = 'FACTORY';
  for r in
    select up.id from public.user_profiles up join public.roles ro on ro.id = up.role_id
    where up.is_active = true
      and (
        ro.code = 'management' or ro.code = 'sysadmin'
        or (up.department_id = v_factory_dept and ro.code in ('dept_head', 'supervisor'))
      )
  loop
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (r.id, 'FACTORY_AI_REQUEST', p_request_id, p_title_en, p_title_gu);
  end loop;
end;
$function$;
-- Internal helper only -- called from within factory_ai_store_extraction /
-- factory_ai_mark_failed (a function's owner may always call another
-- function it owns regardless of grants). No client should ever invoke
-- this directly with an arbitrary request_id/title of their choosing.
revoke all on function public.factory_ai_notify_reviewers(uuid, text, text) from public, authenticated, anon;

-- ---------------------------------------------------------------------
-- 11. factory_ai_store_extraction / factory_ai_mark_failed -- called ONLY
--     by the Edge Function (using the service-role key). auth.uid() is not
--     meaningful for a service-role caller, so these do not (and cannot)
--     use staff_assert_operational() -- instead they are locked down at the
--     grant level below (service_role only), which an ordinary logged-in
--     user cannot obtain regardless of what they call this function with.
-- ---------------------------------------------------------------------
create or replace function public.factory_ai_store_extraction(
  p_request_id uuid, p_extraction jsonb, p_model text, p_prompt_version text,
  p_confidence_overall numeric, p_served_from_cache boolean default false
)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_request public.factory_ai_requests%rowtype;
begin
  select * into v_request from public.factory_ai_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'Request not found'; end if;

  update public.factory_ai_requests set
    status = 'needs_review',
    ai_extraction = p_extraction,
    ai_model = p_model,
    ai_prompt_version = p_prompt_version,
    ai_confidence_overall = p_confidence_overall,
    ai_processed_at = now(),
    ai_served_from_cache = p_served_from_cache,
    ai_failure_reason = null,
    updated_at = now()
  where id = p_request_id;

  perform public.staff_write_audit('factory_ai_requests', p_request_id, 'AI_EXTRACTED',
    null, jsonb_build_object('model', p_model, 'confidence', p_confidence_overall, 'served_from_cache', p_served_from_cache),
    v_request.source_department_id, null);

  perform public.factory_ai_notify_reviewers(p_request_id,
    'A new Factory Request is ready for your review: ' || v_request.request_number,
    v_request.request_number || ' Factory Request સમીક્ષા માટે તૈયાર છે');
end;
$function$;
revoke all on function public.factory_ai_store_extraction(uuid, jsonb, text, text, numeric, boolean) from public, authenticated, anon;
grant execute on function public.factory_ai_store_extraction(uuid, jsonb, text, text, numeric, boolean) to service_role;

create or replace function public.factory_ai_mark_failed(p_request_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_request public.factory_ai_requests%rowtype;
begin
  select * into v_request from public.factory_ai_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'Request not found'; end if;

  update public.factory_ai_requests set status = 'failed', ai_failure_reason = p_reason, updated_at = now() where id = p_request_id;

  perform public.staff_write_audit('factory_ai_requests', p_request_id, 'AI_FAILED', null,
    jsonb_build_object('reason', p_reason), v_request.source_department_id, null);

  perform public.factory_ai_notify_reviewers(p_request_id,
    'AI extraction failed for Factory Request ' || v_request.request_number || ' -- manual review needed',
    v_request.request_number || ' માટે AI એક્સટ્રેક્શન નિષ્ફળ ગયું -- મેન્યુઅલ સમીક્ષા જરૂરી');
end;
$function$;
revoke all on function public.factory_ai_mark_failed(uuid, text) from public, authenticated, anon;
grant execute on function public.factory_ai_mark_failed(uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- 12. factory_ai_correct_extraction -- inline correction on the
--     Verification screen. Reviewer-only. Never touches ai_extraction
--     (the original AI output); merges into verified_extraction and keeps
--     a full history row per edit.
-- ---------------------------------------------------------------------
create or replace function public.factory_ai_correct_extraction(p_request_id uuid, p_corrected_fields jsonb)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_request public.factory_ai_requests%rowtype;
begin
  perform public.staff_assert_operational();
  if not public.factory_ai_is_reviewer() then raise exception 'You are not authorized to review Factory Requests'; end if;
  select * into v_request from public.factory_ai_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'Request not found'; end if;
  if v_request.status not in ('needs_review', 'extracted', 'failed') then
    raise exception 'This request is no longer open for review';
  end if;

  update public.factory_ai_requests set
    verified_extraction = coalesce(v_request.verified_extraction, v_request.ai_extraction, '{}'::jsonb) || p_corrected_fields,
    updated_at = now()
  where id = p_request_id;

  insert into public.factory_ai_request_corrections (request_id, corrected_fields, corrected_by)
  values (p_request_id, p_corrected_fields, auth.uid());

  perform public.staff_write_audit('factory_ai_requests', p_request_id, 'AI_CORRECTED', null, p_corrected_fields, v_request.source_department_id, null);
end;
$function$;
grant execute on function public.factory_ai_correct_extraction(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 13. factory_ai_reject_request / factory_ai_request_clarification.
-- ---------------------------------------------------------------------
create or replace function public.factory_ai_reject_request(p_request_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_request public.factory_ai_requests%rowtype;
begin
  perform public.staff_assert_operational();
  if not public.factory_ai_is_reviewer() then raise exception 'You are not authorized to review Factory Requests'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to reject a Factory Request'; end if;
  select * into v_request from public.factory_ai_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'Request not found'; end if;
  if v_request.status in ('accepted', 'rejected') then raise exception 'This request has already been decided'; end if;

  update public.factory_ai_requests set
    status = 'rejected', rejection_reason = p_reason, reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
  where id = p_request_id;

  perform public.staff_write_audit('factory_ai_requests', p_request_id, 'REJECTED', null, jsonb_build_object('reason', p_reason), v_request.source_department_id, null);

  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  values (v_request.created_by, 'FACTORY_AI_REQUEST', p_request_id,
    'Your Factory Request ' || v_request.request_number || ' was rejected: ' || p_reason,
    v_request.request_number || ' Factory Request નકારવામાં આવી: ' || p_reason);
end;
$function$;
grant execute on function public.factory_ai_reject_request(uuid, text) to authenticated;

create or replace function public.factory_ai_request_clarification(p_request_id uuid, p_note text)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_request public.factory_ai_requests%rowtype;
begin
  perform public.staff_assert_operational();
  if not public.factory_ai_is_reviewer() then raise exception 'You are not authorized to review Factory Requests'; end if;
  if coalesce(btrim(p_note), '') = '' then raise exception 'Please describe what needs clarification'; end if;
  select * into v_request from public.factory_ai_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'Request not found'; end if;
  if v_request.status in ('accepted', 'rejected') then raise exception 'This request has already been decided'; end if;

  update public.factory_ai_requests set clarification_note = p_note, updated_at = now() where id = p_request_id;

  perform public.staff_write_audit('factory_ai_requests', p_request_id, 'CLARIFICATION_REQUESTED', null, jsonb_build_object('note', p_note), v_request.source_department_id, null);

  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  values (v_request.created_by, 'FACTORY_AI_REQUEST', p_request_id,
    'Clarification needed on your Factory Request ' || v_request.request_number || ': ' || p_note,
    v_request.request_number || ' પર સ્પષ્ટતા જરૂરી: ' || p_note);
end;
$function$;
grant execute on function public.factory_ai_request_clarification(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 14. factory_ai_accept_request -- the ONLY place a real Factory Job
--     (inhouse_production_requests row) gets created from an AI request.
--     Idempotent on factory_job_id (refresh/double-click safe, same
--     "already_submitted" pattern as staff_submit_to_factory).
-- ---------------------------------------------------------------------
create or replace function public.factory_ai_accept_request(
  p_request_id uuid, p_assigned_factory_coordinator uuid, p_second_assignee uuid default null,
  p_product_item text default null, p_quantity numeric default null, p_unit text default null,
  p_required_completion_date date default null
)
returns table(job_id uuid, job_order_number text, already_accepted boolean)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_request public.factory_ai_requests%rowtype;
  v_job_id uuid; v_job_order_number text;
  v_factory_dept uuid;
  v_coordinator_auth uuid; v_second_auth uuid; v_submitted_by_profile uuid;
  v_task record;
  v_final jsonb;
begin
  perform public.staff_assert_operational();
  if not public.factory_ai_is_reviewer() then raise exception 'You are not authorized to accept Factory Requests'; end if;
  if p_assigned_factory_coordinator is null then raise exception 'An Assigned Factory Coordinator is required'; end if;

  select * into v_request from public.factory_ai_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'Request not found'; end if;

  if v_request.factory_job_id is not null then
    select job_order_number into v_job_order_number from public.inhouse_production_requests where id = v_request.factory_job_id;
    return query select v_request.factory_job_id, v_job_order_number, true;
    return;
  end if;
  if v_request.status = 'rejected' then raise exception 'This request was already rejected'; end if;

  -- p_assigned_factory_coordinator is a profiles.id (Interior-space, the
  -- same space every other Factory Coordinator dropdown in this app already
  -- returns) -- resolved to its auth_id for the linked task, exactly like
  -- staff_submit_to_factory does.
  select auth_id into v_coordinator_auth from public.profiles where id = p_assigned_factory_coordinator;
  if v_coordinator_auth is null then
    raise exception 'The selected Factory Coordinator has no linked staff login and cannot be assigned a task';
  end if;
  if p_second_assignee is not null then
    select auth_id into v_second_auth from public.profiles where id = p_second_assignee;
    if v_second_auth is null then raise exception 'The selected Second Assignee has no linked staff login and cannot be assigned a task'; end if;
  end if;

  select id into v_factory_dept from public.departments where code = 'FACTORY';
  select id into v_submitted_by_profile from public.profiles where auth_id = v_request.created_by;

  -- verified_extraction already carries every AI field merged with human
  -- corrections (factory_ai_correct_extraction keeps it up to date); it
  -- wins over the raw ai_extraction wherever both set the same key.
  v_final := coalesce(v_request.ai_extraction, '{}'::jsonb) || coalesce(v_request.verified_extraction, '{}'::jsonb);

  select 'JO-' || lpad((select count(*) + 1 from public.inhouse_production_requests)::text, 6, '0') into v_job_order_number;

  insert into public.inhouse_production_requests (
    project_id, purchase_request_id, source_department_id, ai_request_id, product_item, quantity, unit,
    required_completion_date, assigned_factory_coordinator, second_assignee_coordinator, special_instructions,
    job_order_number, status, current_stage, completion_percentage, submitted_by, submitted_at
  ) values (
    v_request.project_id, null, v_request.source_department_id, v_request.id,
    coalesce(p_product_item, v_final->>'work_title', v_request.work_title),
    coalesce(p_quantity, (v_final->>'quantity')::numeric),
    coalesce(p_unit, v_final->>'unit'),
    coalesce(p_required_completion_date, v_request.required_date),
    p_assigned_factory_coordinator, p_second_assignee,
    coalesce(v_request.work_description, v_final->>'work_description'),
    v_job_order_number, 'Submitted to Factory', 'Planning', 0, v_submitted_by_profile, now()
  ) returning id into v_job_id;

  -- staff_create_task requires p_from_department_id to equal the CALLER's
  -- own department for every role except management/sysadmin (confirmed by
  -- reading its body) -- the caller here is the Factory reviewer accepting
  -- the request, not the originating department, so this is always Factory
  -- -> Factory (an intra-Factory task to the chosen coordinator), exactly
  -- mirroring how staff_submit_to_factory always uses the CALLER's own
  -- department as from_department_id. The cross-department origin is
  -- already captured separately on inhouse_production_requests.source_department_id
  -- and on the audit trail below -- nothing about that provenance is lost.
  select * into v_task from public.staff_create_task(
    'Factory Production: ' || coalesce(p_product_item, v_request.work_title),
    coalesce(v_request.work_description, 'AI-assisted Factory Request — ' || v_request.request_number),
    'FACTORY_REQUEST',
    case when v_request.priority = 'Emergency' then 'URGENT' else upper(v_request.priority) end,
    'none', v_factory_dept, v_factory_dept, v_coordinator_auth,
    coalesce(p_required_completion_date, v_request.required_date), null, null, v_job_order_number, '', coalesce(p_quantity::text, ''),
    v_second_auth, v_request.project_id
  );
  update public.inhouse_production_requests set linked_task_id = v_task.task_id where id = v_job_id;

  update public.factory_ai_requests set
    status = 'accepted', factory_job_id = v_job_id, reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
  where id = p_request_id;

  perform public.staff_write_audit('inhouse_production_requests', v_job_id, 'AI_JOB_ACCEPTED',
    null, jsonb_build_object('job_order_number', v_job_order_number, 'ai_request_id', p_request_id, 'coordinator', p_assigned_factory_coordinator), v_factory_dept, null);

  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  values (v_request.created_by, 'FACTORY_AI_REQUEST', p_request_id,
    'Your Factory Request ' || v_request.request_number || ' was accepted -- Job ' || v_job_order_number || ' created',
    v_request.request_number || ' સ્વીકારવામાં આવી -- જોબ ' || v_job_order_number || ' બનાવવામાં આવી');

  return query select v_job_id, v_job_order_number, false;
end;
$function$;
grant execute on function public.factory_ai_accept_request(uuid, uuid, uuid, text, numeric, text, date) to authenticated;
