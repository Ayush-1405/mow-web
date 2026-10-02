import { supabase } from "./supabase";
import { subscribeTable } from "./realtime";

// Factory Phase 1 data layer. Everything reads through RLS (views / tables
// under the caller's own session) or writes through a SECURITY DEFINER RPC
// that re-validates role and status server-side. No permission decisions
// are made here.

const LIST_COLUMNS = [
  "id", "job_order_number", "factory_status", "source_department_id", "source_department_name", "source_department_name_gu",
  "source_module", "source_reference", "project_code", "customer_name", "site_location", "product_item", "item_count",
  "qty_summary", "total_qty", "required_date", "priority", "current_stage", "completion_percentage", "assigned_name", "second_name",
  "assigned_factory_coordinator", "second_assignee_coordinator", "file_count", "drawing_count", "missing_count", "is_delayed",
  "is_blocked", "viewed_at", "requested_by", "requested_by_name", "clarification_note", "blocked_reason", "updated_at", "created_at",
].join(",");

function istDayStartIso() {
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - 5.5 * 3600e3).toISOString();
}

function safeSearch(s) {
  return (s || "").replace(/[,()%*\\]/g, " ").trim();
}

export async function getDashboardCounts(locationId) {
  const { data, error } = await supabase.rpc("factory_dashboard_counts", { p_location: locationId || null });
  return { data: Array.isArray(data) ? data[0] : data, error };
}

export async function getMyActions() {
  return supabase.rpc("factory_my_actions");
}

export async function listFactoryLocations() {
  return supabase.from("factory_locations").select("id, name").order("name");
}

// tab: new | verify | accepted | assigned | in_production | returned | delayed | completed | done_today | active | all | mine
export async function listJobCards({ tab = "all", search, sourceDept, status, stage, location, division, assignee, dueFrom, dueTo, priority, delayed, profileId, from = 0, to = 29 } = {}) {
  let q = supabase.from("factory_job_cards_v").select(LIST_COLUMNS, { count: "exact" }).eq("is_test_data", false);
  switch (tab) {
    case "new": q = q.eq("factory_status", "pending_verification").is("viewed_at", null); break;
    case "verify": q = q.eq("factory_status", "pending_verification").not("viewed_at", "is", null); break;
    case "accepted": q = q.eq("factory_status", "accepted"); break;
    case "assigned": q = q.eq("factory_status", "assigned"); break;
    case "in_production": q = q.eq("factory_status", "in_production"); break;
    case "returned": q = q.eq("factory_status", "needs_clarification"); break;
    case "delayed": q = q.eq("is_delayed", true); break;
    case "completed": q = q.in("factory_status", ["completed", "cancelled"]); break;
    case "active": q = q.not("factory_status", "in", "(completed,cancelled)"); break;
    case "done_today": {
      const start = istDayStartIso();
      q = q.or(`and(factory_status.eq.ready_for_review,ready_at.gte.${start}),and(factory_status.eq.completed,completed_at.gte.${start})`);
      break;
    }
    case "mine":
      if (profileId) q = q.or(`assigned_factory_coordinator.eq.${profileId},second_assignee_coordinator.eq.${profileId}`);
      q = q.in("factory_status", ["assigned", "in_production", "blocked", "ready_for_review"]);
      break;
    default: break;
  }
  if (status) q = q.eq("factory_status", status);
  if (stage) q = q.eq("current_stage", stage);
  if (sourceDept) q = q.eq("source_department_id", sourceDept);
  if (location) q = q.eq("factory_location_id", location);
  if (division) q = q.eq("division_id", division);
  if (assignee) q = q.or(`assigned_factory_coordinator.eq.${assignee},second_assignee_coordinator.eq.${assignee}`);
  if (dueFrom) q = q.gte("required_date", dueFrom);
  if (dueTo) q = q.lte("required_date", dueTo);
  if (priority) q = Array.isArray(priority) ? q.in("priority", priority) : q.eq("priority", priority);
  if (delayed === true) q = q.eq("is_delayed", true);
  if (delayed === false) q = q.eq("is_delayed", false);
  const s = safeSearch(search);
  if (s) {
    const p = `%${s}%`;
    q = q.or(["job_order_number", "source_reference", "customer_name", "project_code", "product_item", "all_items", "assigned_name", "second_name"].map((c) => `${c}.ilike.${p}`).join(","));
  }
  return q.order("required_date", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false }).range(from, to);
}

