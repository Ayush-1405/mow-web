import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { subscribeTable, upsertById, removeById } from "../../lib/realtime";

// Site-wise task data (spec §11): every staff_tasks row linked to THIS
// project (project_id = lockedProjectId) — the same RLS-scoped rows
// Today's Tasks/Bridges already read (staff_tasks_select_scoped, which
// already includes an `interior_is_project_member(project_id)` branch), so
// a project's tasks here are exactly what this caller is authorized to see
// elsewhere too. Read-only stats + filters + a link out to the full
// interactive card on /tasks — the Accept/Start/Complete/Verify/Reply
// action set already lives there and isn't duplicated a third time here.
const SOURCE_FILTER_LABELS = {
  any: { en: "Any Source", gu: "કોઈપણ સ્ત્રોત" },
  assign_task: { en: "Assign Task", gu: "કાર્ય સોંપો" },
  daily_site_update: { en: "Daily Site Update", gu: "દૈનિક સાઇટ અપડેટ" },
};
const DUE_FILTER_LABELS = {
  any: { en: "Any Due Date", gu: "કોઈપણ નિયત તારીખ" },
  overdue: { en: "Overdue", gu: "મુદત વીતેલ" },
  today: { en: "Today", gu: "આજે" },
  upcoming: { en: "Upcoming", gu: "આગામી" },
};

