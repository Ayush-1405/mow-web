import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { t } from "../lib/i18n";
import { downloadCsv } from "../lib/csv";

// Management Reports — Phase 1. Reachable only by Management (gated by
// ProtectedRoute in App.jsx, same as the Management Control Tower). Every
// number here is read straight from staff_tasks / bridges / user_profiles /
// locations under the SAME RLS a `management` caller already has full
// visibility under — this screen adds no new data access of its own, and
// invents nothing: a department, user, or location with zero activity is
// still listed, at zero, rather than hidden.
//
// This is deliberately a *separate* screen from Management Control Tower:
// Control Tower is a live KPI overview; this is a tabular, exportable
// breakdown meant to be read top-to-bottom or downloaded, not glanced at.
export default function Reports({ lang, lookups, departments }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [bridges, setBridges] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [locations, setLocations] = useState([]);

  const [filters, setFilters] = useState({ departmentId: "", locationId: "", from: "", to: "" });

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [taskRes, bridgeRes, profileRes, locRes] = await Promise.all([
      supabase.from("staff_tasks").select("*").eq("is_active", true).limit(1000),
      supabase.from("bridges").select("*").eq("is_active", true).limit(1000),
      supabase.from("user_profiles").select("id, full_name, department_id, home_location_id, is_active"),
      supabase.from("locations").select("id, name_en, name_gu").eq("is_active", true),
    ]);
    if (taskRes.error || bridgeRes.error || profileRes.error || locRes.error) {
      setError(true);
      setLoading(false);
      return;
    }
    setTasks(taskRes.data || []);
    setBridges(bridgeRes.data || []);
    setProfiles(profileRes.data || []);
    setLocations(locRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const profileById = useMemo(() => Object.fromEntries(profiles.map((p) => [p.id, p])), [profiles]);
  const locationById = useMemo(() => Object.fromEntries(locations.map((l) => [l.id, l])), [locations]);
  const deptLabel = useCallback(
    (id) => lookups.departmentById?.[id]?.[lang === "gu" ? "name_gu" : "name_en"] || "—",
    [lookups.departmentById, lang],
  );
  const locLabel = useCallback(
    (id) => (id ? locationById[id]?.[lang === "gu" ? "name_gu" : "name_en"] || "—" : t("noLocationAssigned", lang)),
    [locationById, lang],
  );
  const today = new Date().toISOString().slice(0, 10);

  // Tasks matching department + location filters only — used by the two
  // "live snapshot" reports (User Workload, Location Summary) so they always
  // reflect current ownership, not a historical window.
  const liveTasks = useMemo(() => tasks.filter((tsk) => {
    if (filters.departmentId && tsk.to_department_id !== filters.departmentId) return false;
    if (filters.locationId) {
      const owner = profileById[tsk.current_owner_id];
      if (!owner || owner.home_location_id !== filters.locationId) return false;
    }
    return true;
  }), [tasks, filters.departmentId, filters.locationId, profileById]);

  // Same filters PLUS the created-date range — used by the one genuinely
  // "period" report (Department Performance: how much moved through each
  // department in the selected window).
  const periodTasks = useMemo(() => liveTasks.filter((tsk) => {
    if (filters.from && (!tsk.created_at || tsk.created_at.slice(0, 10) < filters.from)) return false;
    if (filters.to && (!tsk.created_at || tsk.created_at.slice(0, 10) > filters.to)) return false;
    return true;
  }), [liveTasks, filters.from, filters.to]);

  const activeDepartments = useMemo(
    () => (departments || []).filter((d) => d.is_active && !d.is_control_tower),
    [departments],
  );

  const departmentRows = useMemo(() => activeDepartments.map((d) => {
    const deptTasks = periodTasks.filter((tsk) => tsk.to_department_id === d.id);
    const open = deptTasks.filter((tsk) => !tsk.closed_at);
    const overdue = open.filter((tsk) => tsk.due_date && tsk.due_date < today && !tsk.verified_at);
    const completed = deptTasks.filter((tsk) => !!tsk.completed_at);
    const closed = deptTasks.filter((tsk) => !!tsk.closed_at);
    return {
      id: d.id, name: deptLabel(d.id),
      open: open.length, overdue: overdue.length, completed: completed.length, closed: closed.length,
      total: deptTasks.length,
    };
  }).sort((a, b) => b.total - a.total), [activeDepartments, periodTasks, deptLabel, today]);

  const tasksById = useMemo(() => Object.fromEntries(tasks.map((tsk) => [tsk.id, tsk])), [tasks]);

  const bridgeRows = useMemo(() => {
    const byRoute = {};
    for (const b of bridges) {
      if (filters.departmentId && b.from_department_id !== filters.departmentId && b.to_department_id !== filters.departmentId) continue;
      const key = `${deptLabel(b.from_department_id)} → ${deptLabel(b.to_department_id)}`;
      const tsk = tasksById[b.task_id];
      const isOpen = !tsk || !tsk.closed_at;
      if (!byRoute[key]) byRoute[key] = { route: key, open: 0, closed: 0 };
      if (isOpen) byRoute[key].open += 1; else byRoute[key].closed += 1;
    }
    return Object.values(byRoute)
      .map((r) => ({ ...r, total: r.open + r.closed }))
      .sort((a, b) => b.total - a.total);
  }, [bridges, tasksById, filters.departmentId, deptLabel]);

  const userRows = useMemo(() => {
    const byUser = {};
    for (const tsk of liveTasks) {
      if (tsk.closed_at || !tsk.current_owner_id) continue;
      const owner = profileById[tsk.current_owner_id];
      if (!owner) continue;
      const key = owner.id;
      if (!byUser[key]) {
        byUser[key] = {
          id: key, name: owner.full_name || "—", dept: deptLabel(owner.department_id),
          open: 0, overdue: 0,
        };
      }
      byUser[key].open += 1;
      if (tsk.due_date && tsk.due_date < today && !tsk.verified_at) byUser[key].overdue += 1;
    }
    return Object.values(byUser).sort((a, b) => b.open - a.open || b.overdue - a.overdue);
  }, [liveTasks, profileById, deptLabel, today]);

  const locationRows = useMemo(() => {
    const groups = [...locations.map((l) => ({ id: l.id, name: locLabel(l.id) })), { id: null, name: t("noLocationAssigned", lang) }];
    return groups.map((g) => {
      const usersHere = profiles.filter((p) => p.is_active && (p.home_location_id || null) === g.id);
      const openHere = liveTasks.filter((tsk) => {
        if (tsk.closed_at) return false;
        const owner = profileById[tsk.current_owner_id];
        return (owner?.home_location_id || null) === g.id;
      });
      const overdueHere = openHere.filter((tsk) => tsk.due_date && tsk.due_date < today && !tsk.verified_at);
      return { id: g.id, name: g.name, open: openHere.length, overdue: overdueHere.length, activeUsers: usersHere.length };
    }).filter((row) => row.id !== null || row.open > 0 || row.activeUsers > 0)
      .sort((a, b) => b.open - a.open);
  }, [locations, locLabel, profiles, liveTasks, profileById, today, lang]);

  function updateFilter(key, value) { setFilters((f) => ({ ...f, [key]: value })); }
  function clearFilters() { setFilters({ departmentId: "", locationId: "", from: "", to: "" }); }

  if (loading) {
    return (
      <div className="dept-dashboard">
        <div className="skeleton-block" style={{ height: 60 }} />
        <div className="skeleton-block" style={{ height: 220 }} />
        <div className="skeleton-block" style={{ height: 220 }} />
      </div>
    );
  }

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
        <div className="dept-header-icon" aria-hidden="true">📄</div>
        <div className="dept-header-text"><h1>{t("reportsTitle", lang)}</h1></div>
      </div>

      <div className="card">
        <h2>{t("filters", lang)}</h2>
        <div className="filter-bar">
          <select value={filters.departmentId} onChange={(e) => updateFilter("departmentId", e.target.value)}>
            <option value="">{t("allDepartments", lang)}</option>
            {activeDepartments.map((d) => (
              <option key={d.id} value={d.id}>{lang === "gu" ? d.name_gu : d.name_en}</option>
            ))}
          </select>
          <select value={filters.locationId} onChange={(e) => updateFilter("locationId", e.target.value)}>
            <option value="">{t("allLocations", lang)}</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{lang === "gu" ? l.name_gu : l.name_en}</option>
            ))}
          </select>
          <label className="filter-date-label">{t("from", lang)}
            <input type="date" value={filters.from} onChange={(e) => updateFilter("from", e.target.value)} />
          </label>
          <label className="filter-date-label">{t("to", lang)}
            <input type="date" value={filters.to} onChange={(e) => updateFilter("to", e.target.value)} />
          </label>
          <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={clearFilters}>{t("clearFilters", lang)}</button>
        </div>
      </div>

      <ReportTable
        title={t("departmentPerformanceReport", lang)}
        subtitle={t("forSelectedPeriod", lang)}
        columns={[t("colDepartment", lang), t("colOpen", lang), t("colOverdue", lang), t("colCompleted", lang), t("colClosed", lang), t("colTotal", lang)]}
        rows={departmentRows}
        renderRow={(r) => [r.name, r.open, r.overdue, r.completed, r.closed, r.total]}
        onExport={() => downloadCsv(
          "department-performance.csv",
          ["Department", "Open", "Overdue", "Completed", "Closed", "Total"],
          departmentRows.map((r) => [r.name, r.open, r.overdue, r.completed, r.closed, r.total]),
        )}
        lang={lang}
      />

      <ReportTable
        title={t("userWorkloadReport", lang)}
        subtitle={t("liveSnapshot", lang)}
        columns={[t("colUser", lang), t("colDepartment", lang), t("colOpen", lang), t("colOverdue", lang)]}
        rows={userRows}
        renderRow={(r) => [r.name, r.dept, r.open, r.overdue]}
        onExport={() => downloadCsv(
          "user-workload.csv",
          ["User", "Department", "Open", "Overdue"],
          userRows.map((r) => [r.name, r.dept, r.open, r.overdue]),
        )}
        lang={lang}
      />

      <ReportTable
        title={t("locationSummaryReport", lang)}
        subtitle={t("liveSnapshot", lang)}
        columns={[t("colLocation", lang), t("colOpen", lang), t("colOverdue", lang), t("colActiveUsers", lang)]}
        rows={locationRows}
        renderRow={(r) => [r.name, r.open, r.overdue, r.activeUsers]}
        onExport={() => downloadCsv(
          "location-summary.csv",
          ["Location", "Open", "Overdue", "Active Users"],
          locationRows.map((r) => [r.name, r.open, r.overdue, r.activeUsers]),
        )}
        lang={lang}
      />

      <ReportTable
        title={t("bridgeRouteReport", lang)}
        subtitle={t("liveSnapshot", lang)}
        columns={[t("colRoute", lang), t("colOpen", lang), t("colClosed", lang), t("colTotal", lang)]}
        rows={bridgeRows}
        renderRow={(r) => [r.route, r.open, r.closed, r.total]}
        onExport={() => downloadCsv(
          "bridge-routes.csv",
          ["Route", "Open", "Closed", "Total"],
          bridgeRows.map((r) => [r.route, r.open, r.closed, r.total]),
        )}
        lang={lang}
      />
    </div>
  );
}

function ReportTable({ title, subtitle, columns, rows, renderRow, onExport, lang }) {
  return (
    <div className="card">
      <div className="report-card-header">
        <div>
          <h2 style={{ marginBottom: 2 }}>{title}</h2>
          <div className="sub" style={{ fontSize: 11 }}>{subtitle}</div>
        </div>
        <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={onExport} disabled={rows.length === 0}>
          ⬇ {t("downloadCsv", lang)}
        </button>
      </div>
      {rows.length === 0
        ? <div className="msg info">{t("noReportData", lang)}</div>
        : (
          <div className="report-table-wrap">
            <table className="report-table">
              <thead>
                <tr>{columns.map((c) => <th key={c} className={c === columns[0] ? "" : "num"}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id ?? i}>
                    {renderRow(r).map((cell, ci) => <td key={ci} className={ci === 0 ? "" : "num"}>{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
