import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { formatCurrency } from "../../lib/retailModules";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import { getDepartmentCards } from "../../lib/departmentConfig";
import { getModuleRoute } from "../../lib/moduleRegistry";

// Who gets the team-wide KPI/Needs-Attention/Control-Tower tracking view,
// vs. just their own My Today + the function-card grid to reach their own
// operational screens — Super Admin, Management, Dept Head, Accounts
// Head/CFO, Supervisor only, same set DepartmentDashboard.jsx uses. This
// checks the STAFF PILOT role (staffProfile.roleCode), never the separate
// Interior-system functional role (pm/designer/execution/...) resolved by
// InteriorProfileGate — those are two different profiles.
const ELEVATED_ROLES = new Set(["dept_head", "supervisor", "accounts_head", "cfo", "sysadmin"]);

const EXTRA_LINKS = [
  { en: "New Project", gu: "નવો પ્રોજેક્ટ", route: "/interior-projects/new", icon: "➕" },
  { en: "Purchase Board", gu: "ખરીદી બોર્ડ", route: "/interior-projects/purchase", icon: "🧾" },
  { en: "Tasks", gu: "કાર્યો", route: "/interior-projects/tasks", icon: "✅" },
  { en: "Customer Requests & Complaints", gu: "ગ્રાહક વિનંતીઓ", route: "/interior-projects/requests", icon: "📮" },
];

// Interior Head Dashboard — the Control Tower / KPI / Needs Attention /
// project health view from md/MOOD-OF-WOOD-SYSTEM.md §4/§7, built against
// the SAME live Interior Projects tables the rest of this module already
// uses (projects/site_reports/snags/project_changes/project_materials/
// tasks). Scoped per that doc's rule: Director/Head/Purchase/CRM see every
// project, a PM/Designer/Execution person sees only projects where they
// are project_manager_id/designer_id/execution_id — using their resolved
// external profiles.id (see InteriorProfileGate.jsx), never their staff
// pilot auth uid, since that's what these columns actually reference.
// Wood Brown/Gold theme throughout — no new colors, reusing .kpi-tile/
// .card/.badge.* exactly as the rest of the app already does.
function workingDaysSince(dateStr) {
  if (!dateStr) return null;
  const start = new Date(dateStr);
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  start.setHours(0, 0, 0, 0);
  let days = 0;
  const cursor = new Date(start);
  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1);
    if (cursor.getDay() !== 0) days += 1; // Sundays excluded
  }
  return days;
}

