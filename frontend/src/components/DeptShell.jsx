import React, { useState } from "react";
import Sidebar from "./Sidebar.jsx";
import AppHeader from "./AppHeader.jsx";
import { t } from "../lib/i18n";
import ChatNavButton from "./ChatNavButton.jsx";
import ManagementBadge from "./ManagementBadge.jsx";
import NotificationPrompt from "./NotificationPrompt.jsx";

// Layout used by every department page and the Management Control Tower: the responsive Sidebar (desktop rail / mobile drawer, see
// Sidebar.jsx) plus ONE header (AppHeader) with the menu button, chat, back-to-tasks and logout, so a user who navigates here never
// loses the ability to sign out or get back to the existing Tasks/Assign/Bridges screens.
//
// Layout contract (styles.css): .dept-shell is exactly the visible viewport tall and never scrolls; the header is a normal flex item
// (no sticky/fixed); only <main> scrolls -- or, for `flush` pages such as Chat, <main> is a non-scrolling flex box that the page fills
// itself (the page then owns its own single scroll area).
export default function DeptShell({ lang, items, managementLinks, managementBadge = false, onBackToTasks, onLogout, flush = false, children }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="dept-shell">
      <Sidebar lang={lang} items={items} managementLinks={managementLinks} onBackToTasks={onBackToTasks} open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="dept-shell-right">
        <AppHeader
          moreLabel={t("moreActions", lang)}
          leading={(
            <button type="button" className="dept-sidebar-toggle" onClick={() => setMenuOpen((o) => !o)} aria-label={menuOpen ? t("closeMenu", lang) : t("openMenu", lang)} aria-expanded={menuOpen}>
              <span aria-hidden="true">{menuOpen ? "✕" : "☰"}</span>
            </button>
          )}
          primary={<ChatNavButton />}
          secondary={[
            { key: "refresh", icon: "🔄", label: t("refresh", lang), iconOnly: true, onClick: () => window.location.reload() },
            { key: "back", icon: "⬅", label: t("backToTasks", lang), keepOnMobile: true, onClick: onBackToTasks },
            { key: "logout", label: t("logout", lang), onClick: onLogout },
          ]}
        />
        <main className={`dept-main${flush ? " dept-main-flush" : ""}`}>
          {!flush && <NotificationPrompt lang={lang} />}
          {managementBadge && !flush && <ManagementBadge />}
          {children}
        </main>
      </div>
    </div>
  );
}
