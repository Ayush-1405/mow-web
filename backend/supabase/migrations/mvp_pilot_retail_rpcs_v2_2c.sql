-- Mood of Wood — Staff Pilot — Retail Stores narrow write RPCs.
--
-- Two SECURITY DEFINER functions for the two Retail writes that must never
-- be done as a raw client INSERT/UPDATE because they touch two tables that
-- must never drift apart:
--   - retail_record_payment(): inserts a retail_payments row AND updates
--     the parent retail_orders.amount_paid/payment_status atomically.
--   - retail_convert_quotation_to_order(): copies an ACCEPTED quotation's
--     items into a new order server-side, so totals/items are never
--     duplicated by hand on the client.
-- Both re-check the caller's authorization against the SAME scoping rule
-- as the table RLS policies (staff_is_management/staff_is_dept_head/
-- staff_dept_in_hod_scope/own department), since SECURITY DEFINER bypasses
-- RLS — the function body is the only gate once inside it.
--
-- Idempotent (CREATE OR REPLACE FUNCTION + GRANT). Does not touch any
-- existing table, function, or policy.

CREATE OR REPLACE FUNCTION public.retail_record_payment(
  p_order_id uuid,
  p_amount numeric,
  p_payment_mode text DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS public.retail_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order public.retail_orders;
  v_allowed boolean;
  v_new_paid numeric(12,2);
  v_new_status text;
BEGIN
  PERFORM public.staff_assert_operational();

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  SELECT * INTO v_order FROM public.retail_orders WHERE id = p_order_id;
  IF v_order IS NULL THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  v_allowed := (
    v_order.created_by = auth.uid()
    OR public.staff_is_management()
    OR (public.staff_is_dept_head() AND public.staff_dept_in_hod_scope(v_order.department_id))
  );
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Not authorized to record a payment on this order';
  END IF;

  INSERT INTO public.retail_payments (order_id, amount, payment_mode, note, created_by)
  VALUES (p_order_id, p_amount, p_payment_mode, p_note, auth.uid());

  v_new_paid := v_order.amount_paid + p_amount;
  v_new_status := CASE
    WHEN v_new_paid >= v_order.total_amount AND v_order.total_amount > 0 THEN 'PAID'
    WHEN v_new_paid > 0 THEN 'PARTIAL'
    ELSE 'PENDING'
  END;

  UPDATE public.retail_orders
  SET amount_paid = v_new_paid, payment_status = v_new_status
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  RETURN v_order;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.retail_record_payment(uuid, numeric, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.retail_convert_quotation_to_order(p_quotation_id uuid)
RETURNS public.retail_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_quotation public.retail_quotations;
  v_allowed boolean;
  v_order public.retail_orders;
  v_order_number text;
BEGIN
  PERFORM public.staff_assert_operational();

  SELECT * INTO v_quotation FROM public.retail_quotations WHERE id = p_quotation_id;
  IF v_quotation IS NULL THEN
    RAISE EXCEPTION 'Quotation not found';
  END IF;
  IF v_quotation.status <> 'ACCEPTED' THEN
    RAISE EXCEPTION 'Only an ACCEPTED quotation can be converted to an order';
  END IF;

  v_allowed := (
    v_quotation.created_by = auth.uid()
    OR public.staff_is_management()
    OR (public.staff_is_dept_head() AND public.staff_dept_in_hod_scope(v_quotation.department_id))
  );
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Not authorized to convert this quotation';
  END IF;

  v_order_number := 'ORD-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  INSERT INTO public.retail_orders (
    department_id, quotation_id, order_number, customer_name, phone, total_amount, created_by
  ) VALUES (
    v_quotation.department_id, v_quotation.id, v_order_number, v_quotation.customer_name,
    v_quotation.phone, v_quotation.total_amount, auth.uid()
  ) RETURNING * INTO v_order;

  INSERT INTO public.retail_order_items (order_id, item_name, quantity, unit_price, line_total)
  SELECT v_order.id, item_name, quantity, unit_price, line_total
  FROM public.retail_quotation_items
  WHERE quotation_id = v_quotation.id;

  UPDATE public.retail_leads SET converted_order_id = v_order.id, status = 'CONVERTED'
  WHERE id = v_quotation.lead_id;

  RETURN v_order;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.retail_convert_quotation_to_order(uuid) TO authenticated;
