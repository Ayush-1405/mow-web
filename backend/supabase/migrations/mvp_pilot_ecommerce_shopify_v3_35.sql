-- v3_35 E-commerce department + Shopify (read-only) integration.
--
-- 1. Access: departments.managing_department_id -- a department may be run by the members of another department. E-commerce is run
--    by Marketing: every active Marketing member can open E-commerce (can_view_department, mirrored in frontend lib/access.js) and
--    be assigned E-commerce tasks (staff_create_task), without losing Marketing. Membership is the person's own department, so a
--    move in/out of Marketing changes access at once. Management keeps its existing oversight. Nobody else gets in.
-- 2. Shopify mirror tables (ecom_*): products, variants, locations, inventory levels, orders, lines, fulfilments/tracking, refunds,
--    an append-only stock movement history, stock alerts, sync runs and webhook receipts. Shopify is the source of truth: the app
--    only COPIES Shopify's quantities, it never deducts or adds stock itself, so stock can never be deducted twice. A movement row
--    is written only when a synchronised quantity actually changes (a repeated webhook / sync with the same value writes nothing),
--    and is labelled ORDER / CANCEL_RESTOCK / RETURN_RESTOCK only when a matching Shopify order or refund-with-restock explains it;
--    otherwise it is ADJUSTMENT_SYNCED. The first sync writes a BASELINE; no history before it is invented.
-- 3. Credentials: only in Supabase Vault (vault.secrets), written by Management through ecom_save_connection(), read only by the
--    shopify-sync server function (service_role) through ecom_get_credentials(). Never returned to a browser.
-- 4. Products to Add: a light listing checklist (optionally linked to the existing retail_products master), assignable to Marketing
--    / E-commerce members, auto-marked Listed when a Shopify variant with the same SKU appears.
-- 5. A reconcile job every 30 minutes (pg_cron + pg_net -> shopify-sync) recovers missed webhooks; it does nothing until Shopify is
--    connected.
-- Additive only: new column, new tables, new functions, two existing functions extended (logic otherwise unchanged).

-- =============================================================================================================== 1. access
alter table public.departments add column if not exists managing_department_id uuid references public.departments(id);
comment on column public.departments.managing_department_id is
  'Members of this department may also open and be assigned work in this department (E-commerce is run by Marketing).';
update public.departments e set managing_department_id = m.id
  from public.departments m where e.code = 'ECOMMERCE' and m.code = 'MARKETING' and e.managing_department_id is distinct from m.id;

create or replace function public.ecom_dept_id() returns uuid language sql stable security definer set search_path to 'public' as $$
  select id from public.departments where code = 'ECOMMERCE' limit 1 $$;

-- Who may open E-commerce data: exactly who may open the E-commerce department.
create or replace function public.ecom_can_access() returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(auth.uid() is not null and public.can_view_department(auth.uid(), public.ecom_dept_id()), false) $$;

-- Who may change the Shopify connection: Management only.
create or replace function public.ecom_can_configure() returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(auth.uid() is not null and public.staff_current_user_ok() and public.staff_has_global_oversight(), false) $$;

-- Who may change stock thresholds: Management, or a Department Head who can open E-commerce.
create or replace function public.ecom_can_set_thresholds() returns boolean language sql stable security definer set search_path to 'public' as $$
  select public.ecom_can_configure() or (public.ecom_can_access() and coalesce(public.staff_is_dept_head(), false)) $$;

-- People who work E-commerce (assignees for Products to Add, recipients of stock alerts): active members of E-commerce or of the
-- department that runs it.
create or replace function public.ecom_team_ids() returns uuid[] language sql stable security definer set search_path to 'public' as $$
  select coalesce(array_agg(up.id), '{}') from public.user_profiles up
   where up.is_active and coalesce(up.is_deleted, false) = false
     and up.department_id in (select id from public.departments where code = 'ECOMMERCE'
                              union select managing_department_id from public.departments where code = 'ECOMMERCE') $$;

-- can_view_department + staff_create_task: exact live definitions with the managing-department rule added (marked v3_35).
CREATE OR REPLACE FUNCTION public.can_view_department(p_user uuid, p_department uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_user is not distinct from auth.uid() and public.staff_current_user_ok() and exists (
    select 1 from public.departments d
     where d.id = p_department and d.is_active
       and case
             when public.staff_has_global_oversight() then (not d.is_confidential_domain or public.staff_has_capability('can_view_restricted_finance'))
             when d.is_control_tower then false
             when d.is_confidential_domain then public.staff_has_capability('can_view_restricted_finance') and d.id = public.staff_current_department_id()
             else (public.staff_dept_in_hod_scope(d.id) and (public.staff_is_dept_head() or d.id = public.staff_current_department_id()))
                  or coalesce(d.managing_department_id = public.staff_current_department_id(), false)   -- v3_35: run by another department (E-commerce by Marketing)
           end);
$function$;

CREATE OR REPLACE FUNCTION public.staff_create_task(p_title text, p_description text, p_task_type_code text, p_priority_code text, p_proof_type_code text, p_from_department_id uuid, p_to_department_id uuid, p_assigned_to uuid, p_due_date date, p_due_time time without time zone DEFAULT NULL::time without time zone, p_verifier_id uuid DEFAULT NULL::uuid, p_reference_number text DEFAULT NULL::text, p_requirement_text text DEFAULT NULL::text, p_quantity text DEFAULT NULL::text, p_second_assignee uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(task_id uuid, task_number text, bridge_id uuid, bridge_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller uuid := auth.uid();
  v_caller_role text;
  v_caller_department uuid;
  v_task_type_id uuid; v_priority_id uuid; v_proof_type_id uuid; v_status_id uuid;
  v_task_id uuid; v_task_number text; v_bridge_id uuid; v_bridge_number text;
  v_is_bridge boolean;
  v_from_confidential boolean; v_to_confidential boolean;
  v_verifier uuid; v_verifier_role text; v_verifier_department uuid;
  v_assignee_department uuid;
  v_second_department uuid;
  v_interior_dept_id uuid;
  v_project_code text; v_project_customer text; v_project_location text; v_project_archived boolean;
  v_title_en text; v_title_gu text;
begin
  perform public.staff_assert_operational();
  v_caller_role := public.staff_current_role_code();
  v_caller_department := public.staff_current_department_id();

  if not exists (select 1 from public.departments where id = p_from_department_id and is_active = true) then
    raise exception 'Invalid from_department';
  end if;
  if not exists (select 1 from public.departments where id = p_to_department_id and is_active = true) then
    raise exception 'Invalid to_department';
  end if;
  select is_confidential_domain into v_from_confidential from public.departments where id = p_from_department_id;
  select is_confidential_domain into v_to_confidential from public.departments where id = p_to_department_id;
  v_is_bridge := (p_from_department_id <> p_to_department_id);

  if v_is_bridge then
    if v_from_confidential or v_to_confidential then
      raise exception 'Cross-department Bridges into/out of a confidential department are disabled in this pilot';
    end if;
  else
    if v_from_confidential and v_caller_role not in ('management', 'sysadmin', 'cfo', 'accounts_head', 'accounts_employee') then
      raise exception 'Only Accounts roles or Management may create tasks within a confidential department';
    end if;
  end if;

  if v_caller_role in ('employee', 'supervisor') then
    if p_from_department_id <> v_caller_department then
      raise exception 'You may only create tasks from your own department';
    end if;
  elsif v_caller_role = 'dept_head' then
    if not public.staff_dept_in_hod_scope(p_from_department_id) then
      raise exception 'from_department is outside your authorized scope';
    end if;
  elsif v_caller_role in ('management', 'sysadmin') then
    null;
  elsif v_caller_role in ('cfo', 'accounts_head', 'accounts_employee') then
    if p_from_department_id <> v_caller_department then
      raise exception 'Accounts roles may only create tasks within their own Accounts department';
    end if;
  else
    raise exception 'Your role is not authorized to create tasks in this pilot';
  end if;

  select id into v_interior_dept_id from public.departments where code = 'INTERIOR';

  if p_project_id is not null then
    select project_code, customer, location, archived into v_project_code, v_project_customer, v_project_location, v_project_archived
      from public.projects where id = p_project_id;
    if v_project_code is null then
      raise exception 'Invalid Project/Site';
    end if;
    if v_project_archived then
      raise exception 'This Project/Site is archived and cannot receive new tasks. / આ પ્રોજેક્ટ/સાઇટ આર્કાઇવ કરેલ છે અને નવા કાર્યો સ્વીકારી શકાતી નથી.';
    end if;
  end if;

  select department_id into v_assignee_department from public.user_profiles where id = p_assigned_to and is_active = true;
  if v_assignee_department is null then
    raise exception 'Invalid or inactive assignee';
  end if;
  if v_assignee_department is distinct from p_to_department_id and v_assignee_department is distinct from (select managing_department_id from public.departments where id = p_to_department_id) then  -- v3_35
    raise exception 'assigned_to must belong to the selected destination department';
  end if;

  if p_second_assignee is not null then
    if p_second_assignee = p_assigned_to then
      raise exception 'Primary and Second Assignee must be different people. / મુખ્ય અને બીજી જવાબદાર વ્યક્તિ અલગ હોવી જોઈએ.';
    end if;
    select department_id into v_second_department from public.user_profiles where id = p_second_assignee and is_active = true;
    if v_second_department is null then
      raise exception 'Invalid or inactive second assignee';
    end if;
    if v_second_department is distinct from p_to_department_id and v_second_department is distinct from (select managing_department_id from public.departments where id = p_to_department_id) then  -- v3_35
      raise exception 'second assignee must belong to the selected destination department';
    end if;
  end if;

  v_verifier := coalesce(p_verifier_id, v_caller);
  v_verifier_role := public.staff_user_role_code(v_verifier);
  if v_verifier_role is null then
    raise exception 'Invalid or inactive verifier';
  end if;

  if v_verifier <> v_caller then
    if v_caller_role in ('management', 'sysadmin', 'dept_head') then
      null;
    elsif v_caller_role in ('employee', 'supervisor')
          and v_verifier_role = 'dept_head'
          and public.staff_user_dept_in_hod_scope(v_verifier, v_caller_department) then
      null;
    else
      raise exception 'You may only set yourself or your own Department Head as verifier';
    end if;
  end if;

  select department_id into v_verifier_department from public.user_profiles where id = v_verifier;
  if not (
    v_verifier = v_caller
    or v_verifier_role in ('management', 'sysadmin')
    or v_verifier_department = p_to_department_id
    or (v_verifier_role = 'dept_head' and public.staff_user_dept_in_hod_scope(v_verifier, p_to_department_id))
    or (v_verifier_role = 'dept_head' and public.staff_user_dept_in_hod_scope(v_verifier, v_caller_department))
  ) then
    raise exception 'verifier_id is not authorized for the destination department';
  end if;

  select id into v_task_type_id from public.task_types where code = p_task_type_code and is_active = true;
  if v_task_type_id is null then raise exception 'Invalid task_type_code'; end if;
  select id into v_priority_id from public.priority_master where code = p_priority_code and is_active = true;
  if v_priority_id is null then raise exception 'Invalid priority_code'; end if;
  select id into v_proof_type_id from public.proof_types where code = p_proof_type_code and is_active = true;
  if v_proof_type_id is null then raise exception 'Invalid proof_type_code'; end if;
  select id into v_status_id from public.status_master where code = 'ASSIGNED';

  insert into public.staff_tasks as inserted_task (
    title, description, task_type_id, priority_id, status_id, proof_type_id,
    from_department_id, to_department_id, assigned_by, assigned_to, verifier_id,
    current_owner_id, reference_number, requirement_text, quantity, due_date, due_time,
    project_id, source_module
  ) values (
    p_title, p_description, v_task_type_id, v_priority_id, v_status_id, v_proof_type_id,
    p_from_department_id, p_to_department_id, v_caller, p_assigned_to, v_verifier,
    p_assigned_to, p_reference_number, p_requirement_text, p_quantity, p_due_date, p_due_time,
    p_project_id, case when p_project_id is not null then 'assign_task' else null end
  ) returning inserted_task.id, inserted_task.task_number, inserted_task.is_bridge into v_task_id, v_task_number, v_is_bridge;

  if v_is_bridge then
    insert into public.bridges as inserted_bridge (task_id, from_department_id, to_department_id, from_person_id, to_person_id, requirement_text, quantity)
    values (v_task_id, p_from_department_id, p_to_department_id, v_caller, p_assigned_to, coalesce(p_requirement_text, p_title), p_quantity)
    returning inserted_bridge.id, inserted_bridge.bridge_number into v_bridge_id, v_bridge_number;
  end if;

  insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by)
  values (v_task_id, p_assigned_to, 'primary', v_caller);

  if p_second_assignee is not null then
    insert into public.staff_task_assignees (task_id, user_id, assignment_role, assigned_by)
    values (v_task_id, p_second_assignee, 'secondary', v_caller);
  end if;

  perform public.staff_write_audit('task', v_task_id, 'CREATE', null,
    jsonb_build_object('task_number', v_task_number, 'is_bridge', v_is_bridge, 'assigned_to', p_assigned_to, 'second_assignee', p_second_assignee, 'project_id', p_project_id, 'from_department_id', p_from_department_id, 'to_department_id', p_to_department_id), p_to_department_id);

  if p_to_department_id = v_interior_dept_id then
    if p_project_id is not null then
      v_title_en := 'New task assigned: ' || p_title || ' — ' || v_project_code || ' / ' || v_project_customer;
      v_title_gu := 'નવું કામ સોંપાયું: ' || p_title || ' — ' || v_project_code || ' / ' || v_project_customer;
    else
      v_title_en := 'New general Interior task assigned: ' || p_title;
      v_title_gu := 'નવું સામાન્ય ઇન્ટિરિયર કાર્ય સોંપાયું: ' || p_title;
    end if;
  else
    v_title_en := case when p_second_assignee is not null then 'You have been assigned a new task as Primary Assignee: ' || p_title else 'New task assigned: ' || v_task_number end;
    v_title_gu := case when p_second_assignee is not null then 'તમને મુખ્ય જવાબદાર તરીકે નવું કામ સોંપવામાં આવ્યું છે: ' || p_title else 'નવું કામ સોંપાયું: ' || v_task_number end;
  end if;

  insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
  values (p_assigned_to, 'task', v_task_id, v_task_id, v_title_en, v_title_gu);

  if p_second_assignee is not null then
    insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu)
    values (
      p_second_assignee, 'task', v_task_id, v_task_id,
      case when p_to_department_id = v_interior_dept_id then v_title_en else 'You have been added to a task as Second Assignee: ' || p_title end,
      case when p_to_department_id = v_interior_dept_id then v_title_gu else 'તમને બીજી જવાબદાર વ્યક્તિ તરીકે કામમાં ઉમેરવામાં આવ્યા છે: ' || p_title end
    );
  end if;

  return query select v_task_id, v_task_number, v_bridge_id, v_bridge_number;
end;
$function$;

-- =============================================================================================================== 2. tables
create table if not exists public.ecom_connection (
  id int primary key default 1 check (id = 1),
  shop_domain text,                       -- xxx.myshopify.com
  api_version text not null default '2026-10',
  auth_mode text not null default 'ACCESS_TOKEN' check (auth_mode in ('ACCESS_TOKEN', 'CLIENT_CREDENTIALS')),
  client_id text,                         -- not secret
  access_token_secret_id uuid,            -- vault ids only; the values live in vault.secrets
  client_secret_secret_id uuid,
  cron_secret_id uuid,
  functions_url text not null default 'https://bykmyttaesuyjwvtnxks.supabase.co/functions/v1/shopify-sync',
  status text not null default 'NOT_CONFIGURED' check (status in ('NOT_CONFIGURED', 'CONFIGURED', 'CONNECTED', 'ERROR')),
  shop_name text, shop_timezone text, shop_currency text,
  granted_scopes text[] not null default '{}',
  missing_scopes text[] not null default '{}',
  webhooks_registered int not null default 0,
  baseline_at timestamptz,                -- first successful inventory baseline
  last_test_at timestamptz,
  last_sync_started_at timestamptz,
  last_success_sync_at timestamptz,
  last_error text, last_error_at timestamptz,
  low_stock_threshold int not null default 5 check (low_stock_threshold >= 0),
  timezone text not null default 'Asia/Kolkata',
  updated_by uuid, updated_at timestamptz not null default now()
);
insert into public.ecom_connection (id) values (1) on conflict do nothing;

create table if not exists public.ecom_sync_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('FULL', 'INCREMENTAL', 'TEST', 'WEBHOOKS')),
  trigger text not null check (trigger in ('MANUAL', 'SCHEDULE', 'INITIAL', 'WEBHOOK_RETRY')),
  status text not null default 'RUNNING' check (status in ('RUNNING', 'OK', 'PARTIAL', 'FAILED')),
  started_by uuid, started_at timestamptz not null default now(), finished_at timestamptz,
  counts jsonb not null default '{}', resume jsonb, error text
);
create index if not exists ecom_sync_runs_started_idx on public.ecom_sync_runs (started_at desc);

