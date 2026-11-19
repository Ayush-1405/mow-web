-- Due dates, deadline visibility and automatic reminders for Procurement orders.
--
-- Nothing here depends on a browser being open: pg_cron runs public.proc_run_reminders() every 15 minutes inside the
-- database. Each reminder becomes a row in `notifications` (in-app bell + realtime), and the existing
-- notifications_push_trigger sends it as a phone push through the send-push Edge Function.
--
-- Reminder rules (all times Asia/Kolkata):
--   Waiting for acceptance (SENT_TO_PROCUREMENT): on arrival, after 2 h, after 24 h (escalation to the Procurement Head),
--     then once a day.
--   Accepted, Order Placed not yet confirmed (ACCEPTED_BY_PROCUREMENT / DOCUMENT_GENERATED): on acceptance, after 24 h
--     (escalation to the Procurement Head), then once a day.
--   Due date (any open stage with Procurement until delivered): 3 days before, 1 day before, on the day, then daily
--     while overdue. Overdue 2 days -> Management. Overdue 5 days -> critical: Management + the department's Head.
--   Arrival and acceptance messages go out immediately; all timed reminders respect the working days, holidays and
--     reminder hours in procurement_settings and wait for the next working window.
--
-- Duplicates are impossible: procurement_reminders has one row per (order, reminder kind, cycle, recipient). A stage that
-- is entered again (resumed from hold, resubmitted) starts a new cycle. Every reminder, its delivery and push status and
-- retries are kept in procurement_reminders; each run is logged in procurement_reminder_runs.
-- Order statuses are never changed by the reminder job (an overdue order is flagged with overdue_since and a history
-- note, not moved to another status).

begin;

-- ---------------------------------------------------------------------------
-- 1. Structure
-- ---------------------------------------------------------------------------

alter table public.purchase_requests
  add column if not exists proc_assigned_to uuid references public.user_profiles(id) on delete set null,
  add column if not exists overdue_since date;
create index if not exists purchase_requests_due_open_idx on public.purchase_requests (required_by_date) where proc_status <> 'LEGACY';

-- Reminder rules. Working days are ISO weekdays (1 = Monday ... 7 = Sunday); the default is Monday to Saturday, 9 am to 7 pm.
alter table public.procurement_settings
  add column if not exists reminders_enabled boolean not null default true,
  add column if not exists reminder_working_days smallint[] not null default '{1,2,3,4,5,6}',
  add column if not exists reminder_window_start time not null default '09:00',
  add column if not exists reminder_window_end time not null default '19:00';

create table if not exists public.procurement_holidays (
  holiday_date date primary key,
  name text not null,
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.procurement_reminders (
  id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid not null references public.purchase_requests(id) on delete cascade,
  kind text not null,
  cycle_key text not null,
  recipient_id uuid not null references public.user_profiles(id) on delete cascade,
  message_en text not null,
  message_gu text not null,
  -- PENDING while being written, SENT once the notification exists, FAILED (retried by the next run), GAVE_UP after
  -- 5 attempts, STOPPED when the order left that stage before a retry succeeded.
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'FAILED', 'GAVE_UP', 'STOPPED')),
  attempts integer not null default 0,
  last_error text,
  notification_id uuid references public.notifications(id) on delete set null,
  push_status text,
  push_attempts integer not null default 0,
  read_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (purchase_request_id, kind, cycle_key, recipient_id)
);
create index if not exists procurement_reminders_req_idx on public.procurement_reminders (purchase_request_id, created_at);
create index if not exists procurement_reminders_retry_idx on public.procurement_reminders (status) where status = 'FAILED';
create index if not exists procurement_reminders_notification_idx on public.procurement_reminders (notification_id) where notification_id is not null;

create table if not exists public.procurement_reminder_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  in_working_window boolean,
  orders_checked integer not null default 0,
  reminders_sent integer not null default 0,
  retries_sent integer not null default 0,
  push_retries integer not null default 0,
  errors integer not null default 0,
  last_error text
);
create index if not exists procurement_reminder_runs_started_idx on public.procurement_reminder_runs (started_at desc);

alter table public.procurement_holidays enable row level security;
alter table public.procurement_reminders enable row level security;
alter table public.procurement_reminder_runs enable row level security;
revoke all on public.procurement_holidays, public.procurement_reminders, public.procurement_reminder_runs from anon, authenticated;
grant select on public.procurement_holidays, public.procurement_reminders to authenticated;

drop policy if exists procurement_holidays_select on public.procurement_holidays;
create policy procurement_holidays_select on public.procurement_holidays for select to authenticated using (public.staff_current_user_ok());
-- Procurement and Management see every reminder; anyone else sees the reminders that were sent to them.
drop policy if exists procurement_reminders_select on public.procurement_reminders;
create policy procurement_reminders_select on public.procurement_reminders for select to authenticated
  using (public.staff_current_user_ok() and (recipient_id = auth.uid() or public.proc_is_procurement_member() or public.staff_has_global_oversight()));

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------

create or replace function public.proc_today_ist()
returns date language sql stable set search_path to 'public' as $$
  select (now() at time zone 'Asia/Kolkata')::date;
$$;

-- Statuses in which an order's due date is being watched: with Procurement and not yet delivered. On hold, cancelled,
-- rejected, delivered and completed orders get no due-date reminders.
create or replace function public.proc_due_watch_statuses()
returns text[] language sql immutable set search_path to 'public' as $$
  select array['SENT_TO_PROCUREMENT', 'CLARIFICATION_REQUIRED', 'ACCEPTED_BY_PROCUREMENT', 'DOCUMENT_GENERATED', 'ORDER_PLACED', 'VENDOR_CONFIRMED',
               'IN_PRODUCTION', 'READY_FOR_DISPATCH', 'IN_TRANSIT', 'DELAYED', 'PARTIALLY_RECEIVED'];
$$;

