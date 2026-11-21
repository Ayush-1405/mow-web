-- v3_15: Factory Job Cards -- a simple production-order flow, built the same way as Procurement orders.
--
-- Any department sends a production order; it becomes a Job Card (MW-FJC-YYYY-NNNN) in the Factory at once, with a
-- Factory task (+ Cross-Department Bridge) that follows the card. Flow:
--   NEW -> ACCEPTED -> PRODUCTION_STARTED -> IN_PROGRESS -> QUALITY_CHECK -> READY_FOR_DISPATCH -> DISPATCHED -> COMPLETED
--   (QC failed -> back to IN_PROGRESS; CANCELLED before dispatch). COMPLETED = the requesting department confirmed receipt.
-- Missing material -> a normal Procurement order (proc_create_order) linked to the card; its progress comes back here.
-- Every write goes through fjc_* SECURITY DEFINER functions; tables are read-only to the app (RLS).
-- New tables only; the older Factory module (inhouse_production_requests ...) is not changed, except that its task
-- trigger ignores Job Card tasks.
begin;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.factory_job_card_counters (year integer primary key, next_seq integer not null default 1);

create table if not exists public.factory_job_cards (
  id uuid primary key default gen_random_uuid(),
  job_card_number text not null unique,
  requesting_department_id uuid not null references public.departments(id),
  requested_by uuid not null references public.user_profiles(id),
  department_head_id uuid references public.user_profiles(id),
  client_name text,
  project_name text,
  project_id uuid,
  order_date date not null default ((now() at time zone 'Asia/Kolkata')::date),
  due_date date not null,                 -- the original required completion date; never changed
  revised_due_date date,                  -- the Factory Head's proposed new date (with reason in the history)
  revised_reason text,
  priority text not null default 'NORMAL' check (priority in ('NORMAL', 'URGENT', 'EMERGENCY')),
  delivery_location text,
  special_instructions text,
  status text not null default 'NEW' check (status in ('NEW', 'ACCEPTED', 'PRODUCTION_STARTED', 'IN_PROGRESS', 'QUALITY_CHECK',
                                                       'READY_FOR_DISPATCH', 'DISPATCHED', 'COMPLETED', 'CANCELLED')),
  assigned_to uuid references public.user_profiles(id),
  accepted_by uuid references public.user_profiles(id),
  accepted_at timestamptz,
  assigned_by uuid references public.user_profiles(id),
  assigned_at timestamptz,
  production_started_at timestamptz,
  production_completed_at timestamptz,
  progress_pct integer not null default 0 check (progress_pct between 0 and 100),
  production_remarks text,
  qc_status text check (qc_status in ('PASSED', 'FAILED')),
  ready_at timestamptz,
  dispatched_at timestamptz,
  received_by uuid references public.user_profiles(id),
  received_at timestamptz,
  receipt_remarks text,
  cancelled_reason text,
  source_task_id uuid references public.staff_tasks(id) on delete set null,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists factory_job_cards_status_idx on public.factory_job_cards (status);
create index if not exists factory_job_cards_dept_idx on public.factory_job_cards (requesting_department_id);
create index if not exists factory_job_cards_assigned_idx on public.factory_job_cards (assigned_to);

create table if not exists public.factory_job_card_items (
  id uuid primary key default gen_random_uuid(),
  job_card_id uuid not null references public.factory_job_cards(id) on delete cascade,
  line_no integer not null,
  product_name text not null,
  product_category text,
  item_code text,
  description text,
  quantity numeric not null check (quantity > 0),
  unit text not null default 'nos',
  dimensions text,
  material_spec text,
  finish_colour text,
  laminate_fabric_hardware text,
  instructions text,
  qty_completed numeric not null default 0 check (qty_completed >= 0),
  remarks text,
  unique (job_card_id, line_no)
);

create table if not exists public.factory_job_card_files (
  id uuid primary key default gen_random_uuid(),
  job_card_id uuid not null references public.factory_job_cards(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  file_type text,
  kind text not null default 'REFERENCE' check (kind in ('PRODUCT_IMAGE', 'DRAWING', 'PDF', 'REFERENCE', 'QC', 'DISPATCH')),
  description text,
  uploaded_by uuid references public.user_profiles(id),
  uploaded_at timestamptz not null default now()
);

create table if not exists public.factory_job_card_events (
  id uuid primary key default gen_random_uuid(),
  job_card_id uuid not null references public.factory_job_cards(id) on delete cascade,
  action text not null,
  from_status text,
  to_status text,
  note text,
  payload jsonb,
  actor_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists factory_job_card_events_job_idx on public.factory_job_card_events (job_card_id, created_at);

create table if not exists public.factory_job_card_qc (
  id uuid primary key default gen_random_uuid(),
  job_card_id uuid not null references public.factory_job_cards(id) on delete cascade,
  product_quality_ok boolean not null,
  dimensions_ok boolean not null,
  material_ok boolean not null,
  finish_ok boolean not null,
  quantity_ok boolean not null,
  defects text,
  result text not null check (result in ('PASSED', 'FAILED')),
  checked_by uuid not null references public.user_profiles(id),
  checked_on date not null default ((now() at time zone 'Asia/Kolkata')::date),
  created_at timestamptz not null default now()
);

create table if not exists public.factory_job_card_dispatches (
  id uuid primary key default gen_random_uuid(),
  job_card_id uuid not null references public.factory_job_cards(id) on delete cascade,
  dispatch_date date not null,
  quantity numeric not null check (quantity > 0),
  delivery_reference text not null,
  transport_details text,
  remarks text,
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.factory_job_card_reminders (
  job_card_id uuid not null references public.factory_job_cards(id) on delete cascade,
  kind text not null,
  sent_on date not null,
  primary key (job_card_id, kind, sent_on)
);

alter table public.staff_tasks add column if not exists factory_job_card_id uuid references public.factory_job_cards(id) on delete set null;
create unique index if not exists staff_tasks_factory_job_card_uidx on public.staff_tasks (factory_job_card_id) where factory_job_card_id is not null;
alter table public.purchase_requests add column if not exists factory_job_card_id uuid references public.factory_job_cards(id) on delete set null;
create index if not exists purchase_requests_factory_job_card_idx on public.purchase_requests (factory_job_card_id) where factory_job_card_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Who is who
-- ---------------------------------------------------------------------------
create or replace function public.fjc_factory_dept()
returns uuid language sql stable security definer set search_path to 'public' as $$
  select id from public.departments where code = 'FACTORY';
$$;

create or replace function public.fjc_is_member(p_user uuid default auth.uid())
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.user_profiles where id = p_user and is_active and department_id = public.fjc_factory_dept());
$$;

-- Factory Head / Supervisor (they accept for others, reassign, approve QC, revise dates). Management counts too.
create or replace function public.fjc_is_lead(p_user uuid default auth.uid())
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.user_profiles up join public.roles r on r.id = up.role_id
                  where up.id = p_user and up.is_active and up.department_id = public.fjc_factory_dept() and r.code in ('dept_head', 'supervisor'))
         or (p_user = auth.uid() and coalesce(public.staff_has_global_oversight(), false));
$$;

create or replace function public.fjc_factory_leads()
returns uuid[] language sql stable security definer set search_path to 'public' as $$
  select coalesce(array_agg(up.id order by r.code = 'dept_head' desc, up.created_at), '{}') from public.user_profiles up join public.roles r on r.id = up.role_id
   where up.is_active and up.department_id = public.fjc_factory_dept() and r.code in ('dept_head', 'supervisor');
$$;

-- Factory Heads/Supervisors and Management see every card; a Factory employee sees new (unaccepted) cards and the ones
-- assigned to them; the requesting department sees its own cards.
create or replace function public.fjc_can_view(p_job_id uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.factory_job_cards j
     where j.id = p_job_id
       and (public.fjc_is_lead() or coalesce(public.staff_has_global_oversight(), false)
            or (public.fjc_is_member() and (j.status = 'NEW' or j.assigned_to = auth.uid() or j.accepted_by = auth.uid()))
            or j.requested_by = auth.uid()
            or j.requesting_department_id = public.staff_current_department_id()));
$$;

create or replace function public.fjc_effective_due(p_job public.factory_job_cards)
returns date language sql immutable as $$ select coalesce(p_job.revised_due_date, p_job.due_date); $$;

-- The requesting side: requester, their Department Head(s) and, for an Interior project, the project's manager.
create or replace function public.fjc_requester_side(p_job public.factory_job_cards)
returns uuid[] language sql stable security definer set search_path to 'public' as $$
  select array(select distinct u from unnest(array[p_job.requested_by] || public.proc_department_heads(p_job.requesting_department_id)
     || case when p_job.project_id is not null then array[public.proc_project_manager_user(p_job.project_id)] else '{}'::uuid[] end) u where u is not null);
$$;

create or replace function public.fjc_notify(p_users uuid[], p_job_id uuid, p_en text, p_gu text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v uuid;
begin
  foreach v in array (select array(select distinct x from unnest(coalesce(p_users, '{}')) x where x is not null)) loop
    perform public.staff_notify_assignment(v, 'FACTORY_JOB_CARD', p_job_id, left(p_en, 300), left(p_gu, 300));
  end loop;
end $$;

create or replace function public.fjc_log(p_job_id uuid, p_action text, p_from text, p_to text, p_note text, p_payload jsonb default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_dept uuid;
begin
  insert into public.factory_job_card_events (job_card_id, action, from_status, to_status, note, payload, actor_id)
  values (p_job_id, p_action, p_from, p_to, nullif(btrim(coalesce(p_note, '')), ''), p_payload, auth.uid());
  select requesting_department_id into v_dept from public.factory_job_cards where id = p_job_id;
  perform public.staff_write_audit('factory_job_card', p_job_id, p_action, case when p_from is not null then jsonb_build_object('status', p_from) end,
    jsonb_build_object('status', p_to) || coalesce(p_payload, '{}'), v_dept, nullif(btrim(coalesce(p_note, '')), ''));
end $$;

create or replace function public.fjc_next_number()
returns text language plpgsql security definer set search_path to 'public' as $$
declare v_year integer := extract(year from (now() at time zone 'Asia/Kolkata'))::integer; v_seq integer;
begin
  insert into public.factory_job_card_counters (year, next_seq) values (v_year, 2)
  on conflict (year) do update set next_seq = public.factory_job_card_counters.next_seq + 1
  returning next_seq - 1 into v_seq;
  return 'MW-FJC-' || v_year || '-' || lpad(v_seq::text, 4, '0');
end $$;

-- ---------------------------------------------------------------------------
-- 3. The Factory task + Bridge that follow the card
-- ---------------------------------------------------------------------------
create or replace function public.fjc_task_guard()
returns trigger language plpgsql set search_path to 'public' as $$
declare v_number text;
begin
  if new.factory_job_card_id is null then return new; end if;
  if coalesce(current_setting('mow.fjc_sync', true), '') = 'on' then return new; end if;
  if new.status_id is distinct from old.status_id or new.assigned_to is distinct from old.assigned_to or new.current_owner_id is distinct from old.current_owner_id
     or new.is_active is distinct from old.is_active or new.to_department_id is distinct from old.to_department_id or new.due_date is distinct from old.due_date then
    select job_card_number into v_number from public.factory_job_cards where id = new.factory_job_card_id;
    raise exception 'Task % belongs to Job Card %. Open the Job Card to accept, assign, update or complete it.', old.task_number, v_number;
  end if;
  return new;
end $$;
drop trigger if exists trg_a_fjc_task_guard on public.staff_tasks;
create trigger trg_a_fjc_task_guard before update on public.staff_tasks for each row execute function public.fjc_task_guard();

create or replace function public.fjc_sync_task(p_job_id uuid)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare
  j public.factory_job_cards; t public.staff_tasks; v_prev text := coalesce(current_setting('mow.fjc_sync', true), '');
  v_prev2 text := coalesce(current_setting('mow.proc_task_sync', true), '');
  v_fac uuid := public.fjc_factory_dept(); v_lead uuid; v_owner uuid; v_from_dept uuid; v_title text; v_desc text; v_items text; v_prio uuid;
  v_path text[] := array['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'VERIFIED', 'CLOSED']; v_code text; v_target text; v_i int; v_dept text;
  v_qty numeric;
begin
  select * into j from public.factory_job_cards where id = p_job_id;
  if j.id is null or v_fac is null then return null; end if;
  perform set_config('mow.fjc_sync', 'on', true);
  perform set_config('mow.proc_task_sync', 'on', true); -- the shared assignee guard lets synced owner changes through

  v_lead := (public.fjc_factory_leads())[1];
  v_owner := coalesce(j.assigned_to, v_lead,
                      (select id from public.user_profiles where is_active and department_id = v_fac order by created_at limit 1));
  if v_owner is null then
    perform set_config('mow.fjc_sync', v_prev, true); perform set_config('mow.proc_task_sync', v_prev2, true);
    raise exception 'The Factory has no active staff to receive this Job Card';
  end if;
  select d.name_en into v_dept from public.departments d where d.id = j.requesting_department_id;
  select string_agg(i.line_no || ') ' || i.product_name || ' — ' || trim(to_char(i.quantity, 'FM999999990.##')) || ' ' || i.unit
                    || coalesce(' (' || i.dimensions || ')', ''), '; ' order by i.line_no), sum(i.quantity)
    into v_items, v_qty from public.factory_job_card_items i where i.job_card_id = j.id;
  v_title := left('Factory Job Card ' || j.job_card_number || ': ' || coalesce((select product_name from public.factory_job_card_items where job_card_id = j.id order by line_no limit 1), ''), 200);
  v_desc := 'Job Card ' || j.job_card_number || ' from ' || coalesce(v_dept, 'a department')
    || coalesce(' · client ' || nullif(j.client_name, ''), '') || coalesce(' · project ' || nullif(j.project_name, ''), '')
    || '. Due ' || to_char(public.fjc_effective_due(j), 'DD-MM-YYYY') || '. Priority ' || initcap(j.priority) || '. Items: ' || coalesce(v_items, '-') || '.';
  select id into v_prio from public.priority_master where code = case when j.priority in ('URGENT', 'EMERGENCY') then 'URGENT' else 'NORMAL' end;
  v_from_dept := case when exists (select 1 from public.departments where id = j.requesting_department_id and is_confidential_domain) then v_fac
                      else j.requesting_department_id end;

  select * into t from public.staff_tasks where factory_job_card_id = j.id for update;
  if t.id is null then
    insert into public.staff_tasks (title, description, task_type_id, priority_id, status_id, proof_type_id, from_department_id, to_department_id,
      assigned_by, assigned_to, verifier_id, current_owner_id, reference_number, requirement_text, quantity, due_date, project_id, source_module,
      source_type, system_key, factory_job_card_id, requires_acceptance, is_bridge, proof_instructions)
    values (v_title, v_desc, (select id from public.task_types where code = 'FACTORY_REQUEST'), v_prio, public.proc_task_status_id('ASSIGNED'),
      (select id from public.proof_types where code = 'note'), v_from_dept, v_fac, j.requested_by, v_owner, coalesce(v_lead, v_owner), v_owner,
      j.job_card_number, left(coalesce(v_items, v_title), 500), trim(to_char(coalesce(v_qty, 0), 'FM999999990.##')) || ' nos',
      public.fjc_effective_due(j), null, 'factory_job_card', 'factory_job_card', 'FJC:' || j.id, j.id, true, v_from_dept <> v_fac,
      'Work on the Job Card page: accept, update production, QC, ready for dispatch.')
    returning * into t;
    insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by) values (t.id, v_owner, 'primary', j.requested_by)
    on conflict (task_id, user_id) do nothing;
    if t.is_bridge then
      insert into public.bridges (task_id, from_department_id, to_department_id, from_person_id, to_person_id, requirement_text, quantity)
      values (t.id, t.from_department_id, t.to_department_id, j.requested_by, v_owner, t.requirement_text, t.quantity)
      on conflict (task_id) do nothing;
    end if;
    perform public.staff_write_audit('task', t.id, 'CREATE', null, jsonb_build_object('task_number', t.task_number, 'factory_job_card_id', j.id,
      'job_card_number', j.job_card_number, 'is_bridge', t.is_bridge), v_fac, 'Created automatically from Job Card ' || j.job_card_number);
    perform public.staff_post_system_task_message(t.id, 'Factory task created for Job Card ' || j.job_card_number || ', due ' || to_char(public.fjc_effective_due(j), 'DD-MM-YYYY'),
      'જોબ કાર્ડ ' || j.job_card_number || ' માટે ફેક્ટરી કાર્ય બનાવાયું');
  end if;

  if j.status = 'CANCELLED' then
    if t.is_active then
      update public.staff_tasks set is_active = false where id = t.id;
      update public.bridges set is_active = false where task_id = t.id;
      perform public.staff_post_system_task_message(t.id, 'Job Card cancelled: ' || coalesce(j.cancelled_reason, ''), 'જોબ કાર્ડ રદ');
    end if;
    perform set_config('mow.fjc_sync', v_prev, true); perform set_config('mow.proc_task_sync', v_prev2, true);
    return t.id;
  end if;

  update public.staff_tasks set title = v_title, description = v_desc, priority_id = v_prio, due_date = public.fjc_effective_due(j)
   where id = t.id and (title, description, priority_id, due_date) is distinct from (v_title, v_desc, v_prio, public.fjc_effective_due(j));

  -- Owner follows the card's assignee.
  if t.assigned_to is distinct from v_owner then
    perform public.proc_task_set_owner(t.id, v_owner, j.assigned_to is not null, auth.uid(), 'Job Card assignment');
    update public.staff_tasks set previous_owner_id = assigned_to, assigned_to = v_owner, current_owner_id = v_owner,
      accepted_by = case when j.assigned_to is not null and accepted_by is not null then v_owner else accepted_by end where id = t.id;
    update public.bridges set to_person_id = v_owner where task_id = t.id;
  end if;

  v_target := case j.status when 'NEW' then 'ASSIGNED' when 'ACCEPTED' then 'ACCEPTED'
                            when 'READY_FOR_DISPATCH' then 'COMPLETED' when 'DISPATCHED' then 'COMPLETED' when 'COMPLETED' then 'CLOSED'
                            else 'IN_PROGRESS' end;
  loop
    select code into v_code from public.status_master where id = (select status_id from public.staff_tasks where id = t.id);
    v_i := array_position(v_path, v_code);
    exit when v_i is null or v_i >= array_position(v_path, v_target);
    if v_path[v_i + 1] = 'ACCEPTED' then
      perform public.proc_task_set_owner(t.id, v_owner, true, auth.uid(), 'Job Card accepted');
      update public.staff_tasks set status_id = public.proc_task_status_id('ACCEPTED'), accepted_by = v_owner, accepted_at = coalesce(j.accepted_at, now())
       where id = t.id;
      update public.bridges set acceptance_status = 'ACCEPTED', to_person_id = v_owner, accepted_at = coalesce(j.accepted_at, now()) where task_id = t.id;
    elsif v_path[v_i + 1] = 'IN_PROGRESS' then
      update public.staff_tasks set status_id = public.proc_task_status_id('IN_PROGRESS'), started_by = v_owner,
        started_at = coalesce(j.production_started_at, now()) where id = t.id;
    elsif v_path[v_i + 1] = 'COMPLETED' then
      update public.staff_tasks set status_id = public.proc_task_status_id('COMPLETED'), completed_by = v_owner, completed_at = coalesce(j.ready_at, now()),
        completion_note = 'Production finished and QC passed — ready for dispatch' where id = t.id;
      update public.bridges set completed_at = now() where task_id = t.id;
    elsif v_path[v_i + 1] = 'VERIFIED' then
      update public.staff_tasks set status_id = public.proc_task_status_id('VERIFIED'), verified_by = coalesce(j.received_by, auth.uid()), verified_at = now()
       where id = t.id;
    elsif v_path[v_i + 1] = 'CLOSED' then
      update public.staff_tasks set status_id = public.proc_task_status_id('CLOSED'), closed_by = coalesce(j.received_by, auth.uid(), v_owner), closed_at = now()
       where id = t.id;
      update public.bridges set verified_by = coalesce(j.received_by, auth.uid()), verified_at = now(), closed_at = now() where task_id = t.id;
      perform public.staff_post_system_task_message(t.id, 'Received by the requesting department — Job Card completed', 'જોબ કાર્ડ પૂર્ણ');
    end if;
  end loop;

  perform set_config('mow.fjc_sync', v_prev, true); perform set_config('mow.proc_task_sync', v_prev2, true);
  return t.id;
end $$;

-- The older Factory module's task trigger leaves Job Card tasks alone (they notify through the card).
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.factory_task_after_change()'::regprocedure);
  if position('factory_job_card_id' in v_def) = 0 then
    v_def := replace(v_def, E'begin\n  if new.job_card_id is null and new.to_department_id is distinct from v_fac then return new; end if;',
                     E'begin\n  if new.factory_job_card_id is not null then return new; end if;\n  if new.job_card_id is null and new.to_department_id is distinct from v_fac then return new; end if;');
    if position('factory_job_card_id' in v_def) = 0 then raise exception 'factory_task_after_change: expected text not found'; end if;
    execute v_def;
  end if;
end $do$;

-- ---------------------------------------------------------------------------
-- 4. Creating a Job Card
-- ---------------------------------------------------------------------------
-- p_header: {client_name, project_name, project_id, due_date, priority, delivery_location, special_instructions, source_task_id}
-- p_items:  [{product_name, product_category, item_code, description, quantity, unit, dimensions, material_spec, finish_colour,
--             laminate_fabric_hardware, instructions}]
create or replace function public.fjc_create(p_header jsonb, p_items jsonb, p_idempotency_key text default null)
returns public.factory_job_cards language plpgsql security definer set search_path to 'public' as $$
declare
  j public.factory_job_cards; v_dept uuid := public.staff_current_department_id(); v_due date; v_prio text; v_i jsonb; v_n int := 0; v_qty numeric;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), ''); v_head uuid; v_src uuid := public.proc_try_uuid(p_header->>'source_task_id');
  v_project uuid := public.proc_try_uuid(p_header->>'project_id');
begin
  perform public.staff_assert_operational();
  if v_dept is null then raise exception 'Your profile has no department, so a Job Card cannot be sent'; end if;
  if v_key is not null then
    select * into j from public.factory_job_cards where idempotency_key = v_key;
    if j.id is not null then
      if j.requested_by <> auth.uid() then raise exception 'This request key is already used'; end if;
      return j; -- the same submission sent twice (double click / retry): the first card, not a duplicate
    end if;
  end if;
  begin v_due := nullif(p_header->>'due_date', '')::date; exception when others then raise exception 'The due date is not valid'; end;
  if v_due is null then raise exception 'Required completion date is required'; end if;
  if v_due < public.proc_today_ist() then raise exception 'Required completion date cannot be in the past'; end if;
  v_prio := upper(coalesce(nullif(p_header->>'priority', ''), 'NORMAL'));
  if v_prio not in ('NORMAL', 'URGENT', 'EMERGENCY') then raise exception 'Priority must be Normal, Urgent or Emergency'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Add at least one product'; end if;
  if v_src is not null and not exists (select 1 from public.staff_tasks where id = v_src) then v_src := null; end if;
  v_head := (public.proc_department_heads(v_dept))[1];

  insert into public.factory_job_cards (job_card_number, requesting_department_id, requested_by, department_head_id, client_name, project_name, project_id,
    due_date, priority, delivery_location, special_instructions, source_task_id, idempotency_key)
  values (public.fjc_next_number(), v_dept, auth.uid(), v_head, nullif(btrim(coalesce(p_header->>'client_name', '')), ''),
    nullif(btrim(coalesce(p_header->>'project_name', '')), ''), v_project, v_due, v_prio,
    nullif(btrim(coalesce(p_header->>'delivery_location', '')), ''), nullif(btrim(coalesce(p_header->>'special_instructions', '')), ''), v_src, v_key)
  returning * into j;

  for v_i in select * from jsonb_array_elements(p_items) loop
    if btrim(coalesce(v_i->>'product_name', '')) = '' then
      if exists (select 1 from jsonb_each_text(v_i) e where btrim(coalesce(e.value, '')) <> '') then raise exception 'Every product needs a product name'; end if;
      continue; -- a fully empty row from the form
    end if;
    begin v_qty := nullif(btrim(coalesce(v_i->>'quantity', '')), '')::numeric; exception when others then raise exception 'Quantity for % is not a number', v_i->>'product_name'; end;
    if v_qty is null or v_qty <= 0 then raise exception 'Quantity for % must be more than 0', v_i->>'product_name'; end if;
    v_n := v_n + 1;
    insert into public.factory_job_card_items (job_card_id, line_no, product_name, product_category, item_code, description, quantity, unit, dimensions,
      material_spec, finish_colour, laminate_fabric_hardware, instructions)
    values (j.id, v_n, btrim(v_i->>'product_name'), nullif(btrim(coalesce(v_i->>'product_category', '')), ''), nullif(btrim(coalesce(v_i->>'item_code', '')), ''),
      nullif(btrim(coalesce(v_i->>'description', '')), ''), v_qty, coalesce(nullif(btrim(coalesce(v_i->>'unit', '')), ''), 'nos'),
      nullif(btrim(coalesce(v_i->>'dimensions', '')), ''), nullif(btrim(coalesce(v_i->>'material_spec', '')), ''),
      nullif(btrim(coalesce(v_i->>'finish_colour', '')), ''), nullif(btrim(coalesce(v_i->>'laminate_fabric_hardware', '')), ''),
      nullif(btrim(coalesce(v_i->>'instructions', '')), ''));
  end loop;
  if v_n = 0 then raise exception 'Add at least one product'; end if;

  perform public.fjc_log(j.id, 'CREATED', null, 'NEW', null, jsonb_build_object('job_card_number', j.job_card_number, 'items', v_n));
  perform public.fjc_sync_task(j.id);
  perform public.fjc_notify(public.fjc_factory_leads() || array(select id from public.user_profiles where is_active and department_id = public.fjc_factory_dept()),
    j.id, 'New Job Card ' || j.job_card_number || ' from ' || (select name_en from public.departments where id = v_dept) || ', due ' || to_char(v_due, 'DD-MM-YYYY'),
    'નવું જોબ કાર્ડ ' || j.job_card_number || ', નિયત ' || to_char(v_due, 'DD-MM-YYYY'));
  return j;
end $$;

-- Files are uploaded to procurement-orders/factory-jobs/<job id>/... and then registered here.
create or replace function public.fjc_add_file(p_job_id uuid, p_storage_path text, p_file_name text, p_file_type text, p_kind text, p_description text default null)
returns public.factory_job_card_files language plpgsql security definer set search_path to 'public' as $$
declare v public.factory_job_card_files; v_kind text := upper(coalesce(nullif(p_kind, ''), 'REFERENCE'));
begin
  perform public.staff_assert_operational();
  if not public.fjc_can_view(p_job_id) then raise exception 'Job Card not found'; end if;
  if p_storage_path is null or p_storage_path not like 'factory-jobs/' || p_job_id || '/%' then raise exception 'The file is not stored under this Job Card'; end if;
  if v_kind not in ('PRODUCT_IMAGE', 'DRAWING', 'PDF', 'REFERENCE', 'QC', 'DISPATCH') then raise exception 'Unknown file kind'; end if;
  insert into public.factory_job_card_files (job_card_id, storage_path, file_name, file_type, kind, description, uploaded_by)
  values (p_job_id, p_storage_path, coalesce(nullif(btrim(p_file_name), ''), 'file'), p_file_type, v_kind, nullif(btrim(coalesce(p_description, '')), ''), auth.uid())
  returning * into v;
  perform public.fjc_log(p_job_id, 'FILE_ADDED', null, null, v.file_name, jsonb_build_object('kind', v_kind));
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Every step on the card
-- ---------------------------------------------------------------------------
-- actions: accept {assignee?}, assign {assignee, reason?}, start, progress {items:[{id, qty_completed, remarks}], remarks},
--          send_to_qc, qc {product_quality_ok, dimensions_ok, material_ok, finish_ok, quantity_ok, result, defects},
--          ready, dispatch {dispatch_date, quantity, delivery_reference, transport_details, remarks}, confirm_receipt {remarks},
--          revise_date {date, reason}, cancel {reason}
create or replace function public.fjc_action(p_job_id uuid, p_action text, p_payload jsonb default '{}')
returns public.factory_job_cards language plpgsql security definer set search_path to 'public' as $$
declare
  j public.factory_job_cards; v_old text; v_new text; v_uid uuid := auth.uid(); v_lead boolean := public.fjc_is_lead(); v_member boolean := public.fjc_is_member();
  v_mine boolean; v_note text := nullif(btrim(coalesce(p_payload->>'reason', p_payload->>'remarks', p_payload->>'defects', '')), '');
  v_who uuid; v_name text; v_it jsonb; v_q numeric; v_total numeric; v_done numeric; v_pct int; v_date date; v_result text; v_disp numeric;
  v_requester boolean; p jsonb := coalesce(p_payload, '{}');
begin
  perform public.staff_assert_operational();
  select * into j from public.factory_job_cards where id = p_job_id for update;
  if j.id is null then raise exception 'Job Card not found'; end if;
  if not public.fjc_can_view(p_job_id) then
    -- Two Factory employees pressing Accept at once: the loser no longer sees the card, so say who took it.
    if p_action = 'accept' and v_member and j.status <> 'NEW' then
      raise exception 'Job Card % was already accepted by %', j.job_card_number, coalesce(public.factory_user_name(j.accepted_by), 'someone else');
    end if;
    raise exception 'Job Card not found';
  end if;
  v_old := j.status; v_new := v_old;
  v_mine := j.assigned_to = v_uid;
  v_requester := j.requested_by = v_uid or j.requesting_department_id = public.staff_current_department_id();

  case p_action
  when 'accept' then
    if not v_member and not v_lead then raise exception 'Only the Factory can accept a Job Card'; end if;
    if v_old <> 'NEW' then
      raise exception 'Job Card % was already accepted by %', j.job_card_number, coalesce(public.factory_user_name(j.accepted_by), 'someone else');
    end if;
    v_who := coalesce(public.proc_try_uuid(p->>'assignee'), v_uid);
    if v_who <> v_uid and not v_lead then raise exception 'Only the Factory Head can accept a Job Card for someone else'; end if;
    if not public.fjc_is_member(v_who) then raise exception 'Choose an active Factory employee'; end if;
    update public.factory_job_cards set status = 'ACCEPTED', accepted_by = v_uid, accepted_at = now(), assigned_to = v_who, assigned_by = v_uid, assigned_at = now()
     where id = p_job_id returning * into j;
    v_new := 'ACCEPTED';
    v_note := 'Accepted' || case when v_who <> v_uid then ' and assigned to ' || coalesce(public.factory_user_name(v_who), '') else '' end;
    perform public.fjc_notify(public.fjc_requester_side(j), j.id, 'Factory accepted Job Card ' || j.job_card_number || ' — assigned to ' || coalesce(public.factory_user_name(v_who), ''),
      'ફેક્ટરીએ જોબ કાર્ડ ' || j.job_card_number || ' સ્વીકાર્યું');
    perform public.fjc_notify(array[v_who], j.id, 'Job Card ' || j.job_card_number || ' is assigned to you, due ' || to_char(public.fjc_effective_due(j), 'DD-MM-YYYY'),
      'જોબ કાર્ડ ' || j.job_card_number || ' તમને સોંપાયું');

  when 'assign' then
    if not v_lead then raise exception 'Only the Factory Head can assign or reassign a Job Card'; end if;
    if v_old in ('COMPLETED', 'CANCELLED') then raise exception 'This Job Card is closed'; end if;
    v_who := public.proc_try_uuid(p->>'assignee');
    if v_who is null or not public.fjc_is_member(v_who) then raise exception 'Choose an active Factory employee'; end if;
    if v_who = j.assigned_to then raise exception 'The Job Card is already assigned to this employee'; end if;
    update public.factory_job_cards set assigned_to = v_who, assigned_by = v_uid, assigned_at = now(),
      status = case when status = 'NEW' then 'ACCEPTED' else status end, accepted_by = coalesce(accepted_by, v_uid), accepted_at = coalesce(accepted_at, now())
     where id = p_job_id returning * into j;
    v_new := j.status;
    v_note := 'Assigned to ' || coalesce(public.factory_user_name(v_who), '') || coalesce(' — ' || nullif(btrim(coalesce(p->>'reason', '')), ''), '');
    perform public.fjc_notify(array[v_who], j.id, 'Job Card ' || j.job_card_number || ' is assigned to you, due ' || to_char(public.fjc_effective_due(j), 'DD-MM-YYYY'),
      'જોબ કાર્ડ ' || j.job_card_number || ' તમને સોંપાયું');
    if v_old = 'NEW' then
      perform public.fjc_notify(public.fjc_requester_side(j), j.id, 'Factory accepted Job Card ' || j.job_card_number, 'ફેક્ટરીએ જોબ કાર્ડ ' || j.job_card_number || ' સ્વીકાર્યું');
    end if;

  when 'start' then
    if not (v_mine or v_lead) then raise exception 'Only the assigned employee or the Factory Head can start production'; end if;
    if v_old <> 'ACCEPTED' then raise exception 'Production can start once the Job Card is accepted'; end if;
    update public.factory_job_cards set status = 'PRODUCTION_STARTED', production_started_at = now() where id = p_job_id returning * into j;
    v_new := 'PRODUCTION_STARTED';
    perform public.fjc_notify(public.fjc_requester_side(j), j.id, 'Production started on Job Card ' || j.job_card_number, 'જોબ કાર્ડ ' || j.job_card_number || ' નું ઉત્પાદન શરૂ');

  when 'progress' then
    if not (v_mine or v_lead) then raise exception 'Only the assigned employee or the Factory Head can update production'; end if;
    if v_old not in ('PRODUCTION_STARTED', 'IN_PROGRESS') then raise exception 'Start production before updating progress'; end if;
    for v_it in select * from jsonb_array_elements(coalesce(p->'items', '[]')) loop
      begin v_q := nullif(btrim(coalesce(v_it->>'qty_completed', '')), '')::numeric; exception when others then raise exception 'Quantity completed is not a number'; end;
      if v_q is not null then
        if v_q < 0 then raise exception 'Quantity completed cannot be negative'; end if;
        if v_q > (select quantity from public.factory_job_card_items where id = public.proc_try_uuid(v_it->>'id') and job_card_id = p_job_id) then
          raise exception 'Quantity completed cannot be more than the ordered quantity';
        end if;
      end if;
      update public.factory_job_card_items set qty_completed = coalesce(v_q, qty_completed),
        remarks = coalesce(nullif(btrim(coalesce(v_it->>'remarks', '')), ''), remarks)
       where id = public.proc_try_uuid(v_it->>'id') and job_card_id = p_job_id;
      if not found then raise exception 'A line does not belong to this Job Card'; end if;
    end loop;
    select sum(quantity), sum(qty_completed) into v_total, v_done from public.factory_job_card_items where job_card_id = p_job_id;
    v_pct := least(100, floor(100 * v_done / nullif(v_total, 0)))::int;
    update public.factory_job_cards set status = 'IN_PROGRESS', progress_pct = coalesce(v_pct, 0),
      production_remarks = coalesce(nullif(btrim(coalesce(p->>'remarks', '')), ''), production_remarks)
     where id = p_job_id returning * into j;
    v_new := 'IN_PROGRESS';
    v_note := coalesce(v_pct, 0) || '% done' || coalesce(' — ' || nullif(btrim(coalesce(p->>'remarks', '')), ''), '');

  when 'send_to_qc' then
    if not (v_mine or v_lead) then raise exception 'Only the assigned employee or the Factory Head can send the work to Quality Check'; end if;
    if v_old not in ('PRODUCTION_STARTED', 'IN_PROGRESS') then raise exception 'Only work in production can go to Quality Check'; end if;
    if exists (select 1 from public.factory_job_card_items where job_card_id = p_job_id and qty_completed < quantity) then
      raise exception 'Production is not finished: % still pending',
        (select string_agg(product_name || ' ' || trim(to_char(quantity - qty_completed, 'FM999999990.##')) || ' ' || unit, ', ' order by line_no)
           from public.factory_job_card_items where job_card_id = p_job_id and qty_completed < quantity);
    end if;
    update public.factory_job_cards set status = 'QUALITY_CHECK', qc_status = null, progress_pct = 100, production_completed_at = now()
     where id = p_job_id returning * into j;
    v_new := 'QUALITY_CHECK';
    perform public.fjc_notify(public.fjc_factory_leads(), j.id, 'Quality Check pending: Job Card ' || j.job_card_number, 'ગુણવત્તા તપાસ બાકી: ' || j.job_card_number);

  when 'qc' then
    if not v_lead then raise exception 'Only the Factory Head or an authorised QC person can record Quality Check'; end if;
    if v_old <> 'QUALITY_CHECK' then raise exception 'This Job Card is not waiting for Quality Check'; end if;
    v_result := upper(coalesce(p->>'result', ''));
    if v_result not in ('PASSED', 'FAILED') then raise exception 'Choose QC passed or failed'; end if;
    if v_result = 'PASSED' and not (coalesce((p->>'product_quality_ok')::boolean, false) and coalesce((p->>'dimensions_ok')::boolean, false)
        and coalesce((p->>'material_ok')::boolean, false) and coalesce((p->>'finish_ok')::boolean, false) and coalesce((p->>'quantity_ok')::boolean, false)) then
      raise exception 'QC can pass only when quality, dimensions, material, finish and quantity are all verified';
    end if;
    if v_result = 'FAILED' and nullif(btrim(coalesce(p->>'defects', '')), '') is null then raise exception 'Give the defects / reason for failing QC'; end if;
    insert into public.factory_job_card_qc (job_card_id, product_quality_ok, dimensions_ok, material_ok, finish_ok, quantity_ok, defects, result, checked_by)
    values (p_job_id, coalesce((p->>'product_quality_ok')::boolean, false), coalesce((p->>'dimensions_ok')::boolean, false), coalesce((p->>'material_ok')::boolean, false),
      coalesce((p->>'finish_ok')::boolean, false), coalesce((p->>'quantity_ok')::boolean, false), nullif(btrim(coalesce(p->>'defects', '')), ''), v_result, v_uid);
    if v_result = 'FAILED' then
      update public.factory_job_cards set status = 'IN_PROGRESS', qc_status = 'FAILED', production_completed_at = null where id = p_job_id returning * into j;
      v_new := 'IN_PROGRESS';
      v_note := 'QC failed: ' || btrim(p->>'defects');
      perform public.fjc_notify(array[j.assigned_to], j.id, 'QC failed on Job Card ' || j.job_card_number || ': ' || btrim(p->>'defects') || ' — back to production',
        'જોબ કાર્ડ ' || j.job_card_number || ' QC નિષ્ફળ: ' || btrim(p->>'defects'));
    else
      update public.factory_job_cards set qc_status = 'PASSED' where id = p_job_id returning * into j;
      v_note := coalesce('QC passed — ' || nullif(btrim(coalesce(p->>'defects', '')), ''), 'QC passed');
      perform public.fjc_notify(array[j.assigned_to], j.id, 'QC passed on Job Card ' || j.job_card_number, 'જોબ કાર્ડ ' || j.job_card_number || ' QC પાસ');
    end if;

  when 'ready' then
    if not (v_lead or v_mine) then raise exception 'Only the Factory Head or the assigned employee can mark the Job Card ready for dispatch'; end if;
    if v_old <> 'QUALITY_CHECK' or j.qc_status is distinct from 'PASSED' then raise exception 'Quality Check must pass before the Job Card is ready for dispatch'; end if;
    update public.factory_job_cards set status = 'READY_FOR_DISPATCH', ready_at = now() where id = p_job_id returning * into j;
    v_new := 'READY_FOR_DISPATCH';
    perform public.fjc_notify(public.fjc_requester_side(j), j.id, 'Job Card ' || j.job_card_number || ' is ready for dispatch', 'જોબ કાર્ડ ' || j.job_card_number || ' ડિસ્પેચ માટે તૈયાર');

  when 'dispatch' then
    if not (v_lead or v_mine) then raise exception 'Only the Factory Head or the assigned employee can record dispatch'; end if;
    if v_old <> 'READY_FOR_DISPATCH' then raise exception 'Only a Job Card ready for dispatch can be dispatched'; end if;
    begin v_date := nullif(p->>'dispatch_date', '')::date; v_q := nullif(btrim(coalesce(p->>'quantity', '')), '')::numeric;
    exception when others then raise exception 'Dispatch date or quantity is not valid'; end;
    if v_date is null then raise exception 'Dispatch date is required'; end if;
    if v_q is null or v_q <= 0 then raise exception 'Quantity dispatched must be more than 0'; end if;
    if nullif(btrim(coalesce(p->>'delivery_reference', '')), '') is null then raise exception 'Delivery reference (challan / LR number) is required'; end if;
    select coalesce(sum(quantity), 0) into v_disp from public.factory_job_card_dispatches where job_card_id = p_job_id;
    select sum(quantity) into v_total from public.factory_job_card_items where job_card_id = p_job_id;
    if v_disp + v_q > v_total then raise exception 'Only % more can be dispatched', trim(to_char(v_total - v_disp, 'FM999999990.##')); end if;
    insert into public.factory_job_card_dispatches (job_card_id, dispatch_date, quantity, delivery_reference, transport_details, remarks, created_by)
    values (p_job_id, v_date, v_q, btrim(p->>'delivery_reference'), nullif(btrim(coalesce(p->>'transport_details', '')), ''), nullif(btrim(coalesce(p->>'remarks', '')), ''), v_uid);
    v_note := 'Dispatched ' || trim(to_char(v_q, 'FM999999990.##')) || ' on ' || to_char(v_date, 'DD-MM-YYYY') || ', ref ' || btrim(p->>'delivery_reference');
    if v_disp + v_q >= v_total then
      update public.factory_job_cards set status = 'DISPATCHED', dispatched_at = now() where id = p_job_id returning * into j;
      v_new := 'DISPATCHED';
      perform public.fjc_notify(public.fjc_requester_side(j), j.id, 'Job Card ' || j.job_card_number || ' dispatched (' || btrim(p->>'delivery_reference') || ') — confirm when received',
        'જોબ કાર્ડ ' || j.job_card_number || ' મોકલાયું — મળે ત્યારે પુષ્ટિ કરો');
    else
      perform public.fjc_notify(public.fjc_requester_side(j), j.id, 'Part of Job Card ' || j.job_card_number || ' dispatched: ' || v_note, 'જોબ કાર્ડ ' || j.job_card_number || ' આંશિક મોકલાયું');
    end if;

  when 'confirm_receipt' then
    if not (v_requester or coalesce(public.staff_has_global_oversight(), false)) then raise exception 'Only the requesting department confirms receipt'; end if;
    if v_old <> 'DISPATCHED' then raise exception 'Receipt can be confirmed once the Job Card is dispatched'; end if;
    update public.factory_job_cards set status = 'COMPLETED', received_by = v_uid, received_at = now(), receipt_remarks = nullif(btrim(coalesce(p->>'remarks', '')), '')
     where id = p_job_id returning * into j;
    v_new := 'COMPLETED';
    perform public.fjc_notify(public.fjc_factory_leads() || array[j.assigned_to], j.id, 'Job Card ' || j.job_card_number || ' received by ' ||
      (select name_en from public.departments where id = j.requesting_department_id) || ' — completed', 'જોબ કાર્ડ ' || j.job_card_number || ' મળ્યું — પૂર્ણ');

  when 'revise_date' then
    if not v_lead then raise exception 'Only the Factory Head can propose a revised completion date'; end if;
    if v_old in ('READY_FOR_DISPATCH', 'DISPATCHED', 'COMPLETED', 'CANCELLED') then raise exception 'Production is already finished'; end if;
    begin v_date := nullif(p->>'date', '')::date; exception when others then raise exception 'The date is not valid'; end;
    if v_date is null then raise exception 'Choose the revised completion date'; end if;
    if v_date < public.proc_today_ist() then raise exception 'The revised date cannot be in the past'; end if;
    if v_date = public.fjc_effective_due(j) then raise exception 'That is already the completion date'; end if;
    if nullif(btrim(coalesce(p->>'reason', '')), '') is null then raise exception 'Give the reason for the new date'; end if;
    update public.factory_job_cards set revised_due_date = v_date, revised_reason = btrim(p->>'reason') where id = p_job_id returning * into j;
    v_note := 'Revised completion date ' || to_char(v_date, 'DD-MM-YYYY') || ' (original due ' || to_char(j.due_date, 'DD-MM-YYYY') || '): ' || btrim(p->>'reason');
    perform public.fjc_notify(public.fjc_requester_side(j) || array[j.assigned_to], j.id,
      'Factory cannot meet ' || to_char(j.due_date, 'DD-MM-YYYY') || ' for Job Card ' || j.job_card_number || ': new date ' || to_char(v_date, 'DD-MM-YYYY') || ' — ' || btrim(p->>'reason'),
      'જોબ કાર્ડ ' || j.job_card_number || ' નવી તારીખ ' || to_char(v_date, 'DD-MM-YYYY'));

  when 'cancel' then
    if v_old in ('DISPATCHED', 'COMPLETED', 'CANCELLED') then raise exception 'This Job Card can no longer be cancelled'; end if;
    if not (v_lead or (j.requested_by = v_uid and v_old = 'NEW')) then
      raise exception 'Only the Factory Head can cancel a Job Card (the requester can cancel it while it is still new)';
    end if;
    if nullif(btrim(coalesce(p->>'reason', '')), '') is null then raise exception 'Give the reason for cancelling'; end if;
    update public.factory_job_cards set status = 'CANCELLED', cancelled_reason = btrim(p->>'reason') where id = p_job_id returning * into j;
    v_new := 'CANCELLED';
    perform public.fjc_notify(public.fjc_requester_side(j) || public.fjc_factory_leads() || array[j.assigned_to], j.id,
      'Job Card ' || j.job_card_number || ' cancelled: ' || btrim(p->>'reason'), 'જોબ કાર્ડ ' || j.job_card_number || ' રદ');

  else
    raise exception 'Unknown action';
  end case;

  update public.factory_job_cards set updated_at = now() where id = p_job_id returning * into j;
  perform public.fjc_log(p_job_id, upper(p_action), v_old, v_new, v_note, case when p_action in ('progress', 'qc', 'dispatch', 'revise_date', 'assign', 'accept') then p end);
  perform public.fjc_sync_task(p_job_id);
  return j;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Material shortage -> a normal Procurement order linked to the card
-- ---------------------------------------------------------------------------
-- p_items: [{material, specification, quantity, unit}]
create or replace function public.fjc_request_material(p_job_id uuid, p_items jsonb, p_required_date date, p_remarks text default null)
returns public.purchase_requests language plpgsql security definer set search_path to 'public' as $$
declare j public.factory_job_cards; r public.purchase_requests; v_items jsonb := '[]'; v_it jsonb;
begin
  perform public.staff_assert_operational();
  select * into j from public.factory_job_cards where id = p_job_id;
  if j.id is null or not public.fjc_can_view(p_job_id) then raise exception 'Job Card not found'; end if;
  if not (public.fjc_is_member() or public.fjc_is_lead()) then raise exception 'Only the Factory can request material for a Job Card'; end if;
  if j.status in ('READY_FOR_DISPATCH', 'DISPATCHED', 'COMPLETED', 'CANCELLED') then raise exception 'Production on this Job Card is finished'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Add at least one material'; end if;
  for v_it in select * from jsonb_array_elements(p_items) loop
    if btrim(coalesce(v_it->>'material', '')) = '' then raise exception 'Every line needs the material name'; end if;
    if btrim(coalesce(v_it->>'quantity', '')) = '' then raise exception 'Give the quantity of %', v_it->>'material'; end if;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'description', btrim(v_it->>'material') || coalesce(' — ' || nullif(btrim(coalesce(v_it->>'specification', '')), ''), ''),
      'qty_size', btrim(v_it->>'quantity') || coalesce(' ' || nullif(btrim(coalesce(v_it->>'unit', '')), ''), ''),
      'remarks', 'For Job Card ' || j.job_card_number));
  end loop;
  r := public.proc_create_order(jsonb_build_object('form_type', 'RETAIL', 'required_completion_date', p_required_date, 'delivery_location', 'Factory',
         'client_name', j.client_name, 'remarks', 'Material for Factory Job Card ' || j.job_card_number || coalesce('. ' || nullif(btrim(coalesce(p_remarks, '')), ''), '')),
       v_items, true);
  update public.purchase_requests set factory_job_card_id = j.id where id = r.id returning * into r;
  perform public.fjc_log(j.id, 'MATERIAL_REQUESTED', null, null, 'Procurement order ' || r.request_number || ' raised for missing material',
    jsonb_build_object('purchase_request_id', r.id, 'request_number', r.request_number, 'items', p_items));
  perform public.fjc_notify(public.fjc_factory_leads() || array[j.assigned_to], j.id,
    'Material unavailable for Job Card ' || j.job_card_number || ' — Procurement order ' || r.request_number || ' raised', 'સામગ્રી ઉપલબ્ધ નથી: ' || j.job_card_number);
  return r;
