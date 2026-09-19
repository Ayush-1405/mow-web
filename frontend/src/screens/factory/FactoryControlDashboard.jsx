import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { getDepartmentCards, getDepartmentIcon } from "../../lib/departmentConfig";
import { getModuleRoute } from "../../lib/moduleRegistry";
import { subscribeTable } from "../../lib/realtime";
import { useIncludeTestData } from "../../lib/testDataVisibility";
import IncludeTestDataToggle from "../../components/IncludeTestDataToggle";
import { exportRowsToExcel } from "../../lib/exportExcel";
import SimpleBarChart from "../../components/SimpleBarChart.jsx";
import FilterChips from "../../components/FilterChips.jsx";

const PAGE_SIZE = 20;

const TERMINAL_STATUSES = ["Completed", "Installed", "Delivered", "Dispatched", "Cancelled"];
const STATUSES = [
  "Draft", "Submitted to Factory", "Factory Accepted", "Material Check Pending", "Raw Material Pending",
  "Ready for Production", "Production Started", "Work in Progress", "QC Pending", "QC Failed", "Rework",
  "QC Passed", "Packing", "Ready for Dispatch", "Dispatched", "Delivered", "Installed", "Completed", "On Hold", "Cancelled",
];
const STATUS_BADGE = {
  Draft: "CLOSED", "Submitted to Factory": "ASSIGNED", "Factory Accepted": "ASSIGNED", "Production Started": "IN_PROGRESS",
  "Work in Progress": "IN_PROGRESS", "QC Failed": "RETURNED", "QC Passed": "VERIFIED", Dispatched: "COMPLETED",
  Delivered: "VERIFIED", Installed: "VERIFIED", Completed: "VERIFIED", "On Hold": "REVISION", Cancelled: "CLOSED",
};
const DATE_RANGES = [
  ["all", "All Dates"], ["today", "Today"], ["tomorrow", "Tomorrow"], ["week", "This Week"],
  ["month", "This Month"], ["last30", "Last 30 Days"], ["custom", "Custom Range"],
];

function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(base, n) { const d = new Date(base); d.setDate(d.getDate() + n); return d; }

function dateRangeBounds(key, customFrom, customTo) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  switch (key) {
    case "today": return [isoDate(today), isoDate(today)];
    case "tomorrow": { const t = addDays(today, 1); return [isoDate(t), isoDate(t)]; }
    case "week": { const start = addDays(today, -today.getDay()); return [isoDate(start), isoDate(addDays(start, 6))]; }
    case "month": { const start = new Date(today.getFullYear(), today.getMonth(), 1); const end = new Date(today.getFullYear(), today.getMonth() + 1, 0); return [isoDate(start), isoDate(end)]; }
    case "last30": return [isoDate(addDays(today, -30)), isoDate(today)];
    case "custom": return [customFrom || null, customTo || null];
    default: return [null, null];
  }
}

