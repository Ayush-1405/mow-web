import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import {
  listProjects, createSiteReport, notifyDeptLeadership,
  listAssignableInteriorPeople, listProjectTeamIds, createProjectTask,
  listSiteReportsPage, listSiteReportsForDate, listTasksForSiteReports,
} from "../../lib/interiorApi";
import { subscribeTable } from "../../lib/realtime";
import { useForegroundRefresh } from "../../lib/useForegroundRefresh";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { kolkataDateStr, addDaysToDateStr, daysBetweenDateStrs, kolkataDateOf } from "../../lib/kolkataTime";

// Daily Site Update — md/MOOD-OF-WOOD-SYSTEM.md §5. Today's Work and
// Tomorrow's Plan are now structured, person-wise work items (title +
// mandatory assignee + due date + priority) instead of free-text chips —
// each becomes a REAL linked staff_tasks row on submit (see
// interiorApi.createProjectTask / mvp_pilot_daily_update_tasks_v2_38.sql),
// not a typed @name. Material Required / Any Issue / Remarks are
// unchanged from the original flow.
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];
// "Today" must be Asia/Kolkata's calendar day, never `toISOString()`'s UTC
// day — see lib/kolkataTime.js. A raw UTC compute here would show/save the
// wrong date for roughly the first 5.5 hours of every IST day.
const today = () => kolkataDateStr();
const tomorrow = () => addDaysToDateStr(kolkataDateStr(), 1);

const CLOSED_STATUS_CODES = new Set(["COMPLETED", "VERIFIED", "CLOSED"]);
const ACTIVE_MIDDLE_STATUS_CODES = new Set(["IN_PROGRESS", "ACCEPTED", "PARTIALLY_ACCEPTED", "PARTIALLY_COMPLETED"]);
const HISTORY_PAGE_SIZE = 25;
const HISTORY_STORAGE_KEY = "interiorDailyUpdates.history.v1";

function formatDisplayDate(dateStr, lang) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat(lang === "gu" ? "gu-IN" : "en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(dt);
}

function dateGroupHeading(dateStr, todayStr, lang) {
  const formatted = formatDisplayDate(dateStr, lang);
  if (dateStr === todayStr) return `${t("todayLabel", lang)} — ${formatted}`;
  if (dateStr === addDaysToDateStr(todayStr, -1)) return `${t("yesterdayLabel", lang)} — ${formatted}`;
  return formatted;
}

function readHistoryStorage() {
  try { return JSON.parse(sessionStorage.getItem(HISTORY_STORAGE_KEY)) || {}; } catch { return {}; }
}
function writeHistoryStorage(partial) {
  try {
    const cur = readHistoryStorage();
    sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ ...cur, ...partial }));
  } catch { /* private-browsing storage can throw — non-fatal */ }
}

function ChipInput({ value, onChange, placeholder }) {
  const [draft, setDraft] = useState("");
  function commit() {
    const v = draft.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setDraft("");
  }
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        {value.map((chip) => (
          <span key={chip} className="badge ASSIGNED" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {chip}
            <button type="button" onClick={() => onChange(value.filter((c) => c !== chip))} style={{ border: "none", background: "none", cursor: "pointer", color: "inherit", fontWeight: 700 }}>✕</button>
          </span>
        ))}
      </div>
      <input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
        onBlur={commit}
      />
    </div>
  );
}

function emptyItem(dueDate) {
  return { id: crypto.randomUUID(), title: "", assignedTo: "", dueDate, priority: "NORMAL" };
}

