import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { chatHideThread, chatSend, chatStatus, chatThread, chatThreads, devCancel, devSubmit, withOwnerVerification } from "../lib/moodAiApi";

// Mood AI floating chat (Phase C). Sits outside the page routes, so it stays open while you move between pages.
// It answers and explains, in English, Hindi, Hinglish or Gujarati; it has no tools yet and changes nothing.
// Who you are comes from your sign-in on the server; the page you are on and the departments you can open are sent so it can
// explain the right screen and suggest links you can actually use.

const L = (lang, en, gu) => (lang === "gu" ? gu : en);
const THREAD_KEY = "mai_chat_thread";
const readThread = () => { try { return sessionStorage.getItem(THREAD_KEY) || null; } catch { return null; } };
const saveThread = (id) => { try { if (id) sessionStorage.setItem(THREAD_KEY, id); else sessionStorage.removeItem(THREAD_KEY); } catch { /* private mode */ } };
const HIDE_ON = [/^\/chat(\/|$)/]; // the team chat screen has its own send box at the bottom
const SUGGESTIONS = [
  "How do I send a job card to the factory?",
  "Mera aaj ka kaam kahan dikhega?",
  "Purchase request kaise banaye?",
  "Help me write a polite payment reminder to a client.",
];

// Voice input: the browser's own speech recognition (Chrome / Edge / Android). Hidden where the browser has none.
const Speech = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
const VOICE_LANGS = [["en-IN", "English"], ["hi-IN", "हिन्दी"], ["gu-IN", "ગુજરાતી"]];

