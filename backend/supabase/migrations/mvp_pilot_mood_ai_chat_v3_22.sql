-- Mood AI, Phase C: the floating chat.
--
-- Each person's conversations are private to them: they read their own threads; nobody (including Management) reads other
-- people's chats from the app. The Owner sees counts and cost only (mai_usage, feature "mood-ai-chat").
-- Messages are written only by the mood-ai edge function (service role), so a reply cannot be forged from the browser.
-- Who may chat (everyone / Management only / off) and a per-person daily message limit are Owner settings.
-- In Phase C the assistant answers and explains; it has no tools and changes nothing (tools + approvals are Phase D).
-- Additive: two columns on mai_settings, two tables, functions.

alter table public.mai_settings add column if not exists chat_audience text not null default 'everyone'
  check (chat_audience in ('everyone', 'management', 'off'));
alter table public.mai_settings add column if not exists chat_daily_limit integer not null default 40
  check (chat_daily_limit between 0 and 500);

create table if not exists public.mai_chat_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profiles(id),
  title text not null,
  hidden_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mai_chat_threads_user on public.mai_chat_threads (user_id, updated_at desc);

create table if not exists public.mai_chat_messages (
  id bigint generated always as identity primary key,
  thread_id uuid not null references public.mai_chat_threads(id),
  user_id uuid not null references public.user_profiles(id),
  role text not null check (role in ('user', 'assistant', 'error')),
  content text not null,
  page text,
  links jsonb not null default '[]',
  provider text, model text, input_tokens integer, output_tokens integer, cost_usd numeric, latency_ms integer,
  created_at timestamptz not null default now()
);
create index if not exists mai_chat_messages_thread on public.mai_chat_messages (thread_id, id);
create index if not exists mai_chat_messages_user_day on public.mai_chat_messages (user_id, created_at) where role = 'user';

-- messages are a record: never edited or deleted (hiding a thread only hides it from the list)
create or replace function public.mai_chat_messages_frozen() returns trigger language plpgsql as $$
begin raise exception 'Mood AI chat messages cannot be changed or deleted'; end $$;
drop trigger if exists mai_chat_messages_frozen on public.mai_chat_messages;
create trigger mai_chat_messages_frozen before update or delete on public.mai_chat_messages for each row execute function public.mai_chat_messages_frozen();

alter table public.mai_chat_threads enable row level security;
alter table public.mai_chat_messages enable row level security;
drop policy if exists mai_chat_threads_own on public.mai_chat_threads;
create policy mai_chat_threads_own on public.mai_chat_threads for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists mai_chat_messages_own on public.mai_chat_messages;
create policy mai_chat_messages_own on public.mai_chat_messages for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.mai_chat_threads, public.mai_chat_messages from anon;
revoke insert, update, delete, truncate on public.mai_chat_threads, public.mai_chat_messages from authenticated;
grant select on public.mai_chat_threads, public.mai_chat_messages to authenticated;

-- may this person chat? (audience setting; Management = global oversight, like the Control Tower)
create or replace function public.mai_chat_allowed_for(p_user uuid) returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((select case s.chat_audience
      when 'off' then false
      when 'everyone' then true
      else exists (select 1 from public.mai_owners o where o.user_id = p_user and o.is_active)
        or exists (select 1 from public.user_profiles u join public.roles r on r.id = u.role_id
                    where u.id = p_user and r.code in ('management', 'sysadmin'))
    end from public.mai_settings s where s.id = 1), false)
    and exists (select 1 from public.user_profiles u where u.id = p_user and u.is_active) $$;

create or replace function public.mai_chat_used_today(p_user uuid) returns integer language sql stable security definer set search_path to 'public' as $$
  select count(*)::int from public.mai_chat_messages
   where user_id = p_user and role = 'user' and created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' $$;

-- Called by the edge function only (service role), with the user id it verified from the sign-in token.
-- Checks stop switch, audience, daily limit and thread ownership; records the question; returns the recent history.
create or replace function public.mai_chat_begin(p_user uuid, p_thread uuid, p_text text, p_page text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare s public.mai_settings; v_thread uuid := p_thread; v_used int; v_hist jsonb;
begin
  select * into s from public.mai_settings where id = 1;
  if not s.ai_enabled then return jsonb_build_object('ok', false, 'code', 'ai_stopped', 'error', 'Mood AI is stopped by the Owner' || coalesce(': ' || s.stop_reason, '')); end if;
  if not public.mai_chat_allowed_for(p_user) then return jsonb_build_object('ok', false, 'code', 'not_allowed', 'error', 'Mood AI chat is not switched on for you yet.'); end if;
  if length(coalesce(trim(p_text), '')) = 0 or length(p_text) > 2000 then return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'Write a message of up to 2000 characters.'); end if;
  v_used := public.mai_chat_used_today(p_user);
  if v_used >= s.chat_daily_limit then
    return jsonb_build_object('ok', false, 'code', 'daily_limit', 'error', format('You have used today''s %s Mood AI messages. It resets at midnight.', s.chat_daily_limit));
  end if;
  if v_thread is null then
    insert into public.mai_chat_threads (user_id, title) values (p_user, left(regexp_replace(trim(p_text), '\s+', ' ', 'g'), 60)) returning id into v_thread;
  elsif not exists (select 1 from public.mai_chat_threads where id = v_thread and user_id = p_user) then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'error', 'That conversation was not found.');
  end if;
  -- history before this question: last 12 messages, oldest first
  select coalesce(jsonb_agg(jsonb_build_object('role', role, 'content', content) order by id), '[]') into v_hist
    from (select id, role, content from public.mai_chat_messages where thread_id = v_thread and role in ('user', 'assistant') order by id desc limit 12) h;
  insert into public.mai_chat_messages (thread_id, user_id, role, content, page) values (v_thread, p_user, 'user', p_text, left(p_page, 200));
  update public.mai_chat_threads set updated_at = now(), hidden_at = null where id = v_thread;
  return jsonb_build_object('ok', true, 'thread_id', v_thread, 'history', v_hist, 'used_today', v_used + 1, 'daily_limit', s.chat_daily_limit);
