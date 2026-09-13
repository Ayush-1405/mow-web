-- Purchase Management module: consolidates Purchase Coordination and
-- Purchase Board into one project-wise, in-house-vs-outsourced purchase
-- lifecycle (request -> factory job order OR vendor quotation/comparison/
-- approval/PO -> checklist -> GRN/QC -> vendor follow-up -> payment
-- coordination -> closure).
--
-- Nothing existing is touched: `project_materials` rows (what Purchase
-- Coordination/Purchase Board actually read today) stay exactly where
-- they are; the new screen reads them read-only, tagged "Legacy".
--
-- Access mirrors every other project-linked table this session
-- (interior_is_org_wide() OR interior_is_project_member(project_id)) with
-- ONE deliberate exception: costing/vendor-payment tables use a stricter
-- org-wide-only policy (purchase_costing_can_view()), since this is the
-- first module where the spec explicitly requires hiding rate/vendor-
-- payment detail from ordinary project team members while still showing
-- them operational status (kept in separate, normally-scoped tables).

-- ---------------------------------------------------------------------
-- 0. Helper: who can see restricted purchase costing / vendor-payment data
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purchase_costing_can_view()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT public.interior_is_org_wide()
    OR public.staff_is_accounts_head()
    OR (public.staff_is_dept_head() AND public.staff_dept_in_hod_scope(
          (SELECT id FROM public.departments WHERE code = 'FACTORY')
        ));
$$;
REVOKE ALL ON FUNCTION public.purchase_costing_can_view() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purchase_costing_can_view() TO authenticated;

-- ---------------------------------------------------------------------
-- 1. Catalog / master tables (no project_id — org-wide entities)
-- ---------------------------------------------------------------------
CREATE TABLE public.factory_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_code text,
  name text NOT NULL,
  contact_person text,
  mobile text,
  alt_contact text,
  email text,
  address text,
  gstin text,
  pan text,
  vendor_category text,
  product_service_category text,
  payment_terms text,
  credit_period text,
  lead_time text,
  rating numeric,
  approved_status text NOT NULL DEFAULT 'Pending',
  blacklisted boolean NOT NULL DEFAULT false,
  blacklist_reason text,
  notes text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vendors_gstin_unique_idx ON public.vendors(gstin) WHERE gstin IS NOT NULL;
CREATE INDEX vendors_name_idx ON public.vendors(name);
CREATE INDEX vendors_mobile_idx ON public.vendors(mobile);
CREATE TRIGGER vendors_touch_updated_at BEFORE UPDATE ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION public.project_materials_touch_updated_at();

CREATE TABLE public.vendor_bank_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendors(id),
  account_number text,
  ifsc text,
  bank_name text,
  branch text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_bank_details_vendor_id_idx ON public.vendor_bank_details(vendor_id);

CREATE TABLE public.purchase_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  item_text_en text NOT NULL,
  item_text_gu text,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_checklist_items_category_idx ON public.purchase_checklist_items(category);

-- ---------------------------------------------------------------------
-- 2. purchase_requests + line items
-- ---------------------------------------------------------------------
CREATE TABLE public.purchase_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  request_number text NOT NULL UNIQUE,
  area_id uuid REFERENCES public.working_drawing_areas(id),
  material_requirement_id uuid REFERENCES public.project_materials(id),
  material_selection_id uuid REFERENCES public.material_selections(id),
  purchase_source text NOT NULL,
  priority text NOT NULL DEFAULT 'Normal',
  purpose text,
  notes text,
  requested_by uuid REFERENCES public.profiles(id),
  assigned_purchase_person uuid REFERENCES public.profiles(id),
  request_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'Draft',
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX purchase_requests_project_id_idx ON public.purchase_requests(project_id);
CREATE INDEX purchase_requests_status_idx ON public.purchase_requests(status);
CREATE INDEX purchase_requests_purchase_source_idx ON public.purchase_requests(purchase_source);
CREATE TRIGGER purchase_requests_touch_updated_at BEFORE UPDATE ON public.purchase_requests
  FOR EACH ROW EXECUTE FUNCTION public.project_materials_touch_updated_at();

