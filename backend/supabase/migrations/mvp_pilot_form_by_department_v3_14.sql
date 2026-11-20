-- v3_14: the order form follows the ordering department.
--   Interior department -> always the Interior PO form (large, landscape, rate & amount)
--   Retail department   -> always the Retail PO form (small, portrait)
--   Any other department keeps the form chosen when the order was raised (and the Procurement Head's override).
-- Enforced in the database: a trigger sets the form on every order form of those departments, and the template override
-- refuses them. Existing rows of those departments are brought in line (procurement is empty after the 2026-11-20 reset).
begin;

create or replace function public.proc_department_form(p_department_id uuid)
returns text language sql stable security definer set search_path to 'public' as $$
  select case code when 'INTERIOR' then 'INTERIOR' when 'RETAIL' then 'RETAIL' end from public.departments where id = p_department_id;
$$;
revoke all on function public.proc_department_form(uuid) from public, anon;
grant execute on function public.proc_department_form(uuid) to authenticated;

create or replace function public.proc_form_by_department()
returns trigger language plpgsql set search_path to 'public' as $$
declare v_form text;
begin
  if new.order_form_type is null then return new; end if; -- a classic purchase request, not an order form
  v_form := public.proc_department_form(new.requesting_department_id);
  if v_form is not null then
    new.order_form_type := v_form;
    new.print_template := null;
  end if;
  return new;
end $$;

drop trigger if exists purchase_requests_form_by_department on public.purchase_requests;
create trigger purchase_requests_form_by_department
  before insert or update of order_form_type, print_template, requesting_department_id on public.purchase_requests
  for each row execute function public.proc_form_by_department();

create or replace function public.proc_order_template(p_row purchase_requests)
returns text language sql stable security definer set search_path to 'public' as $$
  select coalesce(case when p_row.order_form_type is not null then public.proc_department_form(p_row.requesting_department_id) end,
                  p_row.print_template, p_row.order_form_type,
                  case when (select code from public.departments where id = p_row.requesting_department_id) = 'INTERIOR' then 'INTERIOR' else 'RETAIL' end);
$$;

create or replace function public.proc_set_print_template(p_request_id uuid, p_template text, p_reason text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare r public.purchase_requests; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_old text; v_fixed text;
begin
  perform public.staff_assert_operational();
  if not coalesce(public.proc_is_procurement_head() or public.staff_has_global_oversight(), false) then
    raise exception 'Only the Procurement Head or Management can change the order form template';
  end if;
  if coalesce(p_template, '') not in ('INTERIOR', 'RETAIL') then raise exception 'Template must be INTERIOR or RETAIL'; end if;
  if v_reason is null then raise exception 'A reason is required to change the template'; end if;
  select * into r from public.purchase_requests where id = p_request_id for update;
  if r.id is null or r.proc_status = 'LEGACY' then raise exception 'Order not found'; end if;
  v_fixed := case when r.order_form_type is not null then public.proc_department_form(r.requesting_department_id) end;
  if v_fixed is not null then
    raise exception 'Orders from the % department always use the % PO form', initcap(v_fixed), initcap(v_fixed);
  end if;
  v_old := public.proc_order_template(r);
  if v_old = p_template then raise exception 'The order already uses this template'; end if;
  update public.purchase_requests set print_template = p_template where id = p_request_id;
  insert into public.purchase_request_status_history (purchase_request_id, from_status, to_status, actor_id, actor_role, remarks)
  values (p_request_id, r.proc_status, r.proc_status, auth.uid(), public.staff_current_role_code(),
          'Order form changed from ' || initcap(v_old) || ' to ' || initcap(p_template) || ': ' || v_reason);
  perform public.staff_write_audit('purchase_request', p_request_id, 'PRINT_TEMPLATE', jsonb_build_object('template', v_old),
    jsonb_build_object('template', p_template), r.requesting_department_id, v_reason);
end $$;

commit;
