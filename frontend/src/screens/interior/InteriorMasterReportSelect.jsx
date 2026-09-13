import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../../lib/i18n";
import { formatCurrency } from "../../lib/retailModules";
import { listProjects, listInteriorPeople, listProjectMembers } from "../../lib/interiorApi";

// Same authoritative stage list InteriorTimeline.jsx / InteriorProjectDetail.jsx use.
const STAGES = [
  "Quotation", "Design", "Client Approval", "Design Freeze",
  "Execution Planning", "Purchase/Production", "Execution",
  "QC", "Snagging", "Handover", "Completed",
];

// Master Report project selector — listProjects() is already scoped by the
// same RLS (interior_is_org_wide / interior_is_project_member) every other
// Interior screen relies on, so this list is already exactly "projects the
// logged-in user is permitted to view." No extra filtering needed here for
// access — only for the user's own search/narrow-down convenience.
export default function InteriorMasterReportSelect({ lang }) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [people, setPeople] = useState([]);
  const [teamByProject, setTeamByProject] = useState({});
  const [q, setQ] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [pmFilter, setPmFilter] = useState("");
  const [startFrom, setStartFrom] = useState("");
  const [startTo, setStartTo] = useState("");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data, error: err }, peopleRes] = await Promise.all([listProjects(), listInteriorPeople()]);
    if (err) { setError(true); setLoading(false); return; }
    setProjects(data || []);
    setPeople(peopleRes.data || []);
    const teamLists = await Promise.all((data || []).map((p) => listProjectMembers(p.id)));
    const map = {};
    (data || []).forEach((p, i) => { map[p.id] = teamLists[i].data || []; });
    setTeamByProject(map);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const personName = useCallback((id) => people.find((p) => p.id === id)?.name || "—", [people]);

  const pmOptions = useMemo(() => {
    const ids = new Set(projects.map((p) => p.project_manager_id).filter(Boolean));
    return people.filter((p) => ids.has(p.id));
  }, [projects, people]);

  const filtered = useMemo(() => projects.filter((p) => {
    if (stageFilter && p.stage !== stageFilter) return false;
    if (pmFilter && p.project_manager_id !== pmFilter) return false;
    if (startFrom && (!p.start_date || p.start_date < startFrom)) return false;
    if (startTo && (!p.start_date || p.start_date > startTo)) return false;
    if (dueFrom && (!p.due_date || p.due_date < dueFrom)) return false;
    if (dueTo && (!p.due_date || p.due_date > dueTo)) return false;
    if (q) {
      const needle = q.toLowerCase();
      const haystack = [p.project_code, p.customer, p.location, p.stage, personName(p.project_manager_id)].join(" ").toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  }), [projects, stageFilter, pmFilter, startFrom, startTo, dueFrom, dueTo, q, personName]);

  if (loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 60 }} /><div className="skeleton-block" style={{ height: 300 }} /></div>;
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
        <div className="dept-header-icon" aria-hidden="true">📊</div>
        <div className="dept-header-text">
          <h1>{t("masterReportCardLabel", lang)}</h1>
          <div className="sub">{t("masterReportSelectTitle", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="filter-bar">
          <input placeholder={t("searchLabel", lang)} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "auto", minWidth: 200, flex: 1 }} />
          <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
            <option value="">{t("filterByStageLabel", lang)}</option>
            {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={pmFilter} onChange={(e) => setPmFilter(e.target.value)}>
            <option value="">{t("filterByPmLabel", lang)}</option>
            {pmOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="filter-bar" style={{ marginTop: 8 }}>
          <label className="sub">{t("startDateFromLabel", lang)}<input type="date" value={startFrom} onChange={(e) => setStartFrom(e.target.value)} /></label>
          <label className="sub">{t("startDateToLabel", lang)}<input type="date" value={startTo} onChange={(e) => setStartTo(e.target.value)} /></label>
          <label className="sub">{t("dueDateFromLabel", lang)}<input type="date" value={dueFrom} onChange={(e) => setDueFrom(e.target.value)} /></label>
          <label className="sub">{t("dueDateToLabel", lang)}<input type="date" value={dueTo} onChange={(e) => setDueTo(e.target.value)} /></label>
        </div>
      </div>

      {filtered.length === 0 && <div className="card"><div className="msg info">{t("noRecordsForProject", lang)}</div></div>}

      {filtered.map((p) => {
        const stageIndex = STAGES.indexOf(p.stage);
        const progressPct = stageIndex >= 0 ? Math.round(((stageIndex + 1) / STAGES.length) * 100) : 0;
        const team = teamByProject[p.id] || [];
        const teamNames = Array.from(new Set([p.designer_id, p.execution_id, ...team.map((m) => m.profile_id)].filter(Boolean))).map(personName);
        return (
          <div key={p.id} className="card">
            <div className="task-meta" style={{ marginTop: 0, justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 15 }}>{p.project_code} — {p.customer}</div>
                <div className="sub">{p.location || "—"}</div>
              </div>
              <span className="badge ASSIGNED">{p.stage}</span>
            </div>
            <div className="dept-meta-grid" style={{ marginTop: 10 }}>
              <div className="card dept-meta-tile"><div className="label">{t("interiorRole_pm", lang)}</div><div className="value">{personName(p.project_manager_id)}</div></div>
              <div className="card dept-meta-tile"><div className="label">{t("dueDateLabel", lang)}</div><div className="value">{p.due_date || "—"}</div></div>
              <div className="card dept-meta-tile"><div className="label">{t("projectValueLabel", lang)}</div><div className="value">{formatCurrency(p.project_value)}</div></div>
              <div className="card dept-meta-tile"><div className="label">{t("progressLabel", lang)}</div><div className="value">{progressPct}%</div></div>
            </div>
            {teamNames.length > 0 && <div className="sub" style={{ marginTop: 8 }}>{t("projectTeamTitle", lang)}: {teamNames.join(", ")}</div>}
            <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={() => navigate(`/interior-projects/master-report/${p.id}`)}>
              {t("openReportAction", lang)}
            </button>
          </div>
        );
      })}
    </div>
  );
}
