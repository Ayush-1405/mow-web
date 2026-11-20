import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { acceptOrderTask, changeDueDate, finishOrderTask, getOrderTaskInfo, reopenOrderTask } from "../../lib/procurementApi";
import { L, TASK_STAGES, fmtDate, taskStageLabel, todayIST } from "../../lib/procurementRules";

// The order's Procurement task: the same record that is in My Tasks and the Cross-Department Bridge. Shows who has it and
// where the work stands, and offers only what the database will allow: accept, mark done (once delivered and verified),
// reopen (Procurement Head) and change the due date (with a reason). Every button calls one proc_* function.

const fmtTime = (d) => (d ? `${fmtDate(d)} ${new Date(d).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}` : "—");
const CLOSED = ["CLOSED", "CANCELLED", "REJECTED_BY_DEPT_HEAD", "REJECTED_BY_PROCUREMENT", "EMERGENCY_REJECTED", "LEGACY"];

export default function OrderTaskPanel({ lang, req, roles, profile, busy, run, onInfo, canPrint, onPrint }) {
  const [info, setInfo] = useState(null);
  const [remarks, setRemarks] = useState("");
  const [reopenReason, setReopenReason] = useState("");
  const [due, setDue] = useState({ date: "", reason: "" });

  useEffect(() => {
    let alive = true;
    getOrderTaskInfo([req.id]).then((m) => { if (alive) { setInfo(m[req.id] || null); onInfo?.(m[req.id] || null); } });
    return () => { alive = false; };
    // Reload whenever the order changes (status, due date, assignment).
  }, [req.id, req.proc_status, req.required_by_date, req.proc_assigned_to, req.proc_updated_at, onInfo]);

  const isDeptHead = !!profile.permissions?.isDepartmentHead && profile.department_id === req.requesting_department_id;
  const canChangeDue = !CLOSED.includes(req.proc_status) && (roles.canProcure || roles.isManagement || isDeptHead);
  const canReopen = (roles.isProcurementHead || roles.isManagement) && ["COMPLETED", "VERIFIED", "CLOSED"].includes(info?.task_status) && req.proc_status !== "CANCELLED";
  const taskDone = ["COMPLETED", "VERIFIED", "CLOSED"].includes(info?.task_status);

  if (!info?.task_id) {
    if (req.proc_status === "DRAFT") return null;
    return <div className="card"><div className="msg info">{L(lang, "This order has no Procurement task yet.", "આ ઓર્ડરનું ખરીદી કાર્ય હજુ નથી.")}</div></div>;
  }

  return (
    <div className="card">
      <h2>{L(lang, "Procurement task", "ખરીદી કાર્ય")}</h2>
      <dl className="deadline-panel">
        <div><dt>{L(lang, "Task", "કાર્ય")}</dt><dd><Link to={`/tasks?focus=${info.task_id}`}>{info.task_number}</Link>{info.bridge_number && <> · <Link to="/bridges">{info.bridge_number}</Link></>}</dd></div>
        <div><dt>{L(lang, "Stage", "તબક્કો")}</dt><dd><span className={`badge ${TASK_STAGES[info.stage]?.tone || "ASSIGNED"}`}>{taskStageLabel(info.stage, lang)}</span></dd></div>
        <div><dt>{L(lang, "Task due date", "કાર્ય ડ્યુ તારીખ")}</dt><dd>{fmtDate(info.task_due_date)}</dd></div>
        <div><dt>{L(lang, "Handled by", "સંભાળનાર")}</dt><dd>{info.accepted_by ? info.assigned_name : L(lang, `Not accepted yet (open to ${info.open_to_count} in Procurement)`, `હજુ સ્વીકાર્યું નથી (${info.open_to_count} ને દેખાય છે)`)}</dd></div>
        {info.accepted_by && <div><dt>{L(lang, "Accepted by", "સ્વીકારનાર")}</dt><dd>{info.accepted_by_name} · {fmtTime(info.accepted_at)}</dd></div>}
        <div><dt>{L(lang, "Procurement Head", "ખરીદી વડા")}</dt><dd>{info.procurement_head_name || "—"}</dd></div>
        {info.completed_at && <div style={{ gridColumn: "1 / -1" }}><dt>{L(lang, "Marked done", "પૂર્ણ ચિહ્નિત")}</dt><dd>{info.completed_by_name} · {fmtTime(info.completed_at)} · {info.completion_note}</dd></div>}
        {info.verified_at && <div><dt>{L(lang, "Verified", "ચકાસ્યું")}</dt><dd>{info.verified_by_name} · {fmtTime(info.verified_at)}</dd></div>}
      </dl>

      {canPrint && onPrint && ["ACCEPTED_BY_PROCUREMENT", "DOCUMENT_GENERATED"].includes(req.proc_status) && (
        <button type="button" className="btn btn-primary" style={{ width: "auto", marginTop: 10, fontSize: 18, minHeight: 56, padding: "0 24px" }} disabled={busy} onClick={onPrint}>
          🖨 {req.proc_status === "ACCEPTED_BY_PROCUREMENT" ? L(lang, "PRINT ORDER FORM", "ઓર્ડર ફોર્મ છાપો") : L(lang, "Print order form again", "ઓર્ડર ફોર્મ ફરી છાપો")}
        </button>
      )}
      {info.can_accept && (
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-gold" style={{ width: "auto", margin: 0 }} disabled={busy} onClick={() => run(() => acceptOrderTask(req.id))}>
            {L(lang, "Accept order", "ઓર્ડર સ્વીકારો")}
          </button>
          {req.proc_status === "PENDING_DEPT_APPROVAL" && (
            <div className="sub" style={{ marginTop: 4 }}>{L(lang, "No Department Head approval needed — accepting assigns it to you and unlocks printing.",
              "વિભાગ વડાની મંજૂરી જરૂરી નથી — સ્વીકારતાં તે તમને સોંપાશે અને પ્રિન્ટ ખુલશે.")}</div>
          )}
        </div>
      )}

      {roles.isProcurement && info.accepted_by && !taskDone && !CLOSED.includes(req.proc_status) && (
        info.can_finish ? (
          <div className="field" style={{ marginTop: 10 }}>
            <label>{L(lang, "Completion remarks", "પૂર્ણતા નોંધ")} *</label>
            <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={L(lang, "What was delivered and checked", "શું ડિલિવર થયું અને ચકાસ્યું")} />
            <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy || !remarks.trim()}
              onClick={() => run(() => finishOrderTask(req.id, remarks), () => setRemarks(""))}>
              {L(lang, "Mark task done (send for verification)", "કાર્ય પૂર્ણ ચિહ્નિત કરો")}
            </button>
          </div>
        ) : info.finish_blocker && (
          <div className="sub" style={{ marginTop: 10 }}>{L(lang, "Can be marked done when: ", "પૂર્ણ ક્યારે થઈ શકે: ")}{info.finish_blocker}.</div>
        )
      )}
      {info.task_status === "COMPLETED" && req.proc_status !== "CLOSED" && (
        <div className="msg info" style={{ marginTop: 10 }}>{L(lang, "Marked done — waiting for the Procurement Head to verify and complete the order.", "પૂર્ણ ચિહ્નિત — ખરીદી વડાની ચકાસણી બાકી.")}</div>
      )}

      {canReopen && (
        <details style={{ marginTop: 10 }}>
          <summary>{L(lang, "Reopen task", "કાર્ય ફરી ખોલો")}</summary>
          <div className="btn-row" style={{ alignItems: "center", marginTop: 6 }}>
            <input value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} placeholder={L(lang, "Reason", "કારણ")} style={{ maxWidth: 320, margin: 0 }} />
            <button type="button" className="btn btn-outline" style={{ width: "auto", margin: 0 }} disabled={busy || !reopenReason.trim()}
              onClick={() => run(() => reopenOrderTask(req.id, reopenReason), () => setReopenReason(""))}>{L(lang, "Reopen", "ફરી ખોલો")}</button>
          </div>
        </details>
      )}

      {canChangeDue && (
        <details style={{ marginTop: 10 }}>
          <summary>{L(lang, "Change due date", "ડ્યુ તારીખ બદલો")}</summary>
          <div className="form-grid" style={{ marginTop: 6 }}>
            <div className="field"><label>{L(lang, "New due date", "નવી ડ્યુ તારીખ")}</label>
              <input type="date" min={todayIST()} value={due.date} onChange={(e) => setDue((d) => ({ ...d, date: e.target.value }))} /></div>
            <div className="field"><label>{L(lang, "Reason", "કારણ")} *</label>
              <input value={due.reason} onChange={(e) => setDue((d) => ({ ...d, reason: e.target.value }))} /></div>
            <div className="field full">
              <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={busy || !due.date || !due.reason.trim()}
                onClick={() => run(() => changeDueDate(req.id, due.date, due.reason), () => setDue({ date: "", reason: "" }))}>
                {L(lang, "Save new due date", "નવી ડ્યુ તારીખ સાચવો")}
              </button>
              <div className="sub">{L(lang, "The task, Bridge and reminders follow; the assigned employee, Procurement Head and requester are notified.", "કાર્ય, બ્રિજ અને રિમાઇન્ડર બદલાશે; સંબંધિત લોકોને જાણ થશે.")}</div>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