create table if not exists public.ecom_products (
  shopify_id text primary key,            -- gid://shopify/Product/...
  legacy_id bigint, title text not null, handle text, product_type text, vendor text,
  status text not null check (status in ('ACTIVE', 'DRAFT', 'ARCHIVED', 'UNLISTED')),
  tags text[] not null default '{}', image_url text, images jsonb not null default '[]',
  shopify_created_at timestamptz, shopify_updated_at timestamptz,
  deleted_at timestamptz, synced_at timestamptz not null default now()
);
create index if not exists ecom_products_title_idx on public.ecom_products (lower(title));

create table if not exists public.ecom_variants (
  shopify_id text primary key,
  product_id text not null references public.ecom_products(shopify_id) on delete cascade,
  title text, sku text, price numeric, compare_at_price numeric, position int,
  image_url text, inventory_item_id text, tracked boolean not null default true,
  low_stock_threshold int check (low_stock_threshold >= 0),        -- optional per-variant override
  deleted_at timestamptz, synced_at timestamptz not null default now()
);
create index if not exists ecom_variants_product_idx on public.ecom_variants (product_id);
create index if not exists ecom_variants_sku_idx on public.ecom_variants (lower(sku)) where sku is not null;
create index if not exists ecom_variants_item_idx on public.ecom_variants (inventory_item_id);

create table if not exists public.ecom_locations (
  shopify_id text primary key, name text not null, is_active boolean not null default true, city text,
  synced_at timestamptz not null default now()
);

create table if not exists public.ecom_inventory_levels (
  inventory_item_id text not null, location_id text not null,
  variant_id text, available int, committed int, on_hand int, incoming int,
  shopify_updated_at timestamptz, synced_at timestamptz not null default now(),
  primary key (inventory_item_id, location_id)
);
create index if not exists ecom_inventory_levels_variant_idx on public.ecom_inventory_levels (variant_id);

create table if not exists public.ecom_orders (
  shopify_id text primary key, legacy_id bigint, name text not null,
  shopify_created_at timestamptz not null, processed_at timestamptz, shopify_updated_at timestamptz,
  cancelled_at timestamptz, cancel_reason text, closed_at timestamptz, is_test boolean not null default false,
  customer_name text, currency text, total numeric, subtotal numeric,
  financial_status text, fulfillment_status text, return_status text,
  stage text not null check (stage in ('PENDING', 'PROCESSING', 'PARTIALLY_FULFILLED', 'FULFILLED', 'DISPATCHED', 'DELIVERED', 'CANCELLED', 'RETURNED')),
  tracking jsonb not null default '[]',       -- [{company, number, url, fulfillment_id, status}]
  fulfillments jsonb not null default '[]',   -- [{id, status, display_status, created_at, in_transit_at, delivered_at}]
  returned_qty int not null default 0, restocked_qty int not null default 0,
  delivered_at timestamptz, synced_at timestamptz not null default now()
);
create index if not exists ecom_orders_created_idx on public.ecom_orders (shopify_created_at desc);
create index if not exists ecom_orders_stage_idx on public.ecom_orders (stage);

create table if not exists public.ecom_order_lines (
  shopify_id text primary key,
  order_id text not null references public.ecom_orders(shopify_id) on delete cascade,
  product_id text, variant_id text, inventory_item_id text,
  title text, variant_title text, sku text, image_url text,
  quantity int not null default 0, current_quantity int not null default 0, unfulfilled_quantity int not null default 0,
  fulfilled_quantity int not null default 0, refunded_quantity int not null default 0, restocked_quantity int not null default 0,
  price numeric
);
create index if not exists ecom_order_lines_order_idx on public.ecom_order_lines (order_id);
create index if not exists ecom_order_lines_variant_idx on public.ecom_order_lines (variant_id);

create table if not exists public.ecom_refunds (
  shopify_id text primary key,
  order_id text not null references public.ecom_orders(shopify_id) on delete cascade,
  shopify_created_at timestamptz, note text, lines jsonb not null default '[]'
);

