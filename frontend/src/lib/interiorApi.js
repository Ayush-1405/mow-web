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

async function logAudit(tableName, recordId, action, detail, projectId) {
  // Best-effort: a failed audit insert must never block the real action it
  // describes (the action above has already succeeded by the time this
  // runs) — errors are swallowed deliberately, not surfaced to the user.
  // projectId is what lets the Activity History tab filter by
  // .eq('project_id', currentProjectId) instead of resolving it at read
  // time — every call site either already has it in scope, or reads it
  // off the just-written row's own project_id column (never a fresh query).
  try {
    await supabase.from("interior_pilot_audit_log").insert({
      table_name: tableName, record_id: recordId, action, detail: detail || null, project_id: projectId || null,
    });
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

// Notifies every Management user plus the given department's Department
// Head — e.g. so submitting a Daily Update reaches Interior leadership
// without the submitter (often a plain PM/Designer/Execution person)
// needing read access to anyone else's user_profiles row. Fire-and-forget,
// same as notifyInteriorAssignment — a failed notification must never
// block the save it follows.
export async function notifyDeptLeadership(departmentCode, entityType, entityId, titleEn, titleGu) {
  try {
    await supabase.rpc("staff_notify_dept_leadership", {
      p_department_code: departmentCode, p_entity_type: entityType, p_entity_id: entityId, p_title_en: titleEn, p_title_gu: titleGu,
    });
  } catch {
    // intentional no-op — see comment above
  }
}

// Project-scoped activity trail (Activity History tab) — the pilot's own
// interior_pilot_audit_log, which logAudit() above already writes to on
// nearly every mutation. unassignedOnly surfaces old rows whose project_id
// couldn't be backfilled (see mvp_pilot_interior_audit_project_id_v2_2v.sql)
// so Management/Dept Head can review them, rather than them being silently
// invisible everywhere.
export async function listProjectActivity(projectId) {
  return supabase.from("interior_pilot_audit_log").select("*").eq("project_id", projectId).order("performed_at", { ascending: false }).limit(200);
}

export async function listUnassignedActivity() {
  return supabase.from("interior_pilot_audit_log").select("*").is("project_id", null).order("performed_at", { ascending: false }).limit(200);
}

export async function assignActivityToProject(auditLogId, projectId) {
  return supabase.from("interior_pilot_audit_log").update({ project_id: projectId }).eq("id", auditLogId).select().single();
}

export async function listProjects() {
  return supabase.from("projects").select("*").eq("archived", false).order("created_at", { ascending: false });
}

// Server-side gated: staff_delete_interior_project (SECURITY DEFINER)
// re-checks Management/Super Admin/Interior Dept Head on its own — this
// isn't just a UI-hidden button, a direct RPC call from anyone else is
// rejected by the function itself. Soft-delete (archived = true), same
// convention every project list query already filters on.
export async function deleteProject(projectId) {
  return supabase.rpc("staff_delete_interior_project", { p_project_id: projectId });
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
  if (!error) await logAudit("project_members", data.id, "add_member", { profile_id: profileId }, projectId);
  return { data, error };
}

export async function removeProjectMember(projectId, profileId) {
  const { error } = await supabase.from("project_members").delete().eq("project_id", projectId).eq("profile_id", profileId);
  if (!error) await logAudit("project_members", projectId, "remove_member", { profile_id: profileId }, projectId);
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
  if (!error) await logAudit("projects", id, `update_${field}`, { value }, id);
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
  if (!error) await logAudit("projects", id, "update_details", null, id);
  return { data, error };
}

export async function listAttachments(projectId, stage) {
  let q = supabase.from("attachments").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
  if (stage) q = q.eq("stage", stage);
  return q;
}

export async function addAttachmentRecord({ projectId, stage, title, fileName, note, storagePath, fileType, fileSize, uploadedBy, fileCategory, customCategory }) {
  const { data, error } = await supabase.from("attachments").insert({
    project_id: projectId, stage, title, file_name: fileName, note: note || null,
    storage_path: storagePath || null, file_type: fileType || null, file_size: fileSize || null,
    uploaded_by: uploadedBy || null, file_category: fileCategory || null, custom_category: customCategory || null,
  }).select().single();
  if (!error) await logAudit("attachments", data.id, "create", { stage, title, file_category: fileCategory }, projectId);
  return { data, error };
}

// Uploads the actual file into the interior-attachments Storage bucket
// (mvp_pilot_interior_head_dashboard_v2_2f.sql), then records it. If the
// upload fails, no attachment row is created — never a metadata record
// pointing at a file that was never actually saved.
export async function uploadAttachmentFile({ projectId, stage, file, title, note, uploadedBy }) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-140);
  const path = `projects/${projectId}/${stage}/${crypto.randomUUID()}-${safeName}`;
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

// ---------------------------------------------------------------------
// Working Drawings (simplified) — a plain project-wise file register:
// title, mandatory category, optional note. Reuses the generic
// `attachments` table (stage='Working Drawings') rather than the
// room/area/version schema built earlier this session, per the explicit
// "I do not need the current complicated features" request. Legacy files
// from both earlier eras (`attachments` stage='Drawings', and
// `working_drawing_attachments` from the brief life of the complex
// module) are surfaced read-and-editable alongside new uploads, never
// migrated or deleted — see listWorkingDrawingFiles().
// ---------------------------------------------------------------------
export async function uploadWorkingDrawingFile({ projectId, title, fileCategory, customCategory, file, note, uploadedBy }) {
  const safeCategory = (fileCategory || "Other").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60);
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-140);
  const path = `projects/${projectId}/working-drawings/${safeCategory}/${crypto.randomUUID()}-${safeName}`;
  const { error: uploadError } = await supabase.storage.from("interior-attachments").upload(path, file);
  if (uploadError) return { data: null, error: uploadError };
  return addAttachmentRecord({
    projectId, stage: "Working Drawings", title, fileName: file.name, note,
    storagePath: path, fileType: file.type, fileSize: file.size, uploadedBy,
    fileCategory, customCategory,
  });
}

// Merges the new simplified uploads with both legacy sources so nothing
// previously uploaded ever disappears from this page, normalized onto one
// shape. `source` on each row records which table it actually lives in, so
// a later category edit (updateWorkingDrawingFileCategory) writes back to
// the right place.
export async function listWorkingDrawingFiles(projectId) {
  const [attRes, wdaRes] = await Promise.all([
    supabase.from("attachments").select("*").eq("project_id", projectId).in("stage", ["Working Drawings", "Drawings"]).order("created_at", { ascending: false }),
    supabase.from("working_drawing_attachments").select("*").eq("project_id", projectId).order("uploaded_at", { ascending: false }),
  ]);
  if (attRes.error) return { data: null, error: attRes.error };
  const fromAttachments = (attRes.data || []).map((r) => ({
    source: "attachments", id: r.id, title: r.title || r.file_name, original_file_name: r.file_name,
    file_category: r.file_category || null, custom_category: r.custom_category || null, note: r.note,
    storage_path: r.storage_path, file_type: r.file_type, file_size: r.file_size,
    uploaded_by: r.uploaded_by, uploaded_at: r.created_at,
  }));
  const fromLegacyModule = (wdaRes.data || []).map((r) => ({
    source: "working_drawing_attachments", id: r.id, title: r.original_file_name || r.file_name, original_file_name: r.file_name,
    file_category: r.file_category || null, custom_category: null, note: r.description,
    storage_path: r.storage_path, file_type: r.file_type, file_size: r.file_size,
    uploaded_by: r.uploaded_by, uploaded_at: r.uploaded_at,
  }));
  const merged = [...fromAttachments, ...fromLegacyModule].sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
  return { data: merged, error: null };
}

export async function updateWorkingDrawingFileCategory(source, projectId, id, fileCategory, customCategory) {
  const table = source === "working_drawing_attachments" ? "working_drawing_attachments" : "attachments";
  const patch = table === "attachments" ? { file_category: fileCategory, custom_category: customCategory || null } : { file_category: fileCategory };
  const { data, error } = await supabase.from(table).update(patch).eq("id", id).eq("project_id", projectId).select().single();
  if (!error) await logAudit(table, id, "assign_category", { file_category: fileCategory }, projectId);
  return { data, error };
}

export async function lockDesignAttachment(id) {
  const { data, error } = await supabase.from("attachments").update({ frozen: true }).eq("id", id).select().single();
  if (!error) await logAudit("attachments", id, "lock_design", null, data.project_id);
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
  if (!error) await logAudit("project_changes", id, `decide_${decision}`, null, data.project_id);
  return { data, error };
}

export async function requestProjectChange({ projectId, requestedBy, description, additionalCost, timelineImpact, materialImpact }) {
  const { data, error } = await supabase.from("project_changes").insert({
    project_id: projectId, requested_by: requestedBy, requested_date: new Date().toISOString().slice(0, 10),
    description, additional_cost: additionalCost || 0, timeline_impact: timelineImpact || null, material_impact: materialImpact || null,
  }).select().single();
  if (!error) await logAudit("project_changes", data.id, "create", { description }, projectId);
  return { data, error };
}

export async function listSnags(projectId) {
  return supabase.from("snags").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
}

export async function createSnag({ projectId, issue, major, dueDate, assignedTo }) {
  const { data, error } = await supabase.from("snags").insert({
    project_id: projectId, issue, major: !!major, due_date: dueDate || null, assigned_to: assignedTo || null,
  }).select().single();
  if (!error) await logAudit("snags", data.id, "create", { issue }, projectId);
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
  if (!error) await logAudit("snags", id, "resolve", null, data.project_id);
  return { data, error };
}

