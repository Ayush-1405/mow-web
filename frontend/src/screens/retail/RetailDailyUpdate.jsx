import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { supabase } from "../../lib/supabase";
import { recordDailyUpdate } from "../../lib/retailApi";

const todayStr = () => new Date().toISOString().slice(0, 10);

// Daily Updates — retail_record_daily_update() (mvp_pilot_retail_workflow_v2_93b.sql). The measurable counters (walk-ins, follow-ups,
// quotations, orders, sales value, collection) are NEVER hand-typed: the RPC computes them itself from today's real retail_leads /
// retail_followups / retail_quotations / retail_orders / retail_payments rows for the caller. Only the four free-text fields below are
// hand-entered. One row per employee per store per day (unique constraint) — submitting again the same day updates that same row.
export default function RetailDailyUpdate({ lang }) {
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState("");
  const [form, setForm] = useState({ displayUpdateNote: "", deliveryCoordinationNote: "", problems: "", tomorrowPriority: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    supabase.from("locations").select("id, name_en, name_gu").eq("is_active", true).in("type", ["showroom", "godown"]).order("name_en")
      .then(({ data }) => setLocations(data || []));
  }, []);

  const loadHistory = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error: err } = await supabase.from("retail_daily_updates").select("*").eq("employee_id", user?.id)
      .order("update_date", { ascending: false }).limit(14);
    if (err) { setError(true); return; }
    setError(false);
    setHistory(data || []);
    const today = (data || []).find((r) => r.update_date === todayStr());
    if (today) setSaved(today);
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    const { data, error: err } = await recordDailyUpdate(locationId || null, form);
    setSaving(false);
    if (err) { setError(true); return; }
    setError(false);
    setSaved(data);
    loadHistory();
  }

  if (error && history === null) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">{t("loadErrorRetry", lang)}</div>
        <button className="btn btn-primary" onClick={loadHistory}>{t("retry", lang)}</button>
      </div>
    );
  }

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📝</div>
        <div className="dept-header-text"><h1>{t("retailDailyUpdateTitle", lang)}</h1></div>
      </div>

      {saved && (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>{t("todaysCountersLabel", lang)}</div>
          <div className="task-meta" style={{ gap: 10, flexWrap: "wrap" }}>
            <span className="fx-tag gold">{t("kpiWalkinsToday", lang)}: {saved.walkins_count}</span>
            <span className="fx-tag gold">{t("recordFollowUpAction", lang)}: {saved.followups_count}</span>
            <span className="fx-tag gold">{t("createQuotationAction", lang)}: {saved.quotations_count}</span>
            <span className="fx-tag gold">{t("createOrderAction", lang)}: {saved.orders_count}</span>
            <span className="fx-tag gold">{t("salesValueLabel", lang)}: ₹{Number(saved.sales_value || 0).toLocaleString("en-IN")}</span>
            <span className="fx-tag gold">{t("collectionLabel", lang)}: ₹{Number(saved.collection_amount || 0).toLocaleString("en-IN")}</span>
          </div>
          <div className="msg info" style={{ marginTop: 8 }}>{t("countersAutoComputedMsg", lang)}</div>
        </div>
      )}

      <div className="card">
        <form onSubmit={submit} className="form-grid">
          <div className="field">
            <label>{t("storeLocationLabel", lang)}</label>
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">—</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{lang === "gu" ? l.name_gu : l.name_en}</option>)}
            </select>
          </div>
          <div className="field full"><label>{t("displayUpdateNoteLabel", lang)}</label><textarea rows={2} value={form.displayUpdateNote} onChange={(e) => set("displayUpdateNote", e.target.value)} /></div>
          <div className="field full"><label>{t("deliveryCoordinationNoteLabel", lang)}</label><textarea rows={2} value={form.deliveryCoordinationNote} onChange={(e) => set("deliveryCoordinationNote", e.target.value)} /></div>
          <div className="field full"><label>{t("problemsLabel", lang)}</label><textarea rows={2} value={form.problems} onChange={(e) => set("problems", e.target.value)} /></div>
          <div className="field full"><label>{t("tomorrowPriorityLabel", lang)}</label><textarea rows={2} value={form.tomorrowPriority} onChange={(e) => set("tomorrowPriority", e.target.value)} /></div>
          <div className="field full"><label>{t("notesLabel", lang)}</label><textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} /></div>
          {error && <div className="msg error field full" role="alert">{t("loadErrorRetry", lang)}</div>}
          <div className="field full"><button className="btn btn-primary" type="submit" disabled={saving}>{saving && <span className="spinner" />}{saved ? t("updateAction", lang) : t("submitDailyUpdateAction", lang)}</button></div>
        </form>
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>{t("recentUpdatesLabel", lang)}</div>
        {history === null && <div className="msg info">…</div>}
        {history !== null && history.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {history?.map((h) => (
          <div key={h.id} className="task-meta" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
            <div style={{ fontWeight: 600 }}>{h.update_date}</div>
            <div className="sub">{h.walkins_count} 🚶 · {h.followups_count} 📞 · {h.quotations_count} 📃 · {h.orders_count} 📦 · ₹{Number(h.sales_value || 0).toLocaleString("en-IN")}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
