-- mvp_pilot_factory_dashboard_phase1_v2_80
--
-- Phase 1 of the Factory operational dashboard: one Job Card source of truth,
-- automatic Job Card creation from any source department (no coordinator
-- required at submission), items, files, an audit timeline, ONE validated
-- status-transition function, role-aware visibility, and the read models the
-- dashboard needs (counts, inbox view, "my actions today").
--
-- SOURCE OF TRUTH: inhouse_production_requests stays THE Job Card. Nothing
-- is dropped or renamed. A new `factory_status` column carries the 9-value
-- Phase 1 status model; the existing free-text `status` column is kept and
-- synchronised in BOTH directions by a trigger, so every historical row and
-- every legacy screen/RPC that still reads or writes `status` keeps working:
--
--   pending_verification <-> Submitted to Factory / Draft
--   needs_clarification  <-> Needs Clarification (new label)
--   accepted             <-> Factory Accepted (no coordinator yet)
--   assigned             <-> Factory Accepted (coordinator set) / Material Check Pending /
--                            Raw Material Pending / Ready for Production
--   in_production        <-> Production Started / Work in Progress / QC Pending / QC Failed /
--                            Rework / QC Passed / Packing
--   blocked              <-> On Hold
--   ready_for_review     <-> Ready for Dispatch
--   completed            <-> Dispatched / Delivered / Installed / Completed
--   cancelled            <-> Cancelled
--
-- Additive only: no existing column is dropped or narrowed (project_id is
-- relaxed to nullable so Retail, which has no project, can submit).

-- ---------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------
alter table public.inhouse_production_requests alter column project_id drop not null;
alter table public.inhouse_production_requests
  add column if not exists factory_status text,
  add column if not exists source_module text,
  add column if not exists source_reference text,
  add column if not exists source_record_id uuid,
  add column if not exists project_code text,
  add column if not exists customer_name text,
  add column if not exists site_location text,
  add column if not exists priority text not null default 'Normal',
  add column if not exists requested_by uuid references public.user_profiles(id),
  add column if not exists idempotency_key text,
  add column if not exists viewed_at timestamptz,
  add column if not exists viewed_by uuid references public.user_profiles(id),
  add column if not exists clarification_note text,
  add column if not exists clarification_requested_at timestamptz,
  add column if not exists accepted_at timestamptz,
  add column if not exists accepted_by uuid references public.user_profiles(id),
  add column if not exists assigned_at timestamptz,
  add column if not exists assigned_by uuid references public.user_profiles(id),
  add column if not exists ready_at timestamptz,
  add column if not exists blocked_reason text,
  add column if not exists blocked_from text,
  add column if not exists cancelled_reason text;

alter table public.inhouse_production_requests drop constraint if exists inhouse_jobs_priority_check;
alter table public.inhouse_production_requests add constraint inhouse_jobs_priority_check
  check (priority in ('Normal', 'High', 'Urgent', 'Emergency'));

-- ---------------------------------------------------------------------
-- 2. Status mapping (one place) + backfill + two-way sync trigger
-- ---------------------------------------------------------------------
create or replace function public.factory_status_from_legacy(p_status text, p_has_coordinator boolean, p_completed boolean)
returns text language sql immutable as $$
  select case
    when p_completed then 'completed'
    when p_status in ('Draft', 'Submitted to Factory') then 'pending_verification'
    when p_status = 'Needs Clarification' then 'needs_clarification'
    when p_status = 'Factory Accepted' then case when p_has_coordinator then 'assigned' else 'accepted' end
    when p_status in ('Material Check Pending', 'Raw Material Pending', 'Ready for Production') then 'assigned'
    when p_status in ('Production Started', 'Work in Progress', 'QC Pending', 'QC Failed', 'Rework', 'QC Passed', 'Packing') then 'in_production'
    when p_status = 'On Hold' then 'blocked'
    when p_status = 'Ready for Dispatch' then 'ready_for_review'
    when p_status in ('Dispatched', 'Delivered', 'Installed', 'Completed') then 'completed'
    when p_status = 'Cancelled' then 'cancelled'
    else 'pending_verification' end
$$;

create or replace function public.factory_status_to_legacy(p_status text)
returns text language sql immutable as $$
  select case p_status
    when 'pending_verification' then 'Submitted to Factory'
    when 'needs_clarification' then 'Needs Clarification'
    when 'accepted' then 'Factory Accepted'
    when 'assigned' then 'Ready for Production'
    when 'in_production' then 'Work in Progress'
    when 'blocked' then 'On Hold'
    when 'ready_for_review' then 'Ready for Dispatch'
    when 'completed' then 'Completed'
    when 'cancelled' then 'Cancelled'
    else 'Submitted to Factory' end
$$;

update public.inhouse_production_requests
set factory_status = public.factory_status_from_legacy(status, assigned_factory_coordinator is not null, completed_at is not null or final_closed_at is not null)
where factory_status is null;

update public.inhouse_production_requests r
set requested_by = (select p.auth_id from public.profiles p where p.id = r.submitted_by)
where r.requested_by is null and r.submitted_by is not null;

update public.inhouse_production_requests r
set source_module = 'interior',
    source_department_id = coalesce(r.source_department_id, (select id from public.departments where code = 'INTERIOR'))
where r.source_module is null and r.purchase_request_id is not null;

alter table public.inhouse_production_requests alter column factory_status set default 'pending_verification';
alter table public.inhouse_production_requests alter column factory_status set not null;
alter table public.inhouse_production_requests drop constraint if exists inhouse_jobs_factory_status_check;
alter table public.inhouse_production_requests add constraint inhouse_jobs_factory_status_check check (factory_status in (
  'pending_verification', 'needs_clarification', 'accepted', 'assigned', 'in_production',
  'blocked', 'ready_for_review', 'completed', 'cancelled'));

create or replace function public.factory_jobs_status_sync() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.factory_status is distinct from old.factory_status then
      new.status := public.factory_status_to_legacy(new.factory_status);
    elsif new.status is distinct from old.status then
      new.factory_status := public.factory_status_from_legacy(new.status, new.assigned_factory_coordinator is not null, new.completed_at is not null);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_factory_jobs_status_sync on public.inhouse_production_requests;
create trigger trg_factory_jobs_status_sync before update on public.inhouse_production_requests
  for each row execute function public.factory_jobs_status_sync();

-- Job numbers: a sequence (the old count+1 scheme can repeat a number once
-- rows are removed). Continues after the highest existing JO- number.
create sequence if not exists public.factory_job_number_seq;
do $$
declare m bigint;
begin
  select coalesce(max(substring(job_order_number from '^JO-(\d+)$')::bigint), 0) into m from public.inhouse_production_requests;
  if m > 0 then perform setval('public.factory_job_number_seq', m, true); end if;
