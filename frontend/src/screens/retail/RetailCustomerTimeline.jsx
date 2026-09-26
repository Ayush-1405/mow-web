import React, { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { t } from "../../lib/i18n";
import { loadCustomer, loadCustomerTimeline } from "../../lib/retailApi";
import { statusBadgeClass } from "../../lib/retailModules.js";
import RetailTransferCustomer from "./RetailTransferCustomer.jsx";

// Single Customer Timeline (v2_93h §4): every connected record for one customer, newest first. Each entry links back to the real
// screen that owns that record — nothing here is a copy, it is retail_customer_timeline()'s own live read of every table.
const ENTRY_ROUTE = {
  LEAD: "/retail/leads", FOLLOWUP: "/retail/leads", QUOTATION: "/retail/quotations", ORDER: "/retail/orders",
  PAYMENT: "/retail/orders", FULFILMENT: "/retail/orders", PACKING: "/retail/packing", GODOWN_HANDOVER: "/retail/packing",
  DISPATCH: "/retail/delivery", DELIVERY: "/retail/delivery", DELIVERY_PROOF: "/retail/delivery", INSTALLATION: "/retail/delivery",
  COMPLAINT: "/retail/complaints", OWNERSHIP_CHANGE: null,
};
const ENTRY_ICON = {
  LEAD: "🧭", FOLLOWUP: "📞", QUOTATION: "📃", ORDER: "🧾", PAYMENT: "💰", FULFILMENT: "🏭", PACKING: "📦",
  GODOWN_HANDOVER: "🏬", DISPATCH: "🚚", DELIVERY: "🚚", DELIVERY_PROOF: "✅", INSTALLATION: "🔧", COMPLAINT: "⚠️", OWNERSHIP_CHANGE: "👤",
};

export default function RetailCustomerTimeline({ lang }) {
  const { customerId } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [customer, setCustomer] = useState(null);
  const [entries, setEntries] = useState([]);
  const [showTransfer, setShowTransfer] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data: cust, error: err1 }, { data: tl, error: err2 }] = await Promise.all([
      loadCustomer(customerId), loadCustomerTimeline(customerId),
    ]);
    if (err1 || err2) { setError(true); setLoading(false); return; }
    setCustomer(cust);
    setEntries(tl || []);
    setLoading(false);
  }, [customerId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 60 }} /><div className="skeleton-block" style={{ height: 220 }} /></div>;
  }
  if (error || !customer) {
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
        <div className="dept-header-icon" aria-hidden="true">🕑</div>
        <div className="dept-header-text">
          <h1>{customer.full_name}</h1>
          <div className="sub">{customer.phone} {customer.city ? `— ${customer.city}` : ""}</div>
        </div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div className="sub">
            {t("ownershipStatusLabel", lang)}: <strong>{customer.ownership_status}</strong>
            {customer.transferred_at && <> · {t("lastTransferredLabel", lang)}: {new Date(customer.transferred_at).toLocaleDateString()}</>}
          </div>
          <button className="btn btn-outline" onClick={() => setShowTransfer((s) => !s)}>{t("transferShareCustomerTitle", lang)}</button>
        </div>
        {showTransfer && (
          <RetailTransferCustomer lang={lang} customer={customer} onClose={() => setShowTransfer(false)}
            onDone={() => { setShowTransfer(false); load(); }} />
        )}
      </div>

      <div className="card">
        <h3>{t("timelineLabel", lang)}</h3>
        {entries.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {entries.map((e) => {
          const route = ENTRY_ROUTE[e.entry_type];
          return (
            <div key={`${e.entry_type}-${e.entity_id}`} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border, #eee)", cursor: route ? "pointer" : "default" }}
              onClick={() => route && navigate(route)}>
              <div>
                <div style={{ fontWeight: 600 }}>{ENTRY_ICON[e.entry_type] || "•"} {e.title}</div>
                <div className="sub">{e.entry_type} · {e.occurred_at ? new Date(e.occurred_at).toLocaleString() : ""}</div>
              </div>
              <span className={`badge ${statusBadgeClass(e.status)}`}>{e.status}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
