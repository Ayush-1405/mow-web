import React, { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { t } from "../../lib/i18n";
import { formatCurrency } from "../../lib/retailModules";
import { listProjects, listInteriorPeople } from "../../lib/interiorApi";
import InteriorAttachments from "./InteriorAttachments.jsx";
import InteriorWorkingDrawings from "./InteriorWorkingDrawings.jsx";
import InteriorSiteExecution from "./InteriorSiteExecution.jsx";
import InteriorDailyUpdates from "./InteriorDailyUpdates.jsx";
import InteriorMaterials from "./InteriorMaterials.jsx";
import InteriorPurchaseManagement from "./InteriorPurchaseManagement.jsx";
import InteriorTimeline from "./InteriorTimeline.jsx";
import InteriorClientComm from "./InteriorClientComm.jsx";
import InteriorPayments from "./InteriorPayments.jsx";
import InteriorCompletion from "./InteriorCompletion.jsx";
import InteriorTasks from "./InteriorTasks.jsx";
import InteriorRequests from "./InteriorRequests.jsx";
import InteriorAllFiles from "./InteriorAllFiles.jsx";
import InteriorActivityHistory from "./InteriorActivityHistory.jsx";

// Same authoritative stage list InteriorTimeline.jsx uses (projects_stage_check).
const STAGES = [
  "Quotation", "Design", "Client Approval", "Design Freeze",
  "Execution Planning", "Purchase/Production", "Execution",
  "QC", "Snagging", "Handover", "Completed",
];

// One entry per section the spec asks for. `render` gets (projectId, ctx)
// where ctx carries the props every screen already expects (lang,
// staffProfile, lookups) — every tab reuses the EXISTING screen component
// unchanged except for the one new lockedProjectId prop (see each
// screen's own lockedProjectId handling), so this page adds zero
// duplicate business logic. purchaseManagement's own Board sub-view stays
// org-wide/cross-project by design (md/MOOD-OF-WOOD-SYSTEM.md §6) even
// though the tab itself opens locked to this project.
const TABS = [
  { key: "overview", labelKey: "tabOverview", render: null },
  { key: "quotation", labelKey: "tabQuotation", render: (pid, c) => <InteriorAttachments lang={c.lang} stage="Quotation" titleKey="interiorAttachmentsTitle" lockedProjectId={pid} /> },
  { key: "dealClosure", labelKey: "tabDealClosure", render: (pid, c) => <InteriorTimeline lang={c.lang} staffProfile={c.staffProfile} lockedProjectId={pid} /> },
  { key: "workingDrawings", labelKey: "tabWorkingDrawings", render: (pid, c) => <InteriorWorkingDrawings lang={c.lang} staffProfile={c.staffProfile} lockedProjectId={pid} /> },
  { key: "siteExecution", labelKey: "tabSiteExecution", render: (pid, c) => <InteriorSiteExecution lang={c.lang} lockedProjectId={pid} /> },
  { key: "dailyUpdates", labelKey: "tabDailyUpdates", render: (pid, c) => <InteriorDailyUpdates lang={c.lang} lockedProjectId={pid} /> },
  { key: "materials", labelKey: "tabMaterials", render: (pid, c) => <InteriorMaterials lang={c.lang} filterSource={null} lockedProjectId={pid} /> },
  { key: "purchaseManagement", labelKey: "tabPurchaseManagement", render: (pid, c) => <InteriorPurchaseManagement lang={c.lang} staffProfile={c.staffProfile} lockedProjectId={pid} /> },
  { key: "timeline", labelKey: "tabTimeline", render: (pid, c) => <InteriorTimeline lang={c.lang} staffProfile={c.staffProfile} lockedProjectId={pid} /> },
  { key: "clientComm", labelKey: "tabClientComm", render: (pid, c) => <InteriorClientComm lang={c.lang} lockedProjectId={pid} /> },
  { key: "payments", labelKey: "tabPayments", render: (pid, c) => <InteriorPayments lang={c.lang} lookups={c.lookups} lockedProjectId={pid} /> },
  { key: "tasks", labelKey: "tabTasks", render: (pid, c) => <InteriorTasks lang={c.lang} lockedProjectId={pid} /> },
  { key: "requests", labelKey: "tabRequests", render: (pid, c) => <InteriorRequests lang={c.lang} lockedProjectId={pid} /> },
  { key: "completion", labelKey: "tabCompletion", render: (pid, c) => <InteriorCompletion lang={c.lang} lockedProjectId={pid} /> },
  { key: "files", labelKey: "tabFiles", render: (pid, c) => <InteriorAllFiles lang={c.lang} projectId={pid} /> },
  { key: "activity", labelKey: "tabActivity", render: (pid, c) => <InteriorActivityHistory lang={c.lang} projectId={pid} isElevated={c.isElevated} /> },
];

export default function InteriorProjectDetail({ lang, staffProfile, lookups }) {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [project, setProject] = useState(null);
  const [people, setPeople] = useState([]);
  const [activeTab, setActiveTab] = useState("overview");

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data, error: err }, peopleRes] = await Promise.all([listProjects(), listInteriorPeople()]);
    if (err) { setError(true); setLoading(false); return; }
    const found = (data || []).find((p) => p.id === projectId);
    if (!found) { setError(true); setLoading(false); return; }
    setProject(found);
    setPeople(peopleRes.data || []);
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);
  // A different project link (Control Tower card, notification, etc.)
  // while this page is already mounted — same route component, just a
  // new :projectId param — resets the active tab back to Overview.
  useEffect(() => { setActiveTab("overview"); }, [projectId]);

  const personName = useCallback((id) => people.find((p) => p.id === id)?.name || "—", [people]);
  const isElevated = !!staffProfile?.isManagement || !!staffProfile?.isSuperAdmin || !!staffProfile?.isDeptHead;

  if (loading) {
    return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 90 }} /><div className="skeleton-block" style={{ height: 300 }} /></div>;
  }
  if (error || !project) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">{t("loadErrorRetry", lang)}</div>
        <button className="btn btn-primary" onClick={load}>{t("retry", lang)}</button>
      </div>
    );
  }

  const stageIndex = STAGES.indexOf(project.stage);
  const progressPct = stageIndex >= 0 ? Math.round(((stageIndex + 1) / STAGES.length) * 100) : 0;
  const ctx = { lang, staffProfile, lookups, isElevated };

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🏗️</div>
        <div className="dept-header-text">
          <h1>{project.project_code} — {project.customer}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
        <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => navigate(`/interior-projects/master-report/${projectId}`)}>
          {t("masterReportButtonLabel", lang)}
        </button>
      </div>

      <div className="dept-meta-grid">
        <div className="card dept-meta-tile"><div className="label">{t("stageLabel", lang)}</div><div className="value">{project.stage}</div></div>
        <div className="card dept-meta-tile"><div className="label">{t("interiorRole_pm", lang)}</div><div className="value">{personName(project.project_manager_id)}</div></div>
        <div className="card dept-meta-tile"><div className="label">{t("startDateLabel", lang)}</div><div className="value">{project.start_date || "—"}</div></div>
        <div className="card dept-meta-tile"><div className="label">{t("dueDateLabel", lang)}</div><div className="value">{project.due_date || "—"}</div></div>
        <div className="card dept-meta-tile"><div className="label">{t("projectValueLabel", lang)}</div><div className="value">{formatCurrency(project.project_value)}</div></div>
        <div className="card dept-meta-tile"><div className="label">{t("progressLabel", lang)}</div><div className="value">{progressPct}%</div></div>
      </div>

      <div className="card" style={{ padding: 10 }}>
        <div className="btn-row" style={{ marginTop: 0, flexWrap: "wrap" }}>
          {TABS.map((tb) => (
            <button
              key={tb.key}
              className={`btn ${activeTab === tb.key ? "btn-primary" : "btn-outline"}`}
              style={{ marginTop: 0, width: "auto" }}
              onClick={() => setActiveTab(tb.key)}
            >
              {t(tb.labelKey, lang)}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "overview" ? (
        <div className="card">
          <h2>{t("tabOverview", lang)}</h2>
          <div className="task-meta" style={{ padding: "6px 0" }}><span>{t("interiorRole_designer", lang)}</span><span className="sub">{personName(project.designer_id)}</span></div>
          <div className="task-meta" style={{ padding: "6px 0" }}><span>{t("interiorRole_execution", lang)}</span><span className="sub">{project.execution_id ? personName(project.execution_id) : "—"}</span></div>
          <div className="task-meta" style={{ padding: "6px 0" }}><span>{t("interiorLocationLabel", lang)}</span><span className="sub">{project.location || "—"}</span></div>
          <div className="task-meta" style={{ padding: "6px 0" }}><span>{t("nextActionLabel", lang)}</span><span className="sub">{project.next_action || "—"}</span></div>
          {project.frozen && <div className="msg info" style={{ marginTop: 10 }}>{t("projectFrozenLabel", lang)} — {project.freeze_date}</div>}
          <button className="btn btn-outline" style={{ marginTop: 10 }} onClick={() => navigate("/interior-projects")}>{t("backToTasks", lang)}</button>
        </div>
      ) : (
        TABS.find((tb) => tb.key === activeTab)?.render(projectId, ctx)
      )}
    </div>
  );
}
