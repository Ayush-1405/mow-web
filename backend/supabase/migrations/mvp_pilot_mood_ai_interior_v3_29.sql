-- Mood AI Phase H, first department: Interior AI (v3_29).
--
-- The chat gets interior-project tools (mood-ai/tools_interior.ts): active projects with stage / due date / next action / last
-- update, one project in depth (site reports, open snags, materials still to order, open tasks, purchase requests), recent site
-- reports and projects without one, materials still to order. They read AS THE SIGNED-IN PERSON, so the existing row-level
-- security (organisation-wide roles, or members of the project) decides what anyone sees. Read-only.
-- The Owner can switch Interior AI off in the Control Center (Agents); it also needs Application tools on.
-- Data change: one row of mai_agents. No table or permission changes.

update public.mai_agents set is_built = true, enabled = true, updated_at = now(),
  description = 'Answers about interior projects from live data: stage, due dates, next action, site reports, snags, materials still to order and purchase requests -- only for the projects the person can open in the app.'
 where code = 'INTERIOR';
