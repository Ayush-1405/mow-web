import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import FactoryHeader from "./FactoryHeader.jsx";
import FactoryTaskForm from "./FactoryTaskForm.jsx";
import ChatButton from "../../components/ChatButton.jsx";
import {
  getMyActions, listFactoryTasks, listJobCards, listFactoryStaff, subscribeFactoryTasks, listFactoryLocations,
  taskAccept, taskStart, taskReject, taskBlock, taskUnblock, taskReady, taskApprove, reassignFactoryTask, cancelFactoryTask,
} from "../../lib/factoryApi";
import { supabase } from "../../lib/supabase";
import { useForegroundRefresh } from "../../lib/useForegroundRefresh";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { friendlyRpcError, fmtDate, STATUS, ACTION_LABEL } from "./factoryConstants";
import { TASK_STATUS, TASK_NEEDS_ACCEPT, PRIORITY_LABEL } from "./factoryTaskStatus";

const SECTION_ORDER = [
  ["action", "Needs My Action"], ["today", "Due Today"], ["overdue", "Overdue"],
  ["progress", "In Progress"], ["waiting", "Waiting / Blocked"], ["done_today", "Completed Today"], ["later", "Upcoming"],
];

function istToday() {
  return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
}
function istDateOf(iso) {
  return iso ? new Date(new Date(iso).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10) : null;
}

// Every task lands in exactly ONE section (highest priority first) so nothing shows twice.
function classify(t, leader, today) {
  const s = t.status;
  const mineToAccept = t.is_mine && TASK_NEEDS_ACCEPT.has(s) && t.my_acceptance !== "ACCEPTED";
  const toReview = s === "COMPLETED" && t.i_verify;
  const returnedForLeader = s === "RETURNED" && leader;
  const blockedForMe = s === "ON_HOLD" && (t.i_verify || leader) && !t.is_mine;
  if (mineToAccept || toReview || returnedForLeader || blockedForMe) return "action";
  if (["COMPLETED", "VERIFIED", "CLOSED"].includes(s)) return istDateOf(t.completed_at) === today ? "done_today" : "later";
  if (t.is_overdue) return "overdue";
  if (t.due_date === today) return "today";
  if (s === "ON_HOLD") return "waiting";
  if (["IN_PROGRESS", "ACCEPTED", "PARTIALLY_ACCEPTED", "PARTIALLY_COMPLETED"].includes(s)) return "progress";
  return "later";
}

