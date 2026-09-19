import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import {
  listAllInhouseProductionRequests, updateInhouseProductionStatus, listInteriorPeople,
  listProductionStageUpdates, factoryUpdateStage, listFactoryQualityChecks, factoryRecordQualityCheck,
  listFactoryReworkRecords, factoryCloseRework, listJobClarifications, factoryRequestClarification,
  uploadFactoryAttachment, factorySubmitCompletion,
} from "../../lib/interiorApi";

// The Factory department's working screen — Interior's "Submit to Factory"
// action (InteriorPurchaseManagement.jsx) creates one linked
// inhouse_production_requests row + staff_tasks row via staff_submit_to_factory;
// this is where Factory actually works the job: the 17-stage production
// pipeline, Quality Control, and Rework, all via the RPCs added in the
// Factory-module migration (factory_update_stage / factory_record_quality_check
// / factory_close_rework). RLS is enforced server-side by
// inhouse_production_requests_scoped / staff_factory_job_visible() — this
// screen shows only what those policies already return, it does not
// implement access control of its own.
const INHOUSE_STATUSES = [
  "Draft", "Submitted to Factory", "Factory Accepted", "Material Check Pending", "Raw Material Pending",
  "Ready for Production", "Production Started", "Work in Progress", "QC Pending", "QC Failed", "Rework",
  "QC Passed", "Packing", "Ready for Dispatch", "Dispatched", "Delivered", "Installed", "Completed", "On Hold", "Cancelled",
];
const STATUS_BADGE = {
  Draft: "CLOSED", "Submitted to Factory": "ASSIGNED", "Factory Accepted": "ASSIGNED", "Production Started": "IN_PROGRESS",
  "Work in Progress": "IN_PROGRESS", "QC Failed": "RETURNED", "QC Passed": "VERIFIED", Dispatched: "COMPLETED",
  Delivered: "VERIFIED", Installed: "VERIFIED", Completed: "VERIFIED", "On Hold": "REVISION", Cancelled: "CLOSED",
};
const PRODUCTION_STAGES = [
  "Planning", "Drawing Pending", "Drawing Approved", "Material Pending", "Material Available",
  "Cutting", "Edge Banding", "CNC", "Carpentry/Assembly", "Polishing/Painting", "Hardware Fitting",
  "Final Assembly", "QC", "Packing", "Ready for Dispatch", "Dispatched", "Installed/Completed",
];
const STAGE_STATUSES = ["pending", "in_progress", "completed", "on_hold", "skipped"];

function personName(people, id) {
  return people.find((p) => p.id === id)?.name || "—";
}

function Kpi({ label, value, tone }) {
  return (
    <div className="card dept-meta-tile">
      <div className="label">{label}</div>
      <div className="value" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );
}