-- Whether a reminder of this kind still applies to an order in this status (used to stop retries of stale reminders).
create or replace function public.proc_reminder_still_due(p_kind text, p_status text)
returns boolean language sql immutable set search_path to 'public' as $$
  select case when p_kind like 'ACCEPT%' then p_status = 'SENT_TO_PROCUREMENT'
              when p_kind like 'PLACE%' then p_status in ('ACCEPTED_BY_PROCUREMENT', 'DOCUMENT_GENERATED')
              else p_status = any(public.proc_due_watch_statuses()) end;
$$;

-- The Procurement Head who receives reminders and escalations: the primary head from settings, else the longest-serving
-- active Procurement Department Head. Unlike proc_procurement_contact() this needs no signed-in user (the cron job has none).
create or replace function public.proc_procurement_head_user()
returns uuid language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    (select up.id from public.procurement_settings s join public.user_profiles up on up.id = s.primary_head_user_id
      where s.id and up.is_active and up.department_id = public.factory_procurement_dept_id()),
    (select up.id from public.user_profiles up join public.roles r on r.id = up.role_id
      where up.is_active and up.department_id = public.factory_procurement_dept_id() and r.code = 'dept_head'
      order by up.created_at limit 1));
$$;

-- PROCUREMENT: Procurement Head + the assigned Procurement staff (the whole Procurement team while nobody is assigned).
-- OVERDUE: PROCUREMENT + the requesting department's Heads + the project's manager. MANAGEMENT: Management.
-- CRITICAL: Management + the requesting department's Heads.
create or replace function public.proc_reminder_recipients(p_row public.purchase_requests, p_group text)
returns uuid[] language plpgsql stable security definer set search_path to 'public' as $$
declare v uuid[] := '{}';
begin
  if p_group in ('PROCUREMENT', 'OVERDUE') then
    v := array[public.proc_procurement_head_user()];
    if p_row.proc_assigned_to is not null and exists (select 1 from public.user_profiles where id = p_row.proc_assigned_to and is_active) then
      v := v || p_row.proc_assigned_to;
    else
      v := v || public.proc_procurement_team();
    end if;
  end if;
  if p_group = 'OVERDUE' then
    v := v || public.proc_department_heads(p_row.requesting_department_id);
    if p_row.project_id is not null then v := v || public.proc_project_manager_user(p_row.project_id); end if;
  elsif p_group = 'MANAGEMENT' then
    v := public.proc_management_users();
  elsif p_group = 'CRITICAL' then
    v := public.proc_management_users() || public.proc_department_heads(p_row.requesting_department_id);
  end if;
  return coalesce((select array_agg(distinct x) from unnest(v) x where x is not null), '{}');
end $$;

-- Is `p_at` inside the reminder hours on a working day that is not a company holiday?
create or replace function public.proc_reminder_time_ok(p_at timestamptz)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((
    select s.reminders_enabled
       and extract(isodow from (p_at at time zone 'Asia/Kolkata'))::smallint = any(s.reminder_working_days)
       and not exists (select 1 from public.procurement_holidays h where h.holiday_date = (p_at at time zone 'Asia/Kolkata')::date)
       and (p_at at time zone 'Asia/Kolkata')::time between s.reminder_window_start and s.reminder_window_end
      from public.procurement_settings s where s.id), false);
$$;

create or replace function public.proc_status_label(p_status text)
returns text language sql immutable set search_path to 'public' as $$
  select case p_status
    when 'SENT_TO_PROCUREMENT' then 'Pending Procurement' when 'CLARIFICATION_REQUIRED' then 'Clarification Required'
    when 'ACCEPTED_BY_PROCUREMENT' then 'Accepted - Awaiting Print' when 'DOCUMENT_GENERATED' then 'Printed - Awaiting Order Placed'
    when 'ORDER_PLACED' then 'Order Placed' when 'VENDOR_CONFIRMED' then 'Vendor Confirmed' when 'IN_PRODUCTION' then 'In Production'
    when 'READY_FOR_DISPATCH' then 'Ready for Dispatch' when 'IN_TRANSIT' then 'In Transit' when 'DELAYED' then 'Delayed'
    when 'PARTIALLY_RECEIVED' then 'Partially Delivered' when 'RECEIVED' then 'Delivered' when 'ON_HOLD' then 'On Hold'
    when 'CLOSED' then 'Completed' when 'CANCELLED' then 'Cancelled'
    else initcap(replace(coalesce(p_status, ''), '_', ' ')) end;
$$;

create or replace function public.proc_age_text(p interval)
returns text language sql immutable set search_path to 'public' as $$
  select case when p < interval '1 hour' then greatest(floor(extract(epoch from p) / 60), 0)::int || ' min'
              when p < interval '48 hours' then floor(extract(epoch from p) / 3600)::int || ' h'
              else floor(extract(epoch from p) / 86400)::int || ' days' end;
$$;

create or replace function public.proc_due_text(p_due date, p_today date)
returns text language sql immutable set search_path to 'public' as $$
  select case when p_due is null then 'No due date'
    else 'Due ' || to_char(p_due, 'DD-MM-YYYY') || case
      when p_due - p_today > 1 then ' (in ' || (p_due - p_today) || ' days)'
      when p_due - p_today = 1 then ' (tomorrow)'
      when p_due = p_today then ' (today)'
      when p_today - p_due = 1 then ' (1 day overdue)'
      else ' (' || (p_today - p_due) || ' days overdue)' end end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Sending: one log row per recipient, then the notification
-- ---------------------------------------------------------------------------

-- Creates the notification for one reminder row. A failure is recorded (not raised) so one bad recipient never stops the
-- rest; the next run retries it, up to 5 attempts.
create or replace function public.proc_deliver_reminder(p_reminder_id uuid)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare v_r public.procurement_reminders; v_nid uuid;
begin
  select * into v_r from public.procurement_reminders where id = p_reminder_id for update;
  if v_r.id is null or v_r.status not in ('PENDING', 'FAILED') then return false; end if;
  begin
    if not exists (select 1 from public.user_profiles where id = v_r.recipient_id and is_active) then
      raise exception 'Recipient is not an active user';
    end if;
    insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
    values (v_r.recipient_id, 'PURCHASE_REQUEST', v_r.purchase_request_id, v_r.message_en, v_r.message_gu)
    returning id into v_nid;
    update public.procurement_reminders set status = 'SENT', notification_id = v_nid, sent_at = now(), attempts = attempts + 1,
      push_status = 'pending', last_error = null, updated_at = now() where id = p_reminder_id;
    return true;
  exception when others then
    update public.procurement_reminders set status = case when attempts + 1 >= 5 then 'GAVE_UP' else 'FAILED' end, attempts = attempts + 1,
      last_error = left(sqlerrm, 500), updated_at = now() where id = p_reminder_id;
    return false;
  end;
