-- Real, per-stage WIP workflow engine for Factory (handwritten spec: "WIP Stage Updates", "mandatory photo proof
-- at every production-stage update", "completion percentage calculated automatically, never typed by a worker").
-- production_divisions / production_stage_templates already exist (v2_82b); this migration adds the piece that
-- actually tracks progress through them per Job Card, gated by the SAME reusable, already-production-grade photo
-- pipeline the rest of the app uses (uploadTaskProof -> staff-file-url -> staff_record_attachment), not a new
-- upload system.
--
-- Two real, pre-existing bugs fixed here in passing:
--  1. staff_attachments_entity_type_check already allowed 'factory_material_request' (v2_82b) but
--     staff_record_attachment() was never given a matching branch -- every proof-photo upload on a Material to
--     Order request was silently failing with "Invalid entity_type". Fixed by adding its branch below.
--  2. (same migration) a matching 'factory_job_card_stage' branch is added for the new stage-photo entity type.

-- 1. job_card_stage_updates -- one row per (job, stage), created on Start, mutated to Completed on Complete.
create table if not exists public.job_card_stage_updates (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.inhouse_production_requests(id) on delete cascade,
  stage_template_id uuid references public.production_stage_templates(id),
  stage_code text not null,
  sort_order int not null default 100,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed')),
  started_at timestamptz,
  started_by uuid references public.user_profiles(id),
  completed_at timestamptz,
  completed_by uuid references public.user_profiles(id),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, stage_code)
);
create index if not exists job_card_stage_updates_job_idx on public.job_card_stage_updates (job_id);
create trigger trg_touch_updated_at before update on public.job_card_stage_updates for each row execute function public.staff_touch_updated_at();

alter table public.job_card_stage_updates enable row level security;
-- Visibility is delegated to inhouse_production_requests' own RLS: the EXISTS subquery runs against that table
-- under the caller's session and is therefore already subject to its policies (the standard "inherit the
-- parent's visibility" pattern for a child table).
create policy job_card_stage_updates_select on public.job_card_stage_updates for select to authenticated using (
  exists (select 1 from public.inhouse_production_requests r where r.id = job_id)
);
create policy job_card_stage_updates_write on public.job_card_stage_updates for all to authenticated
  using (staff_current_user_ok() and staff_has_global_oversight()) with check (staff_current_user_ok() and staff_has_global_oversight());
grant select, insert, update, delete on public.job_card_stage_updates to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'job_card_stage_updates') then
    alter publication supabase_realtime add table public.job_card_stage_updates;
  end if;
end $$;