export default function InteriorProjectAssignedTasks({ lang, lockedProjectId }) {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState([]);
  const [assigneesByTask, setAssigneesByTask] = useState({});
  const [statusById, setStatusById] = useState({});
  const [priorityById, setPriorityById] = useState({});
  const [usersById, setUsersById] = useState({});
  const [loading, setLoading] = useState(true);

  const [assigneeFilter, setAssigneeFilter] = useState("any");
  const [statusFilter, setStatusFilter] = useState("any");
  const [priorityFilter, setPriorityFilter] = useState("any");
  const [sourceFilter, setSourceFilter] = useState("any");
  const [dueFilter, setDueFilter] = useState("any");

  const load = useCallback(async () => {
    setLoading(true);
    const [taskRes, statusRes, priorityRes, usersRes] = await Promise.all([
      supabase.from("staff_tasks").select("*").eq("project_id", lockedProjectId).eq("is_active", true).order("created_at", { ascending: false }),
      supabase.from("status_master").select("id, code, name_en, name_gu"),
      supabase.from("priority_master").select("id, code, name_en, name_gu"),
      supabase.rpc("staff_list_assignable_users_all"),
    ]);
    if (!taskRes.error) setTasks(taskRes.data || []);
    if (!statusRes.error) setStatusById(Object.fromEntries((statusRes.data || []).map((s) => [s.id, s])));
    if (!priorityRes.error) setPriorityById(Object.fromEntries((priorityRes.data || []).map((p) => [p.id, p])));
    if (!usersRes.error) setUsersById(Object.fromEntries((usersRes.data || []).map((u) => [u.id, u])));

    const taskIds = (taskRes.data || []).map((tk) => tk.id);
    if (taskIds.length) {
      const { data: assigneeRows } = await supabase.from("staff_task_assignees").select("*").in("task_id", taskIds).eq("is_active", true);
      const grouped = {};
      (assigneeRows || []).forEach((r) => { (grouped[r.task_id] ||= []).push(r); });
      setAssigneesByTask(grouped);
    } else {
      setAssigneesByTask({});
    }
    setLoading(false);
  }, [lockedProjectId]);

  useEffect(() => { load(); }, [load]);

  // Project-scoped realtime: only this project's own tasks re-render this
  // list live — a task created for a different project never touches this
  // screen's state (Project A tasks never leak into Project B's list).
  useEffect(() => {
    return subscribeTable(`interior_project_tasks_${lockedProjectId}`, "staff_tasks", `project_id=eq.${lockedProjectId}`, (payload) => {
      if (payload.eventType === "DELETE") { setTasks((cur) => removeById(cur, payload.old.id)); return; }
      const row = payload.new;
      if (!row) return;
      if (row.is_active === false) { setTasks((cur) => removeById(cur, row.id)); return; }
      setTasks((cur) => upsertById(cur, row));
    });
  }, [lockedProjectId]);

  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = (tk) => {
    const code = statusById[tk.status_id]?.code;
    return !!tk.due_date && tk.due_date < today && !["CLOSED", "VERIFIED"].includes(code);
  };

  const filtered = useMemo(() => {
    return tasks.filter((tk) => {
      const assignees = assigneesByTask[tk.id] || [];
      if (assigneeFilter === "primary" && tk.assigned_to == null) return false;
      if (assigneeFilter === "second" && !assignees.some((a) => a.assignment_role === "secondary")) return false;
      if (statusFilter !== "any" && statusById[tk.status_id]?.code !== statusFilter) return false;
      if (priorityFilter !== "any" && priorityById[tk.priority_id]?.code !== priorityFilter) return false;
      if (sourceFilter !== "any" && (tk.source_module || "assign_task") !== sourceFilter) return false;
      if (dueFilter === "overdue" && !isOverdue(tk)) return false;
      if (dueFilter === "today" && tk.due_date !== today) return false;
      if (dueFilter === "upcoming" && !(tk.due_date && tk.due_date > today)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, assigneesByTask, assigneeFilter, statusFilter, priorityFilter, sourceFilter, dueFilter, statusById, priorityById]);

  const statCount = (code) => tasks.filter((tk) => statusById[tk.status_id]?.code === code).length;
  const stats = {
    total: tasks.length,
    assigned: statCount("ASSIGNED"),
    accepted: statCount("ACCEPTED"),
    inProgress: statCount("IN_PROGRESS"),
    onHold: statCount("ON_HOLD"),
    awaitingVerification: tasks.filter((tk) => statusById[tk.status_id]?.code === "COMPLETED").length,
    completed: tasks.filter((tk) => ["VERIFIED", "CLOSED"].includes(statusById[tk.status_id]?.code)).length,
    blocked: tasks.filter((tk) => tk.help_requested || (assigneesByTask[tk.id] || []).some((a) => a.individual_status === "BLOCKED")).length,
    overdue: tasks.filter(isOverdue).length,
  };

  return (
    <div>
      <div className="section-title">{t("siteWiseTasksLabel", lang)}</div>

      {loading && <div className="msg info">…</div>}

      <div className="kpi-grid">
        <div className="kpi-tile"><div className="num">{stats.total}</div><div className="label">{t("siteTaskStatsTotal", lang)}</div></div>
        <div className="kpi-tile"><div className="num">{stats.assigned}</div><div className="label">{lang === "gu" ? "સોંપાયેલ" : "Assigned"}</div></div>
        <div className="kpi-tile"><div className="num">{stats.accepted}</div><div className="label">{t("accept", lang)}</div></div>
        <div className="kpi-tile"><div className="num">{stats.inProgress}</div><div className="label">{t("start", lang)}</div></div>
        <div className="kpi-tile"><div className="num">{stats.onHold}</div><div className="label">{t("onHoldReasonLabel", lang)}</div></div>
        <div className="kpi-tile"><div className="num">{stats.awaitingVerification}</div><div className="label">{t("siteTaskStatsAwaitingVerification", lang)}</div></div>
        <div className="kpi-tile"><div className="num">{stats.completed}</div><div className="label">{t("complete", lang)}</div></div>
        <div className="kpi-tile"><div className="num">{stats.blocked}</div><div className="label">{t("siteTaskStatsBlocked", lang)}</div></div>
        <div className="kpi-tile gold"><div className="num">{stats.overdue}</div><div className="label">{t("siteTaskStatsOverdue", lang)}</div></div>
      </div>

      <div className="card">
        <div className="btn-row">
          <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
            <option value="any">{lang === "gu" ? "કોઈપણ સોંપાયેલ વ્યક્તિ" : "Any Assignee"}</option>
            <option value="primary">{t("primaryAssigneeLabel", lang)}</option>
            <option value="second">{t("secondAssigneeLabel", lang)}</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="any">—</option>
            {Object.values(statusById).map((s) => <option key={s.id} value={s.code}>{lang === "gu" ? s.name_gu : s.name_en}</option>)}
          </select>
          <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>
            <option value="any">—</option>
            {Object.values(priorityById).map((p) => <option key={p.id} value={p.code}>{lang === "gu" ? p.name_gu : p.name_en}</option>)}
          </select>
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
            {Object.entries(SOURCE_FILTER_LABELS).map(([key, lbl]) => (
              <option key={key} value={key}>{lang === "gu" ? lbl.gu : lbl.en}</option>
            ))}
          </select>
          <select value={dueFilter} onChange={(e) => setDueFilter(e.target.value)}>
            {Object.entries(DUE_FILTER_LABELS).map(([key, lbl]) => (
              <option key={key} value={key}>{lang === "gu" ? lbl.gu : lbl.en}</option>
            ))}
          </select>
        </div>
      </div>

      {!loading && filtered.length === 0 && <div className="msg info">{t("noTasks", lang)}</div>}

      {filtered.map((tk) => {
        const status = statusById[tk.status_id];
        const assignees = assigneesByTask[tk.id] || [];
        const second = assignees.find((a) => a.assignment_role === "secondary");
        return (
          <div className="task-card" key={tk.id}>
            <div className="top-row">
              <div>
                <div className="task-title">{tk.title}</div>
                <div className="task-number">{t("taskNumber", lang)} {tk.task_number}</div>
              </div>
              {status && <span className={`badge ${status.code}`}>{lang === "gu" ? status.name_gu : status.name_en}</span>}
            </div>
            <div className="task-meta">
              <span>{t("primaryAssigneeLabel", lang)}: {usersById[tk.assigned_to]?.full_name || "—"}</span>
              {second && <span>{t("secondAssigneeLabel", lang)}: {usersById[second.user_id]?.full_name || "—"}</span>}
              {tk.due_date && <span className={isOverdue(tk) ? "overdue" : ""}>{t("dueDate", lang)}: {tk.due_date}</span>}
            </div>
            <div className="btn-row">
              <button className="btn btn-outline" onClick={() => navigate(`/tasks?focus=${tk.id}`)}>{t("viewDetails", lang)}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
