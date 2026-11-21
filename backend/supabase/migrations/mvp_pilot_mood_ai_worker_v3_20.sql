-- v3_20: Mood AI laptop worker, step L1 -- an OPTIONAL helper computer that takes background jobs from a queue.
--
-- The hosted app never depends on it: jobs wait in mai_jobs while the worker is off and run when it reconnects.
-- The worker only connects OUT (HTTPS to Supabase) and proves itself with its own token; only the token's SHA-256 is stored
-- here. It holds no AI provider key and no service-role key. Every call it makes is one of the mai_worker_* functions below,
-- which check the token, the worker's state (revoked / paused) and the Mood AI emergency stop.
--
-- Jobs: a time-limited lock (lease) means one worker runs a job at a time; an expired lock puts the job back in the queue;
-- a failed job is retried up to max_attempts; dedupe_key prevents the same job being queued twice. Only job types listed in
-- mai_job_types can be queued, and none of them may purchase, pay, approve or change records -- those stay behind approvals.

create table if not exists public.mai_job_types (
  code text primary key,
  description text not null,
  lease_minutes integer not null default 10 check (lease_minutes between 1 and 240),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  enabled boolean not null default true
);
insert into public.mai_job_types (code, description, lease_minutes, max_attempts) values
  ('SELFTEST', 'Worker self-test: reports the laptop''s health readings and its connection time to the database.', 2, 2)
on conflict (code) do nothing;

create table if not exists public.mai_workers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  token_hash text not null unique,
  token_hint text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED')),
  paused boolean not null default false,
  restart_requested_at timestamptz,
  limits jsonb not null default '{"max_cpu_pct": 70, "min_free_ram_gb": 3, "max_concurrency": 1, "pause_on_battery": true, "working_hours": null}',
  last_heartbeat_at timestamptz,
  process_started_at timestamptz,
  version text,
  hostname text,
  state text,
  state_reason text,
  metrics jsonb,
  created_by uuid references public.user_profiles(id),
  created_at timestamptz not null default now(),
  token_rotated_at timestamptz,
  revoked_by uuid references public.user_profiles(id),
  revoked_at timestamptz
);

