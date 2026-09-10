import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";

const CHECK_KEYS = ["openingChecklist", "closingChecklist", "cleanlinessCheck", "safetyCheck"];

// Store Operations — retail_store_ops_logs, one row per location per day
// (unique constraint), checklist stored as jsonb since the exact checklist
// items aren't finalized yet — adding/removing an item never needs a
// migration.
export default function RetailStoreOps({ lang, profile, lookups }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [locations, setLocations] = useState([]);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ location_id: profile.home_location_id || "", notes: "", checklist: {} });

  const retailDept = useMemo(() => lookups.departments.find((d) => d.code === "RETAIL"), [lookups.departments]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [logsRes, locRes] = await Promise.all([
      supabase.from("retail_store_ops_logs").select("*").eq("is_active", true).order("log_date", { ascending: false }).limit(60),
      supabase.from("locations").select("id, name_en, name_gu").eq("is_active", true),
    ]);
    if (logsRes.error || locRes.error) { setError(true); setLoading(false); return; }
    setRows(logsRes.data || []);
    setLocations(locRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function toggleCheck(key) {
    setForm((f) => ({ ...f, checklist: { ...f.checklist, [key]: !f.checklist[key] } }));
  }

  async function submitLog(e) {
    e.preventDefault();
    if (!form.location_id || !retailDept) return;
    setSaving(true);
    const { error: err } = await supabase.from("retail_store_ops_logs").upsert({
      department_id: retailDept.id,
      location_id: form.location_id,
      log_date: new Date().toISOString().slice(0, 10),
      checklist: form.checklist,
      notes: form.notes || null,
    }, { onConflict: "location_id,log_date" });
    setSaving(false);
    if (err) { setError(true); return; }
    setForm((f) => ({ ...f, notes: "", checklist: {} }));
    load();
  }

  const locName = (id) => locations.find((l) => l.id === id)?.[lang === "gu" ? "name_gu" : "name_en"] || "—";

  if (loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 60 }} /><div className="skeleton-block" style={{ height: 220 }} /></div>;
  if (error) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">{t("loadErrorRetry", lang)}</div>
        <button className="btn btn-primary" onClick={load}>{t("retry", lang)}</button>
      </div>
    );
  }

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🏬</div>
        <div className="dept-header-text"><h1>{t("retailStoreOpsTitle", lang)}</h1></div>
      </div>

      <div className="card">
        <form onSubmit={submitLog} className="form-grid">
          <div className="field full">
            <label>{t("colLocation", lang)} *</label>
            <select value={form.location_id} onChange={(e) => setForm((f) => ({ ...f, location_id: e.target.value }))} required>
              <option value="" disabled>—</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{lang === "gu" ? l.name_gu : l.name_en}</option>)}
            </select>
          </div>
          <div className="field full">
            {CHECK_KEYS.map((key) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <input type="checkbox" checked={!!form.checklist[key]} onChange={() => toggleCheck(key)} />
                {t(key, lang)}
              </label>
            ))}
          </div>
          <div className="field full">
            <label>{t("notesLabel", lang)}</label>
            <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </div>
          <div className="field full">
            <button className="btn btn-primary" type="submit" disabled={saving}>{t("submitLog", lang)}</button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>{t("logDateLabel", lang)}</h2>
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
            <span>{r.log_date} — {locName(r.location_id)}</span>
            <span>{Object.values(r.checklist || {}).filter(Boolean).length}/{CHECK_KEYS.length}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
