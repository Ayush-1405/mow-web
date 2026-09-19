import React, { useCallback, useEffect, useState } from "react";
import AiStageAssistant from "./AiStageAssistant.jsx";
import { useSearchParams } from "react-router-dom";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import {
  listAllInhouseProductionRequests, updateInhouseProductionStatus, listInteriorPeople,
  listProductionStageUpdates, factoryUpdateStage, listFactoryQualityChecks, factoryRecordQualityCheck,
  listFactoryReworkRecords, factoryCloseRework,
  uploadFactoryAttachment, factorySubmitCompletion,
  listFactoryStagePhotos, factorySetClientAcknowledged, getAttachmentUrl,
} from "../../lib/interiorApi";
import { useIncludeTestData } from "../../lib/testDataVisibility";
import IncludeTestDataToggle from "../../components/IncludeTestDataToggle";
import { ViewDownloadButton } from "../interior/InteriorWorkingDrawings.jsx";

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
// Full real production_stage_updates.stage vocabulary (production_stage_updates_stage_check)
// -- kept here as the documented source of truth SIMPLE_STAGES maps onto below.
// "Final Assembly" and generic "QC" have no simplified button (Quality Check
// uses the dedicated factory_quality_checks system instead) -- their history,
// if any exists, is untouched and still queryable, just not surfaced in this
// simplified UI.
// Planning, Drawing Pending, Drawing Approved, Material Pending, Material Available,
// Cutting, Edge Banding, CNC, Carpentry/Assembly, Polishing/Painting, Hardware Fitting,
// Final Assembly, QC, Packing, Ready for Dispatch, Dispatched, Installed/Completed

// The simplified stage-button row shown on every Job Card. Each button maps
// onto the SAME real production_stage_updates rows (stage names constrained
// by production_stage_updates_stage_check — never renamed or migrated) —
// this is a presentation-layer simplification, not a new stage vocabulary.
// "Drawing"/"Material" fold two real stages into one button; the read-only
// second stage still shows inside that button's panel when it has data.
// "Factory Accepted" reflects the job's own status (not a stage row) and
// "Completed" is the job-level completion handover (not a stage row either)
// — both reuse the exact RPCs already used elsewhere in this app.
const SIMPLE_STAGES = [
  { key: "accepted", label: "Factory Accepted", kind: "accept" },
  { key: "Planning", label: "Planning", kind: "stage" },
  { key: "Drawing Pending", label: "Drawing", kind: "stage", altStage: "Drawing Approved" },
  { key: "Material Pending", label: "Material", kind: "stage", altStage: "Material Available" },
  { key: "Cutting", label: "Cutting", kind: "stage" },
  { key: "Edge Banding", label: "Edge Banding", kind: "stage" },
  { key: "CNC", label: "CNC", kind: "stage" },
  { key: "Carpentry/Assembly", label: "Carpentry/Assembly", kind: "stage" },
  { key: "Polishing/Painting", label: "Polishing/Painting", kind: "stage" },
  { key: "Hardware Fitting", label: "Hardware Fitting", kind: "stage" },
  { key: "qc", label: "Quality Check", kind: "qc" },
  { key: "Packing", label: "Packing", kind: "stage" },
  { key: "Ready for Dispatch", label: "Ready for Dispatch", kind: "stage" },
  { key: "Dispatched", label: "Dispatched", kind: "stage" },
  { key: "Installed/Completed", label: "Fitting/Installation", kind: "stage", fitting: true },
  { key: "completed", label: "Completed", kind: "complete" },
];

const STAGE_COLORS = { grey: "#9ca3af", blue: "#2563eb", orange: "#b45309", red: "#b91c1c", green: "#15803d" };

