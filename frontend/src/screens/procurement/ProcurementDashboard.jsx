import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { acceptOrderTask, getOrderTaskInfo, getReminderOverview, getRequestContext, listPurchaseRequests } from "../../lib/procurementApi";
import {
  DUE_WATCH_STATUSES, L, PROC_STATUS, SETUP_MISSING_TEXT, TASK_FILTERS, TASK_STAGES, daysLeft, fmtDate, isProcurementSetupMissing, priorityLabel,
  procStatusLabel, procurementRoles, remainingText, taskStageLabel, todayIST,
} from "../../lib/procurementRules";
import { subscribeTable } from "../../lib/realtime";
import { useForegroundRefresh } from "../../lib/useForegroundRefresh";
import { friendlyError } from "../../lib/friendlyError";
import ProcurementContactCard from "../../components/ProcurementContactCard";

// The Procurement team's day in one screen. Every order is also a Procurement task (the same record in My Tasks and Bridges):
// the deadline tiles say what is late or due now, the task filters follow the work from "open" to "completed". Counts come
// straight from the orders the user may see (RLS). Days left are counted in IST.
// Deadline tiles. "Within 3 days" includes today and tomorrow, so it is the full "coming up" list.
const DUE_TILES = [
  { key: "overdue", en: "Overdue", gu: "મુદત વીતી", test: (n) => n < 0, tone: "danger" },
  { key: "today", en: "Due today", gu: "આજે ડ્યુ", test: (n) => n === 0, tone: "warn" },
  { key: "tomorrow", en: "Due tomorrow", gu: "આવતીકાલે ડ્યુ", test: (n) => n === 1, tone: "warn" },
  { key: "soon", en: "Due within 3 days", gu: "3 દિવસમાં ડ્યુ", test: (n) => n >= 0 && n <= 3, tone: "soft" },
];
const URGENT = new Set(["URGENT", "EMERGENCY"]);

function dueTone(days, open) {
  if (!open || days === null) return "";
  if (days < 0) return "due-overdue";
  if (days <= 1) return "due-near";
  if (days <= 3) return "due-soon";
  return "";
}

