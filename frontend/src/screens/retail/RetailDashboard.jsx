import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../../lib/i18n";
import { loadDashboardCounts, loadImportantWork } from "../../lib/retailApi";
import { subscribeTable } from "../../lib/realtime";
import WalkinModal from "./WalkinModal.jsx";

// KPI id -> where it opens when tapped, and which real table/query backs the count (see lib/retailApi.loadDashboardCounts). Every card is
// a live number and a click-through, never a static demo figure.
const KPI_DEFS = [
  ["walkinsToday", "🚶", "kpiWalkinsToday", "/retail/leads"],
  ["followupsDueToday", "📞", "kpiFollowupsDueToday", "/retail/leads?filter=due_today"],
  ["followupsOverdue", "⏰", "kpiFollowupsOverdue", "/retail/leads?filter=overdue", "critical"],
  ["openQuotations", "📃", "kpiOpenQuotations", "/retail/quotations"],
  ["pendingApproval", "✍️", "kpiPendingApproval", "/retail/quotations?filter=pending_approval"],
  ["confirmedOrders", "📦", "kpiBookedOrders", "/retail/orders"],
  ["pendingStockChecks", "🏷️", "kpiPendingStock", "/retail/stock"],
  ["activeJobCards", "🏭", "kpiActiveJobCards", "/factory/tasks"],
  ["pendingProcurement", "🛒", "kpiPendingProcurement", "/retail/orders"],
  ["deliveriesDueToday", "🚚", "kpiDeliveriesToday", "/retail/delivery"],
  ["delayedDeliveries", "⚠️", "kpiDelayedDeliveries", "/retail/delivery", "critical"],
  ["complaintsOpen", "☎️", "kpiOpenComplaints", "/retail/complaints"],
];

const QUICK_ACTIONS = [
  ["addWalkin", "🚶", "action:walkin"],
  ["recordFollowUpAction", "📞", "/retail/leads"],
  ["createQuotationAction", "📃", "/retail/quotations"],
  ["createOrderAction", "📦", "/retail/orders"],
  ["checkStockAction", "🏷️", "/retail/stock"],
  ["addDisplayUpdateAction", "🖼️", "/retail/display"],
  ["addDeliveryUpdateAction", "🚚", "/retail/delivery"],
  ["submitDailyUpdateAction", "📝", "/retail/daily-update"],
  ["viewReportsAction", "📊", "/retail/reports"],
  ["assignRetailTaskAction", "📝", "/assign"],
];

