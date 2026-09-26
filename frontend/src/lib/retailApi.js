// Retail Stores module — central API. Every write that must be atomic or idempotent (walk-in intake, follow-up scheduling, quotation
// creation, quotation->order conversion, confirmed-order fulfilment split, delivery stage, daily update) goes through the matching
// SECURITY DEFINER RPC in mvp_pilot_retail_workflow_v2_93*.sql — never a raw insert the browser could get half-right. Plain reads (lists,
// dashboard counts) use the normal RLS-scoped client, same as every other module in this app.
import { supabase } from "./supabase";

// ---- reference data -----------------------------------------------------------------------------------------------------------------
export async function retailDeptId() {
  const { data } = await supabase.rpc("retail_dept_id");
  return data;
}

// ---- customers -----------------------------------------------------------------------------------------------------------------------
export function searchCustomers(q, limit = 10) {
  let query = supabase.from("retail_customers").select("id, full_name, phone, whatsapp, email, city, area, customer_type").eq("is_active", true).order("full_name").limit(limit);
  if (q && q.trim()) query = query.or(`full_name.ilike.%${q.trim()}%,phone.ilike.%${q.trim()}%`);
  return query;
}

// ---- walk-in / leads -----------------------------------------------------------------------------------------------------------------
export function createWalkin(payload) {
  return supabase.rpc("retail_create_walkin", {
    p_customer_name: payload.customerName, p_phone: payload.phone || null, p_whatsapp: payload.whatsapp || null, p_email: payload.email || null,
    p_city: payload.city || null, p_location_id: payload.locationId || null, p_requirement_category: payload.requirementCategory || null,
    p_interested_products: payload.interestedProducts || null, p_room_category: payload.roomCategory || null, p_approx_budget: payload.approxBudget || null,
    p_purchase_timeline: payload.purchaseTimeline || null, p_lead_source: payload.leadSource || "walkin", p_salesperson: payload.salesperson || null,
    p_customer_type: payload.customerType || "RETAIL", p_notes: payload.notes || null, p_lead_temperature: payload.leadTemperature || "WARM",
    p_next_follow_up_at: payload.nextFollowUpAt || null,
  });
}

export function listLeads({ status } = {}) {
  let q = supabase.from("retail_leads").select("*").eq("is_active", true).order("created_at", { ascending: false }).limit(300);
  if (status) q = q.eq("status", status);
  return q;
}

// ---- follow-ups -----------------------------------------------------------------------------------------------------------------------
export function recordFollowUp(leadId, payload) {
  return supabase.rpc("retail_record_followup", {
    p_lead_id: leadId, p_contact_mode: payload.contactMode, p_outcome: payload.outcome || null, p_customer_response: payload.customerResponse || null,
    p_products_discussed: payload.productsDiscussed || null, p_expected_decision_date: payload.expectedDecisionDate || null,
    p_revised_budget: payload.revisedBudget || null, p_notes: payload.notes || null, p_next_action: payload.nextAction || null,
    p_next_follow_up_at: payload.nextFollowUpAt || null, p_status: payload.status || "CONTACTED", p_lost_reason: payload.lostReason || null,
  });
}

export function listFollowUps(leadId) {
  return supabase.from("retail_followups").select("*").eq("lead_id", leadId).order("created_at", { ascending: false });
}

// ---- quotations -----------------------------------------------------------------------------------------------------------------------
export function createQuotation(payload) {
  return supabase.rpc("retail_create_quotation", {
    p_lead_id: payload.leadId || null, p_customer_name: payload.customerName, p_phone: payload.phone || null, p_location_id: payload.locationId || null,
    p_valid_until: payload.validUntil || null, p_expected_delivery: payload.expectedDelivery || null, p_delivery_charge: payload.deliveryCharge || 0,
    p_installation_charge: payload.installationCharge || 0, p_terms: payload.terms || null, p_internal_approval_required: !!payload.internalApprovalRequired,
    p_items: payload.items || [], p_supersedes_id: payload.supersedesId || null,
  });
}

