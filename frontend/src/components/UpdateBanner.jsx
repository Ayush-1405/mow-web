import React, { useEffect, useState } from "react";

// Shown when main.jsx's registerSW() reports a new service worker is
// waiting (onNeedReload dispatches "mow-sw-update"). Nothing reloads until
// the user clicks Update -- replaces vite-plugin-pwa's default silent
// window.location.reload() on activation, which could previously land at
// an arbitrary moment (e.g. mid-form-entry).
export default function UpdateBanner({ lang }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    function onUpdate() { setVisible(true); }
    window.addEventListener("mow-sw-update", onUpdate);
    return () => window.removeEventListener("mow-sw-update", onUpdate);
  }, []);

  if (!visible) return null;

  return (
    <div className="install-banner" role="dialog" aria-label="Update available">
      <div className="install-banner-icon" aria-hidden="true">🔄</div>
      <div className="install-banner-text">
        <strong>{lang === "gu" ? "નવું વર્ઝન ઉપલબ્ધ છે" : "A new version is available"}</strong>
        {lang === "gu"
          ? "તાજેતરના ફેરફારો મેળવવા માટે એપ અપડેટ કરો."
          : "Update to get the latest changes."}
      </div>
      <div className="install-banner-actions">
        <button className="btn btn-primary" onClick={() => window.__mowApplyUpdate?.()}>
          {lang === "gu" ? "એપ અપડેટ કરો" : "Update App"}
        </button>
      </div>
    </div>
  );
}