export default function ProcurementDashboard({ lang, profile, lookups }) {
  const [params, setParams] = useSearchParams();
  const due = DUE_TILES.find((t) => t.key === params.get("due")) || null;
  const section = due ? null : TASK_FILTERS.find((s) => s.key === params.get("section")) || TASK_FILTERS[0];
  const [rows, setRows] = useState([]);
  const [ctx, setCtx] = useState({});
  const [tasks, setTasks] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);
  const [reminders, setReminders] = useState(null);
  const [state, setState] = useState({ loading: true, error: null });
  const [dept, setDept] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [today, setToday] = useState(todayIST());
  const roles = procurementRoles(profile, lookups.departments || []);

  const load = useCallback(async () => {
    setToday(todayIST());
    const { data, error } = await listPurchaseRequests({ limit: 2000 });
    if (error) { setState({ loading: false, error: isProcurementSetupMissing(error) ? L(lang, ...SETUP_MISSING_TEXT) : friendlyError(error.message) }); return; }
    setRows(data || []);
    const ids = (data || []).map((x) => x.id);
    const [c, t] = await Promise.all([getRequestContext(ids), getOrderTaskInfo(ids)]);
    setCtx(c);
    setTasks(t);
    setState({ loading: false, error: null });
  }, [lang]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let timer = null;
    const reload = () => { window.clearTimeout(timer); timer = window.setTimeout(load, 400); };
    const unsub = subscribeTable("procurement-dashboard-requests", "purchase_requests", null, reload);
    const unsubTasks = subscribeTable("procurement-dashboard-tasks", "staff_tasks", "source_module=eq.procurement", reload);
    return () => { window.clearTimeout(timer); unsub(); unsubTasks(); };
  }, [load]);
  useForegroundRefresh(load);
  useEffect(() => {
    if (!(roles.isProcurement || roles.isManagement)) return undefined;
    let alive = true;
    getReminderOverview().then(({ data, error }) => { if (alive) setReminders(error ? null : data); });
    return () => { alive = false; };
  }, [roles.isProcurement, roles.isManagement, rows]);

  // Days left for every open order, computed once per load.
  const open = useMemo(() => rows.filter((r) => DUE_WATCH_STATUSES.includes(r.proc_status)).map((r) => ({ r, n: daysLeft(r.required_by_date, today) })), [rows, today]);
  const dueCounts = useMemo(() => Object.fromEntries(DUE_TILES.map((t) => [t.key, open.filter((o) => o.n !== null && t.test(o.n)).length])), [open]);

  const me = profile.id;
  const inSection = useCallback((r) => (!section ? true : section.test(r, tasks[r.id], me)), [section, tasks, me]);
  const counts = useMemo(() => Object.fromEntries(TASK_FILTERS.map((s) => [s.key, rows.filter((r) => s.test(r, tasks[r.id], me)).length])), [rows, tasks, me]);

  const visible = useMemo(() => {
    const base = due ? open.filter((o) => o.n !== null && due.test(o.n)).map((o) => o.r) : rows.filter(inSection);
    const list = base.filter((r) => {
      if (dept && r.requesting_department_id !== dept) return false;
      if (status && r.proc_status !== status) return false;
      const day = (r.created_at || "").slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    });
    // Open work: soonest due date first (overdue on top), urgent before normal on the same day. Records: newest first.
    const work = due || (section && section.key !== "completed" && section.key !== "all");
    return work
      ? [...list].sort((a, b) => String(a.required_by_date || "9999").localeCompare(String(b.required_by_date || "9999"))
        || (URGENT.has(b.priority) ? 1 : 0) - (URGENT.has(a.priority) ? 1 : 0))
      : list;
  }, [rows, open, due, inSection, section, dept, status, from, to]);

  const departments = useMemo(() => {
    const ids = new Set(rows.map((r) => r.requesting_department_id));
    return lookups.departments.filter((d) => ids.has(d.id));
  }, [rows, lookups.departments]);
  const statusesHere = useMemo(() => [...new Set(visible.map((r) => r.proc_status))], [visible]);

  const show = (next) => { setStatus(""); setParams(next, { replace: true }); };
  async function accept(id) {
    setBusyId(id); setActionMsg(null);
    const { error } = await acceptOrderTask(id);
    setBusyId(null);
    setActionMsg(error ? { type: "error", text: friendlyError(error.message) } : { type: "success", text: L(lang, "Accepted — this order task is now yours.", "સ્વીકાર્યું — આ કાર્ય હવે તમારું છે.") });
    await load();
  }

  if (state.loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 120 }} /><div className="skeleton-block" style={{ height: 280 }} /></div>;
  if (state.error) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">{state.error}</div>
        <button className="btn btn-primary" onClick={load}>{L(lang, "Retry", "ફરી પ્રયાસ")}</button>
      </div>
    );
  }

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🧾</div>
        <div className="dept-header-text"><h1>{L(lang, "Procurement", "ખરીદી વિભાગ")}</h1></div>
        <div className="btn-row" style={{ marginLeft: "auto" }}>
          {(roles.isProcurement || roles.isManagement) && <Link className="btn btn-outline" style={{ width: "auto" }} to="/procurement/reminders">⏰ {L(lang, "Reminders", "રિમાઇન્ડર")}</Link>}
          <Link className="btn btn-outline" style={{ width: "auto" }} to="/procurement/vendors">🏢 {L(lang, "Vendors", "વેન્ડરો")}</Link>
          <Link className="btn btn-primary" style={{ width: "auto" }} to="/orders/new">📝 {L(lang, "New order", "નવો ઓર્ડર")}</Link>
        </div>
      </div>

      <ReminderHealth lang={lang} data={reminders} />
      {actionMsg && <div className={`msg ${actionMsg.type}`}>{actionMsg.text}</div>}

      <div className="proc-kpis">
        {DUE_TILES.map((t) => (
          <button key={t.key} type="button" className={`proc-kpi due-tile ${t.tone} ${dueCounts[t.key] ? "has" : ""} ${due?.key === t.key ? "active" : ""}`}
            aria-pressed={due?.key === t.key} onClick={() => show(due?.key === t.key ? {} : { due: t.key })}>
            <strong>{dueCounts[t.key]}</strong><span>{L(lang, t.en, t.gu)}</span>
          </button>
        ))}
      </div>

      <div className="card">
        <div className="tab-strip" role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {TASK_FILTERS.map((s) => (
            <button key={s.key} role="tab" aria-selected={section?.key === s.key} className={`btn ${section?.key === s.key ? "btn-primary" : "btn-outline"}`} style={{ width: "auto" }}
              onClick={() => show({ section: s.key })}>
              {L(lang, s.en, s.gu)} ({counts[s.key]})
            </button>
          ))}
        </div>
        {due && <div className="msg info" style={{ marginTop: 10 }}>{L(lang, `Showing open orders: ${due.en.toLowerCase()}.`, `ખુલ્લા ઓર્ડર: ${due.gu}.`)} <button type="button" className="link-btn" onClick={() => show({})}>{L(lang, "Show all", "બધા બતાવો")}</button></div>}
        <div className="form-grid" style={{ marginTop: 10 }}>
          <div className="field">
            <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label={L(lang, "Department", "વિભાગ")}>
              <option value="">{L(lang, "All departments", "બધા વિભાગ")}</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{lang === "gu" ? d.name_gu : d.name_en}</option>)}
            </select>
          </div>
          <div className="field">
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={L(lang, "Status", "સ્થિતિ")}>
              <option value="">{L(lang, "Any status", "કોઈપણ સ્થિતિ")}</option>
              {statusesHere.map((s) => <option key={s} value={s}>{procStatusLabel(s, lang)}</option>)}
            </select>
          </div>
          <div className="field"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={L(lang, "Order date from", "ઓર્ડર તારીખથી")} /></div>
          <div className="field"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label={L(lang, "Order date to", "ઓર્ડર તારીખ સુધી")} /></div>
        </div>
      </div>

      <div className="order-cards">
        {visible.length === 0 && <div className="card"><div className="msg info">{L(lang, "No orders here.", "અહીં કોઈ ઓર્ડર નથી.")}</div></div>}
        {visible.map((r) => <OrderCard key={r.id} r={r} c={ctx[r.id] || {}} t={tasks[r.id]} lang={lang} today={today}
          onAccept={roles.isProcurement ? accept : null} busy={busyId === r.id} />)}
      </div>

      <ProcurementContactCard lang={lang} profile={profile} />
    </div>
  );
}

