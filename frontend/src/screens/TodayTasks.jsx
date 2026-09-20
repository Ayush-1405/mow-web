import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { uploadTaskProof, resolveMimeType } from "../lib/api";
import { t } from "../lib/i18n";
import { TaskTimeline, ReassignPanel, AttachmentsList, AssignedTeamSection, TaskConversation, ProjectSiteSection, detectFileType } from "./TaskDetail.jsx";
import { getMyInteriorProfile, listInteriorPeople } from "../lib/interiorApi";
import { subscribeTable, upsertById, removeById } from "../lib/realtime";
import { useForegroundRefresh } from "../lib/useForegroundRefresh";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { kolkataDateStr, addDaysToDateStr, daysBetweenDateStrs, kolkataDateOf, msUntilNextKolkataMidnight } from "../lib/kolkataTime";
import VoiceRecorder from "./VoiceRecorder.jsx";
import { DateNavigator, QuickDateChips, TaskSearchBar, FilterButton, FilterFields, ActiveFilterChips, MobileFilterSheet } from "./TaskFilterBar.jsx";
import { activeFilterList } from "../lib/taskFilters";
import { useBreakpoint } from "../lib/useBreakpoint";

const CLOSED_STATUS_CODES = new Set(["COMPLETED", "VERIFIED", "CLOSED"]);
const DATE_FILTER_STORAGE_KEY = "todayTasks.dateFilter.v1";
const PRIORITY_COLORS = { URGENT: "#a23434", HIGH: "#97731c", NORMAL: "#4c6d2b", LOW: "#5c5347" };

