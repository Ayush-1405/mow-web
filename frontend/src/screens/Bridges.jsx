import React, { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "../lib/supabase";
import { t } from "../lib/i18n";
import { TaskTimeline, ReassignPanel, AttachmentsList, ProjectSiteSection } from "./TaskDetail.jsx";
import { subscribeChatBadge, taskChatUnread } from "../lib/chatApi";
import { useBreakpoint } from "../lib/useBreakpoint";
import { listInteriorPeople } from "../lib/interiorApi";
import ChatButton from "../components/ChatButton.jsx";
import ActionMenu from "../components/ActionMenu.jsx";

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
  const breakpoint = useBreakpoint();
  const [bridges, setBridges] = useState([]);
  const [tasksById, setTasksById] = useState({});
  const [usersById, setUsersById] = useState({});
  const [directory, setDirectory] = useState([]);
  const [projectsById, setProjectsById] = useState({});
  const [interiorProfilesById, setInteriorProfilesById] = useState({});
  const interiorProfilesLoadedRef = useRef(false);
  const interiorDeptId = lookups.departments.find((d) => d.code === "INTERIOR")?.id;
  const [projectFilter, setProjectFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [returnReasonFor, setReturnReasonFor] = useState(null);
  const [returnReason, setReturnReason] = useState("");
  const [detailsFor, setDetailsFor] = useState(null);
  const [reassignFor, setReassignFor] = useState(null);
  const [unreadByTask, setUnreadByTask] = useState({});
  // Inbox = incoming Bridge Tasks still waiting for acceptance (destination Head / Supervisor only).
  // Incoming = every Bridge Task routed to the department. Sent = ones this user / their department sent.
  // Assigned to me = the personal slice. Each is a different question -- never one merged list.
  const isLead = !!(profile.isDeptHead || profile.roleCode === "supervisor" || profile.isManagement || profile.isSuperAdmin);
  const bridgeTabs = [
    ...(isLead ? [["inbox", "Bridge Inbox"], ["incoming", "All Incoming"]] : []),
    ["sent", "Bridge Sent"], ["mine", "Assigned to me"],
  ];
  const [bridgeTab, setBridgeTab] = useState(isLead ? "inbox" : "mine");
  const AWAITING = new Set(["ASSIGNED", "PARTIALLY_ACCEPTED", "RETURNED", "REOPENED"]);
  function inTab(task) {
    if (!task) return false;
    switch (bridgeTab) {
      case "inbox": return task.scope_bridge_in && AWAITING.has(lookups.statusById?.[task.status_id]?.code);
      case "incoming": return task.scope_bridge_in;
      case "sent": return task.scope_bridge_sent;
      default: return task.scope_mine;
    }
  }

  const loadUnread = useCallback(async () => {
    const { data, error } = await taskChatUnread();
    if (!error) setUnreadByTask(Object.fromEntries((data || []).map((r) => [r.task_id, r.unread_count])));
  }, []);

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
        .from("staff_task_scope_v")
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

    // A Bridge task retains its originating Interior project_id (the
    // insert path is the SAME staff_tasks row staff_create_task/
    // staff_reassign_task write to regardless of is_bridge) -- this just
    // makes that already-preserved link visible on the card, so the
    // destination department's assignee clearly sees which Interior site
    // the requirement came from.
    const projectIds = Array.from(new Set(Object.values(taskMap).map((tk) => tk.project_id).filter(Boolean)));
    if (projectIds.length) {
      const { data: projRows } = await supabase
        .from("projects")
        .select("id, project_code, customer, location, lead_executive_id, executive_assistant_id, stage, archived")
        .in("id", projectIds);
      setProjectsById(Object.fromEntries((projRows || []).map((p) => [p.id, p])));
      if (!interiorProfilesLoadedRef.current) {
        interiorProfilesLoadedRef.current = true;
        const { data: peopleRows, error: peopleErr } = await listInteriorPeople();
        if (!peopleErr) setInteriorProfilesById(Object.fromEntries((peopleRows || []).map((p) => [p.id, p])));
      }
    } else {
      setProjectsById({});
    }

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
    loadUnread();
  }, [load, loadDirectory, loadUnread]);

  useEffect(() => {
    const channel = supabase
      .channel("bridges_screen")
      .on("postgres_changes", { event: "*", schema: "public", table: "bridges" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "staff_tasks" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  useEffect(() => {
    return subscribeChatBadge(profile.id, `chat-unread-bridges-${profile.id}`, loadUnread);
  }, [profile.id, loadUnread]);

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

      {Object.keys(projectsById).length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <label>{t("filterByProjectLabel", lang)}</label>
          <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="">{t("allInteriorProjectsLabel", lang)}</option>
            {Object.values(projectsById).map((p) => (
              <option key={p.id} value={p.id}>{p.project_code} — {p.customer}{p.location ? ` — ${p.location}` : ""}</option>
            ))}
          </select>
        </div>
      )}

      <div className="fx-tabs" role="tablist" aria-label="Bridge lists" style={{ marginBottom: 8 }}>
        {bridgeTabs.map(([k, lbl]) => (
          <button key={k} type="button" role="tab" aria-selected={bridgeTab === k} className={bridgeTab === k ? "active" : ""} onClick={() => setBridgeTab(k)}>{lbl}</button>
        ))}
      </div>
      {!loading && bridges.filter((b) => inTab(tasksById[b.task_id])).length === 0 && <div className="msg info">{t("noTasks", lang)}</div>}

      {bridges.filter((b) => inTab(tasksById[b.task_id]) && (!projectFilter || tasksById[b.task_id]?.project_id === projectFilter)).map((bridge) => {
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
            {task?.project_id && projectsById[task.project_id] && (
              <div className="task-meta" style={{ marginTop: 4, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700 }}>{t("siteNameLabel", lang)}: {projectsById[task.project_id].project_code} — {projectsById[task.project_id].customer}</span>
                {projectsById[task.project_id].location && <span className="sub">{t("siteLocationLabel", lang)}: {projectsById[task.project_id].location}</span>}
                {projectsById[task.project_id].lead_executive_id && (
                  <span className="sub">{t("leadExecutiveLabel", lang)}: {interiorProfilesById[projectsById[task.project_id].lead_executive_id]?.name || "—"}</span>
                )}
              </div>
            )}
            {task && !task.project_id && interiorDeptId && [task.from_department_id, task.to_department_id].includes(interiorDeptId) && (
              <div className="task-meta" style={{ marginTop: 4 }}>
                <span className="sub">{t("generalInteriorTaskLabel", lang)}</span>
              </div>
            )}
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
                <div className="task-actions-secondary">
                  <ChatButton taskId={task.id} unread={unreadByTask[task.id] || 0} wrapStyle={{ minWidth: 0 }} />
                  {breakpoint === "mobile" && (
                    <button className="btn btn-outline" onClick={() => setDetailsFor(detailsFor === task.id ? null : task.id)} aria-expanded={detailsFor === task.id}>
                      {detailsFor === task.id ? t("hideDetails", lang) : t("viewDetails", lang)}
                    </button>
                  )}
                  <ActionMenu
                    label={t("moreActions", lang)}
                    items={[
                      canManage && ["ASSIGNED", "RETURNED", "ACCEPTED", "IN_PROGRESS"].includes(statusCode) && {
                        key: "reassign", label: t("reassign", lang), disabled: busy, onClick: () => setReassignFor(reassignFor === task.id ? null : task.id),
                      },
                      breakpoint !== "mobile" && {
                        key: "details", label: detailsFor === task.id ? t("hideDetails", lang) : t("viewDetails", lang), onClick: () => setDetailsFor(detailsFor === task.id ? null : task.id),
                      },
                    ].filter(Boolean)}
                  />
                </div>
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
                {(task.project_id || (interiorDeptId && [task.from_department_id, task.to_department_id].includes(interiorDeptId))) && (
                  <ProjectSiteSection
                    task={task}
                    lang={lang}
                    profile={profile}
                    projectsById={projectsById}
                    profilesById={interiorProfilesById}
                    showToast={showToast}
                    onChanged={load}
                  />
                )}
                <AttachmentsList taskId={task.id} lang={lang} showToast={showToast} />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