CREATE TABLE public.purchase_request_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  purchase_request_id uuid NOT NULL REFERENCES public.purchase_requests(id),
  item_name text NOT NULL,
  item_code text,
  category text,
  description text,
  brand text,
  colour text,
  finish text,
  size text,
  thickness text,
  hardware_spec text,
  quantity numeric,
  unit text,
  required_at_location text,
  required_by_date date,
  status text NOT NULL DEFAULT 'Pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_request_items_project_id_idx ON public.purchase_request_items(project_id);
CREATE INDEX purchase_request_items_request_id_idx ON public.purchase_request_items(purchase_request_id);
CREATE TRIGGER purchase_request_items_touch_updated_at BEFORE UPDATE ON public.purchase_request_items
  FOR EACH ROW EXECUTE FUNCTION public.project_materials_touch_updated_at();

-- ---------------------------------------------------------------------
-- 3. In-house workflow
-- ---------------------------------------------------------------------
CREATE TABLE public.inhouse_production_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  purchase_request_id uuid NOT NULL UNIQUE REFERENCES public.purchase_requests(id),
  factory_location_id uuid REFERENCES public.factory_locations(id),
  production_department text,
  product_item text,
  design_version_id uuid REFERENCES public.design_versions(id),
  working_drawing_version_id uuid REFERENCES public.drawing_versions(id),
  bom_reference text,
  quantity numeric,
  unit text,
  required_completion_date date,
  delivery_site_date date,
  assigned_factory_coordinator uuid REFERENCES public.profiles(id),
  special_instructions text,
  quality_requirements text,
  finishing_requirements text,
  packing_requirements text,
  installation_requirement text,
  job_order_number text,
  status text NOT NULL DEFAULT 'Draft',
  production_start_date date,
  expected_completion_date date,
  actual_completion_date date,
  qc_status text,
  rework_status text,
  packing_status text,
  dispatch_readiness text,
  delivery_status text,
  installation_status text,
  delay_reason text,
  current_responsible_person uuid REFERENCES public.profiles(id),
  submitted_by uuid REFERENCES public.profiles(id),
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inhouse_production_requests_project_id_idx ON public.inhouse_production_requests(project_id);
CREATE INDEX inhouse_production_requests_status_idx ON public.inhouse_production_requests(status);
CREATE INDEX inhouse_production_requests_factory_location_idx ON public.inhouse_production_requests(factory_location_id);
CREATE TRIGGER inhouse_production_requests_touch_updated_at BEFORE UPDATE ON public.inhouse_production_requests
  FOR EACH ROW EXECUTE FUNCTION public.project_materials_touch_updated_at();

-- ---------------------------------------------------------------------
-- 4. Outsource workflow
-- ---------------------------------------------------------------------
CREATE TABLE public.outsource_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  purchase_request_id uuid NOT NULL UNIQUE REFERENCES public.purchase_requests(id),
  outsource_type text NOT NULL,
  outsource_type_other text,
  status text NOT NULL DEFAULT 'Draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outsource_requirements_project_id_idx ON public.outsource_requirements(project_id);
CREATE TRIGGER outsource_requirements_touch_updated_at BEFORE UPDATE ON public.outsource_requirements
  FOR EACH ROW EXECUTE FUNCTION public.project_materials_touch_updated_at();

