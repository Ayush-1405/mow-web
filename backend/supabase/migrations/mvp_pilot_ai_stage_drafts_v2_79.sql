-- mvp_pilot_ai_stage_drafts_v2_79
--
-- Factory shop-floor AI: a worker sends a photo / short note ("cutting done,
-- 12 panels, 2 damaged") and Claude PROPOSES production-stage updates for
-- the job; the worker confirms and the existing factory_update_stage RPC
-- applies them under the worker's own permissions. Reuses the
-- ai_task_drafts audit table (adds a `kind` and the job it concerned)
-- rather than a parallel table.

alter table public.ai_task_drafts add column if not exists kind text not null default 'task' check (kind in ('task', 'stage_update'));
alter table public.ai_task_drafts add column if not exists job_id uuid references public.inhouse_production_requests(id);
alter table public.ai_task_drafts add column if not exists applied_count integer not null default 0;

create or replace function public.ai_stage_draft_record_outcome(p_draft_id uuid, p_applied integer, p_total integer)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare v_draft public.ai_task_drafts%rowtype;
begin
  perform public.staff_assert_operational();
  select * into v_draft from public.ai_task_drafts where id = p_draft_id for update;
  if v_draft.id is null then raise exception 'Draft not found'; end if;
  if v_draft.created_by <> auth.uid() or v_draft.kind <> 'stage_update' then raise exception 'You are not authorized to update this draft'; end if;

  update public.ai_task_drafts set
    applied_count = greatest(0, least(p_applied, p_total)),
    confirmed_at = now(),
    status = case when p_applied <= 0 then 'discarded' when p_applied >= p_total then 'confirmed' else 'partially_confirmed' end
  where id = p_draft_id;

  perform public.staff_write_audit('ai_task_drafts', p_draft_id, 'AI_STAGE_UPDATES_CONFIRMED', null,
    jsonb_build_object('job_id', v_draft.job_id, 'applied', p_applied, 'proposed', p_total), null, null);
end;
$function$;
revoke all on function public.ai_stage_draft_record_outcome(uuid, integer, integer) from public;
grant execute on function public.ai_stage_draft_record_outcome(uuid, integer, integer) to authenticated;
