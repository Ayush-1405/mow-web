-- The `materials` catalog table has always had its RLS policy in place
-- (most recently materials_org_wide, mvp_pilot_interior_project_rls_v2_2w.sql)
-- but was MISSING the underlying GRANT for the `authenticated` role —
-- Postgres denies "permission denied for table materials" before RLS is
-- even evaluated when the base privilege is absent, so this was broken for
-- EVERY user, org-wide roles included, not just project-scoped ones. Same
-- class of bug as push_subscriptions earlier this session: an RLS policy
-- is not a substitute for the base table GRANT.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.materials TO authenticated;
