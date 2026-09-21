-- Notification behaviour for chat (v2_91). Same mechanics as access_matrix.sql: runs against real data as impersonated users and ALWAYS rolls back
-- (the report is in the error message). Requires one active project conversation with >= 3 active full participants.
--   1. every chat message notifies the other participants, even while an earlier one is still unread (this used to be silently skipped)
--   2. the bell keeps ONE unread entry per conversation
--   3. sender / muted participants are never notified; same-person duplicates inside 2 s collapse into one push
--   4. each new notification queues a push carrying the notification id and a chat deep link
--   5. push_send_test works for the caller only and is rate limited

do $t$
declare
  v_log text := ''; v_conv uuid; v_a uuid; v_b uuid; v_c uuid; n int; n_unread int; q_before bigint; q_after bigint; v_url text; v_id uuid;
begin
  create function public.zz_chk(p_log text, p_name text, p_ok boolean) returns text language sql immutable as $f$
    select p_log || case when coalesce(p_ok, false) then 'PASS  ' else 'FAIL  ' end || p_name || E'\n' $f$;

  select c.id into v_conv from chat_conversations c
   where c.type = 'project' and c.migration_status is null and c.is_active
     and (select count(*) from chat_participants p join user_profiles up on up.id = p.user_id where p.conversation_id = c.id and p.left_at is null and p.scope = 'full' and up.is_active and not up.must_change_password) >= 3
     and exists (select 1 from chat_participants p join user_profiles up on up.id = p.user_id where p.conversation_id = c.id and p.left_at is null and p.scope = 'full' and p.can_post and up.is_active and not up.must_change_password) limit 1;
  select up.id into v_a from chat_participants p join user_profiles up on up.id = p.user_id where p.conversation_id = v_conv and p.left_at is null and p.scope = 'full' and p.can_post and up.is_active and not up.must_change_password order by up.id limit 1;
  select up.id into v_b from chat_participants p join user_profiles up on up.id = p.user_id where p.conversation_id = v_conv and p.left_at is null and p.scope = 'full' and up.is_active and not up.must_change_password and up.id <> v_a order by up.id limit 1;
  select up.id into v_c from chat_participants p join user_profiles up on up.id = p.user_id where p.conversation_id = v_conv and p.left_at is null and p.scope = 'full' and up.is_active and not up.must_change_password and up.id not in (v_a, v_b) order by up.id limit 1;
  update chat_participants set muted = true where conversation_id = v_conv and user_id = v_c;
  delete from notifications where recipient_id in (v_a, v_b, v_c) and entity_type = 'CHAT' and entity_id = v_conv;

  select count(*) into q_before from net.http_request_queue;
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true); set local role authenticated;
  perform public.chat_send_message(v_conv, 'zz first message');
  reset role;
  select count(*) into n from notifications where recipient_id = v_b and entity_type = 'CHAT' and entity_id = v_conv;
  v_log := public.zz_chk(v_log, 'message 1: recipient gets exactly one notification', n = 1);
  select count(*) into n from notifications where recipient_id = v_a and entity_type = 'CHAT' and entity_id = v_conv;
  v_log := public.zz_chk(v_log, 'sender gets no notification for their own message', n = 0);
  select count(*) into n from notifications where recipient_id = v_c and entity_type = 'CHAT' and entity_id = v_conv;
  v_log := public.zz_chk(v_log, 'muted participant gets none', n = 0);

  update notifications set created_at = now() - interval '10 seconds' where recipient_id = v_b and entity_type = 'CHAT' and entity_id = v_conv;
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true); set local role authenticated;
  perform public.chat_send_message(v_conv, 'zz second message while the first is still unread');
  reset role;
  select count(*), count(*) filter (where not is_read) into n, n_unread from notifications where recipient_id = v_b and entity_type = 'CHAT' and entity_id = v_conv;
  v_log := public.zz_chk(v_log, format('message 2 (first still unread): a NEW notification is created (total %s) -> push fires', n), n = 2);
  v_log := public.zz_chk(v_log, format('bell keeps ONE unread entry per conversation (%s unread)', n_unread), n_unread = 1);

  update notifications set created_at = now() - interval '10 seconds' where recipient_id = v_b and entity_type = 'CHAT' and entity_id = v_conv;
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true); set local role authenticated;
  perform public.chat_send_message(v_conv, 'zz third message');
  reset role;
  select count(*), count(*) filter (where not is_read) into n, n_unread from notifications where recipient_id = v_b and entity_type = 'CHAT' and entity_id = v_conv;
  v_log := public.zz_chk(v_log, format('message 3: again notified (total %s, unread %s)', n, n_unread), n = 3 and n_unread = 1);

  select count(*) into q_after from net.http_request_queue;
  v_log := public.zz_chk(v_log, format('push requests were queued for each new notification (%s queued)', q_after - q_before), q_after - q_before >= 3);
  select (convert_from(body, 'utf8')::jsonb) ->> 'url', (convert_from(body, 'utf8')::jsonb) ->> 'id' into v_url, v_id
    from net.http_request_queue where convert_from(body, 'utf8')::jsonb ->> 'recipient_id' = v_b::text order by id desc limit 1;
  v_log := public.zz_chk(v_log, 'queued push carries the notification id and a chat deep link (' || coalesce(v_url, 'null') || ')', v_id is not null and v_url like '/chat?c=' || v_conv::text || '%');

  delete from notifications where recipient_id = v_b and entity_type = 'CHAT' and entity_id = v_conv;
  perform public.chat_notify(v_b, v_conv, 'a', 'a'); perform public.chat_notify(v_b, v_conv, 'b', 'b');
  select count(*) into n from notifications where recipient_id = v_b and entity_type = 'CHAT' and entity_id = v_conv;
  v_log := public.zz_chk(v_log, 'two notifications for the same person/conversation within 2 s collapse into one push', n = 1);

  v_log := public.zz_chk(v_log, 'deep links: task / job card / chat with task / unknown',
    public.notification_deep_link('task', v_conv, null) = '/tasks?focus=' || v_conv::text
    and public.notification_deep_link('FACTORY_JOB', v_conv, null) = '/factory-job/' || v_conv::text
    and public.notification_deep_link('CHAT', v_conv, v_a) = '/chat?c=' || v_conv::text || '&task=' || v_a::text
    and public.notification_deep_link('mystery', v_conv, null) = '/' and public.notification_deep_link('CHAT', null, null) = '/');

  perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true); set local role authenticated;
  perform public.push_send_test();
  begin perform public.push_send_test(); v_log := public.zz_chk(v_log, 'test notification is rate limited (10 s)', false);
  exception when others then v_log := public.zz_chk(v_log, 'test notification is rate limited (10 s)', true); end;
  reset role;
  select count(*) into n from notifications where recipient_id = v_b and entity_type = 'test';
  v_log := public.zz_chk(v_log, 'test notification row created for the caller only', n = 1);
  raise exception E'NOTIFICATION-REPORT (rolled back)\n%', v_log;
end $t$;
