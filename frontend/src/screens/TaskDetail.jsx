import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { uploadTaskProof, downloadTaskProof, resolveMimeType } from "../lib/api";
import { ACCEPT_ATTR } from "../lib/fileTypes";
import { t } from "../lib/i18n";
import { listProjects } from "../lib/interiorApi";
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
  if (["application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain"].includes(mimeType)) return "word";
  if (["application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/csv"].includes(mimeType)) return "excel";
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

  const loadedOnce = useRef(false);
  const load = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    const { data, error } = await supabase
      .from("staff_attachments")
      .select("*")
      .eq("entity_type", "task")
      .eq("entity_id", taskId)
      .eq("is_active", true)
      .order("created_at", { ascending: false });
    if (error) showToast("error", error.message);
    else setItems(data || []);
    loadedOnce.current = true;
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

  // Signed URLs are deliberately short-lived (~2 min), so a URL cached at
  // page load is dead by the time someone taps a thumbnail a few minutes
  // later (or the browser re-requests an evicted image) -- that is the
  // "Failed to load resource ... 400" on Screenshot*.png. Mint a fresh one
  // for the lightbox every time, and once per image when a thumbnail fails.
  const retriedThumbs = useRef(new Set());
  async function refreshThumb(attachmentId) {
    if (retriedThumbs.current.has(attachmentId)) return;
    retriedThumbs.current.add(attachmentId);
    try {
      const res = await downloadTaskProof(attachmentId);
      setThumbUrls((cur) => ({ ...cur, [attachmentId]: res.signed_url }));
    } catch { /* keep the placeholder; the Download path still works */ }
  }
  async function openLightbox(a) {
    try {
      const res = await downloadTaskProof(a.id);
      setThumbUrls((cur) => ({ ...cur, [a.id]: res.signed_url }));
      setLightboxUrl(res.signed_url);
    } catch (err) {
      showToast("error", err.message);
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
              onClick={() => openLightbox(a)}
              title={a.original_filename}
            >
              {thumbUrls[a.id] ? <img src={thumbUrls[a.id]} alt={a.original_filename} onError={() => refreshThumb(a.id)} /> : "…"}
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
          accept={ACCEPT_ATTR("task")}
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
