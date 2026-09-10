import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import { listProjects, listSnags, createSnag, resolveSnag, listInteriorPeople, notifyInteriorAssignment } from "../../lib/interiorApi";

// Site Execution — the external system's `snags` table (real punch-list
// data per project).
export default function InteriorSiteExecution({ lang }) {
  const myProfile = useInteriorProfile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState([]);
  const [people, setPeople] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(false);
  const [assignedToMeOnly, setAssignedToMeOnly] = useState(false);
  const [form, setForm] = useState({ issue: "", major: false, dueDate: "", assignedTo: "" });

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [projRes, peopleRes] = await Promise.all([listProjects(), listInteriorPeople()]);
    if (projRes.error) { setError(true); setLoading(false); return; }
    setProjects(projRes.data || []);
    setPeople(peopleRes.data || []);
    if (projRes.data?.length) setProjectId((cur) => cur || projRes.data[0].id);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadSnags = useCallback(async () => {
    if (!projectId) { setRows([]); return; }
    const { data, error: err } = await listSnags(projectId);
    if (!err) setRows(data || []);
  }, [projectId]);

  useEffect(() => { loadSnags(); }, [loadSnags]);

  const personName = useCallback((id) => people.find((p) => p.id === id)?.name || "—", [people]);
  const visibleRows = useMemo(
    () => (assignedToMeOnly && myProfile?.id ? rows.filter((r) => r.assigned_to === myProfile.id) : rows),
    [rows, assignedToMeOnly, myProfile?.id],
  );

  async function handleAdd(e) {
    e.preventDefault();
    if (!projectId || !form.issue) return;
    setSaving(true);
    const { data, error: err } = await createSnag({ projectId, issue: form.issue, major: form.major, dueDate: form.dueDate, assignedTo: form.assignedTo });
    setSaving(false);
    if (err) { setError(true); return; }
    if (form.assignedTo) {
      notifyInteriorAssignment(form.assignedTo, "snag", data.id, `New snag assigned: ${data.issue}`, `નવી ખામી સોંપાયેલ: ${data.issue}`);
    }
    setForm({ issue: "", major: false, dueDate: "", assignedTo: "" });
    setShowForm(false);
    loadSnags();
  }

  async function handleResolve(id) {
    setBusyId(id);
    setActionError(false);
    const { error: err } = await resolveSnag(id);
    setBusyId(null);
    if (err) { setActionError(true); return; }
    loadSnags();
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
        <div className="dept-header-icon" aria-hidden="true">🏗️</div>
        <div className="dept-header-text">
          <h1>{t("interiorSiteExecutionTitle", lang)}</h1>
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
          {showForm ? t("cancel", lang) : t("addSnag", lang)}
        </button>
        {showForm && (
          <form onSubmit={handleAdd} className="form-grid" style={{ marginTop: 12 }}>
            <div className="field full">
              <label>{t("issueLabel", lang)} *</label>
              <input value={form.issue} onChange={(e) => setForm((f) => ({ ...f, issue: e.target.value }))} required />
            </div>
            <div className="field">
              <label>{t("dueDateLabel", lang)}</label>
              <input type="date" value={form.dueDate} onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))} />
            </div>
            <div className="field">
              <label>{t("assignedToLabel", lang)}</label>
              <select value={form.assignedTo} onChange={(e) => setForm((f) => ({ ...f, assignedTo: e.target.value }))}>
                <option value="">—</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={form.major} onChange={(e) => setForm((f) => ({ ...f, major: e.target.checked }))} />
                {t("majorLabel", lang)}
              </label>
            </div>
            <div className="field full">
              <button className="btn btn-primary" type="submit" disabled={saving}>{t("save", lang)}</button>
            </div>
          </form>
        )}
      </div>

      <div className="card">
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <input type="checkbox" checked={assignedToMeOnly} onChange={(e) => setAssignedToMeOnly(e.target.checked)} />
          {t("assignedToMeFilter", lang)}
        </label>
        {actionError && <div className="msg error">{t("loadErrorRetry", lang)}</div>}
        {visibleRows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {visibleRows.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
            <span>{r.issue} {r.major && <span className="badge RETURNED">{t("majorLabel", lang)}</span>}</span>
            <span className="sub">{r.assigned_to ? personName(r.assigned_to) : "—"}</span>
            {r.status === "COMPLETED"
              ? <span className="badge VERIFIED">{r.status}</span>
              : <button className="btn btn-outline" disabled={busyId === r.id} onClick={() => handleResolve(r.id)}>{t("resolveSnag", lang)}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
