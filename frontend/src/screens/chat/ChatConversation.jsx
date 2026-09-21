import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  CHAT_ACCEPT, CHAT_EDIT_WINDOW_MIN, TYPE_LABEL, chatFileUrl, deleteMessage, editMessage, fetchMessage, fetchMessages, fetchMessagesAround, fetchReads, getDetails,
  linkMessageToTask, markRead, openProjectChat, projectJobs, projectTasks, searchMessages, sendMessage, setMuted, subscribeConversation, taskRefs, uploadChatFile,
} from "../../lib/chatApi";
import { matchesView } from "../../lib/chatFilters";
import { ProjectViewBar, TaskChip, TaskRefCard } from "./TaskContext.jsx";
import { useForegroundRefresh } from "../../lib/useForegroundRefresh";
import ChatButton from "../../components/ChatButton.jsx";

const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dayKey = (iso) => new Date(iso).toDateString();
const fmtDay = (iso) => {
  const d = new Date(iso); const t = new Date();
  if (d.toDateString() === t.toDateString()) return "Today";
  const y = new Date(t.getTime() - 86400e3);
  return d.toDateString() === y.toDateString() ? "Yesterday" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

// drafts survive switching conversations (per conversation, in memory only)
const draftStore = new Map();

// Insert-or-merge by id, keeping created_at order. A Realtime INSERT, the send response and a foreground refresh can all
// deliver the SAME message; merging by id is what keeps it on screen exactly once.
function upsertMessage(list, row) {
  const i = list.findIndex((m) => m.id === row.id);
  if (i !== -1) {
    const old = list[i];
    const merged = { ...old, ...row, attachments: row.attachments && row.attachments.length ? row.attachments : old.attachments };
    const next = list.slice(); next[i] = merged; return next;
  }
  const item = { ...row, attachments: row.attachments || [] };
  if (!list.length || item.created_at >= list[list.length - 1].created_at) return [...list, item];
  return [...list, item].sort((a, b) => a.created_at.localeCompare(b.created_at));
}
function attachTo(list, att) {
  const i = list.findIndex((m) => m.id === att.message_id);
  if (i === -1) return list;
  if (list[i].attachments.some((a) => a.id === att.id)) return list;
  const next = list.slice(); next[i] = { ...list[i], attachments: [...list[i].attachments, att] }; return next;
}

// Signed URLs are cached briefly (chatApi) and refreshed once if the browser reports the image failed.
function Attachment({ att }) {
  const isImg = att.mime_type.startsWith("image/") && !/heic|heif|dwg|dxf/.test(att.mime_type);
  const [url, setUrl] = useState(null);
  const retried = useRef(false);
  useEffect(() => {
    if (!isImg) return undefined;
    let active = true;
    chatFileUrl(att).then(({ url: u }) => { if (active) setUrl(u); });
    return () => { active = false; };
  }, [att, isImg]);
  async function download() {
    const { url: u } = await chatFileUrl(att);
    if (u) window.open(u, "_blank", "noopener,noreferrer");
  }
  if (isImg) {
    return url ? (
      <button type="button" className="chat-img" onClick={() => window.open(url, "_blank", "noopener,noreferrer")} aria-label={`Open image ${att.file_name}`}>
        <img src={url} alt={att.file_name} loading="lazy" onError={async () => { if (retried.current) return; retried.current = true; const { url: u } = await chatFileUrl(att, { fresh: true }); if (u) setUrl(u); }} />
      </button>
    ) : <div className="chat-file">Loading image…</div>;
  }
  return (
    <button type="button" className="chat-file" onClick={download}>
      <span aria-hidden="true">📄</span> <span className="nm">{att.file_name}</span> <span className="sub">{fmtSize(att.file_size)}</span>
    </button>
  );
}

// One message. Memoised: typing in the composer, or an unrelated message arriving, does not re-render the others.
const MessageRow = memo(function MessageRow({ m, mine, sender, quotedText, seen, canReply, canEdit, canDelete, isEditing, editText, onEditText, onReply, onStartEdit, onSaveEdit, onCancelEdit, onDelete, highlighted, projectActions, onCreateTask, onLinkTask, tInfo, onOpenTask, showRefs, hideTask }) {
  if (m.is_system) return <div className={`chat-system${highlighted ? " hl" : ""}`} data-mid={m.id}>{m.body}{showRefs && m.task_id && !hideTask && <> <TaskChip taskId={m.task_id} info={tInfo} onOpenTask={onOpenTask} /></>}</div>;
  const ctx = m.context || {};
  return (
    <div className={`chat-msg${mine ? " mine" : ""}${highlighted ? " hl" : ""}`} data-mid={m.id}>
      {!mine && sender && <div className="chat-sender"><b>{sender.name}</b> <span className="sub">{sender.role_label}{sender.department ? ` · ${sender.department}` : ""}</span></div>}
      {!mine && !sender && <div className="chat-sender"><b>Former member</b></div>}
      <div className="chat-bubble">
        {showRefs && ((m.task_id && !hideTask) || m.job_card_id || (m.daily_update_id && !ctx.badge)) && (
          <div className="chat-ctxrow">
            {m.task_id && !hideTask && <TaskChip taskId={m.task_id} info={tInfo} onOpenTask={onOpenTask} />}
            {m.job_card_id && <span className="fx-tag">🏭 Job Card</span>}
            {m.daily_update_id && !ctx.badge && <span className="fx-tag gold">Daily Site Update</span>}
          </div>
        )}
        {(ctx.badge || m.legacy_source_type) && (
          <div className="chat-ctxrow">
            {ctx.badge && <span className="fx-tag gold">{ctx.badge}</span>}
            {m.legacy_source_type && <span className="chat-imported" title="This message was moved into Chat from the old Reply section, with its original author and time.">Imported reply</span>}
          </div>
        )}
        {quotedText && <div className="chat-quote">{quotedText}</div>}
        {m.deleted_at ? <i className="sub">Message deleted</i> : isEditing ? (
          <div className="chat-edit">
            <textarea value={editText} onChange={(e) => onEditText(e.target.value)} maxLength={4000} aria-label="Edit message" />
            <div className="btn-row"><button type="button" className="btn btn-primary" onClick={onSaveEdit}>Save</button><button type="button" className="btn btn-outline" onClick={onCancelEdit}>Cancel</button></div>
          </div>
        ) : (
          <>
            {m.body && <div className="chat-body">{m.body}</div>}
            {m.attachments.map((a) => <Attachment key={a.id} att={a} />)}
          </>
        )}
        {ctx.linked_task_number && !m.task_id && <div className="chat-linked">🔗 Linked to task <b>{ctx.linked_task_number}</b></div>}
        <div className="chat-meta">{fmtTime(m.created_at)}{m.edited_at && !m.deleted_at ? " · edited" : ""}{mine && !m.deleted_at ? seen : ""}</div>
      </div>
      {!m.deleted_at && !isEditing && canReply && (
        <div className="chat-actions">
          <button type="button" onClick={() => onReply(m)} aria-label="Reply">↩ Reply</button>
          {canEdit && <button type="button" onClick={() => onStartEdit(m)} aria-label="Edit">✎ Edit</button>}
          {canDelete && <button type="button" onClick={() => onDelete(m)} aria-label="Delete">🗑 Delete</button>}
          {projectActions && m.body && !m.task_id && <button type="button" onClick={() => onLinkTask(m)} aria-label="Link to a task">🔗 Link task</button>}
          {projectActions && m.body && <button type="button" onClick={() => onCreateTask(m)} aria-label="Create a task from this message">➕ Task</button>}
        </div>
      )}
    </div>
  );
});

// The open conversation. `key={conversationId}` in the parent gives every conversation a clean instance; everything
// below depends on PRIMITIVES (conversation id, my id) only, so a parent re-render can never restart a load.
export default function ChatConversation({ conversationId, me, onBack, onRead, highlightId = null, taskId = null, onTaskChange, onRedirect }) {
  const navigate = useNavigate();
  const [details, setDetails] = useState(null);
  const [messages, setMessages] = useState([]);
  const [reads, setReads] = useState({});
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [retryKey, setRetryKey] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState(null);
  const [pending, setPending] = useState([]);
  const [mentions, setMentions] = useState([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editText, setEditText] = useState("");
  const [showInfo, setShowInfo] = useState(false);
  const [showMention, setShowMention] = useState(false);
  const [search, setSearch] = useState({ open: false, q: "", results: [] });
  const [showFiles, setShowFiles] = useState(false);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [hl, setHl] = useState(null);
  const [tasksPanel, setTasksPanel] = useState({ open: false, loading: false, rows: null, error: null });
  const [linkFor, setLinkFor] = useState(null);
  const [createFor, setCreateFor] = useState(null);
  const [ctxNote, setCtxNote] = useState(null);
  const [view, setView] = useState(taskId ? "tasks" : "all");   // a view of THIS conversation; opening from a task starts task-focused
  const [taskInfo, setTaskInfo] = useState({});
  const [jobs, setJobs] = useState(null);
  const [ctxOpen, setCtxOpen] = useState(false);   // project details start collapsed on every screen size (one summary line)

  const scrollRef = useRef(null);
  const stickRef = useRef(true);
  const prependRef = useRef(null);
  const prevLenRef = useRef(0);
  const fileRef = useRef(null);
  const markedRef = useRef(null); // newest foreign message id we have already asked the server to mark read
  const loadToken = useRef(0);
  const textRef = useRef(text); textRef.current = text;
  const editingRef = useRef(editing); editingRef.current = editing;
  const editTextRef = useRef(editText); editTextRef.current = editText;
  const messagesRef = useRef(messages); messagesRef.current = messages;
  const highlightRef = useRef(highlightId); highlightRef.current = highlightId;
  const hlDone = useRef(null);
  const hlTimer = useRef(null);
  const viewRef = useRef(view); viewRef.current = view;
  const taskIdRef = useRef(taskId); taskIdRef.current = taskId;
  const readyRef = useRef(false);
  const askedTasks = useRef(new Set());
  const jobsAsked = useRef(false);
  const onRedirectRef = useRef(onRedirect); onRedirectRef.current = onRedirect;

  const people = useMemo(() => Object.fromEntries((details?.participants || []).map((p) => [p.user_id, p])), [details]);
  const peopleRef = useRef(people); peopleRef.current = people;
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  // ---- 1. initial load (details + newest messages) -- runs for a new conversation id / explicit Retry only ----
  useEffect(() => {
    let alive = true;
    const token = ++loadToken.current;
    readyRef.current = false;
    setLoading(true); setLoadError(null); setUnavailable(false);
    (async () => {
      const [d, m] = await Promise.all([getDetails(conversationId), fetchMessages(conversationId, null, 40, viewRef.current, viewRef.current === "tasks" ? taskIdRef.current : null)]);
      if (!alive || token !== loadToken.current) return;
      if (d.error) {
        if (/not found|no access/i.test(d.error.message || "")) setUnavailable(true); else setLoadError("Could not open this conversation.");
        setLoading(false);
        return;
      }
      // the old per-task conversation of a project task: it now lives in the project chat -> go there with the task as context
      if (d.data?.migrated_to_conversation_id) { onRedirectRef.current?.(d.data.migrated_to_conversation_id, d.data.task_id); return; }
      if (m.error) { console.error("[Chat] messages failed", m.error); setLoadError("Could not load messages."); setLoading(false); return; }
      let list = m.data;
      const want = highlightRef.current;
      if (want && !list.some((x) => x.id === want)) {
        // an old (e.g. migrated) message that is not in the newest window: load the window that ends at it
        const target = await fetchMessage(want);
        if (target.data && target.data.conversation_id === conversationId) {
          const around = await fetchMessagesAround(conversationId, target.data, 40);
          if (!around.error) list = around.data.concat(list.filter((x) => x.created_at > target.data.created_at)).filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
        }
        if (!alive || token !== loadToken.current) return;
      }
      setDetails(d.data);
      setMessages(list);
      setHasMore(list.length >= 40);
      const r = await fetchReads(conversationId);
      if (!alive || token !== loadToken.current) return;
      setReads(r.data);
      readyRef.current = true;
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [conversationId, retryKey]);

  // ---- 1b. changing the view / task filter re-queries the SAME conversation (details, members and the subscription are untouched) ----
  const viewKey = `${view}:${view === "tasks" ? taskId || "" : ""}`;
  useEffect(() => {
    if (!readyRef.current) return undefined;
    let alive = true;
    const token = ++loadToken.current;
    setLoading(true);
    fetchMessages(conversationId, null, 40, view, view === "tasks" ? taskId : null).then(({ data, error }) => {
      if (!alive || token !== loadToken.current) return;
      if (error) { setLoadError("Could not load messages."); setLoading(false); return; }
      setLoadError(null); stickRef.current = true; prevLenRef.current = 0;
      setMessages(data); setHasMore(data.length >= 40); setLoading(false);
    });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, conversationId]);

  // opening the chat from a (different) task focuses the timeline on that task
  const prevTask = useRef(taskId);
  useEffect(() => { if (taskId && taskId !== prevTask.current) setView("tasks"); prevTask.current = taskId; }, [taskId]);

  // ---- 2. draft: restore on open, save on close/switch ----
  useEffect(() => {
    setText(draftStore.get(conversationId) || "");
    return () => { draftStore.set(conversationId, textRef.current); };
  }, [conversationId]);

  // ---- 3. Realtime for THIS conversation only; every event is applied incrementally ----
  useEffect(() => {
    let membersTimer = null;
    let alive = true;
    const refreshDetails = () => {
      window.clearTimeout(membersTimer);
      membersTimer = window.setTimeout(async () => {
        const { data, error } = await getDetails(conversationId);
        if (!alive) return;
        if (error) { if (/not found|no access/i.test(error.message || "")) setUnavailable(true); return; }
        setDetails(data);
      }, 300);
    };
    const unsub = subscribeConversation(conversationId, `chat-open-${conversationId}`, {
      onMessage: (p) => {
        const n = p.new || {}; const o = p.old || {};
        if (p.eventType === "DELETE") { if (o.id) setMessages((cur) => cur.filter((m) => m.id !== o.id)); return; }
        if (!n.id) return;
        // an edit / delete of a message already on screen always merges; a NEW row is appended only if it belongs to the open view
        if (!messagesRef.current.some((m) => m.id === n.id) && !matchesView(n, viewRef.current, taskIdRef.current)) return;
        setMessages((cur) => upsertMessage(cur, n));
        if (n.sender_id && !peopleRef.current[n.sender_id]) refreshDetails(); // e.g. someone who just joined
      },
      onAttachment: (p) => {
        const a = p.new || {};
        if (p.eventType !== "INSERT" || !a.message_id) return;
        if (messagesRef.current.some((m) => m.id === a.message_id)) setMessages((cur) => attachTo(cur, a));
        else fetchMessage(a.message_id).then(({ data }) => { if (alive && data) setMessages((cur) => upsertMessage(cur, data)); });
      },
      onMember: (p) => {
        const n = p.new || {}; const o = p.old || {};
        if (p.eventType === "INSERT") { refreshDetails(); return; }
        if (!n.user_id) return;
        // a read receipt / mute of someone else: update only the small read-state map, nothing else
        setReads((cur) => {
          const prev = cur[n.user_id];
          if (prev && prev.last_read_at === n.last_read_at && prev.muted === n.muted) return cur;
          return { ...cur, [n.user_id]: { user_id: n.user_id, last_read_at: n.last_read_at, muted: n.muted } };
        });
        if ("left_at" in o && (o.left_at !== n.left_at || o.role !== n.role || o.can_post !== n.can_post)) refreshDetails();
        if (n.user_id === me && n.left_at) setUnavailable(true); // removed from the conversation
      },
    });
    return () => { alive = false; window.clearTimeout(membersTimer); unsub(); };
  }, [conversationId, me]);

  // catch up after the tab / network comes back (no polling): merge the newest window by id
  const refreshLatest = useCallback(async () => {
    const token = loadToken.current;
    const { data } = await fetchMessages(conversationId, null, 40, viewRef.current, viewRef.current === "tasks" ? taskIdRef.current : null);
    if (token !== loadToken.current) return;
    setMessages((cur) => data.reduce((acc, m) => upsertMessage(acc, m), cur));
    const r = await fetchReads(conversationId);
    if (token === loadToken.current) setReads((cur) => ({ ...cur, ...r.data }));
  }, [conversationId]);
  useForegroundRefresh(refreshLatest);

  useEffect(() => {
    const onVis = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // ---- 4. mark read: ONLY when a newer message from someone else is on screen (never in response to our own read echo) ----
  const latestForeignId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.sender_id !== me && !m.is_system && !m.deleted_at) return m.id;
    }
    return null;
  }, [messages, me]);
  useEffect(() => {
    if (loading || !visible || !latestForeignId || markedRef.current === latestForeignId) return;
    markedRef.current = latestForeignId;
    markRead(conversationId).then(({ data, error }) => {
      if (error) { markedRef.current = null; return; } // a later message will try again; no tight retry
      if (data) onRead?.(conversationId);
    });
  }, [conversationId, latestForeignId, loading, visible, onRead]);

  // ---- 4b. land on / flash the message an old Reply link pointed at (once per link) ----
  useEffect(() => {
    if (loading || !highlightId || hlDone.current === highlightId || !messages.some((m) => m.id === highlightId)) return;
    hlDone.current = highlightId;
    stickRef.current = false;
    setHl(highlightId);
    requestAnimationFrame(() => document.querySelector(`[data-mid="${highlightId}"]`)?.scrollIntoView({ block: "center" }));
    hlTimer.current = window.setTimeout(() => setHl(null), 3500);
  }, [loading, highlightId, messages]);
  useEffect(() => () => window.clearTimeout(hlTimer.current), []);

  // ---- 5. scrolling: bottom on open / when the user is already near it; never on plain re-renders ----
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prependRef.current != null) { el.scrollTop += el.scrollHeight - prependRef.current; prependRef.current = null; prevLenRef.current = messages.length; return; }
    if (messages.length > prevLenRef.current && stickRef.current) el.scrollTop = el.scrollHeight;
    prevLenRef.current = messages.length;
  }, [messages, loading]);
  function onScroll(e) {
    const el = e.currentTarget;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  async function loadOlder() {
    const first = messagesRef.current[0];
    if (!first || loadingOlder) return;
    setLoadingOlder(true);
    const { data, error } = await fetchMessages(conversationId, first.created_at, 40, viewRef.current, viewRef.current === "tasks" ? taskIdRef.current : null);
    setLoadingOlder(false);
    if (error) { setSendError("Could not load earlier messages."); return; }
    prependRef.current = scrollRef.current ? scrollRef.current.scrollHeight : null;
    setMessages((cur) => data.reduce((acc, m) => upsertMessage(acc, m), cur));
    setHasMore(data.length >= 40);
  }

  async function onPickFiles(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    setSendError(null);
    if (pending.length + files.length > 5) return setSendError("You can attach at most 5 files per message.");
    setSending(true);
    for (const f of files) {
      const { attachment, error: err } = await uploadChatFile(conversationId, f);
      if (err) { setSendError(err.message || "Upload failed."); break; }
      setPending((cur) => [...cur, attachment]);
    }
    setSending(false);
  }

  async function send() {
    const body = text.trim();
    if (sending || (!body && pending.length === 0)) return;
    if (details?.type === "project" && details.my_scope === "task" && !taskId) { setSendError("Choose the task this message is about."); return; }
    setSending(true); setSendError(null);
    const { data: id, error: err } = await sendMessage({
      conversationId, body, replyTo: replyTo?.id, mentions: mentions.filter((uid) => body.includes(`@${people[uid]?.name}`)), attachments: pending,
      taskId: details?.type === "project" ? taskId : undefined,
    });
    if (err || !id) {
      // the draft, reply and attachments stay exactly as they were, so pressing Send again is the retry
      console.error("[Chat] send failed", err);
      setSending(false);
      setSendError(/cannot post/i.test(err?.message || "") ? "You can no longer post in this conversation." : "Message not sent. Your text is kept — press Send to try again.");
      return;
    }
    setText(""); setReplyTo(null); setPending([]); setMentions([]);
    stickRef.current = true;
    const { data: row } = await fetchMessage(id); // same id as the Realtime INSERT -> merged, shown once
    if (row && matchesView(row, viewRef.current, taskIdRef.current)) setMessages((cur) => upsertMessage(cur, row));
    setSending(false);
  }

  const onReply = useCallback((m) => { setReplyTo(m); document.getElementById("chat-composer")?.focus(); }, []);
  const onStartEdit = useCallback((m) => { setEditing(m.id); setEditText(m.body); }, []);
  const onCancelEdit = useCallback(() => setEditing(null), []);
  const onSaveEdit = useCallback(async () => {
    const id = editingRef.current;
    const { error: err } = await editMessage(id, editTextRef.current);
    if (err) { setSendError(/15 minutes/.test(err.message) ? "Messages can only be edited for 15 minutes." : "Could not edit the message."); return; }
    setEditing(null);
    const { data: row } = await fetchMessage(id);
    if (row) setMessages((cur) => upsertMessage(cur, row));
  }, []);
  const onDelete = useCallback(async (m) => {
    let reason = null;
    if (m.sender_id !== me) {
      reason = window.prompt("Reason for removing this message (recorded in the moderation log):");
      if (!reason || !reason.trim()) return;
    } else if (!window.confirm("Delete this message?")) return;
    const { error: err } = await deleteMessage(m.id, reason);
    if (err) { setSendError("Could not delete the message."); return; }
    const { data: row } = await fetchMessage(m.id);
    if (row) setMessages((cur) => upsertMessage(cur, row));
  }, [me]);

  const loadProjectTasks = useCallback(async (projectId) => {
    setTasksPanel((s) => ({ ...s, loading: true, error: null }));
    const { data, error } = await projectTasks(projectId);
    setTasksPanel((s) => ({ ...s, loading: false, rows: error ? s.rows : data || [], error: error ? "Could not load the project's tasks." : null }));
  }, []);
  const tasksLoadedRef = useRef(false);
  const ensureProjectTasks = useCallback((projectId) => {
    if (tasksLoadedRef.current || !projectId) return;
    tasksLoadedRef.current = true;
    loadProjectTasks(projectId);
  }, [loadProjectTasks]);
  const toggleTasks = useCallback((projectId) => {
    setTasksPanel((s) => ({ ...s, open: !s.open }));
    ensureProjectTasks(projectId);
  }, [ensureProjectTasks]);
  const projectIdRef = useRef(null);
  projectIdRef.current = details?.context?.project_id || null;
  const onLinkTask = useCallback((m) => { setLinkFor(m); ensureProjectTasks(projectIdRef.current); }, [ensureProjectTasks]);
  const onCreateTask = useCallback((m) => setCreateFor(m), []);
  async function confirmLink(taskId) {
    const m = linkFor;
    setLinkFor(null);
    const { error: err } = await linkMessageToTask(m.id, taskId);
    if (err) { setSendError("Could not link the message to that task."); return; }
    const { data: row } = await fetchMessage(m.id);
    if (row) setMessages((cur) => upsertMessage(cur, row));
  }
  // Nothing is created here: the message becomes a DRAFT in the normal Assign Task form, which the user reviews and submits.
  function confirmCreate() {
    const m = createFor;
    const c = details?.context || {};
    try {
      sessionStorage.setItem("mow.assign_draft", JSON.stringify({ title: (m.body || "").split("\n")[0].slice(0, 120), description: m.body || "", project_id: c.project_id || "", from_chat_message: m.id }));
    } catch { /* storage unavailable: the form simply opens empty */ }
    setCreateFor(null);
    navigate("/");
  }
  async function openProjectFromTask() {
    setCtxNote(null);
    const { data, error: err } = await openProjectChat(ctx.project_id);
    if (err || !data) { setCtxNote("Project chat is limited to the people working on this project."); return; }
    navigate(`/chat?c=${data}`);
  }

  async function toggleMute() {
    const muted = !reads[me]?.muted;
    const { error } = await setMuted(conversationId, muted);
    if (!error) setReads((r) => ({ ...r, [me]: { ...r[me], muted } }));
  }

  async function runSearch(q) {
    setSearch((s) => ({ ...s, q }));
    if (q.trim().length < 2) return setSearch((s) => ({ ...s, results: [] }));
    const { data } = await searchMessages(q.trim(), conversationId);
    setSearch((s) => ({ ...s, results: data || [] }));
  }

  const isProject = details?.type === "project";
  const myScope = details?.my_scope || "full";
  const myTaskKey = (details?.my_task_ids || []).join(",");
  const projectIdVal = details?.context?.project_id || null;

  // which tasks do the messages on screen point at?  (one batched, cached lookup; only tasks the caller may see come back)
  const taskIdsKey = useMemo(() => [...new Set([...messages.map((m) => m.task_id).filter(Boolean), ...(taskId ? [taskId] : []), ...(myScope === "task" ? myTaskKey.split(",").filter(Boolean) : [])])].sort().join(","), [messages, taskId, myScope, myTaskKey]);
  useEffect(() => {
    const need = taskIdsKey.split(",").filter((id) => id && !askedTasks.current.has(id));
    if (!need.length) return;
    need.forEach((id) => askedTasks.current.add(id));
    taskRefs(need).then(({ data }) => { if (Array.isArray(data)) setTaskInfo((cur) => ({ ...cur, ...Object.fromEntries(data.map((t) => [t.task_id, t])) })); });
  }, [taskIdsKey]);

  // a task-scoped member with exactly one task is put "on" that task automatically
  useEffect(() => { if (isProject && myScope === "task" && !taskId && myTaskKey && !myTaskKey.includes(",")) onTaskChange?.(myTaskKey); }, [isProject, myScope, taskId, myTaskKey, onTaskChange]);
  // full members: the project's tasks feed the task filter
  useEffect(() => { if (isProject && myScope === "full" && (view === "tasks" || tasksPanel.open)) ensureProjectTasks(projectIdVal); }, [isProject, myScope, view, tasksPanel.open, projectIdVal, ensureProjectTasks]);
  // Job Cards linked to this project (a safe reference list; Factory people keep their own job chat)
  useEffect(() => {
    if (!isProject || !tasksPanel.open || jobsAsked.current || !projectIdVal || myScope !== "full") return;
    jobsAsked.current = true;
    projectJobs(projectIdVal).then(({ data }) => setJobs(Array.isArray(data) ? data : []));
  }, [isProject, tasksPanel.open, projectIdVal, myScope]);
  const taskOptions = useMemo(() => (myScope === "task"
    ? myTaskKey.split(",").filter(Boolean).map((id) => taskInfo[id]).filter(Boolean).map((i) => ({ id: i.task_id, label: `${i.task_number} — ${i.title}` }))
    : (tasksPanel.rows || []).map((t) => ({ id: t.id, label: `${t.task_number} — ${t.title}` }))), [myScope, myTaskKey, taskInfo, tasksPanel.rows]);
  const openTask = useCallback((id) => navigate(`/tasks?focus=${id}`), [navigate]);
  const changeView = (k) => { setView(k); if (taskId && k !== "all" && k !== "tasks") onTaskChange?.(null); };   // General / Jobs / Daily / Files are not about one task
  const pickTask = (id) => { onTaskChange?.(id); setView("tasks"); };
  const clearTask = () => { onTaskChange?.(null); if (view === "tasks") setView("all"); };

  const ctx = details?.context || {};
  const activePeople = (details?.participants || []).filter((p) => p.active);
  const direct = details?.type === "direct";
  const canPost = !!details?.i_can_post;
  const canManage = !!details?.i_can_manage;
  const now = Date.now();
  const allFiles = messages.filter((m) => !m.deleted_at).flatMap((m) => m.attachments);

  const seenText = (m) => {
    const others = Object.entries(reads).filter(([id]) => id !== me);
    if (direct) { const r = others[0]?.[1]?.last_read_at; return r && r >= m.created_at ? " · ✓✓ Seen" : " · ✓ Sent"; }
    const n = others.filter(([, r]) => r.last_read_at && r.last_read_at >= m.created_at).length;
    return n > 0 ? ` · Seen by ${n}` : " · ✓ Sent";
  };

  if (unavailable) {
    return (
      <div className="chat-conv">
        <div className="chat-topbar"><button type="button" className="chat-back" onClick={onBack} aria-label="Back to conversations">←</button><b>Conversation</b></div>
        <div className="chat-empty" role="alert" style={{ margin: "auto" }}>This conversation isn’t available to you.<div style={{ marginTop: 10 }}><button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={onBack}>Back to conversations</button></div></div>
      </div>
    );
  }

  let lastDay = null;
  return (
    <div className="chat-conv">
      <div className="chat-topbar">
        <button type="button" className="chat-back" onClick={onBack} aria-label="Back to conversations">←</button>
        <button type="button" className="chat-title" onClick={() => setShowInfo((v) => !v)} aria-expanded={showInfo}>
          <b>{details?.title || "…"}</b>
          <span className="sub">
            {details ? `${TYPE_LABEL[details.type] || details.type}${details.department ? ` · ${details.department}` : ""} · ${activePeople.length} member${activePeople.length === 1 ? "" : "s"}` : ""}
          </span>
        </button>
        <div className="chat-tools">
          <button type="button" className="fx-icon-btn" onClick={() => setSearch((s) => ({ ...s, open: !s.open }))} aria-label="Search in conversation" title="Search">🔍</button>
          <button type="button" className="fx-icon-btn" onClick={() => setShowFiles((v) => !v)} aria-label="Files in this conversation" title="Files">📎</button>
          <button type="button" className="fx-icon-btn" onClick={toggleMute} aria-label={reads[me]?.muted ? "Unmute" : "Mute"} title={reads[me]?.muted ? "Unmute" : "Mute"}>{reads[me]?.muted ? "🔕" : "🔔"}</button>
        </div>
      </div>

      <div className="chat-head">
      {details && (ctx.kind === "task" || ctx.kind === "bridge") && (
        <div className="chat-ctx">
          <div className="chat-ctx-main">
            <b>{ctx.task_number}</b> · {ctx.title}
            <div className="sub">
              {ctx.is_bridge ? <span className="fx-tag gold">🌉 {ctx.from_department} → {ctx.to_department}</span> : <span className="fx-tag">{ctx.owning_department}</span>}
              <span className="fx-tag">{ctx.status}</span>
              {ctx.due_date && <span className="fx-tag">Due {new Date(ctx.due_date + "T00:00:00").toLocaleDateString()}</span>}
              {(ctx.assignees || []).length > 0 && <span className="fx-tag">👤 {ctx.assignees.join(" + ")}</span>}
            </div>
          </div>
          <button type="button" className="btn btn-outline" onClick={() => navigate(`/?focus=${ctx.task_id}`)}>Open Task</button>
          {ctx.project_id && ctx.can_open_project && <button type="button" className="btn btn-outline" onClick={openProjectFromTask}>Project Chat</button>}
          {ctx.project_id && <Link className="btn btn-outline" to={`/interior-projects/detail/${ctx.project_id}`}>Open Project</Link>}
        </div>
      )}
      {ctxNote && <div className="msg info" role="status" style={{ margin: "6px 12px" }}>{ctxNote}</div>}
      {details && ctx.kind === "project" && (
        <div className="chat-ctx chat-ctx-project">
          <button type="button" className="chat-ctx-toggle" onClick={() => setCtxOpen((v) => !v)} aria-expanded={ctxOpen} aria-label="Project details">
            <span className="chat-ctx-main"><b>{ctx.project_code}</b> · {ctx.client}</span>
            {ctx.stage && <span className="fx-tag">{ctx.stage}</span>}
            <span aria-hidden="true">{ctxOpen ? "▴" : "▾"}</span>
          </button>
          {ctxOpen && (
            <>
              <div className="sub chat-ctx-tags">
                {ctx.site && <span className="fx-tag">📍 {ctx.site}</span>}
                <span className="fx-tag">{ctx.department}</span>
                {ctx.lead_executive && <span className="fx-tag">Lead: {ctx.lead_executive}</span>}
                {ctx.executive_assistant && <span className="fx-tag">Assistant: {ctx.executive_assistant}</span>}
                <span className="fx-tag">{activePeople.length} member{activePeople.length === 1 ? "" : "s"}</span>
                {ctx.archived && <span className="fx-tag">Archived</span>}
              </div>
              <div className="chat-ctx-actions">
                <Link className="btn btn-outline" to={`/interior-projects/detail/${ctx.project_id}`}>Open Project</Link>
                {myScope === "full" && <button type="button" className="btn btn-outline" onClick={() => toggleTasks(ctx.project_id)} aria-expanded={tasksPanel.open}>Tasks</button>}
                <Link className="btn btn-outline" to={`/interior-projects/detail/${ctx.project_id}?tab=files`}>Files</Link>
                <Link className="btn btn-outline" to={`/interior-projects/detail/${ctx.project_id}?tab=workingDrawings`}>Drawings</Link>
                <Link className="btn btn-outline" to={`/interior-projects/detail/${ctx.project_id}?tab=dailyUpdates`}>Daily updates</Link>
              </div>
            </>
          )}
        </div>
      )}
      {isProject && taskId && <TaskRefCard taskId={taskId} info={taskInfo[taskId]} onOpenTask={openTask} onClear={clearTask} />}
      {isProject && <ProjectViewBar view={view} onView={changeView} taskId={taskId} onTask={pickTask} taskOptions={taskOptions} />}
      {tasksPanel.open && ctx.kind === "project" && (
        <div className="chat-info" role="region" aria-label="Project tasks">
          <b>Project tasks{tasksPanel.rows ? ` (${tasksPanel.rows.length})` : ""}</b>
          <div className="sub">Task messages stay in this project chat, tagged with the task. Choose “Discuss” to write about one.</div>
          {tasksPanel.loading && <div className="sub">Loading…</div>}
          {tasksPanel.error && <div className="msg error" role="alert">{tasksPanel.error}</div>}
          {tasksPanel.rows && tasksPanel.rows.length === 0 && <div className="sub">No tasks you can see for this project.</div>}
          <ul className="chat-tasklist">
            {(tasksPanel.rows || []).map((t) => (
              <li key={t.id}><span><b>{t.task_number}</b> {t.title} <span className="fx-tag">{t.status}</span></span><ChatButton taskId={t.id} label="Discuss" style={{ minHeight: 44 }} /></li>
            ))}
          </ul>
          {jobs && jobs.length > 0 && (
            <>
              <b style={{ display: "block", marginTop: 10 }}>Linked Job Cards ({jobs.length})</b>
              <div className="sub">Factory keeps its own job chat; the full project conversation is never shared with it.</div>
              <ul className="chat-tasklist">
                {jobs.map((j) => <li key={j.id}><span><b>{j.job_order_number}</b> {j.product} {j.stage && <span className="fx-tag">{j.stage}</span>}</span><ChatButton jobId={j.id} label="Job chat" style={{ minHeight: 44 }} /></li>)}
              </ul>
            </>
          )}
        </div>
      )}
      {details && ctx.kind === "job_card" && (
        <div className="chat-ctx">
          <div className="chat-ctx-main">
            <b>{ctx.job_order_number}</b> · {[ctx.customer, ctx.project_code, ctx.product].filter(Boolean).join(" · ")}
            <div className="sub">
              {ctx.stage && <span className="fx-tag">{ctx.stage}</span>}
              {ctx.required_date && <span className="fx-tag">Required {new Date(ctx.required_date + "T00:00:00").toLocaleDateString()}</span>}
              <span className="fx-tag">{ctx.status}</span>
            </div>
          </div>
          <Link className="btn btn-outline" to={`/factory-job/${ctx.job_card_id}`}>Open Job Card</Link>
          <button type="button" className="btn btn-outline" onClick={() => setShowFiles(true)}>Files</button>
        </div>
      )}

      {details?.notice && <div className="chat-notice" role="note" title={details.notice}>🛈 {details.notice}</div>}

      {showInfo && details && (
        <div className="chat-info" role="region" aria-label="Conversation details">
          <b>Members ({activePeople.length})</b>
          <ul>
            {details.participants.map((p) => (
              <li key={p.user_id} className={p.active ? "" : "gone"}>
                <span>{p.name}{p.user_id === me ? " (you)" : ""}</span>
                <span className="sub">{p.role_label}{p.department ? ` · ${p.department}` : ""} · {p.chat_role.replace(/_/g, " ")}{p.scope === "task" ? " · task only" : ""}{p.active ? "" : " · left"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showFiles && (
        <div className="chat-info" role="region" aria-label="Files">
          <b>Files ({allFiles.length})</b>
          {allFiles.length === 0 && <div className="sub">No files shared yet (in the messages loaded so far).</div>}
          <div className="chat-filelist">{allFiles.map((a) => <Attachment key={a.id} att={a} />)}</div>
        </div>
      )}

      {search.open && (
        <div className="chat-search">
          <input type="search" autoFocus placeholder="Search this conversation…" value={search.q} onChange={(e) => runSearch(e.target.value)} aria-label="Search messages" />
          {search.results.map((r) => (
            <div key={r.id} className="chat-hit"><span className="sub">{r.task_number && <b>{r.task_number} · </b>}{r.sender || "System"} · {new Date(r.created_at).toLocaleString()}</span><div>{r.body}</div></div>
          ))}
          {search.q.trim().length >= 2 && search.results.length === 0 && <div className="sub" style={{ padding: 8 }}>No matches.</div>}
        </div>
      )}
      </div>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} role="log" aria-live="polite" aria-label="Messages">
        {loading && <div className="msg info">Loading…</div>}
        {!loading && hasMore && <button type="button" className="btn btn-outline chat-more" onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? "Loading…" : "Load earlier messages"}</button>}
        {!loading && !loadError && messages.length === 0 && <div className="chat-empty">{view !== "all" ? "Nothing here yet in this view." : "No messages yet. Say hello 👋"}</div>}
        {loadError && <div className="msg error" role="alert">{loadError} <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={() => setRetryKey((k) => k + 1)}>Retry</button></div>}
        {messages.map((m) => {
          const dk = dayKey(m.created_at);
          const showDay = dk !== lastDay; lastDay = dk;
          const mine = m.sender_id === me;
          const q = m.reply_to_id ? byId.get(m.reply_to_id) : null;
          const quotedText = q ? `${people[q.sender_id]?.name || "Message"}: ${q.deleted_at ? "Message deleted" : (q.body || "📎 Attachment").slice(0, 80)}` : null;
          const canEdit = mine && !m.is_system && !m.deleted_at && now - new Date(m.created_at).getTime() < CHAT_EDIT_WINDOW_MIN * 60000;
          return (
            <React.Fragment key={m.id}>
              {showDay && <div className="chat-day"><span>{fmtDay(m.created_at)}</span></div>}
              <MessageRow
                m={m} mine={mine} sender={people[m.sender_id]} quotedText={quotedText} seen={mine ? seenText(m) : ""}
                canReply={canPost} canEdit={canEdit} canDelete={mine || canManage}
                isEditing={editing === m.id} editText={editing === m.id ? editText : ""} onEditText={setEditText}
                onReply={onReply} onStartEdit={onStartEdit} onSaveEdit={onSaveEdit} onCancelEdit={onCancelEdit} onDelete={onDelete}
                highlighted={hl === m.id} projectActions={ctx.kind === "project" && canPost && myScope === "full"} onCreateTask={onCreateTask} onLinkTask={onLinkTask}
                tInfo={m.task_id ? taskInfo[m.task_id] : undefined} onOpenTask={openTask} showRefs={isProject} hideTask={view === "tasks" && !!taskId && m.task_id === taskId}
              />
            </React.Fragment>
          );
        })}
      </div>

      {details && !canPost ? (
        <div className="chat-readonly">{details.is_active ? "You can read this conversation but cannot post." : "This conversation is archived (read-only)."}</div>
      ) : (
        <div className="chat-composer">
          {isProject && taskId && (
            <div className="chat-replybar chat-taskbar"><span className="chat-taskbar-text">📌 Regarding <b>{taskInfo[taskId]?.task_number || "task"}</b>{taskInfo[taskId] ? ` — ${taskInfo[taskId].title}` : ""}</span><button type="button" onClick={clearTask} aria-label="Remove task reference">✕</button></div>
          )}
          {isProject && myScope === "task" && !taskId && (
            <select className="chat-taskselect" aria-label="Choose the task this message is about" value="" onChange={(e) => e.target.value && pickTask(e.target.value)}>
              <option value="">Choose the task to write about…</option>
              {taskOptions.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          )}
          {replyTo && <div className="chat-replybar">↩ Replying to <b>{people[replyTo.sender_id]?.name || "message"}</b>: {(replyTo.body || "📎 Attachment").slice(0, 60)} <button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply">✕</button></div>}
          {pending.length > 0 && <div className="chat-pending">{pending.map((a, i) => <span key={a.path} className="fx-tag">📎 {a.name} <button type="button" onClick={() => setPending((c) => c.filter((_, j) => j !== i))} aria-label={`Remove ${a.name}`}>✕</button></span>)}</div>}
          {showMention && (
            <ul className="chat-mentions" role="listbox" aria-label="Mention someone">
              {activePeople.filter((p) => p.user_id !== me).map((p) => (
                <li key={p.user_id}><button type="button" onClick={() => { setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}@${p.name} `); setMentions((c) => [...new Set([...c, p.user_id])]); setShowMention(false); document.getElementById("chat-composer")?.focus(); }}>{p.name} <span className="sub">{p.role_label}</span></button></li>
              ))}
            </ul>
          )}
          {sendError && <div className="msg error" role="alert" style={{ margin: "0 0 6px" }}>{sendError}</div>}
          <div className="chat-inputrow">
            <input ref={fileRef} type="file" multiple accept={CHAT_ACCEPT} onChange={onPickFiles} hidden />
            <button type="button" className="fx-icon-btn" onClick={() => fileRef.current?.click()} disabled={sending} aria-label="Attach a file">📎</button>
            <button type="button" className="fx-icon-btn" onClick={() => setShowMention((v) => !v)} aria-label="Mention someone" aria-expanded={showMention}>@</button>
            <textarea
              id="chat-composer" rows={1} value={text} maxLength={4000} placeholder="Write a message…" aria-label="Message"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
            />
            <button type="button" className="btn btn-primary chat-send" onClick={send} disabled={sending || (!text.trim() && pending.length === 0) || (isProject && myScope === "task" && !taskId)}>{sending ? "…" : "Send"}</button>
          </div>
        </div>
      )}

      {linkFor && (
        <div className="chat-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setLinkFor(null); }}>
          <div className="chat-modal" role="dialog" aria-modal="true" aria-label="Link message to a task">
            <div className="chat-modal-head"><b>Link to a task</b><button type="button" className="chat-x" onClick={() => setLinkFor(null)} aria-label="Close">×</button></div>
            <div className="sub" style={{ margin: "6px 0" }}>“{(linkFor.body || "").slice(0, 100)}” — only tasks of this project you can see are listed. Linking does not copy or change anything.</div>
            {tasksPanel.loading && <div className="msg info">Loading…</div>}
            {tasksPanel.rows && tasksPanel.rows.length === 0 && <div className="chat-empty">No tasks to link to.</div>}
            <ul className="chat-people">
              {(tasksPanel.rows || []).map((t) => <li key={t.id}><button type="button" onClick={() => confirmLink(t.id)}><b>{t.task_number}</b> {t.title} <span className="sub">{t.status}</span></button></li>)}
            </ul>
          </div>
        </div>
      )}
      {createFor && (
        <div className="chat-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setCreateFor(null); }}>
          <div className="chat-modal" role="dialog" aria-modal="true" aria-label="Create a task from this message">
            <div className="chat-modal-head"><b>Create a task from this message?</b><button type="button" className="chat-x" onClick={() => setCreateFor(null)} aria-label="Close">×</button></div>
            <div className="chat-quote" style={{ margin: "8px 0" }}>{(createFor.body || "").slice(0, 300)}</div>
            <div className="sub">This opens the Assign Task form with the message and this project filled in. Nothing is created until you review and submit it.</div>
            <div className="btn-row" style={{ marginTop: 10 }}><button type="button" className="btn btn-primary" onClick={confirmCreate}>Review in Assign Task</button><button type="button" className="btn btn-outline" onClick={() => setCreateFor(null)}>Cancel</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
