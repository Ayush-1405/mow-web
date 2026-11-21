-- Mood AI laptop developer (Owner's choice 2026-11-21): the laptop worker builds approved developer requests with Claude Code.
--
-- A request is picked up only after the Owner approved it with the authenticator app (status SUBMITTED). The worker (signed in
-- with nothing but its token) claims one at a time, works on its own git worktree/branch on the laptop, and reports back.
-- The worker may report IN_PROGRESS / NEEDS_INFO / READY_FOR_REVIEW / REJECTED for the request it holds -- never LIVE or DONE:
-- going live always needs the Owner's separate yes. Every report notifies the Owner (mai_dev_report).
-- The Owner can switch the laptop developer off (mai_settings.dev_agent = 'off'); the emergency stop and pause also stop pickup.
-- Additive: one setting, two columns, functions.

alter table public.mai_settings add column if not exists dev_agent text not null default 'laptop' check (dev_agent in ('off', 'laptop'));
alter table public.mai_dev_requests add column if not exists worker_id uuid references public.mai_workers(id);
alter table public.mai_dev_requests add column if not exists locked_until timestamptz;

-- the worker takes the oldest approved request (laptop must report Claude Code available in its heartbeat)
create or replace function public.mai_worker_dev_claim(p_token text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare w public.mai_workers := public.mai_worker_from_token(p_token); s public.mai_settings; r public.mai_dev_requests;
begin
  select * into s from public.mai_settings where id = 1;
  if w.paused or not s.ai_enabled or s.dev_agent <> 'laptop' then return null; end if;
  if not coalesce((w.metrics -> 'claude' ->> 'up')::boolean, false) then return null; end if;
  -- a laptop that vanished mid-work: its request goes back to the queue
  update public.mai_dev_requests set status = 'SUBMITTED', worker_id = null, locked_until = null, updated_at = now()
   where status = 'IN_PROGRESS' and worker_id is not null and locked_until < now();
  if exists (select 1 from public.mai_dev_requests where worker_id = w.id and status = 'IN_PROGRESS') then return null; end if;
  select * into r from public.mai_dev_requests where status = 'SUBMITTED' order by submitted_at, created_at limit 1 for update skip locked;
  if r.id is null then return null; end if;
  perform public.mai_dev_report(r.ref, 'IN_PROGRESS', 'Picked up by the laptop developer (' || coalesce(w.name, 'laptop') || '); building on branch mood-ai/' || r.ref, 'mood-ai/' || r.ref, null);
  update public.mai_dev_requests set worker_id = w.id, locked_until = now() + interval '90 minutes' where id = r.id;
  return jsonb_build_object('id', r.id, 'ref', r.ref, 'title', r.title, 'goal', r.goal, 'prompt', r.prompt, 'risk', r.risk,
    'answers', (select coalesce(jsonb_agg(e.note order by e.id), '[]') from public.mai_dev_events e where e.request_id = r.id and e.note like 'Owner answered:%'));
end $$;

create or replace function public.mai_worker_dev_report(p_token text, p_ref text, p_status text, p_note text, p_branch text default null, p_commit text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare w public.mai_workers := public.mai_worker_from_token(p_token); r public.mai_dev_requests;
begin
  if p_status not in ('IN_PROGRESS', 'NEEDS_INFO', 'READY_FOR_REVIEW', 'REJECTED') then raise exception 'The laptop developer cannot set %', p_status; end if;
  select * into r from public.mai_dev_requests where ref = p_ref for update;
  if r.id is null or r.worker_id is distinct from w.id or r.status <> 'IN_PROGRESS' then raise exception 'This worker does not hold %', p_ref; end if;
  perform public.mai_dev_report(p_ref, p_status, p_note, p_branch, p_commit);
  update public.mai_dev_requests set locked_until = case when p_status = 'IN_PROGRESS' then now() + interval '90 minutes' end,
    worker_id = case when p_status = 'IN_PROGRESS' then w.id end where id = r.id;
end $$;

-- Owner settings: same as v3_22 plus the laptop developer switch
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
  s.chat_audience := coalesce(p ->> 'chat_audience', s.chat_audience);
  s.chat_daily_limit := coalesce((p ->> 'chat_daily_limit')::int, s.chat_daily_limit);
  s.dev_agent := coalesce(p ->> 'dev_agent', s.dev_agent);
  if not exists (select 1 from public.mai_models where provider = s.chat_provider and model = s.chat_model and enabled) then raise exception 'The chat model is not a connected, enabled model'; end if;
  if not exists (select 1 from public.mai_models where provider = s.document_provider and model = s.document_model and enabled) then raise exception 'The document model is not a connected, enabled model'; end if;
  update public.mai_settings set chat_provider = s.chat_provider, chat_model = s.chat_model, chat_effort = s.chat_effort, document_provider = s.document_provider,
    document_model = s.document_model, approval_ttl_minutes = s.approval_ttl_minutes, monthly_budget_usd = s.monthly_budget_usd,
    chat_audience = s.chat_audience, chat_daily_limit = s.chat_daily_limit, dev_agent = s.dev_agent, updated_by = auth.uid(), updated_at = now() where id = 1;
  perform public.mai_log('SETTINGS_CHANGED', p);
end $$;

revoke all on function public.mai_worker_dev_claim(text), public.mai_worker_dev_report(text, text, text, text, text, text) from public;
grant execute on function public.mai_worker_dev_claim(text), public.mai_worker_dev_report(text, text, text, text, text, text) to anon, authenticated;
