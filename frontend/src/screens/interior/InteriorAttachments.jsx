import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import { listProjects, listAttachments, addAttachmentRecord, uploadAttachmentFile, getAttachmentUrl, notifyDeptLeadership } from "../../lib/interiorApi";

// Shared by the Quotation / Design / Drawings cards — each is just a
// different `stage` filter over the external system's own `attachments`
// table (real data: e.g. project MOW-101 is currently at stage "Design").
// Real file upload goes into the interior-attachments Storage bucket (see
// mvp_pilot_interior_head_dashboard_v2_2f.sql); "Save without a file"
// stays available for a pure metadata record (e.g. logging a physical
// document that was handed over in person).
export default function InteriorAttachments({ lang, stage, titleKey, lockedProjectId }) {
  const profile = useInteriorProfile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ title: "", fileName: "", note: "" });
  const [file, setFile] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await listProjects();
    if (err) { setError(true); setLoading(false); return; }
    setProjects(data || []);
    if (data?.length && !projectId) setProjectId(lockedProjectId || data[0].id);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedProjectId]);

  useEffect(() => { load(); }, [load]);

  const loadAttachments = useCallback(async () => {
    if (!projectId) { setRows([]); return; }
    const { data, error: err } = await listAttachments(projectId, stage);
    if (!err) setRows(data || []);
  }, [projectId, stage]);

  useEffect(() => { loadAttachments(); }, [loadAttachments]);

  const currentProject = useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId]);

  async function handleAdd(e) {
    e.preventDefault();
    if (!projectId || !form.title) return;
    setSaving(true);
    const { error: err } = file
      ? await uploadAttachmentFile({ projectId, stage, file, title: form.title, note: form.note, uploadedBy: profile?.id })
      : await addAttachmentRecord({ projectId, stage, title: form.title, fileName: form.fileName, note: form.note, uploadedBy: profile?.id });
    setSaving(false);
    if (err) { setError(true); return; }
    notifyDeptLeadership(
      "INTERIOR", "project", projectId,
      `${stage} file uploaded: ${form.title} — ${currentProject ? `${currentProject.project_code} (${currentProject.customer})` : ""}`,
      `${stage} ફાઈલ અપલોડ થઈ: ${form.title}`,
    );
    setForm({ title: "", fileName: "", note: "" });
    setFile(null);
    setShowForm(false);
    loadAttachments();
  }

  async function openFile(storagePath) {
    const { url } = await getAttachmentUrl(storagePath);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
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

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📁</div>
        <div className="dept-header-text">
          <h1>{t(titleKey, lang)} — {stage}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>{t("projectCodeLabel", lang)}</label>
          {lockedProjectId ? (
            <div className="sub" style={{ fontWeight: 700, marginTop: 4 }}>{currentProject?.project_code} — {currentProject?.customer}</div>
          ) : (
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
            </select>
          )}
        </div>
        {currentProject && <div className="sub">{t("stageLabel", lang)}: {currentProject.stage}</div>}
      </div>

      <div className="card">
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)} disabled={!projectId}>
          {showForm ? t("cancel", lang) : t("uploadFile", lang)}
        </button>
        {showForm && (
          <form onSubmit={handleAdd} className="form-grid" style={{ marginTop: 12 }}>
            <div className="field full">
              <label>{t("titleLabel", lang)} *</label>
              <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} required />
            </div>
            <div className="field">
              <label>{t("fileNameLabel", lang)}</label>
              <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </div>
            <div className="field full">
              <label>{t("notesLabel", lang)}</label>
              <textarea value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
            <div className="field full">
              <button className="btn btn-primary" type="submit" disabled={saving}>{t("save", lang)}</button>
            </div>
          </form>
        )}
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
            <span>{r.title || r.file_name} {r.version ? `(${r.version})` : ""}</span>
            {r.frozen && <span className="badge CLOSED">{t("frozenLabel", lang)}</span>}
            {r.storage_path
              ? <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => openFile(r.storage_path)}>{t("download", lang)}</button>
              : <span className="sub">{t("noFileAttachedLabel", lang)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