end $$;

-- Procurement progress on a linked order comes back to the card (history + the Factory is told).
create or replace function public.fjc_on_material_status()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare r public.purchase_requests; j public.factory_job_cards;
begin
  select * into r from public.purchase_requests where id = new.purchase_request_id;
  if r.factory_job_card_id is null or new.to_status is not distinct from new.from_status then return new; end if;
  select * into j from public.factory_job_cards where id = r.factory_job_card_id;
  if j.id is null then return new; end if;
  insert into public.factory_job_card_events (job_card_id, action, note, payload, actor_id)
  values (j.id, 'MATERIAL_STATUS', 'Procurement order ' || r.request_number || ': ' || coalesce(public.proc_status_label(new.to_status), new.to_status),
          jsonb_build_object('purchase_request_id', r.id, 'status', new.to_status), new.actor_id);
  if new.to_status in ('ORDER_PLACED', 'DELIVERED', 'RECEIVED', 'GRN_VERIFIED', 'CLOSED', 'CANCELLED', 'REJECTED_BY_PROCUREMENT', 'REJECTED_BY_DEPT_HEAD') then
    perform public.fjc_notify(public.fjc_factory_leads() || array[j.assigned_to], j.id,
      'Material for Job Card ' || j.job_card_number || ' (' || r.request_number || '): ' || coalesce(public.proc_status_label(new.to_status), new.to_status),
      'જોબ કાર્ડ ' || j.job_card_number || ' સામગ્રી: ' || coalesce(public.proc_status_label(new.to_status), new.to_status));
  end if;
  return new;
