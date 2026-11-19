import { supabase } from "./supabase";

// Central Procurement. Every change goes through a proc_* database function (mvp_pilot_procurement_v3_01_foundation.sql), which
// checks the caller's role and the request's current status; direct writes to the purchase tables are revoked. Reads go
// through RLS (proc_can_view_request), so each list here only ever contains what the caller may see.

export * from "./procurementRules";

const REQUEST_COLUMNS =
  "id, request_number, project_id, requesting_department_id, requester_user_id, proc_status, procurement_category, material_name, material_category, "
  + "specifications, quantity, unit, required_by_date, priority, remarks, delivery_location, is_emergency, emergency_reason, created_at, proc_updated_at, "
  + "dept_decided_by, dept_decided_at, dept_decision_remarks, sent_to_procurement_at, proc_decided_by, proc_decided_at, proc_decision_remarks, "
  + "document_version, document_generated_at, order_confirmed_by, order_confirmed_at, "
  + "order_form_type, client_name, sales_person_name, preferred_vendor_name, delivery_date, delivered_to_client_at, order_total, urgency_reason, "
  + "proc_assigned_to, overdue_since";

export function listPurchaseRequests({ statuses, departmentId, limit = 300 } = {}) {
  let q = supabase.from("purchase_requests").select(REQUEST_COLUMNS).neq("proc_status", "LEGACY");
  if (statuses?.length) q = q.in("proc_status", statuses);
  if (departmentId) q = q.eq("requesting_department_id", departmentId);
  return q.order("created_at", { ascending: false }).limit(limit);
}

export function getPurchaseRequest(id) {
  return supabase.from("purchase_requests").select(REQUEST_COLUMNS).eq("id", id).maybeSingle();
}

export function listStatusHistory(id) {
  return supabase.from("purchase_request_status_history").select("*").eq("purchase_request_id", id).order("created_at");
}

export function listPrintLogs(id) {
  return supabase.from("purchase_print_logs").select("*").eq("purchase_request_id", id).order("printed_at");
}

export function getCurrentOrder(requestId) {
  return supabase.from("purchase_orders").select("*, vendors(name, mobile)").eq("purchase_request_id", requestId).eq("is_current", true).maybeSingle();
}

export function listOrders({ limit = 300 } = {}) {
  return supabase.from("purchase_orders").select("id, purchase_request_id, po_number, order_date, total_order_value, expected_delivery_date, status, vendor_id, vendors(name)")
    .eq("is_current", true).order("order_date", { ascending: false }).limit(limit);
}

export function listAmountApprovals(requestId) {
  return supabase.from("purchase_approvals").select("*").eq("purchase_request_id", requestId).eq("approval_level", "MANAGEMENT").order("created_at");
}

export function listPendingAmountApprovals() {
  return supabase.from("purchase_approvals").select("*, purchase_requests(id, request_number, material_name)")
    .eq("approval_level", "MANAGEMENT").is("decision", null).order("created_at");
}

export function getApprovalLimits() {
  return supabase.from("procurement_approval_limits").select("*");
}

// { [requestId]: { requester_name, department_name, project_code, customer, ... } } for requests the caller may see.
export async function getRequestContext(ids) {
  if (!ids.length) return {};
  const { data, error } = await supabase.rpc("proc_request_context", { p_request_ids: ids });
  if (error) return {};
  return Object.fromEntries((data || []).map((r) => [r.request_id, r]));
}

export function getProcurementContact() {
  return supabase.rpc("proc_procurement_contact");
}

export function createPurchaseRequest(f, { submit = true } = {}) {
  return supabase.rpc("proc_create_request", {
    p_project_id: f.project_id || null, p_material_name: f.material_name, p_material_category: f.material_category,
    p_specifications: f.specifications || null, p_quantity: Number(f.quantity), p_unit: f.unit, p_required_by_date: f.required_by_date,
    p_priority: f.priority, p_remarks: f.remarks || null, p_delivery_location: f.delivery_location, p_procurement_category: f.procurement_category,
    p_is_emergency: !!f.is_emergency, p_emergency_reason: f.emergency_reason || null, p_submit: submit,
  }).single();
}

export function updatePurchaseRequest(id, f) {
  return supabase.rpc("proc_update_request", {
    p_request_id: id, p_material_name: f.material_name, p_material_category: f.material_category, p_specifications: f.specifications || null,
    p_quantity: Number(f.quantity), p_unit: f.unit, p_required_by_date: f.required_by_date, p_priority: f.priority, p_remarks: f.remarks || null,
    p_delivery_location: f.delivery_location, p_procurement_category: f.procurement_category, p_is_emergency: !!f.is_emergency,
    p_emergency_reason: f.emergency_reason || null,
  }).single();
}

