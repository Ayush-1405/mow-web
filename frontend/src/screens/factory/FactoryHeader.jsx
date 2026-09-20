import React, { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";

// Phase 1 Factory navigation: six items only. "Completed" is hidden on the
// smallest phones (it is one tap away as the Completed filter in Job Cards),
// so the mobile bar never exceeds five.
const NAV = [
  ["/factory", { en: "Dashboard", gu: "ડેશબોર્ડ" }, true, ""],
  ["/factory/inbox", { en: "Factory Inbox", gu: "ફેક્ટરી ઇનબોક્સ" }, false, ""],
  ["/factory/job-cards", { en: "Job Cards", gu: "જોબ કાર્ડ" }, false, ""],
  ["/factory/my-tasks", { en: "My Tasks", gu: "મારા કાર્યો" }, false, ""],
  ["/factory/completed", { en: "Completed", gu: "પૂર્ણ" }, false, "fx-hide-sm"],
  ["/factory/master-report", { en: "Reports", gu: "રિપોર્ટ" }, false, ""],
];

export function FactoryNav({ lang }) {
  return (
    <nav className="fx-nav" aria-label="Factory">
      {NAV.map(([to, lbl, end, cls]) => (
        <NavLink key={to} to={to} end={end} className={({ isActive }) => `${cls}${isActive ? " active" : ""}`}>
          {lang === "gu" ? lbl.gu : lbl.en}
        </NavLink>
      ))}
    </nav>
  );
}

// Simple header: title, factory/location, who is logged in and their role,
// notifications, refresh. A location selector appears only when the user
// can see more than one factory location.
export default function FactoryHeader({ lang, profile, title, onRefresh, refreshing, locations = [], location, onLocation, showNav = true }) {
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let active = true;
    supabase.from("notifications").select("id", { count: "exact", head: true }).eq("is_read", false)
      .then(({ count }) => { if (active) setUnread(count || 0); });
    return () => { active = false; };
  }, []);

  const roleName = lang === "gu" ? profile?.roles?.name_gu : profile?.roles?.name_en;
  const locName = locations.length === 1 ? locations[0].name : locations.find((l) => l.id === location)?.name;

  return (
    <div className="fx-head">
      <div className="fx-head-top">
        <div>
          <h1>{title}</h1>
          <div className="fx-sub">
            {locName ? `${locName} · ` : ""}{profile?.full_name || "—"}{roleName ? ` · ${roleName}` : ""}
          </div>
        </div>
        <div className="fx-head-tools">
          {locations.length > 1 && (
            <select className="fx-select" value={location || ""} onChange={(e) => onLocation?.(e.target.value || null)} aria-label="Factory">
              <option value="">{lang === "gu" ? "બધા સ્થળ" : "All locations"}</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          )}
          <button type="button" className="fx-icon-btn" onClick={() => navigate("/notifications")} aria-label="Notifications" title="Notifications">
            🔔{unread > 0 && <span className="dot">{unread > 9 ? "9+" : unread}</span>}
          </button>
          {onRefresh && (
            <button type="button" className="fx-icon-btn" onClick={onRefresh} disabled={refreshing} aria-label="Refresh" title="Refresh">🔄</button>
          )}
        </div>
      </div>
      {showNav && <FactoryNav lang={lang} />}
    </div>
  );
}
