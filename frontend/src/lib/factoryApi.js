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
export async function listJobCards({ tab = "all", search, sourceDept, status, location, assignee, dueFrom, dueTo, priority, delayed, profileId, from = 0, to = 29 } = {}) {
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
  if (sourceDept) q = q.eq("source_department_id", sourceDept);
  if (location) q = q.eq("factory_location_id", location);
  if (assignee) q = q.or(`assigned_factory_coordinator.eq.${assignee},second_assignee_coordinator.eq.${assignee}`);
  if (dueFrom) q = q.gte("required_date", dueFrom);
  if (dueTo) q = q.lte("required_date", dueTo);
  if (priority) q = q.eq("priority", priority);
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
export async function updateStage(id, stage, status, { quantity, notes, delayReason } = {}) {
  return supabase.rpc("factory_update_stage", {
    p_job_id: id, p_stage: stage, p_status: status, p_assigned_to: null, p_quantity_completed: quantity ?? null,
    p_quantity_pending: null, p_notes: notes || null, p_delay_reason: delayReason || null,
    p_planned_start: null, p_planned_end: null, p_stage_data: null,
  });
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
