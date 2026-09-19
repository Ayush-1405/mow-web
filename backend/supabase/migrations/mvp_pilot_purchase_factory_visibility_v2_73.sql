-- mvp_pilot_purchase_factory_visibility_v2_73
--
-- Found while verifying access for the simplified "Factory / In-house"
-- Purchase Request screen: purchase_requests_scoped (the only RLS policy on
-- purchase_requests) only grants access via interior_is_org_wide() or
-- interior_is_project_member(project_id) -- there is no branch at all for
-- Factory staff. inhouse_production_requests, factory_drawings and
-- working_drawing_attachments already grant a Factory coordinator/assignee
-- visibility into their own job (via staff_factory_job_visible /
-- staff_factory_project_linked), but the parent purchase_requests row itself
-- was never included, so a Factory-only staff member (not also an Interior
-- project member) could load their Job Card fine but would be blocked from
-- opening this Purchase Request screen at all -- the same class of gap as
-- the earlier Storage RLS fix (mvp_pilot_factory_storage_access_v2_70).
--
-- Fixed with a SELECT-only additive policy, not by widening the existing
-- ALL policy: Factory staff should be able to VIEW the purchase request
-- their job belongs to, never create/edit/archive it -- that stays
-- Interior's exclusive responsibility via purchase_requests_scoped,
-- unchanged. Reuses staff_factory_project_linked(project_id), the exact
-- same trust model already granted on working_drawing_attachments.

create policy "purchase_requests_factory_select" on public.purchase_requests
  for select
  using (public.staff_factory_project_linked(project_id));