export function convertQuotationToOrder(quotationId) {
  return supabase.rpc("retail_convert_quotation_to_order", { p_quotation_id: quotationId });
}

// Internal approval — restricted to Retail dept-head/management/global-oversight at the DB layer (retail_approve_quotation, see
// mvp_pilot_retail_workflow_v2_93f.sql). Idempotent: approving an already-approved quotation is a safe no-op.
export function approveQuotation(quotationId, approved, notes) {
  return supabase.rpc("retail_approve_quotation", { p_quotation_id: quotationId, p_approved: approved, p_notes: notes || null });
}

// ---- confirmed-order fulfilment split ---------------------------------------------------------------------------------------------
// fulfilment: [{ order_item_id, mode: 'STOCK'|'FACTORY'|'OUTSOURCE'|'IMMEDIATE_DELIVERY', quantity?, required_date?, priority?, notes?,
//               stock_location_id?, preferred_vendor?, target_cost?, specification?, delivery_destination?, qc_requirement?,
//               factory_location_id? }]
export function confirmOrder(orderId, fulfilment) {
  return supabase.rpc("retail_confirm_order", { p_order_id: orderId, p_fulfilment: fulfilment || [] });
}

export function listFulfilmentItems(orderId) {
  return supabase.from("retail_fulfilment_items").select("*").eq("order_id", orderId);
}

// ---- Immediate Delivery: Sales Confirmation Product Photo -> automatic Godown request (v2_93m) -----------------------------------
// Requires a retail_order_item proof photo (ProofPhotoUpload entityType="retail_order_item") to already be uploaded — the RPC itself
// refuses without one. On success this is also the automatic trigger: the instant every IMMEDIATE_DELIVERY item on the order has its
// photo AND payment/approval is valid, the backend creates the Godown fulfilment request itself — nothing here calls "send to godown".
export function recordSalesPhotoMeta(orderItemId, location, serial, conditionNote, notes) {
  return supabase.rpc("retail_record_sales_photo_meta", {
    p_order_item_id: orderItemId, p_location: location || null, p_serial: serial || null,
    p_condition_note: conditionNote || null, p_notes: notes || null,
  });
}
export function loadImmediateDeliveryQueue() {
  return supabase.rpc("retail_immediate_delivery_queue");
}

// ---- delivery -----------------------------------------------------------------------------------------------------------------------
export function advanceDelivery(orderId, stage, notes, scheduledAt) {
  return supabase.rpc("retail_advance_delivery", { p_order_id: orderId, p_stage: stage, p_notes: notes || null, p_scheduled_at: scheduledAt || null });
}
export function getDelivery(orderId) {
  return supabase.from("retail_deliveries").select("*").eq("order_id", orderId).maybeSingle();
}
// Real confirmed orders + their delivery timeline in one call — see mvp_pilot_retail_workflow_v2_93d.sql.
export function loadDeliveriesBoard() {
  return supabase.rpc("retail_deliveries_board");
}

// ---- stock -----------------------------------------------------------------------------------------------------------------------
// On-hand / damaged / incoming / RESERVED (never shown as free) / available, per product per location — see
// mvp_pilot_retail_workflow_v2_93d.sql. Reserved is computed from confirmed STOCK-mode order items, cross-referenced by SKU.
export function loadStockAvailability(query, locationId) {
  return supabase.rpc("retail_stock_availability", { p_query: query || null, p_location_id: locationId || null });
}

// ---- daily update -----------------------------------------------------------------------------------------------------------------------
export function recordDailyUpdate(locationId, fields = {}) {
  return supabase.rpc("retail_record_daily_update", {
    p_location_id: locationId || null, p_display_update_note: fields.displayUpdateNote || null, p_delivery_coordination_note: fields.deliveryCoordinationNote || null,
    p_problems: fields.problems || null, p_tomorrow_priority: fields.tomorrowPriority || null, p_notes: fields.notes || null,
  });
}

