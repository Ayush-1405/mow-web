-- Mood AI Phase H, second department: Factory AI (v3_30).
--
-- The chat gets job-card tools (mood-ai/tools_factory.ts): open job cards (stage, % done, needed-by date, priority, coordinator,
-- delayed / blocked), one job card in depth (items with quantity done, latest history, quality checks, material requests), the
-- job-card steps waiting on this person (factory_my_actions, as on Today's Tasks), delays / failed quality checks / late materials,
-- and factory material requests not received yet. They read AS THE SIGNED-IN PERSON: the job-card view is security_invoker and
-- fjc_can_view() / the factory tables' row-level security decide what anyone sees. Read-only.
-- The Owner can switch Factory AI off in the Control Center (Agents); it also needs Application tools on.
-- Data change: one row of mai_agents. No table or permission changes.

update public.mai_agents set is_built = true, enabled = true, updated_at = now(),
  description = 'Answers about factory job cards from live data: stage and progress, what is waiting on you, delays and blockers, quality checks and material requests -- only for the job cards the person can open in the app.'
 where code = 'FACTORY';