export default function FactoryTasks({ lang, profile, lookups }) {
  const navigate = useNavigate();
  const role = profile.roleCode;
  const headLike = !!(profile.permissions.hasGlobalOversight || profile.permissions.isDepartmentHead);
  const leader = headLike || role === "supervisor";
  const tabs = useMemo(() => {
    const all = [["my", "My Tasks"], ["team", "Team Tasks"], ["unassigned", "Unassigned"], ["jobcard", "Job Card Tasks"], ["standalone", "Standalone"], ["blocked", "Blocked"], ["completed", "Completed"]];
    return leader ? all : all.filter(([k]) => k === "my" || k === "completed");
  }, [leader]);

  const [tab, setTab] = useState("my");
  const [search, setSearch] = useState("");
  const dsearch = useDebouncedValue(search, 250);
  const [rows, setRows] = useState([]);
  const [cards, setCards] = useState([]);
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [note, setNote] = useState(null);
  const [locations, setLocations] = useState([]);
  const [location, setLocation] = useState(null);
  const [staff, setStaff] = useState([]);
  const loadedOnce = useRef(false);
  const factoryDept = lookups.departments.find((d) => d.code === "FACTORY");

  const load = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    if (tab === "unassigned") {
      const [a, b] = await Promise.all([listJobCards({ tab: "accepted", search: dsearch, from: 0, to: 49 }), listJobCards({ tab: "verify", search: dsearch, from: 0, to: 49 })]);
      const n = await listJobCards({ tab: "new", search: dsearch, from: 0, to: 49 });
      const err = a.error || b.error || n.error;
      if (err) setError("Could not load Job Cards. Please try again."); else { setError(null); setCards([...(n.data || []), ...(b.data || []), ...(a.data || [])]); }
    } else {
      const { data, error: err } = await listFactoryTasks({ tab, search: dsearch });
      if (err) { console.error("[FactoryTasks] load failed", err); setError("Could not load tasks. Please try again."); } else { setError(null); setRows(data); }
    }
    if (leader && tab === "my") {
      // Job Card actions for leadership (verify / assign / confirm completion / blocked) -- derived, never duplicated.
      const q = await getMyActions();
      setQueue(q.error ? [] : (q.data || []).filter((a) => ["verify", "confirm_drawing", "assign", "confirm_completion", "resolve_blocker"].includes(a.action_code)));
    }
    loadedOnce.current = true;
    setLoading(false);
  }, [tab, dsearch, leader]);

  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => { loadedOnce.current = false; load(); }, [load]);
  useEffect(() => subscribeFactoryTasks("fx-tasks-page", () => loadRef.current()), []);
  useForegroundRefresh(useCallback(() => loadRef.current(), []));
  useEffect(() => { listFactoryLocations().then(({ data }) => setLocations(data || [])); }, []);
  useEffect(() => { if (leader && factoryDept) listFactoryStaff(factoryDept.id).then(({ data }) => setStaff(data)); }, [leader, factoryDept]);

  const today = istToday();
  const grouped = useMemo(() => {
    const g = Object.fromEntries(SECTION_ORDER.map(([k]) => [k, []]));
    rows.forEach((t) => g[classify(t, leader, today)].push(t));
    return g;
  }, [rows, leader, today]);
  const sectioned = tab !== "completed" && tab !== "blocked";

  function done(msg) { setNote(msg ? { type: "success", text: msg } : null); loadRef.current(); }

  return (
    <div className="fx-page">
      <FactoryHeader lang={lang} profile={profile} title="Factory Tasks" onRefresh={load} refreshing={loading} locations={locations} location={location} onLocation={setLocation} />

      <div className="fx-tabs" role="tablist" aria-label="Factory task views">
        {tabs.map(([k, lbl]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => { setTab(k); setNote(null); }}>{lbl}</button>
        ))}
      </div>

      <div className="fx-toolbar">
        <input type="search" placeholder="Search task, job, customer or person…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search tasks" />
        {leader && <button type="button" className="btn btn-primary" onClick={() => setShowForm((v) => !v)} aria-expanded={showForm}>{showForm ? "Close" : "+ New task"}</button>}
      </div>

      {showForm && (
        <div className="fx-section">
          <h2>New Factory task</h2>
          <FactoryTaskForm lang={lang} lookups={lookups} onCancel={() => setShowForm(false)}
            onCreated={(r) => { setShowForm(false); done(`Task ${r.task_number} created${r.voiceAttached ? " with its voice instruction" : ""}${r.attachmentsFailed ? ` (${r.attachmentsFailed} attachment(s) could not be uploaded — open the task to retry)` : ""}.`); }} />
        </div>
      )}

      {note && <div className={`msg ${note.type}`} role="status">{note.text}</div>}
      {error && <div className="msg error" role="alert">{error} <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={load}>Retry</button></div>}
      {loading && rows.length === 0 && cards.length === 0 && <div className="msg info">Loading…</div>}

      {tab === "unassigned" ? (
        <div className="fx-list">
          {!loading && cards.length === 0 && <div className="msg info">No Job Cards are waiting for verification or assignment.</div>}
          {cards.map((c) => (
            <Link key={c.id} to={`/factory-job/${c.id}`} className="fx-row">
              <div className="fx-row-top"><b>{c.job_order_number}</b><span className="fx-tag gold">{STATUS[c.factory_status]?.en || c.factory_status}</span></div>
              <div className="sub">{[c.customer_name, c.product_item, c.source_department_name].filter(Boolean).join(" · ")}</div>
              <div className="sub">Required {fmtDate(c.required_date)} · {c.priority}</div>
            </Link>
          ))}
        </div>
      ) : sectioned ? (
        <>
          {leader && tab === "my" && queue.length > 0 && (
            <section aria-label="Job Cards needing action">
              <h2 className="fx-sec-title">Needs My Action — Job Cards <span className="c">({queue.length})</span></h2>
              <div className="fx-list">
                {queue.map((a) => (
                  <Link key={`${a.job_id}-${a.action_code}`} to={`/factory-job/${a.job_id}`} className={`fx-row${a.is_overdue ? " late" : ""}`}>
                    <div className="fx-row-top"><b>{ACTION_LABEL[a.action_code]?.en || a.action_code}</b><span className="fx-tag gold">{a.job_order_number}</span></div>
                    <div className="sub">{a.title || ""}{a.source_department_name ? ` · from ${a.source_department_name}` : ""} · {a.required_date ? `Required ${fmtDate(a.required_date)}` : "No date"}</div>
                  </Link>
                ))}
              </div>
            </section>
          )}
          {!loading && !error && rows.length === 0 && <div className="msg info">{tab === "my" ? "No tasks assigned to you right now." : "No tasks here."}</div>}
          {SECTION_ORDER.map(([k, title]) => grouped[k].length > 0 && (
            <section key={k} aria-label={title}>
              <h2 className="fx-sec-title">{title} <span className="c">({grouped[k].length})</span></h2>
              <div className="fx-list">
                {grouped[k].map((t) => <TaskCard key={t.id} t={t} leader={leader} headLike={headLike} staff={staff} navigate={navigate} onDone={done} onError={(m) => setNote({ type: "error", text: m })} />)}
              </div>
            </section>
          ))}
        </>
      ) : (
        <div className="fx-list">
          {!loading && !error && rows.length === 0 && <div className="msg info">No tasks here.</div>}
          {rows.map((t) => <TaskCard key={t.id} t={t} leader={leader} headLike={headLike} staff={staff} navigate={navigate} onDone={done} onError={(m) => setNote({ type: "error", text: m })} />)}
        </div>
      )}
    </div>
  );
}

