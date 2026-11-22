-- Mood AI live build tracking + Owner-verified merge (DR-0008).
--
-- Builds on v3_23 (developer requests) and v3_24 (laptop developer). The laptop worker already claims requests that the Owner
-- approved with the authenticator app and builds them on branch mood-ai/<ref>. This adds:
--   * mai_dev_logs: the live build log (Claude Code progress, stdout, stderr), written only by the worker that holds the request,
--     append-only (cannot be changed or deleted), readable only by the Owner / backup (same rule as the requests themselves);
--   * a test report (checks the laptop ran itself: build, lint, tests -- pass/fail, time, last lines of output) and the branch diff
--     (stat + patch, capped) on each request;
--   * merging needs its own authenticator-verified Owner approval (aal2), only from READY_FOR_REVIEW, only when every check passed,
--     and only for the exact commit the Owner reviewed. The laptop then merges into its LOCAL main (never pushes, never deploys)
--     and reports MERGED. Going live stays the Owner's separate step, outside this flow. Approvals not used within 24 h expire;
--   * Realtime on both tables so /mood-ai updates live (RLS still decides who receives rows).
--
-- Additive: one table, seven columns, the status list widened (every existing status stays valid), functions. No data changes.
-- Back up first (Owner): pg_dump of public.mai_dev_requests / public.mai_dev_events before applying.

-- ---------------------------------------------------------------- schema
alter table public.mai_dev_requests add column if not exists checks jsonb not null default '[]';
alter table public.mai_dev_requests add column if not exists checked_at timestamptz;
alter table public.mai_dev_requests add column if not exists diff_stat text;
alter table public.mai_dev_requests add column if not exists diff_patch text;
alter table public.mai_dev_requests add column if not exists diff_truncated boolean not null default false;
alter table public.mai_dev_requests add column if not exists merge_approved_by uuid references public.user_profiles(id);
alter table public.mai_dev_requests add column if not exists merge_approved_at timestamptz;
alter table public.mai_dev_requests add column if not exists merged_commit text;

alter table public.mai_dev_requests drop constraint if exists mai_dev_requests_status_check;
alter table public.mai_dev_requests add constraint mai_dev_requests_status_check check (status in ('DRAFT', 'SUBMITTED', 'IN_PROGRESS', 'NEEDS_INFO',
  'READY_FOR_REVIEW', 'MERGE_APPROVED', 'MERGED', 'LIVE', 'DONE', 'REJECTED', 'CANCELLED'));

create table if not exists public.mai_dev_logs (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.mai_dev_requests(id),
  stream text not null default 'stdout' check (stream in ('stdout', 'stderr', 'progress')),
  line text not null,
  at timestamptz not null default now()
);
create index if not exists mai_dev_logs_req on public.mai_dev_logs (request_id, id);
drop trigger if exists mai_dev_logs_frozen on public.mai_dev_logs;
create trigger mai_dev_logs_frozen before update or delete on public.mai_dev_logs for each row execute function public.mai_dev_events_frozen();

alter table public.mai_dev_logs enable row level security;
drop policy if exists mai_dev_logs_owner on public.mai_dev_logs;
create policy mai_dev_logs_owner on public.mai_dev_logs for select to authenticated using (public.mai_is_owner(false));
revoke all on public.mai_dev_logs from anon;
revoke insert, update, delete, truncate on public.mai_dev_logs from authenticated;
grant select on public.mai_dev_logs to authenticated;

-- ---------------------------------------------------------------- helpers
create or replace function public.mai_dev_checks_passed(p_checks jsonb) returns boolean language sql immutable as $$
  select jsonb_typeof(p_checks) = 'array' and jsonb_array_length(p_checks) > 0
     and not exists (select 1 from jsonb_array_elements(p_checks) x where x -> 'ok' is distinct from 'true'::jsonb) $$;

-- the request this worker holds right now (building, or merging)
create or replace function public.mai_dev_held(p_worker uuid, p_ref text, p_statuses text[]) returns public.mai_dev_requests
language plpgsql security definer set search_path to 'public' as $$
declare r public.mai_dev_requests;
begin
  select * into r from public.mai_dev_requests where ref = p_ref for update;
  if r.id is null or r.worker_id is distinct from p_worker or not (r.status = any (p_statuses)) then raise exception 'This worker does not hold %', p_ref; end if;
  return r;
