import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../../lib/i18n";
import { loadReportsSummary, loadSalespersonReport, loadPipelineReport, loadOwnershipReport } from "../../lib/retailApi";
import { formatCurrency } from "../../lib/retailModules";

const todayStr = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// Reports — retail_reports_summary() (mvp_pilot_retail_workflow_v2_93e.sql). Every tile is a live COUNT/SUM over the same RLS-scoped
// tables every other Retail screen reads, for the caller's own date range — never a static demo number. Each tile is clickable through to
// the real list screen behind it (spec's "click into a number to see the underlying records" requirement), scoped down to what this app
// already has screens for; no charting library exists in this project, so this is a stat-tile report, not a chart dashboard.
const TILES = [
  ["walkins_total", "🚶", "reportsWalkinsTotal", "/retail/leads", false],
  ["leads_won", "🏆", "reportsLeadsWon", "/retail/leads", false],
  ["leads_lost", "📉", "reportsLeadsLost", "/retail/leads", false],
  ["followups_overdue", "⏰", "reportsFollowupsOverdue", "/retail/leads?filter=overdue", false],
  ["quotations_total", "📃", "reportsQuotationsTotal", "/retail/quotations", false],
  ["quotations_accepted", "✅", "reportsQuotationsAccepted", "/retail/quotations", false],
  ["orders_total", "📦", "reportsOrdersTotal", "/retail/orders", false],
  ["orders_value", "💰", "reportsOrdersValue", "/retail/orders", true],
  ["orders_confirmed_value", "✔️", "reportsConfirmedValue", "/retail/orders", true],
  ["pending_collection", "🧾", "reportsPendingCollection", "/retail/orders", true],
  ["factory_linked_orders", "🏭", "reportsFactoryLinked", "/factory/tasks", false],
  ["outsource_linked_orders", "🛒", "reportsOutsourceLinked", "/retail/orders", false],
  ["deliveries_completed", "🚚", "reportsDeliveriesCompleted", "/retail/delivery", false],
  ["deliveries_delayed", "⚠️", "reportsDeliveriesDelayed", "/retail/delivery", false],
  ["display_updates_total", "🖼️", "reportsDisplayUpdates", "/retail/display", false],
];

// retail_salesperson_report() (v2_93k) — the caller's own portfolio by default (p_salesperson_id defaults to auth.uid() server-side).
const SALESPERSON_TILES = [
  ["owned_customers", "👤", "ownedCustomersLabel", false],
  ["new_customers", "🆕", "newCustomersLabel", false],
  ["customers_served", "🤝", "customersServedLabel", false],
  ["followups_due", "⏰", "followUpsDueLabel", false],
  ["followups_completed", "✅", "followUpsCompletedLabel", false],
  ["followups_overdue", "⚠️", "reportsFollowupsOverdue", false],
  ["quotations_total", "📃", "reportsQuotationsTotal", false],
  ["confirmed_orders", "📦", "confirmedOrdersLabel", false],
  ["order_value", "💰", "orderValueLabel", true],
  ["stock_orders", "🏬", "stockOrdersLabel", false],
  ["factory_orders", "🏭", "factoryOrdersLabel", false],
  ["outsource_orders", "🛒", "outsourceOrdersLabel", false],
  ["immediate_delivery_orders", "⚡", "fulfil_IMMEDIATE_DELIVERY", false],
  ["awaiting_product_photo", "📸", "awaitingProductPhotoStatusLabel", false],
  ["orders_packed", "📦", "ordersPackedLabel", false],
  ["orders_assigned_to_godown", "🏬", "ordersAssignedGodownLabel", false],
  ["deliveries_due", "🚚", "deliveriesDueLabel", false],
  ["deliveries_successful", "✅", "deliveriesSuccessfulLabel", false],
  ["deliveries_failed_or_partial", "⚠️", "deliveriesFailedPartialLabel", false],
  ["installations_pending", "🔧", "installationsPendingLabel", false],
  ["installations_completed", "🔧", "installationsCompletedLabel", false],
  ["complaints", "🗣️", "complaintsLabel", false],
  ["conversion_percent", "📈", "conversionPercentLabel", false, "%"],
  ["on_time_delivery_percent", "⏱️", "onTimeDeliveryPercentLabel", false, "%"],
];

