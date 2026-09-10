import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { listProjects, listActivity, logActivity } from "../../lib/interiorApi";

// Client Communication — the external system's `activity_logs` table, per
// project.
export default function InteriorClientComm({ lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState([]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

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

  const loadActivity = useCallback(async () => {
    if (!projectId) { setRows([]); return; }
    const { data, error: err } = await listActivity(projectId);
    if (!err) setRows(data || []);
  }, [projectId]);

  useEffect(() => { loadActivity(); }, [loadActivity]);

  async function handleLog() {
    if (!projectId || !note) return;
    setSaving(true);
    const { error: err } = await logActivity(projectId, "client_communication", note);
    setSaving(false);
    if (err) { setError(true); return; }
    setNote("");
    loadActivity();
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
        <div className="dept-header-icon" aria-hidden="true">💬</div>
        <div className="dept-header-text">
          <h1>{t("interiorClientCommTitle", lang)}</h1>
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
        <div className="field full" style={{ marginTop: 10 }}>
          <label>{t("logUpdate", lang)}</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
            <button className="btn btn-primary" disabled={saving} onClick={handleLog}>{t("save", lang)}</button>
          </div>
        </div>
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
            <span>{r.description}</span>
            <span className="sub">{(r.created_at || "").slice(0, 10)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
