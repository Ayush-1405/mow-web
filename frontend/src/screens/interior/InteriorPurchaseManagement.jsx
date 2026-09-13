import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import { formatCurrency } from "../../lib/retailModules";
import {
  listProjects, listInteriorPeople,
  listFactoryLocations, createFactoryLocation, listVendors, createVendor,
  listPurchaseChecklistItems, listPurchaseRequests, listAllPurchaseRequests,
  createPurchaseRequest, updatePurchaseRequest, archivePurchaseRequest,
  listPurchaseRequestItems, createPurchaseRequestItem, updatePurchaseRequestItem,
  getInhouseProductionRequest, submitToFactory, updateInhouseProductionStatus,
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

const OUTSOURCE_TYPES = [
  "Finished Goods Purchase", "Vendor Manufacturing/Job Work", "Material-Only Purchase",
  "Labour-Only Contract", "Labour + Material Contract", "Turnkey Agency/Subcontract",
  "Direct-to-Site Vendor Supply", "Vendor Supply to Warehouse", "Other",
];
const PRIORITIES = ["Normal", "High", "Urgent", "Emergency"];
const INHOUSE_STATUSES = [
  "Draft", "Submitted to Factory", "Factory Accepted", "Material Check Pending", "Raw Material Pending",
  "Ready for Production", "Production Started", "Work in Progress", "QC Pending", "QC Failed", "Rework",
  "QC Passed", "Packing", "Ready for Dispatch", "Dispatched", "Delivered", "Installed", "Completed", "On Hold", "Cancelled",
];
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

  const loadDetail = useCallback(async () => {
    if (!requestId) { setDetail(null); return; }
    setDetailLoading(true);
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
    setDetailLoading(false);
  }, [requestId, isOrgWide]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  const refreshDetail = useCallback(() => { loadDetail(); }, [loadDetail]);
  const refreshAll = useCallback(() => { loadRequests(); loadDetail(); }, [loadRequests, loadDetail]);

  const currentRequest = requests.find((r) => r.id === requestId) || boardRequests.find((r) => r.id === requestId) || null;

  const tabs = useMemo(() => {
    const base = [["request", "Request"], ["checklist", "Checklist"]];
    if (currentRequest?.purchase_source === "in_house") base.splice(1, 0, ["inhouse", "In-house / Factory"]);
    if (currentRequest?.purchase_source === "outsourced") {
      base.splice(1, 0, ["outsource", "Outsource / Vendor"]);
      base.push(["followup", "Vendor Follow-up"]);
    }
    base.push(["grn", "GRN / QC"], ["payment", "Payment Coordination"], ["files", "All Attachments"], ["activity", "Activity History"]);
    return base;
  }, [currentRequest]);

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
              {isElevated && (
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
                <InhousePanel lang={lang} projectId={projectId} request={currentRequest} inhouse={detail.inhouse} costing={detail.costing}
                  factoryLocations={factoryLocations} people={people} profile={profile} isOrgWide={isOrgWide} onChanged={refreshAll} />
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
function InhousePanel({ lang, projectId, request, inhouse, costing, factoryLocations, people, profile, isOrgWide, onChanged }) {
  const [form, setForm] = useState({
    factory_location_id: "", production_department: "", product_item: "", bom_reference: "", quantity: "", unit: "",
    required_completion_date: "", delivery_site_date: "", assigned_factory_coordinator: "", special_instructions: "",
    quality_requirements: "", finishing_requirements: "", packing_requirements: "", installation_requirement: "",
  });
  const [msg, setMsg] = useState("");
  const [costForm, setCostForm] = useState({});
  const [newLocationName, setNewLocationName] = useState("");

  useEffect(() => { if (costing) setCostForm(costing); }, [costing]);

  async function handleSubmit(e) {
    e.preventDefault();
    setMsg(t("saving", lang));
    const { error: err, alreadySubmitted } = await submitToFactory(projectId, request.id, {
      ...form, quantity: form.quantity || null, assigned_factory_coordinator: form.assigned_factory_coordinator || null,
    }, profile?.id);
    setMsg(err ? t("errorSaving", lang) : alreadySubmitted ? t("alreadySubmittedMsg", lang) : t("saved", lang));
    if (!err) onChanged();
  }

  async function handleStatusChange(status) {
    await updateInhouseProductionStatus(projectId, inhouse.id, { status });
    onChanged();
  }

  async function handleAddLocation() {
    if (!newLocationName.trim()) return;
    await createFactoryLocation({ name: newLocationName.trim() });
    setNewLocationName("");
    onChanged();
  }

  async function handleSaveCosting(e) {
    e.preventDefault();
    await upsertPurchaseCosting(projectId, request.id, costForm, profile?.id);
    onChanged();
  }

  if (inhouse) {
    return (
      <div className="card">
        <h2>In-house Production Status</h2>
        <div className="dept-meta-grid">
          <div className="card dept-meta-tile"><div className="label">Job Order</div><div className="value">{inhouse.job_order_number}</div></div>
          <div className="card dept-meta-tile"><div className="label">Factory</div><div className="value">{factoryLocations.find((f) => f.id === inhouse.factory_location_id)?.name || "—"}</div></div>
          <div className="card dept-meta-tile"><div className="label">Coordinator</div><div className="value">{personName(people, inhouse.assigned_factory_coordinator)}</div></div>
          <div className="card dept-meta-tile"><div className="label">Status</div><div className="value">{inhouse.status}</div></div>
        </div>
        <div className="field" style={{ marginTop: 8 }}>
          <label>Update Status</label>
          <select value={inhouse.status} onChange={(e) => handleStatusChange(e.target.value)}>
            {INHOUSE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="task-meta" style={{ flexWrap: "wrap", marginTop: 6 }}>
          <span className="sub">QC: {inhouse.qc_status || "—"}</span>
          <span className="sub">Packing: {inhouse.packing_status || "—"}</span>
          <span className="sub">Dispatch: {inhouse.dispatch_readiness || "—"}</span>
          <span className="sub">Delivery: {inhouse.delivery_status || "—"}</span>
          <span className="sub">Installation: {inhouse.installation_status || "—"}</span>
        </div>
        {isOrgWide && (
          <form onSubmit={handleSaveCosting} className="form-grid" style={{ marginTop: 14 }}>
            <h3>{t("costingLabel", lang) || "Costing"}</h3>
            {["raw_material_estimated", "raw_material_actual", "hardware_cost", "labour_estimated", "labour_actual",
              "machine_cost", "finishing_cost", "packing_cost", "transport_cost", "installation_cost", "wastage_cost", "rework_cost", "other_cost"].map((k) => (
              <div className="field" key={k}><label>{k.replace(/_/g, " ")}</label>
                <input type="number" value={costForm[k] ?? ""} onChange={(e) => setCostForm((f) => ({ ...f, [k]: e.target.value }))} /></div>
            ))}
            <button type="submit" className="btn btn-primary">{t("save", lang)}</button>
            {costing && (
              <div className="sub" style={{ marginTop: 6 }}>
                {t("totalCostLabel", lang)}: {t("estimatedLabel", lang) || "Estimated"} {formatCurrency(costing.total_estimated_cost)} · {t("actualLabel", lang) || "Actual"} {formatCurrency(costing.total_actual_cost)}
                {" · "}Variance {formatCurrency((costing.total_actual_cost || 0) - (costing.total_estimated_cost || 0))}
              </div>
            )}
          </form>
        )}
        {!isOrgWide && <div className="msg info" style={{ marginTop: 10 }}>{t("costingRestrictedMsg", lang)}</div>}
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Submit to Factory</h2>
      <form onSubmit={handleSubmit} className="form-grid">
        <div className="field"><label>{t("selectFactoryLabel", lang)}</label>
          <div className="btn-row">
            <select value={form.factory_location_id} onChange={(e) => setForm((f) => ({ ...f, factory_location_id: e.target.value }))} required>
              <option value="">—</option>
              {factoryLocations.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <input placeholder="New location name" value={newLocationName} onChange={(e) => setNewLocationName(e.target.value)} style={{ width: "auto" }} />
            <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={handleAddLocation}>+ Add</button>
          </div>
        </div>
        <div className="field"><label>Production Department</label><input value={form.production_department} onChange={(e) => setForm((f) => ({ ...f, production_department: e.target.value }))} /></div>
        <div className="field"><label>Product/Item</label><input value={form.product_item} onChange={(e) => setForm((f) => ({ ...f, product_item: e.target.value }))} required /></div>
        <div className="field"><label>BOM Reference</label><input value={form.bom_reference} onChange={(e) => setForm((f) => ({ ...f, bom_reference: e.target.value }))} /></div>
        <div className="field"><label>Quantity</label><input type="number" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} required /></div>
        <div className="field"><label>Unit</label><input value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} /></div>
        <div className="field"><label>Required Completion Date</label><input type="date" value={form.required_completion_date} onChange={(e) => setForm((f) => ({ ...f, required_completion_date: e.target.value }))} required /></div>
        <div className="field"><label>Delivery/Site Requirement Date</label><input type="date" value={form.delivery_site_date} onChange={(e) => setForm((f) => ({ ...f, delivery_site_date: e.target.value }))} /></div>
        <div className="field"><label>Assigned Factory Coordinator</label>
          <select value={form.assigned_factory_coordinator} onChange={(e) => setForm((f) => ({ ...f, assigned_factory_coordinator: e.target.value }))}>
            <option value="">—</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="field"><label>Special Instructions</label><textarea rows={2} value={form.special_instructions} onChange={(e) => setForm((f) => ({ ...f, special_instructions: e.target.value }))} /></div>
        <div className="field"><label>Quality Requirements</label><textarea rows={2} value={form.quality_requirements} onChange={(e) => setForm((f) => ({ ...f, quality_requirements: e.target.value }))} /></div>
        <div className="field"><label>Finishing Requirements</label><textarea rows={2} value={form.finishing_requirements} onChange={(e) => setForm((f) => ({ ...f, finishing_requirements: e.target.value }))} /></div>
        <div className="field"><label>Packing Requirements</label><textarea rows={2} value={form.packing_requirements} onChange={(e) => setForm((f) => ({ ...f, packing_requirements: e.target.value }))} /></div>
        <div className="field"><label>Installation Requirement</label><textarea rows={2} value={form.installation_requirement} onChange={(e) => setForm((f) => ({ ...f, installation_requirement: e.target.value }))} /></div>
        <button type="submit" className="btn btn-primary">{t("submitToFactoryLabel", lang)}</button>
        {msg && <div className="sub">{msg}</div>}
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