// ---- dashboard KPIs -----------------------------------------------------------------------------------------------------------------
// Every count is a real, RLS-scoped query — never hardcoded. Run in parallel; a failed slice degrades to 0 rather than blocking the rest.
async function countOf(builder) {
  const { count, error } = await builder;
  return error ? 0 : (count || 0);
}
export async function loadDashboardCounts() {
  const today = new Date().toISOString().slice(0, 10);
  const active = { is_active: true };
  const [
    walkinsToday, followupsDueToday, followupsOverdue, openQuotations, pendingApproval, confirmedOrders,
    pendingStockChecks, activeJobCards, pendingProcurement, deliveriesDueToday, delayedDeliveries, complaintsOpen,
  ] = await Promise.all([
    countOf(supabase.from("retail_leads").select("id", { count: "exact", head: true }).match(active).gte("created_at", today)),
    countOf(supabase.from("retail_leads").select("id", { count: "exact", head: true }).match(active).eq("next_follow_up_date", today).not("status", "in", "(CONVERTED,LOST)")),
    countOf(supabase.from("retail_leads").select("id", { count: "exact", head: true }).match(active).lt("next_follow_up_date", today).not("status", "in", "(CONVERTED,LOST)")),
    countOf(supabase.from("retail_quotations").select("id", { count: "exact", head: true }).match(active).in("status", ["DRAFT", "SENT"])),
    countOf(supabase.from("retail_quotations").select("id", { count: "exact", head: true }).match(active).eq("internal_approval_required", true).is("internal_approved_at", null)),
    countOf(supabase.from("retail_orders").select("id", { count: "exact", head: true }).match(active).eq("status", "BOOKED")),
    countOf(supabase.from("retail_fulfilment_items").select("id", { count: "exact", head: true }).eq("mode", "STOCK").eq("status", "PENDING")),
    countOf(supabase.from("inhouse_production_requests").select("id", { count: "exact", head: true }).eq("source_module", "retail").not("factory_status", "in", "(completed,cancelled)")),
    countOf(supabase.from("retail_procurement_requests").select("id", { count: "exact", head: true }).match(active).not("status", "in", "(COMPLETED,CANCELLED)")),
    countOf(supabase.from("retail_deliveries").select("id", { count: "exact", head: true }).match(active).gte("scheduled_at", today).lt("scheduled_at", today + "T23:59:59")),
    countOf(supabase.from("retail_deliveries").select("id", { count: "exact", head: true }).match(active).not("delay_reason", "is", null).not("stage", "in", "(DELIVERED,COMPLETED)")),
    countOf(supabase.from("retail_complaints").select("id", { count: "exact", head: true }).match(active).neq("status", "RESOLVED")),
  ]);
  return {
    walkinsToday, followupsDueToday, followupsOverdue, openQuotations, pendingApproval, confirmedOrders,
    pendingStockChecks, activeJobCards, pendingProcurement, deliveriesDueToday, delayedDeliveries, complaintsOpen,
  };
}

// ---- Excel/CSV lead import ---------------------------------------------------------------------------------------------------------
// rows: [{ customer_name, phone, whatsapp?, email?, city?, source?, requirement_category?, customer_type?, notes? }] — already
// column-mapped by the frontend's mapping step. p_dry_run=true (default) only validates/detects duplicates, writes nothing.
export function importLeads(rows, dryRun = true) {
  return supabase.rpc("retail_import_leads", { p_rows: rows, p_dry_run: dryRun });
}

// ---- reports -----------------------------------------------------------------------------------------------------------------------
// scope: 'own' (default — the caller's own portfolio) | 'team' | 'all' (dept-head/management only, enforced server-side).
export function loadReportsSummary(fromDate, toDate, scope, salespersonId) {
  return supabase.rpc("retail_reports_summary", { p_from: fromDate || null, p_to: toDate || null, p_scope: scope || "own", p_salesperson_id: salespersonId || null });
}

