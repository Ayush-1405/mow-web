// Single choke point for every read/write the staff pilot makes against
// the SEPARATE, already-live Interior Projects system (projects/tasks/
// site_reports/snags/materials/project_materials/project_changes/
// handovers/customer_feedback/attachments/activity_logs — real customer
// data, e.g. project MOW-101). That system's own RLS is currently wide
// open to any authenticated Supabase user (shared auth with this pilot) —
// this file is what keeps every write from here narrow and traceable:
//
//   - every mutation updates ONE named field by id (never a blanket
//     spread-update, never a non-PK .match()), because another system
//     also reads/writes this same data — updateProjectField() also
//     touches the doc's own "computed on save" last_update column
//     alongside the one field it was asked to change, which is the one
//     deliberate exception to "one field";
//   - every mutation also logs a row to interior_pilot_audit_log (a
//     pilot-owned table — the external system has no audit trail of its
//     own), so at least everything done through THIS app's UI is
//     traceable.
//
// interior_payment_records is the one pilot-owned table in this file
// (that external system has no payment ledger at all) — its writes are
// plain, ordinary Supabase calls under the pilot's own RLS, included here
// only so every Interior screen has one single API surface to import.
import { supabase } from "./supabase";

async function logAudit(tableName, recordId, action, detail) {
  // Best-effort: a failed audit insert must never block the real action it
  // describes (the action above has already succeeded by the time this
  // runs) — errors are swallowed deliberately, not surfaced to the user.
  try {
    await supabase.from("interior_pilot_audit_log").insert({ table_name: tableName, record_id: recordId, action, detail: detail || null });
  } catch {
    // intentional no-op — see comment above
  }
}

// Resolves (or provisions) the calling staff-pilot user's row in the
// external system's own `profiles` table — see interior_ensure_profile()/
// interior_get_my_profile() in mvp_pilot_interior_head_dashboard_v2_2f.sql.
// Used only by InteriorProfileGate.jsx; every other screen reads the
// already-resolved profile via useInteriorProfile() instead of calling
// these directly.
export async function getMyInteriorProfile() {
  return supabase.rpc("interior_get_my_profile").maybeSingle();
}

export async function ensureInteriorProfile(functionalRole) {
  return supabase.rpc("interior_ensure_profile", { p_functional_role: functionalRole || null }).single();
}

// Team roster for "Assign To" pickers (snags, tasks) — the external
// system's own `profiles` table, not user_profiles. active=true only.
export async function listInteriorPeople() {
  return supabase.from("profiles").select("id, name, role").eq("active", true).order("name");
}

// Notifies an Interior assignee. profiles.id (used for assigned_to on
// snags/tasks) is NOT auth.uid() — resolve profiles.auth_id first (the
// actual Supabase auth identity, set by interior_ensure_profile()) and use
// THAT as the recipient for staff_notify_assignment, which expects a
// user_profiles.id/auth.uid()-shaped id. No-ops if the assignee has no
// auth_id yet (never provisioned a staff-pilot login) — same fire-and-
// forget shape as the Retail notifier, never blocks the save it follows.
export async function notifyInteriorAssignment(assigneeProfileId, entityType, entityId, titleEn, titleGu) {
  if (!assigneeProfileId) return;
  try {
    const { data } = await supabase.from("profiles").select("auth_id").eq("id", assigneeProfileId).maybeSingle();
    if (!data?.auth_id) return;
    await supabase.rpc("staff_notify_assignment", {
      p_recipient_id: data.auth_id, p_entity_type: entityType, p_entity_id: entityId, p_title_en: titleEn, p_title_gu: titleGu,
    });
  } catch {
    // intentional no-op — see comment above
  }
}

export async function listProjects() {
  return supabase.from("projects").select("*").eq("archived", false).order("created_at", { ascending: false });
}

// project_members — the "extra team, beyond PM/designer/execution" list
// for a project. No FK to profiles in the schema (only to projects), so
// callers join against listInteriorPeople()'s roster client-side rather
// than embedding — an embed here would 400 (PostgREST has no relationship
// to walk).
export async function listProjectMembers(projectId) {
  return supabase.from("project_members").select("id, profile_id, assigned_at").eq("project_id", projectId);
}

