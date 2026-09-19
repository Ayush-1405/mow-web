import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { uploadTaskProof, downloadTaskProof, resolveMimeType, uploadTaskMessageFile, downloadTaskMessageFile } from "../lib/api";
import { t } from "../lib/i18n";
import { subscribeTable, upsertById } from "../lib/realtime";
import { listProjects } from "../lib/interiorApi";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import VoiceRecorder from "./VoiceRecorder.jsx";

// Shared accountability-timeline + reassign UI used by both TodayTasks and
// Bridges (a Bridge IS a staff_tasks row underneath — same shape). Every
// field rendered here already exists on the staff_tasks row returned by
// `select *` (accepted_at/started_at/completed_at/verified_at/closed_at/
// return_reason/previous_owner_id) — this only makes them visible; it does
// not read or write anything new.
function userLabel(usersById, id) {
  if (!id) return "—";
  const u = usersById[id];
  return u ? `${u.full_name} (${u.employee_code})` : "—";
}

export const TaskTimeline = React.memo(function TaskTimeline({ task, usersById, lang, assignees }) {
  // Second Assignee: one extra row per active assignee, sourced from their
  // own staff_task_assignees.assigned_at — purely additive alongside the
  // existing created_at/accepted_at/.../closed_at rows below, never
  // replacing them (assigned_by/verified_by/closed_by stay whole-task facts).
  const assigneeRows = (assignees || []).map((a) => ({
    label: a.assignment_role === "primary" ? t("primaryAssigneeLabel", lang) : t("secondAssigneeShortLabel", lang),
    value: userLabel(usersById, a.user_id),
    time: a.assigned_at,
  }));
  // Shared-task lifecycle (mvp_pilot_shared_task_status_v2_60): each
  // milestone now names WHICH active assignee actually performed it —
  // any one of them, immediately shared by everyone — instead of a bare
  // timestamp with no actor.
  const rows = [
    { label: t("createdBy", lang), value: userLabel(usersById, task.assigned_by), time: task.created_at },
    ...assigneeRows,
    { label: t("acceptedByLabel", lang), value: userLabel(usersById, task.accepted_by), time: task.accepted_at },
    { label: t("startedByLabel", lang), value: userLabel(usersById, task.started_by), time: task.started_at },
    { label: t("onHoldReasonLabel", lang), value: task.hold_reason ? `${userLabel(usersById, task.held_by)} — ${task.hold_reason}` : userLabel(usersById, task.held_by), time: task.held_at },
    { label: t("completedByLabel", lang), value: userLabel(usersById, task.completed_by), time: task.completed_at },
    { label: t("verifiedAt", lang), value: userLabel(usersById, task.verified_by), time: task.verified_at },
    { label: t("reopenReasonLabel", lang), value: task.reopen_reason ? `${userLabel(usersById, task.reopened_by)} — ${task.reopen_reason}` : userLabel(usersById, task.reopened_by), time: task.reopened_at },
    { label: t("closedAt", lang), value: userLabel(usersById, task.closed_by), time: task.closed_at },
  ].filter((r) => r.time);

  return (
    <div className="timeline">
      {rows.map((r, i) => (
        <div className="timeline-item" key={i}>
          <span className="timeline-label">{r.label}</span>
          <span className="timeline-time">{new Date(r.time).toLocaleString()}</span>
          {r.value && <span className="timeline-value">{r.value}</span>}
        </div>
      ))}
      {task.return_reason && (
        <div className="timeline-item">
          <span className="timeline-label">{t("returnedReason", lang)}</span>
          <span className="timeline-value">{task.return_reason}</span>
        </div>
      )}
      {task.previous_owner_id && (
        <div className="timeline-item">
          <span className="timeline-label">{t("previousOwner", lang)}</span>
          <span className="timeline-value">{userLabel(usersById, task.previous_owner_id)}</span>
        </div>
      )}
      {rows.length === 0 && !task.return_reason && (
        <div className="timeline-item">
          <span className="timeline-value">—</span>
        </div>
      )}
    </div>
  );
});

