import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { t } from "../lib/i18n";

// entity_type -> where clicking a notification should land. staff_tasks
// notifications ("task") deep-link straight to that task via TodayTasks'
// own ?focus= param (see the useEffect there); "project" similarly
// pre-selects the right project in InteriorTimeline. The others land on
// the relevant list screen without a specific-row deep link — the
// underlying screens don't currently support focusing one row, and
// building that per screen is more than this needed. Unrecognized/legacy
// entity_types (e.g. "daily_reminder", whose entity_id is the recipient's
// own id, not a real record) fall through to null — not clickable.
function routeFor(n) {
  switch (n.entity_type) {
    case "task": return `/tasks?focus=${n.entity_id}`;
    case "project": return `/interior-projects/detail/${n.entity_id}`;
    case "snag": return "/interior-projects/site-execution";
    case "interior_task": return "/interior-projects/tasks";
    case "site_report": return "/interior-projects/daily-updates";
    case "retail_lead": return "/retail/leads";
    case "retail_complaint": return "/retail/complaints";
    case "retail_vm_task": return "/retail/display";
    default: return null;
  }
}

export default function Notifications({ lang, showToast }) {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) showToast("error", error.message);
    else setItems(data || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  // Live updates: a new notification (recipient_id scoped by RLS to the
  // current user) prepends immediately instead of waiting for a manual
  // Refresh or a tab switch.
  useEffect(() => {
    const channel = supabase
      .channel("notifications_screen")
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  async function markRead(id) {
    const { error } = await supabase.rpc("staff_mark_notification_read", { p_notification_id: id });
    if (error) showToast("error", error.message);
    else load();
  }

  function openNotification(n) {
    const route = routeFor(n);
    if (!route) return;
    if (!n.is_read) markRead(n.id);
    navigate(route);
  }

  return (
    <div>
      <div className="section-title">{t("notifications", lang)}</div>
      <button className="btn btn-outline" style={{ marginBottom: 10 }} onClick={load} disabled={loading}>
        {t("refresh", lang)}
      </button>
      <div className="card" style={{ padding: 0 }}>
        {!loading && items.length === 0 && <div className="msg info" style={{ margin: 12 }}>{t("noNotifications", lang)}</div>}
        {items.map((n) => {
          const route = routeFor(n);
          return (
            <div
              className={`notif-row ${n.is_read ? "" : "unread"}${route ? " clickable" : ""}`}
              key={n.id}
              role={route ? "button" : undefined}
              tabIndex={route ? 0 : undefined}
              onClick={route ? () => openNotification(n) : undefined}
              onKeyDown={route ? (e) => { if (e.key === "Enter") openNotification(n); } : undefined}
            >
              <div>
                <div className="n-title">{lang === "gu" ? n.title_gu : n.title_en}</div>
                <div className="n-time">{new Date(n.created_at).toLocaleString()}</div>
              </div>
              {!n.is_read && (
                <button
                  className="btn btn-outline"
                  style={{ width: "auto", margin: 0, minHeight: 36, padding: "6px 10px" }}
                  onClick={(e) => { e.stopPropagation(); markRead(n.id); }}
                >
                  {t("markRead", lang)}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