-- vendor_quotations / purchase_vendor_selections / purchase_approvals /
-- purchase_costing / vendor_bank_details carry real rate, payment and
-- approved-amount data -- restricted to purchase_costing_can_view(), not
-- the ordinary org-wide-or-project-member pattern.
CREATE TABLE public.vendor_quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  purchase_request_id uuid NOT NULL REFERENCES public.purchase_requests(id),
  vendor_id uuid NOT NULL REFERENCES public.vendors(id),
  quotation_number text,
  quotation_date date,
  validity_date date,
  material_rate numeric,
  labour_rate numeric,
  other_charges numeric,
  tax numeric,
  transport numeric,
  installation numeric,
  total_landed_cost numeric GENERATED ALWAYS AS (
    coalesce(material_rate,0) + coalesce(labour_rate,0) + coalesce(other_charges,0)
    + coalesce(tax,0) + coalesce(transport,0) + coalesce(installation,0)
  ) STORED,
  lead_time_days integer,
  payment_terms text,
  warranty text,
  quality_rating numeric,
  past_performance_rating numeric,
  negotiated_amount numeric,
  final_offer numeric,
  negotiation_notes text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_quotations_project_id_idx ON public.vendor_quotations(project_id);
CREATE INDEX vendor_quotations_request_id_idx ON public.vendor_quotations(purchase_request_id);
CREATE INDEX vendor_quotations_vendor_id_idx ON public.vendor_quotations(vendor_id);

CREATE TABLE public.purchase_vendor_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  purchase_request_id uuid NOT NULL REFERENCES public.purchase_requests(id),
  selected_vendor_id uuid NOT NULL REFERENCES public.vendors(id),
  selected_quotation_id uuid REFERENCES public.vendor_quotations(id),
  selection_reason text,
  approved_amount numeric,
  approved_by uuid REFERENCES public.profiles(id),
  approval_date date,
  is_lowest_bid boolean,
  justification_text text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_vendor_selections_project_id_idx ON public.purchase_vendor_selections(project_id);
CREATE INDEX purchase_vendor_selections_request_id_idx ON public.purchase_vendor_selections(purchase_request_id);

CREATE TABLE public.purchase_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  purchase_request_id uuid NOT NULL REFERENCES public.purchase_requests(id),
  approval_level text NOT NULL,
  submitted_by uuid REFERENCES public.profiles(id),
  submitted_date date,
  decided_by uuid REFERENCES public.profiles(id),
  decision_date date,
  decision text,
  approved_amount numeric,
  remarks text,
  conditions text,
  proof_storage_path text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_approvals_project_id_idx ON public.purchase_approvals(project_id);
CREATE INDEX purchase_approvals_request_id_idx ON public.purchase_approvals(purchase_request_id);

-- ---------------------------------------------------------------------
-- 5. Purchase Order / Work Order (immutable version chain, like drawing_versions)
-- ---------------------------------------------------------------------
CREATE TABLE public.purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  purchase_request_id uuid NOT NULL REFERENCES public.purchase_requests(id),
  vendor_id uuid REFERENCES public.vendors(id),
  order_type text NOT NULL,
  po_number text,
  version_number text NOT NULL DEFAULT 'V1',
  previous_po_id uuid REFERENCES public.purchase_orders(id),
  is_current boolean NOT NULL DEFAULT true,
  order_date date NOT NULL DEFAULT CURRENT_DATE,
  total_order_value numeric,
  delivery_location text,
  expected_dispatch_date date,
  expected_delivery_date date,
  scope_of_work text,
  exclusions text,
  payment_terms text,
  warranty text,
  penalty_terms text,
  quality_requirements text,
  drawing_reference text,
  material_selection_reference text,
  special_instructions text,
  approved_by uuid REFERENCES public.profiles(id),
  vendor_acknowledgement boolean NOT NULL DEFAULT false,
  acknowledgement_date date,
  status text NOT NULL DEFAULT 'Draft',
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_orders_project_id_idx ON public.purchase_orders(project_id);
CREATE INDEX purchase_orders_request_id_idx ON public.purchase_orders(purchase_request_id);
-- Idempotency: only one CURRENT PO per request -- blocks duplicate-click PO generation.
CREATE UNIQUE INDEX purchase_orders_one_current_idx ON public.purchase_orders(purchase_request_id) WHERE is_current = true;

