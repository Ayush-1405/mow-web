import { useEffect, useRef } from "react";

// Belt-and-suspenders on top of Realtime: if a websocket was dropped while
// the tab was backgrounded/offline, this silently re-runs `cb` (a screen's
// own existing load()/loadX() function -- never a page reload) once the
// device/tab is actually usable again. Never signs the user out or forces
// a re-login -- it only re-fetches data, same as any other background
// refresh in this app.
//
// FILE PICKERS ARE NOT "COMING BACK TO THE APP". Opening the browser's file
// dialog (or the phone's camera/gallery) blurs the window, and closing it
// fires `focus` / `visibilitychange` -- which used to trigger every screen's
// reload the instant a file was chosen. Screens that swap their form for a
// loading skeleton while reloading then threw the form (and the file the
// user had just picked) away, which looked like the page refreshing by
// itself and made attachments impossible to upload. So: while a file dialog
// is open, and for a few seconds after it closes, foreground refreshes are
// skipped. A short minimum interval also stops focus + visibilitychange
// (which often fire together) from double-loading.

let fileDialogOpen = false;
let suppressUntil = 0;
const SUPPRESS_AFTER_DIALOG_MS = 4000;
const MIN_INTERVAL_MS = 3000;

function closeDialogWindow() {
  if (fileDialogOpen) {
    fileDialogOpen = false;
    suppressUntil = Date.now() + SUPPRESS_AFTER_DIALOG_MS;
  }
}

if (typeof window !== "undefined" && !window.__mowFileDialogGuard) {
  window.__mowFileDialogGuard = true;
  // Capture phase + registered at module load, so these run before any
  // screen's own focus/visibility listener.
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (t && t.tagName === "INPUT" && t.type === "file") fileDialogOpen = true;
  }, true);
  document.addEventListener("change", (e) => {
    if (e.target && e.target.type === "file") { fileDialogOpen = true; closeDialogWindow(); }
  }, true);
  document.addEventListener("cancel", (e) => {
    if (e.target && e.target.type === "file") { fileDialogOpen = true; closeDialogWindow(); }
  }, true);
  window.addEventListener("focus", closeDialogWindow, true);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) closeDialogWindow(); }, true);
}

export function useForegroundRefresh(cb) {
  const last = useRef(0);
  useEffect(() => {
    if (typeof cb !== "function") return undefined;
    function run() {
      const now = Date.now();
      if (fileDialogOpen || now < suppressUntil) return;
      if (now - last.current < MIN_INTERVAL_MS) return;
      last.current = now;
      cb();
    }
    function onVisible() {
      if (!document.hidden) run();
    }
    window.addEventListener("online", run);
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", run);
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [cb]);
}
