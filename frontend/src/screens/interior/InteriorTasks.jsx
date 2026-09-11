import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import {
  listProjects, listTasks, createTask, updateTaskStatus,
  listInteriorPeople, listProjectTeamIds, notifyInteriorAssignment,
} from "../../lib/interiorApi";

// Tasks board — the external system's `tasks` table, per project. Task
// delegation is restricted to the project's own team (owner/PM, designer,
// execution, project_members) plus Head/Director — the "project owner
// assigns tasks to other employees" flow — everyone else sees the board
// read-only (can still update their own task status).
export default function InteriorTasks({ lang, lockedProjectId }) {
  const profile = useInteriorProfile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState([]);
  const [people, setPeople] = useState([]);
  const [teamIds, setTeamIds] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [form, setForm] = useState({ title: "", due_date: "", assignedTo: "" });

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data, error: err }, peopleRes] = await Promise.all([listProjects(), listInteriorPeople()]);
    if (err) { setError(true); setLoading(false); return; }
    setProjects(data || []);
    setPeople(peopleRes.data || []);
    if (data?.length) setProjectId((cur) => cur || lockedProjectId || data[0].id);
    setLoading(false);
  }, [lockedProjectId]);

  useEffect(() => { load(); }, [load]);

  const project = useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId]);

  useEffect(() => {
    if (!project) { setTeamIds([]); return; }
    listProjectTeamIds(project).then(setTeamIds);
  }, [project]);

  const canAssign = !!profile && (teamIds.includes(profile.id) || ["head", "director"].includes(profile.role));
  const assignableTeam = useMemo(() => people.filter((p) => teamIds.includes(p.id)), [people, teamIds]);
  const personName = useCallback((id) => people.find((p) => p.id === id)?.name || "—", [people]);

  const loadTasks = useCallback(async () => {
    if (!projectId) { setRows([]); return; }
    const { data, error: err } = await listTasks(projectId);
    if (!err) setRows(data || []);
  }, [projectId]);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  async function handleAdd(e) {
    e.preventDefault();
    if (!projectId || !form.title || !canAssign) return;
    setSaving(true);
    const { data, error: err } = await createTask({ projectId, title: form.title, assignedTo: form.assignedTo, dueDate: form.due_date, createdBy: profile?.id });
    setSaving(false);
    if (err) { setError(true); return; }
    if (form.assignedTo) {
      // "interior_task" (not "task") — that entity_type/entity_id pair
      // points into the external tasks table, not staff_tasks, and the two
      // aren't interchangeable IDs. Notifications.jsx routes on this string.
      notifyInteriorAssignment(form.assignedTo, "interior_task", data.id, `New task assigned: ${data.title}`, `નવું કાર્ય સોંપાયેલ: ${data.title}`);
    }
    setForm({ title: "", due_date: "", assignedTo: "" });
    setShowForm(false);
    loadTasks();
  }

  async function markDone(id) {
    setActionError(false);
    const { error: err } = await updateTaskStatus(id, "COMPLETED");
    if (err) { setActionError(true); return; }
    loadTasks();
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
        {canAssign ? (
          <>
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
                <div className="field">
                  <label>{t("assignedToLabel", lang)}</label>
                  <select value={form.assignedTo} onChange={(e) => setForm((f) => ({ ...f, assignedTo: e.target.value }))}>
                    <option value="">—</option>
                    {assignableTeam.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="field full">
                  <button className="btn btn-primary" type="submit" disabled={saving}>{t("save", lang)}</button>
                </div>
              </form>
            )}
          </>
        ) : (
          <div className="msg info">{t("taskAssignRestricted", lang)}</div>
        )}
      </div>

      <div className="card">
        {actionError && <div className="msg error">{t("loadErrorRetry", lang)}</div>}
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
            <span>{r.title}</span>
            <span className="sub">{r.assigned_to ? personName(r.assigned_to) : "—"}</span>
            <span className="sub">{r.due_date || "—"}</span>
            {r.status === "COMPLETED" ? <span className="badge VERIFIED">{r.status}</span> : <button className="btn btn-outline" onClick={() => markDone(r.id)}>{t("markTaskDone", lang)}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
