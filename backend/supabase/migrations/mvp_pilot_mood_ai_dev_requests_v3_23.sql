-- Mood AI developer requests + Owner notifications.
--
-- The Owner (or the backup approver) tells Mood AI in the chat what should change in the app. Mood AI turns it into a precise
-- developer prompt (goal, details, acceptance checks, areas, risk, open questions) saved as a DRAFT. Nothing is built until the
-- Owner SUBMITS it, verified with the authenticator app (aal2): that is the approval to start work on a branch.
-- The developer (Claude Code, run by the Owner) picks up SUBMITTED requests, works on a branch, and reports every step back with
-- mai_dev_report (server-only); each step notifies the Owner in the app. Going live still needs the Owner's separate approval.
-- mai_notify_owners / mai_phase_report: phase reports and other Mood AI news in the app's notification bell.
-- Additive: two tables and functions; nothing existing changes.

create sequence if not exists public.mai_dev_request_no;

create table if not exists public.mai_dev_requests (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default ('DR-' || lpad(nextval('public.mai_dev_request_no')::text, 4, '0')),
  requested_by uuid not null references public.user_profiles(id),
  source_thread uuid references public.mai_chat_threads(id),
  raw_text text not null,
  title text not null,
  goal text not null,
  details text not null default '',
  acceptance jsonb not null default '[]',
  areas jsonb not null default '[]',
  risk text not null default 'MEDIUM' check (risk in ('LOW', 'MEDIUM', 'HIGH')),
  questions jsonb not null default '[]',
  prompt text not null,
  model text,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'SUBMITTED', 'IN_PROGRESS', 'NEEDS_INFO', 'READY_FOR_REVIEW', 'LIVE', 'DONE', 'REJECTED', 'CANCELLED')),
  branch text, commit_ref text,
  submitted_by uuid references public.user_profiles(id), submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mai_dev_requests_status on public.mai_dev_requests (status, created_at);

create table if not exists public.mai_dev_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.mai_dev_requests(id),
  actor uuid references public.user_profiles(id),     -- null = the developer (server side)
  status text,
  note text not null,
  at timestamptz not null default now()
);
create index if not exists mai_dev_events_req on public.mai_dev_events (request_id, id);
create or replace function public.mai_dev_events_frozen() returns trigger language plpgsql as $$
begin raise exception 'Developer request history cannot be changed or deleted'; end $$;
drop trigger if exists mai_dev_events_frozen on public.mai_dev_events;
create trigger mai_dev_events_frozen before update or delete on public.mai_dev_events for each row execute function public.mai_dev_events_frozen();

alter table public.mai_dev_requests enable row level security;
alter table public.mai_dev_events enable row level security;
drop policy if exists mai_dev_requests_owner on public.mai_dev_requests;
create policy mai_dev_requests_owner on public.mai_dev_requests for select to authenticated using (public.mai_is_owner(false));
drop policy if exists mai_dev_events_owner on public.mai_dev_events;
create policy mai_dev_events_owner on public.mai_dev_events for select to authenticated using (public.mai_is_owner(false));
revoke all on public.mai_dev_requests, public.mai_dev_events from anon;
revoke insert, update, delete, truncate on public.mai_dev_requests, public.mai_dev_events from authenticated;
grant select on public.mai_dev_requests, public.mai_dev_events to authenticated;

-- in-app notification to the active Owner and backup (deep link: Mood AI Control Center)
create or replace function public.mai_notify_owners(p_title_en text, p_title_gu text default null, p_except uuid default null) returns integer
language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu, sender_id)
  select o.user_id, 'MOOD_AI', o.user_id, left(p_title_en, 300), left(coalesce(p_title_gu, p_title_en), 300), null
    from public.mai_owners o where o.is_active and o.user_id is distinct from p_except;
  get diagnostics n = row_count;
  return n;
end $$;

-- a finished phase / milestone: kept in the audit log and sent to the Owner's bell
create or replace function public.mai_phase_report(p_phase text, p_summary text) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  insert into public.mai_audit (actor, action, detail) values (null, 'PHASE_REPORT', jsonb_build_object('phase', p_phase, 'summary', p_summary));
  perform public.mai_notify_owners('Mood AI ' || p_phase || ': ' || p_summary);
