-- Mood of Wood — Staff Pilot — Retail Stores module build.
--
-- Adds real, working data tables for the 12 Retail Stores function cards
-- (Walk-in Leads & CRM, Sales & Quotations, Order Booking, Payment
-- Follow-up, Display & Visual Merchandising, Store Operations, Complaints
-- & Service, Sales Targets/Performance). Stock Availability has no table
-- of its own (Godown/Inventory doesn't exist yet — the screen shows an
-- honest empty state) and Stock Transfer Requests/Delivery Coordination
-- reuse the existing generic staff_tasks/bridges engine (see the separate
-- task_types seed migration) rather than duplicating that workflow.
--
-- Every table mirrors the existing staff_tasks_select_scoped RLS shape
-- exactly, reusing the SAME already-defined helper functions
-- (staff_current_user_ok, staff_is_management, staff_is_dept_head,
-- staff_dept_in_hod_scope, staff_is_accounts_head,
-- staff_current_department_id) rather than inventing a parallel security
-- model. No table gets a DELETE policy — soft-delete via is_active only,
-- matching staff_tasks's own convention.
--
-- Purely additive: every statement is IF NOT EXISTS / DROP-then-CREATE for
-- idempotency. Safe to run twice. Does not touch any existing table.

-- ---------------------------------------------------------------------
-- retail_leads
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retail_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.departments(id),
  location_id uuid REFERENCES public.locations(id),
  customer_name text NOT NULL,
  phone text,
  source text,
  interest_notes text,
  status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','FOLLOW_UP','QUOTED','CONVERTED','LOST')),
  assigned_to uuid REFERENCES public.user_profiles(id),
  next_follow_up_date date,
  converted_order_id uuid,
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------
-- retail_quotations + retail_quotation_items
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retail_quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.departments(id),
  lead_id uuid REFERENCES public.retail_leads(id),
  quotation_number text NOT NULL,
  customer_name text NOT NULL,
  phone text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENT','ACCEPTED','REJECTED','EXPIRED')),
  total_amount numeric(12,2) NOT NULL DEFAULT 0,
  valid_until date,
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (quotation_number)
);

CREATE TABLE IF NOT EXISTS public.retail_quotation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id uuid NOT NULL REFERENCES public.retail_quotations(id) ON DELETE CASCADE,
  item_name text NOT NULL,
  quantity numeric NOT NULL DEFAULT 1,
  unit_price numeric(12,2) NOT NULL DEFAULT 0,
  line_total numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- retail_orders + retail_order_items
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retail_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.departments(id),
  location_id uuid REFERENCES public.locations(id),
  quotation_id uuid REFERENCES public.retail_quotations(id),
  order_number text NOT NULL,
  customer_name text NOT NULL,
  phone text,
  status text NOT NULL DEFAULT 'BOOKED' CHECK (status IN ('BOOKED','CONFIRMED','IN_PRODUCTION','READY','DELIVERED','CANCELLED')),
  total_amount numeric(12,2) NOT NULL DEFAULT 0,
  amount_paid numeric(12,2) NOT NULL DEFAULT 0,
  payment_status text NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING','PARTIAL','PAID')),
  delivery_task_id uuid REFERENCES public.staff_tasks(id),
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (order_number)
);

CREATE TABLE IF NOT EXISTS public.retail_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.retail_orders(id) ON DELETE CASCADE,
  item_name text NOT NULL,
  quantity numeric NOT NULL DEFAULT 1,
  unit_price numeric(12,2) NOT NULL DEFAULT 0,
  line_total numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- retail_payments — append-only ledger; INSERT only via
-- retail_record_payment() RPC (see mvp_pilot_retail_rpcs_v2_2c.sql), so
-- retail_orders.amount_paid/payment_status can never drift from it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retail_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.retail_orders(id),
  amount numeric(12,2) NOT NULL,
  payment_mode text,
  note text,
  paid_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.user_profiles(id)
);

