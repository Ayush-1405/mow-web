-- mvp_pilot_factory_uat_infra_v2_62
--
-- Foundation for a safe, isolated Factory UAT dataset on this single
-- Supabase project (bykmyttaesuyjwvtnxks -- confirmed the only project in
-- the org; there is no separate staging/UAT project). Per the requested
-- safety model: every table that will receive generated test rows gets
-- is_test_data/test_batch_id/test_scenario_code, defaulting to
-- is_test_data=false so every existing real row is completely untouched
-- and unaffected. No existing row is updated by this migration.
--
-- Also fixes two real, verified bugs found while auditing the Factory
-- dashboard header ("Department Head: —", "Active Members: 0",
-- "Locations: 0"):
--   1. factory_locations has zero rows -- the module has no reference
--      locations to attach machines/material stock to, and the dashboard
--      has nothing to count. These 5 are real, permanent reference data
--      (not test data -- every department needs its locations to exist
--      regardless of UAT), matching the "UAT Factory Floor" etc. naming
--      only because no real Factory locations exist yet to name them after.
--   2. DepartmentDashboard.jsx calls an RPC `staff_department_head_public`
--      for non-elevated viewers that does not exist in this database
--      (confirmed: zero rows in pg_proc) -- it fails silently by design,
--      per the existing code comment, but that silence is exactly why the
--      tile always shows "—" for anyone who isn't dept_head/management.
--      Added here so every viewer, not just elevated roles, can see who
--      the department head is (name only -- no other profile data).

-- ---------------------------------------------------------------------
-- 1. Test-data isolation columns.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'projects','purchase_requests','inhouse_production_requests',
    'factory_production_plans','factory_boms','factory_bom_items',
    'factory_cutting_lists','factory_cutting_list_items','factory_drawings',
    'factory_materials','factory_material_stock','factory_material_transactions',
    'factory_machines','factory_machine_logs','production_stage_updates',
    'factory_quality_checks','factory_rework_records','factory_rejection_records',
    'factory_wastage_records','factory_finished_goods','factory_packing_records',
    'factory_transfers','factory_transfer_items','factory_product_costing',
    'factory_clarification_requests','factory_clarification_revisions',
    'staff_tasks','staff_attachments','notifications'
  ];
begin
  foreach t in array tables loop
    execute format('alter table public.%I add column if not exists is_test_data boolean not null default false', t);
    execute format('alter table public.%I add column if not exists test_batch_id text', t);
    execute format('alter table public.%I add column if not exists test_scenario_code text', t);
  end loop;
end $$;

-- Fast, cheap "give me only this batch" lookups during seeding/cleanup —
-- and fast "exclude test data" scans for the normal-user default view.
create index if not exists idx_inhouse_production_requests_test_batch on public.inhouse_production_requests(test_batch_id) where test_batch_id is not null;
create index if not exists idx_inhouse_production_requests_is_test on public.inhouse_production_requests(is_test_data);

-- ---------------------------------------------------------------------
-- 2. Real, permanent Factory reference locations (zero existed before
--    this migration -- confirmed via `select count(*) from factory_locations`).
-- ---------------------------------------------------------------------
insert into public.factory_locations (name, code, active)
select v.name, v.code, true
from (values
  ('Factory Floor', 'FACT-FLOOR'),
  ('Raw Material Store', 'FACT-RM-STORE'),
  ('Finished Goods Area', 'FACT-FG-AREA'),
  ('Packing Area', 'FACT-PACKING'),
  ('Dispatch Bay', 'FACT-DISPATCH')
) as v(name, code)
where not exists (select 1 from public.factory_locations fl where fl.code = v.code);

-- ---------------------------------------------------------------------
-- 3. staff_department_head_public -- read-only, SECURITY DEFINER, returns
--    only the department head's display name (nothing else) so every
--    authenticated staff member can see it, not only elevated roles.
--    DepartmentDashboard.jsx already calls this exact name/signature and
--    already tolerates it not existing (silent catch) -- this just makes
--    that already-written call path succeed.
-- ---------------------------------------------------------------------
create or replace function public.staff_department_head_public(p_department_id uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select up.full_name
  from public.user_profiles up
  join public.roles r on r.id = up.role_id
  where up.department_id = p_department_id
    and r.code = 'dept_head'
    and up.is_active = true
  order by up.created_at asc
  limit 1;
$function$;

grant execute on function public.staff_department_head_public(uuid) to authenticated;
