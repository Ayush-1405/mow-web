-- mvp_pilot_factory_ai_grants_fix_v2_76
--
-- Found while verifying grants right after _75: Postgres grants EXECUTE on
-- a newly created function to PUBLIC by default. Four of the reviewer-only
-- RPCs (factory_ai_accept_request, factory_ai_correct_extraction,
-- factory_ai_reject_request, factory_ai_request_clarification) were given
-- an explicit `grant ... to authenticated` but the migration never revoked
-- the PUBLIC default first -- so `anon` (a fully unauthenticated caller)
-- could still call them. Each one does call staff_assert_operational()/
-- factory_ai_is_reviewer() internally and would reject an anon caller
-- (auth.uid() is null for anon, so the user_profiles lookup fails with "No
-- active profile for current user") -- so this was not a live gap in
-- practice, but every other RPC in this schema locks the grant down too,
-- not just the internal check, and these four should match that same
-- defense-in-depth standard.

revoke all on function public.factory_ai_accept_request(uuid, uuid, uuid, text, numeric, text, date) from public;
grant execute on function public.factory_ai_accept_request(uuid, uuid, uuid, text, numeric, text, date) to authenticated;

revoke all on function public.factory_ai_correct_extraction(uuid, jsonb) from public;
grant execute on function public.factory_ai_correct_extraction(uuid, jsonb) to authenticated;

revoke all on function public.factory_ai_reject_request(uuid, text) from public;
grant execute on function public.factory_ai_reject_request(uuid, text) to authenticated;

revoke all on function public.factory_ai_request_clarification(uuid, text) from public;
grant execute on function public.factory_ai_request_clarification(uuid, text) to authenticated;