// One row: title / assign-to / due date / priority / remove — reused for
// both Today's Work and Tomorrow's Plan.
function WorkItemRow({ lang, item, candidates, onChange, onRemove, showError }) {
  return (
    <div className="card" style={{ padding: 10, marginBottom: 8, borderColor: showError ? "var(--danger)" : undefined }}>
      <div className="form-grid">
        <div className="field full">
          <label>{t("workTitleLabel", lang)}</label>
          <input value={item.title} onChange={(e) => onChange({ ...item, title: e.target.value })} placeholder={t("workTitleLabel", lang)} />
        </div>
        <div className="field">
          <label>{t("assignToLabel", lang)} *</label>
          <select value={item.assignedTo} onChange={(e) => onChange({ ...item, assignedTo: e.target.value })}>
            <option value="">—</option>
            {candidates.team.length > 0 && (
              <optgroup label={t("projectTeamLabel", lang)}>
                {candidates.team.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.role}</option>)}
              </optgroup>
            )}
            {candidates.others.length > 0 && (
              <optgroup label={t("otherTeamMembersLabel", lang)}>
                {candidates.others.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.role}</option>)}
              </optgroup>
            )}
          </select>
        </div>
        <div className="field">
          <label>{t("dueDateLabel", lang)}</label>
          <input type="date" value={item.dueDate} onChange={(e) => onChange({ ...item, dueDate: e.target.value })} />
        </div>
        <div className="field">
          <label>{t("priorityLabel", lang)}</label>
          <select value={item.priority} onChange={(e) => onChange({ ...item, priority: e.target.value })}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="field" style={{ display: "flex", alignItems: "flex-end" }}>
          <button type="button" className="btn btn-outline" style={{ marginTop: 0 }} onClick={onRemove}>✕ {t("removeItemAction", lang)}</button>
        </div>
      </div>
      {showError && <div className="msg error" style={{ marginTop: 6 }}>{t("assignWorkRequiredMsg", lang)}</div>}
    </div>
  );
}