end $$;

-- Sends one reminder to each recipient who has not had this exact reminder (order + kind + cycle) before.
create or replace function public.proc_send_reminder(p_row public.purchase_requests, p_kind text, p_cycle text, p_recipients uuid[], p_en text, p_gu text)
returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_user uuid; v_log uuid; v_sent integer := 0;
begin
  for v_user in select distinct x from unnest(coalesce(p_recipients, '{}')) x where x is not null loop
    v_log := null;
    insert into public.procurement_reminders (purchase_request_id, kind, cycle_key, recipient_id, message_en, message_gu)
    values (p_row.id, p_kind, p_cycle, v_user, p_en, p_gu)
    on conflict (purchase_request_id, kind, cycle_key, recipient_id) do nothing
    returning id into v_log;
    continue when v_log is null;
    if public.proc_deliver_reminder(v_log) then v_sent := v_sent + 1; end if;
  end loop;
  return v_sent;
end $$;

-- Sends a failed phone push again (same body as notifications_push_trigger). The in-app notification itself is not
-- duplicated. Skipped quietly where push is not configured.
create or replace function public.proc_retry_push(p_reminder_id uuid)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare v_r public.procurement_reminders; v_n public.notifications; v_secret text;
begin
  select * into v_r from public.procurement_reminders where id = p_reminder_id for update;
  select * into v_n from public.notifications where id = v_r.notification_id;
  if v_n.id is null then return false; end if;
  update public.procurement_reminders set push_attempts = push_attempts + 1, push_status = 'retrying', updated_at = now() where id = p_reminder_id;
  select value into v_secret from public.app_secrets where key = 'PUSH_TRIGGER_SECRET';
  if v_secret is null then return false; end if;
  update public.notifications set delivery_status = 'pending' where id = v_n.id;
  begin
    perform net.http_post(
      url := 'https://bykmyttaesuyjwvtnxks.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret),
      body := jsonb_build_object('id', v_n.id, 'recipient_id', v_n.recipient_id, 'title_en', v_n.title_en, 'title_gu', v_n.title_gu,
        'entity_type', v_n.entity_type, 'entity_id', v_n.entity_id, 'url', public.notification_deep_link(v_n.entity_type, v_n.entity_id, v_n.task_id)),
      timeout_milliseconds := 5000);
  exception when others then
    update public.procurement_reminders set last_error = left('push retry: ' || sqlerrm, 500) where id = p_reminder_id;
    return false;
  end;
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- 4. The rules for one order
-- ---------------------------------------------------------------------------

-- p_immediate_only: only the on-arrival / on-acceptance messages (used the moment the status changes). Otherwise also
-- every timed reminder that is due now (used by the scheduled run). Returns the number of notifications sent.
create or replace function public.proc_check_order_reminders(p_request_id uuid, p_immediate_only boolean default false)
returns integer language plpgsql security definer set search_path to 'public' as $$
declare
  r public.purchase_requests; v_now timestamptz := now(); v_today date := public.proc_today_ist(); v_ok boolean;
  v_entry uuid; v_start timestamptz; v_age interval; v_days integer; v_sent integer := 0;
  v_dept text; v_head text; v_due text; v_status text; v_open text; v_prio text;
  v_team uuid[]; v_cycle text;