export async function getJobCard(id) {
  return supabase.from("factory_job_cards_v").select("*").eq("id", id).maybeSingle();
}
export async function listJobItems(id) {
  return supabase.from("factory_job_items").select("*").eq("job_id", id).order("line_no");
}
export async function listJobFiles(id) {
  return supabase.from("factory_job_files_v").select("*").eq("job_id", id).order("uploaded_at", { ascending: false });
}
export async function listJobEvents(id) {
  return supabase.from("factory_job_events_v").select("*").eq("job_id", id).order("created_at", { ascending: false });
}
export async function listStageUpdates(id) {
  return supabase.from("production_stage_updates").select("stage,status,quantity_completed,notes,updated_at").eq("job_id", id).order("updated_at", { ascending: false });
}
export async function listFactoryPeople() {
  return supabase.rpc("factory_list_people");
}

export async function jobTransition(id, action, note, payload) {
  return supabase.rpc("factory_job_transition", { p_job_id: id, p_action: action, p_note: note || null, p_payload: payload || {} });
}
export async function markViewed(id) {
  return supabase.rpc("factory_job_mark_viewed", { p_job_id: id });
}
export async function addComment(id, note) {
  return supabase.rpc("factory_job_add_comment", { p_job_id: id, p_note: note });
}
export async function updateItems(id, items) {
  return supabase.rpc("factory_job_update_items", { p_job_id: id, p_items: items });
}
export async function updateDetails(id, patch) {
  return supabase.rpc("factory_job_update_details", { p_job_id: id, p_patch: patch });
}
export async function submitJobCard({ idempotencyKey, sourceModule, sourceReference, sourceRecordId, projectId, customerName, siteLocation, title, requiredDate, priority, notes, items, purchaseRequestId }) {
  const { data, error } = await supabase.rpc("factory_submit_job_card", {
    p_idempotency_key: idempotencyKey || null, p_source_module: sourceModule, p_source_reference: sourceReference || null,
    p_source_record_id: sourceRecordId || null, p_project_id: projectId || null, p_customer_name: customerName || null,
    p_site_location: siteLocation || null, p_title: title || null, p_required_date: requiredDate || null,
    p_priority: priority || "Normal", p_notes: notes || null, p_items: items || [], p_purchase_request_id: purchaseRequestId || null,
    p_factory_location_id: null,
  });
  const row = Array.isArray(data) ? data[0] : data;
  return { data: row, error };
}

export const FACTORY_FILE_BUCKET = "factory-ai-attachments";
export const FACTORY_FILE_TYPES = ["jpg", "jpeg", "png", "webp", "pdf", "dwg", "dxf", "xlsx", "xls", "csv", "docx"];
export const FACTORY_FILE_MAX_MB = 15;

// Uploads to the private bucket, then records the file against the Job Card.
// If recording fails the fresh upload is removed so no orphan is left behind
// (best effort -- physical removal is restricted to management by storage RLS).
export async function uploadJobFile(jobId, file, category, title, note) {
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-140);
  const path = `job/${jobId}/${crypto.randomUUID()}-${safe}`;
  const { error: upErr } = await supabase.storage.from(FACTORY_FILE_BUCKET).upload(path, file);
  if (upErr) return { error: upErr, step: "upload" };
  const { data, error } = await supabase.rpc("factory_job_add_file", {
    p_job_id: jobId, p_category: category, p_title: title || file.name, p_bucket: FACTORY_FILE_BUCKET, p_path: path,
    p_file_name: file.name, p_mime_type: file.type || null, p_file_size: file.size, p_note: note || null,
  });
  if (error) {
    supabase.storage.from(FACTORY_FILE_BUCKET).remove([path]).catch(() => {});
    return { error, step: "record" };
  }
  return { data, error: null };
}

export async function getFileUrl(bucket, path) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
  return { url: data?.signedUrl || null, error };
}

// One debounced subscription on the Job Card table (RLS applies to Realtime,
// so a user only ever gets events for cards they may see).
export function subscribeJobs(name, onChange) {
  let timer = null;
  const fire = () => { window.clearTimeout(timer); timer = window.setTimeout(onChange, 250); };
  const unsub = subscribeTable(name, "inhouse_production_requests", null, fire);
  return () => { window.clearTimeout(timer); unsub(); };
}

