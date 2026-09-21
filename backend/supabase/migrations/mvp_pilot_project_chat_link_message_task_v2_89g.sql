-- v2_89g -- "Link message to a task" now sets the message's REAL task reference (task_id / job card / daily update), so it appears under that
-- task, is searchable by task number and follows task-scoped visibility. Only a full project member may link; only to a task of the SAME project
-- that they can see; a message that already references a task cannot be re-pointed. Applied to the live project.
create or replace function public.chat_link_message_task(p_message uuid, p_task uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m public.chat_messages%rowtype; c public.chat_conversations%rowtype; tk public.staff_tasks%rowtype;
begin
  perform public.staff_assert_operational();
  select * into m from public.chat_messages where id = p_message;
  if m.id is null or not public.chat_can_read_msg(m.conversation_id, m.task_id) then raise exception 'Message not found'; end if;
  select * into c from public.chat_conversations where id = m.conversation_id;
  if c.type <> 'project' or not public.chat_can_post(c.id) or not public.chat_is_full_participant(c.id) then raise exception 'You cannot link messages in this conversation'; end if;
  if m.task_id is not null then raise exception 'This message already refers to a task'; end if;
  select * into tk from public.staff_tasks where id = p_task;
  if tk.id is null or tk.project_id is distinct from c.project_id or not public.staff_can_view_task(tk) then raise exception 'That task is not available for this project'; end if;
  update public.chat_messages set task_id = tk.id, project_id = c.project_id, job_card_id = coalesce(job_card_id, tk.job_card_id),
         daily_update_id = coalesce(daily_update_id, case when tk.source_module = 'daily_site_update' then tk.source_site_report_id end),
         context = context || jsonb_build_object('linked_task_number', tk.task_number, 'linked_by', auth.uid(), 'linked_at', now())
   where id = p_message;
  insert into public.chat_access_log (conversation_id, user_id, action, reason) values (c.id, auth.uid(), 'link_task', p_message::text || ' -> ' || tk.task_number);
end $$;
