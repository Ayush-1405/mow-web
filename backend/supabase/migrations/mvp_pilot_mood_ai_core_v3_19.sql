-- v3_19: Mood AI Core, Phase B -- the central switchboard every AI feature goes through.
--
--   mai_settings   one row: the emergency stop, which model answers chat / reads documents, approval expiry, monthly budget
--   mai_owners     who may approve owner-level actions: the Owner (Ayush Mistry) + at most one Backup the Owner adds
--   mai_agents     the Mood AI agents and whether each is switched on (agents not built yet cannot be switched on)
--   mai_models     connected models, price per million tokens, last health check
--   mai_usage      one row per AI call from ANY AI feature: model, tokens, cost, time, success (append-only)
--   mai_audit      every Mood AI administrative event: stop, resume, settings, owners, agents (append-only)
--
-- Owner-level actions need the Owner/Backup's own signed-in account AND a fresh authenticator-app check (Supabase MFA,
-- JWT claim aal = 'aal2'). A typed name is never proof. Stopping Mood AI is allowed for the Owner and Management (stopping
-- is always safe); resuming it is Owner-only. Nobody can change who the Owner is from the app -- that needs a database change.

create table if not exists public.mai_settings (
  id integer primary key default 1 check (id = 1),
  ai_enabled boolean not null default true,
  stop_reason text,
  stopped_by uuid references public.user_profiles(id),
  stopped_at timestamptz,
  chat_provider text not null default 'anthropic' check (chat_provider in ('anthropic', 'gemini')),
  chat_model text not null default 'claude-opus-5-5',
  chat_effort text not null default 'low' check (chat_effort in ('low', 'medium', 'high')),
  document_provider text not null default 'gemini' check (document_provider in ('anthropic', 'gemini')),
  document_model text not null default 'gemini-3.5-flash',
  approval_ttl_minutes integer not null default 15 check (approval_ttl_minutes between 2 and 240),
  monthly_budget_usd numeric check (monthly_budget_usd is null or monthly_budget_usd >= 0),
  updated_by uuid references public.user_profiles(id),
  updated_at timestamptz not null default now()
);
insert into public.mai_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.mai_owners (
  user_id uuid primary key references public.user_profiles(id),
  kind text not null check (kind in ('OWNER', 'BACKUP')),
  is_active boolean not null default true,
  added_by uuid references public.user_profiles(id),
  added_at timestamptz not null default now(),
  removed_by uuid references public.user_profiles(id),
  removed_at timestamptz
);
create unique index if not exists mai_owners_one_owner_uidx on public.mai_owners ((true)) where kind = 'OWNER' and is_active;
create unique index if not exists mai_owners_one_backup_uidx on public.mai_owners ((true)) where kind = 'BACKUP' and is_active;

-- The Owner: the one active Management account named "Ayush Mistry" (chosen by the owner on 2026-11-21).
do $$
declare v uuid; n int;
begin
  select count(*), min(u.id::text)::uuid into n, v from public.user_profiles u join public.roles r on r.id = u.role_id
   where u.is_active and not coalesce(u.is_deleted, false) and lower(btrim(u.full_name)) = 'ayush mistry' and public.staff_role_family(r.code) = 'management';
  if n = 1 and not exists (select 1 from public.mai_owners where kind = 'OWNER' and is_active) then
    insert into public.mai_owners (user_id, kind) values (v, 'OWNER') on conflict (user_id) do nothing;
  elsif n <> 1 then
    raise notice 'Mood AI owner not seeded: % matching accounts', n;
  end if;
end $$;