export default function InteriorDailyUpdates({ lang, lockedProjectId }) {
  const navigate = useNavigate();
  const profile = useInteriorProfile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [people, setPeople] = useState([]);
  const [teamIds, setTeamIds] = useState([]);
  const [statusById, setStatusById] = useState({});
  const [priorityById, setPriorityById] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [invalidIds, setInvalidIds] = useState(new Set());

  const [todaysWork, setTodaysWork] = useState([emptyItem(today())]);
  const [tomorrowPlan, setTomorrowPlan] = useState([emptyItem(tomorrow())]);
  const [assignAllTo, setAssignAllTo] = useState("");

  const [materialRequired, setMaterialRequired] = useState(false);
  const [materials, setMaterials] = useState([]);
  const [materialRemark, setMaterialRemark] = useState("");
  const [issuePresent, setIssuePresent] = useState(false);
  const [issueText, setIssueText] = useState("");
  const [remarks, setRemarks] = useState("");

  // ---- Lower history section: scrollable, date-grouped, filtered,
  // paginated, realtime-aware. See styles.css ".daily-updates-scroll" for
  // the container CSS. dateMode "all" = paginated newest-first feed;
  // "date" = a single selected calendar day (Previous/Next/Today/picker). ----
  const savedHistory = useRef(readHistoryStorage()).current;
  const [dateMode, setDateMode] = useState(savedHistory.dateMode || "all");
  const [selectedDate, setSelectedDate] = useState(savedHistory.selectedDate || kolkataDateStr());
  const [historyStatusFilter, setHistoryStatusFilter] = useState(savedHistory.historyStatusFilter || "");
  const [historyAssigneeFilter, setHistoryAssigneeFilter] = useState(savedHistory.historyAssigneeFilter || "");
  const [historySearchInput, setHistorySearchInput] = useState(savedHistory.historySearchInput || "");
  const historySearchText = useDebouncedValue(historySearchInput, 250);

  const [rows, setRows] = useState([]);
  const [reportTasks, setReportTasks] = useState([]);
  const [assigneesByTask, setAssigneesByTask] = useState({});
  const [unreadByTask, setUnreadByTask] = useState({});
  const [reportsOffset, setReportsOffset] = useState(0);
  const [hasMoreReports, setHasMoreReports] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [newUpdateAvailable, setNewUpdateAvailable] = useState(false);

  const scrollRef = useRef(null);
  const isAtTopRef = useRef(true);
  const scrollRestoredRef = useRef(false);
  const skipScrollResetRef = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data, error: err }, peopleRes] = await Promise.all([listProjects(), listAssignableInteriorPeople()]);
    if (err) { setError(true); setLoading(false); return; }
    setProjects(data || []);
    setPeople(peopleRes.data || []);
    if (data?.length) setProjectId((cur) => cur || lockedProjectId || data[0].id);
    setLoading(false);
  }, [lockedProjectId]);

  useEffect(() => { load(); }, [load]);

  // Small, static lookups (not otherwise available to this screen) needed
  // only to display a linked staff_tasks row's real status/priority text —
  // and, via their `code` field, to compute date-group tiering/badges.
  useEffect(() => {
    supabase.from("status_master").select("id, code, name_en, name_gu").then(({ data }) => {
      setStatusById(Object.fromEntries((data || []).map((s) => [s.id, s])));
    });
    supabase.from("priority_master").select("id, code, name_en, name_gu").then(({ data }) => {
      setPriorityById(Object.fromEntries((data || []).map((p) => [p.id, p])));
    });
  }, []);

  const loadUnread = useCallback(async () => {
    const { data, error: err } = await supabase.rpc("staff_task_unread_message_counts");
    if (!err) setUnreadByTask(Object.fromEntries((data || []).map((r) => [r.task_id, r.unread_count])));
  }, []);
  useEffect(() => { loadUnread(); }, [loadUnread]);

  const project = projects.find((p) => p.id === projectId);

  useEffect(() => {
    if (!project) { setTeamIds([]); return; }
    listProjectTeamIds(project).then(setTeamIds);
  }, [project]);

  const candidates = useMemo(() => {
    const team = people.filter((p) => teamIds.includes(p.id));
    const others = people.filter((p) => !teamIds.includes(p.id));
    return { team, others };
  }, [people, teamIds]);

  // Second Assignee — staff_task_assignees rows for every currently loaded
  // task (same table/shape TodayTasks.jsx uses), so a card can show "+1"
  // when more than one person is on the linked task.
  useEffect(() => {
    const ids = reportTasks.map((tsk) => tsk.id);
    if (!ids.length) { setAssigneesByTask({}); return; }
    supabase.from("staff_task_assignees").select("*").in("task_id", ids).eq("is_active", true).then(({ data }) => {
      const grouped = {};
      (data || []).forEach((r) => { (grouped[r.task_id] ||= []).push(r); });
      setAssigneesByTask(grouped);
    });
  }, [reportTasks]);

  // ---- History loaders ----
  const loadAllPage = useCallback(async (targetOffset, replace) => {
    if (!projectId) { setRows([]); setReportTasks([]); setHasMoreReports(false); return; }
    const { data, count, error: err } = await listSiteReportsPage(projectId, targetOffset, HISTORY_PAGE_SIZE);
    if (err) { setError(true); return; }
    const newRows = data || [];
    setRows((cur) => (replace ? newRows : [...cur, ...newRows]));
    setReportsOffset(targetOffset + newRows.length);
    setHasMoreReports(targetOffset + newRows.length < (count ?? 0));
    const ids = newRows.map((r) => r.id);
    if (ids.length) {
      const { data: taskRows } = await listTasksForSiteReports(ids);
      setReportTasks((cur) => (replace ? (taskRows || []) : [...cur, ...(taskRows || [])]));
    } else if (replace) {
      setReportTasks([]);
    }
  }, [projectId]);

  const loadForSelectedDate = useCallback(async (dateStr) => {
    if (!projectId) { setRows([]); setReportTasks([]); return; }
    const { data, error: err } = await listSiteReportsForDate(projectId, dateStr);
    if (err) { setError(true); return; }
    const newRows = data || [];
    setRows(newRows);
    setHasMoreReports(false);
    const ids = newRows.map((r) => r.id);
    const { data: taskRows } = ids.length ? await listTasksForSiteReports(ids) : { data: [] };
    setReportTasks(taskRows || []);
  }, [projectId]);

  const reloadHistory = useCallback(async () => {
    setNewUpdateAvailable(false);
    if (dateMode === "date") await loadForSelectedDate(selectedDate);
    else await loadAllPage(0, true);
  }, [dateMode, selectedDate, loadForSelectedDate, loadAllPage]);

  useEffect(() => { setSaveMsg(""); reloadHistory(); }, [reloadHistory]);

  useForegroundRefresh(reloadHistory);

  // Persist filter/date-mode selections (not scroll position, handled
  // separately) so navigating away via "Open Task" and back restores them.
  useEffect(() => {
    writeHistoryStorage({ dateMode, selectedDate, historyStatusFilter, historyAssigneeFilter, historySearchInput });
  }, [dateMode, selectedDate, historyStatusFilter, historyAssigneeFilter, historySearchInput]);

  // Scroll the history container (never the whole page) to top whenever
  // the user changes a filter or date-mode selection — skipping the very
  // first run so a restored scroll position (below) isn't immediately
  // overwritten on mount.
  useEffect(() => {
    if (skipScrollResetRef.current) { skipScrollResetRef.current = false; return; }
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [dateMode, selectedDate, historyStatusFilter, historyAssigneeFilter, historySearchText]);

  // Restore the history container's own scroll position (not the page's)
  // once, right after the first successful load — covers returning from
  // "Open Task" (a real route navigation that unmounts this component).
  useEffect(() => {
    if (scrollRestoredRef.current || loading) return;
    scrollRestoredRef.current = true;
    const savedTop = readHistoryStorage().scrollTop;
    if (savedTop && scrollRef.current) scrollRef.current.scrollTop = savedTop;
  }, [loading, rows]);

  function handleHistoryScroll() {
    const el = scrollRef.current;
    if (!el) return;
    isAtTopRef.current = el.scrollTop < 40;
    writeHistoryStorage({ scrollTop: el.scrollTop });
  }

  async function handleLoadMore() {
    if (loadingMore || !hasMoreReports) return;
    setLoadingMore(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight || 0;
    await loadAllPage(reportsOffset, false);
    setLoadingMore(false);
    requestAnimationFrame(() => {
      if (el) el.scrollTop += (el.scrollHeight - prevHeight);
    });
  }

  async function handleShowNewUpdate() {
    await reloadHistory();
    if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleClickToday() {
    setDateMode("date");
    setSelectedDate(kolkataDateStr());
  }
  function shiftDay(delta) {
    setDateMode("date");
    setSelectedDate((d) => addDaysToDateStr(d || kolkataDateStr(), delta));
  }
  function handleClearHistoryFilters() {
    setHistoryStatusFilter("");
    setHistoryAssigneeFilter("");
    setHistorySearchInput("");
  }

  useEffect(() => {
    if (!projectId) return undefined;
    const handleChange = () => {
      if (isAtTopRef.current) reloadHistory();
      else setNewUpdateAvailable(true);
    };
    const unsubR = subscribeTable(`project-${projectId}-site_reports`, "site_reports", `project_id=eq.${projectId}`, handleChange);
    const unsubT = subscribeTable(`project-${projectId}-staff_tasks`, "staff_tasks", `project_id=eq.${projectId}`, handleChange);
    return () => { unsubR(); unsubT(); };
  }, [projectId, reloadHistory]);

  function updateItem(list, setList, id, next) {
    setList(list.map((it) => (it.id === id ? next : it)));
  }

  function handleAssignAll() {
    if (!assignAllTo) return;
    const apply = (list) => list.map((it) => (it.title.trim() && !it.assignedTo ? { ...it, assignedTo: assignAllTo } : it));
    setTodaysWork((list) => apply(list));
    setTomorrowPlan((list) => apply(list));
  }

  async function handleSend(e) {
    e.preventDefault();
    if (!projectId) return;

    const activeToday = todaysWork.filter((it) => it.title.trim());
    const activeTomorrow = tomorrowPlan.filter((it) => it.title.trim());
    const missing = new Set([...activeToday, ...activeTomorrow].filter((it) => !it.assignedTo).map((it) => it.id));
    if (missing.size > 0) {
      setInvalidIds(missing);
      setSaveMsg(t("assignWorkRequiredMsg", lang));
      return;
    }
    setInvalidIds(new Set());

    setSaving(true);
    setSaveMsg(t("savingUpdateMsg", lang));

    const { data: report, error: err } = await createSiteReport({
      project_id: projectId,
      report_date: today(),
      work_today: activeToday.map((it) => it.title).join(", ") || null,
      work_done: null,
      work_pending: activeToday.length ? activeToday.map((it) => it.title).join(", ") : t("noneLabel", lang),
      material: materialRequired && materials.length ? materials.join(", ") : null,
      issue: issuePresent ? issueText : null,
      tomorrow_plan: activeTomorrow.map((it) => it.title).join(", ") || null,
      remarks: remarks || null,
      submitted_by: profile?.id || null,
    });
    if (err) { setSaving(false); setSaveMsg(t("errorSaving", lang)); return; }

    if (materialRequired && materials.length) {
      await supabase.from("project_materials").insert(
        materials.map((m) => ({
          project_id: projectId, material: m, status: "Pending to Order",
          source: "daily-update", site_report_id: report.id, remark: materialRemark || null,
          requested_by: profile?.id || null,
        })),
      );
    }

    // Every assigned item -> one real staff_tasks row via the idempotent
    // RPC (source_site_report_id + source_work_item_id + assigned_to is
    // the DB-level dedup key) -- a failure here is surfaced verbatim, the
    // already-created report and any already-created tasks are kept, not
    // rolled back (matches "if task creation fails, show the exact error").
    const toCreate = [
      ...activeToday.map((it) => ({ ...it, sourceType: "todays_work" })),
      ...activeTomorrow.map((it) => ({ ...it, sourceType: "tomorrows_plan" })),
    ];
    const taskErrors = [];
    for (const it of toCreate) {
      const assignee = people.find((p) => p.id === it.assignedTo);
      const { error: taskErr } = await createProjectTask({
        projectId, title: it.title.trim(), assignedTo: assignee?.auth_id, dueDate: it.dueDate || today(),
        priorityCode: it.priority, sourceSiteReportId: report.id, sourceWorkItemId: it.id, sourceType: it.sourceType,
      });
      if (taskErr) taskErrors.push(`${it.title}: ${taskErr.message}`);
    }

    const projectLabel = project ? `${project.project_code} — ${project.customer}` : "";
    notifyDeptLeadership(
      "INTERIOR", "site_report", report.id,
      `Daily update submitted: ${projectLabel}`,
      `દૈનિક અપડેટ સબમિટ થયું: ${projectLabel}`,
    );

    setSaving(false);
    if (taskErrors.length) {
      setSaveMsg(`${t("errorSaving", lang)}: ${taskErrors.join("; ")}`);
    } else {
      setSaveMsg(t("saved", lang));
    }
    setTodaysWork([emptyItem(today())]);
    setTomorrowPlan([emptyItem(tomorrow())]);
    setAssignAllTo("");
    setMaterialRequired(false); setMaterials([]); setMaterialRemark("");
    setIssuePresent(false); setIssueText(""); setRemarks("");
    reloadHistory();
  }

  function personNameByAuthId(authId) {
    return people.find((p) => p.auth_id === authId)?.name || "—";
  }

  // ---- History grouping/sorting/filtering (real DB date/status/priority
  // fields — never formatted-text comparison). ----
  function taskTier(tsk, todayStr) {
    const scode = statusById[tsk.status_id]?.code;
    if (CLOSED_STATUS_CODES.has(scode)) return 4;
    if (tsk.due_date === todayStr) return 0;
    const pcode = priorityById[tsk.priority_id]?.code;
    if (pcode === "URGENT" || pcode === "HIGH") return 1;
    if (ACTIVE_MIDDLE_STATUS_CODES.has(scode)) return 2;
    return 3;
  }
  function compareTasksWithinGroup(a, b, todayStr) {
    const tierDiff = taskTier(a, todayStr) - taskTier(b, todayStr);
    if (tierDiff !== 0) return tierDiff;
    if (a.due_time && b.due_time) { const c = a.due_time.localeCompare(b.due_time); if (c) return c; }
    else if (a.due_time) return -1;
    else if (b.due_time) return 1;
    return (b.assigned_at || b.created_at || "").localeCompare(a.assigned_at || a.created_at || "");
  }
  function taskMatchesHistoryFilters(tsk) {
    if (historyStatusFilter && statusById[tsk.status_id]?.code !== historyStatusFilter) return false;
    if (historyAssigneeFilter && tsk.assigned_to !== historyAssigneeFilter) return false;
    if (historySearchText.trim()) {
      const q = historySearchText.trim().toLowerCase();
      const hay = [tsk.title, tsk.description].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }
  function reportMatchesHistoryFilters(r) {
    // A plain Daily Update (no linked task) has no status/assignee of its
    // own to match a task-level filter against.
    if (historyStatusFilter || historyAssigneeFilter) return false;
    if (historySearchText.trim()) {
      const q = historySearchText.trim().toLowerCase();
      const hay = [r.work_today, r.work_pending, r.remarks].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  const historyGroups = useMemo(() => {
    const todayStr = kolkataDateStr();
    const byDate = new Map();
    for (const r of rows) {
      const dateKey = r.report_date || kolkataDateOf(r.created_at);
      if (!byDate.has(dateKey)) byDate.set(dateKey, { reports: [], tasks: [] });
      byDate.get(dateKey).reports.push(r);
    }
    const reportIdToDate = new Map(rows.map((r) => [r.id, r.report_date || kolkataDateOf(r.created_at)]));
    for (const tsk of reportTasks) {
      const dateKey = reportIdToDate.get(tsk.source_site_report_id);
      if (dateKey == null || !taskMatchesHistoryFilters(tsk)) continue;
      byDate.get(dateKey).tasks.push(tsk);
    }
    const linkedReportIds = new Set(reportTasks.map((tsk) => tsk.source_site_report_id));
    const orderedDates = Array.from(byDate.keys()).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    return orderedDates
      .map((dateKey) => {
        const bucket = byDate.get(dateKey);
        const sortedTasks = [...bucket.tasks].sort((a, b) => compareTasksWithinGroup(a, b, todayStr));
        const reportsWithoutTasks = bucket.reports.filter((r) => !linkedReportIds.has(r.id) && reportMatchesHistoryFilters(r));
        return { dateKey, tasks: sortedTasks, reportsWithoutTasks };
      })
      .filter((g) => g.tasks.length > 0 || g.reportsWithoutTasks.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, reportTasks, historyStatusFilter, historyAssigneeFilter, historySearchText, statusById, priorityById]);

  const totalHistoryShown = historyGroups.reduce((sum, g) => sum + g.tasks.length + g.reportsWithoutTasks.length, 0);

  function taskBadge(tsk) {
    const todayStr = kolkataDateStr();
    const scode = statusById[tsk.status_id]?.code;
    if (scode === "CLOSED") return <span className="badge CLOSED">{t("closedBadgeLabel", lang)}</span>;
    if (CLOSED_STATUS_CODES.has(scode)) return <span className="badge COMPLETED">{t("completedBadgeLabel", lang)}</span>;
    if (scode === "IN_PROGRESS") return <span className="badge IN_PROGRESS">{t("inProgressBadgeLabel", lang)}</span>;
    if (!tsk.due_date) return null;
    if (tsk.due_date === todayStr) return <span className="badge ASSIGNED">{t("todayBadgeLabel", lang)}</span>;
    if (tsk.due_date === addDaysToDateStr(todayStr, 1)) return <span className="badge ASSIGNED">{t("tomorrowBadgeLabel", lang)}</span>;
    if (tsk.due_date < todayStr) return <span className="badge RETURNED">{t("overdueByDaysLabel", lang).replace("{n}", String(daysBetweenDateStrs(tsk.due_date, todayStr)))}</span>;
    return null;
  }

  function renderTaskCard(tsk, reportDate) {
    const second = (assigneesByTask[tsk.id] || []).find((a) => a.user_id !== tsk.assigned_to);
    const unread = unreadByTask[tsk.id];
    return (
      <div key={tsk.id} className="card" style={{ padding: 10, marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontWeight: 700 }}>{tsk.title}</div>
          {taskBadge(tsk)}
        </div>
        {project && <div className="sub">{t("projectSiteLabel", lang)}: {project.project_code} — {project.customer}</div>}
        <div className="sub">{t("updateDateLabel", lang)}: {formatDisplayDate(reportDate, lang)}</div>
        <div className="sub">
          {t("dueDateLabel", lang)}: {tsk.due_date ? formatDisplayDate(tsk.due_date, lang) : "—"}
          {tsk.due_time && ` · ${t("dueTimeLabel", lang)}: ${tsk.due_time.slice(0, 5)}`}
        </div>
        <div className="sub">{t("assignToLabel", lang)}: {personNameByAuthId(tsk.assigned_to)}</div>
        {second && <div className="sub">{t("secondAssigneeLabel", lang)}: {personNameByAuthId(second.user_id)}</div>}
        <div className="sub">{t("priorityLabel", lang)}: {lang === "gu" ? priorityById[tsk.priority_id]?.name_gu : priorityById[tsk.priority_id]?.name_en || "—"}</div>
        <div className="sub">
          {t("statusLabel", lang)}: <span className={`badge ${statusById[tsk.status_id]?.code || "ASSIGNED"}`}>{lang === "gu" ? statusById[tsk.status_id]?.name_gu : statusById[tsk.status_id]?.name_en || tsk.status_id}</span>
        </div>
        {tsk.description && <div className="sub">{tsk.description}</div>}
        <button className="btn btn-outline" style={{ marginTop: 8, width: "100%" }} onClick={() => navigate(`/tasks?focus=${tsk.id}`)}>
          {t("openTaskAction", lang)}{unread ? ` (${unread})` : ""}
        </button>
      </div>
    );
  }

  function renderReportFallbackCard(r) {
    return (
      <div key={r.id} className="card" style={{ padding: 10, marginBottom: 8 }}>
        <div style={{ fontWeight: 700 }}>{t("dailyUpdateRecordLabel", lang)}</div>
        {project && <div className="sub">{t("projectSiteLabel", lang)}: {project.project_code} — {project.customer}</div>}
        <div className="sub">{t("updateDateLabel", lang)}: {formatDisplayDate(r.report_date || kolkataDateOf(r.created_at), lang)}</div>
        <div className="sub">{t("todayWorkLabel", lang)}: {r.work_today || "—"}</div>
        <div className="sub">{t("workPendingAuto", lang)}: {r.work_pending || "—"}</div>
        {r.status && <span className="badge IN_PROGRESS">{r.status}</span>}
      </div>
    );
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
        <div className="dept-header-icon" aria-hidden="true">📝</div>
        <div className="dept-header-text">
          <h1>{t("interiorDailyUpdatesTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>{t("projectCodeLabel", lang)}</label>
          {lockedProjectId ? (
            <div className="sub" style={{ fontWeight: 700, marginTop: 4 }}>{project ? `${project.project_code} — ${project.customer}` : "—"}</div>
          ) : (
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
            </select>
          )}
        </div>
      </div>

      <div className="card">
        <form onSubmit={handleSend}>
          <div className="field full" style={{ marginBottom: 6 }}>
            <label>{t("assignAllToLabel", lang)}</label>
            <div className="btn-row" style={{ marginTop: 0 }}>
              <select value={assignAllTo} onChange={(e) => setAssignAllTo(e.target.value)}>
                <option value="">—</option>
                {candidates.team.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.role}</option>)}
                {candidates.others.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.role}</option>)}
              </select>
              <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={handleAssignAll} disabled={!assignAllTo}>
                {t("applyToUnassignedAction", lang)}
              </button>
            </div>
          </div>

          <h3>{t("todaysWorkStep", lang)}</h3>
          {todaysWork.map((item) => (
            <WorkItemRow key={item.id} lang={lang} item={item} candidates={candidates} showError={invalidIds.has(item.id)}
              onChange={(next) => updateItem(todaysWork, setTodaysWork, item.id, next)}
              onRemove={() => setTodaysWork(todaysWork.filter((it) => it.id !== item.id))} />
          ))}
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setTodaysWork([...todaysWork, emptyItem(today())])}>
            + {t("addWorkItemAction", lang)}
          </button>

          <h3 style={{ marginTop: 16 }}>{t("materialRequiredQ", lang)}</h3>
          <div className="btn-row" style={{ marginTop: 0 }}>
            <button type="button" className={`btn ${materialRequired ? "btn-primary" : "btn-outline"}`} onClick={() => setMaterialRequired(true)}>{t("yesLabel", lang)}</button>
            <button type="button" className={`btn ${!materialRequired ? "btn-primary" : "btn-outline"}`} onClick={() => { setMaterialRequired(false); setMaterials([]); setMaterialRemark(""); }}>{t("noLabel", lang)}</button>
          </div>
          {materialRequired && (
            <div style={{ marginTop: 8 }}>
              <ChipInput value={materials} onChange={setMaterials} placeholder={t("materialItemPlaceholder", lang)} />
              <input placeholder={t("notesLabel", lang)} value={materialRemark} onChange={(e) => setMaterialRemark(e.target.value)} style={{ marginTop: 6 }} />
            </div>
          )}

          <h3 style={{ marginTop: 16 }}>{t("anyIssueQ", lang)}</h3>
          <div className="btn-row" style={{ marginTop: 0 }}>
            <button type="button" className={`btn ${issuePresent ? "btn-primary" : "btn-outline"}`} onClick={() => setIssuePresent(true)}>{t("yesLabel", lang)}</button>
            <button type="button" className={`btn ${!issuePresent ? "btn-primary" : "btn-outline"}`} onClick={() => { setIssuePresent(false); setIssueText(""); }}>{t("noLabel", lang)}</button>
          </div>
          {issuePresent && <textarea style={{ marginTop: 8 }} value={issueText} onChange={(e) => setIssueText(e.target.value)} />}

          <h3 style={{ marginTop: 16 }}>{t("tomorrowPlanStep", lang)}</h3>
          {tomorrowPlan.map((item) => (
            <WorkItemRow key={item.id} lang={lang} item={item} candidates={candidates} showError={invalidIds.has(item.id)}
              onChange={(next) => updateItem(tomorrowPlan, setTomorrowPlan, item.id, next)}
              onRemove={() => setTomorrowPlan(tomorrowPlan.filter((it) => it.id !== item.id))} />
          ))}
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setTomorrowPlan([...tomorrowPlan, emptyItem(tomorrow())])}>
            + {t("addWorkItemAction", lang)}
          </button>

          <div className="field full" style={{ marginTop: 16 }}>
            <label>{t("notesLabel", lang)}</label>
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </div>

          <div className="field full">
            <button className="btn btn-primary" type="submit" disabled={saving || !projectId}>
              {saving ? t("savingUpdateMsg", lang) : t("sendUpdate", lang)}
            </button>
            {saveMsg && <div className="sub" style={{ marginTop: 6 }}>{saveMsg}</div>}
          </div>
        </form>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, padding: "12px 14px 0" }}>
          <h3 style={{ margin: 0 }}>{t("dailyTasksUpdatesHeading", lang)}</h3>
          <div className="sub">{t("showingCountLabel", lang).replace("{n}", String(totalHistoryShown))}</div>
        </div>

        <div className="daily-updates-scroll" ref={scrollRef} onScroll={handleHistoryScroll} style={{ marginTop: 10 }}>
          <div className="daily-updates-sticky-filters">
            <div className="btn-row" style={{ flexWrap: "wrap", marginTop: 0 }}>
              <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => shiftDay(-1)}>{t("previousDayLabel", lang)}</button>
              <input type="date" value={selectedDate} onChange={(e) => { setDateMode("date"); setSelectedDate(e.target.value); }} style={{ width: "auto" }} />
              <button type="button" className={`btn ${dateMode === "date" && selectedDate === kolkataDateStr() ? "btn-primary" : "btn-outline"}`} style={{ width: "auto" }} onClick={handleClickToday}>{t("todayLabel", lang)}</button>
              <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => shiftDay(1)}>{t("nextDayLabel", lang)}</button>
              <button type="button" className={`btn ${dateMode === "all" ? "btn-primary" : "btn-outline"}`} style={{ width: "auto" }} onClick={() => setDateMode("all")}>{t("allDatesLabel", lang)}</button>
            </div>
            <div className="btn-row" style={{ flexWrap: "wrap", marginTop: 8 }}>
              <select value={historyStatusFilter} onChange={(e) => setHistoryStatusFilter(e.target.value)} style={{ width: "auto" }}>
                <option value="">{t("statusLabel", lang)}</option>
                {Object.values(statusById).map((s) => <option key={s.id} value={s.code}>{lang === "gu" ? s.name_gu : s.name_en}</option>)}
              </select>
              <select value={historyAssigneeFilter} onChange={(e) => setHistoryAssigneeFilter(e.target.value)} style={{ width: "auto" }}>
                <option value="">{t("assignToLabel", lang)}</option>
                {people.map((p) => <option key={p.id} value={p.auth_id}>{p.name}</option>)}
              </select>
              <input value={historySearchInput} onChange={(e) => setHistorySearchInput(e.target.value)} placeholder={t("searchLabel", lang)} style={{ width: "auto", flex: "1 1 160px" }} />
              <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={handleClearHistoryFilters}>{t("clearFiltersAction", lang)}</button>
            </div>
          </div>

          {newUpdateAvailable && (
            <button type="button" className="daily-updates-new-pill" onClick={handleShowNewUpdate}>
              {t("newUpdateReceivedLabel", lang)}
            </button>
          )}

          <div style={{ padding: "10px 14px 14px" }}>
            {dateMode === "date" && (
              <h4 style={{ margin: "0 0 8px" }}>{t("tasksUpdatesForHeading", lang)} {formatDisplayDate(selectedDate, lang)}</h4>
            )}

            {historyGroups.length === 0 && (
              <div className="msg info">{dateMode === "date" ? t("noTasksOrUpdatesForDateMsg", lang) : t("noRecordsYet", lang)}</div>
            )}

            {historyGroups.map((g) => (
              <div key={g.dateKey} style={{ marginTop: 14 }}>
                {dateMode === "all" && <div style={{ fontWeight: 700, marginBottom: 6 }}>{dateGroupHeading(g.dateKey, kolkataDateStr(), lang)}</div>}
                {g.tasks.map((tsk) => renderTaskCard(tsk, g.dateKey))}
                {g.reportsWithoutTasks.map((r) => renderReportFallbackCard(r))}
              </div>
            ))}

            {dateMode === "all" && hasMoreReports && (
              <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 12 }} disabled={loadingMore} onClick={handleLoadMore}>
                {loadingMore ? t("savingUpdateMsg", lang) : t("loadMoreAction", lang)}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