end $$;
drop trigger if exists fjc_material_status on public.purchase_request_status_history;
create trigger fjc_material_status after insert on public.purchase_request_status_history for each row execute function public.fjc_on_material_status();

-- ---------------------------------------------------------------------------
-- 7. Reminders (every 30 minutes; each kind at most once a day per card)
-- ---------------------------------------------------------------------------
create or replace function public.fjc_remind_once(p_job public.factory_job_cards, p_kind text, p_users uuid[], p_en text, p_gu text)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  insert into public.factory_job_card_reminders (job_card_id, kind, sent_on) values (p_job.id, p_kind, public.proc_today_ist())
  on conflict do nothing;
  if found then perform public.fjc_notify(p_users, p_job.id, p_en, p_gu); end if;
end $$;

create or replace function public.fjc_run_reminders()
returns integer language plpgsql security definer set search_path to 'public' as $$
declare j public.factory_job_cards; v_today date := public.proc_today_ist(); v_due date; v_n int := 0; v_leads uuid[] := public.fjc_factory_leads();
begin
  for j in select * from public.factory_job_cards where status not in ('DISPATCHED', 'COMPLETED', 'CANCELLED') loop
    v_due := public.fjc_effective_due(j);
    if j.status = 'NEW' and j.created_at < now() - interval '2 hours' then
      perform public.fjc_remind_once(j, 'AWAITING_ACCEPTANCE', v_leads, 'Job Card ' || j.job_card_number || ' is waiting to be accepted and assigned',
        'જોબ કાર્ડ ' || j.job_card_number || ' સ્વીકાર બાકી'); v_n := v_n + 1;
    end if;
    if j.status = 'ACCEPTED' and j.accepted_at < now() - interval '1 day' then
      perform public.fjc_remind_once(j, 'NOT_STARTED', v_leads || array[j.assigned_to], 'Production not started on Job Card ' || j.job_card_number,
        'જોબ કાર્ડ ' || j.job_card_number || ' નું ઉત્પાદન શરૂ થયું નથી'); v_n := v_n + 1;
    end if;
    if j.status = 'QUALITY_CHECK' and j.qc_status is null and j.production_completed_at < now() - interval '1 day' then
      perform public.fjc_remind_once(j, 'QC_PENDING', v_leads, 'Quality Check pending on Job Card ' || j.job_card_number, 'જોબ કાર્ડ ' || j.job_card_number || ' QC બાકી');
      v_n := v_n + 1;
    end if;
    if j.status <> 'READY_FOR_DISPATCH' then
      if v_due < v_today then
        perform public.fjc_remind_once(j, 'OVERDUE', v_leads || array[j.assigned_to] || public.proc_department_heads(j.requesting_department_id),
          'Job Card ' || j.job_card_number || ' is overdue (due ' || to_char(v_due, 'DD-MM-YYYY') || ')', 'જોબ કાર્ડ ' || j.job_card_number || ' મોડું');
        v_n := v_n + 1;
      elsif v_due - v_today <= 2 then
        perform public.fjc_remind_once(j, 'DUE_SOON', v_leads || array[j.assigned_to],
          'Job Card ' || j.job_card_number || ' is due ' || case when v_due = v_today then 'today' else 'on ' || to_char(v_due, 'DD-MM-YYYY') end,
          'જોબ કાર્ડ ' || j.job_card_number || ' નિયત ' || to_char(v_due, 'DD-MM-YYYY')); v_n := v_n + 1;
      end if;
    end if;
  end loop;
  return v_n;