// Stage-specific extra fields (section 3) -- each rendered ONLY inside its
// own stage's panel, stored in production_stage_updates.stage_data (jsonb),
// never mixed with another stage's data since each stage keeps its own
// row (unique on job_id+stage). "person" fields use each employee's
// auth_id (the user_profiles(id) space) for consistency with assigned_to,
// even though stage_data itself has no FK to validate against.
const STAGE_FIELDS = {
  "Planning": [
    { key: "priority", label: "Priority", type: "select", options: ["Low", "Normal", "High", "Urgent"] },
    { key: "assignedSupervisor", label: "Assigned Supervisor", type: "person" },
    { key: "plannedQuantity", label: "Planned Quantity", type: "number" },
  ],
  "Drawing Pending": [
    { key: "drawingAssignedTo", label: "Drawing/Checking Assigned To", type: "person" },
    { key: "revisionNumber", label: "Drawing Revision Number", type: "text" },
    { key: "approvedBy", label: "Approved By", type: "person" },
    { key: "approvalDate", label: "Approval Date", type: "date" },
  ],
  "Material Pending": [
    { key: "materialName", label: "Material Name", type: "text" },
    { key: "requiredQuantity", label: "Required Quantity", type: "number" },
    { key: "availableQuantity", label: "Available Quantity", type: "number" },
    { key: "pendingQuantity", label: "Pending Quantity", type: "number" },
    { key: "materialStatus", label: "Material Status", type: "select", options: ["Pending", "Partially Available", "Available", "Issued"] },
    { key: "issuedBy", label: "Material Issued By", type: "person" },
    { key: "issueDate", label: "Material Issue Date", type: "date" },
  ],
  "Cutting": [
    { key: "plannedQuantity", label: "Planned Quantity", type: "number" },
    { key: "cutQuantity", label: "Cut Quantity", type: "number" },
    { key: "rejectedQuantity", label: "Rejected Quantity", type: "number" },
    { key: "pendingQuantity", label: "Pending Quantity", type: "number" },
    { key: "machine", label: "Machine", type: "text" },
    { key: "operator", label: "Operator", type: "person" },
  ],
  "Edge Banding": [
    { key: "receivedQuantity", label: "Received Quantity", type: "number" },
    { key: "completedQuantity", label: "Completed Quantity", type: "number" },
    { key: "rejectedQuantity", label: "Rejected Quantity", type: "number" },
    { key: "pendingQuantity", label: "Pending Quantity", type: "number" },
    { key: "machine", label: "Machine", type: "text" },
    { key: "operator", label: "Operator", type: "person" },
  ],
  "CNC": [
    { key: "programReference", label: "Program/Job Reference", type: "text" },
    { key: "machine", label: "Machine", type: "text" },
    { key: "operator", label: "Operator", type: "person" },
    { key: "inputQuantity", label: "Input Quantity", type: "number" },
    { key: "completedQuantity", label: "Completed Quantity", type: "number" },
    { key: "rejectedQuantity", label: "Rejected Quantity", type: "number" },
  ],
  "Carpentry/Assembly": [
    { key: "assignedTeam", label: "Assigned Team/Worker", type: "person" },
    { key: "receivedQuantity", label: "Received Quantity", type: "number" },
    { key: "assembledQuantity", label: "Assembled Quantity", type: "number" },
    { key: "pendingQuantity", label: "Pending Quantity", type: "number" },
    { key: "reworkQuantity", label: "Rework Quantity", type: "number" },
  ],
  "Polishing/Painting": [
    { key: "finishColour", label: "Finish/Colour", type: "text" },
    { key: "batchReference", label: "Batch/Reference Number", type: "text" },
    { key: "assignedWorker", label: "Assigned Worker", type: "person" },
    { key: "receivedQuantity", label: "Received Quantity", type: "number" },
    { key: "completedQuantity", label: "Completed Quantity", type: "number" },
    { key: "reworkQuantity", label: "Rework Quantity", type: "number" },
  ],
  "Hardware Fitting": [
    { key: "hardwareDetails", label: "Hardware Details", type: "text" },
    { key: "assignedWorker", label: "Assigned Worker", type: "person" },
    { key: "requiredQuantity", label: "Required Quantity", type: "number" },
    { key: "fittedQuantity", label: "Fitted Quantity", type: "number" },
    { key: "pendingQuantity", label: "Pending Quantity", type: "number" },
  ],
  "Packing": [
    { key: "packingQuantity", label: "Packing Quantity", type: "number" },
    { key: "packageCount", label: "Package Count", type: "number" },
    { key: "packingType", label: "Packing Type", type: "text" },
    { key: "packedBy", label: "Packed By", type: "person" },
    { key: "packingDate", label: "Packing Date", type: "date" },
  ],
  "Ready for Dispatch": [
    { key: "readyQuantity", label: "Ready Quantity", type: "number" },
    { key: "packageCount", label: "Package Count", type: "number" },
    { key: "checklist", label: "Dispatch Readiness Checklist", type: "textarea" },
    { key: "confirmedBy", label: "Confirmed By", type: "person" },
    { key: "readyDate", label: "Ready Date", type: "date" },
  ],
  "Dispatched": [
    { key: "dispatchQuantity", label: "Dispatch Quantity", type: "number" },
    { key: "dispatchDateTime", label: "Dispatch Date/Time", type: "date" },
    { key: "vehicleTransporter", label: "Vehicle/Transporter", type: "text" },
    { key: "challanNumber", label: "Challan/Reference Number", type: "text" },
    { key: "dispatchedBy", label: "Dispatched By", type: "person" },
  ],
  "Installed/Completed": [
    { key: "siteLocation", label: "Site Name/Location", type: "text" },
    { key: "fittingTeam", label: "Assigned Fitting Team", type: "person" },
  ],
};