begin
  select * into r from public.purchase_requests where id = p_request_id;
  if r.id is null or r.proc_status is null or r.proc_status = 'LEGACY' then return 0; end if;
  v_ok := public.proc_reminder_time_ok(v_now) and not coalesce(p_immediate_only, false);
  select d.name_en into v_dept from public.departments d where d.id = r.requesting_department_id;
  v_head := 'Order ' || r.request_number || ' (' || coalesce(v_dept, 'Department') || ')';
  v_due := public.proc_due_text(r.required_by_date, v_today);
  v_status := 'Status: ' || public.proc_status_label(r.proc_status);
  v_prio := case when coalesce(r.priority, 'NORMAL') not in ('NORMAL', 'LOW') then ' Priority: ' || initcap(r.priority) || '.' else '' end;
  v_open := case when r.sent_to_procurement_at is not null then ' With Procurement for ' || public.proc_age_text(v_now - r.sent_to_procurement_at) || '.' else '' end;
  v_team := public.proc_reminder_recipients(r, 'PROCUREMENT');

  -- 4a. Waiting for Procurement to accept. The stage starts at the latest move into SENT_TO_PROCUREMENT, so an order
  --     resumed from hold or resubmitted starts a fresh cycle.
  if r.proc_status = 'SENT_TO_PROCUREMENT' then
    select h.id, h.created_at into v_entry, v_start from public.purchase_request_status_history h
     where h.purchase_request_id = r.id and h.to_status = 'SENT_TO_PROCUREMENT' and h.from_status is distinct from h.to_status
     order by h.created_at desc limit 1;
    v_start := coalesce(v_start, r.sent_to_procurement_at, v_now);
    v_cycle := coalesce(v_entry::text, to_char(v_start, 'YYYYMMDDHH24MISS'));
    v_age := v_now - v_start;
    v_sent := v_sent + public.proc_send_reminder(r, 'ACCEPT_NEW', v_cycle, v_team,
      'New order: ' || v_head || ' is waiting for Procurement. ' || v_due || '.' || v_prio || ' ' || v_status || '. Action: accept, reject or return it.',
      'નવો ઓર્ડર ' || r.request_number || ' ખરીદી વિભાગ પાસે બાકી. ડ્યુ ' || coalesce(to_char(r.required_by_date, 'DD-MM-YYYY'), '-') || '. સ્વીકારો, નામંજૂર કરો અથવા પરત કરો.');
    if v_ok then
      if v_age >= interval '2 hours' and v_age < interval '24 hours' then
        v_sent := v_sent + public.proc_send_reminder(r, 'ACCEPT_2H', v_cycle, v_team,
          'Reminder: ' || v_head || ' is still not accepted - pending ' || public.proc_age_text(v_age) || '. ' || v_due || '.' || v_prio || ' ' || v_status || '. Action: accept, reject or return it.',
          'રિમાઇન્ડર: ઓર્ડર ' || r.request_number || ' હજુ સ્વીકાર્યો નથી (' || public.proc_age_text(v_age) || '). ડ્યુ ' || coalesce(to_char(r.required_by_date, 'DD-MM-YYYY'), '-'));
      end if;
      if v_age >= interval '24 hours' then
        v_sent := v_sent + public.proc_send_reminder(r, 'ACCEPT_24H', v_cycle, v_team,
          'ESCALATION: ' || v_head || ' has not been accepted for ' || public.proc_age_text(v_age) || '. ' || v_due || '.' || v_prio || ' ' || v_status || '. Action: Procurement Head, accept, reject or return it today.',
          'એસ્કેલેશન: ઓર્ડર ' || r.request_number || ' ' || public.proc_age_text(v_age) || ' થી સ્વીકાર્યો નથી. ડ્યુ ' || coalesce(to_char(r.required_by_date, 'DD-MM-YYYY'), '-'));
        -- Then once a day, from the day after the 24-hour mark, and never twice on the same day.
        if v_today > ((v_start + interval '24 hours') at time zone 'Asia/Kolkata')::date
           and not exists (select 1 from public.procurement_reminders x where x.purchase_request_id = r.id and x.kind in ('ACCEPT_24H', 'ACCEPT_DAILY')
                             and x.cycle_key like v_cycle || '%' and (x.created_at at time zone 'Asia/Kolkata')::date = v_today) then
          v_sent := v_sent + public.proc_send_reminder(r, 'ACCEPT_DAILY', v_cycle || ':' || v_today, v_team,
            'Daily reminder: ' || v_head || ' is still waiting for acceptance - pending ' || public.proc_age_text(v_age) || '. ' || v_due || '.' || v_prio || ' ' || v_status || '. Action: accept, reject or return it.',
            'દૈનિક રિમાઇન્ડર: ઓર્ડર ' || r.request_number || ' સ્વીકાર બાકી (' || public.proc_age_text(v_age) || ')');
        end if;
      end if;
    end if;
  end if;

  -- 4b. Accepted, Order Placed not yet confirmed. The stage starts at the latest acceptance.
  if r.proc_status in ('ACCEPTED_BY_PROCUREMENT', 'DOCUMENT_GENERATED') then
    select h.id, h.created_at into v_entry, v_start from public.purchase_request_status_history h
     where h.purchase_request_id = r.id and h.to_status = 'ACCEPTED_BY_PROCUREMENT' and h.from_status is distinct from h.to_status
     order by h.created_at desc limit 1;
    v_start := coalesce(v_start, r.proc_decided_at, v_now);
    v_cycle := coalesce(v_entry::text, to_char(v_start, 'YYYYMMDDHH24MISS'));
    v_age := v_now - v_start;
    v_sent := v_sent + public.proc_send_reminder(r, 'PLACE_NOW', v_cycle, v_team,
      'Accepted: ' || v_head || ' - next, print the order form and confirm Order Placed. ' || v_due || '.' || v_prio || ' ' || v_status || '.',
      'સ્વીકાર્યું: ઓર્ડર ' || r.request_number || ' - હવે પ્રિન્ટ કરી ઓર્ડર મૂકાયો તેની પુષ્ટિ કરો. ડ્યુ ' || coalesce(to_char(r.required_by_date, 'DD-MM-YYYY'), '-'));
    if v_ok and v_age >= interval '24 hours' then
      v_sent := v_sent + public.proc_send_reminder(r, 'PLACE_24H', v_cycle, v_team,
        'ESCALATION: ' || v_head || ' was accepted ' || public.proc_age_text(v_age) || ' ago but the order is not placed yet. ' || v_due || '.' || v_prio || ' ' || v_status || '. Action: place the order and confirm Order Placed.',
        'એસ્કેલેશન: ઓર્ડર ' || r.request_number || ' સ્વીકાર્યા પછી ' || public.proc_age_text(v_age) || ' થી ઓર્ડર મૂકાયો નથી');
      if v_today > ((v_start + interval '24 hours') at time zone 'Asia/Kolkata')::date
         and not exists (select 1 from public.procurement_reminders x where x.purchase_request_id = r.id and x.kind in ('PLACE_24H', 'PLACE_DAILY')
                           and x.cycle_key like v_cycle || '%' and (x.created_at at time zone 'Asia/Kolkata')::date = v_today) then
        v_sent := v_sent + public.proc_send_reminder(r, 'PLACE_DAILY', v_cycle || ':' || v_today, v_team,
          'Daily reminder: ' || v_head || ' - Order Placed is still not confirmed, ' || public.proc_age_text(v_age) || ' after acceptance. ' || v_due || '.' || v_prio || ' ' || v_status || '.',
          'દૈનિક રિમાઇન્ડર: ઓર્ડર ' || r.request_number || ' હજુ મૂકાયો નથી');
      end if;
    end if;
  end if;

  -- 4c. The due date, for every open stage until the goods are delivered. Cycles are keyed on the due date itself, so a
  --     corrected due date gets its own reminders.
  if not coalesce(p_immediate_only, false) and r.proc_status = any(public.proc_due_watch_statuses()) and r.required_by_date is not null then
    v_days := r.required_by_date - v_today;
    if v_days < 0 and r.overdue_since is null then
      -- Flag it OVERDUE (the status itself is never changed) and say so in the order's history. Done at any hour.
      update public.purchase_requests set overdue_since = r.required_by_date + 1 where id = r.id;
      insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
      values (r.id, r.proc_status, r.proc_status, null, 'system', 'OVERDUE: due date ' || to_char(r.required_by_date, 'DD-MM-YYYY') || ' has passed');
    elsif v_days >= 0 and r.overdue_since is not null then
      update public.purchase_requests set overdue_since = null where id = r.id;
    end if;
    if v_ok then
      if v_days between 2 and 3 then
        v_sent := v_sent + public.proc_send_reminder(r, 'DUE_3D', r.required_by_date::text, v_team,
          'Due soon: ' || v_head || '. ' || v_due || '.' || v_prio || ' ' || v_status || '.' || v_open || ' Action: make sure it is delivered on time.',
          'ડ્યુ નજીક: ઓર્ડર ' || r.request_number || ', ડ્યુ ' || to_char(r.required_by_date, 'DD-MM-YYYY') || ' (' || v_days || ' દિવસ)');
      elsif v_days = 1 then
        v_sent := v_sent + public.proc_send_reminder(r, 'DUE_1D', r.required_by_date::text, v_team,
          'Due tomorrow: ' || v_head || '. ' || v_due || '.' || v_prio || ' ' || v_status || '.' || v_open || ' Action: confirm delivery for tomorrow.',
          'આવતીકાલે ડ્યુ: ઓર્ડર ' || r.request_number || ', ' || to_char(r.required_by_date, 'DD-MM-YYYY'));
      elsif v_days = 0 then
        v_sent := v_sent + public.proc_send_reminder(r, 'DUE_TODAY', r.required_by_date::text, v_team,
          'Due today: ' || v_head || '. ' || v_due || '.' || v_prio || ' ' || v_status || '.' || v_open || ' Action: deliver today or record the delay.',
          'આજે ડ્યુ: ઓર્ડર ' || r.request_number);
      elsif v_days < 0 then
        v_sent := v_sent + public.proc_send_reminder(r, 'OVERDUE', r.required_by_date::text || ':' || v_today, public.proc_reminder_recipients(r, 'OVERDUE'),
          'OVERDUE: ' || v_head || '. ' || v_due || '.' || v_prio || ' ' || v_status || '.' || v_open || ' Action: deliver it, or record the delay reason and new expected date.',
          'મુદત વીતી: ઓર્ડર ' || r.request_number || ', ડ્યુ ' || to_char(r.required_by_date, 'DD-MM-YYYY') || ' (' || (-v_days) || ' દિવસ મોડું)');
        if v_days <= -2 then
          v_sent := v_sent + public.proc_send_reminder(r, 'ESC_MGMT_2D', r.required_by_date::text, public.proc_reminder_recipients(r, 'MANAGEMENT'),
            'MANAGEMENT ESCALATION: ' || v_head || ' is ' || (-v_days) || ' days overdue. ' || v_due || '.' || v_prio || ' ' || v_status || '.' || v_open || ' Action: follow up with Procurement.',
            'મેનેજમેન્ટ એસ્કેલેશન: ઓર્ડર ' || r.request_number || ' ' || (-v_days) || ' દિવસ મોડો');
        end if;
        if v_days <= -5 then
          v_sent := v_sent + public.proc_send_reminder(r, 'ESC_CRITICAL_5D', r.required_by_date::text, public.proc_reminder_recipients(r, 'CRITICAL'),
            'CRITICAL: ' || v_head || ' is ' || (-v_days) || ' days overdue. ' || v_due || '.' || v_prio || ' ' || v_status || '.' || v_open || ' Action: Management and Department Head to decide next steps today.',
            'ગંભીર: ઓર્ડર ' || r.request_number || ' ' || (-v_days) || ' દિવસ મોડો');
        end if;
      end if;
    end if;
  end if;
  return v_sent;