export async function addProjectMember(projectId, profileId) {
  const { data, error } = await supabase.from("project_members").insert({ project_id: projectId, profile_id: profileId }).select().single();
  if (!error) await logAudit("project_members", data.id, "add_member", { profile_id: profileId });
  return { data, error };
}

export async function removeProjectMember(projectId, profileId) {
  const { error } = await supabase.from("project_members").delete().eq("project_id", projectId).eq("profile_id", profileId);
  if (!error) await logAudit("project_members", projectId, "remove_member", { profile_id: profileId });
  return { error };
}

// Everyone with "full access" to a project: PM (owner), designer,
// execution, plus anyone added to project_members. This is the set a
// project owner can delegate tasks to, and the set InteriorTimeline shows
// as the project's team.
export async function listProjectTeamIds(project) {
  const ids = new Set([project.project_manager_id, project.designer_id, project.execution_id].filter(Boolean));
  const { data } = await listProjectMembers(project.id);
  (data || []).forEach((m) => ids.add(m.profile_id));
  return Array.from(ids);
}

// last_update is the doc's own "computed on save" field — every project
// edit through this app touches it to today automatically (never typed by
// hand), so it actually means something instead of staying permanently
// blank because nothing ever set it.
export async function updateProjectField(id, field, value) {
  const patch = { [field]: value };
  if (field !== "last_update") patch.last_update = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.from("projects").update(patch).eq("id", id).select().single();
  if (!error) await logAudit("projects", id, `update_${field}`, { value });
  return { data, error };
}

// Project Details save — the handful of plain fields a PM/Head fills in
// together (location, start date, next customer-update date, on-time
// call, next action, remarks). Still an explicit named-field list, never
// a blind spread of a form object, so a stray extra key on the client
// object can never leak into an unintended column. last_update is touched
// the same way updateProjectField() does.
export async function updateProjectDetails(id, { location, start_date, next_update, on_time, next_action, remarks }) {
  const patch = { location, start_date, next_update, on_time, next_action, remarks, last_update: new Date().toISOString().slice(0, 10) };
  const { data, error } = await supabase.from("projects").update(patch).eq("id", id).select().single();
  if (!error) await logAudit("projects", id, "update_details", null);
  return { data, error };
}

export async function listAttachments(projectId, stage) {
  let q = supabase.from("attachments").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
  if (stage) q = q.eq("stage", stage);
  return q;
}

export async function addAttachmentRecord({ projectId, stage, title, fileName, note, storagePath, fileType, fileSize, uploadedBy }) {
  const { data, error } = await supabase.from("attachments").insert({
    project_id: projectId, stage, title, file_name: fileName, note: note || null,
    storage_path: storagePath || null, file_type: fileType || null, file_size: fileSize || null,
    uploaded_by: uploadedBy || null,
  }).select().single();
  if (!error) await logAudit("attachments", data.id, "create", { stage, title });
  return { data, error };
}

// Uploads the actual file into the interior-attachments Storage bucket
// (mvp_pilot_interior_head_dashboard_v2_2f.sql), then records it. If the
// upload fails, no attachment row is created — never a metadata record
// pointing at a file that was never actually saved.
export async function uploadAttachmentFile({ projectId, stage, file, title, note, uploadedBy }) {
  const path = `${projectId}/${stage}/${Date.now()}-${file.name}`;
  const { error: uploadError } = await supabase.storage.from("interior-attachments").upload(path, file);
  if (uploadError) return { data: null, error: uploadError };
  return addAttachmentRecord({
    projectId, stage, title: title || file.name, fileName: file.name, note,
    storagePath: path, fileType: file.type, fileSize: file.size, uploadedBy,
  });
}

export async function getAttachmentUrl(storagePath) {
  const { data, error } = await supabase.storage.from("interior-attachments").createSignedUrl(storagePath, 3600);
  return { url: data?.signedUrl || null, error };
}

export async function lockDesignAttachment(id) {
  const { data, error } = await supabase.from("attachments").update({ frozen: true }).eq("id", id).select().single();
  if (!error) await logAudit("attachments", id, "lock_design", null);
  return { data, error };
}

export async function listProjectChanges(projectId) {
  return supabase.from("project_changes").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
}

