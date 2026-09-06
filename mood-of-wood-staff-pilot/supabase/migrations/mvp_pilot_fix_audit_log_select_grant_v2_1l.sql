-- mvp_pilot_fix_audit_log_select_grant_v2_1l
-- Applied directly to the live project (bykmyttaesuyjwvtnxks) on 2026-09-06.
--
-- staff_audit_log already has a working RLS SELECT policy
-- (staff_audit_log_select_scoped: Management sees all, Dept Head sees own
-- department/group), but unlike every comparable table (staff_tasks,
-- bridges, notifications, staff_attachments) it was never actually GRANTed
-- SELECT at the table level for `authenticated` — so PostgREST rejected
-- every read with 403 before RLS ever ran. This was invisible until the
-- new Audit Log screen became the first thing to query the table directly.

GRANT SELECT ON public.staff_audit_log TO authenticated;
