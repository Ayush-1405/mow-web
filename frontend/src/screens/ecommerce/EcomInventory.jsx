import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { L, MOVEMENT, inventoryReport, listLocations, listMovements, variantsById, when } from "../../lib/ecomApi";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { ConnectionStrip, DateRangeFilter, EcomPage, Empty, LoadError, Thumb, useDateRange } from "./EcomShared.jsx";

// Inventory Sync: per variant for a period -- opening (only when stock history reaches back that far), what went out to orders,
// what Shopify restocked, synced adjustments, closing (finished periods only) and today's synchronised available / committed /
// on-hand quantities. Units ordered / sold come from the orders. Nothing here changes stock.
export default function EcomInventory({ lang }) {
  const navigate = useNavigate();
  const range = useDateRange("thisMonth");
  const location = range.params.get("location") || "";
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search, 350);
  const [rows, setRows] = useState(null);
  const [locs, setLocs] = useState([]);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    if (!range.from || !range.to) return;
    setError(null); setRows(null);
    try { setRows(await inventoryReport(range.from, range.to, location, q)); } catch (e) { setError(e); }
  }, [range.from, range.to, location, q]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { listLocations().then(setLocs).catch(() => {}); }, []);
  const sum = (k) => (rows || []).reduce((a, r) => a + (r[k] || 0), 0);
  const cell = (v) => (v === null || v === undefined ? <span className="sub">{L(lang, "n/a", "નથી")}</span> : v);
  return (
    <EcomPage lang={lang} icon="🔄" title="Inventory Sync" titleGu="ઇન્વેન્ટરી સિંક"
      sub={L(lang, "Shopify is the source of truth: these are Shopify's own quantities, copied — never deducted again here.", "Shopify જ સાચો સ્રોત: અહીં ફરી બાદ થતું નથી.")}>
      <ConnectionStrip lang={lang} onSynced={load} compact />
      <div className="card filter-bar filter-grid">
        <DateRangeFilter lang={lang} range={range} />
        <label className="filter-date-label">{L(lang, "Location", "સ્થાન")}
          <select value={location} onChange={(e) => range.set({ location: e.target.value })}>
            <option value="">{L(lang, "All locations", "બધા સ્થાન")}</option>{locs.map((l) => <option key={l.shopify_id} value={l.shopify_id}>{l.name}{l.is_active ? "" : " (inactive)"}</option>)}
          </select>
        </label>
        <label className="filter-date-label">{L(lang, "Search", "શોધો")}<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={L(lang, "Product or SKU", "પ્રોડક્ટ અથવા SKU")} /></label>
      </div>
      {error && <LoadError lang={lang} error={error} onRetry={load} />}
      {!error && rows === null && <div className="skeleton-block" style={{ height: 160 }} />}
      {rows && rows.length === 0 && <Empty lang={lang}>{L(lang, "No stock synchronised yet.", "હજુ સ્ટોક સિંક થયો નથી.")}</Empty>}
      {rows && rows.length > 0 && (
        <div className="card proc-table-wrap">
          <div className="sub" style={{ marginBottom: 6 }}>
            {L(lang, "Opening stock shows \"n/a\" for periods that start before the first Shopify sync (no history is invented). Closing stock shows only for finished periods.",
              "પ્રથમ સિંક પહેલાંનો શરૂઆતનો સ્ટોક ઉપલબ્ધ નથી.")}
          </div>
          <table className="proc-table">
            <thead><tr>
              <th /><th>{L(lang, "Product", "પ્રોડક્ટ")}</th><th>SKU</th><th>{L(lang, "Opening", "શરૂઆત")}</th><th>{L(lang, "Out to orders", "ઓર્ડરમાં ગયો")}</th>
              <th>{L(lang, "Restocked (cancel/return)", "ફરી સ્ટોકમાં")}</th><th>{L(lang, "Adjusted +", "ફેરફાર +")}</th><th>{L(lang, "Adjusted −", "ફેરફાર −")}</th>
              <th>{L(lang, "Closing", "અંત")}</th><th>{L(lang, "Available now", "હાલ ઉપલબ્ધ")}</th><th>{L(lang, "Committed", "કમિટેડ")}</th><th>{L(lang, "On hand", "હાથ પર")}</th>
              <th>{L(lang, "Units ordered", "ઓર્ડર થયા")}</th><th>{L(lang, "Units sold", "વેચાયા")}</th>
            </tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.variant_id} style={{ cursor: "pointer" }} title={r.opening_note || ""} onClick={() => navigate(`/ecommerce/products/${encodeURIComponent(r.product_id)}`)}>
                <td><Thumb url={r.image_url} size={32} /></td>
                <td><strong>{r.product_title}</strong>{r.variant_title && r.variant_title !== "Default Title" ? <span className="sub"> · {r.variant_title}</span> : null}</td>
                <td>{r.sku || "—"}</td><td>{cell(r.opening)}</td><td>{r.ordered_out ? `−${r.ordered_out}` : 0}</td><td>{r.restocked_in ? `+${r.restocked_in}` : 0}</td>
                <td>{r.adjust_in ? `+${r.adjust_in}` : 0}</td><td>{r.adjust_out ? `−${r.adjust_out}` : 0}</td><td>{cell(r.closing)}</td>
                <td><strong>{r.available ?? "—"}</strong></td><td>{r.committed ?? "—"}</td><td>{r.on_hand ?? "—"}</td><td>{r.units_ordered}</td><td>{r.units_sold}</td>
              </tr>))}</tbody>
            <tfoot><tr>
              <th /><th>{L(lang, "Total", "કુલ")}</th><th /><th /><th>−{sum("ordered_out")}</th><th>+{sum("restocked_in")}</th><th>+{sum("adjust_in")}</th><th>−{sum("adjust_out")}</th><th />
              <th>{sum("available")}</th><th>{sum("committed")}</th><th>{sum("on_hand")}</th><th>{sum("units_ordered")}</th><th>{sum("units_sold")}</th>
            </tr></tfoot>
          </table>
        </div>
      )}
    </EcomPage>
  );
}