// retail_pipeline_report() (v2_93k) — one real, filtered count (+value where relevant) per named pipeline stage; each tile is a
// drill-through into the screen that actually holds those records, same convention as the Summary tab above.
const PIPELINE_STAGES = [
  ["lead", "🧭", "/retail/leads"], ["followup", "📞", "/retail/leads"], ["quotation", "📃", "/retail/quotations"],
  ["confirmed", "✔️", "/retail/orders"], ["fulfilment_pending", "⏳", "/retail/orders"], ["factory", "🏭", "/factory/tasks"],
  ["procurement", "🛒", "/retail/orders"], ["stock_reserved", "🏬", "/retail/stock"],
  ["immediate_delivery", "⚡", "/retail/orders"], ["awaiting_product_photo", "📸", "/retail/orders"],
  ["packing", "📦", "/retail/packing"],
  ["godown", "🏬", "/retail/packing"], ["delivery_scheduled", "🗓️", "/retail/delivery"], ["dispatched", "🚚", "/retail/delivery"],
  ["delivered", "✅", "/retail/delivery"], ["installation", "🔧", "/retail/delivery"], ["completed", "🏁", "/retail/orders"],
  ["on_hold_or_delayed", "⚠️", "/retail/orders"],
];

const TABS = [["summary", "summaryTabLabel"], ["salesperson", "myPerformanceTabLabel"], ["pipeline", "pipelineTabLabel"], ["ownership", "ownershipTabLabel"]];

