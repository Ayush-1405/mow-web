-- v2_89f -- a task that GETS (or changes / loses) its project must re-route its chat immediately: the sync trigger now watches project_id.
-- Applied to the live project.
drop trigger if exists trg_chat_task on public.staff_tasks;
create trigger trg_chat_task after insert or update of assigned_by, assigned_to, current_owner_id, verifier_id, is_active, to_department_id, from_department_id, is_bridge, job_card_id, title, project_id
  on public.staff_tasks for each row execute function public.chat_trg_task();