export function subscribeJobDetail(jobId, onChange) {
  let timer = null;
  const fire = () => { window.clearTimeout(timer); timer = window.setTimeout(onChange, 250); };
  const unsubs = [
    subscribeTable(`fx-job-${jobId}-row`, "inhouse_production_requests", `id=eq.${jobId}`, fire),
    subscribeTable(`fx-job-${jobId}-items`, "factory_job_items", `job_id=eq.${jobId}`, fire),
    subscribeTable(`fx-job-${jobId}-events`, "factory_job_events", `job_id=eq.${jobId}`, fire),
    subscribeTable(`fx-job-${jobId}-files`, "factory_drawings", `job_id=eq.${jobId}`, fire),
    subscribeTable(`fx-job-${jobId}-stages`, "production_stage_updates", `job_id=eq.${jobId}`, fire),
  ];
  return () => { window.clearTimeout(timer); unsubs.forEach((u) => u()); };
}

// ---------------------------------------------------------------------------
// Factory Task Management. Tasks live in the existing staff_tasks engine;
// every write is an RPC (server validates role + status transition), and
// reads go through RPCs that reuse the ONE task-visibility rule.
// ---------------------------------------------------------------------------

export async function listFactoryTasks({ tab = "open", search = "" } = {}) {
  const { data, error } = await supabase.rpc("factory_tasks_list", { p_tab: tab, p_search: safeSearch(search) || null, p_limit: 300 });
  return { data: Array.isArray(data) ? data : [], error };
}

export async function createFactoryTask(payload) {
  const { data, error } = await supabase.rpc("factory_create_task", { p: payload });
  return { data: Array.isArray(data) ? data[0] : data, error };
}

export const cancelFactoryTask = (taskId, reason) => supabase.rpc("factory_cancel_task", { p_task: taskId, p_reason: reason });
export const reassignFactoryTask = (taskId, primary, second, reason) =>
  supabase.rpc("factory_reassign_task", { p_task: taskId, p_primary: primary, p_second: second || null, p_reason: reason || null });

// Task actions reuse the existing, already-validated task RPCs.
export const taskAccept = (id) => supabase.rpc("staff_accept_task", { p_task_id: id });
export const taskStart = (id) => supabase.rpc("staff_start_task", { p_task_id: id });
export const taskReject = (id, reason) => supabase.rpc("staff_return_task", { p_task_id: id, p_reason: reason });
export const taskBlock = (id, note) => supabase.rpc("staff_set_task_blocked", { p_task_id: id, p_blocked: true, p_note: note });
export const taskUnblock = (id) => supabase.rpc("staff_set_task_blocked", { p_task_id: id, p_blocked: false, p_note: null });
export const taskReady = (id) => supabase.rpc("staff_complete_task", { p_task_id: id });
export const taskApprove = (id) => supabase.rpc("staff_verify_task", { p_task_id: id });

export async function searchJobCards(q, includeClosed = false) {
  const { data, error } = await supabase.rpc("factory_search_job_cards", { p_q: safeSearch(q) || null, p_include_closed: includeClosed, p_limit: 20 });
  return { data: data || [], error };
}

export async function listProductionStages() {
  const { data, error } = await supabase.from("factory_production_stages").select("code,name_en,name_gu,sort_order").eq("is_active", true).order("sort_order");
  return { data: data || [], error };
}

// [{ job_id, progress: {total, done, review, in_progress, blocked, pending, overdue, qty_total, qty_done, next_due} }]
export async function getJobProgress(jobIds) {
  if (!jobIds?.length) return { data: {}, error: null };
  const { data, error } = await supabase.rpc("factory_job_progress_many", { p_jobs: jobIds });
  return { data: Object.fromEntries((data || []).map((r) => [r.job_id, r.progress])), error };
}

export async function getWorkOverview(filters) {
  const { data, error } = await supabase.rpc("factory_work_overview", { p_filters: filters || {} });
  return { data, error };
}

export async function listFactoryStaff(factoryDeptId) {
  const { data, error } = await supabase.rpc("staff_list_assignable_users", { p_department_id: factoryDeptId });
  return { data: data || [], error };
}

// Tasks of one Job Card (RLS-scoped: a leader sees all, an assignee only their own).
export async function listJobTasks(jobId) {
  const { data, error } = await supabase.rpc("factory_tasks_list", { p_tab: "jobcard", p_search: null, p_limit: 500 });
  return { data: (Array.isArray(data) ? data : []).filter((t) => t.job_card_id === jobId), error };
}