-- 2. staff_attachments -- widen the entity_type whitelist, and give staff_record_attachment() the two new
--    branches (the whitelist alone is not enough -- see bug #1 above).
alter table public.staff_attachments drop constraint if exists staff_attachments_entity_type_check;
alter table public.staff_attachments add constraint staff_attachments_entity_type_check
  check (entity_type in ('task', 'bridge', 'retail_packing', 'retail_godown_handover', 'retail_dispatch', 'retail_delivery',
                          'retail_installation', 'retail_order_item', 'retail_product', 'retail_inventory_item', 'retail_quotation',
                          'retail_delivery_challan', 'factory_material_request', 'factory_job_card_stage'));

CREATE OR REPLACE FUNCTION public.staff_record_attachment(p_entity_type text, p_entity_id uuid, p_file_type text, p_storage_path text, p_original_filename text, p_mime_type text, p_file_size bigint, p_duration_seconds integer DEFAULT NULL::integer, p_purpose text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_task public.staff_tasks%rowtype;
  v_bridge public.bridges%rowtype;
  v_has_access boolean := false;
  v_exists boolean := false;
  v_confidential boolean := false;
  v_attachment_id uuid;
  v_max_bytes bigint := 20 * 1024 * 1024;
  v_storage_obj record;
  v_base_mime text := lower(btrim(split_part(p_mime_type, ';', 1)));
  v_obj_mime text;
  v_old record;
begin
  perform public.staff_assert_operational();

  if p_file_type not in ('image','pdf','word','excel','drawing','voice') then
    raise exception 'Unsupported file_type';
  end if;
  if p_purpose is not null and p_purpose not in ('instruction', 'proof', 'note') then
    raise exception 'Unsupported attachment purpose';
  end if;
  if p_file_size is null or p_file_size <= 0 or p_file_size > v_max_bytes then
    raise exception 'File size invalid or exceeds the pilot limit';
  end if;
  if p_file_type = 'voice' and p_file_size > 5 * 1024 * 1024 then
    raise exception 'Voice messages are limited to 5 MB';
  end if;
  if (p_file_type = 'image' and v_base_mime not in ('image/jpeg','image/png','image/webp','image/heic','image/heif'))
     or (p_file_type = 'pdf' and v_base_mime <> 'application/pdf')
     or (p_file_type = 'word' and v_base_mime not in ('application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain'))
     or (p_file_type = 'excel' and v_base_mime not in ('application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv'))
     or (p_file_type = 'drawing' and v_base_mime not in ('application/dxf','application/dwg','image/vnd.dwg','image/vnd.dxf','application/x-dwg','application/x-dxf','application/acad'))
     or (p_file_type = 'voice' and v_base_mime not in ('audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav','audio/x-m4a','audio/aac'))
  then
    raise exception 'mime_type does not match file_type';
  end if;
  if p_file_type = 'voice' and (p_duration_seconds is null or p_duration_seconds <= 0 or p_duration_seconds > 60) then
    raise exception 'Voice messages must be between 1 and 60 seconds';
  end if;
  if p_purpose = 'instruction' and (p_file_type <> 'voice' or p_entity_type <> 'task') then
    raise exception 'Only a voice recording on a task can be a voice instruction';
  end if;

  if p_storage_path not like (auth.uid()::text || '/%') then
    raise exception 'storage_path must be under your own upload prefix';
  end if;

  select * into v_storage_obj from storage.objects where bucket_id = 'staff-attachments' and name = p_storage_path;
  if v_storage_obj.id is null then
    raise exception 'No uploaded object found at storage_path — refusing to record unverified attachment metadata';
  end if;
  if v_storage_obj.metadata ? 'size' and (v_storage_obj.metadata->>'size')::bigint <> p_file_size then
    raise exception 'Declared file_size does not match the uploaded object';
  end if;
  if v_storage_obj.metadata ? 'mimetype' then
    v_obj_mime := lower(btrim(split_part(v_storage_obj.metadata->>'mimetype', ';', 1)));
    if v_obj_mime <> v_base_mime then
      raise exception 'Declared mime_type does not match the uploaded object';
    end if;
  end if;
  select id into v_attachment_id from public.staff_attachments where storage_path = p_storage_path and entity_id = p_entity_id and is_active;
  if v_attachment_id is not null then return v_attachment_id; end if;

  if p_entity_type = 'task' then
    select * into v_task from public.staff_tasks where id = p_entity_id;
    if v_task.id is null then raise exception 'Parent task does not exist'; end if;
    v_has_access := public.staff_can_view_task(v_task);
    select true into v_confidential from public.departments d where d.id in (v_task.from_department_id, v_task.to_department_id) and d.is_confidential_domain = true limit 1;
  elsif p_entity_type = 'bridge' then
    select * into v_bridge from public.bridges where id = p_entity_id;
    if v_bridge.id is null then raise exception 'Parent bridge does not exist'; end if;
    v_has_access := v_bridge.from_person_id = auth.uid() or v_bridge.to_person_id = auth.uid() or public.staff_task_visible(v_bridge.task_id);

  elsif p_entity_type = 'retail_packing' then
    select exists(select 1 from public.retail_packing_records where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent packing record does not exist'; end if;
    select exists(
      select 1 from public.retail_packing_records p join public.retail_orders o on o.id = p.order_id where p.id = p_entity_id and (
        p.created_by = auth.uid() or o.created_by = auth.uid() or public.retail_can_write_customer(o.customer_id)
        or public.staff_is_godown_staff() or public.staff_has_global_oversight()
        or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(p.department_id) or public.staff_dept_in_hod_scope(public.retail_godown_dept_id())))
      )) into v_has_access;

  elsif p_entity_type = 'retail_godown_handover' then
    select exists(select 1 from public.retail_godown_handovers where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent godown handover does not exist'; end if;
    select exists(
      select 1 from public.retail_godown_handovers h join public.retail_orders o on o.id = h.order_id where h.id = p_entity_id and (
        h.created_by = auth.uid() or h.responsible_user_id = auth.uid() or o.created_by = auth.uid() or public.retail_can_access_customer(o.customer_id)
        or public.staff_is_godown_staff() or public.staff_has_global_oversight()
        or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(h.department_id) or public.staff_dept_in_hod_scope(h.origin_department_id)))
      )) into v_has_access;

  elsif p_entity_type = 'retail_dispatch' then
    select exists(select 1 from public.retail_dispatch_records where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent dispatch record does not exist'; end if;
    select exists(
      select 1 from public.retail_dispatch_records dr join public.retail_orders o on o.id = dr.order_id where dr.id = p_entity_id and (
        dr.created_by = auth.uid() or o.created_by = auth.uid() or public.retail_can_access_customer(o.customer_id)
        or public.staff_is_dispatch_staff() or public.staff_is_godown_staff() or public.staff_has_global_oversight()
        or (public.staff_is_dept_head() and staff_dept_in_hod_scope(dr.department_id))
      )) into v_has_access;

  elsif p_entity_type = 'retail_delivery' then
    select exists(select 1 from public.retail_deliveries where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent delivery record does not exist'; end if;
    select exists(
      select 1 from public.retail_deliveries dl join public.retail_orders o on o.id = dl.order_id where dl.id = p_entity_id and (
        dl.created_by = auth.uid() or o.created_by = auth.uid() or public.retail_can_access_customer(o.customer_id)
        or public.staff_is_dispatch_staff() or public.staff_is_godown_staff() or public.staff_has_global_oversight()
        or (public.staff_is_dept_head() and staff_dept_in_hod_scope(dl.department_id))
      )) into v_has_access;

  elsif p_entity_type = 'retail_installation' then
    select exists(select 1 from public.retail_installations where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent installation record does not exist'; end if;
    select exists(
      select 1 from public.retail_installations ins join public.retail_orders o on o.id = ins.order_id where ins.id = p_entity_id and (
        ins.created_by = auth.uid() or o.created_by = auth.uid() or public.retail_can_access_customer(o.customer_id)
        or public.staff_has_global_oversight() or (public.staff_is_dept_head() and staff_dept_in_hod_scope(o.department_id))
      )) into v_has_access;

  elsif p_entity_type = 'retail_order_item' then
    select exists(select 1 from public.retail_order_items where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent order item does not exist'; end if;
    select exists(
      select 1 from public.retail_order_items oi join public.retail_orders o on o.id = oi.order_id where oi.id = p_entity_id and (
        o.created_by = auth.uid() or public.retail_can_write_customer(o.customer_id)
        or public.staff_has_global_oversight() or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(o.department_id))
      )) into v_has_access;

  elsif p_entity_type = 'retail_product' then
    select exists(select 1 from public.retail_products where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent product does not exist'; end if;
    select exists(
      select 1 from public.retail_products p where p.id = p_entity_id and (
        p.created_by = auth.uid() or public.staff_is_godown_staff() or public.staff_has_global_oversight()
        or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(public.retail_godown_dept_id()))
      )) into v_has_access;

  elsif p_entity_type = 'retail_inventory_item' then
    select exists(select 1 from public.retail_inventory_items where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent inventory item does not exist'; end if;
    select exists(
      select 1 from public.retail_inventory_items ii where ii.id = p_entity_id and (
        ii.created_by = auth.uid() or public.staff_is_godown_staff() or public.staff_has_global_oversight()
        or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(public.retail_godown_dept_id()) or public.staff_dept_in_hod_scope(public.retail_dept_id())))
        or exists (select 1 from public.retail_orders o where o.id in (ii.reserved_order_id, ii.sold_order_id) and (
              o.created_by = auth.uid() or public.retail_can_write_customer(o.customer_id)))
      )) into v_has_access;

  elsif p_entity_type = 'retail_quotation' then
    select exists(select 1 from public.retail_quotations where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent quotation does not exist'; end if;
    select exists(
      select 1 from public.retail_quotations q where q.id = p_entity_id and (
        q.created_by = auth.uid() or public.retail_can_write_customer(q.customer_id)
        or public.staff_has_global_oversight() or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(q.department_id))
      )) into v_has_access;

  elsif p_entity_type = 'retail_delivery_challan' then
    select exists(select 1 from public.retail_delivery_challans where id = p_entity_id) into v_exists;
    if not v_exists then raise exception 'Parent Delivery Challan does not exist'; end if;
    select exists(
      select 1 from public.retail_delivery_challans dc join public.retail_orders o on o.id = dc.order_id where dc.id = p_entity_id and (
        dc.created_by = auth.uid() or o.created_by = auth.uid() or public.retail_can_write_customer(o.customer_id)
        or public.staff_is_godown_staff() or public.staff_has_global_oversight()
        or (public.staff_is_dept_head() and (public.staff_dept_in_hod_scope(o.department_id) or public.staff_dept_in_hod_scope(public.retail_godown_dept_id())))
      )) into v_has_access;

  elsif p_entity_type = 'factory_material_request' then
    select exists(
      select 1 from public.factory_material_requests mr where mr.id = p_entity_id and (
        mr.created_by = auth.uid() or mr.requested_by = auth.uid()
        or public.staff_is_factory_staff() or public.staff_current_department_id() = public.factory_procurement_dept_id()
        or public.staff_has_global_oversight() or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(mr.requesting_department_id))
      )) into v_has_access;
    if not v_has_access then
      select exists(select 1 from public.factory_material_requests where id = p_entity_id) into v_exists;
      if not v_exists then raise exception 'Parent material request does not exist'; end if;
    end if;

  elsif p_entity_type = 'factory_job_card_stage' then
    select exists(
      select 1 from public.job_card_stage_updates su join public.inhouse_production_requests r on r.id = su.job_id
      where su.id = p_entity_id and (
        public.staff_is_factory_staff() or public.staff_has_global_oversight()
        or (public.factory_my_profile_id() is not null and public.factory_my_profile_id() in (r.assigned_factory_coordinator, r.second_assignee_coordinator, r.current_responsible_person))
        or r.requested_by = auth.uid() or (r.source_department_id is not null and r.source_department_id = public.staff_current_department_id())
      )) into v_has_access;
    if not v_has_access then
      select exists(select 1 from public.job_card_stage_updates where id = p_entity_id) into v_exists;
      if not v_exists then raise exception 'Parent production stage does not exist'; end if;
    end if;

  else
    raise exception 'Invalid entity_type';
  end if;

  if not v_has_access then
    raise exception 'You do not have access to attach files to this %', p_entity_type;
  end if;
  if coalesce(v_confidential, false) and not public.staff_has_capability('can_view_restricted_finance') then
    raise exception 'Attachments on a confidential-domain task are restricted';
  end if;
  if p_purpose = 'instruction' and not (
       v_task.assigned_by = auth.uid()
       or public.staff_has_global_oversight()
       or (public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_task.to_department_id))) then
    raise exception 'Only the person who assigned this task (or a manager) can add its voice instruction';
  end if;

  if p_purpose = 'instruction' then
    for v_old in select id, storage_path from public.staff_attachments where entity_type = 'task' and entity_id = p_entity_id and purpose = 'instruction' and is_active loop
      update public.staff_attachments set is_active = false, removed_at = now(), removed_by = auth.uid(), removal_reason = 'replaced by a new voice instruction' where id = v_old.id;
      perform public.staff_write_audit('task', p_entity_id, 'ATTACH_REPLACE', jsonb_build_object('attachment_id', v_old.id), null, null, 'voice instruction replaced');
    end loop;
  end if;

  insert into public.staff_attachments (entity_type, entity_id, file_type, storage_path, original_filename, mime_type, file_size, duration_seconds, uploaded_by, is_confidential, purpose, storage_bucket)
  values (p_entity_type, p_entity_id, p_file_type, p_storage_path, p_original_filename, p_mime_type, p_file_size, p_duration_seconds, auth.uid(), coalesce(v_confidential, false), p_purpose, 'staff-attachments')
  returning id into v_attachment_id;

  perform public.staff_write_audit(p_entity_type, p_entity_id, 'ATTACH', null,
    jsonb_build_object('attachment_id', v_attachment_id, 'file_type', p_file_type, 'purpose', p_purpose), null);

  return v_attachment_id;
