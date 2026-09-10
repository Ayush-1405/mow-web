import React from "react";
import Sidebar from "./Sidebar.jsx";
import { t } from "../lib/i18n";

// Layout used by every department page and the Management Control Tower:
// the responsive Sidebar (desktop rail / mobile drawer, see Sidebar.jsx)
// plus a slim top bar with logout, so a user who navigates here never
// loses the ability to sign out or get back to the existing Tasks/Assign/
// Bridges screens.
export default function DeptShell({ lang, items, managementLinks, onBackToTasks, onLogout, children }) {
  return (
    <div className="dept-shell">
      <Sidebar lang={lang} items={items} managementLinks={managementLinks} onBackToTasks={onBackToTasks} />
      <div className="dept-shell-right">
        <header className="app-header dept-main-header">
          <div>
            <h1>Mood of Wood</h1>
          </div>
          <div className="header-actions">
            <button className="icon-btn" onClick={onBackToTasks}>⬅ {t("backToTasks", lang)}</button>
            <button className="icon-btn" onClick={onLogout}>{t("logout", lang)}</button>
          </div>
        </header>
        <main className="dept-main">{children}</main>
      </div>
    </div>
  );
}
