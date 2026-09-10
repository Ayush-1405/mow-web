import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { t } from "../lib/i18n";

// Management Analytics — Phase 1. Reachable only by Management, same gate
// and same underlying reads (staff_tasks / user_profiles / locations under
// RLS a `management` caller already sees in full) as Management Control
// Tower and Reports — this screen adds no new data access, invents no
// figures, and duplicates none of Control Tower's or Reports' network
// calls (it fetches once, on its own mount, exactly like every other
// screen in this app already does).
//
// Kept separate from Reports on purpose: Reports is tabular/exportable,
// this is the visual/trend view — bar charts only (no pie/donut), one hue
// per magnitude comparison, the app's own existing status-badge colors for
// the one identity comparison (task status), so a status always reads the
// same color here as it does everywhere else in the app.
const STATUS_ORDER = ["ASSIGNED", "ACCEPTED", "IN_PROGRESS", "COMPLETED", "VERIFIED", "RETURNED", "CLOSED"];
const STATUS_COLOR = {
  ASSIGNED: "#97731c", ACCEPTED: "#1f5c96", IN_PROGRESS: "#4c6d2b",
  COMPLETED: "#6640a3", VERIFIED: "#1a7a5a", RETURNED: "#a23434", CLOSED: "#5c5347",
};
const AGEING_BUCKETS = [
  { key: "0-3", labelKey: "ageing0to3", min: 0, max: 3, color: "#eab08c" },
  { key: "4-7", labelKey: "ageing4to7", min: 4, max: 7, color: "#e2896a" },
  { key: "8-14", labelKey: "ageing8to14", min: 8, max: 14, color: "#d9634c" },
  { key: "15+", labelKey: "ageing15plus", min: 15, max: Infinity, color: "#d1453d" },
];

