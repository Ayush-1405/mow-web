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
    // A legacy Reply notification: Replies now live in Chat, so it resolves to the migrated message (server-checked access)
    case "task_message": return n.task_id ? `/chat?legacy_message=${n.entity_id}&legacy_task=${n.task_id}` : `/chat?legacy_message=${n.entity_id}`;
    case "project": return `/interior-projects/detail/${n.entity_id}`;
    case "snag": return "/interior-projects/site-execution";
    case "interior_task": return "/interior-projects/tasks";
    case "site_report": return "/interior-projects/daily-updates";
    case "retail_lead": return "/retail/leads";
    case "retail_complaint": return "/retail/complaints";
    case "retail_vm_task": return "/retail/display";
    case "FACTORY_AI_REQUEST": return "/factory-requests";
    case "FACTORY_JOB": return `/factory-job/${n.entity_id}`;
    // a Chat notification opens the conversation; for a project chat it also carries the task the message was about (task context / filter)
    case "CHAT": return n.task_id ? `/chat?c=${n.entity_id}&task=${n.task_id}` : `/chat?c=${n.entity_id}`;
    default: return null;
  }
}

// Module grouping for the filter chips. Anything unrecognised still shows
// under "All" (and "Other"), so a new notification type is never hidden.
const GROUPS = {
  tasks: ["task", "task_message"],
  interior: ["project", "snag", "interior_task", "site_report"],
  retail: ["retail_lead", "retail_complaint", "retail_vm_task"],
  factory: ["FACTORY_AI_REQUEST", "FACTORY_JOB"],
  chat: ["CHAT"],
  reminders: ["daily_reminder"],
};
const FILTERS = [
  ["all", "All"], ["unread", "Unread"], ["tasks", "Tasks"], ["interior", "Interior"],
  ["retail", "Retail"], ["factory", "Factory"], ["reminders", "Reminders"], ["other", "Other"],
];
const KNOWN = new Set(Object.values(GROUPS).flat());
function matchesFilter(n, f) {
  if (f === "all") return true;
  if (f === "unread") return !n.is_read;
  if (f === "other") return !KNOWN.has(n.entity_type);
  return (GROUPS[f] || []).includes(n.entity_type);
}

const PAGE_SIZE = 20;

export default function Notifications({ lang, showToast }) {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [filter, setFilter] = useState("all");
  const [markingAll, setMarkingAll] = useState(false);

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

  async function markAllRead() {
    setMarkingAll(true);
    const { error } = await supabase.rpc("staff_mark_all_notifications_read");
    setMarkingAll(false);
    if (error) { showToast("error", error.message); return; }
    setItems((cur) => cur.map((n) => (n.is_read ? n : { ...n, is_read: true, read_at: new Date().toISOString() })));
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
      <div className="btn-row" style={{ marginBottom: 10 }}>
        <button className="btn btn-outline" onClick={load} disabled={loading}>
          {t("refresh", lang)}
        </button>
        <button className="btn btn-outline" onClick={markAllRead} disabled={markingAll || !items.some((n) => !n.is_read)}>
          {markingAll ? "…" : "Mark all read"}
        </button>
      </div>
      <div className="filter-bar" style={{ flexWrap: "wrap", marginBottom: 10 }}>
        {FILTERS.map(([k, label]) => (
          <button key={k} type="button" className={`btn ${filter === k ? "btn-primary" : "btn-outline"}`} style={{ marginTop: 0, width: "auto" }} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="card" style={{ padding: 0 }}>
        {!loading && items.length === 0 && <div className="msg info" style={{ margin: 12 }}>{t("noNotifications", lang)}</div>}
        {!loading && items.length > 0 && !items.some((n) => matchesFilter(n, filter)) && (
          <div className="msg info" style={{ margin: 12 }}>Nothing in this filter{hasMore ? " among the loaded notifications — try Load More" : ""}.</div>
        )}
        {items.filter((n) => matchesFilter(n, filter)).map((n) => {
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