end $$;

do $do$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'factory-job-card-reminders';
    perform cron.schedule('factory-job-card-reminders', '*/30 * * * *', 'select public.fjc_run_reminders();');
  end if;
end $do$;

-- ---------------------------------------------------------------------------
-- 8. Security: read through RLS, write only through the functions above
-- ---------------------------------------------------------------------------
alter table public.factory_job_cards enable row level security;
alter table public.factory_job_card_items enable row level security;
alter table public.factory_job_card_files enable row level security;
alter table public.factory_job_card_events enable row level security;
alter table public.factory_job_card_qc enable row level security;
alter table public.factory_job_card_dispatches enable row level security;
alter table public.factory_job_card_reminders enable row level security;
alter table public.factory_job_card_counters enable row level security;

drop policy if exists factory_job_cards_select on public.factory_job_cards;
create policy factory_job_cards_select on public.factory_job_cards for select to authenticated using (public.fjc_can_view(id));
drop policy if exists factory_job_card_items_select on public.factory_job_card_items;
create policy factory_job_card_items_select on public.factory_job_card_items for select to authenticated using (public.fjc_can_view(job_card_id));
drop policy if exists factory_job_card_files_select on public.factory_job_card_files;
create policy factory_job_card_files_select on public.factory_job_card_files for select to authenticated using (public.fjc_can_view(job_card_id));
drop policy if exists factory_job_card_events_select on public.factory_job_card_events;
create policy factory_job_card_events_select on public.factory_job_card_events for select to authenticated using (public.fjc_can_view(job_card_id));
drop policy if exists factory_job_card_qc_select on public.factory_job_card_qc;
create policy factory_job_card_qc_select on public.factory_job_card_qc for select to authenticated using (public.fjc_can_view(job_card_id));
drop policy if exists factory_job_card_dispatches_select on public.factory_job_card_dispatches;
create policy factory_job_card_dispatches_select on public.factory_job_card_dispatches for select to authenticated using (public.fjc_can_view(job_card_id));