-- ---------------------------------------------------------------------
-- 6. Restricted costing (org-wide + Accounts Head + Factory Head only)
-- ---------------------------------------------------------------------
CREATE TABLE public.purchase_costing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  purchase_request_id uuid NOT NULL REFERENCES public.purchase_requests(id),
  purchase_order_id uuid REFERENCES public.purchase_orders(id),
  raw_material_estimated numeric,
  raw_material_actual numeric,
  hardware_cost numeric,
  labour_estimated numeric,
  labour_actual numeric,
  machine_cost numeric,
  finishing_cost numeric,
  packing_cost numeric,
  transport_cost numeric,
  installation_cost numeric,
  wastage_cost numeric,
  rework_cost numeric,
  other_cost numeric,
  total_estimated_cost numeric GENERATED ALWAYS AS (
    coalesce(raw_material_estimated,0) + coalesce(hardware_cost,0) + coalesce(labour_estimated,0)
    + coalesce(machine_cost,0) + coalesce(finishing_cost,0) + coalesce(packing_cost,0)
    + coalesce(transport_cost,0) + coalesce(installation_cost,0) + coalesce(wastage_cost,0) + coalesce(other_cost,0)
  ) STORED,
  total_actual_cost numeric GENERATED ALWAYS AS (
    coalesce(raw_material_actual,0) + coalesce(hardware_cost,0) + coalesce(labour_actual,0)
    + coalesce(machine_cost,0) + coalesce(finishing_cost,0) + coalesce(packing_cost,0)
    + coalesce(transport_cost,0) + coalesce(installation_cost,0) + coalesce(wastage_cost,0)
    + coalesce(rework_cost,0) + coalesce(other_cost,0)
  ) STORED,
  quantity_for_unit_cost numeric,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_costing_project_id_idx ON public.purchase_costing(project_id);
CREATE INDEX purchase_costing_request_id_idx ON public.purchase_costing(purchase_request_id);
CREATE TRIGGER purchase_costing_touch_updated_at BEFORE UPDATE ON public.purchase_costing
  FOR EACH ROW EXECUTE FUNCTION public.project_materials_touch_updated_at();
-- cost_variance / cost_variance_pct / cost_per_unit are computed on read
-- (screen + Master Report), not stored -- Postgres generated columns
-- cannot reference another generated column, and the two totals above
-- already guarantee the underlying sums are never manually typed.

-- ---------------------------------------------------------------------
-- 7. Checklist results (versioned per request x item, like drawing_checklist_results)
-- ---------------------------------------------------------------------
CREATE TABLE public.purchase_checklist_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  purchase_request_id uuid NOT NULL REFERENCES public.purchase_requests(id),
  checklist_item_id uuid NOT NULL REFERENCES public.purchase_checklist_items(id),
  status text NOT NULL DEFAULT 'Not Started',
  responsible_person uuid REFERENCES public.profiles(id),
  due_date date,
  checked_by uuid REFERENCES public.profiles(id),
  checked_date date,
  remarks text,
  proof_storage_path text,
  reopen_reason text,
  previous_result_id uuid REFERENCES public.purchase_checklist_results(id),
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_checklist_results_project_id_idx ON public.purchase_checklist_results(project_id);
CREATE INDEX purchase_checklist_results_request_id_idx ON public.purchase_checklist_results(purchase_request_id);
CREATE UNIQUE INDEX purchase_checklist_results_current_idx ON public.purchase_checklist_results(purchase_request_id, checklist_item_id) WHERE is_current = true;

-- ---------------------------------------------------------------------
-- 8. Vendor follow-up, GRN/QC, payment coordination
-- ---------------------------------------------------------------------
CREATE TABLE public.vendor_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  purchase_request_id uuid NOT NULL REFERENCES public.purchase_requests(id),
  vendor_id uuid REFERENCES public.vendors(id),
  follow_up_date date NOT NULL DEFAULT CURRENT_DATE,
  next_follow_up_date date,
  notes text,
  escalation_status text NOT NULL DEFAULT 'None',
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_followups_project_id_idx ON public.vendor_followups(project_id);
CREATE INDEX vendor_followups_request_id_idx ON public.vendor_followups(purchase_request_id);

