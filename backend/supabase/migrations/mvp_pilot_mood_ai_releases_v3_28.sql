-- Mood AI Phase G: deployment manager (v3_28).
--
-- A release puts the laptop's local main (what the Owner merged) live, in fixed steps run by the laptop worker -- never by an AI:
--   1. the Owner asks for a release plan (Control Center);
--   2. the laptop works out the plan from git: the commits on its main that are not on GitHub yet, the new database migrations
--      and test files among them, the server functions they change, and the website;
--   3. the Owner approves THAT plan for THAT exact commit with the authenticator app (approval expires after 2 hours);
--   4. the laptop runs: checks -> backup -> database trial with tests (rolled back) -> apply migrations -> deploy functions ->
--      publish the website (git push) -> health check. It stops at the first failed step and reports every step.
--   Rollback (also an authenticator approval): website and server functions back to the version before the release. The database
--   is NEVER restored automatically (that could delete new data); the report names the backup file for the developer.
-- The laptop only runs releases when the Owner switched releases on in worker/.env (RELEASE=on) -- the app alone cannot.
-- Additive: one table, one sequence, functions. No existing data is changed.

create sequence if not exists public.mai_release_seq;

create table if not exists public.mai_releases (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default 'RL-' || lpad(nextval('public.mai_release_seq')::text, 4, '0'),
  status text not null default 'REQUESTED' check (status in ('REQUESTED', 'PLANNED', 'NOTHING_TO_RELEASE', 'APPROVED', 'RUNNING', 'LIVE', 'FAILED',
    'ROLLBACK_APPROVED', 'ROLLING_BACK', 'ROLLED_BACK', 'CANCELLED')),
  requested_by uuid references public.user_profiles(id),
  base_commit text,            -- what is live now (GitHub main)
  commit_ref text,             -- what this release puts live (the laptop's main)
  plan jsonb not null default '{}',
  steps jsonb not null default '[]',
  approved_by uuid references public.user_profiles(id),
  approved_at timestamptz,
  rollback_by uuid references public.user_profiles(id),
  rollback_at timestamptz,
  backup_file text,
  note text,
  worker_id uuid references public.mai_workers(id),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mai_releases_open on public.mai_releases (status, created_at);

alter table public.mai_releases enable row level security;
drop policy if exists mai_releases_owner on public.mai_releases;
create policy mai_releases_owner on public.mai_releases for select to authenticated using (public.mai_is_owner(false));
revoke all on public.mai_releases from anon;
revoke insert, update, delete, truncate on public.mai_releases from authenticated;
grant select on public.mai_releases to authenticated;

-- ---------------------------------------------------------------- Owner side
create or replace function public.mai_release_request() returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.mai_releases;
begin
  if not public.mai_is_owner(false) then raise exception 'Only the Owner can prepare a release'; end if;
  if exists (select 1 from public.mai_releases where status in ('REQUESTED', 'PLANNED', 'APPROVED', 'RUNNING', 'ROLLBACK_APPROVED', 'ROLLING_BACK')) then
    raise exception 'A release is already open: finish or cancel it first';
  end if;
  insert into public.mai_releases (requested_by) values (auth.uid()) returning * into r;
  perform public.mai_log('RELEASE_REQUESTED', jsonb_build_object('ref', r.ref));
  return jsonb_build_object('id', r.id, 'ref', r.ref, 'status', r.status);
end $$;

-- approval = the authenticator app, for the exact commit and plan on screen
create or replace function public.mai_release_approve(p_id uuid, p_commit text) returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.mai_releases;
begin
  perform public.mai_require_owner();
  select * into r from public.mai_releases where id = p_id for update;
  if r.id is null then raise exception 'Release not found'; end if;
  if r.status <> 'PLANNED' then raise exception 'Only a planned release can be approved'; end if;
  if r.commit_ref is null or p_commit is distinct from r.commit_ref then raise exception 'The plan changed since you looked at it; reload and review again'; end if;
  update public.mai_releases set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(), updated_at = now() where id = p_id;
  perform public.mai_log('RELEASE_APPROVED', jsonb_build_object('ref', r.ref, 'commit', r.commit_ref, 'plan', r.plan));
  perform public.mai_notify_owners(r.ref || ' approved: the laptop will put commit ' || r.commit_ref || ' live', null, auth.uid());
end $$;

create or replace function public.mai_release_rollback(p_id uuid) returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.mai_releases;
begin
  perform public.mai_require_owner();
  select * into r from public.mai_releases where id = p_id for update;
  if r.id is null then raise exception 'Release not found'; end if;
  if r.status not in ('LIVE', 'FAILED') or r.approved_at is null then raise exception 'Only a release that ran can be rolled back'; end if;
  if exists (select 1 from public.mai_releases x where x.created_at > r.created_at and x.status in ('LIVE', 'RUNNING', 'APPROVED', 'ROLLING_BACK', 'ROLLED_BACK')) then
    raise exception 'A newer release exists; roll that back first';
  end if;
  update public.mai_releases set status = 'ROLLBACK_APPROVED', rollback_by = auth.uid(), rollback_at = now(), updated_at = now() where id = p_id;
  perform public.mai_log('RELEASE_ROLLBACK_APPROVED', jsonb_build_object('ref', r.ref, 'to', r.base_commit));
  perform public.mai_notify_owners(r.ref || ' rollback approved: website and server functions go back to ' || coalesce(r.base_commit, 'the previous version'), null, auth.uid());
end $$;

create or replace function public.mai_release_cancel(p_id uuid) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.mai_is_owner(false) then raise exception 'Only the Owner can do this'; end if;
  update public.mai_releases set status = 'CANCELLED', updated_at = now()
   where id = p_id and (status in ('PLANNED', 'APPROVED', 'NOTHING_TO_RELEASE') or (status = 'REQUESTED' and worker_id is null));
  if not found then raise exception 'This release cannot be cancelled now (it may already be running)'; end if;
end $$;

create or replace function public.mai_release_list() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.mai_is_owner(false) then raise exception 'Only the Owner can see releases'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(r) - 'worker_id' order by r.created_at desc), '[]')
            from (select * from public.mai_releases order by created_at desc limit 20) r);
