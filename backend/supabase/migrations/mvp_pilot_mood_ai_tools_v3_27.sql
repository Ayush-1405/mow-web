-- Mood AI Phase D: application tools (v3_27). (v3_26 is reserved by developer request DR-0008, still under review.)
--
-- The chat can now read the signed-in person's own live data (their tasks, tasks they gave, task search, unread notifications)
-- through their own sign-in, so row-level security decides what it sees, and it can PREPARE a task as a draft in the normal
-- Assign Task form (the person checks and submits it). Nothing here lets Mood AI change a record.
--
-- * mai_agents: Assistant (Phase C, live since v3_22) and Developer agent (laptop developer, live since v3_24) are marked built and
--   on, as they already are in practice; Application tools (this phase) is marked built and switched on. The Owner can switch
--   Application tools off in the Control Center at any time: the chat then answers without live data, as before.
-- * mai_agent_enabled(code): server-only (service role) check used by the mood-ai function.
-- Data change: three rows of mai_agents (descriptions / flags only). No table or permission changes.

update public.mai_agents set is_built = true, enabled = true, updated_at = now() where code = 'ASSISTANT';
update public.mai_agents set is_built = true, enabled = true, updated_at = now(),
  description = 'Turns the Owner''s change requests into a developer request; after approval with the authenticator app, Claude Code builds and tests it on a branch on the Owner''s laptop.'
 where code = 'DEVELOPER';
update public.mai_agents set is_built = true, enabled = true, updated_at = now(),
  description = 'Reads the signed-in person''s own tasks and notifications for the chat (only what the app already shows them) and prepares new tasks as a draft in the Assign Task form for them to check and submit.'
 where code = 'TOOLS';

create or replace function public.mai_agent_enabled(p_code text) returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((select a.enabled and a.is_built from public.mai_agents a where a.code = p_code), false)
     and coalesce((select ai_enabled from public.mai_settings where id = 1), false) $$;

revoke all on function public.mai_agent_enabled(text) from public, anon, authenticated;
grant execute on function public.mai_agent_enabled(text) to service_role;