create table if not exists public.mai_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null references public.mai_job_types(code),
  status text not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED')),
  payload jsonb not null default '{}',
  result jsonb,
  error text,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  priority integer not null default 5,
  dedupe_key text,
  locked_by uuid references public.mai_workers(id),
  locked_until timestamptz,
  created_by uuid references public.user_profiles(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists mai_jobs_queue_idx on public.mai_jobs (status, priority, created_at) where status in ('QUEUED', 'RUNNING');
create unique index if not exists mai_jobs_dedupe_uidx on public.mai_jobs (dedupe_key) where dedupe_key is not null and status in ('QUEUED', 'RUNNING');

-- ---------------------------------------------------------------- worker identity
create or replace function public.mai_worker_from_token(p_token text) returns public.mai_workers language plpgsql stable security definer set search_path to 'public' as $$
declare w public.mai_workers;
begin
  if p_token is null or length(p_token) < 32 then raise exception 'Worker not authorized'; end if;
  select * into w from public.mai_workers where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if w.id is null or w.status <> 'ACTIVE' then raise exception 'Worker not authorized'; end if;
  return w;
end $$;

create or replace function public.mai_new_token() returns text language sql volatile as $$
  select 'mw_' || encode(extensions.gen_random_bytes(32), 'hex') $$;

-- Registering / rotating needs the Owner (with the authenticator check). Returns the token ONCE; only its hash is kept.
create or replace function public.mai_worker_register_internal(p_name text, p_by uuid) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_token text := public.mai_new_token(); v_id uuid;
begin
  insert into public.mai_workers (name, token_hash, token_hint, created_by)
  values (left(btrim(p_name), 60), encode(extensions.digest(v_token, 'sha256'), 'hex'), right(v_token, 4), p_by) returning id into v_id;
  insert into public.mai_audit (actor, action, detail) values (p_by, 'WORKER_REGISTERED', jsonb_build_object('worker_id', v_id, 'name', p_name));
  return jsonb_build_object('worker_id', v_id, 'token', v_token);
end $$;

create or replace function public.mai_worker_register(p_name text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.mai_require_owner();
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'Give the worker a name'; end if;
  return public.mai_worker_register_internal(p_name, auth.uid());
end $$;

create or replace function public.mai_worker_rotate(p_worker uuid) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_token text := public.mai_new_token();
begin
  perform public.mai_require_owner();
  update public.mai_workers set token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'), token_hint = right(v_token, 4), token_rotated_at = now()
   where id = p_worker and status = 'ACTIVE';
  if not found then raise exception 'Worker not found or disconnected'; end if;
  perform public.mai_log('WORKER_TOKEN_ROTATED', jsonb_build_object('worker_id', p_worker));
  return jsonb_build_object('worker_id', p_worker, 'token', v_token);
end $$;

-- ---------------------------------------------------------------- controls from the Control Center
-- Stopping-direction controls (pause, disconnect, restart) are allowed for the Owner and Management; resume and limits are Owner-only.
create or replace function public.mai_worker_disconnect(p_worker uuid) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.mai_can_monitor() then raise exception 'Only the Owner and Management can disconnect a worker'; end if;
  update public.mai_workers set status = 'REVOKED', revoked_by = auth.uid(), revoked_at = now() where id = p_worker and status = 'ACTIVE';
  if not found then raise exception 'Worker not found or already disconnected'; end if;
  -- its running jobs go back to the queue for another worker / later
  update public.mai_jobs set status = 'QUEUED', locked_by = null, locked_until = null where locked_by = p_worker and status = 'RUNNING';
  perform public.mai_log('WORKER_DISCONNECTED', jsonb_build_object('worker_id', p_worker));
end $$;

create or replace function public.mai_worker_set_paused(p_worker uuid, p_paused boolean) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if p_paused then
    if not public.mai_can_monitor() then raise exception 'Only the Owner and Management can pause the worker'; end if;
  else
    perform public.mai_require_owner();
  end if;
  update public.mai_workers set paused = p_paused where id = p_worker and status = 'ACTIVE';
  if not found then raise exception 'Worker not found or disconnected'; end if;
  perform public.mai_log(case when p_paused then 'WORKER_PAUSED' else 'WORKER_RESUMED' end, jsonb_build_object('worker_id', p_worker));
end $$;

create or replace function public.mai_worker_request_restart(p_worker uuid) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.mai_can_monitor() then raise exception 'Only the Owner and Management can restart the worker'; end if;
  update public.mai_workers set restart_requested_at = now() where id = p_worker and status = 'ACTIVE';
  if not found then raise exception 'Worker not found or disconnected'; end if;
  perform public.mai_log('WORKER_RESTART_REQUESTED', jsonb_build_object('worker_id', p_worker));
end $$;

create or replace function public.mai_worker_set_limits(p_worker uuid, p jsonb) returns void language plpgsql security definer set search_path to 'public' as $$
declare v jsonb;
begin
  perform public.mai_require_owner();
  v := jsonb_build_object(
    'max_cpu_pct', least(95, greatest(10, coalesce((p ->> 'max_cpu_pct')::int, 70))),
    'min_free_ram_gb', least(12, greatest(1, coalesce((p ->> 'min_free_ram_gb')::numeric, 3))),
    'max_concurrency', least(4, greatest(1, coalesce((p ->> 'max_concurrency')::int, 1))),
    'pause_on_battery', coalesce((p ->> 'pause_on_battery')::boolean, true),
    'working_hours', case when p ? 'working_hours' and jsonb_typeof(p -> 'working_hours') = 'object'
                          and (p -> 'working_hours' ->> 'from') ~ '^\d{2}:\d{2}$' and (p -> 'working_hours' ->> 'to') ~ '^\d{2}:\d{2}$'
                          then jsonb_build_object('from', p -> 'working_hours' ->> 'from', 'to', p -> 'working_hours' ->> 'to') end);
  update public.mai_workers set limits = v where id = p_worker and status = 'ACTIVE';
  if not found then raise exception 'Worker not found or disconnected'; end if;
  perform public.mai_log('WORKER_LIMITS_CHANGED', jsonb_build_object('worker_id', p_worker, 'limits', v));
end $$;

create or replace function public.mai_enqueue_job(p_type text, p_payload jsonb default '{}', p_dedupe text default null) returns uuid language plpgsql security definer set search_path to 'public' as $$
declare t public.mai_job_types; v uuid;
begin
  if not public.mai_can_monitor() then raise exception 'Only the Owner and Management can queue Mood AI jobs'; end if;
  select * into t from public.mai_job_types where code = p_type and enabled;
  if t.code is null then raise exception 'Unknown or disabled job type'; end if;
  insert into public.mai_jobs (job_type, payload, dedupe_key, max_attempts, created_by)
  values (p_type, coalesce(p_payload, '{}'), p_dedupe, t.max_attempts, auth.uid()) returning id into v;
  return v;
exception when unique_violation then
  raise exception 'The same job is already waiting or running';
end $$;

create or replace function public.mai_cancel_job(p_job uuid) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.mai_can_monitor() then raise exception 'Only the Owner and Management can cancel jobs'; end if;
  update public.mai_jobs set status = 'CANCELLED', finished_at = now(), locked_by = null, locked_until = null where id = p_job and status in ('QUEUED', 'RUNNING');
  if not found then raise exception 'Only a waiting or running job can be cancelled'; end if;
end $$;

-- ---------------------------------------------------------------- what the worker calls (its token, no user session)
create or replace function public.mai_worker_heartbeat(p_token text, p_metrics jsonb, p_state text, p_reason text, p_version text, p_hostname text, p_started_at timestamptz)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare w public.mai_workers := public.mai_worker_from_token(p_token); v_restart boolean;
begin
  v_restart := w.restart_requested_at is not null and (w.process_started_at is null or w.restart_requested_at > coalesce(p_started_at, w.process_started_at));
  update public.mai_workers set last_heartbeat_at = now(), metrics = p_metrics, state = left(p_state, 20), state_reason = left(p_reason, 200),
    version = left(p_version, 30), hostname = left(p_hostname, 80), process_started_at = p_started_at,
    restart_requested_at = case when v_restart then null else restart_requested_at end
   where id = w.id;
  return jsonb_build_object('worker_id', w.id, 'paused', w.paused, 'restart', v_restart, 'limits', w.limits,
    'ai_enabled', (select ai_enabled from public.mai_settings where id = 1));
end $$;

create or replace function public.mai_worker_claim(p_token text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare w public.mai_workers := public.mai_worker_from_token(p_token); j public.mai_jobs; t public.mai_job_types; v_running int;
begin
  if w.paused then return null; end if;
  if not coalesce((select ai_enabled from public.mai_settings where id = 1), false) then return null; end if;
  -- jobs whose worker vanished: their lock has run out, so they go back in the queue (or fail if out of attempts)
  update public.mai_jobs set status = case when attempts >= max_attempts then 'FAILED' else 'QUEUED' end,
    error = case when attempts >= max_attempts then 'Worker stopped responding (lock expired) on the last attempt' else error end,
    finished_at = case when attempts >= max_attempts then now() else finished_at end, locked_by = null, locked_until = null
   where status = 'RUNNING' and locked_until < now();
  select count(*) into v_running from public.mai_jobs where locked_by = w.id and status = 'RUNNING';
  if v_running >= coalesce((w.limits ->> 'max_concurrency')::int, 1) then return null; end if;
  select q.* into j from public.mai_jobs q join public.mai_job_types jt on jt.code = q.job_type and jt.enabled
   where q.status = 'QUEUED' order by q.priority, q.created_at limit 1 for update of q skip locked;
  if j.id is null then return null; end if;
  select * into t from public.mai_job_types where code = j.job_type;
  update public.mai_jobs set status = 'RUNNING', locked_by = w.id, locked_until = now() + make_interval(mins => t.lease_minutes),
    attempts = attempts + 1, started_at = now() where id = j.id;
  return jsonb_build_object('id', j.id, 'job_type', j.job_type, 'payload', j.payload, 'attempt', j.attempts + 1, 'lease_minutes', t.lease_minutes);
end $$;

-- Finishing: only the worker that holds the lock. A worker that lost its lock (expired, disconnected) gets 'lost' and must discard its result.
create or replace function public.mai_worker_complete(p_token text, p_job uuid, p_ok boolean, p_result jsonb, p_error text, p_retryable boolean default true)
returns text language plpgsql security definer set search_path to 'public' as $$
declare w public.mai_workers := public.mai_worker_from_token(p_token); j public.mai_jobs;
begin
  select * into j from public.mai_jobs where id = p_job for update;
  if j.id is null or j.status <> 'RUNNING' or j.locked_by is distinct from w.id then return 'lost'; end if;
  if p_ok then
    update public.mai_jobs set status = 'DONE', result = p_result, error = null, finished_at = now(), locked_by = null, locked_until = null where id = p_job;
    return 'done';
  elsif p_retryable and j.attempts < j.max_attempts then
    update public.mai_jobs set status = 'QUEUED', error = left(p_error, 500), locked_by = null, locked_until = null where id = p_job;
    return 'retry';
  else
    update public.mai_jobs set status = 'FAILED', error = left(p_error, 500), finished_at = now(), locked_by = null, locked_until = null where id = p_job;
    return 'failed';
  end if;
end $$;

-- ---------------------------------------------------------------- panel for the Control Center
create or replace function public.mai_worker_panel() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.mai_can_monitor() then raise exception 'Only the Owner and Management can see the workers'; end if;
  return jsonb_build_object(
    'workers', (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'status', w.status, 'paused', w.paused, 'token_hint', w.token_hint,
                  'online', w.status = 'ACTIVE' and w.last_heartbeat_at > now() - interval '90 seconds', 'last_heartbeat_at', w.last_heartbeat_at,
                  'process_started_at', w.process_started_at, 'version', w.version, 'hostname', w.hostname, 'state', w.state, 'state_reason', w.state_reason,
                  'metrics', w.metrics, 'limits', w.limits, 'restart_pending', w.restart_requested_at is not null, 'created_at', w.created_at,
                  'running', (select count(*) from public.mai_jobs j where j.locked_by = w.id and j.status = 'RUNNING')) order by w.created_at), '[]')
                  from public.mai_workers w),
    'jobs', jsonb_build_object(
      'queued', (select count(*) from public.mai_jobs where status = 'QUEUED'),
      'running', (select count(*) from public.mai_jobs where status = 'RUNNING'),
      'done_24h', (select count(*) from public.mai_jobs where status = 'DONE' and finished_at > now() - interval '24 hours'),
      'failed_24h', (select count(*) from public.mai_jobs where status = 'FAILED' and finished_at > now() - interval '24 hours')),
    'recent', (select coalesce(jsonb_agg(jsonb_build_object('id', j.id, 'job_type', j.job_type, 'status', j.status, 'attempts', j.attempts, 'error', j.error,
                  'created_at', j.created_at, 'finished_at', j.finished_at, 'result', j.result) order by j.created_at desc), '[]')
                  from (select * from public.mai_jobs order by created_at desc limit 20) j),
    'job_types', (select coalesce(jsonb_agg(to_jsonb(t) order by t.code), '[]') from public.mai_job_types t where t.enabled));
