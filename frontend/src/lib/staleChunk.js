import { lazy } from "react";

// After a new release, a copy of the app that is still open (or cached on a phone) asks for screen files that the release
// removed. Instead of the crash "'text/html' is not a valid JavaScript MIME type", the app reloads once into the new
// version. A timestamp in sessionStorage stops a reload loop: at most one such reload per minute; if the new version
// still cannot load the screen, the normal error screen shows.

const KEY = "mow_chunk_reload_at";
let reloading = false;

const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|is not a valid JavaScript MIME type|Unable to preload CSS|Loading (CSS )?chunk .* failed|ChunkLoadError/i;

export function isChunkLoadError(e) {
  return CHUNK_ERROR.test(String(e?.message ?? e ?? ""));
}

export const isReloadingForNewVersion = () => reloading;

// Returns true when a reload has started (the caller should then wait, not show an error).
export function reloadForNewVersion() {
  if (reloading) return true;
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(KEY)) || 0;
    if (Date.now() - last < 60_000) return false; // already tried a moment ago: do not loop
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false; // storage blocked: cannot guard against a loop, so do not reload
  }
  reloading = true;
  (async () => {
    try {
      // a new service worker already waiting: activate it (it reloads the page into the new version)
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg?.waiting && typeof window.__mowApplyUpdate === "function") { window.__mowApplyUpdate(); return; }
    } catch { /* fall back to a plain reload */ }
    window.location.reload();
  })();
  return true;
}

// React.lazy that survives a release: a missing screen file reloads the app once; the screen keeps its loading state meanwhile.
export function retrying(factory) {
  return () => factory().catch((e) => {
    if (isChunkLoadError(e) && reloadForNewVersion()) return new Promise(() => {});
    throw e;
  });
}
export const lazyWithRetry = (factory) => lazy(retrying(factory));

// Other on-demand files (Excel / PDF export libraries, CSS): Vite announces a failed load with this event.
export function installStaleChunkRecovery() {
  window.addEventListener("vite:preloadError", (ev) => {
    if (isChunkLoadError(ev?.payload)) reloadForNewVersion();
  });
}