end $$;

-- ---------------------------------------------------------------------------
-- 5. The scheduled run (pg_cron, every 15 minutes)
-- ---------------------------------------------------------------------------

create or replace function public.proc_run_reminders()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_run public.procurement_reminder_runs; v_id uuid; v_checked integer := 0; v_sent integer := 0; v_retried integer := 0;
  v_push integer := 0; v_errors integer := 0; v_last_error text;
begin
  insert into public.procurement_reminder_runs (in_working_window) values (public.proc_reminder_time_ok(now())) returning * into v_run;

  -- Failed reminders whose stage is over are stopped; the rest are retried (10 minutes apart, at most 5 attempts).
  update public.procurement_reminders x set status = 'STOPPED', updated_at = now()
    from public.purchase_requests r
   where r.id = x.purchase_request_id and x.status = 'FAILED' and not public.proc_reminder_still_due(x.kind, r.proc_status);
  for v_id in select id from public.procurement_reminders where status = 'FAILED' and updated_at < now() - interval '10 minutes' order by created_at limit 500 loop
    if public.proc_deliver_reminder(v_id) then v_retried := v_retried + 1; end if;
  end loop;

  -- New reminders for every open order. One order's error never stops the others.
  for v_id in select id from public.purchase_requests where proc_status = any(public.proc_due_watch_statuses()) order by required_by_date nulls last loop
    v_checked := v_checked + 1;
    begin
      v_sent := v_sent + public.proc_check_order_reminders(v_id, false);
    exception when others then
      v_errors := v_errors + 1; v_last_error := left(sqlerrm, 500);
    end;
  end loop;

  -- Delivery status: copy each notification's push status and read time into the reminder history (notifications are
  -- purged after 2 days; the history is kept), then retry failed phone pushes up to 3 times while the stage still applies.
  update public.procurement_reminders x set push_status = n.delivery_status, read_at = n.read_at, updated_at = now()
    from public.notifications n
   where n.id = x.notification_id and (x.push_status is distinct from n.delivery_status or x.read_at is distinct from n.read_at);
  for v_id in select x.id from public.procurement_reminders x
                join public.notifications n on n.id = x.notification_id
                join public.purchase_requests r on r.id = x.purchase_request_id
               where n.delivery_status = 'failed' and not n.is_read and x.push_attempts < 3 and public.proc_reminder_still_due(x.kind, r.proc_status)
               limit 200 loop
    if public.proc_retry_push(v_id) then v_push := v_push + 1; end if;
  end loop;

  delete from public.procurement_reminder_runs where started_at < now() - interval '30 days';
  update public.procurement_reminder_runs set finished_at = clock_timestamp(), orders_checked = v_checked, reminders_sent = v_sent,
    retries_sent = v_retried, push_retries = v_push, errors = v_errors, last_error = v_last_error
   where id = v_run.id;
  return jsonb_build_object('orders_checked', v_checked, 'reminders_sent', v_sent, 'retries_sent', v_retried, 'push_retries', v_push,
    'errors', v_errors, 'in_working_window', v_run.in_working_window);