// ---- salesperson-wise customer ownership (v2_93h) ------------------------------------------------------------------------------
export function checkDuplicateCustomer(fullName, phone, whatsapp, email, city) {
  return supabase.rpc("retail_check_duplicate_customer", {
    p_full_name: fullName, p_phone: phone || null, p_whatsapp: whatsapp || null, p_email: email || null, p_city: city || null,
  });
}
export function transferCustomer(customerId, newOwnerId, transferType, effectiveDate, until, reason) {
  return supabase.rpc("retail_transfer_customer", {
    p_customer_id: customerId, p_new_owner_id: newOwnerId, p_transfer_type: transferType,
    p_effective_date: effectiveDate || null, p_until: until || null, p_reason: reason || null,
  });
}
export function requestCustomerAccess(customerId, reason) {
  return supabase.rpc("retail_request_customer_access", { p_customer_id: customerId, p_reason: reason || null });
}
export function decideAccessRequest(requestId, approved, notes) {
  return supabase.rpc("retail_decide_access_request", { p_request_id: requestId, p_approved: approved, p_notes: notes || null });
}
export function mergeCustomers(primaryId, duplicateId, reason) {
  return supabase.rpc("retail_merge_customers", { p_primary_id: primaryId, p_duplicate_id: duplicateId, p_reason: reason });
}
export function loadCustomerTimeline(customerId) {
  return supabase.rpc("retail_customer_timeline", { p_customer_id: customerId });
}
export function loadCustomer(customerId) {
  return supabase.from("retail_customers").select("*").eq("id", customerId).maybeSingle();
}
export function listMyAccessRequests() {
  return supabase.from("retail_customer_access_requests").select("*, retail_customers(full_name)").order("created_at", { ascending: false }).limit(100);
}
export function listCustomerAccessGrants(customerId) {
  return supabase.from("retail_customer_access").select("*").eq("customer_id", customerId).eq("is_active", true);
}
export function searchRetailTeam(q) {
  // any active Retail teammate, for the transfer/backup picker
  let query = supabase.from("user_profiles").select("id, full_name").eq("is_active", true).order("full_name").limit(50);
  if (q && q.trim()) query = query.ilike("full_name", `%${q.trim()}%`);
  return query;
}
// Godown/Dispatch staff pickers — scoped to their real department so the RPC's own "must be an active Godown/Dispatch team member"
// check never rejects a name this dropdown offered.
export async function listGodownStaff() {
  const { data: deptId } = await supabase.rpc("retail_godown_dept_id");
  if (!deptId) return { data: [], error: null };
  return supabase.from("user_profiles").select("id, full_name").eq("department_id", deptId).eq("is_active", true).order("full_name");
}
export async function listDispatchStaff() {
  const { data: deptId } = await supabase.rpc("retail_dispatch_dept_id");
  if (!deptId) return { data: [], error: null };
  return supabase.from("user_profiles").select("id, full_name").eq("department_id", deptId).eq("is_active", true).order("full_name");
}

// ---- pipeline: Packing (v2_93i) --------------------------------------------------------------------------------------------------
export function startPacking(orderId, partialReason) {
  return supabase.rpc("retail_start_packing", { p_order_id: orderId, p_partial_reason: partialReason || null });
}
export function verifyPacking(packingId, items, qcStatus, packageCount, conditionNotes, missingDamagedNote) {
  return supabase.rpc("retail_verify_packing", {
    p_packing_id: packingId, p_items: items || [], p_qc_status: qcStatus || "PASSED",
    p_package_count: packageCount ?? null, p_condition_notes: conditionNotes || null, p_missing_damaged_note: missingDamagedNote || null,
  });
}
export function listPackingQueue() {
  return supabase.from("retail_packing_records").select("*, retail_orders(order_number, customer_name, delivery_address)").order("created_at", { ascending: false }).limit(200);
}
export function getPackingForOrder(orderId) {
  return supabase.from("retail_packing_records").select("*").eq("order_id", orderId).maybeSingle();
}
export function listPackingItems(packingId) {
  return supabase.from("retail_packing_items").select("*, retail_order_items(item_name)").eq("packing_id", packingId);
}