end $$;

-- ---------------------------------------------------------------- RLS and grants
alter table public.mai_job_types enable row level security;
alter table public.mai_workers enable row level security;
alter table public.mai_jobs enable row level security;
drop policy if exists mai_job_types_read on public.mai_job_types;
create policy mai_job_types_read on public.mai_job_types for select to authenticated using (public.mai_can_monitor());
drop policy if exists mai_workers_read on public.mai_workers;
create policy mai_workers_read on public.mai_workers for select to authenticated using (public.mai_can_monitor());
drop policy if exists mai_jobs_read on public.mai_jobs;
create policy mai_jobs_read on public.mai_jobs for select to authenticated using (public.mai_can_monitor());
revoke all on public.mai_job_types, public.mai_workers, public.mai_jobs from anon;
revoke insert, update, delete, truncate on public.mai_job_types, public.mai_workers, public.mai_jobs from authenticated;
grant select on public.mai_job_types, public.mai_jobs to authenticated;
-- the token hash never leaves the database: the app reads workers only through mai_worker_panel()
revoke select on public.mai_workers from authenticated;

revoke all on function public.mai_worker_from_token(text), public.mai_new_token(), public.mai_worker_register_internal(text, uuid) from public, anon, authenticated;
revoke all on function public.mai_worker_register(text), public.mai_worker_rotate(uuid), public.mai_worker_disconnect(uuid), public.mai_worker_set_paused(uuid, boolean),
  public.mai_worker_request_restart(uuid), public.mai_worker_set_limits(uuid, jsonb), public.mai_enqueue_job(text, jsonb, text), public.mai_cancel_job(uuid),
  public.mai_worker_panel() from public, anon;
grant execute on function public.mai_worker_register(text), public.mai_worker_rotate(uuid), public.mai_worker_disconnect(uuid), public.mai_worker_set_paused(uuid, boolean),
  public.mai_worker_request_restart(uuid), public.mai_worker_set_limits(uuid, jsonb), public.mai_enqueue_job(text, jsonb, text), public.mai_cancel_job(uuid),
  public.mai_worker_panel() to authenticated;
-- the worker signs in with nothing but its token (public anon key + token), so these three are callable by anon; each checks the token
revoke all on function public.mai_worker_heartbeat(text, jsonb, text, text, text, text, timestamptz), public.mai_worker_claim(text),
  public.mai_worker_complete(text, uuid, boolean, jsonb, text, boolean) from public;
grant execute on function public.mai_worker_heartbeat(text, jsonb, text, text, text, text, timestamptz), public.mai_worker_claim(text),
  public.mai_worker_complete(text, uuid, boolean, jsonb, text, boolean) to anon, authenticated;