export async function listSiteReports(projectId) {
  return supabase.from("site_reports").select("*").eq("project_id", projectId).order("report_date", { ascending: false });
}

export async function createSiteReport(payload) {
  const { data, error } = await supabase.from("site_reports").insert(payload).select().single();
  if (!error) await logAudit("site_reports", data.id, "create", { report_date: payload.report_date }, payload.project_id);
  return { data, error };
}

// ---------------------------------------------------------------------
// Person-wise task assignment from Daily Site Updates -- wired into the
// REAL staff_tasks system (Accept/Start/Complete/Verify/Close, already
// rendered as full cards in Today's Tasks) via the new staff_create_project_task
// RPC (mvp_pilot_daily_update_tasks_v2_38.sql), never Interior's own thin
// `tasks` table. See that migration's header comment for why.
// ---------------------------------------------------------------------

// Candidates for the "Assign To" dropdown need profiles.auth_id (the
// user_profiles.id / auth.uid() value staff_tasks.assigned_to actually
// expects) -- NOT profiles.id. A profile with no auth_id has never logged
// into the staff pilot and cannot receive a task; filtered out here so it
// never silently appears as a pickable-but-broken option.
export async function listAssignableInteriorPeople() {
  return supabase.from("profiles").select("id, name, role, auth_id").eq("active", true).not("auth_id", "is", null).order("name");
}

export async function createProjectTask({ projectId, title, description, assignedTo, dueDate, priorityCode, sourceSiteReportId, sourceWorkItemId, sourceType }) {
  const { data, error } = await supabase.rpc("staff_create_project_task", {
    p_project_id: projectId, p_title: title, p_description: description || null, p_assigned_to: assignedTo,
    p_due_date: dueDate, p_priority_code: priorityCode || "NORMAL",
    p_source_site_report_id: sourceSiteReportId, p_source_work_item_id: sourceWorkItemId, p_source_type: sourceType,
  });
  const row = Array.isArray(data) ? data[0] : data;
  return { data: row, error };
}

// All staff_tasks linked to this project (Daily Site Update assignments,
// and any future project-linked source) -- used by Project Tasks, the
// Daily Update report list, and the Master Report. assigned_to/assigned_by
// here are user_profiles ids, resolved for display via
// staff_list_assignable_users_all() (same resolver TodayTasks.jsx/
// AssignTask.jsx already use), never listInteriorPeople().
export async function listProjectStaffTasks(projectId) {
  return supabase.from("staff_tasks").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
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
  if (!error) await logAudit(table, id, "update_status", { status }, data.project_id);
  return { data, error };
}

export async function updateMaterialField(table, id, field, value) {
  const { data, error } = await supabase.from(table).update({ [field]: value }).eq("id", id).select().single();
  if (!error) await logAudit(table, id, `update_${field}`, { value }, data.project_id);
  return { data, error };
}

export async function listActivity(projectId) {
  return supabase.from("activity_logs").select("*").eq("project_id", projectId).order("created_at", { ascending: false }).limit(100);
}

export async function logActivity(projectId, action, description, userId) {
  const { data, error } = await supabase.from("activity_logs").insert({ project_id: projectId, action, description, user_id: userId || null }).select().single();
  if (!error) await logAudit("activity_logs", data.id, "create", { action }, projectId);
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
  if (!error) await logAudit("tasks", data.id, "create", { title }, projectId);
  return { data, error };
}

// status must be one of tasks_status_check's values: OPEN / IN PROGRESS /
// COMPLETED / BLOCKED / CANCELLED (this external table has no "DONE").
export async function updateTaskStatus(id, status) {
  const { data, error } = await supabase.from("tasks").update({ status }).eq("id", id).select().single();
  if (!error) await logAudit("tasks", id, "update_status", { status }, data.project_id);
  return { data, error };
}

export async function listRequests(projectId) {
  return supabase.from("project_requests").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
}

export async function createRequest({ projectId, requestType, description, createdBy }) {
  const { data, error } = await supabase.from("project_requests").insert({
    project_id: projectId, request_type: requestType, description, created_by: createdBy || null,
  }).select().single();
  if (!error) await logAudit("project_requests", data.id, "create", { requestType }, projectId);
  return { data, error };
}

export async function updateRequestStatus(id, status) {
  const { data, error } = await supabase.from("project_requests").update({ status }).eq("id", id).select().single();
  if (!error) await logAudit("project_requests", id, "update_status", { status }, data.project_id);
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
  if (!result.error) await logAudit("handovers", result.data.id, `set_${field}`, { value }, projectId);
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
  if (!error) await logAudit("customer_feedback", data.id, "create", null, payload.project_id);
  return { data, error };
}

export async function listFeedback(projectId) {
  return supabase.from("customer_feedback").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
}

export async function listPaymentRecords(projectId) {
  return supabase.from("interior_payment_records").select("*").eq("project_id", projectId).eq("is_active", true).order("created_at", { ascending: false });
}

export async function addPaymentRecord(payload) {
  const { data, error } = await supabase.from("interior_payment_records").insert(payload).select().single();
  if (!error) await logAudit("interior_payment_records", data.id, "create", { amount: payload.amount, payment_type: payload.payment_type }, payload.project_id);
  return { data, error };
}

export async function markPaymentReceived(id, receiptNumber) {
  const { data, error } = await supabase.from("interior_payment_records").update({
    status: "RECEIVED", received_date: new Date().toISOString().slice(0, 10),
    receipt_number: receiptNumber || null,
  }).eq("id", id).select().single();
  if (!error) await logAudit("interior_payment_records", id, "mark_received", { receipt_number: receiptNumber || null }, data.project_id);
  return { data, error };
}