export default function RetailReports({ lang }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState("summary");
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(todayStr());
  const [data, setData] = useState(null);
  const [spData, setSpData] = useState(null);
  const [plData, setPlData] = useState(null);
  const [ownData, setOwnData] = useState(null);
  const [ownError, setOwnError] = useState(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (tab === "summary") {
      const { data: d, error: err } = await loadReportsSummary(from, to);
      if (err) { setError(true); return; }
      setError(false); setData(d || {});
    } else if (tab === "salesperson") {
      const { data: d, error: err } = await loadSalespersonReport(null, from, to);
      if (err) { setError(true); return; }
      setError(false); setSpData(d || {});
    } else if (tab === "pipeline") {
      const { data: d, error: err } = await loadPipelineReport(from, to);
      if (err) { setError(true); return; }
      setError(false); setPlData(d || {});
    } else if (tab === "ownership") {
      const { data: d, error: err } = await loadOwnershipReport();
      if (err) { setOwnError(err.message); return; }
      setOwnError(null); setOwnData(d || {});
    }
  }, [tab, from, to]);

  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">{t("loadErrorRetry", lang)}</div>
        <button className="btn btn-primary" onClick={load}>{t("retry", lang)}</button>
      </div>
    );
  }

  const sourceBreakdown = data?.leads_by_source && typeof data.leads_by_source === "object" ? Object.entries(data.leads_by_source) : [];

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📊</div>
        <div className="dept-header-text"><h1>{t("retailReportsTitle", lang)}</h1></div>
      </div>

      <div className="card task-meta" style={{ gap: 8, flexWrap: "wrap" }}>
        {TABS.map(([key, labelKey]) => (
          <button key={key} type="button" className={`btn ${tab === key ? "btn-primary" : "btn-outline"}`} onClick={() => setTab(key)}>{t(labelKey, lang)}</button>
        ))}
      </div>

      {tab !== "ownership" && (
        <div className="card filter-bar filter-grid">
          <div className="field"><label>{t("fromDateLabel", lang)}</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} max={to} /></div>
          <div className="field"><label>{t("toDateLabel", lang)}</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} min={from} max={todayStr()} /></div>
        </div>
      )}

      {tab === "summary" && (
        <>
          <div className="card">
            <div className="kpi-grid">
              {TILES.map(([key, icon, labelKey, route, isCurrency]) => (
                <button key={key} type="button" className="kpi-card" onClick={() => navigate(route)} disabled={!data}>
                  <span className="kpi-icon" aria-hidden="true">{icon}</span>
                  <span className="kpi-value">{data ? (isCurrency ? formatCurrency(data[key]) : (data[key] ?? 0)) : "…"}</span>
                  <span className="kpi-label">{t(labelKey, lang)}</span>
                </button>
              ))}
            </div>
          </div>

          {data?.avg_feedback_score != null && (
            <div className="card">
              <div className="section-title" style={{ marginTop: 0 }}>{t("customerSatisfactionLabel", lang)}</div>
              <div className="sub">{"⭐".repeat(Math.round(data.avg_feedback_score))} ({data.avg_feedback_score}/5)</div>
            </div>
          )}

          {sourceBreakdown.length > 0 && (
            <div className="card">
              <div className="section-title" style={{ marginTop: 0 }}>{t("leadsBySourceLabel", lang)}</div>
              <div className="task-meta" style={{ gap: 10, flexWrap: "wrap" }}>
                {sourceBreakdown.map(([src, n]) => <span key={src} className="fx-tag gold">{src}: {n}</span>)}
              </div>
            </div>
          )}
        </>
      )}

      {tab === "salesperson" && (
        <div className="card">
          <div className="kpi-grid">
            {SALESPERSON_TILES.map(([key, icon, labelKey, isCurrency, suffix]) => (
              <div key={key} className="kpi-card">
                <span className="kpi-icon" aria-hidden="true">{icon}</span>
                <span className="kpi-value">
                  {!spData ? "…" : isCurrency ? formatCurrency(spData[key]) : (spData[key] ?? (suffix ? "—" : 0))}{spData && spData[key] != null && suffix ? suffix : ""}
                </span>
                <span className="kpi-label">{t(labelKey, lang)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "pipeline" && (
        <div className="card">
          <div className="kpi-grid">
            {PIPELINE_STAGES.map(([key, icon, route]) => {
              const stage = plData?.[key];
              return (
                <button key={key} type="button" className="kpi-card" onClick={() => navigate(route)} disabled={!plData}>
                  <span className="kpi-icon" aria-hidden="true">{icon}</span>
                  <span className="kpi-value">{stage ? stage.count ?? 0 : "…"}</span>
                  {stage?.value != null && <span className="sub">{formatCurrency(stage.value)}</span>}
                  <span className="kpi-label">{t(`pipestage_${key}`, lang)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {tab === "ownership" && (
        <>
          {ownError && <div className="card"><div className="msg info">{t("managementOnlyMsg", lang)}</div></div>}
          {!ownError && (
            <>
              <div className="card">
                <div className="kpi-grid">
                  <div className="kpi-card"><span className="kpi-icon">🔁</span><span className="kpi-value">{ownData ? ownData.transferred_count ?? 0 : "…"}</span><span className="kpi-label">{t("transferredCountLabel", lang)}</span></div>
                  <div className="kpi-card"><span className="kpi-icon">🤝</span><span className="kpi-value">{ownData ? ownData.shared_backup_count ?? 0 : "…"}</span><span className="kpi-label">{t("sharedBackupCountLabel", lang)}</span></div>
                  <div className="kpi-card"><span className="kpi-icon">👁️</span><span className="kpi-value">{ownData ? ownData.readonly_shared_count ?? 0 : "…"}</span><span className="kpi-label">{t("readonlySharedCountLabel", lang)}</span></div>
                  <div className="kpi-card"><span className="kpi-icon">❓</span><span className="kpi-value">{ownData ? ownData.unassigned_customers ?? 0 : "…"}</span><span className="kpi-label">{t("unassignedCustomersLabel", lang)}</span></div>
                  <div className="kpi-card"><span className="kpi-icon">⚠️</span><span className="kpi-value">{ownData ? ownData.duplicate_alerts_open ?? 0 : "…"}</span><span className="kpi-label">{t("duplicateAlertsOpenLabel", lang)}</span></div>
                  <div className="kpi-card"><span className="kpi-icon">📅</span><span className="kpi-value">{ownData ? ownData.customers_without_future_followup ?? 0 : "…"}</span><span className="kpi-label">{t("customersWithoutFollowupLabel", lang)}</span></div>
                </div>
              </div>
              <div className="card">
                <div className="section-title" style={{ marginTop: 0 }}>{t("byOwnerLabel", lang)}</div>
                {(ownData?.by_owner || []).map((o) => (
                  <div key={o.owner_id || "unassigned"} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
                    <span>{o.owner_name || "—"}</span>
                    <span className="badge">{o.customer_count}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