end $$;

-- "Run now" for the Procurement Head and Management (the schedule does the same every 15 minutes).
create or replace function public.proc_run_reminders_now()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_head() or public.staff_has_global_oversight(), false) then
    raise exception 'Only the Procurement Head or Management can run the reminder check';
  end if;
  return public.proc_run_reminders();
end $$;

-- ---------------------------------------------------------------------------
-- 6. Immediate messages and automatic assignment when a stage is entered
-- ---------------------------------------------------------------------------

-- Fires when a status-history row records a move into SENT_TO_PROCUREMENT or ACCEPTED_BY_PROCUREMENT (the history row
-- is written right after the status changes, so the order is already in its new state here). On acceptance the person
-- who accepted becomes the assigned Procurement staff unless someone is assigned already.
create or replace function public.proc_on_stage_entered()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.to_status = 'ACCEPTED_BY_PROCUREMENT' then
    update public.purchase_requests set proc_assigned_to = coalesce(proc_decided_by, new.actor_id)
     where id = new.purchase_request_id and proc_assigned_to is null;
  end if;
  perform public.proc_check_order_reminders(new.purchase_request_id, true);
  return null;
end $$;
drop trigger if exists purchase_request_status_history_reminders on public.purchase_request_status_history;
create trigger purchase_request_status_history_reminders after insert on public.purchase_request_status_history
  for each row when (new.to_status in ('SENT_TO_PROCUREMENT', 'ACCEPTED_BY_PROCUREMENT') and new.from_status is distinct from new.to_status)
  execute function public.proc_on_stage_entered();

-- Department Head approval: the Procurement team's "new order" message now comes from the reminder system (with the due
-- date, priority and action, and logged), so it is no longer sent here as well. Otherwise unchanged from v3_01.
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
    update public.purchase_requests set sent_to_procurement_at = now() where id = p_request_id;
    perform public.proc_set_status(p_request_id, 'PENDING_DEPT_APPROVAL', 'APPROVED_BY_DEPT_HEAD', v_remarks);
    perform public.proc_set_status(p_request_id, 'APPROVED_BY_DEPT_HEAD', 'SENT_TO_PROCUREMENT', null);
    perform public.proc_notify_users(array[v_row.requester_user_id], p_request_id,
      'Your request ' || v_row.request_number || ' was approved and sent to Procurement (due ' || coalesce(to_char(v_row.required_by_date, 'DD-MM-YYYY'), '-') || ')',
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

-- Emergency approval: same change -- the Procurement team hears through the reminder system. Otherwise unchanged from v3_02.
create or replace function public.proc_emergency_decision(p_request_id uuid, p_decision text, p_remarks text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_remarks text := nullif(btrim(coalesce(p_remarks, '')), '');
begin
  perform public.staff_assert_operational();
  if not coalesce(public.staff_has_global_oversight(), false) then raise exception 'Only Management can decide an emergency purchase'; end if;
  v_row := public.proc_lock_request(p_request_id);
  if v_row.proc_status <> 'EMERGENCY_APPROVAL_PENDING' then raise exception 'This request is not waiting for emergency approval'; end if;
  if v_row.requester_user_id = auth.uid() then raise exception 'You cannot approve your own request'; end if;
  if p_decision = 'REJECT' and v_remarks is null then raise exception 'A reason is required'; end if;
  update public.purchase_requests set emergency_decided_by = auth.uid(), emergency_decided_at = now(),
    dept_decided_by = auth.uid(), dept_decided_at = now(), dept_decision_remarks = v_remarks where id = p_request_id;
  if p_decision = 'APPROVE' then
    update public.purchase_requests set sent_to_procurement_at = now() where id = p_request_id;
    perform public.proc_set_status(p_request_id, 'EMERGENCY_APPROVAL_PENDING', 'SENT_TO_PROCUREMENT', coalesce(v_remarks, 'Emergency approved'));
    perform public.proc_notify_users(public.proc_department_heads(v_row.requesting_department_id) || array[v_row.requester_user_id], p_request_id,
      'EMERGENCY approved, now with Procurement: ' || v_row.request_number || ' ' || v_row.material_name, 'તાત્કાલિક ખરીદી મંજૂર: ' || v_row.request_number);
  elsif p_decision = 'REJECT' then
    perform public.proc_set_status(p_request_id, 'EMERGENCY_APPROVAL_PENDING', 'EMERGENCY_REJECTED', v_remarks);
    perform public.proc_notify_users(array[v_row.requester_user_id], p_request_id, 'Emergency request ' || v_row.request_number || ' rejected: ' || v_remarks,
      'તાત્કાલિક વિનંતી નામંજૂર: ' || v_row.request_number);
  else
    raise exception 'Decision must be APPROVE or REJECT';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Assignment, reminder settings and holidays
-- ---------------------------------------------------------------------------

create or replace function public.proc_assign_request(p_request_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_row public.purchase_requests; v_name text;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_authorized() or public.staff_has_global_oversight(), false) then
    raise exception 'Only the Procurement Head, a Procurement Supervisor or Management can assign orders';
  end if;
  v_row := public.proc_lock_request(p_request_id);
  if not (v_row.proc_status = any(public.proc_due_watch_statuses())) then raise exception 'Only an open order with Procurement can be assigned'; end if;
  select full_name into v_name from public.user_profiles
   where id = p_user_id and is_active and department_id = public.factory_procurement_dept_id();
  if v_name is null then raise exception 'Assign the order to an active Procurement staff member'; end if;
  update public.purchase_requests set proc_assigned_to = p_user_id where id = p_request_id;
  insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
  values (p_request_id, v_row.proc_status, v_row.proc_status, auth.uid(), public.staff_current_role_code(), 'Assigned to ' || v_name);
  perform public.staff_write_audit('purchase_request', p_request_id, 'ASSIGN', jsonb_build_object('proc_assigned_to', v_row.proc_assigned_to),
    jsonb_build_object('proc_assigned_to', p_user_id), v_row.requesting_department_id, null);
  perform public.proc_notify_users(array[p_user_id], p_request_id,
    'Order ' || v_row.request_number || ' is assigned to you. ' || public.proc_due_text(v_row.required_by_date, public.proc_today_ist()) || '. '
      || 'Status: ' || public.proc_status_label(v_row.proc_status) || '.',
    'ઓર્ડર ' || v_row.request_number || ' તમને સોંપાયો');
end $$;

create or replace function public.proc_set_reminder_settings(p_enabled boolean, p_working_days smallint[], p_start time, p_end time)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v_old jsonb;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_head() or public.staff_has_global_oversight(), false) then
    raise exception 'Only the Procurement Head or Management can change reminder settings';
  end if;
  if p_working_days is null or cardinality(p_working_days) = 0 or exists (select 1 from unnest(p_working_days) d where d not between 1 and 7) then
    raise exception 'Choose at least one working day';
  end if;
  if p_start is null or p_end is null or p_start >= p_end then raise exception 'Reminder hours: the start must be before the end'; end if;
  select jsonb_build_object('enabled', reminders_enabled, 'days', reminder_working_days, 'start', reminder_window_start, 'end', reminder_window_end)
    into v_old from public.procurement_settings where id;
  update public.procurement_settings set reminders_enabled = coalesce(p_enabled, true),
    reminder_working_days = (select array_agg(distinct d order by d) from unnest(p_working_days) d),
    reminder_window_start = p_start, reminder_window_end = p_end, updated_by = auth.uid(), updated_at = now()
   where id;
  perform public.staff_write_audit('procurement_settings', public.factory_procurement_dept_id(), 'REMINDER_SETTINGS', v_old,
    jsonb_build_object('enabled', p_enabled, 'days', p_working_days, 'start', p_start, 'end', p_end), public.factory_procurement_dept_id(), null);
end $$;

create or replace function public.proc_set_holiday(p_date date, p_name text, p_remove boolean default false)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_head() or public.staff_has_global_oversight(), false) then
    raise exception 'Only the Procurement Head or Management can change holidays';
  end if;
  if p_date is null then raise exception 'Choose the holiday date'; end if;
  if coalesce(p_remove, false) then
    delete from public.procurement_holidays where holiday_date = p_date;
  else
    if btrim(coalesce(p_name, '')) = '' then raise exception 'Give the holiday a name'; end if;
    insert into public.procurement_holidays (holiday_date, name, created_by) values (p_date, btrim(p_name), auth.uid())
    on conflict (holiday_date) do update set name = excluded.name, created_by = excluded.created_by;
  end if;
  perform public.staff_write_audit('procurement_holidays', public.factory_procurement_dept_id(), case when coalesce(p_remove, false) then 'REMOVE_HOLIDAY' else 'SET_HOLIDAY' end, null,
    jsonb_build_object('date', p_date, 'name', p_name), public.factory_procurement_dept_id(), null);
