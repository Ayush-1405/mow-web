-- v2_91 -- fast, reliable notifications.
--
-- 1. chat_notify used to RETURN without creating anything whenever the recipient already had an UNREAD chat notification for that
--    conversation. So after the first message, every later message in the same chat produced no notification row => no push, no sound, no
--    badge until the person opened the chat. Now every message notifies. To keep the bell tidy, the older unread chat notification for that
--    conversation is marked read when a newer one arrives (one unread entry per conversation, always the latest message). Two notifications
--    for the same person+conversation inside 2 seconds (e.g. "sent a message" + "replied to you" for one message) still collapse into one push.
-- 2. The push trigger now sends the notification id (used as the OS notification tag, so the in-app popup and the push never double up) and a
--    deep link, so tapping a notification opens the chat / task / job card itself instead of the home screen.
-- 3. push_send_test(): lets a signed-in user send THEMSELVES a real notification through the whole pipeline (row -> trigger -> edge function ->
--    push service -> device) to verify their device is set up.

create or replace function public.notification_deep_link(p_type text, p_id uuid, p_task uuid default null)
returns text language sql immutable set search_path = public as $$
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
    when 'CHAT' then case when p_task is not null then '/chat?c=' || p_id::text || '&task=' || p_task::text else '/chat?c=' || p_id::text end
    else null
  end, '/');
$$;

create or replace function public.chat_notify(p_user uuid, p_conv uuid, p_en text, p_gu text, p_task uuid default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.chat_silent() or p_user is null or p_user is not distinct from auth.uid() then return; end if;
  if not exists (select 1 from public.user_profiles where id = p_user and is_active) then return; end if;
  if exists (select 1 from public.chat_participants where conversation_id = p_conv and user_id = p_user and (muted or left_at is not null)) then return; end if;
  -- the same person twice for the same message / burst: one push is enough
  if exists (select 1 from public.notifications n where n.recipient_id = p_user and n.entity_type = 'CHAT' and n.entity_id = p_conv
               and n.created_at > now() - interval '2 seconds') then return; end if;
  -- keep the bell to ONE unread entry per conversation (the newest); older unread ones are folded into it
  update public.notifications set is_read = true, read_at = now()
   where recipient_id = p_user and entity_type = 'CHAT' and entity_id = p_conv and not is_read;
  insert into public.notifications (recipient_id, entity_type, entity_id, task_id, title_en, title_gu) values (p_user, 'CHAT', p_conv, p_task, p_en, p_gu);
end $$;

create or replace function public.notifications_push_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_secret text;
begin
  select value into v_secret from public.app_secrets where key = 'PUSH_TRIGGER_SECRET';
  if v_secret is null then return new; end if;
  perform net.http_post(
    url := 'https://bykmyttaesuyjwvtnxks.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret),
    body := jsonb_build_object(
      'id', new.id,
      'recipient_id', new.recipient_id,
      'title_en', new.title_en,
      'title_gu', new.title_gu,
      'entity_type', new.entity_type,
      'entity_id', new.entity_id,
      'url', public.notification_deep_link(new.entity_type, new.entity_id, new.task_id)
    ),
    timeout_milliseconds := 5000
  );
  return new;
end;
$$;

create or replace function public.push_send_test()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_assert_operational();
  if exists (select 1 from public.notifications where recipient_id = auth.uid() and entity_type = 'test' and created_at > now() - interval '10 seconds') then
    raise exception 'Please wait a few seconds before sending another test';
  end if;
  insert into public.notifications (recipient_id, entity_type, entity_id, title_en, title_gu)
  values (auth.uid(), 'test', auth.uid(), 'Test notification — notifications are working ✅', 'ટેસ્ટ સૂચના — સૂચનાઓ બરાબર કામ કરે છે ✅');
end $$;

revoke execute on function public.push_send_test() from public, anon;
grant execute on function public.push_send_test() to authenticated;
revoke execute on function public.notification_deep_link(text, uuid, uuid) from public, anon;
grant execute on function public.notification_deep_link(text, uuid, uuid) to authenticated;

create index if not exists notifications_recipient_unread_idx on public.notifications (recipient_id, entity_type, entity_id) where not is_read;
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
