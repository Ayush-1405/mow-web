import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { listProjects, listAttachments, lockDesignAttachment } from "../../lib/interiorApi";

// Design Lock — the Design-stage attachments, with the "Lock Design"
// action (sets attachments.frozen = true via the single narrow
// lockDesignAttachment() call). Irreversible from this screen, so it asks
// for confirmation first.
export default function InteriorDesignLock({ lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await listProjects();
    if (err) { setError(true); setLoading(false); return; }
    setProjects(data || []);
    if (data?.length) setProjectId((cur) => cur || data[0].id);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadAttachments = useCallback(async () => {
    if (!projectId) { setRows([]); return; }
    const { data, error: err } = await listAttachments(projectId, "Design");
    if (!err) setRows(data || []);
  }, [projectId]);

  useEffect(() => { loadAttachments(); }, [loadAttachments]);

  async function confirmLock(id) {
    setBusyId(id);
    const { error: err } = await lockDesignAttachment(id);
    setBusyId(null);
    setConfirmId(null);
    if (!err) loadAttachments();
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
        <div className="dept-header-icon" aria-hidden="true">🔒</div>
        <div className="dept-header-text">
          <h1>{t("interiorDesignLockTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>{t("projectCodeLabel", lang)}</label>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
          </select>
        </div>
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 8 }}>
            <span>{r.title || r.file_name} ({r.version})</span>
            {r.frozen
              ? <span className="badge CLOSED">{t("frozenLabel", lang)}</span>
              : confirmId === r.id
                ? (
                  <span className="btn-row" style={{ marginTop: 0 }}>
                    <span className="sub">{t("areYouSure", lang)}</span>
                    <button className="btn btn-danger" disabled={busyId === r.id} onClick={() => confirmLock(r.id)}>{t("confirm", lang)}</button>
                    <button className="btn btn-outline" onClick={() => setConfirmId(null)}>{t("cancel", lang)}</button>
                  </span>
                )
                : <button className="btn btn-outline" onClick={() => setConfirmId(r.id)}>{t("lockDesign", lang)}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
