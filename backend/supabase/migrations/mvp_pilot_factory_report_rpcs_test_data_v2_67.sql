-- mvp_pilot_factory_report_rpcs_test_data_v2_67
--
-- factory_worker_productivity / factory_shift_productivity /
-- factory_inventory_costing predate the Factory UAT test-data isolation
-- work (mvp_pilot_factory_uat_infra_v2_62) and were never updated to
-- exclude is_test_data rows -- a real, previously-disclosed gap: a normal
-- Factory user opening Worker/Shift Productivity or Inventory Costing (or
-- the new Factory Master Report) today sees the 100-job UAT batch mixed
-- into their real numbers with no way to turn it off. Each RPC gets one
-- new parameter, p_include_test_data boolean default false, applied to
-- every underlying source table exactly like every other Factory list
-- function already does -- default behaviour (omit the parameter) is
-- unchanged for every existing caller.

create or replace function public.factory_worker_productivity(p_from date default null::date, p_to date default null::date, p_include_test_data boolean default false)
returns table(employee_id uuid, employee_name text, assigned_jobs bigint, completed_stages bigint, planned_minutes numeric, actual_minutes numeric, qc_accepted bigint, qc_rejected bigint, rework_count bigint)
language sql
stable security definer
set search_path to 'public'
as $function$
  with my_stages as (
    select s.* from public.production_stage_updates s
    where (p_from is null or s.updated_at::date >= p_from) and (p_to is null or s.updated_at::date <= p_to)
      and (p_include_test_data or s.is_test_data = false)
  ),
  by_emp as (
    select assigned_to as employee_id, count(distinct job_id) as assigned_jobs,
      count(*) filter (where status = 'completed') as completed_stages,
      sum(extract(epoch from (coalesce(planned_end, actual_end) - coalesce(planned_start, actual_start))) / 60) filter (where planned_start is not null and planned_end is not null) as planned_minutes,
      sum(extract(epoch from (actual_end - actual_start)) / 60) filter (where actual_start is not null and actual_end is not null) as actual_minutes
    from my_stages where assigned_to is not null group by assigned_to
  ),
  qc_by_emp as (
    select checked_by as employee_id,
      count(*) filter (where result in ('pass','conditional_pass')) as qc_accepted,
      count(*) filter (where result = 'fail') as qc_rejected
    from public.factory_quality_checks
    where (p_from is null or created_at::date >= p_from) and (p_to is null or created_at::date <= p_to)
      and (p_include_test_data or is_test_data = false)
    group by checked_by
  ),
  rework_by_emp as (
    select assigned_to as employee_id, count(*) as rework_count from public.factory_rework_records
    where (p_from is null or created_at::date >= p_from) and (p_to is null or created_at::date <= p_to)
      and (p_include_test_data or is_test_data = false)
    group by assigned_to
  )
  select up.id, up.full_name, coalesce(e.assigned_jobs, 0), coalesce(e.completed_stages, 0),
    coalesce(e.planned_minutes, 0), coalesce(e.actual_minutes, 0), coalesce(q.qc_accepted, 0), coalesce(q.qc_rejected, 0), coalesce(r.rework_count, 0)
  from public.user_profiles up
  left join by_emp e on e.employee_id = up.id
  left join qc_by_emp q on q.employee_id = up.id
  left join rework_by_emp r on r.employee_id = up.id
  join public.departments d on d.id = up.department_id and d.code = 'FACTORY'
  where up.is_active = true and (e.employee_id is not null or q.employee_id is not null or r.employee_id is not null)
  order by up.full_name;
$function$;

