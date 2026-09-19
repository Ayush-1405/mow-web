-- mvp_pilot_factory_uat_dataset_v2_64
--
-- 100 connected Factory UAT Job Orders (TEST-FJ-2026-0001..0100) plus
-- realistic linked records across the full production workflow, all
-- tagged with one batch id and is_test_data=true. Every stage/status
-- string used below was read directly out of the actual screens
-- (FactoryJobOrders.jsx / FactoryWipStages.jsx / FactoryDrawings.jsx /
-- FactoryBom.jsx / FactoryProductionPlanning.jsx / FactoryTransfer.jsx /
-- FactoryPacking.jsx / FactoryQcBoardShared.jsx / FactoryRejection.jsx)
-- so the seeded rows actually render and filter correctly in the app, not
-- just satisfy the database schema.
--
-- Actor-column FK note (verified live via pg_constraint before writing
-- this, not assumed): inhouse_production_requests' own coordinator
-- columns, and projects/purchase_requests, reference profiles(id) (the
-- Interior-system roster). Every other Factory table's actor columns
-- (created_by/approved_by/checked_by/assigned_to/etc.) reference
-- user_profiles(id) (the auth-space id) instead. Both id spaces are used
-- below, deliberately matched per table.
--
-- Schema note: inhouse_production_requests has no dedicated client/room/
-- material/finish/hardware/dimensions/priority columns -- those are
-- represented as descriptive text within product_item/special_instructions/
-- finishing_requirements/quality_requirements, and priority lives on the
-- parent purchase_requests row. This migration follows that real schema
-- rather than inventing columns that don't exist.
do $$
declare
  v_batch text := 'TEST-BATCH-FACTORY-UAT-2026-001';
  v_uat_project_id uuid;
  v_uat_location_id uuid;
  -- profiles(id) space -- inhouse_production_requests coordinators, projects/purchase_requests actors
  v_head_p uuid := '712d3ecc-29fe-4510-997c-10769eaacfae';
  v_planner_p uuid := 'a59db5c2-0866-4ecf-a11e-ac0b78640d9f';
  v_worker1_p uuid := 'e9d57fa9-8389-4b5d-926a-6a713407fed1';
  v_worker2_p uuid := 'd983915f-9e9e-439b-82f6-79faf1f55b6f';
  v_interior_p uuid;
  -- user_profiles(id) / auth space -- every other Factory table's actor columns, staff_tasks
  v_head_u uuid := '03ee2fb0-7807-459e-85bb-7116281d7fe7';
  v_planner_u uuid := 'd707f651-3d8e-4db9-b473-3952a54fd040';
  v_supervisor_u uuid := 'c16bc01c-953b-4b1b-b297-1fa7ffa7c8d7';
  v_worker1_u uuid := '731df5fe-e741-4911-b818-274d5b3b37c4';
  v_worker2_u uuid := '69efcfaf-101d-4843-a414-ffd48b40f946';
  v_qc_u uuid := '510a44a7-2623-4a2d-ba2a-f7653663def7';
  v_interior_u uuid := '64a4f7dd-9547-4c20-8a1e-18b3227a8903';
  v_factory_dept uuid := '797b412e-d43e-43ea-970c-bc79f350e5f5';
  v_interior_dept uuid := 'cbfa0069-1fe4-4377-9b7b-b240134b007f';
  v_task_type_id uuid; v_proof_none uuid; v_priority_normal uuid; v_priority_high uuid; v_priority_urgent uuid;
  v_status_assigned uuid; v_status_accepted uuid; v_status_in_progress uuid; v_status_completed uuid;