export function OrderCard({ r, c, t, lang, today, onAccept, busy }) {
  const isOpen = DUE_WATCH_STATUSES.includes(r.proc_status);
  const n = daysLeft(r.required_by_date, today);
  const tone = dueTone(n, isOpen);
  return (
    <Link to={`/purchase-requests/${r.id}`} className={`card order-card ${tone} ${URGENT.has(r.priority) || r.is_emergency ? "is-urgent" : ""}`}>
      <div className="order-card-top">
        <strong>{r.request_number}</strong>
        <span className={`badge ${PROC_STATUS[r.proc_status]?.tone || "ASSIGNED"}`}>{procStatusLabel(r.proc_status, lang)}</span>
      </div>
      <div className="order-card-title">{r.client_name || (c.project_code ? `${c.project_code} — ${c.customer || ""}` : r.material_name)}</div>
      {t?.stage && <span className={`badge ${TASK_STAGES[t.stage]?.tone || "ASSIGNED"}`} style={{ marginBottom: 6, display: "inline-block" }}>{taskStageLabel(t.stage, lang)}</span>}
      {isOpen && n !== null && <div className={`due-chip ${tone}`}>{n < 0 ? "⚠ " : "⏰ "}{remainingText(n, lang)}</div>}
      <dl className="order-card-grid">
        <dt>{L(lang, "Department", "વિભાગ")}</dt><dd>{c.department_name || "—"}</dd>
        <dt>{L(lang, "Requester", "વિનંતી કરનાર")}</dt><dd>{c.requester_name || "—"}</dd>
        <dt>{L(lang, "Order date", "ઓર્ડર તારીખ")}</dt><dd>{fmtDate(r.created_at)}</dd>
        <dt>{L(lang, "Due date", "ડ્યુ તારીખ")}</dt><dd><strong>{fmtDate(r.required_by_date)}</strong></dd>
        {c.expected_delivery_date && <><dt>{L(lang, "Expected", "અપેક્ષિત")}</dt><dd>{fmtDate(c.expected_delivery_date)}</dd></>}
        {t?.task_number && <><dt>{L(lang, "Task", "કાર્ય")}</dt><dd>{t.task_number}{t.bridge_number ? ` · ${t.bridge_number}` : ""}</dd></>}
        <dt>{L(lang, "Assigned", "સોંપાયેલ")}</dt><dd>{t?.accepted_by ? t.assigned_name : <em>{L(lang, "Not accepted yet", "હજુ કોઈએ સ્વીકાર્યું નથી")}</em>}</dd>
      </dl>
      {onAccept && t?.can_accept && (
        <button type="button" className="btn btn-gold" style={{ width: "auto", marginTop: 8 }} disabled={busy}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onAccept(r.id); }}>{busy ? L(lang, "Accepting…", "સ્વીકારાય છે…") : L(lang, "Accept task", "કાર્ય સ્વીકારો")}</button>
      )}
      {(URGENT.has(r.priority) || r.priority === "HIGH" || r.is_emergency) && (
        <span className={`badge ${URGENT.has(r.priority) || r.is_emergency ? "RETURNED" : "ASSIGNED"}`}>{priorityLabel(r.is_emergency ? "EMERGENCY" : r.priority, lang)}</span>
      )}
    </Link>
  );
}

