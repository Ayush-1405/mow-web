import React, { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { assignRequest, listRequestReminders } from "../../lib/procurementApi";
import { DUE_WATCH_STATUSES, L, daysLeft, fmtDate, priorityLabel, remainingText, todayIST } from "../../lib/procurementRules";

// Where an order stands against its due date, for everyone who can see the order -- the requesting department included:
// due date and days left, Procurement acceptance, order placement, expected delivery, delay reason and the latest update.
// Procurement also sees who the order is assigned to (and can reassign it) and every reminder that was sent.

const ACCEPT_PENDING = ["SENT_TO_PROCUREMENT", "CLARIFICATION_REQUIRED", "ON_HOLD"];
const PRE_PROCUREMENT = ["DRAFT", "PENDING_DEPT_APPROVAL", "RETURNED_FOR_CORRECTION", "EMERGENCY_APPROVAL_PENDING", "APPROVED_BY_DEPT_HEAD"];
const REJECTED = ["REJECTED_BY_DEPT_HEAD", "REJECTED_BY_PROCUREMENT", "EMERGENCY_REJECTED", "CANCELLED"];
const KIND_LABEL = {
  ACCEPT_NEW: ["New order alert", "નવો ઓર્ડર"], ACCEPT_2H: ["Not accepted after 2 h", "2 કલાકે સ્વીકાર બાકી"],
  ACCEPT_24H: ["Escalation: not accepted 24 h", "એસ્કેલેશન: 24 કલાક"], ACCEPT_DAILY: ["Daily: acceptance pending", "દૈનિક: સ્વીકાર બાકી"],
  PLACE_NOW: ["Accepted: place the order", "સ્વીકાર્યું: ઓર્ડર મૂકો"], PLACE_24H: ["Escalation: not placed 24 h", "એસ્કેલેશન: ઓર્ડર મૂકાયો નથી"],
  PLACE_DAILY: ["Daily: order not placed", "દૈનિક: ઓર્ડર બાકી"], DUE_3D: ["Due in 3 days", "3 દિવસમાં ડ્યુ"], DUE_1D: ["Due tomorrow", "આવતીકાલે ડ્યુ"],
  DUE_TODAY: ["Due today", "આજે ડ્યુ"], OVERDUE: ["Overdue", "મુદત વીતી"], ESC_MGMT_2D: ["Management: 2 days overdue", "મેનેજમેન્ટ: 2 દિવસ"],
  ESC_CRITICAL_5D: ["Critical: 5 days overdue", "ગંભીર: 5 દિવસ"],
};
const fmtTime = (d) => (d ? `${fmtDate(d)} ${new Date(d).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}` : "—");

export default function DeadlinePanel({ lang, req, ctx, order, roles, procurementDeptId, busy, run }) {
  const open = DUE_WATCH_STATUSES.includes(req.proc_status);
  const n = daysLeft(req.required_by_date, todayIST());
  const [reminders, setReminders] = useState([]);
  const [staff, setStaff] = useState([]);
  const [assignee, setAssignee] = useState("");
  const [assignReason, setAssignReason] = useState("");
  const canSeeReminders = roles.isProcurement || roles.isManagement;
  const canAssign = (roles.canProcure || roles.isManagement) && open;

  useEffect(() => {
    if (!canSeeReminders) return undefined;
    let alive = true;
    listRequestReminders(req.id).then(({ data }) => { if (alive) setReminders(data || []); });
    return () => { alive = false; };
  }, [canSeeReminders, req.id, req.proc_status, req.required_by_date]);

  useEffect(() => {
    if (!canAssign || !procurementDeptId) return undefined;
    let alive = true;
    supabase.from("user_profiles").select("id, full_name").eq("department_id", procurementDeptId).eq("is_active", true).order("full_name")
      .then(({ data }) => { if (alive) setStaff(data || []); });
    return () => { alive = false; };
  }, [canAssign, procurementDeptId]);

  const acceptance = PRE_PROCUREMENT.includes(req.proc_status) ? L(lang, "Not yet with Procurement", "હજુ ખરીદી વિભાગ પાસે નથી")
    : ACCEPT_PENDING.includes(req.proc_status) ? L(lang, "Waiting for Procurement", "ખરીદી વિભાગ પાસે બાકી")
      : req.proc_status === "REJECTED_BY_PROCUREMENT" ? L(lang, "Rejected", "નામંજૂર")
        : REJECTED.includes(req.proc_status) ? L(lang, "Stopped", "બંધ")
          : `${L(lang, "Accepted", "સ્વીકાર્યું")}${req.proc_decided_at ? ` · ${fmtTime(req.proc_decided_at)}` : ""}${ctx?.procurement_decider_name ? ` · ${ctx.procurement_decider_name}` : ""}`;
  const placement = req.order_confirmed_at ? `${L(lang, "Order placed", "ઓર્ડર મૂકાયો")} · ${fmtTime(req.order_confirmed_at)}${order?.po_number ? ` · PO ${order.po_number}` : ""}`
    : ["ACCEPTED_BY_PROCUREMENT", "DOCUMENT_GENERATED"].includes(req.proc_status) ? L(lang, "Accepted, not placed yet", "સ્વીકાર્યું, હજુ મૂકાયો નથી")
      : L(lang, "Not placed", "મૂકાયો નથી");
  // One line per reminder sent (a reminder goes to several people): how many got it and how many have read it.
  const groups = Object.values(reminders.reduce((acc, x) => {
    const key = `${x.kind}|${String(x.sent_at || x.created_at).slice(0, 16)}`;
    const g = acc[key] || (acc[key] = { key, kind: x.kind, at: x.sent_at || x.created_at, sent: 0, read: 0, failed: 0, retrying: 0, stopped: 0 });
    if (x.status === "SENT") g.sent += 1;
    if (x.read_at) g.read += 1;
    if (x.status === "GAVE_UP" || (x.status === "SENT" && x.push_status === "failed")) g.failed += 1;
    if (x.status === "FAILED") g.retrying += 1;
    if (x.status === "STOPPED") g.stopped += 1;
    return acc;
  }, {}));
  const expected = ctx?.expected_delivery_date || order?.expected_delivery_date;
  const late = expected && req.required_by_date && expected > req.required_by_date;

  return (
    <div className={`card ${open && n !== null && n < 0 ? "order-card due-overdue" : ""}`} style={{ margin: 0 }}>
      <h2>{L(lang, "Due date & progress", "ડ્યુ તારીખ અને પ્રગતિ")}</h2>
      <dl className="deadline-panel">
        <div><dt>{L(lang, "Required due date", "જરૂરી ડ્યુ તારીખ")}</dt><dd>{fmtDate(req.required_by_date)}{open && n !== null && <> · <span className={n < 0 ? "due-chip due-overdue" : n <= 1 ? "due-chip due-near" : n <= 3 ? "due-chip due-soon" : "due-chip"}>{remainingText(n, lang)}</span></>}</dd></div>
        <div><dt>{L(lang, "Order date", "ઓર્ડર તારીખ")}</dt><dd>{fmtDate(req.created_at)}</dd></div>
        <div><dt>{L(lang, "Priority", "પ્રાથમિકતા")}</dt><dd>{priorityLabel(req.is_emergency ? "EMERGENCY" : req.priority, lang)}</dd></div>
        {(req.urgency_reason || req.emergency_reason) && <div><dt>{L(lang, "Reason for urgency", "તાત્કાલિકતાનું કારણ")}</dt><dd>{req.urgency_reason || req.emergency_reason}</dd></div>}
        <div><dt>{L(lang, "Procurement acceptance", "ખરીદી સ્વીકાર")}</dt><dd>{acceptance}</dd></div>
        <div><dt>{L(lang, "Order placement", "ઓર્ડર મૂકવો")}</dt><dd>{placement}</dd></div>
        <div><dt>{L(lang, "Expected delivery", "અપેક્ષિત ડિલિવરી")}</dt><dd style={late ? { color: "var(--danger)" } : undefined}>{expected ? fmtDate(expected) : "—"}{late ? ` · ${L(lang, "after the due date", "ડ્યુ તારીખ પછી")}` : ""}</dd></div>
        {ctx?.delay_reason && <div><dt>{L(lang, "Delay reason", "વિલંબનું કારણ")}</dt><dd>{ctx.delay_reason}</dd></div>}
        {req.overdue_since && <div><dt>{L(lang, "Overdue since", "ક્યારથી મોડું")}</dt><dd style={{ color: "var(--danger)" }}>{fmtDate(req.overdue_since)}</dd></div>}
        <div><dt>{L(lang, "Assigned to (Procurement)", "સોંપાયેલ (ખરીદી)")}</dt><dd>{ctx?.assigned_to_name || "—"}</dd></div>
        <div style={{ gridColumn: "1 / -1" }}><dt>{L(lang, "Latest Procurement update", "છેલ્લું અપડેટ")}</dt><dd>{ctx?.latest_update ? `${ctx.latest_update} · ${fmtTime(ctx.latest_update_at)}` : "—"}</dd></div>
      </dl>

      {canAssign && staff.length > 0 && (
        <div className="btn-row" style={{ marginTop: 10, alignItems: "center" }}>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label={L(lang, "Assign to", "સોંપો")} style={{ maxWidth: 260, margin: 0 }}>
            <option value="">{L(lang, "Assign to…", "સોંપો…")}</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
          </select>
          <input value={assignReason} onChange={(e) => setAssignReason(e.target.value)} style={{ maxWidth: 260, margin: 0 }}
            placeholder={L(lang, "Reason (needed to reassign)", "કારણ (ફરી સોંપવા જરૂરી)")} aria-label={L(lang, "Reason", "કારણ")} />
          <button type="button" className="btn btn-outline" style={{ width: "auto", margin: 0 }} disabled={busy || !assignee}
            onClick={() => run(() => assignRequest(req.id, assignee, assignReason), () => { setAssignee(""); setAssignReason(""); })}>{L(lang, "Assign", "સોંપો")}</button>
        </div>
      )}

      {canSeeReminders && (
        <details style={{ marginTop: 10 }}>
          <summary>{L(lang, `Reminders sent (${groups.length})`, `મોકલેલા રિમાઇન્ડર (${groups.length})`)}{ctx?.last_reminder_at ? ` · ${L(lang, "last", "છેલ્લું")} ${fmtTime(ctx.last_reminder_at)}` : ""}</summary>
          {groups.length === 0 ? <div className="sub">{L(lang, "None yet.", "હજુ નથી.")}</div> : (
            <ul className="reminder-log">
              {groups.map((g) => (
                <li key={g.key}>
                  <strong>{L(lang, ...(KIND_LABEL[g.kind] || [g.kind, g.kind]))}</strong>
                  <div className="meta">
                    {fmtTime(g.at)} · {L(lang, `sent to ${g.sent}, read by ${g.read}`, `${g.sent} ને મોકલ્યું, ${g.read} એ વાંચ્યું`)}
                    {g.retrying > 0 && ` · ${L(lang, `${g.retrying} retrying`, `${g.retrying} ફરી પ્રયાસ`)}`}
                    {g.failed > 0 && ` · ${L(lang, `${g.failed} not delivered to phone`, `${g.failed} ફોન પર ન પહોંચ્યું`)}`}
                    {g.stopped > 0 && ` · ${L(lang, `${g.stopped} stopped (stage done)`, `${g.stopped} બંધ`)}`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </div>
  );
}