begin
  select id into v_interior_p from profiles where auth_id = v_interior_u;
  select id into v_task_type_id from task_types where code = 'GENERAL_TASK' and is_active;
  select id into v_proof_none from proof_types where code = 'none';
  select id into v_priority_normal from priority_master where code = 'NORMAL';
  select id into v_priority_high from priority_master where code = 'HIGH';
  select id into v_priority_urgent from priority_master where code = 'URGENT';
  select id into v_status_assigned from status_master where code = 'ASSIGNED';
  select id into v_status_accepted from status_master where code = 'ACCEPTED';
  select id into v_status_in_progress from status_master where code = 'IN_PROGRESS';
  select id into v_status_completed from status_master where code = 'COMPLETED';

  if exists (select 1 from inhouse_production_requests where test_batch_id = v_batch) then
    raise notice 'UAT batch % already seeded -- skipping.', v_batch;
    return;
  end if;

  insert into projects (project_code, customer, location, stage, created_by, is_test_data, test_batch_id, test_scenario_code)
  values ('UAT-FACTORY-TEST', 'UAT Test Client (Fictional)', 'UAT Factory Test Site', 'Execution', v_interior_p, true, v_batch, 'factory_uat_root')
  returning id into v_uat_project_id;

  select id into v_uat_location_id from factory_locations where code = 'FACT-FLOOR';

  create temporary table uat_job_seed on commit drop as
  select
    n,
    'TEST-FJ-2026-' || lpad(n::text, 4, '0') as job_order_number,
    'TEST-PR-2026-' || lpad(n::text, 4, '0') as request_number,
    case
      when n between 1 and 8 then 1 when n between 9 and 16 then 2 when n between 17 and 23 then 3
      when n between 24 and 30 then 4 when n between 31 and 38 then 5 when n between 39 and 45 then 6
      when n between 46 and 52 then 7 when n between 53 and 58 then 8 when n between 59 and 64 then 9
      when n between 65 and 70 then 10 when n between 71 and 75 then 11 when n between 76 and 80 then 12
      when n between 81 and 85 then 13 when n between 86 and 89 then 14 when n between 90 and 92 then 15
      when n between 93 and 94 then 16 when n between 95 and 97 then 17 when n between 98 and 99 then 18
      else 19
    end as stage_rank,
    (array['Kitchen Base Cabinet','Kitchen Wall Cabinet','Wardrobe','Bed','Bedside Table','TV Unit','Sofa','Dining Table','Study Table','Vanity','Door Panel','Loose Furniture Unit'])[(n % 12) + 1] as product_item,
    (array['Kitchen','Master Bedroom','Living Room','Kids Bedroom','Dining Area','Study Room','Guest Bedroom','Foyer'])[(n % 8) + 1] as room_area,
    (array['18mm BWP Plywood','MDF','HDF','19mm Particle Board','Marine Plywood'])[(n % 5) + 1] as material,
    (array['Laminate - Matte White','Laminate - Wood Grain','Veneer - Teak','PU Paint - Glossy White','PU Paint - Matte Grey','Acrylic - High Gloss'])[(n % 6) + 1] as finish,
    (array['Hettich Soft-Close Hinges','Hafele Channels','Ebco Handles','Blum Hinges + Channels','Standard Hardware Kit'])[(n % 5) + 1] as hardware,
    (array['Normal','High','Urgent','Critical'])[(n % 4) + 1] as priority_label,
    (2 + (n % 4))::numeric as quantity,
    (900 + (n % 6) * 150)::text || 'mm x ' || (500 + (n % 4) * 100)::text || 'mm x ' || (720 + (n % 3) * 90)::text || 'mm' as dimensions,
    (case when n % 5 = 0 then current_date - ((n % 10) + 3) when n % 5 = 1 then current_date + ((n % 3)) else current_date + ((n % 20) + 5) end) as due_date,
    (n % 4 = 0) as has_second_assignee,
    (n % 3 = 0) as needs_photo_proof
  from generate_series(1, 100) as n;

  -- 1. purchase_requests (parent of every job) -- profiles(id) actor space.
  create temporary table uat_pr on commit drop as
  with ins as (
    insert into purchase_requests (project_id, request_number, purchase_source, priority, purpose, status, requested_by, created_by, request_date, is_test_data, test_batch_id, test_scenario_code)
    select v_uat_project_id, request_number, 'in_house', priority_label,
      'UAT: ' || product_item || ' for ' || room_area || ' (' || job_order_number || ')',
      case when stage_rank = 1 then 'Draft' else 'Approved' end,
      v_interior_p, v_interior_p, current_date - (stage_rank * 2), true, v_batch, 'factory_uat_job'
    from uat_job_seed
    returning id, request_number
  )
  select * from ins;

  -- 2. inhouse_production_requests -- the 100 Factory Jobs. Coordinators
  --    use profiles(id); job_order_number carries `n` so later steps can
  --    recover it by parsing rather than a correlated subquery.
  create temporary table uat_job on commit drop as
  with ins as (
    insert into inhouse_production_requests (
      project_id, purchase_request_id, factory_location_id, production_department, product_item,
      quantity, unit, required_completion_date, delivery_site_date,
      assigned_factory_coordinator, second_assignee_coordinator, current_responsible_person,
      special_instructions, quality_requirements, finishing_requirements, packing_requirements,
      job_order_number, status, current_stage, completion_percentage,
      production_start_date, expected_completion_date,
      qc_status, rework_status, packing_status, dispatch_readiness,
      submitted_by, submitted_at, is_test_data, test_batch_id, test_scenario_code
    )
    select
      v_uat_project_id, pr.id, v_uat_location_id, 'Factory/Manufacturing', s.room_area || ' — ' || s.product_item,
      s.quantity, 'pcs', s.due_date, s.due_date + 3,
      v_worker1_p, case when s.has_second_assignee then v_worker2_p else null end, v_worker1_p,
      'Material: ' || s.material || '. Dimensions: ' || s.dimensions || '. UAT test job, batch ' || v_batch || '.',
      'Hardware: ' || s.hardware,
      'Finish: ' || s.finish,
      case when s.stage_rank >= 17 then 'Standard export-safe packing, corner protection' else null end,
      s.job_order_number,
      case s.stage_rank
        when 1 then 'Draft' when 2 then 'Submitted to Factory' when 3 then 'Factory Accepted' when 4 then 'Factory Accepted'
        when 5 then 'Material Check Pending' when 6 then 'Ready for Production'
        when 7 then 'Work in Progress' when 8 then 'Work in Progress' when 9 then 'Work in Progress'
        when 10 then 'Work in Progress' when 11 then 'Work in Progress' when 12 then 'Work in Progress'
        when 13 then 'QC Pending' when 14 then 'QC Pending' when 15 then 'Rework' when 16 then 'QC Failed'
        when 17 then 'Packing' when 18 then 'Ready for Dispatch' else 'Completed'
      end,
      case s.stage_rank
        when 1 then 'Planning' when 2 then 'Drawing Pending' when 3 then 'Drawing Pending' when 4 then 'Drawing Approved'
        when 5 then 'Material Pending' when 6 then 'Material Available'
        when 7 then 'Cutting' when 8 then 'Edge Banding' when 9 then 'CNC' when 10 then 'Carpentry/Assembly'
        when 11 then 'Polishing/Painting' when 12 then 'Hardware Fitting'
        when 13 then 'QC' when 14 then 'QC' when 15 then 'QC' when 16 then 'QC'
        when 17 then 'Packing' when 18 then 'Ready for Dispatch' else 'Installed/Completed'
      end,
      least(s.stage_rank * 5, 100),
      case when s.stage_rank >= 5 then s.due_date - 20 else null end,
      s.due_date,
      case when s.stage_rank between 13 and 16 then 'Pending' when s.stage_rank >= 17 then 'Passed' else null end,
      case when s.stage_rank = 15 then 'Rework Required' when s.stage_rank > 15 then 'Rework Completed' else null end,
      case when s.stage_rank = 17 then 'In Progress' when s.stage_rank >= 18 then 'Packed' else null end,
      case when s.stage_rank >= 18 then 'Ready' else null end,
      v_interior_p, now() - (s.stage_rank || ' days')::interval, true, v_batch, 'factory_uat_job'
    from uat_job_seed s join uat_pr pr on pr.request_number = s.request_number
    returning id, job_order_number
  )
  select id, job_order_number, split_part(job_order_number, '-', 4)::int as n from ins;

  -- Bridging task -- mirrors staff_submit_to_factory's real shape so every
  -- job also shows up in Factory's Today's Tasks (Interior -> Factory link).
  insert into staff_tasks (
    title, description, task_type_id, priority_id, status_id, proof_type_id,
    from_department_id, to_department_id, assigned_by, assigned_to, verifier_id, current_owner_id,
    due_date, project_id, source_module, is_active, is_test_data, test_batch_id, test_scenario_code
  )
  select
    'UAT Factory Job: ' || s.product_item || ' (' || s.job_order_number || ')',
    'Auto-generated Interior -> Factory UAT bridge task for ' || s.job_order_number,
    v_task_type_id,
    case s.priority_label when 'Urgent' then v_priority_urgent when 'Critical' then v_priority_urgent when 'High' then v_priority_high else v_priority_normal end,
    case when s.stage_rank = 1 then v_status_assigned when s.stage_rank between 2 and 6 then v_status_accepted
         when s.stage_rank between 7 and 16 then v_status_in_progress else v_status_completed end,
    v_proof_none, v_interior_dept, v_factory_dept, v_interior_u, v_worker1_u, v_interior_u, v_worker1_u,
    s.due_date, v_uat_project_id, 'factory_uat', true, true, v_batch, 'factory_uat_bridge_task'
  from uat_job_seed s;

  -- A. Production plans -- one per job.
  insert into factory_production_plans (
    plan_number, job_id, project_id, client, product_item, quantity, priority,
    planned_start_date, planned_completion_date, production_sequence, assigned_team, shift, machine_requirement,
    drawing_status, material_availability_status, notes, status, created_by, is_test_data, test_batch_id, test_scenario_code
  )
  select
    'TEST-PP-2026-' || lpad(s.n::text, 4, '0'), j.id, v_uat_project_id, 'UAT Test Client (Fictional)', s.product_item, s.quantity, s.priority_label,
    s.due_date - 20, s.due_date, s.n, v_planner_u, case when s.n % 2 = 0 then 'Day' else 'Night' end,
    case when s.stage_rank = 9 then 'CNC Router' when s.stage_rank in (7, 8) then 'Panel Saw' else 'General' end,
    case when s.stage_rank <= 3 then 'Pending' else 'Approved' end,
    case when s.stage_rank <= 4 then 'Pending' when s.stage_rank = 5 then 'Shortage' else 'Available' end,
    'UAT production plan for ' || s.job_order_number,
    case when s.stage_rank = 1 then 'Draft' when s.stage_rank <= 6 then 'Planned' when s.stage_rank = 15 then 'On Hold'
         when s.stage_rank <= 16 then 'In Production' when s.stage_rank >= 19 then 'Completed' else 'Released' end,
    v_planner_u, true, v_batch, 'factory_uat_plan'
  from uat_job_seed s join uat_job j on j.n = s.n;

  -- C. BOM + items -- for jobs Drawing Revision Required onward (stage_rank >= 3).
  create temporary table uat_bom on commit drop as
  with ins as (
    insert into factory_boms (bom_number, job_id, status, submitted_by, submitted_at, approved_by, approved_at, created_by, is_test_data, test_batch_id, test_scenario_code)
    select 'TEST-BOM-2026-' || lpad(s.n::text, 4, '0'), j.id,
      case when s.stage_rank = 3 then 'Rejected' when s.stage_rank >= 4 then 'Approved' else 'Submitted' end,
      v_planner_u, now() - (s.stage_rank || ' days')::interval,
      case when s.stage_rank >= 4 then v_head_u else null end, case when s.stage_rank >= 4 then now() - (s.stage_rank || ' days')::interval else null end,
      v_planner_u, true, v_batch, 'factory_uat_bom'
    from uat_job_seed s join uat_job j on j.n = s.n
    where s.stage_rank >= 3
    returning id, job_id
  )
  select ins.id, ins.job_id, j2.n from ins join uat_job j2 on j2.id = ins.job_id;

  insert into factory_bom_items (bom_id, material_name, material_code, category, unit, required_quantity, available_quantity, reserved_quantity, rate, notes, is_test_data, test_batch_id, test_scenario_code)
  select b.id, mat.name, mat.code, mat.category, mat.unit, mat.qty, mat.avail, mat.reserved,
    mat.rate, 'UAT BOM line', true, v_batch, 'factory_uat_bom_item'
  from uat_bom b
  cross join lateral (values
    ('18mm BWP Plywood Sheet', 'MAT-PLY-18', 'Board', 'sheet', 2 + (b.n % 3), 1 + (b.n % 3), 0, 950),
    ('1mm Laminate Sheet', 'MAT-LAM-01', 'Surface', 'sheet', 2 + (b.n % 2), 2 + (b.n % 2), 0, 420),
    ('PVC Edge Band 2mm', 'MAT-EDGE-02', 'Edge', 'mtr', 20 + (b.n % 10), 15 + (b.n % 10), 5, 12),
    ('Fevicol SH Adhesive', 'MAT-ADH-01', 'Consumable', 'ltr', 1, 1, 0, 260),
    ('Hettich Soft-Close Hinge', 'MAT-HNG-01', 'Hardware', 'pcs', 4 + (b.n % 4), 2 + (b.n % 4), 0, 145),
    ('Telescopic Channel 18"', 'MAT-CHN-18', 'Hardware', 'pair', 1 + (b.n % 2), 1, 0, 380)
  ) as mat(name, code, category, unit, qty, avail, reserved, rate)
  where b.n % 6 < 4 or mat.code in ('MAT-PLY-18', 'MAT-HNG-01');

  -- D. Cutting lists + items -- for jobs at/past Cutting (stage_rank >= 7).
  create temporary table uat_cl on commit drop as
  with ins as (
    insert into factory_cutting_lists (list_number, job_id, drawing_reference, revision_number, status, created_by, created_at, is_test_data, test_batch_id, test_scenario_code)
    select 'TEST-CL-2026-' || lpad(s.n::text, 4, '0'), j.id, 'TEST-DWG-2026-' || lpad(s.n::text, 4, '0'), 1,
      case when s.stage_rank >= 8 then 'Approved' else 'Draft' end, v_supervisor_u, now() - (s.stage_rank || ' days')::interval,
      true, v_batch, 'factory_uat_cutting_list'
    from uat_job_seed s join uat_job j on j.n = s.n
    where s.stage_rank >= 7
    returning id, job_id
  )
  select ins.id, j2.n from ins join uat_job j2 on j2.id = ins.job_id;

  insert into factory_cutting_list_items (cutting_list_id, part_name, material, length, width, thickness, quantity, edge_band_sides, grain_direction, machine_process, is_test_data, test_batch_id, test_scenario_code)
  select c.id, part.name, '18mm BWP Plywood', part.len, part.wid, part.thickness, part.qty, part.edge, part.grain, part.proc, true, v_batch, 'factory_uat_cutting_item'
  from uat_cl c
  cross join lateral (values
    ('Side Panel', 720 + (c.n % 5) * 10, 580, 18, 2, 'L,R', 'Vertical', 'Panel Saw'),
    ('Top Panel', 900 + (c.n % 5) * 10, 580, 18, 2, 'F', 'Horizontal', 'Panel Saw'),
    ('Bottom Panel', 900 + (c.n % 5) * 10, 580, 18, 4, 'All', 'Horizontal', 'CNC Router'),
    ('Shutter/Door', 715, 447, 18, 2, 'All', 'Vertical', 'Edge Bander'),
    ('Shelf', 880, 550, 18, 2, 'F', 'Horizontal', 'Panel Saw')
  ) as part(name, len, wid, thickness, qty, edge, grain, proc)
  where c.n % 5 < 3 or part.name in ('Side Panel', 'Top Panel');

  -- E. Drawings -- for jobs at/past Drawing Pending (stage_rank >= 2).
  --    Revision-required jobs (stage_rank=3) get 2 versions.
  insert into factory_drawings (job_id, category, title, storage_path, version_number, status, approved_by, approved_at, uploaded_by, uploaded_at, is_test_data, test_batch_id, test_scenario_code)
  select j.id, 'Working Drawing', s.job_order_number || ' — Working Drawing v1',
    'uat-test/' || v_batch || '/drawings/' || s.job_order_number || '-v1.pdf', 1,
    case when s.stage_rank = 3 then 'Revision Required' when s.stage_rank >= 4 then 'Approved' else 'Submitted' end,
    case when s.stage_rank >= 4 then v_head_u else null end, case when s.stage_rank >= 4 then now() - (s.stage_rank || ' days')::interval else null end,
    v_planner_u, now() - (s.stage_rank + 2 || ' days')::interval, true, v_batch, 'factory_uat_drawing'
  from uat_job_seed s join uat_job j on j.n = s.n
  where s.stage_rank >= 2;

  insert into factory_drawings (job_id, category, title, storage_path, version_number, revision_reason, status, approved_by, approved_at, uploaded_by, uploaded_at, is_test_data, test_batch_id, test_scenario_code)
  select j.id, 'Working Drawing', s.job_order_number || ' — Working Drawing v2 (Revised)',
    'uat-test/' || v_batch || '/drawings/' || s.job_order_number || '-v2.pdf', 2,
    'UAT: Interior requested hardware clearance correction', 'Approved', v_head_u, now() - interval '1 day',
    v_interior_u, now(), true, v_batch, 'factory_uat_drawing_revision'
  from uat_job_seed s join uat_job j on j.n = s.n
  where s.stage_rank = 3;

  -- F/G. Materials catalog + stock + transactions.
  create temporary table uat_materials on commit drop as
  with ins as (
    insert into factory_materials (material_code, material_name, category, unit, reorder_level, is_active, created_by, is_test_data, test_batch_id, test_scenario_code)
    select v.code, v.name, v.category, v.unit, v.reorder, true, v_planner_u, true, v_batch, 'factory_uat_material'
    from (values
      ('MAT-PLY-18', '18mm BWP Plywood Sheet', 'Board', 'sheet', 20),
      ('MAT-MDF-18', '18mm MDF Sheet', 'Board', 'sheet', 15),
      ('MAT-LAM-01', '1mm Laminate Sheet', 'Surface', 'sheet', 30),
      ('MAT-VNR-01', 'Teak Veneer Sheet', 'Surface', 'sheet', 10),
      ('MAT-EDGE-02', 'PVC Edge Band 2mm', 'Edge', 'mtr', 200),
      ('MAT-ADH-01', 'Fevicol SH Adhesive', 'Consumable', 'ltr', 10),
      ('MAT-HNG-01', 'Hettich Soft-Close Hinge', 'Hardware', 'pcs', 100),
      ('MAT-CHN-18', 'Telescopic Channel 18"', 'Hardware', 'pair', 40),
      ('MAT-HDL-01', 'Aluminium Profile Handle', 'Hardware', 'pcs', 60),
      ('MAT-GLS-01', 'Toughened Glass 5mm', 'Glass', 'sqft', 25),
      ('MAT-FOAM-01', 'Sofa Foam - High Density', 'Upholstery', 'sqft', 15),
      ('MAT-PAINT-01', 'PU Paint - Matte White', 'Finish', 'ltr', 12)
    ) as v(code, name, category, unit, reorder)
    returning id, material_code
  )
  select * from ins;

  insert into factory_material_stock (material_id, location_id, quantity_on_hand, reserved_quantity, is_test_data, test_batch_id, test_scenario_code)
  select m.id, v_uat_location_id,
    case m.material_code when 'MAT-PLY-18' then 45 when 'MAT-HNG-01' then 240 when 'MAT-EDGE-02' then 90 else 30 + (ascii(substr(m.material_code, 5, 1)) % 40) end,
    case m.material_code when 'MAT-EDGE-02' then 60 else 5 + (ascii(substr(m.material_code, 5, 1)) % 15) end,
    true, v_batch, 'factory_uat_stock'
  from uat_materials m;

  insert into factory_material_transactions (material_id, location_id, job_id, transaction_type, quantity, balance_after, reference_number, performed_by, performed_at, is_test_data, test_batch_id, test_scenario_code)
  select m.id, v_uat_location_id, j.id, 'issue', 2 + (s.n % 3),
    greatest(30, 45 - ((row_number() over (partition by m.id order by s.n)) * 2)),
    'TEST-ISS-' || lpad(s.n::text, 4, '0'), v_supervisor_u, now() - (s.stage_rank || ' days')::interval,
    true, v_batch, 'factory_uat_material_issue'
  from uat_job_seed s join uat_job j on j.n = s.n
  join uat_materials m on m.material_code = 'MAT-PLY-18'
  where s.stage_rank >= 6;

  -- H. Machines + logs.
  create temporary table uat_machines on commit drop as
  with ins as (
    insert into factory_machines (machine_code, machine_name, machine_type, location_id, status, created_by, is_test_data, test_batch_id, test_scenario_code)
    select v.code, v.name, v.type, v_uat_location_id, v.status, v_supervisor_u, true, v_batch, 'factory_uat_machine'
    from (values
      ('MC-PANEL-01', 'Panel Saw 1', 'Panel Saw', 'idle'),
      ('MC-CNC-01', 'CNC Router 1', 'CNC Router', 'running'),
      ('MC-EDGE-01', 'Edge Bander 1', 'Edge Bander', 'running'),
      ('MC-DRILL-01', 'Boring Machine 1', 'Boring Machine', 'idle'),
      ('MC-SPRAY-01', 'Spray Booth 1', 'Spray Booth', 'maintenance'),
      ('MC-PANEL-02', 'Panel Saw 2', 'Panel Saw', 'breakdown')
    ) as v(code, name, type, status)
    returning id, machine_code
  )
  select * from ins;

  insert into factory_machine_logs (machine_id, job_id, operator_id, process, shift, start_time, end_time, planned_quantity, processed_quantity, accepted_quantity, rejected_quantity, downtime_minutes, downtime_reason, created_by, is_test_data, test_batch_id, test_scenario_code)
  select mc.id, j.id, v_worker1_u,
    case s.stage_rank when 7 then 'Cutting' when 8 then 'Edge Banding' when 9 then 'CNC Machining' else 'General' end,
    case when s.n % 2 = 0 then 'Day' else 'Night' end,
    now() - (s.stage_rank || ' days')::interval, now() - (s.stage_rank || ' days')::interval + interval '3 hours',
    s.quantity, s.quantity, greatest(s.quantity - 1, 0), least(1, s.quantity)::numeric,
    case when s.n % 10 = 0 then 45 else 0 end, case when s.n % 10 = 0 then 'UAT: Blade change' else null end,
    v_worker1_u, true, v_batch, 'factory_uat_machine_log'
  from uat_job_seed s join uat_job j on j.n = s.n
  join uat_machines mc on mc.machine_code = case s.stage_rank when 7 then 'MC-PANEL-01' when 8 then 'MC-EDGE-01' when 9 then 'MC-CNC-01' else 'MC-PANEL-02' end
  where s.stage_rank in (7, 8, 9);

  -- I. WIP stage history -- current stage row for every job, plus one
  --    prior-stage history row for jobs already past planning.
  insert into production_stage_updates (job_id, stage, status, assigned_to, planned_start, planned_end, actual_start, actual_end, quantity_completed, quantity_pending, notes, shift, is_test_data, test_batch_id, test_scenario_code)
  select j.id,
    case s.stage_rank
      when 1 then 'Planning' when 2 then 'Drawing Pending' when 3 then 'Drawing Pending' when 4 then 'Drawing Approved'
      when 5 then 'Material Pending' when 6 then 'Material Available'
      when 7 then 'Cutting' when 8 then 'Edge Banding' when 9 then 'CNC' when 10 then 'Carpentry/Assembly'
      when 11 then 'Polishing/Painting' when 12 then 'Hardware Fitting'
      when 13 then 'QC' when 14 then 'QC' when 15 then 'QC' when 16 then 'QC'
      when 17 then 'Packing' when 18 then 'Ready for Dispatch' else 'Installed/Completed'
    end,
    case when s.stage_rank = 15 then 'on_hold' when s.stage_rank = 19 then 'completed' else 'in_progress' end,
    v_worker1_u, s.due_date - 20, s.due_date, now() - (s.stage_rank || ' days')::interval,
    case when s.stage_rank = 19 then now() else null end,
    round(s.quantity * least(s.stage_rank, 18) / 18.0, 1), round(s.quantity * (1 - least(s.stage_rank, 18) / 18.0), 1),
    'UAT current stage for ' || s.job_order_number, case when s.n % 2 = 0 then 'Day' else 'Night' end,
    true, v_batch, 'factory_uat_stage_current'
  from uat_job_seed s join uat_job j on j.n = s.n;

  insert into production_stage_updates (job_id, stage, status, assigned_to, planned_start, planned_end, actual_start, actual_end, quantity_completed, quantity_pending, notes, is_test_data, test_batch_id, test_scenario_code)
  select j.id, 'Planning', 'completed', v_planner_u, s.due_date - 25, s.due_date - 20, now() - (s.stage_rank + 5 || ' days')::interval, now() - (s.stage_rank + 3 || ' days')::interval,
    s.quantity, 0, 'UAT stage history — planning completed', true, v_batch, 'factory_uat_stage_history'
  from uat_job_seed s join uat_job j on j.n = s.n
  where s.stage_rank >= 4;

  -- K. Quality checks.
  insert into factory_quality_checks (job_id, dimensions_checked, material_checked, finish_checked, hardware_checked, drawing_matched, quantity_checked, result, defect_reason, rework_required, assigned_rework_person, checked_by, created_at, qc_stage, is_test_data, test_batch_id, test_scenario_code)
  select j.id, true, true, s.stage_rank <> 15, true, true, true,
    case when s.stage_rank in (15, 16) then 'fail' when s.stage_rank = 14 then 'conditional_pass' else 'pass' end,
    case when s.stage_rank in (15, 16) then 'UAT: Finish defect found on visible surface' else null end,
    s.stage_rank = 15, case when s.stage_rank = 15 then v_worker2_u else null end,
    v_qc_u, now() - (s.stage_rank || ' days')::interval, 'in_process', true, v_batch, 'factory_uat_qc_inprocess'
  from uat_job_seed s join uat_job j on j.n = s.n
  where s.stage_rank >= 13;

  insert into factory_quality_checks (job_id, dimensions_checked, material_checked, finish_checked, hardware_checked, drawing_matched, quantity_checked, result, checked_by, created_at, qc_stage, is_test_data, test_batch_id, test_scenario_code)
  select j.id, true, true, true, true, true, true, 'pass', v_qc_u, now() - (s.stage_rank || ' days')::interval, 'final', true, v_batch, 'factory_uat_qc_final'
  from uat_job_seed s join uat_job j on j.n = s.n
  where s.stage_rank >= 17;

  -- L. Rework (linked to the QC fail at stage_rank=15) and Rejection
  --    (linked to the QC fail at stage_rank=16).
  insert into factory_rework_records (rework_number, quality_check_id, job_id, defect_details, responsible_stage, assigned_to, required_completion_date, is_closed, created_by, is_test_data, test_batch_id, test_scenario_code)
  select 'TEST-RWK-2026-' || lpad(s.n::text, 4, '0'), qc.id, j.id, 'UAT: Finish defect found on visible surface', 'Polishing/Painting', v_worker2_u, s.due_date, false, v_qc_u, true, v_batch, 'factory_uat_rework'
  from uat_job_seed s join uat_job j on j.n = s.n
  join factory_quality_checks qc on qc.job_id = j.id and qc.qc_stage = 'in_process' and qc.result = 'fail'
  where s.stage_rank = 15;

  insert into factory_rejection_records (job_id, quality_check_id, rejected_quantity, reason, responsible_stage, disposition, rejected_by, rejected_at, is_test_data, test_batch_id, test_scenario_code)
  select j.id, qc.id, 1, 'UAT: Material damage beyond repair', 'Hardware Fitting', 'scrap', v_qc_u, now() - (s.stage_rank || ' days')::interval, true, v_batch, 'factory_uat_rejection'
  from uat_job_seed s join uat_job j on j.n = s.n
  join factory_quality_checks qc on qc.job_id = j.id and qc.qc_stage = 'in_process' and qc.result = 'fail'
  where s.stage_rank = 16;

  -- Wastage -- a representative sample across in-production jobs.
  insert into factory_wastage_records (job_id, material_name, process_stage, issued_quantity, used_quantity, returned_quantity, wastage_quantity, reason, reusable, created_by, is_test_data, test_batch_id, test_scenario_code)
  select j.id, '18mm BWP Plywood Sheet', 'Cutting', 3, 2.6, 0.2, 0.2, 'UAT: Offcut / grain mismatch trim', true, v_worker1_u, true, v_batch, 'factory_uat_wastage'
  from uat_job_seed s join uat_job j on j.n = s.n
  where s.stage_rank between 7 and 12 and s.n % 3 = 0;

  -- M. Finished Goods / Packing / Transfer -- only for jobs whose Final QC
  --    has passed (stage_rank >= 17).
  create temporary table uat_fg on commit drop as
  with ins as (
    insert into factory_finished_goods (fg_number, job_id, quality_check_id, completed_quantity, storage_location, barcode, created_by, is_test_data, test_batch_id, test_scenario_code)
    select 'TEST-FG-2026-' || lpad(s.n::text, 4, '0'), j.id, qc.id, s.quantity, 'Finished Goods Area', 'UAT' || lpad(s.n::text, 6, '0'), v_worker1_u, true, v_batch, 'factory_uat_finished_goods'
    from uat_job_seed s join uat_job j on j.n = s.n
    join factory_quality_checks qc on qc.job_id = j.id and qc.qc_stage = 'final'
    where s.stage_rank >= 17
    returning id, job_id
  )
  select ins.id, ins.job_id, j2.n from ins join uat_job j2 on j2.id = ins.job_id;

  insert into factory_packing_records (packing_number, job_id, finished_goods_id, packed_quantity, package_count, package_dimensions, package_weight, packing_material, status, packed_by, packed_at, created_by, is_test_data, test_batch_id, test_scenario_code)
  select 'TEST-PK-2026-' || lpad(fg.n::text, 4, '0'), fg.job_id, fg.id, s.quantity, 1,
    '1000mm x 700mm x 850mm', 35 + (fg.n % 10), 'Corrugated box + foam corner guards',
    case when s.stage_rank = 17 then 'In Progress' else 'Packed' end, v_worker2_u, now() - (s.stage_rank || ' days')::interval,
    v_worker2_u, true, v_batch, 'factory_uat_packing'
  from uat_fg fg join uat_job_seed s on s.n = fg.n;

  create temporary table uat_transfer on commit drop as
  with ins as (
    insert into factory_transfers (transfer_number, from_location_id, to_type, to_description, job_id, project_id, vehicle_number, transporter, dispatch_date, dispatched_by, status, created_by, is_test_data, test_batch_id, test_scenario_code)
    select 'TEST-TR-2026-' || lpad(s.n::text, 4, '0'), v_uat_location_id, 'site', 'UAT Factory Test Site', j.id, v_uat_project_id,
      'GJ01UT' || lpad(s.n::text, 4, '0'), 'UAT Test Transporter', now()::date - (19 - s.stage_rank), v_supervisor_u,
      case when s.stage_rank = 19 then 'Received' else 'Dispatched' end, v_supervisor_u, true, v_batch, 'factory_uat_transfer'
    from uat_job_seed s join uat_job j on j.n = s.n
    where s.stage_rank >= 18
    returning id, job_id
  )
  select ins.id, j2.n from ins join uat_job j2 on j2.id = ins.job_id;

  insert into factory_transfer_items (transfer_id, finished_goods_id, description, quantity, package_count, is_test_data, test_batch_id, test_scenario_code)
  select tr.id, fg.id, s.product_item, s.quantity, 1, true, v_batch, 'factory_uat_transfer_item'
  from uat_transfer tr join uat_job_seed s on s.n = tr.n join uat_fg fg on fg.n = tr.n;

  -- N. Product costing -- jobs at Final QC or beyond (stage_rank >= 14).
  insert into factory_product_costing (job_id, material_cost, hardware_cost, labour_cost, machine_cost, outsource_cost, packing_cost, transport_cost, other_cost, estimated_cost, approval_status, notes, updated_by, is_test_data, test_batch_id, test_scenario_code)
  select j.id,
    (2200 + (s.n % 5) * 150)::numeric, (600 + (s.n % 4) * 80)::numeric, (1500 + (s.n % 6) * 100)::numeric,
    (350 + (s.n % 3) * 50)::numeric, 0::numeric, (200 + (s.n % 2) * 50)::numeric, (300 + (s.n % 3) * 40)::numeric, 100::numeric,
    (5000 + (s.n % 6) * 200)::numeric,
    case when s.stage_rank >= 17 then 'Approved' else 'Submitted' end, 'UAT costing for ' || s.job_order_number, v_head_u,
    true, v_batch, 'factory_uat_costing'
  from uat_job_seed s join uat_job j on j.n = s.n
  where s.stage_rank >= 14;
  -- total_actual_cost/variance are GENERATED columns on this table (computed
  -- by the database itself from the cost components above) -- no manual
  -- update needed or possible; this is what "reproducible from source
  -- transactions" means at the schema level.

  -- Clarification requests -- "Factory requests drawing clarification,
  -- Interior replies with a revision" scenario, on the Drawing-Pending/
  -- Revision-Required jobs (stage_rank 2-3).
  create temporary table uat_clar on commit drop as
  with ins as (
    insert into factory_clarification_requests (job_id, project_id, reason, related_reference, status, raised_by, created_at, resolved_by, resolved_at, is_test_data, test_batch_id, test_scenario_code)
    select j.id, v_uat_project_id, 'UAT: Hardware clearance unclear on working drawing — please confirm channel depth.',
      s.job_order_number, case when s.stage_rank = 3 then 'resolved' else 'open' end,
      v_worker1_u, now() - (s.stage_rank + 1 || ' days')::interval,
      case when s.stage_rank = 3 then v_interior_u else null end, case when s.stage_rank = 3 then now() - interval '1 day' else null end,
      true, v_batch, 'factory_uat_clarification'
    from uat_job_seed s join uat_job j on j.n = s.n
    where s.stage_rank in (2, 3)
    returning id, job_id
  )
  select ins.id, j2.n from ins join uat_job j2 on j2.id = ins.job_id;

  insert into factory_clarification_revisions (clarification_id, revision_number, document_path, notes, uploaded_by, uploaded_at, decision, decided_by, decided_at, decision_notes, is_test_data, test_batch_id, test_scenario_code)
  select c.id, 1, 'uat-test/' || v_batch || '/clarifications/' || s.job_order_number || '-revision-1.pdf',
    'UAT: Revised drawing with corrected channel depth', v_interior_u, now() - interval '1 day',
    'accepted', v_worker1_u, now(), 'UAT: Confirmed, matches hardware spec', true, v_batch, 'factory_uat_clarification_revision'
  from uat_clar c join uat_job_seed s on s.n = c.n
  where s.stage_rank = 3;

  raise notice 'UAT batch % seeded: 100 jobs.', v_batch;
end $$;