end $$;

-- Same as v3_01, except the audit row: staff_audit_log.entity_id is NOT NULL, so the old null made this always fail and
-- the primary Procurement Head could never be set. The Procurement department's id is the entity now.
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
  perform public.staff_write_audit('procurement_settings', public.factory_procurement_dept_id(), 'SET_PRIMARY_HEAD', null,
    jsonb_build_object('user_id', p_user_id), public.factory_procurement_dept_id());
end $$;

-- What the Reminders page shows: settings, upcoming holidays, whether the schedule exists, and the last run. The page
-- warns when the schedule is missing or has not run for 30 minutes, so nobody assumes reminders work when they don't.
create or replace function public.proc_reminder_overview()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_s public.procurement_settings; v_cron boolean := false; v_last public.procurement_reminder_runs;
begin
  if not coalesce(public.proc_is_procurement_member() or public.staff_has_global_oversight(), false) then
    raise exception 'Only Procurement or Management can see reminder settings';
  end if;
  select * into v_s from public.procurement_settings where id;
  begin
    execute 'select exists (select 1 from cron.job where jobname = ''procurement-order-reminders'' and active)' into v_cron;
  exception when others then v_cron := false;
  end;
  select * into v_last from public.procurement_reminder_runs order by started_at desc limit 1;
  return jsonb_build_object(
    'enabled', v_s.reminders_enabled, 'working_days', to_jsonb(v_s.reminder_working_days),
    'window_start', to_char(v_s.reminder_window_start, 'HH24:MI'), 'window_end', to_char(v_s.reminder_window_end, 'HH24:MI'),
    'in_window_now', public.proc_reminder_time_ok(now()), 'schedule_active', v_cron,
    'head_user_id', public.proc_procurement_head_user(),
    'head_name', (select full_name from public.user_profiles where id = public.proc_procurement_head_user()),
    'last_run', case when v_last.id is null then null else jsonb_build_object('started_at', v_last.started_at, 'finished_at', v_last.finished_at,
      'orders_checked', v_last.orders_checked, 'reminders_sent', v_last.reminders_sent, 'retries_sent', v_last.retries_sent,
      'push_retries', v_last.push_retries, 'errors', v_last.errors, 'last_error', v_last.last_error) end,
    'holidays', coalesce((select jsonb_agg(jsonb_build_object('date', h.holiday_date, 'name', h.name) order by h.holiday_date)
                            from public.procurement_holidays h where h.holiday_date >= public.proc_today_ist() - 1), '[]'),
    'failed_count', (select count(*) from public.procurement_reminders where status = 'FAILED'),
    'gave_up_count', (select count(*) from public.procurement_reminders where status = 'GAVE_UP' and created_at > now() - interval '7 days'),
    'sent_today', (select count(*) from public.procurement_reminders where status = 'SENT'
                     and (sent_at at time zone 'Asia/Kolkata')::date = public.proc_today_ist()));