function TaskCard({ t, leader, headLike, staff, navigate, onDone, onError }) {
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(null); // { kind, label }
  const [reason, setReason] = useState("");
  const [primary, setPrimary] = useState(t.primary_id || "");
  const [second, setSecond] = useState(t.second_id || "");
  const st = TASK_STATUS[t.status] || { en: t.status, badge: "ASSIGNED" };
  const mineAccept = t.is_mine && TASK_NEEDS_ACCEPT.has(t.status) && t.my_acceptance !== "ACCEPTED";
  // The server only lets the verifier, the creator, a Dept Head or Management approve / send back.
  const canReview = t.status === "COMPLETED" && (t.i_verify || headLike);

  async function run(fn, okMsg) {
    if (busy) return;
    setBusy(true);
    const { error } = await fn();
    setBusy(false);
    if (error) {
      console.error("[FactoryTasks] action failed", error);
      onError(friendlyRpcError(error, "That did not work. Please try again."));
      return;
    }
    setAsk(null); setReason("");
    onDone(okMsg);
  }

  function submitAsk() {
    const r = reason.trim();
    if (ask.kind !== "reassign" && !r) return onError("Please give a reason.");
    if (ask.kind === "reject") return run(() => taskReject(t.id, r), "Task rejected — your supervisor has been told.");
    if (ask.kind === "block") return run(() => taskBlock(t.id, r), "Marked as blocked.");
    if (ask.kind === "back") return run(() => supabase.rpc("staff_reopen_task", { p_task_id: t.id, p_reason: r }), "Sent back for correction.");
    if (ask.kind === "cancel") return run(() => cancelFactoryTask(t.id, r), "Task cancelled (history kept).");
    if (ask.kind === "reassign") {
      if (!primary) return onError("Choose the primary assignee.");
      return run(() => reassignFactoryTask(t.id, primary, second || null, r || "Reassigned"), "Assignment updated.");
    }
    return undefined;
  }

  const open = () => navigate(`/?focus=${t.id}`);

  return (
    <article className={`fx-task${t.is_overdue ? " late" : ""}${t.status === "ON_HOLD" ? " blocked" : ""}`}>
      <button type="button" className="fx-task-main" onClick={open} aria-label={`Open task ${t.task_number}: ${t.title}`}>
        <div className="fx-row-top">
          <b>{t.title}</b>
          <span className={`badge ${st.badge}`}>{st.en}</span>
        </div>
        <div className="sub">
          {t.task_number}
          {t.job_order_number ? ` · Job ${t.job_order_number}` : " · Standalone"}
          {t.item_name ? ` · ${t.item_name}` : ""}{t.stage ? ` · ${t.stage}` : ""}
        </div>
        <div className="sub">
          {t.primary_name || "—"}{t.second_name ? ` + ${t.second_name}` : ""}{t.verifier_name ? ` · Supervisor ${t.verifier_name}` : ""}
        </div>
        <div className="fx-meta">
          <span className={`fx-tag${t.priority === "URGENT" ? " bad" : t.priority === "HIGH" ? " gold" : ""}`}>{PRIORITY_LABEL[t.priority] || t.priority}</span>
          <span className={`fx-tag${t.is_overdue ? " bad" : ""}`}>Due {fmtDate(t.due_date)}</span>
          {t.total_quantity != null && <span className="fx-tag">{t.completed_quantity ?? 0} / {t.total_quantity} done</span>}
          <span className="fx-tag">Updated {fmtDate(t.updated_at)}</span>
        </div>
        {t.blocker && <div className="fx-blocker">⚠ Blocked: {t.blocker}</div>}
        {t.return_reason && <div className="fx-blocker">↩ {t.return_reason}</div>}
      </button>

      {t.job_card_id && <Link className="fx-tag gold" to={`/factory-job/${t.job_card_id}`}>Open Job Card {t.job_order_number} →</Link>}

      <div className="fx-actions">
        <ChatButton taskId={t.id} wrapStyle={{ flex: "1 1 96px" }} />
        {mineAccept && <button type="button" className="btn btn-gold" disabled={busy} onClick={() => run(() => taskAccept(t.id), "Accepted.")}>Accept</button>}
        {mineAccept && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setAsk({ kind: "reject" })}>Reject</button>}
        {t.is_mine && ["ACCEPTED", "REOPENED"].includes(t.status) && <button type="button" className="btn btn-gold" disabled={busy} onClick={() => run(() => taskStart(t.id), "Started.")}>Start</button>}
        {t.is_mine && t.status === "IN_PROGRESS" && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setAsk({ kind: "block" })}>Blocked</button>}
        {t.is_mine && t.status === "IN_PROGRESS" && <button type="button" className="btn btn-gold" disabled={busy} onClick={() => run(() => taskReady(t.id), "Marked ready for review.")}>Ready</button>}
        {t.is_mine && t.status === "ON_HOLD" && <button type="button" className="btn btn-gold" disabled={busy} onClick={() => run(() => taskUnblock(t.id), "Resumed.")}>Resume</button>}
        {canReview && <button type="button" className="btn btn-gold" disabled={busy} onClick={() => run(() => taskApprove(t.id), "Approved.")}>Approve</button>}
        {canReview && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setAsk({ kind: "back" })}>Send back</button>}
        {leader && !["VERIFIED", "CLOSED"].includes(t.status) && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setAsk({ kind: "reassign" })}>Reassign</button>}
        {leader && !["VERIFIED", "CLOSED"].includes(t.status) && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setAsk({ kind: "cancel" })}>Cancel</button>}
      </div>

      {ask && (
        <div className="fx-ask">
          {ask.kind === "reassign" && (
            <div className="fx-two">
              <select value={primary} onChange={(e) => setPrimary(e.target.value)} aria-label="Primary assignee">
                <option value="">Primary…</option>
                {staff.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
              <select value={second} onChange={(e) => setSecond(e.target.value)} aria-label="Second assignee">
                <option value="">No second assignee</option>
                {staff.filter((u) => u.id !== primary).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </div>
          )}
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
            placeholder={ask.kind === "reassign" ? "Reason (optional)" : "Reason (required)"} aria-label="Reason" />
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={submitAsk}>Confirm</button>
            <button type="button" className="btn btn-outline" onClick={() => { setAsk(null); setReason(""); }}>Back</button>
          </div>
        </div>
      )}
    </article>
  );
}
