-- mvp_pilot_ai_task_drafts_v2_78
--
-- Audit trail for the AI Task Assistant (any department): every time Claude
-- drafts tasks from a pasted message / uploaded document, one row is kept
-- here -- what was asked, which model/prompt, token usage, the raw draft,
-- and (once a human confirms) which real staff_tasks were created from it.
--
-- The AI never creates a task. It only proposes; a person edits and
-- confirms, and the tasks themselves are created by the existing
-- staff_create_task RPC under that person's own permissions (role,
-- department and assignee rules all still apply). Rows here are written by
-- the Edge Function (service role) and by factory-style SECURITY DEFINER
-- RPCs only -- no direct client write path exists.

create table public.ai_task_drafts (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.user_profiles(id),
  created_at timestamptz not null default now(),
  input_chars integer not null default 0,
  file_names text[] not null default '{}',
  model text,
  prompt_version text,
  input_tokens integer,
  output_tokens integer,
  draft jsonb,
  status text not null default 'drafted' check (status in ('drafted', 'confirmed', 'partially_confirmed', 'discarded', 'failed')),
  failure_reason text,
  created_task_ids uuid[] not null default '{}',
  confirmed_at timestamptz
);
create index ai_task_drafts_user_idx on public.ai_task_drafts(created_by, created_at desc);

alter table public.ai_task_drafts enable row level security;
grant select on public.ai_task_drafts to authenticated;
create policy "ai_task_drafts_select" on public.ai_task_drafts for select using (
  created_by = auth.uid() or public.staff_is_management() or public.staff_is_super_admin()
);

-- Called by the requester once they have confirmed (or discarded) a draft.
-- Only the draft's own creator may record the outcome, and only task ids
-- that really exist and were assigned by that same person are accepted, so
-- the audit row can never claim tasks the user did not create.
create or replace function public.ai_task_draft_record_outcome(
  p_draft_id uuid, p_created_task_ids uuid[], p_total_proposed integer
)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_draft public.ai_task_drafts%rowtype;
  v_valid uuid[];
begin
  perform public.staff_assert_operational();
  select * into v_draft from public.ai_task_drafts where id = p_draft_id for update;
  if v_draft.id is null then raise exception 'Draft not found'; end if;
  if v_draft.created_by <> auth.uid() then raise exception 'You are not authorized to update this draft'; end if;

  select coalesce(array_agg(id), '{}') into v_valid
  from public.staff_tasks where id = any(coalesce(p_created_task_ids, '{}')) and assigned_by = auth.uid();

  update public.ai_task_drafts set
    created_task_ids = v_valid,
    confirmed_at = now(),
    status = case
      when coalesce(array_length(v_valid, 1), 0) = 0 then 'discarded'
      when coalesce(array_length(v_valid, 1), 0) >= greatest(p_total_proposed, 1) then 'confirmed'
      else 'partially_confirmed' end
  where id = p_draft_id;

  perform public.staff_write_audit('ai_task_drafts', p_draft_id, 'AI_TASKS_CONFIRMED', null,
    jsonb_build_object('created_task_ids', v_valid, 'proposed', p_total_proposed), null, null);
end;
$function$;
revoke all on function public.ai_task_draft_record_outcome(uuid, uuid[], integer) from public;
grant execute on function public.ai_task_draft_record_outcome(uuid, uuid[], integer) to authenticated;