create table if not exists public.mai_agents (
  code text primary key,
  name text not null,
  description text not null,
  built_in_phase text not null,
  is_built boolean not null default false,
  enabled boolean not null default false,
  departments text[],            -- department codes the agent may work for; null = all
  updated_by uuid references public.user_profiles(id),
  updated_at timestamptz not null default now(),
  constraint mai_agents_enabled_needs_built check (is_built or not enabled)
);
insert into public.mai_agents (code, name, description, built_in_phase, is_built, enabled) values
  ('CORE', 'Mood AI Core', 'Model routing, cost tracking, health checks, stop switch and audit for every AI feature.', 'B', true, true),
  ('ASSISTANT', 'Mood AI Assistant', 'The floating chat on every page: understands questions and commands in English, Hindi and Hinglish.', 'C', false, false),
  ('TOOLS', 'Application tools', 'Reads real application data and prepares actions for approval, always as the signed-in user.', 'D', false, false),
  ('DEVELOPER', 'Developer agent', 'Turns change requests into a plan and, after Owner approval, a Claude Code pull request.', 'E', false, false),
  ('TESTER', 'Testing agent', 'Runs lint, unit, database and build checks on every pull request and reports honestly.', 'F', false, false),
  ('DEPLOYER', 'Deployment manager', 'Owner-approved backup, database change, release, health check and rollback.', 'G', false, false),
  ('PROCUREMENT', 'Procurement AI', 'Purchase requests, vendor suggestions, order follow-ups and due dates.', 'H', false, false),
  ('FACTORY', 'Factory AI', 'Job Cards, production progress, material needs and quality checks.', 'H', false, false),
  ('INTERIOR', 'Interior AI', 'Project tracking, purchase requests, site coordination and deadlines.', 'H', false, false),
  ('HR', 'HR AI', 'Employee records, attendance and performance reports.', 'H', false, false),
  ('ACCOUNTS', 'Accounts AI', 'Payment follow-ups and financial reports.', 'H', false, false),
  ('MANAGEMENT', 'Management AI', 'Company-wide reports, department performance and bottlenecks.', 'H', false, false)
on conflict (code) do nothing;

create table if not exists public.mai_models (
  provider text not null check (provider in ('anthropic', 'gemini')),
  model text not null,
  label text not null,
  good_for text not null,
  input_usd_per_mtok numeric check (input_usd_per_mtok is null or input_usd_per_mtok >= 0),
  output_usd_per_mtok numeric check (output_usd_per_mtok is null or output_usd_per_mtok >= 0),
  enabled boolean not null default true,
  last_ok_at timestamptz,
  last_latency_ms integer,
  last_error text,
  last_error_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (provider, model)
);
-- Anthropic first-party prices as published (USD per million tokens). Gemini: price left blank -- enter it in the Control Center.
insert into public.mai_models (provider, model, label, good_for, input_usd_per_mtok, output_usd_per_mtok) values
  ('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', 'Chat and commands, code review, hard reasoning', 4, 20),
  ('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 'Fast everyday chat and agent work', 2, 10),
  ('anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5', 'Cheapest and fastest; simple questions', 0.10, 0.50),
  ('gemini', 'gemini-3.5-flash', 'Google Gemini 3.5 Flash', 'Documents, photos and PDFs', null, null)
on conflict (provider, model) do nothing;

create table if not exists public.mai_usage (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid,
  feature text not null,
  provider text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric,               -- null when the model has no price set
  latency_ms integer,
  ok boolean not null,
  error text
);
create index if not exists mai_usage_at_idx on public.mai_usage (at desc);

create table if not exists public.mai_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor uuid,
  action text not null,
  detail jsonb
);
create index if not exists mai_audit_at_idx on public.mai_audit (at desc);

create or replace function public.mai_append_only() returns trigger language plpgsql set search_path to 'public' as $$
begin raise exception '% rows are permanent and cannot be changed or deleted', tg_table_name; end $$;
drop trigger if exists trg_mai_usage_append_only on public.mai_usage;
create trigger trg_mai_usage_append_only before update or delete on public.mai_usage for each row execute function public.mai_append_only();
drop trigger if exists trg_mai_audit_append_only on public.mai_audit;
create trigger trg_mai_audit_append_only before update or delete on public.mai_audit for each row execute function public.mai_append_only();
create or replace function public.mai_owner_guard() returns trigger language plpgsql set search_path to 'public' as $$
begin
  if tg_op = 'DELETE' then raise exception 'Owner records are permanent; deactivate instead'; end if;
  if old.kind = 'OWNER' and (new.kind <> 'OWNER' or not new.is_active or new.user_id <> old.user_id) and current_setting('mai.owner_change', true) is distinct from 'on' then
    raise exception 'The Owner cannot be changed from the app';
  end if;
  return new;
end $$;
drop trigger if exists trg_mai_owner_guard on public.mai_owners;
create trigger trg_mai_owner_guard before update or delete on public.mai_owners for each row execute function public.mai_owner_guard();

