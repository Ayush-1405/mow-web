-- mvp_pilot_factory_uat_linked_task_backfill_v2_65
--
-- The 100-job UAT batch (mvp_pilot_factory_uat_dataset_v2_64) created a
-- bridging staff_tasks row per job but never wrote it back onto
-- inhouse_production_requests.linked_task_id -- unlike the real
-- staff_submit_to_factory() RPC, which always sets it. This left every UAT
-- job unable to resolve its source department through the real join path
-- (FactoryControlDashboard.jsx), falling back to a hardcoded default
-- instead of exercising the actual linkage.
--
-- Safe, exact, reversible-in-spirit backfill: matches each UAT staff_tasks
-- row (source_module='factory_uat') to its one job via the job_order_number
-- embedded in the bridge task's own title ("... (TEST-FJ-2026-0007)"),
-- verified live beforehand to match exactly 100/100 rows with zero
-- ambiguity. Touches only is_test_data=true rows with a NULL
-- linked_task_id; never touches a real (is_test_data=false) row.

update public.inhouse_production_requests ipr
set linked_task_id = st.id
from public.staff_tasks st
where st.source_module = 'factory_uat'
  and st.title like '%(' || ipr.job_order_number || ')%'
  and ipr.is_test_data = true
  and ipr.linked_task_id is null;