end $$;

-- ---------------------------------------------------------------- worker side (token only)
-- live log lines: [{"s": "stdout|stderr|progress", "t": "text"}], at most 200 per call, 2000 chars per line, 20000 per request
create or replace function public.mai_worker_dev_log(p_token text, p_ref text, p_lines jsonb) returns integer
language plpgsql security definer set search_path to 'public' as $$
declare w public.mai_workers := public.mai_worker_from_token(p_token); r public.mai_dev_requests; n int;
begin
  r := public.mai_dev_held(w.id, p_ref, array['IN_PROGRESS', 'MERGE_APPROVED']);
  if jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'Log lines must be a list'; end if;
  select count(*) into n from public.mai_dev_logs where request_id = r.id;
  if n >= 20000 then return 0; end if;
  insert into public.mai_dev_logs (request_id, stream, line)
  select r.id, case when e.x ->> 's' in ('stdout', 'stderr', 'progress') then e.x ->> 's' else 'stdout' end, left(coalesce(e.x ->> 't', ''), 2000)
    from jsonb_array_elements(p_lines) with ordinality as e(x, i)
   where e.i <= least(200, 20000 - n) order by e.i;
  get diagnostics n = row_count;
  return n;
end $$;

-- test report + diff of the current run (an empty call at the start of a run clears the previous run's report)
create or replace function public.mai_worker_dev_result(p_token text, p_ref text, p_checks jsonb, p_diff_stat text, p_diff_patch text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare w public.mai_workers := public.mai_worker_from_token(p_token); r public.mai_dev_requests;
begin
  r := public.mai_dev_held(w.id, p_ref, array['IN_PROGRESS']);
  update public.mai_dev_requests set
    checks = (select coalesce(jsonb_agg(jsonb_build_object(
                'name', left(coalesce(e.x ->> 'name', 'check'), 80),
                'ok', e.x -> 'ok' = 'true'::jsonb,
                'ms', case when e.x ->> 'ms' ~ '^\d{1,9}$' then (e.x ->> 'ms')::int end,
                'tail', left(coalesce(e.x ->> 'tail', ''), 4000)) order by e.i), '[]')
                from jsonb_array_elements(case when jsonb_typeof(p_checks) = 'array' then p_checks else '[]' end) with ordinality as e(x, i) where e.i <= 12),
    checked_at = case when jsonb_typeof(p_checks) = 'array' and jsonb_array_length(p_checks) > 0 then now() end,
    diff_stat = left(p_diff_stat, 20000),
    diff_patch = left(p_diff_patch, 300000),
    diff_truncated = coalesce(length(p_diff_patch) > 300000, false),
    updated_at = now()
   where id = r.id;
end $$;

-- an Owner-approved merge (one at a time per laptop; approvals older than 24 h expire back to review)
create or replace function public.mai_worker_dev_merge_claim(p_token text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare w public.mai_workers := public.mai_worker_from_token(p_token); s public.mai_settings; r public.mai_dev_requests;
begin
  select * into s from public.mai_settings where id = 1;
  if w.paused or not s.ai_enabled or s.dev_agent <> 'laptop' then return null; end if;
  if not coalesce((w.metrics -> 'claude' ->> 'up')::boolean, false) then return null; end if;
  -- a laptop that vanished mid-merge: someone may take it again (the merge step checks whether main already has the commit)
  update public.mai_dev_requests set worker_id = null, locked_until = null
   where status = 'MERGE_APPROVED' and worker_id is not null and locked_until < now();
  for r in select * from public.mai_dev_requests where status = 'MERGE_APPROVED' and worker_id is null and merge_approved_at < now() - interval '24 hours' for update skip locked loop
    update public.mai_dev_requests set status = 'READY_FOR_REVIEW', merge_approved_by = null, merge_approved_at = null, updated_at = now() where id = r.id;
    insert into public.mai_dev_events (request_id, actor, status, note) values (r.id, null, 'READY_FOR_REVIEW', 'Merge approval expired (not used within 24 hours); approve again to merge');
  end loop;
  if exists (select 1 from public.mai_dev_requests where worker_id = w.id and status in ('IN_PROGRESS', 'MERGE_APPROVED')) then return null; end if;
  select * into r from public.mai_dev_requests where status = 'MERGE_APPROVED' and worker_id is null order by merge_approved_at limit 1 for update skip locked;
  if r.id is null then return null; end if;
  update public.mai_dev_requests set worker_id = w.id, locked_until = now() + interval '15 minutes', updated_at = now() where id = r.id;
  insert into public.mai_dev_events (request_id, actor, status, note)
  values (r.id, null, null, 'Merging on the laptop (' || coalesce(w.name, 'laptop') || ') into its local main -- not pushed, not live');
  return jsonb_build_object('id', r.id, 'ref', r.ref, 'title', r.title, 'branch', r.branch, 'commit', r.commit_ref);
end $$;

create or replace function public.mai_worker_dev_merge_report(p_token text, p_ref text, p_ok boolean, p_note text, p_merged_commit text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare w public.mai_workers := public.mai_worker_from_token(p_token); r public.mai_dev_requests;
begin
  r := public.mai_dev_held(w.id, p_ref, array['MERGE_APPROVED']);
  if coalesce(p_ok, false) then
    update public.mai_dev_requests set status = 'MERGED', merged_commit = left(p_merged_commit, 64), worker_id = null, locked_until = null, updated_at = now() where id = r.id;
    insert into public.mai_dev_events (request_id, actor, status, note) values (r.id, null, 'MERGED', left(coalesce(p_note, 'Merged'), 4000));
    perform public.mai_notify_owners(r.ref || ' merged on the laptop (not pushed, not live): ' || left(coalesce(p_note, ''), 200));
  else
    update public.mai_dev_requests set status = 'READY_FOR_REVIEW', merge_approved_by = null, merge_approved_at = null, worker_id = null, locked_until = null, updated_at = now() where id = r.id;
    insert into public.mai_dev_events (request_id, actor, status, note) values (r.id, null, 'READY_FOR_REVIEW', 'Merge not done: ' || left(coalesce(p_note, ''), 3900));
    perform public.mai_notify_owners(r.ref || ' could not be merged: ' || left(coalesce(p_note, ''), 200));
  end if;
end $$;

-- ---------------------------------------------------------------- Owner side
-- merge = its own approval with the authenticator app, for the exact commit on screen, only when every check passed
create or replace function public.mai_dev_approve_merge(p_id uuid, p_commit text) returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.mai_dev_requests;
begin
  perform public.mai_require_owner();
  select * into r from public.mai_dev_requests where id = p_id for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'READY_FOR_REVIEW' then raise exception 'Only a request that is ready for review can be merged'; end if;
  if r.commit_ref is null or p_commit is distinct from r.commit_ref then raise exception 'The branch changed since you looked at it; reload and review again'; end if;
  if not public.mai_dev_checks_passed(r.checks) then raise exception 'Every check (build, lint, tests) must pass before merging'; end if;
  update public.mai_dev_requests set status = 'MERGE_APPROVED', merge_approved_by = auth.uid(), merge_approved_at = now(), worker_id = null, locked_until = null, updated_at = now()
   where id = p_id;
  insert into public.mai_dev_events (request_id, actor, status, note)
  values (p_id, auth.uid(), 'MERGE_APPROVED', 'Owner approved merging commit ' || r.commit_ref || ' of ' || coalesce(r.branch, 'the branch') || ' into the laptop''s main (not pushed, not live)');
  perform public.mai_log('DEV_MERGE_APPROVED', jsonb_build_object('ref', r.ref, 'commit', r.commit_ref, 'branch', r.branch));
  perform public.mai_notify_owners(r.ref || ' approved for merge: ' || r.title, null, auth.uid());
end $$;

-- cancel: as v3_23, but not once merged, and not while the laptop is in the middle of merging
create or replace function public.mai_dev_cancel(p_id uuid, p_note text default null) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.mai_is_owner(false) then raise exception 'Only the Owner can do this'; end if;
  update public.mai_dev_requests set status = 'CANCELLED', merge_approved_by = null, merge_approved_at = null, updated_at = now()
   where id = p_id and status not in ('LIVE', 'DONE', 'CANCELLED', 'MERGED') and not (status = 'MERGE_APPROVED' and worker_id is not null);
  if not found then raise exception 'This request cannot be cancelled now'; end if;
  insert into public.mai_dev_events (request_id, actor, status, note) values (p_id, auth.uid(), 'CANCELLED', coalesce(nullif(btrim(p_note), ''), 'Cancelled by the Owner'));
end $$;

-- list: as v3_23 without the (large) patch
create or replace function public.mai_dev_list() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.mai_is_owner(false) then raise exception 'Only the Owner can see developer requests'; end if;
  return (select coalesce(jsonb_agg((to_jsonb(r) - 'diff_patch') || jsonb_build_object('checks_passed', public.mai_dev_checks_passed(r.checks), 'events',
            (select coalesce(jsonb_agg(jsonb_build_object('status', e.status, 'note', e.note, 'at', e.at, 'by', coalesce(u.full_name, 'Developer')) order by e.id), '[]')
               from public.mai_dev_events e left join public.user_profiles u on u.id = e.actor where e.request_id = r.id)) order by r.created_at desc), '[]')
            from (select * from public.mai_dev_requests order by created_at desc limit 50) r);
end $$;

-- one request with its report, diff and log lines after p_after (0 = the latest 500)
create or replace function public.mai_dev_detail(p_id uuid, p_after bigint default 0) returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare r public.mai_dev_requests; v_logs jsonb;
begin
  if not public.mai_is_owner(false) then raise exception 'Only the Owner can see developer requests'; end if;
  select * into r from public.mai_dev_requests where id = p_id;
  if r.id is null then raise exception 'Request not found'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 's', x.stream, 't', x.line, 'at', x.at) order by x.id), '[]') into v_logs
    from (select * from public.mai_dev_logs l where l.request_id = p_id and l.id > coalesce(p_after, 0)
           order by case when coalesce(p_after, 0) = 0 then -l.id else l.id end limit 500) x;
  return jsonb_build_object('id', r.id, 'ref', r.ref, 'status', r.status, 'branch', r.branch, 'commit_ref', r.commit_ref, 'merged_commit', r.merged_commit,
    'checks', r.checks, 'checked_at', r.checked_at, 'checks_passed', public.mai_dev_checks_passed(r.checks),
    'diff_stat', r.diff_stat, 'diff_patch', r.diff_patch, 'diff_truncated', r.diff_truncated,
    'merge_approved_at', r.merge_approved_at, 'building', r.worker_id is not null, 'updated_at', r.updated_at, 'logs', v_logs);
end $$;

-- ---------------------------------------------------------------- grants
revoke all on function public.mai_dev_held(uuid, text, text[]) from public, anon, authenticated;
revoke all on function public.mai_worker_dev_log(text, text, jsonb), public.mai_worker_dev_result(text, text, jsonb, text, text),
  public.mai_worker_dev_merge_claim(text), public.mai_worker_dev_merge_report(text, text, boolean, text, text) from public;
-- the worker signs in with nothing but its token (anon key + token); each function checks the token and that it holds the request
grant execute on function public.mai_worker_dev_log(text, text, jsonb), public.mai_worker_dev_result(text, text, jsonb, text, text),
  public.mai_worker_dev_merge_claim(text), public.mai_worker_dev_merge_report(text, text, boolean, text, text) to anon, authenticated;
revoke all on function public.mai_dev_approve_merge(uuid, text), public.mai_dev_cancel(uuid, text), public.mai_dev_list(), public.mai_dev_detail(uuid, bigint) from public, anon;
grant execute on function public.mai_dev_approve_merge(uuid, text), public.mai_dev_cancel(uuid, text), public.mai_dev_list(), public.mai_dev_detail(uuid, bigint) to authenticated;

-- ---------------------------------------------------------------- realtime (RLS decides who receives rows: Owner / backup only)
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['mai_dev_requests', 'mai_dev_logs'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
