import React, { useEffect, useState, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { t } from "../lib/i18n";

export default function Notifications({ lang, showToast }) {
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

  return (
    <div>
      <div className="section-title">{t("notifications", lang)}</div>
      <button className="btn btn-outline" style={{ marginBottom: 10 }} onClick={load} disabled={loading}>
        {t("refresh", lang)}
      </button>
      <div className="card" style={{ padding: 0 }}>
        {!loading && items.length === 0 && <div className="msg info" style={{ margin: 12 }}>{t("noNotifications", lang)}</div>}
        {items.map((n) => (
          <div className={`notif-row ${n.is_read ? "" : "unread"}`} key={n.id}>
            <div>
              <div className="n-title">{lang === "gu" ? n.title_gu : n.title_en}</div>
              <div className="n-time">{new Date(n.created_at).toLocaleString()}</div>
            </div>
            {!n.is_read && (
              <button className="btn btn-outline" style={{ width: "auto", margin: 0, minHeight: 36, padding: "6px 10px" }} onClick={() => markRead(n.id)}>
                {t("markRead", lang)}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