export default function Analytics({ lang, lookups, departments }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [locations, setLocations] = useState([]);
  const [filters, setFilters] = useState({ departmentId: "", locationId: "" });

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [taskRes, profileRes, locRes] = await Promise.all([
      supabase.from("staff_tasks").select("*").eq("is_active", true).limit(1000),
      supabase.from("user_profiles").select("id, department_id, home_location_id, is_active"),
      supabase.from("locations").select("id, name_en, name_gu").eq("is_active", true),
    ]);
    if (taskRes.error || profileRes.error || locRes.error) {
      setError(true);
      setLoading(false);
      return;
    }
    setTasks(taskRes.data || []);
    setProfiles(profileRes.data || []);
    setLocations(locRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const profileById = useMemo(() => Object.fromEntries(profiles.map((p) => [p.id, p])), [profiles]);
  const deptLabel = useCallback(
    (id) => lookups.departmentById?.[id]?.[lang === "gu" ? "name_gu" : "name_en"] || "—",
    [lookups.departmentById, lang],
  );
  const locLabel = useCallback(
    (id) => locations.find((l) => l.id === id)?.[lang === "gu" ? "name_gu" : "name_en"] || "—",
    [locations, lang],
  );
  const today = new Date().toISOString().slice(0, 10);

  const filteredTasks = useMemo(() => tasks.filter((tsk) => {
    if (filters.departmentId && tsk.to_department_id !== filters.departmentId) return false;
    if (filters.locationId) {
      const owner = profileById[tsk.current_owner_id];
      if (!owner || owner.home_location_id !== filters.locationId) return false;
    }
    return true;
  }), [tasks, filters, profileById]);

  const openTasks = useMemo(() => filteredTasks.filter((tsk) => !tsk.closed_at), [filteredTasks]);

  const statusRows = useMemo(() => {
    const counts = {};
    for (const tsk of filteredTasks) {
      const code = lookups.statusById?.[tsk.status_id]?.code;
      if (code) counts[code] = (counts[code] || 0) + 1;
    }
    return STATUS_ORDER.map((code) => ({ key: code, label: code, value: counts[code] || 0, color: STATUS_COLOR[code] }));
  }, [filteredTasks, lookups.statusById]);

  const activeDepartments = useMemo(
    () => (departments || []).filter((d) => d.is_active && !d.is_control_tower),
    [departments],
  );

  const departmentRows = useMemo(() => activeDepartments.map((d) => ({
    key: d.id, label: deptLabel(d.id),
    value: openTasks.filter((tsk) => tsk.to_department_id === d.id).length,
  })).sort((a, b) => b.value - a.value), [activeDepartments, openTasks, deptLabel]);

  const locationRows = useMemo(() => {
    const rows = locations.map((l) => ({
      key: l.id, label: locLabel(l.id),
      value: openTasks.filter((tsk) => profileById[tsk.current_owner_id]?.home_location_id === l.id).length,
    }));
    const noLoc = openTasks.filter((tsk) => !profileById[tsk.current_owner_id]?.home_location_id).length;
    if (noLoc > 0) rows.push({ key: "none", label: t("noLocationAssigned", lang), value: noLoc });
    return rows.sort((a, b) => b.value - a.value);
  }, [locations, locLabel, openTasks, profileById, lang]);

  const trendRows = useMemo(() => {
    const days = [];
    for (let i = 13; i >= 0; i -= 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const counts = {};
    for (const tsk of filteredTasks) {
      const day = tsk.created_at?.slice(0, 10);
      if (day) counts[day] = (counts[day] || 0) + 1;
    }
    return days.map((day) => ({
      key: day, value: counts[day] || 0,
      label: day.slice(5).replace("-", "/"),
      isToday: day === today,
    }));
  }, [filteredTasks, today]);

  const ageingRows = useMemo(() => {
    const counts = { "0-3": 0, "4-7": 0, "8-14": 0, "15+": 0 };
    for (const tsk of openTasks) {
      if (!tsk.due_date || tsk.due_date >= today || tsk.verified_at) continue;
      const days = Math.floor((new Date(today) - new Date(tsk.due_date)) / 86400000);
      const bucket = AGEING_BUCKETS.find((b) => days >= b.min && days <= b.max);
      if (bucket) counts[bucket.key] += 1;
    }
    return AGEING_BUCKETS.map((b) => ({ key: b.key, label: t(b.labelKey, lang), value: counts[b.key], color: b.color }));
  }, [openTasks, today, lang]);

  function updateFilter(key, value) { setFilters((f) => ({ ...f, [key]: value })); }
  function clearFilters() { setFilters({ departmentId: "", locationId: "" }); }

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
        <div className="dept-header-icon" aria-hidden="true">📈</div>
        <div className="dept-header-text"><h1>{t("analyticsTitle", lang)}</h1></div>
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
          <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={clearFilters}>{t("clearFilters", lang)}</button>
        </div>
      </div>

      <div className="card">
        <h2>{t("taskStatusBreakdown", lang)}</h2>
        <HBarChart rows={statusRows} colorFor={(r) => r.color} lang={lang} />
      </div>

      <div className="dashboard-grid">
        <div className="card">
          <h2>{t("departmentWorkload", lang)}</h2>
          <HBarChart rows={departmentRows} colorFor={() => "var(--brand-dark)"} lang={lang} />
        </div>
        <div className="card">
          <h2>{t("locationWorkload", lang)}</h2>
          <HBarChart rows={locationRows} colorFor={() => "var(--accent-dark)"} lang={lang} />
        </div>
      </div>

      <div className="card">
        <h2>{t("tasksCreatedTrend", lang)}</h2>
        <VBarChart rows={trendRows} colorFor={(r) => (r.isToday ? "var(--accent-dark)" : "var(--brand)")} lang={lang} />
      </div>

      <div className="card">
        <h2>{t("overdueAgeing", lang)}</h2>
        <VBarChart rows={ageingRows} colorFor={(r) => r.color} lang={lang} />
      </div>
    </div>
  );
}

// Horizontal bar list — sequential magnitude comparison (or the app's own
// fixed status colors, when `colorFor` returns one per row). Direct labels
// only: row label on the left, value on the right, no separate legend.
function HBarChart({ rows, colorFor, lang }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0 || rows.every((r) => r.value === 0)) {
    return <div className="msg info">{t("noChartData", lang)}</div>;
  }
  return (
    <div className="bar-chart">
      {rows.map((r) => (
        <div className="bar-row" key={r.key}>
          <span className="bar-row-label" title={r.label}>{r.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(r.value / max) * 100}%`, background: colorFor(r) }} />
          </span>
          <span className="bar-row-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

// Vertical column chart — used for the two time/ordinal series (daily
// trend, overdue ageing). Values are labeled only on the tallest column and
// the "current" column (today), per the sparing-direct-labels rule; the
// rest are readable from bar height + the day/bucket label underneath.
function VBarChart({ rows, colorFor, lang }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0 || rows.every((r) => r.value === 0)) {
    return <div className="msg info">{t("noChartData", lang)}</div>;
  }
  const maxRow = rows.reduce((a, b) => (b.value > a.value ? b : a), rows[0]);
  return (
    <div className="col-chart">
      {rows.map((r) => (
        <div className="col-chart-bar" key={r.key}>
          {(r === maxRow || r.isToday) && r.value > 0 && <span className="col-chart-value">{r.value}</span>}
          <span
            className="col-chart-fill"
            style={{ height: `${Math.max(2, (r.value / max) * 100)}%`, background: colorFor(r) }}
            title={`${r.label}: ${r.value}`}
          />
          <span className="col-chart-label">{r.label}</span>
        </div>
      ))}
    </div>
  );
}