export async function decideProjectChange(id, decision, decidedBy) {
  const { data, error } = await supabase.from("project_changes").update({
    approval_status: decision, status: decision,
    approved_date: decision === "APPROVED" ? new Date().toISOString().slice(0, 10) : null,
    approved_by: decision === "APPROVED" ? decidedBy || null : null,
  }).eq("id", id).select().single();
  if (!error) await logAudit("project_changes", id, `decide_${decision}`, null);
  return { data, error };
}

export async function requestProjectChange({ projectId, requestedBy, description, additionalCost, timelineImpact, materialImpact }) {
  const { data, error } = await supabase.from("project_changes").insert({
    project_id: projectId, requested_by: requestedBy, requested_date: new Date().toISOString().slice(0, 10),
    description, additional_cost: additionalCost || 0, timeline_impact: timelineImpact || null, material_impact: materialImpact || null,
  }).select().single();
  if (!error) await logAudit("project_changes", data.id, "create", { description });
  return { data, error };
}

export async function listSnags(projectId) {
  return supabase.from("snags").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
}

export async function createSnag({ projectId, issue, major, dueDate, assignedTo }) {
  const { data, error } = await supabase.from("snags").insert({
    project_id: projectId, issue, major: !!major, due_date: dueDate || null, assigned_to: assignedTo || null,
  }).select().single();
  if (!error) await logAudit("snags", data.id, "create", { issue });
  return { data, error };
}

export async function hasOpenMajorSnag(projectId) {
  const { count, error } = await supabase.from("snags").select("id", { count: "exact", head: true })
    .eq("project_id", projectId).eq("major", true).neq("status", "COMPLETED");
  return { hasOpen: (count || 0) > 0, error };
}

// snags.status has a DB check constraint allowing only OPEN / IN PROGRESS /
// COMPLETED (this external table has no "RESOLVED" value — writing that
// string violates the constraint and PostgREST surfaces it as a 400).
export async function resolveSnag(id) {
  const { data, error } = await supabase.from("snags").update({ status: "COMPLETED" }).eq("id", id).select().single();
  if (!error) await logAudit("snags", id, "resolve", null);
  return { data, error };
}

export async function listSiteReports(projectId) {
  return supabase.from("site_reports").select("*").eq("project_id", projectId).order("report_date", { ascending: false });
}

export async function createSiteReport(payload) {
  const { data, error } = await supabase.from("site_reports").insert(payload).select().single();
  if (!error) await logAudit("site_reports", data.id, "create", { report_date: payload.report_date });
  return { data, error };
}

export async function listMaterials(projectId) {
  return supabase.from("materials").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
}

export async function listProjectMaterials(projectId, source) {
  let q = supabase.from("project_materials").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
  if (source) q = q.eq("source", source);
  return q;
}

export async function updateMaterialStatus(table, id, status) {
  const { data, error } = await supabase.from(table).update({ status }).eq("id", id).select().single();
  if (!error) await logAudit(table, id, "update_status", { status });
  return { data, error };
}

export async function updateMaterialField(table, id, field, value) {
  const { data, error } = await supabase.from(table).update({ [field]: value }).eq("id", id).select().single();
  if (!error) await logAudit(table, id, `update_${field}`, { value });
  return { data, error };
}

export async function listActivity(projectId) {
  return supabase.from("activity_logs").select("*").eq("project_id", projectId).order("created_at", { ascending: false }).limit(100);
}

export async function logActivity(projectId, action, description, userId) {
  const { data, error } = await supabase.from("activity_logs").insert({ project_id: projectId, action, description, user_id: userId || null }).select().single();
  if (!error) await logAudit("activity_logs", data.id, "create", { action });
  return { data, error };
}

export async function listTasks(projectId) {
  return supabase.from("tasks").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
}

export async function listMyOpenTasks(profileId) {
  return supabase.from("tasks").select("*, projects(project_code, customer)").eq("assigned_to", profileId).neq("status", "COMPLETED").order("due_date", { ascending: true });
}

export async function createTask({ projectId, title, assignedTo, dueDate, note, createdBy }) {
  const { data, error } = await supabase.from("tasks").insert({
    project_id: projectId, title, assigned_to: assignedTo || null, due_date: dueDate || null, note: note || null, created_by: createdBy || null,
  }).select().single();
  if (!error) await logAudit("tasks", data.id, "create", { title });
  return { data, error };
}

