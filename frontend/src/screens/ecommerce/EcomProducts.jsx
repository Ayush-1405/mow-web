import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { L, MOVEMENT, connectionStatus, listVariants, money, pretty, productDetail, setThreshold, when } from "../../lib/ecomApi";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { EcomPage, Empty, LoadError, StageBadge, StockBadge, Thumb } from "./EcomShared.jsx";

// mode: "catalogue" | "low" | "out". Quantities are Shopify's latest synchronised numbers (summed over locations).
export default function EcomProducts({ lang, mode = "catalogue" }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const set = (k, v) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const view = mode === "catalogue" ? (params.get("view") || "products") : "variants";
  const status = params.get("status") || (mode === "catalogue" ? "" : "ACTIVE");
  const stock = mode === "low" ? "LOW" : mode === "out" ? "OUT" : (params.get("stock") || "");
  const category = params.get("category") || "";
  const [search, setSearch] = useState(params.get("q") || "");
  const q = useDebouncedValue(search, 350);
  const [rows, setRows] = useState(null);
  const [categories, setCategories] = useState([]);
  const [conn, setConn] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null); setRows(null);
    try { setRows(await listVariants({ search: q, status, stock, category })); } catch (e) { setError(e); }
  }, [q, status, stock, category]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    listVariants({}).then((all) => setCategories([...new Set(all.map((v) => v.product_type).filter(Boolean))].sort())).catch(() => {});
    connectionStatus().then(setConn).catch(() => {});
  }, []);

  const products = useMemo(() => {
    if (!rows) return null;
    const by = new Map();
    for (const v of rows) {
      const p = by.get(v.product_id) || { ...v, variants: 0, available: 0, committed: 0, units_sold: 0, skus: [], worst: "IN", tracked: false };
      p.variants += 1; p.available += v.available || 0; p.committed += v.committed || 0; p.units_sold += v.units_sold || 0;
      if (v.sku) p.skus.push(v.sku);
      if (v.tracked && v.stock_status !== "NOT_TRACKED") p.tracked = true;
      const rank = { OUT: 3, LOW: 2, IN: 1, NOT_TRACKED: 0 };
      if (rank[v.stock_status] > rank[p.worst]) p.worst = v.stock_status;
      if (!p.tracked) p.worst = "NOT_TRACKED";
      by.set(v.product_id, p);
    }
    return [...by.values()];
  }, [rows]);

  const title = mode === "low" ? ["Low Stock", "ઓછો સ્ટોક", "🟠"] : mode === "out" ? ["Out of Stock", "સ્ટોક ખતમ", "🔴"] : ["Product Catalogue", "પ્રોડક્ટ કેટલોગ", "🗂️"];
  const list = view === "products" ? products : rows;
  return (
    <EcomPage lang={lang} icon={title[2]} title={title[0]} titleGu={title[1]}
      sub={mode === "catalogue" ? L(lang, "Products, images, variants and stock as synchronised from Shopify.", "Shopify માંથી પ્રોડક્ટ, છબી, વેરિયન્ટ અને સ્ટોક.")
        : `${L(lang, "Active products, latest synchronised stock. Low = at or below", "સક્રિય પ્રોડક્ટ. ઓછો = ")} ${conn?.low_stock_threshold ?? 5} ${L(lang, "units (or the variant's own limit).", "નંગ અથવા ઓછું.")}`}>
      <div className="card filter-bar filter-grid">
        <label className="filter-date-label">{L(lang, "Search", "શોધો")}
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={L(lang, "Product name or SKU", "પ્રોડક્ટ નામ અથવા SKU")} />
        </label>
        {mode === "catalogue" && (
          <>
            <label className="filter-date-label">{L(lang, "Show", "બતાવો")}
              <select value={view} onChange={(e) => set("view", e.target.value === "products" ? "" : e.target.value)}>
                <option value="products">{L(lang, "Products", "પ્રોડક્ટ")}</option><option value="variants">{L(lang, "Variants", "વેરિયન્ટ")}</option>
              </select>
            </label>
            <label className="filter-date-label">{L(lang, "Product status", "પ્રોડક્ટ સ્થિતિ")}
              <select value={status} onChange={(e) => set("status", e.target.value)}>
                <option value="">{L(lang, "All", "બધા")}</option><option value="ACTIVE">{L(lang, "Active", "સક્રિય")}</option>
                <option value="DRAFT">{L(lang, "Draft", "ડ્રાફ્ટ")}</option><option value="ARCHIVED">{L(lang, "Archived", "આર્કાઇવ")}</option>
              </select>
            </label>
            <label className="filter-date-label">{L(lang, "Stock", "સ્ટોક")}
              <select value={stock} onChange={(e) => set("stock", e.target.value)}>
                <option value="">{L(lang, "All", "બધા")}</option><option value="IN">{L(lang, "In stock", "સ્ટોકમાં")}</option>
                <option value="LOW">{L(lang, "Low stock", "ઓછો")}</option><option value="OUT">{L(lang, "Out of stock", "ખતમ")}</option>
                <option value="NOT_TRACKED">{L(lang, "Not tracked", "ટ્રેક નથી")}</option>
              </select>
            </label>
          </>
        )}
        <label className="filter-date-label">{L(lang, "Category", "કેટેગરી")}
          <select value={category} onChange={(e) => set("category", e.target.value)}>
            <option value="">{L(lang, "All", "બધી")}</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>
      {error && <LoadError lang={lang} error={error} onRetry={load} />}
      {!error && list === null && <div className="skeleton-block" style={{ height: 160 }} />}
      {list && list.length === 0 && <Empty lang={lang}>{mode === "low" ? L(lang, "No active product is low on stock.", "કોઈ પ્રોડક્ટ ઓછો નથી.")
        : mode === "out" ? L(lang, "No active product is out of stock.", "કોઈ પ્રોડક્ટ ખતમ નથી.") : L(lang, "No products match (or Shopify has not been synchronised yet).", "કોઈ પ્રોડક્ટ નથી.")}</Empty>}
      {list && list.length > 0 && (
        <div className="ecom-cards">
          <div className="ecom-card-count">{list.length} {view === "products" ? L(lang, "products", "પ્રોડક્ટ") : L(lang, "variants", "વેરિયન્ટ")}</div>
          {list.map((v) => {
            const isP = view === "products";
            return (
              <button key={isP ? v.product_id : v.variant_id} type="button" className="ecom-card" onClick={() => navigate(`/ecommerce/products/${encodeURIComponent(v.product_id)}`)}>
                <Thumb url={v.image_url} size={52} />
                <div style={{ minWidth: 0 }}>
                  <div className="ecom-card-top">
                    <span className="ecom-card-title">{v.product_title}</span>
                    <StockBadge lang={lang} status={isP ? v.worst : v.stock_status} />
                  </div>
                  <div className="ecom-card-line">
                    {!isP && v.variant_title !== "Default Title" ? `${v.variant_title} · ` : ""}
                    {(isP ? v.skus.slice(0, 2).join(", ") : v.sku) || L(lang, "no SKU", "SKU નથી")}{v.product_type ? ` · ${v.product_type}` : ""}
                  </div>
                  <div className="ecom-card-stats">
                    <span>{L(lang, "Available", "ઉપલબ્ધ")} <strong>{v.available ?? "—"}</strong></span>
                    <span>{L(lang, "Committed", "કમિટેડ")} <strong>{v.committed ?? "—"}</strong></span>
                    <span>{L(lang, "Sold", "વેચાયા")} <strong>{v.units_sold}</strong></span>
                    {isP && v.variants > 1 && <span>{v.variants} {L(lang, "variants", "વેરિયન્ટ")}</span>}
                    {v.product_status !== "ACTIVE" && <span>{pretty(v.product_status)}</span>}
                  </div>
                </div>
              </button>);
          })}
        </div>
      )}
      {list && list.length > 0 && (
        <div className="card proc-table-wrap ecom-table-only">
          <div className="sub" style={{ marginBottom: 6 }}>{list.length} {view === "products" ? L(lang, "products", "પ્રોડક્ટ") : L(lang, "variants", "વેરિયન્ટ")}</div>
          <table className="proc-table">
            <thead><tr>
              <th /><th>{L(lang, "Product", "પ્રોડક્ટ")}</th>{view === "variants" && <th>{L(lang, "Variant", "વેરિયન્ટ")}</th>}<th>SKU</th><th>{L(lang, "Category", "કેટેગરી")}</th>
              <th>{L(lang, "Price", "કિંમત")}</th><th>{L(lang, "Available", "ઉપલબ્ધ")}</th><th>{L(lang, "Committed", "કમિટેડ")}</th>
              {view === "variants" && <th>{L(lang, "Locations", "સ્થાન")}</th>}<th>{L(lang, "Stock", "સ્ટોક")}</th><th>{L(lang, "Status", "સ્થિતિ")}</th>
              <th>{L(lang, "Units sold", "વેચાયા")}</th>{view === "products" && <th>{L(lang, "Variants", "વેરિયન્ટ")}</th>}<th>{L(lang, "Updated", "અપડેટ")}</th>
              <th className="sub">Shopify ID</th>
            </tr></thead>
            <tbody>{list.map((v) => (
              <tr key={view === "products" ? v.product_id : v.variant_id} style={{ cursor: "pointer" }} onClick={() => navigate(`/ecommerce/products/${encodeURIComponent(v.product_id)}`)}>
                <td><Thumb url={v.image_url} /></td>
                <td><strong>{v.product_title}</strong></td>
                {view === "variants" && <td>{v.variant_title === "Default Title" ? "—" : v.variant_title}</td>}
                <td>{view === "products" ? (v.skus.slice(0, 2).join(", ") + (v.skus.length > 2 ? ` +${v.skus.length - 2}` : "")) || "—" : v.sku || "—"}</td>
                <td>{v.product_type || "—"}</td>
                <td>{money(v.price)}</td>
                <td><strong>{v.available ?? "—"}</strong></td>
                <td>{v.committed ?? "—"}</td>
                {view === "variants" && <td>{v.locations ?? 0}</td>}
                <td><StockBadge lang={lang} status={view === "products" ? v.worst : v.stock_status} /></td>
                <td>{pretty(v.product_status)}</td>
                <td>{v.units_sold}</td>
                {view === "products" && <td>{v.variants}</td>}
                <td>{when(v.updated_at)}</td>
                <td className="sub">{String(view === "products" ? v.product_id : v.variant_id).split("/").pop()}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </EcomPage>
  );
}

const sum = (list, k) => list.reduce((a, x) => a + (Number(x[k]) || 0), 0);

export function EcomProductDetail({ lang }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [d, setD] = useState(null);
  const [conn, setConn] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = useCallback(async () => {
    setError(null);
    try { const [x, c] = await Promise.all([productDetail(decodeURIComponent(id)), connectionStatus()]); setD(x); setConn(c); } catch (e) { setError(e); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const p = d?.product;
  const locName = (lid) => d?.locations.find((l) => l.shopify_id === lid)?.name || String(lid).split("/").pop();
  const vName = (vid) => { const v = d?.variants.find((x) => x.variant_id === vid); return v ? (v.variant_title === "Default Title" ? v.sku || "" : v.variant_title) : ""; };
  const [thrFor, setThrFor] = useState(null);
  const [thrVal, setThrVal] = useState("");
  const saveThreshold = async () => {
    setMsg(null);
    try { await setThreshold(thrVal === "" ? null : Number(thrVal), thrFor); setThrFor(null); await load(); }
    catch (e) { setMsg(e.message); }
  };
  return (
    <EcomPage lang={lang} icon="🗂️" title={p?.title || "Product"} titleGu={p?.title || "પ્રોડક્ટ"}
      sub={p ? `${pretty(p.status)} · ${p.product_type || "—"}${p.vendor ? ` · ${p.vendor}` : ""} · Shopify ID ${String(p.shopify_id).split("/").pop()} · ${L(lang, "updated", "અપડેટ")} ${when(p.shopify_updated_at)}` : null}>
      {error && <LoadError lang={lang} error={error} onRetry={load} />}
      {d && !p && <Empty lang={lang}>{L(lang, "Product not found (or not synchronised yet).", "પ્રોડક્ટ મળ્યો નથી.")}</Empty>}
      {p && (
        <>
          {p.deleted_at && <div className="msg error">{L(lang, "This product was deleted in Shopify on", "Shopify માં કાઢી નાખ્યો")} {when(p.deleted_at)}.</div>}
          {(p.images || []).length > 0 && (
            <div className="card" style={{ display: "flex", gap: 8, overflowX: "auto" }}>
              {p.images.map((im, i) => <img key={i} src={im.url} alt={im.alt || ""} loading="lazy" style={{ height: 120, borderRadius: 8 }} />)}
            </div>)}
          {msg && <div className="msg error">{msg}</div>}
          <div className="card">
            <div className="kpi-grid">
              {[
                ["📊", L(lang, "Available (all locations)", "ઉપલબ્ધ (બધા સ્થાન)"), sum(d.variants, "available")],
                ["📌", L(lang, "Committed to orders", "ઓર્ડર માટે રોકાયેલ"), sum(d.variants, "committed")],
                ["🛍️", L(lang, "Units sold", "વેચાયેલા નંગ"), sum(d.variants, "units_sold")],
                ["🔢", L(lang, "Variants", "વેરિયન્ટ"), d.variants.length],
                ["🟠", L(lang, "Variants low / out", "ઓછા / ખતમ વેરિયન્ટ"), d.variants.filter((v) => v.stock_status === "LOW" || v.stock_status === "OUT").length,
                  d.variants.some((v) => v.stock_status === "OUT") ? "critical" : d.variants.some((v) => v.stock_status === "LOW") ? "warn" : null],
              ].map(([icon, label, value, tone]) => (
                <div key={label} className={`kpi-card${tone ? ` kpi-${tone}` : ""}${tone === "critical" ? " kpi-alert" : ""}`} style={{ cursor: "default" }}>
                  <span className="kpi-icon" aria-hidden="true">{icon}</span><span className="kpi-value">{value}</span><span className="kpi-label">{label}</span>
                </div>))}
            </div>
          </div>
          <div className="card proc-table-wrap">
            <div className="section-title" style={{ marginTop: 0 }}>{L(lang, "Variants and stock", "વેરિયન્ટ અને સ્ટોક")}</div>
            <table className="proc-table">
              <thead><tr><th>{L(lang, "Variant", "વેરિયન્ટ")}</th><th>SKU</th><th>{L(lang, "Price", "કિંમત")}</th><th>{L(lang, "Location", "સ્થાન")}</th>
                <th>{L(lang, "Available", "ઉપલબ્ધ")}</th><th>{L(lang, "Committed", "કમિટેડ")}</th><th>{L(lang, "On hand", "હાથ પર")}</th><th>{L(lang, "Incoming", "આવનાર")}</th>
                <th>{L(lang, "Stock", "સ્ટોક")}</th><th>{L(lang, "Low-stock limit", "ઓછા સ્ટોકની મર્યાદા")}</th><th>{L(lang, "Units sold", "વેચાયા")}</th></tr></thead>
              <tbody>{d.variants.map((v) => {
                const lv = d.levels.filter((l) => l.inventory_item_id === v.inventory_item_id);
                return (lv.length ? lv : [null]).map((l, i) => (
                  <tr key={v.variant_id + (l?.location_id || "")}>
                    {i === 0 && <td rowSpan={lv.length || 1}><strong>{v.variant_title === "Default Title" ? "—" : v.variant_title}</strong></td>}
                    {i === 0 && <td rowSpan={lv.length || 1}>{v.sku || "—"}</td>}
                    {i === 0 && <td rowSpan={lv.length || 1}>{money(v.price)}</td>}
                    <td>{l ? locName(l.location_id) : L(lang, "not stocked anywhere", "ક્યાંય સ્ટોક નથી")}</td>
                    <td><strong>{l?.available ?? "—"}</strong></td><td>{l?.committed ?? "—"}</td><td>{l?.on_hand ?? "—"}</td><td>{l?.incoming ?? "—"}</td>
                    {i === 0 && <td rowSpan={lv.length || 1}><StockBadge lang={lang} status={v.stock_status} /><div className="sub">{L(lang, "total", "કુલ")} {v.available ?? "—"}</div></td>}
                    {i === 0 && <td rowSpan={lv.length || 1}>
                      {thrFor === v.variant_id ? (
                        <span style={{ display: "flex", gap: 4 }}>
                          <input type="number" min="0" value={thrVal} onChange={(e) => setThrVal(e.target.value)} style={{ width: 70 }} placeholder={String(conn?.low_stock_threshold ?? 5)} />
                          <button type="button" className="btn btn-primary btn-sm" onClick={saveThreshold}>✓</button>
                          <button type="button" className="btn btn-outline btn-sm" onClick={() => setThrFor(null)}>✕</button>
                        </span>
                      ) : (
                        <>
                          {v.threshold}{v.variant_threshold === null ? <span className="sub"> ({L(lang, "default", "ડિફોલ્ટ")})</span> : null}
                          {conn?.can_set_thresholds && <button type="button" className="btn btn-outline btn-sm" style={{ marginLeft: 6 }}
                            onClick={() => { setThrFor(v.variant_id); setThrVal(v.variant_threshold ?? ""); }}>{L(lang, "Change", "બદલો")}</button>}
                        </>)}
                    </td>}
                    {i === 0 && <td rowSpan={lv.length || 1}>{v.units_sold}</td>}
                  </tr>));
              })}</tbody>
            </table>
          </div>
          <div className="card proc-table-wrap">
            <div className="section-title" style={{ marginTop: 0 }}>{L(lang, "Orders with this product", "આ પ્રોડક્ટના ઓર્ડર")}</div>
            {d.lines.length === 0 ? <div className="sub">{L(lang, "No orders yet.", "હજુ ઓર્ડર નથી.")}</div> : (
              <table className="proc-table">
                <thead><tr><th>{L(lang, "Order", "ઓર્ડર")}</th><th>{L(lang, "Date", "તારીખ")}</th><th>{L(lang, "Variant", "વેરિયન્ટ")}</th><th>{L(lang, "Qty", "નંગ")}</th><th>{L(lang, "Status", "સ્થિતિ")}</th><th>{L(lang, "Payment", "ચુકવણી")}</th></tr></thead>
                <tbody>{[...d.lines].sort((a, b) => String(b.ecom_orders.shopify_created_at).localeCompare(a.ecom_orders.shopify_created_at)).map((l) => (
                  <tr key={l.shopify_id} style={{ cursor: "pointer" }} onClick={() => navigate(`/ecommerce/orders/${encodeURIComponent(l.order_id)}`)}>
                    <td>{l.ecom_orders.name}</td><td>{when(l.ecom_orders.shopify_created_at)}</td><td>{l.variant_title || l.sku || "—"}</td><td>{l.quantity}</td>
                    <td><StageBadge lang={lang} stage={l.ecom_orders.stage} /></td><td>{pretty(l.ecom_orders.financial_status)}</td>
                  </tr>))}</tbody>
              </table>)}
          </div>
          <div className="card proc-table-wrap">
            <div className="section-title" style={{ marginTop: 0 }}>{L(lang, "Stock movements", "સ્ટોક હલનચલન")}</div>
            {d.moves.length === 0 ? <div className="sub">{L(lang, "No stock recorded yet.", "હજુ સ્ટોક નોંધાયો નથી.")}</div> : (
              <table className="proc-table">
                <thead><tr><th>{L(lang, "When", "ક્યારે")}</th><th>{L(lang, "Variant", "વેરિયન્ટ")}</th><th>{L(lang, "Location", "સ્થાન")}</th><th>{L(lang, "Before", "પહેલાં")}</th>
                  <th>{L(lang, "Change", "ફેરફાર")}</th><th>{L(lang, "After", "પછી")}</th><th>{L(lang, "Type", "પ્રકાર")}</th><th>{L(lang, "Reference", "સંદર્ભ")}</th></tr></thead>
                <tbody>{d.moves.map((m) => (
                  <tr key={m.id}><td>{when(m.occurred_at)}</td><td>{vName(m.variant_id)}</td><td>{locName(m.location_id)}</td><td>{m.previous_qty ?? "—"}</td>
                    <td style={{ fontWeight: 700, color: m.movement_type === "BASELINE" ? undefined : m.change > 0 ? "var(--success)" : m.change < 0 ? "var(--danger)" : undefined }}>{m.movement_type === "BASELINE" ? "—" : m.change > 0 ? `+${m.change}` : m.change}</td><td>{m.new_qty}</td>
                    <td>{L(lang, ...(MOVEMENT[m.movement_type] || [m.movement_type, m.movement_type]))}</td><td style={{ whiteSpace: "normal" }}>{m.reference || "—"}</td></tr>))}</tbody>
              </table>)}
          </div>
        </>
      )}
    </EcomPage>
  );
}