-- ---------------------------------------------------------------- who is asking
-- Owner or Backup, signed in as themselves; p_mfa = also verified with the authenticator app in this session.
create or replace function public.mai_is_owner(p_mfa boolean default true) returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.staff_current_user_ok()
    and exists (select 1 from public.mai_owners o where o.user_id = auth.uid() and o.is_active)
    and (not p_mfa or coalesce(auth.jwt() ->> 'aal', '') = 'aal2'), false) $$;

create or replace function public.mai_can_monitor() returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.mai_is_owner(false) or (public.staff_current_user_ok() and public.staff_has_global_oversight()), false) $$;

create or replace function public.mai_require_owner() returns void language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.mai_is_owner(false) then raise exception 'Only the Owner can do this'; end if;
  if not public.mai_is_owner(true) then raise exception 'Confirm with your authenticator app first (owner verification)'; end if;
end $$;

create or replace function public.mai_log(p_action text, p_detail jsonb) returns void language sql security definer set search_path to 'public' as $$
  insert into public.mai_audit (actor, action, detail) values (auth.uid(), p_action, p_detail) $$;

-- ---------------------------------------------------------------- server-side (edge functions, service role only)
create or replace function public.mai_runtime() returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('ai_enabled', s.ai_enabled, 'stop_reason', s.stop_reason, 'chat_provider', s.chat_provider, 'chat_model', s.chat_model,
    'chat_effort', s.chat_effort, 'document_provider', s.document_provider, 'document_model', s.document_model,
    'month_cost_usd', (select coalesce(sum(cost_usd), 0) from public.mai_usage where at >= date_trunc('month', now())), 'monthly_budget_usd', s.monthly_budget_usd)
    from public.mai_settings s where s.id = 1 $$;

create or replace function public.mai_record_usage(p_user uuid, p_feature text, p_provider text, p_model text, p_in integer, p_out integer,
  p_latency_ms integer, p_ok boolean, p_error text) returns void language plpgsql security definer set search_path to 'public' as $$
declare m public.mai_models;
begin
  select * into m from public.mai_models where provider = p_provider and model = p_model;
  insert into public.mai_usage (user_id, feature, provider, model, input_tokens, output_tokens, cost_usd, latency_ms, ok, error)
  values (p_user, left(coalesce(p_feature, 'unknown'), 60), p_provider, left(p_model, 80), greatest(coalesce(p_in, 0), 0), greatest(coalesce(p_out, 0), 0),
    case when m.input_usd_per_mtok is not null and m.output_usd_per_mtok is not null
         then round((coalesce(p_in, 0) * m.input_usd_per_mtok + coalesce(p_out, 0) * m.output_usd_per_mtok) / 1000000.0, 6) end,
    p_latency_ms, p_ok, left(p_error, 300));
end $$;

create or replace function public.mai_model_health(p_provider text, p_model text, p_ok boolean, p_latency_ms integer, p_error text)
returns void language sql security definer set search_path to 'public' as $$
  update public.mai_models set
    last_ok_at = case when p_ok then now() else last_ok_at end, last_latency_ms = case when p_ok then p_latency_ms else last_latency_ms end,
    last_error = case when p_ok then null else left(p_error, 300) end, last_error_at = case when p_ok then last_error_at else now() end, updated_at = now()
   where provider = p_provider and model = p_model $$;

