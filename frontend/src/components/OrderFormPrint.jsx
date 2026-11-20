import React from "react";
import { fmtDate, orderFormTemplate } from "../lib/procurementRules";
import { MOW_LOGO } from "../lib/brand";

// The official Mood of Wood "Production Supply Order Form", drawn to match the company's two printed pads:
//   INTERIOR - small portrait pad printed in red: info grid, numbered item lines, a large Drawings area, Remarks.
//   RETAIL   - large landscape pad printed in navy: info grid and a six-column item table (S.N., Item Code, item details,
//              Qty./Size, Rate, Amount) with at least five rows, then Signature.
// Every value comes from the accepted order; an empty field stays blank, as on the paper pad. The labels are the
// pad's own English + Gujarati wording. Sizes are in `em` so one design serves A5 and A4 (font-size set per paper).

const L = {
  formNo: ["PRODUCTION SUPPLY ORDER FORM NO :", "પ્રોડક્શન સપ્લાય ઓર્ડર ફોર્મ નંબર :"],
  issued: ["Ordered Issued Person Name :", "ઓર્ડર જારી કરાયેલ વ્યક્તિનું નામ :"],
  sales: ["Sales Person Name :", "વેચાણ વ્યક્તિનું નામ :"],
  client: ["Client Name :", "ગ્રાહકનું નામ :"],
  issueDate: ["Product Order issue Date :", "પ્રોડક્ટ ઓર્ડર ઇશ્યુ તારીખ :"],
  vendor: ["Product Vendor Name :", "ઉત્પાદન વિક્રેતાનું નામ :"],
  doneDate: ["Product Done Date :", "ઉત્પાદન પૂર્ણ તારીખ :"],
  delivered: ["Delivered to Client Date :", "ક્લાઈન્ટ ડિલિવરી તારીખ :"],
  items: ["Production Item Details :", "ઉત્પાદન આઇટમ વિગતો :"],
  drawings: ["Drawings :", "ચિત્ર :"],
  remarks: ["Remarks :", "ટિપ્પણીઓ :"],
  signature: ["Signature :", "સહી :"],
};