end $$;

create unique index if not exists inhouse_jobs_job_number_uq on public.inhouse_production_requests(job_order_number) where job_order_number is not null;
create unique index if not exists inhouse_jobs_idem_uq on public.inhouse_production_requests(idempotency_key) where idempotency_key is not null;
create unique index if not exists inhouse_jobs_source_uq on public.inhouse_production_requests(source_module, source_record_id) where source_record_id is not null;
create index if not exists inhouse_jobs_factory_status_idx on public.inhouse_production_requests(factory_status);
create index if not exists inhouse_jobs_source_dept_idx on public.inhouse_production_requests(source_department_id);
create index if not exists inhouse_jobs_requested_by_idx on public.inhouse_production_requests(requested_by);
create index if not exists inhouse_jobs_required_date_idx on public.inhouse_production_requests(required_completion_date);

-- ---------------------------------------------------------------------
-- 3. Items + activity timeline; files reuse factory_drawings
-- ---------------------------------------------------------------------
create table if not exists public.factory_job_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.inhouse_production_requests(id) on delete cascade,
  line_no integer not null default 1,
  item_name text not null,
  product_code text,
  quantity numeric,
  unit text,
  dimensions text,
  material text,
  finish text,
  fabric text,
  hardware text,
  room_area text,
  instruction text,
  item_status text not null default 'pending' check (item_status in ('pending', 'in_production', 'ready', 'completed')),
  is_test_data boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists factory_job_items_job_idx on public.factory_job_items(job_id, line_no);

create table if not exists public.factory_job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.inhouse_production_requests(id) on delete cascade,
  event_type text not null,
  from_status text,
  to_status text,
  note text,
  actor_id uuid references public.user_profiles(id),
  is_test_data boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists factory_job_events_job_idx on public.factory_job_events(job_id, created_at);

alter table public.factory_drawings
  add column if not exists storage_bucket text not null default 'interior-attachments',
  add column if not exists file_name text,
  add column if not exists mime_type text,
  add column if not exists file_size bigint;

-- ---------------------------------------------------------------------
-- 4. Role helpers + visibility
-- ---------------------------------------------------------------------
create or replace function public.factory_is_head() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.staff_is_management() or public.staff_is_super_admin()
    or (public.staff_is_factory_staff() and public.staff_is_dept_head());
$$;

create or replace function public.factory_my_profile_id() returns uuid
language sql stable security definer set search_path to 'public' as $$
  select id from public.profiles where auth_id = auth.uid();
$$;

create or replace function public.factory_person_name(p_profile uuid) returns text
language sql stable security definer set search_path to 'public' as $$
  select name from public.profiles where id = p_profile;
$$;

create or replace function public.factory_user_name(p_user uuid) returns text
language sql stable security definer set search_path to 'public' as $$
  select full_name from public.user_profiles where id = p_user;
$$;

-- Source-department visibility applies to every department EXCEPT Interior,
-- whose Job Cards stay scoped by project membership exactly as before.
create or replace function public.factory_job_visible_row(r public.inhouse_production_requests) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.factory_ai_is_reviewer()
    or r.requested_by = auth.uid()
    or (r.source_department_id is not null
        and r.source_department_id = public.staff_current_department_id()
        and r.source_department_id is distinct from (select id from public.departments where code = 'INTERIOR'))
    or (public.staff_is_factory_staff()
        and public.factory_my_profile_id() in (r.assigned_factory_coordinator, r.second_assignee_coordinator, r.current_responsible_person));
$$;

create or replace function public.staff_factory_job_visible(p_job_id uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.inhouse_production_requests r
    where r.id = p_job_id
      and (public.interior_is_org_wide() or public.interior_is_project_member(r.project_id) or public.factory_job_visible_row(r))
  );
$$;

drop policy if exists inhouse_jobs_select_factory_source on public.inhouse_production_requests;
create policy inhouse_jobs_select_factory_source on public.inhouse_production_requests
  for select using (public.factory_job_visible_row(inhouse_production_requests));

alter table public.factory_job_items enable row level security;
grant select on public.factory_job_items to authenticated;
drop policy if exists factory_job_items_select on public.factory_job_items;
create policy factory_job_items_select on public.factory_job_items for select using (public.staff_factory_job_visible(job_id));

alter table public.factory_job_events enable row level security;
grant select on public.factory_job_events to authenticated;
drop policy if exists factory_job_events_select on public.factory_job_events;
create policy factory_job_events_select on public.factory_job_events for select using (public.staff_factory_job_visible(job_id));

-- Storage: files a source department attaches to a Job Card live in the
-- factory-ai-attachments bucket (works for departments with no Interior
-- project); readable by anyone who can see that Job Card.
drop policy if exists factory_ai_attachments_storage_select on storage.objects;
create policy factory_ai_attachments_storage_select on storage.objects for select using (
  bucket_id = 'factory-ai-attachments' and (
    public.staff_is_management() or public.staff_is_super_admin()
    or exists (
      select 1 from public.factory_ai_attachments a join public.factory_ai_requests r on r.id = a.request_id
      where a.storage_path = storage.objects.name and (
        r.created_by = auth.uid()
        or (public.staff_is_factory_staff() and (public.staff_is_dept_head() or public.staff_is_supervisor()))
        or (r.source_department_id = public.staff_current_department_id() and (public.staff_is_dept_head() or public.staff_is_supervisor()))
      )
    )
    or exists (
      select 1 from public.factory_drawings d
      where d.storage_bucket = 'factory-ai-attachments' and d.storage_path = storage.objects.name
        and public.staff_factory_job_visible(d.job_id)
    )
  )
);

-- Factory people for the assignment dropdown. Reviewer-only. Reads
-- departments/roles directly (no department-name string comparison) and only
-- returns people who actually have a profiles row, since that is what the
-- assignment columns reference.
create or replace function public.factory_list_people()
returns table(profile_id uuid, auth_id uuid, name text, employee_code text, role_code text, role_label_en text)
language sql stable security definer set search_path to 'public' as $$
  select p.id, up.id, up.full_name, up.employee_code, r.code, r.name_en
  from public.user_profiles up
  join public.departments d on d.id = up.department_id and d.code = 'FACTORY'
  join public.roles r on r.id = up.role_id
  join public.profiles p on p.auth_id = up.id and p.active
  where public.factory_ai_is_reviewer() and up.is_active and not up.is_deleted
  order by up.full_name;
