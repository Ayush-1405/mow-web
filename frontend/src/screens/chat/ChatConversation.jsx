import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  CHAT_ACCEPT, CHAT_EDIT_WINDOW_MIN, TYPE_LABEL, chatFileUrl, deleteMessage, editMessage, fetchMessage, fetchMessages, fetchReads, getDetails,
  markRead, searchMessages, sendMessage, setMuted, subscribeConversation, uploadChatFile,
} from "../../lib/chatApi";
import { useForegroundRefresh } from "../../lib/useForegroundRefresh";

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
    chatFileUrl(att.storage_path).then(({ url: u }) => { if (active) setUrl(u); });
    return () => { active = false; };
  }, [att.storage_path, isImg]);
  async function download() {
    const { url: u } = await chatFileUrl(att.storage_path);
    if (u) window.open(u, "_blank", "noopener,noreferrer");
  }
  if (isImg) {
    return url ? (
      <button type="button" className="chat-img" onClick={() => window.open(url, "_blank", "noopener,noreferrer")} aria-label={`Open image ${att.file_name}`}>
        <img src={url} alt={att.file_name} loading="lazy" onError={async () => { if (retried.current) return; retried.current = true; const { url: u } = await chatFileUrl(att.storage_path, { fresh: true }); if (u) setUrl(u); }} />
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
const MessageRow = memo(function MessageRow({ m, mine, sender, quotedText, seen, canReply, canEdit, canDelete, isEditing, editText, onEditText, onReply, onStartEdit, onSaveEdit, onCancelEdit, onDelete }) {
  if (m.is_system) return <div className="chat-system" data-mid={m.id}>{m.body}</div>;
  return (
    <div className={`chat-msg${mine ? " mine" : ""}`} data-mid={m.id}>
      {!mine && sender && <div className="chat-sender"><b>{sender.name}</b> <span className="sub">{sender.role_label}{sender.department ? ` · ${sender.department}` : ""}</span></div>}
      {!mine && !sender && <div className="chat-sender"><b>Former member</b></div>}
      <div className="chat-bubble">
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
        <div className="chat-meta">{fmtTime(m.created_at)}{m.edited_at && !m.deleted_at ? " · edited" : ""}{mine && !m.deleted_at ? seen : ""}</div>
      </div>
      {!m.deleted_at && !isEditing && canReply && (
        <div className="chat-actions">
          <button type="button" onClick={() => onReply(m)} aria-label="Reply">↩ Reply</button>
          {canEdit && <button type="button" onClick={() => onStartEdit(m)} aria-label="Edit">✎ Edit</button>}
          {canDelete && <button type="button" onClick={() => onDelete(m)} aria-label="Delete">🗑 Delete</button>}
        </div>
      )}
    </div>
  );
});

// The open conversation. `key={conversationId}` in the parent gives every conversation a clean instance; everything
// below depends on PRIMITIVES (conversation id, my id) only, so a parent re-render can never restart a load.
export default function ChatConversation({ conversationId, me, onBack, onRead }) {
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

  const people = useMemo(() => Object.fromEntries((details?.participants || []).map((p) => [p.user_id, p])), [details]);
  const peopleRef = useRef(people); peopleRef.current = people;
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  // ---- 1. initial load (details + newest messages) -- runs for a new conversation id / explicit Retry only ----
  useEffect(() => {
    let alive = true;
    const token = ++loadToken.current;
    setLoading(true); setLoadError(null); setUnavailable(false);
    (async () => {
      const [d, m] = await Promise.all([getDetails(conversationId), fetchMessages(conversationId, null, 40)]);
      if (!alive || token !== loadToken.current) return;
      if (d.error) {
        if (/not found|no access/i.test(d.error.message || "")) setUnavailable(true); else setLoadError("Could not open this conversation.");
        setLoading(false);
        return;
      }
      if (m.error) { console.error("[Chat] messages failed", m.error); setLoadError("Could not load messages."); setLoading(false); return; }
      setDetails(d.data);
      setMessages(m.data);
      setHasMore(m.data.length >= 40);
      const r = await fetchReads(conversationId);
      if (!alive || token !== loadToken.current) return;
      setReads(r.data);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [conversationId, retryKey]);

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
    const { data } = await fetchMessages(conversationId, null, 40);
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
    const { data, error } = await fetchMessages(conversationId, first.created_at, 40);
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
    setSending(true); setSendError(null);
    const { data: id, error: err } = await sendMessage({
      conversationId, body, replyTo: replyTo?.id, mentions: mentions.filter((uid) => body.includes(`@${people[uid]?.name}`)), attachments: pending,
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
    if (row) setMessages((cur) => upsertMessage(cur, row));
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

      {details?.notice && <div className="chat-notice" role="note">🛈 {details.notice}</div>}

      {showInfo && details && (
        <div className="chat-info" role="region" aria-label="Conversation details">
          <b>Members ({activePeople.length})</b>
          <ul>
            {details.participants.map((p) => (
              <li key={p.user_id} className={p.active ? "" : "gone"}>
                <span>{p.name}{p.user_id === me ? " (you)" : ""}</span>
                <span className="sub">{p.role_label}{p.department ? ` · ${p.department}` : ""} · {p.chat_role.replace(/_/g, " ")}{p.active ? "" : " · left"}</span>
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
            <div key={r.id} className="chat-hit"><span className="sub">{r.sender || "System"} · {new Date(r.created_at).toLocaleString()}</span><div>{r.body}</div></div>
          ))}
          {search.q.trim().length >= 2 && search.results.length === 0 && <div className="sub" style={{ padding: 8 }}>No matches.</div>}
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} role="log" aria-live="polite" aria-label="Messages">
        {loading && <div className="msg info">Loading…</div>}
        {!loading && hasMore && <button type="button" className="btn btn-outline chat-more" onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? "Loading…" : "Load earlier messages"}</button>}
        {!loading && !loadError && messages.length === 0 && <div className="chat-empty">No messages yet. Say hello 👋</div>}
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
              />
            </React.Fragment>
          );
        })}
      </div>

      {details && !canPost ? (
        <div className="chat-readonly">{details.is_active ? "You can read this conversation but cannot post." : "This conversation is archived (read-only)."}</div>
      ) : (
        <div className="chat-composer">
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
            <button type="button" className="btn btn-primary chat-send" onClick={send} disabled={sending || (!text.trim() && pending.length === 0)}>{sending ? "…" : "Send"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
