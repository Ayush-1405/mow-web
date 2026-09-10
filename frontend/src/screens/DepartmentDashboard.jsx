import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { t } from "../lib/i18n";
import { getDepartmentCards, getDepartmentIcon } from "../lib/departmentConfig";
import { getModuleRoute } from "../lib/moduleRegistry";
import ModuleInfoModal from "../components/ModuleInfoModal.jsx";

// Who sees the real roster/head-name/location-count on a department page,
// instead of the "not authorized" fallback. supervisor is capped to their
// OWN department by RLS (user_profiles_select_hod_scope) — unlike
// dept_head, a supervisor never sees a sibling/child department's roster,
// but they run one team and need to see it to actually supervise it.
const ELEVATED_ROSTER_ROLES = new Set(["dept_head", "supervisor", "accounts_head", "cfo", "sysadmin"]);

// Generic department dashboard shell — Phase 1 (navigation, structure, and
// real-but-basic KPIs; full per-department operational workflows are
// Phase 2). Every number here comes straight from the existing staff_tasks
// / bridges / user_profiles tables through the SAME RLS policies every
// other screen in this app already relies on:
//   - staff_tasks_select_scoped / bridges_select_scoped narrow the rows a
//     Department Member ever receives to ones they're personally involved
//     in; a Department Head/Management receives the full department/HOD
//     scope. This component adds no extra filtering of its own to enforce
//     that — the database has already done it before a row ever arrives.
//   - staff_list_department_roster() is already restricted server-side to
//     Management / Department Head / Accounts Head / CFO. For any other
//     role it legitimately returns zero rows, so the roster/head-count/
//     locations cards below fall back to an explanatory empty state
//     instead of a number for those users, rather than a broken query.
export default function DepartmentDashboard({ lang, profile, department, onOpenLegacy }) {
  const navigate = useNavigate();
  const code = department?.code;
  const deptName = lang === "gu" ? department?.name_gu : department?.name_en;
  const deptNameOther = lang === "gu" ? department?.name_en : department?.name_gu;
  const isElevated = !!profile?.isManagement || ELEVATED_ROSTER_ROLES.has(profile?.roleCode);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [urgentPriorityIds, setUrgentPriorityIds] = useState(() => new Set());
  const [roster, setRoster] = useState([]);
  const [rosterAllowed, setRosterAllowed] = useState(false);
  const [headName, setHeadName] = useState(null);
  const [activeCard, setActiveCard] = useState(null);

  const load = useCallback(async () => {
    if (!department?.id) return;
    setLoading(true);
    setError(false);

    const [taskRes, priorityRes] = await Promise.all([
      supabase
        .from("staff_tasks")
        .select("*")
        .eq("is_active", true)
        .or(`from_department_id.eq.${department.id},to_department_id.eq.${department.id}`)
        .limit(500),
      supabase.from("priority_master").select("id, code").eq("code", "URGENT"),
    ]);

    if (taskRes.error || priorityRes.error) {
      setError(true);
      setLoading(false);
      return;
    }
    setTasks(taskRes.data || []);
    setUrgentPriorityIds(new Set((priorityRes.data || []).map((p) => p.id)));

    // Roster: queried straight from user_profiles (not the roster RPC,
    // which does not return home_location_id) so the Locations tile below
    // reflects real data. This is exactly as safe: user_profiles_select_
    // hod_scope already grants Management / Department Head (within HOD
    // scope) / Accounts Head this same row set for this same department —
    // a plain Department Member's RLS only ever matches their own single
    // row (user_profiles_select_own), so this is skipped for them entirely
    // rather than spending a request that could only ever return that one
    // row.
    let head = null;
    if (isElevated) {
      const rosterRes = await supabase
        .from("user_profiles")
        .select("id, full_name, home_location_id, role_id, roles(code)")
        .eq("department_id", department.id);
      if (!rosterRes.error) {
        const rows = rosterRes.data || [];
        setRoster(rows);
        setRosterAllowed(true);
        head = rows.find((r) => r.roles?.code === "dept_head") || null;
      }
    }
    if (head) {
      setHeadName(head.full_name);
    } else if (!isElevated) {
      // Best-effort: a small additive RPC (staff_department_head_public)
      // surfaces just the department head's name to every authorized
      // viewer, including a plain Department Member who cannot see the
      // full roster. It may not exist until the accompanying migration is
      // applied — failing silently is deliberate, not a bug.
      try {
        const headRes = await supabase.rpc("staff_department_head_public", { p_department_id: department.id });
        if (!headRes.error && headRes.data && headRes.data[0]) {
          setHeadName(headRes.data[0].full_name);
        } else {
          setHeadName(null);
        }
      } catch {
        setHeadName(null);
      }
    } else {
      setHeadName(null);
    }

    setLoading(false);
  }, [department?.id, isElevated]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!department?.id) return undefined;
    const channel = supabase
      .channel(`dept_dashboard_${department.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "staff_tasks" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [department?.id, load]);

  const today = new Date().toISOString().slice(0, 10);
  const openTasks = useMemo(() => tasks.filter((tsk) => !tsk.closed_at), [tasks]);
  const overdueTasks = useMemo(
    () => openTasks.filter((tsk) => tsk.due_date && tsk.due_date < today && !tsk.verified_at),
    [openTasks, today],
  );
  const awaitingVerification = useMemo(
    () => tasks.filter((tsk) => tsk.completed_at && !tsk.verified_at),
    [tasks],
  );
  const urgentOverdue = useMemo(
    () => overdueTasks.filter((tsk) => urgentPriorityIds.has(tsk.priority_id)),
    [overdueTasks, urgentPriorityIds],
  );
  const recent = useMemo(
    () => [...tasks].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")).slice(0, 5),
    [tasks],
  );
  const locationCount = useMemo(
    () => new Set(roster.map((r) => r.home_location_id).filter(Boolean)).size,
    [roster],
  );

  const cards = getDepartmentCards(code);
  const icon = getDepartmentIcon(code);

  if (loading) {
    return (
      <div className="dept-dashboard">
        <div className="skeleton-block" style={{ height: 90 }} />
        <div className="kpi-grid">
          {[1, 2, 3, 4].map((i) => <div key={i} className="skeleton-block kpi-skeleton" />)}
        </div>
        <div className="skeleton-block" style={{ height: 160 }} />
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
        <div className="dept-header-icon" aria-hidden="true">{icon}</div>
        <div className="dept-header-text">
          <h1>{deptName || department?.code}</h1>
          <div className="sub">{deptNameOther}</div>
          {department?.is_confidential_domain && (
            <span className="badge restricted-badge">🔒 {t("restrictedBadge", lang)}</span>
          )}
        </div>
      </div>

      {/* Team-tracking KPIs/roster — Super Admin, Management, Dept Head,
          Accounts Head/CFO, and Supervisor only. A plain Department Member
          still gets the department page itself (they need it to reach
          their own operational screens below) but not the team-wide
          tracking view — that's for whoever is responsible for the team,
          not every individual on it. */}
      {isElevated ? (
        <>
          <div className="dept-meta-grid">
            <div className="card dept-meta-tile">
              <div className="label">{t("deptHead", lang)}</div>
              <div className="value">{headName || "—"}</div>
            </div>
            <div className="card dept-meta-tile">
              <div className="label">{t("activeMembers", lang)}</div>
              <div className="value">{rosterAllowed ? roster.length : "—"}</div>
            </div>
            <div className="card dept-meta-tile">
              <div className="label">{t("locationsLabel", lang)}</div>
              <div className="value">{rosterAllowed ? locationCount : "—"}</div>
            </div>
          </div>
          {!rosterAllowed && <div className="msg info">{t("notAuthorizedRoster", lang)}</div>}

          <div className="kpi-grid">
            <div className="kpi-tile"><div className="num">{openTasks.length}</div><div className="label">{t("openTasksLabel", lang)}</div></div>
            <div className="kpi-tile"><div className="num">{overdueTasks.length}</div><div className="label">{t("overdueTasksLabel", lang)}</div></div>
            <div className="kpi-tile"><div className="num">{awaitingVerification.length}</div><div className="label">{t("pendingApprovals", lang)}</div></div>
            <div className="kpi-tile gold"><div className="num">{urgentOverdue.length}</div><div className="label">{t("criticalAlerts", lang)}</div></div>
          </div>
        </>
      ) : (
        <div className="card">
          <div className="task-meta" style={{ marginTop: 0 }}>
            <span>{t("deptHead", lang)}: {headName || "—"}</span>
            <span>{t("openTasksLabel", lang)}: {openTasks.length}</span>
            <span>{t("overdueTasksLabel", lang)}: {overdueTasks.length}</span>
          </div>
        </div>
      )}

      <div className="card">
        <h2>{t("quickActions", lang)}</h2>
        <div className="btn-row">
          <button className="btn btn-outline" onClick={() => onOpenLegacy("tasks")}>{t("openMyTasks", lang)}</button>
          <button className="btn btn-outline" onClick={() => onOpenLegacy("assign")}>{t("assignATask", lang)}</button>
          <button className="btn btn-outline" onClick={() => onOpenLegacy("bridges")}>{t("crossDeptBridges", lang)}</button>
        </div>
      </div>

      <div className="card">
        <h2>{t("recentActivity", lang)}</h2>
        {recent.length === 0 && <div className="msg info">{t("noActivityYet", lang)}</div>}
        {recent.map((tsk) => (
          <div key={tsk.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
            <span>{tsk.task_number} — {tsk.title}</span>
            <span>{tsk.due_date || "—"}</span>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>{t("departmentFunctions", lang)}</h2>
        <div className="function-card-grid">
          {cards.map((c) => {
            const route = getModuleRoute(code, c.en);
            return (
              <button
                key={c.en}
                className="function-card"
                onClick={() => (route ? navigate(route) : setActiveCard(c))}
              >
                <span className="function-card-label">{lang === "gu" ? c.gu : c.en}</span>
                <span className="function-card-sub">{lang === "gu" ? c.en : c.gu}</span>
                {route
                  ? <span className="badge live-badge">{t("openLabel", lang)}</span>
                  : <span className="badge phase2-badge">{t("setupPending", lang)}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {activeCard && <ModuleInfoModal lang={lang} card={activeCard} onClose={() => setActiveCard(null)} />}
    </div>
  );
}