end;
$function$;

-- 3. factory_start_stage -- assigned worker or Head/Supervisor only; only one stage in_progress per job at a
--    time (linear flow, matching the handwritten stage list); re-opens a stage that was pending, is idempotent
--    on one already in_progress, and refuses to reopen one already completed (invalid status jump).
create or replace function public.factory_start_stage(p_job_id uuid, p_stage_code text, p_note text default null)
returns public.job_card_stage_updates
language plpgsql security definer set search_path to 'public' as $function$
declare
  j public.inhouse_production_requests%rowtype;
  v_allowed boolean;
  v_tmpl public.production_stage_templates%rowtype;
  v_row public.job_card_stage_updates%rowtype;
  v_other_active int;
begin
  perform public.staff_assert_operational();
  select * into j from public.inhouse_production_requests where id = p_job_id for update;
  if j.id is null then raise exception 'Job Card not found'; end if;
  if j.division_id is null then raise exception 'This Job Card has no Factory segment set yet'; end if;
  if j.factory_status not in ('in_production', 'blocked') then raise exception 'Production stages can only be updated while the Job Card is in production'; end if;

  v_allowed := public.factory_ai_is_reviewer() or (
    public.factory_my_profile_id() is not null
    and public.factory_my_profile_id() in (j.assigned_factory_coordinator, j.second_assignee_coordinator, j.current_responsible_person)
  );
  if not v_allowed then raise exception 'You are not authorized to update this Job Card''s production stages'; end if;

  select * into v_tmpl from public.production_stage_templates where division_id = j.division_id and stage_code = p_stage_code and is_active;
  if v_tmpl.id is null then raise exception 'Unknown stage for this Factory segment'; end if;

  select count(*) into v_other_active from public.job_card_stage_updates where job_id = p_job_id and status = 'in_progress' and stage_code <> p_stage_code;
  if v_other_active > 0 then raise exception 'Finish the current stage before starting another'; end if;

  insert into public.job_card_stage_updates (job_id, stage_template_id, stage_code, sort_order, status, started_at, started_by, note)
  values (p_job_id, v_tmpl.id, p_stage_code, v_tmpl.sort_order, 'in_progress', now(), auth.uid(), p_note)
  on conflict (job_id, stage_code) do update set
    status = case when public.job_card_stage_updates.status = 'completed' then public.job_card_stage_updates.status else 'in_progress' end,
    started_at = coalesce(public.job_card_stage_updates.started_at, now()),
    started_by = coalesce(public.job_card_stage_updates.started_by, auth.uid()),
    note = coalesce(p_note, public.job_card_stage_updates.note)
  returning * into v_row;

  if v_row.status <> 'in_progress' then raise exception 'This stage is already completed'; end if;

  update public.inhouse_production_requests set current_stage = p_stage_code, updated_at = now() where id = p_job_id;
  perform public.factory_log_event(p_job_id, 'stage_started', j.current_stage, p_stage_code, p_note, auth.uid());

  return v_row;
