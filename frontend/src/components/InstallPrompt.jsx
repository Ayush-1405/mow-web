import React, { useEffect, useState } from "react";

const DISMISS_KEY = "moodOfWood_installDismissedAt";
const DISMISS_DAYS = 14;

function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIos() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent) && !window.MSStream;
}

function recentlyDismissed() {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const days = (Date.now() - Number(raw)) / (1000 * 60 * 60 * 24);
    return days < DISMISS_DAYS;
  } catch {
    return false;
  }
}

// Add to Home Screen banner — Android/Chrome gets the real native install
// prompt via `beforeinstallprompt` (browser fires it only once the PWA
// installability criteria — manifest + service worker — are met, which
// vite-plugin-pwa's build now satisfies). iOS Safari never fires that
// event at all, so it gets a plain "Tap Share, then Add to Home Screen"
// instruction instead — there is no programmatic install API on iOS.
export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [iosVisible, setIosVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (isStandalone() || recentlyDismissed()) return;

    function onBeforeInstall(e) {
      e.preventDefault();
      setDeferredPrompt(e);
    }
    function onInstalled() {
      setDeferredPrompt(null);
      setIosVisible(false);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    if (isIos()) setIosVisible(true);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  function dismiss() {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* private mode — non-fatal */ }
    setDismissed(true);
  }

  async function handleInstallClick() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
  }

  if (dismissed || (!deferredPrompt && !iosVisible)) return null;

  return (
    <div className="install-banner" role="dialog" aria-label="Install app">
      <button className="install-banner-close" onClick={dismiss} aria-label="Dismiss">✕</button>
      <div className="install-banner-icon" aria-hidden="true">📲</div>
      <div className="install-banner-text">
        <strong>Install Mood of Wood / એપ ઇન્સ્ટોલ કરો</strong>
        {deferredPrompt
          ? "Add this app to your home screen for quick, full-screen access."
          : "Tap the Share icon, then \"Add to Home Screen\" to install this app."}
      </div>
      {deferredPrompt && (
        <div className="install-banner-actions">
          <button className="btn btn-primary" onClick={handleInstallClick}>Install</button>
        </div>
      )}
    </div>
  );
}
