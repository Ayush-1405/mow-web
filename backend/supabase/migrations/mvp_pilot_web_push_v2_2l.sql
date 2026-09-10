-- True "closed app" Web Push notifications.
--
-- A trigger fires on every INSERT into public.notifications — there are 8
-- separate call sites already (staff_notify_assignment, staff_create_task,
-- staff_accept_task, staff_complete_task, staff_request_help,
-- staff_return_task, staff_reassign_task x2, staff_send_daily_task_reminders),
-- so a table-level trigger is the only way to cover all of them without
-- touching 8 existing RPCs. It asynchronously calls the send-push Edge
-- Function via pg_net (fire-and-forget — a slow/failed push must never
-- roll back or delay the real write that triggered it), which delivers an
-- actual Web Push message to every device this recipient has subscribed,
-- even when the app/browser is fully closed.

create extension if not exists pg_net;

-- Locked-down secret store: RLS enabled with ZERO policies for anon/
-- authenticated (Postgres RLS denies by default with no matching policy).
-- Only a SECURITY DEFINER function owned by this migration's role can
-- read through it — same trust model as every other SECURITY DEFINER
-- function in this schema.
create table if not exists public.app_secrets (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_secrets enable row level security;

-- ON CONFLICT DO NOTHING: idempotent re-run must never clobber a secret
-- that was already rotated after this migration first applied.
insert into public.app_secrets (key, value) values
  ('VAPID_PUBLIC_KEY', 'BBRQXl14qLBgnGWX_A6T2o1q5jT8wJUwF_89V0gtvWgKV3LwjMq80aabblcUyBP8MR1rmEdnie3OavHWIeiM1k4'),
  ('VAPID_PRIVATE_KEY', 'PlJo6KvFqzf-Ak744-ReDQqkJ93s3ItRHHqdHIJsPdk'),
  ('VAPID_SUBJECT', 'mailto:moodofwood@gmail.com'),
  ('PUSH_TRIGGER_SECRET', 'c875fb875b53edd26ae454145c6bf09211b94c1b070b879b8e068caa420de16e')
on conflict (key) do nothing;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profiles(id) default auth.uid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;

drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions
  for all
  using (public.staff_current_user_ok() and user_id = auth.uid())
  with check (public.staff_current_user_ok() and user_id = auth.uid());

grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- The public VAPID key is meant to be public (that's the whole point of
-- VAPID) — exposing it via RPC lets the frontend call
-- pushManager.subscribe() without a build-time secret or env var.
create or replace function public.push_get_vapid_public_key()
returns text
language sql
security definer
set search_path = public
as $$
  select value from public.app_secrets where key = 'VAPID_PUBLIC_KEY';
$$;
grant execute on function public.push_get_vapid_public_key() to authenticated;

create or replace function public.notifications_push_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  select value into v_secret from public.app_secrets where key = 'PUSH_TRIGGER_SECRET';
  if v_secret is null then
    return new;
  end if;

  perform net.http_post(
    url := 'https://bykmyttaesuyjwvtnxks.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret),
    body := jsonb_build_object(
      'recipient_id', new.recipient_id,
      'title_en', new.title_en,
      'title_gu', new.title_gu,
      'entity_type', new.entity_type,
      'entity_id', new.entity_id
    ),
    timeout_milliseconds := 5000
  );
  return new;
end;
$$;

drop trigger if exists notifications_after_insert_push on public.notifications;
create trigger notifications_after_insert_push
  after insert on public.notifications
  for each row execute function public.notifications_push_trigger();