// status must be one of tasks_status_check's values: OPEN / IN PROGRESS /
// COMPLETED / BLOCKED / CANCELLED (this external table has no "DONE").
export async function updateTaskStatus(id, status) {
  const { data, error } = await supabase.from("tasks").update({ status }).eq("id", id).select().single();
  if (!error) await logAudit("tasks", id, "update_status", { status });
  return { data, error };
}

export async function listRequests(projectId) {
  return supabase.from("project_requests").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
}

export async function createRequest({ projectId, requestType, description, createdBy }) {
  const { data, error } = await supabase.from("project_requests").insert({
    project_id: projectId, request_type: requestType, description, created_by: createdBy || null,
  }).select().single();
  if (!error) await logAudit("project_requests", data.id, "create", { requestType });
  return { data, error };
}

export async function updateRequestStatus(id, status) {
  const { data, error } = await supabase.from("project_requests").update({ status }).eq("id", id).select().single();
  if (!error) await logAudit("project_requests", id, "update_status", { status });
  return { data, error };
}

export async function getHandover(projectId) {
  return supabase.from("handovers").select("*").eq("project_id", projectId).maybeSingle();
}

export async function setHandoverFlag(projectId, field, value, updatedBy) {
  const { data: existing } = await supabase.from("handovers").select("id").eq("project_id", projectId).maybeSingle();
  let result;
  if (existing) {
    result = await supabase.from("handovers").update({ [field]: value, updated_by: updatedBy || null }).eq("id", existing.id).select().single();
  } else {
    result = await supabase.from("handovers").insert({ project_id: projectId, [field]: value, updated_by: updatedBy || null }).select().single();
  }
  if (!result.error) await logAudit("handovers", result.data.id, `set_${field}`, { value });
  return result;
}

// Design Freeze — the 4-point checklist + the actual gate. Setting a check
// never freezes on its own; freezeProject() re-verifies server-side via
// interior_can_freeze_project() before writing frozen=true, so the UI
// check state can never be raced past.
export async function setFreezeCheck(projectId, field, value) {
  return updateProjectField(projectId, field, value);
}

export async function canFreezeProject(projectId) {
  return supabase.rpc("interior_can_freeze_project", { p_project_id: projectId });
}

export async function freezeProject(projectId) {
  const { data: can, error: checkErr } = await canFreezeProject(projectId);
  if (checkErr) return { data: null, error: checkErr };
  if (!can) return { data: null, error: { message: "All 4 design freeze checks must be complete first." } };
  return updateProjectField(projectId, "frozen", true).then(async (res) => {
    if (!res.error) await updateProjectField(projectId, "freeze_date", new Date().toISOString().slice(0, 10));
    return res;
  });
}

// Project closure gate — "no open major snag → no project closure" and
// "pending change request → no stage advance", enforced here before the
// stage is ever set to Completed, not just suggested in the UI.
export async function canCloseProject(projectId) {
  const [{ hasOpen }, changesRes] = await Promise.all([
    hasOpenMajorSnag(projectId),
    supabase.from("project_changes").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("approval_status", "PENDING"),
  ]);
  const pendingChanges = (changesRes.count || 0) > 0;
  return { canClose: !hasOpen && !pendingChanges, hasOpenMajorSnag: hasOpen, pendingChanges };
}

export async function submitFeedback(payload) {
  const { data, error } = await supabase.from("customer_feedback").insert(payload).select().single();
  if (!error) await logAudit("customer_feedback", data.id, "create", null);
  return { data, error };
}

export async function listPaymentRecords(projectId) {
  return supabase.from("interior_payment_records").select("*").eq("project_id", projectId).eq("is_active", true).order("created_at", { ascending: false });
}

export async function addPaymentRecord(payload) {
  return supabase.from("interior_payment_records").insert(payload).select().single();
}

export async function markPaymentReceived(id) {
  return supabase.from("interior_payment_records").update({
    status: "RECEIVED", received_date: new Date().toISOString().slice(0, 10),
  }).eq("id", id).select().single();
}