// ---------------------------------------------------------------------
// Project Master Report — one aggregate loader for every function's real
// data, all scoped to a single project_id. Every call here is an EXISTING
// function already used by its own screen; this adds zero new queries
// beyond listFeedback() above (customer_feedback had a writer but no
// reader yet). RLS (interior_is_org_wide/interior_is_project_member,
// mvp_pilot_interior_project_rls_v2_2w.sql) already scopes every one of
// these to what the caller may see — an unauthorized project_id simply
// resolves to project: null / empty arrays here, same as every other
// Interior screen, not a special case this function needs to handle.
// isOrgWide mirrors the server-side interior_is_org_wide() RLS check
// client-side, ONLY to decide whether it's worth even attempting the one
// call (`materials`, the catalog table) that RLS restricts to org-wide
// roles — skipping it for a project-scoped viewer avoids a guaranteed 403
// on their own project's report. RLS is still the real enforcement either
// way; this is purely to not fire a request known in advance to fail.
export async function loadMasterReport(projectId, isOrgWide) {
  const [
    projectsRes, peopleRes, attachmentsRes, changesRes, snagsRes, siteReportsRes,
    materialsProjectRes, materialsPurchaseRes, materialsCatalogRes, activityRes,
    paymentsRes, handoverRes, feedbackRes, tasksRes, requestsRes, teamRes, auditRes,
    materialSelectionsRes, materialSelectionAttachmentsRes,
    workingDrawingAreasRes, designBriefsRes, designVersionsRes, designChangeRequestsRes,
    designApprovalsRes, designLocksRes, workingDrawingsRes, drawingVersionsRes,
    checklistResultsRes, checklistItemsRes, drawingIssuesRes, workingDrawingAttachmentsRes,
    purchaseRequestsRes, purchaseRequestItemsRes, inhouseProductionRequestsRes, outsourceRequirementsRes,
    vendorQuotationsRes, purchaseVendorSelectionsRes, purchaseApprovalsRes, purchaseOrdersRes,
    purchaseCostingRes, purchaseChecklistResultsRes, purchaseChecklistItemsRes, vendorFollowupsRes,
    purchaseReceiptsRes, purchasePaymentCoordinationRes, purchaseAttachmentsRes, staffTasksRes,
  ] = await Promise.all([
    listProjects(), listInteriorPeople(), listAttachments(projectId), listProjectChanges(projectId),
    listSnags(projectId), listSiteReports(projectId), listProjectMaterials(projectId, null),
    listProjectMaterials(projectId, "purchase"), isOrgWide ? listMaterials(projectId) : Promise.resolve({ data: [], error: null }),
    listActivity(projectId), listPaymentRecords(projectId), getHandover(projectId), listFeedback(projectId),
    listTasks(projectId), listRequests(projectId), listProjectMembers(projectId), listProjectActivity(projectId),
    listMaterialSelections(projectId), listMaterialSelectionAttachmentsForProject(projectId),
    supabase.from("working_drawing_areas").select("*").eq("project_id", projectId).is("archived_at", null),
    supabase.from("design_briefs").select("*").eq("project_id", projectId),
    supabase.from("design_versions").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
    supabase.from("design_change_requests").select("*").eq("project_id", projectId).order("requested_date", { ascending: true }),
    supabase.from("design_approvals").select("*").eq("project_id", projectId).order("decided_at", { ascending: true }),
    supabase.from("design_locks").select("*").eq("project_id", projectId).eq("is_active", true),
    supabase.from("working_drawings").select("*").eq("project_id", projectId),
    supabase.from("drawing_versions").select("*").eq("project_id", projectId),
    supabase.from("drawing_checklist_results").select("*").eq("project_id", projectId).eq("is_current", true),
    listChecklistItems(),
    supabase.from("drawing_issues").select("*").eq("project_id", projectId).order("issue_date", { ascending: true }),
    listWorkingDrawingAttachmentsForProject(projectId),
    supabase.from("purchase_requests").select("*").eq("project_id", projectId).is("archived_at", null),
    supabase.from("purchase_request_items").select("*").eq("project_id", projectId),
    supabase.from("inhouse_production_requests").select("*").eq("project_id", projectId),
    supabase.from("outsource_requirements").select("*").eq("project_id", projectId),
    supabase.from("vendor_quotations").select("*").eq("project_id", projectId),
    supabase.from("purchase_vendor_selections").select("*").eq("project_id", projectId),
    supabase.from("purchase_approvals").select("*").eq("project_id", projectId),
    supabase.from("purchase_orders").select("*").eq("project_id", projectId),
    supabase.from("purchase_costing").select("*").eq("project_id", projectId),
    supabase.from("purchase_checklist_results").select("*").eq("project_id", projectId).eq("is_current", true),
    listPurchaseChecklistItems(),
    supabase.from("vendor_followups").select("*").eq("project_id", projectId),
    supabase.from("purchase_receipts").select("*").eq("project_id", projectId),
    supabase.from("purchase_payment_coordination").select("*").eq("project_id", projectId),
    listPurchaseAttachmentsForProject(projectId),
    listProjectStaffTasks(projectId),
  ]);

  const project = (projectsRes.data || []).find((p) => p.id === projectId) || null;
  // Only "couldn't find/read the project itself" fails the whole report.
  // Every other query already degrades to an empty array below on its own
  // error — e.g. `materials` (the catalog table) is deliberately org-wide-
  // only under this session's RLS, so a PM/Designer/Execution viewer gets a
  // 403 on THAT ONE call for their own project, same as the existing
  // Materials tab already treats it (silently empty, never an error). Only
  // bundling errors that should never legitimately happen for an
  // authorized viewer keeps one such by-design gap from taking down every
  // other section of the report.
  const project_load_error = projectsRes.error;

  return {
    error: project_load_error || (project ? null : { message: "not_found_or_not_authorized" }),
    project,
    people: peopleRes.data || [],
    attachments: attachmentsRes.data || [],
    changes: changesRes.data || [],
    snags: snagsRes.data || [],
    siteReports: siteReportsRes.data || [],
    materialsRequirements: materialsProjectRes.data || [],
    materialsPurchase: materialsPurchaseRes.data || [],
    materialsCatalog: materialsCatalogRes.data || [],
    activity: activityRes.data || [],
    payments: paymentsRes.data || [],
    handover: handoverRes.data || {},
    feedback: feedbackRes.data || [],
    tasks: tasksRes.data || [],
    requests: requestsRes.data || [],
    team: teamRes.data || [],
    auditLog: auditRes.data || [],
    materialSelections: materialSelectionsRes.data || [],
    materialSelectionAttachments: materialSelectionAttachmentsRes.data || [],
    workingDrawingAreas: workingDrawingAreasRes.data || [],
    designBriefs: designBriefsRes.data || [],
    designVersions: designVersionsRes.data || [],
    designChangeRequests: designChangeRequestsRes.data || [],
    designApprovals: designApprovalsRes.data || [],
    designLocks: designLocksRes.data || [],
    workingDrawings: workingDrawingsRes.data || [],
    drawingVersions: drawingVersionsRes.data || [],
    checklistResults: checklistResultsRes.data || [],
    checklistItems: checklistItemsRes.data || [],
    drawingIssues: drawingIssuesRes.data || [],
    workingDrawingAttachments: workingDrawingAttachmentsRes.data || [],
    purchaseRequests: purchaseRequestsRes.data || [],
    purchaseRequestItems: purchaseRequestItemsRes.data || [],
    inhouseProductionRequests: inhouseProductionRequestsRes.data || [],
    outsourceRequirements: outsourceRequirementsRes.data || [],
    vendorQuotations: vendorQuotationsRes.data || [],
    purchaseVendorSelections: purchaseVendorSelectionsRes.data || [],
    purchaseApprovals: purchaseApprovalsRes.data || [],
    purchaseOrders: purchaseOrdersRes.data || [],
    purchaseCosting: purchaseCostingRes.data || [],
    purchaseChecklistResults: purchaseChecklistResultsRes.data || [],
    purchaseChecklistItems: purchaseChecklistItemsRes.data || [],
    vendorFollowups: vendorFollowupsRes.data || [],
    purchaseReceipts: purchaseReceiptsRes.data || [],
    purchasePaymentCoordination: purchasePaymentCoordinationRes.data || [],
    purchaseAttachments: purchaseAttachmentsRes.data || [],
    staffTasks: staffTasksRes.data || [],
  };
}

// Independent per-table row counts for the same project_id — used only by
// the report's Reconciliation panel to verify the numbers it rendered
// actually match a fresh, separately-issued count (catches pagination or
// filter bugs; RLS still applies the same as any other query here).
export async function reconcileMasterReportCounts(projectId) {
  const tables = [
    "attachments", "project_changes", "snags", "site_reports", "project_materials",
    "activity_logs", "customer_feedback", "tasks", "project_requests", "project_members", "interior_pilot_audit_log",
    "material_selection_attachments",
    "working_drawing_areas", "design_briefs", "design_versions", "design_change_requests",
    "design_approvals", "working_drawings", "drawing_versions", "drawing_checklist_results",
    "drawing_issues", "working_drawing_attachments",
    "purchase_request_items", "inhouse_production_requests", "outsource_requirements",
    "vendor_quotations", "purchase_vendor_selections", "purchase_approvals", "purchase_orders",
    "purchase_costing", "purchase_checklist_results", "vendor_followups", "purchase_receipts",
    "purchase_payment_coordination", "purchase_attachments",
  ];
  const results = await Promise.all(tables.map((table) =>
    supabase.from(table).select("id", { count: "exact", head: true }).eq("project_id", projectId),
  ));
  const counts = {};
  tables.forEach((table, i) => { counts[table] = results[i].count ?? null; });
  // interior_payment_records is soft-deletable (is_active) — listPaymentRecords()
  // only shows is_active=true rows, so the independent count must match that
  // same filter, or a soft-deleted record would look like a false MISMATCH.
  const paymentsCount = await supabase.from("interior_payment_records").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("is_active", true);
  counts.interior_payment_records = paymentsCount.count ?? null;
  // material_selections is soft-archivable (archived_at) — listMaterialSelections()
  // only shows archived_at IS NULL rows, same reasoning as payments above.
  const selectionsCount = await supabase.from("material_selections").select("id", { count: "exact", head: true }).eq("project_id", projectId).is("archived_at", null);
  counts.material_selections = selectionsCount.count ?? null;
  // design_locks is soft-managed (is_active) — same reasoning as above.
  const locksCount = await supabase.from("design_locks").select("id", { count: "exact", head: true }).eq("project_id", projectId).eq("is_active", true);
  counts.design_locks = locksCount.count ?? null;
  // purchase_requests is soft-archivable (archived_at) — same reasoning as above.
  const purchaseRequestsCount = await supabase.from("purchase_requests").select("id", { count: "exact", head: true }).eq("project_id", projectId).is("archived_at", null);
  counts.purchase_requests = purchaseRequestsCount.count ?? null;
  return counts;
}

// ---------------------------------------------------------------------
// Material Selection — room-wise material choices with an approval
// workflow and revision history. "Replace" NEVER deletes or overwrites
// the old row: it inserts a new one referencing it via
// previous_selection_id and marks the old row status='REPLACED', so
// history is always still queryable. RLS (material_selections_scoped,
// mvp_pilot_material_selection_v2_34.sql) already restricts every one of
// these the same way every other project-linked table is — org-wide or a
// member of that specific project.
export async function listMaterialSelections(projectId) {
  return supabase.from("material_selections").select("*").eq("project_id", projectId).is("archived_at", null).order("created_at", { ascending: false });
}

export async function createMaterialSelection(payload) {
  const { data, error } = await supabase.from("material_selections").insert(payload).select().single();
  if (!error) await logAudit("material_selections", data.id, "create", { material_name: payload.material_name, material_code: payload.material_code, area_type: payload.area_type }, payload.project_id);
  return { data, error };
}

// Fetches the pre-update row first so the audit entry can carry real old ->
// new values per changed field (spec explicitly asks for both), not just
// the new patch. "Submitted to Client" gets its own distinct action label
// (matching the decide_APPROVED/decide_REJECTED convention below) rather
// than showing as a generic "update" in Activity History.
export async function updateMaterialSelection(projectId, id, patch, updatedBy) {
  const { data: before } = await supabase.from("material_selections").select("*").eq("id", id).eq("project_id", projectId).single();
  const { data, error } = await supabase.from("material_selections")
    .update({ ...patch, updated_by: updatedBy || null })
    .eq("id", id).eq("project_id", projectId).select().single();
  if (!error) {
    const old_values = {}; const new_values = {};
    Object.keys(patch).forEach((k) => { old_values[k] = before ? before[k] : undefined; new_values[k] = patch[k]; });
    const action = patch.approval_status === "Submitted to Client" ? "submit"
      : patch.approval_status ? `update_status_${patch.approval_status}` : "update";
    await logAudit("material_selections", id, action, { old_values, new_values }, projectId);
  }
  return { data, error };
}

// Never overwrites `previousSelection` — inserts a new revision row and
// only flips the OLD row's status to REPLACED, so both remain queryable.
export async function replaceMaterialSelection(projectId, previousSelection, newPayload, changedBy) {
  const { data: created, error: createErr } = await supabase.from("material_selections").insert({
    ...newPayload,
    project_id: projectId,
    previous_selection_id: previousSelection.id,
    revision_number: (previousSelection.revision_number || 1) + 1,
    created_by: changedBy || null,
  }).select().single();
  if (createErr) return { data: null, error: createErr };
  const { error: updateErr } = await supabase.from("material_selections")
    .update({ status: "REPLACED", updated_by: changedBy || null })
    .eq("id", previousSelection.id).eq("project_id", projectId);
  if (!updateErr) {
    await logAudit("material_selections", created.id, "replace", {
      old_values: { material_name: previousSelection.material_name, material_code: previousSelection.material_code, id: previousSelection.id },
      new_values: { material_name: newPayload.material_name, material_code: newPayload.material_code, id: created.id },
      change_reason: newPayload.change_reason,
    }, projectId);
  }
  return { data: created, error: updateErr || null };
}

