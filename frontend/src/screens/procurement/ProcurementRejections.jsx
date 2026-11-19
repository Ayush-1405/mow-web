import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listPurchaseRequests, listReceipts } from "../../lib/procurementApi";
import { L, QUEUES, procStatusLabel } from "../../lib/procurementRules";
import { subscribeTable } from "../../lib/realtime";
import { friendlyError } from "../../lib/friendlyError";

// Rejections register: material rejected at goods receipt (quantity, reason, corrective action, replacement) and requests
// rejected by a Department Head, Procurement or Management.
export default function ProcurementRejections({ lang }) {
  const [receipts, setReceipts] = useState([]);
  const [requests, setRequests] = useState([]);
  const [state, setState] = useState({ loading: true, error: null });

  const load = useCallback(async () => {
    const [r, q] = await Promise.all([listReceipts({ onlyRejected: true }), listPurchaseRequests({ statuses: QUEUES.stopped.filter((s) => s !== "CANCELLED") })]);
    if (r.error || q.error) { setState({ loading: false, error: friendlyError((r.error || q.error).message) }); return; }
    setReceipts(r.data || []);
    setRequests(q.data || []);
    setState({ loading: false, error: null });
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("procurement-rejections", "purchase_receipts", null, () => load()), [load]);

  if (state.loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 300 }} /></div>;
  if (state.error) return <div className="dept-dashboard"><div className="msg error">{state.error}</div><button className="btn btn-primary" onClick={load}>{L(lang, "Retry", "ફરી પ્રયાસ")}</button></div>;

  return (
    <div className="dept-dashboard">
      <div className="dept-header card"><div className="dept-header-icon" aria-hidden="true">⛔</div><div className="dept-header-text"><h1>{L(lang, "Rejections", "નામંજૂરી")}</h1></div></div>
      <div className="card">
        <h2>{L(lang, "Material rejected at receipt", "પ્રાપ્તિ વખતે નકારેલ સામગ્રી")}</h2>
        {receipts.length === 0 ? <div className="msg info">{L(lang, "No material has been rejected.", "કોઈ સામગ્રી નકારાઈ નથી.")}</div> : (
          <div className="proc-table-wrap">
            <table className="proc-table">
              <thead><tr><th>GRN</th><th>{L(lang, "Request", "વિનંતી")}</th><th>{L(lang, "Rejected", "નકાર્યું")}</th><th>{L(lang, "Reason", "કારણ")}</th><th>{L(lang, "Corrective action", "સુધારાત્મક પગલું")}</th><th>{L(lang, "Replace", "બદલવું")}</th><th>{L(lang, "Date", "તારીખ")}</th></tr></thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.id}>
                    <td>{r.grn_number}</td>
                    <td><Link to={`/purchase-requests/${r.purchase_request_id}`}>{r.purchase_requests?.request_number} — {r.purchase_requests?.material_name}</Link></td>
                    <td>{r.qty_rejected} {r.purchase_requests?.unit}{Number(r.damage_qty) > 0 ? ` (${r.damage_qty} ${L(lang, "damaged", "નુકસાન")})` : ""}</td>
                    <td style={{ whiteSpace: "normal" }}>{r.rejection_reason || "—"}</td><td style={{ whiteSpace: "normal" }}>{r.corrective_action || "—"}</td>
                    <td>{r.replacement_required ? L(lang, "Yes", "હા") : L(lang, "No", "ના")}</td><td>{r.receipt_date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <h2>{L(lang, "Rejected requests", "નામંજૂર વિનંતીઓ")}</h2>
        {requests.length === 0 && <div className="msg info">{L(lang, "No rejected requests.", "કોઈ નામંજૂર વિનંતી નથી.")}</div>}
        {requests.map((r) => (
          <div key={r.id} className="proc-row">
            <Link to={`/purchase-requests/${r.id}`}>
              <div style={{ fontWeight: 700 }}>{r.request_number} — {r.material_name}</div>
              <div className="sub">{r.proc_decision_remarks || r.dept_decision_remarks || "—"}</div>
            </Link>
            <span className="badge RETURNED">{procStatusLabel(r.proc_status, lang)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
