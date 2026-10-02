import React, { useCallback, useEffect, useState } from "react";
import FactoryHeader from "./FactoryHeader.jsx";
import { listPoVerificationTasks, resolvePoVerification } from "../../lib/factoryApi";
import { fmtDateTime } from "./factoryConstants";

// The real queue behind "multiple possible matches -> Supervisor verification" (handwritten spec, part 4):
// a PO upload that matched more than one existing Job Card never asks the ordinary task creator to understand
// the full Job Card list -- it lands here instead, for Factory Head/Supervisor only, who picks the right one or
// creates a new Job Card. factory_list_po_verification_tasks() already scopes this to Head/Supervisor/oversight
// server-side; this page just renders what it returns.
export default function FactoryPoVerification({ lang, profile }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    const { data, error: err } = await listPoVerificationTasks();
    if (err) { setError(true); return; }
    setError(false);
    setRows(data);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function resolve(taskId, jobCardId) {
    setBusyId(taskId);
    setMsg(null);
    const { error: err } = await resolvePoVerification(taskId, jobCardId);
    setBusyId(null);
    if (err) { setMsg({ type: "error", text: err.message }); return; }
    setMsg({ type: "success", text: lang === "gu" ? "ઉકેલાઈ ગયું" : "Resolved" });
    load();
  }

  return (
    <div className="fx-page">
      <FactoryHeader lang={lang} profile={profile} title={lang === "gu" ? "જોબ કાર્ડ ચકાસણી" : "Job Card Verification"} onRefresh={load} />
      <div className="sub">
        {lang === "gu"
          ? "આ ટાસ્કના PO એક કરતાં વધુ હાલના જોબ કાર્ડ સાથે મેળ ખાય છે. સાચું પસંદ કરો, અથવા નવું જોબ કાર્ડ બનાવો."
          : "These tasks' PO uploads matched more than one existing Job Card. Pick the correct one, or create a new Job Card."}
      </div>

      {error && <div className="msg error">{lang === "gu" ? "લોડ કરવામાં નિષ્ફળ" : "Failed to load"} <button className="btn btn-outline" onClick={load}>{lang === "gu" ? "ફરી પ્રયાસ કરો" : "Retry"}</button></div>}
      {msg && <div className={`msg ${msg.type}`}>{msg.text}</div>}
      {rows === null && !error && <div className="skeleton-block" style={{ height: 160 }} />}
      {rows && rows.length === 0 && <div className="fx-empty">{lang === "gu" ? "કોઈ ચકાસણી બાકી નથી" : "Nothing waiting for verification"}</div>}

      {rows && rows.map((r) => (
        <div key={r.task_id} className="fx-section" style={{ marginBottom: 12 }}>
          <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <div>
              <strong>{r.title}</strong>
              <div className="sub">
                {r.task_number} · {r.factory_segment_code}{r.po_order_number ? ` · PO ${r.po_order_number}` : ""} · {r.assigned_by_name || "—"} · {fmtDateTime(r.created_at)}
              </div>
            </div>
          </div>

          <div className="sub" style={{ marginTop: 8, fontWeight: 700 }}>{lang === "gu" ? "સંભવિત જોબ કાર્ડ" : "Possible Job Cards"}</div>
          {(r.candidates || []).map((c) => (
            <div key={c.id} className="fx-row" style={{ marginTop: 6 }}>
              <div className="top">
                <div>
                  <span className="no">{c.job_order_number}</span>
                  <div className="item">{c.product_item || "—"}</div>
                  <div className="meta">{c.customer_name || "—"}{c.po_number ? ` · PO ${c.po_number}` : ""} · {c.factory_status}</div>
                </div>
                <button type="button" className="btn btn-primary" style={{ width: "auto", minHeight: 44 }} disabled={busyId === r.task_id}
                  onClick={() => resolve(r.task_id, c.id)}>
                  {lang === "gu" ? "આ જોબ કાર્ડ જોડો" : "Link this Job Card"}
                </button>
              </div>
            </div>
          ))}
          <button type="button" className="btn btn-outline" style={{ marginTop: 10 }} disabled={busyId === r.task_id} onClick={() => resolve(r.task_id, null)}>
            ➕ {lang === "gu" ? "તેના બદલે નવું જોબ કાર્ડ બનાવો" : "Create New Job Card Instead"}
          </button>
        </div>
      ))}
    </div>
  );
}