// A rejected selection can't be marked final without a fresh approval —
// enforced here, not just hidden by a disabled button.
export async function markMaterialSelectionFinal(projectId, id, currentApprovalStatus, updatedBy) {
  if (currentApprovalStatus === "Rejected") {
    return { data: null, error: { message: "A rejected material cannot be marked final without a new approval." } };
  }
  const { data, error } = await supabase.from("material_selections")
    .update({ is_final: true, updated_by: updatedBy || null })
    .eq("id", id).eq("project_id", projectId).select().single();
  if (!error) await logAudit("material_selections", id, "mark_final", { old_values: { is_final: false }, new_values: { is_final: true } }, projectId);
  return { data, error };
}

export async function decideMaterialSelectionApproval(projectId, id, decision, approverId) {
  const { data: before } = await supabase.from("material_selections").select("approval_status").eq("id", id).eq("project_id", projectId).single();
  const patch = {
    approval_status: decision,
    approved_by: approverId || null,
    client_approval_date: decision === "Approved" ? new Date().toISOString().slice(0, 10) : null,
    updated_by: approverId || null,
  };
  const { data, error } = await supabase.from("material_selections").update(patch).eq("id", id).eq("project_id", projectId).select().single();
  if (!error) {
    await logAudit("material_selections", id, `decide_${decision}`, {
      old_values: { approval_status: before?.approval_status }, new_values: { approval_status: decision },
    }, projectId);
  }
  return { data, error };
}

export async function archiveMaterialSelection(projectId, id, updatedBy) {
  const archivedAt = new Date().toISOString();
  const { data, error } = await supabase.from("material_selections")
    .update({ archived_at: archivedAt, updated_by: updatedBy || null })
    .eq("id", id).eq("project_id", projectId).select().single();
  if (!error) await logAudit("material_selections", id, "archive", { old_values: { archived_at: null }, new_values: { archived_at: archivedAt } }, projectId);
  return { data, error };
}

export async function uploadMaterialSelectionAttachment({ projectId, materialSelectionId, file, fileCategory, description, uploadedBy }) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-140);
  const path = `projects/${projectId}/material-selection/${materialSelectionId}/${crypto.randomUUID()}-${safeName}`;
  const { error: uploadError } = await supabase.storage.from("interior-attachments").upload(path, file);
  if (uploadError) return { data: null, error: uploadError };
  const { data, error } = await supabase.from("material_selection_attachments").insert({
    project_id: projectId, material_selection_id: materialSelectionId, file_category: fileCategory || "Other",
    file_name: file.name, original_file_name: file.name, storage_path: path,
    file_type: file.type, file_size: file.size, description: description || null, uploaded_by: uploadedBy || null,
  }).select().single();
  if (!error) await logAudit("material_selection_attachments", data.id, "upload", { file_category: fileCategory, material_selection_id: materialSelectionId }, projectId);
  return { data, error };
}

export async function listMaterialSelectionAttachments(materialSelectionId) {
  return supabase.from("material_selection_attachments").select("*").eq("material_selection_id", materialSelectionId).order("uploaded_at", { ascending: false });
}

export async function listMaterialSelectionAttachmentsForProject(projectId) {
  return supabase.from("material_selection_attachments").select("*").eq("project_id", projectId).order("uploaded_at", { ascending: false });
}

export async function deleteMaterialSelectionAttachment(projectId, id) {
  const { error } = await supabase.from("material_selection_attachments").delete().eq("id", id).eq("project_id", projectId);
  if (!error) await logAudit("material_selection_attachments", id, "delete", null, projectId);
  return { error };
}

// =======================================================================
// Working Drawings -- consolidates Design / Design Approval / Design Lock /
// Drawings / Material Selection into one room/area-wise flow
// (mvp_pilot_working_drawings_v2_35.sql). Old `attachments` (stage=Design/
// Drawings) and `project_changes` rows are never touched by any function
// here -- they stay exactly where they are and the screen reads them
// read-only alongside the new tables below.
// =======================================================================

// ---------- areas ----------
export async function listWorkingDrawingAreas(projectId) {
  return supabase.from("working_drawing_areas").select("*").eq("project_id", projectId).is("archived_at", null).order("created_at", { ascending: true });
}

export async function createWorkingDrawingArea(payload, createdBy) {
  const { data, error } = await supabase.from("working_drawing_areas").insert({ ...payload, created_by: createdBy || null }).select().single();
  if (!error) await logAudit("working_drawing_areas", data.id, "create", { area_type: payload.area_type, area_name: payload.area_name }, payload.project_id);
  return { data, error };
}

export async function updateWorkingDrawingArea(projectId, id, patch) {
  const { data: before } = await supabase.from("working_drawing_areas").select("*").eq("id", id).eq("project_id", projectId).single();
  const { data, error } = await supabase.from("working_drawing_areas").update(patch).eq("id", id).eq("project_id", projectId).select().single();
  if (!error) {
    const old_values = {}; const new_values = {};
    Object.keys(patch).forEach((k) => { old_values[k] = before ? before[k] : undefined; new_values[k] = patch[k]; });
    await logAudit("working_drawing_areas", id, "update", { old_values, new_values }, projectId);
  }
  return { data, error };
}

export async function archiveWorkingDrawingArea(projectId, id) {
  const archivedAt = new Date().toISOString();
  const { data, error } = await supabase.from("working_drawing_areas").update({ archived_at: archivedAt }).eq("id", id).eq("project_id", projectId).select().single();
  if (!error) await logAudit("working_drawing_areas", id, "archive", null, projectId);
  return { data, error };
}

// ---------- design brief (one per area) ----------
export async function getDesignBrief(projectId, areaId) {
  return supabase.from("design_briefs").select("*").eq("project_id", projectId).eq("area_id", areaId).maybeSingle();
}

export async function upsertDesignBrief(projectId, areaId, patch, userId) {
  const { data: existing } = await supabase.from("design_briefs").select("id").eq("area_id", areaId).maybeSingle();
  if (existing) {
    const { data, error } = await supabase.from("design_briefs")
      .update({ ...patch, updated_by: userId || null }).eq("id", existing.id).select().single();
    if (!error) await logAudit("design_briefs", data.id, "update", patch, projectId);
    return { data, error };
  }
  const { data, error } = await supabase.from("design_briefs")
    .insert({ ...patch, project_id: projectId, area_id: areaId, created_by: userId || null, updated_by: userId || null }).select().single();
  if (!error) await logAudit("design_briefs", data.id, "create", patch, projectId);
  return { data, error };
}

// ---------- design versions (immutable chain per area) ----------
export async function listDesignVersions(projectId, areaId) {
  return supabase.from("design_versions").select("*").eq("project_id", projectId).eq("area_id", areaId).order("created_at", { ascending: false });
}

function nextVersionNum(versionNumber) {
  return (parseInt(String(versionNumber || "V0").replace(/\D/g, ""), 10) || 0) + 1;
}

// "New Version" -- used before a design is approved (V1 -> V2 -> V3...).
export async function createDesignVersion(projectId, areaId, payload, createdBy) {
  const { data: current } = await supabase.from("design_versions").select("*").eq("area_id", areaId).eq("is_current", true).maybeSingle();
  if (current) await supabase.from("design_versions").update({ is_current: false }).eq("id", current.id);
  const { data, error } = await supabase.from("design_versions").insert({
    ...payload, project_id: projectId, area_id: areaId,
    version_number: `V${nextVersionNum(current?.version_number)}`, revision_number: 0,
    previous_version_id: current?.id || null, created_by: createdBy || null, is_current: true, approval_status: "Draft",
  }).select().single();
  if (!error) {
    await supabase.from("working_drawing_areas").update({ current_stage: "Design Development" }).eq("id", areaId).eq("current_stage", "Design Brief");
    await logAudit("design_versions", data.id, "create_version", { version_number: data.version_number }, projectId);
  }
  return { data, error };
}

// "New Revision" -- used AFTER a version is approved: keeps the same
// version_number, increments revision_number (Approved V3 -> R1 after V3 ->
// R2 after V3), per spec's explicit "never silently replace an approved
// file" rule.
export async function createDesignRevision(projectId, areaId, approvedVersion, payload, createdBy) {
  await supabase.from("design_versions").update({ is_current: false }).eq("id", approvedVersion.id);
  const nextRev = (approvedVersion.revision_number || 0) + 1;
  const { data, error } = await supabase.from("design_versions").insert({
    ...payload, project_id: projectId, area_id: areaId,
    version_number: approvedVersion.version_number, revision_number: nextRev,
    previous_version_id: approvedVersion.id, created_by: createdBy || null, is_current: true, approval_status: "Draft",
  }).select().single();
  if (!error) await logAudit("design_versions", data.id, "create_revision", { version_number: data.version_number, revision_number: nextRev }, projectId);
  return { data, error };
}

