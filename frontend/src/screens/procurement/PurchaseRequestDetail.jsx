import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  answerClarification, cancelPurchaseRequest, confirmOrder, decideAmountApproval, deptDecision, getApprovalLimits, getCurrentOrder,
  getPurchaseRequest, getRequestContext, listAmountApprovals, listPrintLogs, listStatusHistory, procurementDecision, recordPrint,
  requestAmountApproval, submitPurchaseRequest,
} from "../../lib/procurementApi";
import {
  L, PROC_CATEGORIES, PROC_STATUS, SETUP_MISSING_TEXT, WORK_ORDER_CATEGORIES, fmtDate, isProcurementSetupMissing, priorityLabel, procStatusLabel, procurementRoles,
  validateOrderForm,
} from "../../lib/procurementRules";
import { listPurchaseAttachments, getAttachmentUrl } from "../../lib/interiorApi";
import { subscribeTable } from "../../lib/realtime";
import { friendlyError } from "../../lib/friendlyError";
import { kolkataDateStr } from "../../lib/kolkataTime";
import ProcurementContactCard from "../../components/ProcurementContactCard";
import { useProcurementContact } from "../../lib/useProcurementContact";
import PurchaseDocument from "../../components/PurchaseDocument";
import PurchaseLifecyclePanels from "./PurchaseLifecyclePanels";
import OrderPrintPreview from "../../components/OrderPrintPreview";
import DeadlinePanel from "./DeadlinePanel";
import OrderTaskPanel from "./OrderTaskPanel";
import { amendOrder, canWorkOrder, completeOrder, listOrderItems, markDelivered, openOrderFile, uploadOrderFile } from "../../lib/procurementApi";

// DD-MM-YYYY HH:MM in IST, the format used across Procurement.
const fmt = (d) => (d ? `${fmtDate(d)} ${new Date(d).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}` : "—");
const ORDER_EMPTY = {
  vendor_name: "", vendor_contact: "", quotation_reference: "", po_number: "", order_date: kolkataDateStr(), ordered_quantity: "",
  amount: "", expected_delivery_date: "", payment_terms: "", remarks: "", scope_of_work: "",
};
const ORDER_FIELDS = [
  ["vendor_name", "Vendor name", "વેન્ડરનું નામ", "text"],
  ["vendor_contact", "Vendor contact number", "વેન્ડર સંપર્ક નંબર", "tel"],
  ["quotation_reference", "Vendor quotation reference", "વેન્ડર ભાવપત્રક સંદર્ભ", "text"],
  ["po_number", "Purchase order number", "ખરીદી ઓર્ડર નંબર", "text"],
  ["order_date", "Order date", "ઓર્ડર તારીખ", "date"],
  ["ordered_quantity", "Ordered quantity", "ઓર્ડર જથ્થો", "number"],
  ["amount", "Final purchase amount (Rs)", "અંતિમ ખરીદી રકમ (રૂ.)", "number"],
  ["expected_delivery_date", "Expected delivery date", "અપેક્ષિત ડિલિવરી તારીખ", "date"],
  ["payment_terms", "Payment terms", "ચુકવણી શરતો", "text"],
];
const ORDER_ERRORS = {
  required: ["Required", "જરૂરી"], phone: ["Enter a 10–13 digit phone number", "10–13 અંકનો ફોન નંબર લખો"],
  positive: ["Must be more than zero", "શૂન્યથી વધુ હોવું જોઈએ"], beforeOrder: ["Cannot be before the order date", "ઓર્ડર તારીખ પહેલાં ન હોઈ શકે"],
};

