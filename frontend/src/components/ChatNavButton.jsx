import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { subscribeChatBadge, unreadTotal } from "../lib/chatApi";
import { useForegroundRefresh } from "../lib/useForegroundRefresh";

// Header entry for the internal Chat: icon + REAL unread badge (server-side count, muted chats excluded).
// One pair of channels for the whole header, created once per signed-in user id (primitive) -- never per render.
export default function ChatNavButton({ className = "icon-btn bell", label = "Chat" }) {
  const navigate = useNavigate();
  const [n, setN] = useState(0);
  const [uid, setUid] = useState(null);

  const load = useCallback(async () => {
    const { data, error } = await unreadTotal();
    if (!error && typeof data === "number") setN((cur) => (cur === data ? cur : data));
  }, []);

  useEffect(() => {
    let active = true;
    // getSession reads the local session (no network round trip, unlike getUser)
    supabase.auth.getSession().then(({ data }) => { if (active) setUid(data?.session?.user?.id || null); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!uid) return undefined;
    load();
    return subscribeChatBadge(uid, `chat-badge-${uid}`, load);
  }, [uid, load]);
  useForegroundRefresh(load);

  return (
    <button type="button" className={className} onClick={() => navigate("/chat")} aria-label={n > 0 ? `${label} (${n} unread)` : label} title={label}>
      💬{n > 0 && <span className="dot">{n > 9 ? "9+" : n}</span>}
    </button>
  );
}