create or replace function public.factory_shift_productivity(p_from date default null::date, p_to date default null::date, p_include_test_data boolean default false)
returns table(shift_date date, shift text, jobs_touched bigint, stages_completed bigint, qc_pass bigint, qc_fail bigint, rework_count bigint, rejection_count bigint)
language sql
stable security definer
set search_path to 'public'
as $function$
  with stage_rows as (
    select updated_at::date as d, coalesce(shift, 'General') as sh, job_id, status
    from public.production_stage_updates
    where (p_from is null or updated_at::date >= p_from) and (p_to is null or updated_at::date <= p_to)
      and (p_include_test_data or is_test_data = false)
  ),
  qc_rows as (
    select created_at::date as d, job_id, result from public.factory_quality_checks
    where (p_from is null or created_at::date >= p_from) and (p_to is null or created_at::date <= p_to)
      and (p_include_test_data or is_test_data = false)
  ),
  rework_rows as (
    select created_at::date as d from public.factory_rework_records
    where (p_from is null or created_at::date >= p_from) and (p_to is null or created_at::date <= p_to)
      and (p_include_test_data or is_test_data = false)
  ),
  rejection_rows as (
    select rejected_at::date as d from public.factory_rejection_records
    where (p_from is null or rejected_at::date >= p_from) and (p_to is null or rejected_at::date <= p_to)
      and (p_include_test_data or is_test_data = false)
  )
  select s.d, s.sh, count(distinct s.job_id), count(*) filter (where s.status = 'completed'),
    coalesce((select count(*) from qc_rows q where q.d = s.d and q.result in ('pass','conditional_pass')), 0),
    coalesce((select count(*) from qc_rows q where q.d = s.d and q.result = 'fail'), 0),
    coalesce((select count(*) from rework_rows r where r.d = s.d), 0),
    coalesce((select count(*) from rejection_rows rj where rj.d = s.d), 0)
  from stage_rows s
  group by s.d, s.sh
  order by s.d desc, s.sh;
$function$;

create or replace function public.factory_inventory_costing(p_from date default null::date, p_to date default null::date, p_include_test_data boolean default false)
returns table(material_id uuid, material_code text, material_name text, location_id uuid, location_name text, opening_quantity numeric, received_quantity numeric, issued_quantity numeric, adjustment_quantity numeric, closing_quantity numeric)
language sql
stable security definer
set search_path to 'public'
as $function$
  with opening as (
    select t.material_id, t.location_id,
      coalesce(sum(case when t.transaction_type in ('receipt','return') then t.quantity when t.transaction_type = 'issue' then -t.quantity else 0 end), 0) as qty
    from public.factory_material_transactions t
    where p_from is not null and t.performed_at::date < p_from
      and (p_include_test_data or t.is_test_data = false)
    group by t.material_id, t.location_id
  ),
  period as (
    select t.material_id, t.location_id,
      coalesce(sum(t.quantity) filter (where t.transaction_type in ('receipt','return')), 0) as received,
      coalesce(sum(t.quantity) filter (where t.transaction_type = 'issue'), 0) as issued,
      coalesce(sum(t.quantity) filter (where t.transaction_type = 'adjustment'), 0) as adjustment
    from public.factory_material_transactions t
    where (p_from is null or t.performed_at::date >= p_from) and (p_to is null or t.performed_at::date <= p_to)
      and (p_include_test_data or t.is_test_data = false)
    group by t.material_id, t.location_id
  )
  select m.id, m.material_code, m.material_name, l.id, l.name,
    coalesce(o.qty, 0), coalesce(p.received, 0), coalesce(p.issued, 0), coalesce(p.adjustment, 0),
    coalesce(o.qty, 0) + coalesce(p.received, 0) - coalesce(p.issued, 0) + coalesce(p.adjustment, 0)
  from public.factory_materials m
  cross join public.factory_locations l
  left join opening o on o.material_id = m.id and o.location_id = l.id
  left join period p on p.material_id = m.id and p.location_id = l.id
  where m.is_active = true and l.active = true and (o.material_id is not null or p.material_id is not null)
    and (p_include_test_data or m.is_test_data = false)
  order by m.material_name, l.name;
$function$;

-- CREATE OR REPLACE does not replace a function when the argument list
-- changes -- it creates a second overload instead, which made the three
-- calls above ambiguous (PostgREST/psql couldn't tell which overload a
-- 2-argument call meant). Confirmed live and fixed in the same pass, before
-- this was ever left in a broken state: drop the old 2-argument signature
-- now that the 3-argument one (with a default, so 2-argument calls still
-- work) is the only one left.
drop function if exists public.factory_worker_productivity(date, date);
drop function if exists public.factory_shift_productivity(date, date);
drop function if exists public.factory_inventory_costing(date, date);
