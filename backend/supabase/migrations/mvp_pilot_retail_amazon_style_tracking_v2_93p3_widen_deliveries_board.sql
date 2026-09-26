-- Widen retail_deliveries_board() with pipeline_status + installation_required so the new OrderTracker component
-- can render the real, single, controlled status instead of the raw retail_deliveries.stage column alone.
-- RETURNS TABLE column sets cannot be changed via bare CREATE OR REPLACE -- drop first.
drop function if exists public.retail_deliveries_board();

create function public.retail_deliveries_board()
returns table(delivery_id uuid, order_id uuid, order_number text, customer_name text, phone text, stage text, delivery_address text,
  contact_person text, contact_phone text, scheduled_at timestamp with time zone, vehicle_transporter text, assigned_team text,
  customer_confirmed boolean, feedback_score integer, delay_reason text, total_amount numeric, payment_status text,
  pipeline_status text, installation_required boolean)
language sql
stable security definer
set search_path to 'public'
as $function$
  select d.id, o.id, o.order_number, o.customer_name, o.phone, d.stage, coalesce(d.delivery_address, o.delivery_address),
    d.contact_person, d.contact_phone, d.scheduled_at, d.vehicle_transporter, d.assigned_team,
    d.customer_confirmed, d.feedback_score, d.delay_reason, o.total_amount, o.payment_status,
    o.pipeline_status, o.installation_required
  from public.retail_deliveries d join public.retail_orders o on o.id = d.order_id
  where o.is_active and (
    o.created_by = auth.uid() or staff_has_global_oversight() or (staff_is_dept_head() and staff_dept_in_hod_scope(o.department_id)))
  order by coalesce(d.scheduled_at, d.created_at) desc;
$function$;

grant execute on function public.retail_deliveries_board() to authenticated;