// ONE debounced subscription pair for task pages: staff_tasks + assignees
// (RLS applies to Realtime, so a user only receives events for tasks they may see).
export function subscribeFactoryTasks(name, onChange) {
  let timer = null;
  const fire = () => { window.clearTimeout(timer); timer = window.setTimeout(onChange, 300); };
  const unsubs = [
    subscribeTable(`${name}-tasks`, "staff_tasks", null, fire),
    subscribeTable(`${name}-assignees`, "staff_task_assignees", null, fire),
    subscribeTable(`${name}-jobs`, "inhouse_production_requests", null, fire),
  ];
  return () => { window.clearTimeout(timer); unsubs.forEach((u) => u()); };
}

// ---------------------------------------------------------------------------
// Production Divisions (Sofa / Modular / Metal Fabrication) + division-scoped
// stage templates + Material-to-Order. Backend: mvp_pilot_factory_divisions_material_v2_82b.sql.
// Reads go through plain RLS-scoped selects (reference tables), writes through
// SECURITY DEFINER RPCs that re-validate role server-side — same convention
// as every other data-layer function in this file.
// ---------------------------------------------------------------------------

export async function listDivisions() {
  const { data, error } = await supabase.from("production_divisions").select("*").eq("is_active", true).order("sort_order");
  return { data: data || [], error };
}

export async function getDivisionDashboardCounts(locationId) {
  const { data, error } = await supabase.rpc("factory_division_dashboard_counts", { p_location: locationId || null });
  return { data: data || [], error };
}

// Material Pending / Blocked / Ready for Dispatch -- a separate, additive RPC from factory_dashboard_counts()
// (see mvp_pilot_factory_dashboard_extra_counts_v2_82d.sql for why it isn't just widened in place).
export async function getDashboardExtraCounts(locationId) {
  const { data, error } = await supabase.rpc("factory_dashboard_extra_counts", { p_location: locationId || null });
  return { data: Array.isArray(data) ? data[0] : data, error };
}

export async function setJobDivision(jobId, divisionId) {
  return supabase.rpc("factory_set_job_division", { p_job_id: jobId, p_division_id: divisionId });
}

export async function listStageTemplates(divisionId) {
  if (!divisionId) return { data: [], error: null };
  const { data, error } = await supabase.rpc("factory_list_stage_templates", { p_division_id: divisionId });
  return { data: data || [], error };
}

// tab: open (REQUESTED/ORDERED/PARTIALLY_RECEIVED) | all
export async function listMaterialRequests({ tab = "open", jobCardId, search } = {}) {
  let q = supabase.from("factory_material_requests").select(
    "*, requesting_department:departments(name_en,name_gu), job_card:inhouse_production_requests(job_order_number,product_item)"
  ).eq("is_active", true);
  if (tab === "open") q = q.in("status", ["REQUESTED", "ORDERED", "PARTIALLY_RECEIVED"]);
  if (jobCardId) q = q.eq("job_card_id", jobCardId);
  const s = safeSearch(search);
  if (s) q = q.or(`material.ilike.%${s}%,request_number.ilike.%${s}%,order_po_reference.ilike.%${s}%`);
  return q.order("created_at", { ascending: false }).limit(200);
}

// ---------------------------------------------------------------------------
// Production-stage workflow (mvp_pilot_factory_stage_workflow_v2_83.sql) --
// Start/Complete buttons per division-configured stage, with a server-side
// mandatory-photo gate and automatic completion-percentage recalculation.
// ---------------------------------------------------------------------------

export async function listJobStages(jobId) {
  if (!jobId) return { data: [], error: null };
  const { data, error } = await supabase.rpc("factory_list_job_stages", { p_job_id: jobId });
  return { data: data || [], error };
}

export async function startStage(jobId, stageCode, note) {
  return supabase.rpc("factory_start_stage", { p_job_id: jobId, p_stage_code: stageCode, p_note: note || null });
}

export async function completeStage(jobId, stageCode, note) {
  return supabase.rpc("factory_complete_stage", { p_job_id: jobId, p_stage_code: stageCode, p_note: note || null });
}

export async function getQcPendingCount(locationId) {
  const { data, error } = await supabase.rpc("factory_qc_pending_count", { p_location: locationId || null });
  return { data: data ?? null, error };
}

export async function createMaterialRequest(fields) {
  return supabase.rpc("factory_create_material_request", {
    p_material: fields.material, p_requesting_department_id: fields.requestingDepartmentId, p_quantity: fields.quantity,
    p_unit: fields.unit || "Nos", p_order_po_reference: fields.orderPoReference || null, p_priority: fields.priority || "Normal",
    p_required_date: fields.requiredDate || null, p_job_card_id: fields.jobCardId || null, p_supplier: fields.supplier || null,
    p_notes: fields.notes || null,
  });
}

