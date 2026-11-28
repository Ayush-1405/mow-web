import React, { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { L, STAGE, day, listOrders, listRefunds, money, orderDetail, pretty, when } from "../../lib/ecomApi";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { DateRangeFilter, EcomPage, Empty, LoadError, StageBadge, Thumb, useDateRange } from "./EcomShared.jsx";

const FULFIL_STAGES = ["PENDING", "PROCESSING", "PARTIALLY_FULFILLED", "FULFILLED", "DISPATCHED", "DELIVERED"];

// mode: "orders" (Online Orders), "fulfilment" (Fulfilment Tracking), "returns" (Cancellations and Returns)
export default function EcomOrders({ lang, mode = "orders" }) {
  const navigate = useNavigate();
  const range = useDateRange(mode === "orders" ? "last7" : "thisMonth");
  const stageParam = range.params.get("stage") || "";
  const payment = range.params.get("payment") || "";
  const tab = range.params.get("tab") || "cancelled";
  const [search, setSearch] = useState(range.params.get("q") || "");
  const q = useDebouncedValue(search, 350);
  const [list, setList] = useState(null);
  const [refunds, setRefunds] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null); setList(null);
    try {
      const base = { from: range.from || null, to: range.to || null, search: q, payment: payment || null };
      if (mode === "returns") {
        if (tab === "refunds") { setRefunds(await listRefunds(base.from, base.to)); setList([]); return; }
        const stages = tab === "cancelled" ? ["CANCELLED"] : null;
        setList(await listOrders({ ...base, stages, extra: tab === "returned" ? (x) => x.or("stage.eq.RETURNED,returned_qty.gt.0,return_status.in.(RETURN_REQUESTED,IN_PROGRESS,INSPECTION_COMPLETE,RETURNED,RETURN_FAILED)") : null }));
      } else {
        const stages = stageParam ? stageParam.split(",") : mode === "fulfilment" ? FULFIL_STAGES : null;
        setList(await listOrders({ ...base, stages }));
      }
    } catch (e) { setError(e); }
  }, [range.from, range.to, q, payment, stageParam, mode, tab]);
  useEffect(() => { load(); }, [load]);

  const title = mode === "fulfilment" ? ["Fulfilment Tracking", "ફુલફિલમેન્ટ ટ્રેકિંગ", "🚚"] : mode === "returns" ? ["Cancellations and Returns", "કેન્સલેશન અને રિટર્ન", "↩️"] : ["Online Orders", "ઓનલાઇન ઓર્ડર", "🧾"];
  return (
    <EcomPage lang={lang} icon={title[2]} title={title[0]} titleGu={title[1]}
      sub={L(lang, "From Shopify. Payment and fulfilment are separate; \"Delivered\" only when the carrier confirmed it.", "Shopify માંથી. ચુકવણી અને ફુલફિલમેન્ટ અલગ.")}>
      {mode === "returns" && (
        <div className="card fx-tabs mobile-tab-list" role="tablist">
          {[["cancelled", "Cancelled orders", "રદ ઓર્ડર"], ["returned", "Returns", "રિટર્ન"], ["refunds", "Refunds", "રિફંડ"]].map(([k, en, gu]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => range.set({ tab: k })}>{L(lang, en, gu)}</button>
          ))}
        </div>
      )}
      <div className="card filter-bar filter-grid">
        <label className="filter-date-label">{L(lang, "Search", "શોધો")}
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={L(lang, "Order no., customer, product or SKU", "ઓર્ડર, ગ્રાહક, પ્રોડક્ટ, SKU")} />
        </label>
        <DateRangeFilter lang={lang} range={range} allowAll />
        {mode !== "returns" && (
          <label className="filter-date-label">{L(lang, "Status", "સ્થિતિ")}
            <select value={stageParam} onChange={(e) => range.set({ stage: e.target.value })}>
              <option value="">{L(lang, "All", "બધા")}</option>
              {(mode === "fulfilment" ? FULFIL_STAGES : Object.keys(STAGE)).map((s) => <option key={s} value={s}>{L(lang, STAGE[s][0], STAGE[s][1])}</option>)}
              <option value="PROCESSING,PARTIALLY_FULFILLED">{L(lang, "Processing + partially fulfilled", "પ્રોસેસિંગ + આંશિક")}</option>
            </select>
          </label>
        )}
        {mode === "orders" && (
          <label className="filter-date-label">{L(lang, "Payment", "ચુકવણી")}
            <select value={payment} onChange={(e) => range.set({ payment: e.target.value })}>
              <option value="">{L(lang, "All", "બધા")}</option>
              {["PAID", "PENDING", "PARTIALLY_PAID", "AUTHORIZED", "REFUNDED", "PARTIALLY_REFUNDED", "VOIDED", "EXPIRED"].map((p) => <option key={p} value={p}>{pretty(p)}</option>)}
            </select>
          </label>
        )}
      </div>
      {error && <LoadError lang={lang} error={error} onRetry={load} />}
      {!error && list === null && <div className="skeleton-block" style={{ height: 160 }} />}
      {mode === "returns" && tab === "refunds" ? (
        refunds.length === 0 ? <Empty lang={lang}>{L(lang, "No refunds in this period.", "આ સમયગાળામાં રિફંડ નથી.")}</Empty> : (
          <div className="card proc-table-wrap">
            <table className="proc-table">
              <thead><tr><th>{L(lang, "Date", "તારીખ")}</th><th>{L(lang, "Order", "ઓર્ડર")}</th><th>{L(lang, "Items", "આઇટમ")}</th><th>{L(lang, "Restocked by Shopify", "ફરી સ્ટોકમાં")}</th><th>{L(lang, "Note", "નોંધ")}</th></tr></thead>
              <tbody>{refunds.map((r) => {
                const qty = (r.lines || []).reduce((a, x) => a + (x.quantity || 0), 0);
                const rest = (r.lines || []).filter((x) => x.restocked).reduce((a, x) => a + (x.quantity || 0), 0);
                return (
                  <tr key={r.shopify_id} style={{ cursor: "pointer" }} onClick={() => navigate(`/ecommerce/orders/${encodeURIComponent(r.order_id)}`)}>
                    <td>{when(r.shopify_created_at)}</td><td>{r.ecom_orders?.name}</td><td>{qty}</td>
                    <td>{rest ? `${rest} ${L(lang, "restocked", "ફરી સ્ટોકમાં")}` : L(lang, "Not restocked", "સ્ટોકમાં નહીં")}</td><td>{r.note || "—"}</td>
                  </tr>);
              })}</tbody>
            </table>
          </div>)
      ) : list && list.length === 0 ? <Empty lang={lang}>{L(lang, "No orders match.", "કોઈ ઓર્ડર નથી.")}</Empty> : list && (
        <>
        <div className="ecom-cards">
          <div className="ecom-card-count">{list.length} {L(lang, "orders", "ઓર્ડર")}{list.length === 300 ? ` · ${L(lang, "latest 300", "છેલ્લા 300")}` : ""}</div>
          {list.map((o) => <OrderCard key={o.shopify_id} lang={lang} o={o} showReturn={mode === "returns"} onOpen={() => navigate(`/ecommerce/orders/${encodeURIComponent(o.shopify_id)}`)} />)}
        </div>
        <div className="card proc-table-wrap ecom-table-only">
          <div className="sub" style={{ marginBottom: 6 }}>{list.length} {L(lang, "orders", "ઓર્ડર")}{list.length === 300 ? ` · ${L(lang, "showing the latest 300; narrow the filters", "છેલ્લા 300")}` : ""}</div>
          <table className="proc-table">
            <thead><tr>
              <th>{L(lang, "Order", "ઓર્ડર")}</th><th>{L(lang, "Date", "તારીખ")}</th><th>{L(lang, "Customer", "ગ્રાહક")}</th><th>{L(lang, "Products", "પ્રોડક્ટ")}</th>
              <th>{L(lang, "Qty", "નંગ")}</th><th>{L(lang, "Amount", "રકમ")}</th><th>{L(lang, "Payment", "ચુકવણી")}</th><th>{L(lang, "Fulfilment", "ફુલફિલમેન્ટ")}</th>
              <th>{L(lang, "Status", "સ્થિતિ")}</th><th>{L(lang, "Tracking", "ટ્રેકિંગ")}</th>{mode === "returns" && <th>{L(lang, "Returned", "પરત")}</th>}<th>{L(lang, "Updated", "અપડેટ")}</th>
            </tr></thead>
            <tbody>{list.map((o) => {
              const lines = o.ecom_order_lines || [];
              return (
                <tr key={o.shopify_id} style={{ cursor: "pointer" }} onClick={() => navigate(`/ecommerce/orders/${encodeURIComponent(o.shopify_id)}`)}>
                  <td><strong>{o.name}</strong></td>
                  <td>{when(o.shopify_created_at)}</td>
                  <td>{o.customer_name || "—"}</td>
                  <td style={{ whiteSpace: "normal", minWidth: 220 }}>
                    {lines.slice(0, 3).map((l) => (
                      <div key={l.shopify_id} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 2 }}>
                        <Thumb url={l.image_url} size={28} />
                        <span>{l.title}{l.variant_title ? ` · ${l.variant_title}` : ""}{l.sku ? <span className="sub"> · {l.sku}</span> : null}</span>
                      </div>))}
                    {lines.length > 3 && <span className="sub">+{lines.length - 3} {L(lang, "more", "વધુ")}</span>}
                  </td>
                  <td>{lines.reduce((a, l) => a + (l.quantity || 0), 0)}</td>
                  <td>{money(o.total, o.currency)}</td>
                  <td>{pretty(o.financial_status)}</td>
                  <td>{pretty(o.fulfillment_status)}</td>
                  <td><StageBadge lang={lang} stage={o.stage} /></td>
                  <td>{(o.tracking || []).map((t, i) => <div key={i}>{t.url ? <a href={t.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{t.number || t.company}</a> : t.number}{t.company ? <span className="sub"> · {t.company}</span> : null}</div>)}{!(o.tracking || []).length && "—"}</td>
                  {mode === "returns" && <td>{o.returned_qty || 0}{o.return_status && o.return_status !== "NO_RETURN" ? <span className="sub"> · {pretty(o.return_status)}</span> : null}</td>}
                  <td>{when(o.shopify_updated_at)}</td>
                </tr>);
            })}</tbody>
          </table>
        </div>
        </>
      )}
    </EcomPage>
  );
}