// ---- pipeline: Godown handover (v2_93i) ------------------------------------------------------------------------------------------
export function sendToGodown(orderId, godownLocationId, responsibleUserId, expectedHandoverAt, notes) {
  return supabase.rpc("retail_send_to_godown", {
    p_order_id: orderId, p_godown_location_id: godownLocationId || null, p_responsible_user_id: responsibleUserId,
    p_expected_handover_at: expectedHandoverAt || null, p_notes: notes || null,
  });
}
export function godownAccept(handoverId, packagesReceived, quantityVerified, conditionVerified, rackLocation, notes) {
  return supabase.rpc("retail_godown_accept", {
    p_handover_id: handoverId, p_packages_received: packagesReceived, p_quantity_verified: quantityVerified,
    p_condition_verified: conditionVerified, p_rack_location: rackLocation || null, p_notes: notes || null,
  });
}
export function godownReject(handoverId, reason, missingQty, damagedQty, returnDepartmentId, responsibleUserId) {
  return supabase.rpc("retail_godown_reject", {
    p_handover_id: handoverId, p_reason: reason, p_missing_qty: missingQty ?? null, p_damaged_qty: damagedQty ?? null,
    p_return_department_id: returnDepartmentId || null, p_responsible_user_id: responsibleUserId || null,
  });
}
// Godown Head/Supervisor assigns a specific team member to a still-PENDING incoming request (v2_93p).
export function assignGodownHandover(handoverId, userId) {
  return supabase.rpc("retail_assign_godown_handover", { p_handover_id: handoverId, p_user_id: userId });
}
export function listGodownQueue() {
  // retail_packing_records(status) is embedded so the Godown inbox can tell an already-packed "standard" handover
  // apart from an Immediate Delivery one (v2_93m) where Godown itself still has to verify & pack — derived at read
  // time from the linked packing record's own status, no separate discriminator column needed.
  return supabase.from("retail_godown_handovers")
    .select("*, retail_orders(order_number, customer_name, delivery_address, installation_required), retail_packing_records(id, status)")
    .order("created_at", { ascending: false }).limit(200);
}

// ---- pipeline: Dispatch (v2_93j) -------------------------------------------------------------------------------------------------
export function startDispatch(orderId) {
  return supabase.rpc("retail_start_dispatch", { p_order_id: orderId });
}
export function preDispatchChecklist(orderId, checklist, exceptionReason) {
  return supabase.rpc("retail_pre_dispatch_checklist", { p_order_id: orderId, p_checklist: checklist || {}, p_exception_reason: exceptionReason || null });
}
export function recordDispatch(dispatchId, vehicleNumber, vehicleTransporter, packageCount, challanRef, gpsLocation, notes) {
  return supabase.rpc("retail_record_dispatch", {
    p_dispatch_id: dispatchId, p_vehicle_number: vehicleNumber, p_vehicle_transporter: vehicleTransporter || null,
    p_package_count: packageCount ?? null, p_delivery_challan_ref: challanRef || null, p_gps_location: gpsLocation || null, p_notes: notes || null,
  });
}
export function listDispatchQueue() {
  return supabase.from("retail_dispatch_records").select("*, retail_orders(order_number, customer_name, delivery_address)").order("created_at", { ascending: false }).limit(200);
}
export function getDispatchForOrder(orderId) {
  return supabase.from("retail_dispatch_records").select("*").eq("order_id", orderId).maybeSingle();
}

export const PRE_DISPATCH_CHECKLIST_KEYS = [
  ["correct_order", "correctOrderCheckLabel"],
  ["correct_customer_address", "correctAddressCheckLabel"],
  ["quantity_checked", "quantityCheckedLabel"],
  ["packing_checked", "packingCheckedLabel"],
  ["condition_checked", "conditionCheckedLabel"],
  ["documents_checked", "documentsCheckedLabel"],
  ["payment_clearance_checked", "paymentClearanceCheckedLabel"],
  ["site_confirmed", "siteConfirmedLabel"],
  ["vehicle_assigned", "vehicleAssignedLabel"],
];

