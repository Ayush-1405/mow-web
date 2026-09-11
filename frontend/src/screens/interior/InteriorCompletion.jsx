import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { listProjects, getHandover, setHandoverFlag, submitFeedback, notifyDeptLeadership } from "../../lib/interiorApi";

const HANDOVER_FLAGS = [
  ["qc_complete", "qcCompleteLabel"],
  ["cleaning_complete", "cleaningCompleteLabel"],
  ["snags_complete", "snagsCompleteLabel"],
  ["hardware_complete", "hardwareCompleteLabel"],
  ["customer_inspection", "customerInspectionLabel"],
  ["warranty_documents", "warrantyDocumentsLabel"],
  ["handover_complete", "handoverCompleteLabel"],
];
const SCORE_FIELDS = ["design_score", "communication_score", "quality_score", "timeliness_score", "overall_score"];
const SCORE_LABELS = ["designScoreLabel", "communicationScoreLabel", "qualityScoreLabel", "timelinessScoreLabel", "overallScoreLabel"];

// Project Completion — the external system's `handovers` checklist +
// `customer_feedback` capture. Each checklist toggle writes exactly one
// boolean field via setHandoverFlag() (never the whole row), since another
// system may also be reading/writing this same record.
export default function InteriorCompletion({ lang, lockedProjectId }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [handover, setHandover] = useState(null);
  const [busyField, setBusyField] = useState(null);
  const [confirmField, setConfirmField] = useState(null);
  const [feedback, setFeedback] = useState({ design_score: 5, communication_score: 5, quality_score: 5, timeliness_score: 5, overall_score: 5, note: "" });
  const [savingFeedback, setSavingFeedback] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await listProjects();
    if (err) { setError(true); setLoading(false); return; }
    setProjects(data || []);
    if (data?.length) setProjectId((cur) => cur || lockedProjectId || data[0].id);
    setLoading(false);
  }, [lockedProjectId]);

  useEffect(() => { load(); }, [load]);

  const loadHandover = useCallback(async () => {
    if (!projectId) { setHandover(null); return; }
    const { data } = await getHandover(projectId);
    setHandover(data || {});
    setFeedbackSent(false);
  }, [projectId]);

  useEffect(() => { loadHandover(); }, [loadHandover]);

  async function toggleFlag(field, labelKey) {
    setBusyField(field);
    const nextValue = !handover?.[field];
    const { error: err } = await setHandoverFlag(projectId, field, nextValue);
    setBusyField(null);
    setConfirmField(null);
    if (err) return;
    const project = projects.find((p) => p.id === projectId);
    notifyDeptLeadership(
      "INTERIOR", "project", projectId,
      `${t(labelKey, "en")}: ${nextValue ? "done" : "undone"} — ${project ? `${project.project_code} (${project.customer})` : ""}`,
      `${t(labelKey, "gu")}: ${nextValue ? "પૂર્ણ" : "અપૂર્ણ"}`,
    );
    loadHandover();
  }

  async function handleFeedback(e) {
    e.preventDefault();
    setSavingFeedback(true);
    const { error: err } = await submitFeedback({ project_id: projectId, ...feedback });
    setSavingFeedback(false);
    if (err) return;
    const project = projects.find((p) => p.id === projectId);
    notifyDeptLeadership(
      "INTERIOR", "project", projectId,
      `Customer feedback submitted (overall ${feedback.overall_score}/10) — ${project ? `${project.project_code} (${project.customer})` : ""}`,
      `ગ્રાહક પ્રતિસાદ સબમિટ થયો (એકંદરે ${feedback.overall_score}/10)`,
    );
    setFeedbackSent(true);
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
        <div className="dept-header-icon" aria-hidden="true">🏁</div>
        <div className="dept-header-text">
          <h1>{t("interiorCompletionTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>{t("projectCodeLabel", lang)}</label>
          {lockedProjectId ? (
            <div className="sub" style={{ fontWeight: 700, marginTop: 4 }}>
              {(() => { const p = projects.find((pr) => pr.id === projectId); return p ? `${p.project_code} — ${p.customer}` : "—"; })()}
            </div>
          ) : (
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
            </select>
          )}
        </div>
      </div>

      <div className="card">
        {HANDOVER_FLAGS.map(([field, labelKey]) => (
          <div key={field} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
            <span>{t(labelKey, lang)}</span>
            {confirmField === field ? (
              <span className="btn-row" style={{ marginTop: 0 }}>
                <span className="sub">{t("areYouSure", lang)}</span>
                <button className="btn btn-primary" disabled={busyField === field} onClick={() => toggleFlag(field, labelKey)}>{t("confirm", lang)}</button>
                <button className="btn btn-outline" onClick={() => setConfirmField(null)}>{t("cancel", lang)}</button>
              </span>
            ) : (
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={!!handover?.[field]} onChange={() => setConfirmField(field)} disabled={busyField === field} />
              </label>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h2>{t("customerFeedbackTitle", lang)}</h2>
        {feedbackSent
          ? <div className="msg success">{t("savedSuccess", lang)}</div>
          : (
            <form onSubmit={handleFeedback} className="form-grid">
              {SCORE_FIELDS.map((field, i) => (
                <div className="field" key={field}>
                  <label>{t(SCORE_LABELS[i], lang)}</label>
                  <input type="number" min="1" max="10" value={feedback[field]} onChange={(e) => setFeedback((f) => ({ ...f, [field]: Number(e.target.value) }))} />
                </div>
              ))}
              <div className="field full">
                <label>{t("notesLabel", lang)}</label>
                <textarea value={feedback.note} onChange={(e) => setFeedback((f) => ({ ...f, note: e.target.value }))} />
              </div>
              <div className="field full">
                <button className="btn btn-primary" type="submit" disabled={savingFeedback || !projectId}>{t("submitFeedback", lang)}</button>
              </div>
            </form>
          )}
      </div>
    </div>
  );
}
