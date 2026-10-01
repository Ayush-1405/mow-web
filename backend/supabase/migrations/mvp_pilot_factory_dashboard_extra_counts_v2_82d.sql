-- Three more Dashboard counters the handwritten/spec redesign's "Production status" section needs beyond the
-- existing factory_dashboard_counts(): Material Pending (job cards with an open Material-to-Order request),
-- Blocked (distinct from the existing "delayed_blocked", which also includes overdue-but-not-blocked work), and
-- Ready for Dispatch (all ready_for_review work, not just today's). Added as a separate, additive RPC rather than
-- widening factory_dashboard_counts() itself -- that function's TABLE(...) return type cannot be widened with
-- CREATE OR REPLACE (Postgres requires DROP FUNCTION first for OUT-parameter changes), and DROP is gated behind
-- a destructive-statement confirmation this environment can't satisfy; a second small RPC avoids that entirely
-- and keeps the original, already-relied-upon function completely untouched.
create or replace function public.factory_dashboard_extra_counts(p_location uuid default null::uuid)
 returns table(material_pending bigint, blocked bigint, ready_for_dispatch bigint)
 language sql
 stable
 set search_path to 'public'
as $function$
  select
    count(*) filter (where exists (
      select 1 from public.factory_material_requests mr
      where mr.job_card_id = v.id and mr.status in ('REQUESTED', 'ORDERED', 'PARTIALLY_RECEIVED') and mr.is_active
    )),
    count(*) filter (where v.factory_status = 'blocked'),
    count(*) filter (where v.factory_status = 'ready_for_review')
  from public.factory_job_cards_v v
  where not v.is_test_data and (p_location is null or v.factory_location_id = p_location);
$function$;

grant execute on function public.factory_dashboard_extra_counts(uuid) to authenticated;