// Factory's landing page, replacing the generic "Department Functions" grid
// with a live, source-department-wise view of real work in
// inhouse_production_requests. The department grid is NOT deleted — every
// existing Factory route/page still exists and is reachable via the
// "All Factory Functions" panel at the bottom of this page, and via a job
// card's own "Open Job Card" link into FactoryJobOrders.jsx (which still has
// the complete Job Card detail: stage history, QC, rework, clarifications).
//
// Source department: `staff_submit_to_factory` (the only real, live code
// path that creates one of these rows today) always sets the bridge task's
// from_department_id to Interior Projects -- Government/B2B, Retail, R&D and
// Customer Service have no code path into Factory yet. So the Source
// Department dropdown below is populated dynamically from the real
// `departments` table (never hardcoded), but honestly shows 0 for every
// department except Interior until those other modules are actually wired
// up -- this screen does not fabricate numbers to make the breakdown look
// more populated than the database really is.
export default function FactoryControlDashboard({ lang, profile, department }) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [unreadByTask, setUnreadByTask] = useState(new Map());
  const [showAllFunctions, setShowAllFunctions] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const [deptFilter, setDeptFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [dateRange, setDateRange] = useState("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const { includeTestData, canToggle, setIncludeTestData } = useIncludeTestData(profile);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    let q = supabase
      .from("inhouse_production_requests")
      .select(`*, purchase_requests(request_number, project_id, projects(project_code, customer)),
        linked_task:staff_tasks!inhouse_production_requests_linked_task_id_fkey(id, from_department_id, departments:from_department_id(code, name_en, name_gu))`)
      .order("created_at", { ascending: false });
    if (!includeTestData) q = q.eq("is_test_data", false);
    const [{ data, error: err }, deptRes] = await Promise.all([
      q,
      supabase.from("departments").select("id, code, name_en, name_gu").eq("is_active", true).eq("is_control_tower", false).neq("code", "FACTORY").order("name_en"),
    ]);
    if (err) { setError(true); setLoading(false); return; }
    setRows(data || []);
    setDepartments(deptRes.data || []);
    setLoading(false);
  }, [includeTestData]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory_control_dashboard", "inhouse_production_requests", null, load), [load]);

  const loadReplies = useCallback(async () => {
    const taskIds = rows.map((r) => r.linked_task_id).filter(Boolean);
    if (taskIds.length === 0) { setUnreadByTask(new Map()); return; }
    const { data, error: err } = await supabase.rpc("staff_task_unread_message_counts");
    if (err) return;
    const idSet = new Set(taskIds);
    const m = new Map();
    (data || []).forEach((r) => { if (idSet.has(r.task_id)) m.set(r.task_id, r.unread_count ?? 1); });
    setUnreadByTask(m);
  }, [rows]);
  useEffect(() => { loadReplies(); }, [loadReplies]);

  // Every row today resolves to Interior Projects (see module note above) --
  // via the linked bridge task when present, falling back to "Interior
  // Projects" for the 100 UAT rows seeded before linked_task_id was wired up
  // (their own bridge staff_tasks rows, independently verified, are also
  // all from_department_id = Interior).
  function sourceDept(row) {
    const d = row.linked_task?.departments;
    if (d) return d;
    return { code: "INTERIOR", name_en: "Interior Projects", name_gu: "ઈન્ટિરિયર પ્રોજેક્ટ્સ" };
  }

  const today = isoDate(new Date());
  const [rangeFrom, rangeTo] = useMemo(() => dateRangeBounds(dateRange, customFrom, customTo), [dateRange, customFrom, customTo]);

  const projectOptions = useMemo(() => {
    const seen = new Map();
    rows.forEach((r) => {
      const p = r.purchase_requests?.projects;
      const pid = r.purchase_requests?.project_id;
      if (pid && !seen.has(pid)) seen.set(pid, `${p?.project_code || "—"} — ${p?.customer || ""}`);
    });
    return Array.from(seen.entries());
  }, [rows]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (deptFilter && sourceDept(r).code !== deptFilter) return false;
    if (projectFilter && r.purchase_requests?.project_id !== projectFilter) return false;
    if (statusFilter && r.status !== statusFilter) return false;
    if (rangeFrom && (!r.required_completion_date || r.required_completion_date < rangeFrom)) return false;
    if (rangeTo && (!r.required_completion_date || r.required_completion_date > rangeTo)) return false;
    return true;
  }), [rows, deptFilter, projectFilter, statusFilter, rangeFrom, rangeTo]);

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [deptFilter, projectFilter, statusFilter, dateRange, customFrom, customTo]);

  const summary = useMemo(() => {
    const isOverdue = (r) => r.required_completion_date && r.required_completion_date < today && !TERMINAL_STATUSES.includes(r.status);
    return {
      total: filtered.length,
      newUnassigned: filtered.filter((r) => ["Draft", "Submitted to Factory"].includes(r.status)).length,
      open: filtered.filter((r) => !TERMINAL_STATUSES.includes(r.status)).length,
      accepted: filtered.filter((r) => r.status === "Factory Accepted").length,
      inProgress: filtered.filter((r) => ["Production Started", "Work in Progress"].includes(r.status)).length,
      drawingPending: filtered.filter((r) => r.current_stage === "Drawing Pending").length,
      materialPending: filtered.filter((r) => ["Raw Material Pending", "Material Check Pending"].includes(r.status)).length,
      qcPending: filtered.filter((r) => r.status === "QC Pending").length,
      rework: filtered.filter((r) => r.status === "Rework" || r.rework_status === "Rework Required").length,
      readyForDispatch: filtered.filter((r) => r.status === "Ready for Dispatch").length,
      completed: filtered.filter((r) => ["Completed", "Installed", "Delivered"].includes(r.status)).length,
      overdue: filtered.filter(isOverdue).length,
      onHold: filtered.filter((r) => r.status === "On Hold").length,
      pendingReplies: filtered.reduce((sum, r) => sum + (r.linked_task_id && unreadByTask.has(r.linked_task_id) ? 1 : 0), 0),
    };
  }, [filtered, today, unreadByTask]);

  const sortedJobs = useMemo(() => {
    const sortRank = (r) => {
      const overdue = r.required_completion_date && r.required_completion_date < today && !TERMINAL_STATUSES.includes(r.status);
      if (overdue) return 0;
      if (r.required_completion_date === today) return 1;
      if (["Production Started", "Work in Progress"].includes(r.status)) return 4;
      if (["Draft", "Submitted to Factory"].includes(r.status)) return 5;
      if (TERMINAL_STATUSES.includes(r.status)) return 7;
      return 6;
    };
    return [...filtered].sort((a, b) => sortRank(a) - sortRank(b));
  }, [filtered, today]);
  const visibleJobs = sortedJobs.slice(0, visibleCount);

  function clearFilters() {
    setDeptFilter(""); setProjectFilter(""); setStatusFilter(""); setDateRange("all"); setCustomFrom(""); setCustomTo("");
  }

  function handleExport() {
    exportRowsToExcel("Factory-Control-Dashboard-export.xlsx", "Factory Jobs", filtered.map((r) => ({
      JobOrder: r.job_order_number, SourceDept: sourceDept(r).name_en,
      Project: r.purchase_requests?.projects?.project_code, Customer: r.purchase_requests?.projects?.customer,
      Product: r.product_item, Status: r.status, Stage: r.current_stage, Progress: r.completion_percentage ?? 0,
      DueDate: r.required_completion_date || "", Overdue: r.required_completion_date && r.required_completion_date < today && !TERMINAL_STATUSES.includes(r.status) ? "Yes" : "No",
    })));
  }

  function openJobCard(id) { navigate(`/factory/job-orders?job=${id}`); }

  const cards = getDepartmentCards("FACTORY");
  const icon = getDepartmentIcon("FACTORY");

  if (loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 90 }} /><div className="kpi-grid">{[1, 2, 3, 4].map((i) => <div key={i} className="skeleton-block kpi-skeleton" />)}</div></div>;
  if (error) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">Could not load the Factory dashboard. Please retry.</div>
        <button className="btn btn-primary" onClick={load}>Retry</button>
      </div>
    );
  }

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">{icon}</div>
        <div className="dept-header-text">
          <h1>Factory Control Dashboard</h1>
          <div className="sub">Live work received from other departments, by source, status and Job Card — {lang === "gu" ? department?.name_gu : department?.name_en}</div>
        </div>
      </div>

      <div className="card">
        <button type="button" className="btn btn-outline filter-toggle-btn" style={{ width: "100%", marginBottom: 8 }} onClick={() => setFiltersOpen((s) => !s)}>
          {filtersOpen ? "Hide Filters ▲" : "Filters ▼"}
        </button>
        <FilterChips chips={[
          deptFilter && { key: "dept", label: departments.find((d) => d.code === deptFilter) ? (lang === "gu" ? departments.find((d) => d.code === deptFilter).name_gu : departments.find((d) => d.code === deptFilter).name_en) : deptFilter, onClear: () => setDeptFilter("") },
          projectFilter && { key: "project", label: projectOptions.find(([id]) => id === projectFilter)?.[1] || "Project", onClear: () => setProjectFilter("") },
          statusFilter && { key: "status", label: statusFilter, onClear: () => setStatusFilter("") },
          dateRange !== "all" && { key: "date", label: DATE_RANGES.find(([v]) => v === dateRange)?.[1] || dateRange, onClear: () => setDateRange("all") },
        ]} />
        <div className={`task-meta collapsible-filters ${filtersOpen ? "filters-open" : ""}`} style={{ flexWrap: "wrap", gap: 8 }}>
          <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">All Departments</option>
            {departments.map((d) => <option key={d.id} value={d.code}>{lang === "gu" ? d.name_gu : d.name_en}</option>)}
          </select>
          <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">All Projects/Sites</option>
            {projectOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">All Statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={dateRange} onChange={(e) => setDateRange(e.target.value)} style={{ width: "auto" }}>
            {DATE_RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {dateRange === "custom" && (
            <>
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </>
          )}
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={clearFilters}>Clear Filters</button>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={load}>Refresh</button>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={handleExport}>Export Report</button>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => window.print()}>Print</button>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => navigate("/factory/master-report")}>📊 Factory Master Report</button>
          <IncludeTestDataToggle canToggle={canToggle} includeTestData={includeTestData} onChange={setIncludeTestData} />
        </div>
      </div>

      <div className="kpi-grid">
        {[
          ["Total Received", summary.total, null],
          ["New/Unassigned", summary.newUnassigned, "newUnassigned"],
          ["Open", summary.open, "open"],
          ["Accepted", summary.accepted, "accepted"],
          ["In Progress", summary.inProgress, "inProgress"],
          ["Drawing Pending", summary.drawingPending, "drawingPending"],
          ["Material Pending", summary.materialPending, "materialPending"],
          ["QC Pending", summary.qcPending, "qcPending"],
          ["Rework", summary.rework, "rework"],
          ["Ready for Dispatch", summary.readyForDispatch, "readyForDispatch"],
          ["Completed", summary.completed, "completed"],
          ["Overdue", summary.overdue, "overdue"],
          ["On Hold", summary.onHold, "onHold"],
          ["Pending Replies", summary.pendingReplies, "pendingReplies"],
        ].map(([label, value, key]) => (
          <button
            key={label}
            type="button"
            className="kpi-tile"
            style={{ textAlign: "left", cursor: key ? "pointer" : "default", border: 0 }}
            onClick={() => {
              if (key === "overdue") { setStatusFilter(""); setDateRange("all"); }
              else if (key === "completed") setStatusFilter("Completed");
              else if (key === "rework") setStatusFilter("Rework");
              else if (key === "qcPending") setStatusFilter("QC Pending");
              else if (key === "readyForDispatch") setStatusFilter("Ready for Dispatch");
              else if (key === "onHold") setStatusFilter("On Hold");
              else if (key === "materialPending") setStatusFilter("Material Check Pending");
              document.getElementById("factory-job-card-list")?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            <div className="num" style={value > 0 && (key === "overdue" || key === "rework") ? { color: "#b91c1c" } : undefined}>{value}</div>
            <div className="label">{label}</div>
          </button>
        ))}
      </div>

      <div className="card">
        <h2>Status Distribution</h2>
        <SimpleBarChart
          color="var(--accent)"
          data={STATUSES.map((s) => ({ label: s, value: filtered.filter((r) => r.status === s).length })).filter((d) => d.value > 0)}
        />
      </div>

      <div className="card">
        <h2>Open vs Completed · On-time vs Overdue</h2>
        <div className="dept-meta-grid">
          <div>
            <div className="sub" style={{ marginBottom: 6, fontWeight: 700 }}>Open vs Completed</div>
            <SimpleBarChart data={[{ label: "Open", value: summary.open }, { label: "Completed", value: summary.completed }]} />
          </div>
          <div>
            <div className="sub" style={{ marginBottom: 6, fontWeight: 700 }}>On-time vs Overdue</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[["On-time", summary.total - summary.overdue, "var(--success)"], ["Overdue", summary.overdue, "var(--danger)"]].map(([label, value, color]) => {
                const max = Math.max(1, summary.total);
                return (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 70, flexShrink: 0, fontSize: 12, color: "var(--ink-soft)", textAlign: "right" }}>{label}</div>
                    <div style={{ flex: 1, background: "var(--surface-2)", borderRadius: 4, height: 18 }}>
                      <div style={{ width: `${Math.max((value / max) * 100, value > 0 ? 2 : 0)}%`, background: color, height: "100%", borderRadius: 4 }} />
                    </div>
                    <div style={{ width: 30, flexShrink: 0, fontSize: 12, fontWeight: 700 }}>{value}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="card" id="factory-job-card-list">
        <div className="task-meta" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Job Cards</h2>
          <span className="sub">{filtered.length} job{filtered.length === 1 ? "" : "s"}</span>
        </div>
        {visibleJobs.length === 0 && <div className="msg info">No matching Factory jobs for the current filters.</div>}
        {visibleJobs.map((r) => {
          const overdue = r.required_completion_date && r.required_completion_date < today && !TERMINAL_STATUSES.includes(r.status);
          const overdueDays = overdue ? Math.round((new Date(today) - new Date(r.required_completion_date)) / 86400000) : 0;
          const d = sourceDept(r);
          const unread = r.linked_task_id ? unreadByTask.get(r.linked_task_id) : undefined;
          return (
            <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 6, borderBottom: "1px solid var(--border, #e5e7eb)" }}>
              <span style={{ fontWeight: 700 }}>{r.job_order_number}</span>
              <span className="badge ASSIGNED">{lang === "gu" ? d.name_gu : d.name_en}</span>
              <span className="sub">{r.purchase_requests?.projects?.project_code} — {r.purchase_requests?.projects?.customer}</span>
              <span className="sub">{r.product_item} × {r.quantity ?? "—"}</span>
              <span className="sub">{r.current_stage || "—"} ({r.completion_percentage ?? 0}%)</span>
              <span className={`badge ${STATUS_BADGE[r.status] || "CLOSED"}`}>{r.status}</span>
              <span className="sub">{r.required_completion_date || "—"}{overdue ? ` — ${overdueDays}d overdue` : ""}</span>
              {unread > 0 && <span className="sub" style={{ color: "#b45309" }}>💬 {unread}</span>}
              <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => openJobCard(r.id)}>Open Job Card</button>
            </div>
          );
        })}
        {visibleCount < sortedJobs.length && (
          <button type="button" className="btn btn-outline" style={{ marginTop: 8 }} onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}>
            Load More ({sortedJobs.length - visibleCount} more)
          </button>
        )}
      </div>

      <div className="card">
        <div className="task-meta" style={{ justifyContent: "space-between", cursor: "pointer" }} onClick={() => setShowAllFunctions((s) => !s)}>
          <h2 style={{ margin: 0 }}>All Factory Functions</h2>
          <span className="sub">{showAllFunctions ? "Hide" : "Show"}</span>
        </div>
        {showAllFunctions && (
          <div className="function-card-grid" style={{ marginTop: 10 }}>
            {cards.map((c) => {
              const route = getModuleRoute("FACTORY", c.en);
              return (
                <button key={c.en} className="function-card" onClick={() => (route ? navigate(route) : null)}>
                  <span className="function-card-label">{lang === "gu" ? c.gu : c.en}</span>
                  <span className="function-card-sub">{lang === "gu" ? c.en : c.gu}</span>
                  {route ? <span className="badge live-badge">Open</span> : <span className="badge phase2-badge">Setup Pending</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