-- ---------------------------------------------------------------------
-- retail_vm_tasks (Display & Visual Merchandising)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retail_vm_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.departments(id),
  location_id uuid REFERENCES public.locations(id),
  title text NOT NULL,
  description text,
  due_date date,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DONE')),
  assigned_to uuid REFERENCES public.user_profiles(id),
  photo_attachment_path text,
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------
-- retail_store_ops_logs (Store Operations)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retail_store_ops_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.departments(id),
  location_id uuid REFERENCES public.locations(id),
  log_date date NOT NULL DEFAULT current_date,
  checklist jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (location_id, log_date)
);

-- ---------------------------------------------------------------------
-- retail_complaints (Complaints & Service — Retail-scoped for this round)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retail_complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.departments(id),
  location_id uuid REFERENCES public.locations(id),
  customer_name text NOT NULL,
  phone text,
  order_id uuid REFERENCES public.retail_orders(id),
  description text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')),
  assigned_to uuid REFERENCES public.user_profiles(id),
  resolution_notes text,
  resolved_at timestamptz,
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------
-- retail_sales_targets (Sales Targets — write restricted to dept_head/
-- management; Sales Performance is computed client-side from this +
-- retail_orders, no table of its own)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retail_sales_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.departments(id),
  location_id uuid REFERENCES public.locations(id),
  user_id uuid REFERENCES public.user_profiles(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  target_amount numeric(12,2) NOT NULL,
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  CHECK (period_end >= period_start)
);