// Moves a version through the workflow states that aren't a formal
// approve/reject decision (Submitted for Internal Review, Submitted to
// Client, Internal/Client Changes Required, Resubmitted...). Approve/
// Reject/Approved with Conditions go through decideDesignApproval() instead,
// since those also need an approval-record with proof.
export async function updateDesignVersionStatus(projectId, areaId, id, status) {
  const { data, error } = await supabase.from("design_versions").update({ approval_status: status }).eq("id", id).select().single();
  if (!error) {
    if (status !== "Draft") await supabase.from("working_drawing_areas").update({ current_stage: "Design Approval" }).eq("id", areaId).eq("current_stage", "Design Development");
    await logAudit("design_versions", id, `update_status_${status}`, null, projectId);
  }
  return { data, error };
}

// ---------- design change requests (client/internal/site/management split) ----------
export async function listDesignChangeRequests(projectId, areaId) {
  return supabase.from("design_change_requests").select("*").eq("project_id", projectId).eq("area_id", areaId).order("requested_date", { ascending: false });
}

export async function createDesignChangeRequest(payload) {
  const { data, error } = await supabase.from("design_change_requests").insert(payload).select().single();
  if (!error) await logAudit("design_change_requests", data.id, "create", { change_type: payload.change_type, post_lock: !!payload.post_lock }, payload.project_id);
  return { data, error };
}

export async function linkChangeRequestToVersion(projectId, changeRequestId, versionId) {
  const { data, error } = await supabase.from("design_change_requests")
    .update({ resulting_version_id: versionId, status: "Addressed" }).eq("id", changeRequestId).eq("project_id", projectId).select().single();
  if (!error) await logAudit("design_change_requests", changeRequestId, "resolve", { resulting_version_id: versionId }, projectId);
  return { data, error };
}

// Pure computation, no DB call -- the spec explicitly requires this be
// CALCULATED from real version/change-request rows, never manually entered.
export function computeDesignChangeCounts(changeRequests) {
  const counts = { client_change_count: 0, internal_change_count: 0, site_condition_change_count: 0, management_change_count: 0, total_change_count: 0 };
  (changeRequests || []).forEach((c) => {
    if (c.change_type === "Client") counts.client_change_count += 1;
    else if (c.change_type === "Internal") counts.internal_change_count += 1;
    else if (c.change_type === "Site Condition") counts.site_condition_change_count += 1;
    else if (c.change_type === "Management") counts.management_change_count += 1;
    counts.total_change_count += 1;
  });
  return counts;
}

// One row per area (its current version) -- used for the Working Drawings
// dashboard's project-wide design-approval progress/pending-approvals tiles.
export async function listCurrentDesignVersionsForProject(projectId) {
  return supabase.from("design_versions").select("*").eq("project_id", projectId).eq("is_current", true);
}

// ---------- design approvals ----------
export async function listDesignApprovals(projectId, areaId) {
  return supabase.from("design_approvals").select("*").eq("project_id", projectId).eq("area_id", areaId).order("decided_at", { ascending: false });
}

// Approving/rejecting flips the version's own approval_status too (so a
// version's status and its latest approval decision never disagree), and
// an approved version becomes read-only -- enforced in the screen by
// disabling edit once approval_status is Approved/Approved with Conditions.
export async function decideDesignApproval(projectId, areaId, versionId, decision, extra, decidedBy) {
  const { data, error } = await supabase.from("design_approvals").insert({
    project_id: projectId, area_id: areaId, design_version_id: versionId,
    version_number: extra.version_number || null, stage_at_approval: extra.stage_at_approval || null,
    decision, decided_by: decidedBy || null, remarks: extra.remarks || null, conditions: extra.conditions || null,
    approval_method: extra.approval_method || null, proof_storage_path: extra.proof_storage_path || null,
  }).select().single();
  if (!error) {
    await supabase.from("design_versions").update({ approval_status: decision }).eq("id", versionId);
    if (decision === "Approved" || decision === "Approved with Conditions") {
      await supabase.from("working_drawing_areas").update({ current_stage: "Material Approval" }).eq("id", areaId);
    }
    await logAudit("design_approvals", data.id, `decide_${decision}`, { design_version_id: versionId }, projectId);
  }
  return { data, error };
}

// ---------- design lock ----------
export async function getActiveDesignLock(projectId, areaId) {
  return supabase.from("design_locks").select("*").eq("project_id", projectId).eq("area_id", areaId).eq("is_active", true).maybeSingle();
}

export async function createDesignLock(projectId, areaId, payload, lockedBy) {
  const { data, error } = await supabase.from("design_locks").insert({
    ...payload, project_id: projectId, area_id: areaId, locked_by: lockedBy || null,
  }).select().single();
  if (!error) {
    await supabase.from("working_drawing_areas").update({ current_stage: "Working Drawings" }).eq("id", areaId);
    await logAudit("design_locks", data.id, payload.exception_reason ? "lock_with_exception" : "lock", { locked_version_id: payload.locked_version_id }, projectId);
  }
  return { data, error };
}

// ---------- working drawings + drawing versions ----------
export async function listWorkingDrawings(projectId, areaId) {
  return supabase.from("working_drawings").select("*").eq("project_id", projectId).eq("area_id", areaId).order("created_at", { ascending: false });
}

export async function createWorkingDrawing(payload, createdBy) {
  const { data, error } = await supabase.from("working_drawings").insert({ ...payload, created_by: createdBy || null }).select().single();
  if (!error) await logAudit("working_drawings", data.id, "create", { drawing_number: payload.drawing_number, drawing_type: payload.drawing_type }, payload.project_id);
  return { data, error };
}

export async function updateWorkingDrawing(projectId, id, patch) {
  const { data: before } = await supabase.from("working_drawings").select("*").eq("id", id).eq("project_id", projectId).single();
  const { data, error } = await supabase.from("working_drawings").update(patch).eq("id", id).eq("project_id", projectId).select().single();
  if (!error) {
    const old_values = {}; const new_values = {};
    Object.keys(patch).forEach((k) => { old_values[k] = before ? before[k] : undefined; new_values[k] = patch[k]; });
    await logAudit("working_drawings", id, patch.status ? `update_status_${patch.status}` : "update", { old_values, new_values }, projectId);
  }
  return { data, error };
}

export async function listDrawingVersions(projectId, drawingId) {
  return supabase.from("drawing_versions").select("*").eq("project_id", projectId).eq("drawing_id", drawingId).order("created_at", { ascending: false });
}

export async function createDrawingVersion(projectId, drawingId, payload, createdBy) {
  const { data: current } = await supabase.from("drawing_versions").select("*").eq("drawing_id", drawingId).eq("is_current", true).maybeSingle();
  if (current) await supabase.from("drawing_versions").update({ is_current: false }).eq("id", current.id);
  const { data, error } = await supabase.from("drawing_versions").insert({
    ...payload, project_id: projectId, drawing_id: drawingId,
    version_number: `V${nextVersionNum(current?.version_number)}`, revision_number: (current?.revision_number || 0),
    previous_version_id: current?.id || null, created_by: createdBy || null, is_current: true, status: "Draft",
  }).select().single();
  if (!error) await logAudit("drawing_versions", data.id, "create_version", { version_number: data.version_number, drawing_id: drawingId }, projectId);
  return { data, error };
}

export async function updateDrawingVersionStatus(projectId, id, status) {
  const { data, error } = await supabase.from("drawing_versions").update({ status }).eq("id", id).select().single();
  if (!error) await logAudit("drawing_versions", id, `update_status_${status}`, null, projectId);
  return { data, error };
}

// Only one "Issued for Execution" version may exist per drawing at a time
// (also enforced by a DB-level partial unique index) -- issuing a new one
// marks the previous one Superseded first, never silently overwritten.
export async function issueDrawingVersion(projectId, drawingId, versionId) {
  await supabase.from("drawing_versions").update({ status: "Superseded" }).eq("drawing_id", drawingId).eq("status", "Issued for Execution");
  const { data, error } = await supabase.from("drawing_versions").update({ status: "Issued for Execution" }).eq("id", versionId).select().single();
  if (!error) await logAudit("drawing_versions", versionId, "issue_for_execution", { drawing_id: drawingId }, projectId);
  return { data, error };
}

// ---------- checklist ----------
export async function listChecklistItems() {
  return supabase.from("drawing_checklist_items").select("*").eq("active", true).order("category", { ascending: true }).order("sort_order", { ascending: true });
}

export async function listChecklistResults(projectId, areaId) {
  return supabase.from("drawing_checklist_results").select("*").eq("project_id", projectId).eq("area_id", areaId).eq("is_current", true);
}

export async function listChecklistResultHistory(projectId, areaId, checklistItemId) {
  return supabase.from("drawing_checklist_results").select("*").eq("project_id", projectId).eq("area_id", areaId).eq("checklist_item_id", checklistItemId).order("created_at", { ascending: false });
}

// Never overwrites a result -- inserts a new current row and flips the old
// one, so "reopen" and "completion history" (spec section 12) are real
// rows, not a single mutable cell.
export async function upsertChecklistResult(projectId, areaId, checklistItemId, patch, checkedBy) {
  const { data: current } = await supabase.from("drawing_checklist_results").select("*").eq("area_id", areaId).eq("checklist_item_id", checklistItemId).eq("is_current", true).maybeSingle();
  if (current) await supabase.from("drawing_checklist_results").update({ is_current: false }).eq("id", current.id);
  const { data, error } = await supabase.from("drawing_checklist_results").insert({
    project_id: projectId, area_id: areaId, checklist_item_id: checklistItemId,
    status: patch.status, checked_by: checkedBy || null, checked_date: patch.checked_date || new Date().toISOString().slice(0, 10),
    remarks: patch.remarks || null, proof_storage_path: patch.proof_storage_path || null, reopen_reason: patch.reopen_reason || null,
    previous_result_id: current?.id || null, is_current: true,
  }).select().single();
  if (!error) {
    await logAudit("drawing_checklist_results", data.id, patch.reopen_reason ? "reopen" : "update_status",
      { old_values: { status: current?.status || null }, new_values: { status: patch.status } }, projectId);
  }
  return { data, error };
}