CREATE TABLE public.purchase_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  purchase_request_id uuid NOT NULL REFERENCES public.purchase_requests(id),
  po_id uuid REFERENCES public.purchase_orders(id),
  grn_number text,
  receipt_location text,
  receipt_date date NOT NULL DEFAULT CURRENT_DATE,
  received_by uuid REFERENCES public.profiles(id),
  qty_ordered numeric,
  qty_received numeric,
  qty_accepted numeric,
  qty_rejected numeric,
  qty_short numeric,
  damage_qty numeric,
  qc_status text NOT NULL DEFAULT 'Pending',
  qc_remarks text,
  rejection_reason text,
  replacement_required boolean NOT NULL DEFAULT false,
  replacement_due_date date,
  delivery_flow text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_receipts_project_id_idx ON public.purchase_receipts(project_id);
CREATE INDEX purchase_receipts_request_id_idx ON public.purchase_receipts(purchase_request_id);

CREATE TABLE public.purchase_payment_coordination (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  purchase_request_id uuid NOT NULL REFERENCES public.purchase_requests(id),
  invoice_number text,
  invoice_date date,
  invoice_amount numeric,
  tax_amount numeric,
  payment_type text,
  advance_amount numeric,
  paid_amount numeric,
  pending_amount numeric,
  due_date date,
  status text NOT NULL DEFAULT 'Not Due',
  payment_request_date date,
  submitted_to_accounts boolean NOT NULL DEFAULT false,
  accounts_acknowledgement boolean NOT NULL DEFAULT false,
  -- payment_reference is the one column filtered out at the API layer for
  -- non-org-wide callers (interiorApi.js listPurchasePaymentCoordination)
  -- -- everything else here is deliberately project-member readable.
  payment_reference text,
  retention_amount numeric,
  deduction numeric,
  deduction_reason text,
  final_settlement_status text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_payment_coordination_project_id_idx ON public.purchase_payment_coordination(project_id);
CREATE INDEX purchase_payment_coordination_request_id_idx ON public.purchase_payment_coordination(purchase_request_id);
CREATE TRIGGER purchase_payment_coordination_touch_updated_at BEFORE UPDATE ON public.purchase_payment_coordination
  FOR EACH ROW EXECUTE FUNCTION public.project_materials_touch_updated_at();

-- ---------------------------------------------------------------------
-- 9. Shared attachments
-- ---------------------------------------------------------------------
CREATE TABLE public.purchase_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  purchase_request_id uuid NOT NULL REFERENCES public.purchase_requests(id),
  line_item_id uuid REFERENCES public.purchase_request_items(id),
  vendor_id uuid REFERENCES public.vendors(id),
  purchase_order_id uuid REFERENCES public.purchase_orders(id),
  module text NOT NULL,
  file_category text NOT NULL DEFAULT 'Other',
  file_name text NOT NULL,
  original_file_name text,
  storage_path text,
  file_type text,
  file_size bigint,
  description text,
  uploaded_by uuid REFERENCES public.profiles(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_attachments_project_id_idx ON public.purchase_attachments(project_id);
CREATE INDEX purchase_attachments_request_id_idx ON public.purchase_attachments(purchase_request_id);
CREATE INDEX purchase_attachments_module_idx ON public.purchase_attachments(module);

-- ---------------------------------------------------------------------
-- 10. RLS
-- ---------------------------------------------------------------------
ALTER TABLE public.factory_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_bank_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_request_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inhouse_production_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outsource_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_vendor_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_costing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_checklist_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_payment_coordination ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_attachments ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.factory_locations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendors TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_bank_details TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_checklist_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_request_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inhouse_production_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.outsource_requirements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_quotations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_vendor_selections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_approvals TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_orders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_costing TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_checklist_results TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_followups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_receipts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_payment_coordination TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_attachments TO authenticated;

-- Catalog tables: everyone reads, only org-wide manages the template/master.
CREATE POLICY "factory_locations_select" ON public.factory_locations FOR SELECT TO authenticated USING (true);
CREATE POLICY "factory_locations_manage" ON public.factory_locations FOR ALL TO authenticated
  USING (public.interior_is_org_wide()) WITH CHECK (public.interior_is_org_wide());

CREATE POLICY "vendors_select" ON public.vendors FOR SELECT TO authenticated USING (true);
CREATE POLICY "vendors_manage" ON public.vendors FOR ALL TO authenticated
  USING (public.interior_is_org_wide()) WITH CHECK (public.interior_is_org_wide());

CREATE POLICY "purchase_checklist_items_select" ON public.purchase_checklist_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "purchase_checklist_items_manage" ON public.purchase_checklist_items FOR ALL TO authenticated
  USING (public.interior_is_org_wide()) WITH CHECK (public.interior_is_org_wide());

-- Restricted financial tables: purchase_costing_can_view() only.
CREATE POLICY "vendor_bank_details_scoped" ON public.vendor_bank_details FOR ALL TO authenticated
  USING (public.purchase_costing_can_view()) WITH CHECK (public.purchase_costing_can_view());
CREATE POLICY "vendor_quotations_scoped" ON public.vendor_quotations FOR ALL TO authenticated
  USING (public.purchase_costing_can_view()) WITH CHECK (public.purchase_costing_can_view());
CREATE POLICY "purchase_vendor_selections_scoped" ON public.purchase_vendor_selections FOR ALL TO authenticated
  USING (public.purchase_costing_can_view()) WITH CHECK (public.purchase_costing_can_view());
CREATE POLICY "purchase_approvals_scoped" ON public.purchase_approvals FOR ALL TO authenticated
  USING (public.purchase_costing_can_view()) WITH CHECK (public.purchase_costing_can_view());
CREATE POLICY "purchase_costing_scoped" ON public.purchase_costing FOR ALL TO authenticated
  USING (public.purchase_costing_can_view()) WITH CHECK (public.purchase_costing_can_view());

-- Ordinary project-linked tables: org-wide OR project-member (standard pattern).
CREATE POLICY "purchase_requests_scoped" ON public.purchase_requests FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
CREATE POLICY "purchase_request_items_scoped" ON public.purchase_request_items FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
CREATE POLICY "inhouse_production_requests_scoped" ON public.inhouse_production_requests FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
CREATE POLICY "outsource_requirements_scoped" ON public.outsource_requirements FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
CREATE POLICY "purchase_orders_scoped" ON public.purchase_orders FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
CREATE POLICY "purchase_checklist_results_scoped" ON public.purchase_checklist_results FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
CREATE POLICY "vendor_followups_scoped" ON public.vendor_followups FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
CREATE POLICY "purchase_receipts_scoped" ON public.purchase_receipts FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
CREATE POLICY "purchase_payment_coordination_scoped" ON public.purchase_payment_coordination FOR ALL TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id))
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));

