import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { t } from "../lib/i18n";
import { subscribeTable, upsertById } from "../lib/realtime";

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
    case "task_message": return n.task_id ? `/tasks?focus=${n.task_id}&message=${n.entity_id}` : null;
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

const PAGE_SIZE = 20;

export default function Notifications({ lang, showToast }) {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  // First page only, on demand — "Load More" fetches older pages rather
  // than the previous flat limit(100), so a long-lived account with
  // hundreds of accumulated notifications doesn't pay for all of them on
  // every screen open, and a realtime INSERT never has to re-fetch the
  // whole list (it prepends the one new row directly — see the realtime
  // effect below).
  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .range(0, PAGE_SIZE - 1);
    if (error) showToast("error", error.message);
    else {
      setItems(data || []);
      setHasMore((data || []).length === PAGE_SIZE);
    }
    setLoading(false);
  }, [showToast]);

  async function loadMore() {
    setLoadingMore(true);
    const { data, error } = await supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .range(items.length, items.length + PAGE_SIZE - 1);
    if (error) showToast("error", error.message);
    else {
      setItems((cur) => [...cur, ...(data || [])]);
      setHasMore((data || []).length === PAGE_SIZE);
    }
    setLoadingMore(false);
  }

  useEffect(() => {
    load();
  }, [load]);

  // Live updates: merge only the affected row (INSERT prepends, UPDATE
  // replaces in place) instead of refetching the whole page on every
  // event — a notification arriving for an unrelated reason (someone else
  // marking a DIFFERENT one of their own notifications read, in another
  // tab) never re-runs the full list query here.
  useEffect(() => {
    return subscribeTable("notifications_screen", "notifications", null, (payload) => {
      const row = payload.new;
      if (!row) return;
      setItems((cur) => upsertById(cur, row));
    });
  }, []);

  async function markRead(id) {
    const { error } = await supabase.rpc("staff_mark_notification_read", { p_notification_id: id });
    if (error) { showToast("error", error.message); return; }
    setItems((cur) => cur.map((n) => (n.id === id ? { ...n, is_read: true, read_at: new Date().toISOString() } : n)));
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
      {hasMore && (
        <button className="btn btn-outline" style={{ marginTop: 10 }} onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? "…" : t("loadMore", lang)}
        </button>
      )}
    </div>
  );
}
