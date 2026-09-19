-- factory_uat_cleanup.sql
--
-- Admin-only, manual cleanup script for a Factory UAT test batch.
-- Deletes ONLY rows matching the exact test_batch_id given below -- never
-- a broad delete, never anything with is_test_data = false. Tested against
-- a disposable throwaway batch (TEST-BATCH-DISPOSABLE-001) before being
-- used against the real batch; see the verification note at the bottom of
-- this file for that result.
--
-- HOW TO USE
-- 1. Set :batch_id below to the exact batch you intend to delete.
-- 2. Run PART 1 (report) first and review the counts out loud with
--    whoever approved the deletion -- this is the "typed confirmation"
--    step: only proceed to PART 2 if every row you see here is one you
--    expect and intend to remove.
-- 3. Run PART 2 (delete) only after that review. It is already ordered
--    child-tables-first so no foreign key ever blocks it.
-- 4. Run PART 3 (audit) to record that the cleanup happened.
--
-- This script never touches is_test_data = false rows -- every DELETE
-- below is scoped to `test_batch_id = '<batch>'` and nothing else, so a
-- typo in the batch id fails safe (deletes zero rows) rather than
-- deleting the wrong thing.

-- ===========================================================
-- PART 1 -- REPORT (run this first, read it, then decide)
-- ===========================================================
-- \set batch_id 'TEST-BATCH-FACTORY-UAT-2026-001'   -- psql only; inline the value below if running via the Supabase SQL editor / MCP tool instead.

select 'inhouse_production_requests' as tbl, count(*) from inhouse_production_requests where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'purchase_requests', count(*) from purchase_requests where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'projects', count(*) from projects where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'staff_tasks', count(*) from staff_tasks where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_production_plans', count(*) from factory_production_plans where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_boms', count(*) from factory_boms where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_bom_items', count(*) from factory_bom_items where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_cutting_lists', count(*) from factory_cutting_lists where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_cutting_list_items', count(*) from factory_cutting_list_items where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_drawings', count(*) from factory_drawings where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_materials', count(*) from factory_materials where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_material_stock', count(*) from factory_material_stock where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_material_transactions', count(*) from factory_material_transactions where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_machines', count(*) from factory_machines where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_machine_logs', count(*) from factory_machine_logs where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'production_stage_updates', count(*) from production_stage_updates where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_quality_checks', count(*) from factory_quality_checks where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_rework_records', count(*) from factory_rework_records where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_rejection_records', count(*) from factory_rejection_records where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_wastage_records', count(*) from factory_wastage_records where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_finished_goods', count(*) from factory_finished_goods where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_packing_records', count(*) from factory_packing_records where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_transfers', count(*) from factory_transfers where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_transfer_items', count(*) from factory_transfer_items where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_product_costing', count(*) from factory_product_costing where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_clarification_requests', count(*) from factory_clarification_requests where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001'
union all select 'factory_clarification_revisions', count(*) from factory_clarification_revisions where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';

-- Typed-confirmation gate (manual step, no automated bypass):
-- Before running PART 2, the operator must type exactly:
--   DELETE TEST BATCH TEST-BATCH-FACTORY-UAT-2026-001
-- as acknowledgement, matching the counts reported above.

-- ===========================================================
-- PART 2 -- DELETE (dependency-safe order: children before parents)
-- ===========================================================
begin;

delete from factory_clarification_revisions where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_clarification_requests where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_transfer_items where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_transfers where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_packing_records where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_finished_goods where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_rejection_records where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_rework_records where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_quality_checks where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_wastage_records where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_product_costing where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from production_stage_updates where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_machine_logs where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_machines where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_material_transactions where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_material_stock where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_materials where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_drawings where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_cutting_list_items where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_cutting_lists where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_bom_items where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_boms where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from factory_production_plans where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from staff_tasks where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from inhouse_production_requests where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from purchase_requests where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';
delete from projects where test_batch_id = 'TEST-BATCH-FACTORY-UAT-2026-001';

-- Review the row counts printed for each DELETE above, then either:
commit;   -- if every count matched PART 1's report
-- or: rollback;   -- if anything looked wrong

-- ===========================================================
-- PART 3 -- cleanup audit record (run after a committed PART 2)
-- ===========================================================
insert into staff_audit_log (entity_type, entity_id, action, new_value, remarks, performed_at)
values ('factory_uat_batch', gen_random_uuid(), 'CLEANUP',
  jsonb_build_object('batch_id', 'TEST-BATCH-FACTORY-UAT-2026-001'),
  'Factory UAT batch TEST-BATCH-FACTORY-UAT-2026-001 deleted via factory_uat_cleanup.sql', now());

-- ===========================================================
-- OPTIONAL -- UAT test-account deactivation (separate from batch
-- cleanup; the 10 UAT login accounts are longer-lived than one data
-- batch, so this is not bundled into PART 2). Deactivates, does not
-- delete -- preserves the audit trail of who did what during UAT.
-- ===========================================================
-- update public.user_profiles set is_active = false where employee_code like 'UAT-%';

-- ===========================================================
-- VERIFICATION NOTE (filled in after running this script against a
-- disposable throwaway batch, before ever touching the real one):
--
-- Disposable batch TEST-BATCH-DISPOSABLE-001 (1 project + 1 purchase_request
-- + 1 inhouse_production_request, no deeper dependents) was created, this
-- script's PART 2 was run against it with the batch id substituted, and:
--   - All 3 disposable rows were deleted (0 remaining afterward).
--   - The real batch TEST-BATCH-FACTORY-UAT-2026-001 (100 jobs + all
--     dependents) was completely unaffected -- verified by re-running
--     PART 1's report immediately after, with unchanged counts.
--   - No real (is_test_data = false) row was touched in either run.
-- ===========================================================
