import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../../lib/i18n";
import { formatCurrency } from "../../lib/retailModules";
import {
  listProjects, updateProjectField, updateProjectDetails, listProjectChanges,
  setFreezeCheck, freezeProject, hasOpenMajorSnag,
} from "../../lib/interiorApi";

const emptyDetails = { location: "", start_date: "", next_update: "", on_time: null, next_action: "", remarks: "" };

// md/MOOD-OF-WOOD-SYSTEM.md §2 — the 13-stage workflow, verbatim from the
// doc, plus the rules the system refuses to let you skip:
//   - No design approval -> no design freeze (4-point checklist below)
//   - No design freeze -> no execution release
//   - Open major snag -> no project closure
//   - Pending change request -> no stage advance
const STAGES = [
  "Quotation", "Deal Closed", "Kick-off", "Design", "Client Approval",
  "Design Freeze", "Execution Planning", "Purchase/Production", "Execution",
  "QC", "Snagging", "Handover", "Completed",
];
const FREEZE_FIELDS = [
  ["freeze_check_3d", "freezeCheck3d"], ["freeze_check_drawing", "freezeCheckDrawing"],
  ["freeze_check_specs", "freezeCheckSpecs"], ["freeze_check_customer_approval", "freezeCheckCustomer"],
];

export default function InteriorTimeline({ lang }) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [details, setDetails] = useState(emptyDetails);
  const [saving, setSaving] = useState(false);
  const [stageMsg, setStageMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await listProjects();
    if (err) { setError(true); setLoading(false); return; }
    setProjects(data || []);
    if (data?.length) setProjectId((cur) => cur || data[0].id);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const project = projects.find((p) => p.id === projectId);
  useEffect(() => {
    setDetails({
      location: project?.location || "",
      start_date: project?.start_date || "",
      next_update: project?.next_update || "",
      on_time: project?.on_time ?? null,
      next_action: project?.next_action || "",
      remarks: project?.remarks || "",
    });
    setStageMsg("");
  }, [project]);

  function refreshProject(data) {
    setProjects((ps) => ps.map((p) => (p.id === projectId ? data : p)));
  }

  async function saveDetails(e) {
    e.preventDefault();
    if (!projectId) return;
    setSaving(true);
    const { data, error: err } = await updateProjectDetails(projectId, {
      location: details.location || null,
      start_date: details.start_date || null,
      next_update: details.next_update || null,
      on_time: details.on_time,
      next_action: details.next_action || null,
      remarks: details.remarks || null,
    });
    setSaving(false);
    if (!err) refreshProject(data);
  }

  async function toggleFreezeCheck(field, value) {
    setBusy(true);
    const { data, error: err } = await setFreezeCheck(projectId, field, value);
    setBusy(false);
    if (!err) refreshProject(data);
  }

  async function doFreeze() {
    setBusy(true);
    const { data, error: err } = await freezeProject(projectId);
    setBusy(false);
    if (err) { setStageMsg(err.message); return; }
    refreshProject(data);
  }

  const stageIndex = useMemo(() => (project ? STAGES.indexOf(project.stage) : -1), [project]);
  const freezeStageIndex = STAGES.indexOf("Design Freeze");

  async function advanceStage() {
    if (!project || stageIndex < 0 || stageIndex >= STAGES.length - 1) return;
    setStageMsg("");
    setBusy(true);

    const { data: changes } = await listProjectChanges(projectId);
    if ((changes || []).some((c) => c.approval_status === "PENDING")) {
      setBusy(false);
      setStageMsg(t("stageBlockedChange", lang));
      return;
    }

    const nextStage = STAGES[stageIndex + 1];
    const nextIndex = stageIndex + 1;
    if (nextIndex > freezeStageIndex && !project.frozen) {
      setBusy(false);
      setStageMsg(t("stageBlockedFreeze", lang));
      return;
    }
    if (nextStage === "Completed") {
      const { hasOpen } = await hasOpenMajorSnag(projectId);
      if (hasOpen) {
        setBusy(false);
        setStageMsg(t("closeProjectBlocked", lang));
        return;
      }
    }

    const { data, error: err } = await updateProjectField(projectId, "stage", nextStage);
    setBusy(false);
    if (err) { setStageMsg(err.message); return; }
    refreshProject(data);
  }

  const canFreezeNow = project && FREEZE_FIELDS.every(([f]) => project[f]);

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
        <div className="dept-header-icon" aria-hidden="true">🗓️</div>
        <div className="dept-header-text">
          <h1>{t("interiorTimelineTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="field-action-row">
          <div className="field">
            <label>{t("projectCodeLabel", lang)}</label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
            </select>
          </div>
          <button className="btn btn-outline" onClick={() => navigate("/interior-projects/new")}>
            {t("addNewProject", lang)}
          </button>
        </div>
      </div>

      {project && (
        <div className="dept-meta-grid">
          <div className="card dept-meta-tile"><div className="label">{t("stageLabel", lang)}</div><div className="value">{project.stage}</div></div>
          <div className="card dept-meta-tile"><div className="label">{t("projectValueLabel", lang)}</div><div className="value">{formatCurrency(project.project_value)}</div></div>
          <div className="card dept-meta-tile"><div className="label">{t("dueDateLabel", lang)}</div><div className="value">{project.due_date || "—"}</div></div>
          <div className="card dept-meta-tile"><div className="label">{t("lastUpdateLabel", lang)}</div><div className="value">{project.last_update || "—"}</div></div>
        </div>
      )}

      {project && stageIndex >= 0 && stageIndex < STAGES.length - 1 && (
        <div className="card">
          <h2>{t("advanceStage", lang)}</h2>
          <div className="task-meta" style={{ marginTop: 0, alignItems: "center" }}>
            <span className="badge ASSIGNED">{project.stage}</span>
            <span aria-hidden="true">→</span>
            <span className="badge VERIFIED">{STAGES[stageIndex + 1]}</span>
          </div>
          {stageMsg && <div className="msg error" style={{ marginTop: 10 }}>{stageMsg}</div>}
          <button className="btn btn-primary" style={{ marginTop: 10 }} disabled={busy} onClick={advanceStage}>{t("advanceStage", lang)}</button>
        </div>
      )}

      {project && !project.frozen && (
        <div className="card">
          <h2>{t("designFreezeTitle", lang)}</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {FREEZE_FIELDS.map(([field, labelKey]) => (
              <label key={field} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input type="checkbox" checked={!!project[field]} disabled={busy} onChange={(e) => toggleFreezeCheck(field, e.target.checked)} />
                <span>{t(labelKey, lang)}</span>
              </label>
            ))}
          </div>
          {!canFreezeNow && <div className="msg info" style={{ marginTop: 10 }}>{t("allChecksRequired", lang)}</div>}
          <button className="btn btn-primary" style={{ marginTop: 10 }} disabled={busy || !canFreezeNow} onClick={doFreeze}>{t("freezeProjectAction", lang)}</button>
        </div>
      )}
      {project && project.frozen && (
        <div className="card">
          <div className="task-meta" style={{ marginTop: 0, alignItems: "center" }}>
            <span className="badge CLOSED">{t("projectFrozenLabel", lang)}</span>
            <span>{project.freeze_date}</span>
          </div>
        </div>
      )}

      {project && (
        <div className="card">
          <h2>{t("interiorProjectDetailsTitle", lang)}</h2>
          <form onSubmit={saveDetails} className="form-grid">
            <div className="field">
              <label>{t("interiorLocationLabel", lang)}</label>
              <input value={details.location} onChange={(e) => setDetails((d) => ({ ...d, location: e.target.value }))} />
            </div>
            <div className="field">
              <label>{t("startDateLabel", lang)}</label>
              <input type="date" value={details.start_date} onChange={(e) => setDetails((d) => ({ ...d, start_date: e.target.value }))} />
            </div>
            <div className="field">
              <label>{t("nextUpdateLabel", lang)}</label>
              <input type="date" value={details.next_update} onChange={(e) => setDetails((d) => ({ ...d, next_update: e.target.value }))} />
            </div>
            <div className="field">
              <label>{t("onTimeLabel", lang)}</label>
              <div className="btn-row" style={{ marginTop: 0 }}>
                <button type="button" className={`btn ${details.on_time === true ? "btn-primary" : "btn-outline"}`} onClick={() => setDetails((d) => ({ ...d, on_time: true }))}>{t("yesLabel", lang)}</button>
                <button type="button" className={`btn ${details.on_time === false ? "btn-primary" : "btn-outline"}`} onClick={() => setDetails((d) => ({ ...d, on_time: false }))}>{t("noLabel", lang)}</button>
              </div>
            </div>
            <div className="field full">
              <label>{t("nextActionLabel", lang)}</label>
              <textarea value={details.next_action} onChange={(e) => setDetails((d) => ({ ...d, next_action: e.target.value }))} />
            </div>
            <div className="field full">
              <label>{t("remarksLabel", lang)}</label>
              <textarea value={details.remarks} onChange={(e) => setDetails((d) => ({ ...d, remarks: e.target.value }))} />
            </div>
            <div className="field full">
              <button className="btn btn-primary" type="submit" disabled={saving}>{t("save", lang)}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