CREATE POLICY "purchase_attachments_select_scoped" ON public.purchase_attachments FOR SELECT TO authenticated
  USING (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
CREATE POLICY "purchase_attachments_insert_scoped" ON public.purchase_attachments FOR INSERT TO authenticated
  WITH CHECK (public.interior_is_org_wide() OR public.interior_is_project_member(project_id));
CREATE POLICY "purchase_attachments_delete_scoped" ON public.purchase_attachments FOR DELETE TO authenticated
  USING (public.interior_is_org_wide());

-- Storage: projects/{project_id}/purchase-management/{purchase_request_id}/{stage}/{file}
-- already matches interior_storage_project_id() (project_id is path segment 2) -- no new storage policy needed.

-- ---------------------------------------------------------------------
-- 11. Seed the purchase checklist catalog verbatim (144 items, 10 categories)
-- ---------------------------------------------------------------------
INSERT INTO public.purchase_checklist_items (category, item_text_en, sort_order) VALUES
('Requirement', 'Correct project selected', 1),
('Requirement', 'Correct room/area selected', 2),
('Requirement', 'Requirement clearly defined', 3),
('Requirement', 'Quantity verified', 4),
('Requirement', 'Specification complete', 5),
('Requirement', 'Material code verified', 6),
('Requirement', 'Approved material selection linked', 7),
('Requirement', 'Latest working drawing linked', 8),
('Requirement', 'Required-by date confirmed', 9),
('Requirement', 'Budget availability checked', 10),
('Requirement', 'Scope of work defined', 11),
('Requirement', 'Responsibility for material and labour confirmed', 12),
('Requirement', 'Delivery destination confirmed', 13),
('Requirement', 'Installation requirement confirmed', 14),
('Requirement', 'Supporting files uploaded', 15),

('Vendor', 'Vendor selected from Vendor Master', 1),
('Vendor', 'Vendor contact verified', 2),
('Vendor', 'GSTIN verified', 3),
('Vendor', 'Vendor category verified', 4),
('Vendor', 'Vendor capability checked', 5),
('Vendor', 'Previous performance checked', 6),
('Vendor', 'Vendor approval status checked', 7),
('Vendor', 'Vendor not blacklisted', 8),
('Vendor', 'Production capacity confirmed', 9),
('Vendor', 'Lead time confirmed', 10),
('Vendor', 'Site/location capability confirmed', 11),
('Vendor', 'Warranty terms confirmed', 12),
('Vendor', 'Replacement terms confirmed', 13),

('Quotation', 'RFQ sent', 1),
('Quotation', 'Quotation received', 2),
('Quotation', 'Quotation number recorded', 3),
('Quotation', 'Quotation validity checked', 4),
('Quotation', 'At least required quotations compared', 5),
('Quotation', 'Material cost captured', 6),
('Quotation', 'Labour cost captured', 7),
('Quotation', 'Transport captured', 8),
('Quotation', 'Installation captured', 9),
('Quotation', 'Taxes captured', 10),
('Quotation', 'Total landed cost calculated', 11),
('Quotation', 'Negotiation completed', 12),
('Quotation', 'Final quotation uploaded', 13),
('Quotation', 'Vendor-selection reason recorded', 14),
('Quotation', 'Non-lowest-vendor justification recorded, if applicable', 15),

('Approval', 'Budgeted cost available', 1),
('Approval', 'Cost variance checked', 2),
('Approval', 'Purchase person reviewed', 3),
('Approval', 'Project Manager reviewed', 4),
('Approval', 'Department Head approval completed', 5),
('Approval', 'Management approval completed where required', 6),
('Approval', 'Accounts review completed where required', 7),
('Approval', 'Approved amount recorded', 8),
('Approval', 'Approval proof available', 9),
('Approval', 'Rejection/revision remarks resolved', 10),

('PO/WO', 'Correct order type selected', 1),
('PO/WO', 'PO/WO number generated', 2),
('PO/WO', 'Vendor name verified', 3),
('PO/WO', 'Scope included', 4),
('PO/WO', 'Quantity and rate verified', 5),
('PO/WO', 'Material/labour responsibility mentioned', 6),
('PO/WO', 'Taxes verified', 7),
('PO/WO', 'Payment terms mentioned', 8),
('PO/WO', 'Delivery date mentioned', 9),
('PO/WO', 'Delivery location mentioned', 10),
('PO/WO', 'Working drawing attached', 11),
('PO/WO', 'Material selection attached', 12),
('PO/WO', 'Quality requirement mentioned', 13),
('PO/WO', 'Warranty mentioned', 14),
('PO/WO', 'Delay terms mentioned', 15),
('PO/WO', 'PO/WO approved', 16),
('PO/WO', 'PO/WO sent to vendor', 17),
('PO/WO', 'Vendor acknowledgement received', 18),

('Vendor Follow-up', 'Vendor accepted order', 1),
('Vendor Follow-up', 'Production/start date confirmed', 2),
('Vendor Follow-up', 'Material arrangement confirmed', 3),
('Vendor Follow-up', 'Sample submitted where required', 4),
('Vendor Follow-up', 'Sample approved where required', 5),
('Vendor Follow-up', 'Progress update received', 6),
('Vendor Follow-up', 'Progress photos/videos uploaded', 7),
('Vendor Follow-up', 'Pre-dispatch date confirmed', 8),
('Vendor Follow-up', 'Delay checked', 9),
('Vendor Follow-up', 'Delay reason recorded', 10),
('Vendor Follow-up', 'Revised date approved', 11),
('Vendor Follow-up', 'Three-day advance follow-up completed', 12),
('Vendor Follow-up', 'Escalation raised where delayed', 13),

('Pre-Dispatch and QC', 'Correct product/material verified', 1),
('Pre-Dispatch and QC', 'Quantity verified', 2),
('Pre-Dispatch and QC', 'Dimensions verified', 3),
('Pre-Dispatch and QC', 'Material verified', 4),
('Pre-Dispatch and QC', 'Colour and finish verified', 5),
('Pre-Dispatch and QC', 'Hardware verified', 6),
('Pre-Dispatch and QC', 'Workmanship checked', 7),
('Pre-Dispatch and QC', 'Packing checked', 8),
('Pre-Dispatch and QC', 'Damage checked', 9),
('Pre-Dispatch and QC', 'Product photographs uploaded', 10),
('Pre-Dispatch and QC', 'QC report uploaded', 11),
('Pre-Dispatch and QC', 'Rejection/rework recorded', 12),
('Pre-Dispatch and QC', 'Final QC passed', 13),
('Pre-Dispatch and QC', 'Dispatch approval received', 14),

('Delivery', 'Delivery location confirmed', 1),
('Delivery', 'Site readiness confirmed', 2),
('Delivery', 'Contact person confirmed', 3),
('Delivery', 'Transporter/vehicle details recorded', 4),
('Delivery', 'Dispatch date recorded', 5),
('Delivery', 'Invoice/challan available', 6),
('Delivery', 'E-way bill available where required', 7),
('Delivery', 'Material dispatched', 8),
('Delivery', 'In-transit status updated', 9),
('Delivery', 'Material delivered', 10),
('Delivery', 'Delivery proof/POD uploaded', 11),
('Delivery', 'Quantity received verified', 12),
('Delivery', 'Damage/shortage recorded', 13),
('Delivery', 'Installation requirement transferred', 14),
('Delivery', 'Site acknowledgement received', 15),

('Payment Coordination', 'Vendor invoice received', 1),
('Payment Coordination', 'Invoice number and date recorded', 2),
('Payment Coordination', 'PO/WO matched', 3),
('Payment Coordination', 'Quantity matched', 4),
('Payment Coordination', 'Rate matched', 5),
('Payment Coordination', 'Tax details verified', 6),
('Payment Coordination', 'GRN/QC completed', 7),
('Payment Coordination', 'Advance payment recorded', 8),
('Payment Coordination', 'Running payment recorded', 9),
('Payment Coordination', 'Retention recorded', 10),
('Payment Coordination', 'Final payment due date recorded', 11),
('Payment Coordination', 'Payment approval submitted', 12),
('Payment Coordination', 'Accounts coordination completed', 13),
('Payment Coordination', 'Payment status updated', 14),
('Payment Coordination', 'Payment proof linked where authorised', 15),
('Payment Coordination', 'Vendor outstanding updated', 16),
('Payment Coordination', 'No-claim/closure confirmation obtained where required', 17),

('Closure', 'Complete supply/work received', 1),
('Closure', 'QC passed', 2),
('Closure', 'Rework completed', 3),
('Closure', 'Installation completed', 4),
('Closure', 'Final documentation received', 5),
('Closure', 'Warranty document received', 6),
('Closure', 'Project team confirmation received', 7),
('Closure', 'Vendor performance rated', 8),
('Closure', 'Final cost recorded', 9),
('Closure', 'Cost variance recorded', 10),
('Closure', 'Pending payment recorded', 11),
('Closure', 'Purchase request closed', 12),
('Closure', 'All files available', 13),
('Closure', 'Activity history complete', 14);