end $$;

-- the chat (service role) saves a draft for the Owner / backup
create or replace function public.mai_dev_draft_internal(p_user uuid, p_thread uuid, p_raw text, p jsonb, p_model text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r public.mai_dev_requests;
begin
  if not exists (select 1 from public.mai_owners o where o.user_id = p_user and o.is_active) then
    raise exception 'Only the Owner or the backup approver can ask for app changes';
  end if;
  insert into public.mai_dev_requests (requested_by, source_thread, raw_text, title, goal, details, acceptance, areas, risk, questions, prompt, model)
  values (p_user, p_thread, left(p_raw, 4000), left(coalesce(nullif(p ->> 'title', ''), left(p_raw, 80)), 120), left(coalesce(p ->> 'goal', p_raw), 2000),
          left(coalesce(p ->> 'details', ''), 6000), coalesce(p -> 'acceptance', '[]'), coalesce(p -> 'areas', '[]'),
          case when p ->> 'risk' in ('LOW', 'MEDIUM', 'HIGH') then p ->> 'risk' else 'MEDIUM' end, coalesce(p -> 'questions', '[]'),
          left(coalesce(p ->> 'prompt', p_raw), 12000), p_model)
  returning * into r;
  insert into public.mai_dev_events (request_id, actor, status, note) values (r.id, p_user, 'DRAFT', 'Drafted by Mood AI from the chat');
  return jsonb_build_object('id', r.id, 'ref', r.ref, 'title', r.title, 'risk', r.risk, 'status', r.status);
end $$;

-- Owner actions (submit = approval to start building; needs the authenticator app)
create or replace function public.mai_dev_submit(p_id uuid, p_note text default null) returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.mai_dev_requests;
begin
  perform public.mai_require_owner();
  select * into r from public.mai_dev_requests where id = p_id for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status not in ('DRAFT', 'NEEDS_INFO') then raise exception 'Only a draft or a request waiting for your answer can be submitted'; end if;
  update public.mai_dev_requests set status = 'SUBMITTED', submitted_by = auth.uid(), submitted_at = now(), updated_at = now() where id = p_id;
  insert into public.mai_dev_events (request_id, actor, status, note)
  values (p_id, auth.uid(), 'SUBMITTED', coalesce(nullif(btrim(p_note), ''), 'Approved to start work on a branch (not live)'));
  perform public.mai_log('DEV_REQUEST_SUBMITTED', jsonb_build_object('ref', r.ref, 'title', r.title));
  perform public.mai_notify_owners(r.ref || ' submitted to the developer: ' || r.title, null, auth.uid());
end $$;

create or replace function public.mai_dev_edit(p_id uuid, p_title text, p_prompt text) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.mai_is_owner(false) then raise exception 'Only the Owner can do this'; end if;
  update public.mai_dev_requests set title = left(coalesce(nullif(btrim(p_title), ''), title), 120), prompt = left(coalesce(nullif(btrim(p_prompt), ''), prompt), 12000), updated_at = now()
   where id = p_id and status in ('DRAFT', 'NEEDS_INFO');
  if not found then raise exception 'Only a draft can be edited'; end if;
  insert into public.mai_dev_events (request_id, actor, status, note) values (p_id, auth.uid(), null, 'Edited by the Owner');
end $$;

create or replace function public.mai_dev_cancel(p_id uuid, p_note text default null) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.mai_is_owner(false) then raise exception 'Only the Owner can do this'; end if;
  update public.mai_dev_requests set status = 'CANCELLED', updated_at = now() where id = p_id and status not in ('LIVE', 'DONE', 'CANCELLED');
  if not found then raise exception 'This request cannot be cancelled now'; end if;
  insert into public.mai_dev_events (request_id, actor, status, note) values (p_id, auth.uid(), 'CANCELLED', coalesce(nullif(btrim(p_note), ''), 'Cancelled by the Owner'));
end $$;

-- answer the developer's question (NEEDS_INFO): goes back to the developer; needs the authenticator app like a submit
create or replace function public.mai_dev_answer(p_id uuid, p_answer text) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.mai_require_owner();
  if nullif(btrim(coalesce(p_answer, '')), '') is null then raise exception 'Write your answer'; end if;
  update public.mai_dev_requests set status = 'SUBMITTED', updated_at = now() where id = p_id and status = 'NEEDS_INFO';
  if not found then raise exception 'This request is not waiting for an answer'; end if;
  insert into public.mai_dev_events (request_id, actor, status, note) values (p_id, auth.uid(), 'SUBMITTED', 'Owner answered: ' || left(btrim(p_answer), 4000));
end $$;

create or replace function public.mai_dev_list() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.mai_is_owner(false) then raise exception 'Only the Owner can see developer requests'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('events',
            (select coalesce(jsonb_agg(jsonb_build_object('status', e.status, 'note', e.note, 'at', e.at, 'by', coalesce(u.full_name, 'Developer')) order by e.id), '[]')
               from public.mai_dev_events e left join public.user_profiles u on u.id = e.actor where e.request_id = r.id)) order by r.created_at desc), '[]')
            from (select * from public.mai_dev_requests order by created_at desc limit 50) r);