grant select on public.factory_job_cards, public.factory_job_card_items, public.factory_job_card_files, public.factory_job_card_events,
  public.factory_job_card_qc, public.factory_job_card_dispatches to authenticated;
revoke insert, update, delete on public.factory_job_cards, public.factory_job_card_items, public.factory_job_card_files, public.factory_job_card_events,
  public.factory_job_card_qc, public.factory_job_card_dispatches, public.factory_job_card_reminders, public.factory_job_card_counters from authenticated, anon;
revoke all on public.factory_job_card_reminders, public.factory_job_card_counters from authenticated, anon;

-- Storage: procurement-orders/factory-jobs/<job id>/<file>
drop policy if exists fjc_files_select on storage.objects;
create policy fjc_files_select on storage.objects for select to authenticated
  using (bucket_id = 'procurement-orders' and split_part(name, '/', 1) = 'factory-jobs' and public.fjc_can_view(public.proc_try_uuid(split_part(name, '/', 2))));
drop policy if exists fjc_files_insert on storage.objects;
create policy fjc_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'procurement-orders' and split_part(name, '/', 1) = 'factory-jobs' and public.fjc_can_view(public.proc_try_uuid(split_part(name, '/', 2))));

revoke all on function public.fjc_sync_task(uuid), public.fjc_log(uuid, text, text, text, text, jsonb), public.fjc_notify(uuid[], uuid, text, text),
  public.fjc_next_number(), public.fjc_run_reminders(), public.fjc_remind_once(public.factory_job_cards, text, uuid[], text, text),
  public.fjc_requester_side(public.factory_job_cards) from public, anon, authenticated;
