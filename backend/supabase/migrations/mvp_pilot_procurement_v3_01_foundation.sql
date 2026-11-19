-- Central Procurement, part 1: foundation, permissions and the department -> Procurement -> order workflow.
--
-- Every company purchase now runs through purchase_requests.proc_status, changed only by the proc_* functions below.
-- Departments raise and track requests; their Department Head approves; only authorised Procurement users accept,
-- record the document and confirm the order. Direct writes to the purchase tables are revoked, so the rules hold
-- for API calls too, not just in the app.
--
-- Existing Interior rows keep their old `status` and get proc_status = 'LEGACY'; they never enter Procurement's queue.
-- In-house production (purchase_source in-house -> staff_submit_to_factory) is not a purchase and is unchanged.

begin;

-- ---------------------------------------------------------------------------
-- 1. Settings: primary Procurement Head and approval limits
-- ---------------------------------------------------------------------------

create table if not exists public.procurement_settings (
  id boolean primary key default true check (id),
  primary_head_user_id uuid references public.user_profiles(id),
  escalation_contact_user_id uuid references public.user_profiles(id),
  updated_by uuid references public.user_profiles(id),
  updated_at timestamptz not null default now()
);
insert into public.procurement_settings (id) values (true) on conflict (id) do nothing;

-- Orders up to the first limit are confirmed by Procurement alone; above it a Management approval of at least the order
-- amount must exist first. Defaults only -- Management can change them.
create table if not exists public.procurement_approval_limits (
  approver text primary key check (approver in ('PROCUREMENT_HEAD', 'MANAGEMENT')),
  max_amount numeric(14,2),           -- null = no upper limit
  updated_by uuid references public.user_profiles(id),
  updated_at timestamptz not null default now()
);
insert into public.procurement_approval_limits (approver, max_amount) values
  ('PROCUREMENT_HEAD', 25000), ('MANAGEMENT', null)
on conflict (approver) do nothing;

create table if not exists public.procurement_number_counters (
  kind text not null,
  period text not null,
  next_seq integer not null default 1,
  primary key (kind, period)
);

-- ---------------------------------------------------------------------------
-- 2. Company-wide requests on the existing purchase tables
-- ---------------------------------------------------------------------------

-- Non-Interior requests have no project and no Interior profile.
alter table public.purchase_requests alter column project_id drop not null;
alter table public.purchase_requests alter column created_by drop not null;
alter table public.purchase_requests alter column requested_by drop not null;
alter table public.purchase_request_items alter column project_id drop not null;
alter table public.purchase_orders alter column project_id drop not null;
alter table public.purchase_orders alter column created_by drop not null;
alter table public.purchase_approvals alter column project_id drop not null;
alter table public.purchase_approvals alter column submitted_by drop not null;
alter table public.purchase_receipts alter column project_id drop not null;

alter table public.purchase_requests
  add column if not exists requesting_department_id uuid references public.departments(id),
  add column if not exists requester_user_id uuid references public.user_profiles(id),
  add column if not exists proc_status text,
  add column if not exists procurement_category text,
  add column if not exists material_name text,
  add column if not exists material_category text,
  add column if not exists specifications text,
  add column if not exists quantity numeric(14,3),
  add column if not exists unit text,
  add column if not exists required_by_date date,
  add column if not exists delivery_location text,
  add column if not exists remarks text,
  add column if not exists is_emergency boolean not null default false,
  add column if not exists emergency_reason text,
  add column if not exists dept_decided_by uuid references public.user_profiles(id),
  add column if not exists dept_decided_at timestamptz,
  add column if not exists dept_decision_remarks text,
  add column if not exists sent_to_procurement_at timestamptz,
  add column if not exists proc_decided_by uuid references public.user_profiles(id),
  add column if not exists proc_decided_at timestamptz,
  add column if not exists proc_decision_remarks text,
  add column if not exists document_version integer not null default 0,
  add column if not exists document_generated_at timestamptz,
  add column if not exists order_confirmed_by uuid references public.user_profiles(id),
  add column if not exists order_confirmed_at timestamptz,
  add column if not exists dedupe_key text,
  add column if not exists proc_updated_at timestamptz,
  add column if not exists emergency_decided_by uuid references public.user_profiles(id),
  add column if not exists emergency_decided_at timestamptz,
  add column if not exists emergency_review_note text,
  add column if not exists emergency_reviewed_by uuid references public.user_profiles(id),
  add column if not exists emergency_reviewed_at timestamptz;

alter table public.purchase_requests drop constraint if exists purchase_requests_proc_status_check;
do $$ begin
  alter table public.purchase_requests add constraint purchase_requests_proc_status_check check (proc_status in (
    'LEGACY', 'DRAFT', 'PENDING_DEPT_APPROVAL', 'RETURNED_FOR_CORRECTION', 'REJECTED_BY_DEPT_HEAD', 'APPROVED_BY_DEPT_HEAD',
    'SENT_TO_PROCUREMENT', 'CLARIFICATION_REQUIRED', 'ON_HOLD', 'REJECTED_BY_PROCUREMENT', 'ACCEPTED_BY_PROCUREMENT',
    'EMERGENCY_APPROVAL_PENDING', 'EMERGENCY_REJECTED', 'DOCUMENT_GENERATED', 'ORDER_PLACED', 'VENDOR_CONFIRMED', 'IN_PRODUCTION',
    'READY_FOR_DISPATCH', 'IN_TRANSIT', 'DELAYED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'GRN_VERIFIED', 'INVOICE_VERIFIED',
    'PAYMENT_PENDING', 'PARTIALLY_PAID', 'PAID', 'CLOSED', 'CANCELLED'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.purchase_requests add constraint purchase_requests_procurement_category_check check (procurement_category in (
    'RAW_MATERIAL', 'FINISHED_GOODS', 'JOB_WORK', 'MATERIAL', 'LABOUR', 'TURNKEY', 'SERVICE', 'CONSUMABLES', 'MACHINERY', 'OTHER'));
exception when duplicate_object then null; end $$;

update public.purchase_requests
   set proc_status = 'LEGACY',
       requesting_department_id = coalesce(requesting_department_id, (select id from public.departments where code = 'INTERIOR'))
 where proc_status is null;

-- One open request per department + project + material + quantity + date. Closed, rejected and cancelled ones don't block.
create unique index if not exists purchase_requests_open_dedupe_idx on public.purchase_requests (dedupe_key)
  where dedupe_key is not null and proc_status not in ('LEGACY', 'REJECTED_BY_DEPT_HEAD', 'REJECTED_BY_PROCUREMENT', 'EMERGENCY_REJECTED', 'CANCELLED', 'CLOSED');
create index if not exists purchase_requests_proc_status_idx on public.purchase_requests (proc_status);
create index if not exists purchase_requests_requesting_dept_idx on public.purchase_requests (requesting_department_id);
create index if not exists purchase_requests_requester_idx on public.purchase_requests (requester_user_id);

alter table public.purchase_orders
  add column if not exists vendor_contact text,
  add column if not exists quotation_reference text,
  add column if not exists ordered_quantity numeric(14,3),
  add column if not exists remarks text,
  add column if not exists confirmed_by uuid references public.user_profiles(id),
  add column if not exists confirmed_at timestamptz;
create unique index if not exists purchase_orders_po_number_idx on public.purchase_orders (lower(po_number)) where po_number is not null;

alter table public.purchase_approvals
  add column if not exists requested_by_user uuid references public.user_profiles(id),
  add column if not exists decided_by_user uuid references public.user_profiles(id),
  add column if not exists requested_amount numeric(14,2);

create table if not exists public.purchase_request_status_history (
  id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid not null references public.purchase_requests(id),
  from_status text,
  to_status text not null,
  actor_id uuid references public.user_profiles(id),
  actor_role text,
  remarks text,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.purchase_request_status_history alter column created_at set default clock_timestamp();
create index if not exists purchase_request_status_history_req_idx on public.purchase_request_status_history (purchase_request_id, created_at);

-- Browsers can't confirm paper came out of a printer, so this records that the document was generated and printing was
-- started -- never that it physically printed.
create table if not exists public.purchase_print_logs (
  id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid not null references public.purchase_requests(id),
  purchase_order_id uuid references public.purchase_orders(id),
  document_type text not null check (document_type in ('PURCHASE_REQUEST', 'PURCHASE_ORDER')),
  document_version integer not null check (document_version > 0),
  action text not null check (action in ('PRINT_INITIATED', 'REPRINT')),
  printed_by uuid not null references public.user_profiles(id),
  printed_at timestamptz not null default clock_timestamp()
);
alter table public.purchase_print_logs alter column printed_at set default clock_timestamp();
create index if not exists purchase_print_logs_req_idx on public.purchase_print_logs (purchase_request_id, printed_at);

-- ---------------------------------------------------------------------------
-- 3. Who is who
-- ---------------------------------------------------------------------------

create or replace function public.proc_is_procurement_member()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.user_profiles up
                  where up.id = auth.uid() and up.is_active and up.department_id = public.factory_procurement_dept_id());
$$;

-- Accepting requests, recording documents and confirming orders: Procurement Department Heads and Supervisors.
create or replace function public.proc_is_procurement_authorized()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.proc_is_procurement_member() and public.staff_current_role_code() in ('dept_head', 'supervisor'), false);
$$;

-- Accounts / Finance: invoice verification and payments.
create or replace function public.proc_is_accounts()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.staff_current_role_code() in ('accounts_head', 'accounts_employee', 'cfo')
    or public.staff_current_department_id() = (select id from public.departments where code = 'ACCOUNTS'), false);
