import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import { t } from "../../lib/i18n";
import { formatCurrency } from "../../lib/retailModules";
import { loadMasterReport, reconcileMasterReportCounts, getAttachmentUrl, computeDesignChangeCounts } from "../../lib/interiorApi";
import InteriorAllFiles from "./InteriorAllFiles.jsx";
import InteriorActivityHistory from "./InteriorActivityHistory.jsx";
import { AREA_TYPES } from "./InteriorMaterialSelection.jsx";

// Shared by every section that lists an `attachments` row — opens a fresh
// signed URL on demand (never pre-fetched/cached, since these expire).
async function openAttachment(storagePath, onError) {
  const { url, error } = await getAttachmentUrl(storagePath);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
  else onError?.(error);
}

// Same authoritative stage list every other Interior screen uses.
const STAGES = [
  "Quotation", "Design", "Client Approval", "Design Freeze",
  "Execution Planning", "Purchase/Production", "Execution",
  "QC", "Snagging", "Handover", "Completed",
];

const STATUS_BADGE = { complete: "VERIFIED", partial: "ASSIGNED", pending_approval: "ACCEPTED", not_started: "CLOSED" };
const STATUS_LABEL_KEY = { complete: "completeStatusLabel", partial: "partialStatusLabel", pending_approval: "pendingApprovalStatusLabel", not_started: "notStartedLabel" };

// Same mapping InteriorMaterialSelection.jsx uses for its own status badges.
const MS_STATUS_BADGE = {
  "Draft": "CLOSED", "Selection Pending": "ASSIGNED", "Client Review Pending": "ASSIGNED",
  "Submitted to Client": "ACCEPTED", "Approved": "VERIFIED", "Final Selection Locked": "VERIFIED",
  "Rejected": "RETURNED", "Revision Required": "REVISION", "Replaced": "CLOSED",
};

const HANDOVER_FLAGS = [
  ["qc_complete", "qcCompleteLabel"],
  ["cleaning_complete", "cleaningCompleteLabel"],
  ["snags_complete", "snagsCompleteLabel"],
  ["hardware_complete", "hardwareCompleteLabel"],
  ["customer_inspection", "customerInspectionLabel"],
  ["warranty_documents", "warrantyDocumentsLabel"],
  ["handover_complete", "handoverCompleteLabel"],
];

function StatusBadge({ status, lang }) {
  return <span className={`badge ${STATUS_BADGE[status]}`}>{t(STATUS_LABEL_KEY[status], lang)}</span>;
}

function NotTracked({ lang }) {
  return <span className="sub" style={{ fontStyle: "italic" }}>{t("notTrackedLabel", lang)}</span>;
}

function EmptySection({ lang }) {
  return <div className="msg info">{t("noDataEnteredLabel", lang)}</div>;
}

