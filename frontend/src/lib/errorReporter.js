import { supabase } from "./supabase";
import { isChunkLoadError, isReloadingForNewVersion } from "./staleChunk";

// Records problems people hit in the app (v3_16, app_report_error) so the scheduled "app doctor" can find and fix them.
// Never throws, never blocks the screen; the same problem is sent at most once per 10 minutes per browser tab. Personal
// data (numbers, e-mails, ids) is masked again in the database before it is stored.

/* global __APP_BUILD__ */
const BUILD = typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "local";
const recent = new Map();
let sending = false;

// Errors that are the user's situation, not a bug: offline, signed out, a deliberate business rule.
const NOT_A_BUG = /Failed to fetch|NetworkError|Load failed|network request failed|JWT|token.*expired|not authenticated|Invalid Refresh Token|AbortError|ResizeObserver loop/i;

export function reportProblem(kind, message, detail) {
  try {
    const text = String(message || "").trim();
    if (!text || NOT_A_BUG.test(text)) return;
    if (isChunkLoadError(text) && isReloadingForNewVersion()) return; // reloading into the new release
    const page = window.location.pathname;
    const key = `${kind}|${page}|${text}`;
    const now = Date.now();
    if (recent.has(key) && now - recent.get(key) < 10 * 60 * 1000) return;
    recent.set(key, now);
    if (sending && kind !== "crash") return; // one at a time; a storm of the same failure needs one report
    sending = true;
    supabase.rpc("app_report_error", {
      p_kind: kind, p_page: page, p_message: text.slice(0, 1000), p_detail: detail ? String(detail).slice(0, 4000) : null,
      p_version: BUILD, p_agent: navigator.userAgent.slice(0, 300),
    }).then(() => { sending = false; }, () => { sending = false; });
  } catch {
    sending = false;
  }
}

// Browser-level crashes that no screen caught.
export function installGlobalReporters() {
  window.addEventListener("error", (e) => {
    if (e?.message) reportProblem("unhandled", e.message, e.error?.stack || `${e.filename || ""}:${e.lineno || ""}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e?.reason;
    reportProblem("unhandled", r?.message || String(r || ""), r?.stack);
  });
}