export const submitPurchaseRequest = (id) => supabase.rpc("proc_submit_request", { p_request_id: id });
export const deptDecision = (id, decision, remarks) => supabase.rpc("proc_dept_decision", { p_request_id: id, p_decision: decision, p_remarks: remarks || null });
export const procurementDecision = (id, decision, remarks) => supabase.rpc("proc_procurement_decision", { p_request_id: id, p_decision: decision, p_remarks: remarks || null });
export const answerClarification = (id, answer) => supabase.rpc("proc_answer_clarification", { p_request_id: id, p_answer: answer });
export const cancelPurchaseRequest = (id, reason) => supabase.rpc("proc_cancel_request", { p_request_id: id, p_reason: reason });
export const recordPrint = (id, documentType) => supabase.rpc("proc_record_print", { p_request_id: id, p_document_type: documentType });
export const requestAmountApproval = (id, amount, remarks) => supabase.rpc("proc_request_amount_approval", { p_request_id: id, p_amount: Number(amount), p_remarks: remarks || null });
export const decideAmountApproval = (id, decision, remarks) => supabase.rpc("proc_decide_amount_approval", { p_request_id: id, p_decision: decision, p_remarks: remarks || null });
export const setPrimaryHead = (userId) => supabase.rpc("proc_set_primary_head", { p_user_id: userId });
export const setApprovalLimit = (approver, amount) => supabase.rpc("proc_set_approval_limit", { p_approver: approver, p_max_amount: amount === "" || amount == null ? null : Number(amount) });

export function confirmOrder(id, f) {
  return supabase.rpc("proc_confirm_order", {
    p_request_id: id, p_vendor_name: f.vendor_name, p_vendor_contact: f.vendor_contact, p_quotation_reference: f.quotation_reference,
    p_po_number: f.po_number, p_order_date: f.order_date, p_ordered_quantity: Number(f.ordered_quantity), p_amount: Number(f.amount),
    p_expected_delivery_date: f.expected_delivery_date, p_payment_terms: f.payment_terms, p_remarks: f.remarks,
    p_scope_of_work: f.scope_of_work || null,
  }).single();
}

// ---- Part 2 (mvp_pilot_procurement_v3_02_lifecycle.sql): vendors, quotations, follow-ups, progress, GRN, invoice, payments ----

export function listVendors() {
  return supabase.from("vendors").select("*").order("name");
}

export function saveVendor(id, f) {
  return supabase.rpc("proc_save_vendor", {
    p_vendor_id: id || null, p_name: f.name, p_contact_person: f.contact_person || null, p_mobile: f.mobile, p_email: f.email || null,
    p_address: f.address || null, p_gstin: f.gstin || null, p_pan: f.pan || null, p_categories: f.product_service_category || null,
    p_payment_terms: f.payment_terms || null, p_credit_period: f.credit_period || null, p_lead_time: f.lead_time || null, p_notes: f.notes || null,
  }).single();
}

export const setVendorStatus = (id, status, reason) => supabase.rpc("proc_set_vendor_status", { p_vendor_id: id, p_status: status, p_reason: reason || null });

export function listQuotations(requestId) {
  return supabase.from("vendor_quotations").select("*, vendors(name, mobile, rating, blacklisted)").eq("purchase_request_id", requestId).order("total_landed_cost");
}

export function listSelections(requestId) {
  return supabase.from("purchase_vendor_selections").select("*").eq("purchase_request_id", requestId).order("created_at_ts", { ascending: false });
}

export function addQuotation(requestId, f) {
  const n = (x) => (x === "" || x == null ? null : Number(x));
  return supabase.rpc("proc_add_quotation", {
    p_request_id: requestId, p_vendor_id: f.vendor_id, p_quotation_number: f.quotation_number, p_quotation_date: f.quotation_date,
    p_validity_date: f.validity_date || null, p_material_rate: n(f.material_rate), p_labour_rate: n(f.labour_rate), p_other_charges: n(f.other_charges),
    p_tax: n(f.tax), p_transport: n(f.transport), p_installation: n(f.installation), p_lead_time_days: n(f.lead_time_days),
    p_payment_terms: f.payment_terms || null, p_warranty: f.warranty || null, p_quality_rating: n(f.quality_rating),
  }).single();
}

export const selectQuotation = (requestId, quotationId, reason) => supabase.rpc("proc_select_quotation", { p_request_id: requestId, p_quotation_id: quotationId, p_reason: reason || null });

export function listFollowups(requestId) {
  return supabase.from("vendor_followups").select("*").eq("purchase_request_id", requestId).order("created_at", { ascending: false });
}