// Report is read-only by design (spec: "viewing does not grant edit
// access") — every section here only ever reads report.* arrays already
// loaded once by loadMasterReport(); actual edits happen on the existing
// interactive tabs (Project Detail page), linked from the header.
export default function InteriorMasterReport({ lang, staffProfile }) {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const interiorProfile = useInteriorProfile();
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState(null);
  const [generatedAt, setGeneratedAt] = useState(null);
  const [zipBusy, setZipBusy] = useState(false);
  const [zipProgress, setZipProgress] = useState("");
  const [zipMsg, setZipMsg] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const [reconciliation, setReconciliation] = useState(null);
  const [showReconciliation, setShowReconciliation] = useState(false);
  const [staffUsersById, setStaffUsersById] = useState({});

  const isElevated = !!staffProfile?.isManagement || !!staffProfile?.isSuperAdmin || !!staffProfile?.isDeptHead;
  // Mirrors interior_is_org_wide() client-side, only to skip a request
  // (the materials catalog) known in advance to 403 for anyone else — RLS
  // is still the real enforcement regardless of this value.
  const isOrgWide = isElevated || ["head", "director", "purchase", "crm"].includes(interiorProfile?.role);

  const load = useCallback(async () => {
    setLoading(true);
    const [data, staffUsersRes] = await Promise.all([
      loadMasterReport(projectId, isOrgWide),
      // interior_pilot_audit_log.performed_by AND interior_payment_records.created_by
      // (its DB default is auth.uid()) are staff-pilot login ids, not Interior
      // profiles.id — resolved via the same RPC InteriorActivityHistory.jsx
      // already uses for exactly this reason, not the Interior `people` list.
      supabase.rpc("staff_list_assignable_users_all"),
    ]);
    setReport(data);
    setStaffUsersById(Object.fromEntries((staffUsersRes.data || []).map((u) => [u.id, u.full_name])));
    setGeneratedAt(new Date());
    setLoading(false);
  }, [projectId, isOrgWide]);

  useEffect(() => { load(); }, [load]);

  const personName = useCallback((id) => report?.people.find((p) => p.id === id)?.name || "—", [report]);
  const staffUserName = useCallback((id) => (id ? staffUsersById[id] || "—" : "—"), [staffUsersById]);

  const today = new Date().toISOString().slice(0, 10);

  const kpis = useMemo(() => {
    if (!report?.project) return null;
    const p = report.project;
    const stageIndex = STAGES.indexOf(p.stage);
    const progressPct = stageIndex >= 0 ? Math.round(((stageIndex + 1) / STAGES.length) * 100) : 0;
    const totalTasks = report.tasks.length;
    const completedTasks = report.tasks.filter((x) => x.status === "COMPLETED").length;
    const overdueTasks = report.tasks.filter((x) => x.status !== "COMPLETED" && x.due_date && x.due_date < today).length;
    const pendingDesignApprovals = report.designVersions.filter((v) => v.is_current && ["Submitted for Internal Review", "Submitted to Client", "Resubmitted"].includes(v.approval_status)).length;
    const pmPendingApprovals = report.purchaseRequests.filter((r) => ["Approval Pending", "Vendor Comparison", "PO/WO Pending"].includes(r.status)).length;
    const pendingApprovals = report.changes.filter((c) => c.approval_status === "PENDING").length + pendingDesignApprovals + pmPendingApprovals;
    const pmTotal = report.purchaseRequests.length;
    const pmInHouse = report.purchaseRequests.filter((r) => r.purchase_source === "in_house").length;
    const pmOutsourced = report.purchaseRequests.filter((r) => r.purchase_source === "outsourced").length;
    const pmPendingFactory = report.purchaseRequests.filter((r) => r.purchase_source === "in_house" && r.status === "Draft").length;
    const pmPoIssued = report.purchaseOrders.filter((o) => o.is_current).length;
    const pmDelivered = report.purchaseRequests.filter((r) => r.status === "Delivered" || r.status === "Completed").length;
    const pmCompleted = report.purchaseRequests.filter((r) => r.status === "Completed").length;
    const pmQcFailures = report.purchaseReceipts.filter((rc) => rc.qc_status === "Failed").length;
    const pmReplacementPending = report.purchaseReceipts.filter((rc) => rc.replacement_required).length;
    const pmApprovedValue = report.purchaseOrders.filter((o) => o.is_current).reduce((s, o) => s + Number(o.total_order_value || 0), 0);
    const pmEstimatedCost = report.purchaseCosting.reduce((s, c) => s + Number(c.total_estimated_cost || 0), 0);
    const pmActualCost = report.purchaseCosting.reduce((s, c) => s + Number(c.total_actual_cost || 0), 0);
    const pmChecklistDone = report.purchaseChecklistItems.length && pmTotal
      ? Math.round((report.purchaseChecklistResults.filter((r) => r.status === "Completed" || r.status === "Not Applicable").length / (report.purchaseChecklistItems.length * pmTotal)) * 100)
      : 0;
    const wdAreasTotal = report.workingDrawingAreas.length;
    const wdAreasIssued = report.workingDrawingAreas.filter((a) => a.current_stage === "Issued for Execution").length;
    const wdChecklistDone = report.checklistItems.length && wdAreasTotal
      ? Math.round((report.checklistResults.filter((r) => r.status === "Completed" || r.status === "Not Applicable").length / (report.checklistItems.length * wdAreasTotal)) * 100)
      : 0;
    const materialsPending = report.materialsRequirements.filter((m) => m.status && !["Received", "Not Required"].includes(m.status)).length;
    const purchasePending = report.materialsPurchase.filter((m) => m.status && !["Received", "Not Required"].includes(m.status)).length;
    const openComplaints = report.requests.filter((r) => r.status !== "CLOSED").length;
    const totalFiles = report.attachments.length + report.materialSelectionAttachments.length + report.workingDrawingAttachments.length + report.purchaseAttachments.length;
    const received = report.payments.filter((pay) => pay.status === "RECEIVED").reduce((s, pay) => s + Number(pay.amount || 0), 0);
    const pendingFromValue = p.project_value != null ? Math.max(Number(p.project_value) - received, 0) : null;
    const daysRemaining = p.due_date && p.stage !== "Completed" ? Math.ceil((new Date(p.due_date) - new Date(today)) / 86400000) : null;
    const daysOverdue = p.due_date && p.due_date < today && p.stage !== "Completed" ? Math.ceil((new Date(today) - new Date(p.due_date)) / 86400000) : 0;
    const lastDailyUpdate = report.siteReports.reduce((max, r) => (!max || r.report_date > max ? r.report_date : max), null);
    const openMajorSnag = report.snags.some((s) => s.major && s.status !== "COMPLETED");
    const msTotal = report.materialSelections.length;
    const msApproved = report.materialSelections.filter((m) => m.approval_status === "Approved" || m.approval_status === "Final Selection Locked").length;
    const msPending = report.materialSelections.filter((m) => ["Selection Pending", "Submitted to Client", "Client Review Pending"].includes(m.approval_status)).length;
    const msRejected = report.materialSelections.filter((m) => m.approval_status === "Rejected" || m.approval_status === "Revision Required").length;
    const msFinal = report.materialSelections.filter((m) => m.is_final).length;
    return {
      progressPct, totalTasks, completedTasks, pendingTasks: totalTasks - completedTasks, overdueTasks,
      pendingApprovals, materialsPending, purchasePending, openComplaints, totalFiles,
      received, pendingFromValue, daysRemaining, daysOverdue, lastDailyUpdate, openMajorSnag,
      msTotal, msApproved, msPending, msRejected, msFinal,
      wdAreasTotal, wdAreasIssued, wdChecklistDone,
      pmTotal, pmInHouse, pmOutsourced, pmPendingFactory, pmPoIssued, pmDelivered, pmCompleted,
      pmQcFailures, pmReplacementPending, pmApprovedValue, pmEstimatedCost, pmActualCost, pmChecklistDone,
    };
  }, [report, today]);

  const warnings = useMemo(() => {
    if (!report?.project || !kpis) return [];
    const w = [];
    if (kpis.daysOverdue > 0) w.push("warningOverdue");
    if (kpis.pendingApprovals > 0) w.push("warningPendingApproval");
    if (kpis.pendingFromValue > 0) w.push("warningPendingPayment");
    if (kpis.openComplaints > 0) w.push("warningOpenComplaint");
    if (kpis.openMajorSnag) w.push("warningOpenMajorSnag");
    if (kpis.msPending > 0) w.push("warningPendingMaterialSelection");
    if (kpis.pmQcFailures > 0) w.push("warningQcFailure");
    return w;
  }, [report, kpis]);

  // Room-wise progress + missing rooms — computed against the ACTIVE
  // (non-REPLACED) selections only, since a REPLACED row is superseded by
  // its own successor and shouldn't count twice for "is this room done".
  // "Missing" is checked against the same fixed AREA_TYPES catalogue the
  // Material Selection form itself offers, not an invented scope-of-work
  // list this system has no table for.
  const roomProgress = useMemo(() => {
    if (!report) return { rooms: [], missing: [] };
    const active = report.materialSelections.filter((m) => m.status !== "REPLACED");
    const byRoom = {};
    active.forEach((m) => {
      const key = m.area_name || (m.area_type === "Other" ? m.custom_area_type : m.area_type) || "—";
      byRoom[key] = byRoom[key] || { total: 0, done: 0, areaType: m.area_type };
      byRoom[key].total += 1;
      if (m.is_final || m.approval_status === "Approved" || m.approval_status === "Final Selection Locked") byRoom[key].done += 1;
    });
    const rooms = Object.entries(byRoom).map(([name, v]) => ({ name, ...v, pct: v.total ? Math.round((v.done / v.total) * 100) : 0 }));
    const coveredAreaTypes = new Set(active.map((m) => m.area_type));
    const missing = AREA_TYPES.filter(([en]) => en !== "Other" && !coveredAreaTypes.has(en));
    return { rooms, missing };
  }, [report]);

  // Full revision chain per material — only the LATEST (non-superseded)
  // row of each chain is shown as the primary entry; its full history
  // (every prior revision, never deleted) nests underneath it, so a
  // replaced material isn't ALSO shown a second time as its own top-level
  // row.
  const msChains = useMemo(() => {
    if (!report) return [];
    const all = report.materialSelections;
    const referenced = new Set(all.map((m) => m.previous_selection_id).filter(Boolean));
    const heads = all.filter((m) => !referenced.has(m.id));
    return heads.map((head) => {
      const history = [];
      let cur = head;
      while (cur) {
        history.unshift(cur);
        cur = cur.previous_selection_id ? all.find((m) => m.id === cur.previous_selection_id) : null;
      }
      return { head, history };
    });
  }, [report]);

  // Per room/area rollup for the consolidated Working Drawings section —
  // one row per working_drawing_areas record, joining its current design
  // version, latest approval, active lock, drawings, checklist %, and
  // final-issue status. Design-version chain (current + full history) is
  // walked the same backward-link way msChains walks material selections.
  const wdAreaSummary = useMemo(() => {
    if (!report) return [];
    return report.workingDrawingAreas.map((area) => {
      const versions = report.designVersions.filter((v) => v.area_id === area.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const current = versions.find((v) => v.is_current) || null;
      const changeRequests = report.designChangeRequests.filter((c) => c.area_id === area.id);
      const approvals = report.designApprovals.filter((a) => a.area_id === area.id);
      const lock = report.designLocks.find((l) => l.area_id === area.id) || null;
      const drawings = report.workingDrawings.filter((d) => d.area_id === area.id);
      const drawingIds = new Set(drawings.map((d) => d.id));
      const drawingVersionsForArea = report.drawingVersions.filter((v) => drawingIds.has(v.drawing_id));
      const items = report.checklistItems;
      const results = report.checklistResults.filter((r) => r.area_id === area.id);
      const checklistPct = items.length ? Math.round((results.filter((r) => r.status === "Completed" || r.status === "Not Applicable").length / items.length) * 100) : 0;
      const issues = report.drawingIssues.filter((i) => i.area_id === area.id);
      const areaMaterials = report.materialSelections.filter((m) => m.area_id === area.id || m.area_name === area.area_name);
      const materialsApproved = areaMaterials.length > 0 && areaMaterials.every((m) => ["Approved", "Approved with Conditions", "Final Selection Locked"].includes(m.approval_status));
      return {
        area, current, versions, changeRequests, changeCounts: computeDesignChangeCounts(changeRequests),
        approvals, lock, drawings, drawingVersionsForArea, checklistPct, issues, areaMaterials, materialsApproved,
      };
    });
  }, [report]);

  // Not-Started is the only automatic "empty" state — the schema has no way
  // to mark a function Not Applicable, so that state is never inferred here.
  const completeness = useMemo(() => {
    if (!report) return [];
    const has = (arr) => arr && arr.length > 0;
    const hasFile = (arr) => arr.some((a) => a.storage_path);
    const items = [
      { key: "quotation", labelKey: "tabQuotation", status: !has(report.attachments.filter((a) => a.stage === "Quotation")) ? "not_started" : hasFile(report.attachments.filter((a) => a.stage === "Quotation")) ? "complete" : "partial" },
      { key: "projectTimeline", labelKey: "tabProjectTimeline", status: (() => {
        const hasDealClosure = report.project.location || report.project.next_action;
        const hasTimeline = report.project.start_date && report.project.next_action;
        if (hasDealClosure && hasTimeline) return "complete";
        if (hasDealClosure || report.project.start_date || report.project.next_action) return "partial";
        return "not_started";
      })() },
      { key: "workingDrawings", labelKey: "tabWorkingDrawings", status: (() => {
        // Simplified page: presence of any uploaded working-drawing file is
        // "complete" — a plain file register has no partial/pending-approval
        // state of its own. Falls back to the older room/version workflow's
        // richer status only for historical projects that still have that data.
        const hasFiles = has(report.attachments.filter((a) => a.stage === "Working Drawings" || a.stage === "Drawings")) || has(report.workingDrawingAttachments);
        if (hasFiles) return "complete";
        if (!has(report.workingDrawingAreas) && !has(report.materialSelections)) return "not_started";
        const pendingDesign = report.designVersions.some((v) => v.is_current && ["Submitted for Internal Review", "Submitted to Client", "Resubmitted"].includes(v.approval_status));
        const pendingMaterial = report.materialSelections.some((m) => ["Selection Pending", "Submitted to Client", "Client Review Pending"].includes(m.approval_status));
        if (pendingDesign || pendingMaterial) return "pending_approval";
        const issued = report.workingDrawingAreas.length > 0 && report.workingDrawingAreas.every((a) => a.current_stage === "Issued for Execution");
        return issued ? "complete" : "partial";
      })() },
      { key: "purchaseManagement", labelKey: "tabPurchaseManagement", status: (() => {
        if (!has(report.purchaseRequests)) return "not_started";
        const pending = report.purchaseRequests.some((r) => ["Approval Pending", "Vendor Comparison", "PO/WO Pending"].includes(r.status));
        if (pending) return "pending_approval";
        const done = report.purchaseRequests.every((r) => r.status === "Completed");
        return done ? "complete" : "partial";
      })() },
      { key: "siteExecution", labelKey: "tabSiteExecution", status: has(report.snags) ? "complete" : "not_started" },
      { key: "dailyUpdates", labelKey: "tabDailyUpdates", status: has(report.siteReports) ? "complete" : "not_started" },
      { key: "materials", labelKey: "tabMaterials", status: has(report.materialsRequirements) ? "complete" : "not_started" },
      { key: "purchase", labelKey: "tabPurchase", status: has(report.materialsPurchase) ? "complete" : "not_started" },
      { key: "clientComm", labelKey: "tabClientComm", status: has(report.activity) ? "complete" : "not_started" },
      { key: "payments", labelKey: "tabPayments", status: has(report.payments) ? "complete" : "not_started" },
      { key: "completion", labelKey: "tabCompletion", status: report.handover?.handover_complete ? "complete" : Object.values(report.handover || {}).some((v) => v === true) ? "partial" : "not_started" },
    ];
    return items;
  }, [report]);

  const completenessPct = useMemo(() => {
    if (completeness.length === 0) return 0;
    const score = completeness.reduce((s, i) => s + (i.status === "complete" ? 1 : i.status === "partial" ? 0.5 : 0), 0);
    return Math.round((score / completeness.length) * 100);
  }, [completeness]);

  async function handlePrint() {
    window.print();
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2500);
    } catch { /* clipboard unavailable — silently ignore, nothing to report to the user beyond not toggling the confirmation */ }
  }

  async function handleExportExcel() {
    if (!report) return;
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    const addSheet = (name, rows) => {
      const ws = XLSX.utils.json_to_sheet(rows && rows.length ? rows : [{}]);
      XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
    };
    addSheet("Quotation", report.attachments.filter((a) => a.stage === "Quotation"));
    addSheet("WD Areas", report.workingDrawingAreas);
    addSheet("Design Briefs", report.designBriefs);
    addSheet("Design Versions", report.designVersions);
    addSheet("Design Change Requests", report.designChangeRequests);
    addSheet("Design Approvals", report.designApprovals);
    addSheet("Design Locks", report.designLocks);
    addSheet("Working Drawings", report.workingDrawings);
    addSheet("Working Drawing Files", [
      ...report.attachments.filter((a) => a.stage === "Working Drawings" || a.stage === "Drawings"),
      ...report.workingDrawingAttachments,
    ]);
    addSheet("Drawing Versions", report.drawingVersions);
    addSheet("Drawing Checklist Results", report.checklistResults);
    addSheet("Drawing Issues", report.drawingIssues);
    addSheet("Purchase Requests", report.purchaseRequests);
    addSheet("Purchase Request Items", report.purchaseRequestItems);
    addSheet("In-house Production", report.inhouseProductionRequests);
    addSheet("Outsource Requirements", report.outsourceRequirements);
    addSheet("Vendor Quotations", isElevated ? report.vendorQuotations : []);
    addSheet("Vendor Selections", isElevated ? report.purchaseVendorSelections : []);
    addSheet("Purchase Approvals", isElevated ? report.purchaseApprovals : []);
    addSheet("Purchase Orders", report.purchaseOrders);
    addSheet("Purchase Costing", isElevated ? report.purchaseCosting : []);
    addSheet("Vendor Follow-ups", report.vendorFollowups);
    addSheet("GRN-QC", report.purchaseReceipts);
    addSheet("Payment Coordination", report.purchasePaymentCoordination);
    addSheet("Material Selection", report.materialSelections);
    addSheet("Legacy Design-Drawings", report.attachments.filter((a) => a.stage === "Design" || a.stage === "Drawings"));
    addSheet("Legacy Change Requests", report.changes);
    addSheet("Site Execution", report.snags);
    addSheet("Daily Updates", report.siteReports);
    addSheet("Material Requirements", report.materialsRequirements);
    addSheet("Purchase-Sourced Materials", report.materialsPurchase);
    addSheet("Client Communication", report.activity);
    addSheet("Payments", report.payments);
    addSheet("Tasks", report.tasks);
    addSheet("Requests-Complaints", report.requests);
    addSheet("All Files", report.attachments);
    addSheet("Activity History", report.auditLog);
    XLSX.writeFile(wb, `${report.project.project_code}-master-report.xlsx`);
  }

  async function handleDownloadAllFiles() {
    if (!report) return;
    setZipMsg("");
    const files = [
      ...report.attachments.filter((a) => a.storage_path).map((a) => ({ storage_path: a.storage_path, name: a.file_name || a.title, folder: a.stage || "Other" })),
      ...report.materialSelectionAttachments.filter((a) => a.storage_path).map((a) => ({ storage_path: a.storage_path, name: a.original_file_name || a.file_name, folder: "Material Selection" })),
      ...report.workingDrawingAttachments.filter((a) => a.storage_path).map((a) => ({ storage_path: a.storage_path, name: a.original_file_name || a.file_name, folder: `Working Drawings/${a.module || "Other"}` })),
      ...report.purchaseAttachments.filter((a) => a.storage_path).map((a) => ({ storage_path: a.storage_path, name: a.original_file_name || a.file_name, folder: `Purchase Management/${a.module || "Other"}` })),
    ];
    if (files.length === 0) { setZipMsg(t("noFilesToDownloadMsg", lang)); return; }
    setZipBusy(true);
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setZipProgress(`${i + 1} / ${files.length}`);
        const { url } = await getAttachmentUrl(f.storage_path);
        if (!url) continue;
        const blob = await (await fetch(url)).blob();
        zip.folder(f.folder).file(f.name || `file-${i}`, blob);
      }
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(zipBlob);
      link.download = `${report.project.project_code}-files.zip`;
      link.click();
      URL.revokeObjectURL(link.href);
    } finally {
      setZipBusy(false);
      setZipProgress("");
    }
  }

  async function handleReconcile() {
    setShowReconciliation((s) => !s);
    if (!reconciliation) {
      const counts = await reconcileMasterReportCounts(projectId);
      setReconciliation(counts);
    }
  }

  if (loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 90 }} /><div className="skeleton-block" style={{ height: 400 }} /></div>;
  if (report?.error || !report?.project) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">{t("loadErrorRetry", lang)}</div>
        <button className="btn btn-primary" onClick={load}>{t("retry", lang)}</button>
      </div>
    );
  }

  const p = report.project;
  const stageIndex = STAGES.indexOf(p.stage);

  return (
    <div className="dept-dashboard master-report">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📊</div>
        <div className="dept-header-text">
          <h1>{t("masterReportCardLabel", lang)} — {p.project_code}</h1>
          <div className="sub">{p.customer} · {p.location || "—"}</div>
        </div>
      </div>

      <div className="card no-print">
        <div className="btn-row" style={{ marginTop: 0, flexWrap: "wrap" }}>
          <button className="btn btn-outline" onClick={load}>{t("refreshReportAction", lang)}</button>
          <button className="btn btn-outline" onClick={handlePrint}>{t("printReportAction", lang)}</button>
          <button className="btn btn-outline" onClick={handlePrint}>{t("exportPdfAction", lang)}</button>
          <button className="btn btn-outline" onClick={handleExportExcel}>{t("exportExcelAction", lang)}</button>
          <button className="btn btn-outline" disabled={zipBusy} onClick={handleDownloadAllFiles}>
            {zipBusy ? `${t("preparingDownloadMsg", lang)} ${zipProgress}` : t("downloadAllFilesAction", lang)}
          </button>
          <button className="btn btn-outline" onClick={handleCopyLink}>{linkCopied ? t("linkCopiedMsg", lang) : t("copyReportLinkAction", lang)}</button>
          <button className="btn btn-outline" onClick={() => navigate(`/interior-projects/detail/${projectId}`)}>{t("openEditableTabsLabel", lang)}</button>
        </div>
        {zipMsg && <div className="msg info" style={{ marginTop: 10 }}>{zipMsg}</div>}
      </div>

      {/* ---------- Header / Project Summary ---------- */}
      <div className="card" id="section-summary">
        <h2>{t("tabOverview", lang)}</h2>
        <div className="dept-meta-grid">
          <div className="card dept-meta-tile"><div className="label">{t("stageLabel", lang)}</div><div className="value">{p.stage}</div></div>
          <div className="card dept-meta-tile"><div className="label">{t("interiorRole_pm", lang)}</div><div className="value">{personName(p.project_manager_id)}</div></div>
          <div className="card dept-meta-tile"><div className="label">{t("interiorRole_designer", lang)}</div><div className="value">{p.designer_id ? personName(p.designer_id) : "—"}</div></div>
          <div className="card dept-meta-tile"><div className="label">{t("interiorRole_execution", lang)}</div><div className="value">{p.execution_id ? personName(p.execution_id) : "—"}</div></div>
          <div className="card dept-meta-tile"><div className="label">{t("startDateLabel", lang)}</div><div className="value">{p.start_date || "—"}</div></div>
          <div className="card dept-meta-tile"><div className="label">{t("dueDateLabel", lang)}</div><div className="value">{p.due_date || "—"}</div></div>
          <div className="card dept-meta-tile"><div className="label">{t("projectValueLabel", lang)}</div><div className="value">{formatCurrency(p.project_value)}</div></div>
          <div className="card dept-meta-tile"><div className="label">{t("progressLabel", lang)}</div><div className="value">{kpis.progressPct}%</div></div>
        </div>
        <div className="task-meta" style={{ padding: "6px 0" }}><span>{t("clientContactLabel", lang)}</span><NotTracked lang={lang} /></div>
        {p.frozen && <div className="msg info" style={{ marginTop: 10 }}>{t("projectFrozenLabel", lang)} — {p.freeze_date}</div>}
        <div className="sub" style={{ marginTop: 10 }}>
          {t("reportGeneratedLabel", lang)}: {generatedAt?.toLocaleString()} · {t("generatedByLabel", lang)}: {staffProfile?.full_name || "—"}
        </div>
        <div className="sub">
          {t("lastUpdatedByLabel", lang)}: {report.auditLog[0] ? `${staffUserName(report.auditLog[0].performed_by)} · ${new Date(report.auditLog[0].performed_at).toLocaleString()}` : "—"}
        </div>
      </div>

      {/* ---------- Warnings ---------- */}
      {warnings.length > 0 && (
        <div className="card" id="section-warnings" style={{ borderColor: "var(--danger)" }}>
          <h2>{t("warningsTitle", lang)}</h2>
          {warnings.map((w) => <div key={w} className="msg error" style={{ marginTop: 6 }}>{t(w, lang)}</div>)}
        </div>
      )}

      {/* ---------- Executive Dashboard ---------- */}
      <div className="card" id="section-dashboard">
        <h2>{t("executiveDashboardTitle", lang)}</h2>
        <div className="kpi-grid kpi-grid-wide">
          <div className="kpi-tile"><div className="num">{kpis.progressPct}%</div><div className="label">{t("progressLabel", lang)}</div></div>
          <div className="kpi-tile gold"><div className="num">{p.stage}</div><div className="label">{t("stageLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{formatCurrency(p.project_value)}</div><div className="label">{t("projectValueLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{formatCurrency(kpis.received)}</div><div className="label">{t("paymentReceivedLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.pendingFromValue != null ? formatCurrency(kpis.pendingFromValue) : "—"}</div><div className="label">{t("paymentPendingLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.totalTasks}</div><div className="label">{t("totalTasksLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.completedTasks}</div><div className="label">{t("completedTasksLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.pendingTasks}</div><div className="label">{t("pendingTasksLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.overdueTasks}</div><div className="label">{t("overdueTasksLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.pendingApprovals}</div><div className="label">{t("pendingApprovalsLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.materialsPending}</div><div className="label">{t("materialsPendingLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.purchasePending}</div><div className="label">{t("purchasePendingLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.openComplaints}</div><div className="label">{t("openComplaintsLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.totalFiles}</div><div className="label">{t("totalFilesLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.daysRemaining != null ? kpis.daysRemaining : "—"}</div><div className="label">{t("daysRemainingLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.daysOverdue}</div><div className="label">{t("daysOverdueLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.lastDailyUpdate || "—"}</div><div className="label">{t("lastDailyUpdateLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.msTotal}</div><div className="label">{t("materialSelectionTitle", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.msApproved}</div><div className="label">{t("completeStatusLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.msPending}</div><div className="label">{t("pendingApprovalStatusLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.msRejected}</div><div className="label">{t("rejectedCountLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.msFinal}</div><div className="label">{t("finalSelectionLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{roomProgress.rooms.length}</div><div className="label">{t("roomAreaLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{roomProgress.missing.length}</div><div className="label">{t("missingInfoLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.wdAreasIssued}/{kpis.wdAreasTotal}</div><div className="label">{t("workingDrawingProgressLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.wdChecklistDone}%</div><div className="label">{t("checklistLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.pmTotal}</div><div className="label">{t("purchaseManagementTitle", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.pmInHouse}</div><div className="label">{t("inHouseProductionLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.pmOutsourced}</div><div className="label">{t("outsourcedLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.pmPoIssued}</div><div className="label">{t("purchaseOrderLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{formatCurrency(kpis.pmApprovedValue)}</div><div className="label">{t("totalCostLabel", lang)}</div></div>
          {isElevated && <div className="kpi-tile"><div className="num">{formatCurrency(kpis.pmEstimatedCost)}</div><div className="label">{t("estimatedLabel", lang)}</div></div>}
          {isElevated && <div className="kpi-tile"><div className="num">{formatCurrency(kpis.pmActualCost)}</div><div className="label">{t("actualLabel", lang)}</div></div>}
          <div className="kpi-tile"><div className="num">{kpis.pmQcFailures}</div><div className="label">{t("qualityCheckLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.pmCompleted}</div><div className="label">{t("completeStatusLabel", lang)}</div></div>
          <div className="kpi-tile"><div className="num">{kpis.pmChecklistDone}%</div><div className="label">{t("checklistLabel", lang)}</div></div>
        </div>
      </div>

      {/* ---------- 1. Quotation ---------- */}
      <AttachmentSection id="section-quotation" lang={lang} titleKey="tabQuotation" rows={report.attachments.filter((a) => a.stage === "Quotation")} personName={personName} />

      {/* ---------- 2, 11. Project Timeline & Deal Closure (consolidated —
           these were two separate report sections built over the exact
           same project fields; merged into one) ---------- */}
      <div className="card" id="section-projecttimeline">
        <h2>{t("tabProjectTimeline", lang)}</h2>
        <div className="task-meta" style={{ padding: "6px 0" }}>
          {STAGES.map((s, i) => <span key={s} className={`badge ${i <= stageIndex ? "VERIFIED" : "CLOSED"}`}>{s}</span>)}
        </div>
        <div className="task-meta" style={{ padding: "6px 0" }}><span>{t("interiorLocationLabel", lang)}</span><span className="sub">{p.location || "—"}</span></div>
        <div className="task-meta" style={{ padding: "6px 0" }}><span>{t("nextActionLabel", lang)}</span><span className="sub">{p.next_action || "—"}</span></div>
        <div className="task-meta" style={{ padding: "6px 0" }}><span>{t("nextUpdateLabel", lang)}</span><span className="sub">{p.next_update || "—"}</span></div>
        <div className="task-meta" style={{ padding: "6px 0" }}><span>{t("onTimeLabel", lang)}</span><span className="sub">{p.on_time == null ? "—" : p.on_time ? t("yesLabel", lang) : t("noLabel", lang)}</span></div>
        <div className="task-meta" style={{ padding: "6px 0" }}><span>{t("remarksLabel", lang)}</span><span className="sub">{p.remarks || "—"}</span></div>
      </div>

      {/* ---------- 3-6, 21. Working Drawings (consolidates Design / Design
           Approval / Design Lock / Drawings / Material Selection) ---------- */}
      <div className="card" id="section-workingdrawings">
        <h2>{t("tabWorkingDrawings", lang)}</h2>

        {/* Current simplified file register — title/category/note, per the
            simplified Working Drawings page. The per-area breakdown below
            is historical data from that page's earlier, richer design
            (room/version/checklist workflow) — never deleted, but frozen
            in time since the page no longer creates new rows there. */}
        <div className="sub" style={{ fontWeight: 700 }}>{t("uploadFileAction", lang)}</div>
        {(() => {
          const wdFiles = [
            ...report.attachments.filter((a) => a.stage === "Working Drawings" || a.stage === "Drawings"),
            ...report.workingDrawingAttachments,
          ];
          if (wdFiles.length === 0) return <EmptySection lang={lang} />;
          return wdFiles.map((f) => {
            const category = f.file_category === "Other" ? (f.custom_category || f.file_category) : f.file_category;
            return (
              <div key={f.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0", flexWrap: "wrap", gap: 6 }}>
                <span>{f.title || f.original_file_name || f.file_name}</span>
                <span className="badge ASSIGNED">{category || t("uncategorisedLabel", lang)}</span>
                <span className="sub">{personName(f.uploaded_by)} · {(f.created_at || f.uploaded_at || "").slice(0, 10)}</span>
                {(f.note || f.description) && <span className="sub">{t("notesLabel", lang)}: {f.note || f.description}</span>}
                <DownloadButton storagePath={f.storage_path} lang={lang} />
              </div>
            );
          });
        })()}

        {wdAreaSummary.length > 0 && <div className="sub" style={{ fontWeight: 700, marginTop: 14 }}>{t("roomAreaLabel", lang)}</div>}
        {wdAreaSummary.map(({ area, current, versions, changeCounts, approvals, lock, drawings, drawingVersionsForArea, checklistPct, issues, areaMaterials, materialsApproved }) => (
          <div key={area.id} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 10, marginBottom: 10 }}>
            <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700 }}>{area.area_type === "Other" ? area.custom_area_type : area.area_type}{area.area_name ? ` — ${area.area_name}` : ""}</span>
              <span className="badge ASSIGNED">{area.current_stage}</span>
              {area.assigned_designer_id && <span className="sub">{t("assignedDesignerLabel", lang)}: {personName(area.assigned_designer_id)}</span>}
            </div>

            <div className="sub" style={{ marginTop: 4 }}>
              {t("designVersionLabel", lang)}: {current ? `${current.version_number}${current.revision_number ? ` · R${current.revision_number}` : ""} (${current.approval_status})` : t("notTrackedLabel", lang)}
              {" · "}{t("changeCountLabel", lang)}: {changeCounts.total_change_count} (Client {changeCounts.client_change_count} / Internal {changeCounts.internal_change_count} / Site {changeCounts.site_condition_change_count} / Mgmt {changeCounts.management_change_count})
            </div>
            {versions.length > 1 && (
              <div className="sub">{t("viewHistoryAction", lang)}: {versions.map((v) => `${v.version_number}${v.revision_number ? `.R${v.revision_number}` : ""} (${v.approval_status})`).join(" → ")}</div>
            )}
            {approvals.length > 0 && (
              <div className="sub">{t("approvalStageLabel", lang)}: {approvals[approvals.length - 1].stage_at_approval || "—"} · {t("approvedVersionLabel", lang)}: {approvals[approvals.length - 1].version_number || "—"} · {t("approvedByLabel", lang)}: {personName(approvals[approvals.length - 1].decided_by)}</div>
            )}

            <div className="sub" style={{ marginTop: 4 }}>
              {t("materialApprovalLabel", lang)}: {areaMaterials.length === 0 ? t("notTrackedLabel", lang) : `${areaMaterials.filter((m) => ["Approved", "Approved with Conditions", "Final Selection Locked"].includes(m.approval_status)).length}/${areaMaterials.length}`}
              <span className={`badge ${materialsApproved ? "VERIFIED" : "ASSIGNED"}`} style={{ marginLeft: 6 }}>{materialsApproved ? t("completeStatusLabel", lang) : t("pendingApprovalStatusLabel", lang)}</span>
            </div>
            {areaMaterials.filter((m) => m.approval_status === "Rejected" || m.status === "REPLACED").length > 0 && (
              <div className="sub">{t("rejectedCountLabel", lang)}: {areaMaterials.filter((m) => m.approval_status === "Rejected" || m.status === "REPLACED").map((m) => `${m.material_name} (${m.status === "REPLACED" ? "Replaced" : "Rejected"})`).join(", ")}</div>
            )}

            <div className="sub" style={{ marginTop: 4 }}>
              {t("tabDesignLock", lang)}: {lock ? (
                <span className="badge COMPLETED">{t("lockedLabel", lang)} — {lock.lock_date} ({personName(lock.locked_by)})</span>
              ) : <span className="badge ASSIGNED">{t("pendingApprovalStatusLabel", lang)}</span>}
              {lock?.exception_reason && <span className="sub"> · Exception: {lock.exception_reason}</span>}
            </div>

            {drawings.length > 0 && (
              <div className="sub" style={{ marginTop: 4 }}>
                {t("finalDrawingLabel", lang)}: {drawings.map((d) => {
                  const dv = drawingVersionsForArea.filter((v) => v.drawing_id === d.id);
                  const issued = dv.find((v) => v.status === "Issued for Execution");
                  return `${d.drawing_number} (${issued ? "ISSUED" : d.status})`;
                }).join(", ")}
              </div>
            )}
            <div className="sub">{t("checklistLabel", lang)}: {checklistPct}%</div>
            {issues.length > 0 && (
              <div className="sub">{t("issueForExecutionLabel", lang)}: {issues.map((i) => `${i.issued_to} · ${i.issue_date}${i.superseded_at ? " (Superseded)" : i.receiver_ack ? " (Acknowledged)" : ""}`).join(", ")}</div>
            )}
          </div>
        ))}

        {(report.attachments.some((a) => a.stage === "Design" || a.stage === "Drawings") || report.changes.length > 0) && (
          <div style={{ marginTop: 10 }}>
            <div className="sub" style={{ fontWeight: 700 }}>{t("legacyRecordsLabel", lang)}</div>
            {report.attachments.filter((a) => a.stage === "Design" || a.stage === "Drawings").map((a) => (
              <div key={a.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0", flexWrap: "wrap" }}>
                <span>{a.title || a.file_name} ({a.stage})</span>
                {a.frozen && <span className="badge CLOSED">{t("frozenLabel", lang)}</span>}
                <DownloadButton storagePath={a.storage_path} lang={lang} />
              </div>
            ))}
            {report.changes.map((c) => (
              <div key={c.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0", flexWrap: "wrap" }}>
                <span>{c.description}</span>
                <span className={`badge ${c.approval_status === "PENDING" ? "ASSIGNED" : c.approval_status === "APPROVED" ? "VERIFIED" : "RETURNED"}`}>{c.approval_status}</span>
              </div>
            ))}
          </div>
        )}

        <div className="sub" style={{ marginTop: 14, fontWeight: 700 }}>{t("groupByRoomLabel", lang)}</div>
        {roomProgress.rooms.length === 0 && <EmptySection lang={lang} />}
        {roomProgress.rooms.map((r) => (
          <div key={r.name} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
            <span>{r.name}</span>
            <span className="sub">{r.done}/{r.total}</span>
            <span className={`badge ${r.pct === 100 ? "VERIFIED" : r.pct > 0 ? "ASSIGNED" : "CLOSED"}`}>{r.pct}%</span>
          </div>
        ))}
        {roomProgress.missing.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="sub" style={{ fontWeight: 700 }}>{t("missingInfoLabel", lang)}</div>
            <div className="sub">{roomProgress.missing.map(([en, gu]) => (lang === "gu" ? gu : en)).join(", ")}</div>
          </div>
        )}

        <div className="sub" style={{ fontWeight: 700, marginTop: 14 }}>{t("materialSelectionTitle", lang)}</div>
        {msChains.length === 0 && <EmptySection lang={lang} />}
        {msChains.map(({ head: m, history }) => {
          const atts = report.materialSelectionAttachments.filter((a) => a.material_selection_id === m.id);
          return (
            <div key={m.id} className="task-meta" style={{ display: "block", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                <span style={{ fontWeight: 700 }}>{m.material_name} <span className="sub" style={{ fontWeight: 400 }}>({m.material_code})</span></span>
                <span className="sub">{m.area_name || (m.area_type === "Other" ? m.custom_area_type : m.area_type)} {m.floor ? `· ${m.floor}` : ""} {m.room_number ? `· #${m.room_number}` : ""}</span>
                <span className="sub">{m.material_category === "Other" ? m.custom_material_category : m.material_category} {m.material_type ? `(${m.material_type})` : ""}</span>
                {m.is_final && <span className="badge VERIFIED">{t("finalSelectionLabel", lang)}</span>}
                <span className={`badge ${MS_STATUS_BADGE[m.approval_status] || "CLOSED"}`}>{m.approval_status}</span>
                {m.revision_number > 1 && <span className="sub">{t("revisionLabel", lang)} {m.revision_number}</span>}
              </div>
              <div className="sub" style={{ marginTop: 4 }}>{t("selectionDateLabel", lang)}: {m.selection_date} · {t("selectedByLabel", lang)}: {m.selected_by_type || "—"} {m.selected_by_name ? `(${m.selected_by_name})` : ""} · {t("responsibleDesignerLabel", lang)}: {personName(m.responsible_designer_id)}</div>
              <div className="sub">{t("brandLabel", lang)}: {m.brand || "—"} · {t("vendorLabel", lang)}: {m.vendor_name || "—"} · {t("colourLabel", lang)}: {m.colour || "—"} · {t("finishLabel", lang)}: {m.finish || "—"} · {t("textureLabel", lang)}: {m.texture || "—"}</div>
              <div className="sub">{t("dimensionsLabel", lang)}: {m.dimensions || "—"} · {t("thicknessLabel", lang)}: {m.thickness || "—"} · {t("unitLabel", lang)}: {m.unit || "—"} · {t("quantityLabel", lang)}: {m.quantity ?? "—"}</div>
              <div className="sub">{t("rateLabel", lang)}: {m.rate != null ? formatCurrency(m.rate) : "—"} · {t("estimatedAmountLabel", lang)}: {m.estimated_amount != null ? formatCurrency(m.estimated_amount) : "—"}</div>
              {m.usage_application && <div className="sub">{t("usageApplicationLabel", lang)}: {m.usage_application}</div>}
              {m.description && <div className="sub">{t("descriptionLabel", lang)}: {m.description}</div>}
              {m.remarks && <div className="sub">{t("remarksLabel", lang)}: {m.remarks}</div>}
              {m.client_remarks && <div className="sub">{t("clientRemarksLabel", lang)}: {m.client_remarks}</div>}
              {m.internal_remarks && <div className="sub">{t("internalRemarksLabel", lang)}: {m.internal_remarks}</div>}
              {m.change_reason && <div className="sub">{t("changeReasonLabel", lang)}: {m.change_reason}</div>}
              {m.design_lock_note && <div className="sub">{t("designLockNoteLabel", lang)}: {m.design_lock_note}</div>}
              {m.approved_by && <div className="sub">{t("approvedByLabel", lang)}: {personName(m.approved_by)} · {m.client_approval_date || "—"}</div>}
              <div className="sub" style={{ marginTop: 4 }}>{t("tabFiles", lang)} ({atts.length}):</div>
              {atts.length === 0 && <span className="sub">{t("noFileAttachedLabel", lang)}</span>}
              {atts.map((a) => (
                <span key={a.id} style={{ marginRight: 10, display: "inline-block" }}>
                  <DownloadButton storagePath={a.storage_path} lang={lang} /> <span className="sub">{a.file_category}</span>
                </span>
              ))}

              {history.length > 1 && (
                <div style={{ marginTop: 8 }}>
                  <div className="sub" style={{ fontWeight: 700 }}>{t("viewHistoryAction", lang)}</div>
                  {history.map((h) => (
                    <div key={h.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
                      <span className="sub">{t("revisionLabel", lang)} {h.revision_number} — {h.material_name} ({h.material_code})</span>
                      <span className="sub">{h.selection_date}</span>
                      {h.change_reason && <span className="sub">{t("changeReasonLabel", lang)}: {h.change_reason}</span>}
                      <span className={`badge ${MS_STATUS_BADGE[h.approval_status] || "CLOSED"}`}>{h.approval_status}{h.status === "REPLACED" ? ` (${t("replaceSelectionAction", lang)})` : ""}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <div className="sub" style={{ marginTop: 14, fontWeight: 700 }}>{t("tabActivity", lang)}</div>
        {report.auditLog.filter((l) => ["working_drawing_areas", "design_briefs", "design_versions", "design_change_requests", "design_approvals", "design_locks", "working_drawings", "drawing_versions", "drawing_checklist_results", "drawing_issues", "working_drawing_attachments", "material_selections", "material_selection_attachments"].includes(l.table_name)).length === 0 && <EmptySection lang={lang} />}
        {report.auditLog.filter((l) => ["working_drawing_areas", "design_briefs", "design_versions", "design_change_requests", "design_approvals", "design_locks", "working_drawings", "drawing_versions", "drawing_checklist_results", "drawing_issues", "working_drawing_attachments", "material_selections", "material_selection_attachments"].includes(l.table_name)).slice(0, 30).map((l) => (
          <div key={l.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
            <span className="sub">{l.table_name} · {l.action}</span>
            <span className="sub">{staffUserName(l.performed_by)} · {new Date(l.performed_at).toLocaleString()}</span>
          </div>
        ))}
      </div>

      {/* ---------- Purchase Management (consolidates Purchase Coordination / Purchase Board) ---------- */}
      <div className="card" id="section-purchasemanagement">
        <h2>{t("purchaseManagementTitle", lang)}</h2>
        {report.purchaseRequests.length === 0 && <EmptySection lang={lang} />}
        {report.purchaseRequests.map((r) => {
          const inhouse = report.inhouseProductionRequests.find((i) => i.purchase_request_id === r.id);
          const outsource = report.outsourceRequirements.find((o) => o.purchase_request_id === r.id);
          const po = report.purchaseOrders.find((o) => o.purchase_request_id === r.id && o.is_current);
          const costing = report.purchaseCosting.find((c) => c.purchase_request_id === r.id);
          const receipts = report.purchaseReceipts.filter((rc) => rc.purchase_request_id === r.id);
          const payments = report.purchasePaymentCoordination.filter((p) => p.purchase_request_id === r.id);
          const followups = report.vendorFollowups.filter((f) => f.purchase_request_id === r.id);
          const selection = report.purchaseVendorSelections.find((s) => s.purchase_request_id === r.id);
          const items = report.purchaseRequestItems.filter((it) => it.purchase_request_id === r.id);
          return (
            <div key={r.id} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 10, marginBottom: 10 }}>
              <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700 }}>{r.request_number}</span>
                <span className="sub">{r.purchase_source === "in_house" ? t("inHouseProductionLabel", lang) : t("outsourcedLabel", lang)}</span>
                <span className="badge ASSIGNED">{r.status}</span>
                <span className="sub">{r.priority} · {personName(r.assigned_purchase_person)}</span>
              </div>
              {items.length > 0 && <div className="sub">Items: {items.map((it) => `${it.item_name} (${it.quantity || "—"} ${it.unit || ""})`).join(", ")}</div>}
              {inhouse && (
                <div className="sub">{t("selectFactoryLabel", lang)}: {inhouse.job_order_number || "—"} · {inhouse.status} · QC {inhouse.qc_status || "—"} · {t("deliveredLabel", lang)}: {inhouse.delivery_status || "—"}</div>
              )}
              {outsource && (
                <div className="sub">Outsource Type: {outsource.outsource_type === "Other" ? outsource.outsource_type_other : outsource.outsource_type}</div>
              )}
              {selection && (
                <div className="sub">{t("vendorComparisonLabel", lang)}: {selection.selection_reason} {!selection.is_lowest_bid && "(not lowest bid — justified)"}</div>
              )}
              {po && (
                <div className="sub">{t("purchaseOrderLabel", lang)}: {po.po_number} ({po.version_number}) · {po.status} · {t("totalCostLabel", lang)}: {formatCurrency(po.total_order_value)}</div>
              )}
              {isElevated && costing && (
                <div className="sub">{t("costingLabel", lang)}: {t("estimatedLabel", lang)} {formatCurrency(costing.total_estimated_cost)} · {t("actualLabel", lang)} {formatCurrency(costing.total_actual_cost)}</div>
              )}
              {receipts.length > 0 && (
                <div className="sub">GRN/QC: {receipts.map((rc) => `${rc.grn_number} (${rc.qc_status})`).join(", ")}</div>
              )}
              {followups.length > 0 && (
                <div className="sub">{t("vendorFollowUpLabel", lang)}: {followups.length} · Last: {followups[0]?.follow_up_date}</div>
              )}
              {payments.length > 0 && (
                <div className="sub">{t("paymentCoordinationLabel", lang)}: {payments.map((p) => `${p.invoice_number || "—"} (${p.status})`).join(", ")}</div>
              )}
            </div>
          );
        })}

        <div className="sub" style={{ marginTop: 14, fontWeight: 700 }}>{t("checklistLabel", lang)}</div>
        <div className="sub">{kpis.pmChecklistDone}%</div>

        {report.purchaseRequests.length === 0 ? null : (
          <div className="sub" style={{ marginTop: 14, fontWeight: 700 }}>{t("tabActivity", lang)}</div>
        )}
        {report.auditLog.filter((l) => ["purchase_requests", "purchase_request_items", "inhouse_production_requests", "outsource_requirements", "vendor_quotations", "purchase_vendor_selections", "purchase_approvals", "purchase_orders", "purchase_costing", "purchase_checklist_results", "vendor_followups", "purchase_receipts", "purchase_payment_coordination", "purchase_attachments", "vendors"].includes(l.table_name)).slice(0, 30).map((l) => (
          <div key={l.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
            <span className="sub">{l.table_name} · {l.action}</span>
            <span className="sub">{staffUserName(l.performed_by)} · {new Date(l.performed_at).toLocaleString()}</span>
          </div>
        ))}
      </div>

      {/* ---------- 7. Site Execution ---------- */}
      <div className="card" id="section-siteexecution">
        <h2>{t("tabSiteExecution", lang)}</h2>
        {report.snags.length === 0 && <EmptySection lang={lang} />}
        {report.snags.map((s) => (
          <div key={s.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap", gap: 6 }}>
            <span>{s.issue} {s.major && <span className="badge RETURNED">{t("majorLabel", lang)}</span>}</span>
            <span className="sub">{s.assigned_to ? personName(s.assigned_to) : "—"} · {s.due_date || "—"}</span>
            {s.note && <span className="sub">{t("notesLabel", lang)}: {s.note}</span>}
            <span className={`badge ${s.status === "COMPLETED" ? "VERIFIED" : "ASSIGNED"}`}>{s.status}</span>
          </div>
        ))}
      </div>

      {/* ---------- 8. Daily Updates ---------- */}
      <div className="card" id="section-dailyupdates">
        <h2>{t("tabDailyUpdates", lang)}</h2>
        {report.siteReports.length === 0 && <EmptySection lang={lang} />}
        {report.siteReports.map((r) => (
          <div key={r.id} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
            <div style={{ fontWeight: 700 }}>{r.report_date} <span className="sub" style={{ fontWeight: 400 }}>· {personName(r.submitted_by)}</span></div>
            <div className="sub">{t("todayWorkLabel", lang)}: {r.work_today || "—"}</div>
            <div className="sub">{t("workPendingAuto", lang)}: {r.work_pending || "—"}</div>
            <div className="sub">{t("materialLabel", lang)}: {r.material || "—"}</div>
            <div className="sub">{r.issue || "—"}</div>
            <div className="sub">{r.tomorrow_plan || "—"}</div>
            {r.remarks && <div className="sub">{t("remarksLabel", lang)}: {r.remarks}</div>}
          </div>
        ))}
      </div>

      {/* ---------- 9. Material Requirements ---------- */}
      <div className="card" id="section-materials">
        <h2>{t("tabMaterials", lang)}</h2>
        {report.materialsCatalog.length > 0 && report.materialsCatalog.map((m) => (
          <div key={m.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
            <span>{m.material} ({m.quantity})</span>
            <span className="sub">{m.ordered ? "Ordered" : "—"} / {m.received ? "Received" : "—"}</span>
          </div>
        ))}
        {report.materialsRequirements.length === 0 && report.materialsCatalog.length === 0 && <EmptySection lang={lang} />}
        {report.materialsRequirements.map((m) => (
          <div key={m.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap", gap: 6 }}>
            <span>{m.material}</span>
            <span className="sub">{t("neededByLabel", lang)}: {m.required_by || "—"} · {m.requested_by ? personName(m.requested_by) : "—"}</span>
            {m.remark && <span className="sub">{t("notesLabel", lang)}: {m.remark}</span>}
            <span className="badge ASSIGNED">{m.status}</span>
          </div>
        ))}
      </div>

      {/* ---------- 10. Purchase Coordination ---------- */}
      <div className="card" id="section-purchase">
        <h2>{t("tabPurchase", lang)}</h2>
        {report.materialsPurchase.length === 0 && <EmptySection lang={lang} />}
        {report.materialsPurchase.map((m) => (
          <div key={m.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap", gap: 6 }}>
            <span>{m.material}</span>
            <span className="sub">{t("neededByLabel", lang)}: {m.required_by || "—"} · {m.requested_by ? personName(m.requested_by) : "—"}</span>
            {m.remark && <span className="sub">{t("notesLabel", lang)}: {m.remark}</span>}
            <span className="badge ASSIGNED">{m.status}</span>
          </div>
        ))}
      </div>

      {/* ---------- 12. Client Communication ---------- */}
      <div className="card" id="section-clientcomm">
        <h2>{t("tabClientComm", lang)}</h2>
        {report.activity.length === 0 && <EmptySection lang={lang} />}
        {report.activity.map((a) => (
          <div key={a.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
            <span>{a.description}</span>
            <span className="sub">{a.user_id ? personName(a.user_id) : "—"} · {(a.created_at || "").slice(0, 10)}</span>
          </div>
        ))}
      </div>

      {/* ---------- 13. Payment Follow-up ---------- */}
      <div className="card" id="section-payments">
        <h2>{t("tabPayments", lang)}</h2>
        {report.payments.length === 0 && <EmptySection lang={lang} />}
        {report.payments.map((pay) => (
          <div key={pay.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap", gap: 6 }}>
            <span>{pay.payment_type} · {t("dueDateLabel", lang)}: {pay.due_date || "—"}</span>
            <span>{formatCurrency(pay.amount)}</span>
            <span className="sub">{staffUserName(pay.created_by)}</span>
            {pay.receipt_number && <span className="sub">{t("receiptNumberLabel", lang)}: {pay.receipt_number}</span>}
            {pay.note && <span className="sub">{t("notesLabel", lang)}: {pay.note}</span>}
            <span className={`badge ${pay.status === "RECEIVED" ? "VERIFIED" : "ASSIGNED"}`}>{pay.status}</span>
          </div>
        ))}
      </div>

      {/* ---------- 14. Project Completion ---------- */}
      <div className="card" id="section-completion">
        <h2>{t("tabCompletion", lang)}</h2>
        {HANDOVER_FLAGS.map(([f, labelKey]) => (
          <div key={f} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
            <span>{t(labelKey, lang)}</span>
            <span className={`badge ${report.handover?.[f] ? "VERIFIED" : "CLOSED"}`}>{report.handover?.[f] ? t("completeStatusLabel", lang) : t("pendingLabel", lang)}</span>
          </div>
        ))}
        {report.handover?.handover_date && (
          <div className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
            <span>{t("handoverCompleteLabel", lang)}</span>
            <span className="sub">{report.handover.handover_date} {report.handover.updated_by ? `· ${personName(report.handover.updated_by)}` : ""}</span>
          </div>
        )}
        {report.feedback.length === 0 && <div className="msg info" style={{ marginTop: 10 }}>{t("noDataEnteredLabel", lang)}</div>}
        {report.feedback.map((f) => (
          <div key={f.id} className="task-meta" style={{ padding: "6px 0", flexWrap: "wrap", gap: 6 }}>
            <span>{t("overallScoreLabel", lang)}: {f.overall_score}/10 — {f.note || "—"}</span>
            <span className="sub">{f.created_by ? personName(f.created_by) : "—"} · {(f.created_at || "").slice(0, 10)}</span>
          </div>
        ))}
      </div>

      {/* ---------- 16. Tasks ---------- */}
      <div className="card" id="section-tasks">
        <h2>{t("tabTasks", lang)}</h2>
        {report.tasks.length === 0 && report.staffTasks.length === 0 && <EmptySection lang={lang} />}
        {report.tasks.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap", gap: 6 }}>
            <span>{r.title}</span>
            <span className="sub">{t("createdBy", lang)}: {r.created_by ? personName(r.created_by) : "—"} · {t("assignedToLabel", lang)}: {r.assigned_to ? personName(r.assigned_to) : "—"}</span>
            <span className="sub">{r.due_date || "—"}</span>
            {r.note && <span className="sub">{t("notesLabel", lang)}: {r.note}</span>}
            <span className={`badge ${r.status === "COMPLETED" ? "VERIFIED" : "ASSIGNED"}`}>{r.status}</span>
          </div>
        ))}
        {/* staff_tasks linked to this project (Daily Site Update assignments
            and any future project-linked source) — assigned_to/assigned_by
            are user_profiles ids, resolved via staffUserName, not personName. */}
        {report.staffTasks.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap", gap: 6 }}>
            <span>{r.title}</span>
            <span className="sub">{t("assignedToLabel", lang)}: {staffUserName(r.assigned_to)}</span>
            <span className="sub">{r.due_date || "—"}</span>
            {r.source_module === "daily_site_update" && <span className="badge ASSIGNED">{t("sourceDailySiteUpdateLabel", lang)}</span>}
          </div>
        ))}
      </div>

      {/* ---------- 17. Customer Requests & Complaints ---------- */}
      <div className="card" id="section-requests">
        <h2>{t("customerRequestsTitle", lang)}</h2>
        {report.requests.length === 0 && <EmptySection lang={lang} />}
        {report.requests.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap", gap: 6 }}>
            <span>{r.request_type} — {r.description}</span>
            <span className="sub">{t("createdBy", lang)}: {r.created_by ? personName(r.created_by) : "—"} · {(r.created_at || "").slice(0, 10)}</span>
            <span className={`badge ${r.status === "CLOSED" ? "CLOSED" : "ASSIGNED"}`}>{r.status}</span>
          </div>
        ))}
      </div>

      {/* ---------- 18. Uploaded Files ---------- */}
      <div id="section-files">
        <InteriorAllFiles lang={lang} projectId={projectId} />
      </div>

      {/* ---------- 19. Project Team ---------- */}
      <div className="card" id="section-team">
        <h2>{t("projectTeamTitle", lang)}</h2>
        <div className="task-meta" style={{ padding: "4px 0" }}><span className="badge VERIFIED">{t("projectOwnerBadge", lang)}</span><span>{personName(p.project_manager_id)}</span></div>
        {p.designer_id && <div className="task-meta" style={{ padding: "4px 0" }}><span className="badge ASSIGNED">{t("interiorRole_designer", lang)}</span><span>{personName(p.designer_id)}</span></div>}
        {p.execution_id && <div className="task-meta" style={{ padding: "4px 0" }}><span className="badge ASSIGNED">{t("interiorRole_execution", lang)}</span><span>{personName(p.execution_id)}</span></div>}
        {report.team.map((m) => (
          <div key={m.id} className="task-meta" style={{ padding: "4px 0" }}><span>{personName(m.profile_id)}</span></div>
        ))}
      </div>

      {/* ---------- 20. Complete Activity History ---------- */}
      <div id="section-activity">
        <InteriorActivityHistory lang={lang} projectId={projectId} isElevated={isElevated} />
      </div>


      {/* ---------- Data Completeness Engine ---------- */}
      <div className="card" id="section-completeness">
        <h2>{t("reportCompletenessTitle", lang)} — {completenessPct}%</h2>
        {completeness.map((c) => (
          <div key={c.key} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
            <span>{t(c.labelKey, lang)}</span>
            <StatusBadge status={c.status} lang={lang} />
          </div>
        ))}
      </div>

      {/* ---------- Reconciliation (elevated roles only) ---------- */}
      {isElevated && (
        <div className="card no-print" id="section-reconciliation">
          <button className="btn btn-outline" onClick={handleReconcile}>{t("reconciliationTitle", lang)}</button>
          {showReconciliation && reconciliation && (
            <div style={{ marginTop: 10 }}>
              {Object.entries(reconciliation).map(([table, dbCount]) => {
                const reportCounts = {
                  // materialsRequirements is the UNFILTERED project_materials read
                  // (listProjectMaterials(id, null) — no `source` filter applied),
                  // so it already includes the purchase-sourced rows shown again,
                  // as a subset, in materialsPurchase. Summing both here would
                  // double-count them against the table's real row count.
                  attachments: report.attachments.length, project_changes: report.changes.length, snags: report.snags.length,
                  site_reports: report.siteReports.length, project_materials: report.materialsRequirements.length,
                  activity_logs: report.activity.length, interior_payment_records: report.payments.length, customer_feedback: report.feedback.length,
                  tasks: report.tasks.length, project_requests: report.requests.length, project_members: report.team.length, interior_pilot_audit_log: report.auditLog.length,
                  material_selections: report.materialSelections.length, material_selection_attachments: report.materialSelectionAttachments.length,
                  working_drawing_areas: report.workingDrawingAreas.length, design_briefs: report.designBriefs.length,
                  design_versions: report.designVersions.length, design_change_requests: report.designChangeRequests.length,
                  design_approvals: report.designApprovals.length, design_locks: report.designLocks.length,
                  working_drawings: report.workingDrawings.length, drawing_versions: report.drawingVersions.length,
                  drawing_checklist_results: report.checklistResults.length, drawing_issues: report.drawingIssues.length,
                  working_drawing_attachments: report.workingDrawingAttachments.length,
                  purchase_request_items: report.purchaseRequestItems.length, inhouse_production_requests: report.inhouseProductionRequests.length,
                  outsource_requirements: report.outsourceRequirements.length, vendor_quotations: report.vendorQuotations.length,
                  purchase_vendor_selections: report.purchaseVendorSelections.length, purchase_approvals: report.purchaseApprovals.length,
                  purchase_orders: report.purchaseOrders.length, purchase_costing: report.purchaseCosting.length,
                  purchase_checklist_results: report.purchaseChecklistResults.length, vendor_followups: report.vendorFollowups.length,
                  purchase_receipts: report.purchaseReceipts.length, purchase_payment_coordination: report.purchasePaymentCoordination.length,
                  purchase_attachments: report.purchaseAttachments.length, purchase_requests: report.purchaseRequests.length,
                };
                const match = dbCount === reportCounts[table];
                return (
                  <div key={table} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
                    <span>{table}</span>
                    <span className="sub">{t("statusLabel", lang)} DB={dbCount ?? "—"} / Report={reportCounts[table]}</span>
                    <span className={`badge ${match ? "VERIFIED" : "RETURNED"}`}>{match ? t("matchLabel", lang) : t("mismatchLabel", lang)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DownloadButton({ storagePath, lang }) {
  return storagePath ? (
    <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => openAttachment(storagePath)}>{t("download", lang)}</button>
  ) : (
    <span className="sub">{t("noFileAttachedLabel", lang)}</span>
  );
}

function AttachmentSection({ id, lang, titleKey, rows, personName }) {
  return (
    <div className="card" id={id}>
      <h2>{t(titleKey, lang)}</h2>
      {rows.length === 0 && <EmptySection lang={lang} />}
      {rows.map((r) => (
        <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap", gap: 6 }}>
          <span>{r.title || r.file_name} {r.version ? `(${r.version})` : ""}</span>
          <span className="sub">{personName(r.uploaded_by)} · {(r.created_at || "").slice(0, 10)}</span>
          {r.note && <span className="sub">{t("notesLabel", lang)}: {r.note}</span>}
          <DownloadButton storagePath={r.storage_path} lang={lang} />
        </div>
      ))}
    </div>
  );
}