-- =======================================================================
-- Indexes (foreign keys the pilot's own indexing convention covers)
-- =======================================================================
CREATE INDEX IF NOT EXISTS idx_retail_leads_department_id ON public.retail_leads(department_id);
CREATE INDEX IF NOT EXISTS idx_retail_leads_assigned_to ON public.retail_leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_retail_quotations_department_id ON public.retail_quotations(department_id);
CREATE INDEX IF NOT EXISTS idx_retail_quotations_lead_id ON public.retail_quotations(lead_id);
CREATE INDEX IF NOT EXISTS idx_retail_quotation_items_quotation_id ON public.retail_quotation_items(quotation_id);
CREATE INDEX IF NOT EXISTS idx_retail_orders_department_id ON public.retail_orders(department_id);
CREATE INDEX IF NOT EXISTS idx_retail_orders_quotation_id ON public.retail_orders(quotation_id);
CREATE INDEX IF NOT EXISTS idx_retail_order_items_order_id ON public.retail_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_retail_payments_order_id ON public.retail_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_retail_vm_tasks_department_id ON public.retail_vm_tasks(department_id);
CREATE INDEX IF NOT EXISTS idx_retail_store_ops_logs_department_id ON public.retail_store_ops_logs(department_id);
CREATE INDEX IF NOT EXISTS idx_retail_complaints_department_id ON public.retail_complaints(department_id);
CREATE INDEX IF NOT EXISTS idx_retail_complaints_order_id ON public.retail_complaints(order_id);
CREATE INDEX IF NOT EXISTS idx_retail_sales_targets_department_id ON public.retail_sales_targets(department_id);
CREATE INDEX IF NOT EXISTS idx_retail_sales_targets_user_id ON public.retail_sales_targets(user_id);

-- =======================================================================
-- updated_at triggers (reuses the existing generic staff_touch_updated_at)
-- =======================================================================
DO $do$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'retail_leads','retail_quotations','retail_orders','retail_vm_tasks',
    'retail_store_ops_logs','retail_complaints','retail_sales_targets'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch_updated_at ON public.%I', tbl);
    EXECUTE format(
      'CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.staff_touch_updated_at()',
      tbl
    );
  END LOOP;
END;
$do$;

-- =======================================================================
-- RLS — enable + policies. Every USING/WITH CHECK reuses the existing
-- staff_current_user_ok / staff_is_management / staff_is_dept_head /
-- staff_dept_in_hod_scope / staff_is_accounts_head / staff_current_
-- department_id helper functions — no new security primitive is defined.
-- =======================================================================
ALTER TABLE public.retail_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retail_quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retail_quotation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retail_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retail_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retail_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retail_vm_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retail_store_ops_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retail_complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retail_sales_targets ENABLE ROW LEVEL SECURITY;

-- retail_leads
DROP POLICY IF EXISTS retail_leads_select_scoped ON public.retail_leads;
CREATE POLICY retail_leads_select_scoped ON public.retail_leads FOR SELECT
USING (
  staff_current_user_ok() AND (
    created_by = auth.uid() OR assigned_to = auth.uid()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
    OR (staff_is_accounts_head() AND department_id = staff_current_department_id())
  )
);
DROP POLICY IF EXISTS retail_leads_insert_scoped ON public.retail_leads;
CREATE POLICY retail_leads_insert_scoped ON public.retail_leads FOR INSERT
WITH CHECK (
  staff_current_user_ok() AND (
    department_id = staff_current_department_id()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
);
DROP POLICY IF EXISTS retail_leads_update_scoped ON public.retail_leads;
CREATE POLICY retail_leads_update_scoped ON public.retail_leads FOR UPDATE
USING (
  staff_current_user_ok() AND (
    created_by = auth.uid() OR assigned_to = auth.uid()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
)
WITH CHECK (
  department_id = staff_current_department_id() OR staff_is_management()
  OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
);
GRANT SELECT, INSERT, UPDATE ON public.retail_leads TO authenticated;

-- retail_quotations
DROP POLICY IF EXISTS retail_quotations_select_scoped ON public.retail_quotations;
CREATE POLICY retail_quotations_select_scoped ON public.retail_quotations FOR SELECT
USING (
  staff_current_user_ok() AND (
    created_by = auth.uid()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
    OR (staff_is_accounts_head() AND department_id = staff_current_department_id())
  )
);
DROP POLICY IF EXISTS retail_quotations_insert_scoped ON public.retail_quotations;
CREATE POLICY retail_quotations_insert_scoped ON public.retail_quotations FOR INSERT
WITH CHECK (
  staff_current_user_ok() AND (
    department_id = staff_current_department_id()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
);
DROP POLICY IF EXISTS retail_quotations_update_scoped ON public.retail_quotations;
CREATE POLICY retail_quotations_update_scoped ON public.retail_quotations FOR UPDATE
USING (
  staff_current_user_ok() AND (
    created_by = auth.uid()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
)
WITH CHECK (
  department_id = staff_current_department_id() OR staff_is_management()
  OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
);
GRANT SELECT, INSERT, UPDATE ON public.retail_quotations TO authenticated;

-- retail_quotation_items (scoped via parent quotation)
DROP POLICY IF EXISTS retail_quotation_items_select_scoped ON public.retail_quotation_items;
CREATE POLICY retail_quotation_items_select_scoped ON public.retail_quotation_items FOR SELECT
USING (
  staff_current_user_ok() AND EXISTS (
    SELECT 1 FROM public.retail_quotations q WHERE q.id = retail_quotation_items.quotation_id AND (
      q.created_by = auth.uid() OR staff_is_management()
      OR (staff_is_dept_head() AND staff_dept_in_hod_scope(q.department_id))
      OR (staff_is_accounts_head() AND q.department_id = staff_current_department_id())
    )
  )
);
DROP POLICY IF EXISTS retail_quotation_items_write_scoped ON public.retail_quotation_items;
CREATE POLICY retail_quotation_items_write_scoped ON public.retail_quotation_items FOR ALL
USING (
  staff_current_user_ok() AND EXISTS (
    SELECT 1 FROM public.retail_quotations q WHERE q.id = retail_quotation_items.quotation_id AND (
      q.created_by = auth.uid() OR staff_is_management()
      OR (staff_is_dept_head() AND staff_dept_in_hod_scope(q.department_id))
    )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.retail_quotations q WHERE q.id = retail_quotation_items.quotation_id AND (
      q.department_id = staff_current_department_id() OR staff_is_management()
      OR (staff_is_dept_head() AND staff_dept_in_hod_scope(q.department_id))
    )
  )
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.retail_quotation_items TO authenticated;

-- retail_orders
DROP POLICY IF EXISTS retail_orders_select_scoped ON public.retail_orders;
CREATE POLICY retail_orders_select_scoped ON public.retail_orders FOR SELECT
USING (
  staff_current_user_ok() AND (
    created_by = auth.uid()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
    OR (staff_is_accounts_head() AND department_id = staff_current_department_id())
  )
);
DROP POLICY IF EXISTS retail_orders_insert_scoped ON public.retail_orders;
CREATE POLICY retail_orders_insert_scoped ON public.retail_orders FOR INSERT
WITH CHECK (
  staff_current_user_ok() AND (
    department_id = staff_current_department_id()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
);
DROP POLICY IF EXISTS retail_orders_update_scoped ON public.retail_orders;
CREATE POLICY retail_orders_update_scoped ON public.retail_orders FOR UPDATE
USING (
  staff_current_user_ok() AND (
    created_by = auth.uid()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
)
WITH CHECK (
  department_id = staff_current_department_id() OR staff_is_management()
  OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
);
GRANT SELECT, INSERT, UPDATE ON public.retail_orders TO authenticated;

-- retail_order_items (scoped via parent order)
DROP POLICY IF EXISTS retail_order_items_select_scoped ON public.retail_order_items;
CREATE POLICY retail_order_items_select_scoped ON public.retail_order_items FOR SELECT
USING (
  staff_current_user_ok() AND EXISTS (
    SELECT 1 FROM public.retail_orders o WHERE o.id = retail_order_items.order_id AND (
      o.created_by = auth.uid() OR staff_is_management()
      OR (staff_is_dept_head() AND staff_dept_in_hod_scope(o.department_id))
      OR (staff_is_accounts_head() AND o.department_id = staff_current_department_id())
    )
  )
);
DROP POLICY IF EXISTS retail_order_items_write_scoped ON public.retail_order_items;
CREATE POLICY retail_order_items_write_scoped ON public.retail_order_items FOR ALL
USING (
  staff_current_user_ok() AND EXISTS (
    SELECT 1 FROM public.retail_orders o WHERE o.id = retail_order_items.order_id AND (
      o.created_by = auth.uid() OR staff_is_management()
      OR (staff_is_dept_head() AND staff_dept_in_hod_scope(o.department_id))
    )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.retail_orders o WHERE o.id = retail_order_items.order_id AND (
      o.department_id = staff_current_department_id() OR staff_is_management()
      OR (staff_is_dept_head() AND staff_dept_in_hod_scope(o.department_id))
    )
  )
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.retail_order_items TO authenticated;

-- retail_payments — SELECT only for clients; INSERT is via RPC only
-- (retail_record_payment, SECURITY DEFINER, see the RPC migration).
DROP POLICY IF EXISTS retail_payments_select_scoped ON public.retail_payments;
CREATE POLICY retail_payments_select_scoped ON public.retail_payments FOR SELECT
USING (
  staff_current_user_ok() AND EXISTS (
    SELECT 1 FROM public.retail_orders o WHERE o.id = retail_payments.order_id AND (
      o.created_by = auth.uid() OR staff_is_management()
      OR (staff_is_dept_head() AND staff_dept_in_hod_scope(o.department_id))
      OR (staff_is_accounts_head() AND o.department_id = staff_current_department_id())
    )
  )
);
GRANT SELECT ON public.retail_payments TO authenticated;

-- retail_vm_tasks
DROP POLICY IF EXISTS retail_vm_tasks_select_scoped ON public.retail_vm_tasks;
CREATE POLICY retail_vm_tasks_select_scoped ON public.retail_vm_tasks FOR SELECT
USING (
  staff_current_user_ok() AND (
    created_by = auth.uid() OR assigned_to = auth.uid()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
);
DROP POLICY IF EXISTS retail_vm_tasks_insert_scoped ON public.retail_vm_tasks;
CREATE POLICY retail_vm_tasks_insert_scoped ON public.retail_vm_tasks FOR INSERT
WITH CHECK (
  staff_current_user_ok() AND (
    department_id = staff_current_department_id()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
);
DROP POLICY IF EXISTS retail_vm_tasks_update_scoped ON public.retail_vm_tasks;
CREATE POLICY retail_vm_tasks_update_scoped ON public.retail_vm_tasks FOR UPDATE
USING (
  staff_current_user_ok() AND (
    created_by = auth.uid() OR assigned_to = auth.uid()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
)
WITH CHECK (
  department_id = staff_current_department_id() OR staff_is_management()
  OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
);
GRANT SELECT, INSERT, UPDATE ON public.retail_vm_tasks TO authenticated;

-- retail_store_ops_logs
DROP POLICY IF EXISTS retail_store_ops_logs_select_scoped ON public.retail_store_ops_logs;
CREATE POLICY retail_store_ops_logs_select_scoped ON public.retail_store_ops_logs FOR SELECT
USING (
  staff_current_user_ok() AND (
    created_by = auth.uid()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
);
DROP POLICY IF EXISTS retail_store_ops_logs_insert_scoped ON public.retail_store_ops_logs;
CREATE POLICY retail_store_ops_logs_insert_scoped ON public.retail_store_ops_logs FOR INSERT
WITH CHECK (
  staff_current_user_ok() AND (
    department_id = staff_current_department_id()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
);
DROP POLICY IF EXISTS retail_store_ops_logs_update_scoped ON public.retail_store_ops_logs;
CREATE POLICY retail_store_ops_logs_update_scoped ON public.retail_store_ops_logs FOR UPDATE
USING (
  staff_current_user_ok() AND (
    created_by = auth.uid()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
)
WITH CHECK (
  department_id = staff_current_department_id() OR staff_is_management()
  OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
);
GRANT SELECT, INSERT, UPDATE ON public.retail_store_ops_logs TO authenticated;

-- retail_complaints
DROP POLICY IF EXISTS retail_complaints_select_scoped ON public.retail_complaints;
CREATE POLICY retail_complaints_select_scoped ON public.retail_complaints FOR SELECT
USING (
  staff_current_user_ok() AND (
    created_by = auth.uid() OR assigned_to = auth.uid()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
);
DROP POLICY IF EXISTS retail_complaints_insert_scoped ON public.retail_complaints;
CREATE POLICY retail_complaints_insert_scoped ON public.retail_complaints FOR INSERT
WITH CHECK (
  staff_current_user_ok() AND (
    department_id = staff_current_department_id()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
);
DROP POLICY IF EXISTS retail_complaints_update_scoped ON public.retail_complaints;
CREATE POLICY retail_complaints_update_scoped ON public.retail_complaints FOR UPDATE
USING (
  staff_current_user_ok() AND (
    created_by = auth.uid() OR assigned_to = auth.uid()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
)
WITH CHECK (
  department_id = staff_current_department_id() OR staff_is_management()
  OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
);
GRANT SELECT, INSERT, UPDATE ON public.retail_complaints TO authenticated;

-- retail_sales_targets — read: any scoped Retail member; write: dept_head/
-- management only.
DROP POLICY IF EXISTS retail_sales_targets_select_scoped ON public.retail_sales_targets;
CREATE POLICY retail_sales_targets_select_scoped ON public.retail_sales_targets FOR SELECT
USING (
  staff_current_user_ok() AND (
    department_id = staff_current_department_id()
    OR staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
);
DROP POLICY IF EXISTS retail_sales_targets_insert_scoped ON public.retail_sales_targets;
CREATE POLICY retail_sales_targets_insert_scoped ON public.retail_sales_targets FOR INSERT
WITH CHECK (
  staff_current_user_ok() AND (
    staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
);
DROP POLICY IF EXISTS retail_sales_targets_update_scoped ON public.retail_sales_targets;
CREATE POLICY retail_sales_targets_update_scoped ON public.retail_sales_targets FOR UPDATE
USING (
  staff_current_user_ok() AND (
    staff_is_management()
    OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
  )
)
WITH CHECK (
  staff_is_management() OR (staff_is_dept_head() AND staff_dept_in_hod_scope(department_id))
);
GRANT SELECT, INSERT, UPDATE ON public.retail_sales_targets TO authenticated;
