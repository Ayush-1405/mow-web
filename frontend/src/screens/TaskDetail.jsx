import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { uploadTaskProof, downloadTaskProof, resolveMimeType } from "../lib/api";
import { t } from "../lib/i18n";
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

export function TaskTimeline({ task, usersById, lang }) {
  const rows = [
    { label: t("createdBy", lang), value: userLabel(usersById, task.assigned_by), time: task.created_at },
    { label: t("acceptedAt", lang), value: null, time: task.accepted_at },
    { label: t("startedAt", lang), value: null, time: task.started_at },
    { label: t("completedAt", lang), value: null, time: task.completed_at },
    { label: t("verifiedAt", lang), value: userLabel(usersById, task.verified_by), time: task.verified_at },
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
}

// Maps a browser File's mime type to the file_type value staff_record_
// attachment/staff-file-url actually accept (mirrors MIME_WHITELIST in the
// staff-file-url Edge Function) — server-side validation is still the real
// enforcement boundary; this only decides what the client attempts.
export function detectFileType(mimeType) {
  if (["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(mimeType)) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (["application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(mimeType)) return "word";
  if (["application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(mimeType)) return "excel";
  return null;
}

// Lists existing staff_attachments for a task (entity_type is always
// 'task' — a Bridge IS a staff_tasks row underneath, so its attachments
// live under the same task id) via the normal RLS-scoped client
// (staff_attachments_select_matches_parent decides visibility), plus a
// generic "attach a file" control usable any time — not only at Complete,
// unlike the existing photo-proof uploader on TodayTasks.
export function AttachmentsList({ taskId, lang, showToast }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [playing, setPlaying] = useState(null);
  const [voiceKey, setVoiceKey] = useState(0);

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

  return (
    <div style={{ marginTop: 10 }}>
      <label>{t("attachments", lang)}</label>
      {loading && <div className="msg info">…</div>}
      {!loading && items.length === 0 && <div className="msg info">{t("noAttachments", lang)}</div>}
      {items.map((a) => (
        <div key={a.id}>
          <div className="notif-row">
            <div>
              <div className="n-title">{a.file_type === "voice" ? `🎙️ ${t("voiceNote", lang)}` : a.original_filename}</div>
              <div className="n-time">{new Date(a.created_at).toLocaleString()}{a.duration_seconds ? ` · ${a.duration_seconds}s` : ""}</div>
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
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          style={{ display: "none" }}
          disabled={uploading}
          onChange={(e) => { handleUpload(e.target.files?.[0] || null); e.target.value = ""; }}
        />
      </label>
    </div>
  );
}

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
export function ReassignPanel({ task, candidates, lang, busy, onSubmit, onCancel }) {
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
}
