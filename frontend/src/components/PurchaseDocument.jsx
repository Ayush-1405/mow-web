import React from "react";
import { PROC_PRIORITIES, PROC_CATEGORIES, fmtDate as fmtDay, procStatusLabel } from "../lib/procurementRules";

// A4 Purchase Request / Purchase Order document. Rendered off-screen and shown only by the print stylesheet (.purchase-doc),
// so the browser's print dialog prints this and nothing else; "Save as PDF" in that dialog is the PDF download.
// Always English: it goes to vendors and into files. Empty values print as "—", never as blank boxes.

const fmtDate = (d) => fmtDay(d);
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const v = (x) => (x === null || x === undefined || String(x).trim() === "" ? "—" : x);

function Row({ label, children }) {
  return (
    <tr>
      <th>{label}</th>
      <td>{children}</td>
    </tr>
  );
}

export default function PurchaseDocument({ type, request, context, order, contact, version }) {
  if (!request) return null;
  const isPO = type === "PURCHASE_ORDER";
  const isWork = isPO && order?.order_type === "WORK_ORDER";
  const priority = PROC_PRIORITIES.find((p) => p.code === request.priority)?.en || request.priority;
  const category = PROC_CATEGORIES.find((c) => c.code === request.procurement_category)?.en || request.procurement_category;
  return (
    <div className="purchase-doc" aria-hidden="true">
      <header className="purchase-doc-head">
        <div>
          <div className="purchase-doc-brand">MOOD OF WOOD</div>
          <div className="purchase-doc-dept">PROCUREMENT DEPARTMENT</div>
        </div>
        <div className="purchase-doc-meta">
          <div className="purchase-doc-title">{isWork ? "WORK ORDER" : isPO ? "PURCHASE ORDER" : "PURCHASE REQUEST"}</div>
          <div>{isPO ? `PO No. ${v(order?.po_number)}` : `Request No. ${request.request_number}`}</div>
          {isPO && <div>Request No. {request.request_number}</div>}
          <div>Document version {version || 1}</div>
          <div>Generated {fmtDateTime(new Date())}</div>
        </div>
      </header>

      <table className="purchase-doc-table">
        <tbody>
          <Row label="Project">{context?.project_code ? `${context.project_code} (ID ${request.project_id})` : "Not a project purchase"}</Row>
          <Row label="Customer">{v(context?.customer)}</Row>
          <Row label="Requesting department">{v(context?.department_name)}</Row>
          <Row label="Requested by">{v(context?.requester_name)} — {fmtDateTime(request.created_at)}</Row>
          <Row label="Department Head approval">{context?.dept_approver_name ? `${context.dept_approver_name} — ${fmtDateTime(request.dept_decided_at)}` : "—"}</Row>
          <Row label="Procurement acceptance">{context?.procurement_decider_name ? `${context.procurement_decider_name} — ${fmtDateTime(request.proc_decided_at)}` : "—"}</Row>
          <Row label="Status">{procStatusLabel(request.proc_status, "en")}</Row>
        </tbody>
      </table>

      <h3 className="purchase-doc-section">Material</h3>
      <table className="purchase-doc-table">
        <tbody>
          <Row label="Material">{v(request.material_name)}</Row>
          <Row label="Category">{v(request.material_category)} ({v(category)})</Row>
          <Row label="Specifications">{v(request.specifications)}</Row>
          <Row label="Quantity">{isPO ? `${v(order?.ordered_quantity)} ${v(request.unit)} ordered (requested ${request.quantity} ${request.unit})` : `${request.quantity} ${request.unit}`}</Row>
          <Row label="Due date">{fmtDate(request.required_by_date)}</Row>
          <Row label="Priority">{v(priority)}{request.is_emergency ? ` — EMERGENCY: ${v(request.emergency_reason)}` : ""}</Row>
          <Row label="Delivery location">{v(request.delivery_location)}</Row>
          <Row label="Remarks">{v(request.remarks)}</Row>
        </tbody>
      </table>

      {isPO && order && (
        <>
          <h3 className="purchase-doc-section">Order</h3>
          <table className="purchase-doc-table">
            <tbody>
              <Row label="Vendor">{v(order.vendors?.name)} — {v(order.vendor_contact)}</Row>
              <Row label="Vendor quotation">{v(order.quotation_reference)}</Row>
              <Row label="Order date">{fmtDate(order.order_date)}</Row>
              <Row label="Amount">Rs {Number(order.total_order_value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</Row>
              <Row label="Expected delivery">{fmtDate(order.expected_delivery_date)}</Row>
              <Row label="Payment terms">{v(order.payment_terms)}</Row>
              {isWork && <Row label="Scope of work">{v(order.scope_of_work)}</Row>}
              <Row label="Procurement remarks">{v(order.remarks)}</Row>
              <Row label="Confirmed by">{v(context?.order_confirmed_by_name)} — {fmtDateTime(order.confirmed_at)}</Row>
            </tbody>
          </table>
        </>
      )}

      <h3 className="purchase-doc-section">Procurement contact</h3>
      <p>{contact?.name ? `${contact.name}${contact.phone ? ` — ${contact.phone}` : " — phone not on record"}` : "No Procurement Head on record"}</p>

      <div className="purchase-doc-signs">
        <div><span />Requested by</div>
        <div><span />Department Head</div>
        <div><span />Procurement Head</div>
        {isPO && <div><span />Vendor acceptance</div>}
      </div>
      <footer className="purchase-doc-foot">
        {isPO ? `PO ${v(order?.po_number)}` : request.request_number} · version {version || 1} · This document records that it was generated and sent to print; it does not confirm a paper copy was printed.
      </footer>
    </div>
  );
}
