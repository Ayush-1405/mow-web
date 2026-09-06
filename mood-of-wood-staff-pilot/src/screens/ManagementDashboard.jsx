import React, { useEffect, useState, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { t } from "../lib/i18n";

// Management Dashboard. Every count below is derived from the SAME
// RLS-scoped reads used elsewhere (staff_tasks_select_scoped, bridges_
// select_scoped) — a Management user sees the full pilot picture because
// that policy already grants them that scope; a Department Head sees their
// own department's picture for the same reason. This screen adds no new
// data access of its own.
//
// Bridge workflow status is read from the LINKED TASK's status_id, never
// from bridges.acceptance_status — that column only ever reflects the
// Accept/Return handoff step (staff_accept_task/staff_return_task are the
// only RPCs that touch it); Start/Complete/Verify/Close never update it, so
// treating it as the bridge's overall lifecycle status would keep counting
// a fully closed bridge as still open forever.
export default function ManagementDashboard({ lang, lookups, showToast }) {
  const [tasks, setTasks] = useState([]);
  const [bridges, setBridges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [taskRes, bridgeRes] = await Promise.all([
      supabase.from("staff_tasks").select("*").eq("is_active", true).limit(500),
      supabase.from("bridges").select("*").eq("is_active", true).limit(500),
    ]);
    if (taskRes.error) showToast("error", taskRes.error.message);
    else setTasks(taskRes.data || []);
    if (bridgeRes.error) showToast("error", bridgeRes.error.message);
    else setBridges(bridgeRes.data || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  // Live KPIs: any task/bridge change reloads the dashboard instead of
  // requiring a manual Refresh click.
  useEffect(() => {
    const channel = supabase
      .channel("management_dashboard")
      .on("postgres_changes", { event: "*", schema: "public", table: "staff_tasks" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "bridges" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  const today = new Date().toISOString().slice(0, 10);
  const statusCode = (id) => lookups.statusById[id]?.code;
  const deptName = (id) => lookups.departmentById[id]?.[lang === "gu" ? "name_gu" : "name_en"] || "—";
  const tasksById = Object.fromEntries(tasks.map((tsk) => [tsk.id, tsk]));

  const open = tasks.filter((tsk) => statusCode(tsk.status_id) !== "CLOSED");
  const overdue = open
    .filter((tsk) => tsk.due_date && tsk.due_date < today && statusCode(tsk.status_id) !== "VERIFIED")
    .sort((a, b) => (a.due_date || "").localeCompare(b.due_date || ""));
  const awaitingVerification = tasks.filter((tsk) => statusCode(tsk.status_id) === "COMPLETED");

  const bridgesWithTask = bridges.map((b) => ({ bridge: b, task: tasksById[b.task_id] }));
  const openBridges = bridgesWithTask.filter(({ task }) => !task || statusCode(task.status_id) !== "CLOSED");

  const byStatus = {};
  for (const tsk of tasks) {
    const code = statusCode(tsk.status_id) || "—";
    byStatus[code] = (byStatus[code] || 0) + 1;
  }

  const byDepartment = {};
  for (const tsk of open) {
    const key = deptName(tsk.to_department_id);
    byDepartment[key] = (byDepartment[key] || 0) + 1;
  }
  const departmentRows = Object.entries(byDepartment).sort((a, b) => b[1] - a[1]);

  const bridgeByStatus = {};
  for (const { task } of bridgesWithTask) {
    const code = task ? statusCode(task.status_id) || "—" : "—";
    bridgeByStatus[code] = (bridgeByStatus[code] || 0) + 1;
  }
  const bridgeStatusRows = Object.entries(bridgeByStatus);

  const bridgeByRoute = {};
  for (const { bridge } of bridgesWithTask) {
    const key = `${deptName(bridge.from_department_id)} → ${deptName(bridge.to_department_id)}`;
    bridgeByRoute[key] = (bridgeByRoute[key] || 0) + 1;
  }
  const bridgeRouteRows = Object.entries(bridgeByRoute).sort((a, b) => b[1] - a[1]);

  function toggle(section) {
    setExpanded((cur) => (cur === section ? null : section));
  }

  return (
    <div>
      <div className="section-title">{t("dashboard", lang)}</div>
      <button className="btn btn-outline" style={{ marginBottom: 10 }} onClick={load} disabled={loading}>
        {t("refresh", lang)}
      </button>

      <div className="kpi-grid">
        <button className="kpi-tile" onClick={() => toggle("open")}>
          <div className="num">{open.length}</div><div className="label">{t("totalOpen", lang)}</div>
        </button>
        <button className="kpi-tile gold" onClick={() => toggle("overdue")}>
          <div className="num">{overdue.length}</div><div className="label">{t("overdue", lang)}</div>
        </button>
        <button className="kpi-tile" onClick={() => toggle("awaiting")}>
          <div className="num">{awaitingVerification.length}</div><div className="label">{t("awaitingVerification", lang)}</div>
        </button>
        <button className="kpi-tile" onClick={() => toggle("bridges")}>
          <div className="num">{openBridges.length}</div><div className="label">{t("openBridges", lang)}</div>
        </button>
      </div>

      {expanded === "open" && (
        <div className="card">
          <h2>{t("totalOpen", lang)}</h2>
          {open.length === 0 && <div className="msg info">{t("noTasks", lang)}</div>}
          {open.map((tsk) => (
            <div key={tsk.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span>{tsk.task_number} — {tsk.title}</span>
              <span className={`badge ${statusCode(tsk.status_id)}`}>{statusCode(tsk.status_id)}</span>
            </div>
          ))}
        </div>
      )}

      {expanded === "overdue" && (
        <div className="card">
          <h2>{t("overdue", lang)}</h2>
          {overdue.length === 0 && <div className="msg info">{t("noTasks", lang)}</div>}
          {overdue.map((tsk) => (
            <div key={tsk.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span>{tsk.task_number} — {tsk.title}</span>
              <span className="overdue">{tsk.due_date}</span>
            </div>
          ))}
        </div>
      )}

      {expanded === "awaiting" && (
        <div className="card">
          <h2>{t("awaitingVerification", lang)}</h2>
          {awaitingVerification.length === 0 && <div className="msg info">{t("noTasks", lang)}</div>}
          {awaitingVerification.map((tsk) => (
            <div key={tsk.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span>{tsk.task_number} — {tsk.title}</span>
              <span>{deptName(tsk.to_department_id)}</span>
            </div>
          ))}
        </div>
      )}

      {expanded === "bridges" && (
        <div className="card">
          <h2>{t("openBridges", lang)}</h2>
          {openBridges.length === 0 && <div className="msg info">{t("noBridges", lang)}</div>}
          {openBridges.map(({ bridge, task }) => (
            <div key={bridge.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span>{bridge.bridge_number} — {task?.title || "—"}</span>
              {task && <span className={`badge ${statusCode(task.status_id)}`}>{statusCode(task.status_id)}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="dashboard-grid">
        <div className="card">
          <h2>{t("status", lang)}</h2>
          {Object.entries(byStatus).map(([code, count]) => (
            <div key={code} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span className={`badge ${code}`}>{code}</span>
              <span>{count}</span>
            </div>
          ))}
        </div>

        <div className="card">
          <h2>{t("departmentBreakdown", lang)}</h2>
          {departmentRows.length === 0 && <div className="msg info">{t("noTasks", lang)}</div>}
          {departmentRows.map(([name, count]) => (
            <div key={name} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span>{name}</span>
              <span>{count}</span>
            </div>
          ))}
        </div>

        <div className="card">
          <h2>{t("bridgeStatus", lang)}</h2>
          {bridgeStatusRows.length === 0 && <div className="msg info">{t("noBridges", lang)}</div>}
          {bridgeStatusRows.map(([code, count]) => (
            <div key={code} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span className={`badge ${code}`}>{code}</span>
              <span>{count}</span>
            </div>
          ))}
        </div>

        <div className="card">
          <h2>{t("bridgeRoutes", lang)}</h2>
          {bridgeRouteRows.length === 0 && <div className="msg info">{t("noBridges", lang)}</div>}
          {bridgeRouteRows.map(([route, count]) => (
            <div key={route} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span>{route}</span>
              <span>{count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
