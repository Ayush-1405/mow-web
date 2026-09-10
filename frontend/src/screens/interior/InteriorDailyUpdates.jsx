import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import { listProjects, listSiteReports, createSiteReport, notifyDeptLeadership } from "../../lib/interiorApi";

// Daily Site Update — md/MOOD-OF-WOOD-SYSTEM.md §5, "the most-used screen
// in the system": Today's Work -> tick what's Completed -> Pending is
// whatever's left (automatic) -> Material required? (Yes files it to
// Purchase the same moment, §6) -> Any issue? -> Tomorrow's Plan ->
// Remarks -> Send. Untick a Today's Work chip and it drops out of
// Completed and reappears in Pending immediately (plain derived state,
// no separate step).
//
// The doc's catalogues are FIXED, curated vocabularies (Designer 15 items,
// PM 17, Execution 24, Purchase 15, CRM 6, Director/Head 12; a separate,
// larger Next Step list per role) — their exact wording isn't in the spec
// I was given, only the counts, so hardcoding plausible-sounding entries
// would be inventing operational data. Today's Work / Material / Tomorrow's
// Plan are free-text tag chips instead (type + Enter) until the real
// wording is supplied — structurally identical (multi-select, chips,
// searchable-by-typing), just not a closed vocabulary yet.
function ChipInput({ value, onChange, placeholder }) {
  const [draft, setDraft] = useState("");
  function commit() {
    const v = draft.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setDraft("");
  }
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        {value.map((chip) => (
          <span key={chip} className="badge ASSIGNED" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {chip}
            <button type="button" onClick={() => onChange(value.filter((c) => c !== chip))} style={{ border: "none", background: "none", cursor: "pointer", color: "inherit", fontWeight: 700 }}>✕</button>
          </span>
        ))}
      </div>
      <input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
        onBlur={commit}
      />
    </div>
  );
}

