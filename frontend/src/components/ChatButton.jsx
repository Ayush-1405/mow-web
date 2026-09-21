import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { openJobChat, openProjectChat, openTaskChat } from "../lib/chatApi";

// "Chat" action for a Task, Bridge Task, Factory Job Card or Project. A Project-linked task opens its PROJECT chat with the task as
// context (never a separate task conversation); everything else creates-or-reuses the ONE conversation for that record and only returns it if the caller belongs (or is authorized leadership); otherwise it says so. `unread` shows the
// conversation's unread count on the button (Chat is the only place messages live -- there is no separate Reply).
export default function ChatButton({ taskId, jobId, projectId, label = "💬 Chat", unread = 0, className = "btn btn-outline", style, wrapStyle, onError }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function open(e) {
    e?.stopPropagation?.();
    if (busy) return;
    setBusy(true); setMsg(null);
    const { data: raw, error } = taskId ? await openTaskChat(taskId) : projectId ? await openProjectChat(projectId) : await openJobChat(jobId);
    setBusy(false);
    // a task answers with WHERE to go: its project chat + the task as context, or (standalone task) its own chat
    const data = taskId ? raw?.conversation_id : raw;
    if (error || !data) {
      const text = /limited to the people|not have access|not found/i.test(error?.message || "") ? "Chat is limited to the people working on this item." : "Could not open the chat. Please try again.";
      if (!/limited/.test(text)) console.error("[ChatButton] open failed", error);
      setMsg(text);
      onError?.(text);
      return;
    }
    navigate(taskId && raw.mode === "project" ? `/chat?c=${data}&task=${raw.task_id}` : `/chat?c=${data}`);
  }

  return (
    <span className="chat-btn-wrap" style={{ display: "inline-flex", flexDirection: "column", gap: 4, ...wrapStyle }}>
      <button type="button" className={className} style={{ width: wrapStyle ? "100%" : "auto", marginTop: 0, minHeight: 46, ...style }} onClick={open} disabled={busy}
        aria-label={unread > 0 ? `${label.replace(/^\S+\s/, "")} (${unread} unread)` : undefined}>
        {busy ? "Opening…" : label}
        {!busy && unread > 0 && <span className="chat-badge" style={{ marginLeft: 6 }}>{unread > 99 ? "99+" : unread}</span>}
      </button>
      {msg && <span className="sub" role="alert" style={{ color: "var(--danger)", fontSize: 12 }}>{msg}</span>}
    </span>
  );
}