// ---------- final issue for execution ----------
export async function listDrawingIssues(projectId, areaId) {
  return supabase.from("drawing_issues").select("*").eq("project_id", projectId).eq("area_id", areaId).order("issue_date", { ascending: false });
}

// Issuing a new drawing package supersedes the previous still-active issue
// for the same area, per spec ("mark the previous issue as superseded").
export async function createDrawingIssue(projectId, areaId, payload, issuedBy) {
  const { data: prior } = await supabase.from("drawing_issues").select("id").eq("area_id", areaId).is("superseded_at", null).maybeSingle();
  if (prior) {
    await supabase.from("drawing_issues").update({
      superseded_at: new Date().toISOString(), supersede_reason: payload.supersede_reason || "Re-issued",
    }).eq("id", prior.id);
  }
  const { data, error } = await supabase.from("drawing_issues").insert({ ...payload, project_id: projectId, area_id: areaId, issued_by: issuedBy || null }).select().single();
  if (!error) {
    await supabase.from("working_drawing_areas").update({ current_stage: "Issued for Execution" }).eq("id", areaId);
    await logAudit("drawing_issues", data.id, "issue_for_execution", { drawing_id: payload.drawing_id }, projectId);
  }
  return { data, error };
}

export async function acknowledgeDrawingIssue(projectId, id) {
  const ackDate = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.from("drawing_issues").update({ receiver_ack: true, ack_date: ackDate }).eq("id", id).eq("project_id", projectId).select().single();
  if (!error) await logAudit("drawing_issues", id, "acknowledge", { ack_date: ackDate }, projectId);
  return { data, error };
}

// ---------- shared attachments (every sub-module except Material Selection) ----------
export async function uploadWorkingDrawingAttachment({ projectId, areaId, module, relatedRecordId, file, fileCategory, description, uploadedBy }) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-140);
  const path = `projects/${projectId}/working-drawings/${areaId}/${module}/${relatedRecordId || "general"}/${crypto.randomUUID()}-${safeName}`;
  const { error: uploadError } = await supabase.storage.from("interior-attachments").upload(path, file);
  if (uploadError) return { data: null, error: uploadError };
  const { data, error } = await supabase.from("working_drawing_attachments").insert({
    project_id: projectId, area_id: areaId, module, related_record_id: relatedRecordId || null,
    file_category: fileCategory || "Other", file_name: file.name, original_file_name: file.name,
    storage_path: path, file_type: file.type, file_size: file.size, description: description || null, uploaded_by: uploadedBy || null,
  }).select().single();
  if (!error) await logAudit("working_drawing_attachments", data.id, "upload", { module, file_category: fileCategory }, projectId);
  return { data, error };
}

export async function listWorkingDrawingAttachments(areaId, module) {
  let q = supabase.from("working_drawing_attachments").select("*").eq("area_id", areaId).order("uploaded_at", { ascending: false });
  if (module) q = q.eq("module", module);
  return q;
}

export async function listWorkingDrawingAttachmentsForProject(projectId) {
  return supabase.from("working_drawing_attachments").select("*").eq("project_id", projectId).order("uploaded_at", { ascending: false });
}

export async function deleteWorkingDrawingAttachment(projectId, id) {
  const { error } = await supabase.from("working_drawing_attachments").delete().eq("id", id).eq("project_id", projectId);
  if (!error) await logAudit("working_drawing_attachments", id, "delete", null, projectId);
  return { error };
}

// ---------- task quick-actions (spec section 17) ----------
export async function createWorkingDrawingTask({ projectId, areaId, title, assignedTo, dueDate, note, createdBy, relatedModule, relatedRecordId, priority }) {
  const { data, error } = await supabase.from("tasks").insert({
    project_id: projectId, area_id: areaId || null, title, assigned_to: assignedTo || null, due_date: dueDate || null,
    note: note || null, created_by: createdBy || null, related_module: relatedModule || null,
    related_record_id: relatedRecordId || null, priority: priority || null,
  }).select().single();
  if (!error) await logAudit("tasks", data.id, "create_from_working_drawings", { related_module: relatedModule, priority }, projectId);
  return { data, error };
}

// =======================================================================
// Purchase Management -- consolidates Purchase Coordination / Purchase
// Board into one in-house-vs-outsourced purchase lifecycle
// (mvp_pilot_purchase_management_v2_36.sql). The old `project_materials`
// rows those two screens read are never touched here -- they stay exactly
// where they are and are surfaced read-only, tagged "Legacy", alongside
// the new tables below (same treatment Working Drawings gave the old
// attachments/project_changes rows).
//
// purchase_costing / vendor_quotations / purchase_vendor_selections /
// purchase_approvals / vendor_bank_details are RLS-restricted to
// purchase_costing_can_view() (org-wide + Accounts Head + Factory Head) --
// a plain project member's read of these simply comes back empty, not an
// error; screens must treat that as "not authorised to see cost detail",
// never as "no cost recorded".
// =======================================================================

async function nextSequenceNumber(table, column, prefix) {
  const { count } = await supabase.from(table).select("id", { count: "exact", head: true });
  return `${prefix}-${String((count || 0) + 1).padStart(6, "0")}`;
}

// ---------- catalogs ----------
export async function listFactoryLocations() {
  return supabase.from("factory_locations").select("*").eq("active", true).order("name", { ascending: true });
}

export async function createFactoryLocation({ name, code }) {
  const { data, error } = await supabase.from("factory_locations").insert({ name, code: code || null }).select().single();
  if (!error) await logAudit("factory_locations", data.id, "create", { name }, null);
  return { data, error };
}

export async function listVendors() {
  return supabase.from("vendors").select("*").order("name", { ascending: true });
}

export async function createVendor(payload, createdBy) {
  const { data, error } = await supabase.from("vendors").insert({ ...payload, created_by: createdBy || null }).select().single();
  if (!error) {
    await supabase.from("vendors").update({ vendor_code: `V-${String(data.id).slice(0, 8).toUpperCase()}` }).eq("id", data.id);
    await logAudit("vendors", data.id, "create", { name: payload.name }, null);
  }
  return { data, error };
}

export async function updateVendor(id, patch) {
  const { data, error } = await supabase.from("vendors").update(patch).eq("id", id).select().single();
  if (!error) await logAudit("vendors", id, "update", patch, null);
  return { data, error };
}

// Restricted -- returns empty for a plain project member, per purchase_costing_can_view().
export async function getVendorBankDetails(vendorId) {
  return supabase.from("vendor_bank_details").select("*").eq("vendor_id", vendorId).maybeSingle();
}

export async function upsertVendorBankDetails(vendorId, patch) {
  const { data: existing } = await supabase.from("vendor_bank_details").select("id").eq("vendor_id", vendorId).maybeSingle();
  if (existing) {
    const { data, error } = await supabase.from("vendor_bank_details").update(patch).eq("id", existing.id).select().single();
    return { data, error };
  }
  const { data, error } = await supabase.from("vendor_bank_details").insert({ ...patch, vendor_id: vendorId }).select().single();
  return { data, error };
}

export async function listPurchaseChecklistItems() {
  return supabase.from("purchase_checklist_items").select("*").eq("active", true).order("category", { ascending: true }).order("sort_order", { ascending: true });
}

// ---------- purchase requests + line items ----------
export async function listPurchaseRequests(projectId) {
  return supabase.from("purchase_requests").select("*").eq("project_id", projectId).is("archived_at", null).order("created_at", { ascending: false });
}

export async function listAllPurchaseRequests() {
  // Org-wide board view across every project, same shape Purchase Board
  // used to read project_materials across all projects (mvp_pilot's own
  // md/MOOD-OF-WOOD-SYSTEM.md §6 cross-project-board convention).
  return supabase.from("purchase_requests").select("*").is("archived_at", null).order("created_at", { ascending: false }).limit(500);
}

export async function createPurchaseRequest(payload, createdBy) {
  const request_number = await nextSequenceNumber("purchase_requests", "id", "PR");
  const { data, error } = await supabase.from("purchase_requests").insert({
    ...payload, request_number, created_by: createdBy || null,
  }).select().single();
  if (!error) await logAudit("purchase_requests", data.id, "create", { purchase_source: payload.purchase_source, request_number }, payload.project_id);
  return { data, error };
}

export async function updatePurchaseRequest(projectId, id, patch, updatedBy) {
  const { data: before } = await supabase.from("purchase_requests").select("*").eq("id", id).eq("project_id", projectId).single();
  const { data, error } = await supabase.from("purchase_requests")
    .update({ ...patch, updated_by: updatedBy || null }).eq("id", id).eq("project_id", projectId).select().single();
  if (!error) {
    const old_values = {}; const new_values = {};
    Object.keys(patch).forEach((k) => { old_values[k] = before ? before[k] : undefined; new_values[k] = patch[k]; });
    await logAudit("purchase_requests", id, patch.status ? `update_status_${patch.status}` : "update", { old_values, new_values }, projectId);
  }
  return { data, error };
}

export async function archivePurchaseRequest(projectId, id) {
  const archivedAt = new Date().toISOString();
  const { data, error } = await supabase.from("purchase_requests").update({ archived_at: archivedAt }).eq("id", id).eq("project_id", projectId).select().single();
  if (!error) await logAudit("purchase_requests", id, "archive", null, projectId);
  return { data, error };
}

