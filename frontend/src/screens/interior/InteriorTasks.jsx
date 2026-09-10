import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import { listProjects, listTasks, createTask, updateTaskStatus } from "../../lib/interiorApi";

// Tasks board — the external system's `tasks` table, per project.
export default function InteriorTasks({ lang }) {
  const profile = useInteriorProfile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ title: "", due_date: "" });

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

  const loadTasks = useCallback(async () => {
    if (!projectId) { setRows([]); return; }
    const { data, error: err } = await listTasks(projectId);
    if (!err) setRows(data || []);
  }, [projectId]);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  async function handleAdd(e) {
    e.preventDefault();
    if (!projectId || !form.title) return;
    setSaving(true);
    const { error: err } = await createTask({ projectId, title: form.title, dueDate: form.due_date, createdBy: profile?.id });
    setSaving(false);
    if (err) { setError(true); return; }
    setForm({ title: "", due_date: "" });
    setShowForm(false);
    loadTasks();
  }

  async function markDone(id) {
    const { error: err } = await updateTaskStatus(id, "DONE");
    if (!err) loadTasks();
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
          <h1>{t("tasksBoardTitle", lang)}</h1>
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
          {showForm ? t("cancel", lang) : t("addTask", lang)}
        </button>
        {showForm && (
          <form onSubmit={handleAdd} className="form-grid" style={{ marginTop: 12 }}>
            <div className="field full">
              <label>{t("titleLabel", lang)} *</label>
              <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} required />
            </div>
            <div className="field">
              <label>{t("dueDateLabel", lang)}</label>
              <input type="date" value={form.due_date} onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))} />
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
            <span>{r.title}</span>
            <span className="sub">{r.due_date || "—"}</span>
            {r.status === "DONE" ? <span className="badge VERIFIED">{r.status}</span> : <button className="btn btn-outline" onClick={() => markDone(r.id)}>{t("markTaskDone", lang)}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