export default function RetailDashboard({ lang, profile, lookups, department }) {
  const navigate = useNavigate();
  const [counts, setCounts] = useState(null);
  const [work, setWork] = useState(null);
  const [error, setError] = useState(false);
  const [showWalkin, setShowWalkin] = useState(false);
  const [tab, setTab] = useState("important");

  const load = useCallback(async () => {
    try {
      const [c, w] = await Promise.all([loadDashboardCounts(), loadImportantWork()]);
      setCounts(c);
      setWork(w);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("retail_dashboard_leads", "retail_leads", null, load), [load]);
  useEffect(() => subscribeTable("retail_dashboard_orders", "retail_orders", null, load), [load]);
  useEffect(() => subscribeTable("retail_dashboard_quotes", "retail_quotations", null, load), [load]);
  useEffect(() => subscribeTable("retail_dashboard_deliveries", "retail_deliveries", null, load), [load]);

  const teamCountLabel = t("activeTeamLabel", lang);

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
        <div className="dept-header-text">
          <h1>{lang === "gu" ? department?.name_gu : department?.name_en}</h1>
          <div className="sub">{teamCountLabel}</div>
        </div>
        <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={load}>{t("refresh", lang)}</button>
      </div>

      <div className="card">
        <div className="kpi-grid">
          {KPI_DEFS.map(([key, icon, labelKey, route, tone]) => (
            <button key={key} type="button" className={`kpi-card${tone ? ` kpi-${tone}` : ""}${(counts?.[key] || 0) > 0 && tone === "critical" ? " kpi-alert" : ""}`}
              onClick={() => navigate(route)} disabled={!counts}>
              <span className="kpi-icon" aria-hidden="true">{icon}</span>
              <span className="kpi-value">{counts ? counts[key] ?? 0 : "…"}</span>
              <span className="kpi-label">{t(labelKey, lang)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>{t("quickActionsLabel", lang)}</div>
        <div className="retail-quick-actions">
          {QUICK_ACTIONS.map(([labelKey, icon, target]) => (
            <button key={labelKey} type="button" className="btn btn-outline retail-quick-action"
              onClick={() => (target === "action:walkin" ? setShowWalkin(true) : navigate(target))}>
              <span aria-hidden="true">{icon}</span> {t(labelKey, lang)}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="fx-tabs mobile-tab-list" role="tablist" aria-label={t("retailDashboardSectionsLabel", lang)} style={{ marginBottom: 10 }}>
          <button type="button" role="tab" aria-selected={tab === "important"} className={tab === "important" ? "active" : ""} onClick={() => setTab("important")}>{t("importantWorkLabel", lang)}</button>
          <button type="button" role="tab" aria-selected={tab === "followups"} className={tab === "followups" ? "active" : ""} onClick={() => setTab("followups")}>{t("overdueFollowupsLabel", lang)}</button>
          <button type="button" role="tab" aria-selected={tab === "quotes"} className={tab === "quotes" ? "active" : ""} onClick={() => setTab("quotes")}>{t("pendingApprovalLabel", lang)}</button>
          <button type="button" role="tab" aria-selected={tab === "jobs"} className={tab === "jobs" ? "active" : ""} onClick={() => setTab("jobs")}>{t("factoryDelaysLabel", lang)}</button>
          <button type="button" role="tab" aria-selected={tab === "complaints"} className={tab === "complaints" ? "active" : ""} onClick={() => setTab("complaints")}>{t("complaintsLabel", lang)}</button>
        </div>

        {!work && <div className="msg info">…</div>}
        {work && tab === "important" && (
          <ImportantList lang={lang} rows={[
            ...work.overdueFollowUps.map((r) => ({ ref: r.id, title: r.customer_name, reason: t("kpiFollowupsOverdue", lang), due: r.next_follow_up_date, priority: r.lead_temperature, onClick: () => navigate("/retail/leads") })),
            ...work.pendingApprovalQuotes.map((r) => ({ ref: r.quotation_number, title: r.customer_name, reason: t("kpiPendingApproval", lang), due: r.created_at?.slice(0, 10), onClick: () => navigate("/retail/quotations") })),
            ...work.blockedOrders.map((r) => ({ ref: r.order_number, title: r.customer_name, reason: t("orderBlockedPaymentLabel", lang), due: null, onClick: () => navigate("/retail/orders") })),
            ...work.delayedJobs.map((r) => ({ ref: r.job_order_number, title: r.customer_name, reason: t("factoryDelaysLabel", lang), due: r.required_completion_date, onClick: () => navigate("/factory/tasks") })),
            ...work.openComplaints.map((r) => ({ ref: r.id.slice(0, 8), title: r.customer_name, reason: r.description, due: r.created_at?.slice(0, 10), onClick: () => navigate("/retail/complaints") })),
          ]} empty={t("noUrgentWorkMsg", lang)} />
        )}
        {work && tab === "followups" && <ImportantList lang={lang} rows={work.overdueFollowUps.map((r) => ({ ref: r.id, title: r.customer_name, reason: r.status, due: r.next_follow_up_date, priority: r.lead_temperature, onClick: () => navigate("/retail/leads") }))} empty={t("noRecordsYet", lang)} />}
        {work && tab === "quotes" && <ImportantList lang={lang} rows={work.pendingApprovalQuotes.map((r) => ({ ref: r.quotation_number, title: r.customer_name, reason: t("kpiPendingApproval", lang), due: null, onClick: () => navigate("/retail/quotations") }))} empty={t("noRecordsYet", lang)} />}
        {work && tab === "jobs" && <ImportantList lang={lang} rows={work.delayedJobs.map((r) => ({ ref: r.job_order_number, title: r.customer_name, reason: r.product_item, due: r.required_completion_date, onClick: () => navigate("/factory/tasks") }))} empty={t("noRecordsYet", lang)} />}
        {work && tab === "complaints" && <ImportantList lang={lang} rows={work.openComplaints.map((r) => ({ ref: r.id.slice(0, 8), title: r.customer_name, reason: r.description, due: null, onClick: () => navigate("/retail/complaints") }))} empty={t("noRecordsYet", lang)} />}
      </div>

      {showWalkin && (
        <WalkinModal lang={lang} profile={profile} lookups={lookups} onClose={() => setShowWalkin(false)} onSaved={() => { setShowWalkin(false); load(); }} />
      )}
    </div>
  );
}

function ImportantList({ lang, rows, empty }) {
  if (!rows.length) return <div className="msg info">{empty}</div>;
  return (
    <div>
      {rows.map((r, i) => (
        <button key={r.ref + i} type="button" className="retail-work-row" onClick={r.onClick}>
          <div>
            <div className="retail-work-title">{r.title || "—"} <span className="sub">{r.ref}</span></div>
            <div className="sub">{r.reason}{r.due ? ` · ${t("dueDate", lang)}: ${r.due}` : ""}{r.priority ? ` · ${r.priority}` : ""}</div>
          </div>
          <span aria-hidden="true">→</span>
        </button>
      ))}
    </div>
  );
}