revoke all on function public.fjc_create(jsonb, jsonb, text), public.fjc_add_file(uuid, text, text, text, text, text), public.fjc_action(uuid, text, jsonb),
  public.fjc_request_material(uuid, jsonb, date, text), public.fjc_can_view(uuid), public.fjc_is_member(uuid), public.fjc_is_lead(uuid),
  public.fjc_factory_leads(), public.fjc_factory_dept() from public, anon;
grant execute on function public.fjc_create(jsonb, jsonb, text), public.fjc_add_file(uuid, text, text, text, text, text), public.fjc_action(uuid, text, jsonb),
  public.fjc_request_material(uuid, jsonb, date, text), public.fjc_can_view(uuid), public.fjc_is_member(uuid), public.fjc_is_lead(uuid),
  public.fjc_factory_leads(), public.fjc_factory_dept() to authenticated;

-- The Factory team (for the assign list): active Factory employees, readable by anyone who can see a card.
create or replace function public.fjc_factory_team()
returns table (id uuid, full_name text, role_code text) language sql stable security definer set search_path to 'public' as $$
  select up.id, up.full_name, r.code from public.user_profiles up join public.roles r on r.id = up.role_id
   where up.is_active and up.department_id = public.fjc_factory_dept() order by r.code = 'dept_head' desc, r.code = 'supervisor' desc, up.full_name;