end $$;

-- ---------------------------------------------------------------------------
-- 8. Context for screens: add assignment, expected delivery, delay reason and the latest Procurement update, so the
--    requesting department sees where its order stands.
-- ---------------------------------------------------------------------------

drop function if exists public.proc_request_context(uuid[]);
create function public.proc_request_context(p_request_ids uuid[])
returns table (request_id uuid, department_code text, department_name text, requester_name text, requester_phone text,
  dept_approver_name text, procurement_decider_name text, order_confirmed_by_name text, project_code text, customer text, project_location text,
  department_head_name text, item_count integer, assigned_to_name text, expected_delivery_date date, delay_reason text,
  latest_update text, latest_update_at timestamptz, last_reminder_at timestamptz)
language sql stable security definer set search_path to 'public' as $$
  select r.id, d.code, d.name_en, rq.full_name, rq.phone, da.full_name, pd.full_name, oc.full_name, p.project_code, p.customer, p.location,
         public.staff_department_head_public(r.requesting_department_id),
         (select count(*)::int from public.purchase_request_items i where i.purchase_request_id = r.id),
         asg.full_name,
         (select po.expected_delivery_date from public.purchase_orders po where po.purchase_request_id = r.id and po.is_current limit 1),
         (select h.remarks from public.purchase_request_status_history h where h.purchase_request_id = r.id and h.to_status = 'DELAYED'
           and h.from_status is distinct from h.to_status order by h.created_at desc limit 1),
         lu.txt, lu.created_at,
         (select max(x.sent_at) from public.procurement_reminders x where x.purchase_request_id = r.id and x.status = 'SENT')
    from public.purchase_requests r
    left join public.departments d on d.id = r.requesting_department_id
    left join public.user_profiles rq on rq.id = r.requester_user_id
    left join public.user_profiles da on da.id = r.dept_decided_by
    left join public.user_profiles pd on pd.id = r.proc_decided_by
    left join public.user_profiles oc on oc.id = r.order_confirmed_by
    left join public.user_profiles asg on asg.id = r.proc_assigned_to
    left join public.projects p on p.id = r.project_id
    left join lateral (
      select public.proc_status_label(h.to_status) || coalesce(': ' || h.remarks, '') as txt, h.created_at
        from public.purchase_request_status_history h where h.purchase_request_id = r.id
       order by h.created_at desc limit 1) lu on true
   where r.id = any(p_request_ids) and public.proc_can_view_request(r.id);
$$;

-- ---------------------------------------------------------------------------
-- 9. Direct-write guard: the new Procurement columns can only change through the workflow functions too.
-- ---------------------------------------------------------------------------

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
    new.proc_assigned_to := null; new.overdue_since := null;
    return new;
  end if;
  if (new.proc_status, new.requesting_department_id, new.requester_user_id, new.dedupe_key, new.document_version, new.document_generated_at,
      new.dept_decided_by, new.dept_decided_at, new.proc_decided_by, new.proc_decided_at, new.sent_to_procurement_at, new.order_confirmed_by,
      new.order_confirmed_at, new.material_name, new.quantity, new.unit, new.required_by_date, new.is_emergency, new.proc_assigned_to, new.overdue_since)
     is distinct from
     (old.proc_status, old.requesting_department_id, old.requester_user_id, old.dedupe_key, old.document_version, old.document_generated_at,
      old.dept_decided_by, old.dept_decided_at, old.proc_decided_by, old.proc_decided_at, old.sent_to_procurement_at, old.order_confirmed_by,
      old.order_confirmed_at, old.material_name, old.quantity, old.unit, old.required_by_date, old.is_emergency, old.proc_assigned_to, old.overdue_since) then
    raise exception 'Procurement fields can only be changed through the Procurement workflow';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 10. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.proc_procurement_head_user(), public.proc_reminder_recipients(public.purchase_requests, text),
  public.proc_reminder_time_ok(timestamptz), public.proc_deliver_reminder(uuid),
  public.proc_send_reminder(public.purchase_requests, text, text, uuid[], text, text), public.proc_retry_push(uuid),
  public.proc_check_order_reminders(uuid, boolean), public.proc_run_reminders(), public.proc_on_stage_entered()
  from public, anon, authenticated;
revoke all on function public.proc_run_reminders_now(), public.proc_assign_request(uuid, uuid),
  public.proc_set_reminder_settings(boolean, smallint[], time, time), public.proc_set_holiday(date, text, boolean),
  public.proc_reminder_overview(), public.proc_request_context(uuid[]), public.proc_dept_decision(uuid, text, text),
  public.proc_emergency_decision(uuid, text, text) from public, anon;
grant execute on function public.proc_run_reminders_now(), public.proc_assign_request(uuid, uuid),
  public.proc_set_reminder_settings(boolean, smallint[], time, time), public.proc_set_holiday(date, text, boolean),
  public.proc_reminder_overview(), public.proc_request_context(uuid[]), public.proc_dept_decision(uuid, text, text),
  public.proc_emergency_decision(uuid, text, text), public.proc_today_ist(), public.proc_due_text(date, date), public.proc_status_label(text),
  public.proc_age_text(interval), public.proc_due_watch_statuses(), public.proc_reminder_still_due(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Schedule: every 15 minutes. Without pg_cron nothing runs automatically -- say so loudly instead of pretending.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed: automatic Procurement reminders will NOT run. Enable pg_cron (Database > Extensions) and re-run section 11.';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'procurement-order-reminders';
  perform cron.schedule('procurement-order-reminders', '*/15 * * * *', 'select public.proc_run_reminders();');
end $$;

commit;
