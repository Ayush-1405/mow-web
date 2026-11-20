import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  listCategories, listVendors, placeOrderWithVendors, recommendVendors, uploadOrderFile, vendorHistory, vendorPerformance, whatsappHref,
} from "../../lib/procurementApi";
import { L, TIER_LABELS, VENDOR_LEVELS, fmtDate, telHref, todayIST, vendorLevel, vendorSelectable } from "../../lib/procurementRules";
import { friendlyError } from "../../lib/friendlyError";

// Step 2 for order forms: choose a vendor for every line -- from recommendations built only from the vendor master,
// past purchases and quotations on record (proc_recommend_vendors) or by searching the vendor master -- then enter each
// vendor's PO / reference and expected date. One vendor can take all lines, or lines can be split between vendors.

const num = (n) => (n === null || n === undefined || n === "" ? null : Number(n));
const rs = (n) => (num(n) === null ? "—" : `Rs ${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);

export default function VendorSelection({ lang, req, items, onPlaced, isWorkOrder }) {
  const lines = useMemo(() => [...items].sort((a, b) => (a.line_no || 0) - (b.line_no || 0)), [items]);
  const [recs, setRecs] = useState([]);
  const [recError, setRecError] = useState(null);
  const [vendors, setVendors] = useState([]);
  const [cats, setCats] = useState([]);
  const [perf, setPerf] = useState({});
  const [loading, setLoading] = useState(true);
  const [alloc, setAlloc] = useState({}); // itemId -> vendorId
  const [rates, setRates] = useState({}); // itemId -> rate text
  const [vd, setVd] = useState({}); // vendorId -> { vendor_po_reference, quotation_reference, expected_delivery_date }
  const [common, setCommon] = useState({ order_date: todayIST(), payment_terms: "", remarks: "", scope_of_work: "", late_reason: "" });
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({ q: "", category: "", preferred: false, location: "", maxDays: "", maxPrice: "" });
  const [targetLine, setTargetLine] = useState("ALL");
  const [historyOf, setHistoryOf] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const [r, v, c] = await Promise.all([recommendVendors(req.id), listVendors(), listCategories()]);
      if (!live) return;
      if (r.error) setRecError(friendlyError(r.error.message));
      setRecs(r.data || []);
      const vs = (v.data || []).filter(vendorSelectable);
      setVendors(vs);
      setCats(c.data || []);
      const p = await vendorPerformance(vs.map((x) => x.id));
      if (!live) return;
      setPerf(p);
      setLoading(false);
    })();
    return () => { live = false; };
  }, [req.id]);
  // Rates start from the order's own rate, otherwise empty: a past rate is shown on the card, never filled in silently.
  useEffect(() => {
    setRates((r) => ({ ...Object.fromEntries(lines.map((i) => [i.id, i.rate != null ? String(i.rate) : ""])), ...r }));
  }, [lines]);

  const vById = useMemo(() => Object.fromEntries(vendors.map((v) => [v.id, v])), [vendors]);
  const recFor = useMemo(() => {
    const m = {};
    recs.forEach((r) => { (m[r.item_id] = m[r.item_id] || []).push(r); });
    return m;
  }, [recs]);
  const catName = (code) => { const c = cats.find((x) => x.code === code); return c ? (lang === "gu" ? c.name_gu || c.name_en : c.name_en) : code; };
  // Vendors who were recommended for every line can take the whole order.
  const combined = useMemo(() => new Set(recs.filter((r) => r.combined).map((r) => r.vendor_id)), [recs]);

  function priceOf(r) { return num(r.quote_amount) ?? num(r.last_rate); }
  function passes(v, rec) {
    if (!v) return false;
    if (filters.category && !(v.categories || []).includes(filters.category)) return false;
    if (filters.preferred && !["PREFERRED", "HIGHLY_PREFERRED"].includes(vendorLevel(v))) return false;
    if (filters.location && !String(v.address || "").toLowerCase().includes(filters.location.trim().toLowerCase())) return false;
    if (filters.maxDays !== "" && (v.avg_delivery_days == null || Number(v.avg_delivery_days) > Number(filters.maxDays))) return false;
    if (filters.maxPrice !== "") { const p = rec ? priceOf(rec) : null; if (p === null || p > Number(filters.maxPrice)) return false; }
    if (filters.q) {
      const q = filters.q.trim().toLowerCase();
      const hay = [v.name, v.vendor_code, v.contact_person, v.mobile, v.gstin, v.address, v.specifications, ...(v.brands || []), ...(v.categories || []).map(catName)].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function choose(vendorId, itemId) {
    const ids = itemId === "ALL" ? lines.map((i) => i.id) : [itemId];
    setAlloc((a) => ({ ...a, ...Object.fromEntries(ids.map((x) => [x, vendorId])) }));
    const v = vById[vendorId];
    setVd((d) => (d[vendorId] ? d : { ...d, [vendorId]: { vendor_po_reference: "", quotation_reference: recs.find((r) => r.vendor_id === vendorId && r.quote_reference)?.quote_reference || "",
      expected_delivery_date: v?.avg_delivery_days != null ? addDays(common.order_date, v.avg_delivery_days) : "" } }));
    if (!common.payment_terms && v?.payment_terms) setCommon((c) => ({ ...c, payment_terms: v.payment_terms }));
    setError(null);
  }

  const groups = useMemo(() => {
    const g = {};
    lines.forEach((i) => { const v = alloc[i.id]; if (v) (g[v] = g[v] || []).push(i); });
    return g;
  }, [alloc, lines]);
  const missing = lines.filter((i) => !alloc[i.id]);
  const late = Object.keys(groups).some((v) => vd[v]?.expected_delivery_date && req.required_by_date && vd[v].expected_delivery_date > req.required_by_date);
  const lineAmount = (i) => { const r = num(rates[i.id]); return r === null ? num(i.amount) : r * Number(i.quantity ?? 1); };
  const total = lines.reduce((s, i) => s + (lineAmount(i) || 0), 0);

  async function submit() {
    setError(null);
    if (missing.length) { setError(L(lang, `Choose a vendor for line ${missing.map((i) => i.line_no).join(", ")}.`, `લાઇન ${missing.map((i) => i.line_no).join(", ")} માટે વેન્ડર પસંદ કરો.`)); return; }
    for (const v of Object.keys(groups)) {
      const d = vd[v] || {};
      if (!d.vendor_po_reference?.trim()) { setError(L(lang, `Enter the PO / reference number for ${vById[v]?.name}.`, `${vById[v]?.name} માટે PO / સંદર્ભ નંબર લખો.`)); return; }
      if (!d.expected_delivery_date) { setError(L(lang, `Enter the expected delivery date for ${vById[v]?.name}.`, `${vById[v]?.name} માટે અપેક્ષિત તારીખ લખો.`)); return; }
    }
    if (late && !common.late_reason.trim()) { setError(L(lang, "Delivery is after the due date: give the reason or the agreed new commitment.", "ડિલિવરી નિયત તારીખ પછી છે: કારણ લખો.")); return; }
    if (isWorkOrder && !common.scope_of_work.trim()) { setError(L(lang, "Scope of work is required for a work order.", "વર્ક ઓર્ડર માટે કામનો વ્યાપ જરૂરી છે.")); return; }
    const allocations = lines.map((i) => ({ item_id: i.id, vendor_id: alloc[i.id], rate: rates[i.id] ?? "", ...vd[alloc[i.id]] }));
    setBusy(true);
    const { error: e } = await placeOrderWithVendors(req.id, allocations, common);
    if (e) { setBusy(false); setError(friendlyError(e.message)); return; }
    const failed = [];
    for (const f of files) { const { error: ue } = await uploadOrderFile(req.id, f); if (ue) failed.push(f.name); }
    setBusy(false);
    onPlaced(failed.length ? L(lang, "These files did not upload: ", "આ ફાઇલો અપલોડ ન થઈ: ") + failed.join(", ") : null);
  }

  if (loading) return <div className="card"><div className="skeleton-block" style={{ height: 160 }} /></div>;

  const card = (v, rec, itemId) => (
    <VendorCard key={`${v.id}-${itemId}`} v={v} rec={rec} lang={lang} perf={perf[v.id]} catName={catName} combined={combined.has(v.id)}
      chosen={itemId === "ALL" ? lines.every((i) => alloc[i.id] === v.id) : alloc[itemId] === v.id}
      onSelect={() => choose(v.id, itemId)} onSelectAll={lines.length > 1 && itemId !== "ALL" ? () => choose(v.id, "ALL") : null}
      onHistory={() => setHistoryOf(historyOf === v.id ? null : v.id)} showHistory={historyOf === v.id} />
  );

  const manual = vendors.filter((v) => passes(v, recs.find((r) => r.vendor_id === v.id && (targetLine === "ALL" || r.item_id === targetLine))));

  return (
    <div className="card">
      <h2>{L(lang, "Step 2 — SELECT VENDOR & CONFIRM ORDER PLACED", "પગલું 2 — વેન્ડર પસંદ કરો અને ઓર્ડરની પુષ્ટિ કરો")}</h2>

      <div className="vs-group" style={{ background: "var(--surface)" }}>
        <b>{L(lang, "ORDER REQUIREMENTS", "ઓર્ડરની જરૂરિયાત")}</b>
        <div className="sub">{[req.request_number, req.required_by_date && `${L(lang, "Due", "નિયત")} ${fmtDate(req.required_by_date)}`, req.delivery_location].filter(Boolean).join(" · ")}</div>
        <ol style={{ margin: "6px 0 0", paddingLeft: 20 }}>
          {lines.map((i) => <li key={i.id}>{i.description}{i.qty_size && <span className="sub"> · {i.qty_size}</span>}{i.item_code && <span className="sub"> · {i.item_code}</span>}</li>)}
        </ol>
      </div>

      {recError && <div className="msg info">{L(lang, "Recommendations are not available: ", "ભલામણ ઉપલબ્ધ નથી: ")}{recError}</div>}
      {vendors.length === 0 && (
        <div className="msg info">{L(lang, "No active vendors in the vendor master yet. ", "વેન્ડર માસ્ટરમાં હજુ સક્રિય વેન્ડર નથી. ")}
          <Link to="/procurement/vendors">{L(lang, "Add vendors", "વેન્ડર ઉમેરો")}</Link></div>
      )}

      {lines.map((i) => {
        const list = (recFor[i.id] || []).filter((r) => vById[r.vendor_id] && passes(vById[r.vendor_id], r));
        const chosen = alloc[i.id] && vById[alloc[i.id]];
        return (
          <div key={i.id} className={`vs-line${chosen ? " done" : ""}`}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <b>{i.line_no}. {i.description} {i.qty_size && <span className="sub">· {i.qty_size}</span>}</b>
              <span className="sub">{chosen ? `✅ ${chosen.name}` : L(lang, "No vendor chosen", "વેન્ડર પસંદ નથી")}
                {(recFor[i.id]?.[0]?.item_categories || []).length > 0 && ` · ${recFor[i.id][0].item_categories.map(catName).join(", ")}`}</span>
            </div>
            {list.length === 0 ? (
              <div className="sub">{L(lang, "No vendor in the master matches this line by category, brand, past purchase or quotation. Search below.", "આ લાઇન માટે કોઈ મેળ ખાતો વેન્ડર નથી. નીચે શોધો.")}</div>
            ) : [1, 2, 3].map((t) => {
              const tier = list.filter((r) => r.tier === t);
              if (!tier.length) return null;
              return (
                <div key={t}>
                  <div className="vs-tier">{L(lang, ...TIER_LABELS[t])}</div>
                  <div className="vs-cards">{tier.map((r) => card(vById[r.vendor_id], r, i.id))}</div>
                </div>
              );
            })}
          </div>
        );
      })}

      <details className="vs-line" open={vendors.length > 0 && recs.length === 0}>
        <summary style={{ cursor: "pointer", fontWeight: 700 }}>{L(lang, "Search the vendor master", "વેન્ડર માસ્ટરમાં શોધો")}</summary>
        <div className="form-grid" style={{ marginTop: 8 }}>
          <div className="field"><input type="search" value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} placeholder={L(lang, "Name, brand, GSTIN, mobile", "નામ, બ્રાન્ડ, GSTIN, મોબાઇલ")} /></div>
          <div className="field">
            <select value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))} aria-label={L(lang, "Category", "કેટેગરી")}>
              <option value="">{L(lang, "All categories", "બધી કેટેગરી")}</option>
              {cats.map((c) => <option key={c.code} value={c.code}>{lang === "gu" ? c.name_gu || c.name_en : c.name_en}</option>)}
            </select>
          </div>
          <div className="field"><input value={filters.location} onChange={(e) => setFilters((f) => ({ ...f, location: e.target.value }))} placeholder={L(lang, "Location", "સ્થળ")} /></div>
          <div className="field"><input inputMode="numeric" value={filters.maxDays} onChange={(e) => setFilters((f) => ({ ...f, maxDays: e.target.value.replace(/\D/g, "") }))} placeholder={L(lang, "Max delivery days", "મહત્તમ ડિલિવરી દિવસ")} /></div>
          <div className="field"><input inputMode="decimal" value={filters.maxPrice} onChange={(e) => setFilters((f) => ({ ...f, maxPrice: e.target.value.replace(/[^\d.]/g, "") }))} placeholder={L(lang, "Max price (past rate / quote)", "મહત્તમ ભાવ")} /></div>
          <label className="field" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={filters.preferred} onChange={(e) => setFilters((f) => ({ ...f, preferred: e.target.checked }))} style={{ width: "auto", margin: 0 }} />
            {L(lang, "Preferred only", "ફક્ત પસંદગીના")}
          </label>
          <div className="field full">
            <label>{L(lang, "Select for", "કોના માટે પસંદ કરો")}</label>
            <select value={targetLine} onChange={(e) => setTargetLine(e.target.value)}>
              <option value="ALL">{L(lang, "All lines", "બધી લાઇન")}</option>
              {lines.map((i) => <option key={i.id} value={i.id}>{i.line_no}. {i.description}</option>)}
            </select>
          </div>
        </div>
        {filters.maxPrice !== "" && <div className="sub">{L(lang, "The price filter uses past rates and quotations on record; vendors without one are hidden.", "ભાવ ફિલ્ટર જૂના ભાવ/ભાવપત્રક પર આધારિત છે.")}</div>}
        <div className="vs-cards" style={{ marginTop: 8 }}>
          {manual.slice(0, 40).map((v) => card(v, null, targetLine))}
        </div>
        {manual.length === 0 && <div className="sub">{L(lang, "No vendor matches.", "કોઈ વેન્ડર મળ્યો નહીં.")}</div>}
      </details>

      {Object.keys(groups).length > 0 && <h3 style={{ marginTop: 14 }}>{L(lang, "Order details per vendor", "વેન્ડર મુજબ ઓર્ડર વિગતો")}</h3>}
      {Object.entries(groups).map(([vid, its]) => {
        const v = vById[vid];
        const d = vd[vid] || {};
        const setD = (k, val) => setVd((x) => ({ ...x, [vid]: { ...x[vid], [k]: val } }));
        const isLate = d.expected_delivery_date && req.required_by_date && d.expected_delivery_date > req.required_by_date;
        return (
          <div key={vid} className="vs-group">
            <div style={{ fontWeight: 700 }}>{v?.name} <span className="sub">{v?.vendor_code}</span></div>
            <div className="sub">{[v?.contact_person, v?.mobile, v?.email, v?.gstin && `GSTIN ${v.gstin}`, v?.payment_terms && `${L(lang, "Terms", "શરતો")}: ${v.payment_terms}`].filter(Boolean).join(" · ")}</div>
            {v?.address && <div className="sub">{v.address}</div>}
            <div className="proc-table-wrap" style={{ marginTop: 6 }}>
              <table className="proc-table">
                <thead><tr><th>#</th><th>{L(lang, "Item", "આઇટમ")}</th><th>{L(lang, "Rate", "ભાવ")}</th><th>{L(lang, "Amount", "રકમ")}</th></tr></thead>
                <tbody>{its.map((i) => (
                  <tr key={i.id}>
                    <td>{i.line_no}</td>
                    <td style={{ whiteSpace: "normal" }}>{i.description} {i.qty_size && <span className="sub">· {i.qty_size}</span>}</td>
                    <td><input inputMode="decimal" style={{ width: 110, margin: 0 }} value={rates[i.id] ?? ""} onChange={(e) => setRates((r) => ({ ...r, [i.id]: e.target.value.replace(/[^\d.]/g, "") }))} /></td>
                    <td>{rs(lineAmount(i))}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="form-grid">
              <div className="field"><label>{L(lang, "Vendor PO / reference number", "વેન્ડર PO / સંદર્ભ નંબર")} *</label><input value={d.vendor_po_reference || ""} onChange={(e) => setD("vendor_po_reference", e.target.value)} /></div>
              <div className="field"><label>{L(lang, "Quotation reference", "ભાવપત્રક સંદર્ભ")}</label><input value={d.quotation_reference || ""} onChange={(e) => setD("quotation_reference", e.target.value)} /></div>
              <div className="field"><label>{L(lang, "Expected delivery", "અપેક્ષિત ડિલિવરી")} *</label><input type="date" min={common.order_date} value={d.expected_delivery_date || ""} onChange={(e) => setD("expected_delivery_date", e.target.value)} />
                {isLate && <div className="vs-warn">⚠ {L(lang, `After the due date (${fmtDate(req.required_by_date)})`, `નિયત તારીખ (${fmtDate(req.required_by_date)}) પછી`)}</div>}</div>
            </div>
          </div>
        );
      })}

      {Object.keys(groups).length > 0 && (
        <div className="form-grid" style={{ marginTop: 10 }}>
          <div className="field"><label>{L(lang, "Order date", "ઓર્ડર તારીખ")} *</label><input type="date" value={common.order_date} onChange={(e) => setCommon((c) => ({ ...c, order_date: e.target.value }))} /></div>
          <div className="field"><label>{L(lang, "Payment terms", "ચુકવણી શરતો")}</label><input value={common.payment_terms} onChange={(e) => setCommon((c) => ({ ...c, payment_terms: e.target.value }))} /></div>
          <div className="field"><label>{L(lang, "Total", "કુલ")}</label><div style={{ paddingTop: 8, fontWeight: 700 }}>{total ? rs(total) : "—"}</div></div>
          {late && (
            <div className="field full">
              <div className="msg error" style={{ margin: 0 }}>{L(lang, `Expected delivery is after the department's due date (${fmtDate(req.required_by_date)}). Choose another vendor, or give the reason / agreed commitment to continue.`,
                `અપેક્ષિત ડિલિવરી વિભાગની નિયત તારીખ (${fmtDate(req.required_by_date)}) પછી છે. બીજો વેન્ડર પસંદ કરો અથવા કારણ લખો.`)}</div>
              <label style={{ marginTop: 6 }}>{L(lang, "Reason for later delivery", "મોડી ડિલિવરીનું કારણ")} *</label>
              <textarea rows={2} value={common.late_reason} onChange={(e) => setCommon((c) => ({ ...c, late_reason: e.target.value }))} />
            </div>
          )}
          {isWorkOrder && (
            <div className="field full"><label>{L(lang, "Scope of work (work order)", "કામનો વ્યાપ (વર્ક ઓર્ડર)")} *</label>
              <textarea rows={3} value={common.scope_of_work} onChange={(e) => setCommon((c) => ({ ...c, scope_of_work: e.target.value }))} /></div>
          )}
          <div className="field full"><label>{L(lang, "Procurement remarks", "ખરીદી વિભાગની નોંધ")}</label><textarea rows={2} value={common.remarks} onChange={(e) => setCommon((c) => ({ ...c, remarks: e.target.value }))} /></div>
          <div className="field full">
            <label>{L(lang, "Supporting documents (vendor PO, confirmation)", "આધાર દસ્તાવેજ (વેન્ડર PO, પુષ્ટિ)")}</label>
            <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.heic" onChange={(e) => setFiles(Array.from(e.target.files || []))} />
          </div>
        </div>
      )}

      {error && <div className="msg error">{error}</div>}
      <div className="btn-row" style={{ marginTop: 10 }}>
        <button className="btn btn-primary" type="button" style={{ fontSize: 17, minHeight: 52 }} disabled={busy || missing.length > 0} onClick={submit}>
          ✅ {busy ? "…" : L(lang, "Confirm order placed", "ઓર્ડર મૂક્યાની પુષ્ટિ કરો")}
        </button>
        {missing.length > 0 && <span className="sub" style={{ alignSelf: "center" }}>{L(lang, `${missing.length} of ${lines.length} lines still need a vendor`, `${lines.length} માંથી ${missing.length} લાઇન માટે વેન્ડર બાકી`)}</span>}
      </div>
    </div>
  );
}