export const addFollowup = (requestId, f) => supabase.rpc("proc_add_followup", {
  p_request_id: requestId, p_notes: f.notes, p_contact_mode: f.contact_mode || null, p_next_date: f.next_date || null, p_escalate: !!f.escalate,
});

export function listDispatches(requestId) {
  return supabase.from("purchase_dispatches").select("*").eq("purchase_request_id", requestId).order("created_at", { ascending: false });
}

export const updateProgress = (requestId, toStatus, f = {}) => supabase.rpc("proc_update_progress", {
  p_request_id: requestId, p_to_status: toStatus, p_remarks: f.remarks || null, p_transporter: f.transporter || null, p_vehicle_number: f.vehicle_number || null,
  p_tracking_number: f.tracking_number || null, p_dispatch_date: f.dispatch_date || null, p_expected_arrival: f.expected_arrival || null,
});

export function listReceipts({ requestId, onlyRejected = false, limit = 500 } = {}) {
  let q = supabase.from("purchase_receipts").select("*, purchase_requests(request_number, material_name, unit)");
  if (requestId) q = q.eq("purchase_request_id", requestId);
  if (onlyRejected) q = q.gt("qty_rejected", 0);
  return q.order("created_at", { ascending: false }).limit(limit);
}

export const recordGrn = (requestId, f) => supabase.rpc("proc_record_grn", {
  p_request_id: requestId, p_received_qty: Number(f.received), p_accepted_qty: Number(f.accepted), p_rejected_qty: Number(f.rejected || 0),
  p_damaged_qty: Number(f.damaged || 0), p_receipt_location: f.location, p_qc_remarks: f.qc_remarks || null, p_rejection_reason: f.rejection_reason || null,
  p_corrective_action: f.corrective_action || null, p_replacement_required: !!f.replacement_required,
}).single();

export const verifyGrn = (requestId, remarks) => supabase.rpc("proc_verify_grn", { p_request_id: requestId, p_remarks: remarks || null });

export function getInvoice(requestId) {
  return supabase.from("purchase_payment_coordination").select("*").eq("purchase_request_id", requestId).maybeSingle();
}

export function listPayments(requestId) {
  return supabase.from("purchase_payments").select("*").eq("purchase_request_id", requestId).order("created_at");
}

export const recordInvoice = (requestId, f) => supabase.rpc("proc_record_invoice", {
  p_request_id: requestId, p_invoice_number: f.invoice_number, p_invoice_date: f.invoice_date, p_amount: Number(f.amount), p_tax: Number(f.tax || 0), p_due_date: f.due_date,
});
export const verifyInvoice = (requestId, decision, remarks) => supabase.rpc("proc_verify_invoice", { p_request_id: requestId, p_decision: decision, p_remarks: remarks || null });
export const recordPayment = (requestId, f) => supabase.rpc("proc_record_payment", {
  p_request_id: requestId, p_amount: Number(f.amount), p_paid_on: f.paid_on, p_payment_mode: f.mode, p_reference: f.reference,
});
export const closeRequest = (requestId, remarks) => supabase.rpc("proc_close_request", { p_request_id: requestId, p_remarks: remarks || null });
export const emergencyDecision = (requestId, decision, remarks) => supabase.rpc("proc_emergency_decision", { p_request_id: requestId, p_decision: decision, p_remarks: remarks || null });
export const reviewEmergency = (requestId, note) => supabase.rpc("proc_review_emergency", { p_request_id: requestId, p_note: note });
export const raiseLowStockRequests = () => supabase.rpc("proc_raise_low_stock_requests");

// ---- Production Supply Order Forms (mvp_pilot_order_forms_v3_05.sql) ----

const ORDER_BUCKET = "procurement-orders";

export function listOrderItems(requestId) {
  return supabase.from("purchase_request_items").select("id, line_no, item_code, description, qty_size, quantity, rate, amount, line_remarks")
    .eq("purchase_request_id", requestId).order("line_no");
}

export function getOrder(requestId) {
  return supabase.from("purchase_requests")
    .select("id, request_number, proc_status, order_form_type, project_id, client_name, sales_person_name, preferred_vendor_name, required_by_date, delivery_date, delivery_location, remarks, priority, is_emergency, emergency_reason, urgency_reason, requester_user_id, created_at")
    .eq("id", requestId).maybeSingle();
}

const orderHeader = (h) => ({
  form_type: h.form_type, project_id: h.project_id || null, client_name: h.client_name, sales_person_name: h.sales_person_name, vendor_name: h.vendor_name,
  required_completion_date: h.required_completion_date, delivery_date: h.delivery_date || null, delivery_location: h.delivery_location, remarks: h.remarks,
  priority: h.priority, procurement_category: h.procurement_category, urgency_reason: h.urgency_reason || null,
});
const orderItems = (items) => items.map((i) => ({ item_code: i.item_code, description: i.description, qty_size: i.qty_size, quantity: i.quantity, rate: i.rate, remarks: i.remarks }));

