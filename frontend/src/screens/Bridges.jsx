import React, { useEffect, useState, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { t } from "../lib/i18n";
import { TaskTimeline, ReassignPanel, AttachmentsList } from "./TaskDetail.jsx";

// Cross-department Bridge screen. Reads public.bridges (RLS-scoped via
// bridges_select_scoped) joined against its linked staff_tasks row for
// status/title. A Bridge IS a staff_tasks row underneath (is_bridge=true)
// with this extra handoff record layered on it, so every state change here
// goes through the exact same approved staff_* task RPCs used on the
// Today's Tasks screen, called against bridges.task_id.
//
// Action gating mirrors TodayTasks.jsx exactly: staff_accept_task/
// staff_return_task (from ASSIGNED/RETURNED) authorize on `assigned_to`;
// staff_start_task/staff_complete_task/staff_return_task (from ACCEPTED/
// IN_PROGRESS) authorize on `current_owner_id`.
// Resolves a user id to a display label via the loaded directory —
// {full_name} ({employee_code}) — or "—" if the id is missing or the user
// isn't in this caller's directory scope.
function userLabel(usersById, id) {
  if (!id) return "—";
  const u = usersById[id];
  return u ? `${u.full_name} (${u.employee_code})` : "—";
}

export default function Bridges({ lang, profile, lookups, showToast }) {
  const [bridges, setBridges] = useState([]);
  const [tasksById, setTasksById] = useState({});
  const [usersById, setUsersById] = useState({});
  const [directory, setDirectory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [returnReasonFor, setReturnReasonFor] = useState(null);
  const [returnReason, setReturnReason] = useState("");
  const [detailsFor, setDetailsFor] = useState(null);
  const [reassignFor, setReassignFor] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: bridgeRows, error: bridgeErr } = await supabase
      .from("bridges")
      .select("*")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(100);
    if (bridgeErr) {
      showToast("error", bridgeErr.message);
      setLoading(false);
      return;
    }
    const taskIds = [...new Set((bridgeRows || []).map((b) => b.task_id))];
    let taskMap = {};
    if (taskIds.length > 0) {
      const { data: taskRows, error: taskErr } = await supabase
        .from("staff_tasks")
        .select("*")
        .in("id", taskIds);
      if (taskErr) {
        showToast("error", taskErr.message);
      } else {
        taskMap = Object.fromEntries((taskRows || []).map((row) => [row.id, row]));
      }
    }
    setBridges(bridgeRows || []);
    setTasksById(taskMap);
    setLoading(false);
  }, [showToast]);

  const loadDirectory = useCallback(async () => {
    const { data, error } = await supabase.rpc("staff_list_assignable_users_all");
    if (!error) {
      setDirectory(data || []);
      setUsersById(Object.fromEntries((data || []).map((u) => [u.id, u])));
    }
  }, []);

  useEffect(() => {
    load();
    loadDirectory();
  }, [load, loadDirectory]);

  useEffect(() => {
    const channel = supabase
      .channel("bridges_screen")
      .on("postgres_changes", { event: "*", schema: "public", table: "bridges" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "staff_tasks" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  async function runAction(rpcName, taskId, extraArgs = {}) {
    setBusyId(taskId);
    try {
      const { error } = await supabase.rpc(rpcName, { p_task_id: taskId, ...extraArgs });
      if (error) throw error;
      showToast("success", "Done / થઈ ગયું");
      await load();
    } catch (err) {
      showToast("error", err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function submitReturn(taskId) {
    if (!returnReason.trim()) return;
    setBusyId(taskId);
    try {
      const { error } = await supabase.rpc("staff_return_task", { p_task_id: taskId, p_reason: returnReason.trim() });
      if (error) throw error;
      setReturnReasonFor(null);
      setReturnReason("");
      showToast("success", "Task returned / કાર્ય પરત કરાયું");
      await load();
    } catch (err) {
      showToast("error", err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function submitReassign(taskId, payload) {
    setBusyId(taskId);
    try {
      const { error } = await supabase.rpc("staff_reassign_task", payload);
      if (error) throw error;
      setReassignFor(null);
      showToast("success", payload.p_new_to_department_id ? `${t("reassigned", lang)} — ${t("bridgeCreated", lang)}` : t("reassigned", lang));
      await load();
    } catch (err) {
      showToast("error", err.message);
    } finally {
      setBusyId(null);
    }
  }

  const deptName = (id) => lookups.departmentById[id]?.[lang === "gu" ? "name_gu" : "name_en"] || "—";
  const priorityOf = (id) => lookups.priorities.find((p) => p.id === id);
  const taskTypeOf = (id) => lookups.taskTypes.find((tt) => tt.id === id);
  const isOverdue = (task) => {
    const s = lookups.statusById[task.status_id]?.code;
    if (!task.due_date || s === "CLOSED" || s === "VERIFIED") return false;
    return task.due_date < new Date().toISOString().slice(0, 10);
  };

  return (
    <div>
      <div className="section-title">{t("bridges", lang)}</div>
      <button className="btn btn-outline" style={{ marginBottom: 10 }} onClick={load} disabled={loading}>
        {t("refresh", lang)}
      </button>

      {!loading && bridges.length === 0 && <div className="msg info">{t("noTasks", lang)}</div>}

      {bridges.map((bridge) => {
        const task = tasksById[bridge.task_id];
        const status = task ? lookups.statusById[task.status_id] : null;
        const statusCode = status?.code || "";
        const mine = task && task.current_owner_id === profile.id;
        const isAssignee = task && task.assigned_to === profile.id;
        const iAmVerifier = task && task.verifier_id === profile.id;
        const canManage = profile.isManagement || profile.isDeptHead;
        const busy = busyId === bridge.task_id;

        return (
          <div className="task-card" key={bridge.id}>
            <div className="top-row">
              <div>
                <div className="task-title">{task?.title || bridge.bridge_number}</div>
                <div className="task-number">{bridge.bridge_number}</div>
              </div>
              {status && <span className={`badge ${statusCode}`}>{lang === "gu" ? status.name_gu : status.name_en}</span>}
            </div>
            <div style={{ fontSize: 13, marginTop: 6 }}>{bridge.requirement_text}</div>
            {task?.description && <div style={{ fontSize: 13, marginTop: 4 }}>{task.description}</div>}
            {bridge.quantity && <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{t("quantity", lang)}: {bridge.quantity}</div>}

            <div className="task-meta">
              <span>{deptName(bridge.from_department_id)} → {deptName(bridge.to_department_id)}</span>
              {task?.reference_number && <span>{t("referenceNumber", lang)}: {task.reference_number}</span>}
              {task?.task_type_id && <span>{lang === "gu" ? taskTypeOf(task.task_type_id)?.name_gu : taskTypeOf(task.task_type_id)?.name_en}</span>}
              {task?.priority_id && (
                <span>
                  <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: priorityOf(task.priority_id)?.color_code || "var(--ink-soft)", marginRight: 4 }} />
                  {lang === "gu" ? priorityOf(task.priority_id)?.name_gu : priorityOf(task.priority_id)?.name_en}
                </span>
              )}
              {task?.due_date && (
                <span className={isOverdue(task) ? "overdue" : ""}>
                  {t("dueDate", lang)}: {task.due_date}{task.due_time ? ` ${task.due_time}` : ""}{isOverdue(task) ? ` · ${t("overdue", lang)}` : ""}
                </span>
              )}
            </div>

            {task && (
              <div className="task-meta">
                <span>{t("assignedTo", lang)}: {userLabel(usersById, task.assigned_to)}</span>
                <span>{t("verifier", lang)}: {userLabel(usersById, task.verifier_id)}</span>
                {task.current_owner_id !== task.assigned_to && (
                  <span>{t("owner", lang)}: {userLabel(usersById, task.current_owner_id)}</span>
                )}
              </div>
            )}

            {statusCode === "RETURNED" && task?.return_reason && (
              <div className="msg info" style={{ marginTop: 8 }}>
                {t("returnedReason", lang)}: {task.return_reason}
              </div>
            )}

            {task && (
              <div className="btn-row">
                {statusCode === "ASSIGNED" && isAssignee && (
                  <>
                    <button className="btn btn-gold" disabled={busy} onClick={() => runAction("staff_accept_task", task.id)}>
                      {t("accept", lang)}
                    </button>
                    <button className="btn btn-outline" disabled={busy} onClick={() => setReturnReasonFor(task.id)}>
                      {t("returnTask", lang)}
                    </button>
                  </>
                )}
                {statusCode === "RETURNED" && isAssignee && (
                  <button className="btn btn-gold" disabled={busy} onClick={() => runAction("staff_accept_task", task.id)}>
                    {t("accept", lang)}
                  </button>
                )}
                {statusCode === "ACCEPTED" && mine && (
                  <>
                    <button className="btn btn-gold" disabled={busy} onClick={() => runAction("staff_start_task", task.id)}>
                      {t("start", lang)}
                    </button>
                    <button className="btn btn-outline" disabled={busy} onClick={() => setReturnReasonFor(task.id)}>
                      {t("returnTask", lang)}
                    </button>
                  </>
                )}
                {statusCode === "IN_PROGRESS" && mine && (
                  <button className="btn btn-gold" disabled={busy} onClick={() => runAction("staff_complete_task", task.id)}>
                    {t("complete", lang)}
                  </button>
                )}
                {statusCode === "COMPLETED" && iAmVerifier && (
                  <button className="btn btn-gold" disabled={busy} onClick={() => runAction("staff_verify_task", task.id)}>
                    {t("verify", lang)}
                  </button>
                )}
                {statusCode === "VERIFIED" && (profile.isManagement || profile.isDeptHead) && (
                  <button className="btn btn-primary" disabled={busy} onClick={() => runAction("staff_close_task", task.id)}>
                    {t("close", lang)}
                  </button>
                )}
                {canManage && ["ASSIGNED", "RETURNED", "ACCEPTED", "IN_PROGRESS"].includes(statusCode) && (
                  <button
                    className="btn btn-outline"
                    disabled={busy}
                    onClick={() => setReassignFor(reassignFor === task.id ? null : task.id)}
                  >
                    {t("reassign", lang)}
                  </button>
                )}
                <button
                  className="btn btn-outline"
                  onClick={() => setDetailsFor(detailsFor === task.id ? null : task.id)}
                >
                  {detailsFor === task.id ? t("hideDetails", lang) : t("viewDetails", lang)}
                </button>
              </div>
            )}

            {task && returnReasonFor === task.id && (
              <div style={{ marginTop: 10 }}>
                <label>{t("reason", lang)}</label>
                <textarea value={returnReason} onChange={(e) => setReturnReason(e.target.value)} />
                <div className="btn-row">
                  <button className="btn btn-primary" disabled={busy} onClick={() => submitReturn(task.id)}>
                    {t("submit", lang)}
                  </button>
                  <button className="btn btn-outline" onClick={() => { setReturnReasonFor(null); setReturnReason(""); }}>
                    {t("cancel", lang)}
                  </button>
                </div>
              </div>
            )}

            {task && reassignFor === task.id && (
              <ReassignPanel
                task={task}
                candidates={directory}
                lang={lang}
                busy={busy}
                onCancel={() => setReassignFor(null)}
                onSubmit={(payload) => submitReassign(task.id, payload)}
              />
            )}

            {task && detailsFor === task.id && (
              <>
                <TaskTimeline task={task} usersById={usersById} lang={lang} />
                <AttachmentsList taskId={task.id} lang={lang} showToast={showToast} />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
