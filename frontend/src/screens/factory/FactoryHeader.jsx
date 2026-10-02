import React, { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";

// Phase 1 simplification: nine large, icon-led primary destinations -- Home / New Orders / Job Cards / My Work /
// Material Required / QC / Ready for Dispatch / Completed / Reports -- replacing the previous Dashboard/Inbox/
// Job Cards/Tasks/Overview/Completed/Reports set. "Overview" (a Head/Management-only deep-dive screen) now only
// shows for a leader, same as before; everything else is a real, already-working destination, several reusing
// the status/stage filters built for the Dashboard's own cards rather than new screens.
const NAV = [
  ["/factory", { en: "🏠 Home", gu: "🏠 હોમ" }, true, ""],
  ["/factory/inbox?tab=new", { en: "📥 New Orders", gu: "📥 નવા ઓર્ડર" }, false, ""],
  ["/factory/job-cards", { en: "📋 Job Cards", gu: "📋 જોબ કાર્ડ" }, false, ""],
  ["/factory/my-work", { en: "👷 My Work", gu: "👷 મારું કામ" }, false, ""],
  ["/factory/material-orders", { en: "📦 Material Required", gu: "📦 મટિરિયલ" }, false, ""],
  ["/factory/job-cards?status=in_production&stage=QC", { en: "✅ QC", gu: "✅ QC" }, false, ""],
  ["/factory/job-cards?status=ready_for_review", { en: "🚚 Ready for Dispatch", gu: "🚚 ડિસ્પેચ" }, false, "fx-hide-sm"],
  ["/factory/completed", { en: "🏁 Completed", gu: "🏁 પૂર્ણ" }, false, "fx-hide-sm"],
  ["/factory/master-report", { en: "📊 Reports", gu: "📊 રિપોર્ટ" }, false, ""],
  ["/factory/po-verification", { en: "🔍 Verify POs", gu: "🔍 PO ચકાસણી" }, false, "fx-hide-sm", "leader"],
  ["/factory/overview", { en: "Overview", gu: "ઓવરવ્યુ" }, false, "fx-hide-sm", "leader"],
];

export function FactoryNav({ lang, leader = false }) {
  return (
    <nav className="fx-nav" aria-label="Factory">
      {NAV.filter((n) => n[4] !== "leader" || leader).map(([to, lbl, end, cls]) => (
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
      {showNav && <FactoryNav lang={lang} leader={!!(profile?.permissions?.hasGlobalOversight || profile?.permissions?.isDepartmentHead || profile?.permissions?.isSupervisor)} />}
    </div>
  );
}