// ---- pipeline: Delivery proof / partial / failure / installation (v2_93j) ---------------------------------------------------------
export function recordDeliveryProof(orderId, siteRepName, podMethod, podReference, items, conditionNotes) {
  return supabase.rpc("retail_record_delivery_proof", {
    p_order_id: orderId, p_site_representative_name: siteRepName, p_pod_method: podMethod, p_pod_reference: podReference || null,
    p_items: items || [], p_condition_notes: conditionNotes || null,
  });
}
export function recordDeliveryFailure(orderId, reason, nextDeliveryDate) {
  return supabase.rpc("retail_record_delivery_failure", { p_order_id: orderId, p_reason: reason, p_next_delivery_date: nextDeliveryDate || null });
}
export function completeOrder(orderId) {
  return supabase.rpc("retail_complete_order", { p_order_id: orderId });
}
export function startInstallation(orderId) {
  return supabase.rpc("retail_start_installation", { p_order_id: orderId });
}
export function recordInstallation(installationId, team, pendingWork, damageRework) {
  return supabase.rpc("retail_record_installation", { p_installation_id: installationId, p_installation_team: team || null, p_pending_work: pendingWork || null, p_damage_rework: damageRework || null });
}
export function confirmInstallation(installationId, customerConfirmed, feedbackScore) {
  return supabase.rpc("retail_confirm_installation", { p_installation_id: installationId, p_customer_confirmed: customerConfirmed, p_feedback_score: feedbackScore ?? null });
}
export function getInstallationForOrder(orderId) {
  return supabase.from("retail_installations").select("*").eq("order_id", orderId).maybeSingle();
}
export function listDeliveryItems(deliveryId) {
  return supabase.from("retail_delivery_items").select("*, retail_order_items(item_name)").eq("delivery_id", deliveryId);
}
export function listDeliveryProofs(deliveryId) {
  return supabase.from("retail_delivery_proofs").select("*").eq("delivery_id", deliveryId).order("created_at", { ascending: false });
}
// Deliveries whose order needs installation and has reached (or passed) a successful delivery — Dispatch's own installation queue.
export function listInstallationQueue() {
  return supabase.from("retail_deliveries")
    .select("*, retail_orders!inner(order_number, customer_name, delivery_address, installation_required), retail_installations(*)")
    .eq("retail_orders.installation_required", true)
    .in("stage", ["DELIVERY_SUCCESSFUL", "INSTALLATION_PENDING", "INSTALLATION_IN_PROGRESS", "INSTALLATION_PROOF_UPLOADED"])
    .order("created_at", { ascending: false }).limit(200);
}

// ---- reports (v2_93k) --------------------------------------------------------------------------------------------------------
export function loadSalespersonReport(salespersonId, fromDate, toDate) {
  return supabase.rpc("retail_salesperson_report", { p_salesperson_id: salespersonId || null, p_from: fromDate || null, p_to: toDate || null });
}
export function loadPipelineReport(fromDate, toDate) {
  return supabase.rpc("retail_pipeline_report", { p_from: fromDate || null, p_to: toDate || null });
}
export function loadOwnershipReport() {
  return supabase.rpc("retail_ownership_report");
}

