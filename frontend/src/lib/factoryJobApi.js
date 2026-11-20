import { supabase } from "./supabase";

// Factory Job Cards (mvp_pilot_factory_job_cards_v3_15.sql). Every change goes through an fjc_* database function, which
// checks who is calling and the card's current status; the tables are read-only to the app and RLS (fjc_can_view) decides
// what each person sees. Files: procurement-orders/factory-jobs/<job id>/...

export * from "./factoryJobRules";

const BUCKET = "procurement-orders";

export const listJobCards = ({ limit = 1000 } = {}) => supabase.from("factory_job_cards")
  .select("*, factory_job_card_items(product_name, quantity, unit, qty_completed), departments:requesting_department_id(name_en, name_gu, code)")
  .order("created_at", { ascending: false }).limit(limit);

export const getJobCard = (id) => supabase.from("factory_job_cards")
  .select("*, departments:requesting_department_id(name_en, name_gu, code)").eq("id", id).maybeSingle();
export const listItems = (id) => supabase.from("factory_job_card_items").select("*").eq("job_card_id", id).order("line_no");
export const listFiles = (id) => supabase.from("factory_job_card_files").select("*").eq("job_card_id", id).order("uploaded_at");
export const listEvents = (id) => supabase.from("factory_job_card_events").select("*").eq("job_card_id", id).order("created_at");
export const listQc = (id) => supabase.from("factory_job_card_qc").select("*").eq("job_card_id", id).order("created_at");
export const listDispatches = (id) => supabase.from("factory_job_card_dispatches").select("*").eq("job_card_id", id).order("created_at");
export const listMaterialOrders = (id) => supabase.from("purchase_requests")
  .select("id, request_number, proc_status, required_by_date, created_at").eq("factory_job_card_id", id).order("created_at");
export const getFactoryTask = (id) => supabase.from("staff_tasks").select("id, task_number").eq("factory_job_card_id", id).maybeSingle();
export const factoryTeam = () => supabase.rpc("fjc_factory_team");
export const amFactoryLead = () => supabase.rpc("fjc_is_lead");
export const amFactoryMember = () => supabase.rpc("fjc_is_member");

// Names of the people on a card (requester, assignee, QC, ...). user_profiles is readable to staff.
export async function peopleNames(ids) {
  const u = [...new Set(ids.filter(Boolean))];
  if (!u.length) return {};
  const { data } = await supabase.from("user_profiles").select("id, full_name").in("id", u);
  return Object.fromEntries((data || []).map((p) => [p.id, p.full_name]));
}

const clean = (v) => (typeof v === "string" ? v.trim() : v);
export function createJobCard(header, items, key) {
  const h = Object.fromEntries(Object.entries(header).map(([k, v]) => [k, clean(v)]));
  const it = items.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, clean(v)])));
  return supabase.rpc("fjc_create", { p_header: h, p_items: it, p_idempotency_key: key }).single();
}

export const jobAction = (id, action, payload = {}) => supabase.rpc("fjc_action", { p_job_id: id, p_action: action, p_payload: payload }).single();

export const requestMaterial = (id, items, requiredDate, remarks) =>
  supabase.rpc("fjc_request_material", { p_job_id: id, p_items: items, p_required_date: requiredDate, p_remarks: remarks || null }).single();

export async function uploadJobFile(jobId, file, kind, description) {
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
  const path = `factory-jobs/${jobId}/${crypto.randomUUID()}-${safe}`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined });
  if (upErr) return { error: upErr };
  return supabase.rpc("fjc_add_file", {
    p_job_id: jobId, p_storage_path: path, p_file_name: file.name, p_file_type: file.type || null, p_kind: kind || "REFERENCE", p_description: description || null,
  });
}