export default function MoodAiChat({ lang, departments, management }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const [threadId, setThreadId] = useState(readThread);
  const [messages, setMessages] = useState([]);
  const [threads, setThreads] = useState(null); // null = conversation view; array = history view
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [devMode, setDevMode] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceLang, setVoiceLang] = useState(() => { try { return localStorage.getItem("mai_voice_lang") || (lang === "gu" ? "gu-IN" : "en-IN"); } catch { return "en-IN"; } });
  const recRef = useRef(null);
  const [waitSec, setWaitSec] = useState(0);

  // seconds counter while Mood AI is thinking (the AI services can take a while)
  useEffect(() => {
    if (!busy) { setWaitSec(0); return undefined; }
    const started = Date.now();
    const t = setInterval(() => setWaitSec(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  const hidden = HIDE_ON.some((re) => re.test(location.pathname));

  const refreshStatus = useCallback(() => chatStatus().then(setStatus).catch(() => setStatus(null)), []);

  // first open: status + the conversation kept for this browser tab
  useEffect(() => {
    if (!open) return;
    refreshStatus();
    if (threadId && !messages.length) chatThread(threadId).then(setMessages).catch(() => { setThreadId(null); saveThread(null); });
    setTimeout(() => inputRef.current?.focus(), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [messages, busy]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function send(raw) {
    const msg = String(raw ?? text).trim();
    if (!msg || busy) return;
    setError(""); setText(""); setBusy(true);
    setMessages((m) => [...m, { id: `local-${Date.now()}`, role: "user", content: msg }]);
    const r = await chatSend({
      thread_id: threadId, message: msg, page: { path: location.pathname, title: document.title },
      departments, management, mode: devMode ? "dev" : "chat",
    });
    setBusy(false);
    if (r.thread_id && r.thread_id !== threadId) { setThreadId(r.thread_id); saveThread(r.thread_id); }
    if (r.ok) {
      setMessages((m) => [...m, { id: `local-${Date.now()}-a`, role: "assistant", content: r.reply, links: r.links, cost_usd: r.cost_usd, latency_ms: r.latency_ms, model: r.model, dev: r.dev_request }]);
      setStatus((s) => (s ? { ...s, used_today: r.used_today, daily_limit: r.daily_limit } : s));
    } else {
      setError(r.error || L(lang, "Mood AI could not answer. Please try again.", "Mood AI જવાબ આપી શક્યું નહીં."));
      if (r.code === "ai_failed") setMessages((m) => [...m, { id: `local-${Date.now()}-e`, role: "error", content: r.error }]);
      else setMessages((m) => m.slice(0, -1)); // not stored by the server (limit / stopped / not allowed): take it back
      if (r.code !== "ai_failed") setText(msg);
      refreshStatus();
    }
  }

  function toggleVoice() {
    if (!Speech) return;
    if (listening) { recRef.current?.stop(); return; }
    const rec = new Speech();
    rec.lang = voiceLang; rec.interimResults = true; rec.continuous = false;
    const before = text ? `${text.trim()} ` : "";
    rec.onresult = (e) => { let t = ""; for (const res of e.results) t += res[0].transcript; setText(before + t); };
    rec.onerror = (e) => { if (e.error !== "aborted" && e.error !== "no-speech") setError(L(lang, "Voice input didn't work. Check the microphone permission.", "અવાજ ઇનપુટ ચાલ્યું નહીં.")); };
    rec.onend = () => { setListening(false); inputRef.current?.focus(); };
    recRef.current = rec; setError(""); setListening(true);
    try { rec.start(); } catch { setListening(false); }
  }

  async function devAction(msgId, dev, kind) {
    setError("");
    try {
      if (kind === "submit") {
        await withOwnerVerification(() => devSubmit(dev.id), async () => window.prompt(L(lang, "Enter the 6-digit code from your authenticator app to approve this request:", "ઓથેન્ટિકેટર કોડ (6 અંક):")));
      } else {
        if (!window.confirm(L(lang, `Cancel ${dev.ref}?`, `${dev.ref} રદ કરવું?`))) return;
        await devCancel(dev.id);
      }
      setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, dev: { ...x.dev, status: kind === "submit" ? "SUBMITTED" : "CANCELLED" } } : x)));
    } catch (e) {
      setError(e?.message || L(lang, "That didn't work.", "થયું નહીં."));
    }
  }

  function newChat() { setThreadId(null); saveThread(null); setMessages([]); setThreads(null); setError(""); inputRef.current?.focus(); }
  async function showHistory() { setError(""); try { setThreads(await chatThreads()); } catch { setError(L(lang, "Could not load your history.", "ઇતિહાસ લોડ થયો નહીં.")); } }
  async function openThread(id) {
    try { setMessages(await chatThread(id)); setThreadId(id); saveThread(id); setThreads(null); } catch { setError(L(lang, "Could not open that conversation.", "વાતચીત ખૂલી નહીં.")); }
  }
  async function hideThread(id) {
    try { await chatHideThread(id); setThreads((t) => t.filter((x) => x.id !== id)); if (id === threadId) newChat(); } catch { /* keep it listed */ }
  }

  if (hidden) return null;

  const blocked = status && (!status.allowed || !status.ai_enabled);
  const limitReached = status && status.used_today >= status.daily_limit;

  return (
    <>
      {!open && (
        <button type="button" className="mai-fab" onClick={() => setOpen(true)} aria-label="Open Mood AI">
          <span className="mai-fab-icon" aria-hidden="true">✦</span><span className="mai-fab-text">Mood AI</span>
        </button>
      )}
      {open && (
        <section className="mai-chat" role="dialog" aria-label="Mood AI chat">
          <header className="mai-chat-head">
            <div>
              <b>✦ Mood AI</b>
              <span className="mai-chat-sub">
                {status && !status.ai_enabled ? L(lang, "Stopped by the Owner", "માલિકે બંધ કર્યું")
                  : L(lang, "Explains the app and helps you write · can't change records yet", "એપ સમજાવે છે · હજુ રેકોર્ડ બદલી શકતું નથી")}
              </span>
            </div>
            <div className="mai-chat-actions">
              <button type="button" onClick={threads ? () => setThreads(null) : showHistory} title={L(lang, "History", "ઇતિહાસ")}>{threads ? "←" : "🕘"}</button>
              <button type="button" onClick={newChat} title={L(lang, "New chat", "નવી વાત")}>＋</button>
              <button type="button" onClick={() => setOpen(false)} title={L(lang, "Close", "બંધ")}>✕</button>
            </div>
          </header>

          {threads ? (
            <div className="mai-chat-list" ref={listRef}>
              <div className="mai-chat-note">{L(lang, "Your conversations (only you can see them)", "તમારી વાતચીત (ફક્ત તમે જોઈ શકો)")}</div>
              {threads.length === 0 && <div className="mai-chat-note">{L(lang, "No conversations yet.", "હજુ કોઈ વાતચીત નથી.")}</div>}
              {threads.map((t) => (
                <div key={t.id} className={`mai-thread ${t.id === threadId ? "on" : ""}`}>
                  <button type="button" className="mai-thread-open" onClick={() => openThread(t.id)}>
                    <span>{t.title}</span><small>{new Date(t.updated_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small>
                  </button>
                  <button type="button" className="mai-thread-hide" onClick={() => hideThread(t.id)} title={L(lang, "Remove from list", "યાદીમાંથી દૂર કરો")}>✕</button>
                </div>
              ))}
            </div>
          ) : (
            <div className="mai-chat-list" ref={listRef} aria-live="polite">
              {messages.length === 0 && !busy && (
                <div className="mai-chat-empty">
                  <p>{L(lang, "Ask in English, Hindi, Hinglish or Gujarati. I know which page you're on.", "અંગ્રેજી, હિન્દી, હિંગ્લિશ કે ગુજરાતીમાં પૂછો.")}</p>
                  {SUGGESTIONS.map((s) => <button type="button" key={s} className="mai-chip" onClick={() => send(s)} disabled={blocked || limitReached}>{s}</button>)}
                </div>
              )}
              {messages.map((m) => (
                <div key={m.id} className={`mai-msg ${m.role}`}>
                  <div className="mai-bubble">{m.content}</div>
                  {m.role === "assistant" && (m.links || []).length > 0 && (
                    <div className="mai-links">
                      {m.links.map((l) => <button type="button" key={l.path} className="mai-chip link" onClick={() => navigate(l.path)}>↗ {l.label}</button>)}
                    </div>
                  )}
                  {m.role === "assistant" && m.dev && (
                    <div className="mai-dev-card">
                      <div><b>{m.dev.ref}</b> · {m.dev.title} · <span className={`mai-risk ${m.dev.risk}`}>{m.dev.risk}</span></div>
                      {m.dev.goal && <div className="sub">{m.dev.goal}</div>}
                      {(m.dev.questions || []).length > 0 && <ul>{m.dev.questions.map((q) => <li key={q}>{q}</li>)}</ul>}
                      {m.dev.status === "DRAFT" ? (
                        <div className="btn-row">
                          <button type="button" className="btn btn-primary btn-sm" onClick={() => devAction(m.id, m.dev, "submit")}>{L(lang, "Approve & send to developer", "મંજૂર કરી ડેવલપરને મોકલો")}</button>
                          <button type="button" className="btn btn-outline btn-sm" onClick={() => devAction(m.id, m.dev, "cancel")}>{L(lang, "Cancel", "રદ")}</button>
                        </div>
                      ) : <div className="sub">{m.dev.status === "SUBMITTED" ? L(lang, "Sent to the developer. You'll be notified at each step.", "ડેવલપરને મોકલ્યું. દરેક પગલે સૂચના મળશે.") : m.dev.status}</div>}
                    </div>
                  )}
                  {m.role === "assistant" && status?.can_see_cost && m.cost_usd != null && (
                    <div className="mai-meta">${Number(m.cost_usd).toFixed(4)}{m.latency_ms ? ` · ${(m.latency_ms / 1000).toFixed(1)} s` : ""}{m.model ? ` · ${m.model}` : ""}</div>
                  )}
                </div>
              ))}
              {busy && (
                <div className="mai-msg assistant">
                  <div className="mai-bubble mai-typing"><span /><span /><span /></div>
                  {waitSec >= 3 && <div className="mai-meta">{devMode ? L(lang, "Writing the developer request…", "ડેવલપર વિનંતી લખાય છે…") : L(lang, "Thinking…", "વિચારે છે…")} {waitSec} s</div>}
                </div>
              )}
            </div>
          )}

          {!threads && (
            <footer className="mai-chat-foot">
              {error && <div className="mai-chat-error">{error}</div>}
              {blocked ? (
                <div className="mai-chat-note">{!status.ai_enabled ? L(lang, "Mood AI is stopped by the Owner right now.", "Mood AI હાલ બંધ છે.") : L(lang, "Mood AI chat is not switched on for you yet.", "Mood AI ચેટ હજુ તમારા માટે ચાલુ નથી.")}</div>
              ) : (
                <>
                {status?.is_owner && (
                  <div className="mai-mode">
                    <button type="button" className={!devMode ? "on" : ""} onClick={() => setDevMode(false)}>💬 {L(lang, "Ask", "પૂછો")}</button>
                    <button type="button" className={devMode ? "on" : ""} onClick={() => setDevMode(true)}>🛠 {L(lang, "Developer request", "ડેવલપર વિનંતી")}</button>
                  </div>
                )}
                <form className="mai-chat-form" onSubmit={(e) => { e.preventDefault(); send(); }}>
                  {Speech && (
                    <button type="button" className={`mai-mic ${listening ? "on" : ""}`} onClick={toggleVoice} disabled={busy || limitReached}
                      title={L(lang, "Speak", "બોલો")} aria-label={listening ? "Stop voice input" : "Voice input"}>{listening ? "■" : "🎤"}</button>
                  )}
                  <textarea ref={inputRef} rows={1} value={text} maxLength={2000} disabled={busy || limitReached}
                    placeholder={limitReached ? L(lang, "Today's limit is used up", "આજની મર્યાદા પૂરી") : listening ? L(lang, "Listening…", "સાંભળું છું…")
                      : devMode ? L(lang, "Describe the change you want in the app…", "એપમાં શું બદલવું છે તે લખો…") : L(lang, "Ask Mood AI…", "Mood AI ને પૂછો…")}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
                  <button type="submit" className="btn btn-primary" disabled={busy || !text.trim() || limitReached}>{busy ? "…" : "➤"}</button>
                </form>
                {Speech && (
                  <select className="mai-voice-lang" value={voiceLang} aria-label="Voice language"
                    onChange={(e) => { setVoiceLang(e.target.value); try { localStorage.setItem("mai_voice_lang", e.target.value); } catch { /* ignore */ } }}>
                    {VOICE_LANGS.map(([v, n]) => <option key={v} value={v}>🎤 {n}</option>)}
                  </select>
                )}
                </>
              )}
              {status && !blocked && <div className="mai-chat-count">{status.used_today}/{status.daily_limit} {L(lang, "today", "આજે")}</div>}
            </footer>
          )}
        </section>
      )}
    </>
  );
}
