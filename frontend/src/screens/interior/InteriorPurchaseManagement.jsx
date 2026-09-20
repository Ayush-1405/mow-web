import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import { formatCurrency } from "../../lib/retailModules";
import { subscribeTable } from "../../lib/realtime";
import { useForegroundRefresh } from "../../lib/useForegroundRefresh";
import {
  listProjects, listInteriorPeople,
  listFactoryLocations, listVendors, createVendor,
  listPurchaseChecklistItems, listPurchaseRequests, listAllPurchaseRequests,
  createPurchaseRequest, updatePurchaseRequest, archivePurchaseRequest,
  listPurchaseRequestItems, createPurchaseRequestItem, updatePurchaseRequestItem,
  getInhouseProductionRequest,
  listFactoryDrawingsForJob, factoryUploadDrawing, getAttachmentUrl,
  uploadFactoryAttachment, removeFactoryAttachmentFile, deleteWorkingDrawingAttachment,
  getOutsourceRequirement, upsertOutsourceRequirement,
  listVendorQuotations, createVendorQuotation, listPurchaseVendorSelections, selectPurchaseVendor,
  listPurchaseApprovals, decidePurchaseApproval,
  listPurchaseOrders, createPurchaseOrder, revisePurchaseOrder, acknowledgePurchaseOrder,
  getPurchaseCosting, upsertPurchaseCosting,
  listPurchaseChecklistResults, listPurchaseChecklistResultHistory, upsertPurchaseChecklistResult,
  listVendorFollowups, createVendorFollowup,
  listPurchaseReceipts, createPurchaseReceipt,
  listPurchasePaymentCoordination, createPurchasePaymentCoordination, updatePurchasePaymentCoordination,
  uploadPurchaseAttachment, listPurchaseAttachments, deletePurchaseAttachment,
} from "../../lib/interiorApi";
import { AttachmentUploader, AttachmentList, ViewDownloadButton, CreateTaskButton } from "./InteriorWorkingDrawings.jsx";
import InteriorActivityHistory from "./InteriorActivityHistory.jsx";
import { submitJobCard, uploadJobFile, FACTORY_FILE_MAX_MB } from "../../lib/factoryApi";
import { friendlyRpcError } from "../factory/factoryConstants";

const OUTSOURCE_TYPES = [
  "Finished Goods Purchase", "Vendor Manufacturing/Job Work", "Material-Only Purchase",
  "Labour-Only Contract", "Labour + Material Contract", "Turnkey Agency/Subcontract",
  "Direct-to-Site Vendor Supply", "Vendor Supply to Warehouse", "Other",
];
const PRIORITIES = ["Normal", "High", "Urgent", "Emergency"];
const APPROVAL_LEVELS = [
  "Purchase Review Pending", "Department Head Approval Pending", "Management Approval Pending", "Accounts Review Pending",
];
const ORDER_TYPES = ["Purchase Order", "Work Order", "Labour Contract", "Labour + Material Contract", "Job-Work Order", "Turnkey/Subcontract Order"];
const CHECKLIST_STATUSES = ["Not Started", "In Progress", "Completed", "Correction Required", "Not Applicable"];
const PAYMENT_STATUSES = ["Not Due", "Advance Requested", "Approval Pending", "Submitted to Accounts", "Partially Paid", "Paid", "On Hold", "Disputed", "Overdue"];
const BOARD_STAGES = [
  "Draft", "Awaiting Source Selection", "In-house Submitted", "Factory in Progress", "Outsource RFQ",
  "Vendor Comparison", "Approval Pending", "PO/WO Pending", "Ordered", "Vendor in Progress", "QC Pending",
  "Ready for Dispatch", "Delivered", "Installation Pending", "Payment Coordination", "Completed", "On Hold",
];
const REQUEST_ATTACHMENT_CATEGORIES = [
  "Requirement Image", "Material Sample", "Material Approval", "Working Drawing", "RFQ", "Vendor Quotation",
  "Comparison Sheet", "Cost Sheet", "Approval Proof", "PO/WO", "Vendor Acknowledgement", "Production Progress Photo",
  "QC Photo", "Packing Photo", "Invoice", "Delivery Challan", "E-way Bill", "GRN", "POD", "Warranty",
  "Payment Request", "Voice Note", "Video", "Other",
];

const STATUS_BADGE = {
  Draft: "CLOSED", "Awaiting Source Selection": "ASSIGNED", "In-house Submitted": "ASSIGNED", "Factory in Progress": "IN_PROGRESS",
  "Outsource RFQ": "ASSIGNED", "Vendor Comparison": "ASSIGNED", "Approval Pending": "ASSIGNED", Approved: "VERIFIED", Rejected: "RETURNED",
  "Vendor Selected": "ACCEPTED", "PO Issued": "COMPLETED", "PO/WO Pending": "ASSIGNED", Ordered: "COMPLETED", "Vendor in Progress": "IN_PROGRESS",
  "QC Pending": "ASSIGNED", "Ready for Dispatch": "IN_PROGRESS", Delivered: "VERIFIED", "Installation Pending": "ASSIGNED",
  "Payment Coordination": "IN_PROGRESS", Completed: "VERIFIED", "On Hold": "REVISION",
};

function personName(people, id) {
  return people.find((p) => p.id === id)?.name || "—";
}

// Several Factory tables (factory_drawings.uploaded_by, production_stage_updates
// actor columns, etc.) store the auth-space id (user_profiles.id), not the
// Interior-roster profiles.id that `people` is normally keyed by — resolve
// through the auth_id field listInteriorPeople() already returns for exactly
// this reason (see FactoryJobOrders.jsx's identical helper).
function personNameByAuthId(people, authId) {
  return people.find((p) => p.auth_id === authId)?.name || "—";
}

const emptyRequestForm = {
  purchase_source: "", area_id: "", priority: "Normal", purpose: "", notes: "",
  assigned_purchase_person: "",
};
const emptyItemForm = {
  item_name: "", item_code: "", category: "", description: "", brand: "", colour: "", finish: "",
  size: "", thickness: "", hardware_spec: "", quantity: "", unit: "", required_at_location: "", required_by_date: "",
};