const date = (d) => (d ? fmtDate(d) : "");
const money = (n) => (n === null || n === undefined || n === "" ? "" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function Label({ k, inline }) {
  return (
    <span className="mowf-label">
      {L[k][0]}{inline ? " " : <br />}<span className="mowf-gu">{L[k][1]}</span>
    </span>
  );
}


// The company block under the logo, from Company Information (Management settings). Empty fields print nothing.
function CompanyBlock({ company }) {
  if (!company) return null;
  const place = [company.city, company.state].filter(Boolean).join(", ") + (company.pin_code ? ` - ${company.pin_code}` : "");
  const contact = [company.phone && `Ph: ${company.phone}`, company.email].filter(Boolean).join(" · ");
  const lines = [company.address_line, place.trim(), contact, company.gstin && `GSTIN: ${company.gstin}`].filter(Boolean);
  if (!company.company_name && !lines.length) return null;
  return (
    <div className="mowf-company">
      {company.company_name && <div className="mowf-company-name">{company.company_name}</div>}
      {lines.map((l) => <div key={l}>{l}</div>)}
    </div>
  );
}

export default function OrderFormPrint({ request, items = [], context, order, files = [], template, meta, company }) {
  if (!request) return null;
  const tpl = template || orderFormTemplate(request);
  const retail = tpl === "RETAIL";
  const vendor = order?.vendors?.name || request.preferred_vendor_name || "";
  const lines = [...items].sort((a, b) => (a.line_no || 0) - (b.line_no || 0));
  const minRows = retail ? 5 : 3;
  const rows = [...lines, ...Array.from({ length: Math.max(0, minRows - lines.length) }, () => null)];
  const hasAmounts = lines.some((i) => i.amount !== null && i.amount !== undefined);
  const total = lines.reduce((s, i) => s + (i.amount === null || i.amount === undefined ? 0 : Number(i.amount)), 0);
  const drawings = files.map((f) => f.original_file_name || f.file_name).filter(Boolean);
  const issuedBy = context?.requester_name || "";
  const client = request.client_name || (context?.project_code ? `${context.project_code}${context.customer ? ` — ${context.customer}` : ""}` : "");

  return (
    <div className={`mowf ${retail ? "mowf-retail" : "mowf-interior"}`}>
      <div className="mowf-frame">
        <header className="mowf-head">
          <div className="mowf-brand">
            <img className="mowf-logo" src={MOW_LOGO} alt="Mood of Wood" />
            <CompanyBlock company={company} />
          </div>
          <div className="mowf-title">
            <div className="mowf-title-en">{L.formNo[0]} <span className="mowf-no">{request.request_number}</span></div>
            <div className="mowf-gu mowf-title-gu">{L.formNo[1]}</div>
          </div>
        </header>

        <table className="mowf-info">
          <colgroup><col className="mowf-c-label" /><col className="mowf-c-value" /><col className="mowf-c-label" /><col className="mowf-c-value" /></colgroup>
          <tbody>
            <tr><th><Label k="issued" /></th><td>{issuedBy}</td><th><Label k="sales" /></th><td>{request.sales_person_name || ""}</td></tr>
            <tr><th><Label k="client" inline /></th><td colSpan={3}>{client}</td></tr>
            <tr><th><Label k="issueDate" /></th><td>{date(order?.order_date || request.created_at)}</td><th><Label k="vendor" /></th><td>{vendor}</td></tr>
            <tr><th><Label k="doneDate" /></th><td>{date(request.required_by_date)}</td><th><Label k="delivered" /></th><td>{date(request.delivered_to_client_at || request.delivery_date)}</td></tr>
          </tbody>
        </table>

        <div className="mowf-band"><span className="mowf-label">{L.items[0]}</span><br /><span className="mowf-label mowf-gu">{L.items[1]}</span></div>

        {retail ? (
          <table className="mowf-items">
            <colgroup><col className="mowf-c-sn" /><col className="mowf-c-code" /><col /><col className="mowf-c-qty" /><col className="mowf-c-rate" /><col className="mowf-c-amt" /></colgroup>
            <thead>
              <tr>
                <th>S.N.</th><th>Item Code</th><th><span className="mowf-gu">આઇટમ વિગતો</span> <span className="mowf-sub">/ Item Description</span></th>
                <th>Qty.Size</th><th>Rate</th><th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i, n) => (
                <tr key={i?.id || `b${n}`}>
                  <td className="mowf-center">{n + 1}</td>
                  <td>{i?.item_code || ""}</td>
                  <td>{i?.description || ""}{i?.line_remarks ? <span className="mowf-sub"> — {i.line_remarks}</span> : null}</td>
                  <td>{i?.qty_size || ""}</td>
                  <td className="mowf-num">{money(i?.rate)}</td>
                  <td className="mowf-num">{money(i?.amount)}</td>
                </tr>
              ))}
              {hasAmounts && (
                <tr className="mowf-total"><td colSpan={5} className="mowf-num"><span className="mowf-label">Total / કુલ</span></td><td className="mowf-num">{money(total)}</td></tr>
              )}
            </tbody>
          </table>
        ) : (
          <table className="mowf-lines">
            <colgroup><col className="mowf-c-sn" /><col /></colgroup>
            <tbody>
              {rows.map((i, n) => (
                <tr key={i?.id || `b${n}`}>
                  <td className="mowf-center mowf-label">{n + 1}</td>
                  <td>
                    {i && <>
                      <span className="mowf-desc">{i.description}</span>
                      {i.item_code && <span className="mowf-sub"> · Code {i.item_code}</span>}
                      {i.qty_size && <span> · {i.qty_size}</span>}
                      {i.line_remarks && <span className="mowf-sub"> · {i.line_remarks}</span>}
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!retail && (
          <section className="mowf-drawings">
            <div className="mowf-drawings-label"><span className="mowf-label">{L.drawings[0]} <span className="mowf-gu">{L.drawings[1]}</span></span></div>
            {drawings.length > 0 && <ol className="mowf-files">{drawings.map((d, n) => <li key={`${d}${n}`}>{d}</li>)}</ol>}
            {drawings.length > 0 && <div className="mowf-sub mowf-follow">Photos and drawings follow on the next pages. / ફોટા અને ચિત્રો આગળના પાનાં પર.</div>}
          </section>
        )}

        {retail && (
          <table className="mowf-info mowf-after">
            <colgroup><col className="mowf-c-label" /><col /></colgroup>
            <tbody>
              <tr><th><Label k="remarks" inline /></th><td>{request.remarks || ""}</td></tr>
              <tr><th><Label k="drawings" inline /></th><td>{drawings.length ? `${drawings.join(", ")} — see the following pages` : ""}</td></tr>
            </tbody>
          </table>
        )}

        <footer className="mowf-foot">
          {!retail && (
            <div className="mowf-remarks"><Label k="remarks" /><div className="mowf-remarks-text">{request.remarks || ""}</div></div>
          )}
          <div className="mowf-sign"><Label k="signature" /><span className="mowf-sign-line" /></div>
        </footer>
      </div>
      {meta && (
        <div className="mowf-meta">
          {[context?.department_name, context?.department_head_name && `Dept Head: ${context.department_head_name}`,
            context?.project_code && `Project: ${context.project_code}`, request.required_by_date && `Due ${date(request.required_by_date)}`,
            meta.taskNumber && `Task ${meta.taskNumber}`, order?.po_number && `PO ${order.po_number}`,
            `v${meta.version || 1}`, meta.printedBy && `Printed by ${meta.printedBy} ${meta.printedAt || ""}`].filter(Boolean).join(" · ")}
        </div>
      )}
    </div>
  );
}
