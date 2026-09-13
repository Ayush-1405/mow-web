import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { listProjects, listInteriorPeople, listDeletedWorkingDrawingFiles, restoreWorkingDrawingFile, permanentlyDeleteWorkingDrawingFile } from "../../lib/interiorApi";
import { DeletionReasonFields, isDeletionReasonValid } from "./InteriorWorkingDrawings";

function personName(people, id) {
  return people.find((p) => p.id === id)?.name || "—";
}

function reasonLabel(lang, code) {
  const key = {
    WRONG_FILE: "reasonWrongFile", WRONG_PROJECT: "reasonWrongProject", DUPLICATE: "reasonDuplicate",
    WRONG_VERSION: "reasonWrongVersion", REPLACED: "reasonReplaced", WRONG_CATEGORY: "reasonWrongCategory",
    CORRUPTED: "reasonCorrupted", CLIENT_REJECTED: "reasonClientRejected", NOT_REQUIRED: "reasonNotRequired", OTHER: "reasonOther",
  }[code];
  return key ? t(key, lang) : code || "—";
}

// Second confirmation for an irreversible action -- reuses the exact same
// reason dropdown/textarea validation as the soft-delete modal in
// InteriorWorkingDrawings.jsx, per the spec's "re-entry of the reason".
function PermanentDeleteModal({ lang, file, onCancel, onConfirm }) {
  const [reasonCode, setReasonCode] = useState("");
  const [reasonNote, setReasonNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = isDeletionReasonValid(reasonCode, reasonNote);

  async function handleConfirm() {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    const { error: err } = await onConfirm(reasonCode, reasonNote.trim());
    if (err) {
      setBusy(false);
      setError(err.message || String(err));
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-card-title">{t("permanentlyDeleteAction", lang)}</div>
        <div className="sub" style={{ marginTop: 4 }}>{file.title}</div>
        <p className="msg error" style={{ marginTop: 10 }}>{t("permanentDeleteWarningMsg", lang)}</p>
        <div className="form-grid">
          <DeletionReasonFields lang={lang} reasonCode={reasonCode} setReasonCode={setReasonCode} reasonNote={reasonNote} setReasonNote={setReasonNote} />
        </div>
        {error && <div className="msg error" style={{ marginTop: 6 }}>{error}</div>}
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn btn-outline" style={{ width: "auto" }} disabled={busy} onClick={onCancel}>{t("cancel", lang)}</button>
          <button className="btn btn-danger" style={{ width: "auto" }} disabled={!valid || busy} onClick={handleConfirm}>
            {busy ? t("removingFileMsg", lang) : t("confirmDeleteAction", lang)}
          </button>
        </div>
      </div>
    </div>
  );
}

// "Deleted Files" / recycle bin -- visible only to Management/Super Admin/
// Interior Department Head (route-gated in App.jsx to the same booleans);
// the real enforcement is server-side (attachments_select_scoped /
// working_drawing_attachments_select_scoped only return is_deleted=true
// rows to interior_files_can_view_deleted()), this is just the UI home for it.
export default function InteriorDeletedFiles({ lang, staffProfile }) {
  const canPurge = !!staffProfile?.isManagement || !!staffProfile?.isSuperAdmin;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [people, setPeople] = useState([]);
  const [projectId, setProjectId] = useState("");

  const [files, setFiles] = useState([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [rowMsg, setRowMsg] = useState({});
  const [purgingFile, setPurgingFile] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data, error: err }, peopleRes] = await Promise.all([listProjects(), listInteriorPeople()]);
    if (err) { setError(true); setLoading(false); return; }
    setProjects(data || []);
    setPeople(peopleRes.data || []);
    if (data?.length) setProjectId((cur) => cur || data[0].id);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadFiles = useCallback(async () => {
    if (!projectId) { setFiles([]); return; }
    setFilesLoading(true);
    const { data, error: err } = await listDeletedWorkingDrawingFiles(projectId);
    if (!err) setFiles(data || []);
    setFilesLoading(false);
  }, [projectId]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  async function handleRestore(f) {
    setRowMsg((m) => ({ ...m, [f.id]: "" }));
    const { error: err } = await restoreWorkingDrawingFile({ source: f.source, id: f.id, projectId });
    if (err) { setRowMsg((m) => ({ ...m, [f.id]: err.message || String(err) })); return; }
    setFiles((rows) => rows.filter((r) => r.id !== f.id));
  }

  async function handlePermanentDelete(reasonCode, reasonNote) {
    const f = purgingFile;
    const { error: err } = await permanentlyDeleteWorkingDrawingFile({
      source: f.source, id: f.id, projectId, reasonCode, reasonNote, storagePath: f.storage_path,
    });
    if (err) return { error: err };
    setPurgingFile(null);
    setFiles((rows) => rows.filter((r) => r.id !== f.id));
    return { error: null };
  }

  if (loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 60 }} /><div className="skeleton-block" style={{ height: 220 }} /></div>;
  if (error) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">{t("loadErrorRetry", lang)}</div>
        <button className="btn btn-primary" onClick={load}>{t("retry", lang)}</button>
      </div>
    );
  }

  const project = projects.find((p) => p.id === projectId);

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🗑️</div>
        <div className="dept-header-text">
          <h1>{t("deletedFilesTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>{t("selectProjectLabel", lang)}</label>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
          </select>
        </div>
      </div>

      <div className="card">
        {filesLoading ? <div className="skeleton-block" style={{ height: 140 }} /> : (
          <>
            {files.length === 0 && <div className="msg info">{t("noDeletedFilesLabel", lang)}</div>}
            {files.map((f) => (
              <div key={`${f.source}-${f.id}`} className="task-meta" style={{ justifyContent: "space-between", padding: "10px 0", flexWrap: "wrap", gap: 6, borderBottom: "1px solid var(--border)" }}>
                <span style={{ flex: "1 1 200px", fontWeight: 700 }}>{f.title}</span>
                <span className="sub">{f.original_file_name || t("noFileAttachedLabel", lang)}</span>
                <span className="badge CLOSED">{f.file_category === "Other" ? f.custom_category : f.file_category || "—"}</span>
                <span className="sub">{project ? `${project.project_code} — ${project.customer}` : "—"}</span>
                <span className="sub">{t("uploadedByLabel", lang)}: {personName(people, f.uploaded_by)}</span>
                <span className="sub">{t("deletedByLabel", lang)}: {personName(people, f.deleted_by)} · {t("deletedAtLabel", lang)}: {f.deleted_at ? new Date(f.deleted_at).toLocaleString() : "—"}</span>
                <span className="sub">{t("deletionReasonLabel", lang)}: {reasonLabel(lang, f.deletion_reason_code)} — {f.deletion_reason_note}</span>
                {rowMsg[f.id] && <div className="msg error">{rowMsg[f.id]}</div>}
                <span className="btn-row" style={{ marginTop: 0 }}>
                  <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => handleRestore(f)}>{t("restoreFileAction", lang)}</button>
                  {canPurge && (
                    <button className="btn btn-danger" style={{ marginTop: 0, width: "auto" }} onClick={() => setPurgingFile(f)}>{t("permanentlyDeleteAction", lang)}</button>
                  )}
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      {purgingFile && (
        <PermanentDeleteModal lang={lang} file={purgingFile} onCancel={() => setPurgingFile(null)} onConfirm={handlePermanentDelete} />
      )}
    </div>
  );
}