export async function updateMaterialRequestStatus(id, status, notes) {
  return supabase.rpc("factory_update_material_request_status", { p_id: id, p_status: status, p_notes: notes || null });
}

export function subscribeMaterialRequests(name, onChange) {
  let timer = null;
  const fire = () => { window.clearTimeout(timer); timer = window.setTimeout(onChange, 250); };
  const unsub = subscribeTable(name, "factory_material_requests", null, fire);
  return () => { window.clearTimeout(timer); unsub(); };
}

export async function getMaterialRequest(id) {
  if (!id) return { data: null, error: null };
  return supabase.from("factory_material_requests").select(
    "*, requesting_department:departments(name_en,name_gu), job_card:inhouse_production_requests(job_order_number,product_item)"
  ).eq("id", id).maybeSingle();
}

// Note: Job Card CREATION is photo-first via factoryAiSubmit (lib/interiorApi.js) -- the old typed-form
// factory_create_segment_job RPC is unused (left in the DB, harmless; DROP is gated behind a confirmation this
// session's tooling can't satisfy). The pieces below ARE used, for the Job Card's own PO/Party/Delivery/
// Priority/Material sections: each stores its few fields in segment_specs (merge, never clobbers other
// sections) and carries one mandatory field-level photo via FieldPhotoProof.jsx.

export async function updateSegmentSpecs(jobId, specs) {
  return supabase.rpc("factory_update_segment_specs", { p_job_id: jobId, p_specs: specs || {} });
}

// Field-level photo proof: list the real, active photos already recorded against a record's given section (e.g.
// "po_photo", "party_photo", "delivery_photo", "priority_photo", "bom_photo", "costing_photo") -- not just a
// count, the actual rows, so a thumbnail + who/when can be shown right beside the field it proves. entityType
// defaults to the Job Card field type; the Material-to-Order per-field redesign passes "factory_material_request_field".
export async function listFieldPhotos(entityId, sectionKey, entityType = "factory_job_card_field") {
  if (!entityId) return { data: [], error: null };
  let q = supabase.from("staff_attachments").select("id, created_at, uploaded_by, original_filename, uploader:user_profiles!uploaded_by(full_name)")
    .eq("entity_type", entityType).eq("entity_id", entityId).eq("purpose", "proof").eq("is_active", true);
  if (sectionKey) q = q.eq("section_key", sectionKey);
  return q.order("created_at", { ascending: false });
}

export async function tagAttachmentSection(attachmentId, sectionKey) {
  return supabase.rpc("staff_set_attachment_section", { p_attachment_id: attachmentId, p_section_key: sectionKey });
}

// Material-to-Order per-field redesign: Material / Requesting Department / Order-PO / Party Name / Person Name /
// Priority each save through this one patch RPC (mirrors factory_job_update_details's merge-by-key pattern).
export async function updateMaterialRequestFields(id, patch) {
  return supabase.rpc("factory_update_material_request_fields", { p_id: id, p_patch: patch || {} });
}

// ---------------------------------------------------------------------------
// Assign Task -> Factory Segment + Job Card routing (mvp_pilot_assign_task_factory_segment_v2_89.sql).
// ---------------------------------------------------------------------------

// Active Job Cards in one Factory segment only, richer than the generic searchJobCards() (division/priority/
// photo-count) so a picker list can show enough to tell two candidates apart.
export async function searchJobCardsByDivision(divisionCode, q, limit = 20) {
  if (!divisionCode) return { data: [], error: null };
  const { data, error } = await supabase.rpc("factory_search_job_cards_by_division", {
    p_division_code: divisionCode, p_q: q || null, p_limit: limit,
  });
  return { data: data || [], error };
}

// Who an EXTERNAL department (not Factory itself) may assign a Factory task to: Head + Supervisors only.
export async function listSegmentLeadership() {
  const { data, error } = await supabase.rpc("factory_list_segment_leadership");
  return { data: data || [], error };
}

// Called right after staff_create_task() whenever To Department resolved to Factory -- attaches and
// server-side re-validates the Factory Segment / Job Card / link type, and sends the routing notifications.
export async function setTaskFactoryContext(taskId, factorySegmentCode, jobCardId, taskLinkType) {
  return supabase.rpc("staff_set_task_factory_context", {
    p_task_id: taskId, p_factory_segment_code: factorySegmentCode,
    p_job_card_id: jobCardId || null, p_task_link_type: taskLinkType || "general",
  });
}