-- ---------------------------------------------------------------- app functions
create or replace function public.mai_control_center() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.mai_can_monitor() then raise exception 'Only the Owner and Management can open the Mood AI Control Center'; end if;
  return jsonb_build_object(
    'me', jsonb_build_object('is_owner', public.mai_is_owner(false), 'owner_verified', public.mai_is_owner(true),
                             'kind', (select kind from public.mai_owners where user_id = auth.uid() and is_active)),
    'settings', (select to_jsonb(s) || jsonb_build_object('stopped_by_name', (select full_name from public.user_profiles where id = s.stopped_by)) from public.mai_settings s where s.id = 1),
    'owners', (select coalesce(jsonb_agg(jsonb_build_object('user_id', o.user_id, 'kind', o.kind, 'full_name', u.full_name, 'added_at', o.added_at) order by o.kind desc), '[]')
                 from public.mai_owners o join public.user_profiles u on u.id = o.user_id where o.is_active),
    'agents', (select coalesce(jsonb_agg(to_jsonb(a) order by a.built_in_phase, a.code), '[]') from public.mai_agents a),
    'models', (select coalesce(jsonb_agg(to_jsonb(m) order by m.provider, m.input_usd_per_mtok desc nulls last), '[]') from public.mai_models m),
    'usage', jsonb_build_object(
      'today', (select jsonb_build_object('calls', count(*), 'failed', count(*) filter (where not ok), 'cost_usd', round(coalesce(sum(cost_usd), 0), 4),
                  'unpriced_calls', count(*) filter (where cost_usd is null and ok)) from public.mai_usage where at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
      'month', (select jsonb_build_object('calls', count(*), 'failed', count(*) filter (where not ok), 'cost_usd', round(coalesce(sum(cost_usd), 0), 4),
                  'input_tokens', coalesce(sum(input_tokens), 0), 'output_tokens', coalesce(sum(output_tokens), 0), 'unpriced_calls', count(*) filter (where cost_usd is null and ok))
                  from public.mai_usage where at >= date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
      'by_feature', (select coalesce(jsonb_agg(x order by (x ->> 'calls')::int desc), '[]') from (
                  select jsonb_build_object('feature', feature, 'calls', count(*), 'failed', count(*) filter (where not ok), 'cost_usd', round(coalesce(sum(cost_usd), 0), 4),
                    'avg_ms', round(avg(latency_ms) filter (where ok))) x
                    from public.mai_usage where at >= now() - interval '30 days' group by feature) q),
      'by_model', (select coalesce(jsonb_agg(x order by (x ->> 'calls')::int desc), '[]') from (
                  select jsonb_build_object('provider', provider, 'model', model, 'calls', count(*), 'cost_usd', round(coalesce(sum(cost_usd), 0), 4),
                    'input_tokens', sum(input_tokens), 'output_tokens', sum(output_tokens), 'avg_ms', round(avg(latency_ms) filter (where ok))) x
                    from public.mai_usage where at >= now() - interval '30 days' group by provider, model) q)),
    'errors', (select coalesce(jsonb_agg(jsonb_build_object('at', at, 'feature', feature, 'model', model, 'error', error) order by at desc), '[]')
                 from (select * from public.mai_usage where not ok order by at desc limit 20) e),
    'audit', (select coalesce(jsonb_agg(jsonb_build_object('at', a.at, 'action', a.action, 'by', u.full_name, 'detail', a.detail) order by a.at desc), '[]')
                 from (select * from public.mai_audit order by at desc limit 50) a left join public.user_profiles u on u.id = a.actor));
end $$;

-- Emergency stop: the Owner or Management. Takes effect on the next AI call of every feature.
create or replace function public.mai_emergency_stop(p_reason text) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.mai_can_monitor() then raise exception 'Only the Owner and Management can stop Mood AI'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'Please give a reason'; end if;
  update public.mai_settings set ai_enabled = false, stop_reason = btrim(p_reason), stopped_by = auth.uid(), stopped_at = now(), updated_at = now() where id = 1;
  perform public.mai_log('EMERGENCY_STOP', jsonb_build_object('reason', btrim(p_reason)));
  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu, sender_id)
  select o.user_id, 'MOOD_AI', o.user_id, 'Mood AI was stopped: ' || left(btrim(p_reason), 200), 'Mood AI બંધ કરાયું: ' || left(btrim(p_reason), 200), auth.uid()
    from public.mai_owners o where o.is_active and o.user_id <> auth.uid();
end $$;

create or replace function public.mai_resume() returns void language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.mai_require_owner();
  update public.mai_settings set ai_enabled = true, stop_reason = null, stopped_by = null, stopped_at = null, updated_by = auth.uid(), updated_at = now() where id = 1;
  perform public.mai_log('RESUMED', null);
end $$;

create or replace function public.mai_update_settings(p jsonb) returns void language plpgsql security definer set search_path to 'public' as $$
declare s public.mai_settings;
begin
  perform public.mai_require_owner();
  select * into s from public.mai_settings where id = 1;
  s.chat_provider := coalesce(p ->> 'chat_provider', s.chat_provider);
  s.chat_model := coalesce(p ->> 'chat_model', s.chat_model);
  s.chat_effort := coalesce(p ->> 'chat_effort', s.chat_effort);
  s.document_provider := coalesce(p ->> 'document_provider', s.document_provider);
  s.document_model := coalesce(p ->> 'document_model', s.document_model);
  s.approval_ttl_minutes := coalesce((p ->> 'approval_ttl_minutes')::int, s.approval_ttl_minutes);
  s.monthly_budget_usd := case when p ? 'monthly_budget_usd' then nullif(p ->> 'monthly_budget_usd', '')::numeric else s.monthly_budget_usd end;
  if not exists (select 1 from public.mai_models where provider = s.chat_provider and model = s.chat_model and enabled) then raise exception 'The chat model is not a connected, enabled model'; end if;
  if not exists (select 1 from public.mai_models where provider = s.document_provider and model = s.document_model and enabled) then raise exception 'The document model is not a connected, enabled model'; end if;
  update public.mai_settings set chat_provider = s.chat_provider, chat_model = s.chat_model, chat_effort = s.chat_effort, document_provider = s.document_provider,
    document_model = s.document_model, approval_ttl_minutes = s.approval_ttl_minutes, monthly_budget_usd = s.monthly_budget_usd, updated_by = auth.uid(), updated_at = now() where id = 1;
  perform public.mai_log('SETTINGS_CHANGED', p);
end $$;

create or replace function public.mai_set_model_price(p_provider text, p_model text, p_input numeric, p_output numeric, p_enabled boolean)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.mai_require_owner();
  update public.mai_models set input_usd_per_mtok = p_input, output_usd_per_mtok = p_output, enabled = coalesce(p_enabled, enabled), updated_at = now()
   where provider = p_provider and model = p_model;
  if not found then raise exception 'Unknown model'; end if;
  if not coalesce(p_enabled, true) and exists (select 1 from public.mai_settings where (chat_provider = p_provider and chat_model = p_model) or (document_provider = p_provider and document_model = p_model)) then
    raise exception 'This model is in use for chat or documents; choose another first';
  end if;
  perform public.mai_log('MODEL_CHANGED', jsonb_build_object('provider', p_provider, 'model', p_model, 'input', p_input, 'output', p_output, 'enabled', p_enabled));
end $$;

create or replace function public.mai_set_agent(p_code text, p_enabled boolean) returns void language plpgsql security definer set search_path to 'public' as $$
declare a public.mai_agents;
begin
  perform public.mai_require_owner();
  select * into a from public.mai_agents where code = p_code;
  if a.code is null then raise exception 'Unknown agent'; end if;
  if p_enabled and not a.is_built then raise exception 'This agent is not built yet (Phase %)', a.built_in_phase; end if;
  update public.mai_agents set enabled = p_enabled, updated_by = auth.uid(), updated_at = now() where code = p_code;
  perform public.mai_log(case when p_enabled then 'AGENT_ENABLED' else 'AGENT_DISABLED' end, jsonb_build_object('agent', p_code));
end $$;

-- The Owner adds or removes the single Backup approver. A Backup cannot change approvers.
create or replace function public.mai_set_backup(p_user uuid, p_active boolean) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.mai_require_owner();
  if not exists (select 1 from public.mai_owners where user_id = auth.uid() and kind = 'OWNER' and is_active) then raise exception 'Only the Owner can choose the backup approver'; end if;
  if p_active then
    if exists (select 1 from public.mai_owners where kind = 'BACKUP' and is_active) then raise exception 'There is already a backup approver; remove them first'; end if;
    if not exists (select 1 from public.user_profiles u join public.roles r on r.id = u.role_id where u.id = p_user and u.is_active and public.staff_role_family(r.code) is not null) then
      raise exception 'The backup approver must be an active Management account';
    end if;
    insert into public.mai_owners (user_id, kind, added_by) values (p_user, 'BACKUP', auth.uid())
      on conflict (user_id) do update set kind = 'BACKUP', is_active = true, added_by = auth.uid(), added_at = now(), removed_by = null, removed_at = null
      where public.mai_owners.kind = 'BACKUP';
  else
    update public.mai_owners set is_active = false, removed_by = auth.uid(), removed_at = now() where user_id = p_user and kind = 'BACKUP' and is_active;
    if not found then raise exception 'That person is not the backup approver'; end if;
  end if;
  perform public.mai_log(case when p_active then 'BACKUP_ADDED' else 'BACKUP_REMOVED' end, jsonb_build_object('user_id', p_user));
end $$;

-- Lightweight status for every signed-in user (the chat in Phase C shows "Mood AI is paused" when stopped).
create or replace function public.mai_public_status() returns jsonb language sql stable security definer set search_path to 'public' as $$
  select case when public.staff_current_user_ok() then
    (select jsonb_build_object('ai_enabled', ai_enabled, 'stop_reason', case when ai_enabled then null else stop_reason end) from public.mai_settings where id = 1) end $$;

create or replace function public.notification_deep_link(p_type text, p_id uuid, p_task uuid default null::uuid)
returns text language sql immutable set search_path to 'public' as $function$
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
    when 'PERF_REVIEW' then '/performance/report/' || p_id::text
    when 'PERF_TEAM' then '/performance/team'
    when 'PERF_CONTROL' then '/performance/control'
    when 'PERF_COMPANY' then '/performance/control?tab=company'
    when 'MOOD_AI' then '/mood-ai'
    else null
  end, '/');
