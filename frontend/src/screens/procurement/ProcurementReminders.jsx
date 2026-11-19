import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getReminderOverview, listRecentReminders, runRemindersNow, setHoliday, setReminderSettings } from "../../lib/procurementApi";
import { L, fmtDate, procurementRoles, todayIST } from "../../lib/procurementRules";
import { friendlyError } from "../../lib/friendlyError";

// Automatic reminders, in plain words: are they running, when did they last run, which days and hours they go out on, and
// the company holidays they skip. The reminders themselves are sent by the database every 15 minutes (pg_cron), whether or
// not anyone has the app open; this page only shows and changes the rules. Procurement Head and Management can change them.

const DAYS = [[1, "Mon", "સોમ"], [2, "Tue", "મંગળ"], [3, "Wed", "બુધ"], [4, "Thu", "ગુરુ"], [5, "Fri", "શુક્ર"], [6, "Sat", "શનિ"], [7, "Sun", "રવિ"]];
const fmtTime = (d) => (d ? `${fmtDate(d)} ${new Date(d).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}` : "—");

export default function ProcurementReminders({ lang, profile, lookups }) {
  const roles = useMemo(() => procurementRoles(profile, lookups.departments), [profile, lookups.departments]);
  const canEdit = roles.isProcurementHead || roles.isManagement;
  const [data, setData] = useState(null);
  const [recent, setRecent] = useState([]);
  const [form, setForm] = useState(null);
  const [holiday, setHolidayForm] = useState({ date: "", name: "" });
  const [state, setState] = useState({ loading: true, error: null });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    const [o, r] = await Promise.all([getReminderOverview(), listRecentReminders(60)]);
    if (o.error) { setState({ loading: false, error: friendlyError(o.error.message) }); return; }
    setData(o.data);
    setRecent(r.data || []);
    setForm({ enabled: o.data.enabled, working_days: o.data.working_days || [], window_start: o.data.window_start, window_end: o.data.window_end });
    setState({ loading: false, error: null });
  }, []);
  useEffect(() => { load(); }, [load]);

  async function act(fn, ok) {
    setBusy(true); setMsg(null);
    const { data: res, error } = await fn();
    setBusy(false);
    if (error) { setMsg({ type: "error", text: friendlyError(error.message) }); return; }
    setMsg({ type: "success", text: typeof ok === "function" ? ok(res) : ok });
    await load();
  }

  if (state.loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 260 }} /></div>;
  if (state.error) return <div className="dept-dashboard"><div className="msg error">{state.error}</div><button className="btn btn-primary" style={{ width: "auto" }} onClick={load}>{L(lang, "Retry", "ફરી પ્રયાસ")}</button></div>;

  const last = data.last_run;
  const minutes = last ? Math.round((Date.now() - new Date(last.finished_at || last.started_at).getTime()) / 60000) : null;
  const running = data.schedule_active && minutes !== null && minutes <= 30;
  const toggleDay = (d) => setForm((f) => ({ ...f, working_days: f.working_days.includes(d) ? f.working_days.filter((x) => x !== d) : [...f.working_days, d].sort() }));

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">⏰</div>
        <div className="dept-header-text">
          <h1>{L(lang, "Order reminders", "ઓર્ડર રિમાઇન્ડર")}</h1>
          <div className="sub">{L(lang, "Sent automatically by the server every 15 minutes, even when every phone has the app closed.", "સર્વર દર 15 મિનિટે આપોઆપ મોકલે છે, ભલે એપ બંધ હોય.")}</div>
        </div>
        <Link className="btn btn-outline" style={{ width: "auto", marginLeft: "auto" }} to="/procurement">{L(lang, "Back", "પાછા")}</Link>
      </div>

      {msg && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="card">
        <h2>{L(lang, "Status", "સ્થિતિ")}</h2>
        <div className={`msg ${running && data.enabled ? "success" : "error"}`}>
          {!data.schedule_active ? L(lang, "Not scheduled on the server: reminders will NOT go out. The administrator must enable pg_cron and re-run the reminders migration.", "સર્વર પર શેડ્યૂલ નથી: રિમાઇન્ડર નહીં જાય.")
            : !data.enabled ? L(lang, "Switched off below: only the immediate new-order and acceptance messages go out.", "નીચે બંધ છે: ફક્ત તાત્કાલિક સંદેશા જશે.")
              : running ? L(lang, `Running. Last check ${minutes} min ago.`, `ચાલુ છે. છેલ્લી તપાસ ${minutes} મિનિટ પહેલાં.`)
                : L(lang, `Scheduled, but the last check was ${minutes === null ? "never" : `${minutes} min ago`}. Reminders may be delayed.`, "શેડ્યૂલ છે, પણ તપાસ ચાલી નથી.")}
        </div>
        <dl className="deadline-panel" style={{ marginTop: 10 }}>
          <div><dt>{L(lang, "Procurement Head (receives escalations)", "ખરીદી વડા (એસ્કેલેશન)")}</dt><dd>{data.head_name || L(lang, "Not set — reminders go to the whole Procurement team", "સેટ નથી — આખી ટીમને જશે")}</dd></div>
          <div><dt>{L(lang, "Right now", "અત્યારે")}</dt><dd>{data.in_window_now ? L(lang, "Inside reminder hours", "રિમાઇન્ડર સમયમાં") : L(lang, "Outside reminder hours — timed reminders wait", "રિમાઇન્ડર સમય બહાર")}</dd></div>
          <div><dt>{L(lang, "Sent today", "આજે મોકલ્યા")}</dt><dd>{data.sent_today}</dd></div>
          <div><dt>{L(lang, "Being retried", "ફરી પ્રયાસમાં")}</dt><dd>{data.failed_count}{data.gave_up_count ? ` · ${L(lang, `${data.gave_up_count} gave up (7 days)`, `${data.gave_up_count} નિષ્ફળ`)}` : ""}</dd></div>
          {last && <div style={{ gridColumn: "1 / -1" }}><dt>{L(lang, "Last check", "છેલ્લી તપાસ")}</dt><dd>
            {fmtTime(last.started_at)} · {L(lang, `${last.orders_checked} open orders checked, ${last.reminders_sent} sent, ${last.retries_sent} retried, ${last.push_retries} phone pushes retried`, `${last.orders_checked} ઓર્ડર તપાસ્યા, ${last.reminders_sent} મોકલ્યા`)}
            {last.errors ? ` · ${L(lang, "errors", "ભૂલો")}: ${last.errors} (${last.last_error})` : ""}</dd></div>}
        </dl>
        {canEdit && (
          <button className="btn btn-outline" style={{ width: "auto", marginTop: 10 }} disabled={busy}
            onClick={() => act(runRemindersNow, (r) => L(lang, `Checked ${r?.orders_checked ?? 0} open orders; ${r?.reminders_sent ?? 0} reminders sent.`, `${r?.orders_checked ?? 0} ઓર્ડર તપાસ્યા; ${r?.reminders_sent ?? 0} રિમાઇન્ડર મોકલ્યા.`))}>
            {L(lang, "Check now", "હમણાં તપાસો")}
          </button>
        )}
      </div>

      <div className="card">
        <h2>{L(lang, "When reminders go out", "રિમાઇન્ડર ક્યારે જાય")}</h2>
        <p className="sub">{L(lang,
          "New orders and acceptances are announced immediately. Timed reminders (2 h, 24 h, daily, due-date and overdue) go out only on working days, inside these hours, and not on holidays — otherwise they wait for the next working time.",
          "નવા ઓર્ડર તરત જણાવાય છે. સમયસર રિમાઇન્ડર ફક્ત કામના દિવસે, આ સમયમાં, રજા સિવાય જાય છે.")}</p>
        <fieldset disabled={!canEdit || busy} style={{ border: 0, padding: 0, margin: 0 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 600 }}>
            <input type="checkbox" checked={!!form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} style={{ width: "auto", margin: 0 }} />
            {L(lang, "Timed reminders on", "સમયસર રિમાઇન્ડર ચાલુ")}
          </label>
          <div className="field" style={{ marginTop: 10 }}>
            <label>{L(lang, "Working days", "કામના દિવસો")}</label>
            <div className="day-picks">
              {DAYS.map(([d, en, gu]) => (
                <label key={d}><input type="checkbox" checked={form.working_days.includes(d)} onChange={() => toggleDay(d)} />{L(lang, en, gu)}</label>
              ))}
            </div>
          </div>
          <div className="form-grid">
            <div className="field"><label>{L(lang, "From", "થી")}</label><input type="time" value={form.window_start} onChange={(e) => setForm((f) => ({ ...f, window_start: e.target.value }))} /></div>
            <div className="field"><label>{L(lang, "To", "સુધી")}</label><input type="time" value={form.window_end} onChange={(e) => setForm((f) => ({ ...f, window_end: e.target.value }))} /></div>
          </div>
          {canEdit && <button className="btn btn-primary" style={{ width: "auto" }} onClick={() => act(() => setReminderSettings(form), L(lang, "Saved.", "સાચવ્યું."))}>{L(lang, "Save", "સાચવો")}</button>}
        </fieldset>
        {!canEdit && <div className="sub">{L(lang, "Only the Procurement Head or Management can change these.", "ફક્ત ખરીદી વડા અથવા મેનેજમેન્ટ બદલી શકે.")}</div>}
      </div>

      <div className="card">
        <h2>{L(lang, "Company holidays", "કંપની રજાઓ")}</h2>
        {data.holidays.length === 0 && <div className="sub">{L(lang, "No upcoming holidays.", "કોઈ આગામી રજા નથી.")}</div>}
        <ul className="reminder-log">
          {data.holidays.map((h) => (
            <li key={h.date} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <span><strong>{fmtDate(h.date)}</strong> · {h.name}</span>
              {canEdit && <button type="button" className="btn btn-outline" style={{ width: "auto", margin: 0 }} disabled={busy} onClick={() => act(() => setHoliday(h.date, null, true), L(lang, "Removed.", "દૂર કર્યું."))}>{L(lang, "Remove", "દૂર કરો")}</button>}
            </li>
          ))}
        </ul>
        {canEdit && (
          <div className="form-grid" style={{ marginTop: 10 }}>
            <div className="field"><label>{L(lang, "Date", "તારીખ")}</label><input type="date" min={todayIST()} value={holiday.date} onChange={(e) => setHolidayForm((h) => ({ ...h, date: e.target.value }))} /></div>
            <div className="field"><label>{L(lang, "Holiday", "રજા")}</label><input value={holiday.name} onChange={(e) => setHolidayForm((h) => ({ ...h, name: e.target.value }))} placeholder={L(lang, "e.g. Diwali", "દા.ત. દિવાળી")} /></div>
            <div className="field full"><button className="btn btn-outline" style={{ width: "auto" }} disabled={busy || !holiday.date || !holiday.name.trim()}
              onClick={() => act(() => setHoliday(holiday.date, holiday.name), L(lang, "Holiday added.", "રજા ઉમેરી.")).then(() => setHolidayForm({ date: "", name: "" }))}>{L(lang, "Add holiday", "રજા ઉમેરો")}</button></div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>{L(lang, "Recent reminders", "તાજેતરના રિમાઇન્ડર")}</h2>
        {recent.length === 0 && <div className="sub">{L(lang, "None yet.", "હજુ નથી.")}</div>}
        <ul className="reminder-log">
          {recent.map((x) => (
            <li key={x.id}>
              <Link to={`/purchase-requests/${x.purchase_request_id}`} style={{ color: "inherit" }}>{x.message_en}</Link>
              <div className="meta">{fmtTime(x.sent_at || x.created_at)} · {x.status === "SENT" ? (x.read_at ? L(lang, "read", "વાંચ્યું") : L(lang, "delivered", "પહોંચ્યું")) : x.status.toLowerCase()}
                {x.push_status === "failed" ? ` · ${L(lang, "phone push failed", "ફોન પુશ નિષ્ફળ")}` : ""}{x.last_error ? ` · ${x.last_error}` : ""}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