$$;

-- ---------------------------------------------------------------------
-- 5. Internal helpers (owner-only; not granted to any client role)
-- ---------------------------------------------------------------------
create or replace function public.factory_log_event(p_job uuid, p_type text, p_from text, p_to text, p_note text, p_actor uuid)
returns void language sql security definer set search_path to 'public' as $$
  insert into public.factory_job_events(job_id, event_type, from_status, to_status, note, actor_id) values (p_job, p_type, p_from, p_to, p_note, p_actor);
$$;

create or replace function public.factory_notify_managers(p_job uuid, p_en text, p_gu text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_factory uuid; r record;
begin
  select id into v_factory from public.departments where code = 'FACTORY';
  for r in
    select up.id from public.user_profiles up join public.roles ro on ro.id = up.role_id
    where up.is_active and (ro.code in ('management', 'sysadmin') or (up.department_id = v_factory and ro.code in ('dept_head', 'supervisor')))
  loop
    insert into public.notifications(recipient_id, entity_type, entity_id, title_en, title_gu) values (r.id, 'FACTORY_JOB', p_job, p_en, p_gu);
  end loop;
end $$;

create or replace function public.factory_notify_user(p_user uuid, p_job uuid, p_en text, p_gu text)
returns void language sql security definer set search_path to 'public' as $$
  insert into public.notifications(recipient_id, entity_type, entity_id, title_en, title_gu)
  select p_user, 'FACTORY_JOB', p_job, p_en, p_gu where p_user is not null and p_user <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid);
$$;

