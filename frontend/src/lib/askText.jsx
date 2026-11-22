/* eslint-disable react-refresh/only-export-components -- askText() mounts its own small dialog component */
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { t } from "./i18n";

// In-app replacement for window.prompt(). Some phones and installed-app windows do not support prompt() at all (the app
// recorded "prompt() is not supported"), so every button that asked for a reason that way failed on them.
// Usage: const reason = await askText("Reason for ...", { lang }); -> the typed text (trimmed), or null when cancelled.
// Options: lang, required (default true: OK stays disabled until something is typed), placeholder, defaultValue, inputMode,
// maxLength, okLabel.

function AskDialog({ message, opts, done }) {
  const [value, setValue] = useState(opts.defaultValue ?? "");
  const input = useRef(null);
  const required = opts.required !== false;
  const lang = opts.lang;
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") done(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [done]);
  const ok = () => { const v = value.trim(); if (required && !v) return; done(v); };
  return (
    <div className="modal-backdrop" onClick={() => done(null)}>
      <form className="modal-card" role="dialog" aria-modal="true" aria-label={message}
        onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); ok(); }}>
        <div className="modal-card-title" style={{ whiteSpace: "pre-line" }}>{message}</div>
        <textarea ref={input} value={value} onChange={(e) => setValue(e.target.value)} rows={opts.inputMode ? 1 : 3}
          inputMode={opts.inputMode} maxLength={opts.maxLength} placeholder={opts.placeholder || ""}
          autoComplete={opts.inputMode === "numeric" ? "one-time-code" : "off"}
          onKeyDown={(e) => { if (e.key === "Enter" && (opts.inputMode || e.ctrlKey || e.metaKey)) { e.preventDefault(); ok(); } }}
          style={{ width: "100%", margin: "12px 0", boxSizing: "border-box", font: "inherit", padding: 10 }} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-outline" onClick={() => done(null)}>{t("cancel", lang)}</button>
          <button type="submit" className="btn btn-primary" disabled={required && !value.trim()}>{opts.okLabel || t("submit", lang)}</button>
        </div>
      </form>
    </div>
  );
}

export function askText(message, opts = {}) {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let finished = false;
    const done = (v) => {
      if (finished) return;
      finished = true;
      resolve(v === "" ? null : v);
      setTimeout(() => { root.unmount(); host.remove(); }, 0);
    };
    root.render(<AskDialog message={message} opts={opts} done={done} />);
  });
}