// Second Assignee: "Assigned Team" section -- who is on this shared task
// and their role. mvp_pilot_shared_task_status_v2_60 moved the actual
// lifecycle (accepted/started/completed by whom, and when) onto the task
// itself, shown once in TaskTimeline above -- there is no more per-row
// "Pending Acceptance"/"Partially Accepted" text here, since acceptance is
// no longer a per-person thing to wait on. Read-only display; status
// changes happen via the shared action buttons on the task card
// (TodayTasks.jsx), never from here.
export const AssignedTeamSection = React.memo(function AssignedTeamSection({ assignees, usersById, lang }) {
  if (!assignees || assignees.length === 0) return null;
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="section-title" style={{ fontSize: 14 }}>{t("assignedTeamLabel", lang)}</div>
      {assignees.map((a) => (
        <div key={a.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700 }}>{userLabel(usersById, a.user_id)}</span>
          <span className="sub">{a.assignment_role === "primary" ? t("primaryAssigneeLabel", lang) : t("secondAssigneeShortLabel", lang)}</span>
        </div>
      ))}
    </div>
  );
});

// Project/Site Information (Interior Projects Department). Read-only
// display of the exact project a task is linked to (never free-text —
// always resolved live from staff_tasks.project_id via `projectsById`,
// the same RLS-scoped rows AssignTask.jsx's dropdown already trusts), plus
// a "View Full Project" deep link and, for authorized users only, a
// "Change Project/Site" correction form backed by the secure
// staff_change_task_project RPC (mandatory reason, full audit trail,
// notifies every active participant — this component only collects the
// two inputs the RPC needs).
//
// `projectsById`/`profilesById` are loaded once by the parent screen
// (TodayTasks/Bridges) and shared across every visible task card, so
// opening a second task's Details never re-fetches the same rows.
export const ProjectSiteSection = React.memo(function ProjectSiteSection({ task, lang, profile, projectsById, profilesById, showToast, onChanged }) {
  const navigate = useNavigate();
  const [changing, setChanging] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const [search, setSearch] = useState("");
  const [newProjectId, setNewProjectId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const project = task.project_id ? projectsById[task.project_id] : null;
  const personName = (id) => (id ? profilesById?.[id]?.name : null) || "—";

  const canChange = profile.isManagement || profile.isSuperAdmin || profile.isDeptHead || task.assigned_by === profile.id;
  if (!task.project_id && !canChange) return null;

  async function startChange() {
    setChanging(true);
    if (candidates.length === 0) {
      const { data, error } = await listProjects();
      if (!error) setCandidates(data || []);
    }
  }

  const searchLower = search.trim().toLowerCase();
  const filtered = candidates.filter((p) => {
    if (!searchLower) return true;
    const lead = personName(p.lead_executive_id);
    const ea = personName(p.executive_assistant_id);
    return [p.project_code, p.customer, p.location, lead, ea].filter(Boolean).some((v) => v.toLowerCase().includes(searchLower));
  });

  async function submitChange() {
    if (!newProjectId || !reason.trim()) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("staff_change_task_project", {
        p_task_id: task.id,
        p_new_project_id: newProjectId,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      showToast("success", t("statusUpdated", lang));
      setChanging(false);
      setNewProjectId("");
      setReason("");
      if (onChanged) onChanged();
    } catch (err) {
      showToast("error", err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="section-title" style={{ fontSize: 14 }}>{t("projectSiteInfoTitle", lang)}</div>

      {project ? (
        <div className="task-meta" style={{ marginTop: 0, flexWrap: "wrap" }}>
          <span><strong>{t("projectCodeFullLabel", lang)}:</strong> {project.project_code}</span>
          <span><strong>{t("clientNameLabel", lang)}:</strong> {project.customer}</span>
          {project.location && <span><strong>{t("siteLocationLabel", lang)}:</strong> {project.location}</span>}
          <span><strong>{t("leadExecutiveLabel", lang)}:</strong> {personName(project.lead_executive_id)}</span>
          <span><strong>{t("executiveAssistantLabel", lang)}:</strong> {personName(project.executive_assistant_id)}</span>
          {project.stage && <span><strong>{t("projectStageLabel", lang)}:</strong> {project.stage}</span>}
          <span><strong>{t("projectStatusLabel", lang)}:</strong> {project.archived ? t("archivedStatusLabel", lang) : t("active", lang)}</span>
        </div>
      ) : (
        <div className="msg info">{t("generalInteriorTaskLabel", lang)}</div>
      )}

      <div className="btn-row">
        {project && (
          <button className="btn btn-outline" onClick={() => navigate(`/interior-projects/detail/${project.id}`)}>
            {t("viewFullProjectAction", lang)}
          </button>
        )}
        {canChange && !changing && (
          <button className="btn btn-outline" onClick={startChange}>{t("changeProjectSiteAction", lang)}</button>
        )}
      </div>

      {changing && (
        <div style={{ marginTop: 10 }}>
          <label>{t("selectProjectSiteLabel", lang)} *</label>
          <input type="text" placeholder={t("searchProjectPlaceholder", lang)} value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={newProjectId} onChange={(e) => setNewProjectId(e.target.value)}>
            <option value="" disabled>—</option>
            {filtered.map((p) => (
              <option key={p.id} value={p.id}>{p.project_code} — {p.customer}{p.location ? ` — ${p.location}` : ""}</option>
            ))}
          </select>
          <label>{t("changeProjectReasonLabel", lang)} *</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="btn-row">
            <button className="btn btn-primary" disabled={busy || !newProjectId || !reason.trim()} onClick={submitChange}>
              {t("submit", lang)}
            </button>
            <button className="btn btn-outline" onClick={() => { setChanging(false); setNewProjectId(""); setReason(""); }}>
              {t("cancel", lang)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

// Maps a browser File's mime type to the file_type value staff_record_
// attachment/staff-file-url actually accept (mirrors MIME_WHITELIST in the
// staff-file-url Edge Function) — server-side validation is still the real
// enforcement boundary; this only decides what the client attempts.
export function detectFileType(mimeType) {
  if (["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(mimeType)) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (["application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(mimeType)) return "word";
  if (["application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(mimeType)) return "excel";
  if (["application/dxf", "application/dwg", "image/vnd.dwg", "image/vnd.dxf", "application/x-dwg", "application/x-dxf", "application/acad"].includes(mimeType)) return "drawing";
  return null;
}

// Lists existing staff_attachments for a task (entity_type is always
// 'task' — a Bridge IS a staff_tasks row underneath, so its attachments
// live under the same task id) via the normal RLS-scoped client
// (staff_attachments_select_matches_parent decides visibility), plus a
// generic "attach a file" control usable any time — not only at Complete,
// unlike the existing photo-proof uploader on TodayTasks.
export const AttachmentsList = React.memo(function AttachmentsList({ taskId, lang, showToast, usersById }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [playing, setPlaying] = useState(null);
  const [voiceKey, setVoiceKey] = useState(0);
  const [thumbUrls, setThumbUrls] = useState({});
  const [lightboxUrl, setLightboxUrl] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("staff_attachments")
      .select("*")
      .eq("entity_type", "task")
      .eq("entity_id", taskId)
      .eq("is_active", true)
      .order("created_at", { ascending: false });
    if (error) showToast("error", error.message);
    else setItems(data || []);
    setLoading(false);
  }, [taskId, showToast]);

  useEffect(() => { load(); }, [load]);

  // "Completion Proof" thumbnails — one signed URL per image attachment,
  // fetched lazily and best-effort (a failure here just means no inline
  // thumbnail; the Download button below still works independently).
  useEffect(() => {
    const missing = items.filter((a) => a.file_type === "image" && !thumbUrls[a.id]);
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      for (const a of missing) {
        try {
          const res = await downloadTaskProof(a.id);
          if (!cancelled) setThumbUrls((cur) => ({ ...cur, [a.id]: res.signed_url }));
        } catch { /* best-effort thumbnail only */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  async function handleUpload(file) {
    if (!file) return;
    const fileType = detectFileType(resolveMimeType(file));
    if (!fileType) {
      showToast("error", "Unsupported file type. / અસમર્થિત ફાઇલ પ્રકાર.");
      return;
    }
    setUploading(true);
    try {
      await uploadTaskProof({ entityType: "task", entityId: taskId, file, fileType });
      await load();
    } catch (err) {
      showToast("error", err.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleDownload(attachmentId) {
    try {
      const res = await downloadTaskProof(attachmentId);
      window.open(res.signed_url, "_blank", "noopener,noreferrer");
    } catch (err) {
      showToast("error", err.message);
    }
  }

  // Voice attachments play inline instead of downloading — the signed URL
  // is fetched on demand (it's short-lived, so nothing is pre-fetched for
  // attachments the viewer hasn't asked to hear).
  async function handlePlay(attachment) {
    if (playing?.id === attachment.id) {
      setPlaying(null);
      return;
    }
    try {
      const res = await downloadTaskProof(attachment.id);
      setPlaying({ id: attachment.id, url: res.signed_url });
    } catch (err) {
      showToast("error", err.message);
    }
  }

  async function handleVoiceRecorded(file, durationSeconds) {
    if (!file) return;
    setUploading(true);
    try {
      await uploadTaskProof({ entityType: "task", entityId: taskId, file, fileType: "voice", durationSeconds });
      setVoiceKey((k) => k + 1);
      await load();
    } catch (err) {
      showToast("error", err.message);
    } finally {
      setUploading(false);
    }
  }

  const imageItems = items.filter((a) => a.file_type === "image");

  return (
    <div style={{ marginTop: 10 }}>
      <label>{t("attachments", lang)}</label>
      {loading && <div className="msg info">…</div>}
      {!loading && items.length === 0 && <div className="msg info">{t("noAttachments", lang)}</div>}

      {imageItems.length > 0 && (
        <div className="proof-thumb-grid">
          {imageItems.map((a) => (
            <button
              key={a.id}
              type="button"
              className="proof-thumb"
              onClick={() => (thumbUrls[a.id] ? setLightboxUrl(thumbUrls[a.id]) : handleDownload(a.id))}
              title={a.original_filename}
            >
              {thumbUrls[a.id] ? <img src={thumbUrls[a.id]} alt={a.original_filename} /> : "…"}
            </button>
          ))}
        </div>
      )}

      {items.map((a) => (
        <div key={a.id}>
          <div className="notif-row">
            <div>
              <div className="n-title">{a.file_type === "voice" ? `🎙️ ${t("voiceNote", lang)}` : a.original_filename}</div>
              <div className="n-time">
                {new Date(a.created_at).toLocaleString()}{a.duration_seconds ? ` · ${a.duration_seconds}s` : ""}
                {usersById?.[a.uploaded_by]?.full_name ? ` · ${t("uploadedByLabel", lang)}: ${usersById[a.uploaded_by].full_name}` : ""}
              </div>
            </div>
            {a.file_type === "voice" ? (
              <button
                className="btn btn-outline"
                style={{ width: "auto", margin: 0, minHeight: 36, padding: "6px 10px" }}
                onClick={() => handlePlay(a)}
              >
                {playing?.id === a.id ? t("hideDetails", lang) : `▶ ${t("play", lang)}`}
              </button>
            ) : (
              <button
                className="btn btn-outline"
                style={{ width: "auto", margin: 0, minHeight: 36, padding: "6px 10px" }}
                onClick={() => handleDownload(a.id)}
              >
                {t("download", lang)}
              </button>
            )}
          </div>
          {playing?.id === a.id && (
            <audio controls autoPlay src={playing.url} style={{ width: "100%", marginTop: -4, marginBottom: 8 }} />
          )}
        </div>
      ))}

      <VoiceRecorder key={voiceKey} lang={lang} disabled={uploading} onRecorded={handleVoiceRecorded} />

      <label className="file-input-label">
        {uploading ? t("uploading", lang) : t("attachFile", lang)}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.dwg,.dxf,application/dxf,application/dwg,image/vnd.dwg,image/vnd.dxf,application/x-dwg,application/x-dxf,application/acad"
          style={{ display: "none" }}
          disabled={uploading}
          onChange={(e) => { handleUpload(e.target.files?.[0] || null); e.target.value = ""; }}
        />
      </label>

      {lightboxUrl && (
        <div className="proof-lightbox" onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} alt="" />
        </div>
      )}
    </div>
  );
});

// Reassign panel. Calls staff_reassign_task via onSubmit(payload) — the RPC
// itself is the authorization boundary (Management or the authorized Dept
// Head only); this form just collects the fields it needs.
//
// To Department defaults to the task's current to_department_id and is
// editable — picking a different department (loaded from the same
// staff_list_assignable_departments RPC AssignTask.jsx uses) lets an
// existing task be handed to an employee in another department entirely.
// The RPC creates or updates the matching Bridge row itself when the
// department actually changes; this form just requires a new assignee
// whenever a different department is picked, since the old assignee can't
// belong to it.
export const ReassignPanel = React.memo(function ReassignPanel({ task, candidates, lang, busy, onSubmit, onCancel }) {
  const [departments, setDepartments] = useState([]);
  const [toDepartment, setToDepartment] = useState(task.to_department_id);
  const [newAssignee, setNewAssignee] = useState("");
  const [newVerifier, setNewVerifier] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    let cancelled = false;
    supabase.rpc("staff_list_assignable_departments").then(({ data, error }) => {
      if (!cancelled && !error) setDepartments(data || []);
    });
    return () => { cancelled = true; };
  }, []);

  const departmentChanged = toDepartment !== task.to_department_id;
  const deptCandidates = candidates.filter((u) => u.department_id === toDepartment);

  function selectDepartment(deptId) {
    setToDepartment(deptId);
    setNewAssignee("");
    setNewVerifier("");
  }

  function submit(e) {
    e.preventDefault();
    if (!reason.trim()) return;
    if (departmentChanged && !newAssignee) return;
    onSubmit({
      p_task_id: task.id,
      p_reason: reason.trim(),
      p_new_assigned_to: newAssignee || null,
      p_new_verifier_id: newVerifier || null,
      p_new_to_department_id: departmentChanged ? toDepartment : null,
    });
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 10 }}>
      <label>{t("toDepartment", lang)}</label>
      <select value={toDepartment} onChange={(e) => selectDepartment(e.target.value)}>
        {departments.map((d) => (
          <option key={d.id} value={d.id}>{lang === "gu" ? d.name_gu : d.name_en}</option>
        ))}
      </select>
      {departmentChanged && (
        <div className="msg info" style={{ marginTop: 8 }}>🌉 {t("willCreateBridge", lang)}</div>
      )}

      <label>{t("newAssignee", lang)} {departmentChanged && "*"}</label>
      <select value={newAssignee} onChange={(e) => setNewAssignee(e.target.value)} required={departmentChanged}>
        <option value="">{departmentChanged ? "—" : t("keepSame", lang)}</option>
        {deptCandidates.map((u) => (
          <option key={u.id} value={u.id}>{u.full_name} ({u.employee_code})</option>
        ))}
      </select>

      <label>{t("newVerifier", lang)}</label>
      <select value={newVerifier} onChange={(e) => setNewVerifier(e.target.value)}>
        <option value="">{t("keepSame", lang)}</option>
        {deptCandidates.map((u) => (
          <option key={u.id} value={u.id}>{u.full_name} ({u.employee_code})</option>
        ))}
      </select>

      <label>{t("reassignReason", lang)} *</label>
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} required />

      <div className="btn-row">
        <button className="btn btn-primary" type="submit" disabled={busy || (departmentChanged && !newAssignee)}>
          {t("submit", lang)}
        </button>
        <button className="btn btn-outline" type="button" onClick={onCancel}>
          {t("cancel", lang)}
        </button>
      </div>
    </form>
  );
});

function formatFileSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MESSAGE_DOCUMENT_ACCEPT = "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/jpeg,image/png,image/webp,image/heic,image/heif,.dwg,.dxf,application/dxf,application/dwg,image/vnd.dwg,image/vnd.dxf,application/x-dwg,application/x-dxf,application/acad";

// Task-wise Reply / Conversation. Reads/writes public.task_messages through
// the normal RLS-scoped client + the staff_send_task_message/
// staff_edit_task_message/staff_delete_task_message/
// staff_mark_task_messages_read RPCs — task_messages_select_scoped (backed
// by staff_task_visible, now fixed to include Second Assignees) is the
// actual authorization boundary; an unrelated employee changing the task
// id in the URL gets an empty list here, not someone else's conversation.
//
// `usersById` is the SAME staff_list_assignable_users_all()-backed lookup
// TodayTasks/Bridges already load for the timeline — reused here for
// sender name + role, no extra query. `highlightMessageId` (from a
// notification's ?message= deep link) scrolls to and briefly highlights
// that one message once it's loaded.
export const TaskConversation = React.memo(function TaskConversation({ taskId, lang, profile, usersById, showToast, highlightMessageId }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState("");
  const [pendingFile, setPendingFile] = useState(null);
  const [pendingFileType, setPendingFileType] = useState(null);
  const [pendingVoice, setPendingVoice] = useState(null);
  const [pendingVoiceDuration, setPendingVoiceDuration] = useState(0);
  const [voiceKey, setVoiceKey] = useState(0);
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [playing, setPlaying] = useState(null);
  const [search, setSearch] = useState("");
  const highlightedRef = useRef(null);
  const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("task_messages")
      .select("*")
      .eq("task_id", taskId)
      .order("created_at", { ascending: true });
    if (error) showToast("error", error.message);
    else setMessages(data || []);
    setLoading(false);
  }, [taskId, showToast]);

  useEffect(() => { load(); }, [load]);

  // Opening this component IS "reading" this task's conversation — mark
  // read once on mount, and again whenever a message from someone else
  // arrives while it's still open. Never marks read for anyone but the
  // caller themselves (their own RPC call, their own row).
  const markRead = useCallback(() => {
    supabase.rpc("staff_mark_task_messages_read", { p_task_id: taskId });
  }, [taskId]);

  useEffect(() => {
    markRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    return subscribeTable(`task_messages_${taskId}`, "task_messages", `task_id=eq.${taskId}`, (payload) => {
      const row = payload.new;
      if (!row) return;
      setMessages((cur) => upsertById(cur, row));
      if (row.sender_id !== profile.id) markRead();
    });
  }, [taskId, profile.id, markRead]);

  useEffect(() => {
    if (!highlightMessageId || highlightedRef.current === highlightMessageId) return;
    if (!messages.some((m) => m.id === highlightMessageId)) return;
    highlightedRef.current = highlightMessageId;
    requestAnimationFrame(() => {
      document.getElementById(`msg-${highlightMessageId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [messages, highlightMessageId]);

  function displayName(id) {
    if (id === profile.id) return profile.full_name || usersById[id]?.full_name || "—";
    return usersById[id]?.full_name || "—";
  }
  function displayRole(id) {
    const u = usersById[id];
    if (!u) return "";
    return lang === "gu" ? u.role_label_gu : u.role_label_en;
  }

  function handleFileChange(file) {
    if (!file) return;
    const fileType = detectFileType(resolveMimeType(file)) || "drawing";
    setPendingFile(file);
    setPendingFileType(fileType);
    setPendingVoice(null);
    setPendingVoiceDuration(0);
  }

  function handleVoiceRecorded(file, durationSeconds) {
    setPendingVoice(file);
    setPendingVoiceDuration(durationSeconds || 0);
    if (file) {
      setPendingFile(null);
      setPendingFileType(null);
    }
  }

  const trimmedText = replyText.trim();
  const canSend = !sending && (trimmedText !== "" || !!pendingFile || !!pendingVoice);

  async function send() {
    if (!canSend) return;
    setSending(true);
    try {
      let metadata = null;
      if (pendingFile) {
        metadata = await uploadTaskMessageFile({ taskId, file: pendingFile, fileType: pendingFileType });
      } else if (pendingVoice) {
        metadata = await uploadTaskMessageFile({ taskId, file: pendingVoice, fileType: "voice", durationSeconds: pendingVoiceDuration });
      }
      const { data, error } = await supabase.rpc("staff_send_task_message", {
        p_task_id: taskId,
        p_message_text: trimmedText || null,
        p_reply_to_message_id: replyTo?.id || null,
        p_attachment_metadata: metadata,
      });
      if (error) throw error;
      setMessages((cur) => upsertById(cur, Array.isArray(data) ? data[0] : data));
      setReplyText("");
      setPendingFile(null);
      setPendingFileType(null);
      setPendingVoice(null);
      setPendingVoiceDuration(0);
      setVoiceKey((k) => k + 1);
      setReplyTo(null);
      showToast("success", t("messageSentLabel", lang));
    } catch (err) {
      showToast("error", err.message);
    } finally {
      setSending(false);
    }
  }

  async function saveEdit(messageId) {
    const text = editText.trim();
    if (!text) return;
    try {
      const { error } = await supabase.rpc("staff_edit_task_message", { p_message_id: messageId, p_new_text: text });
      if (error) throw error;
      setEditingId(null);
      setEditText("");
      await load();
    } catch (err) {
      showToast("error", err.message);
    }
  }

  async function confirmDelete(messageId) {
    if (!deleteReason.trim()) return;
    try {
      const { error } = await supabase.rpc("staff_delete_task_message", { p_message_id: messageId, p_reason: deleteReason.trim() });
      if (error) throw error;
      setDeleteConfirmId(null);
      setDeleteReason("");
      await load();
    } catch (err) {
      showToast("error", err.message);
    }
  }

  async function handleDownloadAttachment(m) {
    try {
      const res = await downloadTaskMessageFile(m.id);
      window.open(res.signed_url, "_blank", "noopener,noreferrer");
    } catch (err) {
      showToast("error", err.message);
    }
  }

  async function handlePlayVoice(m) {
    if (playing?.id === m.id) {
      setPlaying(null);
      return;
    }
    try {
      const res = await downloadTaskMessageFile(m.id);
      setPlaying({ id: m.id, url: res.signed_url });
    } catch (err) {
      showToast("error", err.message);
    }
  }

  // Debounced: the input itself stays instantly responsive (bound to
  // `search`), but the filter recomputation only re-runs ~250ms after
  // typing pauses, so a long conversation doesn't re-filter on every
  // keystroke.
  const debouncedSearch = useDebouncedValue(search, 250);
  const searchLower = debouncedSearch.trim().toLowerCase();
  const visibleMessages = messages.filter((m) => {
    if (!searchLower) return true;
    return (m.message_text || "").toLowerCase().includes(searchLower);
  });

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="section-title" style={{ fontSize: 14 }}>{t("taskConversationTitle", lang)}</div>

      <input
        type="text"
        placeholder={t("searchConversationPlaceholder", lang)}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 8 }}
      />

      {loading && <div className="msg info">…</div>}
      {!loading && visibleMessages.length === 0 && (
        <div className="msg info">{searchLower ? t("noSearchResultsMsg", lang) : t("emptyConversationMsg", lang)}</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 420, overflowY: "auto" }}>
        {visibleMessages.map((m) => {
          const mine = m.sender_id === profile.id;
          const isSystem = m.message_type === "system";
          const quoted = m.reply_to_message_id ? messagesById[m.reply_to_message_id] : null;
          const canEditThis = mine && !isSystem && !m.is_deleted && (Date.now() - new Date(m.created_at).getTime()) < 15 * 60 * 1000;
          const canDeleteThis = !isSystem && !m.is_deleted && (mine || profile.isManagement || profile.isSuperAdmin || profile.isDeptHead);

          if (isSystem) {
            return (
              <div key={m.id} id={`msg-${m.id}`} style={{ textAlign: "center", fontSize: 12, opacity: 0.7, padding: "2px 0" }}>
                🔔 {m.message_text} · {new Date(m.created_at).toLocaleString()}
              </div>
            );
          }

          return (
            <div
              key={m.id}
              id={`msg-${m.id}`}
              style={{
                alignSelf: mine ? "flex-end" : "flex-start",
                maxWidth: "85%",
                background: mine ? "#fff4dd" : "#f4f1ea",
                border: highlightMessageId === m.id ? "2px solid #c9971f" : "1px solid #e2dccb",
                borderRadius: 10,
                padding: "8px 10px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, fontWeight: 700 }}>
                <span>{displayName(m.sender_id)}</span>
                {displayRole(m.sender_id) && <span className="sub" style={{ fontWeight: 400 }}>{displayRole(m.sender_id)}</span>}
              </div>

              {m.reply_to_message_id && (
                <div style={{ fontSize: 11, opacity: 0.75, borderLeft: "3px solid #c9971f", paddingLeft: 6, margin: "4px 0" }}>
                  {quoted && !quoted.is_deleted ? (
                    <>{t("replyingToLabel", lang)} {displayName(quoted.sender_id)}: “{(quoted.message_text || "").slice(0, 80)}”</>
                  ) : (
                    <em>{t("originalMessageRemovedLabel", lang)}</em>
                  )}
                </div>
              )}

              {m.is_deleted ? (
                <div style={{ fontStyle: "italic", fontSize: 13, opacity: 0.7 }}>{t("messageRemovedLabel", lang)}</div>
              ) : editingId === m.id ? (
                <div>
                  <textarea value={editText} onChange={(e) => setEditText(e.target.value)} style={{ width: "100%" }} />
                  <div className="btn-row">
                    <button className="btn btn-primary" onClick={() => saveEdit(m.id)}>{t("saveEditAction", lang)}</button>
                    <button className="btn btn-outline" onClick={() => { setEditingId(null); setEditText(""); }}>{t("cancelEditAction", lang)}</button>
                  </div>
                </div>
              ) : (
                <>
                  {m.message_text && <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{m.message_text}</div>}
                  {m.message_type === "attachment" && m.attachment_path && (
                    <div className="notif-row" style={{ marginTop: 4 }}>
                      <div>
                        <div className="n-title">📎 {m.attachment_name}</div>
                        <div className="n-time">{m.attachment_type} · {formatFileSize(m.attachment_size)}</div>
                      </div>
                      <button className="btn btn-outline" style={{ width: "auto", margin: 0, minHeight: 32, padding: "4px 8px" }} onClick={() => handleDownloadAttachment(m)}>
                        {t("download", lang)}
                      </button>
                    </div>
                  )}
                  {m.message_type === "voice" && m.voice_path && (
                    <div style={{ marginTop: 4 }}>
                      <button className="btn btn-outline" style={{ width: "auto", margin: 0, minHeight: 32, padding: "4px 8px" }} onClick={() => handlePlayVoice(m)}>
                        {playing?.id === m.id ? t("hideDetails", lang) : `▶ ${t("voiceReplyLabel", lang)}`}
                        {m.voice_duration_seconds ? ` · ${m.voice_duration_seconds}s` : ""}
                      </button>
                      {playing?.id === m.id && (
                        <audio controls autoPlay src={playing.url} style={{ width: "100%", marginTop: 4 }} />
                      )}
                    </div>
                  )}
                </>
              )}

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                <span className="n-time">
                  {new Date(m.created_at).toLocaleString()}
                  {m.is_edited && !m.is_deleted && ` · ${t("editedLabel", lang)}`}
                </span>
                {!m.is_deleted && (
                  <span style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-outline" style={{ width: "auto", margin: 0, minHeight: 26, padding: "2px 8px", fontSize: 11 }} onClick={() => setReplyTo(m)}>
                      {t("replyToMessageAction", lang)}
                    </button>
                    {canEditThis && (
                      <button className="btn btn-outline" style={{ width: "auto", margin: 0, minHeight: 26, padding: "2px 8px", fontSize: 11 }} onClick={() => { setEditingId(m.id); setEditText(m.message_text || ""); }}>
                        {t("editMessageAction", lang)}
                      </button>
                    )}
                    {canDeleteThis && (
                      <button className="btn btn-outline" style={{ width: "auto", margin: 0, minHeight: 26, padding: "2px 8px", fontSize: 11 }} onClick={() => setDeleteConfirmId(m.id)}>
                        {t("deleteMessageAction", lang)}
                      </button>
                    )}
                  </span>
                )}
              </div>

              {deleteConfirmId === m.id && (
                <div className="msg error" style={{ marginTop: 6 }}>
                  {t("confirmRemoveMessageMsg", lang)}
                  <textarea
                    placeholder={t("removeMessageReasonLabel", lang)}
                    value={deleteReason}
                    onChange={(e) => setDeleteReason(e.target.value)}
                    style={{ width: "100%", marginTop: 4 }}
                  />
                  <div className="btn-row">
                    <button className="btn btn-primary" disabled={!deleteReason.trim()} onClick={() => confirmDelete(m.id)}>
                      {t("confirmDelete", lang)}
                    </button>
                    <button className="btn btn-outline" onClick={() => { setDeleteConfirmId(null); setDeleteReason(""); }}>
                      {t("cancel", lang)}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 10, borderTop: "1px solid #e2dccb", paddingTop: 8 }}>
        {replyTo && (
          <div className="msg info" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{t("replyingToLabel", lang)} {displayName(replyTo.sender_id)}: “{(replyTo.message_text || "").slice(0, 60)}”</span>
            <button className="btn btn-outline" style={{ width: "auto", margin: 0, minHeight: 26, padding: "2px 8px" }} onClick={() => setReplyTo(null)}>✕</button>
          </div>
        )}

        <textarea
          placeholder={t("writeReplyPlaceholder", lang)}
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          disabled={sending}
        />

        {pendingFile && (
          <div className="msg info" style={{ display: "flex", justifyContent: "space-between" }}>
            <span>📎 {pendingFile.name}</span>
            <button className="btn btn-outline" style={{ width: "auto", margin: 0, minHeight: 26, padding: "2px 8px" }} onClick={() => { setPendingFile(null); setPendingFileType(null); }}>✕</button>
          </div>
        )}

        <VoiceRecorder key={voiceKey} lang={lang} disabled={sending} onRecorded={handleVoiceRecorded} />

        <div className="btn-row">
          <label className="file-input-label" style={{ margin: 0 }}>
            📎 {t("attachFile", lang)}
            <input
              type="file"
              accept={MESSAGE_DOCUMENT_ACCEPT}
              style={{ display: "none" }}
              disabled={sending}
              onChange={(e) => { handleFileChange(e.target.files?.[0] || null); e.target.value = ""; }}
            />
          </label>
          <button className="btn btn-primary" disabled={!canSend} onClick={send}>
            {sending ? t("sendingLabel", lang) : t("sendReplyAction", lang)}
          </button>
        </div>
      </div>
    </div>
  );
});
