import React, { useEffect, useState, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { uploadTaskProof } from "../lib/api";
import { t } from "../lib/i18n";
import { TaskTimeline, ReassignPanel, AttachmentsList } from "./TaskDetail.jsx";

// Today's Tasks. Reads public.staff_tasks through the normal RLS-scoped
// client (staff_tasks_select_scoped decides which rows come back — this
// screen does not add its own visibility filter beyond "due today or
// overdue and still open"). Every state-changing action calls one of the
// approved staff_* RPCs; nothing here writes to staff_tasks directly.
//
// Action-button gating matches exactly what each RPC authorizes server-
// side: staff_accept_task/staff_return_task (from ASSIGNED/RETURNED) check
// `assigned_to`, while staff_start_task/staff_complete_task/staff_return_task
// (from ACCEPTED/IN_PROGRESS) check `current_owner_id`. Gating on the wrong
// column here would only hide/show a button incorrectly — the RPC itself
// remains the real authorization boundary either way.
export default function TodayTasks({ lang, profile, lookups, showToast }) {
  const [tasks, setTasks] = useState([]);
  const [usersById, setUsersById] = useState({});
  const [directory, setDirectory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [returnReasonFor, setReturnReasonFor] = useState(null);
  const [returnReason, setReturnReason] = useState("");
  const [proofFor, setProofFor] = useState(null);
  const [detailsFor, setDetailsFor] = useState(null);
  const [reassignFor, setReassignFor] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("staff_tasks")
      .select("*")
      .eq("is_active", true)
      .order("due_date", { ascending: true })
      .limit(100);
    if (error) {
      showToast("error", error.message);
    } else {
      setTasks(data || []);
    }
    setLoading(false);
  }, [showToast]);

  // Directory used only to resolve ids to names in the timeline and to
  // populate the Reassign candidate list — same RPC AssignTask.jsx already
  // uses, scoped server-side to what this caller is authorized to see.
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

  // Live updates: any INSERT/UPDATE/DELETE on staff_tasks reloads the list.
  // RLS still decides which rows this subscriber actually receives.
  useEffect(() => {
    const channel = supabase
      .channel("staff_tasks_today")
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

  async function completeWithProof(task, file) {
    setBusyId(task.id);
    try {
      if (file) {
        await uploadTaskProof({ entityType: "task", entityId: task.id, file, fileType: "photo" });
      }
      const { error } = await supabase.rpc("staff_complete_task", { p_task_id: task.id });
      if (error) throw error;
      setProofFor(null);
      showToast("success", "Task completed / કાર્ય પૂર્ણ થયું");
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

  const statusOf = (id) => lookups.statusById[id];
  const isOverdue = (task) => {
    const s = statusOf(task.status_id)?.code;
    if (!task.due_date || s === "CLOSED" || s === "VERIFIED") return false;
    return task.due_date < new Date().toISOString().slice(0, 10);
  };

  return (
    <div>
      <div className="section-title">{t("todaysTasks", lang)}</div>
      <button className="btn btn-outline" style={{ marginBottom: 10 }} onClick={load} disabled={loading}>
        {t("refresh", lang)}
      </button>

      {loading && tasks.length === 0 && <div className="msg info">…</div>}
      {!loading && tasks.length === 0 && <div className="msg info">{t("noTasks", lang)}</div>}

      {tasks.map((task) => {
        const status = statusOf(task.status_id);
        const statusCode = status?.code || "";
        const mine = task.current_owner_id === profile.id;
        const isAssignee = task.assigned_to === profile.id;
        const iAmVerifier = task.verifier_id === profile.id;
        const canManage = profile.isManagement || profile.isDeptHead;
        const busy = busyId === task.id;

        return (
          <div className="task-card" key={task.id}>
            <div className="top-row">
              <div>
                <div className="task-title">{task.title}</div>
                <div className="task-number">{t("taskNumber", lang)} {task.task_number}</div>
              </div>
              <span className={`badge ${statusCode}`}>{lang === "gu" ? status?.name_gu : status?.name_en || statusCode}</span>
            </div>
            {task.description && <div style={{ fontSize: 13, marginTop: 6 }}>{task.description}</div>}
            <div className="task-meta">
              {task.due_date && (
                <span className={isOverdue(task) ? "overdue" : ""}>
                  {t("dueDate", lang)}: {task.due_date}{isOverdue(task) ? ` · ${t("overdue", lang)}` : ""}
                </span>
              )}
              {task.is_bridge && <span>🌉 {t("bridges", lang)}</span>}
              {task.help_requested && <span>🆘 {t("requestHelp", lang)}</span>}
            </div>

            {statusCode === "RETURNED" && task.return_reason && (
              <div className="msg info" style={{ marginTop: 8 }}>
                {t("returnedReason", lang)}: {task.return_reason}
              </div>
            )}

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
                <button className="btn btn-gold" disabled={busy} onClick={() => setProofFor(task.id)}>
                  {t("complete", lang)}
                </button>
              )}
              {statusCode === "COMPLETED" && iAmVerifier && (
                <button className="btn btn-gold" disabled={busy} onClick={() => runAction("staff_verify_task", task.id)}>
                  {t("verify", lang)}
                </button>
              )}
              {statusCode === "VERIFIED" && (canManage || task.assigned_by === profile.id) && (
                <button className="btn btn-primary" disabled={busy} onClick={() => runAction("staff_close_task", task.id)}>
                  {t("close", lang)}
                </button>
              )}
              {!task.help_requested && ["ACCEPTED", "IN_PROGRESS"].includes(statusCode) && mine && (
                <button
                  className="btn btn-outline"
                  disabled={busy}
                  onClick={() => runAction("staff_request_help", task.id, { p_note: "" })}
                >
                  {t("requestHelp", lang)}
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

            {returnReasonFor === task.id && (
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

            {proofFor === task.id && (
              <ProofUploader
                lang={lang}
                busy={busy}
                onCancel={() => setProofFor(null)}
                onSubmit={(file) => completeWithProof(task, file)}
              />
            )}

            {reassignFor === task.id && (
              <ReassignPanel
                task={task}
                candidates={directory}
                lang={lang}
                busy={busy}
                onCancel={() => setReassignFor(null)}
                onSubmit={(payload) => submitReassign(task.id, payload)}
              />
            )}

            {detailsFor === task.id && (
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

function ProofUploader({ lang, busy, onCancel, onSubmit }) {
  const [file, setFile] = useState(null);
  return (
    <div style={{ marginTop: 10 }}>
      <label className="file-input-label">
        {file ? file.name : t("attachProof", lang)}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          style={{ display: "none" }}
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
      </label>
      <div className="btn-row">
        <button className="btn btn-primary" disabled={busy} onClick={() => onSubmit(file)}>
          {busy ? t("uploading", lang) : t("complete", lang)}
        </button>
        <button className="btn btn-outline" onClick={onCancel}>{t("cancel", lang)}</button>
      </div>
    </div>
  );
}
