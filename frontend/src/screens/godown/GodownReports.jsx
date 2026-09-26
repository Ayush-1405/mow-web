import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../../lib/i18n";
import { loadGodownReportsSummary } from "../../lib/retailApi";

// More / Reports — Head/Supervisor/Management only (retail_godown_reports_summary itself refuses anyone else).
// Every number here is live and, where a matching screen exists, clickable through to the real records behind it —
// never a static demo count.
export default function GodownReports({ lang }) {
  const navigate = useNavigate();
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    const { data, error: err } = await loadGodownReportsSummary();
    if (err) { setError(true); return; }
    setError(false);
    setSummary(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">{t("reportsRestrictedMsg", lang)}</div>
        <button className="btn btn-primary" onClick={load}>{t("retry", lang)}</button>
      </div>
    );
  }
  if (!summary) return <div className="dept-dashboard"><div className="msg info">…</div></div>;

  const tiles = [
    { key: "stock_received_today", label: "stockReceivedTodayLabel", route: "/godown/stock" },
    { key: "available_products", label: "availableProductsLabel", route: "/godown/stock" },
    { key: "new_delivery_requests", label: "newDeliveryRequestsLabel", route: "/godown/handovers" },
    { key: "packing_pending", label: "packingPendingLabel", route: "/godown/handovers" },
    { key: "deliveries_today", label: "deliveriesTodayLabel", route: "/dispatch/queue" },
    { key: "successful_deliveries_today", label: "successfulDeliveriesTodayLabel", route: "/dispatch/queue" },
    { key: "failed_or_delayed_deliveries", label: "failedOrDelayedDeliveriesLabel", route: "/dispatch/queue" },
    { key: "missing_photo_proof", label: "missingPhotoProofLabel", route: "/godown/handovers" },
    { key: "overdue_requests", label: "overdueRequestsLabel", route: "/godown/handovers" },
  ];

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📊</div>
        <div className="dept-header-text"><h1>{t("moreReportsTileLabel", lang)}</h1></div>
      </div>

      <div className="card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {tiles.map((tile) => (
          <button key={tile.key} type="button" className="btn btn-outline" style={{ display: "grid", gap: 4, minHeight: 72, textAlign: "center" }}
            onClick={() => navigate(tile.route)}>
            <span style={{ fontSize: 26, fontWeight: 800 }}>{summary[tile.key] ?? 0}</span>
            <span className="sub" style={{ fontSize: 13 }}>{t(tile.label, lang)}</span>
          </button>
        ))}
      </div>

      <div className="card">
        <h3>{t("categoryWiseStockLabel", lang)}</h3>
        {(summary.category_wise_stock || []).length === 0 && <div className="msg info">{t("noStockDataMsg", lang)}</div>}
        {(summary.category_wise_stock || []).map((c, i) => (
          <div key={i} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
            <span>{c.category}</span><span className="sub">{c.qty}</span>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>{t("rackWiseStockLabel", lang)}</h3>
        {(summary.rack_wise_stock || []).length === 0 && <div className="msg info">{t("noStockDataMsg", lang)}</div>}
        {(summary.rack_wise_stock || []).map((c, i) => (
          <div key={i} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
            <span>{c.rack}</span><span className="sub">{c.qty}</span>
          </div>
        ))}
      </div>

      <div className="card" style={{ textAlign: "center" }}>
        <button type="button" className="btn btn-outline" onClick={() => navigate("/inventory/setup")}>{t("fullReportsSetupLabel", lang)} ▸</button>
      </div>
    </div>
  );
}