// ---- Godown stock intake: photo -> auto product code + QR (v2_93o) ----------------------------------------------------------------
// Simplified for low-literacy Godown workers: one photo, one tap. retail_start_stock_intake creates a real
// placeholder product+stock row; the AI classify Edge Function fills in a suggestion (never required — the worker
// can just type instead); retail_confirm_stock_intake requires the photo and commits the real SKU.
export function startStockIntake(locationId) {
  return supabase.rpc("retail_start_stock_intake", { p_location_id: locationId });
}
// v2_93r: corrected to the real two-tier shape (Product Master vs. physical Inventory Serial) -- returns ONE
// product-master row always, regardless of quantity/item-level. When itemLevel is true and quantity > 1, N unique
// serials are created in retail_inventory_items (fetch them separately with listInventoryItems(productId)) — they
// are NOT separate product rows (that was v2_93q's now-superseded shortcut).
export function confirmStockIntake(productId, category, name, unit, quantity, condition, rackLocation, note, itemLevel, categoryCorrected, productTypeCode) {
  return supabase.rpc("retail_confirm_stock_intake", {
    p_product_id: productId, p_category: category, p_name: name, p_unit: unit || "Nos", p_quantity: quantity ?? 1,
    p_condition: condition || "GOOD", p_rack_location: rackLocation || null, p_note: note || null,
    p_item_level: !!itemLevel, p_category_corrected: !!categoryCorrected, p_product_type_code: productTypeCode || null,
  });
}
export function listInventoryItems(productId) {
  return supabase.from("retail_inventory_items").select("*").eq("product_id", productId).order("serial_number");
}
export function listProductTypes() {
  return supabase.rpc("retail_list_product_types");
}
export function upsertProductType(code, nameEn, nameGu, prefix) {
  return supabase.rpc("retail_upsert_product_type", { p_code: code, p_name_en: nameEn, p_name_gu: nameGu, p_prefix: prefix });
}
// Calls the retail-stock-ai-classify Edge Function — best-effort; a failure here is not fatal, the caller just gets
// { ok: false, reason } and shows empty fields for the worker to type instead of a suggestion.
export async function classifyStockPhoto(productId) {
  const { data, error } = await supabase.functions.invoke("retail-stock-ai-classify", { body: { product_id: productId } });
  if (error) return { ok: false, reason: error.message };
  return data;
}
export function loadStockIntakeQueue() {
  return supabase.rpc("retail_stock_intake_queue");
}

// ---- Godown worker simplification (v2_93q): Move-to-Display, inventory correction, QR scan, My Work Today, reports ----------------
export function moveStockToDisplay(productId, toLocationId, quantity, note) {
  return supabase.rpc("retail_move_stock_to_display", { p_product_id: productId, p_to_location_id: toLocationId, p_quantity: quantity, p_note: note || null });
}
export function correctStock(productId, locationId, newOnHandQty, newDamagedQty, reason) {
  return supabase.rpc("retail_correct_stock", {
    p_product_id: productId, p_location_id: locationId, p_new_on_hand_qty: newOnHandQty, p_new_damaged_qty: newDamagedQty ?? 0, p_reason: reason,
  });
}
export function scanProduct(code) {
  return supabase.rpc("retail_scan_product", { p_code: code });
}
export function loadMyWorkToday() {
  return supabase.rpc("retail_godown_my_work_today");
}
export function loadGodownReportsSummary() {
  return supabase.rpc("retail_godown_reports_summary");
}
export function listShowroomLocations() {
  return supabase.from("locations").select("id, name_en, name_gu").eq("type", "showroom").eq("is_active", true).order("name_en");
}
export function logLabelReprint(productId, reason, inventoryItemId) {
  return supabase.rpc("retail_log_label_reprint", { p_product_id: productId, p_reason: reason, p_inventory_item_id: inventoryItemId || null });
}

