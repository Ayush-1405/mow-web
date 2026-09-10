import React, { useState } from "react";
import { NavLink } from "react-router-dom";
import { t } from "../lib/i18n";

// Mood of Wood — Staff Pilot — department sidebar.
//
// `items` is already filtered to ONLY the departments the current user is
// authorized for (see useCurrentUserAccess in lib/access.js) and already
// ordered with Management Control Tower first — this component never
// decides who sees what, it only renders what it is given. That filtering
// happens after profile+lookups have both finished loading (App.jsx already
// gates the whole authenticated shell on that), so there is no moment where
// an item can flash and then disappear.
export default function Sidebar({ lang, items, managementLinks, onBackToTasks }) {
  const [open, setOpen] = useState(false);

  function close() {
    setOpen(false);
  }

  return (
    <>
      <div className="dept-topbar">
        <button
          className="dept-sidebar-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? t("closeMenu", lang) : t("openMenu", lang)}
          aria-expanded={open}
        >
          <span aria-hidden="true">{open ? "✕" : "☰"}</span>
        </button>
        <div className="dept-topbar-title">{t("departmentsNav", lang)}</div>
      </div>

      {open && <div className="dept-sidebar-backdrop" onClick={close} />}

      <nav className={`dept-sidebar${open ? " open" : ""}`} aria-label={t("departmentsNav", lang)}>
        <div className="dept-sidebar-heading">{t("departmentsNav", lang)}</div>
        <ul className="dept-nav-list">
          {items.map((dept) => (
            <React.Fragment key={dept.id}>
              <li>
                <NavLink
                  to={dept.route}
                  onClick={close}
                  className={({ isActive }) => `dept-nav-item${isActive ? " active" : ""}${dept.is_control_tower ? " control-tower" : ""}`}
                >
                  <span className="dept-nav-icon" aria-hidden="true">{dept.icon}</span>
                  <span className="dept-nav-label">
                    <span className="dept-nav-en">{dept.name_en}</span>
                    <span className="dept-nav-gu">{dept.name_gu}</span>
                  </span>
                  {dept.is_confidential_domain && (
                    <span className="restricted-tag" title={t("restrictedBadge", lang)}>🔒</span>
                  )}
                </NavLink>
              </li>
              {dept.is_control_tower && managementLinks?.map((link) => (
                <li key={link.route}>
                  <NavLink
                    to={link.route}
                    onClick={close}
                    className={({ isActive }) => `dept-nav-item mgmt-tool${isActive ? " active" : ""}`}
                  >
                    <span className="dept-nav-icon" aria-hidden="true">{link.icon}</span>
                    <span className="dept-nav-label">
                      <span className="dept-nav-en">{link.name_en}</span>
                      <span className="dept-nav-gu">{link.name_gu}</span>
                    </span>
                  </NavLink>
                </li>
              ))}
            </React.Fragment>
          ))}
        </ul>
        <button className="dept-sidebar-back" onClick={() => { close(); onBackToTasks(); }}>
          <span aria-hidden="true">⬅</span> {t("backToTasks", lang)}
        </button>
      </nav>
    </>
  );
}