export function EcomMovements({ lang }) {
  const navigate = useNavigate();
  const range = useDateRange("last7");
  const type = range.params.get("type") || "";
  const location = range.params.get("location") || "";
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search, 350);
  const [rows, setRows] = useState(null);
  const [names, setNames] = useState({});
  const [locs, setLocs] = useState([]);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    setError(null); setRows(null);
    try {
      const r = await listMovements({ from: range.from || null, to: range.to || null, type, search: q, location });
      setNames(await variantsById(r.map((m) => m.variant_id)));
      setRows(r);
    } catch (e) { setError(e); }
  }, [range.from, range.to, type, q, location]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { listLocations().then(setLocs).catch(() => {}); }, []);
  const locName = (id) => locs.find((l) => l.shopify_id === id)?.name || String(id).split("/").pop();
  return (
    <EcomPage lang={lang} icon="📜" title="Stock Movement History" titleGu="સ્ટોક હલનચલન ઇતિહાસ"
      sub={L(lang, "Every change in Shopify's available stock, recorded once. A reason is shown only when Shopify's order or refund proves it; otherwise \"Synced adjustment\".",
        "Shopify ના દરેક સ્ટોક ફેરફાર; કારણ સાબિત હોય ત્યારે જ.")}>
      <div className="card filter-bar filter-grid">
        <DateRangeFilter lang={lang} range={range} allowAll />
        <label className="filter-date-label">{L(lang, "Type", "પ્રકાર")}
          <select value={type} onChange={(e) => range.set({ type: e.target.value })}>
            <option value="">{L(lang, "All", "બધા")}</option>{Object.entries(MOVEMENT).map(([k, v]) => <option key={k} value={k}>{L(lang, v[0], v[1])}</option>)}
          </select>
        </label>
        <label className="filter-date-label">{L(lang, "Location", "સ્થાન")}
          <select value={location} onChange={(e) => range.set({ location: e.target.value })}>
            <option value="">{L(lang, "All", "બધા")}</option>{locs.map((l) => <option key={l.shopify_id} value={l.shopify_id}>{l.name}</option>)}
          </select>
        </label>
        <label className="filter-date-label">{L(lang, "Search", "શોધો")}<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={L(lang, "Product or SKU", "પ્રોડક્ટ અથવા SKU")} /></label>
      </div>
      {error && <LoadError lang={lang} error={error} onRetry={load} />}
      {!error && rows === null && <div className="skeleton-block" style={{ height: 160 }} />}
      {rows && rows.length === 0 && <Empty lang={lang}>{L(lang, "No stock movements in this period.", "આ સમયગાળામાં હલનચલન નથી.")}</Empty>}
      {rows && rows.length > 0 && (
        <div className="card proc-table-wrap">
          {rows.length === 500 && <div className="sub">{L(lang, "Showing the latest 500; narrow the filters.", "છેલ્લા 500.")}</div>}
          <table className="proc-table">
            <thead><tr><th>{L(lang, "When", "ક્યારે")}</th><th>{L(lang, "Product", "પ્રોડક્ટ")}</th><th>SKU</th><th>{L(lang, "Location", "સ્થાન")}</th>
              <th>{L(lang, "Before", "પહેલાં")}</th><th>{L(lang, "Change", "ફેરફાર")}</th><th>{L(lang, "After", "પછી")}</th><th>{L(lang, "Type", "પ્રકાર")}</th>
              <th>{L(lang, "Reference", "સંદર્ભ")}</th><th>{L(lang, "Source", "સ્રોત")}</th></tr></thead>
            <tbody>{rows.map((m) => {
              const v = names[m.variant_id];
              return (
                <tr key={m.id} style={{ cursor: m.order_id || v ? "pointer" : undefined }}
                  onClick={() => (m.order_id ? navigate(`/ecommerce/orders/${encodeURIComponent(m.order_id)}`) : v && navigate(`/ecommerce/products/${encodeURIComponent(v.product_id)}`))}>
                  <td>{when(m.occurred_at)}</td>
                  <td>{v ? <>{v.product_title}{v.variant_title && v.variant_title !== "Default Title" ? <span className="sub"> · {v.variant_title}</span> : null}</> : <span className="sub">{L(lang, "(removed product)", "(કાઢેલ પ્રોડક્ટ)")}</span>}</td>
                  <td>{m.sku || v?.sku || "—"}</td><td>{locName(m.location_id)}</td><td>{m.previous_qty ?? "—"}</td>
                  <td><strong style={{ color: m.movement_type === "BASELINE" ? undefined : m.change > 0 ? "var(--success)" : m.change < 0 ? "var(--danger)" : undefined }}>{m.movement_type === "BASELINE" ? "—" : m.change > 0 ? `+${m.change}` : m.change}</strong></td><td>{m.new_qty}</td>
                  <td>{L(lang, ...(MOVEMENT[m.movement_type] || [m.movement_type, m.movement_type]))}</td>
                  <td style={{ whiteSpace: "normal", minWidth: 180 }}>{m.reference || "—"}</td>
                  <td className="sub">{m.source.replace(/_/g, " ").toLowerCase()}</td>
                </tr>);
            })}</tbody>
          </table>
        </div>
      )}
    </EcomPage>
  );
}