end $function$;

-- 4. factory_complete_stage -- the mandatory photo gate: a stage flagged requires_photo in its division's
--    template cannot complete without at least one already-uploaded, linked photo. Auto-advances current_stage
--    to the next active stage by sort_order, recalculates completion_percentage from completed/total stages
--    (never typed by a worker), and notifies the Supervisor/Head.
create or replace function public.factory_complete_stage(p_job_id uuid, p_stage_code text, p_note text default null)
returns public.inhouse_production_requests
language plpgsql security definer set search_path to 'public' as $function$
declare
  j public.inhouse_production_requests%rowtype;
  v_allowed boolean;
  v_row public.job_card_stage_updates%rowtype;
  v_tmpl public.production_stage_templates%rowtype;
  v_photo_count int;
  v_total_stages int;
  v_completed_stages int;
  v_next_code text;
  v_pct int;
begin
  perform public.staff_assert_operational();
  select * into j from public.inhouse_production_requests where id = p_job_id for update;
  if j.id is null then raise exception 'Job Card not found'; end if;

  v_allowed := public.factory_ai_is_reviewer() or (
    public.factory_my_profile_id() is not null
    and public.factory_my_profile_id() in (j.assigned_factory_coordinator, j.second_assignee_coordinator, j.current_responsible_person)
  );
  if not v_allowed then raise exception 'You are not authorized to update this Job Card''s production stages'; end if;

  select * into v_row from public.job_card_stage_updates where job_id = p_job_id and stage_code = p_stage_code for update;
  if v_row.id is null or v_row.status <> 'in_progress' then raise exception 'Start this stage before completing it'; end if;

  select * into v_tmpl from public.production_stage_templates where id = v_row.stage_template_id;

  if coalesce(v_tmpl.requires_photo, false) then
    select count(*) into v_photo_count from public.staff_attachments
      where entity_type = 'factory_job_card_stage' and entity_id = v_row.id and file_type = 'image' and is_active;
    if v_photo_count = 0 then
      raise exception 'A photo is required to complete the % stage', coalesce(v_tmpl.name_en, p_stage_code);
    end if;
  end if;

  update public.job_card_stage_updates set status = 'completed', completed_at = now(), completed_by = auth.uid(),
    note = coalesce(p_note, note) where id = v_row.id;

  select count(*) into v_total_stages from public.production_stage_templates where division_id = j.division_id and is_active;
  select count(*) into v_completed_stages from public.job_card_stage_updates where job_id = p_job_id and status = 'completed';
  v_pct := case when v_total_stages > 0 then least(100, round(100.0 * v_completed_stages / v_total_stages)) else j.completion_percentage end;

  select stage_code into v_next_code from public.production_stage_templates
    where division_id = j.division_id and is_active and sort_order > coalesce(v_tmpl.sort_order, 0)
    order by sort_order asc limit 1;

  update public.inhouse_production_requests set
    current_stage = coalesce(v_next_code, p_stage_code), completion_percentage = v_pct, updated_at = now()
  where id = p_job_id;
  select * into j from public.inhouse_production_requests where id = p_job_id;

  perform public.factory_log_event(p_job_id, 'stage_completed', p_stage_code, coalesce(v_next_code, p_stage_code), p_note, auth.uid());
  perform public.factory_notify_managers(p_job_id,
    j.job_order_number || ': ' || coalesce(v_tmpl.name_en, p_stage_code) || ' stage completed (' || v_pct || '%)',
    j.job_order_number || ': ' || coalesce(v_tmpl.name_gu, p_stage_code) || ' સ્ટેજ પૂર્ણ (' || v_pct || '%)');

  return j;