$$;
revoke all on function public.fjc_factory_team() from public, anon;
grant execute on function public.fjc_factory_team() to authenticated;

-- Tapping a Job Card notification (in the app or as a phone push) opens the card.
create or replace function public.notification_deep_link(p_type text, p_id uuid, p_task uuid default null)
returns text language sql immutable set search_path to 'public' as $$
  select coalesce(case p_type
    when 'task' then '/tasks?focus=' || p_id::text
    when 'task_message' then case when p_task is not null then '/chat?legacy_message=' || p_id::text || '&legacy_task=' || p_task::text else '/chat?legacy_message=' || p_id::text end
    when 'project' then '/interior-projects/detail/' || p_id::text
    when 'snag' then '/interior-projects/site-execution'
    when 'interior_task' then '/interior-projects/tasks'
    when 'site_report' then '/interior-projects/daily-updates'
    when 'retail_lead' then '/retail/leads'
    when 'retail_complaint' then '/retail/complaints'
    when 'retail_vm_task' then '/retail/display'
    when 'FACTORY_AI_REQUEST' then '/factory-requests'
    when 'FACTORY_JOB' then '/factory-job/' || p_id::text
    when 'FACTORY_JOB_CARD' then '/factory-job-cards/' || p_id::text
    when 'CHAT' then case when p_task is not null then '/chat?c=' || p_id::text || '&task=' || p_task::text else '/chat?c=' || p_id::text end
    when 'PURCHASE_REQUEST' then '/purchase-requests/' || p_id::text
    else null
  end, '/');
$$;

commit;