// Says plainly whether the automatic reminders are actually running, so nobody relies on them when they are not.
function ReminderHealth({ lang, data }) {
  if (!data) return null;
  const last = data.last_run?.finished_at || data.last_run?.started_at;
  const minutes = last ? Math.round((Date.now() - new Date(last).getTime()) / 60000) : null;
  const healthy = data.schedule_active && data.enabled && minutes !== null && minutes <= 30;
  if (healthy && !data.failed_count) return null;
  return (
    <div className={`msg ${healthy ? "info" : "error"}`}>
      {!data.schedule_active ? L(lang, "Automatic reminders are NOT scheduled on the server. Ask the administrator to enable them.", "સર્વર પર આપોઆપ રિમાઇન્ડર ચાલુ નથી. એડમિનને જણાવો.")
        : !data.enabled ? L(lang, "Automatic reminders are switched off in reminder settings.", "રિમાઇન્ડર સેટિંગમાં રિમાઇન્ડર બંધ છે.")
          : minutes === null || minutes > 30 ? L(lang, `Reminder check has not run for ${minutes === null ? "a while" : `${minutes} min`}. Reminders may be delayed.`, "રિમાઇન્ડર તપાસ ચાલી નથી; રિમાઇન્ડર મોડા થઈ શકે.")
            : L(lang, `${data.failed_count} reminder(s) could not be delivered and are being retried.`, `${data.failed_count} રિમાઇન્ડર પહોંચ્યા નથી; ફરી પ્રયાસ ચાલુ છે.`)}
      {" "}<Link to="/procurement/reminders">{L(lang, "Details", "વિગત")}</Link>
    </div>
  );
}
