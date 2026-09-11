import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { listProjects, listProjectChanges, decideProjectChange, notifyDeptLeadership } from "../../lib/interiorApi";

// Design Approval — the external system's project_changes table doubles
// as its change/approval mechanism; approving/rejecting here writes
// approval_status via the single narrow decideProjectChange() call in
// lib/interiorApi.js (never a blanket update).
export default function InteriorDesignApproval({ lang, lockedProjectId }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState([]);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await listProjects();
    if (err) { setError(true); setLoading(false); return; }
    setProjects(data || []);
    if (data?.length) setProjectId((cur) => cur || lockedProjectId || data[0].id);
    setLoading(false);
  }, [lockedProjectId]);

  useEffect(() => { load(); }, [load]);

  const loadChanges = useCallback(async () => {
    if (!projectId) { setRows([]); return; }
    const { data, error: err } = await listProjectChanges(projectId);
    if (!err) setRows(data || []);
  }, [projectId]);

  useEffect(() => { loadChanges(); }, [loadChanges]);

  async function decide(id, decision, description) {
    setBusyId(id);
    const { error: err } = await decideProjectChange(id, decision);
    setBusyId(null);
    if (err) return;
    const project = projects.find((p) => p.id === projectId);
    notifyDeptLeadership(
      "INTERIOR", "project", projectId,
      `Design change ${decision.toLowerCase()}: ${description} — ${project ? `${project.project_code} (${project.customer})` : ""}`,
      `ડિઝાઇન ફેરફાર ${decision === "APPROVED" ? "મંજૂર" : "નકારાયો"}: ${description}`,
    );
    loadChanges();
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
        <div className="dept-header-icon" aria-hidden="true">✅</div>
        <div className="dept-header-text">
          <h1>{t("interiorDesignApprovalTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>{t("projectCodeLabel", lang)}</label>
          {lockedProjectId ? (
            <div className="sub" style={{ fontWeight: 700, marginTop: 4 }}>
              {(() => { const p = projects.find((pr) => pr.id === projectId); return p ? `${p.project_code} — ${p.customer}` : "—"; })()}
            </div>
          ) : (
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
            </select>
          )}
        </div>
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontWeight: 700 }}>{r.description}</div>
              <div className="sub">{r.requested_by} · {r.requested_date}</div>
            </div>
            <span className="badge ASSIGNED">{r.approval_status}</span>
            {r.approval_status === "PENDING" && (
              <div className="btn-row" style={{ marginTop: 0 }}>
                <button className="btn btn-primary" disabled={busyId === r.id} onClick={() => decide(r.id, "APPROVED", r.description)}>{t("approveLabel", lang)}</button>
                <button className="btn btn-outline" disabled={busyId === r.id} onClick={() => decide(r.id, "REJECTED", r.description)}>{t("rejectLabel", lang)}</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
