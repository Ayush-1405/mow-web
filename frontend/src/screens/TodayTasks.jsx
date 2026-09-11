import React, { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { uploadTaskProof, resolveMimeType } from "../lib/api";
import { t } from "../lib/i18n";
import { TaskTimeline, ReassignPanel, AttachmentsList, detectFileType } from "./TaskDetail.jsx";
import { getMyInteriorProfile } from "../lib/interiorApi";
import VoiceRecorder from "./VoiceRecorder.jsx";

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
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const focusedRef = useRef(null);
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
  const [deleteConfirmFor, setDeleteConfirmFor] = useState(null);
  const [assignedItems, setAssignedItems] = useState([]);

  // Retail leads/complaints/VM-tasks and Interior snags/tasks live in
  // separate tables from staff_tasks (different lifecycle, no shared
  // status enum), so they're fetched and rendered as their own list here
  // rather than merged into the staff_tasks cards above. Scoped by the
  // caller's own department — no point querying a module the user has no
  // department match for.
  const loadAssignedItems = useCallback(async () => {
    const deptCode = lookups.departments.find((d) => d.id === profile.department_id)?.code;
    const items = [];

    if (deptCode === "RETAIL") {
      const [leadsRes, complaintsRes, vmRes] = await Promise.all([
        supabase.from("retail_leads").select("id, customer_name, status").eq("assigned_to", profile.id).eq("is_active", true).not("status", "in", "(CONVERTED,LOST)"),
        supabase.from("retail_complaints").select("id, customer_name, status").eq("assigned_to", profile.id).eq("is_active", true).not("status", "in", "(RESOLVED,CLOSED)"),
        supabase.from("retail_vm_tasks").select("id, title, status").eq("assigned_to", profile.id).eq("is_active", true).neq("status", "DONE"),
      ]);
      (leadsRes.data || []).forEach((r) => items.push({ key: `lead-${r.id}`, typeKey: "retailLeadItem", label: r.customer_name, status: r.status, route: "/retail/leads" }));
      (complaintsRes.data || []).forEach((r) => items.push({ key: `complaint-${r.id}`, typeKey: "retailComplaintItem", label: r.customer_name, status: r.status, route: "/retail/complaints" }));
      (vmRes.data || []).forEach((r) => items.push({ key: `vm-${r.id}`, typeKey: "retailDisplayItem", label: r.title, status: r.status, route: "/retail/display" }));
    }

    if (deptCode === "INTERIOR") {
      const { data: myInteriorProfile } = await getMyInteriorProfile();
      if (myInteriorProfile?.id) {
        const [snagsRes, tasksRes] = await Promise.all([
          supabase.from("snags").select("id, issue, status, projects(project_code)").eq("assigned_to", myInteriorProfile.id).neq("status", "COMPLETED"),
          supabase.from("tasks").select("id, title, status, projects(project_code)").eq("assigned_to", myInteriorProfile.id).neq("status", "COMPLETED"),
        ]);
        (snagsRes.data || []).forEach((r) => items.push({ key: `snag-${r.id}`, typeKey: "interiorSnagItem", label: `${r.projects?.project_code ? r.projects.project_code + " — " : ""}${r.issue}`, status: r.status, route: "/interior-projects/site-execution" }));
        (tasksRes.data || []).forEach((r) => items.push({ key: `itask-${r.id}`, typeKey: "interiorTaskItem", label: `${r.projects?.project_code ? r.projects.project_code + " — " : ""}${r.title}`, status: r.status, route: "/interior-projects/timeline" }));
      }
    }

    setAssignedItems(items);
  }, [lookups.departments, profile.department_id, profile.id]);

  const load = useCallback(async () => {
    setLoading(true);
    // requirement_text/quantity now live directly on staff_tasks (every
    // task, not just Bridges — see mvp_pilot_task_requirement_quantity_
    // v2_2z.sql), so a plain select("*") picks them up like any other field.
    const { data, error } = await supabase
      .from("staff_tasks")
      .select("*")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
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
    loadAssignedItems();
  }, [load, loadDirectory, loadAssignedItems]);

  // Live updates: any INSERT/UPDATE/DELETE on staff_tasks reloads the list.
  // RLS still decides which rows this subscriber actually receives.
  useEffect(() => {
    const channel = supabase
      .channel("staff_tasks_today")
      .on("postgres_changes", { event: "*", schema: "public", table: "staff_tasks" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  // Arriving here via a notification click (?focus=<task id>) or a
  // Control Tower KPI tile — open that task's Details panel and scroll it
  // into view. Tracks the last focus id actually handled (not just
  // "ever ran") so clicking a SECOND, different task notification while
  // this page is already open still re-focuses — the route doesn't
  // remount between two clicks here, only re-renders — while a later
  // realtime reload for the SAME focus id doesn't keep re-scrolling.
  useEffect(() => {
    const focusId = searchParams.get("focus");
    if (!focusId || focusId === focusedRef.current) return;
    if (!tasks.some((tsk) => tsk.id === focusId)) return;
    focusedRef.current = focusId;
    setDetailsFor(focusId);
    requestAnimationFrame(() => {
      document.getElementById(`task-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [tasks, searchParams]);

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

  // Matches exactly what staff_validate_task_transition's trigger checks
  // for each proof_types.code before it allows COMPLETED — the whole
  // point of this rewrite is that the upload actually satisfies the same
  // requirement the DB is about to enforce, instead of always guessing
  // "image" regardless of what the task actually asked for.
  async function completeWithProof(task, proofTypeCode, file, confirmationText, voiceDurationSeconds) {
    setBusyId(task.id);
    try {
      if (proofTypeCode === "photo" || proofTypeCode === "barcode") {
        if (!file) throw new Error("A photo is required to complete this task. / આ કાર્ય પૂર્ણ કરવા માટે ફોટો જરૂરી છે.");
        await uploadTaskProof({ entityType: "task", entityId: task.id, file, fileType: "image" });
      } else if (proofTypeCode === "document") {
        if (!file) throw new Error("A document (PDF/Word/Excel) is required to complete this task. / આ કાર્ય પૂર્ણ કરવા માટે દસ્તાવેજ જરૂરી છે.");
        const detected = detectFileType(resolveMimeType(file));
        if (!detected || detected === "image") {
          throw new Error("Please attach a PDF, Word, or Excel file — not a photo. / કૃપા કરીને PDF, Word અથવા Excel ફાઇલ જોડો — ફોટો નહીં.");
        }
        await uploadTaskProof({ entityType: "task", entityId: task.id, file, fileType: detected });
      } else if (proofTypeCode === "voice") {
        if (!file) throw new Error("A voice note is required to complete this task. / આ કાર્ય પૂર્ણ કરવા માટે વોઇસ નોંધ જરૂરી છે.");
        await uploadTaskProof({ entityType: "task", entityId: task.id, file, fileType: "voice", durationSeconds: voiceDurationSeconds });
      } else if (proofTypeCode === "customer_confirmation") {
        if (!confirmationText?.trim() && !file) {
          throw new Error("Enter the customer's confirmation, or attach evidence. / ગ્રાહકની પુષ્ટિ દાખલ કરો, અથવા પુરાવો જોડો.");
        }
        if (file) {
          const detected = detectFileType(resolveMimeType(file)) || "image";
          await uploadTaskProof({ entityType: "task", entityId: task.id, file, fileType: detected });
        }
      } else if (proofTypeCode !== "none") {
        // Covers any proof_type_id the active lookup no longer recognizes
        // — the DB trigger would reject this transition unconditionally
        // regardless of what's uploaded, so don't even try.
        throw new Error("This task's required proof type isn't supported in this pilot. Ask whoever created it to change the proof type. / આ કાર્યનો જરૂરી પુરાવો પ્રકાર આ પાયલોટમાં સમર્થિત નથી.");
      }

      const { error } = await supabase.rpc("staff_complete_task", {
        p_task_id: task.id,
        p_customer_confirmation_text: proofTypeCode === "customer_confirmation" ? (confirmationText?.trim() || null) : null,
      });
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

  async function handleDelete(taskId) {
    setBusyId(taskId);
    try {
      const { error } = await supabase.rpc("staff_delete_task", { p_task_id: taskId });
      if (error) throw error;
      setDeleteConfirmFor(null);
      showToast("success", "Task deleted / કાર્ય કાઢી નાખ્યું");
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

      {assignedItems.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="section-title" style={{ fontSize: 15 }}>{t("myAssignedItems", lang)}</div>
          {assignedItems.map((item) => (
            <div key={item.key} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
              <span>
                <span className="badge ASSIGNED" style={{ marginRight: 8 }}>{t(item.typeKey, lang)}</span>
                {item.label}
              </span>
              <span className="sub">{item.status}</span>
              <button className="btn btn-outline" onClick={() => navigate(item.route)}>{t("goToItem", lang)}</button>
            </div>
          ))}
        </div>
      )}

      {loading && tasks.length === 0 && <div className="msg info">…</div>}
      {!loading && tasks.length === 0 && assignedItems.length === 0 && <div className="msg info">{t("noTasks", lang)}</div>}

      {tasks.map((task) => {
        const status = statusOf(task.status_id);
        const statusCode = status?.code || "";
        const mine = task.current_owner_id === profile.id;
        const isAssignee = task.assigned_to === profile.id;
        const iAmVerifier = task.verifier_id === profile.id;
        const canManage = profile.isManagement || profile.isDeptHead;
        const iCreatedIt = task.assigned_by === profile.id;
        // staff_delete_task server-side also allows Management/Super Admin/
        // Department Head to delete ANY task, not just their own creations
        // — this mirrors that exactly (it's only the optimistic UI gate;
        // the RPC re-checks regardless of what this computes).
        const canDeleteTask = iCreatedIt || profile.isManagement || profile.isSuperAdmin || profile.isDeptHead;
        const busy = busyId === task.id;
        // Undefined here means either an unrecognized proof_type_id or one
        // that's since been deactivated (e.g. "voice" — see
        // mvp_pilot_task_proof_type_fixes_v2_30.sql, disabled because the
        // DB trigger unconditionally rejects completing it). ProofUploader
        // treats "undefined" the same as an explicitly unsupported type —
        // a clear message instead of a picker that can only ever fail.
        const proofTypeCode = lookups.proofTypes?.find((pt) => pt.id === task.proof_type_id)?.code;

        return (
          <div className="task-card" id={`task-${task.id}`} key={task.id}>
            <div className="top-row">
              <div>
                <div className="task-title">{task.title}</div>
                <div className="task-number">{t("taskNumber", lang)} {task.task_number}</div>
              </div>
              <span className={`badge ${statusCode}`}>{lang === "gu" ? status?.name_gu : status?.name_en || statusCode}</span>
            </div>
            {task.description && <div style={{ fontSize: 13, marginTop: 6 }}>{task.description}</div>}
            {task.requirement_text && (
              <div style={{ fontSize: 13, marginTop: 6 }}>
                <strong>{t("requirementText", lang)}:</strong> {task.requirement_text}
              </div>
            )}
            <div className="task-meta">
              {task.due_date && (
                <span className={isOverdue(task) ? "overdue" : ""}>
                  {t("dueDate", lang)}: {task.due_date}{isOverdue(task) ? ` · ${t("overdue", lang)}` : ""}
                </span>
              )}
              {task.reference_number && <span>{t("referenceNumber", lang)}: {task.reference_number}</span>}
              {task.quantity && <span>{t("quantity", lang)}: {task.quantity}</span>}
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
                <button
                  className="btn btn-gold"
                  disabled={busy}
                  onClick={() => (proofTypeCode === "none" ? runAction("staff_complete_task", task.id) : setProofFor(task.id))}
                >
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
              {canDeleteTask && (
                <button
                  className="btn btn-outline"
                  disabled={busy}
                  onClick={() => setDeleteConfirmFor(deleteConfirmFor === task.id ? null : task.id)}
                >
                  {t("deleteTask", lang)}
                </button>
              )}
            </div>

            {deleteConfirmFor === task.id && (
              <div className="msg error" style={{ marginTop: 10 }}>
                {t("confirmDeleteTask", lang)}
                <div className="btn-row">
                  <button className="btn btn-primary" disabled={busy} onClick={() => handleDelete(task.id)}>
                    {t("confirmDelete", lang)}
                  </button>
                  <button className="btn btn-outline" onClick={() => setDeleteConfirmFor(null)}>
                    {t("cancel", lang)}
                  </button>
                </div>
              </div>
            )}

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
                proofTypeCode={proofTypeCode}
                onCancel={() => setProofFor(null)}
                onSubmit={(file, confirmationText, voiceDurationSeconds) => completeWithProof(task, proofTypeCode, file, confirmationText, voiceDurationSeconds)}
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

const DOCUMENT_ACCEPT = "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif";

const SUPPORTED_PROOF_CODES = new Set(["photo", "barcode", "document", "voice", "customer_confirmation", "none"]);

// Adapts to the task's actual proof_type_code — matching what the DB
// trigger is about to check, instead of always assuming "attach a photo"
// regardless of what proof was actually configured (photo/barcode need an
// image, document needs a PDF/Word/Excel, voice needs a recorded note,
// customer_confirmation needs text and/or evidence, and any type this
// pilot doesn't recognize gets a clear message instead of a picker that
// can only ever fail).
function ProofUploader({ lang, busy, proofTypeCode, onCancel, onSubmit }) {
  const [file, setFile] = useState(null);
  const [confirmationText, setConfirmationText] = useState("");
  const [voiceDuration, setVoiceDuration] = useState(0);

  if (!SUPPORTED_PROOF_CODES.has(proofTypeCode)) {
    return (
      <div style={{ marginTop: 10 }}>
        <div className="msg error">
          This task's required proof type isn't supported in this pilot. Ask whoever created it to change the proof type. / આ કાર્યનો જરૂરી પુરાવો પ્રકાર આ પાયલોટમાં સમર્થિત નથી.
        </div>
        <div className="btn-row">
          <button className="btn btn-outline" onClick={onCancel}>{t("cancel", lang)}</button>
        </div>
      </div>
    );
  }

  const accept = proofTypeCode === "document" ? DOCUMENT_ACCEPT : IMAGE_ACCEPT;

  return (
    <div style={{ marginTop: 10 }}>
      {proofTypeCode === "customer_confirmation" && (
        <div className="field">
          <label>{t("customerConfirmationLabel", lang)}</label>
          <textarea value={confirmationText} onChange={(e) => setConfirmationText(e.target.value)} />
        </div>
      )}
      {proofTypeCode === "voice" && (
        <VoiceRecorder lang={lang} disabled={busy} onRecorded={(f, duration) => { setFile(f); setVoiceDuration(duration); }} />
      )}
      {proofTypeCode !== "none" && proofTypeCode !== "voice" && (
        <label className="file-input-label">
          {file ? file.name : (proofTypeCode === "document" ? t("attachDocument", lang) : t("attachProof", lang))}
          <input
            type="file"
            accept={accept}
            style={{ display: "none" }}
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
      )}
      <div className="btn-row">
        <button className="btn btn-primary" disabled={busy} onClick={() => onSubmit(file, confirmationText, voiceDuration)}>
          {busy ? t("uploading", lang) : t("complete", lang)}
        </button>
        <button className="btn btn-outline" onClick={onCancel}>{t("cancel", lang)}</button>
      </div>
    </div>
  );
}
