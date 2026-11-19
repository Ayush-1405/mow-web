import React, { useCallback, useEffect, useState } from "react";
import {
  addFollowup, addQuotation, closeRequest, emergencyDecision, getInvoice, listDispatches, listFollowups, listPayments, listQuotations, listReceipts,
  listSelections, listVendors, recordGrn, recordInvoice, recordPayment, reviewEmergency, selectQuotation, updateProgress, verifyGrn, verifyInvoice,
} from "../../lib/procurementApi";
import { L, PROGRESS_MOVES, fmtDate, procStatusLabel } from "../../lib/procurementRules";
import { friendlyError } from "../../lib/friendlyError";
import { kolkataDateStr } from "../../lib/kolkataTime";

const rs = (n) => `Rs ${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const fmt = (d) => (d ? `${fmtDate(d)} ${new Date(d).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}` : "—");
const PRE_ORDER = ["ACCEPTED_BY_PROCUREMENT", "DOCUMENT_GENERATED"];
const OPEN_ORDER = ["ORDER_PLACED", "VENDOR_CONFIRMED", "IN_PRODUCTION", "READY_FOR_DISPATCH", "IN_TRANSIT", "DELAYED", "PARTIALLY_RECEIVED"];

// Everything that happens to a request after Procurement accepts it. Each panel shows only to the people the database lets
// act (see procurementRoles); every button calls one proc_* function, which re-checks the role and the status.
export default function PurchaseLifecyclePanels({ lang, req, order, roles, onChanged }) {
  const status = req.proc_status;
  const [data, setData] = useState({ quotations: [], selections: [], followups: [], dispatches: [], receipts: [], invoice: null, payments: [], vendors: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const [q, s, f, d, r, i, p, v] = await Promise.all([
      listQuotations(req.id), listSelections(req.id), listFollowups(req.id), listDispatches(req.id), listReceipts({ requestId: req.id }),
      getInvoice(req.id), listPayments(req.id), roles.isProcurement ? listVendors() : Promise.resolve({ data: [] }),
    ]);
    setData({
      quotations: q.data || [], selections: s.data || [], followups: f.data || [], dispatches: d.data || [], receipts: r.data || [],
      invoice: i.data || null, payments: p.data || [], vendors: (v.data || []).filter((x) => !x.blacklisted),
    });
  }, [req.id, roles.isProcurement]);
  useEffect(() => { load(); }, [load, status]);

  async function run(fn) {
    setBusy(true);
    setError(null);
    const { error: err } = await fn();
    setBusy(false);
    if (err) { setError(friendlyError(err.message)); return false; }
    await load();
    onChanged();
    return true;
  }

  const selected = data.selections[0];
  const accepted = data.receipts.reduce((s, x) => s + Number(x.qty_accepted || 0), 0);
  const outstanding = order ? Number(order.ordered_quantity || 0) - accepted : 0;
  const props = { lang, busy, run, req };

  return (
    <>
      {error && <div className="msg error">{error}</div>}

      {status === "EMERGENCY_APPROVAL_PENDING" && roles.isManagement && <EmergencyDecision {...props} />}
      {req.is_emergency && roles.isManagement && req.order_confirmed_at && !req.emergency_reviewed_at && <EmergencyReview {...props} />}
      {req.emergency_reviewed_at && (
        <div className="msg info">{L(lang, "Emergency post-purchase review", "તાત્કાલિક ખરીદી પછીની સમીક્ષા")}: {req.emergency_review_note} · {fmt(req.emergency_reviewed_at)}</div>
      )}

      {(data.quotations.length > 0 || (roles.isProcurement && PRE_ORDER.includes(status))) && (
        <Quotations {...props} quotations={data.quotations} selected={selected} vendors={data.vendors}
          canAdd={roles.isProcurement && PRE_ORDER.includes(status)} canSelect={roles.canProcure && PRE_ORDER.includes(status)} />
      )}

      {order && (
        <div className="card">
          <h2>{L(lang, "Delivery", "ડિલિવરી")}</h2>
          <div className="task-meta" style={{ flexWrap: "wrap", gap: 12 }}>
            <span>{L(lang, "Ordered", "ઓર્ડર")}: {order.ordered_quantity} {req.unit}</span>
            <span>{L(lang, "Accepted so far", "અત્યાર સુધી સ્વીકાર્યું")}: {accepted} {req.unit}</span>
            <span style={{ fontWeight: 700 }}>{L(lang, "Outstanding", "બાકી")}: {Math.max(outstanding, 0)} {req.unit}</span>
          </div>
          {data.dispatches.map((d) => (
            <div key={d.id} className="sub" style={{ marginTop: 6 }}>
              🚚 {d.transporter || "—"}{d.vehicle_number ? ` · ${d.vehicle_number}` : ""}{d.tracking_number ? ` · ${L(lang, "Tracking", "ટ્રેકિંગ")} ${d.tracking_number}` : ""} ·
              {" "}{L(lang, "dispatched", "રવાના")} {d.dispatch_date || "—"} · {L(lang, "expected", "અપેક્ષિત")} {d.expected_arrival || "—"}{d.notes ? ` · ${d.notes}` : ""}
            </div>
          ))}
          {roles.isProcurement && PROGRESS_MOVES[status] && <Progress {...props} />}
        </div>
      )}

      {order && (roles.isProcurement || data.followups.length > 0) && (
        <Followups {...props} followups={data.followups} canAdd={roles.isProcurement && [...PRE_ORDER, ...OPEN_ORDER].includes(status)} />
      )}

      {order && (data.receipts.length > 0 || ((roles.isGodown || roles.canProcure) && OPEN_ORDER.includes(status))) && (
        <Receipts {...props} receipts={data.receipts} outstanding={outstanding}
          canReceive={(roles.isGodown || roles.canProcure) && OPEN_ORDER.includes(status)}
          canVerify={(roles.isGodownLead || roles.isProcurementHead) && status === "RECEIVED"} />
      )}

      {["GRN_VERIFIED", "INVOICE_VERIFIED", "PAYMENT_PENDING", "PARTIALLY_PAID", "PAID", "CLOSED"].includes(status) && (roles.isProcurement || roles.isAccounts || roles.isManagement) && (
        <Payments {...props} invoice={data.invoice} payments={data.payments} order={order} roles={roles} />
      )}
    </>
  );
}

function Field({ label, children, full }) {
  return <div className={`field${full ? " full" : ""}`}><label>{label}</label>{children}</div>;
}

function useForm(initial) {
  const [f, setF] = useState(initial);
  const bind = (k, type) => ({
    value: type === "checkbox" ? undefined : f[k] ?? "",
    checked: type === "checkbox" ? !!f[k] : undefined,
    type: type || "text",
    onChange: (e) => setF((x) => ({ ...x, [k]: type === "checkbox" ? e.target.checked : e.target.value })),
    ...(type === "number" ? { inputMode: "decimal", min: "0", step: "any" } : {}),
    ...(type === "checkbox" ? { style: { width: "auto" } } : {}),
  });
  return [f, bind, setF];
}

function Quotations({ lang, busy, run, req, quotations, selected, vendors, canAdd, canSelect }) {
  const blank = { vendor_id: "", quotation_number: "", quotation_date: kolkataDateStr(), validity_date: "", material_rate: "", labour_rate: "", other_charges: "", tax: "", transport: "", installation: "", lead_time_days: "", payment_terms: "", warranty: "", quality_rating: "" };
  const [f, bind, setF] = useForm(blank);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const lowest = quotations.length ? Math.min(...quotations.map((q) => Number(q.total_landed_cost))) : null;
  return (
    <div className="card">
      <h2>{L(lang, "Vendor quotations & comparison", "વેન્ડર ભાવપત્રક અને સરખામણી")}</h2>
      {quotations.length === 0 ? <div className="msg info">{L(lang, "No quotations yet.", "હજુ કોઈ ભાવપત્રક નથી.")}</div> : (
        <div className="proc-table-wrap">
          <table className="proc-table">
            <thead><tr>
              <th>{L(lang, "Vendor", "વેન્ડર")}</th><th>{L(lang, "Quote", "ભાવ")}</th><th style={{ textAlign: "right" }}>{L(lang, "Landed total", "કુલ ખર્ચ")}</th>
              <th>{L(lang, "Lead time", "સમય")}</th><th>{L(lang, "Payment", "ચુકવણી")}</th><th>{L(lang, "Warranty", "વોરંટી")}</th><th>{L(lang, "Quality", "ગુણવત્તા")}</th><th>{L(lang, "Valid till", "માન્ય")}</th><th />
            </tr></thead>
            <tbody>
              {quotations.map((q) => (
                <tr key={q.id} style={selected?.selected_quotation_id === q.id ? { background: "var(--success-bg)" } : undefined}>
                  <td>{q.vendors?.name}{Number(q.total_landed_cost) === lowest && <span className="badge COMPLETED" style={{ marginLeft: 6 }}>{L(lang, "Lowest", "સૌથી ઓછો")}</span>}</td>
                  <td>{q.quotation_number}</td><td style={{ textAlign: "right" }}>{rs(q.total_landed_cost)}</td>
                  <td>{q.lead_time_days != null ? `${q.lead_time_days} d` : "—"}</td><td>{q.payment_terms || "—"}</td><td>{q.warranty || "—"}</td>
                  <td>{q.quality_rating ? `${q.quality_rating}/5` : "—"}</td><td>{q.validity_date || "—"}</td>
                  <td>{canSelect && selected?.selected_quotation_id !== q.id && (
                    <button type="button" className="btn btn-outline" style={{ width: "auto", margin: 0 }} disabled={busy}
                      onClick={() => run(() => selectQuotation(req.id, q.id, reason))}>{L(lang, "Select", "પસંદ")}</button>
                  )}{selected?.selected_quotation_id === q.id && <strong>✓ {L(lang, "Selected", "પસંદ")}</strong>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && <div className="sub" style={{ marginTop: 6 }}>{L(lang, "Selection note", "પસંદગી નોંધ")}: {selected.justification_text || L(lang, "lowest quotation", "સૌથી ઓછો ભાવ")}</div>}
      {canSelect && quotations.length > 1 && (
        <input style={{ marginTop: 8 }} value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder={L(lang, "Why this vendor? (required if it isn't the lowest)", "આ વેન્ડર કેમ? (સૌથી ઓછો ન હોય તો જરૂરી)")} />
      )}
      {canAdd && (
        <>
          <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 8 }} onClick={() => setOpen((o) => !o)}>
            {open ? L(lang, "Close", "બંધ") : `+ ${L(lang, "Add quotation", "ભાવપત્રક ઉમેરો")}`}
          </button>
          {open && (
            <form className="form-grid" style={{ marginTop: 8 }} onSubmit={async (e) => { e.preventDefault(); if (await run(() => addQuotation(req.id, f))) { setF(blank); setOpen(false); } }}>
              <Field label={`${L(lang, "Vendor", "વેન્ડર")} *`}>
                <select value={f.vendor_id} onChange={(e) => setF((x) => ({ ...x, vendor_id: e.target.value }))}>
                  <option value="">—</option>
                  {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}{v.approved_status !== "Approved" ? ` (${v.approved_status})` : ""}</option>)}
                </select>
              </Field>
              <Field label={`${L(lang, "Quotation number", "ભાવપત્રક નંબર")} *`}><input {...bind("quotation_number")} /></Field>
              <Field label={`${L(lang, "Quotation date", "ભાવપત્રક તારીખ")} *`}><input {...bind("quotation_date", "date")} /></Field>
              <Field label={L(lang, "Valid till", "માન્ય તારીખ")}><input {...bind("validity_date", "date")} /></Field>
              <Field label={L(lang, "Material (Rs)", "સામગ્રી (રૂ.)")}><input {...bind("material_rate", "number")} /></Field>
              <Field label={L(lang, "Labour (Rs)", "મજૂરી (રૂ.)")}><input {...bind("labour_rate", "number")} /></Field>
              <Field label={L(lang, "Tax (Rs)", "કર (રૂ.)")}><input {...bind("tax", "number")} /></Field>
              <Field label={L(lang, "Transport (Rs)", "પરિવહન (રૂ.)")}><input {...bind("transport", "number")} /></Field>
              <Field label={L(lang, "Installation (Rs)", "ઇન્સ્ટોલેશન (રૂ.)")}><input {...bind("installation", "number")} /></Field>
              <Field label={L(lang, "Other (Rs)", "અન્ય (રૂ.)")}><input {...bind("other_charges", "number")} /></Field>
              <Field label={L(lang, "Lead time (days)", "સમય (દિવસ)")}><input {...bind("lead_time_days", "number")} /></Field>
              <Field label={L(lang, "Quality rating (1–5)", "ગુણવત્તા (1–5)")}><input {...bind("quality_rating", "number")} max="5" /></Field>
              <Field label={L(lang, "Payment terms", "ચુકવણી શરતો")}><input {...bind("payment_terms")} /></Field>
              <Field label={L(lang, "Warranty", "વોરંટી")}><input {...bind("warranty")} /></Field>
              <div className="field full"><button className="btn btn-primary" type="submit" disabled={busy}>{L(lang, "Save quotation", "ભાવપત્રક સાચવો")}</button></div>
            </form>
          )}
        </>
      )}
    </div>
  );
}

function Progress({ lang, busy, run, req }) {
  const moves = PROGRESS_MOVES[req.proc_status] || [];
  const [to, setTo] = useState("");
  const [f, bind, setF] = useForm({ remarks: "", transporter: "", vehicle_number: "", tracking_number: "", dispatch_date: kolkataDateStr(), expected_arrival: "" });
  return (
    <form className="form-grid" style={{ marginTop: 10 }} onSubmit={async (e) => { e.preventDefault(); if (to && await run(() => updateProgress(req.id, to, f))) { setTo(""); setF((x) => ({ ...x, remarks: "" })); } }}>
      <Field label={L(lang, "Update order progress", "ઓર્ડર પ્રગતિ અપડેટ કરો")}>
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">—</option>
          {moves.map((m) => <option key={m} value={m}>{procStatusLabel(m, lang)}</option>)}
        </select>
      </Field>
      <Field label={to === "DELAYED" ? `${L(lang, "Reason for delay", "વિલંબનું કારણ")} *` : L(lang, "Remarks", "નોંધ")}><input {...bind("remarks")} /></Field>
      {to === "IN_TRANSIT" && (
        <>
          <Field label={L(lang, "Transporter", "ટ્રાન્સપોર્ટર")}><input {...bind("transporter")} /></Field>
          <Field label={L(lang, "Vehicle number", "વાહન નંબર")}><input {...bind("vehicle_number")} /></Field>
          <Field label={L(lang, "Tracking / LR number", "ટ્રેકિંગ / LR નંબર")}><input {...bind("tracking_number")} /></Field>
          <Field label={L(lang, "Dispatch date", "રવાના તારીખ")}><input {...bind("dispatch_date", "date")} /></Field>
          <Field label={`${L(lang, "Expected arrival", "અપેક્ષિત આગમન")} *`}><input {...bind("expected_arrival", "date")} /></Field>
        </>
      )}
      <div className="field full"><button className="btn btn-primary" type="submit" disabled={busy || !to}>{L(lang, "Update", "અપડેટ")}</button></div>
    </form>
  );
}

function Followups({ lang, busy, run, req, followups, canAdd }) {
  const [f, bind, setF] = useForm({ notes: "", contact_mode: "Phone", next_date: "", escalate: false });
  return (
    <div className="card">
      <h2>{L(lang, "Vendor follow-up", "વેન્ડર ફોલો-અપ")}</h2>
      {followups.length === 0 && <div className="sub">{L(lang, "No follow-ups yet.", "હજુ કોઈ ફોલો-અપ નથી.")}</div>}
      <ul className="proc-history">
        {followups.map((x) => (
          <li key={x.id}>
            {x.escalation_status === "Escalated" && <span className="badge RETURNED" style={{ marginRight: 6 }}>{L(lang, "Escalated", "એસ્કેલેટ")}</span>}
            {x.notes} <span className="sub">· {x.contact_mode || "—"} · {x.follow_up_date}{x.next_follow_up_date ? ` · ${L(lang, "next", "આગળ")} ${x.next_follow_up_date}` : ""}</span>
          </li>
        ))}
      </ul>
      {canAdd && (
        <form className="form-grid" onSubmit={async (e) => { e.preventDefault(); if (await run(() => addFollowup(req.id, f))) setF({ notes: "", contact_mode: "Phone", next_date: "", escalate: false }); }}>
          <Field label={`${L(lang, "What was discussed", "શું વાત થઈ")} *`} full><input {...bind("notes")} /></Field>
          <Field label={L(lang, "Contact by", "સંપર્ક")}>
            <select value={f.contact_mode} onChange={(e) => setF((x) => ({ ...x, contact_mode: e.target.value }))}>
              {["Phone", "WhatsApp", "Email", "Visit"].map((m) => <option key={m}>{m}</option>)}
            </select>
          </Field>
          <Field label={L(lang, "Next follow-up", "આગળનું ફોલો-અપ")}><input {...bind("next_date", "date")} min={kolkataDateStr()} /></Field>
          <div className="field"><label style={{ display: "flex", gap: 8, alignItems: "center" }}><input {...bind("escalate", "checkbox")} />{L(lang, "Escalate to Management", "મેનેજમેન્ટને એસ્કેલેટ કરો")}</label></div>
          <div className="field full"><button className="btn btn-primary" type="submit" disabled={busy}>{L(lang, "Save follow-up", "ફોલો-અપ સાચવો")}</button></div>
        </form>
      )}
    </div>
  );
}

function Receipts({ lang, busy, run, req, receipts, outstanding, canReceive, canVerify }) {
  const blank = { received: "", accepted: "", rejected: "0", damaged: "0", location: "", qc_remarks: "", rejection_reason: "", corrective_action: "", replacement_required: false };
  const [f, bind, setF] = useForm(blank);
  const [remarks, setRemarks] = useState("");
  return (
    <div className="card">
      <h2>{L(lang, "Goods receipt (GRN)", "માલ પ્રાપ્તિ (GRN)")}</h2>
      {receipts.length === 0 && <div className="sub">{L(lang, "Nothing received yet.", "હજુ કંઈ પ્રાપ્ત થયું નથી.")}</div>}
      {receipts.length > 0 && (
        <div className="proc-table-wrap">
          <table className="proc-table">
            <thead><tr><th>GRN</th><th>{L(lang, "Date", "તારીખ")}</th><th>{L(lang, "Received", "મળ્યું")}</th><th>{L(lang, "Accepted", "સ્વીકાર્યું")}</th><th>{L(lang, "Rejected", "નકાર્યું")}</th><th>{L(lang, "Reason / action", "કારણ / પગલું")}</th><th>{L(lang, "Verified", "ચકાસ્યું")}</th></tr></thead>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.id}>
                  <td>{r.grn_number}</td><td>{r.receipt_date}</td><td>{r.qty_received}</td><td>{r.qty_accepted}</td>
                  <td>{r.qty_rejected}{Number(r.damage_qty) > 0 ? ` (${r.damage_qty} ${L(lang, "damaged", "નુકસાન")})` : ""}</td>
                  <td style={{ whiteSpace: "normal" }}>{[r.rejection_reason, r.corrective_action].filter(Boolean).join(" → ") || "—"}</td>
                  <td>{r.verified_at ? "✓" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canReceive && (
        <form className="form-grid" style={{ marginTop: 10 }}
          onSubmit={async (e) => { e.preventDefault(); if (await run(() => recordGrn(req.id, f))) setF(blank); }}>
          <div className="field full sub">{L(lang, "Outstanding on this order", "આ ઓર્ડરમાં બાકી")}: {outstanding} {req.unit}</div>
          <Field label={`${L(lang, "Received", "મળ્યું")} *`}><input {...bind("received", "number")} /></Field>
          <Field label={`${L(lang, "Accepted", "સ્વીકાર્યું")} *`}><input {...bind("accepted", "number")} /></Field>
          <Field label={L(lang, "Rejected", "નકાર્યું")}><input {...bind("rejected", "number")} /></Field>
          <Field label={L(lang, "Of which damaged", "તેમાંથી નુકસાન")}><input {...bind("damaged", "number")} /></Field>
          <Field label={`${L(lang, "Received at", "ક્યાં મળ્યું")} *`}><input {...bind("location")} placeholder={req.delivery_location || ""} /></Field>
          <Field label={L(lang, "QC remarks", "QC નોંધ")}><input {...bind("qc_remarks")} /></Field>
          {Number(f.rejected) > 0 && (
            <>
              <Field label={`${L(lang, "Rejection reason", "નકારવાનું કારણ")} *`}><input {...bind("rejection_reason")} /></Field>
              <Field label={L(lang, "Corrective action", "સુધારાત્મક પગલું")}><input {...bind("corrective_action")} /></Field>
              <div className="field"><label style={{ display: "flex", gap: 8, alignItems: "center" }}><input {...bind("replacement_required", "checkbox")} />{L(lang, "Vendor must replace", "વેન્ડરે બદલવું પડશે")}</label></div>
            </>
          )}
          <div className="field full"><button className="btn btn-primary" type="submit" disabled={busy}>{L(lang, "Record goods receipt", "માલ પ્રાપ્તિ નોંધો")}</button></div>
        </form>
      )}
      {canVerify && (
        <div style={{ marginTop: 10 }}>
          <input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={L(lang, "Verification remarks", "ચકાસણી નોંધ")} />
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(() => verifyGrn(req.id, remarks))}>✅ {L(lang, "Verify GRN", "GRN ચકાસો")}</button>
        </div>
      )}
    </div>
  );
}

function Payments({ lang, busy, run, req, invoice, payments, order, roles }) {
  const status = req.proc_status;
  const [inv, bindInv] = useForm({ invoice_number: "", invoice_date: kolkataDateStr(), amount: order?.total_order_value ?? "", tax: "0", due_date: "" });
  const [pay, bindPay, setPay] = useForm({ amount: "", paid_on: kolkataDateStr(), mode: "NEFT", reference: "" });
  const [remarks, setRemarks] = useState("");
  const due = invoice ? Number(invoice.invoice_amount) + Number(invoice.tax_amount || 0) : 0;
  return (
    <div className="card">
      <h2>{L(lang, "Invoice & payment", "ઇન્વોઇસ અને ચુકવણી")}</h2>
      {invoice ? (
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 12 }}>
          <span>{L(lang, "Invoice", "ઇન્વોઇસ")} {invoice.invoice_number} · {invoice.invoice_date}</span>
          <span>{L(lang, "Total", "કુલ")} {rs(due)} ({L(lang, "order", "ઓર્ડર")} {rs(order?.total_order_value)})</span>
          <span>{L(lang, "Paid", "ચૂકવ્યું")} {rs(invoice.paid_amount)}</span>
          <span style={{ fontWeight: 700 }}>{L(lang, "Outstanding", "બાકી")} {rs(invoice.pending_amount)}</span>
          <span>{L(lang, "Due", "નિયત તારીખ")} {invoice.due_date}</span>
          <span className="sub">{invoice.status}{invoice.verification_remarks ? ` · ${invoice.verification_remarks}` : ""}</span>
        </div>
      ) : <div className="sub">{L(lang, "No invoice recorded yet.", "હજુ ઇન્વોઇસ નોંધાયું નથી.")}</div>}
      {payments.length > 0 && (
        <ul className="proc-history" style={{ marginTop: 8 }}>
          {payments.map((p) => <li key={p.id} className="sub">{rs(p.amount)} · {p.paid_on} · {p.payment_mode} · {p.reference}</li>)}
        </ul>
      )}

      {roles.isProcurement && status === "GRN_VERIFIED" && !invoice && (
        <form className="form-grid" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); run(() => recordInvoice(req.id, inv)); }}>
          <Field label={`${L(lang, "Invoice number", "ઇન્વોઇસ નંબર")} *`}><input {...bindInv("invoice_number")} /></Field>
          <Field label={`${L(lang, "Invoice date", "ઇન્વોઇસ તારીખ")} *`}><input {...bindInv("invoice_date", "date")} /></Field>
          <Field label={`${L(lang, "Amount before tax (Rs)", "કર પહેલાં રકમ (રૂ.)")} *`}><input {...bindInv("amount", "number")} /></Field>
          <Field label={L(lang, "Tax (Rs)", "કર (રૂ.)")}><input {...bindInv("tax", "number")} /></Field>
          <Field label={`${L(lang, "Payment due by", "ચુકવણી તારીખ")} *`}><input {...bindInv("due_date", "date")} /></Field>
          <div className="field full"><button className="btn btn-primary" type="submit" disabled={busy}>{L(lang, "Send invoice to Accounts", "ઇન્વોઇસ એકાઉન્ટ્સને મોકલો")}</button></div>
        </form>
      )}

      {roles.isAccounts && status === "GRN_VERIFIED" && invoice && (
        <div style={{ marginTop: 8 }}>
          <input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={L(lang, "Remarks (required if rejecting or above the order value)", "નોંધ (નામંજૂર કે ઓર્ડરથી વધુ હોય તો જરૂરી)")} />
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(() => verifyInvoice(req.id, "APPROVE", remarks))}>{L(lang, "Verify invoice", "ઇન્વોઇસ ચકાસો")}</button>
            <button type="button" className="btn btn-outline" style={{ color: "var(--danger, #a23434)" }} disabled={busy} onClick={() => run(() => verifyInvoice(req.id, "REJECT", remarks))}>{L(lang, "Reject invoice", "ઇન્વોઇસ નામંજૂર")}</button>
          </div>
        </div>
      )}

      {roles.isAccounts && ["PAYMENT_PENDING", "PARTIALLY_PAID"].includes(status) && (
        <form className="form-grid" style={{ marginTop: 8 }} onSubmit={async (e) => { e.preventDefault(); if (await run(() => recordPayment(req.id, pay))) setPay((x) => ({ ...x, amount: "", reference: "" })); }}>
          <Field label={`${L(lang, "Amount (Rs)", "રકમ (રૂ.)")} *`}><input {...bindPay("amount", "number")} placeholder={String(invoice?.pending_amount ?? "")} /></Field>
          <Field label={`${L(lang, "Paid on", "ચુકવણી તારીખ")} *`}><input {...bindPay("paid_on", "date")} /></Field>
          <Field label={`${L(lang, "Mode", "રીત")} *`}>
            <select value={pay.mode} onChange={(e) => setPay((x) => ({ ...x, mode: e.target.value }))}>
              {["NEFT", "RTGS", "UPI", "Cheque", "Cash"].map((m) => <option key={m}>{m}</option>)}
            </select>
          </Field>
          <Field label={`${L(lang, "Reference / UTR", "સંદર્ભ / UTR")} *`}><input {...bindPay("reference")} /></Field>
          <div className="field full"><button className="btn btn-primary" type="submit" disabled={busy}>{L(lang, "Record payment", "ચુકવણી નોંધો")}</button></div>
        </form>
      )}

      {roles.canProcure && status === "PAID" && (
        <button type="button" className="btn btn-primary" style={{ width: "auto", marginTop: 8 }} disabled={busy} onClick={() => run(() => closeRequest(req.id, null))}>
          {L(lang, "Close purchase", "ખરીદી બંધ કરો")}
        </button>
      )}
    </div>
  );
}

function EmergencyDecision({ lang, busy, run, req }) {
  const [remarks, setRemarks] = useState("");
  return (
    <div className="card" style={{ borderLeft: "4px solid var(--danger, #a23434)" }}>
      <h2>🚨 {L(lang, "Emergency purchase — your decision", "તાત્કાલિક ખરીદી — તમારો નિર્ણય")}</h2>
      <p>{req.emergency_reason}</p>
      <input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={L(lang, "Remarks (required to reject)", "નોંધ (નામંજૂર કરવા જરૂરી)")} />
      <div className="btn-row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(() => emergencyDecision(req.id, "APPROVE", remarks))}>{L(lang, "Approve — send to Procurement now", "મંજૂર — હમણાં ખરીદી વિભાગને મોકલો")}</button>
        <button type="button" className="btn btn-outline" style={{ color: "var(--danger, #a23434)" }} disabled={busy} onClick={() => run(() => emergencyDecision(req.id, "REJECT", remarks))}>{L(lang, "Reject", "નામંજૂર")}</button>
      </div>
    </div>
  );
}

function EmergencyReview({ lang, busy, run, req }) {
  const [note, setNote] = useState("");
  return (
    <div className="card">
      <h2>{L(lang, "Post-purchase review of this emergency", "આ તાત્કાલિક ખરીદીની સમીક્ષા")}</h2>
      <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={L(lang, "Was the emergency justified? Price and vendor OK?", "તાત્કાલિકતા યોગ્ય હતી? ભાવ અને વેન્ડર બરાબર?")} />
      <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy} onClick={() => run(() => reviewEmergency(req.id, note))}>{L(lang, "Save review", "સમીક્ષા સાચવો")}</button>
    </div>
  );
}
