import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { formatCurrency } from "../../lib/retailModules";

// Sales Targets — retail_sales_targets. Write is restricted server-side
// (RLS) to Management/Retail Head; a plain member gets a working read-only
// list of the SAME rows rather than a disabled form pretending to work.
export default function RetailTargets({ lang, profile, lookups }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [locations, setLocations] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ location_id: "", period_start: "", period_end: "", target_amount: "" });

  const retailDept = useMemo(() => lookups.departments.find((d) => d.code === "RETAIL"), [lookups.departments]);
  const canWrite = profile.isManagement || profile.isDeptHead;

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [targetsRes, locRes] = await Promise.all([
      supabase.from("retail_sales_targets").select("*").eq("is_active", true).order("period_start", { ascending: false }).limit(100),
      supabase.from("locations").select("id, name_en, name_gu").eq("is_active", true),
    ]);
    if (targetsRes.error || locRes.error) { setError(true); setLoading(false); return; }
    setRows(targetsRes.data || []);
    setLocations(locRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleAdd(e) {
    e.preventDefault();
    if (!form.period_start || !form.period_end || !form.target_amount || !retailDept) return;
    setSaving(true);
    const { error: err } = await supabase.from("retail_sales_targets").insert({
      department_id: retailDept.id,
      location_id: form.location_id || null,
      period_start: form.period_start,
      period_end: form.period_end,
      target_amount: Number(form.target_amount),
    });
    setSaving(false);
    if (err) { setError(true); return; }
    setForm({ location_id: "", period_start: "", period_end: "", target_amount: "" });
    setShowForm(false);
    load();
  }

  const locName = (id) => (id ? locations.find((l) => l.id === id)?.[lang === "gu" ? "name_gu" : "name_en"] || "—" : t("allLocations", lang));

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
        <div className="dept-header-icon" aria-hidden="true">🎯</div>
        <div className="dept-header-text"><h1>{t("retailTargetsTitle", lang)}</h1></div>
      </div>

      {!canWrite && <div className="msg info">{t("readOnlyTargets", lang)}</div>}

      {canWrite && (
        <div className="card">
          <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>{showForm ? t("cancel", lang) : t("addTarget", lang)}</button>
          {showForm && (
            <form onSubmit={handleAdd} className="form-grid" style={{ marginTop: 12 }}>
              <div className="field">
                <label>{t("colLocation", lang)}</label>
                <select value={form.location_id} onChange={(e) => setForm((f) => ({ ...f, location_id: e.target.value }))}>
                  <option value="">{t("allLocations", lang)}</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{lang === "gu" ? l.name_gu : l.name_en}</option>)}
                </select>
              </div>
              <div className="field">
                <label>{t("periodStartLabel", lang)} *</label>
                <input type="date" value={form.period_start} onChange={(e) => setForm((f) => ({ ...f, period_start: e.target.value }))} required />
              </div>
              <div className="field">
                <label>{t("periodEndLabel", lang)} *</label>
                <input type="date" value={form.period_end} onChange={(e) => setForm((f) => ({ ...f, period_end: e.target.value }))} required />
              </div>
              <div className="field">
                <label>{t("targetAmountLabel", lang)} *</label>
                <input type="number" min="0" value={form.target_amount} onChange={(e) => setForm((f) => ({ ...f, target_amount: e.target.value }))} required />
              </div>
              <div className="field full">
                <button className="btn btn-primary" type="submit" disabled={saving}>{t("save", lang)}</button>
              </div>
            </form>
          )}
        </div>
      )}

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
            <span>{locName(r.location_id)} · {r.period_start} → {r.period_end}</span>
            <span>{formatCurrency(r.target_amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