export default function InteriorDailyUpdates({ lang }) {
  const profile = useInteriorProfile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState(false);

  const [todaysWork, setTodaysWork] = useState([]);
  const [completed, setCompleted] = useState(new Set());
  const [materialRequired, setMaterialRequired] = useState(false);
  const [materials, setMaterials] = useState([]);
  const [materialRemark, setMaterialRemark] = useState("");
  const [issuePresent, setIssuePresent] = useState(false);
  const [issueText, setIssueText] = useState("");
  const [tomorrowPlan, setTomorrowPlan] = useState([]);
  const [remarks, setRemarks] = useState("");

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

  const loadReports = useCallback(async () => {
    if (!projectId) { setRows([]); return; }
    const { data, error: err } = await listSiteReports(projectId);
    if (!err) setRows(data || []);
  }, [projectId]);

  useEffect(() => { loadReports(); }, [loadReports]);

  const project = projects.find((p) => p.id === projectId);

  const pending = useMemo(() => todaysWork.filter((w) => !completed.has(w)), [todaysWork, completed]);

  function toggleCompleted(item) {
    setCompleted((s) => {
      const next = new Set(s);
      if (next.has(item)) next.delete(item); else next.add(item);
      return next;
    });
  }
  function setTodaysWorkAndPrune(next) {
    setTodaysWork(next);
    setCompleted((s) => new Set([...s].filter((x) => next.includes(x))));
  }

  async function handleSend(e) {
    e.preventDefault();
    if (!projectId) return;
    setSaving(true);
    const { data: report, error: err } = await createSiteReport({
      project_id: projectId,
      report_date: new Date().toISOString().slice(0, 10),
      work_today: todaysWork.join(", ") || null,
      work_done: [...completed].join(", ") || null,
      work_pending: pending.length ? pending.join(", ") : t("noneLabel", lang),
      material: materialRequired && materials.length ? materials.join(", ") : null,
      issue: issuePresent ? issueText : null,
      tomorrow_plan: tomorrowPlan.join(", ") || null,
      remarks: remarks || null,
      submitted_by: profile?.id || null,
    });
    if (err) { setSaving(false); setError(true); return; }

    // Material required = Yes files it to Purchase the SAME moment (§6) —
    // one project_materials row per item, linked to this report so the
    // (site_report_id, material) unique index blocks a duplicate if this
    // report is ever re-sent.
    if (materialRequired && materials.length) {
      await supabase.from("project_materials").insert(
        materials.map((m) => ({
          project_id: projectId, material: m, status: "Pending to Order",
          source: "daily-update", site_report_id: report.id, remark: materialRemark || null,
          requested_by: profile?.id || null,
        })),
      );
    }

    const projectLabel = project ? `${project.project_code} — ${project.customer}` : "";
    notifyDeptLeadership(
      "INTERIOR", "site_report", report.id,
      `Daily update submitted: ${projectLabel}`,
      `દૈનિક અપડેટ સબમિટ થયું: ${projectLabel}`,
    );

    setSaving(false);
    setTodaysWork([]); setCompleted(new Set()); setMaterialRequired(false); setMaterials([]);
    setMaterialRemark(""); setIssuePresent(false); setIssueText(""); setTomorrowPlan([]); setRemarks("");
    loadReports();
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
        <div className="dept-header-icon" aria-hidden="true">📝</div>
        <div className="dept-header-text">
          <h1>{t("interiorDailyUpdatesTitle", lang)}</h1>
          <div className="sub">{t("catalogueNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>{t("projectCodeLabel", lang)}</label>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
          </select>
        </div>
      </div>

      <div className="card">
        <form onSubmit={handleSend} className="form-grid">
          <div className="field full">
            <label>{t("todaysWorkStep", lang)}</label>
            <ChipInput value={todaysWork} onChange={setTodaysWorkAndPrune} placeholder={t("todaysWorkStep", lang)} />
          </div>

          {todaysWork.length > 0 && (
            <div className="field full">
              <label>{t("tickCompletedStep", lang)}</label>
              {todaysWork.map((item) => (
                <label key={item} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <input type="checkbox" checked={completed.has(item)} onChange={() => toggleCompleted(item)} />
                  {item}
                </label>
              ))}
            </div>
          )}

          <div className="field full">
            <label>{t("workPendingAuto", lang)}</label>
            <div className="msg info">{pending.length ? pending.join(", ") : t("noneLabel", lang)}</div>
          </div>

          <div className="field full">
            <label>{t("materialRequiredQ", lang)}</label>
            <div className="btn-row" style={{ marginTop: 0 }}>
              <button type="button" className={`btn ${materialRequired ? "btn-primary" : "btn-outline"}`} onClick={() => setMaterialRequired(true)}>{t("yesLabel", lang)}</button>
              <button type="button" className={`btn ${!materialRequired ? "btn-primary" : "btn-outline"}`} onClick={() => { setMaterialRequired(false); setMaterials([]); setMaterialRemark(""); }}>{t("noLabel", lang)}</button>
            </div>
            {materialRequired && (
              <div style={{ marginTop: 8 }}>
                <ChipInput value={materials} onChange={setMaterials} placeholder={t("materialItemPlaceholder", lang)} />
                <input placeholder={t("notesLabel", lang)} value={materialRemark} onChange={(e) => setMaterialRemark(e.target.value)} style={{ marginTop: 6 }} />
              </div>
            )}
          </div>

          <div className="field full">
            <label>{t("anyIssueQ", lang)}</label>
            <div className="btn-row" style={{ marginTop: 0 }}>
              <button type="button" className={`btn ${issuePresent ? "btn-primary" : "btn-outline"}`} onClick={() => setIssuePresent(true)}>{t("yesLabel", lang)}</button>
              <button type="button" className={`btn ${!issuePresent ? "btn-primary" : "btn-outline"}`} onClick={() => { setIssuePresent(false); setIssueText(""); }}>{t("noLabel", lang)}</button>
            </div>
            {issuePresent && <textarea style={{ marginTop: 8 }} value={issueText} onChange={(e) => setIssueText(e.target.value)} />}
          </div>

          <div className="field full">
            <label>{t("tomorrowPlanStep", lang)}</label>
            <ChipInput value={tomorrowPlan} onChange={setTomorrowPlan} placeholder={t("tomorrowPlanStep", lang)} />
          </div>

          <div className="field full">
            <label>{t("notesLabel", lang)}</label>
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </div>

          <div className="field full">
            <button className="btn btn-primary" type="submit" disabled={saving || !projectId}>{t("sendUpdate", lang)}</button>
          </div>
        </form>
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => (
          <div key={r.id} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
            <div style={{ fontWeight: 700 }}>{r.report_date}</div>
            <div className="sub">{t("todayWorkLabel", lang)}: {r.work_today || "—"}</div>
            <div className="sub">{t("workPendingAuto", lang)}: {r.work_pending || "—"}</div>
            <span className="badge IN_PROGRESS">{r.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