export async function listPurchaseRequestItems(purchaseRequestId) {
  return supabase.from("purchase_request_items").select("*").eq("purchase_request_id", purchaseRequestId).order("created_at", { ascending: true });
}

export async function createPurchaseRequestItem(payload) {
  const { data, error } = await supabase.from("purchase_request_items").insert(payload).select().single();
  if (!error) await logAudit("purchase_request_items", data.id, "create", { item_name: payload.item_name }, payload.project_id);
  return { data, error };
}

export async function updatePurchaseRequestItem(projectId, id, patch) {
  const { data, error } = await supabase.from("purchase_request_items").update(patch).eq("id", id).eq("project_id", projectId).select().single();
  if (!error) await logAudit("purchase_request_items", id, "update", patch, projectId);
  return { data, error };
}

// ---------- in-house workflow ----------
export async function getInhouseProductionRequest(purchaseRequestId) {
  return supabase.from("inhouse_production_requests").select("*").eq("purchase_request_id", purchaseRequestId).maybeSingle();
}

// Idempotent: a unique constraint on purchase_request_id means a second
// "Submit to Factory" click can never create a second job order -- this
// checks first and returns the existing row instead of erroring blindly.
export async function submitToFactory(projectId, purchaseRequestId, payload, submittedBy) {
  const { data: existing } = await supabase.from("inhouse_production_requests").select("*").eq("purchase_request_id", purchaseRequestId).maybeSingle();
  if (existing) return { data: existing, error: null, alreadySubmitted: true };
  const job_order_number = await nextSequenceNumber("inhouse_production_requests", "id", "JO");
  const { data, error } = await supabase.from("inhouse_production_requests").insert({
    ...payload, project_id: projectId, purchase_request_id: purchaseRequestId, job_order_number,
    status: "Submitted to Factory", submitted_by: submittedBy || null, submitted_at: new Date().toISOString(),
  }).select().single();
  if (!error) {
    await supabase.from("purchase_requests").update({ status: "In-house Submitted" }).eq("id", purchaseRequestId);
    await logAudit("inhouse_production_requests", data.id, "submit_to_factory", { job_order_number }, projectId);
  }
  return { data, error, alreadySubmitted: false };
}

export async function updateInhouseProductionStatus(projectId, id, patch) {
  const { data: before } = await supabase.from("inhouse_production_requests").select("*").eq("id", id).eq("project_id", projectId).single();
  const { data, error } = await supabase.from("inhouse_production_requests").update(patch).eq("id", id).eq("project_id", projectId).select().single();
  if (!error) {
    const old_values = {}; const new_values = {};
    Object.keys(patch).forEach((k) => { old_values[k] = before ? before[k] : undefined; new_values[k] = patch[k]; });
    await logAudit("inhouse_production_requests", id, "update_status", { old_values, new_values }, projectId);
  }
  return { data, error };
}

// Cross-department read used by the new Factory Job Orders screen -- joins
// enough project/request context for a Factory user with no Interior
// profile to make sense of the list. RLS still applies per-row
// (inhouse_production_requests_scoped); a Factory Head reaches these rows
// via interior_is_org_wide()'s staff_is_dept_head()+HOD-scope check same
// as any other org-wide Interior viewer -- there is no separate Factory-
// side RLS table to maintain.
export async function listAllInhouseProductionRequests() {
  return supabase.from("inhouse_production_requests")
    .select("*, purchase_requests(request_number, project_id, projects(project_code, customer))")
    .order("created_at", { ascending: false }).limit(300);
}

// ---------- outsource workflow ----------
export async function getOutsourceRequirement(purchaseRequestId) {
  return supabase.from("outsource_requirements").select("*").eq("purchase_request_id", purchaseRequestId).maybeSingle();
}

export async function upsertOutsourceRequirement(projectId, purchaseRequestId, patch) {
  const { data: existing } = await supabase.from("outsource_requirements").select("id").eq("purchase_request_id", purchaseRequestId).maybeSingle();
  if (existing) {
    const { data, error } = await supabase.from("outsource_requirements").update(patch).eq("id", existing.id).select().single();
    if (!error) await logAudit("outsource_requirements", existing.id, "update", patch, projectId);
    return { data, error };
  }
  const { data, error } = await supabase.from("outsource_requirements").insert({ ...patch, project_id: projectId, purchase_request_id: purchaseRequestId }).select().single();
  if (!error) await logAudit("outsource_requirements", data.id, "create", { outsource_type: patch.outsource_type }, projectId);
  return { data, error };
}

// ---------- vendor quotations, comparison, selection (restricted) ----------
export async function listVendorQuotations(purchaseRequestId) {
  return supabase.from("vendor_quotations").select("*").eq("purchase_request_id", purchaseRequestId).order("total_landed_cost", { ascending: true });
}

export async function createVendorQuotation(payload, createdBy) {
  const { data, error } = await supabase.from("vendor_quotations").insert({ ...payload, created_by: createdBy || null }).select().single();
  if (!error) await logAudit("vendor_quotations", data.id, "create", { vendor_id: payload.vendor_id, quotation_number: payload.quotation_number }, payload.project_id);
  return { data, error };
}

export async function listPurchaseVendorSelections(purchaseRequestId) {
  return supabase.from("purchase_vendor_selections").select("*").eq("purchase_request_id", purchaseRequestId).order("created_at", { ascending: false });
}

// The lowest-cost vendor is never auto-selected -- the caller always picks;
// this only computes whether the pick WAS the lowest bid, to enforce the
// mandatory-justification rule server-side, not just hide/show a form field.
export async function selectPurchaseVendor(projectId, purchaseRequestId, { selectedQuotationId, selectionReason, approvedAmount, justificationText }, approvedBy) {
  const { data: quotes } = await supabase.from("vendor_quotations").select("id, vendor_id, total_landed_cost").eq("purchase_request_id", purchaseRequestId);
  const selected = (quotes || []).find((q) => q.id === selectedQuotationId);
  if (!selected) return { data: null, error: { message: "Selected quotation not found." } };
  const lowest = (quotes || []).reduce((min, q) => (min === null || q.total_landed_cost < min ? q.total_landed_cost : min), null);
  const isLowest = selected.total_landed_cost === lowest;
  if (!isLowest && !justificationText) {
    return { data: null, error: { message: "A justification is required when the selected vendor is not the lowest bidder." } };
  }
  const { data, error } = await supabase.from("purchase_vendor_selections").insert({
    project_id: projectId, purchase_request_id: purchaseRequestId, selected_vendor_id: selected.vendor_id,
    selected_quotation_id: selectedQuotationId, selection_reason: selectionReason || null, approved_amount: approvedAmount || null,
    approved_by: approvedBy || null, approval_date: new Date().toISOString().slice(0, 10), is_lowest_bid: isLowest, justification_text: justificationText || null,
  }).select().single();
  if (!error) {
    await supabase.from("purchase_requests").update({ status: "Vendor Selected" }).eq("id", purchaseRequestId);
    await logAudit("purchase_vendor_selections", data.id, "select_vendor", { selected_vendor_id: selected.vendor_id, is_lowest_bid: isLowest }, projectId);
  }
  return { data, error };
}

// ---------- approvals (restricted) ----------
export async function listPurchaseApprovals(purchaseRequestId) {
  return supabase.from("purchase_approvals").select("*").eq("purchase_request_id", purchaseRequestId).order("decision_date", { ascending: false });
}

export async function decidePurchaseApproval(projectId, purchaseRequestId, payload, decidedBy) {
  const { data, error } = await supabase.from("purchase_approvals").insert({
    project_id: projectId, purchase_request_id: purchaseRequestId, approval_level: payload.approval_level,
    submitted_by: payload.submitted_by || null, submitted_date: payload.submitted_date || null,
    decided_by: decidedBy || null, decision_date: new Date().toISOString().slice(0, 10), decision: payload.decision,
    approved_amount: payload.approved_amount || null, remarks: payload.remarks || null, conditions: payload.conditions || null,
    proof_storage_path: payload.proof_storage_path || null,
  }).select().single();
  if (!error) {
    if (payload.decision === "Approved") await supabase.from("purchase_requests").update({ status: "Approved" }).eq("id", purchaseRequestId);
    else if (payload.decision === "Rejected") await supabase.from("purchase_requests").update({ status: "Rejected" }).eq("id", purchaseRequestId);
    await logAudit("purchase_approvals", data.id, `decide_${payload.decision}`, { approval_level: payload.approval_level }, projectId);
  }
  return { data, error };
}

// ---------- purchase orders / work orders ----------
export async function listPurchaseOrders(purchaseRequestId) {
  return supabase.from("purchase_orders").select("*").eq("purchase_request_id", purchaseRequestId).order("created_at", { ascending: false });
}

function nextPoVersionNum(versionNumber) {
  return (parseInt(String(versionNumber || "V0").replace(/\D/g, ""), 10) || 0) + 1;
}

// Idempotent against duplicate clicks: purchase_orders_one_current_idx
// (partial unique on purchase_request_id WHERE is_current) means a second
// concurrent insert without first flipping the old one off would violate
// the constraint -- this always flips the prior current PO first, in the
// same statement order as design/drawing "new version" flows.
export async function createPurchaseOrder(projectId, purchaseRequestId, payload, createdBy) {
  const { data: current } = await supabase.from("purchase_orders").select("*").eq("purchase_request_id", purchaseRequestId).eq("is_current", true).maybeSingle();
  if (current) return { data: current, error: null, alreadyExists: true };
  const po_number = await nextSequenceNumber("purchase_orders", "id", payload.order_type === "Work Order" ? "WO" : "PO");
  const { data, error } = await supabase.from("purchase_orders").insert({
    ...payload, project_id: projectId, purchase_request_id: purchaseRequestId, po_number, version_number: "V1",
    is_current: true, created_by: createdBy || null,
  }).select().single();
  if (!error) {
    await supabase.from("purchase_requests").update({ status: "PO Issued" }).eq("id", purchaseRequestId);
    await logAudit("purchase_orders", data.id, "issue", { po_number }, projectId);
  }
  return { data, error, alreadyExists: false };
}