function formatDisplayDate(dateStr, lang) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat(lang === "gu" ? "gu-IN" : "en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(dt);
}

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
//
// Date handling (see lib/kolkataTime.js): "today" is ALWAYS computed in
// Asia/Kolkata, never via `new Date().toISOString()` (which is UTC and
// would show the wrong calendar date for roughly the first 5.5 hours of
// every IST day). due_date is a plain SQL `date` with no time/timezone
// attached, so comparing it against the Kolkata "today" string is always
// correct with no further conversion; only the "Assigned Date" filter
// (a real timestamptz column) needs the Kolkata-aware conversion helpers.
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
  const [holdReasonFor, setHoldReasonFor] = useState(null);
  const [holdReason, setHoldReason] = useState("");
  const [reopenReasonFor, setReopenReasonFor] = useState(null);
  const [reopenReason, setReopenReason] = useState("");
  const [proofFor, setProofFor] = useState(null);
  const [detailsFor, setDetailsFor] = useState(null);
  const [reassignFor, setReassignFor] = useState(null);
  const [deleteConfirmFor, setDeleteConfirmFor] = useState(null);
  const [assignedItems, setAssignedItems] = useState([]);
  const [unreadByTask, setUnreadByTask] = useState({});
  const [interiorProfilesById, setInteriorProfilesById] = useState({});
  const interiorProfilesLoadedRef = useRef(false);
  const interiorDeptId = lookups.departments.find((d) => d.code === "INTERIOR")?.id;

  // ---- Date filter bar state -- persisted in sessionStorage so the
  // selected date survives leaving this page (e.g. to view a task's
  // linked project) and coming back, without surviving past the tab
  // closing (a fresh session always starts back on "today"). ----
  const savedFilter = (() => {
    try { return JSON.parse(sessionStorage.getItem(DATE_FILTER_STORAGE_KEY)) || {}; } catch { return {}; }
  })();
  const [dateMode, setDateMode] = useState(savedFilter.dateMode || "all"); // "all" | "date" | "week" | "overdue"
  const [selectedDate, setSelectedDate] = useState(savedFilter.selectedDate || kolkataDateStr());
  const [filterType, setFilterType] = useState(savedFilter.filterType || "due"); // "due" | "assigned" -- only affects "date" mode
  const [projectFilter, setProjectFilter] = useState(savedFilter.project || "");
  const [statusFilter, setStatusFilter] = useState(savedFilter.status || "");
  const [priorityFilter, setPriorityFilter] = useState(savedFilter.priority || "");
  const [departmentFilter, setDepartmentFilter] = useState(savedFilter.department || "");
  const [primaryAssigneeFilter, setPrimaryAssigneeFilter] = useState(savedFilter.primary || "");
  const [secondAssigneeFilter, setSecondAssigneeFilter] = useState(savedFilter.second || "");
  const [searchInput, setSearchInput] = useState(savedFilter.search || "");
  const breakpoint = useBreakpoint();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const searchText = useDebouncedValue(searchInput, 250);
  const [showClosedSection, setShowClosedSection] = useState(false);
  const [today, setToday] = useState(() => kolkataDateStr());
  const todayRef = useRef(today);

  useEffect(() => {
    try {
      sessionStorage.setItem(DATE_FILTER_STORAGE_KEY, JSON.stringify({
        dateMode, selectedDate, filterType,
        project: projectFilter, status: statusFilter, priority: priorityFilter, department: departmentFilter,
        primary: primaryAssigneeFilter, second: secondAssigneeFilter, search: searchInput,
      }));
    } catch { /* private-browsing storage can throw — non-fatal */ }
  }, [dateMode, selectedDate, filterType, projectFilter, statusFilter, priorityFilter, departmentFilter, primaryAssigneeFilter, secondAssigneeFilter, searchInput]);

  // Midnight rollover in Asia/Kolkata, no reload required. If the user was
  // pinned to "today" (either via the Today quick button or simply never
  // having changed the date), the selected date rolls forward with it —
  // an explicitly-chosen past/future date is left alone.
  useEffect(() => {
    let timer;
    function schedule() {
      timer = setTimeout(() => {
        const prevToday = todayRef.current;
        const newToday = kolkataDateStr();
        todayRef.current = newToday;
        setToday(newToday);
        setSelectedDate((cur) => (cur === prevToday ? newToday : cur));
        schedule();
      }, msUntilNextKolkataMidnight());
    }
    schedule();
    return () => clearTimeout(timer);
  }, []);

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

  // Skeleton only on the very first load. A later reload (returning to the
  // tab, after an action, the file picker closing) swaps data in place --
  // hiding every task card behind `loading` unmounted whatever the user was
  // doing inside one, including the file they had just picked to attach.
  const loadedOnce = useRef(false);
  const load = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    // requirement_text/quantity now live directly on staff_tasks (every
    // task, not just Bridges — see mvp_pilot_task_requirement_quantity_
    // v2_2z.sql), so a plain select("*") picks them up like any other field.
    // Limit raised from 100 -> 300: the date-filter modes (a specific past/
    // future date, This Week, Overdue) need to see further back/forward
    // than "most recently created 100" would allow for an active user.
    const { data, error } = await supabase
      .from("staff_tasks")
      .select("*")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(300);
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
    loadedOnce.current = true;
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
  // Because every section/date-bucket below is DERIVED from this same
  // `tasks` state via useMemo, a due-date change, reassignment, status
  // change, or new task lands here once and automatically reflows into
  // its correct section/date — no separate per-section realtime logic
  // needed.
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

  async function submitHold(taskId) {
    if (!holdReason.trim()) return;
    setBusyId(taskId);
    try {
      const { error } = await supabase.rpc("staff_set_task_blocked", { p_task_id: taskId, p_blocked: true, p_note: holdReason.trim() });
      if (error) throw error;
      setHoldReasonFor(null);
      setHoldReason("");
      showToast("success", "Task put on hold / કાર્ય અટકાવાયું");
      await load();
    } catch (err) {
      showToast("error", err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function submitReopen(taskId) {
    if (!reopenReason.trim()) return;
    setBusyId(taskId);
    try {
      const { error } = await supabase.rpc("staff_reopen_task", { p_task_id: taskId, p_reason: reopenReason.trim() });
      if (error) throw error;
      setReopenReasonFor(null);
      setReopenReason("");
      showToast("success", "Task reopened / કાર્ય ફરીથી ખોલાયું");
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
      if (proofTypeCode === "photo" || proofTypeCode === "photo_note") {
        // Photos for these two types are already uploaded progressively by
        // PhotoProofField (with per-photo retry) before Complete is even
        // enabled — nothing left to upload here. The DB trigger re-checks
        // the actual attachment count regardless, as the real enforcement.
      } else if (proofTypeCode === "barcode") {
        if (!file) throw new Error("A barcode evidence photo is required to complete this task. / આ કાર્ય પૂર્ણ કરવા માટે બારકોડ પુરાવો જરૂરી છે.");
        await uploadTaskProof({ entityType: "task", entityId: task.id, file, fileType: "image" });
      } else if (proofTypeCode === "document" || proofTypeCode === "file_note") {
        if (!file) throw new Error("A document (PDF/Word/Excel/Drawing) is required to complete this task. / આ કાર્ય પૂર્ણ કરવા માટે દસ્તાવેજ જરૂરી છે.");
        const detected = detectFileType(resolveMimeType(file));
        if (!detected || detected === "image") {
          throw new Error("Please attach a PDF, Word, Excel, or DWG/DXF drawing file — not a photo. / કૃપા કરીને PDF, Word, Excel અથવા DWG/DXF ડ્રોઈંગ ફાઇલ જોડો — ફોટો નહીં.");
        }
        await uploadTaskProof({ entityType: "task", entityId: task.id, file, fileType: detected });
        if (proofTypeCode === "file_note" && !confirmationText?.trim()) {
          throw new Error("A completion note is required to complete this task. / આ કાર્ય પૂર્ણ કરવા માટે પૂર્ણતા નોંધ જરૂરી છે.");
        }
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
      } else if (proofTypeCode === "note" || proofTypeCode === "photo_note") {
        if (!confirmationText?.trim()) {
          throw new Error("A completion note is required to complete this task. / આ કાર્ય પૂર્ણ કરવા માટે પૂર્ણતા નોંધ જરૂરી છે.");
        }
      } else if (proofTypeCode !== "none") {
        // Covers any proof_type_id the active lookup no longer recognizes
        // — the DB trigger would reject this transition unconditionally
        // regardless of what's uploaded, so don't even try.
        throw new Error("This task's required proof type isn't supported in this pilot. Ask whoever created it to change the proof type. / આ કાર્યનો જરૂરી પુરાવો પ્રકાર આ પાયલોટમાં સમર્થિત નથી.");
      }

      const { error } = await supabase.rpc("staff_complete_task", {
        p_task_id: task.id,
        p_customer_confirmation_text: ["customer_confirmation", "note", "photo_note", "file_note"].includes(proofTypeCode) ? (confirmationText?.trim() || null) : null,
      });
      if (error) throw error;
      setProofFor(null);
      showToast("success", "Task completed / કાર્ય પૂર્ણ થયું");
      await load();
    } catch (err) {
      // Recoverable failure: already-uploaded photos/notes stay exactly as
      // the user left them (ProofUploader's own state is untouched, proof
      // already recorded in staff_attachments is a real durable row, not a
      // temp/orphaned one) — a retry needs no re-upload, and "note" text
      // survives since this component only clears on success.
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
  const priorityOf = (id) => (lookups.priorities || []).find((p) => p.id === id);
  const isClosedStatus = (task) => CLOSED_STATUS_CODES.has(statusOf(task.status_id)?.code);
  const isOverdue = (task) => {
    const s = statusOf(task.status_id)?.code;
    if (!task.due_date || CLOSED_STATUS_CODES.has(s)) return false;
    return task.due_date < today;
  };

  // ---------------------------------------------------------------------
  // Combined filters + date-mode sectioning. Every section below is
  // recomputed from `tasks` (and the filter selections) on every render —
  // there is no separate "refetch per filter" path, which is exactly what
  // lets a realtime-updated task instantly reflow into its correct
  // section/date without any special-case code.
  // ---------------------------------------------------------------------
  const priorityRank = useMemo(() => Object.fromEntries((lookups.priorities || []).map((p) => [p.id, p.sort_order])), [lookups.priorities]);

  function matchesNonDateFilters(task) {
    if (projectFilter && task.project_id !== projectFilter) return false;
    if (statusFilter && statusOf(task.status_id)?.code !== statusFilter) return false;
    if (priorityFilter && task.priority_id !== priorityFilter) return false;
    if (departmentFilter && task.from_department_id !== departmentFilter && task.to_department_id !== departmentFilter) return false;
    if (primaryAssigneeFilter && task.assigned_to !== primaryAssigneeFilter) return false;
    if (secondAssigneeFilter) {
      const rows = assigneesByTask[task.id] || [];
      if (!rows.some((r) => r.user_id === secondAssigneeFilter && r.assignment_role !== "primary")) return false;
    }
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase();
      const hay = [task.title, task.task_number, task.description, task.reference_number].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function comparePriorityDesc(a, b) { return (priorityRank[b.priority_id] ?? -1) - (priorityRank[a.priority_id] ?? -1); }
  function compareDueTime(a, b) {
    if (!a.due_time && !b.due_time) return 0;
    if (!a.due_time) return 1;
    if (!b.due_time) return -1;
    return a.due_time.localeCompare(b.due_time);
  }
  function sortActiveDefault(list) {
    return [...list].sort((a, b) => comparePriorityDesc(a, b) || compareDueTime(a, b) || (b.created_at || "").localeCompare(a.created_at || ""));
  }
  function sortByDueDateThenPriority(list) {
    return [...list].sort((a, b) => (a.due_date || "").localeCompare(b.due_date || "") || comparePriorityDesc(a, b) || compareDueTime(a, b));
  }
  function sortMostRecentlyClosedFirst(list) {
    return [...list].sort((a, b) => (b.completed_at || b.closed_at || b.verified_at || "").localeCompare(a.completed_at || a.closed_at || a.verified_at || ""));
  }
  function taskDateForSingleDateMode(task) {
    return filterType === "assigned" ? kolkataDateOf(task.assigned_at) : task.due_date;
  }

  const sections = useMemo(() => {
    const base = tasks.filter(matchesNonDateFilters);
    const activeBase = base.filter((tsk) => !isClosedStatus(tsk));
    const closedBase = base.filter((tsk) => isClosedStatus(tsk));

    if (dateMode === "date") {
      const activeForDate = sortActiveDefault(activeBase.filter((tsk) => taskDateForSingleDateMode(tsk) === selectedDate));
      const closedForDate = sortMostRecentlyClosedFirst(closedBase.filter((tsk) => taskDateForSingleDateMode(tsk) === selectedDate));
      return { mode: "date", activeForDate, closedForDate };
    }
    if (dateMode === "overdue") {
      return { mode: "overdue", list: sortByDueDateThenPriority(activeBase.filter((tsk) => tsk.due_date && tsk.due_date < today)) };
    }
    if (dateMode === "week") {
      const weekEnd = addDaysToDateStr(today, 6);
      return { mode: "week", list: sortByDueDateThenPriority(activeBase.filter((tsk) => tsk.due_date && tsk.due_date >= today && tsk.due_date <= weekEnd)) };
    }
    return {
      mode: "all",
      todayList: sortActiveDefault(activeBase.filter((tsk) => tsk.due_date === today)),
      overdueList: sortByDueDateThenPriority(activeBase.filter((tsk) => tsk.due_date && tsk.due_date < today)),
      upcomingList: sortByDueDateThenPriority(activeBase.filter((tsk) => tsk.due_date && tsk.due_date > today)),
      noDueDateList: sortActiveDefault(activeBase.filter((tsk) => !tsk.due_date)),
      closedList: sortMostRecentlyClosedFirst(closedBase),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, today, dateMode, selectedDate, filterType, projectFilter, statusFilter, priorityFilter, departmentFilter, primaryAssigneeFilter, secondAssigneeFilter, searchText, assigneesByTask, priorityRank]);

  function dateBadge(task) {
    if (isClosedStatus(task)) return <span className="badge COMPLETED">{t("completedBadgeLabel", lang)}</span>;
    if (!task.due_date) return <span className="badge CLOSED">{t("noDueDateBadgeLabel", lang)}</span>;
    if (task.due_date === today) return <span className="badge ASSIGNED">{t("todayBadgeLabel", lang)}</span>;
    if (task.due_date === addDaysToDateStr(today, 1)) return <span className="badge ASSIGNED">{t("tomorrowBadgeLabel", lang)}</span>;
    if (task.due_date < today) return <span className="badge RETURNED">{t("overdueByDaysLabel", lang).replace("{n}", String(daysBetweenDateStrs(task.due_date, today)))}</span>;
    return null;
  }

  function clearAllFilters() {
    setProjectFilter(""); setStatusFilter(""); setPriorityFilter(""); setDepartmentFilter("");
    setPrimaryAssigneeFilter(""); setSecondAssigneeFilter(""); setSearchInput(""); setDateMode("all"); setFilterType("due");
  }

  // ---- Toolbar view-model (the responsive components are purely
  // presentational; the state above stays the single source of truth) ----
  const filterValues = {
    project: projectFilter, status: statusFilter, priority: priorityFilter, department: departmentFilter,
    primary: primaryAssigneeFilter, second: secondAssigneeFilter, filterType,
  };
  const filterSetters = {
    project: setProjectFilter, status: setStatusFilter, priority: setPriorityFilter, department: setDepartmentFilter,
    primary: setPrimaryAssigneeFilter, second: setSecondAssigneeFilter, filterType: setFilterType,
  };
  function setFilterValue(key, value) { filterSetters[key]?.(value); }
  function applyFilterValues(next) {
    Object.keys(filterSetters).forEach((k) => filterSetters[k](next[k] ?? (k === "filterType" ? "due" : "")));
    setSheetOpen(false);
  }
  function clearFromSheet() { clearAllFilters(); setSheetOpen(false); }

  // Options for the assignee filters are drawn from people actually
  // present in the currently loaded tasks (not the entire company
  // directory) — keeps the dropdown short and always relevant.
  const assigneeOptions = useMemo(() => {
    const ids = new Set();
    tasks.forEach((tsk) => {
      if (tsk.assigned_to) ids.add(tsk.assigned_to);
      (assigneesByTask[tsk.id] || []).forEach((r) => ids.add(r.user_id));
    });
    return Array.from(ids).map((id) => usersById[id]).filter(Boolean).sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
  }, [tasks, assigneesByTask, usersById]);

  const filterOptions = useMemo(() => ({
    projects: Object.values(projectsById).map((p) => ({ value: p.id, label: `${p.project_code} — ${p.customer}${p.location ? ` — ${p.location}` : ""}` })),
    statuses: (lookups.statuses || []).map((st) => ({ value: st.code, label: lang === "gu" ? st.name_gu : st.name_en })),
    priorities: (lookups.priorities || []).map((pr) => ({ value: pr.id, label: lang === "gu" ? pr.name_gu : pr.name_en })),
    departments: (lookups.departments || []).map((d) => ({ value: d.id, label: lang === "gu" ? d.name_gu : d.name_en })),
    assignees: assigneeOptions.map((u) => ({ value: u.id, label: u.full_name })),
  }), [projectsById, lookups.statuses, lookups.priorities, lookups.departments, lang, assigneeOptions]);
  const activeFilters = activeFilterList(filterValues, filterOptions, lang);

  function renderTaskCard(task) {
    const status = statusOf(task.status_id);
    const statusCode = status?.code || "";
    const priority = priorityOf(task.priority_id);
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

    // Shared task lifecycle: staff_tasks.status_id is the single source of
    // truth for EVERY assignee (single or multi) -- there is no more
    // per-assignee acceptance/completion gate. Any active assignee (their
    // own staff_task_assignees row, regardless of assignment_role) may
    // Accept/Start/Complete/Hold/Resume once for the whole task; the
    // server (staff_accept_task/staff_start_task/staff_complete_task/
    // staff_set_task_blocked) re-validates all of this independently and
    // returns a specific "already accepted/started/completed by X" error
    // if two assignees act at the same time -- these booleans only decide
    // what the button row looks like.
    const assignees = assigneesByTask[task.id] || [];
    const isMulti = assignees.length > 1;
    const myRow = assignees.find((a) => a.user_id === profile.id);
    const isSharedAssignee = !!myRow || isAssignee;
    const canAccept = isSharedAssignee && ["ASSIGNED", "RETURNED", "REOPENED"].includes(statusCode);
    const canStart = isSharedAssignee && ["ACCEPTED", "REOPENED"].includes(statusCode);
    const canComplete = isSharedAssignee && statusCode === "IN_PROGRESS";
    const canHold = isSharedAssignee && statusCode === "IN_PROGRESS";
    const canResume = isSharedAssignee && statusCode === "ON_HOLD";
    const canReturn = isSharedAssignee && ["ASSIGNED", "ACCEPTED", "IN_PROGRESS", "ON_HOLD"].includes(statusCode);
    const canReopen = statusCode === "COMPLETED" ? iAmVerifier : ["VERIFIED", "CLOSED"].includes(statusCode) && (canManage || iCreatedIt || iAmVerifier);

    return (
      <div className="task-card" id={`task-${task.id}`} key={task.id}>
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
            {task.source_module === "daily_site_update" && <span className="badge ASSIGNED">{t("sourceDailySiteUpdateLabel", lang)}</span>}
          </div>
        )}
        {!taskProject && interiorDeptId && [task.from_department_id, task.to_department_id].includes(interiorDeptId) && (
          <div className="task-meta" style={{ marginTop: 4 }}>
            <span className="sub">{t("generalInteriorTaskLabel", lang)}</span>
          </div>
        )}
        <div className="task-meta" style={{ marginTop: 4, flexWrap: "wrap" }}>
          {isMulti && <span className="badge ASSIGNED">{t("sharedTaskLabel", lang)}</span>}
          <span className="sub">{t("primaryAssigneeLabel", lang)}: {usersById[task.assigned_to]?.full_name || "—"}</span>
          {isMulti && assignees.filter((a) => a.user_id !== task.assigned_to).map((a) => (
            <span key={a.id} className="sub">{t("secondAssigneeFilterLabel", lang)}: {usersById[a.user_id]?.full_name || "—"}</span>
          ))}
        </div>
        <div className="task-meta" style={{ marginTop: 2, flexWrap: "wrap" }}>
          {task.accepted_by && <span className="sub">{t("acceptedByLabel", lang)}: {usersById[task.accepted_by]?.full_name || "—"} — {new Date(task.accepted_at).toLocaleString()}</span>}
          {task.started_by && <span className="sub">{t("startedByLabel", lang)}: {usersById[task.started_by]?.full_name || "—"} — {new Date(task.started_at).toLocaleString()}</span>}
          {task.completed_by && <span className="sub">{t("completedByLabel", lang)}: {usersById[task.completed_by]?.full_name || "—"} — {new Date(task.completed_at).toLocaleString()}</span>}
        </div>
        {task.description && <div style={{ fontSize: 13, marginTop: 6 }}>{task.description}</div>}
        {task.requirement_text && (
          <div style={{ fontSize: 13, marginTop: 6 }}>
            <strong>{t("requirementText", lang)}:</strong> {task.requirement_text}
          </div>
        )}
        <div className="task-meta" style={{ flexWrap: "wrap" }}>
          {dateBadge(task)}
          {task.due_date && <span className={isOverdue(task) ? "overdue" : ""}>{t("dueDate", lang)}: {task.due_date}</span>}
          {task.due_time && <span>{t("dueTimeLabel", lang)}: {task.due_time.slice(0, 5)}</span>}
          <span className="sub">{t("assignedDateLabel", lang)}: {kolkataDateOf(task.assigned_at) || "—"}</span>
          {priority && (
            <span style={{ fontWeight: 700, color: PRIORITY_COLORS[priority.code] || undefined }}>
              {lang === "gu" ? priority.name_gu : priority.name_en}
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
        {statusCode === "ON_HOLD" && task.hold_reason && (
          <div className="msg info" style={{ marginTop: 8 }}>
            {t("onHoldReasonLabel", lang)}: {task.hold_reason} — {usersById[task.held_by]?.full_name || "—"}
          </div>
        )}
        {statusCode === "REOPENED" && task.reopen_reason && (
          <div className="msg info" style={{ marginTop: 8 }}>
            {t("reopenReasonLabel", lang)}: {task.reopen_reason} — {usersById[task.reopened_by]?.full_name || "—"}
          </div>
        )}

        <div className="btn-row">
          {/* Shared task lifecycle: any active assignee (isSharedAssignee)
              sees exactly the same buttons regardless of assignment_role
              or how many other people are on the task — the server is the
              real gate (staff_accept_task/staff_start_task/etc. each
              re-check the shared status_id and raise a specific "already
              accepted/started/completed by X" error on a race), this is
              only the matching UI. */}
          {canAccept && (
            <button className="btn btn-gold" disabled={busy} onClick={() => runAction("staff_accept_task", task.id)}>
              {t("accept", lang)}
            </button>
          )}
          {canStart && (
            <button className="btn btn-gold" disabled={busy} onClick={() => runAction("staff_start_task", task.id)}>
              {t("start", lang)}
            </button>
          )}
          {canComplete && (
            <button
              className="btn btn-gold"
              disabled={busy}
              onClick={() => (proofTypeCode === "none" ? runAction("staff_complete_task", task.id) : setProofFor(task.id))}
            >
              {t("complete", lang)}
            </button>
          )}
          {canHold && (
            <button className="btn btn-outline" disabled={busy} onClick={() => setHoldReasonFor(task.id)}>
              {t("putOnHoldAction", lang)}
            </button>
          )}
          {canResume && (
            <button className="btn btn-gold" disabled={busy} onClick={() => runAction("staff_set_task_blocked", task.id, { p_blocked: false, p_note: null })}>
              {t("resumeAction", lang)}
            </button>
          )}
          {canReturn && (
            <button className="btn btn-outline" disabled={busy} onClick={() => setReturnReasonFor(task.id)}>
              {t("returnTask", lang)}
            </button>
          )}
          {statusCode === "COMPLETED" && iAmVerifier && (
            <>
              <button className="btn btn-gold" disabled={busy} onClick={() => runAction("staff_verify_task", task.id)}>
                {t("verify", lang)}
              </button>
              <button className="btn btn-outline" disabled={busy} onClick={() => setReopenReasonFor(task.id)}>
                {t("rejectAction", lang)}
              </button>
            </>
          )}
          {statusCode === "VERIFIED" && (canManage || task.assigned_by === profile.id) && (
            <button className="btn btn-primary" disabled={busy} onClick={() => runAction("staff_close_task", task.id)}>
              {t("close", lang)}
            </button>
          )}
          {canReopen && statusCode !== "COMPLETED" && (
            <button className="btn btn-outline" disabled={busy} onClick={() => setReopenReasonFor(task.id)}>
              {t("reopenAction", lang)}
            </button>
          )}
          {!task.help_requested && ["ACCEPTED", "IN_PROGRESS"].includes(statusCode) && isSharedAssignee && (
            <button
              className="btn btn-outline"
              disabled={busy}
              onClick={() => runAction("staff_request_help", task.id, { p_note: "" })}
            >
              {t("requestHelp", lang)}
            </button>
          )}
          {canManage && ["ASSIGNED", "RETURNED", "ACCEPTED", "IN_PROGRESS", "ON_HOLD", "REOPENED"].includes(statusCode) && (
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

        {holdReasonFor === task.id && (
          <div style={{ marginTop: 10 }}>
            <label>{t("holdReasonLabel", lang)}</label>
            <textarea value={holdReason} onChange={(e) => setHoldReason(e.target.value)} />
            <div className="btn-row">
              <button className="btn btn-primary" disabled={busy || !holdReason.trim()} onClick={() => submitHold(task.id)}>
                {t("submit", lang)}
              </button>
              <button className="btn btn-outline" onClick={() => { setHoldReasonFor(null); setHoldReason(""); }}>
                {t("cancel", lang)}
              </button>
            </div>
          </div>
        )}

        {reopenReasonFor === task.id && (
          <div style={{ marginTop: 10 }}>
            <label>{t("reopenReasonLabel", lang)}</label>
            <textarea value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} />
            <div className="btn-row">
              <button className="btn btn-primary" disabled={busy || !reopenReason.trim()} onClick={() => submitReopen(task.id)}>
                {t("submit", lang)}
              </button>
              <button className="btn btn-outline" onClick={() => { setReopenReasonFor(null); setReopenReason(""); }}>
                {t("cancel", lang)}
              </button>
            </div>
          </div>
        )}

        {proofFor === task.id && (
          <ProofUploader
            lang={lang}
            busy={busy}
            task={task}
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
            <AttachmentsList taskId={task.id} lang={lang} showToast={showToast} usersById={usersById} />
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
    );
  }

  function renderSection(titleKey, list, options = {}) {
    if (!list.length) return null;
    return (
      <React.Fragment key={titleKey}>
        <div className="section-title" style={{ marginTop: 16 }}>
          {t(titleKey, lang)} {options.showCount !== false && <span className="sub">({list.length})</span>}
        </div>
        {list.map((task) => renderTaskCard(task))}
      </React.Fragment>
    );
  }

  const totalVisible = tasks.length;

  return (
    <div className="tt-page">
      <div className="tt-header">
        <div className="section-title">{t("todaysTasks", lang)}</div>
        <button type="button" className="btn btn-outline tt-refresh" onClick={load} disabled={loading}>
          {t("refresh", lang)}
        </button>
      </div>

      {/* ---------------- Date + search + filter toolbar ---------------- */}
      <div className="tt-toolbar">
        <div className="tt-toolbar-top">
          <DateNavigator
            lang={lang}
            value={selectedDate}
            onChange={(v) => { setDateMode("date"); setSelectedDate(v); }}
            onPrev={() => { setDateMode("date"); setSelectedDate((d) => addDaysToDateStr(d, -1)); }}
            onNext={() => { setDateMode("date"); setSelectedDate((d) => addDaysToDateStr(d, 1)); }}
          />
          <QuickDateChips
            lang={lang}
            chips={[
              { key: "today", label: t("todayButtonLabel", lang), active: dateMode === "date" && selectedDate === today, onSelect: () => { setDateMode("date"); setSelectedDate(today); } },
              { key: "tomorrow", label: t("tomorrowLabel", lang), active: dateMode === "date" && selectedDate === addDaysToDateStr(today, 1), onSelect: () => { setDateMode("date"); setSelectedDate(addDaysToDateStr(today, 1)); } },
              { key: "week", label: t("thisWeekLabel", lang), active: dateMode === "week", onSelect: () => setDateMode("week") },
              { key: "overdue", label: t("overdueQuickLabel", lang), active: dateMode === "overdue", onSelect: () => setDateMode("overdue") },
              { key: "all", label: breakpoint === "mobile" ? t("tfAllChip", lang) : t("allTasksLabel", lang), active: dateMode === "all", onSelect: () => setDateMode("all") },
            ]}
          />
        </div>

        <TaskSearchBar lang={lang} value={searchInput} onChange={setSearchInput}>
          {breakpoint === "desktop" ? (
            <button type="button" className="btn btn-outline tt-clearbtn" onClick={clearAllFilters}>{t("clearFiltersAction", lang)}</button>
          ) : (
            <FilterButton
              lang={lang}
              count={activeFilters.length}
              expanded={breakpoint === "mobile" ? sheetOpen : panelOpen}
              controls={breakpoint === "mobile" ? undefined : "tt-filter-panel"}
              hasPopup={breakpoint === "mobile"}
              onClick={() => (breakpoint === "mobile" ? setSheetOpen(true) : setPanelOpen((o) => !o))}
            />
          )}
        </TaskSearchBar>

        {/* Tablet: collapsible two-column panel. Desktop: always open. Phone: lives in the sheet instead. */}
        {breakpoint !== "mobile" && (breakpoint === "desktop" || panelOpen) && (
          <div id="tt-filter-panel">
            <FilterFields lang={lang} idPrefix="tt-inline" values={filterValues} options={filterOptions} onChange={setFilterValue} />
          </div>
        )}

        {breakpoint !== "desktop" && !(breakpoint === "tablet" && panelOpen) && (
          <ActiveFilterChips
            lang={lang}
            filters={activeFilters}
            onRemove={(k) => setFilterValue(k, k === "filterType" ? "due" : "")}
            onClearAll={clearAllFilters}
          />
        )}
      </div>

      {breakpoint === "mobile" && sheetOpen && (
        <MobileFilterSheet
          lang={lang}
          open={sheetOpen}
          values={filterValues}
          options={filterOptions}
          onApply={applyFilterValues}
          onClearAll={clearFromSheet}
          onClose={() => setSheetOpen(false)}
        />
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
      {!loading && totalVisible === 0 && assignedItems.length === 0 && <div className="msg info">{t("noTasks", lang)}</div>}

      {!loading && sections.mode === "date" && (
        <>
          <div className="section-title">
            {filterType === "assigned" ? t("tasksAssignedOnHeading", lang) : t("tasksForDateHeading", lang)} {formatDisplayDate(selectedDate, lang)}
          </div>
          {sections.activeForDate.length === 0 && sections.closedForDate.length === 0 && (
            <div className="msg info">{t("noTasksForDateMsg", lang)}</div>
          )}
          {sections.activeForDate.map((task) => renderTaskCard(task))}
          {sections.closedForDate.length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: 16 }}>{t("completedClosedSectionLabel", lang)} <span className="sub">({sections.closedForDate.length})</span></div>
              {sections.closedForDate.map((task) => renderTaskCard(task))}
            </>
          )}
        </>
      )}

      {!loading && sections.mode === "overdue" && (
        <>
          <div className="section-title">{t("overdueSectionLabel", lang)} <span className="sub">({sections.list.length})</span></div>
          {sections.list.length === 0 && <div className="msg info">{t("noTasksForDateMsg", lang)}</div>}
          {sections.list.map((task) => renderTaskCard(task))}
        </>
      )}

      {!loading && sections.mode === "week" && (
        <>
          <div className="section-title">{t("thisWeekLabel", lang)} <span className="sub">({sections.list.length})</span></div>
          {sections.list.length === 0 && <div className="msg info">{t("noTasksForDateMsg", lang)}</div>}
          {sections.list.map((task) => renderTaskCard(task))}
        </>
      )}

      {!loading && sections.mode === "all" && (
        <>
          {renderSection("todaysTasks", sections.todayList)}
          {renderSection("overdueSectionLabel", sections.overdueList)}
          {renderSection("upcomingSectionLabel", sections.upcomingList)}
          {renderSection("noDueDateSectionLabel", sections.noDueDateList)}
          {sections.closedList.length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: 16, cursor: "pointer" }} onClick={() => setShowClosedSection((s) => !s)}>
                {t("completedClosedSectionLabel", lang)} <span className="sub">({sections.closedList.length}) — {showClosedSection ? t("collapseLabel", lang) : t("expandLabel", lang)}</span>
              </div>
              {showClosedSection && sections.closedList.map((task) => renderTaskCard(task))}
            </>
          )}
        </>
      )}
    </div>
  );
}

// Includes CAD drawing MIME types/extensions alongside PDF/Word/Excel —
// the server (staff-file-url's MIME_WHITELIST, the staff-attachments
// storage bucket, and staff_record_attachment()) already accepts a
// 'drawing' file_type for DWG/DXF; this was the one place still missing
// it, which made every DWG "document" proof upload fail before the file
// even left the browser.
const DOCUMENT_ACCEPT = "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.dwg,.dxf,application/dxf,application/dwg,image/vnd.dwg,image/vnd.dxf,application/x-dwg,application/x-dxf,application/acad";
const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif";

const SUPPORTED_PROOF_CODES = new Set(["photo", "barcode", "document", "voice", "customer_confirmation", "none", "note", "photo_note", "file_note"]);
const PHOTO_PROOF_CODES = new Set(["photo", "photo_note"]);
const NOTE_PROOF_CODES = new Set(["note", "photo_note", "file_note"]);

// Best-effort only — compression never blocks an upload. Downscales to a
// sane max dimension and re-encodes as JPEG when a photo is clearly larger
// than needed for a completion-proof record; createImageBitmap's
// imageOrientation:"from-image" applies the file's EXIF rotation itself,
// which is what keeps a phone-camera photo right-side-up here without any
// manual EXIF parsing.
async function compressImageIfNeeded(file) {
  if (!file.type?.startsWith("image/") || file.size <= 1.5 * 1024 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const maxDim = 1920;
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob.slice(0, blob.size, "image/jpeg")], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

// Multi-photo capture: Take Photo (camera-first via capture="environment")
// and Choose from Gallery are two separate inputs — mobile browsers show
// the OS camera/gallery chooser either way, this just hints which one to
// default to. Each photo uploads immediately on selection (progress is
// this per-photo pending/uploading/done/error state, since the underlying
// signed-URL upload has no byte-level progress event to surface) so a
// failure is caught and retried per-photo, never silently blocking the
// whole batch or losing the photos that did succeed.
function PhotoProofField({ lang, taskId, minCount, allowMultiple, photos, setPhotos }) {
  async function uploadOne(id, file) {
    setPhotos((cur) => cur.map((p) => (p.id === id ? { ...p, status: "uploading" } : p)));
    try {
      const compressed = await compressImageIfNeeded(file);
      await uploadTaskProof({ entityType: "task", entityId: taskId, file: compressed, fileType: "image" });
      setPhotos((cur) => cur.map((p) => (p.id === id ? { ...p, status: "done" } : p)));
    } catch (err) {
      setPhotos((cur) => cur.map((p) => (p.id === id ? { ...p, status: "error", errorMsg: err.message } : p)));
    }
  }

  function addFiles(fileList) {
    const picked = Array.from(fileList || []);
    if (!picked.length) return;
    const capped = allowMultiple ? picked : picked.slice(0, 1);
    const entries = capped.map((file) => ({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file), status: "pending", errorMsg: "" }));
    setPhotos((cur) => (allowMultiple ? [...cur, ...entries] : entries));
    entries.forEach((entry) => uploadOne(entry.id, entry.file));
  }

  function removePhoto(id) {
    setPhotos((cur) => {
      const target = cur.find((p) => p.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return cur.filter((p) => p.id !== id);
    });
  }

  const doneCount = photos.filter((p) => p.status === "done").length;
  const firstError = photos.find((p) => p.status === "error");

  return (
    <div className="proof-photo-field">
      <div className="btn-row" style={{ marginTop: 0 }}>
        <label className="file-input-label">
          {t("takePhotoAction", lang)}
          <input type="file" accept={IMAGE_ACCEPT} capture="environment" style={{ display: "none" }} onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        </label>
        <label className="file-input-label">
          {t("chooseFromGalleryAction", lang)}
          <input type="file" accept={IMAGE_ACCEPT} multiple={allowMultiple} style={{ display: "none" }} onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        </label>
      </div>
      {photos.length > 0 && (
        <div className="proof-photo-grid">
          {photos.map((p) => (
            <div className="proof-photo-thumb" key={p.id}>
              <img src={p.previewUrl} alt="" />
              {p.status === "uploading" && <div className="proof-photo-overlay">…</div>}
              {p.status === "done" && <div className="proof-photo-badge">✓</div>}
              {p.status === "error" && (
                <button type="button" className="proof-photo-retry" onClick={() => uploadOne(p.id, p.file)}>{t("retryUploadAction", lang)}</button>
              )}
              <button type="button" className="proof-photo-remove" onClick={() => removePhoto(p.id)} aria-label={t("removePhotoAction", lang)}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div className="sub" style={{ marginTop: 6 }}>{doneCount} / {minCount} {t("minPhotoCountLabel", lang)}</div>
      {firstError && <div className="msg error" style={{ marginTop: 6 }}>{firstError.errorMsg}</div>}
    </div>
  );
}

// Adapts to the task's actual proof_type_code — matching what the DB
// trigger is about to check, instead of always assuming "attach a photo"
// regardless of what proof was actually configured (photo/barcode need an
// image, document needs a PDF/Word/Excel, voice needs a recorded note,
// customer_confirmation needs text and/or evidence, note/photo_note/
// file_note need a completion note — mvp_pilot_daily_update_proof_v2_61 —
// and any type this pilot doesn't recognize gets a clear message instead
// of a picker that can only ever fail).
function ProofUploader({ lang, busy, task, proofTypeCode, onCancel, onSubmit }) {
  const [file, setFile] = useState(null);
  const [confirmationText, setConfirmationText] = useState("");
  const [voiceDuration, setVoiceDuration] = useState(0);
  const [photos, setPhotos] = useState([]);

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

  const isPhotoType = PHOTO_PROOF_CODES.has(proofTypeCode);
  const minPhotos = Math.max(1, Math.min(10, task?.minimum_photo_count || 1));
  const allowMultiple = task?.allow_multiple_photos !== false;
  const donePhotoCount = photos.filter((p) => p.status === "done").length;
  const anyPhotoUploading = photos.some((p) => p.status === "uploading");
  const accept = (proofTypeCode === "document" || proofTypeCode === "file_note") ? DOCUMENT_ACCEPT : IMAGE_ACCEPT;

  let canSubmit = true;
  if (isPhotoType) canSubmit = canSubmit && !anyPhotoUploading && donePhotoCount >= minPhotos;
  if (NOTE_PROOF_CODES.has(proofTypeCode)) canSubmit = canSubmit && !!confirmationText.trim();
  if (proofTypeCode === "file_note" || proofTypeCode === "document" || proofTypeCode === "barcode") canSubmit = canSubmit && !!file;
  if (proofTypeCode === "voice") canSubmit = canSubmit && !!file;
  if (proofTypeCode === "customer_confirmation") canSubmit = canSubmit && (!!confirmationText.trim() || !!file);

  return (
    <div style={{ marginTop: 10 }}>
      {task?.proof_instructions && <div className="msg info" style={{ marginBottom: 8 }}>{task.proof_instructions}</div>}

      {isPhotoType && (
        <PhotoProofField lang={lang} taskId={task.id} minCount={minPhotos} allowMultiple={allowMultiple} photos={photos} setPhotos={setPhotos} />
      )}

      {(proofTypeCode === "customer_confirmation" || NOTE_PROOF_CODES.has(proofTypeCode)) && (
        <div className="field">
          <label>{proofTypeCode === "customer_confirmation" ? t("customerConfirmationLabel", lang) : t("completionNoteLabel", lang)}</label>
          <textarea value={confirmationText} onChange={(e) => setConfirmationText(e.target.value)} />
        </div>
      )}

      {proofTypeCode === "voice" && (
        <VoiceRecorder lang={lang} disabled={busy} onRecorded={(f, duration) => { setFile(f); setVoiceDuration(duration); }} />
      )}

      {(proofTypeCode === "document" || proofTypeCode === "barcode" || proofTypeCode === "file_note") && (
        <label className="file-input-label">
          {file ? file.name : (proofTypeCode === "barcode" ? t("attachProof", lang) : t("attachDocument", lang))}
          <input
            type="file"
            accept={accept}
            style={{ display: "none" }}
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
      )}

      <div className="btn-row">
        <button className="btn btn-primary" disabled={busy || !canSubmit} onClick={() => onSubmit(file, confirmationText, voiceDuration)}>
          {busy ? t("uploading", lang) : t("complete", lang)}
        </button>
        <button className="btn btn-outline" onClick={onCancel}>{t("cancel", lang)}</button>
      </div>
    </div>
  );
}