create table if not exists public.ecom_order_events (
  id bigint generated always as identity primary key,
  order_id text not null references public.ecom_orders(shopify_id) on delete cascade,
  at timestamptz not null, kind text not null, value text, source text not null default 'SHOPIFY'
);
create unique index if not exists ecom_order_events_once on public.ecom_order_events (order_id, kind, coalesce(value, ''), at);

create table if not exists public.ecom_stock_movements (
  id bigint generated always as identity primary key,
  inventory_item_id text not null, location_id text not null, variant_id text, sku text,
  previous_qty int, change int not null, new_qty int not null,
  committed_after int, on_hand_after int,
  movement_type text not null check (movement_type in ('BASELINE', 'ORDER', 'CANCEL_RESTOCK', 'RETURN_RESTOCK', 'ADJUSTMENT_SYNCED', 'ITEM_REMOVED')),
  order_id text, reference text,
  source text not null check (source in ('INITIAL_SYNC', 'WEBHOOK', 'SCHEDULED_SYNC', 'MANUAL_SYNC')),
  occurred_at timestamptz not null, recorded_at timestamptz not null default now(), attributed_at timestamptz
);
create index if not exists ecom_stock_movements_item_idx on public.ecom_stock_movements (inventory_item_id, location_id, occurred_at desc);
create index if not exists ecom_stock_movements_variant_idx on public.ecom_stock_movements (variant_id, occurred_at desc);
create index if not exists ecom_stock_movements_time_idx on public.ecom_stock_movements (occurred_at desc);

-- What a recent order / refund-with-restock is expected to do to stock; used ONLY to label a movement Shopify reports.
create table if not exists public.ecom_stock_hints (
  id bigint generated always as identity primary key,
  inventory_item_id text not null, location_id text, delta int not null,
  movement_type text not null, order_id text, reference text, hint_key text not null unique,
  created_at timestamptz not null default now(), consumed_at timestamptz
);

create table if not exists public.ecom_stock_alerts (
  id uuid primary key default gen_random_uuid(),
  variant_id text not null, condition text not null check (condition in ('LOW', 'OUT')),
  available_at_open int, opened_at timestamptz not null default now(), resolved_at timestamptz
);
create unique index if not exists ecom_stock_alerts_one_open on public.ecom_stock_alerts (variant_id) where resolved_at is null;

create table if not exists public.ecom_webhook_events (
  event_key text primary key,             -- X-Shopify-Event-Id (or X-Shopify-Webhook-Id)
  topic text not null, object_id text, triggered_at timestamptz,
  received_at timestamptz not null default now(), processed_at timestamptz,
  status text not null default 'RECEIVED' check (status in ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED')),
  attempts int not null default 1, error text
);
create index if not exists ecom_webhook_events_status_idx on public.ecom_webhook_events (status, received_at);

create table if not exists public.ecom_listing_items (
  id uuid primary key default gen_random_uuid(),
  title text not null, sku text, category text, image_url text, notes text,
  retail_product_id uuid references public.retail_products(id),
  assigned_to uuid references public.user_profiles(id), target_date date,
  status text not null default 'TO_ADD' check (status in ('TO_ADD', 'IN_PROGRESS', 'LISTED')),
  shopify_product_id text references public.ecom_products(shopify_id) on delete set null,
  auto_linked boolean not null default false, listed_at timestamptz,
  created_by uuid not null, created_at timestamptz not null default now(),
  updated_by uuid, updated_at timestamptz not null default now(), archived_at timestamptz
);
create index if not exists ecom_listing_items_sku_idx on public.ecom_listing_items (lower(sku)) where sku is not null;

-- Read access: anyone who may open E-commerce; no direct writes from the browser (everything goes through the functions below).
do $$
declare t text;
begin
  foreach t in array array['ecom_products', 'ecom_variants', 'ecom_locations', 'ecom_inventory_levels', 'ecom_orders', 'ecom_order_lines',
                           'ecom_refunds', 'ecom_order_events', 'ecom_stock_movements', 'ecom_stock_alerts', 'ecom_listing_items', 'ecom_sync_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select_ecom', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.ecom_can_access())', t || '_select_ecom', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  foreach t in array array['ecom_connection', 'ecom_stock_hints', 'ecom_webhook_events'] loop
    execute format('alter table public.%I enable row level security', t);   -- no policy: server only
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- =============================================================================================================== 3. stock view
create or replace function public.ecom_default_threshold() returns int language sql stable security definer set search_path to 'public' as $$
  select coalesce((select low_stock_threshold from public.ecom_connection where id = 1), 5) $$;
grant execute on function public.ecom_default_threshold() to authenticated, service_role;
-- One row per variant with its synchronised stock and status. security_invoker: the caller's row-level security applies.
create or replace view public.ecom_variant_stock with (security_invoker = true) as
select v.shopify_id as variant_id, v.product_id, p.title as product_title, p.status as product_status, p.product_type, p.vendor,
       coalesce(v.image_url, p.image_url) as image_url, v.title as variant_title, v.sku, v.price, v.tracked,
       v.inventory_item_id, v.low_stock_threshold as variant_threshold,
       coalesce(v.low_stock_threshold, public.ecom_default_threshold()) as threshold,
       l.available, l.committed, l.on_hand, l.incoming, l.locations, l.last_stock_update,
       case when not v.tracked then 'NOT_TRACKED'
            when l.available is null then 'NOT_TRACKED'
            when l.available <= 0 then 'OUT'
            when l.available <= coalesce(v.low_stock_threshold, public.ecom_default_threshold()) then 'LOW'
            else 'IN' end as stock_status,
       coalesce((select sum(ol.current_quantity) from public.ecom_order_lines ol join public.ecom_orders o on o.shopify_id = ol.order_id
                  where ol.variant_id = v.shopify_id and o.cancelled_at is null and not o.is_test), 0)::int as units_sold,
       greatest(p.shopify_updated_at, v.synced_at) as updated_at
  from public.ecom_variants v
  join public.ecom_products p on p.shopify_id = v.product_id
  left join lateral (select sum(il.available)::int available, sum(il.committed)::int committed, sum(il.on_hand)::int on_hand,
                            sum(il.incoming)::int incoming, count(*)::int locations, max(il.shopify_updated_at) last_stock_update
                       from public.ecom_inventory_levels il where il.inventory_item_id = v.inventory_item_id) l on true
 where v.deleted_at is null and p.deleted_at is null;
grant select on public.ecom_variant_stock to authenticated;

-- =============================================================================================================== 4. connection
create or replace function public.ecom_connection_status() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare c public.ecom_connection; r public.ecom_sync_runs;
begin
  if not public.ecom_can_access() then raise exception 'You do not have access to E-commerce'; end if;
  select * into c from public.ecom_connection where id = 1;
  select * into r from public.ecom_sync_runs order by started_at desc limit 1;
  return jsonb_build_object(
    'status', c.status, 'shop_domain', c.shop_domain, 'shop_name', c.shop_name, 'api_version', c.api_version, 'auth_mode', c.auth_mode,
    'client_id', c.client_id, 'has_access_token', c.access_token_secret_id is not null, 'has_client_secret', c.client_secret_secret_id is not null,
    'granted_scopes', c.granted_scopes, 'missing_scopes', c.missing_scopes, 'webhooks_registered', c.webhooks_registered,
    'baseline_at', c.baseline_at, 'last_test_at', c.last_test_at, 'last_success_sync_at', c.last_success_sync_at,
    'last_sync_started_at', c.last_sync_started_at, 'last_error', c.last_error, 'last_error_at', c.last_error_at,
    'low_stock_threshold', c.low_stock_threshold, 'timezone', c.timezone, 'can_configure', public.ecom_can_configure(),
    'can_set_thresholds', public.ecom_can_set_thresholds(),
    'last_run', case when r.id is null then null else jsonb_build_object('kind', r.kind, 'trigger', r.trigger, 'status', r.status,
       'started_at', r.started_at, 'finished_at', r.finished_at, 'counts', r.counts, 'error', r.error) end,
    'failed_webhooks_24h', (select count(*) from public.ecom_webhook_events where status = 'FAILED' and received_at > now() - interval '24 hours'));
end $$;

-- Saves the connection. Blank secrets keep the stored value. Secrets go to Vault only and are never returned.
create or replace function public.ecom_save_connection(p_shop_domain text, p_api_version text, p_auth_mode text, p_client_id text,
                                                       p_client_secret text, p_access_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare c public.ecom_connection; v_domain text := lower(btrim(coalesce(p_shop_domain, ''))); v_ver text := btrim(coalesce(p_api_version, ''));
        v_mode text := upper(btrim(coalesce(p_auth_mode, 'ACCESS_TOKEN')));
begin
  if not public.ecom_can_configure() then raise exception 'Only Management can change the Shopify connection'; end if;
  v_domain := regexp_replace(regexp_replace(v_domain, '^https?://', ''), '/.*$', '');
  if v_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' then raise exception 'Enter the store''s myshopify.com address, e.g. moodofwood.myshopify.com'; end if;
  if v_ver !~ '^20[0-9]{2}-(01|04|07|10)$' then raise exception 'API version must look like 2026-10'; end if;
  if v_mode not in ('ACCESS_TOKEN', 'CLIENT_CREDENTIALS') then raise exception 'Unknown connection type'; end if;
  select * into c from public.ecom_connection where id = 1 for update;
  if nullif(btrim(coalesce(p_client_secret, '')), '') is not null then
    if c.client_secret_secret_id is null then
      c.client_secret_secret_id := vault.create_secret(btrim(p_client_secret), 'ecom_shopify_client_secret_' || gen_random_uuid(), 'Shopify app client secret (E-commerce)');
    else perform vault.update_secret(c.client_secret_secret_id, btrim(p_client_secret)); end if;
  end if;
  if nullif(btrim(coalesce(p_access_token, '')), '') is not null then
    if c.access_token_secret_id is null then
      c.access_token_secret_id := vault.create_secret(btrim(p_access_token), 'ecom_shopify_access_token_' || gen_random_uuid(), 'Shopify Admin API access token (E-commerce)');
    else perform vault.update_secret(c.access_token_secret_id, btrim(p_access_token)); end if;
  end if;
  if c.client_secret_secret_id is null then raise exception 'The app''s client secret is required (it also verifies Shopify webhooks)'; end if;
  if v_mode = 'ACCESS_TOKEN' and c.access_token_secret_id is null then raise exception 'The Admin API access token is required'; end if;
  if v_mode = 'CLIENT_CREDENTIALS' and nullif(btrim(coalesce(p_client_id, '')), '') is null then raise exception 'The app''s client ID is required'; end if;
  if c.cron_secret_id is null then
    c.cron_secret_id := vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'ecom_cron_secret_' || gen_random_uuid(), 'E-commerce scheduled sync key');
  end if;
  update public.ecom_connection set shop_domain = v_domain, api_version = v_ver, auth_mode = v_mode, client_id = nullif(btrim(coalesce(p_client_id, '')), ''),
         client_secret_secret_id = c.client_secret_secret_id, access_token_secret_id = c.access_token_secret_id, cron_secret_id = c.cron_secret_id,
         status = case when c.shop_domain is distinct from v_domain or c.status = 'NOT_CONFIGURED' then 'CONFIGURED' else c.status end,
         updated_by = auth.uid(), updated_at = now()
   where id = 1;
  perform public.staff_write_audit('ecom_connection', null, 'SHOPIFY_CONNECTION_SAVED', null,
    jsonb_build_object('shop_domain', v_domain, 'api_version', v_ver, 'auth_mode', v_mode), public.ecom_dept_id(), 'Shopify connection saved (secrets in Vault)');
  return public.ecom_connection_status();
end $$;

create or replace function public.ecom_set_threshold(p_threshold int, p_variant_id text default null) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.ecom_can_set_thresholds() then raise exception 'Only Management or a Department Head can change stock thresholds'; end if;
  if p_variant_id is null then
    if p_threshold is null or p_threshold < 0 then raise exception 'Threshold must be 0 or more'; end if;
    update public.ecom_connection set low_stock_threshold = p_threshold, updated_by = auth.uid(), updated_at = now() where id = 1;
    perform public.ecom_eval_alerts(null, false);
  else
    if p_threshold is not null and p_threshold < 0 then raise exception 'Threshold must be 0 or more'; end if;
    update public.ecom_variants set low_stock_threshold = p_threshold where shopify_id = p_variant_id;
    if not found then raise exception 'Variant not found'; end if;
    perform public.ecom_eval_alerts(p_variant_id, false);
  end if;
end $$;

-- Server only: everything the shopify-sync function needs, secrets included.
create or replace function public.ecom_get_credentials() returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('shop_domain', c.shop_domain, 'api_version', c.api_version, 'auth_mode', c.auth_mode, 'client_id', c.client_id,
    'client_secret', (select decrypted_secret from vault.decrypted_secrets where id = c.client_secret_secret_id),
    'access_token', (select decrypted_secret from vault.decrypted_secrets where id = c.access_token_secret_id),
    'cron_secret', (select decrypted_secret from vault.decrypted_secrets where id = c.cron_secret_id),
    'functions_url', c.functions_url, 'last_success_sync_at', c.last_success_sync_at, 'baseline_at', c.baseline_at, 'status', c.status)
  from public.ecom_connection c where c.id = 1 $$;

create or replace function public.ecom_record_test(p_ok boolean, p_shop jsonb, p_error text) returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_required text[] := array['read_products', 'read_inventory', 'read_locations', 'read_orders'];
        v_granted text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p_shop -> 'scopes', '[]')) x), '{}');