// Phone layout of one order: first product image, order number + status, customer, products, quantity / amount / payment.
function OrderCard({ lang, o, showReturn, onOpen }) {
  const lines = o.ecom_order_lines || [];
  const qty = lines.reduce((a, l) => a + (l.quantity || 0), 0);
  const names = lines.map((l) => l.title + (l.variant_title ? ` · ${l.variant_title}` : "")).join(", ");
  const track = (o.tracking || [])[0];
  return (
    <button type="button" className="ecom-card" onClick={onOpen}>
      <Thumb url={lines[0]?.image_url} size={48} />
      <div style={{ minWidth: 0 }}>
        <div className="ecom-card-top">
          <span className="ecom-card-title">{o.name}</span>
          <StageBadge lang={lang} stage={o.stage} />
        </div>
        <div className="ecom-card-line">{when(o.shopify_created_at)}{o.customer_name ? ` · ${o.customer_name}` : ""}</div>
        <div className="ecom-card-line">{names || "—"}</div>
        <div className="ecom-card-stats">
          <span>{L(lang, "Qty", "નંગ")} <strong>{qty}</strong></span>
          <span><strong>{money(o.total, o.currency)}</strong></span>
          <span>{pretty(o.financial_status)}</span>
          {track && <span>{L(lang, "Tracking", "ટ્રેકિંગ")} <strong>{track.number || track.company}</strong></span>}
          {showReturn && o.returned_qty > 0 && <span>{L(lang, "Returned", "પરત")} <strong>{o.returned_qty}</strong></span>}
        </div>
      </div>
    </button>
  );
}

