import React, { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { uploadTaskProof, resolveMimeType } from "../lib/api";
import { t } from "../lib/i18n";
import { TaskTimeline, ReassignPanel, AttachmentsList, AssignedTeamSection, TaskConversation, ProjectSiteSection, detectFileType } from "./TaskDetail.jsx";
import { getMyInteriorProfile, listInteriorPeople } from "../lib/interiorApi";
import { subscribeTable, upsertById, removeById } from "../lib/realtime";
import { useForegroundRefresh } from "../lib/useForegroundRefresh";
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
  const [assigneesByTask, setAssigneesByTask] = useState({});
  const [projectsById, setProjectsById] = useState({});
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
  const [unreadByTask, setUnreadByTask] = useState({});
  const [interiorProfilesById, setInteriorProfilesById] = useState({});
  const interiorProfilesLoadedRef = useRef(false);
  const [projectFilter, setProjectFilter] = useState("");
  const interiorDeptId = lookups.departments.find((d) => d.code === "INTERIOR")?.id;

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
        (tasksRes.data || []).forEach((r) => items.push({ key: `itask-${r.id}`, typeKey: "interiorTaskItem", label: `${r.projects?.project_code ? r.projects.project_code + " — " : ""}${r.title}`, status: r.status, route: "/interior-projects/project-timeline" }));
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
      setLoading(false);
      return;
    }
    setTasks(data || []);
    // Project-linked tasks (e.g. from Daily Site Updates) need the
    // project's code/customer/location shown as its own field, never
    // buried inside the description — a second small query only for the
    // distinct project_ids actually present, not every project this user
    // can see.
    const projectIds = Array.from(new Set((data || []).map((tsk) => tsk.project_id).filter(Boolean)));
    if (projectIds.length) {
      const { data: projRows } = await supabase
        .from("projects")
        .select("id, project_code, customer, location, lead_executive_id, executive_assistant_id, stage, archived")
        .in("id", projectIds);
      setProjectsById(Object.fromEntries((projRows || []).map((p) => [p.id, p])));
      // Lead Executive/Executive Assistant names live in Interior's own
      // `profiles` table (a different id space from user_profiles) —
      // loaded once, lazily, only once a project-linked task is actually
      // visible, so a non-Interior caller never pays for this query.
      if (!interiorProfilesLoadedRef.current) {
        interiorProfilesLoadedRef.current = true;
        const { data: peopleRows, error: peopleErr } = await listInteriorPeople();
        if (!peopleErr) setInteriorProfilesById(Object.fromEntries((peopleRows || []).map((p) => [p.id, p])));
      }
    } else {
      setProjectsById({});
    }
    // Second Assignee: staff_task_assignees rows for every visible task
    // (RLS-scoped the same as staff_tasks itself) -- lets a task show
    // "Working With" plus each person's own acceptance/individual status,
    // and lets action-button gating check the caller's own row instead of
    // only the shared assigned_to/current_owner_id scalar columns.
    const taskIds = (data || []).map((tsk) => tsk.id);
    if (taskIds.length) {
      const { data: assigneeRows } = await supabase.from("staff_task_assignees").select("*").in("task_id", taskIds).eq("is_active", true);
      const grouped = {};
      (assigneeRows || []).forEach((r) => { (grouped[r.task_id] ||= []).push(r); });
      setAssigneesByTask(grouped);
    } else {
      setAssigneesByTask({});
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

  // Per-task unread-reply count (staff_task_unread_message_counts is scoped
  // to whatever tasks staff_task_visible already lets this caller see — no
  // separate authorization check needed here).
  const loadUnread = useCallback(async () => {
    const { data, error } = await supabase.rpc("staff_task_unread_message_counts");
    if (!error) setUnreadByTask(Object.fromEntries((data || []).map((r) => [r.task_id, r.unread_count])));
  }, []);

  useEffect(() => {
    load();
    loadDirectory();
    loadAssignedItems();
    loadUnread();
  }, [load, loadDirectory, loadAssignedItems, loadUnread]);

  // Live updates: any reply anywhere this caller can see re-derives the
  // unread badges immediately — an open TaskConversation panel keeps its
  // own separate realtime subscription (TaskDetail.jsx) for the message
  // list itself; this one only drives the per-card "Reply (N)" badges.
  useEffect(() => {
    return subscribeTable("task_messages_unread_today", "task_messages", null, () => loadUnread());
  }, [loadUnread]);

  // Live updates: merge INSERT/UPDATE straight into `tasks` instead of a
  // full refetch (spec'd "person-wise Today's Tasks realtime" pattern) --
  // RLS still decides which rows this subscriber actually receives, so a
  // task reassigned away from this user (assigned_to/current_owner_id
  // changed to someone else) simply stops arriving as an event for them;
  // staff_delete_task soft-deletes (is_active=false), which arrives as an
  // UPDATE, so that case is handled the same way as a real DELETE below.
  useEffect(() => {
    return subscribeTable("staff_tasks_today", "staff_tasks", null, (payload) => {
      if (payload.eventType === "DELETE") {
        setTasks((cur) => removeById(cur, payload.old.id));
        return;
      }
      const row = payload.new;
      if (!row) return;
      if (row.is_active === false) {
        setTasks((cur) => removeById(cur, row.id));
        return;
      }
      setTasks((cur) => upsertById(cur, row));
      if (row.project_id) {
        setProjectsById((cur) => {
          if (cur[row.project_id]) return cur;
          supabase.from("projects").select("id, project_code, customer, location").eq("id", row.project_id).maybeSingle()
            .then(({ data }) => { if (data) setProjectsById((c) => ({ ...c, [data.id]: data })); });
          return cur;
        });
      }
    });
  }, []);

  // Second Assignee: merge INSERT/UPDATE/DELETE straight into
  // assigneesByTask instead of a full refetch -- when someone is newly
  // added as a second assignee, this arrives here immediately and the task
  // itself arrives via the staff_tasks channel above (RLS now allows it),
  // so the two together are what makes the task show up in Today's Tasks
  // live with no duplicate card (one INSERT event per table, merged into
  // two different pieces of state, never two task cards).
  useEffect(() => {
    return subscribeTable("staff_task_assignees_today", "staff_task_assignees", null, (payload) => {
      const row = payload.new || payload.old;
      if (!row) return;
      setAssigneesByTask((cur) => {
        const list = cur[row.task_id] || [];
        let nextList;
        if (payload.eventType === "DELETE" || row.is_active === false) {
          nextList = list.filter((r) => r.id !== row.id);
        } else {
          nextList = list.some((r) => r.id === row.id) ? list.map((r) => (r.id === row.id ? row : r)) : [...list, row];
        }
        return { ...cur, [row.task_id]: nextList };
      });
    });
  }, []);

  // Catches anything a dropped websocket might have missed (phone locked,
  // brief network drop) -- a silent background refetch, never a forced
  // logout or page reload.
  useForegroundRefresh(useCallback(() => { load(); loadUnread(); }, [load, loadUnread]));

  // Arriving here via a notification click (?focus=<task id>) or a
  // Control Tower KPI tile — open that task's Details panel and scroll it
  // into view. Tracks the last focus id actually handled (not just
  // "ever ran") so clicking a SECOND, different task notification while
  // this page is already open still re-focuses — the route doesn't
  // remount between two clicks here, only re-renders — while a later
  // realtime reload for the SAME focus id doesn't keep re-scrolling.
  useEffect(() => {
    const focusId = searchParams.get("focus");
    const messageId = searchParams.get("message");
    if (!focusId || focusId === focusedRef.current) return;
    if (!tasks.some((tsk) => tsk.id === focusId)) return;
    focusedRef.current = focusId;
    setDetailsFor(focusId);
    requestAnimationFrame(() => {
      const anchor = messageId ? `conversation-${focusId}` : `task-${focusId}`;
      document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [tasks, searchParams]);

  const highlightMessageId = searchParams.get("message");

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
  const todayStr = new Date().toISOString().slice(0, 10);
  const isOverdue = (task) => {
    const s = statusOf(task.status_id)?.code;
    if (!task.due_date || s === "CLOSED" || s === "VERIFIED") return false;
    return task.due_date < todayStr;
  };
  // Today/overdue/no-due-date tasks stay in the primary list exactly as
  // before; anything due strictly after today moves under its own
  // "Upcoming" heading instead of being mixed in unconditionally.
  const isUpcoming = (task) => !!task.due_date && task.due_date > todayStr;
  const projectFiltered = projectFilter ? tasks.filter((tsk) => tsk.project_id === projectFilter) : tasks;
  const sortedTasks = [...projectFiltered].sort((a, b) => (a.due_date || "").localeCompare(b.due_date || ""));
  const firstUpcomingIndex = sortedTasks.findIndex(isUpcoming);

  return (
    <div>
      <div className="section-title">{t("todaysTasks", lang)}</div>
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

      {sortedTasks.map((task, index) => {
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
        const taskProject = task.project_id ? projectsById[task.project_id] : null;

        // Second Assignee: staff_task_assignees rows for this task (RLS-
        // scoped, same as the task itself). isMulti === false means this is
        // an ordinary single-assignee task -- mine/isAssignee above (the
        // shared scalar columns) remain the ENTIRE gating story for it,
        // completely unchanged from before this feature existed. Only when
        // isMulti is true do the *Mine booleans below take over, driven by
        // the caller's own row instead of the shared columns (which, once
        // there's a second person, are ambiguous as to whose "part" is done).
        const assignees = assigneesByTask[task.id] || [];
        const isMulti = assignees.length > 1;
        const myRow = assignees.find((a) => a.user_id === profile.id);
        const canAcceptMine = !!myRow && myRow.acceptance_status !== "ACCEPTED" && myRow.individual_status !== "REJECTED";
        const canStartMine = !!myRow && myRow.individual_status === "ACCEPTED";
        const canCompleteMine = !!myRow && myRow.individual_status === "IN_PROGRESS";
        const canReturnMine = !!myRow && !["COMPLETED", "REJECTED"].includes(myRow.individual_status);
        const iAmBlockedMulti = myRow?.individual_status === "BLOCKED";
        const canToggleBlockedMulti = !!myRow && ["IN_PROGRESS", "BLOCKED"].includes(myRow.individual_status);
        const acceptanceLabel = (row) => (row.acceptance_status === "ACCEPTED" ? t("accept", lang) : row.acceptance_status === "REJECTED" ? t("rejectedStatusLabel", lang) : t("pendingAcceptanceLabel", lang));
        const individualLabel = (row) => (row.individual_status === "BLOCKED" ? t("blockedStatusLabel", lang) : row.individual_status === "REJECTED" ? t("rejectedStatusLabel", lang) : row.individual_status);

        return (
          <React.Fragment key={task.id}>
          {index === firstUpcomingIndex && <div className="section-title" style={{ marginTop: 16 }}>{t("upcomingLabel", lang)}</div>}
          <div className="task-card" id={`task-${task.id}`}>
            <div className="top-row">
              <div>
                <div className="task-title">{task.title}</div>
                <div className="task-number">{t("taskNumber", lang)} {task.task_number}</div>
              </div>
              <span className={`badge ${statusCode}`}>{lang === "gu" ? status?.name_gu : status?.name_en || statusCode}</span>
            </div>
            {taskProject && (
              <div className="task-meta" style={{ marginTop: 4, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700 }}>{t("siteNameLabel", lang)}: {taskProject.project_code} — {taskProject.customer}</span>
                {taskProject.location && <span className="sub">{t("siteLocationLabel", lang)}: {taskProject.location}</span>}
                {taskProject.lead_executive_id && (
                  <span className="sub">{t("leadExecutiveLabel", lang)}: {interiorProfilesById[taskProject.lead_executive_id]?.name || "—"}</span>
                )}
                {!isMulti && (
                  <span className="sub">{t("primaryAssigneeLabel", lang)}: {usersById[task.assigned_to]?.full_name || "—"}</span>
                )}
                {task.source_module === "daily_site_update" && <span className="badge ASSIGNED">{t("sourceDailySiteUpdateLabel", lang)}</span>}
              </div>
            )}
            {!taskProject && interiorDeptId && [task.from_department_id, task.to_department_id].includes(interiorDeptId) && (
              <div className="task-meta" style={{ marginTop: 4 }}>
                <span className="sub">{t("generalInteriorTaskLabel", lang)}</span>
              </div>
            )}
            {isMulti && (
              <div className="task-meta" style={{ marginTop: 4, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700 }}>{t("workingWithLabel", lang)}:</span>
                {assignees.map((a) => (
                  <span key={a.id} className="sub">
                    {usersById[a.user_id]?.full_name || "—"} — {acceptanceLabel(a)}{a.individual_status !== "ASSIGNED" ? ` · ${individualLabel(a)}` : ""}
                  </span>
                ))}
              </div>
            )}
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
              {!isMulti && statusCode === "ASSIGNED" && isAssignee && (
                <>
                  <button className="btn btn-gold" disabled={busy} onClick={() => runAction("staff_accept_task", task.id)}>
                    {t("accept", lang)}
                  </button>
                  <button className="btn btn-outline" disabled={busy} onClick={() => setReturnReasonFor(task.id)}>
                    {t("returnTask", lang)}
                  </button>
                </>
              )}
              {!isMulti && statusCode === "RETURNED" && isAssignee && (
                <button className="btn btn-gold" disabled={busy} onClick={() => runAction("staff_accept_task", task.id)}>
                  {t("accept", lang)}
                </button>
              )}
              {!isMulti && statusCode === "ACCEPTED" && mine && (
                <>
                  <button className="btn btn-gold" disabled={busy} onClick={() => runAction("staff_start_task", task.id)}>
                    {t("start", lang)}
                  </button>
                  <button className="btn btn-outline" disabled={busy} onClick={() => setReturnReasonFor(task.id)}>
                    {t("returnTask", lang)}
                  </button>
                </>
              )}
              {!isMulti && statusCode === "IN_PROGRESS" && mine && (
                <button
                  className="btn btn-gold"
                  disabled={busy}
                  onClick={() => (proofTypeCode === "none" ? runAction("staff_complete_task", task.id) : setProofFor(task.id))}
                >
                  {t("complete", lang)}
                </button>
              )}
              {/* Second Assignee: each person's own buttons are gated on
                  THEIR OWN staff_task_assignees row, never on the other
                  assignee's — Employee A can never flip Employee B's status
                  from here since these RPCs only ever touch auth.uid()'s
                  own row (server-enforced, this is just the matching UI gate). */}
              {isMulti && canAcceptMine && (
                <button className="btn btn-gold" disabled={busy} onClick={() => runAction("staff_accept_task", task.id)}>
                  {t("accept", lang)}
                </button>
              )}
              {isMulti && canStartMine && (
                <button className="btn btn-gold" disabled={busy} onClick={() => runAction("staff_start_task", task.id)}>
                  {t("start", lang)}
                </button>
              )}
              {isMulti && canCompleteMine && (
                <button
                  className="btn btn-gold"
                  disabled={busy}
                  onClick={() => (proofTypeCode === "none" ? runAction("staff_complete_task", task.id) : setProofFor(task.id))}
                >
                  {t("complete", lang)}
                </button>
              )}
              {isMulti && canReturnMine && (
                <button className="btn btn-outline" disabled={busy} onClick={() => setReturnReasonFor(task.id)}>
                  {t("returnTask", lang)}
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
              {!isMulti && !task.help_requested && ["ACCEPTED", "IN_PROGRESS"].includes(statusCode) && mine && (
                <button
                  className="btn btn-outline"
                  disabled={busy}
                  onClick={() => runAction("staff_request_help", task.id, { p_note: "" })}
                >
                  {t("requestHelp", lang)}
                </button>
              )}
              {isMulti && canToggleBlockedMulti && (
                <button
                  className="btn btn-outline"
                  disabled={busy}
                  onClick={() => runAction("staff_set_task_blocked", task.id, { p_blocked: !iAmBlockedMulti, p_note: "" })}
                >
                  {iAmBlockedMulti ? t("start", lang) : t("requestHelp", lang)}
                </button>
              )}
              {canManage && ["ASSIGNED", "RETURNED", "ACCEPTED", "IN_PROGRESS", "PARTIALLY_ACCEPTED", "PARTIALLY_COMPLETED"].includes(statusCode) && (
                <button
                  className="btn btn-outline"
                  disabled={busy}
                  onClick={() => setReassignFor(reassignFor === task.id ? null : task.id)}
                >
                  {t("reassign", lang)}
                </button>
              )}
              {taskProject && (
                <>
                  <button className="btn btn-outline" onClick={() => navigate(`/interior-projects/detail/${task.project_id}`)}>
                    {t("viewProjectAction", lang)}
                  </button>
                  {task.source_module === "daily_site_update" && (
                    <button className="btn btn-outline" onClick={() => navigate(`/interior-projects/detail/${task.project_id}?tab=dailyUpdates`)}>
                      {t("viewDailyUpdateAction", lang)}
                    </button>
                  )}
                </>
              )}
              <button
                className="btn btn-outline"
                onClick={() => setDetailsFor(detailsFor === task.id ? null : task.id)}
              >
                {detailsFor === task.id ? t("hideDetails", lang) : t("viewDetails", lang)}
              </button>
              <button
                className="btn btn-outline"
                onClick={() => {
                  setDetailsFor(task.id);
                  requestAnimationFrame(() => {
                    document.getElementById(`conversation-${task.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                  });
                }}
              >
                {t("replyAction", lang)}{unreadByTask[task.id] ? ` (${unreadByTask[task.id]})` : ""}
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
                {isMulti && <AssignedTeamSection assignees={assignees} usersById={usersById} lang={lang} />}
                <TaskTimeline task={task} usersById={usersById} lang={lang} assignees={assignees} />
                {(task.project_id || [task.from_department_id, task.to_department_id].includes(interiorDeptId)) && (
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
                <div id={`conversation-${task.id}`}>
                  <TaskConversation
                    taskId={task.id}
                    lang={lang}
                    profile={profile}
                    usersById={usersById}
                    showToast={showToast}
                    highlightMessageId={highlightMessageId}
                  />
                </div>
              </>
            )}
          </div>
          </React.Fragment>
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