begin
  update public.ecom_connection set last_test_at = now(),
    status = case when p_ok then 'CONNECTED' else 'ERROR' end,
    shop_name = coalesce(p_shop ->> 'name', shop_name), shop_timezone = coalesce(p_shop ->> 'timezone', shop_timezone),
    shop_currency = coalesce(p_shop ->> 'currency', shop_currency),
    granted_scopes = case when p_ok then v_granted else granted_scopes end,
    missing_scopes = case when p_ok then (select coalesce(array_agg(s), '{}') from unnest(v_required) s where not s = any(v_granted)) else missing_scopes end,
    webhooks_registered = coalesce((p_shop ->> 'webhooks')::int, webhooks_registered),
    last_error = case when p_ok then null else left(p_error, 1000) end, last_error_at = case when p_ok then last_error_at else now() end
  where id = 1;
end $$;

-- =============================================================================================================== 5. sync runs
create or replace function public.ecom_sync_start(p_kind text, p_trigger text, p_user uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r public.ecom_sync_runs; v_resume jsonb;
begin
  -- a run that has said nothing for 10 minutes died (the server function stops after ~150 s)
  update public.ecom_sync_runs set status = 'FAILED', finished_at = now(), error = coalesce(error, 'Stopped without finishing (timed out)')
   where status = 'RUNNING' and started_at < now() - interval '10 minutes';
  if exists (select 1 from public.ecom_sync_runs where status = 'RUNNING') then
    return jsonb_build_object('busy', true);
  end if;
  -- a full sync that ran out of time continues where it stopped
  select resume into v_resume from public.ecom_sync_runs where status = 'PARTIAL' and resume is not null
     and started_at > now() - interval '2 days' order by started_at desc limit 1;
  insert into public.ecom_sync_runs (kind, trigger, started_by, resume)
  values (case when v_resume is not null then 'FULL' else p_kind end, p_trigger, p_user, v_resume) returning * into r;
  update public.ecom_connection set last_sync_started_at = now() where id = 1;
  return jsonb_build_object('busy', false, 'run_id', r.id, 'kind', r.kind, 'resume', r.resume);
end $$;

create or replace function public.ecom_sync_finish(p_run uuid, p_status text, p_counts jsonb, p_error text, p_resume jsonb, p_since timestamptz)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update public.ecom_sync_runs set status = p_status, finished_at = now(), counts = coalesce(p_counts, '{}'), error = left(p_error, 2000),
         resume = case when p_status = 'PARTIAL' then p_resume end
   where id = p_run;
  if p_status = 'OK' then
    -- the next incremental sync asks Shopify for everything changed since this run STARTED (minus a margin), never later
    update public.ecom_connection set last_success_sync_at = coalesce(p_since, now()), status = 'CONNECTED', baseline_at = coalesce(baseline_at, now()),
           last_error = null where id = 1;
    update public.ecom_sync_runs set resume = null where status = 'PARTIAL' and resume is not null;
  elsif p_status = 'FAILED' then
    update public.ecom_connection set last_error = left(p_error, 1000), last_error_at = now(), status = 'ERROR' where id = 1;
  end if;
end $$;

-- =============================================================================================================== 6. ingest (server only)
create or replace function public.ecom_ingest_locations(p_locations jsonb) returns int
language plpgsql security definer set search_path to 'public' as $$
declare x jsonb; n int := 0;
begin
  for x in select * from jsonb_array_elements(coalesce(p_locations, '[]')) loop
    insert into public.ecom_locations (shopify_id, name, is_active, city, synced_at)
    values (x ->> 'id', coalesce(x ->> 'name', '?'), coalesce((x ->> 'is_active')::boolean, true), x ->> 'city', now())
    on conflict (shopify_id) do update set name = excluded.name, is_active = excluded.is_active, city = excluded.city, synced_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

-- Products with their variants. Older data never overwrites newer (out-of-order webhooks). Variants missing from a full product
-- payload are marked deleted. Listing checklist items with the same SKU are marked Listed.
create or replace function public.ecom_ingest_products(p_products jsonb) returns int
language plpgsql security definer set search_path to 'public' as $$
declare x jsonb; v jsonb; n int := 0; v_ids text[]; v_upd timestamptz;
begin
  for x in select * from jsonb_array_elements(coalesce(p_products, '[]')) loop
    v_upd := (x ->> 'updated_at')::timestamptz;
    if exists (select 1 from public.ecom_products where shopify_id = x ->> 'id' and shopify_updated_at > v_upd and deleted_at is null) then
      continue;
    end if;
    insert into public.ecom_products (shopify_id, legacy_id, title, handle, product_type, vendor, status, tags, image_url, images,
                                      shopify_created_at, shopify_updated_at, deleted_at, synced_at)
    values (x ->> 'id', (x ->> 'legacy_id')::bigint, coalesce(x ->> 'title', '(no title)'), x ->> 'handle', nullif(x ->> 'product_type', ''),
            nullif(x ->> 'vendor', ''), upper(coalesce(x ->> 'status', 'ACTIVE')),
            coalesce((select array_agg(t) from jsonb_array_elements_text(coalesce(x -> 'tags', '[]')) t), '{}'),
            x ->> 'image_url', coalesce(x -> 'images', '[]'), (x ->> 'created_at')::timestamptz, v_upd, null, now())
    on conflict (shopify_id) do update set legacy_id = excluded.legacy_id, title = excluded.title, handle = excluded.handle,
      product_type = excluded.product_type, vendor = excluded.vendor, status = excluded.status, tags = excluded.tags,
      image_url = excluded.image_url, images = excluded.images, shopify_created_at = excluded.shopify_created_at,
      shopify_updated_at = excluded.shopify_updated_at, deleted_at = null, synced_at = now();
    v_ids := '{}';
    for v in select * from jsonb_array_elements(coalesce(x -> 'variants', '[]')) loop
      v_ids := v_ids || (v ->> 'id');
      insert into public.ecom_variants (shopify_id, product_id, title, sku, price, compare_at_price, position, image_url, inventory_item_id, tracked, deleted_at, synced_at)
      values (v ->> 'id', x ->> 'id', v ->> 'title', nullif(btrim(coalesce(v ->> 'sku', '')), ''), (v ->> 'price')::numeric,
              (v ->> 'compare_at_price')::numeric, (v ->> 'position')::int, v ->> 'image_url', v ->> 'inventory_item_id',
              coalesce((v ->> 'tracked')::boolean, true), null, now())
      on conflict (shopify_id) do update set product_id = excluded.product_id, title = excluded.title, sku = excluded.sku, price = excluded.price,
        compare_at_price = excluded.compare_at_price, position = excluded.position, image_url = excluded.image_url,
        inventory_item_id = excluded.inventory_item_id, tracked = excluded.tracked, deleted_at = null, synced_at = now();
      update public.ecom_inventory_levels set variant_id = v ->> 'id' where inventory_item_id = v ->> 'inventory_item_id' and variant_id is distinct from v ->> 'id';
    end loop;
    if coalesce((x ->> 'variants_complete')::boolean, true) then
      update public.ecom_variants set deleted_at = now() where product_id = x ->> 'id' and deleted_at is null and not (shopify_id = any(v_ids));
    end if;
    -- Products to Add: a checklist item whose SKU now exists in Shopify is Listed
    update public.ecom_listing_items li set status = 'LISTED', shopify_product_id = x ->> 'id', auto_linked = true, listed_at = now(), updated_at = now()
     where li.archived_at is null and li.status <> 'LISTED' and li.sku is not null
       and exists (select 1 from jsonb_array_elements(coalesce(x -> 'variants', '[]')) vv where lower(btrim(vv ->> 'sku')) = lower(btrim(li.sku)));
    perform public.ecom_eval_alerts(vv.shopify_id, true) from public.ecom_variants vv where vv.product_id = x ->> 'id';
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.ecom_mark_product_deleted(p_product_id text) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  update public.ecom_products set deleted_at = now() where shopify_id = p_product_id and deleted_at is null;
  update public.ecom_variants set deleted_at = now() where product_id = p_product_id and deleted_at is null;
  update public.ecom_stock_alerts set resolved_at = now()
   where resolved_at is null and variant_id in (select shopify_id from public.ecom_variants where product_id = p_product_id);
end $$;

-- Inventory levels as Shopify reports them. A movement is written only when the AVAILABLE quantity really changed; it is labelled
-- from a matching hint (recent order / refund with restock) or else ADJUSTMENT_SYNCED. The first sight of a level is its BASELINE.
create or replace function public.ecom_ingest_inventory(p_levels jsonb, p_source text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare x jsonb; old public.ecom_inventory_levels; v_new int; v_upd timestamptz; v_variant text; v_sku text; h public.ecom_stock_hints;
        n_levels int := 0; n_moves int := 0; n_stale int := 0; v_type text; v_variants text[] := '{}';
begin
  if p_source not in ('INITIAL_SYNC', 'WEBHOOK', 'SCHEDULED_SYNC', 'MANUAL_SYNC') then raise exception 'bad source %', p_source; end if;
  for x in select * from jsonb_array_elements(coalesce(p_levels, '[]')) loop
    v_upd := coalesce((x ->> 'updated_at')::timestamptz, now());
    v_new := (x ->> 'available')::int;
    select * into old from public.ecom_inventory_levels where inventory_item_id = x ->> 'inventory_item_id' and location_id = x ->> 'location_id' for update;
    if old.inventory_item_id is not null and old.shopify_updated_at is not null and v_upd < old.shopify_updated_at then
      n_stale := n_stale + 1;  -- an older report arriving late: ignore
      continue;
    end if;
    v_variant := coalesce(x ->> 'variant_id', old.variant_id, (select shopify_id from public.ecom_variants where inventory_item_id = x ->> 'inventory_item_id' limit 1));
    v_sku := coalesce(nullif(x ->> 'sku', ''), (select sku from public.ecom_variants where shopify_id = v_variant));
    insert into public.ecom_inventory_levels (inventory_item_id, location_id, variant_id, available, committed, on_hand, incoming, shopify_updated_at, synced_at)
    values (x ->> 'inventory_item_id', x ->> 'location_id', v_variant, v_new, (x ->> 'committed')::int, (x ->> 'on_hand')::int, (x ->> 'incoming')::int, v_upd, now())
    on conflict (inventory_item_id, location_id) do update set variant_id = excluded.variant_id, available = excluded.available,
      committed = coalesce(excluded.committed, ecom_inventory_levels.committed), on_hand = coalesce(excluded.on_hand, ecom_inventory_levels.on_hand),
      incoming = coalesce(excluded.incoming, ecom_inventory_levels.incoming), shopify_updated_at = excluded.shopify_updated_at, synced_at = now();
    n_levels := n_levels + 1;
    if v_new is null then continue; end if;
    if old.inventory_item_id is null then
      insert into public.ecom_stock_movements (inventory_item_id, location_id, variant_id, sku, previous_qty, change, new_qty, committed_after, on_hand_after,
                                               movement_type, reference, source, occurred_at)
      values (x ->> 'inventory_item_id', x ->> 'location_id', v_variant, v_sku, null, 0, v_new, (x ->> 'committed')::int, (x ->> 'on_hand')::int,
              'BASELINE', case when p_source = 'INITIAL_SYNC' then 'Opening balance at the first Shopify sync' else 'First seen in Shopify' end, p_source, v_upd);
      n_moves := n_moves + 1;
    elsif old.available is distinct from v_new then
      h := null;
      select * into h from public.ecom_stock_hints
       where inventory_item_id = x ->> 'inventory_item_id' and consumed_at is null and delta = v_new - coalesce(old.available, 0)
         and (location_id is null or location_id = x ->> 'location_id') and created_at > now() - interval '6 hours'
       order by created_at limit 1 for update skip locked;
      v_type := coalesce(h.movement_type, 'ADJUSTMENT_SYNCED');
      insert into public.ecom_stock_movements (inventory_item_id, location_id, variant_id, sku, previous_qty, change, new_qty, committed_after, on_hand_after,
                                               movement_type, order_id, reference, source, occurred_at, attributed_at)
      values (x ->> 'inventory_item_id', x ->> 'location_id', v_variant, v_sku, old.available, v_new - coalesce(old.available, 0), v_new,
              (x ->> 'committed')::int, (x ->> 'on_hand')::int, v_type, h.order_id,
              coalesce(h.reference, 'Shopify inventory changed; reason not reported by Shopify'), p_source, v_upd, case when h.id is not null then now() end);
      if h.id is not null then update public.ecom_stock_hints set consumed_at = now() where id = h.id; end if;
      n_moves := n_moves + 1;
    end if;
    if v_variant is not null then v_variants := v_variants || v_variant; end if;
  end loop;
  perform public.ecom_eval_alerts(vid, p_source = 'INITIAL_SYNC') from (select distinct unnest(v_variants) vid) s;
  return jsonb_build_object('levels', n_levels, 'movements', n_moves, 'stale_ignored', n_stale);
end $$;

-- An inventory item removed from a location (inventory_levels/disconnect).
create or replace function public.ecom_remove_inventory_level(p_item text, p_location text, p_source text) returns void
language plpgsql security definer set search_path to 'public' as $$
declare old public.ecom_inventory_levels;
begin
  delete from public.ecom_inventory_levels where inventory_item_id = p_item and location_id = p_location returning * into old;
  if old.inventory_item_id is not null and coalesce(old.available, 0) <> 0 then
    insert into public.ecom_stock_movements (inventory_item_id, location_id, variant_id, previous_qty, change, new_qty, movement_type, reference, source, occurred_at)
    values (p_item, p_location, old.variant_id, old.available, -old.available, 0, 'ITEM_REMOVED', 'Item no longer stocked at this location in Shopify', p_source, now());
  end if;
  if old.variant_id is not null then perform public.ecom_eval_alerts(old.variant_id, false); end if;
end $$;

-- A hint that explains a stock change; if Shopify reported the change BEFORE the order arrived, the waiting movement is labelled now.
create or replace function public.ecom_add_hint(p_item text, p_location text, p_delta int, p_type text, p_order text, p_reference text, p_key text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare m_id bigint;
begin
  if p_item is null or coalesce(p_delta, 0) = 0 then return; end if;
  if exists (select 1 from public.ecom_stock_hints where hint_key = p_key) then return; end if;  -- the same order/refund again: nothing new
  select id into m_id from public.ecom_stock_movements
   where inventory_item_id = p_item and movement_type = 'ADJUSTMENT_SYNCED' and attributed_at is null and change = p_delta
     and (p_location is null or location_id = p_location) and recorded_at > now() - interval '6 hours'
   order by recorded_at limit 1 for update skip locked;
  if m_id is not null then
    update public.ecom_stock_movements set movement_type = p_type, order_id = p_order, reference = p_reference, attributed_at = now() where id = m_id;
    insert into public.ecom_stock_hints (inventory_item_id, location_id, delta, movement_type, order_id, reference, hint_key, consumed_at)
    values (p_item, p_location, p_delta, p_type, p_order, p_reference, p_key, now());
  else
    insert into public.ecom_stock_hints (inventory_item_id, location_id, delta, movement_type, order_id, reference, hint_key)
    values (p_item, p_location, p_delta, p_type, p_order, p_reference, p_key);
  end if;
end $$;

-- Orders with lines, fulfilments (tracking) and refunds. Never touches stock: Shopify already moved it; recent orders and refunds
-- with restock only leave hints that LABEL the stock change Shopify reports.
create or replace function public.ecom_ingest_orders(p_orders jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare x jsonb; l jsonb; f jsonb; r jsonb; rl jsonb; old public.ecom_orders; v_upd timestamptz; v_created timestamptz; v_stage text;
        v_tracking jsonb; v_fulfil jsonb; v_all_delivered boolean; v_any_shipment boolean; v_ret int; v_rest int; v_deliv timestamptz;
        n int := 0; n_stale int := 0; v_line_ids text[]; v_ff_qty jsonb; v_ref_qty jsonb; v_rst_qty jsonb; v_type text;
begin
  for x in select * from jsonb_array_elements(coalesce(p_orders, '[]')) loop
    v_upd := (x ->> 'updated_at')::timestamptz;
    v_created := (x ->> 'created_at')::timestamptz;
    select * into old from public.ecom_orders where shopify_id = x ->> 'id' for update;
    if old.shopify_id is not null and old.shopify_updated_at is not null and v_upd < old.shopify_updated_at then
      n_stale := n_stale + 1; continue;
    end if;

    -- fulfilments and tracking
    v_tracking := '[]'; v_fulfil := '[]'; v_all_delivered := false; v_any_shipment := false; v_deliv := null; v_ff_qty := '{}';
    for f in select * from jsonb_array_elements(coalesce(x -> 'fulfillments', '[]')) loop
      v_fulfil := v_fulfil || jsonb_build_array(jsonb_build_object('id', f ->> 'id', 'status', f ->> 'status', 'display_status', f ->> 'display_status',
                   'created_at', f ->> 'created_at', 'in_transit_at', f ->> 'in_transit_at', 'delivered_at', f ->> 'delivered_at'));
      if upper(coalesce(f ->> 'status', '')) in ('CANCELLED', 'ERROR', 'FAILURE') then continue; end if;
      select v_tracking || coalesce(jsonb_agg(jsonb_build_object('company', t ->> 'company', 'number', t ->> 'number', 'url', t ->> 'url',
               'fulfillment_id', f ->> 'id', 'status', f ->> 'display_status')), '[]')
        into v_tracking from jsonb_array_elements(coalesce(f -> 'tracking', '[]')) t where coalesce(t ->> 'number', t ->> 'url') is not null;
      if jsonb_array_length(coalesce(f -> 'tracking', '[]')) > 0 or f ->> 'in_transit_at' is not null
         or upper(coalesce(f ->> 'display_status', '')) in ('IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ATTEMPTED_DELIVERY', 'READY_FOR_PICKUP', 'PICKED_UP', 'DELIVERED') then
        v_any_shipment := true;
      end if;
      for rl in select * from jsonb_array_elements(coalesce(f -> 'lines', '[]')) loop
        v_ff_qty := jsonb_set(v_ff_qty, array[rl ->> 'line_id'], to_jsonb(coalesce((v_ff_qty ->> (rl ->> 'line_id'))::int, 0) + (rl ->> 'quantity')::int));
      end loop;
    end loop;
    select bool_and(upper(coalesce(ff ->> 'display_status', '')) = 'DELIVERED' or ff ->> 'delivered_at' is not null), max((ff ->> 'delivered_at')::timestamptz)
      into v_all_delivered, v_deliv
      from jsonb_array_elements(coalesce(x -> 'fulfillments', '[]')) ff where upper(coalesce(ff ->> 'status', '')) not in ('CANCELLED', 'ERROR', 'FAILURE');

    -- refunds: returned / restocked quantities per line
    v_ret := 0; v_rest := 0; v_ref_qty := '{}'; v_rst_qty := '{}';
    for r in select * from jsonb_array_elements(coalesce(x -> 'refunds', '[]')) loop
      for rl in select * from jsonb_array_elements(coalesce(r -> 'lines', '[]')) loop
        v_ref_qty := jsonb_set(v_ref_qty, array[rl ->> 'line_id'], to_jsonb(coalesce((v_ref_qty ->> (rl ->> 'line_id'))::int, 0) + (rl ->> 'quantity')::int));
        if upper(coalesce(rl ->> 'restock_type', '')) = 'RETURN' then v_ret := v_ret + (rl ->> 'quantity')::int; end if;
        if coalesce((rl ->> 'restocked')::boolean, false) then
          v_rest := v_rest + (rl ->> 'quantity')::int;
          v_rst_qty := jsonb_set(v_rst_qty, array[rl ->> 'line_id'], to_jsonb(coalesce((v_rst_qty ->> (rl ->> 'line_id'))::int, 0) + (rl ->> 'quantity')::int));
        end if;
      end loop;
    end loop;

    v_stage := case
      when x ->> 'cancelled_at' is not null then 'CANCELLED'
      when upper(coalesce(x ->> 'return_status', '')) = 'RETURNED' then 'RETURNED'
      when upper(coalesce(x ->> 'fulfillment_status', '')) = 'FULFILLED' and coalesce(v_all_delivered, false) then 'DELIVERED'
      when upper(coalesce(x ->> 'fulfillment_status', '')) = 'FULFILLED' and v_any_shipment then 'DISPATCHED'
      when upper(coalesce(x ->> 'fulfillment_status', '')) = 'FULFILLED' then 'FULFILLED'
      when upper(coalesce(x ->> 'fulfillment_status', '')) = 'PARTIALLY_FULFILLED' then 'PARTIALLY_FULFILLED'
      when upper(coalesce(x ->> 'fulfillment_status', '')) in ('IN_PROGRESS') then 'PROCESSING'
      else 'PENDING' end;

    insert into public.ecom_orders (shopify_id, legacy_id, name, shopify_created_at, processed_at, shopify_updated_at, cancelled_at, cancel_reason, closed_at,
                                    is_test, customer_name, currency, total, subtotal, financial_status, fulfillment_status, return_status, stage,
                                    tracking, fulfillments, returned_qty, restocked_qty, delivered_at, synced_at)
    values (x ->> 'id', (x ->> 'legacy_id')::bigint, coalesce(x ->> 'name', '?'), v_created, (x ->> 'processed_at')::timestamptz, v_upd,
            (x ->> 'cancelled_at')::timestamptz, x ->> 'cancel_reason', (x ->> 'closed_at')::timestamptz, coalesce((x ->> 'test')::boolean, false),
            nullif(x ->> 'customer_name', ''), x ->> 'currency', (x ->> 'total')::numeric, (x ->> 'subtotal')::numeric,
            upper(x ->> 'financial_status'), upper(x ->> 'fulfillment_status'), upper(x ->> 'return_status'), v_stage,
            v_tracking, v_fulfil, v_ret, v_rest, case when v_stage = 'DELIVERED' then v_deliv end, now())
    on conflict (shopify_id) do update set legacy_id = excluded.legacy_id, name = excluded.name, processed_at = excluded.processed_at,
      shopify_updated_at = excluded.shopify_updated_at, cancelled_at = excluded.cancelled_at, cancel_reason = excluded.cancel_reason,
      closed_at = excluded.closed_at, is_test = excluded.is_test, customer_name = coalesce(excluded.customer_name, ecom_orders.customer_name),
      currency = excluded.currency, total = excluded.total, subtotal = excluded.subtotal, financial_status = excluded.financial_status,
      fulfillment_status = excluded.fulfillment_status, return_status = excluded.return_status, stage = excluded.stage,
      tracking = excluded.tracking, fulfillments = excluded.fulfillments, returned_qty = excluded.returned_qty,
      restocked_qty = excluded.restocked_qty, delivered_at = excluded.delivered_at, synced_at = now();

    -- lines
    v_line_ids := '{}';
    for l in select * from jsonb_array_elements(coalesce(x -> 'lines', '[]')) loop
      v_line_ids := v_line_ids || (l ->> 'id');
      insert into public.ecom_order_lines (shopify_id, order_id, product_id, variant_id, inventory_item_id, title, variant_title, sku, image_url,
                                           quantity, current_quantity, unfulfilled_quantity, fulfilled_quantity, refunded_quantity, restocked_quantity, price)
      values (l ->> 'id', x ->> 'id', l ->> 'product_id', l ->> 'variant_id', l ->> 'inventory_item_id', l ->> 'title', nullif(l ->> 'variant_title', ''),
              nullif(l ->> 'sku', ''), l ->> 'image_url', coalesce((l ->> 'quantity')::int, 0), coalesce((l ->> 'current_quantity')::int, (l ->> 'quantity')::int, 0),
              coalesce((l ->> 'unfulfilled_quantity')::int, 0), coalesce((v_ff_qty ->> (l ->> 'id'))::int, 0),
              coalesce((v_ref_qty ->> (l ->> 'id'))::int, 0), coalesce((v_rst_qty ->> (l ->> 'id'))::int, 0), (l ->> 'price')::numeric)
      on conflict (shopify_id) do update set product_id = excluded.product_id, variant_id = excluded.variant_id, inventory_item_id = excluded.inventory_item_id,
        title = excluded.title, variant_title = excluded.variant_title, sku = excluded.sku, image_url = excluded.image_url, quantity = excluded.quantity,
        current_quantity = excluded.current_quantity, unfulfilled_quantity = excluded.unfulfilled_quantity, fulfilled_quantity = excluded.fulfilled_quantity,
        refunded_quantity = excluded.refunded_quantity, restocked_quantity = excluded.restocked_quantity, price = excluded.price;
      -- a NEW recent order: hint that Shopify will lower available stock by the ordered quantity
      if v_created > now() - interval '6 hours' then
        perform public.ecom_add_hint(l ->> 'inventory_item_id', null, -coalesce((l ->> 'quantity')::int, 0), 'ORDER', x ->> 'id',
                                     'Order ' || coalesce(x ->> 'name', ''), 'order:' || (l ->> 'id'));
      end if;
    end loop;
    delete from public.ecom_order_lines where order_id = x ->> 'id' and not (shopify_id = any(v_line_ids));

    -- refunds (and the stock they put back, if Shopify restocked)
    for r in select * from jsonb_array_elements(coalesce(x -> 'refunds', '[]')) loop
      insert into public.ecom_refunds (shopify_id, order_id, shopify_created_at, note, lines)
      values (r ->> 'id', x ->> 'id', (r ->> 'created_at')::timestamptz, r ->> 'note', coalesce(r -> 'lines', '[]'))
      on conflict (shopify_id) do update set note = excluded.note, lines = excluded.lines;
      if (r ->> 'created_at')::timestamptz > now() - interval '6 hours' then
        for rl in select * from jsonb_array_elements(coalesce(r -> 'lines', '[]')) loop
          continue when not coalesce((rl ->> 'restocked')::boolean, false);
          v_type := case when upper(coalesce(rl ->> 'restock_type', '')) = 'RETURN' then 'RETURN_RESTOCK' else 'CANCEL_RESTOCK' end;
          perform public.ecom_add_hint(rl ->> 'inventory_item_id', rl ->> 'location_id', (rl ->> 'quantity')::int, v_type, x ->> 'id',
                                       case when v_type = 'RETURN_RESTOCK' then 'Return restocked, order ' else 'Cancelled and restocked, order ' end || coalesce(x ->> 'name', ''),
                                       'refund:' || (r ->> 'id') || ':' || (rl ->> 'line_id'));
        end loop;
      end if;
    end loop;

    -- status history (each fact once)
    insert into public.ecom_order_events (order_id, at, kind, value) values (x ->> 'id', v_created, 'RECEIVED', null) on conflict do nothing;
    if x ->> 'cancelled_at' is not null then
      insert into public.ecom_order_events (order_id, at, kind, value) values (x ->> 'id', (x ->> 'cancelled_at')::timestamptz, 'CANCELLED', x ->> 'cancel_reason') on conflict do nothing;
    end if;
    for f in select * from jsonb_array_elements(v_fulfil) loop
      insert into public.ecom_order_events (order_id, at, kind, value) values (x ->> 'id', (f ->> 'created_at')::timestamptz, 'FULFILMENT_CREATED', f ->> 'id') on conflict do nothing;
      if f ->> 'in_transit_at' is not null then
        insert into public.ecom_order_events (order_id, at, kind, value) values (x ->> 'id', (f ->> 'in_transit_at')::timestamptz, 'IN_TRANSIT', f ->> 'id') on conflict do nothing;
      end if;
      if f ->> 'delivered_at' is not null then
        insert into public.ecom_order_events (order_id, at, kind, value) values (x ->> 'id', (f ->> 'delivered_at')::timestamptz, 'DELIVERED', f ->> 'id') on conflict do nothing;
      end if;
    end loop;
    for r in select * from jsonb_array_elements(coalesce(x -> 'refunds', '[]')) loop
      insert into public.ecom_order_events (order_id, at, kind, value) values (x ->> 'id', (r ->> 'created_at')::timestamptz, 'REFUND', r ->> 'id') on conflict do nothing;
    end loop;
    if old.shopify_id is null or old.stage is distinct from v_stage then
      insert into public.ecom_order_events (order_id, at, kind, value) values (x ->> 'id', coalesce(v_upd, now()), 'STAGE', v_stage) on conflict do nothing;
    end if;
    if old.shopify_id is null or old.financial_status is distinct from upper(x ->> 'financial_status') then
      insert into public.ecom_order_events (order_id, at, kind, value) values (x ->> 'id', coalesce(v_upd, now()), 'PAYMENT', upper(x ->> 'financial_status')) on conflict do nothing;
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('orders', n, 'stale_ignored', n_stale);
end $$;

-- Low / out-of-stock alerts: one open alert per variant; it closes when stock recovers. p_silent (first sync) opens without notifying.
create or replace function public.ecom_eval_alerts(p_variant_id text, p_silent boolean) returns void
language plpgsql security definer set search_path to 'public' as $$
declare s record; a public.ecom_stock_alerts; v_new uuid; u uuid;
begin
  for s in select vs.variant_id, vs.stock_status, vs.available, vs.product_title, vs.variant_title, vs.sku, vs.product_status
             from public.ecom_variant_stock vs where p_variant_id is null or vs.variant_id = p_variant_id loop
    select * into a from public.ecom_stock_alerts where variant_id = s.variant_id and resolved_at is null;
    if s.stock_status in ('LOW', 'OUT') and s.product_status = 'ACTIVE' then
      if a.id is not null and a.condition = s.stock_status then continue; end if;   -- already alerted for this condition
      if a.id is not null then update public.ecom_stock_alerts set resolved_at = now() where id = a.id; end if;
      insert into public.ecom_stock_alerts (variant_id, condition, available_at_open) values (s.variant_id, s.stock_status, s.available) returning id into v_new;
      if not coalesce(p_silent, false) then
        foreach u in array public.ecom_team_ids() loop
          insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
          values (u, 'ecom_stock_alert', v_new,
            case when s.stock_status = 'OUT' then 'Out of stock on Shopify: ' else 'Low stock on Shopify: ' end || s.product_title
              || coalesce(' (' || nullif(s.variant_title, 'Default Title') || ')', '') || coalesce(' · SKU ' || s.sku, '') || ' · ' || coalesce(s.available, 0) || ' left',
            case when s.stock_status = 'OUT' then 'Shopify પર સ્ટોક ખતમ: ' else 'Shopify પર ઓછો સ્ટોક: ' end || s.product_title || ' · ' || coalesce(s.available, 0));
        end loop;
      end if;
    elsif a.id is not null then
      update public.ecom_stock_alerts set resolved_at = now() where id = a.id;
    end if;
  end loop;
end $$;

-- Webhook receipt: true = process it (new, or an earlier attempt failed); false = already handled (duplicate delivery).
create or replace function public.ecom_webhook_receive(p_key text, p_topic text, p_object text, p_triggered timestamptz) returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare v_status text;
begin
  insert into public.ecom_webhook_events (event_key, topic, object_id, triggered_at) values (p_key, p_topic, p_object, p_triggered)
  on conflict (event_key) do nothing;
  if found then return true; end if;
  select status into v_status from public.ecom_webhook_events where event_key = p_key for update;
  if v_status = 'FAILED' then
    update public.ecom_webhook_events set attempts = attempts + 1, status = 'RECEIVED', error = null where event_key = p_key;
    return true;
  end if;
  return false;
end $$;

create or replace function public.ecom_webhook_done(p_key text, p_status text, p_error text) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  update public.ecom_webhook_events set status = p_status, error = left(p_error, 1000), processed_at = now() where event_key = p_key;
  if p_status = 'FAILED' then
    update public.ecom_connection set last_error = 'Webhook ' || (select topic from public.ecom_webhook_events where event_key = p_key) || ': ' || left(p_error, 500),
           last_error_at = now() where id = 1;
  end if;
end $$;

-- Failed webhooks to retry on the next scheduled sync (up to 5 attempts).
create or replace function public.ecom_webhooks_to_retry() returns setof public.ecom_webhook_events
language sql stable security definer set search_path to 'public' as $$
  select * from public.ecom_webhook_events where status = 'FAILED' and attempts < 5 and received_at > now() - interval '3 days' order by received_at limit 50 $$;

-- =============================================================================================================== 7. dashboard + reports
-- Period counts use the order date in the company's timezone; stock counts are always the latest synchronised quantities.
create or replace function public.ecom_dashboard(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare tz text := coalesce((select timezone from public.ecom_connection where id = 1), 'Asia/Kolkata');
        v_from timestamptz; v_to timestamptz; v_today date := (now() at time zone tz)::date; res jsonb;
begin
  if not public.ecom_can_access() then raise exception 'You do not have access to E-commerce'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Choose a valid date range'; end if;
  v_from := p_from::timestamp at time zone tz; v_to := (p_to + 1)::timestamp at time zone tz;
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', tz),
    'orders_total', count(*) filter (where shopify_created_at >= v_from and shopify_created_at < v_to),
    'pending', count(*) filter (where stage = 'PENDING' and shopify_created_at >= v_from and shopify_created_at < v_to),
    'processing', count(*) filter (where stage in ('PROCESSING', 'PARTIALLY_FULFILLED') and shopify_created_at >= v_from and shopify_created_at < v_to),
    'fulfilled', count(*) filter (where stage = 'FULFILLED' and shopify_created_at >= v_from and shopify_created_at < v_to),
    'dispatched', count(*) filter (where stage = 'DISPATCHED' and shopify_created_at >= v_from and shopify_created_at < v_to),
    'delivered', count(*) filter (where stage = 'DELIVERED' and shopify_created_at >= v_from and shopify_created_at < v_to),
    'cancelled', count(*) filter (where stage = 'CANCELLED' and shopify_created_at >= v_from and shopify_created_at < v_to),
    'returned', count(*) filter (where (stage = 'RETURNED' or returned_qty > 0) and shopify_created_at >= v_from and shopify_created_at < v_to),
    'today_orders', count(*) filter (where (shopify_created_at at time zone tz)::date = v_today))
    into res from public.ecom_orders where not is_test;
  res := res || jsonb_build_object(
    'units_sold', (select coalesce(sum(ol.current_quantity), 0) from public.ecom_order_lines ol join public.ecom_orders o on o.shopify_id = ol.order_id
                    where not o.is_test and o.cancelled_at is null and o.shopify_created_at >= v_from and o.shopify_created_at < v_to),
    'products_total', (select count(*) from public.ecom_products where deleted_at is null),
    'products_active', (select count(*) from public.ecom_products where deleted_at is null and status = 'ACTIVE'),
    'products_draft', (select count(*) from public.ecom_products where deleted_at is null and status = 'DRAFT'),
    'products_archived', (select count(*) from public.ecom_products where deleted_at is null and status = 'ARCHIVED'),
    'variants_total', (select count(*) from public.ecom_variant_stock),
    'stock_available', (select coalesce(sum(available), 0) from public.ecom_variant_stock where tracked),
    'low_stock', (select count(*) from public.ecom_variant_stock where stock_status = 'LOW' and product_status = 'ACTIVE'),
    'out_of_stock', (select count(*) from public.ecom_variant_stock where stock_status = 'OUT' and product_status = 'ACTIVE'),
    'to_add', (select count(*) from public.ecom_listing_items where archived_at is null and status <> 'LISTED'),
    'stock_as_of', (select max(synced_at) from public.ecom_inventory_levels),
    'connection', public.ecom_connection_status());
  return res;
end $$;

-- Stock report for a period, per variant (all locations, or one): opening (only when the baseline is older than the period),
-- movements by type, closing (only for a finished period), and the current synchronised quantities.
create or replace function public.ecom_inventory_report(p_from date, p_to date, p_location text default null, p_search text default null)
returns table (variant_id text, product_id text, product_title text, variant_title text, sku text, image_url text, location_id text,
               opening int, ordered_out int, restocked_in int, adjust_in int, adjust_out int, closing int,
               available int, committed int, on_hand int, units_ordered int, units_sold int, baseline_at timestamptz, opening_note text)
language plpgsql stable security definer set search_path to 'public' as $$
#variable_conflict use_column
declare tz text := coalesce((select timezone from public.ecom_connection where id = 1), 'Asia/Kolkata');
        v_from timestamptz; v_to timestamptz; v_done boolean;
begin
  if not public.ecom_can_access() then raise exception 'You do not have access to E-commerce'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Choose a valid date range'; end if;
  v_from := p_from::timestamp at time zone tz; v_to := (p_to + 1)::timestamp at time zone tz; v_done := v_to <= now();
  return query
  with lv as (
    select il.inventory_item_id, il.location_id, il.available, il.committed, il.on_hand from public.ecom_inventory_levels il
     where p_location is null or il.location_id = p_location),
  per_loc as (
    select lv.inventory_item_id, lv.location_id, lv.available, lv.committed, lv.on_hand,
      (select m.new_qty from public.ecom_stock_movements m where m.inventory_item_id = lv.inventory_item_id and m.location_id = lv.location_id
          and m.occurred_at < v_from order by m.occurred_at desc, m.id desc limit 1) as open_qty,
      (select min(m.occurred_at) from public.ecom_stock_movements m where m.inventory_item_id = lv.inventory_item_id and m.location_id = lv.location_id
          and m.movement_type = 'BASELINE') as base_at,
      (select m.new_qty from public.ecom_stock_movements m where m.inventory_item_id = lv.inventory_item_id and m.location_id = lv.location_id
          and m.occurred_at < v_to order by m.occurred_at desc, m.id desc limit 1) as close_qty,
      (select coalesce(sum(-m.change) filter (where m.movement_type = 'ORDER'), 0) from public.ecom_stock_movements m where m.inventory_item_id = lv.inventory_item_id
          and m.location_id = lv.location_id and m.occurred_at >= v_from and m.occurred_at < v_to) as o_out,
      (select coalesce(sum(m.change) filter (where m.movement_type in ('CANCEL_RESTOCK', 'RETURN_RESTOCK')), 0) from public.ecom_stock_movements m
          where m.inventory_item_id = lv.inventory_item_id and m.location_id = lv.location_id and m.occurred_at >= v_from and m.occurred_at < v_to) as r_in,
      (select coalesce(sum(m.change) filter (where m.movement_type = 'ADJUSTMENT_SYNCED' and m.change > 0), 0) from public.ecom_stock_movements m
          where m.inventory_item_id = lv.inventory_item_id and m.location_id = lv.location_id and m.occurred_at >= v_from and m.occurred_at < v_to) as a_in,
      (select coalesce(sum(-m.change) filter (where m.movement_type in ('ADJUSTMENT_SYNCED', 'ITEM_REMOVED') and m.change < 0), 0) from public.ecom_stock_movements m
          where m.inventory_item_id = lv.inventory_item_id and m.location_id = lv.location_id and m.occurred_at >= v_from and m.occurred_at < v_to) as a_out
    from lv),
  agg as (
    select pl.inventory_item_id, case when p_location is null then null else max(pl.location_id) end as loc,
      case when bool_and(pl.base_at is not null and pl.base_at < v_from and pl.open_qty is not null) then sum(pl.open_qty)::int end as opening,
      sum(pl.o_out)::int o_out, sum(pl.r_in)::int r_in, sum(pl.a_in)::int a_in, sum(pl.a_out)::int a_out,
      case when v_done and bool_and(pl.close_qty is not null) then sum(pl.close_qty)::int end as closing,
      sum(pl.available)::int available, sum(pl.committed)::int committed, sum(pl.on_hand)::int on_hand, min(pl.base_at) base_at
    from per_loc pl group by pl.inventory_item_id)
  select v.shopify_id, v.product_id, p.title, v.title, v.sku, coalesce(v.image_url, p.image_url), agg.loc,
         agg.opening, agg.o_out, agg.r_in, agg.a_in, agg.a_out, agg.closing, agg.available, agg.committed, agg.on_hand,
         (select coalesce(sum(ol.quantity), 0)::int from public.ecom_order_lines ol join public.ecom_orders o on o.shopify_id = ol.order_id
           where ol.variant_id = v.shopify_id and not o.is_test and o.shopify_created_at >= v_from and o.shopify_created_at < v_to),
         (select coalesce(sum(ol.current_quantity), 0)::int from public.ecom_order_lines ol join public.ecom_orders o on o.shopify_id = ol.order_id
           where ol.variant_id = v.shopify_id and not o.is_test and o.cancelled_at is null and o.shopify_created_at >= v_from and o.shopify_created_at < v_to),
         agg.base_at,
         case when agg.opening is null then 'Not available: stock history starts at the first Shopify sync (' || coalesce(to_char(agg.base_at at time zone tz, 'DD Mon YYYY HH24:MI'), 'not yet') || ')' end
    from agg
    join public.ecom_variants v on v.inventory_item_id = agg.inventory_item_id and v.deleted_at is null
    join public.ecom_products p on p.shopify_id = v.product_id and p.deleted_at is null
   where p_search is null or p.title ilike '%' || p_search || '%' or v.sku ilike '%' || p_search || '%'
   order by p.title, v.position nulls last;
end $$;

-- =============================================================================================================== 8. products to add
create or replace function public.ecom_save_listing(p_id uuid, p_title text, p_sku text, p_category text, p_image_url text,
                                                    p_retail_product_id uuid, p_assigned_to uuid, p_target_date date, p_notes text)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid := p_id; old public.ecom_listing_items; rp public.retail_products; v_title text := btrim(coalesce(p_title, ''));
        v_shop text;
begin
  perform public.staff_assert_operational();
  if not public.ecom_can_access() then raise exception 'You do not have access to E-commerce'; end if;
  if p_retail_product_id is not null then
    select * into rp from public.retail_products where id = p_retail_product_id;
    if rp.id is null then raise exception 'Product not found in the product master'; end if;
    if v_title = '' then v_title := rp.name; end if;
  end if;
  if v_title = '' then raise exception 'Product name is required'; end if;
  if p_assigned_to is not null and not (p_assigned_to = any(public.ecom_team_ids())) then
    raise exception 'Assign it to a member of Marketing or E-commerce';
  end if;
  if v_id is null then
    insert into public.ecom_listing_items (title, sku, category, image_url, notes, retail_product_id, assigned_to, target_date, created_by, updated_by)
    values (v_title, nullif(btrim(coalesce(p_sku, rp.sku, '')), ''), nullif(btrim(coalesce(p_category, rp.category, '')), ''),
            nullif(btrim(coalesce(p_image_url, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''), p_retail_product_id, p_assigned_to, p_target_date, auth.uid(), auth.uid())
    returning id into v_id;
  else
    select * into old from public.ecom_listing_items where id = v_id and archived_at is null for update;
    if old.id is null then raise exception 'Item not found'; end if;
    update public.ecom_listing_items set title = v_title, sku = nullif(btrim(coalesce(p_sku, '')), ''), category = nullif(btrim(coalesce(p_category, '')), ''),
           image_url = nullif(btrim(coalesce(p_image_url, '')), ''), notes = nullif(btrim(coalesce(p_notes, '')), ''), retail_product_id = p_retail_product_id,
           assigned_to = p_assigned_to, target_date = p_target_date, updated_by = auth.uid(), updated_at = now()
     where id = v_id;
  end if;
  if p_assigned_to is not null and p_assigned_to is distinct from old.assigned_to then
    perform public.staff_notify_assignment(p_assigned_to, 'ecom_listing', v_id, 'Add to Shopify: ' || v_title || coalesce(' (by ' || to_char(p_target_date, 'DD Mon') || ')', ''),
                                           'Shopify પર ઉમેરો: ' || v_title);
  end if;
  -- already on Shopify? link it straight away
  select v.product_id into v_shop from public.ecom_variants v join public.ecom_listing_items li on li.id = v_id
   where li.sku is not null and lower(v.sku) = lower(li.sku) and v.deleted_at is null limit 1;
  if v_shop is not null then
    update public.ecom_listing_items set status = 'LISTED', shopify_product_id = v_shop, auto_linked = true, listed_at = coalesce(listed_at, now())
     where id = v_id and status <> 'LISTED';
  end if;
  return v_id;
end $$;

create or replace function public.ecom_set_listing_status(p_id uuid, p_status text, p_shopify_product_id text) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.staff_assert_operational();
  if not public.ecom_can_access() then raise exception 'You do not have access to E-commerce'; end if;
  if p_status not in ('TO_ADD', 'IN_PROGRESS', 'LISTED') then raise exception 'Unknown status'; end if;
  if p_shopify_product_id is not null and not exists (select 1 from public.ecom_products where shopify_id = p_shopify_product_id and deleted_at is null) then
    raise exception 'That Shopify product has not been synchronised yet';
  end if;
  update public.ecom_listing_items set status = p_status,
         shopify_product_id = case when p_status = 'LISTED' then coalesce(p_shopify_product_id, shopify_product_id) else null end,
         auto_linked = case when p_status = 'LISTED' and p_shopify_product_id is not null then false else auto_linked end,
         listed_at = case when p_status = 'LISTED' then coalesce(listed_at, now()) else null end, updated_by = auth.uid(), updated_at = now()
   where id = p_id and archived_at is null;
  if not found then raise exception 'Item not found'; end if;
end $$;

create or replace function public.ecom_remove_listing(p_id uuid) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.staff_assert_operational();
  if not public.ecom_can_access() then raise exception 'You do not have access to E-commerce'; end if;
  update public.ecom_listing_items set archived_at = now(), updated_by = auth.uid(), updated_at = now() where id = p_id and archived_at is null;
  if not found then raise exception 'Item not found'; end if;
end $$;

-- People that Products to Add can be assigned to.
create or replace function public.ecom_team() returns table (id uuid, full_name text, department_code text)
language sql stable security definer set search_path to 'public' as $$
  select up.id, up.full_name, d.code from public.user_profiles up join public.departments d on d.id = up.department_id
   where public.ecom_can_access() and up.id = any(public.ecom_team_ids()) order by up.full_name $$;

-- =============================================================================================================== 9. schedule
-- Every 30 minutes ask shopify-sync for an incremental sync + webhook retries; nothing happens until Shopify is connected.
create or replace function public.ecom_cron_tick() returns void language plpgsql security definer set search_path to 'public' as $$
declare c jsonb := public.ecom_get_credentials();
begin
  delete from public.ecom_webhook_events where received_at < now() - interval '30 days';
  delete from public.ecom_stock_hints where created_at < now() - interval '2 days';
  if c ->> 'status' not in ('CONNECTED', 'ERROR') or c ->> 'cron_secret' is null or c ->> 'shop_domain' is null then return; end if;
  perform net.http_post(url := c ->> 'functions_url', body := jsonb_build_object('action', 'scheduled'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-mow-cron', c ->> 'cron_secret'), timeout_milliseconds := 5000);
end $$;

do $$ begin
  perform cron.unschedule('ecom-shopify-reconcile') where exists (select 1 from cron.job where jobname = 'ecom-shopify-reconcile');
  perform cron.schedule('ecom-shopify-reconcile', '*/30 * * * *', 'select public.ecom_cron_tick();');
end $$;

-- =============================================================================================================== 10. grants
do $$
declare f text;
begin
  foreach f in array array['ecom_dept_id()', 'ecom_can_access()', 'ecom_can_configure()', 'ecom_can_set_thresholds()', 'ecom_team_ids()',
    'ecom_connection_status()', 'ecom_save_connection(text, text, text, text, text, text)', 'ecom_set_threshold(int, text)', 'ecom_get_credentials()',
    'ecom_record_test(boolean, jsonb, text)', 'ecom_sync_start(text, text, uuid)', 'ecom_sync_finish(uuid, text, jsonb, text, jsonb, timestamptz)',
    'ecom_ingest_locations(jsonb)', 'ecom_ingest_products(jsonb)', 'ecom_mark_product_deleted(text)', 'ecom_ingest_inventory(jsonb, text)',
    'ecom_remove_inventory_level(text, text, text)', 'ecom_add_hint(text, text, int, text, text, text, text)', 'ecom_ingest_orders(jsonb)',
    'ecom_eval_alerts(text, boolean)', 'ecom_webhook_receive(text, text, text, timestamptz)', 'ecom_webhook_done(text, text, text)',
    'ecom_webhooks_to_retry()', 'ecom_dashboard(date, date)', 'ecom_inventory_report(date, date, text, text)',
    'ecom_save_listing(uuid, text, text, text, text, uuid, uuid, date, text)', 'ecom_set_listing_status(uuid, text, text)', 'ecom_remove_listing(uuid)',
    'ecom_team()', 'ecom_cron_tick()'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
  end loop;
  -- for signed-in staff (each checks access itself)
  foreach f in array array['ecom_can_access()', 'ecom_can_configure()', 'ecom_connection_status()', 'ecom_save_connection(text, text, text, text, text, text)',
    'ecom_set_threshold(int, text)', 'ecom_dashboard(date, date)', 'ecom_inventory_report(date, date, text, text)',
    'ecom_save_listing(uuid, text, text, text, text, uuid, uuid, date, text)', 'ecom_set_listing_status(uuid, text, text)', 'ecom_remove_listing(uuid)', 'ecom_team()'] loop
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
  -- for the shopify-sync server function only
  foreach f in array array['ecom_get_credentials()', 'ecom_record_test(boolean, jsonb, text)', 'ecom_sync_start(text, text, uuid)',
    'ecom_sync_finish(uuid, text, jsonb, text, jsonb, timestamptz)', 'ecom_ingest_locations(jsonb)', 'ecom_ingest_products(jsonb)', 'ecom_mark_product_deleted(text)',
    'ecom_ingest_inventory(jsonb, text)', 'ecom_remove_inventory_level(text, text, text)', 'ecom_ingest_orders(jsonb)', 'ecom_webhook_receive(text, text, text, timestamptz)',
    'ecom_webhook_done(text, text, text)', 'ecom_webhooks_to_retry()', 'ecom_can_access()', 'ecom_eval_alerts(text, boolean)'] loop
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $$;