end $$;

-- the developer reports progress (server only: Claude Code via the database connection). Every step notifies the Owner.
create or replace function public.mai_dev_report(p_ref text, p_status text, p_note text, p_branch text default null, p_commit text default null) returns void
language plpgsql security definer set search_path to 'public' as $$
declare r public.mai_dev_requests;
begin
  select * into r from public.mai_dev_requests where ref = p_ref for update;
  if r.id is null then raise exception 'Unknown request %', p_ref; end if;
  if p_status is not null and p_status not in ('IN_PROGRESS', 'NEEDS_INFO', 'READY_FOR_REVIEW', 'LIVE', 'DONE', 'REJECTED') then raise exception 'Bad status'; end if;
  if r.status in ('DRAFT', 'CANCELLED') then raise exception '% is not submitted (status %)', p_ref, r.status; end if;
  -- LIVE only after the Owner said yes to going live (recorded in the note by the developer, and asked in the developer session)
  update public.mai_dev_requests set status = coalesce(p_status, status), branch = coalesce(p_branch, branch), commit_ref = coalesce(p_commit, commit_ref), updated_at = now()
   where id = r.id;
  insert into public.mai_dev_events (request_id, actor, status, note) values (r.id, null, p_status, left(p_note, 4000));
  perform public.mai_notify_owners(r.ref || case p_status when 'IN_PROGRESS' then ' started: ' when 'NEEDS_INFO' then ' needs your answer: '
      when 'READY_FOR_REVIEW' then ' ready for your review: ' when 'LIVE' then ' is live: ' when 'DONE' then ' done: ' when 'REJECTED' then ' not done: ' else ' update: ' end
    || left(p_note, 220));
end $$;

revoke all on function public.mai_notify_owners(text, text, uuid), public.mai_phase_report(text, text),
  public.mai_dev_draft_internal(uuid, uuid, text, jsonb, text), public.mai_dev_report(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.mai_dev_draft_internal(uuid, uuid, text, jsonb, text) to service_role;
revoke all on function public.mai_dev_submit(uuid, text), public.mai_dev_edit(uuid, text, text), public.mai_dev_cancel(uuid, text),
  public.mai_dev_answer(uuid, text), public.mai_dev_list() from public, anon;
grant execute on function public.mai_dev_submit(uuid, text), public.mai_dev_edit(uuid, text, text), public.mai_dev_cancel(uuid, text),
  public.mai_dev_answer(uuid, text), public.mai_dev_list() to authenticated;

-- chat status also tells the app whether this person may write developer requests (Owner / backup)
create or replace function public.mai_chat_status() returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('allowed', public.mai_chat_allowed_for(auth.uid()), 'ai_enabled', s.ai_enabled,
    'used_today', public.mai_chat_used_today(auth.uid()), 'daily_limit', s.chat_daily_limit, 'can_see_cost', public.mai_can_monitor(),
    'is_owner', public.mai_is_owner(false))
    from public.mai_settings s where s.id = 1 $$;
