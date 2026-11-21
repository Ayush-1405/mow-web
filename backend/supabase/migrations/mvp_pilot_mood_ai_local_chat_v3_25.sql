-- Mood AI chat fallback on the Owner's laptop (v3_25).
--
-- When the cloud AI services (Claude, Gemini) cannot answer a chat question, the mood-ai edge function puts the question on
-- the laptop queue as a LOCAL_CHAT job (high priority, one attempt, short lease) and waits for the small local model's answer.
-- Only when a laptop worker is online, running, idle enough and has Ollama with a chat model. Text only: the job cannot change records.
-- The question and answer are removed from the job row as soon as the edge function has read them (the chat tables keep the
-- conversation, as before), so the Control Center's job list shows only the timing.
-- Additive only: one job-type row and four server-only functions (service role).

insert into public.mai_job_types (code, description, lease_minutes, max_attempts, requires) values
  ('LOCAL_CHAT', 'Answers a Mood AI chat question with the small model on the laptop when the cloud AI services cannot. Text only; it cannot change records.', 2, 1, 'ollama')
on conflict (code) do nothing;

-- Is a laptop able to answer right now? (online in the last 75 s, running, not paused, Ollama up with a chat model, not building a request)
create or replace function public.mai_chat_local_ready() returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((select ai_enabled from public.mai_settings where id = 1), false)
     and exists (select 1 from public.mai_job_types where code = 'LOCAL_CHAT' and enabled)
     and exists (select 1 from public.mai_workers w
                  where w.status = 'ACTIVE' and not w.paused and w.state = 'RUNNING'
                    and w.last_heartbeat_at > now() - interval '75 seconds'
                    and coalesce((w.metrics -> 'ollama' ->> 'up')::boolean, false)
                    and nullif(w.metrics -> 'ollama' ->> 'chat_model', '') is not null
                    and nullif(w.metrics -> 'claude' ->> 'busy', '') is null) $$;

create or replace function public.mai_chat_local_enqueue(p_user uuid, p_payload jsonb) returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v uuid;
begin
  if not public.mai_chat_local_ready() then return null; end if;
  if jsonb_typeof(p_payload) <> 'object' or length(p_payload::text) > 40000 then raise exception 'Bad local chat payload'; end if;
  insert into public.mai_jobs (job_type, payload, priority, max_attempts, created_by)
  values ('LOCAL_CHAT', p_payload, 1, 1, p_user) returning id into v;
  return v;
end $$;

-- The answer, once. A finished job is cleared straight away (payload and answer text removed; model, time and token counts kept).
create or replace function public.mai_chat_local_take(p_job uuid) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare j public.mai_jobs;
begin
  select * into j from public.mai_jobs where id = p_job and job_type = 'LOCAL_CHAT' for update;
  if j.id is null then return jsonb_build_object('status', 'MISSING'); end if;
  if j.status in ('QUEUED', 'RUNNING') then return jsonb_build_object('status', j.status); end if;
  update public.mai_jobs set payload = '{}',
    result = case when j.result is null then null else jsonb_strip_nulls(jsonb_build_object('model', j.result -> 'model', 'ms', j.result -> 'ms',
      'input_tokens', j.result -> 'input_tokens', 'output_tokens', j.result -> 'output_tokens', 'tokens_per_s', j.result -> 'tokens_per_s')) end
   where id = p_job;
  return jsonb_build_object('status', j.status, 'result', j.result, 'error', j.error);
end $$;

-- Gave up waiting: the job is cancelled and cleared (a laptop still working on it gets 'lost' and drops its answer).
create or replace function public.mai_chat_local_cancel(p_job uuid) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update public.mai_jobs set status = case when status in ('QUEUED', 'RUNNING') then 'CANCELLED' else status end,
    error = case when status in ('QUEUED', 'RUNNING') then 'The chat stopped waiting for the laptop' else error end,
    finished_at = coalesce(finished_at, now()), locked_by = null, locked_until = null, payload = '{}',
    result = case when result is null then null else jsonb_strip_nulls(jsonb_build_object('model', result -> 'model', 'ms', result -> 'ms')) end
   where id = p_job and job_type = 'LOCAL_CHAT';
end $$;

revoke all on function public.mai_chat_local_ready(), public.mai_chat_local_enqueue(uuid, jsonb), public.mai_chat_local_take(uuid),
  public.mai_chat_local_cancel(uuid) from public, anon, authenticated;
grant execute on function public.mai_chat_local_ready(), public.mai_chat_local_enqueue(uuid, jsonb), public.mai_chat_local_take(uuid),
  public.mai_chat_local_cancel(uuid) to service_role;
