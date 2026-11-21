-- Mood AI laptop worker, step L3: local models (Ollama on the Owner's laptop).
--
-- Adds two job types that run only on a laptop where Ollama is running, plus a "requires" column so the queue never hands
-- a local-model job to a laptop that cannot run it (it stays queued until one can). The worker reports Ollama's status and
-- installed models in every heartbeat (mai_workers.metrics -> 'ollama'). Neither job type can change application records.
-- Additive only: one nullable column, two job-type rows, and the claim function re-created with the extra filter.

alter table public.mai_job_types add column if not exists requires text check (requires in ('ollama'));

insert into public.mai_job_types (code, description, lease_minutes, max_attempts, requires) values
  ('LOCAL_EMBED', 'Turns text into search vectors with the embedding model on the laptop (for searching company documents).', 5, 2, 'ollama'),
  ('LOCAL_GENERATE', 'Writes a short summary, sorting or draft with the small chat model on the laptop. Text only; it cannot change records.', 10, 2, 'ollama')
on conflict (code) do nothing;

create or replace function public.mai_worker_claim(p_token text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare w public.mai_workers := public.mai_worker_from_token(p_token); j public.mai_jobs; t public.mai_job_types; v_running int;
  v_ollama boolean;
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
  -- what this laptop can run, from its last heartbeat
  v_ollama := coalesce((w.metrics -> 'ollama' ->> 'up')::boolean, false);
  select q.* into j from public.mai_jobs q join public.mai_job_types jt on jt.code = q.job_type and jt.enabled
   where q.status = 'QUEUED'
     and (jt.requires is null or (jt.requires = 'ollama' and v_ollama))
   order by q.priority, q.created_at limit 1 for update of q skip locked;
  if j.id is null then return null; end if;
  select * into t from public.mai_job_types where code = j.job_type;
  update public.mai_jobs set status = 'RUNNING', locked_by = w.id, locked_until = now() + make_interval(mins => t.lease_minutes),
    attempts = attempts + 1, started_at = now() where id = j.id;
  return jsonb_build_object('id', j.id, 'job_type', j.job_type, 'payload', j.payload, 'attempt', j.attempts + 1, 'lease_minutes', t.lease_minutes);
end $$;

revoke all on function public.mai_worker_claim(text) from public;
grant execute on function public.mai_worker_claim(text) to anon, authenticated;