revoke all on function public.factory_log_event(uuid, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.factory_notify_managers(uuid, text, text) from public, anon, authenticated;
revoke all on function public.factory_notify_user(uuid, uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Job Card creation core (used by the client RPC and by the AI pipeline)
-- ---------------------------------------------------------------------
create or replace function public.factory_create_job_internal(
  p_requester uuid, p_dept uuid, p_idempotency_key text, p_source_module text, p_source_reference text, p_source_record_id uuid,
  p_project_id uuid, p_customer_name text, p_site_location text, p_title text, p_required_date date, p_priority text,
  p_notes text, p_items jsonb, p_purchase_request_id uuid, p_ai_request_id uuid, p_factory_location_id uuid
)
returns table(job_id uuid, job_order_number text, already_submitted boolean)
language plpgsql security definer set search_path to 'public' as $$
declare
  v_existing public.inhouse_production_requests%rowtype;
  v_id uuid; v_number text; v_title text; v_proj public.projects%rowtype;
  v_items jsonb; v_item jsonb; v_i int := 0; v_units text[]; v_qty numeric; v_profile uuid;
begin
  if p_priority not in ('Normal', 'High', 'Urgent', 'Emergency') then raise exception 'Invalid priority'; end if;
  if p_source_module not in ('interior', 'retail', 'ai_intake', 'manual', 'other') then raise exception 'Invalid source'; end if;

  if p_idempotency_key is not null then select * into v_existing from public.inhouse_production_requests where idempotency_key = p_idempotency_key; end if;
  if v_existing.id is null and p_source_record_id is not null then
    select * into v_existing from public.inhouse_production_requests where source_module = p_source_module and source_record_id = p_source_record_id;
  end if;
  if v_existing.id is null and p_purchase_request_id is not null then
    select * into v_existing from public.inhouse_production_requests where purchase_request_id = p_purchase_request_id;
  end if;
  if v_existing.id is not null then
    return query select v_existing.id, v_existing.job_order_number, true;
    return;
  end if;

  if p_project_id is not null then
    select * into v_proj from public.projects where id = p_project_id;
    if v_proj.id is null then raise exception 'Invalid project'; end if;
    if v_proj.archived then raise exception 'This project is archived and cannot receive new work'; end if;
  end if;

  v_items := case when p_items is not null and jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) > 0 then p_items else '[]'::jsonb end;
  v_title := coalesce(nullif(btrim(p_title), ''), nullif(btrim(v_items -> 0 ->> 'item_name'), ''));
  if v_title is null then raise exception 'A title, instruction or at least one item is required'; end if;
  if jsonb_array_length(v_items) = 0 then
    v_items := jsonb_build_array(jsonb_build_object('item_name', v_title));
  end if;

  select array_agg(distinct nullif(btrim(it ->> 'unit'), '')) into v_units from jsonb_array_elements(v_items) it;
  select sum(nullif(it ->> 'quantity', '')::numeric) into v_qty from jsonb_array_elements(v_items) it;

  v_number := 'JO-' || lpad(nextval('public.factory_job_number_seq')::text, 6, '0');
  select id into v_profile from public.profiles where auth_id = p_requester;

  insert into public.inhouse_production_requests (
    project_id, purchase_request_id, source_department_id, source_module, source_reference, source_record_id,
    project_code, customer_name, site_location, product_item, quantity, unit, required_completion_date, priority,
    special_instructions, job_order_number, status, factory_status, current_stage, completion_percentage,
    requested_by, submitted_by, submitted_at, idempotency_key, factory_location_id, ai_request_id
  ) values (
    p_project_id, p_purchase_request_id, p_dept, p_source_module, p_source_reference, p_source_record_id,
    v_proj.project_code, coalesce(nullif(btrim(p_customer_name), ''), v_proj.customer), coalesce(nullif(btrim(p_site_location), ''), v_proj.location),
    case when jsonb_array_length(v_items) > 1 then v_title || ' (+' || (jsonb_array_length(v_items) - 1) || ' more)' else v_title end,
    case when v_units is null or array_length(v_units, 1) is null or array_length(v_units, 1) <= 1 then v_qty else null end,
    case when array_length(v_units, 1) = 1 then v_units[1] else null end,
    p_required_date, p_priority, p_notes, v_number, 'Submitted to Factory', 'pending_verification', 'Planning', 0,
    p_requester, v_profile, now(), p_idempotency_key, p_factory_location_id, p_ai_request_id
  ) returning id into v_id;

  for v_item in select * from jsonb_array_elements(v_items) loop
    v_i := v_i + 1;
    if coalesce(btrim(v_item ->> 'item_name'), '') = '' then raise exception 'Every item needs a name'; end if;
    insert into public.factory_job_items(job_id, line_no, item_name, product_code, quantity, unit, dimensions, material, finish, fabric, hardware, room_area, instruction)
    values (v_id, v_i, btrim(v_item ->> 'item_name'), nullif(btrim(v_item ->> 'product_code'), ''), nullif(v_item ->> 'quantity', '')::numeric,
      nullif(btrim(v_item ->> 'unit'), ''), nullif(btrim(v_item ->> 'dimensions'), ''), nullif(btrim(v_item ->> 'material'), ''),
      nullif(btrim(v_item ->> 'finish'), ''), nullif(btrim(v_item ->> 'fabric'), ''), nullif(btrim(v_item ->> 'hardware'), ''),
      nullif(btrim(v_item ->> 'room_area'), ''), nullif(btrim(v_item ->> 'instruction'), ''));
  end loop;

  perform public.factory_log_event(v_id, 'submitted', null, 'pending_verification', 'Request submitted (' || p_source_module || ')', p_requester);
  perform public.factory_log_event(v_id, 'job_card_generated', null, 'pending_verification', v_number || ' created with ' || v_i || ' item(s)', p_requester);
  perform public.staff_write_audit('inhouse_production_requests', v_id, 'SUBMIT_JOB_CARD', null,
    jsonb_build_object('job_order_number', v_number, 'source_module', p_source_module, 'source_reference', p_source_reference, 'items', v_i), p_dept, null);
  perform public.factory_notify_managers(v_id, 'New Factory request ' || v_number || ': ' || v_title, 'નવી ફેક્ટરી વિનંતી ' || v_number || ': ' || v_title);

  if p_purchase_request_id is not null then
    update public.purchase_requests set status = 'In-house Submitted' where id = p_purchase_request_id;
  end if;

  return query select v_id, v_number, false;
end $$;
revoke all on function public.factory_create_job_internal(uuid, uuid, text, text, text, uuid, uuid, text, text, text, date, text, text, jsonb, uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.factory_submit_job_card(
  p_idempotency_key text, p_source_module text, p_source_reference text, p_source_record_id uuid,
  p_project_id uuid, p_customer_name text, p_site_location text, p_title text, p_required_date date,
  p_priority text, p_notes text, p_items jsonb, p_purchase_request_id uuid default null, p_factory_location_id uuid default null
)
returns table(job_id uuid, job_order_number text, already_submitted boolean)
language plpgsql security definer set search_path to 'public' as $$
declare v_dept uuid;
begin
  perform public.staff_assert_operational();
  select department_id into v_dept from public.user_profiles where id = auth.uid();
  if v_dept is null then
    select id into v_dept from public.departments where code = case p_source_module when 'interior' then 'INTERIOR' when 'retail' then 'RETAIL' else 'FACTORY' end;
  end if;
  if v_dept is null then raise exception 'Your department could not be resolved'; end if;
  return query select * from public.factory_create_job_internal(
    auth.uid(), v_dept, p_idempotency_key, p_source_module, p_source_reference, p_source_record_id, p_project_id, p_customer_name,
    p_site_location, p_title, p_required_date, coalesce(p_priority, 'Normal'), p_notes, p_items, p_purchase_request_id, null, p_factory_location_id);
end $$;
revoke all on function public.factory_submit_job_card(text, text, text, uuid, uuid, text, text, text, date, text, text, jsonb, uuid, uuid) from public, anon;
grant execute on function public.factory_submit_job_card(text, text, text, uuid, uuid, text, text, text, date, text, text, jsonb, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 7. Files, items and details (each writes the activity timeline)
-- ---------------------------------------------------------------------
create or replace function public.factory_job_add_file(
  p_job_id uuid, p_category text, p_title text, p_bucket text, p_path text, p_file_name text,
  p_mime_type text default null, p_file_size bigint default null, p_note text default null
) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare j public.inhouse_production_requests%rowtype; v_id uuid; v_ok boolean;
begin
  perform public.staff_assert_operational();
  select * into j from public.inhouse_production_requests where id = p_job_id;
  if j.id is null then raise exception 'Job Card not found'; end if;
  v_ok := public.factory_ai_is_reviewer()
    or j.requested_by = auth.uid()
    or (j.source_department_id is not null and j.source_department_id = public.staff_current_department_id() and j.factory_status in ('pending_verification', 'needs_clarification'))
    or public.factory_my_profile_id() in (j.assigned_factory_coordinator, j.second_assignee_coordinator, j.current_responsible_person);
  if not v_ok then raise exception 'You are not authorized to add files to this Job Card'; end if;
  if p_bucket not in ('factory-ai-attachments', 'interior-attachments') then raise exception 'Invalid storage bucket'; end if;
  if coalesce(btrim(p_path), '') = '' then raise exception 'A file is required'; end if;

  insert into public.factory_drawings(job_id, category, title, storage_path, storage_bucket, file_name, mime_type, file_size, status, note, uploaded_by)
  values (p_job_id, p_category, coalesce(nullif(btrim(p_title), ''), p_file_name), p_path, p_bucket, p_file_name, p_mime_type, p_file_size, 'Submitted', p_note, auth.uid())
  returning id into v_id;
  perform public.factory_log_event(p_job_id, 'file_added', null, null, coalesce(p_title, p_file_name) || ' (' || p_category || ')', auth.uid());
  return v_id;
end $$;
revoke all on function public.factory_job_add_file(uuid, text, text, text, text, text, text, bigint, text) from public, anon;
grant execute on function public.factory_job_add_file(uuid, text, text, text, text, text, text, bigint, text) to authenticated;

create or replace function public.factory_job_update_items(p_job_id uuid, p_items jsonb)
returns void language plpgsql security definer set search_path to 'public' as $$
declare j public.inhouse_production_requests%rowtype; v_item jsonb; v_id uuid; v_next int;
begin
  perform public.staff_assert_operational();
  select * into j from public.inhouse_production_requests where id = p_job_id for update;
  if j.id is null then raise exception 'Job Card not found'; end if;
  if not (public.factory_ai_is_reviewer()
          or ((j.requested_by = auth.uid() or (j.source_department_id is not null and j.source_department_id = public.staff_current_department_id()))
              and j.factory_status in ('pending_verification', 'needs_clarification'))) then
    raise exception 'You are not authorized to edit the items of this Job Card';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'Items must be a list'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_id := nullif(v_item ->> 'id', '')::uuid;
    if coalesce((v_item ->> 'remove')::boolean, false) then
      if v_id is not null then delete from public.factory_job_items where id = v_id and job_id = p_job_id; end if;
      continue;
    end if;
    if coalesce(btrim(v_item ->> 'item_name'), '') = '' then raise exception 'Every item needs a name'; end if;
    if v_id is not null then
      update public.factory_job_items set
        item_name = btrim(v_item ->> 'item_name'), product_code = nullif(btrim(v_item ->> 'product_code'), ''),
        quantity = nullif(v_item ->> 'quantity', '')::numeric, unit = nullif(btrim(v_item ->> 'unit'), ''),
        dimensions = nullif(btrim(v_item ->> 'dimensions'), ''), material = nullif(btrim(v_item ->> 'material'), ''),
        finish = nullif(btrim(v_item ->> 'finish'), ''), fabric = nullif(btrim(v_item ->> 'fabric'), ''),
        hardware = nullif(btrim(v_item ->> 'hardware'), ''), room_area = nullif(btrim(v_item ->> 'room_area'), ''),
        instruction = nullif(btrim(v_item ->> 'instruction'), ''), updated_at = now()
      where id = v_id and job_id = p_job_id;
    else
      select coalesce(max(line_no), 0) + 1 into v_next from public.factory_job_items where job_id = p_job_id;
      insert into public.factory_job_items(job_id, line_no, item_name, product_code, quantity, unit, dimensions, material, finish, fabric, hardware, room_area, instruction)
      values (p_job_id, v_next, btrim(v_item ->> 'item_name'), nullif(btrim(v_item ->> 'product_code'), ''), nullif(v_item ->> 'quantity', '')::numeric,
        nullif(btrim(v_item ->> 'unit'), ''), nullif(btrim(v_item ->> 'dimensions'), ''), nullif(btrim(v_item ->> 'material'), ''),
        nullif(btrim(v_item ->> 'finish'), ''), nullif(btrim(v_item ->> 'fabric'), ''), nullif(btrim(v_item ->> 'hardware'), ''),
        nullif(btrim(v_item ->> 'room_area'), ''), nullif(btrim(v_item ->> 'instruction'), ''));
    end if;
  end loop;
  update public.inhouse_production_requests set updated_at = now(),
    product_item = coalesce(
      (select i.item_name || case when (select count(*) from public.factory_job_items where job_id = p_job_id) > 1
                                  then ' (+' || ((select count(*) from public.factory_job_items where job_id = p_job_id) - 1) || ' more)' else '' end
       from public.factory_job_items i where i.job_id = p_job_id order by i.line_no limit 1), product_item)
  where id = p_job_id;
  perform public.factory_log_event(p_job_id, 'items_updated', null, null, 'Items updated', auth.uid());
end $$;
revoke all on function public.factory_job_update_items(uuid, jsonb) from public, anon;
grant execute on function public.factory_job_update_items(uuid, jsonb) to authenticated;

create or replace function public.factory_job_update_details(p_job_id uuid, p_patch jsonb)
returns void language plpgsql security definer set search_path to 'public' as $$
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
    updated_at = now()
  where id = p_job_id;
  perform public.factory_log_event(p_job_id, case when p_patch ? 'priority' then 'priority_changed' else 'details_updated' end, null, null,
    (select string_agg(k, ', ') from jsonb_object_keys(p_patch) k), auth.uid());
end $$;
revoke all on function public.factory_job_update_details(uuid, jsonb) from public, anon;
grant execute on function public.factory_job_update_details(uuid, jsonb) to authenticated;

create or replace function public.factory_job_mark_viewed(p_job_id uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.staff_assert_operational();
  if not public.factory_ai_is_reviewer() then return; end if;
  update public.inhouse_production_requests set viewed_at = now(), viewed_by = auth.uid()
  where id = p_job_id and viewed_at is null;
end $$;
revoke all on function public.factory_job_mark_viewed(uuid) from public, anon;
grant execute on function public.factory_job_mark_viewed(uuid) to authenticated;

create or replace function public.factory_job_add_comment(p_job_id uuid, p_note text) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.staff_assert_operational();
  if coalesce(btrim(p_note), '') = '' then raise exception 'Please write a comment'; end if;
  if not public.staff_factory_job_visible(p_job_id) then raise exception 'You are not authorized to comment on this Job Card'; end if;
  perform public.factory_log_event(p_job_id, 'comment', null, null, btrim(p_note), auth.uid());
end $$;
revoke all on function public.factory_job_add_comment(uuid, text) from public, anon;
grant execute on function public.factory_job_add_comment(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 8. THE status-transition function (server-side validation for every move)
-- ---------------------------------------------------------------------
create or replace function public.factory_job_transition(p_job_id uuid, p_action text, p_note text default null, p_payload jsonb default '{}'::jsonb)
returns text
language plpgsql security definer set search_path to 'public' as $$
declare
  j public.inhouse_production_requests%rowtype;
  v_uid uuid := auth.uid();
  v_mgr boolean; v_head boolean; v_assigned boolean; v_source boolean;
  v_old text; v_new text; v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_primary uuid; v_second uuid; v_primary_auth uuid; v_second_auth uuid; v_factory uuid;
  v_start date; v_end date; v_dept text; v_task record; v_prio text; v_event text; v_pname text;
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

      v_prio := case when j.priority = 'Emergency' then 'URGENT' else upper(j.priority) end;
      if j.linked_task_id is null then
        select * into v_task from public.staff_create_task(
          'Factory Production: ' || coalesce(j.product_item, j.job_order_number),
          coalesce(j.special_instructions, 'Factory Job Card ' || j.job_order_number),
          'FACTORY_REQUEST', v_prio, 'none', v_factory, v_factory, v_primary_auth,
          coalesce(v_end, j.required_completion_date, current_date + 7), null, null, j.job_order_number, '', coalesce(j.quantity::text, ''),
          v_second_auth, j.project_id);
        update public.inhouse_production_requests set linked_task_id = v_task.task_id where id = p_job_id;
      else
        update public.staff_tasks set assigned_to = v_primary_auth, current_owner_id = v_primary_auth where id = j.linked_task_id;
        update public.staff_task_assignees set user_id = v_primary_auth where task_id = j.linked_task_id and assignment_role = 'primary';
        delete from public.staff_task_assignees where task_id = j.linked_task_id and assignment_role = 'secondary';
        if v_second_auth is not null then
          insert into public.staff_task_assignees(task_id, user_id, assignment_role, assigned_by) values (j.linked_task_id, v_second_auth, 'secondary', v_uid);
        end if;
      end if;
      v_pname := public.factory_person_name(v_primary);
      v_note := coalesce(v_note, 'Assigned to ' || coalesce(v_pname, 'team'));
      perform public.factory_notify_user(v_primary_auth, p_job_id, 'Job Card ' || j.job_order_number || ' is assigned to you', 'જોબ કાર્ડ ' || j.job_order_number || ' તમને સોંપવામાં આવ્યું છે');
      if v_second_auth is not null then
        perform public.factory_notify_user(v_second_auth, p_job_id, 'You were added to Job Card ' || j.job_order_number, 'તમને જોબ કાર્ડ ' || j.job_order_number || ' માં ઉમેરવામાં આવ્યા છે');
      end if;
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
      update public.inhouse_production_requests set completed_at = now(), completed_by = v_uid, actual_completion_date = current_date, completion_percentage = 100 where id = p_job_id;
    when 'cancel' then
      if not v_head then raise exception 'Only the Factory Head or Admin can cancel a Job Card'; end if;
      if v_old in ('completed', 'cancelled') then raise exception 'This Job Card is already closed'; end if;
      if v_note is null then raise exception 'Please give a reason for cancelling'; end if;
      v_new := 'cancelled';
      update public.inhouse_production_requests set cancelled_reason = v_note where id = p_job_id;
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

  -- Who needs to know
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
end $$;
revoke all on function public.factory_job_transition(uuid, text, text, jsonb) from public, anon;
grant execute on function public.factory_job_transition(uuid, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 9. Production progress: same function as before (11 params), now also
--    allowing Factory Supervisors/Admin, refusing jobs that are not open for
--    production, auto-starting an assigned job on the first update, and
--    writing the activity timeline.
-- ---------------------------------------------------------------------
create or replace function public.factory_update_stage(
  p_job_id uuid, p_stage text, p_status text, p_assigned_to uuid default null, p_quantity_completed numeric default null,
  p_quantity_pending numeric default null, p_notes text default null, p_delay_reason text default null,
  p_planned_start date default null, p_planned_end date default null, p_stage_data jsonb default null
)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare
  v_job public.inhouse_production_requests%rowtype;
  v_existing public.production_stage_updates%rowtype;
  v_actor_name text; v_my_profile uuid;
  v_done_stages int; v_completion int;
  v_resolved_assigned_to uuid;
begin
  perform public.staff_assert_operational();
  if p_status not in ('pending','in_progress','completed','skipped','on_hold','rework') then raise exception 'Invalid stage status'; end if;

  select * into v_job from public.inhouse_production_requests where id = p_job_id for update;
  if v_job.id is null then raise exception 'Job not found'; end if;
  select id into v_my_profile from public.profiles where auth_id = auth.uid();

  if not (
    public.staff_is_management() or public.staff_is_super_admin() or public.factory_ai_is_reviewer()
    or (public.staff_is_factory_staff() and v_my_profile in (v_job.assigned_factory_coordinator, v_job.second_assignee_coordinator, v_job.current_responsible_person))
  ) then
    raise exception 'You are not authorized to update this job''s production stage';
  end if;
  if v_job.factory_status not in ('assigned', 'in_production', 'blocked') then
    raise exception 'This Job Card is not open for production updates. It must be accepted and assigned first.';
  end if;

  if p_assigned_to is not null then
    select id into v_resolved_assigned_to from public.user_profiles where id = p_assigned_to;
    if v_resolved_assigned_to is null then select auth_id into v_resolved_assigned_to from public.profiles where id = p_assigned_to; end if;
    if v_resolved_assigned_to is null then raise exception 'Selected employee could not be found. Please choose a valid employee from the list.'; end if;
  else
    v_resolved_assigned_to := null;
  end if;

  select * into v_existing from public.production_stage_updates where job_id = p_job_id and stage = p_stage;

  insert into public.production_stage_updates (
    job_id, stage, status, assigned_to, planned_start, planned_end, actual_start, actual_end,
    quantity_completed, quantity_pending, notes, delay_reason, stage_data, started_by, completed_by, updated_at
  ) values (
    p_job_id, p_stage, p_status, v_resolved_assigned_to, p_planned_start, p_planned_end,
    case when p_status = 'in_progress' and v_existing.actual_start is null then now() else v_existing.actual_start end,
    case when p_status = 'completed' then now() else v_existing.actual_end end,
    p_quantity_completed, p_quantity_pending, p_notes, p_delay_reason, coalesce(p_stage_data, '{}'::jsonb),
    case when p_status = 'in_progress' and v_existing.started_by is null then auth.uid() else v_existing.started_by end,
    case when p_status = 'completed' then auth.uid() else v_existing.completed_by end, now()
  )
  on conflict (job_id, stage) do update set
    status = excluded.status,
    assigned_to = coalesce(excluded.assigned_to, production_stage_updates.assigned_to),
    planned_start = coalesce(excluded.planned_start, production_stage_updates.planned_start),
    planned_end = coalesce(excluded.planned_end, production_stage_updates.planned_end),
    actual_start = excluded.actual_start, actual_end = excluded.actual_end,
    quantity_completed = coalesce(excluded.quantity_completed, production_stage_updates.quantity_completed),
    quantity_pending = coalesce(excluded.quantity_pending, production_stage_updates.quantity_pending),
    notes = coalesce(excluded.notes, production_stage_updates.notes),
    delay_reason = excluded.delay_reason,
    stage_data = case when p_stage_data is not null then production_stage_updates.stage_data || p_stage_data else production_stage_updates.stage_data end,
    started_by = excluded.started_by, completed_by = excluded.completed_by, updated_at = now();

  select count(*) into v_done_stages from public.production_stage_updates where job_id = p_job_id and status = 'completed';
  v_completion := round((v_done_stages::numeric / 17) * 100);
  update public.inhouse_production_requests set current_stage = p_stage, completion_percentage = v_completion, updated_at = now() where id = p_job_id;

  if v_job.factory_status = 'assigned' and p_status in ('in_progress', 'completed') then
    update public.inhouse_production_requests set factory_status = 'in_production' where id = p_job_id;
    perform public.factory_log_event(p_job_id, 'start', 'assigned', 'in_production', 'Production started with the first update', auth.uid());
  end if;
  perform public.factory_log_event(p_job_id, 'progress_update', null, null,
    p_stage || ' → ' || p_status || coalesce(' · ' || p_quantity_completed::text || ' done', '') || coalesce(' · ' || p_notes, ''), auth.uid());

  select full_name into v_actor_name from public.user_profiles where id = auth.uid();
  perform public.staff_write_audit('production_stage_updates', p_job_id, 'STAGE_UPDATE',
    jsonb_build_object('stage', p_stage, 'previous_status', v_existing.status),
    jsonb_build_object('status', p_status, 'quantity_completed', p_quantity_completed, 'notes', p_notes, 'delay_reason', p_delay_reason, 'project_id', v_job.project_id), null);

  if v_job.linked_task_id is not null then
    perform public.staff_post_system_task_message(v_job.linked_task_id,
      'Production stage "' || p_stage || '" ' || p_status || ' — ' || v_actor_name || coalesce(': ' || p_notes, ''),
      v_actor_name || ' દ્વારા ઉત્પાદન તબક્કો "' || p_stage || '" ' || p_status || coalesce(': ' || p_notes, ''));
  end if;
end;
$function$;

-- ---------------------------------------------------------------------
-- 10. Read models: inbox view, dashboard counts, my actions today
-- ---------------------------------------------------------------------
create or replace view public.factory_job_cards_v with (security_invoker = true) as
select
  r.id, r.job_order_number, r.factory_status, r.status as legacy_status,
  r.source_department_id, d.name_en as source_department_name, d.name_gu as source_department_name_gu,
  r.source_module, r.source_reference,
  r.project_id, coalesce(r.project_code, pr.project_code) as project_code,
  coalesce(r.customer_name, pr.customer) as customer_name, coalesce(r.site_location, pr.location) as site_location,
  r.product_item,
  coalesce(ic.item_count, case when r.product_item is not null then 1 else 0 end) as item_count,
  ic.total_qty, ic.qty_summary,
  r.required_completion_date as required_date, r.priority, r.current_stage, r.completion_percentage,
  r.assigned_factory_coordinator, public.factory_person_name(r.assigned_factory_coordinator) as assigned_name,
  r.second_assignee_coordinator, public.factory_person_name(r.second_assignee_coordinator) as second_name,
  coalesce(fc.file_count, 0) as file_count, coalesce(fc.drawing_count, 0) as drawing_count,
  ( (case when r.required_completion_date is null then 1 else 0 end)
  + (case when coalesce(ic.item_count, 0) = 0 then 1 else 0 end)
  + (case when coalesce(fc.drawing_count, 0) = 0 then 1 else 0 end)
  + (case when coalesce(ic.missing_qty, 0) > 0 then 1 else 0 end)
  + (case when coalesce(ic.missing_spec, 0) > 0 then 1 else 0 end) ) as missing_count,
  (r.factory_status not in ('completed', 'cancelled')
    and (r.factory_status = 'blocked'
         or (r.required_completion_date is not null and r.required_completion_date < (now() at time zone 'Asia/Kolkata')::date))) as is_delayed,
  (r.factory_status = 'blocked') as is_blocked,
  r.viewed_at, r.requested_by, public.factory_user_name(r.requested_by) as requested_by_name,
  r.clarification_note, r.blocked_reason, r.factory_location_id, r.production_department,
  r.created_at, r.updated_at, r.ready_at, r.completed_at, r.is_test_data
from public.inhouse_production_requests r
left join public.departments d on d.id = r.source_department_id
left join public.projects pr on pr.id = r.project_id
left join lateral (
  select count(*) as item_count, sum(i.quantity) as total_qty,
    string_agg(coalesce(i.quantity::text, '?') || ' ' || coalesce(i.unit, '') || ' ' || i.item_name, ', ' order by i.line_no) filter (where i.line_no <= 3) as qty_summary,
    count(*) filter (where i.quantity is null or i.quantity <= 0) as missing_qty,
    count(*) filter (where i.material is null or i.dimensions is null) as missing_spec
  from public.factory_job_items i where i.job_id = r.id
) ic on true
left join lateral (
  select count(*) as file_count,
    count(*) filter (where f.category in ('Working Drawing', 'Production Drawing', '3D Drawing', 'Normal Drawing', 'Reference Drawing',
      'Furniture Detail Drawing', 'Cutting Drawing', 'Approved Design', 'RCP', 'Electrical Drawing', 'MEP Drawing')) as drawing_count
  from public.factory_drawings f where f.job_id = r.id and f.status <> 'Superseded'
) fc on true;
grant select on public.factory_job_cards_v to authenticated;

create or replace function public.factory_dashboard_counts(p_location uuid default null)
returns table(new_requests bigint, needs_verification bigint, accepted_unassigned bigint, in_production bigint,
              delayed_blocked bigint, done_today bigint, needs_clarification bigint, assigned bigint)
language sql stable security invoker set search_path to 'public' as $$
  select
    count(*) filter (where factory_status = 'pending_verification' and viewed_at is null),
    count(*) filter (where factory_status = 'pending_verification' and viewed_at is not null),
    count(*) filter (where factory_status = 'accepted'),
    count(*) filter (where factory_status = 'in_production'),
    count(*) filter (where is_delayed),
    count(*) filter (where (factory_status = 'ready_for_review' and (ready_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date)
                        or (factory_status = 'completed' and (completed_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date)),
    count(*) filter (where factory_status = 'needs_clarification'),
    count(*) filter (where factory_status = 'assigned')
  from public.factory_job_cards_v
  where not is_test_data and (p_location is null or factory_location_id = p_location);
$$;
grant execute on function public.factory_dashboard_counts(uuid) to authenticated;

create or replace function public.factory_my_actions()
returns table(job_id uuid, job_order_number text, action_code text, title text, source_department_name text,
              required_date date, priority text, since timestamptz, is_overdue boolean)
language sql stable security invoker set search_path to 'public' as $$
  with me as (
    select public.factory_my_profile_id() as pid, public.factory_ai_is_reviewer() as mgr, public.factory_is_head() as head, auth.uid() as uid,
           (now() at time zone 'Asia/Kolkata')::date as today
  ), c as (
    select v.*, (me.pid is not null and me.pid in (v.assigned_factory_coordinator, v.second_assignee_coordinator)) as mine, (v.requested_by = me.uid) as src
    from public.factory_job_cards_v v, me
    where not v.is_test_data and v.factory_status not in ('completed', 'cancelled')
  ), a as (
    select c.id, c.job_order_number, c.product_item, c.source_department_name, c.required_date, c.priority, c.updated_at, c.created_at,
      case
        when me.mgr and c.factory_status = 'pending_verification' and c.drawing_count = 0 then 'confirm_drawing'
        when me.mgr and c.factory_status = 'pending_verification' then 'verify'
        when me.mgr and c.factory_status = 'accepted' then 'assign'
        when me.head and c.factory_status = 'ready_for_review' then 'confirm_completion'
        when (me.mgr or c.mine) and c.factory_status = 'blocked' then 'resolve_blocker'
        when (me.mgr or c.mine) and c.is_delayed and c.factory_status in ('assigned', 'in_production') then 'update_delayed'
        when c.mine and c.factory_status = 'assigned' then 'start_job'
        when c.mine and c.factory_status = 'in_production' then 'update_progress'
        when c.src and c.factory_status = 'needs_clarification' then 'respond_clarification'
      end as code, me.today
    from c, me
  )
  select a.id, a.job_order_number, a.code, a.product_item, a.source_department_name, a.required_date, a.priority,
         coalesce(a.updated_at, a.created_at), (a.required_date is not null and a.required_date < a.today)
  from a where a.code is not null
  order by (a.required_date is not null and a.required_date < a.today) desc,
           (a.required_date = a.today) desc,
           case a.priority when 'Emergency' then 0 when 'Urgent' then 1 when 'High' then 2 else 3 end,
           coalesce(a.updated_at, a.created_at);
$$;
grant execute on function public.factory_my_actions() to authenticated;

revoke all on function public.factory_list_people() from public, anon;
grant execute on function public.factory_list_people() to authenticated;
revoke all on function public.factory_dashboard_counts(uuid) from public, anon;
revoke all on function public.factory_my_actions() from public, anon;

-- ---------------------------------------------------------------------
-- 11. AI intake now produces the Job Card itself (no separate accept step)
-- ---------------------------------------------------------------------
create or replace function public.factory_ai_ensure_job(p_request_id uuid) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare
  v_req public.factory_ai_requests%rowtype; v_items jsonb := '[]'::jsonb; v_x jsonb; v_job uuid; v_res record; a record;
  v_ext jsonb; v_date date;
begin
  select * into v_req from public.factory_ai_requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'Request not found'; end if;
  if v_req.factory_job_id is not null then return v_req.factory_job_id; end if;

  v_ext := coalesce(v_req.verified_extraction, v_req.ai_extraction, '{}'::jsonb);
  if jsonb_typeof(v_ext -> 'product_items') = 'array' then
    for v_x in select * from jsonb_array_elements(v_ext -> 'product_items') loop
      if coalesce(btrim(v_x ->> 'item_name'), '') <> '' then
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'item_name', v_x ->> 'item_name', 'quantity', v_x ->> 'quantity', 'unit', v_x ->> 'unit', 'dimensions', v_x ->> 'dimensions',
          'material', v_x ->> 'material', 'finish', v_x ->> 'finish', 'hardware', v_x ->> 'hardware', 'room_area', v_x ->> 'room_area',
          'instruction', v_x ->> 'notes'));
      end if;
    end loop;
  end if;
  begin v_date := coalesce(v_req.required_date, nullif(v_ext ->> 'required_date', '')::date); exception when others then v_date := v_req.required_date; end;

  select * into v_res from public.factory_create_job_internal(
    v_req.created_by, v_req.source_department_id, 'ai:' || v_req.id::text, 'ai_intake', v_req.request_number, v_req.id,
    v_req.project_id, v_ext ->> 'customer_name', v_ext ->> 'site_name',
    coalesce(nullif(v_ext ->> 'work_title', ''), v_req.work_title), v_date, v_req.priority,
    coalesce(v_req.work_description, v_ext ->> 'work_description'), v_items, null, v_req.id, null);
  v_job := v_res.job_id;

  for a in select * from public.factory_ai_attachments where request_id = p_request_id loop
    insert into public.factory_drawings(job_id, category, custom_category_name, title, storage_path, storage_bucket, file_name, mime_type, file_size, status, uploaded_by)
    values (v_job,
      case when lower(coalesce(a.mime_type, '')) like 'image/%' then 'Reference Photo' when a.original_file_name ilike '%.pdf' then 'Reference Drawing' else 'Others' end,
      case when lower(coalesce(a.mime_type, '')) like 'image/%' or a.original_file_name ilike '%.pdf' then null else 'Source document' end,
      a.original_file_name, a.storage_path, 'factory-ai-attachments', a.original_file_name, a.mime_type, a.file_size, 'Submitted', a.uploaded_by);
    perform public.factory_log_event(v_job, 'file_added', null, null, a.original_file_name, a.uploaded_by);
  end loop;

  update public.factory_ai_requests set factory_job_id = v_job, updated_at = now() where id = p_request_id;
  return v_job;
end $$;
revoke all on function public.factory_ai_ensure_job(uuid) from public, anon, authenticated;

create or replace function public.factory_ai_store_extraction(
  p_request_id uuid, p_extraction jsonb, p_model text, p_prompt_version text,
  p_confidence_overall numeric, p_served_from_cache boolean default false
) returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_request public.factory_ai_requests%rowtype; v_job uuid;
begin
  select * into v_request from public.factory_ai_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'Request not found'; end if;

  update public.factory_ai_requests set status = 'extracted', ai_extraction = p_extraction, ai_model = p_model,
    ai_prompt_version = p_prompt_version, ai_confidence_overall = p_confidence_overall, ai_processed_at = now(),
    ai_served_from_cache = p_served_from_cache, ai_failure_reason = null, updated_at = now()
  where id = p_request_id;

  perform public.staff_write_audit('factory_ai_requests', p_request_id, 'AI_EXTRACTED', null,
    jsonb_build_object('model', p_model, 'confidence', p_confidence_overall, 'served_from_cache', p_served_from_cache), v_request.source_department_id, null);

  v_job := public.factory_ai_ensure_job(p_request_id);
  perform public.factory_log_event(v_job, 'ai_extracted', null, null, 'AI read the source file(s) — confidence ' || round(coalesce(p_confidence_overall, 0) * 100) || '%', null);
end $function$;

create or replace function public.factory_ai_mark_failed(p_request_id uuid, p_reason text)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_request public.factory_ai_requests%rowtype; v_job uuid;
begin
  select * into v_request from public.factory_ai_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'Request not found'; end if;
  update public.factory_ai_requests set status = 'failed', ai_failure_reason = p_reason, updated_at = now() where id = p_request_id;
  perform public.staff_write_audit('factory_ai_requests', p_request_id, 'AI_FAILED', null, jsonb_build_object('reason', p_reason), v_request.source_department_id, null);
  -- Never lose the request: the Job Card is still created from what the sender typed and the files they uploaded.
  v_job := public.factory_ai_ensure_job(p_request_id);
  perform public.factory_log_event(v_job, 'ai_failed', null, null, 'Automatic reading did not complete — verify details manually (' || left(p_reason, 200) || ')', null);
end $function$;

revoke all on function public.factory_ai_store_extraction(uuid, jsonb, text, text, numeric, boolean) from public, authenticated, anon;
grant execute on function public.factory_ai_store_extraction(uuid, jsonb, text, text, numeric, boolean) to service_role;
revoke all on function public.factory_ai_mark_failed(uuid, text) from public, authenticated, anon;
grant execute on function public.factory_ai_mark_failed(uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- 12. Realtime + indexes for the new tables
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['factory_job_items', 'factory_job_events'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
