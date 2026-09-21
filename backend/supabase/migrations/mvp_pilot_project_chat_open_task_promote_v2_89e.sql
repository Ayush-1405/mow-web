-- v2_89e -- Authorized project leadership (Management, Interior heads / supervisors, project team) who open a task's Chat get the FULL
-- project chat even if they are also on the task as creator / verifier; everyone else keeps task-scoped access. Applied to the live project.
do $$
declare v_old text; v_new text;
begin
  v_old := pg_get_functiondef('public.chat_open_task_chat(uuid)'::regprocedure);
  v_new := replace(v_old,
    E'    if not public.chat_is_full_participant(v_conv)\n       and not exists (select 1 from public.chat_task_members tm where tm.task_id = tk.id and tm.user_id = auth.uid() and tm.left_at is null) then\n      if public.chat_can_open_project(tk.project_id) then\n        perform public.chat_open_project(tk.project_id);\n      elsif v_role',
    E'    if not public.chat_is_full_participant(v_conv) and public.chat_can_open_project(tk.project_id) then\n      perform public.chat_open_project(tk.project_id);\n    end if;\n    if not public.chat_is_full_participant(v_conv)\n       and not exists (select 1 from public.chat_task_members tm where tm.task_id = tk.id and tm.user_id = auth.uid() and tm.left_at is null) then\n      if v_role');
  if v_new = v_old then raise exception 'chat_open_task_chat patch did not apply'; end if;
  execute v_new;
end $$;
