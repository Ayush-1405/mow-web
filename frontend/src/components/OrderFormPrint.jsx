import React from "react";
import { fmtDate, priorityLabel } from "../lib/procurementRules";

// Mood of Wood "Production Supply Order Form" -- the company's physical order stationery, drawn for printing.
// INTERIOR: compact form (A5): item, code, qty/size and remarks per line, plus a drawings box.
// RETAIL: large form (A4): S.N., item code, description, qty/size, rate, amount, with at least five lines and a total.
// Rendered outside #root and shown only by the print stylesheet, like PurchaseDocument. Labels are English + Gujarati,
// as on the paper forms. Empty values print as blank writing lines, the way the paper form is filled in by hand.

const LOGO = "/icons/icon-512.png";
const fmt = (d) => (d ? fmtDate(d) : "");
const money = (n) => (n === null || n === undefined || n === "" ? "" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function Field({ en, gu, value }) {
  return (
    <div className="of-field">
      <span className="of-label">{en} <span className="of-gu">/ {gu}</span> :</span>
      <span className="of-value">{value || ""}</span>
    </div>
  );
}

export default function OrderFormPrint({ request, items, context, order, files, contact }) {
  if (!request) return null;
  const retail = request.order_form_type === "RETAIL";
  const vendor = order?.vendors?.name || request.preferred_vendor_name;
  const rows = retail ? [...items, ...Array.from({ length: Math.max(0, 5 - items.length) }, () => null)] : items;
  const total = items.reduce((s, i) => s + (i.amount === null || i.amount === undefined ? 0 : Number(i.amount)), 0);
  const hasAmounts = items.some((i) => i.amount !== null && i.amount !== undefined);

  return (
    <div className={`purchase-doc order-form ${retail ? "order-form-retail" : "order-form-interior"}`} aria-hidden="true">
      <header className="of-head">
        <img src={LOGO} alt="" className="of-logo" />
        <div className="of-brand">
          <div className="of-company">MOOD OF WOOD</div>
          <div className="of-title">PRODUCTION SUPPLY ORDER FORM <span className="of-gu">/ પ્રોડક્શન સપ્લાય ઓર્ડર ફોર્મ</span></div>
        </div>
        <div className="of-no">
          <span className="of-label">NO. / નં.</span>
          <span className="of-number">{request.request_number}</span>
        </div>
      </header>

      <section className="of-info">
        <Field en="Ordered Issued Person Name" gu="ઓર્ડર આપનારનું નામ" value={context?.requester_name} />
        <Field en="Sales Person Name" gu="સેલ્સ પર્સનનું નામ" value={request.sales_person_name} />
        <Field en="Client Name" gu="ગ્રાહકનું નામ" value={request.client_name || context?.customer} />
        <Field en="Product Order Issue Date" gu="ઓર્ડર આપ્યાની તારીખ" value={fmt(order?.order_date || request.created_at)} />
        <Field en="Product Vendor Name" gu="વેન્ડરનું નામ" value={vendor} />
        <Field en="Due Date (Product Done)" gu="ડ્યુ તારીખ (પ્રોડક્ટ તૈયાર)" value={fmt(request.required_by_date)} />
        <Field en="Delivered to Client Date" gu="ગ્રાહકને ડિલિવરી તારીખ" value={fmt(request.delivered_to_client_at || request.delivery_date)} />
        {(request.is_emergency || (request.priority && request.priority !== "NORMAL")) && (
          <Field en="Priority" gu="પ્રાથમિકતા" value={`${priorityLabel(request.is_emergency ? "EMERGENCY" : request.priority)}${request.urgency_reason || request.emergency_reason ? ` — ${request.urgency_reason || request.emergency_reason}` : ""}`} />
        )}
        {context?.project_code && <Field en="Project" gu="પ્રોજેક્ટ" value={`${context.project_code}${context.customer ? ` — ${context.customer}` : ""}`} />}
      </section>

      <div className="of-section-title">PRODUCTION ITEM DETAILS <span className="of-gu">/ પ્રોડક્શન આઇટમ વિગત</span></div>
      <table className="of-table">
        <thead>
          {retail ? (
            <tr>
              <th className="of-sn">S.N.<div className="of-gu">ક્રમ</div></th>
              <th className="of-code">Item Code<div className="of-gu">આઇટમ કોડ</div></th>
              <th>Item Description<div className="of-gu">આઇટમ વર્ણન</div></th>
              <th className="of-qty">Qty. / Size<div className="of-gu">જથ્થો / માપ</div></th>
              <th className="of-rate">Rate<div className="of-gu">ભાવ</div></th>
              <th className="of-amt">Amount<div className="of-gu">રકમ</div></th>
            </tr>
          ) : (
            <tr>
              <th className="of-sn">S.N.<div className="of-gu">ક્રમ</div></th>
              <th>Item Description<div className="of-gu">આઇટમ વર્ણન</div></th>
              <th className="of-code">Item Code<div className="of-gu">આઇટમ કોડ</div></th>
              <th className="of-qty">Qty. / Size<div className="of-gu">જથ્થો / માપ</div></th>
              <th>Remarks<div className="of-gu">નોંધ</div></th>
            </tr>
          )}
        </thead>
        <tbody>
          {rows.map((i, n) => (retail ? (
            <tr key={i?.id || `blank-${n}`}>
              <td className="of-sn">{n + 1}</td>
              <td>{i?.item_code || ""}</td>
              <td>{i?.description || ""}</td>
              <td>{i?.qty_size || ""}</td>
              <td className="of-num">{money(i?.rate)}</td>
              <td className="of-num">{money(i?.amount)}</td>
            </tr>
          ) : (
            <tr key={i?.id || `blank-${n}`}>
              <td className="of-sn">{n + 1}</td>
              <td>{i?.description || ""}</td>
              <td>{i?.item_code || ""}</td>
              <td>{i?.qty_size || ""}</td>
              <td>{i?.line_remarks || ""}</td>
            </tr>
          )))}
          {retail && (
            <tr className="of-total">
              <td colSpan={5}>TOTAL <span className="of-gu">/ કુલ</span></td>
              <td className="of-num">{hasAmounts ? money(total) : ""}</td>
            </tr>
          )}
        </tbody>
      </table>

      <section className="of-bottom">
        <div className="of-box of-drawings">
          <div className="of-label">DRAWINGS <span className="of-gu">/ ડ્રોઇંગ</span></div>
          {files?.length ? (
            <ol>{files.map((f) => <li key={f.id}>{f.original_file_name || f.file_name}</li>)}</ol>
          ) : <div className="of-empty-box" />}
        </div>
        <div className="of-box">
          <div className="of-label">REMARKS <span className="of-gu">/ નોંધ</span></div>
          <div className="of-remarks">{request.remarks || ""}</div>
        </div>
      </section>

      <section className="of-signs">
        <div><span className="of-line">{context?.requester_name || ""}</span>Ordered by <span className="of-gu">/ ઓર્ડર આપનાર</span></div>
        <div><span className="of-line">{context?.dept_approver_name || context?.department_head_name || ""}</span>Department Head <span className="of-gu">/ વિભાગ વડા</span></div>
        <div><span className="of-line">{context?.procurement_decider_name || ""}</span>Procurement <span className="of-gu">/ ખરીદી</span></div>
        <div><span className="of-line" />Signature <span className="of-gu">/ સહી</span></div>
      </section>

      <footer className="of-foot">
        {context?.department_name} · {request.delivery_location ? `Deliver to: ${request.delivery_location} · ` : ""}
        Procurement Head: {contact?.name || "—"}{contact?.phone ? ` (${contact.phone})` : ""}
        {order?.po_number ? ` · PO ${order.po_number}` : ""} · Printed {fmtDate(new Date().toISOString())} {new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}
      </footer>
    </div>
  );
}
