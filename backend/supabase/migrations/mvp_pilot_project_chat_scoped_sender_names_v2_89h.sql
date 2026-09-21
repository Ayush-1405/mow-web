-- v2_89h -- A task-scoped member must see WHO wrote each message they are allowed to read (otherwise project leadership shows as
-- "Former member"), without learning who else is in the project: the member list they get = themselves + members of their tasks +
-- authors of the messages they can read. Applied to the live project.
do $$
declare v_old text; v_new text;
begin
  v_old := pg_get_functiondef('public.chat_conversation_details(uuid)'::regprocedure);
  v_new := replace(v_old,
    'and tm.task_id = any (v_my_tasks)));',
    'and tm.task_id = any (v_my_tasks))
                      or exists (select 1 from public.chat_messages sm where sm.conversation_id = p_conversation and sm.sender_id = p.user_id and sm.task_id = any (v_my_tasks)));');
  if v_new = v_old then raise exception 'chat_conversation_details patch did not apply'; end if;
  execute v_new;
end $$;
