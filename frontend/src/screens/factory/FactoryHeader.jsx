import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";

// Simple header: title, factory/location, who is logged in and their role,
// notifications, refresh. A location selector appears only when the user
// can see more than one factory location.
//
// The horizontal Factory nav row (Home/New Orders/Job Cards/My Work/Material Required/QC/Ready for Dispatch/
// Completed/Reports/...) that used to render here is removed -- every one of those destinations is still a
// real, working route; they're just no longer duplicated in a second nav bar on every Factory page. They stay
// reachable via the Factory Dashboard's own segment cards/actions, each segment page's own actions, direct
// URLs, and notifications/linked records, same as the rest of the app.
export default function FactoryHeader({ lang, profile, title, onRefresh, refreshing, locations = [], location, onLocation }) {
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
    </div>
  );
}