export default function InteriorHeadDashboard({ lang, staffProfile }) {
  const navigate = useNavigate();
  const profile = useInteriorProfile();
  const isElevated = !!staffProfile?.isManagement || !!staffProfile?.isSuperAdmin || ELEVATED_ROLES.has(staffProfile?.roleCode);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [lastUpdateByProject, setLastUpdateByProject] = useState({});
  const [majorSnagByProject, setMajorSnagByProject] = useState({});
  const [pendingChangeByProject, setPendingChangeByProject] = useState({});
  const [materialPendingByProject, setMaterialPendingByProject] = useState({});
  const [myTasks, setMyTasks] = useState([]);
  const [mySnags, setMySnags] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [projRes, reportsRes, snagsRes, changesRes, materialsRes, tasksRes, mySnagsRes] = await Promise.all([
      supabase.from("projects").select("*").eq("archived", false),
      supabase.from("site_reports").select("project_id, report_date"),
      supabase.from("snags").select("project_id, major, status"),
      supabase.from("project_changes").select("project_id, approval_status"),
      supabase.from("project_materials").select("project_id, status"),
      profile?.id
        ? supabase.from("tasks").select("*, projects(project_code, customer)").eq("assigned_to", profile.id).neq("status", "COMPLETED")
        : Promise.resolve({ data: [] }),
      profile?.id
        ? supabase.from("snags").select("*, projects(project_code, customer)").eq("assigned_to", profile.id).neq("status", "COMPLETED")
        : Promise.resolve({ data: [] }),
    ]);
    if (projRes.error || reportsRes.error || snagsRes.error || changesRes.error || materialsRes.error) {
      setError(true); setLoading(false); return;
    }
    setMySnags(mySnagsRes.data || []);
    setProjects(projRes.data || []);

    const lastUpdate = {};
    for (const r of reportsRes.data || []) {
      if (!lastUpdate[r.project_id] || r.report_date > lastUpdate[r.project_id]) lastUpdate[r.project_id] = r.report_date;
    }
    setLastUpdateByProject(lastUpdate);

    const majorSnags = {};
    for (const s of snagsRes.data || []) {
      if (s.major && s.status !== "COMPLETED") majorSnags[s.project_id] = (majorSnags[s.project_id] || 0) + 1;
    }
    setMajorSnagByProject(majorSnags);

    const pendingChanges = {};
    for (const c of changesRes.data || []) {
      if (c.approval_status === "PENDING") pendingChanges[c.project_id] = (pendingChanges[c.project_id] || 0) + 1;
    }
    setPendingChangeByProject(pendingChanges);

    const materialPending = {};
    for (const m of materialsRes.data || []) {
      if (m.status !== "Received") materialPending[m.project_id] = (materialPending[m.project_id] || 0) + 1;
    }
    setMaterialPendingByProject(materialPending);

    setMyTasks((tasksRes.data || []).sort((a, b) => (a.due_date || "").localeCompare(b.due_date || "")));
    setLoading(false);
  }, [profile?.id]);

  useEffect(() => { load(); }, [load]);

  const scopedProjects = useMemo(() => {
    if (!profile) return projects;
    if (profile.role === "pm") return projects.filter((p) => p.project_manager_id === profile.id);
    if (profile.role === "designer") return projects.filter((p) => p.designer_id === profile.id);
    if (profile.role === "execution") return projects.filter((p) => p.execution_id === profile.id);
    return projects; // director / head / purchase / crm see all
  }, [projects, profile]);

  const today = new Date().toISOString().slice(0, 10);
  const weekAhead = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  function healthOf(p) {
    if (p.due_date && p.due_date < today) return "delayed";
    if (majorSnagByProject[p.id] > 0) return "delayed";
    if ((materialPendingByProject[p.id] || 0) > 0 && p.due_date && p.due_date <= weekAhead) return "delayed";
    const days = workingDaysSince(lastUpdateByProject[p.id]);
    if (p.due_date && p.due_date <= weekAhead) return "attention";
    if (days !== null && days >= 2) return "attention";
    if ((pendingChangeByProject[p.id] || 0) > 0) return "attention";
    if (!p.stage || p.stage === "Client Approval") return "attention";
    return "ontrack";
  }

  const healthCounts = useMemo(() => {
    const c = { ontrack: 0, attention: 0, delayed: 0 };
    for (const p of scopedProjects) c[healthOf(p)] += 1;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedProjects, majorSnagByProject, pendingChangeByProject, materialPendingByProject, lastUpdateByProject]);

  const dueThisWeek = scopedProjects.filter((p) => p.due_date && p.due_date >= today && p.due_date <= weekAhead).length;
  const pendingApprovals = Object.values(pendingChangeByProject).reduce((a, b) => a + b, 0);
  const materialPendingTotal = Object.values(materialPendingByProject).reduce((a, b) => a + b, 0);
  const noUpdateProjects = scopedProjects.filter((p) => (workingDaysSince(lastUpdateByProject[p.id]) ?? 99) >= 2);

  const attentionFeed = useMemo(() => {
    const rows = [];
    for (const p of scopedProjects) {
      const days = workingDaysSince(lastUpdateByProject[p.id]);
      if (days !== null && days >= 2) rows.push({ key: `${p.id}-noupdate`, project: p, text: t("noUpdateDays", lang).replace("{n}", days) });
      if (majorSnagByProject[p.id] > 0) rows.push({ key: `${p.id}-snag`, project: p, text: `${majorSnagByProject[p.id]} ${t("majorLabel", lang)} ${t("interiorSiteExecutionTitle", lang)}` });
      if (materialPendingByProject[p.id] > 0) rows.push({ key: `${p.id}-material`, project: p, text: `${t("materialPendingLabel", lang)}: ${materialPendingByProject[p.id]}` });
      if (pendingChangeByProject[p.id] > 0) rows.push({ key: `${p.id}-change`, project: p, text: `${pendingChangeByProject[p.id]} ${t("pendingApprovalsLabel", lang)}` });
      if (p.due_date && p.due_date < today) rows.push({ key: `${p.id}-overdue`, project: p, text: `${t("dueDateLabel", lang)}: ${p.due_date} (${t("delayedLabel", lang)})` });
    }
    return rows;
  }, [scopedProjects, lastUpdateByProject, majorSnagByProject, materialPendingByProject, pendingChangeByProject, today, lang]);

  if (loading) {
    return (
      <div className="dept-dashboard">
        <div className="skeleton-block" style={{ height: 60 }} />
        <div className="kpi-grid">{[1, 2, 3, 4, 5, 6, 7, 8].map((i) => <div key={i} className="skeleton-block kpi-skeleton" />)}</div>
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
          <h1>{t("interiorHeadDashboardTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      {(myTasks.length > 0 || mySnags.length > 0) && (
        <div className="card">
          <h2>{t("myTodayLabel", lang)}</h2>
          {myTasks.slice(0, 6).map((tsk) => (
            <div key={`task-${tsk.id}`} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
              <span>{tsk.title} — {tsk.projects?.project_code}</span>
              <span className={tsk.due_date && tsk.due_date < today ? "overdue" : "sub"}>{tsk.due_date || "—"}</span>
            </div>
          ))}
          {mySnags.slice(0, 6).map((sn) => (
            <div key={`snag-${sn.id}`} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", cursor: "pointer" }} onClick={() => navigate("/interior-projects/site-execution")}>
              <span>🔧 {sn.issue} — {sn.projects?.project_code} {sn.major && <span className="badge RETURNED">{t("majorLabel", lang)}</span>}</span>
              <span className={sn.due_date && sn.due_date < today ? "overdue" : "sub"}>{sn.due_date || "—"}</span>
            </div>
          ))}
        </div>
      )}

      {isElevated && (
        <>
          <div className="kpi-grid kpi-grid-wide">
            <div className="kpi-tile"><div className="num">{scopedProjects.length}</div><div className="label">{t("totalProjects", lang)}</div></div>
            <div className="kpi-tile"><div className="num">{healthCounts.ontrack}</div><div className="label">{t("onTrackLabel", lang)}</div></div>
            <div className="kpi-tile gold"><div className="num">{healthCounts.attention}</div><div className="label">{t("attentionNeededLabel", lang)}</div></div>
            <div className="kpi-tile"><div className="num">{healthCounts.delayed}</div><div className="label">{t("delayedLabel", lang)}</div></div>
            <div className="kpi-tile"><div className="num">{dueThisWeek}</div><div className="label">{t("dueThisWeekLabel", lang)}</div></div>
            <div className="kpi-tile"><div className="num">{pendingApprovals}</div><div className="label">{t("pendingApprovalsLabel", lang)}</div></div>
            <div className="kpi-tile"><div className="num">{materialPendingTotal}</div><div className="label">{t("materialPendingLabel", lang)}</div></div>
            <div className="kpi-tile"><div className="num">{noUpdateProjects.length}</div><div className="label">{t("noUpdateWarningLabel", lang)}</div></div>
          </div>

          <div className="card">
            <h2>{t("needsAttentionLabel", lang)}</h2>
            {attentionFeed.length === 0 && <div className="msg info">{t("allCaughtUp", lang)}</div>}
            {attentionFeed.map((row) => (
              <div key={row.key} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", cursor: "pointer" }} onClick={() => navigate(`/interior-projects/detail/${row.project.id}`)}>
                <span>{row.project.project_code} — {row.project.customer}</span>
                <span className="sub">{row.text}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="card">
        <h2>{t("departmentFunctions", lang)}</h2>
        <div className="function-card-grid">
          {getDepartmentCards("INTERIOR").map((c) => {
            const route = getModuleRoute("INTERIOR", c.en);
            return (
              <button key={c.en} className="function-card" onClick={() => route && navigate(route)}>
                <span className="function-card-label">{lang === "gu" ? c.gu : c.en}</span>
                <span className="function-card-sub">{lang === "gu" ? c.en : c.gu}</span>
              </button>
            );
          })}
          {EXTRA_LINKS.map((l) => (
            <button key={l.route} className="function-card" onClick={() => navigate(l.route)}>
              <span className="function-card-label">{l.icon} {lang === "gu" ? l.gu : l.en}</span>
            </button>
          ))}
        </div>
      </div>

      {isElevated && (
        <div className="card">
          <h2>{t("controlTowerLabel", lang)}</h2>
          <div className="control-tower-dept-grid">
            {scopedProjects.map((p) => {
              const health = healthOf(p);
              const badgeClass = health === "ontrack" ? "VERIFIED" : health === "attention" ? "ASSIGNED" : "RETURNED";
              return (
                <button key={p.id} className="dept-card-link" onClick={() => navigate(`/interior-projects/detail/${p.id}`)}>
                  <span className="dept-card-icon" aria-hidden="true">🏗️</span>
                  <span className="dept-card-name">{p.project_code} — {p.customer}</span>
                  <span className={`badge ${badgeClass}`}>{t(`health${health === "ontrack" ? "OnTrack" : health === "attention" ? "Attention" : "Delayed"}`, lang)}</span>
                  <span className="dept-card-count">{p.stage} · {formatCurrency(p.project_value)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
