import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import { listProjects, listRequests, createRequest, updateRequestStatus, notifyDeptLeadership } from "../../lib/interiorApi";

// Customer Requests & Complaints — the external system's `project_requests`
// table, per project.
export default function InteriorRequests({ lang }) {
  const profile = useInteriorProfile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ request_type: "", description: "" });

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

  const loadRequests = useCallback(async () => {
    if (!projectId) { setRows([]); return; }
    const { data, error: err } = await listRequests(projectId);
    if (!err) setRows(data || []);
  }, [projectId]);

  useEffect(() => { loadRequests(); }, [loadRequests]);

  async function handleAdd(e) {
    e.preventDefault();
    if (!projectId || !form.description) return;
    setSaving(true);
    const { error: err } = await createRequest({ projectId, requestType: form.request_type || "general", description: form.description, createdBy: profile?.id });
    setSaving(false);
    if (err) { setError(true); return; }
    const project = projects.find((p) => p.id === projectId);
    notifyDeptLeadership(
      "INTERIOR", "project", projectId,
      `New customer request/complaint: ${form.description} — ${project ? `${project.project_code} (${project.customer})` : ""}`,
      `નવી ગ્રાહક વિનંતી/ફરિયાદ: ${form.description}`,
    );
    setForm({ request_type: "", description: "" });
    setShowForm(false);
    loadRequests();
  }

  async function close(id) {
    const { error: err } = await updateRequestStatus(id, "CLOSED");
    if (!err) loadRequests();
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
        <div className="dept-header-icon" aria-hidden="true">📮</div>
        <div className="dept-header-text">
          <h1>{t("customerRequestsTitle", lang)}</h1>
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
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)} disabled={!projectId}>
          {showForm ? t("cancel", lang) : t("addRequest", lang)}
        </button>
        {showForm && (
          <form onSubmit={handleAdd} className="form-grid" style={{ marginTop: 12 }}>
            <div className="field">
              <label>{t("requestTypeLabel", lang)}</label>
              <input value={form.request_type} onChange={(e) => setForm((f) => ({ ...f, request_type: e.target.value }))} />
            </div>
            <div className="field full">
              <label>{t("descriptionLabel", lang)} *</label>
              <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} required />
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
            <span>{r.request_type} — {r.description}</span>
            {r.status === "CLOSED" ? <span className="badge CLOSED">{r.status}</span> : <button className="btn btn-outline" onClick={() => close(r.id)}>{t("close", lang)}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