end $$;

create or replace function public.mai_chat_finish(p_user uuid, p_thread uuid, p_ok boolean, p_text text, p_links jsonb, p_provider text, p_model text,
  p_in integer, p_out integer, p_ms integer) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare m public.mai_models; v_cost numeric; v_id bigint;
begin
  if not exists (select 1 from public.mai_chat_threads where id = p_thread and user_id = p_user) then raise exception 'Unknown conversation'; end if;
  select * into m from public.mai_models where provider = p_provider and model = p_model;
  v_cost := case when p_ok and m.input_usd_per_mtok is not null and m.output_usd_per_mtok is not null
                 then round((coalesce(p_in, 0) * m.input_usd_per_mtok + coalesce(p_out, 0) * m.output_usd_per_mtok) / 1000000.0, 6) end;
  insert into public.mai_chat_messages (thread_id, user_id, role, content, links, provider, model, input_tokens, output_tokens, cost_usd, latency_ms)
  values (p_thread, p_user, case when p_ok then 'assistant' else 'error' end, left(coalesce(p_text, ''), 8000),
          case when jsonb_typeof(p_links) = 'array' then p_links else '[]' end, p_provider, p_model, p_in, p_out, v_cost, p_ms)
  returning id into v_id;
  update public.mai_chat_threads set updated_at = now() where id = p_thread;
  return jsonb_build_object('id', v_id, 'cost_usd', v_cost);
end $$;

-- for the signed-in person
create or replace function public.mai_chat_status() returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('allowed', public.mai_chat_allowed_for(auth.uid()), 'ai_enabled', s.ai_enabled,
    'used_today', public.mai_chat_used_today(auth.uid()), 'daily_limit', s.chat_daily_limit, 'can_see_cost', public.mai_can_monitor())
    from public.mai_settings s where s.id = 1 $$;

create or replace function public.mai_chat_threads_list() returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'updated_at', t.updated_at) order by t.updated_at desc), '[]')
    from (select * from public.mai_chat_threads where user_id = auth.uid() and hidden_at is null order by updated_at desc limit 30) t $$;

create or replace function public.mai_chat_thread(p_thread uuid) returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_mon boolean := public.mai_can_monitor();
begin
  if not exists (select 1 from public.mai_chat_threads where id = p_thread and user_id = auth.uid()) then raise exception 'Conversation not found'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'role', role, 'content', content, 'links', links, 'created_at', created_at,
            'model', model, 'cost_usd', case when v_mon then cost_usd end, 'latency_ms', latency_ms) order by id), '[]')
            from public.mai_chat_messages where thread_id = p_thread);
end $$;

create or replace function public.mai_chat_hide_thread(p_thread uuid) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update public.mai_chat_threads set hidden_at = now() where id = p_thread and user_id = auth.uid();
  if not found then raise exception 'Conversation not found'; end if;
end $$;

-- Owner settings: same as v3_19 plus who may chat and the daily limit
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
  if not exists (select 1 from public.mai_models where provider = s.chat_provider and model = s.chat_model and enabled) then raise exception 'The chat model is not a connected, enabled model'; end if;
  if not exists (select 1 from public.mai_models where provider = s.document_provider and model = s.document_model and enabled) then raise exception 'The document model is not a connected, enabled model'; end if;
  update public.mai_settings set chat_provider = s.chat_provider, chat_model = s.chat_model, chat_effort = s.chat_effort, document_provider = s.document_provider,
    document_model = s.document_model, approval_ttl_minutes = s.approval_ttl_minutes, monthly_budget_usd = s.monthly_budget_usd,
    chat_audience = s.chat_audience, chat_daily_limit = s.chat_daily_limit, updated_by = auth.uid(), updated_at = now() where id = 1;
  perform public.mai_log('SETTINGS_CHANGED', p);
end $$;

revoke all on function public.mai_chat_allowed_for(uuid), public.mai_chat_used_today(uuid), public.mai_chat_begin(uuid, uuid, text, text),
  public.mai_chat_finish(uuid, uuid, boolean, text, jsonb, text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.mai_chat_begin(uuid, uuid, text, text),
  public.mai_chat_finish(uuid, uuid, boolean, text, jsonb, text, text, integer, integer, integer) to service_role;
revoke all on function public.mai_chat_status(), public.mai_chat_threads_list(), public.mai_chat_thread(uuid), public.mai_chat_hide_thread(uuid),
  public.mai_update_settings(jsonb) from public, anon;
grant execute on function public.mai_chat_status(), public.mai_chat_threads_list(), public.mai_chat_thread(uuid), public.mai_chat_hide_thread(uuid),
  public.mai_update_settings(jsonb) to authenticated;