export default function InteriorPurchaseManagement({ lang, staffProfile, lockedProjectId: lockedProjectIdProp }) {
  const { projectId: routeProjectId } = useParams();
  const lockedProjectId = lockedProjectIdProp || routeProjectId;
  const profile = useInteriorProfile();
  const isElevated = !!staffProfile?.isManagement || !!staffProfile?.isSuperAdmin || !!staffProfile?.isDeptHead;
  const isOrgWide = isElevated || ["head", "director", "purchase", "crm"].includes(profile?.role);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [people, setPeople] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [factoryLocations, setFactoryLocations] = useState([]);
  const [checklistItems, setChecklistItems] = useState([]);
  const [projectId, setProjectId] = useState("");

  const [view, setView] = useState("list"); // list | board | detail
  const [requests, setRequests] = useState([]);
  const [boardRequests, setBoardRequests] = useState([]);
  const [legacyMaterials, setLegacyMaterials] = useState([]);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState(emptyRequestForm);

  const [requestId, setRequestId] = useState("");
  const [activeTab, setActiveTab] = useState("request");
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data, error: err }, peopleRes, vendorsRes, locRes, itemsRes] = await Promise.all([
      listProjects(), listInteriorPeople(), listVendors(), listFactoryLocations(), listPurchaseChecklistItems(),
    ]);
    if (err) { setError(true); setLoading(false); return; }
    setProjects(data || []);
    setPeople(peopleRes.data || []);
    setVendors(vendorsRes.data || []);
    setFactoryLocations(locRes.data || []);
    setChecklistItems(itemsRes.data || []);
    if (data?.length) setProjectId((cur) => cur || lockedProjectId || data[0].id);
    setLoading(false);
  }, [lockedProjectId]);

  useEffect(() => { load(); }, [load]);

  const loadRequests = useCallback(async () => {
    if (!projectId) { setRequests([]); return; }
    const [{ data }, legacyRes] = await Promise.all([
      listPurchaseRequests(projectId),
      Promise.resolve({ data: [] }), // legacy project_materials fetched via listAllPurchaseRequests board only, kept simple here
    ]);
    setRequests(data || []);
    setLegacyMaterials(legacyRes.data || []);
  }, [projectId]);

  useEffect(() => { loadRequests(); }, [loadRequests]);

  const loadBoard = useCallback(async () => {
    const { data } = await listAllPurchaseRequests();
    setBoardRequests(data || []);
  }, []);

  useEffect(() => { if (view === "board") loadBoard(); }, [view, loadBoard]);

  // Skeleton only the FIRST time a request's detail loads. Every later
  // refresh (realtime event, returning to the tab, a save) swaps the data in
  // place -- swapping the panels for a skeleton unmounted whatever form the
  // user was filling in, including a file they had just picked to upload.
  const detailLoadedFor = useRef(null);
  const loadDetail = useCallback(async () => {
    if (!requestId) { setDetail(null); detailLoadedFor.current = null; return; }
    if (detailLoadedFor.current !== requestId) setDetailLoading(true);
    const [
      itemsRes, inhouseRes, outsourceRes, quotationsRes, selectionsRes, approvalsRes,
      ordersRes, costingRes, checklistResultsRes, followupsRes, receiptsRes, paymentsRes, attachmentsRes,
    ] = await Promise.all([
      listPurchaseRequestItems(requestId), getInhouseProductionRequest(requestId), getOutsourceRequirement(requestId),
      listVendorQuotations(requestId), listPurchaseVendorSelections(requestId), listPurchaseApprovals(requestId),
      listPurchaseOrders(requestId), getPurchaseCosting(requestId), listPurchaseChecklistResults(requestId),
      listVendorFollowups(requestId), listPurchaseReceipts(requestId), listPurchasePaymentCoordination(requestId, isOrgWide),
      listPurchaseAttachments(requestId),
    ]);
    setDetail({
      items: itemsRes.data || [], inhouse: inhouseRes.data || null, outsource: outsourceRes.data || null,
      quotations: quotationsRes.data || [], selections: selectionsRes.data || [], approvals: approvalsRes.data || [],
      orders: ordersRes.data || [], costing: costingRes.data || null, checklistResults: checklistResultsRes.data || [],
      followups: followupsRes.data || [], receipts: receiptsRes.data || [], payments: paymentsRes.data || [],
      attachments: attachmentsRes.data || [],
    });
    detailLoadedFor.current = requestId;
    setDetailLoading(false);
  }, [requestId, isOrgWide]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  const refreshDetail = useCallback(() => { loadDetail(); }, [loadDetail]);
  const refreshAll = useCallback(() => { loadRequests(); loadDetail(); }, [loadRequests, loadDetail]);

  useEffect(() => {
    if (!projectId) return undefined;
    const unsubR = subscribeTable(`project-${projectId}-purchase_requests`, "purchase_requests", `project_id=eq.${projectId}`, () => refreshAll());
    const unsubA = subscribeTable(`project-${projectId}-purchase_attachments`, "purchase_attachments", `project_id=eq.${projectId}`, () => refreshDetail());
    // Factory Job stage/status changes -- so the Factory Reference summary
    // (current stage, status, completion) updates live without a reload.
    const unsubJob = subscribeTable(`project-${projectId}-inhouse_production_requests`, "inhouse_production_requests", `project_id=eq.${projectId}`, () => refreshDetail());
    return () => { unsubR(); unsubA(); unsubJob(); };
  }, [projectId, refreshAll, refreshDetail]);

  useEffect(() => {
    // New/updated Factory reference attachments for the currently-open job --
    // separate effect since the job id is only known once detail has loaded.
    const jobId = detail?.inhouse?.id;
    if (!jobId) return undefined;
    const unsubDrawings = subscribeTable(`inhouse-${jobId}-factory_drawings`, "factory_drawings", `job_id=eq.${jobId}`, () => refreshDetail());
    return () => { unsubDrawings(); };
  }, [detail?.inhouse?.id, refreshDetail]);

  useForegroundRefresh(refreshAll);

  const currentRequest = requests.find((r) => r.id === requestId) || boardRequests.find((r) => r.id === requestId) || null;

  // In-house/Factory requests get ONE simplified "Factory / In-house" tab and
  // nothing else (Request/Checklist/GRN-QC/Payment Coordination/Attachments/
  // Activity History/Archive are all hidden here, per explicit request — none
  // of their underlying tables/records are touched, only this page's
  // navigation). Outsourced requests are completely unaffected: same full
  // tab set as before.
  const isInHouseOnly = currentRequest?.purchase_source === "in_house";
  const tabs = useMemo(() => {
    if (isInHouseOnly) return [["inhouse", "Factory / In-house"]];
    const base = [["request", "Request"], ["checklist", "Checklist"]];
    if (currentRequest?.purchase_source === "outsourced") {
      base.splice(1, 0, ["outsource", "Outsource / Vendor"]);
      base.push(["followup", "Vendor Follow-up"]);
    }
    base.push(["grn", "GRN / QC"], ["payment", "Payment Coordination"], ["files", "All Attachments"], ["activity", "Activity History"]);
    return base;
  }, [currentRequest, isInHouseOnly]);

  useEffect(() => {
    if (isInHouseOnly && activeTab !== "inhouse") setActiveTab("inhouse");
  }, [isInHouseOnly, activeTab]);

  async function handleCreateRequest(e) {
    e.preventDefault();
    if (!newForm.purchase_source) return;
    const payload = {
      project_id: projectId, area_id: newForm.area_id || null, purchase_source: newForm.purchase_source,
      priority: newForm.priority, purpose: newForm.purpose || null, notes: newForm.notes || null,
      requested_by: profile?.id || null, assigned_purchase_person: newForm.assigned_purchase_person || null,
      status: newForm.purchase_source === "in_house" ? "Draft" : "Awaiting Source Selection",
    };
    const { data, error: err } = await createPurchaseRequest(payload, profile?.id);
    if (!err) {
      setShowNewForm(false);
      setNewForm(emptyRequestForm);
      await loadRequests();
      setRequestId(data.id);
      setView("detail");
      setActiveTab("request");
    }
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

  const project = projects.find((p) => p.id === projectId);

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🛒</div>
        <div className="dept-header-text">
          <h1>{t("purchaseManagementTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>{t("selectProjectLabel", lang)}</label>
          {lockedProjectId ? (
            <div className="sub" style={{ fontWeight: 700, marginTop: 4 }}>{project ? `${project.project_code} — ${project.customer}` : "—"}</div>
          ) : (
            <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setRequestId(""); setView("list"); }}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
            </select>
          )}
        </div>
        <div className="btn-row">
          <button className={`btn ${view === "list" ? "btn-primary" : "btn-outline"}`} style={{ width: "auto" }} onClick={() => setView("list")}>{t("tabPurchase", lang)}</button>
          <button className={`btn ${view === "board" ? "btn-primary" : "btn-outline"}`} style={{ width: "auto" }} onClick={() => setView("board")}>{t("purchaseBoardTitle", lang)}</button>
        </div>
      </div>

      {view === "board" && (
        <PurchaseBoardPanel lang={lang} requests={boardRequests} projects={projects} people={people}
          onOpen={(r) => { setProjectId(r.project_id); setRequestId(r.id); setView("detail"); setActiveTab("request"); }} />
      )}

      {view === "list" && (
        <div className="card">
          <button className="btn btn-outline" style={{ width: "auto" }} onClick={() => setShowNewForm((s) => !s)}>+ {t("newPurchaseRequestAction", lang)}</button>
          {showNewForm && (
            <form onSubmit={handleCreateRequest} className="form-grid" style={{ marginTop: 10 }}>
              <div className="field">
                <label>{t("purchaseSourceLabel", lang)} *</label>
                <div className="btn-row">
                  <button type="button" className={`btn ${newForm.purchase_source === "in_house" ? "btn-primary" : "btn-outline"}`}
                    style={{ width: "auto", padding: "18px 24px" }} onClick={() => setNewForm((f) => ({ ...f, purchase_source: "in_house" }))}>
                    🏭 {t("inHouseProductionLabel", lang)}
                  </button>
                  <button type="button" className={`btn ${newForm.purchase_source === "outsourced" ? "btn-primary" : "btn-outline"}`}
                    style={{ width: "auto", padding: "18px 24px" }} onClick={() => setNewForm((f) => ({ ...f, purchase_source: "outsourced" }))}>
                    🚚 {t("outsourcedLabel", lang)}
                  </button>
                </div>
              </div>
              <div className="field"><label>{t("priorityLabel", lang) || "Priority"}</label>
                <select value={newForm.priority} onChange={(e) => setNewForm((f) => ({ ...f, priority: e.target.value }))}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="field"><label>Assigned Purchase Person</label>
                <select value={newForm.assigned_purchase_person} onChange={(e) => setNewForm((f) => ({ ...f, assigned_purchase_person: e.target.value }))}>
                  <option value="">—</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="field"><label>Purpose</label><input value={newForm.purpose} onChange={(e) => setNewForm((f) => ({ ...f, purpose: e.target.value }))} /></div>
              <div className="field"><label>Notes</label><textarea rows={2} value={newForm.notes} onChange={(e) => setNewForm((f) => ({ ...f, notes: e.target.value }))} /></div>
              <button type="submit" className="btn btn-primary" disabled={!newForm.purchase_source}>{t("save", lang)}</button>
            </form>
          )}

          <div style={{ marginTop: 10 }}>
            {requests.length === 0 && <div className="msg info">{t("noRecordsForProject", lang)}</div>}
            {requests.map((r) => (
              <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700 }}>{r.request_number}</span>
                <span className="sub">{r.purchase_source === "in_house" ? t("inHouseProductionLabel", lang) : t("outsourcedLabel", lang)}</span>
                <span className={`badge ${STATUS_BADGE[r.status] || "CLOSED"}`}>{r.status}</span>
                <span className="sub">{r.priority}</span>
                <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }}
                  onClick={() => { setRequestId(r.id); setView("detail"); setActiveTab("request"); }}>{t("viewDetails", lang)}</button>
              </div>
            ))}
          </div>

          {legacyMaterials.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="sub" style={{ fontWeight: 700 }}>{t("legacyRecordsLabel", lang)}</div>
              {legacyMaterials.map((m) => (
                <div key={m.id} className="task-meta" style={{ padding: "4px 0" }}>
                  <span>{m.material}</span><span className="badge CLOSED">{m.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "detail" && requestId && (
        <>
          <div className="card">
            <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700 }}>{currentRequest?.request_number}</span>
              <span className={`badge ${STATUS_BADGE[currentRequest?.status] || "CLOSED"}`}>{currentRequest?.status}</span>
              {isElevated && !isInHouseOnly && (
                <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }}
                  onClick={async () => { await archivePurchaseRequest(projectId, requestId); setRequestId(""); setView("list"); refreshAll(); }}>
                  {t("archiveAction", lang)}
                </button>
              )}
            </div>
            <div className="filter-bar" style={{ flexWrap: "wrap", marginTop: 8 }}>
              {tabs.map(([key, label]) => (
                <button key={key} className={`btn ${activeTab === key ? "btn-primary" : "btn-outline"}`} style={{ marginTop: 0, width: "auto" }}
                  onClick={() => setActiveTab(key)}>{label}</button>
              ))}
            </div>
          </div>

          {detailLoading || !detail ? <div className="skeleton-block" style={{ height: 200 }} /> : (
            <>
              {activeTab === "request" && (
                <RequestPanel lang={lang} projectId={projectId} request={currentRequest} items={detail.items} people={people}
                  profile={profile} isElevated={isElevated} onChanged={refreshAll} />
              )}
              {activeTab === "inhouse" && (
                <InhousePanel lang={lang} projectId={projectId} project={project} request={currentRequest} inhouse={detail.inhouse}
                  factoryLocations={factoryLocations} people={people} profile={profile} onChanged={refreshAll} />
              )}
              {activeTab === "outsource" && (
                <OutsourcePanel lang={lang} projectId={projectId} request={currentRequest} outsource={detail.outsource}
                  quotations={detail.quotations} selections={detail.selections} approvals={detail.approvals}
                  orders={detail.orders} costing={detail.costing} vendors={vendors} people={people} profile={profile}
                  isOrgWide={isOrgWide} onChanged={refreshAll} onVendorCreated={load} />
              )}
              {activeTab === "checklist" && (
                <PurchaseChecklistPanel lang={lang} projectId={projectId} requestId={requestId} items={checklistItems}
                  results={detail.checklistResults} people={people} profile={profile} onChanged={refreshDetail} />
              )}
              {activeTab === "followup" && (
                <FollowupPanel lang={lang} projectId={projectId} request={currentRequest} followups={detail.followups}
                  vendors={vendors} people={people} profile={profile} onChanged={refreshDetail} />
              )}
              {activeTab === "grn" && (
                <GrnPanel lang={lang} projectId={projectId} request={currentRequest} receipts={detail.receipts}
                  orders={detail.orders} people={people} profile={profile} onChanged={refreshAll} />
              )}
              {activeTab === "payment" && (
                <PaymentCoordinationPanel lang={lang} projectId={projectId} request={currentRequest} payments={detail.payments}
                  isOrgWide={isOrgWide} profile={profile} onChanged={refreshDetail} />
              )}
              {activeTab === "files" && (
                <AllAttachmentsPanel lang={lang} projectId={projectId} requestId={requestId} attachments={detail.attachments}
                  people={people} profile={profile} isElevated={isElevated} onChanged={refreshDetail} />
              )}
              {activeTab === "activity" && (
                <InteriorActivityHistory lang={lang} projectId={projectId} isElevated={isElevated} />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

// =======================================================================
// Board (org-wide, mirrors the old InteriorPurchaseBoard.jsx)
// =======================================================================
function PurchaseBoardPanel({ lang, requests, projects, people, onOpen }) {
  const [filter, setFilter] = useState("");
  const projectLabel = (id) => { const p = projects.find((pr) => pr.id === id); return p ? `${p.project_code} — ${p.customer}` : "—"; };
  const counts = useMemo(() => { const c = {}; BOARD_STAGES.forEach((s) => { c[s] = requests.filter((r) => r.status === s).length; }); return c; }, [requests]);
  const filtered = filter ? requests.filter((r) => r.status === filter) : requests;

  return (
    <div className="card">
      <div className="kpi-grid kpi-grid-wide">
        {BOARD_STAGES.map((s) => (
          <button key={s} className={`kpi-tile${filter === s ? " gold" : ""}`} onClick={() => setFilter(filter === s ? "" : s)}>
            <div className="num">{counts[s] || 0}</div><div className="label">{s}</div>
          </button>
        ))}
      </div>
      {filtered.length === 0 && <div className="msg info" style={{ marginTop: 10 }}>{t("noRecordsYet", lang)}</div>}
      {filtered.map((r) => (
        <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700 }}>{r.request_number}</span>
          <span className="sub">{projectLabel(r.project_id)}</span>
          <span className="sub">{r.purchase_source === "in_house" ? t("inHouseProductionLabel", lang) : t("outsourcedLabel", lang)}</span>
          <span className={`badge ${STATUS_BADGE[r.status] || "CLOSED"}`}>{r.status}</span>
          <span className="sub">{personName(people, r.assigned_purchase_person)}</span>
          <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => onOpen(r)}>{t("viewDetails", lang)}</button>
        </div>
      ))}
    </div>
  );
}

// =======================================================================
// Request + line items
// =======================================================================
function RequestPanel({ lang, projectId, request, items, people, profile, isElevated, onChanged }) {
  const [showItemForm, setShowItemForm] = useState(false);
  const [itemForm, setItemForm] = useState(emptyItemForm);
  const [statusMsg, setStatusMsg] = useState("");

  async function handleAddItem(e) {
    e.preventDefault();
    await createPurchaseRequestItem({ ...itemForm, project_id: projectId, purchase_request_id: request.id, quantity: itemForm.quantity || null });
    setItemForm(emptyItemForm);
    setShowItemForm(false);
    onChanged();
  }

  async function handleItemStatus(item, status) {
    await updatePurchaseRequestItem(projectId, item.id, { status });
    onChanged();
  }

  async function handleBoardStatus(status) {
    setStatusMsg(t("saving", lang));
    const { error: err } = await updatePurchaseRequest(projectId, request.id, { status }, profile?.id);
    setStatusMsg(err ? t("errorSaving", lang) : t("saved", lang));
    onChanged();
  }

  return (
    <div className="card">
      <h2>Purchase Request</h2>
      <div className="dept-meta-grid">
        <div className="card dept-meta-tile"><div className="label">{t("purchaseSourceLabel", lang)}</div><div className="value">{request.purchase_source === "in_house" ? t("inHouseProductionLabel", lang) : t("outsourcedLabel", lang)}</div></div>
        <div className="card dept-meta-tile"><div className="label">Priority</div><div className="value">{request.priority}</div></div>
        <div className="card dept-meta-tile"><div className="label">Requested By</div><div className="value">{personName(people, request.requested_by)}</div></div>
        <div className="card dept-meta-tile"><div className="label">Assigned Purchase Person</div><div className="value">{personName(people, request.assigned_purchase_person)}</div></div>
        <div className="card dept-meta-tile"><div className="label">Request Date</div><div className="value">{request.request_date}</div></div>
      </div>
      {isElevated && (
        <div className="field" style={{ marginTop: 8 }}>
          <label>Board Status</label>
          <select value={request.status} onChange={(e) => handleBoardStatus(e.target.value)}>
            {BOARD_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {statusMsg && <div className="sub">{statusMsg}</div>}
        </div>
      )}
      {request.purpose && <div className="sub" style={{ marginTop: 6 }}>Purpose: {request.purpose}</div>}
      {request.notes && <div className="sub">Notes: {request.notes}</div>}

      <h3 style={{ marginTop: 14 }}>Line Items</h3>
      <button className="btn btn-outline" style={{ width: "auto" }} onClick={() => setShowItemForm((s) => !s)}>+ Add Line Item</button>
      {showItemForm && (
        <form onSubmit={handleAddItem} className="form-grid" style={{ marginTop: 10 }}>
          <div className="field"><label>Item name</label><input value={itemForm.item_name} onChange={(e) => setItemForm((f) => ({ ...f, item_name: e.target.value }))} required /></div>
          <div className="field"><label>Item code</label><input value={itemForm.item_code} onChange={(e) => setItemForm((f) => ({ ...f, item_code: e.target.value }))} /></div>
          <div className="field"><label>Category</label><input value={itemForm.category} onChange={(e) => setItemForm((f) => ({ ...f, category: e.target.value }))} /></div>
          <div className="field"><label>Description</label><textarea rows={2} value={itemForm.description} onChange={(e) => setItemForm((f) => ({ ...f, description: e.target.value }))} /></div>
          <div className="field"><label>Brand</label><input value={itemForm.brand} onChange={(e) => setItemForm((f) => ({ ...f, brand: e.target.value }))} /></div>
          <div className="field"><label>Colour</label><input value={itemForm.colour} onChange={(e) => setItemForm((f) => ({ ...f, colour: e.target.value }))} /></div>
          <div className="field"><label>Finish</label><input value={itemForm.finish} onChange={(e) => setItemForm((f) => ({ ...f, finish: e.target.value }))} /></div>
          <div className="field"><label>Size</label><input value={itemForm.size} onChange={(e) => setItemForm((f) => ({ ...f, size: e.target.value }))} /></div>
          <div className="field"><label>Thickness</label><input value={itemForm.thickness} onChange={(e) => setItemForm((f) => ({ ...f, thickness: e.target.value }))} /></div>
          <div className="field"><label>Hardware spec</label><input value={itemForm.hardware_spec} onChange={(e) => setItemForm((f) => ({ ...f, hardware_spec: e.target.value }))} /></div>
          <div className="field"><label>Quantity</label><input type="number" min="0" value={itemForm.quantity} onChange={(e) => setItemForm((f) => ({ ...f, quantity: e.target.value }))} required /></div>
          <div className="field"><label>Unit</label><input value={itemForm.unit} onChange={(e) => setItemForm((f) => ({ ...f, unit: e.target.value }))} /></div>
          <div className="field"><label>Required at location</label><input value={itemForm.required_at_location} onChange={(e) => setItemForm((f) => ({ ...f, required_at_location: e.target.value }))} /></div>
          <div className="field"><label>Required by date</label><input type="date" value={itemForm.required_by_date} onChange={(e) => setItemForm((f) => ({ ...f, required_by_date: e.target.value }))} required /></div>
          <button type="submit" className="btn btn-primary">{t("save", lang)}</button>
        </form>
      )}
      {items.length === 0 && <div className="msg info" style={{ marginTop: 10 }}>{t("noRecordsYet", lang)}</div>}
      {items.map((it) => (
        <div key={it.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700 }}>{it.item_name}</span>
          <span className="sub">{it.category} · {it.quantity} {it.unit}</span>
          <span className="sub">Required: {it.required_by_date}</span>
          <select value={it.status} onChange={(e) => handleItemStatus(it, e.target.value)}>
            {["Pending", "Costed", "Approved", "Ordered", "Manufactured", "Delivered", "Closed"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
}

// =======================================================================
// In-house workflow
// =======================================================================
// The only categories shown/uploadable on the simplified Purchase Request
// screen -- a subset of the full FACTORY_DRAWING_TYPES vocabulary (all 7
// values are already valid per factory_drawings_category_check, so no
// schema change is needed to restrict this page to them). The full 17-type
// list, revisions and approvals still live on the Factory Drawings screen.
const FACTORY_REFERENCE_CATEGORIES = [
  "Working Drawing", "Production Drawing", "3D Drawing", "Reference Photo",
  "Material Specification", "Job Card", "Others",
];
const REF_IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif"];
// What the Upload Factory Reference form itself accepts (a stricter subset of
// what the wider Working Drawings screen allows) -- matches FILE SUPPORT.
const FACTORY_REFERENCE_ALLOWED_EXTS = ["jpg", "jpeg", "png", "webp", "pdf", "dwg", "dxf"];
const FACTORY_REFERENCE_MAX_SIZE_MB = 15;
const FACTORY_REFERENCE_MAX_SIZE_BYTES = FACTORY_REFERENCE_MAX_SIZE_MB * 1024 * 1024;
function refExtOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

function ReferenceAttachmentThumb({ storagePath, title }) {
  const [url, setUrl] = useState(null);
  const isImage = REF_IMAGE_EXTS.includes(refExtOf(storagePath));
  useEffect(() => {
    let active = true;
    if (isImage) {
      getAttachmentUrl(storagePath).then((res) => { if (active) setUrl(res?.url || null); });
    }
    return () => { active = false; };
  }, [storagePath, isImage]);
  if (isImage && url) {
    return <img src={url} alt={title} style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", flexShrink: 0 }} />;
  }
  return (
    <div style={{ width: 56, height: 56, borderRadius: 6, border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }} aria-hidden="true">
      📄
    </div>
  );
}

// The entire simplified Purchase Request detail screen for In-house/Factory
// requests: Factory Reference summary, Reference Attachments and an Upload
// button -- nothing else. Reuses the exact same factory_drawings table +
// factory_upload_drawing RPC + interior-attachments bucket the full Factory
// Drawings screen and Job Card already use, so nothing new is created and no
// duplicate Factory Job can ever result (submitToFactory's own
// already-submitted guard, upstream of this screen, is what prevents that).
function FactoryReferenceView({ lang, project, request, inhouse, people, profile, onChanged, projectId }) {
  const [drawings, setDrawings] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadForm, setUploadForm] = useState({ title: "", category: FACTORY_REFERENCE_CATEGORIES[0], notes: "", file: null });
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState("");
  const [msgType, setMsgType] = useState("error");

  const loadFiles = useCallback(async () => {
    setLoadingFiles(true);
    const { data } = await listFactoryDrawingsForJob(inhouse.id);
    setDrawings((data || []).filter((d) => FACTORY_REFERENCE_CATEGORIES.includes(d.category)));
    setLoadingFiles(false);
  }, [inhouse.id]);

  useEffect(() => { loadFiles(); }, [loadFiles]);
  useEffect(() => subscribeTable(`pr-factoryref-${inhouse.id}-drawings`, "factory_drawings", `job_id=eq.${inhouse.id}`, loadFiles), [inhouse.id, loadFiles]);

  function fail(text) {
    setMsgType("error");
    setMsg(text);
  }

  async function handleUpload(e) {
    e.preventDefault();
    // Guards against a double-click/double-submit re-entering while the
    // first request is still in flight (the Save button is also disabled
    // below, but the form's own onSubmit can still fire twice on a fast
    // double-click before React re-renders the disabled state).
    if (uploading) return;
    setMsg("");

    // 1. Validate -- every check the request lists, in order, each with its
    // own user-facing message (no raw Supabase error reaches the UI here).
    const title = uploadForm.title.trim();
    if (!title) { fail("Please enter a title."); return; }
    if (!uploadForm.category) { fail("Please select a category."); return; }
    if (!uploadForm.file) { fail("Please select a file."); return; }
    if (!request?.id) { fail("This purchase request could not be found. Please reload the page."); return; }
    if (request.purchase_source !== "in_house") { fail("Factory references can only be uploaded for In-house/Factory requests."); return; }
    if (!profile?.id) { fail("You must be signed in to upload a file."); return; }
    if (!inhouse?.id) { fail("No Factory job exists yet for this request."); return; }

    const ext = refExtOf(uploadForm.file.name);
    if (!FACTORY_REFERENCE_ALLOWED_EXTS.includes(ext)) {
      fail("This file type is not supported. Allowed: JPG, PNG, WEBP, PDF, DWG, DXF.");
      return;
    }
    if (uploadForm.file.size > FACTORY_REFERENCE_MAX_SIZE_BYTES) {
      fail(`This file is too large. Maximum size is ${FACTORY_REFERENCE_MAX_SIZE_MB} MB.`);
      return;
    }

    setUploading(true);

    // 2. Upload the file to Storage.
    const { data: attachmentRow, path, error: uploadErr } = await uploadFactoryAttachment({
      projectId, module: "factory_drawing", relatedRecordId: inhouse.id, file: uploadForm.file,
      fileCategory: uploadForm.category, description: uploadForm.notes.trim() || null, uploadedBy: profile.id,
    });
    if (uploadErr) {
      console.error("[FactoryReferenceView] uploadFactoryAttachment failed", uploadErr);
      setUploading(false);
      if (uploadErr.code === "42501" || uploadErr.status === 403) fail("You do not have permission to upload.");
      else fail("Upload failed. Please try again.");
      return;
    }

    // 3. Insert the reference metadata row (factory_drawings -- the real,
    // existing table every Job Card / Factory Drawings screen already reads
    // reference files from; uploaded_by is resolved server-side from
    // auth.uid(), so no client-supplied id can ever be wrong here).
    const { error: drawErr } = await factoryUploadDrawing(inhouse.id, uploadForm.category, title, path, {
      note: uploadForm.notes.trim() || null,
    });
    if (drawErr) {
      console.error("[FactoryReferenceView] factoryUploadDrawing failed", drawErr);
      // Atomic failure handling: the Storage object + the working_drawing_attachments
      // row above already succeeded, but the actual reference record didn't --
      // best-effort cleanup of both so no orphan is left behind. This can
      // itself be blocked by storage/table RLS for non-management accounts
      // (physical purge is intentionally an elevated-only action in this
      // app); when that happens the row/file are simply invisible (nothing
      // references them) rather than truly removed, which is safe.
      if (attachmentRow?.id) {
        deleteWorkingDrawingAttachment(projectId, attachmentRow.id).catch((cleanupErr) => console.error("[FactoryReferenceView] orphan row cleanup failed", cleanupErr));
      }
      removeFactoryAttachmentFile(path).catch((cleanupErr) => console.error("[FactoryReferenceView] orphan file cleanup failed", cleanupErr));
      setUploading(false);
      fail("Could not save the reference file. Please try again.");
      return;
    }

    // 5. Success -- close, clear, refresh, and confirm.
    setUploading(false);
    setUploadForm({ title: "", category: FACTORY_REFERENCE_CATEGORIES[0], notes: "", file: null });
    setUploadOpen(false);
    setMsgType("success");
    setMsg("Factory reference uploaded successfully.");
    loadFiles();
    onChanged();
  }

  return (
    <div className="card">
      <h2>Factory / In-house</h2>
      <div style={{ marginBottom: 8 }}><Link to={`/factory-job/${inhouse.id}`} className="fx-tag gold">Open Factory Job Card →</Link></div>

      <h3 style={{ marginTop: 0 }}>Factory Reference</h3>
      <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <div className="field"><label>Factory Reference Number</label><div className="sub" style={{ fontWeight: 700 }}>{request?.request_number || "—"}</div></div>
        <div className="field"><label>Factory Job/Order Number</label><div className="sub" style={{ fontWeight: 700 }}>{inhouse.job_order_number || "—"}</div></div>
        <div className="field"><label>Project / Site</label><div className="sub">{project ? `${project.project_code} — ${project.customer}` : "—"}</div></div>
        <div className="field"><label>Product / Item</label><div className="sub">{inhouse.product_item || "—"}</div></div>
        <div className="field"><label>Quantity</label><div className="sub">{inhouse.quantity != null ? `${inhouse.quantity} ${inhouse.unit || ""}`.trim() : "—"}</div></div>
        <div className="field"><label>Required Date</label><div className="sub">{inhouse.required_completion_date || "—"}</div></div>
        <div className="field"><label>Current Stage</label><div className="sub">{inhouse.current_stage || "—"}</div></div>
        <div className="field"><label>Factory Status</label><div><span className={`badge ${STATUS_BADGE[inhouse.status] || "ASSIGNED"}`}>{inhouse.status || "—"}</span></div></div>
        <div className="field"><label>Assigned Factory Person</label><div className="sub">{personName(people, inhouse.assigned_factory_coordinator)}</div></div>
        <div className="field"><label>Created By</label><div className="sub">{personName(people, inhouse.submitted_by)}</div></div>
        <div className="field"><label>Created Date</label><div className="sub">{inhouse.submitted_at ? new Date(inhouse.submitted_at).toLocaleString() : "—"}</div></div>
        <div className="field full"><label>Notes</label><div className="sub">{inhouse.special_instructions || "—"}</div></div>
      </div>

      <h3>Reference Attachments</h3>
      {loadingFiles ? (
        <div className="skeleton-block" style={{ height: 60 }} />
      ) : drawings.length === 0 ? (
        <div className="msg info">{t("noFileAttachedLabel", lang)}</div>
      ) : (
        drawings.map((d) => (
          <div key={d.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <ReferenceAttachmentThumb storagePath={d.storage_path} title={d.title} />
            <div style={{ flex: 1, minWidth: 160 }}>
              <div style={{ fontWeight: 700 }}>{d.title}</div>
              <div className="sub">
                {d.category === "Others" && d.custom_category_name ? d.custom_category_name : d.category}
                {" · "}{personNameByAuthId(people, d.uploaded_by)}
                {" · "}{d.uploaded_at ? new Date(d.uploaded_at).toLocaleDateString() : "—"}
              </div>
              {d.note && <div className="sub">{d.note}</div>}
            </div>
            <ViewDownloadButton lang={lang} storagePath={d.storage_path} fileName={d.title} />
          </div>
        ))
      )}

      {!uploadOpen ? (
        <button type="button" className="btn btn-primary" style={{ marginTop: 10, width: "auto" }} onClick={() => setUploadOpen(true)}>
          Upload Factory Reference
        </button>
      ) : (
        <form onSubmit={handleUpload} className="form-grid" style={{ marginTop: 10, border: "1px dashed var(--border)", padding: 10 }}>
          <div className="field"><label>Title *</label><input value={uploadForm.title} onChange={(e) => setUploadForm((f) => ({ ...f, title: e.target.value }))} required disabled={uploading} /></div>
          <div className="field"><label>Category *</label>
            <select value={uploadForm.category} onChange={(e) => setUploadForm((f) => ({ ...f, category: e.target.value }))} required disabled={uploading}>
              {FACTORY_REFERENCE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field"><label>File *</label>
            <input type="file" accept=".jpg,.jpeg,.png,.webp,.pdf,.dwg,.dxf" onChange={(e) => setUploadForm((f) => ({ ...f, file: e.target.files?.[0] || null }))} required disabled={uploading} />
            <div className="sub" style={{ marginTop: 4 }}>JPG, PNG, WEBP, PDF, DWG or DXF — max {FACTORY_REFERENCE_MAX_SIZE_MB} MB.</div>
          </div>
          <div className="field full"><label>Notes</label><textarea rows={2} value={uploadForm.notes} onChange={(e) => setUploadForm((f) => ({ ...f, notes: e.target.value }))} disabled={uploading} /></div>
          <div className="btn-row">
            <button type="submit" className="btn btn-primary" disabled={uploading}>{uploading ? "Saving…" : t("save", lang)}</button>
            <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={uploading} onClick={() => { setUploadOpen(false); setMsg(""); }}>{t("cancel", lang)}</button>
          </div>
        </form>
      )}
      {msg && <div className={`msg ${msgType}`} style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  );
}

// Send to Factory (In-house). Deliberately tiny: what is needed, how many,
// by when, and the drawings. Customer, site, project, requester and source
// department come from the request and project; the Job Card is created
// automatically and the Factory Head/Supervisor picks the team AFTER
// accepting it -- the sender never chooses a Factory employee.
const FACTORY_SEND_FILE_TYPES = ["Working Drawing", "Production Drawing", "3D Drawing", "Reference Photo", "Material Specification", "Job Card", "Others"];

function InhousePanel({ lang, projectId, project, request, inhouse, people, profile, onChanged }) {
  const [rows, setRows] = useState([{ item_name: "", quantity: "", unit: "Nos" }]);
  const [requiredDate, setRequiredDate] = useState("");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState([]);
  const [fileType, setFileType] = useState(FACTORY_SEND_FILE_TYPES[0]);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState(null);
  const idemKey = useRef(request?.id ? `pr:${request.id}` : crypto.randomUUID());

  const setRow = (i, patch) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setMsg(null);
    const items = rows.filter((r) => r.item_name.trim()).map((r) => ({
      item_name: r.item_name.trim(), quantity: r.quantity === "" ? null : Number(r.quantity), unit: r.unit.trim() || null,
    }));
    if (items.length === 0) { setMsg({ type: "error", text: "Please add at least one item." }); return; }
    if (items.some((i) => i.quantity !== null && !(i.quantity >= 0))) { setMsg({ type: "error", text: "Quantity must be a number." }); return; }
    if (!requiredDate) { setMsg({ type: "error", text: "Please choose the required date." }); return; }

    setSubmitting(true);
    const { data, error } = await submitJobCard({
      idempotencyKey: idemKey.current, sourceModule: "interior", sourceReference: request.request_number, sourceRecordId: request.id,
      projectId, customerName: project?.customer, siteLocation: project?.location, title: items[0].item_name,
      requiredDate, priority: request.priority && ["Normal", "High", "Urgent", "Emergency"].includes(request.priority) ? request.priority : "Normal",
      notes: notes.trim() || request.purpose || null, items, purchaseRequestId: request.id,
    });
    if (error) {
      setSubmitting(false);
      console.error("[Send to Factory] failed", error);
      setMsg({ type: "error", text: friendlyRpcError(error, "Could not send to Factory. Please try again.") });
      return;
    }
    if (data.already_submitted) {
      setSubmitting(false);
      setMsg({ type: "info", text: t("alreadySubmittedMsg", lang) });
      onChanged();
      return;
    }
    let failed = 0;
    for (let i = 0; i < files.length; i++) {
      setMsg({ type: "info", text: `Uploading file ${i + 1} of ${files.length}…` });
      const r = await uploadJobFile(data.job_id, files[i], fileType, files[i].name);
      if (r.error) { failed += 1; console.error("[Send to Factory] file upload failed", r.error); }
    }
    setSubmitting(false);
    setMsg({
      type: failed ? "error" : "success",
      text: failed
        ? `Job Card ${data.job_order_number} was created, but ${failed} file(s) could not be uploaded. Open the Job Card to add them again.`
        : `Sent to Factory — Job Card ${data.job_order_number} created.`,
    });
    onChanged();
  }

  if (inhouse) {
    return <FactoryReferenceView lang={lang} projectId={projectId} project={project} request={request} inhouse={inhouse} people={people} profile={profile} onChanged={onChanged} />;
  }

  return (
    <div className="card">
      <h2>Send to Factory</h2>
      <div className="sub" style={{ marginBottom: 8 }}>
        Project: <strong>{project ? `${project.project_code} — ${project.customer}` : "—"}</strong>. Factory will verify the details and choose the team — you do not select a Factory employee.
      </div>
      <form onSubmit={handleSubmit} className="form-grid">
        <div className="field full">
          <label>Items needed *</label>
          {rows.map((r, i) => (
            <div key={i} className="form-grid" style={{ gridTemplateColumns: "2fr 1fr 1fr auto", marginBottom: 6 }}>
              <input placeholder="Item / product" value={r.item_name} onChange={(e) => setRow(i, { item_name: e.target.value })} disabled={submitting} />
              <input type="number" min="0" placeholder="Qty" value={r.quantity} onChange={(e) => setRow(i, { quantity: e.target.value })} disabled={submitting} />
              <input placeholder="Unit" value={r.unit} onChange={(e) => setRow(i, { unit: e.target.value })} disabled={submitting} />
              {rows.length > 1 && <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))} disabled={submitting} aria-label="Remove item">✕</button>}
            </div>
          ))}
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setRows((rs) => [...rs, { item_name: "", quantity: "", unit: "Nos" }])} disabled={submitting}>+ Add item</button>
        </div>
        <div className="field"><label>Required date *</label><input type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} disabled={submitting} /></div>
        <div className="field full"><label>Notes for Factory (optional)</label><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={submitting} /></div>
        <div className="field"><label>File type</label>
          <select value={fileType} onChange={(e) => setFileType(e.target.value)} disabled={submitting}>{FACTORY_SEND_FILE_TYPES.map((ft) => <option key={ft} value={ft}>{ft}</option>)}</select></div>
        <div className="field full"><label>Drawings / photos / files (optional)</label>
          <input type="file" multiple accept=".jpg,.jpeg,.png,.webp,.pdf,.dwg,.dxf,.xlsx,.xls,.csv,.docx" disabled={submitting}
            onChange={(e) => {
              const picked = Array.from(e.target.files || []);
              if (picked.some((f) => f.size > FACTORY_FILE_MAX_MB * 1024 * 1024)) { setMsg({ type: "error", text: `Each file must be under ${FACTORY_FILE_MAX_MB} MB.` }); e.target.value = ""; return; }
              setMsg(null); setFiles(picked);
            }} />
          {files.length > 0 && <div className="sub">{files.map((f) => f.name).join(", ")}</div>}
          <div className="sub">If you have no drawing yet, send without one — Factory will ask for it.</div>
        </div>
        <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? "Sending…" : t("submitToFactoryLabel", lang)}</button>
        {msg && <div className={`msg ${msg.type}`} style={{ gridColumn: "1 / -1" }}>{msg.text}</div>}
      </form>
    </div>
  );
}

// =======================================================================
// Outsource workflow — type, vendor quotations, comparison, selection, approvals, PO/WO
// =======================================================================
function OutsourcePanel({ lang, projectId, request, outsource, quotations, selections, approvals, orders, costing, vendors, people, profile, isOrgWide, onChanged, onVendorCreated }) {
  const [typeForm, setTypeForm] = useState({ outsource_type: outsource?.outsource_type || OUTSOURCE_TYPES[0], outsource_type_other: outsource?.outsource_type_other || "" });
  const [quoteForm, setQuoteForm] = useState({ vendor_id: "", quotation_number: "", quotation_date: "", validity_date: "", material_rate: "", labour_rate: "", other_charges: "", tax: "", transport: "", installation: "", payment_terms: "", warranty: "", lead_time_days: "" });
  const [selectForm, setSelectForm] = useState({ selectedQuotationId: "", selectionReason: "", approvedAmount: "", justificationText: "" });
  const [approvalForm, setApprovalForm] = useState({ approval_level: APPROVAL_LEVELS[0], decision: "Approved", remarks: "", approved_amount: "" });
  const [poForm, setPoForm] = useState({ order_type: ORDER_TYPES[0], delivery_location: "", expected_dispatch_date: "", expected_delivery_date: "", scope_of_work: "", payment_terms: "", warranty: "", total_order_value: "" });
  const [newVendorForm, setNewVendorForm] = useState(null);
  const [msg, setMsg] = useState("");

  async function handleSaveType(e) {
    e.preventDefault();
    await upsertOutsourceRequirement(projectId, request.id, typeForm);
    await updatePurchaseRequest(projectId, request.id, { status: "Outsource RFQ" }, profile?.id);
    onChanged();
  }

  async function handleAddQuote(e) {
    e.preventDefault();
    if (!isOrgWide) return;
    await createVendorQuotation({ ...quoteForm, project_id: projectId, purchase_request_id: request.id }, profile?.id);
    setQuoteForm((f) => ({ ...f, vendor_id: "", quotation_number: "" }));
    await updatePurchaseRequest(projectId, request.id, { status: "Vendor Comparison" }, profile?.id);
    onChanged();
  }

  async function handleCreateVendor(e) {
    e.preventDefault();
    const { data, error: err } = await createVendor(newVendorForm, profile?.id);
    if (!err) { setNewVendorForm(null); onVendorCreated(); setQuoteForm((f) => ({ ...f, vendor_id: data.id })); }
  }

  async function handleSelectVendor(e) {
    e.preventDefault();
    setMsg("");
    const { error: err } = await selectPurchaseVendor(projectId, request.id, {
      selectedQuotationId: selectForm.selectedQuotationId, selectionReason: selectForm.selectionReason,
      approvedAmount: selectForm.approvedAmount || null, justificationText: selectForm.justificationText || null,
    }, profile?.id);
    if (err) setMsg(err.message);
    else { setMsg(t("saved", lang)); onChanged(); }
  }

  async function handleApprove(e) {
    e.preventDefault();
    await decidePurchaseApproval(projectId, request.id, approvalForm, profile?.id);
    onChanged();
  }

  const currentPo = orders.find((o) => o.is_current);

  async function handleCreatePo(e) {
    e.preventDefault();
    const selectedVendorId = selections[0]?.selected_vendor_id;
    const { data, error: err, alreadyExists } = await createPurchaseOrder(projectId, request.id, { ...poForm, vendor_id: selectedVendorId || null }, profile?.id);
    if (!err) {
      if (isOrgWide) await upsertPurchaseCosting(projectId, request.id, { purchase_order_id: data.id }, profile?.id);
      setMsg(alreadyExists ? t("alreadySubmittedMsg", lang) : t("saved", lang));
      onChanged();
    }
  }

  async function handleRevisePo(e) {
    e.preventDefault();
    await revisePurchaseOrder(projectId, request.id, currentPo, poForm, profile?.id);
    onChanged();
  }

  async function handleAck() {
    await acknowledgePurchaseOrder(projectId, currentPo.id);
    onChanged();
  }

  const vendorName = (id) => vendors.find((v) => v.id === id)?.name || "—";

  return (
    <div className="card">
      <h2>Outsource / Vendor</h2>
      <form onSubmit={handleSaveType} className="form-grid">
        <div className="field"><label>Outsource Type</label>
          <select value={typeForm.outsource_type} onChange={(e) => setTypeForm((f) => ({ ...f, outsource_type: e.target.value }))}>
            {OUTSOURCE_TYPES.map((ot) => <option key={ot} value={ot}>{ot}</option>)}
          </select>
        </div>
        {typeForm.outsource_type === "Other" && (
          <div className="field"><label>Describe</label><input value={typeForm.outsource_type_other} onChange={(e) => setTypeForm((f) => ({ ...f, outsource_type_other: e.target.value }))} required /></div>
        )}
        <button type="submit" className="btn btn-outline" style={{ width: "auto" }}>{t("save", lang)}</button>
      </form>

      {isOrgWide ? (
        <>
          <h3 style={{ marginTop: 14 }}>Vendor Quotations</h3>
          <form onSubmit={handleAddQuote} className="form-grid">
            <div className="field"><label>{t("vendorNameLabel", lang)}</label>
              <div className="btn-row">
                <select value={quoteForm.vendor_id} onChange={(e) => setQuoteForm((f) => ({ ...f, vendor_id: e.target.value }))} required>
                  <option value="">—</option>
                  {vendors.map((v) => <option key={v.id} value={v.id} disabled={v.blacklisted}>{v.name}{v.blacklisted ? " (Blocked)" : ""}</option>)}
                </select>
                <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setNewVendorForm({ name: "", contact_person: "", mobile: "", gstin: "" })}>+ New Vendor</button>
              </div>
            </div>
            <div className="field"><label>Quotation Number</label><input value={quoteForm.quotation_number} onChange={(e) => setQuoteForm((f) => ({ ...f, quotation_number: e.target.value }))} /></div>
            <div className="field"><label>Quotation Date</label><input type="date" value={quoteForm.quotation_date} onChange={(e) => setQuoteForm((f) => ({ ...f, quotation_date: e.target.value }))} /></div>
            <div className="field"><label>Validity Date</label><input type="date" value={quoteForm.validity_date} onChange={(e) => setQuoteForm((f) => ({ ...f, validity_date: e.target.value }))} /></div>
            <div className="field"><label>{t("materialCostLabel", lang)}</label><input type="number" value={quoteForm.material_rate} onChange={(e) => setQuoteForm((f) => ({ ...f, material_rate: e.target.value }))} /></div>
            <div className="field"><label>{t("labourCostLabel", lang)}</label><input type="number" value={quoteForm.labour_rate} onChange={(e) => setQuoteForm((f) => ({ ...f, labour_rate: e.target.value }))} /></div>
            <div className="field"><label>Other Charges</label><input type="number" value={quoteForm.other_charges} onChange={(e) => setQuoteForm((f) => ({ ...f, other_charges: e.target.value }))} /></div>
            <div className="field"><label>Tax</label><input type="number" value={quoteForm.tax} onChange={(e) => setQuoteForm((f) => ({ ...f, tax: e.target.value }))} /></div>
            <div className="field"><label>Transport</label><input type="number" value={quoteForm.transport} onChange={(e) => setQuoteForm((f) => ({ ...f, transport: e.target.value }))} /></div>
            <div className="field"><label>Installation</label><input type="number" value={quoteForm.installation} onChange={(e) => setQuoteForm((f) => ({ ...f, installation: e.target.value }))} /></div>
            <div className="field"><label>Lead Time (days)</label><input type="number" value={quoteForm.lead_time_days} onChange={(e) => setQuoteForm((f) => ({ ...f, lead_time_days: e.target.value }))} /></div>
            <div className="field"><label>Payment Terms</label><input value={quoteForm.payment_terms} onChange={(e) => setQuoteForm((f) => ({ ...f, payment_terms: e.target.value }))} /></div>
            <div className="field"><label>Warranty</label><input value={quoteForm.warranty} onChange={(e) => setQuoteForm((f) => ({ ...f, warranty: e.target.value }))} /></div>
            <button type="submit" className="btn btn-primary">{t("save", lang)}</button>
          </form>

          {newVendorForm && (
            <form onSubmit={handleCreateVendor} className="form-grid" style={{ marginTop: 8, border: "1px dashed var(--border)", padding: 10 }}>
              <div className="field"><label>{t("vendorNameLabel", lang)}</label><input value={newVendorForm.name} onChange={(e) => setNewVendorForm((f) => ({ ...f, name: e.target.value }))} required /></div>
              <div className="field"><label>Contact Person</label><input value={newVendorForm.contact_person} onChange={(e) => setNewVendorForm((f) => ({ ...f, contact_person: e.target.value }))} /></div>
              <div className="field"><label>Mobile</label><input value={newVendorForm.mobile} onChange={(e) => setNewVendorForm((f) => ({ ...f, mobile: e.target.value }))} /></div>
              <div className="field"><label>GSTIN</label><input value={newVendorForm.gstin} onChange={(e) => setNewVendorForm((f) => ({ ...f, gstin: e.target.value }))} /></div>
              <button type="submit" className="btn btn-primary">{t("save", lang)}</button>
            </form>
          )}

          <h3 style={{ marginTop: 14 }}>{t("vendorComparisonLabel", lang)}</h3>
          <div style={{ overflowX: "auto" }}>
            {quotations.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
            {quotations.map((q) => (
              <div key={q.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700 }}>{vendorName(q.vendor_id)}</span>
                <span className="sub">Material {formatCurrency(q.material_rate)} · Labour {formatCurrency(q.labour_rate)} · Tax {formatCurrency(q.tax)} · Transport {formatCurrency(q.transport)}</span>
                <span className="sub">{t("totalCostLabel", lang)}: {formatCurrency(q.total_landed_cost)}</span>
                <span className="sub">{q.lead_time_days ? `${q.lead_time_days}d` : "—"}</span>
              </div>
            ))}
          </div>

          <form onSubmit={handleSelectVendor} className="form-grid" style={{ marginTop: 8 }}>
            <h3>Select Vendor</h3>
            <div className="field"><label>Quotation</label>
              <select value={selectForm.selectedQuotationId} onChange={(e) => setSelectForm((f) => ({ ...f, selectedQuotationId: e.target.value }))} required>
                <option value="">—</option>
                {quotations.map((q) => <option key={q.id} value={q.id}>{vendorName(q.vendor_id)} — {formatCurrency(q.total_landed_cost)}</option>)}
              </select>
            </div>
            <div className="field"><label>Selection Reason</label><textarea rows={2} value={selectForm.selectionReason} onChange={(e) => setSelectForm((f) => ({ ...f, selectionReason: e.target.value }))} required /></div>
            <div className="field"><label>Approved Amount</label><input type="number" value={selectForm.approvedAmount} onChange={(e) => setSelectForm((f) => ({ ...f, approvedAmount: e.target.value }))} /></div>
            <div className="field"><label>Justification (if not lowest bidder)</label><textarea rows={2} value={selectForm.justificationText} onChange={(e) => setSelectForm((f) => ({ ...f, justificationText: e.target.value }))} /></div>
            <button type="submit" className="btn btn-primary">{t("save", lang)}</button>
            {msg && <div className="msg info">{msg}</div>}
          </form>
          {selections.map((s) => (
            <div key={s.id} className="task-meta" style={{ padding: "4px 0", flexWrap: "wrap" }}>
              <span className="badge VERIFIED">{t("vendorComparisonLabel", lang)}: {vendorName(s.selected_vendor_id)}</span>
              {!s.is_lowest_bid && <span className="badge REVISION">Not lowest bid</span>}
              <span className="sub">{s.selection_reason}</span>
            </div>
          ))}

          <h3 style={{ marginTop: 14 }}>Approval</h3>
          <form onSubmit={handleApprove} className="form-grid">
            <div className="field"><label>Approval Level</label>
              <select value={approvalForm.approval_level} onChange={(e) => setApprovalForm((f) => ({ ...f, approval_level: e.target.value }))}>
                {APPROVAL_LEVELS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div className="field"><label>Decision</label>
              <select value={approvalForm.decision} onChange={(e) => setApprovalForm((f) => ({ ...f, decision: e.target.value }))}>
                <option value="Approved">Approved</option>
                <option value="Rejected">Rejected</option>
                <option value="Revision Required">Revision Required</option>
              </select>
            </div>
            <div className="field"><label>Approved Amount</label><input type="number" value={approvalForm.approved_amount} onChange={(e) => setApprovalForm((f) => ({ ...f, approved_amount: e.target.value }))} /></div>
            <div className="field"><label>Remarks</label><textarea rows={2} value={approvalForm.remarks} onChange={(e) => setApprovalForm((f) => ({ ...f, remarks: e.target.value }))} /></div>
            <button type="submit" className="btn btn-primary">{t("approveLabel", lang)}</button>
          </form>
          {approvals.map((a) => (
            <div key={a.id} className="task-meta" style={{ padding: "4px 0", flexWrap: "wrap" }}>
              <span className="sub">{a.approval_level}</span>
              <span className={`badge ${a.decision === "Approved" ? "VERIFIED" : a.decision === "Rejected" ? "RETURNED" : "ASSIGNED"}`}>{a.decision}</span>
              <span className="sub">{personName(people, a.decided_by)} · {a.decision_date}</span>
            </div>
          ))}

          <h3 style={{ marginTop: 14 }}>{t("purchaseOrderLabel", lang)}</h3>
          {currentPo ? (
            <div>
              <div className="task-meta" style={{ flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700 }}>{currentPo.po_number} ({currentPo.version_number})</span>
                <span className="badge ASSIGNED">{currentPo.status}</span>
                <span className="sub">{t("totalCostLabel", lang)}: {formatCurrency(currentPo.total_order_value)}</span>
                {currentPo.vendor_acknowledgement
                  ? <span className="badge VERIFIED">Acknowledged</span>
                  : <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={handleAck}>Record Vendor Acknowledgement</button>}
              </div>
              <form onSubmit={handleRevisePo} className="form-grid" style={{ marginTop: 8 }}>
                <div className="field"><label>Delivery Location (revision)</label><input value={poForm.delivery_location} onChange={(e) => setPoForm((f) => ({ ...f, delivery_location: e.target.value }))} /></div>
                <button type="submit" className="btn btn-outline" style={{ width: "auto" }}>+ New Revision</button>
              </form>
              {costing && (
                <div className="sub" style={{ marginTop: 6 }}>
                  {t("totalCostLabel", lang)}: {t("estimatedLabel", lang) || "Estimated"} {formatCurrency(costing.total_estimated_cost)} · {t("actualLabel", lang) || "Actual"} {formatCurrency(costing.total_actual_cost)}
                  {" · "}Variance {formatCurrency((costing.total_actual_cost || 0) - (costing.total_estimated_cost || 0))}
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={handleCreatePo} className="form-grid">
              <div className="field"><label>Order Type</label>
                <select value={poForm.order_type} onChange={(e) => setPoForm((f) => ({ ...f, order_type: e.target.value }))}>
                  {ORDER_TYPES.map((ot) => <option key={ot} value={ot}>{ot}</option>)}
                </select>
              </div>
              <div className="field"><label>Delivery Location</label><input value={poForm.delivery_location} onChange={(e) => setPoForm((f) => ({ ...f, delivery_location: e.target.value }))} /></div>
              <div className="field"><label>Expected Dispatch Date</label><input type="date" value={poForm.expected_dispatch_date} onChange={(e) => setPoForm((f) => ({ ...f, expected_dispatch_date: e.target.value }))} /></div>
              <div className="field"><label>Expected Delivery Date</label><input type="date" value={poForm.expected_delivery_date} onChange={(e) => setPoForm((f) => ({ ...f, expected_delivery_date: e.target.value }))} /></div>
              <div className="field"><label>Scope of Work</label><textarea rows={2} value={poForm.scope_of_work} onChange={(e) => setPoForm((f) => ({ ...f, scope_of_work: e.target.value }))} /></div>
              <div className="field"><label>Payment Terms</label><input value={poForm.payment_terms} onChange={(e) => setPoForm((f) => ({ ...f, payment_terms: e.target.value }))} /></div>
              <div className="field"><label>Warranty</label><input value={poForm.warranty} onChange={(e) => setPoForm((f) => ({ ...f, warranty: e.target.value }))} /></div>
              <div className="field"><label>{t("totalCostLabel", lang)}</label><input type="number" value={poForm.total_order_value} onChange={(e) => setPoForm((f) => ({ ...f, total_order_value: e.target.value }))} /></div>
              <button type="submit" className="btn btn-primary">Generate {poForm.order_type}</button>
            </form>
          )}
        </>
      ) : (
        <div className="msg info" style={{ marginTop: 10 }}>{t("costingRestrictedMsg", lang)}</div>
      )}
    </div>
  );
}

// =======================================================================
// Checklist
// =======================================================================
function PurchaseChecklistPanel({ lang, projectId, requestId, items, results, people, profile, onChanged }) {
  const [drafts, setDrafts] = useState({});
  const [historyFor, setHistoryFor] = useState(null);
  const [history, setHistory] = useState([]);

  const byCategory = useMemo(() => {
    const g = {};
    items.forEach((i) => { g[i.category] = g[i.category] || []; g[i.category].push(i); });
    return g;
  }, [items]);
  const resultFor = useCallback((itemId) => results.find((r) => r.checklist_item_id === itemId), [results]);
  const completionPct = useMemo(() => {
    if (items.length === 0) return 0;
    const done = items.filter((i) => { const r = resultFor(i.id); return r && (r.status === "Completed" || r.status === "Not Applicable"); }).length;
    return Math.round((done / items.length) * 100);
  }, [items, resultFor]);

  async function handleSave(item) {
    const draft = drafts[item.id] || {};
    const current = resultFor(item.id);
    const status = draft.status || current?.status || "Not Started";
    await upsertPurchaseChecklistResult(projectId, requestId, item.id, { status, remarks: draft.remarks ?? current?.remarks, reopen_reason: draft.reopen_reason || null }, profile?.id);
    setDrafts((d) => ({ ...d, [item.id]: {} }));
    onChanged();
  }

  async function viewHistory(itemId) {
    const { data } = await listPurchaseChecklistResultHistory(requestId, itemId);
    setHistory(data || []);
    setHistoryFor(itemId);
  }

  return (
    <div className="card">
      <h2>{t("checklistLabel", lang)}</h2>
      <div className="msg info">{t("checklistLabel", lang)}: {completionPct}%</div>
      {Object.entries(byCategory).map(([category, catItems]) => (
        <div key={category} style={{ marginTop: 12 }}>
          <h3>{category}</h3>
          {catItems.map((item) => {
            const r = resultFor(item.id);
            const draft = drafts[item.id] || {};
            return (
              <div key={item.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0", flexWrap: "wrap" }}>
                <span style={{ flex: 1, minWidth: 220 }}>{item.item_text_en}</span>
                <span className="sub">{r?.status || "Not Started"}</span>
                <select value={draft.status ?? r?.status ?? "Not Started"} onChange={(e) => setDrafts((d) => ({ ...d, [item.id]: { ...d[item.id], status: e.target.value } }))}>
                  {CHECKLIST_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => handleSave(item)}>{t("save", lang)}</button>
                <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => viewHistory(item.id)}>{t("viewHistoryAction", lang)}</button>
                {r && <span className="sub">{personName(people, r.checked_by)} {r.checked_date}</span>}
              </div>
            );
          })}
        </div>
      ))}
      {historyFor && (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="btn-row" style={{ justifyContent: "space-between" }}>
            <div className="sub" style={{ fontWeight: 700 }}>{t("viewHistoryAction", lang)}</div>
            <button className="btn btn-outline" style={{ width: "auto" }} onClick={() => setHistoryFor(null)}>{t("cancel", lang)}</button>
          </div>
          {history.map((h) => (
            <div key={h.id} className="task-meta" style={{ padding: "4px 0" }}>
              <span className="sub">{h.status}</span><span className="sub">{h.checked_date}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// =======================================================================
// Vendor follow-up
// =======================================================================
function FollowupPanel({ lang, projectId, request, followups, vendors, people, profile, onChanged }) {
  const [form, setForm] = useState({ vendor_id: "", next_follow_up_date: "", notes: "", escalation_status: "None" });

  async function handleAdd(e) {
    e.preventDefault();
    await createVendorFollowup({ ...form, project_id: projectId, purchase_request_id: request.id }, profile?.id);
    setForm({ vendor_id: "", next_follow_up_date: "", notes: "", escalation_status: "None" });
    onChanged();
  }

  return (
    <div className="card">
      <h2>{t("vendorFollowUpLabel", lang)}</h2>
      <form onSubmit={handleAdd} className="form-grid">
        <div className="field"><label>Vendor</label>
          <select value={form.vendor_id} onChange={(e) => setForm((f) => ({ ...f, vendor_id: e.target.value }))}>
            <option value="">—</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
        <div className="field"><label>Next Follow-up Date</label><input type="date" value={form.next_follow_up_date} onChange={(e) => setForm((f) => ({ ...f, next_follow_up_date: e.target.value }))} /></div>
        <div className="field"><label>Notes</label><textarea rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></div>
        <div className="field"><label>Escalation</label>
          <select value={form.escalation_status} onChange={(e) => setForm((f) => ({ ...f, escalation_status: e.target.value }))}>
            <option value="None">None</option><option value="Raised">Raised</option><option value="Resolved">Resolved</option>
          </select>
        </div>
        <button type="submit" className="btn btn-primary">{t("save", lang)}</button>
      </form>
      {followups.length === 0 && <div className="msg info" style={{ marginTop: 10 }}>{t("noRecordsYet", lang)}</div>}
      {followups.map((f) => (
        <div key={f.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0", flexWrap: "wrap" }}>
          <span>{vendors.find((v) => v.id === f.vendor_id)?.name || "—"}</span>
          <span className="sub">{f.follow_up_date} → {f.next_follow_up_date || "—"}</span>
          <span className="sub">{f.notes}</span>
          {f.escalation_status !== "None" && <span className="badge REVISION">{f.escalation_status}</span>}
        </div>
      ))}
      <div style={{ marginTop: 8 }}>
        <CreateTaskButton lang={lang} projectId={projectId} areaId={null} profile={profile} people={people}
          title={`Vendor follow-up — ${request.request_number}`} relatedModule="vendor_followup" relatedRecordId={request.id} priority="Medium" />
      </div>
    </div>
  );
}

// =======================================================================
// GRN / QC
// =======================================================================
function GrnPanel({ lang, projectId, request, receipts, orders, people, profile, onChanged }) {
  const [form, setForm] = useState({ po_id: "", receipt_location: "", qty_ordered: "", qty_received: "", qty_accepted: "", qty_rejected: "", qc_status: "Pending", qc_remarks: "", delivery_flow: "" });

  async function handleAdd(e) {
    e.preventDefault();
    await createPurchaseReceipt(projectId, request.id, { ...form, received_by: profile?.id }, profile?.id);
    setForm({ po_id: "", receipt_location: "", qty_ordered: "", qty_received: "", qty_accepted: "", qty_rejected: "", qc_status: "Pending", qc_remarks: "", delivery_flow: "" });
    onChanged();
  }

  return (
    <div className="card">
      <h2>{t("qualityCheckLabel", lang)} / GRN</h2>
      <form onSubmit={handleAdd} className="form-grid">
        <div className="field"><label>PO/WO</label>
          <select value={form.po_id} onChange={(e) => setForm((f) => ({ ...f, po_id: e.target.value }))}>
            <option value="">—</option>
            {orders.map((o) => <option key={o.id} value={o.id}>{o.po_number}</option>)}
          </select>
        </div>
        <div className="field"><label>Receipt Location</label><input value={form.receipt_location} onChange={(e) => setForm((f) => ({ ...f, receipt_location: e.target.value }))} /></div>
        <div className="field"><label>Qty Ordered</label><input type="number" value={form.qty_ordered} onChange={(e) => setForm((f) => ({ ...f, qty_ordered: e.target.value }))} /></div>
        <div className="field"><label>Qty Received</label><input type="number" value={form.qty_received} onChange={(e) => setForm((f) => ({ ...f, qty_received: e.target.value }))} /></div>
        <div className="field"><label>Qty Accepted</label><input type="number" value={form.qty_accepted} onChange={(e) => setForm((f) => ({ ...f, qty_accepted: e.target.value }))} /></div>
        <div className="field"><label>Qty Rejected</label><input type="number" value={form.qty_rejected} onChange={(e) => setForm((f) => ({ ...f, qty_rejected: e.target.value }))} /></div>
        <div className="field"><label>QC Status</label>
          <select value={form.qc_status} onChange={(e) => setForm((f) => ({ ...f, qc_status: e.target.value }))}>
            <option value="Pending">Pending</option><option value="Passed">Passed</option><option value="Failed">Failed</option>
          </select>
        </div>
        <div className="field"><label>QC Remarks</label><textarea rows={2} value={form.qc_remarks} onChange={(e) => setForm((f) => ({ ...f, qc_remarks: e.target.value }))} /></div>
        <div className="field"><label>Delivery Flow</label>
          <select value={form.delivery_flow} onChange={(e) => setForm((f) => ({ ...f, delivery_flow: e.target.value }))}>
            <option value="">—</option>
            <option value="Vendor -> Warehouse -> QC -> Site">Vendor → Warehouse → QC → Site</option>
            <option value="Vendor -> Direct Site -> Site QC">Vendor → Direct Site → Site QC</option>
            <option value="Vendor -> Factory -> QC">Vendor → Factory → QC</option>
            <option value="Vendor -> Display/Store -> QC">Vendor → Display/Store → QC</option>
          </select>
        </div>
        <button type="submit" className="btn btn-primary">{t("save", lang)}</button>
      </form>
      {receipts.length === 0 && <div className="msg info" style={{ marginTop: 10 }}>{t("noRecordsYet", lang)}</div>}
      {receipts.map((r) => (
        <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700 }}>{r.grn_number}</span>
          <span className="sub">Ordered {r.qty_ordered} · Received {r.qty_received} · Accepted {r.qty_accepted} · Rejected {r.qty_rejected}</span>
          <span className={`badge ${r.qc_status === "Passed" ? "VERIFIED" : r.qc_status === "Failed" ? "RETURNED" : "ASSIGNED"}`}>{r.qc_status}</span>
          <span className="sub">{personName(people, r.received_by)} · {r.receipt_date}</span>
        </div>
      ))}
    </div>
  );
}

// =======================================================================
// Payment coordination
// =======================================================================
function PaymentCoordinationPanel({ lang, projectId, request, payments, isOrgWide, profile, onChanged }) {
  const [form, setForm] = useState({ invoice_number: "", invoice_date: "", invoice_amount: "", tax_amount: "", payment_type: "", advance_amount: "", paid_amount: "", pending_amount: "", due_date: "", status: "Not Due" });

  async function handleAdd(e) {
    e.preventDefault();
    await createPurchasePaymentCoordination({ ...form, project_id: projectId, purchase_request_id: request.id }, profile?.id);
    setForm({ invoice_number: "", invoice_date: "", invoice_amount: "", tax_amount: "", payment_type: "", advance_amount: "", paid_amount: "", pending_amount: "", due_date: "", status: "Not Due" });
    onChanged();
  }

  async function handleStatus(id, status) {
    await updatePurchasePaymentCoordination(projectId, id, { status });
    onChanged();
  }

  return (
    <div className="card">
      <h2>{t("paymentCoordinationLabel", lang)}</h2>
      <form onSubmit={handleAdd} className="form-grid">
        <div className="field"><label>Invoice Number</label><input value={form.invoice_number} onChange={(e) => setForm((f) => ({ ...f, invoice_number: e.target.value }))} /></div>
        <div className="field"><label>Invoice Date</label><input type="date" value={form.invoice_date} onChange={(e) => setForm((f) => ({ ...f, invoice_date: e.target.value }))} /></div>
        <div className="field"><label>Invoice Amount</label><input type="number" value={form.invoice_amount} onChange={(e) => setForm((f) => ({ ...f, invoice_amount: e.target.value }))} /></div>
        <div className="field"><label>Tax Amount</label><input type="number" value={form.tax_amount} onChange={(e) => setForm((f) => ({ ...f, tax_amount: e.target.value }))} /></div>
        <div className="field"><label>Payment Type</label><input value={form.payment_type} onChange={(e) => setForm((f) => ({ ...f, payment_type: e.target.value }))} /></div>
        <div className="field"><label>Advance Amount</label><input type="number" value={form.advance_amount} onChange={(e) => setForm((f) => ({ ...f, advance_amount: e.target.value }))} /></div>
        <div className="field"><label>Paid Amount</label><input type="number" value={form.paid_amount} onChange={(e) => setForm((f) => ({ ...f, paid_amount: e.target.value }))} /></div>
        <div className="field"><label>Pending Amount</label><input type="number" value={form.pending_amount} onChange={(e) => setForm((f) => ({ ...f, pending_amount: e.target.value }))} /></div>
        <div className="field"><label>Due Date</label><input type="date" value={form.due_date} onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))} /></div>
        <button type="submit" className="btn btn-primary">{t("save", lang)}</button>
      </form>
      {!isOrgWide && <div className="msg info">{t("costingRestrictedMsg", lang)}</div>}
      {payments.length === 0 && <div className="msg info" style={{ marginTop: 10 }}>{t("noRecordsYet", lang)}</div>}
      {payments.map((p) => (
        <div key={p.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0", flexWrap: "wrap" }}>
          <span>{p.invoice_number || "—"}</span>
          <span className="sub">{formatCurrency(p.invoice_amount)} · Paid {formatCurrency(p.paid_amount)} · Pending {formatCurrency(p.pending_amount)}</span>
          <select value={p.status} onChange={(e) => handleStatus(p.id, e.target.value)}>
            {PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {p.submitted_to_accounts && <span className="badge ASSIGNED">Submitted to Accounts</span>}
        </div>
      ))}
    </div>
  );
}

// =======================================================================
// All Attachments
// =======================================================================
function AllAttachmentsPanel({ lang, projectId, requestId, attachments, profile, isElevated, onChanged }) {
  const [uploadBusy, setUploadBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  async function handleUpload(file, category) {
    setUploadBusy(true);
    await uploadPurchaseAttachment({ projectId, purchaseRequestId: requestId, module: "request", file, fileCategory: category, uploadedBy: profile?.id });
    setUploadBusy(false);
    onChanged();
  }

  async function handleDelete(id) {
    if (confirmDeleteId !== id) { setConfirmDeleteId(id); return; }
    setConfirmDeleteId(null);
    await deletePurchaseAttachment(projectId, id);
    onChanged();
  }

  return (
    <div className="card">
      <h2>{t("uploadAttachmentLabel", lang)}</h2>
      <AttachmentList lang={lang} attachments={attachments} isElevated={isElevated} onDelete={handleDelete} confirmDeleteId={confirmDeleteId} />
      <AttachmentUploader lang={lang} categories={REQUEST_ATTACHMENT_CATEGORIES} onUpload={handleUpload} busy={uploadBusy} />
    </div>
  );
}
