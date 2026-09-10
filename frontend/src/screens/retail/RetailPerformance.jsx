import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { downloadCsv } from "../../lib/csv";
import { formatCurrency } from "../../lib/retailModules";

// Sales Performance — no table of its own; computed from retail_orders +
// retail_sales_targets, following the same reporting pattern as
// screens/Reports.jsx (KPI tiles + a simple bar comparison + CSV export).
export default function RetailPerformance({ lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [orders, setOrders] = useState([]);
  const [targets, setTargets] = useState([]);
  const [locations, setLocations] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [ordersRes, targetsRes, locRes] = await Promise.all([
      supabase.from("retail_orders").select("*").eq("is_active", true).neq("status", "CANCELLED").limit(1000),
      supabase.from("retail_sales_targets").select("*").eq("is_active", true).limit(200),
      supabase.from("locations").select("id, name_en, name_gu").eq("is_active", true),
    ]);
    if (ordersRes.error || targetsRes.error || locRes.error) { setError(true); setLoading(false); return; }
    setOrders(ordersRes.data || []);
    setTargets(targetsRes.data || []);
    setLocations(locRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const locName = useCallback((id) => {
    if (!id) return t("allLocations", lang);
    const loc = locations.find((l) => l.id === id);
    return loc?.[lang === "gu" ? "name_gu" : "name_en"] || "—";
  }, [locations, lang]);

  const rows = useMemo(() => targets.map((tgt) => {
    const achieved = orders
      .filter((o) => {
        if (tgt.location_id && o.location_id !== tgt.location_id) return false;
        const created = (o.created_at || "").slice(0, 10);
        return created >= tgt.period_start && created <= tgt.period_end;
      })
      .reduce((sum, o) => sum + Number(o.total_amount || 0), 0);
    const pct = tgt.target_amount > 0 ? Math.round((achieved / tgt.target_amount) * 100) : 0;
    return { id: tgt.id, label: `${locName(tgt.location_id)} (${tgt.period_start} → ${tgt.period_end})`, target: Number(tgt.target_amount), achieved, pct };
  }).sort((a, b) => b.achieved - a.achieved), [targets, orders, locName]);

  const totalOrders = orders.length;
  const totalRevenue = orders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0);

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
        <div className="dept-header-icon" aria-hidden="true">📈</div>
        <div className="dept-header-text"><h1>{t("retailPerformanceTitle", lang)}</h1></div>
      </div>

      <div className="kpi-grid">
        <div className="kpi-tile"><div className="num">{totalOrders}</div><div className="label">{t("colTotal", lang)}</div></div>
        <div className="kpi-tile gold"><div className="num">{formatCurrency(totalRevenue)}</div><div className="label">{t("totalAmountLabel", lang)}</div></div>
      </div>

      <div className="card">
        <div className="report-card-header">
          <h2>{t("achievedVsTarget", lang)}</h2>
          <button
            className="btn btn-outline"
            style={{ marginTop: 0, width: "auto" }}
            disabled={rows.length === 0}
            onClick={() => downloadCsv(
              "sales-performance.csv",
              ["Target", "Achieved", "Target Amount", "% Achieved"],
              rows.map((r) => [r.label, r.achieved, r.target, r.pct]),
            )}
          >
            ⬇ {t("downloadCsv", lang)}
          </button>
        </div>
        {rows.length === 0 && <div className="msg info">{t("noReportData", lang)}</div>}
        <div className="bar-chart">
          {rows.map((r) => (
            <div className="bar-row" key={r.id}>
              <span className="bar-row-label" title={r.label}>{r.label}</span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${Math.min(100, r.pct)}%`, background: r.pct >= 100 ? "var(--success)" : "var(--brand)" }} />
              </span>
              <span className="bar-row-value">{r.pct}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
