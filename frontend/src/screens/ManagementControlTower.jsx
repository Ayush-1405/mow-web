import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { t } from "../lib/i18n";
import { buildOrderedDepartments } from "../lib/departmentConfig";

// Management Control Tower — Phase 1 executive dashboard. Reachable only by
// Management (departments.is_control_tower is gated in lib/access.js and
// re-checked by ProtectedRoute before this ever mounts). Every figure here
// is read straight from staff_tasks / bridges / user_profiles under the
// SAME RLS policies as everywhere else in the app — staff_tasks_select_
// scoped / bridges_select_scoped / user_profiles_select_hod_scope already
// grant a `management` caller full visibility, so this screen adds no new
// data access of its own, exactly like the existing ManagementDashboard
// screen it sits alongside. No figure below is invented: anything the
// current schema doesn't track yet (e.g. a generic "approvals" workflow)
// is derived from the closest real equivalent already in staff_tasks
// (COMPLETED-but-not-yet-verified = pending approval) rather than faked.
export default function ManagementControlTower({ lang, lookups, departments }) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [bridges, setBridges] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [locations, setLocations] = useState([]);

  const [filters, setFilters] = useState({
    departmentId: "", locationId: "", statusId: "", priorityId: "", from: "", to: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [taskRes, bridgeRes, profileRes, locRes] = await Promise.all([
      supabase.from("staff_tasks").select("*").eq("is_active", true).limit(1000),
      supabase.from("bridges").select("*").eq("is_active", true).limit(1000),
      supabase.from("user_profiles").select("id, department_id, home_location_id, is_active"),
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

  useEffect(() => {
    const channel = supabase
      .channel("control_tower")
      .on("postgres_changes", { event: "*", schema: "public", table: "staff_tasks" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "bridges" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  const profileById = useMemo(() => Object.fromEntries(profiles.map((p) => [p.id, p])), [profiles]);
  const locationById = useMemo(() => Object.fromEntries(locations.map((l) => [l.id, l])), [locations]);
  const deptName = (id) => lookups.departmentById?.[id]?.[lang === "gu" ? "name_gu" : "name_en"] || "—";

  const urgentPriorityId = useMemo(
    () => (lookups.priorities || []).find((p) => p.code === "URGENT")?.id || null,
    [lookups.priorities],
  );

  const today = new Date().toISOString().slice(0, 10);

  const filteredTasks = useMemo(() => tasks.filter((tsk) => {
    if (filters.departmentId && tsk.from_department_id !== filters.departmentId && tsk.to_department_id !== filters.departmentId) return false;
    if (filters.statusId && tsk.status_id !== filters.statusId) return false;
    if (filters.priorityId && tsk.priority_id !== filters.priorityId) return false;
    if (filters.from && (!tsk.due_date || tsk.due_date < filters.from)) return false;
    if (filters.to && (!tsk.due_date || tsk.due_date > filters.to)) return false;
    if (filters.locationId) {
      const owner = profileById[tsk.current_owner_id];
      if (!owner || owner.home_location_id !== filters.locationId) return false;
    }
    return true;
  }), [tasks, filters, profileById]);

  const openTasks = filteredTasks.filter((tsk) => !tsk.closed_at);
  const overdueTasks = openTasks.filter((tsk) => tsk.due_date && tsk.due_date < today && !tsk.verified_at);
  const awaitingApproval = filteredTasks.filter((tsk) => tsk.completed_at && !tsk.verified_at);
  const criticalBlockers = overdueTasks.filter((tsk) => tsk.priority_id === urgentPriorityId);

  const tasksById = useMemo(() => Object.fromEntries(tasks.map((tsk) => [tsk.id, tsk])), [tasks]);
  const openBridges = bridges.filter((b) => {
    const tsk = tasksById[b.task_id];
    return !tsk || !tsk.closed_at;
  });

  const departmentBreakdown = useMemo(() => {
    const byDept = {};
    for (const tsk of openTasks) {
      const key = tsk.to_department_id;
      byDept[key] = (byDept[key] || 0) + 1;
    }
    return Object.entries(byDept).map(([id, count]) => ({ id, name: deptName(id), count })).sort((a, b) => b.count - a.count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTasks, lookups.departmentById]);

  const locationBreakdown = useMemo(() => {
    const byLoc = {};
    for (const tsk of openTasks) {
      const owner = profileById[tsk.current_owner_id];
      const locId = owner?.home_location_id;
      const key = locId ? (locationById[locId]?.[lang === "gu" ? "name_gu" : "name_en"] || "—") : t("allLocations", lang);
      byLoc[key] = (byLoc[key] || 0) + 1;
    }
    return Object.entries(byLoc).sort((a, b) => b[1] - a[1]);
  }, [openTasks, profileById, locationById, lang]);

  const recent = useMemo(
    () => [...filteredTasks].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")).slice(0, 8),
    [filteredTasks],
  );

  const activeUsers = profiles.filter((p) => p.is_active).length;
  const activeDepartments = (departments || []).filter((d) => d.is_active && !d.is_control_tower).length;

  const deptCards = useMemo(() => buildOrderedDepartments(departments).filter((d) => !d.is_control_tower), [departments]);
  const openCountByDept = useMemo(() => {
    const map = {};
    for (const tsk of openTasks) {
      map[tsk.to_department_id] = (map[tsk.to_department_id] || 0) + 1;
    }
    return map;
  }, [openTasks]);

  function updateFilter(key, value) {
    setFilters((f) => ({ ...f, [key]: value }));
  }
  function clearFilters() {
    setFilters({ departmentId: "", locationId: "", statusId: "", priorityId: "", from: "", to: "" });
  }

  if (loading) {
    return (
      <div className="dept-dashboard">
        <div className="skeleton-block" style={{ height: 60 }} />
        <div className="kpi-grid">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => <div key={i} className="skeleton-block kpi-skeleton" />)}
        </div>
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
        <div className="dept-header-icon" aria-hidden="true">🗼</div>
        <div className="dept-header-text">
          <h1>{t("controlTowerTitle", lang)}</h1>
          <div className="sub">{lookups.departmentById && Object.values(lookups.departmentById).find((d) => d.is_control_tower)?.[lang === "gu" ? "name_en" : "name_gu"]}</div>
        </div>
      </div>

      <div className="card">
        <h2>{t("filters", lang)}</h2>
        <div className="filter-bar">
          <select value={filters.departmentId} onChange={(e) => updateFilter("departmentId", e.target.value)}>
            <option value="">{t("allDepartments", lang)}</option>
            {(departments || []).filter((d) => !d.is_control_tower).map((d) => (
              <option key={d.id} value={d.id}>{lang === "gu" ? d.name_gu : d.name_en}</option>
            ))}
          </select>
          <select value={filters.locationId} onChange={(e) => updateFilter("locationId", e.target.value)}>
            <option value="">{t("allLocations", lang)}</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{lang === "gu" ? l.name_gu : l.name_en}</option>
            ))}
          </select>
          <select value={filters.statusId} onChange={(e) => updateFilter("statusId", e.target.value)}>
            <option value="">{t("allStatuses", lang)}</option>
            {(lookups.statuses || []).map((s) => (
              <option key={s.id} value={s.id}>{s.code}</option>
            ))}
          </select>
          <select value={filters.priorityId} onChange={(e) => updateFilter("priorityId", e.target.value)}>
            <option value="">{t("allPriorities", lang)}</option>
            {(lookups.priorities || []).map((p) => (
              <option key={p.id} value={p.id}>{p.code}</option>
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

      <div className="kpi-grid kpi-grid-wide">
        <button className="kpi-tile" onClick={() => document.getElementById("open-department-section")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
          <div className="num">{activeDepartments}</div><div className="label">{t("totalActiveDepartments", lang)}</div>
        </button>
        <button className="kpi-tile" onClick={() => navigate("/users")}>
          <div className="num">{activeUsers}</div><div className="label">{t("totalActiveUsers", lang)}</div>
        </button>
        <button className="kpi-tile" onClick={() => navigate("/tasks")}>
          <div className="num">{openTasks.length}</div><div className="label">{t("tasksPendingLabel", lang)}</div>
        </button>
        <button className="kpi-tile" onClick={() => navigate("/tasks")}>
          <div className="num">{overdueTasks.length}</div><div className="label">{t("tasksOverdueLabel", lang)}</div>
        </button>
        <button className="kpi-tile gold" onClick={() => navigate("/tasks")}>
          <div className="num">{criticalBlockers.length}</div><div className="label">{t("criticalBlockers", lang)}</div>
        </button>
        <button className="kpi-tile" onClick={() => navigate("/tasks")}>
          <div className="num">{awaitingApproval.length}</div><div className="label">{t("pendingApprovals", lang)}</div>
        </button>
        <button className="kpi-tile" onClick={() => navigate("/bridges")}>
          <div className="num">{openBridges.length}</div><div className="label">{t("crossDeptDependencies", lang)}</div>
        </button>
      </div>

      <div className="card" id="open-department-section">
        <h2>{t("openDepartment", lang)}</h2>
        <div className="control-tower-dept-grid">
          {deptCards.map((d) => (
            <button key={d.id} className="dept-card-link" onClick={() => navigate(d.route)}>
              <span className="dept-card-icon" aria-hidden="true">{d.icon}</span>
              <span className="dept-card-name">{lang === "gu" ? d.name_gu : d.name_en}</span>
              {d.is_confidential_domain && <span className="restricted-tag" title={t("restrictedBadge", lang)}>🔒</span>}
              <span className="dept-card-count">{openCountByDept[d.id] || 0} {t("openTasksLabel", lang)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="card">
          <h2>{t("deptWiseStatus", lang)}</h2>
          {departmentBreakdown.length === 0 && <div className="msg info">{t("noTasks", lang)}</div>}
          {departmentBreakdown.map((row) => (
            <div key={row.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span>{row.name}</span><span>{row.count}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <h2>{t("locationWiseStatus", lang)}</h2>
          {locationBreakdown.length === 0 && <div className="msg info">{t("noTasks", lang)}</div>}
          {locationBreakdown.map(([name, count]) => (
            <div key={name} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span>{name}</span><span>{count}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>{t("recentActivity", lang)}</h2>
        {recent.length === 0 && <div className="msg info">{t("noActivityYet", lang)}</div>}
        {recent.map((tsk) => (
          <div key={tsk.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
            <span>{tsk.task_number} — {tsk.title}</span>
            <span>{deptName(tsk.to_department_id)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