$$;

create or replace function public.proc_can_view_request(p_request_id uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.purchase_requests r
     where r.id = p_request_id
       and public.staff_current_user_ok()
       and (
         r.requester_user_id = auth.uid()
         or public.proc_is_procurement_member()
         or public.staff_has_global_oversight()
         or public.proc_is_accounts()
         or (public.staff_is_dept_head() and r.requesting_department_id is not null and public.staff_dept_in_hod_scope(r.requesting_department_id))
         or (r.project_id is not null and (public.interior_is_org_wide() or public.interior_is_project_member(r.project_id)))
         or (public.staff_is_godown_staff() and r.proc_status in ('ORDER_PLACED', 'VENDOR_CONFIRMED', 'IN_PRODUCTION', 'READY_FOR_DISPATCH',
               'IN_TRANSIT', 'DELAYED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'GRN_VERIFIED', 'INVOICE_VERIFIED', 'PAYMENT_PENDING', 'PARTIALLY_PAID', 'PAID', 'CLOSED'))
       ));
$$;

-- Primary Procurement Head from settings, else the longest-serving active Procurement Department Head.
create or replace function public.proc_procurement_contact()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_user public.user_profiles%rowtype; v_source text := 'primary';
begin
  if not public.staff_current_user_ok() then return null; end if;
  select up.* into v_user from public.procurement_settings s join public.user_profiles up on up.id = s.primary_head_user_id
   where up.is_active and up.department_id = public.factory_procurement_dept_id();
  if v_user.id is null then
    v_source := 'department_head';
    select up.* into v_user from public.user_profiles up join public.roles r on r.id = up.role_id
     where up.is_active and up.department_id = public.factory_procurement_dept_id() and r.code = 'dept_head'
     order by up.created_at limit 1;
  end if;
  if v_user.id is null then
    return jsonb_build_object('user_id', null, 'name', null, 'phone', null, 'phone_missing', true, 'source', 'none');
  end if;
  return jsonb_build_object('user_id', v_user.id, 'name', v_user.full_name, 'phone', nullif(btrim(coalesce(v_user.phone, '')), ''),
    'phone_missing', nullif(btrim(coalesce(v_user.phone, '')), '') is null, 'source', v_source);
end $$;

create or replace function public.proc_set_primary_head(p_user_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.staff_assert_operational();
  if not coalesce(public.staff_has_global_oversight(), false) then raise exception 'Only Management can set the primary Procurement Head'; end if;
  if p_user_id is not null and not exists (
    select 1 from public.user_profiles up join public.roles r on r.id = up.role_id
     where up.id = p_user_id and up.is_active and up.department_id = public.factory_procurement_dept_id()
       and r.code in ('dept_head', 'supervisor')) then
    raise exception 'The primary Procurement Head must be an active Procurement Department Head or Supervisor';
  end if;
  update public.procurement_settings set primary_head_user_id = p_user_id, updated_by = auth.uid(), updated_at = now() where id;
  perform public.staff_write_audit('procurement_settings', null, 'SET_PRIMARY_HEAD', null, jsonb_build_object('user_id', p_user_id), public.factory_procurement_dept_id());
end $$;

create or replace function public.proc_set_approval_limit(p_approver text, p_max_amount numeric)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_old numeric;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.staff_has_global_oversight(), false) then raise exception 'Only Management can change approval limits'; end if;
  if p_max_amount is not null and p_max_amount <= 0 then raise exception 'The limit must be more than zero'; end if;
  select max_amount into v_old from public.procurement_approval_limits where approver = p_approver for update;
  if not found then raise exception 'Unknown approver level %', p_approver; end if;
  update public.procurement_approval_limits set max_amount = p_max_amount, updated_by = auth.uid(), updated_at = now() where approver = p_approver;
  perform public.staff_write_audit('procurement_approval_limit', null, 'SET_LIMIT', jsonb_build_object('approver', p_approver, 'max_amount', v_old),
    jsonb_build_object('approver', p_approver, 'max_amount', p_max_amount), public.factory_procurement_dept_id());
end $$;

-- ---------------------------------------------------------------------------
-- 4. Internal helpers (not callable by users)
-- ---------------------------------------------------------------------------

create or replace function public.proc_next_number(p_kind text)
returns text language plpgsql security definer set search_path to 'public' as $$
declare v_period text := to_char(now() at time zone 'Asia/Kolkata', 'YYYYMM'); v_seq integer; v_number text;
begin
  loop
    insert into public.procurement_number_counters as c (kind, period, next_seq) values (p_kind, v_period, 2)
    on conflict (kind, period) do update set next_seq = c.next_seq + 1
    returning next_seq - 1 into v_seq;
    v_number := p_kind || '-' || v_period || '-' || lpad(v_seq::text, 4, '0');
    exit when p_kind <> 'PR' or not exists (select 1 from public.purchase_requests where request_number = v_number);
  end loop;
  return v_number;
end $$;

create or replace function public.proc_set_status(p_request_id uuid, p_from text, p_to text, p_remarks text)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update public.purchase_requests set proc_status = p_to, proc_updated_at = now() where id = p_request_id;
  insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
  values (p_request_id, p_from, p_to, auth.uid(), public.staff_current_role_code(), nullif(btrim(coalesce(p_remarks, '')), ''));
  perform public.staff_write_audit('purchase_request', p_request_id, 'STATUS_' || p_to, jsonb_build_object('proc_status', p_from),
    jsonb_build_object('proc_status', p_to), (select requesting_department_id from public.purchase_requests where id = p_request_id), p_remarks);
end $$;

create or replace function public.proc_notify_users(p_user_ids uuid[], p_request_id uuid, p_title_en text, p_title_gu text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid;
begin
  foreach v_id in array coalesce(p_user_ids, '{}') loop
    perform public.staff_notify_assignment(v_id, 'PURCHASE_REQUEST', p_request_id, p_title_en, p_title_gu);
  end loop;
end $$;

create or replace function public.proc_department_heads(p_department_id uuid)
returns uuid[] language sql stable security definer set search_path to 'public' as $$
  select coalesce(array_agg(up.id), '{}') from public.user_profiles up join public.roles r on r.id = up.role_id
   where up.is_active and up.department_id = p_department_id and r.code = 'dept_head';
$$;

create or replace function public.proc_procurement_team()
returns uuid[] language sql stable security definer set search_path to 'public' as $$
  select coalesce(array_agg(up.id), '{}') from public.user_profiles up
   where up.is_active and up.department_id = public.factory_procurement_dept_id();
$$;

-- The project's manager is an Interior `profiles` row; notifications go to that person's staff account.
create or replace function public.proc_project_manager_user(p_project_id uuid)
returns uuid language sql stable security definer set search_path to 'public' as $$
  select up.id from public.projects p join public.profiles pr on pr.id = p.project_manager_id
    join public.user_profiles up on up.id = pr.auth_id and up.is_active
   where p.id = p_project_id;
$$;

-- Who hears about a newly submitted request: its department's Heads, plus Management for an emergency.
create or replace function public.proc_management_users()
returns uuid[] language sql stable security definer set search_path to 'public' as $$
  select coalesce(array_agg(up.id), '{}') from public.user_profiles up join public.roles r on r.id = up.role_id
   where up.is_active and public.staff_role_family(r.code) = 'management';
$$;

create or replace function public.proc_notify_submitted(p_row public.purchase_requests)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if p_row.proc_status = 'EMERGENCY_APPROVAL_PENDING' then
    perform public.proc_notify_users(public.proc_management_users() || public.proc_department_heads(p_row.requesting_department_id), p_row.id,
      'EMERGENCY purchase ' || p_row.request_number || ' needs Management approval: ' || p_row.material_name || ' - ' || coalesce(p_row.emergency_reason, ''),
      'તાત્કાલિક ખરીદી ' || p_row.request_number || ' માટે મેનેજમેન્ટ મંજૂરી જરૂરી');
  elsif p_row.proc_status = 'PENDING_DEPT_APPROVAL' then
    perform public.proc_notify_users(public.proc_department_heads(p_row.requesting_department_id), p_row.id,
      'Purchase request ' || p_row.request_number || ' needs your approval: ' || p_row.material_name,
      'ખરીદી વિનંતી ' || p_row.request_number || ' માટે તમારી મંજૂરી જરૂરી છે: ' || p_row.material_name);
  end if;
end $$;

create or replace function public.proc_dedupe_key(p_dept uuid, p_project uuid, p_material text, p_qty numeric, p_unit text, p_required date)
returns text language sql immutable set search_path to 'public' as $$
  select md5(concat_ws('|', p_dept, p_project, lower(btrim(p_material)), p_qty, lower(btrim(coalesce(p_unit, ''))), p_required));
$$;

create or replace function public.proc_validate_request(p_material text, p_category text, p_qty numeric, p_unit text, p_required date,
  p_priority text, p_delivery text, p_emergency boolean, p_emergency_reason text)
returns void language plpgsql immutable set search_path to 'public' as $$
begin
  if btrim(coalesce(p_material, '')) = '' then raise exception 'Material name is required'; end if;
  if btrim(coalesce(p_category, '')) = '' then raise exception 'Material category is required'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be more than zero'; end if;
  if btrim(coalesce(p_unit, '')) = '' then raise exception 'Unit is required'; end if;
  if p_required is null then raise exception 'Required-by date is required'; end if;
  if coalesce(p_priority, '') not in ('LOW', 'NORMAL', 'HIGH', 'URGENT') then raise exception 'Priority must be LOW, NORMAL, HIGH or URGENT'; end if;
  if btrim(coalesce(p_delivery, '')) = '' then raise exception 'Delivery location is required'; end if;
  if coalesce(p_emergency, false) and btrim(coalesce(p_emergency_reason, '')) = '' then raise exception 'An emergency request needs a reason'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Workflow
-- ---------------------------------------------------------------------------

create or replace function public.proc_create_request(
  p_project_id uuid, p_material_name text, p_material_category text, p_specifications text, p_quantity numeric, p_unit text,
  p_required_by_date date, p_priority text, p_remarks text, p_delivery_location text, p_procurement_category text,
  p_is_emergency boolean default false, p_emergency_reason text default null, p_submit boolean default true)
returns public.purchase_requests language plpgsql security definer set search_path to 'public' as $$
declare v_dept uuid := public.staff_current_department_id(); v_key text; v_dup text; v_row public.purchase_requests; v_status text;
begin
  perform public.staff_assert_operational();
  if v_dept is null then raise exception 'Your profile has no department, so a request cannot be raised'; end if;
  perform public.proc_validate_request(p_material_name, p_material_category, p_quantity, p_unit, p_required_by_date, p_priority,
    p_delivery_location, p_is_emergency, p_emergency_reason);
  if p_required_by_date < (now() at time zone 'Asia/Kolkata')::date then raise exception 'Required-by date cannot be in the past'; end if;
  if p_project_id is not null and not (public.interior_is_org_wide() or public.interior_is_project_member(p_project_id)) then
    raise exception 'You are not a member of this project';
  end if;

  v_key := public.proc_dedupe_key(v_dept, p_project_id, p_material_name, p_quantity, p_unit, p_required_by_date);
  select request_number into v_dup from public.purchase_requests where dedupe_key = v_key
     and proc_status not in ('LEGACY', 'REJECTED_BY_DEPT_HEAD', 'REJECTED_BY_PROCUREMENT', 'EMERGENCY_REJECTED', 'CANCELLED', 'CLOSED') limit 1;
  if v_dup is not null then raise exception 'The same request is already open as %', v_dup; end if;

  -- An emergency purchase skips the department queue but not approval: Management decides it (proc_emergency_decision).
  v_status := case when not coalesce(p_submit, true) then 'DRAFT' when coalesce(p_is_emergency, false) then 'EMERGENCY_APPROVAL_PENDING' else 'PENDING_DEPT_APPROVAL' end;
  insert into public.purchase_requests (project_id, request_number, purchase_source, priority, purpose, notes, requested_by, created_by,
    request_date, status, requesting_department_id, requester_user_id, proc_status, procurement_category, material_name, material_category,
    specifications, quantity, unit, required_by_date, delivery_location, remarks, is_emergency, emergency_reason, dedupe_key, proc_updated_at)
  values (p_project_id, public.proc_next_number('PR'), 'Procurement', p_priority, btrim(p_material_name), p_remarks,
    public.interior_current_profile_id(), public.interior_current_profile_id(), (now() at time zone 'Asia/Kolkata')::date, 'Procurement',
    v_dept, auth.uid(), v_status, coalesce(p_procurement_category, 'MATERIAL'), btrim(p_material_name), btrim(p_material_category),
    p_specifications, p_quantity, btrim(p_unit), p_required_by_date, btrim(p_delivery_location), p_remarks, coalesce(p_is_emergency, false),
    p_emergency_reason, v_key, now())
  returning * into v_row;

  insert into public.purchase_request_items (project_id, purchase_request_id, item_name, category, description, quantity, unit,
    required_at_location, required_by_date, status)
  values (p_project_id, v_row.id, v_row.material_name, v_row.material_category, p_specifications, p_quantity, v_row.unit,
    v_row.delivery_location, p_required_by_date, 'Requested');

  insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
  values (v_row.id, null, v_status, auth.uid(), public.staff_current_role_code(), null);
  perform public.staff_write_audit('purchase_request', v_row.id, 'CREATE', null, to_jsonb(v_row), v_dept, null);

  perform public.proc_notify_submitted(v_row);
  return v_row;
end $$;

-- The requester edits a draft or a request returned for correction.
create or replace function public.proc_update_request(
  p_request_id uuid, p_material_name text, p_material_category text, p_specifications text, p_quantity numeric, p_unit text,
  p_required_by_date date, p_priority text, p_remarks text, p_delivery_location text, p_procurement_category text,
  p_is_emergency boolean default false, p_emergency_reason text default null)
returns public.purchase_requests language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_key text; v_dup text;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found'; end if;
  if v_row.requester_user_id is distinct from auth.uid() then raise exception 'Only the person who raised this request can edit it'; end if;
  if v_row.proc_status not in ('DRAFT', 'RETURNED_FOR_CORRECTION') then raise exception 'Only a draft or a returned request can be edited'; end if;
  perform public.proc_validate_request(p_material_name, p_material_category, p_quantity, p_unit, p_required_by_date, p_priority,
    p_delivery_location, p_is_emergency, p_emergency_reason);

  v_key := public.proc_dedupe_key(v_row.requesting_department_id, v_row.project_id, p_material_name, p_quantity, p_unit, p_required_by_date);
  select request_number into v_dup from public.purchase_requests where dedupe_key = v_key and id <> p_request_id
     and proc_status not in ('LEGACY', 'REJECTED_BY_DEPT_HEAD', 'REJECTED_BY_PROCUREMENT', 'EMERGENCY_REJECTED', 'CANCELLED', 'CLOSED') limit 1;
  if v_dup is not null then raise exception 'The same request is already open as %', v_dup; end if;

  update public.purchase_requests set material_name = btrim(p_material_name), purpose = btrim(p_material_name),
    material_category = btrim(p_material_category), specifications = p_specifications, quantity = p_quantity, unit = btrim(p_unit),
    required_by_date = p_required_by_date, priority = p_priority, remarks = p_remarks, notes = p_remarks,
    delivery_location = btrim(p_delivery_location), procurement_category = coalesce(p_procurement_category, procurement_category),
    is_emergency = coalesce(p_is_emergency, false), emergency_reason = p_emergency_reason, dedupe_key = v_key, proc_updated_at = now()
   where id = p_request_id returning * into v_row;
  update public.purchase_request_items set item_name = v_row.material_name, category = v_row.material_category, description = p_specifications,
    quantity = p_quantity, unit = v_row.unit, required_at_location = v_row.delivery_location, required_by_date = p_required_by_date
   where purchase_request_id = p_request_id;
  perform public.staff_write_audit('purchase_request', p_request_id, 'UPDATE', null, to_jsonb(v_row), v_row.requesting_department_id, null);
  return v_row;
end $$;

create or replace function public.proc_submit_request(p_request_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests;
begin
  perform public.staff_assert_operational();
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found'; end if;
  if v_row.requester_user_id is distinct from auth.uid() then raise exception 'Only the person who raised this request can submit it'; end if;
  if v_row.proc_status not in ('DRAFT', 'RETURNED_FOR_CORRECTION') then raise exception 'This request has already been submitted'; end if;
  perform public.proc_set_status(p_request_id, v_row.proc_status, case when v_row.is_emergency then 'EMERGENCY_APPROVAL_PENDING' else 'PENDING_DEPT_APPROVAL' end, null);
  select * into v_row from public.purchase_requests where id = p_request_id;
  perform public.proc_notify_submitted(v_row);
end $$;

-- Department Head: APPROVE (goes straight on to Procurement), REJECT or RETURN for correction. Nobody approves their own request.
create or replace function public.proc_dept_decision(p_request_id uuid, p_decision text, p_remarks text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_remarks text := nullif(btrim(coalesce(p_remarks, '')), '');
begin
  perform public.staff_assert_operational();
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found'; end if;
  if v_row.proc_status <> 'PENDING_DEPT_APPROVAL' then raise exception 'This request is not waiting for department approval'; end if;
  if not coalesce((public.staff_is_dept_head() and public.staff_dept_in_hod_scope(v_row.requesting_department_id)) or public.staff_has_global_oversight(), false) then
    raise exception 'Only the requesting department''s Head can decide this request';
  end if;
  if v_row.requester_user_id = auth.uid() then raise exception 'You cannot approve your own request'; end if;
  if p_decision in ('REJECT', 'RETURN') and v_remarks is null then raise exception 'A reason is required'; end if;

  update public.purchase_requests set dept_decided_by = auth.uid(), dept_decided_at = now(), dept_decision_remarks = v_remarks where id = p_request_id;
  if p_decision = 'APPROVE' then
    perform public.proc_set_status(p_request_id, 'PENDING_DEPT_APPROVAL', 'APPROVED_BY_DEPT_HEAD', v_remarks);
    perform public.proc_set_status(p_request_id, 'APPROVED_BY_DEPT_HEAD', 'SENT_TO_PROCUREMENT', null);
    update public.purchase_requests set sent_to_procurement_at = now() where id = p_request_id;
    perform public.proc_notify_users(public.proc_procurement_team(), p_request_id,
      'New purchase request ' || v_row.request_number || ': ' || v_row.material_name || ' (' || v_row.quantity || ' ' || v_row.unit || ')',
      'નવી ખરીદી વિનંતી ' || v_row.request_number || ': ' || v_row.material_name);
    perform public.proc_notify_users(array[v_row.requester_user_id], p_request_id,
      'Your request ' || v_row.request_number || ' was approved and sent to Procurement',
      'તમારી વિનંતી ' || v_row.request_number || ' મંજૂર થઈ અને ખરીદી વિભાગને મોકલાઈ');
  elsif p_decision = 'REJECT' then
    perform public.proc_set_status(p_request_id, 'PENDING_DEPT_APPROVAL', 'REJECTED_BY_DEPT_HEAD', v_remarks);
    perform public.proc_notify_users(array[v_row.requester_user_id], p_request_id,
      'Your request ' || v_row.request_number || ' was rejected: ' || v_remarks, 'તમારી વિનંતી ' || v_row.request_number || ' નામંજૂર: ' || v_remarks);
  elsif p_decision = 'RETURN' then
    perform public.proc_set_status(p_request_id, 'PENDING_DEPT_APPROVAL', 'RETURNED_FOR_CORRECTION', v_remarks);
    perform public.proc_notify_users(array[v_row.requester_user_id], p_request_id,
      'Your request ' || v_row.request_number || ' needs correction: ' || v_remarks, 'તમારી વિનંતી ' || v_row.request_number || ' સુધારો જરૂરી: ' || v_remarks);
  else
    raise exception 'Decision must be APPROVE, REJECT or RETURN';
  end if;
end $$;

-- Procurement: ACCEPT, REJECT, CLARIFY (ask the requester), HOLD or RESUME.
create or replace function public.proc_procurement_decision(p_request_id uuid, p_decision text, p_remarks text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_remarks text := nullif(btrim(coalesce(p_remarks, '')), ''); v_to text;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_authorized(), false) then raise exception 'Only an authorised Procurement user can do this'; end if;
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found'; end if;
  if p_decision in ('REJECT', 'CLARIFY', 'HOLD') and v_remarks is null then raise exception 'A reason is required'; end if;

  if p_decision = 'RESUME' then
    if v_row.proc_status <> 'ON_HOLD' then raise exception 'Only a request on hold can be resumed'; end if;
    v_to := 'SENT_TO_PROCUREMENT';
  else
    if v_row.proc_status <> 'SENT_TO_PROCUREMENT' then raise exception 'This request is not waiting for Procurement'; end if;
    v_to := case p_decision when 'ACCEPT' then 'ACCEPTED_BY_PROCUREMENT' when 'REJECT' then 'REJECTED_BY_PROCUREMENT'
                            when 'CLARIFY' then 'CLARIFICATION_REQUIRED' when 'HOLD' then 'ON_HOLD' end;
    if v_to is null then raise exception 'Decision must be ACCEPT, REJECT, CLARIFY, HOLD or RESUME'; end if;
  end if;

  update public.purchase_requests set proc_decided_by = auth.uid(), proc_decided_at = now(), proc_decision_remarks = v_remarks where id = p_request_id;
  perform public.proc_set_status(p_request_id, v_row.proc_status, v_to, v_remarks);
  perform public.proc_notify_users(array[v_row.requester_user_id], p_request_id,
    case v_to when 'ACCEPTED_BY_PROCUREMENT' then 'Procurement accepted your request ' || v_row.request_number
              when 'REJECTED_BY_PROCUREMENT' then 'Procurement rejected your request ' || v_row.request_number || ': ' || v_remarks
              when 'CLARIFICATION_REQUIRED' then 'Procurement needs clarification on ' || v_row.request_number || ': ' || v_remarks
              when 'ON_HOLD' then 'Your request ' || v_row.request_number || ' is on hold: ' || v_remarks
              else 'Your request ' || v_row.request_number || ' is back with Procurement' end,
    'ખરીદી વિનંતી ' || v_row.request_number || ' અપડેટ');
  if v_to = 'REJECTED_BY_PROCUREMENT' then
    perform public.proc_notify_users(public.proc_department_heads(v_row.requesting_department_id), p_request_id,
      'Procurement rejected request ' || v_row.request_number || ': ' || v_remarks, 'ખરીદી વિભાગે વિનંતી ' || v_row.request_number || ' નામંજૂર કરી');
  end if;
end $$;

create or replace function public.proc_answer_clarification(p_request_id uuid, p_answer text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_answer text := nullif(btrim(coalesce(p_answer, '')), '');
begin
  perform public.staff_assert_operational();
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found'; end if;
  if v_row.requester_user_id is distinct from auth.uid() then raise exception 'Only the person who raised this request can answer'; end if;
  if v_row.proc_status <> 'CLARIFICATION_REQUIRED' then raise exception 'No clarification was asked for'; end if;
  if v_answer is null then raise exception 'Please write the clarification'; end if;
  perform public.proc_set_status(p_request_id, 'CLARIFICATION_REQUIRED', 'SENT_TO_PROCUREMENT', v_answer);
  perform public.proc_notify_users(case when v_row.proc_decided_by is not null then array[v_row.proc_decided_by] else public.proc_procurement_team() end,
    p_request_id, 'Clarification received for ' || v_row.request_number || ': ' || v_answer, 'સ્પષ્ટતા મળી: ' || v_row.request_number);
end $$;

create or replace function public.proc_cancel_request(p_request_id uuid, p_reason text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.staff_assert_operational();
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found'; end if;
  if v_reason is null then raise exception 'A reason is required'; end if;
  if v_row.proc_status in ('DRAFT', 'PENDING_DEPT_APPROVAL', 'RETURNED_FOR_CORRECTION', 'CLARIFICATION_REQUIRED') and v_row.requester_user_id = auth.uid() then
    null;
  elsif v_row.proc_status in ('SENT_TO_PROCUREMENT', 'ON_HOLD', 'ACCEPTED_BY_PROCUREMENT', 'DOCUMENT_GENERATED', 'CLARIFICATION_REQUIRED')
        and (public.proc_is_procurement_authorized() or public.staff_has_global_oversight()) then
    null;
  else
    raise exception 'This request cannot be cancelled by you at this stage';
  end if;
  perform public.proc_set_status(p_request_id, v_row.proc_status, 'CANCELLED', v_reason);
  perform public.proc_notify_users(array[v_row.requester_user_id] || public.proc_department_heads(v_row.requesting_department_id), p_request_id,
    'Request ' || v_row.request_number || ' was cancelled: ' || v_reason, 'વિનંતી ' || v_row.request_number || ' રદ: ' || v_reason);
end $$;

-- Recorded when the printable document is generated and the print dialog is opened. The first print of the request document
-- moves an accepted request to DOCUMENT_GENERATED, which is what unlocks order confirmation.
create or replace function public.proc_record_print(p_request_id uuid, p_document_type text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_po public.purchase_orders; v_version integer; v_action text;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_authorized(), false) then raise exception 'Only an authorised Procurement user can print purchase documents'; end if;
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found'; end if;

  if p_document_type = 'PURCHASE_REQUEST' then
    if v_row.proc_status in ('LEGACY', 'DRAFT', 'PENDING_DEPT_APPROVAL', 'RETURNED_FOR_CORRECTION', 'REJECTED_BY_DEPT_HEAD', 'APPROVED_BY_DEPT_HEAD',
                             'SENT_TO_PROCUREMENT', 'CLARIFICATION_REQUIRED', 'ON_HOLD', 'REJECTED_BY_PROCUREMENT', 'CANCELLED') then
      raise exception 'The document can be printed only after Procurement accepts the request';
    end if;
    v_action := case when v_row.document_version = 0 then 'PRINT_INITIATED' else 'REPRINT' end;
    v_version := greatest(v_row.document_version, 1);
    if v_row.document_version = 0 then
      update public.purchase_requests set document_version = 1, document_generated_at = now() where id = p_request_id;
    end if;
    insert into public.purchase_print_logs (purchase_request_id, document_type, document_version, action, printed_by)
    values (p_request_id, 'PURCHASE_REQUEST', v_version, v_action, auth.uid());
    if v_row.proc_status = 'ACCEPTED_BY_PROCUREMENT' then
      perform public.proc_set_status(p_request_id, 'ACCEPTED_BY_PROCUREMENT', 'DOCUMENT_GENERATED', null);
    end if;
  elsif p_document_type = 'PURCHASE_ORDER' then
    select * into v_po from public.purchase_orders where purchase_request_id = p_request_id and is_current;
    if v_po.id is null then raise exception 'No purchase order has been confirmed for this request yet'; end if;
    v_version := v_po.version_number;
    v_action := case when exists (select 1 from public.purchase_print_logs where purchase_order_id = v_po.id) then 'REPRINT' else 'PRINT_INITIATED' end;
    insert into public.purchase_print_logs (purchase_request_id, purchase_order_id, document_type, document_version, action, printed_by)
    values (p_request_id, v_po.id, 'PURCHASE_ORDER', v_version, v_action, auth.uid());
  else
    raise exception 'Unknown document type %', p_document_type;
  end if;
  perform public.staff_write_audit('purchase_document', p_request_id, v_action,
    null, jsonb_build_object('document_type', p_document_type, 'document_version', v_version), v_row.requesting_department_id, null);
  return jsonb_build_object('document_version', v_version, 'action', v_action);
end $$;

-- Procurement asks Management to approve an order amount above Procurement's own limit.
create or replace function public.proc_request_amount_approval(p_request_id uuid, p_amount numeric, p_remarks text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_mgmt uuid[];
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_authorized(), false) then raise exception 'Only an authorised Procurement user can ask for approval'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  select * into v_row from public.purchase_requests where id = p_request_id;
  if v_row.proc_status not in ('ACCEPTED_BY_PROCUREMENT', 'DOCUMENT_GENERATED') then raise exception 'Approval can be asked only for an accepted request'; end if;
  if exists (select 1 from public.purchase_approvals where purchase_request_id = p_request_id and approval_level = 'MANAGEMENT' and decision is null) then
    raise exception 'An approval is already pending for this request';
  end if;
  insert into public.purchase_approvals (project_id, purchase_request_id, approval_level, submitted_date, remarks, requested_by_user, requested_amount)
  values (v_row.project_id, p_request_id, 'MANAGEMENT', (now() at time zone 'Asia/Kolkata')::date, p_remarks, auth.uid(), p_amount);
  v_mgmt := public.proc_management_users();
  perform public.proc_notify_users(v_mgmt, p_request_id,
    'Approval needed: ' || v_row.request_number || ' order of Rs ' || p_amount, 'મંજૂરી જરૂરી: ' || v_row.request_number);
  perform public.staff_write_audit('purchase_request', p_request_id, 'AMOUNT_APPROVAL_REQUESTED', null, jsonb_build_object('amount', p_amount), v_row.requesting_department_id, p_remarks);
end $$;

create or replace function public.proc_decide_amount_approval(p_request_id uuid, p_decision text, p_remarks text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_appr public.purchase_approvals; v_row public.purchase_requests;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.staff_is_management(), false) then raise exception 'Only Management can approve purchase amounts'; end if;
  if p_decision not in ('APPROVED', 'REJECTED') then raise exception 'Decision must be APPROVED or REJECTED'; end if;
  if p_decision = 'REJECTED' and nullif(btrim(coalesce(p_remarks, '')), '') is null then raise exception 'A reason is required'; end if;
  select * into v_appr from public.purchase_approvals where purchase_request_id = p_request_id and approval_level = 'MANAGEMENT' and decision is null for update;
  if v_appr.id is null then raise exception 'No approval is pending for this request'; end if;
  update public.purchase_approvals set decision = p_decision, decided_by_user = auth.uid(), decision_date = (now() at time zone 'Asia/Kolkata')::date,
    approved_amount = case when p_decision = 'APPROVED' then v_appr.requested_amount end, remarks = coalesce(p_remarks, remarks)
   where id = v_appr.id;
  select * into v_row from public.purchase_requests where id = p_request_id;
  perform public.proc_notify_users(array[v_appr.requested_by_user], p_request_id,
    'Management ' || lower(p_decision) || ' the order amount for ' || v_row.request_number, 'મેનેજમેન્ટ નિર્ણય: ' || v_row.request_number);
  perform public.staff_write_audit('purchase_request', p_request_id, 'AMOUNT_' || p_decision, null,
    jsonb_build_object('amount', v_appr.requested_amount), v_row.requesting_department_id, p_remarks);
end $$;

drop function if exists public.proc_confirm_order(uuid, text, text, text, text, date, numeric, numeric, date, text, text);
create or replace function public.proc_confirm_order(
  p_request_id uuid, p_vendor_name text, p_vendor_contact text, p_quotation_reference text, p_po_number text, p_order_date date,
  p_ordered_quantity numeric, p_amount numeric, p_expected_delivery_date date, p_payment_terms text, p_remarks text,
  p_scope_of_work text default null)
returns public.purchase_orders language plpgsql security definer set search_path to 'public' as $$
declare
  v_row public.purchase_requests; v_po public.purchase_orders; v_vendor uuid; v_phone text; v_limit numeric; v_contact jsonb;
  v_recipients uuid[]; v_msg text;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_authorized(), false) then raise exception 'Only an authorised Procurement user can confirm an order'; end if;
  select * into v_row from public.purchase_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found'; end if;
  if v_row.proc_status = 'ORDER_PLACED' or exists (select 1 from public.purchase_orders where purchase_request_id = p_request_id and is_current) then
    raise exception 'The order for this request has already been confirmed';
  end if;
  if v_row.proc_status <> 'DOCUMENT_GENERATED'
     or not exists (select 1 from public.purchase_print_logs where purchase_request_id = p_request_id and document_type = 'PURCHASE_REQUEST') then
    raise exception 'Print the purchase document before confirming the order';
  end if;

  v_phone := regexp_replace(coalesce(p_vendor_contact, ''), '[^0-9+]', '', 'g');
  if btrim(coalesce(p_vendor_name, '')) = '' then raise exception 'Vendor name is required'; end if;
  if length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 10 and 13 then raise exception 'Vendor contact must be a valid phone number'; end if;
  if btrim(coalesce(p_quotation_reference, '')) = '' then raise exception 'Vendor quotation reference is required'; end if;
  if btrim(coalesce(p_po_number, '')) = '' then raise exception 'Purchase order number is required'; end if;
  if p_order_date is null then raise exception 'Order date is required'; end if;
  if p_ordered_quantity is null or p_ordered_quantity <= 0 then raise exception 'Ordered quantity must be more than zero'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Final purchase amount must be more than zero'; end if;
  if p_expected_delivery_date is null then raise exception 'Expected delivery date is required'; end if;
  if p_expected_delivery_date < p_order_date then raise exception 'Expected delivery cannot be before the order date'; end if;
  if btrim(coalesce(p_payment_terms, '')) = '' then raise exception 'Payment terms are required'; end if;
  if btrim(coalesce(p_remarks, '')) = '' then raise exception 'Procurement remarks are required'; end if;
  -- Labour, turnkey, job work and services are work orders: what is to be done must be written down.
  if v_row.procurement_category in ('LABOUR', 'TURNKEY', 'JOB_WORK', 'SERVICE') and btrim(coalesce(p_scope_of_work, '')) = '' then
    raise exception 'Scope of work is required for a work order';
  end if;
  if exists (select 1 from public.purchase_orders where lower(po_number) = lower(btrim(p_po_number))) then
    raise exception 'Purchase order number % is already used', btrim(p_po_number);
  end if;

  select max_amount into v_limit from public.procurement_approval_limits where approver = 'PROCUREMENT_HEAD';
  if v_limit is not null and p_amount > v_limit and not exists (
       select 1 from public.purchase_approvals where purchase_request_id = p_request_id and approval_level = 'MANAGEMENT'
          and decision = 'APPROVED' and approved_amount >= p_amount) then
    raise exception 'Orders above Rs % need Management approval first', v_limit;
  end if;

  select id into v_vendor from public.vendors
   where lower(btrim(name)) = lower(btrim(p_vendor_name)) and right(regexp_replace(coalesce(mobile, ''), '[^0-9]', '', 'g'), 10) = right(regexp_replace(v_phone, '[^0-9]', '', 'g'), 10)
   limit 1;
  if v_vendor is null then
    insert into public.vendors (vendor_code, name, mobile, approved_status, notes)
    values (public.proc_next_number('V'), btrim(p_vendor_name), v_phone, 'Pending Review', 'Added at order confirmation for ' || v_row.request_number)
    returning id into v_vendor;
  elsif exists (select 1 from public.vendors where id = v_vendor and coalesce(blacklisted, false)) then
    raise exception 'This vendor is blocked';
  end if;

  insert into public.purchase_orders (project_id, purchase_request_id, vendor_id, order_type, po_number, version_number, is_current, order_date,
    total_order_value, delivery_location, expected_delivery_date, payment_terms, status, created_by, vendor_contact, quotation_reference,
    ordered_quantity, remarks, confirmed_by, confirmed_at, approved_by, scope_of_work)
  values (v_row.project_id, p_request_id, v_vendor,
    case when v_row.procurement_category in ('LABOUR', 'TURNKEY', 'JOB_WORK', 'SERVICE') then 'WORK_ORDER' else 'PURCHASE_ORDER' end, btrim(p_po_number), 1, true, p_order_date, p_amount, v_row.delivery_location,
    p_expected_delivery_date, btrim(p_payment_terms), 'ORDER_PLACED', public.interior_current_profile_id(), v_phone, btrim(p_quotation_reference),
    p_ordered_quantity, btrim(p_remarks), auth.uid(), now(), public.interior_current_profile_id(), nullif(btrim(coalesce(p_scope_of_work, '')), ''))
  returning * into v_po;

  update public.purchase_requests set order_confirmed_by = auth.uid(), order_confirmed_at = now() where id = p_request_id;
  perform public.proc_set_status(p_request_id, 'DOCUMENT_GENERATED', 'ORDER_PLACED', p_remarks);

  v_contact := public.proc_procurement_contact();
  v_msg := 'Order placed for ' || v_row.request_number
    || coalesce(' (' || (select project_code from public.projects where id = v_row.project_id) || ')', '')
    || ': ' || v_row.material_name || ', ' || p_ordered_quantity || ' ' || v_row.unit
    || '. Vendor ' || btrim(p_vendor_name) || ', PO ' || btrim(p_po_number) || ', ordered ' || to_char(p_order_date, 'DD Mon YYYY')
    || ', expected ' || to_char(p_expected_delivery_date, 'DD Mon YYYY') || '. Procurement Head: '
    || coalesce(v_contact->>'name', 'not set') || coalesce(' (' || (v_contact->>'phone') || ')', ' (phone not set)')
    || '. Your purchase request has been successfully processed and the order has been placed. You can coordinate directly with the Procurement Head for further updates.';
  v_recipients := public.proc_department_heads(v_row.requesting_department_id) || array[v_row.requester_user_id] || public.proc_procurement_team();
  if v_row.project_id is not null then v_recipients := v_recipients || public.proc_project_manager_user(v_row.project_id); end if;
  select coalesce(array_agg(distinct x), '{}') into v_recipients from unnest(v_recipients) x where x is not null;
  perform public.proc_notify_users(v_recipients, p_request_id, v_msg,
    'ઓર્ડર મૂકાયો: ' || v_row.request_number || ', ' || v_row.material_name || ', PO ' || btrim(p_po_number));
  perform public.staff_write_audit('purchase_order', v_po.id, 'ORDER_PLACED', null, to_jsonb(v_po), v_row.requesting_department_id, p_remarks);
  return v_po;
end $$;

-- Names and project details for requests the caller may see. A Procurement user can't read another department's people or
-- an Interior project directly, but needs them on the request and its printed document.
create or replace function public.proc_request_context(p_request_ids uuid[])
returns table (request_id uuid, department_code text, department_name text, requester_name text, requester_phone text,
  dept_approver_name text, procurement_decider_name text, order_confirmed_by_name text, project_code text, customer text, project_location text)
language sql stable security definer set search_path to 'public' as $$
  select r.id, d.code, d.name_en, rq.full_name, rq.phone, da.full_name, pd.full_name, oc.full_name, p.project_code, p.customer, p.location
    from public.purchase_requests r
    left join public.departments d on d.id = r.requesting_department_id
    left join public.user_profiles rq on rq.id = r.requester_user_id
    left join public.user_profiles da on da.id = r.dept_decided_by
    left join public.user_profiles pd on pd.id = r.proc_decided_by
    left join public.user_profiles oc on oc.id = r.order_confirmed_by
    left join public.projects p on p.id = r.project_id
   where r.id = any(p_request_ids) and public.proc_can_view_request(r.id);
$$;

-- ---------------------------------------------------------------------------
-- 6. Lock the purchase tables: read through policies, write only through the functions above
-- ---------------------------------------------------------------------------

-- Orders, approvals, quotations, vendor selection, receipts, payments and follow-ups: read-only to every user. Only the
-- security-definer proc_* functions write them.
do $$
declare v_tbl text; v_pol record;
begin
  foreach v_tbl in array array['purchase_orders', 'purchase_approvals', 'purchase_receipts', 'purchase_vendor_selections', 'vendor_quotations',
                               'purchase_payment_coordination', 'vendor_followups'] loop
    for v_pol in select policyname from pg_policies where schemaname = 'public' and tablename = v_tbl loop
      execute format('drop policy %I on public.%I', v_pol.policyname, v_tbl);
    end loop;
    execute format('revoke insert, update, delete on public.%I from authenticated, anon', v_tbl);
    execute format('create policy %I on public.%I for select to authenticated using (public.proc_can_view_request(purchase_request_id))', v_tbl || '_select', v_tbl);
  end loop;
end $$;

-- purchase_requests / purchase_request_items also carry Interior's own pre-Procurement records, including in-house production
-- sent to the Factory, which is not a purchase. Those LEGACY rows stay writable by the project's members exactly as before;
-- Procurement rows (any other proc_status) are written only by the proc_* functions.
drop policy if exists purchase_requests_scoped on public.purchase_requests;
drop policy if exists purchase_requests_select on public.purchase_requests;
drop policy if exists purchase_requests_legacy_write on public.purchase_requests;
create policy purchase_requests_select on public.purchase_requests for select to authenticated using (public.proc_can_view_request(id));
create policy purchase_requests_legacy_write on public.purchase_requests for all to authenticated
  using (proc_status = 'LEGACY' and project_id is not null and (public.interior_is_org_wide() or public.interior_is_project_member(project_id)))
  with check (proc_status = 'LEGACY' and project_id is not null and (public.interior_is_org_wide() or public.interior_is_project_member(project_id)));

do $$
declare v_pol record;
begin
  for v_pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'purchase_request_items' loop
    execute format('drop policy %I on public.purchase_request_items', v_pol.policyname);
  end loop;
end $$;
drop policy if exists purchase_request_items_select on public.purchase_request_items;
create policy purchase_request_items_select on public.purchase_request_items for select to authenticated
  using (public.proc_can_view_request(purchase_request_id));
drop policy if exists purchase_request_items_legacy_write on public.purchase_request_items;
create policy purchase_request_items_legacy_write on public.purchase_request_items for all to authenticated
  using (exists (select 1 from public.purchase_requests r where r.id = purchase_request_id and r.proc_status = 'LEGACY')
         and (public.interior_is_org_wide() or public.interior_is_project_member(project_id)))
  with check (exists (select 1 from public.purchase_requests r where r.id = purchase_request_id and r.proc_status = 'LEGACY')
              and (public.interior_is_org_wide() or public.interior_is_project_member(project_id)));

-- A direct (API) write can never create a Procurement request or touch a Procurement field: a new row is always LEGACY,
-- and on update every Procurement column keeps its value. The proc_* functions run as their owner, not as `authenticated`,
-- so this guard does not apply to them.
create or replace function public.proc_guard_direct_write()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'INSERT' then
    new.proc_status := 'LEGACY';
    new.requesting_department_id := (select id from public.departments where code = 'INTERIOR');
    new.requester_user_id := null; new.dedupe_key := null; new.document_version := 0; new.document_generated_at := null;
    new.dept_decided_by := null; new.dept_decided_at := null; new.proc_decided_by := null; new.proc_decided_at := null;
    new.sent_to_procurement_at := null; new.order_confirmed_by := null; new.order_confirmed_at := null;
    return new;
  end if;
  if (new.proc_status, new.requesting_department_id, new.requester_user_id, new.dedupe_key, new.document_version, new.document_generated_at,
      new.dept_decided_by, new.dept_decided_at, new.proc_decided_by, new.proc_decided_at, new.sent_to_procurement_at, new.order_confirmed_by,
      new.order_confirmed_at, new.material_name, new.quantity, new.unit, new.required_by_date, new.is_emergency)
     is distinct from
     (old.proc_status, old.requesting_department_id, old.requester_user_id, old.dedupe_key, old.document_version, old.document_generated_at,
      old.dept_decided_by, old.dept_decided_at, old.proc_decided_by, old.proc_decided_at, old.sent_to_procurement_at, old.order_confirmed_by,
      old.order_confirmed_at, old.material_name, old.quantity, old.unit, old.required_by_date, old.is_emergency) then
    raise exception 'Procurement fields can only be changed through the Procurement workflow';
  end if;
  return new;
end $$;
drop trigger if exists purchase_requests_proc_guard on public.purchase_requests;
create trigger purchase_requests_proc_guard before insert or update on public.purchase_requests
  for each row execute function public.proc_guard_direct_write();

alter table public.purchase_request_status_history enable row level security;
alter table public.purchase_print_logs enable row level security;
alter table public.procurement_settings enable row level security;
alter table public.procurement_approval_limits enable row level security;
alter table public.procurement_number_counters enable row level security;
revoke all on public.purchase_request_status_history, public.purchase_print_logs, public.procurement_settings,
  public.procurement_approval_limits, public.procurement_number_counters from anon, authenticated;
grant select on public.purchase_request_status_history, public.purchase_print_logs, public.procurement_approval_limits to authenticated;
drop policy if exists purchase_request_status_history_select on public.purchase_request_status_history;
create policy purchase_request_status_history_select on public.purchase_request_status_history for select to authenticated
  using (public.proc_can_view_request(purchase_request_id));
drop policy if exists purchase_print_logs_select on public.purchase_print_logs;
create policy purchase_print_logs_select on public.purchase_print_logs for select to authenticated
  using (public.proc_can_view_request(purchase_request_id));
drop policy if exists procurement_approval_limits_select on public.procurement_approval_limits;
create policy procurement_approval_limits_select on public.procurement_approval_limits for select to authenticated
  using (public.staff_current_user_ok());

-- Vendors: everyone may read the directory; only Procurement and Management maintain it. Bank details: Procurement Head,
-- Accounts Head and Management only.
drop policy if exists vendors_manage on public.vendors;
create policy vendors_manage on public.vendors for all to authenticated
  using (public.proc_is_procurement_authorized() or public.staff_has_global_oversight())
  with check (public.proc_is_procurement_authorized() or public.staff_has_global_oversight());
drop policy if exists vendor_bank_details_scoped on public.vendor_bank_details;
create policy vendor_bank_details_scoped on public.vendor_bank_details for all to authenticated
  using ((public.proc_is_procurement_member() and public.staff_is_dept_head()) or public.staff_is_accounts_head() or public.staff_has_global_oversight())
  with check ((public.proc_is_procurement_member() and public.staff_is_dept_head()) or public.staff_is_accounts_head() or public.staff_has_global_oversight());

-- Procurement and the requesting department's Head can see a request's attachments, not only the project's members.
drop policy if exists purchase_attachments_procurement_select on public.purchase_attachments;
create policy purchase_attachments_procurement_select on public.purchase_attachments for select to authenticated
  using (purchase_request_id is not null and public.proc_can_view_request(purchase_request_id));

-- Supporting files uploaded with an Interior request live under projects/<project>/purchase-management/<request>/... in the
-- interior-attachments bucket; Procurement and the approving Head must be able to open them.
create or replace function public.proc_try_uuid(p text)
returns uuid language plpgsql immutable set search_path to 'public' as $$
begin return p::uuid; exception when others then return null; end $$;

drop policy if exists proc_purchase_files_select on storage.objects;
create policy proc_purchase_files_select on storage.objects for select to authenticated
  using (bucket_id = 'interior-attachments' and split_part(name, '/', 3) = 'purchase-management'
         and public.proc_can_view_request(public.proc_try_uuid(split_part(name, '/', 4))));

-- ---------------------------------------------------------------------------
-- 7. Grants, notification links, realtime
-- ---------------------------------------------------------------------------

revoke all on function public.proc_next_number(text), public.proc_set_status(uuid, text, text, text),
  public.proc_notify_users(uuid[], uuid, text, text), public.proc_department_heads(uuid), public.proc_procurement_team(),
  public.proc_project_manager_user(uuid), public.proc_management_users(), public.proc_notify_submitted(public.purchase_requests) from public, anon, authenticated;
revoke all on function public.proc_is_procurement_member(), public.proc_is_procurement_authorized(), public.proc_can_view_request(uuid),
  public.proc_procurement_contact(), public.proc_set_primary_head(uuid), public.proc_set_approval_limit(text, numeric),
  public.proc_create_request(uuid, text, text, text, numeric, text, date, text, text, text, text, boolean, text, boolean),
  public.proc_update_request(uuid, text, text, text, numeric, text, date, text, text, text, text, boolean, text),
  public.proc_submit_request(uuid), public.proc_dept_decision(uuid, text, text), public.proc_procurement_decision(uuid, text, text),
  public.proc_answer_clarification(uuid, text), public.proc_cancel_request(uuid, text), public.proc_record_print(uuid, text),
  public.proc_request_amount_approval(uuid, numeric, text), public.proc_decide_amount_approval(uuid, text, text),
  public.proc_confirm_order(uuid, text, text, text, text, date, numeric, numeric, date, text, text, text) from public, anon;
revoke all on function public.proc_request_context(uuid[]), public.proc_is_accounts() from public, anon;
grant execute on function public.proc_is_accounts() to authenticated;
grant execute on function public.proc_request_context(uuid[]) to authenticated;
grant execute on function public.proc_is_procurement_member(), public.proc_is_procurement_authorized(), public.proc_can_view_request(uuid),
  public.proc_procurement_contact(), public.proc_set_primary_head(uuid), public.proc_set_approval_limit(text, numeric),
  public.proc_create_request(uuid, text, text, text, numeric, text, date, text, text, text, text, boolean, text, boolean),
  public.proc_update_request(uuid, text, text, text, numeric, text, date, text, text, text, text, boolean, text),
  public.proc_submit_request(uuid), public.proc_dept_decision(uuid, text, text), public.proc_procurement_decision(uuid, text, text),
  public.proc_answer_clarification(uuid, text), public.proc_cancel_request(uuid, text), public.proc_record_print(uuid, text),
  public.proc_request_amount_approval(uuid, numeric, text), public.proc_decide_amount_approval(uuid, text, text),
  public.proc_confirm_order(uuid, text, text, text, text, date, numeric, numeric, date, text, text, text) to authenticated;

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
    when 'CHAT' then case when p_task is not null then '/chat?c=' || p_id::text || '&task=' || p_task::text else '/chat?c=' || p_id::text end
    when 'PURCHASE_REQUEST' then '/purchase-requests/' || p_id::text
    else null
  end, '/');
$$;

do $$
declare v_tbl text;
begin
  foreach v_tbl in array array['purchase_requests', 'purchase_orders', 'purchase_request_status_history'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_tbl) then
      execute format('alter publication supabase_realtime add table public.%I', v_tbl);
    end if;
  end loop;
end $$;

commit;
