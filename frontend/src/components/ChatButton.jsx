import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { openJobChat, openTaskChat } from "../lib/chatApi";

// "Chat" action for a Task, Bridge Task or Factory Job Card. The database creates-or-reuses the ONE conversation
// for that record and only returns it if the caller belongs (or is authorized leadership); otherwise it says so.
export default function ChatButton({ taskId, jobId, label = "💬 Chat", className = "btn btn-outline", style, wrapStyle, onError }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function open(e) {
    e?.stopPropagation?.();
    if (busy) return;
    setBusy(true); setMsg(null);
    const { data, error } = taskId ? await openTaskChat(taskId) : await openJobChat(jobId);
    setBusy(false);
    if (error || !data) {
      const text = /limited to the people|not have access|not found/i.test(error?.message || "") ? "Chat is limited to the people working on this item." : "Could not open the chat. Please try again.";
      if (!/limited/.test(text)) console.error("[ChatButton] open failed", error);
      setMsg(text);
      onError?.(text);
      return;
    }
    navigate(`/chat?c=${data}`);
  }

  return (
    <span className="chat-btn-wrap" style={{ display: "inline-flex", flexDirection: "column", gap: 4, ...wrapStyle }}>
      <button type="button" className={className} style={{ width: wrapStyle ? "100%" : "auto", marginTop: 0, minHeight: 44, ...style }} onClick={open} disabled={busy}>
        {busy ? "Opening…" : label}
      </button>
      {msg && <span className="sub" role="alert" style={{ color: "var(--danger)", fontSize: 12 }}>{msg}</span>}
    </span>
  );
}
