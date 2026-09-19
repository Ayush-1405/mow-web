-- mvp_pilot_inhouse_no_drawing_yet_v2_69
--
-- "No Drawing Available Yet" path for Submit to Factory: an Interior user
-- cannot call factory_update_stage directly (verified live -- it is
-- restricted to Management/Super Admin/the job's own assigned Factory
-- staff, correctly, since normally only Factory should move its own
-- production stages). So this is done inside staff_submit_to_factory
-- itself (which already runs as the Interior submitter, SECURITY DEFINER)
-- rather than as a second privileged call from an unauthorized caller:
-- when a reason is given, the job is created starting at current_stage =
-- 'Drawing Pending' instead of 'Planning', with the reason stored in the
-- existing delay_reason column and the expected date appended to
-- special_instructions (no dedicated column for it -- disclosed, not
-- silently invented).

create or replace function public.staff_submit_to_factory(
  p_project_id uuid, p_purchase_request_id uuid, p_factory_location_id uuid, p_product_item text,
  p_design_version_id uuid, p_working_drawing_version_id uuid, p_bom_reference text, p_quantity numeric, p_unit text,
  p_required_completion_date date, p_delivery_site_date date, p_assigned_factory_coordinator uuid,
  p_second_assignee uuid default null, p_special_instructions text default null, p_quality_requirements text default null,
  p_finishing_requirements text default null, p_packing_requirements text default null, p_installation_requirement text default null,
  p_production_department text default null, p_no_drawing_reason text default null, p_expected_drawing_date date default null
)
returns table(job_id uuid, job_order_number text, task_id uuid, task_number text, already_submitted boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_existing record;
  v_job_id uuid; v_job_order_number text;
  v_factory_dept uuid; v_interior_dept uuid;
  v_task record;
  v_project_code text; v_project_customer text;
  v_coordinator_auth uuid; v_second_auth uuid; v_caller_profile uuid;
  v_stage text; v_instructions text;
begin
  perform public.staff_assert_operational();
  if not (public.interior_is_org_wide() or public.interior_is_project_member(p_project_id)) then
    raise exception 'You are not authorized to submit work to Factory for this project';
  end if;
  if p_assigned_factory_coordinator is null then
    raise exception 'An Assigned Factory Coordinator is required';
  end if;
  if p_no_drawing_reason is not null and (btrim(p_no_drawing_reason) = '' or p_expected_drawing_date is null) then
    raise exception 'A reason and an expected drawing date are both required when no drawing is available yet';
  end if;

  select id into v_caller_profile from public.profiles where auth_id = auth.uid();
  if v_caller_profile is null then
    raise exception 'Your staff profile could not be resolved -- please contact an administrator';
  end if;

  select * into v_existing from public.inhouse_production_requests where purchase_request_id = p_purchase_request_id;
  if v_existing.id is not null then
    return query select v_existing.id, v_existing.job_order_number, v_existing.linked_task_id,
      (select st.task_number from public.staff_tasks st where st.id = v_existing.linked_task_id), true;
    return;
  end if;

  select id into v_factory_dept from public.departments where code = 'FACTORY';
  select id into v_interior_dept from public.departments where code = 'INTERIOR';
  select project_code, customer into v_project_code, v_project_customer from public.projects where id = p_project_id;
  if v_project_code is null then raise exception 'Invalid project'; end if;

  select auth_id into v_coordinator_auth from public.profiles where id = p_assigned_factory_coordinator;
  if v_coordinator_auth is null then
    raise exception 'The selected Factory Coordinator has no linked staff login and cannot be assigned a task';
  end if;
  if p_second_assignee is not null then
    select auth_id into v_second_auth from public.profiles where id = p_second_assignee;
    if v_second_auth is null then
      raise exception 'The selected Second Assignee has no linked staff login and cannot be assigned a task';
    end if;
  end if;

  select 'JO-' || lpad((select count(*) + 1 from public.inhouse_production_requests)::text, 6, '0') into v_job_order_number;

  v_stage := case when p_no_drawing_reason is not null then 'Drawing Pending' else 'Planning' end;
  v_instructions := p_special_instructions;
  if p_no_drawing_reason is not null then
    v_instructions := coalesce(v_instructions || ' | ', '') || 'No drawing available yet -- expected ' || p_expected_drawing_date::text;
  end if;

  insert into public.inhouse_production_requests (
    project_id, purchase_request_id, factory_location_id, product_item, design_version_id, working_drawing_version_id,
    bom_reference, quantity, unit, required_completion_date, delivery_site_date,
    assigned_factory_coordinator, second_assignee_coordinator,
    special_instructions, quality_requirements, finishing_requirements, packing_requirements, installation_requirement,
    production_department, job_order_number, status, current_stage, completion_percentage, submitted_by, submitted_at,
    delay_reason
  ) values (
    p_project_id, p_purchase_request_id, p_factory_location_id, p_product_item, p_design_version_id, p_working_drawing_version_id,
    p_bom_reference, p_quantity, p_unit, p_required_completion_date, p_delivery_site_date,
    p_assigned_factory_coordinator, p_second_assignee,
    v_instructions, p_quality_requirements, p_finishing_requirements, p_packing_requirements, p_installation_requirement,
    p_production_department, v_job_order_number, 'Submitted to Factory', v_stage, 0, v_caller_profile, now(),
    p_no_drawing_reason
  ) returning id into v_job_id;

  update public.purchase_requests set status = 'In-house Submitted' where id = p_purchase_request_id;

  select * into v_task from public.staff_create_task(
    'Factory Production: ' || p_product_item,
    coalesce(v_instructions, 'Interior production requirement — ' || v_project_code || ' — ' || v_project_customer),
    'FACTORY_REQUEST', 'NORMAL', 'none', v_interior_dept, v_factory_dept, v_coordinator_auth,
    p_required_completion_date, null, null, v_job_order_number, coalesce(p_bom_reference, ''), coalesce(p_quantity::text, ''),
    v_second_auth, p_project_id
  );

  update public.inhouse_production_requests set linked_task_id = v_task.task_id where id = v_job_id;

  perform public.staff_write_audit('inhouse_production_requests', v_job_id, 'SUBMIT_TO_FACTORY',
    null, jsonb_build_object('job_order_number', v_job_order_number, 'task_id', v_task.task_id, 'project_id', p_project_id, 'coordinator', p_assigned_factory_coordinator, 'no_drawing_yet', p_no_drawing_reason is not null), v_factory_dept);

  return query select v_job_id, v_job_order_number, v_task.task_id, v_task.task_number, false;
end;
$function$;

drop function if exists public.staff_submit_to_factory(uuid, uuid, uuid, text, uuid, uuid, text, numeric, text, date, date, uuid, uuid, text, text, text, text, text, text);
