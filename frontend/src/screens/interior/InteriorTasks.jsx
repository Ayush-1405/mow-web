import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import {
  listProjects, listTasks, createTask, updateTaskStatus,
  listInteriorPeople, listProjectTeamIds, notifyInteriorAssignment, listProjectStaffTasks,
} from "../../lib/interiorApi";

// Tasks board — the external system's `tasks` table, per project, PLUS
// (since mvp_pilot_daily_update_tasks_v2_38.sql) every staff_tasks row
// linked to this project — Daily Site Update assignments, and any future
// project-linked source — merged read-only into the same list. The two
// sources are never combined into one table: staff_tasks keeps its own
// real Accept/Start/Complete/Verify/Close lifecycle (managed from Today's
// Tasks / notifications, not from here); this screen's own "Add Task" /
// "Mark Done" flow is untouched and still only writes the plain `tasks`
// table, exactly as before.
export default function InteriorTasks({ lang, lockedProjectId }) {
  const navigate = useNavigate();
  const profile = useInteriorProfile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState([]);
  const [staffRows, setStaffRows] = useState([]);
  const [staffUsersById, setStaffUsersById] = useState({});
  const [statusById, setStatusById] = useState({});
  const [priorityById, setPriorityById] = useState({});
  const [people, setPeople] = useState([]);
  const [teamIds, setTeamIds] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [form, setForm] = useState({ title: "", due_date: "", assignedTo: "" });

  const [filterAssignee, setFilterAssignee] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterPriority, setFilterPriority] = useState("");
  const [filterSource, setFilterSource] = useState("");
  const [filterWindow, setFilterWindow] = useState("");

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

  // staff_tasks.assigned_to/assigned_by are user_profiles ids, a different
  // id space from Interior's own profiles.id used by listInteriorPeople()
  // — resolved via the same RPC TodayTasks.jsx/AssignTask.jsx already use.
  useEffect(() => {
    supabase.rpc("staff_list_assignable_users_all").then(({ data }) => {
      setStaffUsersById(Object.fromEntries((data || []).map((u) => [u.id, u])));
    });
    supabase.from("status_master").select("id, code, name_en, name_gu").then(({ data }) => {
      setStatusById(Object.fromEntries((data || []).map((s) => [s.id, s])));
    });
    supabase.from("priority_master").select("id, code, name_en, name_gu").then(({ data }) => {
      setPriorityById(Object.fromEntries((data || []).map((p) => [p.id, p])));
    });
  }, []);

  const project = useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId]);

  useEffect(() => {
    if (!project) { setTeamIds([]); return; }
    listProjectTeamIds(project).then(setTeamIds);
  }, [project]);

  const canAssign = !!profile && (teamIds.includes(profile.id) || ["head", "director"].includes(profile.role));
  const assignableTeam = useMemo(() => people.filter((p) => teamIds.includes(p.id)), [people, teamIds]);
  const personName = useCallback((id) => people.find((p) => p.id === id)?.name || "—", [people]);

  const loadTasks = useCallback(async () => {
    if (!projectId) { setRows([]); setStaffRows([]); return; }
    const [{ data, error: err }, staffRes] = await Promise.all([listTasks(projectId), listProjectStaffTasks(projectId)]);
    if (!err) setRows(data || []);
    setStaffRows(staffRes.data || []);
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

  const todayStr = new Date().toISOString().slice(0, 10);

  // Normalized view of both sources so one filter bar and one list can
  // cover them — `raw`/`kind` keep enough to route "Open Task" correctly.
  const merged = useMemo(() => {
    const fromInterior = rows.map((r) => ({
      kind: "interior", id: r.id, title: r.title, assigneeName: r.assigned_to ? personName(r.assigned_to) : "—",
      assigneeKey: r.assigned_to || "", due_date: r.due_date, priorityLabel: "—", statusLabel: r.status,
      statusCode: r.status === "COMPLETED" ? "VERIFIED" : "ASSIGNED", sourceLabel: t("tabTasks", lang), raw: r,
    }));
    const fromStaff = staffRows.map((r) => {
      const u = staffUsersById[r.assigned_to];
      const status = statusById[r.status_id];
      const priority = priorityById[r.priority_id];
      return {
        kind: "staff", id: r.id, title: r.title, assigneeName: u?.full_name || "—", assigneeKey: r.assigned_to || "",
        due_date: r.due_date, priorityLabel: (lang === "gu" ? priority?.name_gu : priority?.name_en) || "—",
        statusLabel: (lang === "gu" ? status?.name_gu : status?.name_en) || status?.code || "—",
        statusCode: status?.code || "ASSIGNED",
        sourceLabel: r.source_module === "daily_site_update" ? t("sourceDailySiteUpdateLabel", lang) : (r.is_bridge ? "Bridge" : t("tabTasks", lang)),
        raw: r,
      };
    });
    return [...fromInterior, ...fromStaff];
  }, [rows, staffRows, staffUsersById, statusById, priorityById, personName, lang]);

  const filtered = useMemo(() => merged.filter((m) => {
    if (filterAssignee && m.assigneeKey !== filterAssignee) return false;
    if (filterStatus && m.statusCode !== filterStatus) return false;
    if (filterPriority && m.priorityLabel !== filterPriority) return false;
    if (filterSource && m.sourceLabel !== filterSource) return false;
    if (filterWindow === "overdue" && !(m.due_date && m.due_date < todayStr && m.statusCode !== "VERIFIED" && m.statusCode !== "CLOSED")) return false;
    if (filterWindow === "today" && m.due_date !== todayStr) return false;
    if (filterWindow === "upcoming" && !(m.due_date && m.due_date > todayStr)) return false;
    return true;
  }), [merged, filterAssignee, filterStatus, filterPriority, filterSource, filterWindow, todayStr]);

  const sourceOptions = useMemo(() => Array.from(new Set(merged.map((m) => m.sourceLabel))), [merged]);
  const priorityOptions = useMemo(() => Array.from(new Set(merged.map((m) => m.priorityLabel).filter((p) => p !== "—"))), [merged]);

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
        <div className="filter-bar" style={{ flexWrap: "wrap" }}>
          <select value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)}>
            <option value="">{t("allAssigneesLabel", lang)}</option>
            {Array.from(new Map(merged.map((m) => [m.assigneeKey, m.assigneeName])).entries()).filter(([k]) => k).map(([k, name]) => (
              <option key={k} value={k}>{name}</option>
            ))}
          </select>
          <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)}>
            <option value="">{t("priorityLabel", lang)}</option>
            {priorityOptions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={filterSource} onChange={(e) => setFilterSource(e.target.value)}>
            <option value="">{t("sourceLabel", lang)}</option>
            {sourceOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filterWindow} onChange={(e) => setFilterWindow(e.target.value)}>
            <option value="">{t("allDatesLabel", lang)}</option>
            <option value="overdue">{t("overdue", lang)}</option>
            <option value="today">{t("todayLabel", lang)}</option>
            <option value="upcoming">{t("upcomingLabel", lang)}</option>
          </select>
          <input placeholder={t("statusLabel", lang)} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ width: "auto" }} />
        </div>
      </div>

      <div className="card">
        {actionError && <div className="msg error">{t("loadErrorRetry", lang)}</div>}
        {filtered.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {filtered.map((m) => (
          <div key={`${m.kind}-${m.id}`} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap", gap: 6 }}>
            <span>{m.title}</span>
            <span className="sub">{m.assigneeName}</span>
            <span className="sub">{m.due_date || "—"}</span>
            {m.kind === "staff" && <span className="sub">{m.priorityLabel}</span>}
            <span className="badge ASSIGNED">{m.sourceLabel}</span>
            {m.kind === "interior" ? (
              m.raw.status === "COMPLETED" ? <span className="badge VERIFIED">{m.statusLabel}</span> : <button className="btn btn-outline" onClick={() => markDone(m.id)}>{t("markTaskDone", lang)}</button>
            ) : (
              <>
                <span className={`badge ${m.statusCode}`}>{m.statusLabel}</span>
                <button className="btn btn-outline" onClick={() => navigate(`/tasks?focus=${m.id}`)}>{t("openTaskAction", lang)}</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