export default function FactoryJobOrders({ lang, profile }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [people, setPeople] = useState([]);
  const [filter, setFilter] = useState("");
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data, error: err }, peopleRes] = await Promise.all([listAllInhouseProductionRequests(), listInteriorPeople()]);
    if (err) { setError(true); setLoading(false); return; }
    setRows(data || []);
    setPeople(peopleRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => subscribeTable("factory_job_orders_list", "inhouse_production_requests", null, load), [load]);

  async function handleStatus(row, status) {
    await updateInhouseProductionStatus(row.purchase_requests?.project_id, row.id, { status });
    load();
  }

  const filtered = filter ? rows.filter((r) => r.status === filter) : rows;
  const factoryPeople = people.filter((p) => p.department_name === "Factory/Manufacturing");

  const kpi = {
    total: rows.length,
    pending: rows.filter((r) => ["Draft", "Submitted to Factory", "Factory Accepted"].includes(r.status)).length,
    inProgress: rows.filter((r) => ["Production Started", "Work in Progress"].includes(r.status)).length,
    materialPending: rows.filter((r) => r.status === "Raw Material Pending" || r.status === "Material Check Pending").length,
    qcPending: rows.filter((r) => r.status === "QC Pending").length,
    rework: rows.filter((r) => r.status === "Rework" || r.rework_status === "Rework Required").length,
    completed: rows.filter((r) => ["Completed", "Installed", "Delivered"].includes(r.status)).length,
    delayed: rows.filter((r) => r.required_completion_date && r.required_completion_date < new Date().toISOString().slice(0, 10)
      && !["Completed", "Installed", "Delivered", "Dispatched", "Cancelled"].includes(r.status)).length,
  };

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
        <div className="dept-header-icon" aria-hidden="true">🏭</div>
        <div className="dept-header-text">
          <h1>{t("factoryJobOrdersTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="dept-meta-grid">
        <Kpi label="Total Jobs" value={kpi.total} />
        <Kpi label="Pending" value={kpi.pending} />
        <Kpi label="In Progress" value={kpi.inProgress} />
        <Kpi label="Material Pending" value={kpi.materialPending} tone={kpi.materialPending ? "#b45309" : undefined} />
        <Kpi label="QC Pending" value={kpi.qcPending} tone={kpi.qcPending ? "#b45309" : undefined} />
        <Kpi label="Rework" value={kpi.rework} tone={kpi.rework ? "#b91c1c" : undefined} />
        <Kpi label="Completed" value={kpi.completed} />
        <Kpi label="Delayed (past due)" value={kpi.delayed} tone={kpi.delayed ? "#b91c1c" : undefined} />
      </div>

      <div className="card">
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: "auto" }}>
          <option value="">{t("allModulesLabel", lang)}</option>
          {INHOUSE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div className="card">
        {filtered.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {filtered.map((r) => (
          <div key={r.id} style={{ borderBottom: "1px solid var(--border, #e5e7eb)", padding: "8px 0" }}>
            <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 6, cursor: "pointer" }}
              onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}>
              <span style={{ fontWeight: 700 }}>{r.job_order_number}</span>
              <span className="sub">{r.purchase_requests?.request_number} · {r.purchase_requests?.projects?.project_code} — {r.purchase_requests?.projects?.customer}</span>
              <span className="sub">{r.product_item}</span>
              <span className="sub">{personName(people, r.assigned_factory_coordinator)}</span>
              <span className="sub">{r.current_stage || "—"} ({r.completion_percentage ?? 0}%)</span>
              <span className={`badge ${STATUS_BADGE[r.status] || "CLOSED"}`}>{r.status}</span>
              <select value={r.status} onChange={(e) => { e.stopPropagation(); handleStatus(r, e.target.value); }} onClick={(e) => e.stopPropagation()}>
                {INHOUSE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button type="button" className="btn btn-outline" style={{ width: "auto" }}>{expandedId === r.id ? "Hide" : "Job Card"}</button>
            </div>
            {expandedId === r.id && <JobCardDetail job={r} factoryPeople={factoryPeople} profile={profile} onChanged={load} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function JobCardDetail({ job, factoryPeople, profile, onChanged }) {
  const [stageUpdates, setStageUpdates] = useState([]);
  const [qcChecks, setQcChecks] = useState([]);
  const [reworkRecords, setReworkRecords] = useState([]);
  const [clarifications, setClarifications] = useState([]);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [stageForm, setStageForm] = useState({ stage: PRODUCTION_STAGES[0], status: "in_progress", notes: "", quantityCompleted: "", quantityPending: "", delayReason: "" });
  const [savingStage, setSavingStage] = useState(false);
  const [qcForm, setQcForm] = useState({
    dimensions: false, material: false, finish: false, hardware: false, drawing: false, quantity: false,
    result: "pass", defectReason: "", reworkRequired: false, assignedReworkPerson: "", recheckDate: "", qcStage: "in_process", photoFile: null,
  });
  const [savingQc, setSavingQc] = useState(false);
  const [clarForm, setClarForm] = useState({ reason: "", relatedReference: "", proofFile: null });
  const [savingClar, setSavingClar] = useState(false);
  const [completionForm, setCompletionForm] = useState({ quantity: "", notes: "", photoFiles: [] });
  const [savingCompletion, setSavingCompletion] = useState(false);
  const [msg, setMsg] = useState("");

  const loadDetail = useCallback(async () => {
    setLoadingDetail(true);
    const [stageRes, qcRes, reworkRes, clarRes] = await Promise.all([
      listProductionStageUpdates(job.id), listFactoryQualityChecks(job.id), listFactoryReworkRecords(job.id), listJobClarifications(job.id),
    ]);
    setStageUpdates(stageRes.data || []);
    setQcChecks(qcRes.data || []);
    setReworkRecords(reworkRes.data || []);
    setClarifications(clarRes.data || []);
    setLoadingDetail(false);
  }, [job.id]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  useEffect(() => subscribeTable(`factory_job_${job.id}_stages`, "production_stage_updates", `job_id=eq.${job.id}`, loadDetail), [job.id, loadDetail]);
  useEffect(() => subscribeTable(`factory_job_${job.id}_qc`, "factory_quality_checks", `job_id=eq.${job.id}`, loadDetail), [job.id, loadDetail]);
  useEffect(() => subscribeTable(`factory_job_${job.id}_rework`, "factory_rework_records", `job_id=eq.${job.id}`, loadDetail), [job.id, loadDetail]);
  useEffect(() => subscribeTable(`factory_job_${job.id}_clar`, "factory_clarification_requests", `job_id=eq.${job.id}`, loadDetail), [job.id, loadDetail]);
  useEffect(() => subscribeTable(`factory_job_${job.id}_row`, "inhouse_production_requests", `id=eq.${job.id}`, onChanged), [job.id, onChanged]);

  async function handleRequestClarification(e) {
    e.preventDefault();
    if (!clarForm.reason.trim()) { setMsg("A clarification reason is required."); return; }
    setSavingClar(true);
    setMsg("");
    let proofPath = null;
    if (clarForm.proofFile) {
      const { path, error: uploadErr } = await uploadFactoryAttachment({
        projectId: job.project_id, module: "factory_clarification", relatedRecordId: job.id,
        file: clarForm.proofFile, fileCategory: "Clarification Proof", uploadedBy: profile?.id,
      });
      if (uploadErr) { setSavingClar(false); setMsg(uploadErr.message); return; }
      proofPath = path;
    }
    const { error } = await factoryRequestClarification(job.id, clarForm.reason, clarForm.relatedReference || null, proofPath);
    setSavingClar(false);
    if (error) { setMsg(error.message); return; }
    setClarForm({ reason: "", relatedReference: "", proofFile: null });
    loadDetail();
    onChanged();
  }

  async function handleSubmitCompletion(e) {
    e.preventDefault();
    if (!completionForm.quantity || Number(completionForm.quantity) <= 0) { setMsg("Actual completed quantity is required."); return; }
    setSavingCompletion(true);
    setMsg("");
    const photoPaths = [];
    for (const file of completionForm.photoFiles) {
      const { path, error: uploadErr } = await uploadFactoryAttachment({
        projectId: job.project_id, module: "factory_completion", relatedRecordId: job.id,
        file, fileCategory: "Completion Photo", uploadedBy: profile?.id,
      });
      if (uploadErr) { setSavingCompletion(false); setMsg(uploadErr.message); return; }
      photoPaths.push(path);
    }
    const { error } = await factorySubmitCompletion(job.id, Number(completionForm.quantity), photoPaths.length ? photoPaths : null, completionForm.notes || null);
    setSavingCompletion(false);
    if (error) { setMsg(error.message); return; }
    setCompletionForm({ quantity: "", notes: "", photoFiles: [] });
    loadDetail();
    onChanged();
  }

  const stageMap = {};
  stageUpdates.forEach((s) => { stageMap[s.stage] = s; });

  async function handleStageSave(e) {
    e.preventDefault();
    setSavingStage(true);
    setMsg("");
    const { error } = await factoryUpdateStage(job.id, stageForm.stage, stageForm.status, {
      notes: stageForm.notes || null,
      quantityCompleted: stageForm.quantityCompleted || null,
      quantityPending: stageForm.quantityPending || null,
      delayReason: stageForm.delayReason || null,
    });
    setSavingStage(false);
    if (error) { setMsg(error.message); return; }
    setStageForm((f) => ({ ...f, notes: "", quantityCompleted: "", quantityPending: "", delayReason: "" }));
    loadDetail();
    onChanged();
  }

  async function handleQcSave(e) {
    e.preventDefault();
    if (qcForm.reworkRequired && !qcForm.defectReason.trim()) { setMsg("A defect reason is required when rework is needed."); return; }
    if (qcForm.result === "fail" && !qcForm.photoFile) { setMsg("At least one photo is required when QC result is Fail."); return; }
    setSavingQc(true);
    setMsg("");
    let photos = null;
    if (qcForm.photoFile) {
      const { path, error: uploadErr } = await uploadFactoryAttachment({
        projectId: job.project_id, module: "factory_qc", relatedRecordId: job.id,
        file: qcForm.photoFile, fileCategory: "QC Photo", uploadedBy: profile?.id,
      });
      if (uploadErr) { setSavingQc(false); setMsg(uploadErr.message); return; }
      photos = [path];
    }
    const { error } = await factoryRecordQualityCheck(job.id, qcForm, qcForm.result, {
      defectReason: qcForm.defectReason || null,
      reworkRequired: qcForm.reworkRequired,
      assignedReworkPerson: qcForm.assignedReworkPerson || null,
      recheckDate: qcForm.recheckDate || null,
      qcStage: qcForm.qcStage, photos,
    });
    setSavingQc(false);
    if (error) { setMsg(error.message); return; }
    setQcForm({ dimensions: false, material: false, finish: false, hardware: false, drawing: false, quantity: false, result: "pass", defectReason: "", reworkRequired: false, assignedReworkPerson: "", recheckDate: "", qcStage: "in_process", photoFile: null });
    loadDetail();
    onChanged();
  }

  async function handleCloseRework(reworkId, recheckResult, correctiveAction, afterPhotoFile) {
    if (!recheckResult.trim()) { setMsg("A recheck result is required to close a rework."); return; }
    if (!afterPhotoFile) { setMsg("An after-rework photo is required to close a rework."); return; }
    const { path, error: uploadErr } = await uploadFactoryAttachment({
      projectId: job.project_id, module: "factory_rework_after", relatedRecordId: reworkId,
      file: afterPhotoFile, fileCategory: "Rework After Photo", uploadedBy: profile?.id,
    });
    if (uploadErr) { setMsg(uploadErr.message); return; }
    const { error } = await factoryCloseRework(reworkId, recheckResult, correctiveAction, [path]);
    if (error) { setMsg(error.message); return; }
    loadDetail();
    onChanged();
  }

  return (
    <div style={{ marginTop: 10, paddingLeft: 8, borderLeft: "3px solid var(--border, #e5e7eb)" }}>
      {msg && <div className="msg error" style={{ marginBottom: 8 }}>{msg}</div>}
      {loadingDetail ? <div className="skeleton-block" style={{ height: 80 }} /> : (
        <>
          <h3 style={{ marginTop: 0 }}>Production Stage Tracking</h3>
          <div className="task-meta" style={{ flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
            {PRODUCTION_STAGES.map((s) => {
              const st = stageMap[s];
              const status = st?.status || "pending";
              const colors = { completed: "#15803d", in_progress: "#b45309", on_hold: "#b91c1c", skipped: "#6b7280", pending: "#9ca3af" };
              return (
                <span key={s} className="sub" title={st?.notes || ""} style={{ border: `1px solid ${colors[status]}`, color: colors[status], borderRadius: 6, padding: "2px 6px" }}>
                  {s}: {status}
                </span>
              );
            })}
          </div>
          <form onSubmit={handleStageSave} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            <div className="field"><label>Stage</label>
              <select value={stageForm.stage} onChange={(e) => setStageForm((f) => ({ ...f, stage: e.target.value }))}>
                {PRODUCTION_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="field"><label>Status</label>
              <select value={stageForm.status} onChange={(e) => setStageForm((f) => ({ ...f, status: e.target.value }))}>
                {STAGE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="field"><label>Qty Completed</label><input type="number" value={stageForm.quantityCompleted} onChange={(e) => setStageForm((f) => ({ ...f, quantityCompleted: e.target.value }))} /></div>
            <div className="field"><label>Qty Pending</label><input type="number" value={stageForm.quantityPending} onChange={(e) => setStageForm((f) => ({ ...f, quantityPending: e.target.value }))} /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Notes</label><input value={stageForm.notes} onChange={(e) => setStageForm((f) => ({ ...f, notes: e.target.value }))} /></div>
            {stageForm.status === "on_hold" && <div className="field" style={{ gridColumn: "1 / -1" }}><label>Delay Reason</label><input value={stageForm.delayReason} onChange={(e) => setStageForm((f) => ({ ...f, delayReason: e.target.value }))} /></div>}
            <button type="submit" className="btn btn-primary" disabled={savingStage}>{savingStage ? "Saving…" : "Update Stage"}</button>
          </form>

          <h3>Quality Control</h3>
          {qcChecks.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {qcChecks.map((qc) => (
                <div key={qc.id} className="sub" style={{ padding: "4px 0" }}>
                  [{qc.qc_stage === "final" ? "Final" : "In-process"}] {new Date(qc.created_at).toLocaleDateString()}: <strong>{qc.result}</strong>{qc.defect_reason ? ` — ${qc.defect_reason}` : ""}
                </div>
              ))}
            </div>
          )}
          <form onSubmit={handleQcSave} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            <div className="field"><label>QC Stage</label>
              <select value={qcForm.qcStage} onChange={(e) => setQcForm((f) => ({ ...f, qcStage: e.target.value }))}>
                <option value="in_process">In-process</option><option value="final">Final</option>
              </select>
            </div>
            {[["dimensions", "Dimensions"], ["material", "Material"], ["finish", "Finish"], ["hardware", "Hardware"], ["drawing", "Drawing Match"], ["quantity", "Quantity"]].map(([k, label]) => (
              <label key={k} className="sub" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input type="checkbox" checked={qcForm[k]} onChange={(e) => setQcForm((f) => ({ ...f, [k]: e.target.checked }))} /> {label}
              </label>
            ))}
            <div className="field"><label>Result</label>
              <select value={qcForm.result} onChange={(e) => setQcForm((f) => ({ ...f, result: e.target.value }))}>
                <option value="pass">Pass</option><option value="conditional_pass">Conditional Pass</option><option value="fail">Fail</option>
              </select>
            </div>
            <div className="field"><label>Photo{qcForm.result === "fail" ? " (required on Fail)" : ""}</label>
              <input type="file" accept="image/*" onChange={(e) => setQcForm((f) => ({ ...f, photoFile: e.target.files?.[0] || null }))} />
            </div>
            <label className="sub" style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={qcForm.reworkRequired} onChange={(e) => setQcForm((f) => ({ ...f, reworkRequired: e.target.checked }))} /> Rework Required
            </label>
            {qcForm.reworkRequired && (
              <>
                <div className="field" style={{ gridColumn: "1 / -1" }}><label>Defect Reason (required)</label>
                  <input value={qcForm.defectReason} onChange={(e) => setQcForm((f) => ({ ...f, defectReason: e.target.value }))} />
                </div>
                <div className="field"><label>Assign Rework To</label>
                  <select value={qcForm.assignedReworkPerson} onChange={(e) => setQcForm((f) => ({ ...f, assignedReworkPerson: e.target.value }))}>
                    <option value="">—</option>
                    {factoryPeople.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="field"><label>Recheck Date</label><input type="date" value={qcForm.recheckDate} onChange={(e) => setQcForm((f) => ({ ...f, recheckDate: e.target.value }))} /></div>
              </>
            )}
            <button type="submit" className="btn btn-primary" disabled={savingQc}>{savingQc ? "Saving…" : "Record QC"}</button>
          </form>

          {reworkRecords.length > 0 && (
            <>
              <h3>Rework</h3>
              {reworkRecords.map((rw) => <ReworkRow key={rw.id} rw={rw} onClose={handleCloseRework} />)}
            </>
          )}

          <h3>Clarification / Revision</h3>
          {clarifications.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {clarifications.map((c) => (
                <div key={c.id} className="card" style={{ marginBottom: 6 }}>
                  <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                    <span>{c.reason}{c.related_reference ? ` (${c.related_reference})` : ""}</span>
                    <span className={`badge ${c.status === "resolved" ? "VERIFIED" : c.status === "rejected" ? "RETURNED" : "ASSIGNED"}`}>{c.status}</span>
                  </div>
                  <div className="sub">Raised {new Date(c.created_at).toLocaleDateString()}</div>
                </div>
              ))}
            </div>
          )}
          <form onSubmit={handleRequestClarification} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Reason (required)</label>
              <input value={clarForm.reason} onChange={(e) => setClarForm((f) => ({ ...f, reason: e.target.value }))} />
            </div>
            <div className="field"><label>Related Drawing/Material</label>
              <input value={clarForm.relatedReference} onChange={(e) => setClarForm((f) => ({ ...f, relatedReference: e.target.value }))} />
            </div>
            <div className="field"><label>Proof/Photo</label>
              <input type="file" onChange={(e) => setClarForm((f) => ({ ...f, proofFile: e.target.files?.[0] || null }))} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={savingClar}>{savingClar ? "Sending…" : "Request Clarification"}</button>
          </form>

          <h3>Completion Handover</h3>
          {job.completed_at ? (
            <div className="sub">
              Submitted {new Date(job.completed_at).toLocaleDateString()} — qty {job.actual_completed_quantity}.{" "}
              {job.final_closed_at ? "Closed (Interior confirmed)." : job.interior_issue_raised ? "Interior raised an issue — reopened." : "Awaiting Interior confirmation."}
            </div>
          ) : (
            <form onSubmit={handleSubmitCompletion} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
              <div className="field"><label>Actual Completed Quantity</label>
                <input type="number" value={completionForm.quantity} onChange={(e) => setCompletionForm((f) => ({ ...f, quantity: e.target.value }))} />
              </div>
              <div className="field"><label>Completion Photos</label>
                <input type="file" multiple onChange={(e) => setCompletionForm((f) => ({ ...f, photoFiles: Array.from(e.target.files || []) }))} />
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}><label>Notes</label>
                <input value={completionForm.notes} onChange={(e) => setCompletionForm((f) => ({ ...f, notes: e.target.value }))} />
              </div>
              <button type="submit" className="btn btn-primary" disabled={savingCompletion}>{savingCompletion ? "Submitting…" : "Submit Completion"}</button>
              <div className="sub" style={{ gridColumn: "1 / -1" }}>Requires a Final QC Pass or Conditional Pass recorded above first (QC Stage = Final).</div>
            </form>
          )}
        </>
      )}
    </div>
  );
}

function ReworkRow({ rw, onClose }) {
  const [recheckResult, setRecheckResult] = useState(rw.recheck_result || "");
  const [correctiveAction, setCorrectiveAction] = useState(rw.corrective_action || "");
  const [afterPhotoFile, setAfterPhotoFile] = useState(null);
  return (
    <div className="card" style={{ marginBottom: 6 }}>
      <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700 }}>{rw.rework_number}</span>
        <span className={`badge ${rw.is_closed ? "VERIFIED" : "RETURNED"}`}>{rw.is_closed ? "Closed" : "Open"}</span>
        {rw.before_photos?.length > 0 && <span className="sub">📷 before: {rw.before_photos.length}</span>}
        {rw.after_photos?.length > 0 && <span className="sub">📷 after: {rw.after_photos.length}</span>}
      </div>
      <div className="sub">{rw.defect_details}</div>
      {rw.is_closed ? (
        <div className="sub">Recheck: {rw.recheck_result}{rw.corrective_action ? ` — ${rw.corrective_action}` : ""}</div>
      ) : (
        <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", marginTop: 6 }}>
          <div className="field"><label>Recheck Result</label><input value={recheckResult} onChange={(e) => setRecheckResult(e.target.value)} /></div>
          <div className="field"><label>Corrective Action</label><input value={correctiveAction} onChange={(e) => setCorrectiveAction(e.target.value)} /></div>
          <div className="field"><label>After Photo (required)</label><input type="file" accept="image/*" onChange={(e) => setAfterPhotoFile(e.target.files?.[0] || null)} /></div>
          <button type="button" className="btn btn-primary" onClick={() => onClose(rw.id, recheckResult, correctiveAction, afterPhotoFile)}>Close Rework</button>
        </div>
      )}
    </div>
  );
}