function addDays(dateStr, days) {
  if (!dateStr || days == null) return "";
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

function VendorCard({ v, rec, lang, perf, catName, combined, chosen, onSelect, onSelectAll, onHistory, showHistory }) {
  const lv = VENDOR_LEVELS.find((x) => x.code === vendorLevel(v));
  const tel = telHref(v.mobile);
  const wa = whatsappHref(v.whatsapp || v.mobile);
  return (
    <div className={`vs-card${chosen ? " chosen" : ""}`}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6, alignItems: "flex-start" }}>
        <b style={{ minWidth: 0, overflowWrap: "anywhere" }}>{v.name}</b>
        <span className={`badge ${lv?.tone || "ASSIGNED"}`}>{L(lang, lv?.en, lv?.gu)}</span>
      </div>
      {combined && <div className="vendor-chip" style={{ alignSelf: "flex-start" }}>{L(lang, "Can supply all lines", "બધી લાઇન પૂરી પાડી શકે")}</div>}
      <div className="sub">{[v.contact_person, v.mobile].filter(Boolean).join(" · ")}</div>
      {(v.categories || []).length > 0 && <div className="vendor-chips">{v.categories.map((c) => <span key={c} className="vendor-chip">{catName(c)}</span>)}</div>}
      {rec?.reasons?.length > 0 && <ul className="vs-reasons">{rec.reasons.map((x) => <li key={x}>{x}</li>)}</ul>}
      <div className="sub">
        {[rec?.last_rate != null && `${L(lang, "Last rate", "છેલ્લો ભાવ")} ${rs(rec.last_rate)}${rec.last_rate_on ? ` (${fmtDate(rec.last_rate_on)})` : ""}`,
          rec?.quote_amount != null && `${L(lang, "Quote", "ભાવપત્રક")} ${rs(rec.quote_amount)}${rec.quote_reference ? ` · ${rec.quote_reference}` : ""}`,
          v.avg_delivery_days != null && `~${v.avg_delivery_days} ${L(lang, "days", "દિવસ")}`,
          v.payment_terms].filter(Boolean).join(" · ")}
      </div>
      {rec?.meets_due === false && <div className="vs-warn">⚠ {L(lang, "Usual delivery time is after the due date", "સામાન્ય ડિલિવરી સમય નિયત તારીખ પછી")}</div>}
      <div className="sub">{perf && perf.total_orders > 0
        ? `${perf.total_orders} ${L(lang, "orders", "ઓર્ડર")}${perf.on_time_pct != null ? ` · ${perf.on_time_pct}% ${L(lang, "on time", "સમયસર")}` : ""}${perf.quality_rejections ? ` · ${perf.quality_rejections} ${L(lang, "rejections", "રિજેક્શન")}` : ""}`
        : L(lang, "No purchase history yet", "હજુ ખરીદી ઇતિહાસ નથી")}</div>
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={onSelect}>{chosen ? "✅ " : ""}{L(lang, "Select", "પસંદ કરો")}</button>
        {onSelectAll && <button type="button" className="btn btn-outline" onClick={onSelectAll}>{L(lang, "All lines", "બધી લાઇન")}</button>}
        <Link className="btn btn-outline" to={`/procurement/vendors?vendor=${v.id}`} target="_blank">{L(lang, "Profile", "પ્રોફાઇલ")}</Link>
        <button type="button" className="btn btn-outline" onClick={onHistory}>{L(lang, "History", "ઇતિહાસ")}</button>
        {tel && <a className="btn btn-outline" href={tel} aria-label={L(lang, "Call", "કૉલ")}>📞</a>}
        {wa && <a className="btn btn-outline" href={wa} target="_blank" rel="noopener noreferrer">WhatsApp</a>}
        {v.email && <a className="btn btn-outline" href={`mailto:${v.email}`} aria-label="Email">✉</a>}
      </div>
      {showHistory && <MiniHistory vendorId={v.id} lang={lang} />}
    </div>
  );
}

function MiniHistory({ vendorId, lang }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { vendorHistory(vendorId).then(({ data }) => setRows(data || [])); }, [vendorId]);
  if (rows === null) return <div className="sub">…</div>;
  if (!rows.length) return <div className="sub">{L(lang, "No purchases recorded.", "કોઈ ખરીદી નોંધાઈ નથી.")}</div>;
  return (
    <ul className="vs-reasons">
      {rows.slice(0, 8).map((h) => (
        <li key={h.id}>{fmtDate(h.created_at)} · {h.purchase_requests?.request_number} · {h.purchase_request_items?.description}{h.rate != null ? ` @ ${rs(h.rate)}` : ""}</li>
      ))}
    </ul>
  );
}