// ---- Product lifecycle (v2_93r): pricing/detail versioning, QR-based quotation entry, Delivery Challan, Godown
// scan-pick, damage reporting, returns. ---------------------------------------------------------------------------
export function updateProductPricing(productId, mrp, sellingPrice, minApprovedPrice, reason) {
  return supabase.rpc("retail_update_product_pricing", {
    p_product_id: productId, p_mrp: mrp ?? null, p_selling_price: sellingPrice ?? null, p_min_approved_price: minApprovedPrice ?? null, p_reason: reason,
  });
}
export function updateProductDetails(productId, fields, reason) {
  return supabase.rpc("retail_update_product_details", {
    p_product_id: productId, p_name: fields.name || null, p_material: fields.material || null, p_color_finish: fields.colorFinish || null,
    p_dimensions: fields.dimensions || null, p_description: fields.description || null, p_warranty_text: fields.warrantyText || null,
    p_gst_percent: fields.gstPercent ?? null, p_brand_vendor: fields.brandVendor || null, p_display_availability: fields.displayAvailability ?? null,
    p_reason: reason,
  });
}
export function listProductPriceHistory(productId) {
  return supabase.from("retail_product_price_history").select("*").eq("product_id", productId).order("changed_at", { ascending: false });
}
export function addQuotationItemFromScan(quotationId, code, quantity, discount) {
  return supabase.rpc("retail_add_quotation_item_from_scan", { p_quotation_id: quotationId, p_code: code, p_quantity: quantity ?? 1, p_discount: discount ?? 0 });
}
export function createDeliveryChallan(orderId, vehicleTransporter, deliveryDate, specialInstructions, notes) {
  return supabase.rpc("retail_create_delivery_challan", {
    p_order_id: orderId, p_vehicle_transporter: vehicleTransporter || null, p_delivery_date: deliveryDate || null,
    p_special_instructions: specialInstructions || null, p_notes: notes || null,
  });
}
export function getDeliveryChallanForOrder(orderId) {
  return supabase.from("retail_delivery_challans").select("*").eq("order_id", orderId).eq("status", "ACTIVE").maybeSingle();
}
export function listDeliveryChallanItems(dcId) {
  return supabase.from("retail_delivery_challan_items").select("*, retail_inventory_items(serial_number, status), retail_order_items(item_name)").eq("dc_id", dcId);
}
export function godownScanPick(handoverId, code) {
  return supabase.rpc("retail_godown_scan_pick", { p_handover_id: handoverId, p_code: code });
}
export function reportItemDamage(inventoryItemId, reason) {
  return supabase.rpc("retail_report_item_damage", { p_inventory_item_id: inventoryItemId, p_reason: reason });
}
export function scanReturnToGodown(code, notes) {
  return supabase.rpc("retail_scan_return_to_godown", { p_code: code, p_notes: notes || null });
}
export function restockReturnedItem(inventoryItemId, reason) {
  return supabase.rpc("retail_restock_returned_item", { p_inventory_item_id: inventoryItemId, p_reason: reason });
}

// "Important Work": urgent, overdue, blocked. One screen worth of real records, not just counts.
export async function loadImportantWork() {
  const today = new Date().toISOString().slice(0, 10);
  const [overdueFollowUps, pendingApprovalQuotes, blockedOrders, delayedJobs, openComplaints] = await Promise.all([
    supabase.from("retail_leads").select("id, customer_name, assigned_to, next_follow_up_date, lead_temperature, status")
      .eq("is_active", true).lt("next_follow_up_date", today).not("status", "in", "(CONVERTED,LOST)").order("next_follow_up_date").limit(20),
    supabase.from("retail_quotations").select("id, quotation_number, customer_name, created_by, total_amount, created_at")
      .eq("is_active", true).eq("internal_approval_required", true).is("internal_approved_at", null).order("created_at").limit(20),
    supabase.from("retail_orders").select("id, order_number, customer_name, created_by, payment_status, status")
      .eq("is_active", true).eq("status", "BOOKED").neq("payment_status", "PAID").order("created_at").limit(20),
    supabase.from("inhouse_production_requests").select("id, job_order_number, customer_name, product_item, required_completion_date, factory_status")
      .eq("source_module", "retail").lt("required_completion_date", today).not("factory_status", "in", "(completed,cancelled)").order("required_completion_date").limit(20),
    supabase.from("retail_complaints").select("id, customer_name, description, assigned_to, created_at").eq("is_active", true).neq("status", "RESOLVED").order("created_at").limit(20),
  ]);
  return {
    overdueFollowUps: overdueFollowUps.data || [], pendingApprovalQuotes: pendingApprovalQuotes.data || [], blockedOrders: blockedOrders.data || [],
    delayedJobs: delayedJobs.data || [], openComplaints: openComplaints.data || [],
  };
}