end $$;

-- ---------------------------------------------------------------- laptop side (worker token only)
create or replace function public.mai_release_held(p_worker uuid, p_ref text, p_statuses text[]) returns public.mai_releases
language plpgsql security definer set search_path to 'public' as $$
declare r public.mai_releases;
begin
  select * into r from public.mai_releases where ref = p_ref for update;
  if r.id is null or r.worker_id is distinct from p_worker or not (r.status = any (p_statuses)) then raise exception 'This laptop does not hold %', p_ref; end if;
  return r;
end $$;

-- next release work: a plan to make, an approved release to run, or an approved rollback
create or replace function public.mai_worker_release_claim(p_token text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare w public.mai_workers := public.mai_worker_from_token(p_token); s public.mai_settings; r public.mai_releases;
begin
  select * into s from public.mai_settings where id = 1;
  if w.paused or not s.ai_enabled then return null; end if;
  if not coalesce((w.metrics -> 'release' ->> 'enabled')::boolean, false) then return null; end if;   -- RELEASE=on on this laptop
  -- a laptop that vanished in the middle: never retried automatically (a half-done release needs a person)
  update public.mai_releases set status = 'FAILED', worker_id = null, locked_until = null, updated_at = now(),
         note = 'The laptop stopped responding during the ' || lower(status) || '; check what was done before trying again'
   where status in ('RUNNING', 'ROLLING_BACK') and locked_until < now();
  update public.mai_releases set worker_id = null, locked_until = null where status = 'REQUESTED' and locked_until < now();
  -- approvals are for now, not for later
  update public.mai_releases set status = 'PLANNED', approved_by = null, approved_at = null, updated_at = now(),
         note = 'Approval expired (not started within 2 hours); approve again'
   where status = 'APPROVED' and approved_at < now() - interval '2 hours';
  if exists (select 1 from public.mai_releases where worker_id = w.id and status in ('REQUESTED', 'RUNNING', 'ROLLING_BACK')) then return null; end if;
  select * into r from public.mai_releases
   where (status = 'REQUESTED' and worker_id is null) or status in ('APPROVED', 'ROLLBACK_APPROVED')
   order by created_at limit 1 for update skip locked;
  if r.id is null then return null; end if;
  update public.mai_releases set worker_id = w.id, locked_until = now() + interval '30 minutes', updated_at = now(),
         status = case r.status when 'APPROVED' then 'RUNNING' when 'ROLLBACK_APPROVED' then 'ROLLING_BACK' else r.status end
   where id = r.id;
  return jsonb_build_object('id', r.id, 'ref', r.ref, 'action', case r.status when 'REQUESTED' then 'plan' when 'APPROVED' then 'release' else 'rollback' end,
    'base_commit', r.base_commit, 'commit', r.commit_ref, 'plan', r.plan);
end $$;

create or replace function public.mai_worker_release_plan(p_token text, p_ref text, p_base text, p_commit text, p_plan jsonb, p_problem text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare w public.mai_workers := public.mai_worker_from_token(p_token); r public.mai_releases; v_status text;
begin
  r := public.mai_release_held(w.id, p_ref, array['REQUESTED']);
  if jsonb_typeof(p_plan) is distinct from 'object' then raise exception 'The plan must be an object'; end if;
  v_status := case when p_problem is not null then 'FAILED'
                   when coalesce(jsonb_array_length(p_plan -> 'commits'), 0) = 0 then 'NOTHING_TO_RELEASE' else 'PLANNED' end;
  update public.mai_releases set status = v_status, base_commit = left(p_base, 64), commit_ref = left(p_commit, 64), plan = p_plan,
         note = left(p_problem, 2000), worker_id = null, locked_until = null, updated_at = now()
   where id = r.id;
  perform public.mai_notify_owners(r.ref || case v_status when 'PLANNED' then ' is ready for your approval: '
      || jsonb_array_length(p_plan -> 'commits') || ' change(s), ' || coalesce(jsonb_array_length(p_plan -> 'migrations'), 0) || ' database change(s)'
    when 'NOTHING_TO_RELEASE' then ': nothing new to put live' else ' could not be planned: ' || left(p_problem, 200) end);
end $$;

create or replace function public.mai_worker_release_step(p_token text, p_ref text, p_name text, p_ok boolean, p_note text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare w public.mai_workers := public.mai_worker_from_token(p_token); r public.mai_releases;
begin
  r := public.mai_release_held(w.id, p_ref, array['RUNNING', 'ROLLING_BACK']);
  update public.mai_releases set steps = steps || jsonb_build_array(jsonb_build_object('name', left(p_name, 60), 'ok', coalesce(p_ok, false),
           'note', left(coalesce(p_note, ''), 2000), 'at', now())),
         locked_until = now() + interval '30 minutes', updated_at = now()
   where id = r.id;
end $$;

create or replace function public.mai_worker_release_finish(p_token text, p_ref text, p_ok boolean, p_note text, p_backup text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare w public.mai_workers := public.mai_worker_from_token(p_token); r public.mai_releases; v_status text;
begin
  r := public.mai_release_held(w.id, p_ref, array['RUNNING', 'ROLLING_BACK']);
  v_status := case when r.status = 'RUNNING' then (case when p_ok then 'LIVE' else 'FAILED' end)
                   else (case when p_ok then 'ROLLED_BACK' else 'FAILED' end) end;
  update public.mai_releases set status = v_status, note = left(p_note, 2000), backup_file = coalesce(left(p_backup, 300), backup_file),
         worker_id = null, locked_until = null, updated_at = now()
   where id = r.id;
  -- developer requests merged into this release are now live
  if v_status = 'LIVE' then
    with done as (
      update public.mai_dev_requests d set status = 'LIVE', updated_at = now()
       where d.status = 'MERGED' and d.merged_commit is not null and exists (
         select 1 from jsonb_array_elements(r.plan -> 'commits') c where (c ->> 'sha') like d.merged_commit || '%' or d.merged_commit like (c ->> 'sha') || '%')
      returning d.id)
    insert into public.mai_dev_events (request_id, actor, status, note) select id, null, 'LIVE', 'Put live by release ' || r.ref from done;
  end if;
  perform public.mai_log('RELEASE_' || v_status, jsonb_build_object('ref', r.ref, 'commit', r.commit_ref, 'note', left(p_note, 300)));
  perform public.mai_notify_owners(r.ref || ' ' || lower(replace(v_status, '_', ' ')) || ': ' || left(coalesce(p_note, ''), 200));
end $$;

-- ---------------------------------------------------------------- grants
revoke all on function public.mai_release_held(uuid, text, text[]) from public, anon, authenticated;
revoke all on function public.mai_worker_release_claim(text), public.mai_worker_release_plan(text, text, text, text, jsonb, text),
  public.mai_worker_release_step(text, text, text, boolean, text), public.mai_worker_release_finish(text, text, boolean, text, text) from public;
grant execute on function public.mai_worker_release_claim(text), public.mai_worker_release_plan(text, text, text, text, jsonb, text),
  public.mai_worker_release_step(text, text, text, boolean, text), public.mai_worker_release_finish(text, text, boolean, text, text) to anon, authenticated;
revoke all on function public.mai_release_request(), public.mai_release_approve(uuid, text), public.mai_release_rollback(uuid),
  public.mai_release_cancel(uuid), public.mai_release_list() from public, anon;
grant execute on function public.mai_release_request(), public.mai_release_approve(uuid, text), public.mai_release_rollback(uuid),
  public.mai_release_cancel(uuid), public.mai_release_list() to authenticated;

-- the Deployment manager agent is built (Phase G); it acts only through the approvals above
update public.mai_agents set is_built = true, enabled = true, updated_at = now(),
  description = 'Puts the laptop''s merged changes live in fixed steps after the Owner approves the plan with the authenticator app: backup, database trial with tests, database change, server functions, website, health check; website and functions can be rolled back.'
 where code = 'DEPLOYER';