const EVENT = {
  RECEIVED: ["Order received", "ઓર્ડર મળ્યો"], CANCELLED: ["Cancelled", "રદ"], FULFILMENT_CREATED: ["Fulfilment created", "ફુલફિલમેન્ટ બનાવ્યું"],
  IN_TRANSIT: ["In transit", "રસ્તામાં"], DELIVERED: ["Delivered (carrier confirmed)", "પહોંચાડ્યું"], REFUND: ["Refund", "રિફંડ"],
  STAGE: ["Status", "સ્થિતિ"], PAYMENT: ["Payment", "ચુકવણી"],
};

export function EcomOrderDetail({ lang }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => { setError(null); try { setD(await orderDetail(decodeURIComponent(id))); } catch (e) { setError(e); } }, [id]);
  useEffect(() => { load(); }, [load]);
  const o = d?.order;
  return (
    <EcomPage lang={lang} icon="🧾" title={o ? `Order ${o.name}` : "Order"} titleGu={o ? `ઓર્ડર ${o.name}` : "ઓર્ડર"}
      sub={o ? `${when(o.shopify_created_at)} · ${o.customer_name || L(lang, "customer name not shared by Shopify", "ગ્રાહકનું નામ નથી")}` : null}>
      {error && <LoadError lang={lang} error={error} onRetry={load} />}
      {d && !o && <Empty lang={lang}>{L(lang, "Order not found (or not synchronised yet).", "ઓર્ડર મળ્યો નથી.")}</Empty>}
      {o && (
        <>
          <div className="card" style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
            <div><div className="sub">{L(lang, "Status", "સ્થિતિ")}</div><StageBadge lang={lang} stage={o.stage} /></div>
            <div><div className="sub">{L(lang, "Payment", "ચુકવણી")}</div><strong>{pretty(o.financial_status)}</strong></div>
            <div><div className="sub">{L(lang, "Fulfilment", "ફુલફિલમેન્ટ")}</div><strong>{pretty(o.fulfillment_status)}</strong></div>
            <div><div className="sub">{L(lang, "Return", "રિટર્ન")}</div><strong>{pretty(o.return_status)}</strong></div>
            <div><div className="sub">{L(lang, "Total", "કુલ")}</div><strong>{money(o.total, o.currency)}</strong></div>
            {o.delivered_at && <div><div className="sub">{L(lang, "Delivered", "પહોંચાડ્યું")}</div><strong>{when(o.delivered_at)}</strong></div>}
            {o.cancelled_at && <div><div className="sub">{L(lang, "Cancelled", "રદ")}</div><strong>{when(o.cancelled_at)}</strong>{o.cancel_reason ? ` · ${pretty(o.cancel_reason)}` : ""}</div>}
            <div><div className="sub">{L(lang, "Last updated in Shopify", "Shopify માં છેલ્લું અપડેટ")}</div><strong>{when(o.shopify_updated_at)}</strong></div>
          </div>
          <div className="card proc-table-wrap">
            <div className="section-title" style={{ marginTop: 0 }}>{L(lang, "Items", "આઇટમ")}</div>
            <table className="proc-table">
              <thead><tr><th /><th>{L(lang, "Product", "પ્રોડક્ટ")}</th><th>SKU</th><th>{L(lang, "Ordered", "ઓર્ડર")}</th><th>{L(lang, "Fulfilled", "મોકલ્યું")}</th>
                <th>{L(lang, "Refunded", "રિફંડ")}</th><th>{L(lang, "Restocked", "ફરી સ્ટોકમાં")}</th><th>{L(lang, "Price", "કિંમત")}</th></tr></thead>
              <tbody>{d.lines.map((l) => (
                <tr key={l.shopify_id} style={{ cursor: l.product_id ? "pointer" : undefined }} onClick={() => l.product_id && navigate(`/ecommerce/products/${encodeURIComponent(l.product_id)}`)}>
                  <td><Thumb url={l.image_url} /></td><td>{l.title}{l.variant_title ? <span className="sub"> · {l.variant_title}</span> : null}</td><td>{l.sku || "—"}</td>
                  <td>{l.quantity}</td><td>{l.fulfilled_quantity}</td><td>{l.refunded_quantity}</td><td>{l.restocked_quantity}</td><td>{money(l.price, o.currency)}</td>
                </tr>))}</tbody>
            </table>
          </div>
          <div className="card">
            <div className="section-title" style={{ marginTop: 0 }}>{L(lang, "Shipments", "શિપમેન્ટ")}</div>
            {(o.fulfillments || []).length === 0 ? <div className="sub">{L(lang, "Not fulfilled yet.", "હજુ મોકલ્યું નથી.")}</div> : (o.fulfillments || []).map((f) => (
              <div key={f.id} style={{ marginBottom: 6 }}>
                <strong>{pretty(f.display_status || f.status)}</strong> <span className="sub">· {when(f.created_at)}{f.in_transit_at ? ` · ${L(lang, "in transit", "રસ્તામાં")} ${when(f.in_transit_at)}` : ""}{f.delivered_at ? ` · ${L(lang, "delivered", "પહોંચાડ્યું")} ${when(f.delivered_at)}` : ""}</span>
                {(o.tracking || []).filter((t) => t.fulfillment_id === f.id).map((t, i) => (
                  <div key={i} className="sub">{t.company || ""} {t.url ? <a href={t.url} target="_blank" rel="noreferrer">{t.number || t.url}</a> : t.number}</div>))}
              </div>))}
          </div>
          <div className="card">
            <div className="section-title" style={{ marginTop: 0 }}>{L(lang, "History", "ઇતિહાસ")}</div>
            <ul className="proc-history">
              {d.events.map((e) => (
                <li key={e.id}><strong>{L(lang, ...(EVENT[e.kind] || [e.kind, e.kind]))}</strong>{e.value && !["FULFILMENT_CREATED", "IN_TRANSIT", "DELIVERED", "REFUND"].includes(e.kind) ? `: ${pretty(e.value)}` : ""} <span className="sub">· {when(e.at)}</span></li>))}
            </ul>
            <div className="sub">{L(lang, "History starts when the app first synchronised this order; earlier steps come from Shopify's own timestamps.", "ઇતિહાસ પ્રથમ સિંકથી.")}</div>
          </div>
          {d.refunds.length > 0 && (
            <div className="card">
              <div className="section-title" style={{ marginTop: 0 }}>{L(lang, "Refunds", "રિફંડ")}</div>
              {d.refunds.map((r) => (
                <div key={r.shopify_id} className="sub">{day(r.shopify_created_at)} · {(r.lines || []).map((x) => `${x.quantity} × ${pretty(x.restock_type)}${x.restocked ? ` (${L(lang, "restocked", "ફરી સ્ટોકમાં")})` : ""}`).join(", ")}{r.note ? ` · ${r.note}` : ""}</div>))}
            </div>)}
        </>
      )}
    </EcomPage>
  );
}