$function$;

-- ---------------------------------------------------------------- RLS: monitoring reads only; every change goes through the functions above
alter table public.mai_settings enable row level security;
alter table public.mai_owners enable row level security;
alter table public.mai_agents enable row level security;
alter table public.mai_models enable row level security;
alter table public.mai_usage enable row level security;
alter table public.mai_audit enable row level security;
drop policy if exists mai_settings_read on public.mai_settings;
create policy mai_settings_read on public.mai_settings for select to authenticated using (public.mai_can_monitor());
drop policy if exists mai_owners_read on public.mai_owners;
create policy mai_owners_read on public.mai_owners for select to authenticated using (public.mai_can_monitor());
drop policy if exists mai_agents_read on public.mai_agents;
create policy mai_agents_read on public.mai_agents for select to authenticated using (public.mai_can_monitor());
drop policy if exists mai_models_read on public.mai_models;
create policy mai_models_read on public.mai_models for select to authenticated using (public.mai_can_monitor());
drop policy if exists mai_usage_read on public.mai_usage;
create policy mai_usage_read on public.mai_usage for select to authenticated using (public.mai_can_monitor());
drop policy if exists mai_audit_read on public.mai_audit;
create policy mai_audit_read on public.mai_audit for select to authenticated using (public.mai_can_monitor());
revoke all on public.mai_settings, public.mai_owners, public.mai_agents, public.mai_models, public.mai_usage, public.mai_audit from anon;
revoke insert, update, delete, truncate on public.mai_settings, public.mai_owners, public.mai_agents, public.mai_models, public.mai_usage, public.mai_audit from authenticated;
grant select on public.mai_settings, public.mai_owners, public.mai_agents, public.mai_models, public.mai_usage, public.mai_audit to authenticated;

revoke all on function public.mai_runtime(), public.mai_record_usage(uuid, text, text, text, integer, integer, integer, boolean, text),
  public.mai_model_health(text, text, boolean, integer, text), public.mai_log(text, jsonb) from public, anon, authenticated;
grant execute on function public.mai_runtime(), public.mai_record_usage(uuid, text, text, text, integer, integer, integer, boolean, text),
  public.mai_model_health(text, text, boolean, integer, text) to service_role;
revoke all on function public.mai_control_center(), public.mai_emergency_stop(text), public.mai_resume(), public.mai_update_settings(jsonb),
  public.mai_set_model_price(text, text, numeric, numeric, boolean), public.mai_set_agent(text, boolean), public.mai_set_backup(uuid, boolean),
  public.mai_public_status(), public.mai_is_owner(boolean), public.mai_can_monitor() from public, anon;
grant execute on function public.mai_control_center(), public.mai_emergency_stop(text), public.mai_resume(), public.mai_update_settings(jsonb),
  public.mai_set_model_price(text, text, numeric, numeric, boolean), public.mai_set_agent(text, boolean), public.mai_set_backup(uuid, boolean),
  public.mai_public_status(), public.mai_is_owner(boolean), public.mai_can_monitor() to authenticated;