export function createOrder(header, items, { submit = true } = {}) {
  return supabase.rpc("proc_create_order", { p_header: orderHeader(header), p_items: orderItems(items), p_submit: submit }).single();
}

export function updateOrder(id, header, items) {
  return supabase.rpc("proc_update_order", { p_request_id: id, p_header: orderHeader(header), p_items: orderItems(items) }).single();
}

// Upload to procurement-orders/orders/<request id>/..., then record it against the order (proc_add_order_attachment checks access).
export async function uploadOrderFile(requestId, file) {
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
  const path = `orders/${requestId}/${crypto.randomUUID()}-${safe}`;
  const { error: upErr } = await supabase.storage.from(ORDER_BUCKET).upload(path, file, { contentType: file.type || undefined });
  if (upErr) return { error: upErr };
  return supabase.rpc("proc_add_order_attachment", {
    p_request_id: requestId, p_storage_path: path, p_file_name: file.name, p_file_type: file.type || null, p_file_size: file.size, p_description: null,
  });
}

export async function openOrderFile(storagePath) {
  const bucket = storagePath.startsWith("orders/") ? ORDER_BUCKET : "interior-attachments";
  const { data } = await supabase.storage.from(bucket).createSignedUrl(storagePath, 600);
  if (data?.signedUrl) window.open(data.signedUrl, "_blank", "noopener");
}

export const markDelivered = (id, deliveredOn, remarks) => supabase.rpc("proc_mark_delivered", { p_request_id: id, p_delivered_on: deliveredOn, p_remarks: remarks || null });
export const completeOrder = (id, remarks) => supabase.rpc("proc_complete_order", { p_request_id: id, p_remarks: remarks || null });
export const amendOrder = (id, changes, reason) => supabase.rpc("proc_amend_order", { p_request_id: id, p_changes: changes, p_reason: reason });

// ---- Due dates and reminders (mvp_pilot_order_reminders_v3_06.sql) ----
// Reminders are sent by the database on a schedule (pg_cron), not by this app; these calls only read and configure them.

export const getReminderOverview = () => supabase.rpc("proc_reminder_overview");
export const runRemindersNow = () => supabase.rpc("proc_run_reminders_now");
export const setReminderSettings = (s) => supabase.rpc("proc_set_reminder_settings", {
  p_enabled: !!s.enabled, p_working_days: s.working_days, p_start: s.window_start, p_end: s.window_end,
});
export const setHoliday = (date, name, remove = false) => supabase.rpc("proc_set_holiday", { p_date: date, p_name: name || null, p_remove: remove });
export const assignRequest = (id, userId, reason) => supabase.rpc("proc_assign_request", { p_request_id: id, p_user_id: userId, p_reason: reason || null });

export function listRequestReminders(requestId) {
  return supabase.from("procurement_reminders")
    .select("id, kind, recipient_id, status, attempts, push_status, read_at, sent_at, created_at, last_error, message_en")
    .eq("purchase_request_id", requestId).order("created_at", { ascending: false }).limit(200);
}

export function listRecentReminders(limit = 100) {
  return supabase.from("procurement_reminders")
    .select("id, purchase_request_id, kind, recipient_id, status, attempts, push_status, read_at, sent_at, created_at, last_error, message_en")
    .order("created_at", { ascending: false }).limit(limit);
}

// ---- Orders as Procurement tasks (mvp_pilot_order_tasks_v3_07.sql) ----
// Each order has one staff_tasks row (My Tasks) and one Bridge. The order stays the source of truth; these calls act on both.

// { [requestId]: { task_id, task_number, task_status, stage, assigned_name, accepted_by_name, can_accept, can_finish, finish_blocker, ... } }
export async function getOrderTaskInfo(ids) {
  if (!ids.length) return {};
  const { data, error } = await supabase.rpc("proc_order_task_info", { p_request_ids: ids });
  if (error) return {};
  return Object.fromEntries((data || []).map((r) => [r.request_id, r]));
}
export const acceptOrderTask = (id) => supabase.rpc("proc_accept_order_task", { p_request_id: id });
export const finishOrderTask = (id, remarks) => supabase.rpc("proc_finish_order_task", { p_request_id: id, p_remarks: remarks });
export const reopenOrderTask = (id, reason) => supabase.rpc("proc_reopen_order_task", { p_request_id: id, p_reason: reason });
export const changeDueDate = (id, date, reason) => supabase.rpc("proc_change_due_date", { p_request_id: id, p_new_date: date, p_reason: reason });