export async function revisePurchaseOrder(projectId, purchaseRequestId, currentPo, payload, createdBy) {
  await supabase.from("purchase_orders").update({ is_current: false }).eq("id", currentPo.id);
  const { data, error } = await supabase.from("purchase_orders").insert({
    ...payload, project_id: projectId, purchase_request_id: purchaseRequestId, vendor_id: currentPo.vendor_id,
    order_type: currentPo.order_type, po_number: currentPo.po_number, version_number: `V${nextPoVersionNum(currentPo.version_number)}`,
    previous_po_id: currentPo.id, is_current: true, created_by: createdBy || null,
  }).select().single();
  if (!error) await logAudit("purchase_orders", data.id, "revise", { po_number: currentPo.po_number, version_number: data.version_number }, projectId);
  return { data, error };
}

export async function acknowledgePurchaseOrder(projectId, id) {
  const ackDate = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.from("purchase_orders").update({ vendor_acknowledgement: true, acknowledgement_date: ackDate }).eq("id", id).eq("project_id", projectId).select().single();
  if (!error) await logAudit("purchase_orders", id, "acknowledge", { acknowledgement_date: ackDate }, projectId);
  return { data, error };
}

// ---------- costing (restricted) ----------
export async function getPurchaseCosting(purchaseRequestId) {
  return supabase.from("purchase_costing").select("*").eq("purchase_request_id", purchaseRequestId).maybeSingle();
}

export async function upsertPurchaseCosting(projectId, purchaseRequestId, patch, userId) {
  const { data: existing } = await supabase.from("purchase_costing").select("id").eq("purchase_request_id", purchaseRequestId).maybeSingle();
  if (existing) {
    const { data, error } = await supabase.from("purchase_costing").update({ ...patch, updated_by: userId || null }).eq("id", existing.id).select().single();
    if (!error) await logAudit("purchase_costing", existing.id, "update", null, projectId);
    return { data, error };
  }
  const { data, error } = await supabase.from("purchase_costing").insert({
    ...patch, project_id: projectId, purchase_request_id: purchaseRequestId, created_by: userId || null, updated_by: userId || null,
  }).select().single();
  if (!error) await logAudit("purchase_costing", data.id, "create", null, projectId);
  return { data, error };
}

// ---------- checklist ----------
export async function listPurchaseChecklistResults(purchaseRequestId) {
  return supabase.from("purchase_checklist_results").select("*").eq("purchase_request_id", purchaseRequestId).eq("is_current", true);
}

export async function listPurchaseChecklistResultHistory(purchaseRequestId, checklistItemId) {
  return supabase.from("purchase_checklist_results").select("*").eq("purchase_request_id", purchaseRequestId).eq("checklist_item_id", checklistItemId).order("created_at", { ascending: false });
}

export async function upsertPurchaseChecklistResult(projectId, purchaseRequestId, checklistItemId, patch, checkedBy) {
  const { data: current } = await supabase.from("purchase_checklist_results").select("*").eq("purchase_request_id", purchaseRequestId).eq("checklist_item_id", checklistItemId).eq("is_current", true).maybeSingle();
  if (current) await supabase.from("purchase_checklist_results").update({ is_current: false }).eq("id", current.id);
  const { data, error } = await supabase.from("purchase_checklist_results").insert({
    project_id: projectId, purchase_request_id: purchaseRequestId, checklist_item_id: checklistItemId,
    status: patch.status, responsible_person: patch.responsible_person || null, due_date: patch.due_date || null,
    checked_by: checkedBy || null, checked_date: patch.checked_date || new Date().toISOString().slice(0, 10),
    remarks: patch.remarks || null, proof_storage_path: patch.proof_storage_path || null, reopen_reason: patch.reopen_reason || null,
    previous_result_id: current?.id || null, is_current: true,
  }).select().single();
  if (!error) {
    await logAudit("purchase_checklist_results", data.id, patch.reopen_reason ? "reopen" : "update_status",
      { old_values: { status: current?.status || null }, new_values: { status: patch.status } }, projectId);
  }
  return { data, error };
}

// ---------- vendor follow-up ----------
export async function listVendorFollowups(purchaseRequestId) {
  return supabase.from("vendor_followups").select("*").eq("purchase_request_id", purchaseRequestId).order("follow_up_date", { ascending: false });
}

export async function createVendorFollowup(payload, createdBy) {
  const { data, error } = await supabase.from("vendor_followups").insert({ ...payload, created_by: createdBy || null }).select().single();
  if (!error) await logAudit("vendor_followups", data.id, "follow_up", { escalation_status: payload.escalation_status }, payload.project_id);
  return { data, error };
}

// ---------- GRN / QC ----------
export async function listPurchaseReceipts(purchaseRequestId) {
  return supabase.from("purchase_receipts").select("*").eq("purchase_request_id", purchaseRequestId).order("receipt_date", { ascending: false });
}

export async function createPurchaseReceipt(projectId, purchaseRequestId, payload, createdBy) {
  const grn_number = await nextSequenceNumber("purchase_receipts", "id", "GRN");
  const { data, error } = await supabase.from("purchase_receipts").insert({
    ...payload, project_id: projectId, purchase_request_id: purchaseRequestId, grn_number, created_by: createdBy || null,
  }).select().single();
  if (!error) {
    // A QC failure never marks the purchase completed -- it flips the
    // request back to a QC-attention status instead of letting it drift
    // toward Completed with a failed receipt sitting underneath it.
    if (payload.qc_status === "Failed") {
      await supabase.from("purchase_requests").update({ status: "QC Pending" }).eq("id", purchaseRequestId);
    }
    await logAudit("purchase_receipts", data.id, "grn_recorded", { grn_number, qc_status: payload.qc_status }, projectId);
  }
  return { data, error };
}

// ---------- payment coordination ----------
// isOrgWide gates the one restricted column (payment_reference) at the API
// layer -- the row itself is readable by any project member per RLS
// (purchase_payment_coordination_scoped), matching the spec's own "show
// operational status, hide vendor-payment reference" instruction.
export async function listPurchasePaymentCoordination(purchaseRequestId, isOrgWide) {
  const cols = isOrgWide
    ? "*"
    : "id, project_id, purchase_request_id, invoice_number, invoice_date, invoice_amount, tax_amount, payment_type, advance_amount, paid_amount, pending_amount, due_date, status, payment_request_date, submitted_to_accounts, accounts_acknowledgement, retention_amount, deduction, deduction_reason, final_settlement_status, created_at, updated_at";
  return supabase.from("purchase_payment_coordination").select(cols).eq("purchase_request_id", purchaseRequestId).order("created_at", { ascending: false });
}

export async function createPurchasePaymentCoordination(payload, createdBy) {
  const { data, error } = await supabase.from("purchase_payment_coordination").insert({ ...payload, created_by: createdBy || null }).select().single();
  if (!error) await logAudit("purchase_payment_coordination", data.id, "create", { invoice_number: payload.invoice_number }, payload.project_id);
  return { data, error };
}

export async function updatePurchasePaymentCoordination(projectId, id, patch) {
  const { data, error } = await supabase.from("purchase_payment_coordination").update(patch).eq("id", id).eq("project_id", projectId).select().single();
  if (!error) await logAudit("purchase_payment_coordination", id, patch.status ? `update_status_${patch.status}` : "update", patch, projectId);
  return { data, error };
}

// ---------- attachments ----------
export async function uploadPurchaseAttachment({ projectId, purchaseRequestId, module, lineItemId, vendorId, purchaseOrderId, file, fileCategory, description, uploadedBy }) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-140);
  const path = `projects/${projectId}/purchase-management/${purchaseRequestId}/${module}/${crypto.randomUUID()}-${safeName}`;
  const { error: uploadError } = await supabase.storage.from("interior-attachments").upload(path, file);
  if (uploadError) return { data: null, error: uploadError };
  const { data, error } = await supabase.from("purchase_attachments").insert({
    project_id: projectId, purchase_request_id: purchaseRequestId, line_item_id: lineItemId || null,
    vendor_id: vendorId || null, purchase_order_id: purchaseOrderId || null, module, file_category: fileCategory || "Other",
    file_name: file.name, original_file_name: file.name, storage_path: path, file_type: file.type, file_size: file.size,
    description: description || null, uploaded_by: uploadedBy || null,
  }).select().single();
  if (!error) await logAudit("purchase_attachments", data.id, "upload", { module, file_category: fileCategory }, projectId);
  return { data, error };
}

export async function listPurchaseAttachments(purchaseRequestId, module) {
  let q = supabase.from("purchase_attachments").select("*").eq("purchase_request_id", purchaseRequestId).order("uploaded_at", { ascending: false });
  if (module) q = q.eq("module", module);
  return q;
}

export async function listPurchaseAttachmentsForProject(projectId) {
  return supabase.from("purchase_attachments").select("*").eq("project_id", projectId).order("uploaded_at", { ascending: false });
}

export async function deletePurchaseAttachment(projectId, id) {
  const { error } = await supabase.from("purchase_attachments").delete().eq("id", id).eq("project_id", projectId);
  if (!error) await logAudit("purchase_attachments", id, "delete", null, projectId);
  return { error };
}
