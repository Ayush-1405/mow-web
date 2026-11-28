import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { L, dashboard, when } from "../../lib/ecomApi";
import DepartmentDashboard from "../DepartmentDashboard.jsx";
import { ConnectionStrip, DateRangeFilter, LoadError, useDateRange } from "./EcomShared.jsx";

// E-commerce department home: the live Shopify overview on top, then the department's existing task / approval / activity /
// AI performance view (DepartmentDashboard) and its function cards, unchanged.
export default function EcomHome(props) {
  const { lang } = props;
  const navigate = useNavigate();
  const range = useDateRange("today");
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!range.from || !range.to) return;
    setError(null);
    try { setD(await dashboard(range.from, range.to)); } catch (e) { setError(e); }
  }, [range.from, range.to]);
  useEffect(() => { load(); }, [load]);

  const period = `preset=${range.preset}${range.preset === "custom" ? `&from=${range.from}&to=${range.to}` : ""}`;
  const go = (path) => navigate(path);
  const summary = d ? [
    ["🧾", L(lang, "Orders in this period", "આ સમયગાળાના ઓર્ડર"), d.orders_total, `/ecommerce/orders?${period}`],
    ["📅", L(lang, "Today's orders", "આજના ઓર્ડર"), d.today_orders, "/ecommerce/orders?preset=today"],
    ["🛍️", L(lang, "Units sold", "વેચાયેલા નંગ"), d.units_sold, `/ecommerce/inventory?${period}`],
  ] : [];
  const pipeline = d ? [
    ["⏳", L(lang, "Pending", "બાકી"), d.pending, `/ecommerce/orders?${period}&stage=PENDING`, d.pending > 0 ? "warn" : null],
    ["⚙️", L(lang, "Processing", "પ્રોસેસિંગ"), d.processing, `/ecommerce/orders?${period}&stage=PROCESSING,PARTIALLY_FULFILLED`],
    ["📦", L(lang, "Fulfilled (not shipped)", "ફુલફિલ"), d.fulfilled, `/ecommerce/fulfilment?${period}&stage=FULFILLED`],
    ["🚚", L(lang, "Dispatched", "રવાના"), d.dispatched, `/ecommerce/fulfilment?${period}&stage=DISPATCHED`],
    ["✅", L(lang, "Delivered (confirmed)", "પહોંચાડ્યું"), d.delivered, `/ecommerce/fulfilment?${period}&stage=DELIVERED`],
  ] : [];
  const closed = d ? [
    ["✖️", L(lang, "Cancelled", "રદ"), d.cancelled, `/ecommerce/returns?${period}&tab=cancelled`],
    ["↩️", L(lang, "Returned", "પરત"), d.returned, `/ecommerce/returns?${period}&tab=returned`],
  ] : [];
  const stockTiles = d ? [
    ["🗂️", L(lang, "Total products", "કુલ પ્રોડક્ટ"), d.products_total, "/ecommerce/products"],
    ["🟢", L(lang, "Active", "સક્રિય"), d.products_active, "/ecommerce/products?status=ACTIVE"],
    ["📝", L(lang, "Draft", "ડ્રાફ્ટ"), d.products_draft, "/ecommerce/products?status=DRAFT"],
    ["🗄️", L(lang, "Archived", "આર્કાઇવ"), d.products_archived, "/ecommerce/products?status=ARCHIVED"],
    ["🔢", L(lang, "Variants", "વેરિયન્ટ"), d.variants_total, "/ecommerce/products?view=variants"],
    ["📊", L(lang, "Available stock (units)", "ઉપલબ્ધ સ્ટોક"), d.stock_available, "/ecommerce/inventory"],
    ["🟠", L(lang, "Low stock", "ઓછો સ્ટોક"), d.low_stock, "/ecommerce/low-stock", d.low_stock > 0 ? "warn" : null],
    ["🔴", L(lang, "Out of stock", "સ્ટોક ખતમ"), d.out_of_stock, "/ecommerce/out-of-stock", d.out_of_stock > 0 ? "critical" : null],
    ["➕", L(lang, "Products to add", "ઉમેરવાના પ્રોડક્ટ"), d.to_add, "/ecommerce/to-add"],
  ] : [];
  const Tile = ([icon, label, value, path, tone]) => (
    <button key={label} type="button" className={`kpi-card${tone ? ` kpi-${tone}` : ""}${tone === "critical" ? " kpi-alert" : ""}`} onClick={() => go(path)}>
      <span className="kpi-icon" aria-hidden="true">{icon}</span>
      <span className="kpi-value">{value ?? 0}</span>
      <span className="kpi-label">{label}</span>
    </button>
  );
  const notConnected = d && !["CONNECTED", "ERROR"].includes(d.connection?.status) && !d.connection?.last_success_sync_at;

  return (
    <>
      <div className="dept-dashboard" style={{ paddingBottom: 0 }}>
        <ConnectionStrip lang={lang} status={d?.connection} onSynced={load} />
        {error && <LoadError lang={lang} error={error} onRetry={load} />}
        {notConnected && (
          <div className="card">
            <strong>{L(lang, "Shopify is not connected yet.", "Shopify હજુ જોડાયેલ નથી.")}</strong>{" "}
            {d.connection?.can_configure
              ? L(lang, "Open Connection settings to add the store; orders, products and stock appear after the first sync.", "કનેક્શન સેટિંગ્સમાં સ્ટોર ઉમેરો; પ્રથમ સિંક પછી ડેટા દેખાશે.")
              : L(lang, "Management adds the store in Connection settings. Until then the numbers below stay at zero.", "મેનેજમેન્ટ સ્ટોર ઉમેરશે. ત્યાં સુધી આંકડા શૂન્ય રહેશે.")}
          </div>
        )}
        <div className="card filter-bar filter-grid">
          <DateRangeFilter lang={lang} range={range} />
          <span className="sub" style={{ alignSelf: "end" }}>{L(lang, "Order and sales counts use the order date (India time).", "ઓર્ડર તારીખ (ભારત સમય) મુજબ.")}</span>
        </div>
        {d && (
          <>
            <div className="card">
              <div className="ecom-summary">{summary.map(Tile)}</div>
            </div>
            <div className="card">
              <div className="ecom-section-head">
                <div className="section-title">{L(lang, "Where the orders are", "ઓર્ડર ક્યાં છે")}</div>
                <span className="sub">{L(lang, "orders placed in this period, by their current status", "આ સમયગાળાના ઓર્ડર, હાલની સ્થિતિ મુજબ")}</span>
              </div>
              <div className="ecom-pipeline">{pipeline.map(Tile)}</div>
              <div className="ecom-side">{closed.map(Tile)}</div>
            </div>
            <div className="card">
              <div className="ecom-section-head">
                <div className="section-title">{L(lang, "Products and stock", "પ્રોડક્ટ અને સ્ટોક")}</div>
                <span className="sub">{L(lang, "latest synchronised quantities, as of", "છેલ્લો સિંક,")} {when(d.stock_as_of)}</span>
              </div>
              <div className="kpi-grid">{stockTiles.map(Tile)}</div>
            </div>
          </>
        )}
      </div>
      <DepartmentDashboard {...props} />
    </>
  );
}