end $function$;

-- 5. factory_list_job_stages -- the division's template LEFT JOINed to this job's actual progress, so a stage
--    nobody has touched yet still renders as "pending" (the UI never has to special-case "no row exists yet").
create or replace function public.factory_list_job_stages(p_job_id uuid)
returns table(
  stage_code text, name_en text, name_gu text, sort_order int, requires_photo boolean,
  status text, started_at timestamptz, started_by uuid, started_by_name text,
  completed_at timestamptz, completed_by uuid, completed_by_name text, note text,
  stage_update_id uuid, photo_count bigint
)
language sql stable security invoker set search_path to 'public' as $$
  select t.stage_code, t.name_en, t.name_gu, t.sort_order, t.requires_photo,
    coalesce(su.status, 'pending'), su.started_at, su.started_by, public.factory_user_name(su.started_by),
    su.completed_at, su.completed_by, public.factory_user_name(su.completed_by), su.note,
    su.id,
    coalesce((select count(*) from public.staff_attachments a where a.entity_type = 'factory_job_card_stage' and a.entity_id = su.id and a.is_active), 0)
  from public.production_stage_templates t
  join public.inhouse_production_requests r on r.division_id = t.division_id and r.id = p_job_id
  left join public.job_card_stage_updates su on su.job_id = p_job_id and su.stage_code = t.stage_code
  where t.is_active
  order by t.sort_order;
$$;

-- 6. factory_qc_pending_count -- backs the Dashboard's "QC Pending" counter with real data now that current_stage
--    is actually driven by the stage engine above (previously disclosed as not derivable from reliable data).
create or replace function public.factory_qc_pending_count(p_location uuid default null::uuid)
returns bigint
language sql stable security invoker set search_path to 'public' as $$
  select count(*) from public.inhouse_production_requests r
  where not r.is_test_data and r.factory_status = 'in_production' and r.current_stage = 'QC'
    and (p_location is null or r.factory_location_id = p_location);
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'factory_start_stage(uuid, text, text)',
    'factory_complete_stage(uuid, text, text)',
    'factory_list_job_stages(uuid)',
    'factory_qc_pending_count(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