function personName(people, id) {
  return people.find((p) => p.id === id)?.name || "—";
}
function personNameByAuthId(people, authId) {
  return people.find((p) => p.auth_id === authId)?.name || "—";
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
  const { includeTestData, canToggle, setIncludeTestData } = useIncludeTestData(profile);
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkJobId = searchParams.get("job");

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data, error: err }, peopleRes] = await Promise.all([listAllInhouseProductionRequests(includeTestData), listInteriorPeople()]);
    if (err) { setError(true); setLoading(false); return; }
    setRows(data || []);
    setPeople(peopleRes.data || []);
    setLoading(false);
  }, [includeTestData]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => subscribeTable("factory_job_orders_list", "inhouse_production_requests", null, load), [load]);

  // Deep-link support for the Factory Control Dashboard's "Open Job Card"
  // button (?job=<id>) — auto-expands the matching row once it has loaded,
  // scrolls it into view, then clears the param so it doesn't re-trigger on
  // a later unrelated re-render.
  useEffect(() => {
    if (!deepLinkJobId || rows.length === 0) return;
    if (!rows.some((r) => r.id === deepLinkJobId)) return;
    setExpandedId(deepLinkJobId);
    setSearchParams({}, { replace: true });
    requestAnimationFrame(() => {
      document.getElementById(`job-card-${deepLinkJobId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [deepLinkJobId, rows, setSearchParams]);

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
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">{t("allModulesLabel", lang)}</option>
            {INHOUSE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <IncludeTestDataToggle canToggle={canToggle} includeTestData={includeTestData} onChange={setIncludeTestData} />
        </div>
      </div>

      <div className="card">
        {filtered.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {filtered.map((r) => (
          <div key={r.id} id={`job-card-${r.id}`} style={{ borderBottom: "1px solid var(--border, #e5e7eb)", padding: "8px 0" }}>
            <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 6, cursor: "pointer" }}
              onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}>
              <span style={{ fontWeight: 700 }}>{r.job_order_number}</span>
              <span className="sub">{r.purchase_requests?.request_number} · {r.purchase_requests?.projects?.project_code} — {r.purchase_requests?.projects?.customer}</span>
              <span className="sub">{r.product_item}</span>
              <span className="sub">{personName(people, r.assigned_factory_coordinator)}</span>
              <span className="sub">{r.current_stage || "—"} ({r.completion_percentage ?? 0}%)</span>
              <span className="sub">Due {r.required_completion_date || "—"}</span>
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

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp"]);

function extOf(name) {
  if (!name) return "";
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

// Small thumbnail that lazy-loads a signed URL only for actual image files
// (PDFs/other types show a plain icon — no wasted signed-URL round trip).
function FileThumb({ storagePath, title }) {
  const [url, setUrl] = useState(null);
  const isImage = IMAGE_EXTS.has(extOf(storagePath));
  useEffect(() => {
    let cancelled = false;
    if (isImage) getAttachmentUrl(storagePath).then(({ url: u }) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [storagePath, isImage]);
  if (isImage && url) {
    return <img src={url} alt={title} style={{ width: 90, height: 90, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border, #e5e7eb)" }} />;
  }
  return (
    <div style={{ width: 90, height: 90, borderRadius: 8, border: "1px solid var(--border, #e5e7eb)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, background: "var(--surface-2, #fbf7f1)" }}>📄</div>
  );
}


function JobCardDetail({ job, factoryPeople, profile, onChanged }) {
  const [stageUpdates, setStageUpdates] = useState([]);
  const [qcChecks, setQcChecks] = useState([]);
  const [reworkRecords, setReworkRecords] = useState([]);
  const [stagePhotos, setStagePhotos] = useState([]);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [activeKey, setActiveKey] = useState(null);
  const [msg, setMsg] = useState("");

  const loadDetail = useCallback(async () => {
    setLoadingDetail(true);
    const [stageRes, qcRes, reworkRes, photoRes] = await Promise.all([
      listProductionStageUpdates(job.id), listFactoryQualityChecks(job.id), listFactoryReworkRecords(job.id),
      listFactoryStagePhotos(job.id),
    ]);
    setStageUpdates(stageRes.data || []);
    setQcChecks(qcRes.data || []);
    setReworkRecords(reworkRes.data || []);
    setStagePhotos(photoRes.data || []);
    setLoadingDetail(false);
  }, [job.id]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  useEffect(() => subscribeTable(`factory_job_${job.id}_stages`, "production_stage_updates", `job_id=eq.${job.id}`, loadDetail), [job.id, loadDetail]);
  useEffect(() => subscribeTable(`factory_job_${job.id}_qc`, "factory_quality_checks", `job_id=eq.${job.id}`, loadDetail), [job.id, loadDetail]);
  useEffect(() => subscribeTable(`factory_job_${job.id}_rework`, "factory_rework_records", `job_id=eq.${job.id}`, loadDetail), [job.id, loadDetail]);
  useEffect(() => subscribeTable(`factory_job_${job.id}_row`, "inhouse_production_requests", `id=eq.${job.id}`, onChanged), [job.id, onChanged]);

  const stageMap = {};
  stageUpdates.forEach((s) => { stageMap[s.stage] = s; });

  async function handleAcceptJob() {
    setMsg("");
    const { error } = await updateInhouseProductionStatus(job.project_id, job.id, { status: "Factory Accepted" });
    if (error) { setMsg(error.message); return; }
    onChanged();
  }

  // assignedTo must be a user_profiles.id (the FK production_stage_updates_
  // assigned_to_fkey actually points at) — StagePanel's dropdown already
  // supplies each employee's .auth_id, which IS that same id space. The RPC
  // itself also now safely resolves a profiles.id if one is ever passed
  // instead, and returns a friendly error rather than a raw FK violation if
  // neither resolves.
  async function handleStartStage(realStage, assignedTo, stageData) {
    setMsg("");
    const { error } = await factoryUpdateStage(job.id, realStage, "in_progress", { assignedTo: assignedTo || null, stageData });
    if (error) { setMsg(error.message); return; }
    loadDetail(); onChanged();
  }
  async function handleHoldStage(realStage, reason, assignedTo) {
    setMsg("");
    const { error } = await factoryUpdateStage(job.id, realStage, "on_hold", { delayReason: reason.trim(), assignedTo: assignedTo || null });
    if (error) { setMsg(error.message); return; }
    loadDetail(); onChanged();
  }
  async function handleMarkRework(realStage, reason, assignedTo) {
    setMsg("");
    const { error } = await factoryUpdateStage(job.id, realStage, "rework", { delayReason: reason.trim(), assignedTo: assignedTo || null });
    if (error) { setMsg(error.message); return; }
    loadDetail(); onChanged();
  }
  async function handleCompleteStage(realStage, assignedTo, stageData) {
    setMsg("");
    const { error } = await factoryUpdateStage(job.id, realStage, "completed", { assignedTo: assignedTo || null, stageData });
    if (error) { setMsg(error.message); return; }
    loadDetail(); onChanged();
  }
  async function handleAddNote(realStage, note) {
    setMsg("");
    const existing = stageMap[realStage];
    const { error } = await factoryUpdateStage(job.id, realStage, existing?.status || "pending", { notes: note.trim() });
    if (error) { setMsg(error.message); return; }
    loadDetail(); onChanged();
  }
  async function handleSaveStageDetails(realStage, assignedTo, stageData) {
    setMsg("");
    const existing = stageMap[realStage];
    const { error } = await factoryUpdateStage(job.id, realStage, existing?.status || "pending", { assignedTo: assignedTo || null, stageData });
    if (error) { setMsg(error.message); return; }
    loadDetail(); onChanged();
  }
  async function handleUploadStagePhoto(realStage, file) {
    setMsg("");
    const { error: uploadErr } = await uploadFactoryAttachment({
      projectId: job.project_id, module: "factory_stage", relatedRecordId: job.id,
      file, fileCategory: realStage, uploadedBy: profile?.id,
    });
    if (uploadErr) { setMsg(uploadErr.message); return; }
    loadDetail();
  }
  async function handleToggleClientAck(realStage, next) {
    setMsg("");
    const { error } = await factorySetClientAcknowledged(job.id, realStage, next);
    if (error) { setMsg(error.message); return; }
    loadDetail(); onChanged();
  }

  async function handleQcSave(form) {
    if (form.result === "fail" && !form.defectReason.trim()) { setMsg("A reason is required when QC result is Fail."); return { error: true }; }
    if (form.reworkRequired && !form.defectReason.trim()) { setMsg("A defect reason is required when rework is needed."); return { error: true }; }
    if (form.result === "fail" && !form.photoFile) { setMsg("At least one photo is required when QC result is Fail."); return { error: true }; }
    setMsg("");
    let photos = null;
    if (form.photoFile) {
      const { path, error: uploadErr } = await uploadFactoryAttachment({
        projectId: job.project_id, module: "factory_qc", relatedRecordId: job.id,
        file: form.photoFile, fileCategory: "QC Photo", uploadedBy: profile?.id,
      });
      if (uploadErr) { setMsg(uploadErr.message); return { error: uploadErr }; }
      photos = [path];
    }
    const { error } = await factoryRecordQualityCheck(job.id, form, form.result, {
      defectReason: form.defectReason || null, reworkRequired: form.reworkRequired,
      assignedReworkPerson: form.assignedReworkPerson || null, recheckDate: form.recheckDate || null,
      qcStage: form.qcStage, photos,
    });
    if (error) { setMsg(error.message); return { error }; }
    loadDetail(); onChanged();
    return { error: null };
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

  async function handleSubmitCompletion(quantity, notes, photoFiles) {
    if (!quantity || Number(quantity) <= 0) { setMsg("Actual completed quantity is required."); return; }
    setMsg("");
    const photoPaths = [];
    for (const file of photoFiles) {
      const { path, error: uploadErr } = await uploadFactoryAttachment({
        projectId: job.project_id, module: "factory_completion", relatedRecordId: job.id,
        file, fileCategory: "Completion Photo", uploadedBy: profile?.id,
      });
      if (uploadErr) { setMsg(uploadErr.message); return; }
      photoPaths.push(path);
    }
    const { error } = await factorySubmitCompletion(job.id, Number(quantity), photoPaths.length ? photoPaths : null, notes || null);
    if (error) { setMsg(error.message); return; }
    loadDetail();
    onChanged();
  }

  function colorFor(btn) {
    if (btn.kind === "accept") return ["Draft", "Submitted to Factory"].includes(job.status) ? "grey" : "green";
    if (btn.kind === "qc") {
      if (qcChecks.length === 0) return "grey";
      const latest = qcChecks[0];
      if (latest.result === "fail") return "red";
      if (latest.result === "conditional_pass") return "orange";
      return "green";
    }
    if (btn.kind === "complete") return job.completed_at ? "green" : "grey";
    const row = stageMap[btn.key] || (btn.altStage ? stageMap[btn.altStage] : null);
    const status = row?.status || "pending";
    if (status === "completed") return "green";
    if (status === "in_progress") return "blue";
    if (status === "on_hold") return "orange";
    if (status === "rework") return "red";
    return "grey";
  }

  const activeBtn = SIMPLE_STAGES.find((b) => b.key === activeKey);

  return (
    <div style={{ marginTop: 10, paddingLeft: 8, borderLeft: "3px solid var(--border, #e5e7eb)" }}>
      {msg && <div className="msg error" style={{ marginBottom: 8 }}>{msg}</div>}
      {loadingDetail ? <div className="skeleton-block" style={{ height: 80 }} /> : (
        <>
          <AiStageAssistant job={job} onApplied={() => { loadDetail(); onChanged(); }} />
          <div className="card" style={{ marginBottom: 10 }}>
            <h3 style={{ marginTop: 0 }}>Production Stage</h3>
            <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 6 }}>
              {SIMPLE_STAGES.map((btn) => {
                const color = colorFor(btn);
                const isActive = activeKey === btn.key;
                return (
                  <button
                    key={btn.key} type="button"
                    onClick={() => setActiveKey(isActive ? null : btn.key)}
                    style={{
                      flex: "0 0 auto", minHeight: 44, padding: "8px 14px", borderRadius: 999, whiteSpace: "nowrap",
                      border: `2px solid ${STAGE_COLORS[color]}`, background: isActive ? STAGE_COLORS[color] : "var(--surface, #fff)",
                      color: isActive ? "#fff" : STAGE_COLORS[color], fontWeight: 700, fontSize: 13, cursor: "pointer",
                    }}
                  >
                    {btn.label}
                  </button>
                );
              })}
            </div>
            <div className="task-meta" style={{ gap: 10, marginTop: 4, flexWrap: "wrap" }}>
              {[["grey", "Not Started"], ["blue", "In Progress"], ["orange", "On Hold"], ["red", "Rework/Rejected"], ["green", "Completed"]].map(([name, label]) => (
                <span key={name} className="sub" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: STAGE_COLORS[name], display: "inline-block" }} />
                  {label}
                </span>
              ))}
            </div>
          </div>

          {activeBtn && (
            <div className="card" style={{ marginBottom: 10 }}>
              {activeBtn.kind === "accept" && <AcceptPanel job={job} onAccept={handleAcceptJob} />}
              {activeBtn.kind === "qc" && (
                <QcPanel qcChecks={qcChecks} reworkRecords={reworkRecords} factoryPeople={factoryPeople} onSave={handleQcSave} onCloseRework={handleCloseRework} />
              )}
              {activeBtn.kind === "complete" && <CompletionPanel job={job} onSubmit={handleSubmitCompletion} />}
              {activeBtn.kind === "stage" && (
                <StagePanel
                  job={job} btn={activeBtn} row={stageMap[activeBtn.key]} altRow={activeBtn.altStage ? stageMap[activeBtn.altStage] : null}
                  photos={stagePhotos.filter((p) => p.file_category === activeBtn.key)} factoryPeople={factoryPeople}
                  onStart={(assignedTo, stageData) => handleStartStage(activeBtn.key, assignedTo, stageData)}
                  onHold={(reason, assignedTo) => handleHoldStage(activeBtn.key, reason, assignedTo)}
                  onRework={(reason, assignedTo) => handleMarkRework(activeBtn.key, reason, assignedTo)}
                  onComplete={(assignedTo, stageData) => handleCompleteStage(activeBtn.key, assignedTo, stageData)}
                  onAddNote={(note) => handleAddNote(activeBtn.key, note)}
                  onSaveDetails={(assignedTo, stageData) => handleSaveStageDetails(activeBtn.key, assignedTo, stageData)}
                  onUploadPhoto={(file) => handleUploadStagePhoto(activeBtn.key, file)}
                  onToggleClientAck={(next) => handleToggleClientAck(activeBtn.key, next)}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AcceptPanel({ job, onAccept }) {
  const [saving, setSaving] = useState(false);
  const accepted = !["Draft", "Submitted to Factory"].includes(job.status);
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Factory Accepted</h3>
      <div className="sub">Current status: <strong>{job.status}</strong></div>
      {!accepted ? (
        <button type="button" className="btn btn-primary" style={{ marginTop: 8 }} disabled={saving}
          onClick={async () => { setSaving(true); await onAccept(); setSaving(false); }}>
          {saving ? "Accepting…" : "Accept Job"}
        </button>
      ) : (
        <div className="msg info" style={{ marginTop: 8 }}>This job has already been accepted by Factory.</div>
      )}
    </div>
  );
}

function QcPanel({ qcChecks, reworkRecords, factoryPeople, onSave, onCloseRework }) {
  const emptyForm = { dimensions: false, material: false, finish: false, hardware: false, drawing: false, quantity: false, result: "pass", defectReason: "", reworkRequired: false, assignedReworkPerson: "", recheckDate: "", qcStage: "in_process", photoFile: null };
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    const res = await onSave(form);
    setSaving(false);
    if (!res?.error) setForm(emptyForm);
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Quality Check</h3>
      {qcChecks.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {qcChecks.map((qc) => (
            <div key={qc.id} className="sub" style={{ padding: "4px 0" }}>
              [{qc.qc_stage === "final" ? "Final" : "In-process"}] Checked {new Date(qc.created_at).toLocaleString()}: <strong>{qc.result}</strong>{qc.defect_reason ? ` — ${qc.defect_reason}` : ""}{qc.rework_required ? " — Rework required" : ""}
            </div>
          ))}
        </div>
      )}
      <form onSubmit={handleSubmit} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
        <div className="field"><label>QC Status</label>
          <select value={form.result} onChange={(e) => setForm((f) => ({ ...f, result: e.target.value }))}>
            <option value="pass">Pass</option><option value="conditional_pass">Conditional Pass</option><option value="fail">Fail</option>
          </select>
        </div>
        <div className="field"><label>QC Stage</label>
          <select value={form.qcStage} onChange={(e) => setForm((f) => ({ ...f, qcStage: e.target.value }))}>
            <option value="in_process">In-process</option><option value="final">Final</option>
          </select>
        </div>
        {[["dimensions", "Dimensions Check"], ["material", "Material Check"], ["finish", "Finish Check"], ["hardware", "Hardware Check"], ["drawing", "Drawing Match"], ["quantity", "Quantity Check"]].map(([k, label]) => (
          <label key={k} className="sub" style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.checked }))} /> {label}
          </label>
        ))}
        <div className="field"><label>QC Photo{form.result === "fail" ? " (required on Fail)" : ""}</label>
          <input type="file" accept="image/*" onChange={(e) => setForm((f) => ({ ...f, photoFile: e.target.files?.[0] || null }))} />
        </div>
        {form.result === "fail" && (
          <div className="field full"><label>Fail Reason (required)</label>
            <input value={form.defectReason} onChange={(e) => setForm((f) => ({ ...f, defectReason: e.target.value }))} />
          </div>
        )}
        <label className="sub" style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={form.reworkRequired} onChange={(e) => setForm((f) => ({ ...f, reworkRequired: e.target.checked }))} /> Rework Required
        </label>
        {form.reworkRequired && (
          <>
            {form.result !== "fail" && (
              <div className="field full"><label>Defect Reason (required)</label>
                <input value={form.defectReason} onChange={(e) => setForm((f) => ({ ...f, defectReason: e.target.value }))} />
              </div>
            )}
            <div className="field"><label>Assign Rework To</label>
              <select value={form.assignedReworkPerson} onChange={(e) => setForm((f) => ({ ...f, assignedReworkPerson: e.target.value }))}>
                <option value="">—</option>
                {factoryPeople.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="field"><label>Recheck Date</label><input type="date" value={form.recheckDate} onChange={(e) => setForm((f) => ({ ...f, recheckDate: e.target.value }))} /></div>
          </>
        )}
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Record QC"}</button>
      </form>

      {reworkRecords.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <h4>Rework</h4>
          {reworkRecords.map((rw) => <ReworkRow key={rw.id} rw={rw} onClose={onCloseRework} />)}
        </div>
      )}
    </div>
  );
}

function CompletionPanel({ job, onSubmit }) {
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [photoFiles, setPhotoFiles] = useState([]);
  const [saving, setSaving] = useState(false);

  if (job.completed_at) {
    return (
      <div>
        <h3 style={{ marginTop: 0 }}>Completed</h3>
        <div className="sub">
          Submitted {new Date(job.completed_at).toLocaleString()} — qty {job.actual_completed_quantity}.{" "}
          {job.final_closed_at ? "Closed (Interior confirmed)." : job.interior_issue_raised ? "Interior raised an issue — reopened." : "Awaiting Interior confirmation."}
        </div>
      </div>
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    await onSubmit(quantity, notes, photoFiles);
    setSaving(false);
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Completed</h3>
      <form onSubmit={handleSubmit} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
        <div className="field"><label>Actual Completed Quantity</label><input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></div>
        <div className="field"><label>Completion Photos</label><input type="file" multiple onChange={(e) => setPhotoFiles(Array.from(e.target.files || []))} /></div>
        <div className="field full"><label>Notes</label><input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Submitting…" : "Complete Stage"}</button>
        <div className="sub full">Requires a Final QC Pass or Conditional Pass recorded first.</div>
      </form>
    </div>
  );
}

// One stage-specific field, rendered from STAGE_FIELDS[stage] -- "person"
// fields use each employee's auth_id (the same id space assigned_to needs),
// everything else is a plain controlled input scoped to this one stage's
// own stage_data object.
function StageDataField({ field, value, onChange, factoryPeople }) {
  if (field.type === "select") {
    return (
      <div className="field"><label>{field.label}</label>
        <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }
  if (field.type === "person") {
    return (
      <div className="field"><label>{field.label}</label>
        <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {factoryPeople.filter((p) => p.auth_id).map((p) => <option key={p.auth_id} value={p.auth_id}>{p.name}</option>)}
        </select>
      </div>
    );
  }
  if (field.type === "textarea") {
    return <div className="field full"><label>{field.label}</label><textarea rows={2} value={value ?? ""} onChange={(e) => onChange(e.target.value)} /></div>;
  }
  return (
    <div className="field"><label>{field.label}</label>
      <input type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// Generic per-stage panel — shared by every real production stage. The
// common summary/actions (section 2) are the same everywhere; the extra
// fields below them come entirely from STAGE_FIELDS[btn.key] (section 3),
// so no stage ever renders a field that belongs to a different stage, and
// the old always-shown Quantity Completed/Pending pair is gone in favour of
// each stage's own appropriately-named quantity fields.
function StagePanel({ job, btn, row, altRow, photos, factoryPeople, onStart, onHold, onRework, onComplete, onAddNote, onSaveDetails, onUploadPhoto, onToggleClientAck }) {
  const defaultAssignee = factoryPeople.find((p) => p.id === job.assigned_factory_coordinator)?.auth_id || "";
  const [note, setNote] = useState("");
  const [assignedTo, setAssignedTo] = useState(row?.assigned_to || defaultAssignee);
  const [stageData, setStageData] = useState(row?.stage_data || {});
  const [busy, setBusy] = useState(false);
  const status = row?.status || "pending";
  const fields = STAGE_FIELDS[btn.key] || [];

  async function run(fn) {
    setBusy(true);
    await fn();
    setBusy(false);
  }
  function setFieldValue(key, value) {
    setStageData((d) => ({ ...d, [key]: value }));
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>{btn.label}</h3>
      <div className="dept-meta-grid" style={{ marginBottom: 10 }}>
        <div className="card dept-meta-tile"><div className="label">Status</div><div className="value" style={{ fontSize: 16 }}>{status}</div></div>
        <div className="card dept-meta-tile"><div className="label">Assigned Employee</div><div className="value" style={{ fontSize: 13 }}>{personNameByAuthId(factoryPeople, row?.assigned_to)}</div></div>
        <div className="card dept-meta-tile"><div className="label">Started</div><div className="value" style={{ fontSize: 12 }}>{row?.actual_start ? new Date(row.actual_start).toLocaleString() : "—"}</div></div>
        <div className="card dept-meta-tile"><div className="label">Completed</div><div className="value" style={{ fontSize: 12 }}>{row?.actual_end ? new Date(row.actual_end).toLocaleString() : "—"}</div></div>
        <div className="card dept-meta-tile"><div className="label">Last Updated By</div><div className="value" style={{ fontSize: 13 }}>{row?.updated_at ? new Date(row.updated_at).toLocaleDateString() : "—"}</div></div>
      </div>

      {btn.fitting && (
        <div className="card" style={{ marginBottom: 10 }}>
          <h4 style={{ marginTop: 0 }}>Fitting Details</h4>
          <div className="task-meta" style={{ flexWrap: "wrap" }}>
            <span className="sub">Site/Project: <strong>{job.purchase_requests?.projects?.project_code} — {job.purchase_requests?.projects?.customer}</strong></span>
            <span className="sub">Scheduled: {row?.planned_start || "—"}</span>
            <span className="sub">Pending work: {stageData.pendingWork ?? "—"}</span>
          </div>
          <label className="sub" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
            <input type="checkbox" checked={!!row?.client_acknowledged} disabled={!row || busy} onChange={(e) => run(() => onToggleClientAck(e.target.checked))} />
            Client Acknowledgement
            {row?.client_acknowledged_at && <span> — {new Date(row.client_acknowledged_at).toLocaleString()}</span>}
          </label>
        </div>
      )}

      {altRow && (
        <div className="sub" style={{ marginBottom: 8 }}>Also tracked: {altRow.stage} — {altRow.status}{altRow.notes ? ` — ${altRow.notes}` : ""}</div>
      )}

      <div className="task-meta" style={{ flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        <button type="button" className="btn btn-outline" disabled={busy || status === "completed"} onClick={() => run(() => onStart(assignedTo, stageData))}>Start Stage</button>
        <button type="button" className="btn btn-outline" disabled={busy}
          onClick={() => { const r = window.prompt("Reason for putting this stage on hold:"); if (r?.trim()) run(() => onHold(r, assignedTo)); }}>Put On Hold</button>
        <button type="button" className="btn btn-outline" disabled={busy}
          onClick={() => { const r = window.prompt("Reason for marking this stage as rework:"); if (r?.trim()) run(() => onRework(r, assignedTo)); }}>Mark Rework</button>
        <label className="btn btn-outline" style={{ cursor: "pointer" }}>
          {btn.fitting ? "Upload Before/After Photo" : "Upload Proof/Photo"}
          <input type="file" accept="image/*,.pdf" style={{ display: "none" }} disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) run(() => onUploadPhoto(f)); e.target.value = ""; }} />
        </label>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(() => onComplete(assignedTo, stageData))}>Complete Stage</button>
      </div>

      <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
        <div className="field"><label>Assigned Employee</label>
          <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
            <option value="">— Unassigned —</option>
            {factoryPeople.filter((p) => p.auth_id).map((p) => <option key={p.auth_id} value={p.auth_id}>{p.name}</option>)}
          </select>
        </div>
        {fields.map((field) => (
          <StageDataField key={field.key} field={field} value={stageData[field.key]} onChange={(v) => setFieldValue(field.key, v)} factoryPeople={factoryPeople} />
        ))}
        <button type="button" className="btn btn-outline" disabled={busy} onClick={() => run(() => onSaveDetails(assignedTo, stageData))}>Save Details</button>
      </div>

      <div className="field full" style={{ marginTop: 8 }}>
        <label>Add Note</label>
        <div className="task-meta">
          <input value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={busy || !note.trim()}
            onClick={() => run(async () => { await onAddNote(note); setNote(""); })}>Save Note</button>
        </div>
        {row?.notes && <div className="sub" style={{ marginTop: 4 }}>Current note: {row.notes}</div>}
        {row?.delay_reason && <div className="sub" style={{ marginTop: 2, color: "#b45309" }}>Reason: {row.delay_reason}</div>}
      </div>

      {photos.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="sub" style={{ fontWeight: 700, marginBottom: 4 }}>Photo/Proof Gallery</div>
          <div style={{ display: "flex", gap: 8, overflowX: "auto" }}>
            {photos.map((p) => (
              <div key={p.id} style={{ flex: "0 0 auto" }}>
                <FileThumb storagePath={p.storage_path} title={p.original_file_name} />
                <ViewDownloadButton lang="en" storagePath={p.storage_path} fileName={p.original_file_name} />
              </div>
            ))}
          </div>
        </div>
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
