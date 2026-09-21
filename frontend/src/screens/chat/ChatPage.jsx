import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import ChatConversation from "./ChatConversation.jsx";
import {
  TYPE_LABEL, UUID_RE, listConversations, managementDirectory, managementOpen, openProjectChat, resolveLegacyLink, searchMessages, searchProjects, searchUsers, startDirect,
  subscribeConversationList,
} from "../../lib/chatApi";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { useForegroundRefresh } from "../../lib/useForegroundRefresh";

const FILTERS = [
  ["all", "All", null], ["unread", "Unread", null], ["direct", "Direct", ["direct"]], ["department", "Department", ["department"]],
  ["team", "Team", ["team"]], ["task", "Tasks", ["task"]], ["project", "Projects", ["project"]], ["job_card", "Job Cards", ["job_card"]], ["bridge", "Bridge", ["bridge"]],
  ["management", "Management", ["management"]],
];

function timeLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso); const now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const bySortKey = (a, b) => (b.sort_at || "").localeCompare(a.sort_at || "");
function upsertRow(list, row) {
  const i = list.findIndex((x) => x.id === row.id);
  const next = i === -1 ? [...list, row] : list.map((x) => (x.id === row.id ? row : x));
  return next.sort(bySortKey);
}

// Internal Chat. Desktop: list + conversation side by side. Phone: full-screen list, then full-screen conversation.
//
// Data flow (each step is its own effect with PRIMITIVE dependencies):
//   1. signed-in user id  -> load the conversation list ONCE
//   2. signed-in user id  -> ONE list subscription (per-conversation events -> fetch just that row)
//   3. ?c=<id>            -> which conversation is open (the URL is only ever READ here; nothing writes it back)
//   The open conversation owns its own messages, subscription and mark-read (see ChatConversation).
export default function ChatPage({ profile }) {
  const me = profile.id;
  const [params, setParams] = useSearchParams();
  const rawC = params.get("c");
  const selected = rawC && UUID_RE.test(rawC) ? rawC : null;
  const rawT = params.get("task");
  const taskParam = rawT && UUID_RE.test(rawT) ? rawT : null;   // the task the project chat is currently "about"
  const rawP = params.get("project");
  const rawM = params.get("m");
  const highlightId = rawM && UUID_RE.test(rawM) ? rawM : null;
  // An OLD Reply link (notification / bookmark): ?legacy_message=<old reply id>&legacy_task=<task id> (or legacy_project / legacy_job)
  const legacyMessage = params.get("legacy_message");
  const legacyTask = params.get("legacy_task");
  const legacyProject = params.get("legacy_project");
  const legacyJob = params.get("legacy_job");
  const [legacyError, setLegacyError] = useState(null);

  const [items, setItems] = useState([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");
  const [showNew, setShowNew] = useState(false);
  const [showOversight, setShowOversight] = useState(false);
  const [q, setQ] = useState("");
  const dq = useDebouncedValue(q, 300);
  const [hits, setHits] = useState([]);
  const isMgmt = !!(profile.isManagement || profile.isSuperAdmin);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // A malformed ?c= is normalised away ONCE (replace, so no history entry); a well-formed one is never rewritten.
  useEffect(() => {
    if (rawC && !selected) setParams({}, { replace: true });
  }, [rawC, selected, setParams]);

  useEffect(() => {
    const kind = legacyMessage ? "task_message" : legacyTask ? "task" : legacyProject ? "project" : legacyJob ? "job_card" : null;
    const id = legacyMessage || legacyTask || legacyProject || legacyJob;
    if (!kind) return undefined;
    if (!UUID_RE.test(id)) { setLegacyError("This link is not valid any more."); setParams({}, { replace: true }); return undefined; }
    let alive = true;
    setLegacyError(null);
    resolveLegacyLink(kind, id, legacyMessage && legacyTask && UUID_RE.test(legacyTask) ? legacyTask : null).then(({ data, error: err }) => {
      if (!alive) return;
      if (err || !data?.conversation_id) {
        setLegacyError(/access|not found|limited/i.test(err?.message || "")
          ? "That conversation is limited to the people working on it, and you do not have access."
          : "This old reply link could not be matched to a chat. The message history is kept safely — ask an administrator if it is missing.");
        setParams({}, { replace: true });
        return;
      }
      const next = { c: data.conversation_id };
      if (data.message_id) next.m = data.message_id;
      setParams(next, { replace: true });
    });
    return () => { alive = false; };
  }, [legacyMessage, legacyTask, legacyProject, legacyJob, setParams]);

  // /chat?project=<id>&task=<id>  ->  that project's canonical chat (created if missing; server checks access) with the task as context
  useEffect(() => {
    if (!rawP || selected) return undefined;
    if (!UUID_RE.test(rawP)) { setParams({}, { replace: true }); return undefined; }
    let alive = true;
    openProjectChat(rawP).then(({ data, error: err }) => {
      if (!alive) return;
      if (err || !data) { setLegacyError("Project chat is limited to the people working on this project."); setParams({}, { replace: true }); return; }
      setParams(taskParam ? { c: data, task: taskParam } : { c: data }, { replace: true });
    });
    return () => { alive = false; };
  }, [rawP, selected, taskParam, setParams]);

  // the open project chat asks to change / clear its task context; an archived old task conversation redirects to its project chat
  const onTaskChange = useCallback((id) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (id) next.set("task", id); else next.delete("task");
    next.delete("m");
    return next;
  }, { replace: true }), [setParams]);
  const onRedirect = useCallback((dest, task) => setParams(task ? { c: dest, task } : { c: dest }, { replace: true }), [setParams]);

  // ---- list data ----
  const listToken = useRef(0);
  const loadAll = useCallback(async () => {
    const token = ++listToken.current;
    const { data, error: err } = await listConversations();
    if (token !== listToken.current) return; // a newer request superseded this one
    if (err) { console.error("[Chat] list failed", err); setError("Could not load your conversations."); }
    else { setError(null); setItems(data || []); }
    setInitialLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [me, loadAll]);
  useForegroundRefresh(loadAll);

  // one Realtime event about one conversation -> one small request for that row (coalesced)
  const pending = useRef(new Set());
  const flushTimer = useRef(null);
  const flush = useCallback(async () => {
    const ids = [...pending.current];
    pending.current.clear();
    if (ids.length > 4) { loadAll(); return; }
    await Promise.all(ids.map(async (id) => {
      const { data, error: err } = await listConversations(null, false, id);
      if (err) return;
      setItems((cur) => {
        const row = data?.[0];
        if (!row) return cur.some((x) => x.id === id) ? cur.filter((x) => x.id !== id) : cur;
        // the conversation the user is looking at is being marked read; do not flash it as unread
        const shown = row.id === selectedRef.current && !document.hidden ? { ...row, unread: 0 } : row;
        return upsertRow(cur, shown);
      });
    }));
  }, [loadAll]);
  const refreshRow = useCallback((id) => {
    pending.current.add(id);
    window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(flush, 250);
  }, [flush]);
  const removeRow = useCallback((id) => {
    pending.current.delete(id);
    setItems((cur) => (cur.some((x) => x.id === id) ? cur.filter((x) => x.id !== id) : cur));
  }, []);

  useEffect(() => {
    const unsub = subscribeConversationList(me, `chat-list-${me}`, { onRow: refreshRow, onRemove: removeRow });
    return () => { window.clearTimeout(flushTimer.current); unsub(); };
  }, [me, refreshRow, removeRow]);

  // the open conversation reports "I marked it read" -> zero its badge locally (no refetch)
  const onRead = useCallback((id) => {
    setItems((cur) => (cur.some((x) => x.id === id && x.unread > 0) ? cur.map((x) => (x.id === id ? { ...x, unread: 0 } : x)) : cur));
  }, []);

  // ---- message search (only when the user types) ----
  useEffect(() => {
    if (dq.trim().length < 2) { setHits([]); return undefined; }
    let active = true;
    searchMessages(dq.trim()).then(({ data }) => { if (active) setHits(data || []); });
    return () => { active = false; };
  }, [dq]);

  // ---- selection: user clicks write the URL; nothing else does ----
  const open = useCallback((id) => { if (id !== selectedRef.current) setParams({ c: id }); }, [setParams]);
  const back = useCallback(() => setParams({}, { replace: true }), [setParams]);

  const projectQ = filter === "project" ? q.trim().toLowerCase() : "";
  const present = useMemo(() => new Set(items.map((i) => i.type)), [items]);
  const visible = useMemo(() => {
    const def = FILTERS.find((f) => f[0] === filter);
    return items.filter((i) => (filter === "unread" ? i.unread > 0 : !def?.[2] || def[2].includes(i.type)));
  }, [items, filter]);
  const shown = useMemo(() => {
    if (!projectQ) return visible;
    return visible.filter((c) => [c.title, c.project_code, c.client, c.site].filter(Boolean).some((v) => v.toLowerCase().includes(projectQ)));
  }, [visible, projectQ]);
  const chips = FILTERS.filter(([k, , types]) => k === "all" || k === "unread" || k === "direct" || k === "project" || types?.some((t) => present.has(t)));
  const unreadAll = items.reduce((n, i) => n + (i.muted ? 0 : i.unread), 0);

  return (
    <div className={`chat-shell${selected ? " has-conv" : ""}`}>
      <aside className="chat-list-pane" aria-label="Conversations">
        <div className="chat-list-head">
          <h1>Chat {unreadAll > 0 && <span className="fx-tag gold">{unreadAll}</span>}</h1>
          <div className="chat-list-actions">
            {isMgmt && <button type="button" className="fx-icon-btn" onClick={() => setShowOversight(true)} aria-label="Management oversight" title="Management oversight">🛡</button>}
            <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>+ New chat</button>
          </div>
        </div>
        <input type="search" className="chat-search-all" placeholder={filter === "project" ? "Search projects by code, name, client or site…" : "Search messages…"} value={q} onChange={(e) => setQ(e.target.value)} aria-label={filter === "project" ? "Search projects" : "Search all your messages"} />
        {legacyError && <div className="msg info" role="alert">{legacyError} <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={() => setLegacyError(null)}>OK</button></div>}
        {filter === "project" && <ProjectFinder q={q} onOpened={(id) => { refreshRow(id); open(id); }} />}
        {filter !== "project" && hits.length > 0 && (
          <div className="chat-hits">
            {hits.map((h) => <button key={h.id} type="button" className="chat-hit" onClick={() => { setQ(""); setParams(h.task_id ? { c: h.conversation_id, task: h.task_id, m: h.id } : { c: h.conversation_id, m: h.id }); }}><b>{h.conversation_title}</b><span className="sub">{h.task_number ? `${h.task_number} · ` : ""}{h.sender} · {new Date(h.created_at).toLocaleDateString()}</span><div>{h.body}</div></button>)}
          </div>
        )}
        <div className="fx-tabs chat-filters mobile-tab-list" role="tablist" aria-label="Filter conversations">
          {chips.map(([k, lbl]) => <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? "active" : ""} onClick={() => setFilter(k)}>{lbl}</button>)}
        </div>
        {error && <div className="msg error">{error} <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={loadAll}>Retry</button></div>}
        {initialLoading && <div className="msg info">Loading…</div>}
        {!initialLoading && !error && shown.length === 0 && filter !== "project" && (
          <div className="chat-empty">{filter === "unread" ? "Nothing unread." : items.length === 0 ? "No conversations yet. Start one with “New chat”, or open Chat from a task or Job Card." : "No conversations in this view."}</div>
        )}
        <ul className="chat-list">
          {shown.map((c) => (
            <li key={c.id}>
              <button type="button" className={`chat-row${c.id === selected ? " active" : ""}${c.unread > 0 ? " unread" : ""}`} onClick={() => open(c.id)}>
                <span className="chat-row-top">
                  <b className="ttl">{c.title}</b>
                  <span className="sub when">{timeLabel(c.last_message_at)}</span>
                </span>
                <span className="chat-row-mid">
                  <span className="fx-tag">{TYPE_LABEL[c.type] || c.type}</span>
                  {c.type === "project" ? <span className="sub">{[c.site, c.stage].filter(Boolean).join(" · ")}</span> : c.department && c.type !== "direct" && <span className="sub">{c.department}</span>}
                  {c.muted && <span aria-label="Muted" title="Muted">🔕</span>}
                  {!c.is_active && <span className="fx-tag">Archived</span>}
                </span>
                <span className="chat-row-bot">
                  <span className="prev">{c.last_message_preview ? `${c.last_task_number ? `${c.last_task_number} · ` : ""}${c.last_sender ? `${c.last_sender}: ` : ""}${c.last_message_preview}` : <i className="sub">No messages yet</i>}</span>
                  {c.unread > 0 && <span className="chat-badge" aria-label={`${c.unread} unread`}>{c.unread > 99 ? "99+" : c.unread}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="chat-conv-pane" aria-label="Conversation">
        {selected ? (
          <ChatConversation key={selected} conversationId={selected} me={me} onBack={back} onRead={onRead} highlightId={highlightId} taskId={taskParam} onTaskChange={onTaskChange} onRedirect={onRedirect} />
        ) : (
          <div className="chat-placeholder">
            <div style={{ fontSize: 40 }} aria-hidden="true">💬</div>
            <b>Select a conversation</b>
            <div className="sub">Work chats may be visible to authorized Management. Messages are not end-to-end encrypted.</div>
          </div>
        )}
      </section>

      {showNew && <NewChat onClose={() => setShowNew(false)} onStarted={(id) => { setShowNew(false); refreshRow(id); open(id); }} />}
      {showOversight && <Oversight onClose={() => setShowOversight(false)} onOpened={(id) => { setShowOversight(false); refreshRow(id); open(id); }} />}
    </div>
  );
}

// Projects the caller may open (the server decides; a project they cannot open is never returned). Members open their existing chat;
// authorized leadership can start one from here. Shown under the Projects tab, searchable by code / project / client / site.
function ProjectFinder({ q, onOpened }) {
  const dq = useDebouncedValue(q, 300);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let active = true;
    searchProjects(dq.trim()).then(({ data, error: e }) => { if (!active) return; if (e) setErr("Could not search projects."); else { setErr(null); setRows(data || []); } });
    return () => { active = false; };
  }, [dq]);
  const others = (rows || []).filter((r) => !r.is_member);
  if (err) return <div className="msg error" role="alert">{err}</div>;
  if (!others.length) return null;
  async function pick(r) {
    setBusy(r.project_id); setErr(null);
    const { data, error: e } = await openProjectChat(r.project_id);
    setBusy(null);
    if (e || !data) { setErr("You cannot open this project chat."); return; }
    onOpened(data);
  }
  return (
    <div className="chat-hits" aria-label="Other projects you can open">
      <div className="sub" style={{ padding: "4px 8px" }}>Other projects you can open</div>
      {others.map((r) => (
        <button key={r.project_id} type="button" className="chat-hit" disabled={busy === r.project_id} onClick={() => pick(r)}>
          <b>{r.project_code} — {r.client}</b><span className="sub">{[r.site, r.stage].filter(Boolean).join(" · ")}</span>
        </button>
      ))}
    </div>
  );
}

// Eligible people only: the server returns the list; nobody outside the caller's relationships is ever sent to the browser.
function NewChat({ onClose, onStarted }) {
  const [q, setQ] = useState("");
  const dq = useDebouncedValue(q, 250);
  const [people, setPeople] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    searchUsers(dq.trim()).then(({ data, error: err }) => { if (!active) return; setLoading(false); if (err) setError("Could not load people."); else { setError(null); setPeople(data || []); } });
    return () => { active = false; };
  }, [dq]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  async function pick(id) {
    setBusy(id); setError(null);
    const { data, error: err } = await startDirect(id);
    setBusy(null);
    if (err || !data) { setError("You cannot start a chat with this person."); return; }
    onStarted(data);
  }
  return (
    <div className="chat-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="chat-modal" role="dialog" aria-modal="true" aria-label="New chat">
        <div className="chat-modal-head"><b>New chat</b><button type="button" className="chat-x" onClick={onClose} aria-label="Close">×</button></div>
        <input type="search" autoFocus placeholder="Search people you can message…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
        <div className="sub" style={{ margin: "6px 0" }}>Only colleagues you work with (your team, supervisor, head, task and Job Card partners, Management) appear here.</div>
        {error && <div className="msg error" role="alert">{error}</div>}
        {loading && <div className="msg info">Loading…</div>}
        {!loading && people.length === 0 && <div className="chat-empty">{q.trim() ? "No matching people you can message." : "No one is available to message yet."}</div>}
        <ul className="chat-people">
          {people.map((p) => (
            <li key={p.id}><button type="button" disabled={busy === p.id} onClick={() => pick(p.id)}>
              <b>{p.full_name}</b> <span className="sub">{p.employee_code}</span>
              <span className="sub">{[p.role_label, p.department_name].filter(Boolean).join(" · ")} · {p.relation}</span>
            </button></li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// Management oversight: conversation NAMES only. Opening one needs a reason, is logged, and posts a visible "Management joined" notice.
function Oversight({ onClose, onOpened }) {
  const [q, setQ] = useState("");
  const dq = useDebouncedValue(q, 300);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [target, setTarget] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    managementDirectory(dq.trim()).then(({ data, error: err }) => { if (!active) return; if (err) setError("Could not load conversations."); else setRows(data || []); });
    return () => { active = false; };
  }, [dq]);
  async function enter() {
    if (reason.trim().length < 5) return setError("Please give a reason (at least 5 characters).");
    setBusy(true);
    const { data, error: err } = await managementOpen(target.id, reason.trim());
    setBusy(false);
    if (err) return setError(err.message || "Could not open.");
    onOpened(data);
  }
  return (
    <div className="chat-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="chat-modal" role="dialog" aria-modal="true" aria-label="Management oversight">
        <div className="chat-modal-head"><b>Management oversight</b><button type="button" className="chat-x" onClick={onClose} aria-label="Close">×</button></div>
        <div className="sub">Opening a conversation is recorded and other members see “Management joined this conversation for oversight”.</div>
        {!target ? (
          <>
            <input type="search" placeholder="Search conversations…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" />
            {error && <div className="msg error" role="alert">{error}</div>}
            <ul className="chat-people">
              {rows.map((r) => (
                <li key={r.id}><button type="button" onClick={() => { setError(null); if (r.is_member) onOpened(r.id); else setTarget(r); }}>
                  <b>{r.title}</b> <span className="fx-tag">{TYPE_LABEL[r.type] || r.type}</span>
                  <span className="sub">{r.department || "—"} · {r.participants} members{r.is_member ? " · you are a member" : ""}</span>
                </button></li>
              ))}
            </ul>
          </>
        ) : (
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            <b>{target.title}</b>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for opening this conversation (required)" maxLength={300} aria-label="Reason" />
            {error && <div className="msg error" role="alert">{error}</div>}
            <div className="btn-row"><button type="button" className="btn btn-primary" disabled={busy} onClick={enter}>Open &amp; join</button><button type="button" className="btn btn-outline" onClick={() => { setTarget(null); setReason(""); }}>Back</button></div>
          </div>
        )}
      </div>
    </div>
  );
}