// One purchase request end to end. Which buttons appear depends on the viewer's role and the request's status, but every
// action is re-checked by its proc_* function, so a hidden button is convenience, not security.
export default function PurchaseRequestDetail({ lang, profile, lookups }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const contact = useProcurementContact();
  const [state, setState] = useState({ loading: true, error: null });
  const [req, setReq] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [history, setHistory] = useState([]);
  const [prints, setPrints] = useState([]);
  const [order, setOrder] = useState(null);
  const [approvals, setApprovals] = useState([]);
  const [limits, setLimits] = useState([]);
  const [files, setFiles] = useState([]);
  const [remarks, setRemarks] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [orderForm, setOrderForm] = useState(ORDER_EMPTY);
  const [orderErrors, setOrderErrors] = useState({});
  const [printType, setPrintType] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [canWork, setCanWork] = useState(false);
  const [placedFiles, setPlacedFiles] = useState([]);
  const [items, setItems] = useState([]);
  const [taskInfo, setTaskInfo] = useState(null);

  const load = useCallback(async () => {
    const { data, error } = await getPurchaseRequest(id);
    if (error) { setState({ loading: false, error: isProcurementSetupMissing(error) ? L(lang, ...SETUP_MISSING_TEXT) : friendlyError(error.message) }); return; }
    if (!data) { setState({ loading: false, error: L(lang, "This request doesn't exist or you can't see it.", "આ વિનંતી અસ્તિત્વમાં નથી અથવા તમે જોઈ શકતા નથી.") }); return; }
    const [c, h, p, o, a, lim, att, it] = await Promise.all([
      getRequestContext([id]), listStatusHistory(id), listPrintLogs(id), getCurrentOrder(id), listAmountApprovals(id), getApprovalLimits(),
      listPurchaseAttachments(id), data.order_form_type ? listOrderItems(id) : Promise.resolve({ data: [] }),
    ]);
    setItems(it.data || []);
    setCanWork(data.order_form_type || data.print_template ? await canWorkOrder(id) : false);
    setReq(data);
    setCtx(c[id] || null);
    setHistory(h.data || []);
    setPrints(p.data || []);
    setOrder(o.data || null);
    setApprovals(a.data || []);
    setLimits(lim.data || []);
    setFiles(att.data || []);
    setOrderForm((f) => (f.ordered_quantity ? f : {
      ...f, ordered_quantity: String(data.quantity ?? ""), vendor_name: f.vendor_name || data.preferred_vendor_name || "",
      amount: f.amount || (data.order_total != null ? String(data.order_total) : ""), expected_delivery_date: f.expected_delivery_date || data.delivery_date || "",
    }));
    setState({ loading: false, error: null });
  }, [id, lang]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable(`purchase-request-${id}`, "purchase_requests", `id=eq.${id}`, () => load()), [id, load]);

  const perms = profile.permissions || {};
  const isRequester = req?.requester_user_id === profile.id;
  // Same rule as proc_is_procurement_authorized(): a Procurement Department Head or Supervisor.
  const roles = useMemo(() => procurementRoles(profile, lookups.departments), [profile, lookups.departments]);
  const { canProcure, isManagement } = roles;
  const canDeptDecide = req?.proc_status === "PENDING_DEPT_APPROVAL" && !isRequester && (perms.isDepartmentHead || perms.hasGlobalOversight);
  const isWorkOrder = WORK_ORDER_CATEGORIES.includes(req?.procurement_category);
  const limitProc = limits.find((x) => x.approver === "PROCUREMENT_HEAD")?.max_amount;
  const pendingApproval = approvals.find((x) => !x.decision);
  const approvedAmount = Math.max(0, ...approvals.filter((x) => x.decision === "APPROVED").map((x) => Number(x.approved_amount || 0)));
  const status = req?.proc_status;

  async function run(fn, after) {
    setBusy(true);
    setActionError(null);
    const { error } = await fn();
    setBusy(false);
    if (error) { setActionError(friendlyError(error.message)); return false; }
    setRemarks("");
    if (after) after();
    await load();
    return true;
  }

  // Print is recorded first; the dialog opens only once the database has the record, so "Confirm order" can't unlock
  // from a print that was never logged.
  async function print(type) {
    setBusy(true);
    setActionError(null);
    const { error } = await recordPrint(id, type);
    setBusy(false);
    if (error) { setActionError(friendlyError(error.message)); return; }
    setPrintType(type);
    await load();
    requestAnimationFrame(() => {
      document.body.classList.add("printing-purchase-doc");
      // The compact Interior form is A5, everything else A4.
      const pageSize = document.createElement("style");
      pageSize.textContent = `@page { size: ${req?.order_form_type === "INTERIOR" ? "A5" : "A4"}; margin: 8mm; }`;
      document.head.appendChild(pageSize);
      const done = () => { document.body.classList.remove("printing-purchase-doc"); pageSize.remove(); window.removeEventListener("afterprint", done); };
      window.addEventListener("afterprint", done);
      window.print();
    });
  }

  async function submitOrder(e) {
    e.preventDefault();
    const found = validateOrderForm(orderForm, { orderForm: !!req.order_form_type });
    if (isWorkOrder && !orderForm.scope_of_work.trim()) found.scope_of_work = "required";
    setOrderErrors(found);
    if (Object.keys(found).length) return;
    const ok = await run(() => confirmOrder(id, orderForm));
    // Supporting documents (vendor PO, confirmation) are attached to the order once it is placed.
    if (ok && placedFiles.length) {
      const failed = [];
      for (const f of placedFiles) { const { error } = await uploadOrderFile(id, f); if (error) failed.push(f.name); }
      setPlacedFiles([]);
      if (failed.length) setActionError(L(lang, "These files did not upload: ", "આ ફાઇલો અપલોડ ન થઈ: ") + failed.join(", "));
      await load();
    }
  }

  async function openFile(path) {
    if (path?.startsWith("orders/")) { openOrderFile(path); return; }
    const { url } = await getAttachmentUrl(path);
    if (url) window.open(url, "_blank", "noopener");
  }

  async function addFiles(fileList) {
    const failed = [];
    setBusy(true);
    for (const f of fileList) { const { error } = await uploadOrderFile(id, f); if (error) failed.push(f.name); }
    setBusy(false);
    if (failed.length) setActionError(L(lang, "These files did not upload: ", "આ ફાઇલો અપલોડ ન થઈ: ") + failed.join(", "));
    load();
  }

  const timeline = useMemo(() => history.slice().reverse(), [history]);
  const isOrderForm = !!(req?.order_form_type || req?.print_template);
  const mayPrint = (canProcure || canWork) && isOrderForm
    && ["ACCEPTED_BY_PROCUREMENT", "DOCUMENT_GENERATED", "ORDER_PLACED", "VENDOR_CONFIRMED", "IN_PRODUCTION", "READY_FOR_DISPATCH", "IN_TRANSIT",
        "DELAYED", "PARTIALLY_RECEIVED", "RECEIVED", "GRN_VERIFIED", "INVOICE_VERIFIED", "PAYMENT_PENDING", "PARTIALLY_PAID", "PAID", "CLOSED"].includes(req?.proc_status);
  useEffect(() => {
    if (params.get("print") === "1" && mayPrint) {
      setShowPreview(true);
      setParams({}, { replace: true });
    }
  }, [params, mayPrint, setParams]);

  if (state.loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 90 }} /><div className="skeleton-block" style={{ height: 320 }} /></div>;
  if (state.error) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">{state.error}</div>
        <button className="btn btn-outline" onClick={() => navigate("/purchase-requests")}>{L(lang, "Back to requests", "વિનંતીઓ પર પાછા")}</button>
      </div>
    );
  }

  const tone = PROC_STATUS[status]?.tone || "ASSIGNED";
  const priority = req.priority && req.priority !== "NORMAL" ? priorityLabel(req.priority, lang) : null;
  const procurementDeptId = lookups.departments.find((d) => d.code === "PROCUREMENT")?.id;
  const category = PROC_CATEGORIES.find((c) => c.code === req.procurement_category);
  const docVersion = Math.max(1, req.document_version || 0);

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🧾</div>
        <div className="dept-header-text" style={{ minWidth: 0 }}>
          <h1>{req.request_number} — {req.material_name}</h1>
          <div className="task-meta" style={{ flexWrap: "wrap", gap: 6 }}>
            <span className={`badge ${tone}`}>{procStatusLabel(status, lang)}</span>
            {req.is_emergency && <span className="badge RETURNED">{L(lang, "Emergency", "તાત્કાલિક")}</span>}
            {priority && !req.is_emergency && <span className={`badge ${["URGENT", "EMERGENCY"].includes(req.priority) ? "RETURNED" : "ASSIGNED"}`}>{priority}</span>}
            {req.required_by_date && <span className="sub">{L(lang, "Due", "ડ્યુ")} {fmtDate(req.required_by_date)}</span>}
          </div>
        </div>
      </div>

      {location.state?.uploadFailed?.length > 0 && (
        <div className="msg warning">{L(lang, "These files did not upload: ", "આ ફાઇલો અપલોડ ન થઈ: ")}{location.state.uploadFailed.join(", ")}</div>
      )}
      {actionError && <div className="msg error">{actionError}</div>}

      <DeadlinePanel lang={lang} req={req} ctx={ctx} order={order} roles={roles} procurementDeptId={procurementDeptId} busy={busy} run={run} />

      <OrderTaskPanel lang={lang} req={req} roles={roles} profile={profile} busy={busy} run={run} onInfo={setTaskInfo}
        canPrint={mayPrint} onPrint={() => setShowPreview(true)} />

      <div className="card">
        <h2>{L(lang, "Request details", "વિનંતીની વિગતો")}</h2>
        <div className="form-grid">
          <Info label={L(lang, "Department", "વિભાગ")} value={ctx?.department_name} />
          <Info label={L(lang, "Requested by", "વિનંતી કરનાર")} value={`${ctx?.requester_name || "—"} · ${fmt(req.created_at)}`} />
          {req.project_id && <Info label={L(lang, "Project", "પ્રોજેક્ટ")} value={ctx?.project_code ? `${ctx.project_code} — ${ctx.customer || ""}` : "—"} />}
          <Info label={L(lang, "Category", "પ્રકાર")} value={`${req.material_category || "—"} · ${category ? (lang === "gu" ? category.gu : category.en) : "—"}`} />
          <Info label={L(lang, "Quantity", "જથ્થો")} value={`${req.quantity} ${req.unit}`} />
          <Info label={L(lang, "Required due date", "જરૂરી ડ્યુ તારીખ")} value={fmtDate(req.required_by_date)} />
          <Info label={L(lang, "Delivery location", "ડિલિવરી સ્થળ")} value={req.delivery_location} full />
          <Info label={L(lang, "Specifications", "સ્પષ્ટીકરણ")} value={req.specifications} full />
          <Info label={L(lang, "Remarks", "નોંધ")} value={req.remarks} full />
          {req.is_emergency && <Info label={L(lang, "Emergency reason", "તાત્કાલિક કારણ")} value={req.emergency_reason} full />}
          {req.dept_decided_at && <Info label={L(lang, "Department Head decision", "વિભાગ વડાનો નિર્ણય")} value={`${ctx?.dept_approver_name || "—"} · ${fmt(req.dept_decided_at)}${req.dept_decision_remarks ? ` · ${req.dept_decision_remarks}` : ""}`} full />}
          {req.proc_decided_at && <Info label={L(lang, "Procurement decision", "ખરીદી વિભાગનો નિર્ણય")} value={`${ctx?.procurement_decider_name || "—"} · ${fmt(req.proc_decided_at)}${req.proc_decision_remarks ? ` · ${req.proc_decision_remarks}` : ""}`} full />}
        </div>
        {req.order_form_type && (
          <div className="proc-table-wrap" style={{ marginTop: 10 }}>
            <table className="proc-table">
              <thead><tr><th>#</th><th>{L(lang, "Item code", "આઇટમ કોડ")}</th><th>{L(lang, "Description", "વર્ણન")}</th><th>{L(lang, "Qty / size", "જથ્થો / માપ")}</th>
                {req.order_form_type === "RETAIL" && <><th style={{ textAlign: "right" }}>{L(lang, "Rate", "ભાવ")}</th><th style={{ textAlign: "right" }}>{L(lang, "Amount", "રકમ")}</th></>}</tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}><td>{i.line_no}</td><td>{i.item_code || "—"}</td><td style={{ whiteSpace: "normal" }}>{i.description}</td><td>{i.qty_size}</td>
                    {req.order_form_type === "RETAIL" && <><td style={{ textAlign: "right" }}>{i.rate ?? "—"}</td><td style={{ textAlign: "right" }}>{i.amount ?? "—"}</td></>}</tr>
                ))}
                {req.order_total != null && (
                  <tr><td colSpan={req.order_form_type === "RETAIL" ? 5 : 3} style={{ textAlign: "right", fontWeight: 700 }}>{L(lang, "Total", "કુલ")}</td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>Rs {Number(req.order_total).toLocaleString("en-IN")}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {req.order_form_type && (isRequester || roles.isProcurement) && !["CLOSED", "CANCELLED", "REJECTED_BY_DEPT_HEAD", "REJECTED_BY_PROCUREMENT"].includes(status) && (
          <label className="btn btn-outline" style={{ width: "auto", marginTop: 8, display: "inline-block" }}>
            📎 {L(lang, "Attach drawing / file", "ડ્રોઇંગ / ફાઇલ જોડો")}
            <input type="file" multiple hidden accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.dwg,.dxf" onChange={(e) => addFiles(Array.from(e.target.files || []))} disabled={busy} />
          </label>
        )}
        {files.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <strong>{L(lang, "Files", "ફાઇલો")}:</strong>{" "}
            {files.map((f) => <button key={f.id} type="button" className="btn btn-outline" style={{ width: "auto", margin: 4 }} onClick={() => openFile(f.storage_path)}>📎 {f.original_file_name || f.file_name}</button>)}
          </div>
        )}
      </div>

      {/* ---- Requester actions ---- */}
      {isRequester && ["DRAFT", "RETURNED_FOR_CORRECTION"].includes(status) && (
        <div className="card btn-row">
          <Link className="btn btn-outline" to={req.order_form_type ? `/orders/${id}/edit` : `/purchase-requests/${id}/edit`}>{L(lang, "Edit", "સુધારો")}</Link>
          <button className="btn btn-primary" disabled={busy} onClick={() => run(() => submitPurchaseRequest(id))}>{L(lang, "Send for approval", "મંજૂરી માટે મોકલો")}</button>
        </div>
      )}
      {isRequester && status === "CLARIFICATION_REQUIRED" && (
        <ActionCard title={L(lang, "Procurement asked for clarification", "ખરીદી વિભાગે સ્પષ્ટતા માંગી")} lang={lang} remarks={remarks} setRemarks={setRemarks}
          placeholder={L(lang, "Your answer", "તમારો જવાબ")}
          actions={[{ label: L(lang, "Send answer", "જવાબ મોકલો"), primary: true, onClick: () => run(() => answerClarification(id, remarks)) }]} busy={busy} />
      )}

      {/* ---- Department Head ---- */}
      {canDeptDecide && (
        <ActionCard title={L(lang, "Your approval is needed", "તમારી મંજૂરી જરૂરી છે")} lang={lang} remarks={remarks} setRemarks={setRemarks}
          placeholder={L(lang, "Remarks (required to reject or return)", "નોંધ (નામંજૂર કે પરત કરવા જરૂરી)")} busy={busy}
          actions={[
            { label: L(lang, "Approve and send to Procurement", "મંજૂર કરી ખરીદી વિભાગને મોકલો"), primary: true, onClick: () => run(() => deptDecision(id, "APPROVE", remarks)) },
            { label: L(lang, "Return for correction", "સુધારા માટે પરત"), onClick: () => run(() => deptDecision(id, "RETURN", remarks)) },
            { label: L(lang, "Reject", "નામંજૂર"), danger: true, onClick: () => run(() => deptDecision(id, "REJECT", remarks)) },
          ]} />
      )}

      {/* ---- Procurement ---- */}
      {canProcure && status === "SENT_TO_PROCUREMENT" && (
        <ActionCard title={L(lang, "Procurement decision", "ખરીદી વિભાગનો નિર્ણય")} lang={lang} remarks={remarks} setRemarks={setRemarks}
          placeholder={L(lang, "Remarks (required to reject, ask or hold)", "નોંધ (નામંજૂર, પૂછવા કે અટકાવવા જરૂરી)")} busy={busy}
          actions={[
            { label: L(lang, "Accept request", "વિનંતી સ્વીકારો"), primary: true, onClick: () => run(() => procurementDecision(id, "ACCEPT", remarks)) },
            { label: L(lang, "Return for correction", "સુધારા માટે પરત"), onClick: () => run(() => procurementDecision(id, "RETURN", remarks)) },
            { label: L(lang, "Request clarification", "સ્પષ્ટતા માંગો"), onClick: () => run(() => procurementDecision(id, "CLARIFY", remarks)) },
            { label: L(lang, "Put on hold", "અટકાવો"), onClick: () => run(() => procurementDecision(id, "HOLD", remarks)) },
            { label: L(lang, "Reject", "નામંજૂર"), danger: true, onClick: () => run(() => procurementDecision(id, "REJECT", remarks)) },
          ]} />
      )}
      {canProcure && status === "ON_HOLD" && (
        <div className="card btn-row">
          <button className="btn btn-primary" disabled={busy} onClick={() => run(() => procurementDecision(id, "RESUME", null))}>{L(lang, "Resume", "ફરી શરૂ કરો")}</button>
        </div>
      )}

      {isOrderForm && (canProcure || canWork) && ["ACCEPTED_BY_PROCUREMENT", "DOCUMENT_GENERATED"].includes(status) && (
        <div className="card">
          <h2>{L(lang, "Step 1 — Print the official order form", "પગલું 1 — સત્તાવાર ઓર્ડર ફોર્મ છાપો")}</h2>
          <button className="btn btn-primary" style={{ fontSize: 18, minHeight: 56, width: "auto", padding: "0 24px" }} disabled={busy} onClick={() => setShowPreview(true)}>
            🖨 {status === "ACCEPTED_BY_PROCUREMENT" ? L(lang, "PRINT ORDER FORM", "ઓર્ડર ફોર્મ છાપો") : L(lang, "Print order form again", "ઓર્ડર ફોર્મ ફરી છાપો")}
          </button>
          <div className="sub" style={{ marginTop: 6 }}>
            {L(lang, "Opens a preview of the Mood of Wood form with this order filled in. Print on any printer, or download the PDF.",
              "આ ઓર્ડર ભરેલું મૂડ ઓફ વુડ ફોર્મ દેખાશે. કોઈપણ પ્રિન્ટર પર છાપો અથવા PDF ડાઉનલોડ કરો.")}
          </div>
        </div>
      )}
      {!isOrderForm && canProcure && ["ACCEPTED_BY_PROCUREMENT", "DOCUMENT_GENERATED"].includes(status) && (
        <div className="card">
          <h2>{L(lang, "Step 1 — Print the purchase document", "પગલું 1 — ખરીદી દસ્તાવેજ છાપો")}</h2>
          <button className="btn btn-primary" style={{ fontSize: 17, minHeight: 52 }} disabled={busy} onClick={() => print("PURCHASE_REQUEST")}>
            🖨️ {status === "ACCEPTED_BY_PROCUREMENT" ? L(lang, "Print document", "દસ્તાવેજ છાપો") : L(lang, "Reprint document", "દસ્તાવેજ ફરી છાપો")}
          </button>
          <div className="sub" style={{ marginTop: 6 }}>
            {L(lang, "To save a PDF, choose \"Save as PDF\" in the print window. The app records that printing was started, not that paper came out.",
              "PDF સાચવવા, પ્રિન્ટ વિન્ડોમાં \"Save as PDF\" પસંદ કરો. એપ ફક્ત પ્રિન્ટ શરૂ થયાની નોંધ રાખે છે, કાગળ નીકળ્યાની નહીં.")}
          </div>
        </div>
      )}

      {(canProcure || (isOrderForm && canWork)) && status === "DOCUMENT_GENERATED" && (
        <form className="card form-grid" onSubmit={submitOrder} noValidate>
          <h2 className="field full">{L(lang, "Step 2 — CONFIRM ORDER PLACED", "પગલું 2 — ઓર્ડર મૂક્યાની પુષ્ટિ કરો")}</h2>
          {isOrderForm && <div className="sub field full">{L(lang, "After sending the printed form to the vendor: vendor, the vendor's PO / reference number and the expected delivery date are required.",
            "છાપેલું ફોર્મ વેન્ડરને મોકલ્યા પછી: વેન્ડર, વેન્ડરનો PO / સંદર્ભ નંબર અને અપેક્ષિત ડિલિવરી તારીખ જરૂરી છે.")}</div>}
          {limitProc != null && (
            <div className="msg info field full">
              {L(lang, `Orders above Rs ${Number(limitProc).toLocaleString("en-IN")} need Management approval first.`,
                `રૂ. ${Number(limitProc).toLocaleString("en-IN")} થી વધુના ઓર્ડર માટે પહેલા મેનેજમેન્ટની મંજૂરી જોઈએ.`)}
              {approvedAmount > 0 && ` ${L(lang, "Approved up to", "મંજૂર મર્યાદા")}: Rs ${approvedAmount.toLocaleString("en-IN")}.`}
              {pendingApproval && ` ${L(lang, "An approval request is pending.", "મંજૂરી વિનંતી બાકી છે.")}`}
            </div>
          )}
          {ORDER_FIELDS.map(([k, en, gu, type]) => (
            <div className="field" key={k}>
              <label>{isOrderForm && k === "po_number" ? L(lang, "Vendor PO / reference number", "વેન્ડર PO / સંદર્ભ નંબર") : L(lang, en, gu)}
                {(!isOrderForm || ["vendor_name", "po_number", "order_date", "expected_delivery_date"].includes(k)) && " *"}</label>
              <input type={type} inputMode={type === "number" ? "decimal" : undefined} min={type === "number" ? "0" : undefined} step={type === "number" ? "any" : undefined}
                value={orderForm[k]} onChange={(e) => { setOrderForm((f) => ({ ...f, [k]: e.target.value })); setOrderErrors((x) => ({ ...x, [k]: undefined })); }} />
              {orderErrors[k] && <div className="sub" style={{ color: "var(--danger, #a23434)" }}>{L(lang, ...ORDER_ERRORS[orderErrors[k]])}</div>}
            </div>
          ))}
          <div className="field full">
            <label>{L(lang, "Procurement remarks", "ખરીદી વિભાગની નોંધ")}{!isOrderForm && " *"}</label>
            <textarea rows={2} value={orderForm.remarks} onChange={(e) => { setOrderForm((f) => ({ ...f, remarks: e.target.value })); setOrderErrors((x) => ({ ...x, remarks: undefined })); }} />
            {orderErrors.remarks && <div className="sub" style={{ color: "var(--danger, #a23434)" }}>{L(lang, ...ORDER_ERRORS.required)}</div>}
          </div>
          {isWorkOrder && (
            <div className="field full">
              <label>{L(lang, "Scope of work (work order)", "કામનો વ્યાપ (વર્ક ઓર્ડર)")} *</label>
              <textarea rows={3} value={orderForm.scope_of_work} placeholder={L(lang, "What exactly is to be done, deliverables, milestones and deadline", "બરાબર શું કરવાનું છે, ડિલિવરેબલ્સ, માઇલસ્ટોન અને સમયમર્યાદા")}
                onChange={(e) => { setOrderForm((f) => ({ ...f, scope_of_work: e.target.value })); setOrderErrors((x) => ({ ...x, scope_of_work: undefined })); }} />
              {orderErrors.scope_of_work && <div className="sub" style={{ color: "var(--danger, #a23434)" }}>{L(lang, ...ORDER_ERRORS.required)}</div>}
            </div>
          )}
          {isOrderForm && (
            <div className="field full">
              <label>{L(lang, "Supporting documents (vendor PO, confirmation)", "આધાર દસ્તાવેજ (વેન્ડર PO, પુષ્ટિ)")}</label>
              <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.heic" onChange={(e) => setPlacedFiles(Array.from(e.target.files || []))} />
            </div>
          )}
          <div className="field full btn-row">
            <button className="btn btn-primary" type="submit" style={{ fontSize: 17, minHeight: 52 }} disabled={busy}>✅ {L(lang, "Confirm order placed", "ઓર્ડર મૂક્યાની પુષ્ટિ કરો")}</button>
            {limitProc != null && Number(orderForm.amount) > Number(limitProc) && Number(orderForm.amount) > approvedAmount && !pendingApproval && (
              <button className="btn btn-outline" type="button" disabled={busy}
                onClick={() => run(() => requestAmountApproval(id, orderForm.amount, orderForm.remarks))}>
                {L(lang, "Ask Management to approve this amount", "આ રકમ માટે મેનેજમેન્ટની મંજૂરી માંગો")}
              </button>
            )}
          </div>
        </form>
      )}

      {isManagement && pendingApproval && (
        <ActionCard title={L(lang, `Approve order amount Rs ${Number(pendingApproval.requested_amount).toLocaleString("en-IN")}?`, `રૂ. ${Number(pendingApproval.requested_amount).toLocaleString("en-IN")} ઓર્ડર રકમ મંજૂર કરો?`)}
          lang={lang} remarks={remarks} setRemarks={setRemarks} placeholder={L(lang, "Remarks (required to reject)", "નોંધ (નામંજૂર કરવા જરૂરી)")} busy={busy}
          actions={[
            { label: L(lang, "Approve amount", "રકમ મંજૂર કરો"), primary: true, onClick: () => run(() => decideAmountApproval(id, "APPROVED", remarks)) },
            { label: L(lang, "Reject", "નામંજૂર"), danger: true, onClick: () => run(() => decideAmountApproval(id, "REJECTED", remarks)) },
          ]} />
      )}

      {order && (
        <div className="card">
          <h2>{order.order_type === "WORK_ORDER" ? L(lang, "Work order", "વર્ક ઓર્ડર") : L(lang, "Purchase order", "ખરીદી ઓર્ડર")} {order.po_number}</h2>
          <div className="form-grid">
            <Info label={L(lang, "Vendor", "વેન્ડર")} value={`${order.vendors?.name || "—"} · ${order.vendor_contact || ""}`} />
            <Info label={L(lang, "Quotation", "ભાવપત્રક")} value={order.quotation_reference} />
            <Info label={L(lang, "Order date", "ઓર્ડર તારીખ")} value={order.order_date} />
            <Info label={L(lang, "Ordered quantity", "ઓર્ડર જથ્થો")} value={`${order.ordered_quantity} ${req.unit}`} />
            <Info label={L(lang, "Amount", "રકમ")} value={`Rs ${Number(order.total_order_value || 0).toLocaleString("en-IN")}`} />
            <Info label={L(lang, "Expected delivery", "અપેક્ષિત ડિલિવરી")} value={order.expected_delivery_date} />
            <Info label={L(lang, "Payment terms", "ચુકવણી શરતો")} value={order.payment_terms} />
            <Info label={L(lang, "Confirmed by", "પુષ્ટિ કરનાર")} value={`${ctx?.order_confirmed_by_name || "—"} · ${fmt(order.confirmed_at)}`} />
            <Info label={L(lang, "Remarks", "નોંધ")} value={order.remarks} full />
            {order.scope_of_work && <Info label={L(lang, "Scope of work", "કામનો વ્યાપ")} value={order.scope_of_work} full />}
          </div>
          {canProcure && (
            <button className="btn btn-outline" style={{ width: "auto", marginTop: 8 }} disabled={busy} onClick={() => print("PURCHASE_ORDER")}>🖨️ {L(lang, "Print purchase order", "ખરીદી ઓર્ડર છાપો")}</button>
          )}
        </div>
      )}

      {["ACCEPTED_BY_PROCUREMENT", "DOCUMENT_GENERATED"].includes(status) || order || status === "EMERGENCY_APPROVAL_PENDING" ? (
        <PurchaseLifecyclePanels lang={lang} req={req} order={order} roles={roles} onChanged={load} />
      ) : null}

      {/* The same stages proc_cancel_request accepts: before an order exists. */}
      {(isRequester || canProcure || isManagement) && ["DRAFT", "PENDING_DEPT_APPROVAL", "RETURNED_FOR_CORRECTION", "CLARIFICATION_REQUIRED", "SENT_TO_PROCUREMENT", "ON_HOLD", "ACCEPTED_BY_PROCUREMENT", "DOCUMENT_GENERATED"].includes(status) && (
        <details className="card">
          <summary>{L(lang, "Cancel this request", "આ વિનંતી રદ કરો")}</summary>
          <ActionCard lang={lang} remarks={remarks} setRemarks={setRemarks} placeholder={L(lang, "Reason (required)", "કારણ (જરૂરી)")} busy={busy} bare
            actions={[{ label: L(lang, "Cancel request", "વિનંતી રદ કરો"), danger: true, onClick: () => run(() => cancelPurchaseRequest(id, remarks)) }]} />
        </details>
      )}

      <ProcurementContactCard lang={lang} profile={profile} />

      <div className="card">
        <h2>{L(lang, "History", "ઇતિહાસ")}</h2>
        <ul className="proc-history">
          {timeline.map((hst) => (
            <li key={hst.id}>
              <strong>{procStatusLabel(hst.to_status, lang)}</strong> <span className="sub">· {fmt(hst.created_at)}{hst.remarks ? ` · ${hst.remarks}` : ""}</span>
            </li>
          ))}
        </ul>
        {prints.length > 0 && (
          <>
            <h3 style={{ fontSize: 15 }}>{L(lang, "Print record", "પ્રિન્ટ નોંધ")}</h3>
            <ul className="proc-history">
              {prints.map((p) => (
                <li key={p.id} className="sub">
                  {p.template ? `${p.template === "INTERIOR" ? L(lang, "Interior order form", "ઇન્ટિરિયર ઓર્ડર ફોર્મ") : L(lang, "Retail order form", "રિટેલ ઓર્ડર ફોર્મ")}`
                    : p.document_type === "PURCHASE_ORDER" ? L(lang, "Purchase order", "ખરીદી ઓર્ડર") : L(lang, "Purchase request", "ખરીદી વિનંતી")} v{p.document_version} ·{" "}
                  {p.output === "PDF" ? L(lang, "PDF downloaded", "PDF ડાઉનલોડ") : p.action === "REPRINT" ? L(lang, "reprint started", "ફરી પ્રિન્ટ શરૂ") : L(lang, "print started", "પ્રિન્ટ શરૂ")}
                  {" · "}{fmt(p.printed_at)}
                  {p.print_confirmed_at && ` · ✓ ${L(lang, "confirmed printed", "છપાયાની પુષ્ટિ")} ${fmt(p.print_confirmed_at)}`}
                  {p.pdf_storage_path && <> · <button type="button" className="link-btn" onClick={() => openOrderFile(p.pdf_storage_path)}>{L(lang, "open PDF", "PDF ખોલો")}</button></>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {order && req.order_form_type && roles.isProcurement && (
        <OrderFollowThrough lang={lang} req={req} order={order} canProcure={canProcure} canVerify={roles.canProcure} taskInfo={taskInfo} busy={busy} run={run} />
      )}

      {showPreview && (
        <OrderPrintPreview lang={lang} request={req} items={items} context={ctx} order={order}
          files={files.filter((f) => !String(f.storage_path || "").includes("/printed/"))} taskNumber={taskInfo?.task_number}
          printedBy={profile.full_name} canChangeTemplate={roles.isProcurementHead || roles.isManagement}
          onClose={() => setShowPreview(false)} onChanged={load} />
      )}
      {printType && !req.order_form_type && createPortal(
        <PurchaseDocument type={printType} request={req} context={ctx} order={order} contact={contact} version={printType === "PURCHASE_ORDER" ? order?.version_number : docVersion} />,
        document.body,
      )}
    </div>
  );
}

function Info({ label, value, full }) {
  return (
    <div className={`field${full ? " full" : ""}`}>
      <label>{label}</label>
      <div>{value === null || value === undefined || String(value).trim() === "" ? "—" : value}</div>
    </div>
  );
}

function ActionCard({ title, lang, remarks, setRemarks, placeholder, actions, busy, bare }) {
  const body = (
    <>
      {title && <h2>{title}</h2>}
      <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={placeholder} aria-label={placeholder || L(lang, "Remarks", "નોંધ")} />
      <div className="btn-row">
        {actions.map((a) => (
          <button key={a.label} type="button" className={`btn ${a.primary ? "btn-primary" : "btn-outline"}`} style={a.danger ? { color: "var(--danger, #a23434)" } : undefined}
            disabled={busy} onClick={a.onClick}>{a.label}</button>
        ))}
      </div>
    </>
  );
  return bare ? body : <div className="card">{body}</div>;
}

// After an order is placed: record delivery to the client/site, complete it, or amend it (with a reason; the old values are
// kept in the audit log). Each button calls one proc_* function, which checks the role and the status.
function OrderFollowThrough({ lang, req, order, canProcure, canVerify, taskInfo, busy, run }) {
  const open = !["RECEIVED", "GRN_VERIFIED", "INVOICE_VERIFIED", "PAYMENT_PENDING", "PARTIALLY_PAID", "PAID", "CLOSED", "CANCELLED"].includes(req.proc_status);
  const [deliveredOn, setDeliveredOn] = useState(kolkataDateStr());
  const [amend, setAmend] = useState({ expected_delivery_date: "", vendor_contact: "", payment_terms: "", reason: "" });
  const changes = Object.fromEntries(Object.entries(amend).filter(([k, v]) => k !== "reason" && String(v).trim()));
  return (
    <div className="card">
      <h2>{L(lang, "Order follow-up", "ઓર્ડર ફોલો-અપ")}</h2>
      {open && (
        <div className="btn-row" style={{ alignItems: "center" }}>
          <input type="date" value={deliveredOn} onChange={(e) => setDeliveredOn(e.target.value)} style={{ width: "auto" }} aria-label={L(lang, "Delivered on", "ડિલિવરી તારીખ")} />
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(() => markDelivered(req.id, deliveredOn, null))}>
            {L(lang, "Mark delivered to client / site", "ગ્રાહક / સાઇટ પર ડિલિવર થયું")}
          </button>
        </div>
      )}
      {/* Verification: only after the assigned employee has marked the Procurement task done (the database checks it too). */}
      {canVerify && ["RECEIVED", "GRN_VERIFIED", "PAID"].includes(req.proc_status) && (!taskInfo?.task_id || taskInfo.task_status === "COMPLETED") && (
        <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy} onClick={() => run(() => completeOrder(req.id, "Verified by Procurement"))}>
          ✅ {L(lang, "Verify & complete order", "ચકાસો અને ઓર્ડર પૂર્ણ કરો")}
        </button>
      )}
      {canProcure && req.proc_status !== "CLOSED" && (
        <details style={{ marginTop: 10 }}>
          <summary>{L(lang, "Amend placed order", "મૂકેલા ઓર્ડરમાં ફેરફાર")}</summary>
          <div className="form-grid" style={{ marginTop: 8 }}>
            <div className="field">
              <label>{L(lang, "New expected delivery", "નવી અપેક્ષિત ડિલિવરી")}</label>
              <input type="date" min={order.order_date} value={amend.expected_delivery_date} onChange={(e) => setAmend((a) => ({ ...a, expected_delivery_date: e.target.value }))} />
            </div>
            <div className="field">
              <label>{L(lang, "New vendor contact", "નવો વેન્ડર સંપર્ક")}</label>
              <input type="tel" value={amend.vendor_contact} onChange={(e) => setAmend((a) => ({ ...a, vendor_contact: e.target.value }))} />
            </div>
            <div className="field">
              <label>{L(lang, "New payment terms", "નવી ચુકવણી શરતો")}</label>
              <input value={amend.payment_terms} onChange={(e) => setAmend((a) => ({ ...a, payment_terms: e.target.value }))} />
            </div>
            <div className="field full">
              <label>{L(lang, "Reason for the amendment", "ફેરફારનું કારણ")} *</label>
              <input value={amend.reason} onChange={(e) => setAmend((a) => ({ ...a, reason: e.target.value }))} />
            </div>
            <div className="field full">
              <button type="button" className="btn btn-outline" disabled={busy || !Object.keys(changes).length || !amend.reason.trim()}
                onClick={() => run(() => amendOrder(req.id, changes, amend.reason), () => setAmend({ expected_delivery_date: "", vendor_contact: "", payment_terms: "", reason: "" }))}>
                {L(lang, "Save amendment", "ફેરફાર સાચવો")}
              </button>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
