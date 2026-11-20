import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  getVendorNotes, listCategories, listOrders, listVendorDocuments, listVendors, openVendorDocument, saveCategory, saveVendorMaster, setVendorRating,
  uploadVendorDocument, vendorHistory, vendorPerformance, whatsappHref,
} from "../../lib/procurementApi";
import { L, VENDOR_LEVELS, fmtDate, procurementRoles, telHref, vendorLevel } from "../../lib/procurementRules";
import { subscribeTable } from "../../lib/realtime";
import { friendlyError } from "../../lib/friendlyError";
import { useDebouncedValue } from "../../lib/useDebouncedValue";

// Vendor Master: one record per supplier -- contacts, the material categories and brands they supply, delivery time,
// payment terms, preference set by Management / the Procurement Head, documents and internal remarks -- with their real
// purchase history and delivery performance. Procurement and Management maintain it; recommendations on orders use it.

const BLANK = { name: "", contact_person: "", mobile: "", whatsapp: "", email: "", address: "", gstin: "", pan: "", categories: [], brands_text: "",
  specifications: "", payment_terms: "", credit_period: "", avg_delivery_days: "", notes: "", internal_remarks: "", is_active: true };
const FIELDS = [
  ["name", "Company name *", "કંપનીનું નામ *"], ["contact_person", "Contact person", "સંપર્ક વ્યક્તિ"], ["mobile", "Mobile *", "મોબાઇલ *"],
  ["whatsapp", "WhatsApp", "વોટ્સએપ"], ["email", "Email", "ઇમેઇલ"], ["gstin", "GSTIN", "GSTIN"], ["pan", "PAN", "PAN"],
  ["payment_terms", "Payment terms", "ચુકવણી શરતો"], ["credit_period", "Credit period", "ક્રેડિટ સમય"], ["avg_delivery_days", "Average delivery (days)", "સરેરાશ ડિલિવરી (દિવસ)"],
];
const money = (n) => `Rs ${Math.round(Number(n || 0)).toLocaleString("en-IN")}`;

export default function ProcurementVendors({ lang, profile, lookups }) {
  const roles = useMemo(() => procurementRoles(profile, lookups.departments), [profile, lookups.departments]);
  const canRate = roles.isProcurementHead || roles.isManagement;
  const canEdit = roles.isProcurement || roles.isManagement;
  const [params] = useSearchParams();
  const [vendors, setVendors] = useState([]);
  const [cats, setCats] = useState([]);
  const [perf, setPerf] = useState({});
  const [legacyOrders, setLegacyOrders] = useState({});
  const [state, setState] = useState({ loading: true, error: null });
  const [form, setForm] = useState(null);
  const [editId, setEditId] = useState(null);
  const [open, setOpen] = useState(params.get("vendor") || null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [showCats, setShowCats] = useState(false);
  const q = useDebouncedValue(search, 250).trim().toLowerCase();

  const load = useCallback(async () => {
    const [v, c, o] = await Promise.all([listVendors(), listCategories(), listOrders({ limit: 2000 })]);
    if (v.error) { setState({ loading: false, error: friendlyError(v.error.message) }); return; }
    setVendors(v.data || []);
    setCats(c.data || []);
    const counts = {};
    (o.data || []).forEach((x) => { if (x.vendor_id) counts[x.vendor_id] = (counts[x.vendor_id] || 0) + 1; });
    setLegacyOrders(counts);
    setPerf(canEdit ? await vendorPerformance((v.data || []).map((x) => x.id)) : {});
    setState({ loading: false, error: null });
  }, [canEdit]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("procurement-vendors", "vendors", null, () => load()), [load]);

  const catName = useCallback((code) => cats.find((c) => c.code === code)?.[lang === "gu" ? "name_gu" : "name_en"] || cats.find((c) => c.code === code)?.name_en || code, [cats, lang]);
  const visible = useMemo(() => vendors.filter((v) => {
    if (catFilter && !(v.categories || []).includes(catFilter)) return false;
    if (levelFilter && vendorLevel(v) !== levelFilter) return false;
    if (!q) return true;
    return [v.name, v.vendor_code, v.contact_person, v.mobile, v.gstin, v.address, v.specifications, ...(v.brands || []), ...(v.categories || []).map(catName)]
      .filter(Boolean).some((x) => String(x).toLowerCase().includes(q));
  }).sort((a, b) => {
    const rank = { HIGHLY_PREFERRED: 0, PREFERRED: 1, REGULAR: 2, TEMPORARILY_BLOCKED: 3, BLACKLISTED: 4 };
    return rank[vendorLevel(a)] - rank[vendorLevel(b)] || a.name.localeCompare(b.name);
  }), [vendors, catFilter, levelFilter, q, catName]);

  async function act(fn, after, ok) {
    setBusy(true); setMsg(null);
    const { error } = await fn();
    setBusy(false);
    if (error) { setMsg({ kind: "error", text: friendlyError(error.message) }); return false; }
    if (ok) setMsg({ kind: "success", text: ok });
    if (after) after();
    load();
    return true;
  }

  async function edit(v) {
    const { data } = await getVendorNotes(v.id);
    setForm({ ...BLANK, ...v, brands_text: (v.brands || []).join(", "), avg_delivery_days: v.avg_delivery_days ?? "", internal_remarks: data?.remarks || "" });
    setEditId(v.id);
    window.scrollTo({ top: 0 });
  }
  function save(e) {
    e.preventDefault();
    const p = { ...form, brands: form.brands_text.split(",").map((x) => x.trim()).filter(Boolean), categories: form.categories };
    act(() => saveVendorMaster(editId, p), () => setForm(null), L(lang, "Vendor saved.", "વેન્ડર સાચવ્યો."));
  }

  if (state.loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 300 }} /></div>;
  if (state.error) return <div className="dept-dashboard"><div className="msg error">{state.error}</div><button className="btn btn-primary" onClick={load}>{L(lang, "Retry", "ફરી પ્રયાસ")}</button></div>;

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🏢</div>
        <div className="dept-header-text">
          <h1>{L(lang, "Vendor master", "વેન્ડર માસ્ટર")}</h1>
          <div className="sub">{L(lang, "Categories, brands and preference here decide which vendors are recommended on each order.", "અહીંની કેટેગરી, બ્રાન્ડ અને પસંદગી પરથી દરેક ઓર્ડર પર વેન્ડર સૂચવાય છે.")}</div>
        </div>
        <div className="btn-row" style={{ marginLeft: "auto" }}>
          {canRate && <button className="btn btn-outline" style={{ width: "auto" }} onClick={() => setShowCats((x) => !x)}>{L(lang, "Material categories", "મટિરિયલ કેટેગરી")}</button>}
          {canEdit && <button className="btn btn-primary" style={{ width: "auto" }} onClick={() => { setForm({ ...BLANK }); setEditId(null); }}>+ {L(lang, "Add vendor", "વેન્ડર ઉમેરો")}</button>}
        </div>
      </div>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
      {showCats && <CategoryEditor lang={lang} cats={cats} busy={busy} act={act} />}

      {form && (
        <form className="card form-grid" onSubmit={save}>
          <h2 className="field full">{editId ? L(lang, "Edit vendor", "વેન્ડર સુધારો") : L(lang, "New vendor", "નવો વેન્ડર")}</h2>
          {FIELDS.map(([k, en, gu]) => (
            <div className="field" key={k}><label>{L(lang, en, gu)}</label>
              <input value={form[k] ?? ""} inputMode={k === "avg_delivery_days" ? "numeric" : undefined} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} /></div>
          ))}
          <div className="field full"><label>{L(lang, "Complete address", "પૂરું સરનામું")}</label><textarea rows={2} value={form.address || ""} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} /></div>
          <div className="field full">
            <label>{L(lang, "Material / product categories supplied", "પૂરી પાડતી કેટેગરી")}</label>
            <div className="day-picks">
              {cats.filter((c) => c.is_active || form.categories.includes(c.code)).map((c) => (
                <label key={c.code}><input type="checkbox" checked={form.categories.includes(c.code)}
                  onChange={(e) => setForm((f) => ({ ...f, categories: e.target.checked ? [...f.categories, c.code] : f.categories.filter((x) => x !== c.code) }))} />
                  {lang === "gu" ? c.name_gu || c.name_en : c.name_en}</label>
              ))}
            </div>
          </div>
          <div className="field full"><label>{L(lang, "Brands supplied (comma separated)", "બ્રાન્ડ (અલ્પવિરામથી)")}</label><input value={form.brands_text} onChange={(e) => setForm((f) => ({ ...f, brands_text: e.target.value }))} placeholder="Century, Greenply, Hettich" /></div>
          <div className="field full"><label>{L(lang, "Product specifications", "ઉત્પાદન સ્પષ્ટીકરણ")}</label><textarea rows={2} value={form.specifications || ""} onChange={(e) => setForm((f) => ({ ...f, specifications: e.target.value }))} /></div>
          <div className="field full"><label>{L(lang, "Notes", "નોંધ")}</label><textarea rows={2} value={form.notes || ""} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></div>
          <div className="field full"><label>{L(lang, "Internal procurement remarks (Procurement & Management only)", "આંતરિક નોંધ (ફક્ત ખરીદી અને મેનેજમેન્ટ)")}</label>
            <textarea rows={2} value={form.internal_remarks || ""} onChange={(e) => setForm((f) => ({ ...f, internal_remarks: e.target.value }))} /></div>
          <label className="field full" style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 600 }}>
            <input type="checkbox" checked={form.is_active !== false} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))} style={{ width: "auto", margin: 0 }} />
            {L(lang, "Active", "સક્રિય")}
          </label>
          <div className="field full btn-row">
            <button className="btn btn-primary" type="submit" disabled={busy}>{L(lang, "Save vendor", "વેન્ડર સાચવો")}</button>
            <button className="btn btn-outline" type="button" onClick={() => setForm(null)}>{L(lang, "Cancel", "રદ કરો")}</button>
          </div>
        </form>
      )}

      <div className="card form-grid">
        <div className="field"><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={L(lang, "Search name, brand, GSTIN, mobile, location", "નામ, બ્રાન્ડ, GSTIN, મોબાઇલ, સ્થળ શોધો")} /></div>
        <div className="field">
          <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} aria-label={L(lang, "Category", "કેટેગરી")}>
            <option value="">{L(lang, "All categories", "બધી કેટેગરી")}</option>
            {cats.map((c) => <option key={c.code} value={c.code}>{lang === "gu" ? c.name_gu || c.name_en : c.name_en}</option>)}
          </select>
        </div>
        <div className="field">
          <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)} aria-label={L(lang, "Level", "સ્તર")}>
            <option value="">{L(lang, "All levels", "બધા સ્તર")}</option>
            {VENDOR_LEVELS.map((x) => <option key={x.code} value={x.code}>{L(lang, x.en, x.gu)}</option>)}
          </select>
        </div>
      </div>

      <div className="card">
        {visible.length === 0 && <div className="msg info">{L(lang, "No vendors match.", "કોઈ વેન્ડર મળ્યો નહીં.")}</div>}
        {visible.map((v) => (
          <VendorRow key={v.id} v={v} lang={lang} perf={perf[v.id]} legacy={legacyOrders[v.id]} catName={catName} canEdit={canEdit} canRate={canRate}
            busy={busy} act={act} onEdit={() => edit(v)} open={open === v.id} onToggle={() => setOpen(open === v.id ? null : v.id)} />
        ))}
      </div>
    </div>
  );
}

function VendorRow({ v, lang, perf, legacy, catName, canEdit, canRate, busy, act, onEdit, open, onToggle }) {
  const level = vendorLevel(v);
  const lv = VENDOR_LEVELS.find((x) => x.code === level);
  const [rate, setRate] = useState({ level: "", reason: "" });
  const tel = telHref(v.mobile);
  const wa = whatsappHref(v.whatsapp || v.mobile);
  return (
    <div className="proc-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "space-between" }}>
        <div style={{ flex: "1 1 280px", minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>{v.name} <span className="sub">{v.vendor_code}</span>{v.is_active === false && <span className="badge CLOSED" style={{ marginLeft: 6 }}>{L(lang, "Inactive", "નિષ્ક્રિય")}</span>}</div>
          <div className="sub">{[v.contact_person, v.mobile, v.email, v.gstin && `GSTIN ${v.gstin}`].filter(Boolean).join(" · ")}</div>
          <div className="vendor-chips">{(v.categories || []).map((c) => <span key={c} className="vendor-chip">{catName(c)}</span>)}{(v.brands || []).map((b) => <span key={b} className="vendor-chip brand">{b}</span>)}</div>
          <div className="sub">{[v.avg_delivery_days != null && `${L(lang, "Delivers in", "ડિલિવરી")} ~${v.avg_delivery_days} ${L(lang, "days", "દિવસ")}`, v.payment_terms && `${L(lang, "Terms", "શરતો")}: ${v.payment_terms}`, v.address].filter(Boolean).join(" · ")}</div>
          <div className="sub">{perf ? `${perf.total_orders} ${L(lang, "orders", "ઓર્ડર")} · ${money(perf.total_value)}${perf.on_time_pct != null ? ` · ${perf.on_time_pct}% ${L(lang, "on time", "સમયસર")}` : ""}${perf.quality_rejections ? ` · ${perf.quality_rejections} ${L(lang, "with rejections", "રિજેક્શન સાથે")}` : ""}`
            : legacy ? `${legacy} ${L(lang, "orders", "ઓર્ડર")}` : L(lang, "No purchases yet", "હજુ ખરીદી નથી")}</div>
          {v.blacklist_reason && level !== "REGULAR" && <div className="sub" style={{ color: "var(--danger, #a23434)" }}>{lv?.en}: {v.blacklist_reason}</div>}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span className={`badge ${lv?.tone || "ASSIGNED"}`}>{L(lang, lv?.en, lv?.gu)}</span>
          {tel && <a className="btn btn-outline" style={{ width: "auto", margin: 0 }} href={tel}>📞</a>}
          {wa && <a className="btn btn-outline" style={{ width: "auto", margin: 0 }} href={wa} target="_blank" rel="noopener noreferrer">WhatsApp</a>}
          {v.email && <a className="btn btn-outline" style={{ width: "auto", margin: 0 }} href={`mailto:${v.email}`}>✉</a>}
          {canEdit && <button type="button" className="btn btn-outline" style={{ width: "auto", margin: 0 }} onClick={onToggle}>{open ? L(lang, "Close", "બંધ") : L(lang, "Profile & history", "પ્રોફાઇલ અને ઇતિહાસ")}</button>}
          {canEdit && <button type="button" className="btn btn-outline" style={{ width: "auto", margin: 0 }} onClick={onEdit}>{L(lang, "Edit", "સુધારો")}</button>}
        </div>
      </div>
      {canRate && (
        <div className="btn-row" style={{ alignItems: "center", marginTop: 6 }}>
          <select value={rate.level} onChange={(e) => setRate((r) => ({ ...r, level: e.target.value }))} style={{ width: "auto", margin: 0 }} aria-label={L(lang, "Set level", "સ્તર")}>
            <option value="">{L(lang, "Set level…", "સ્તર…")}</option>
            {VENDOR_LEVELS.filter((x) => x.code !== level).map((x) => <option key={x.code} value={x.code}>{L(lang, x.en, x.gu)}</option>)}
          </select>
          {rate.level && <input value={rate.reason} onChange={(e) => setRate((r) => ({ ...r, reason: e.target.value }))} style={{ maxWidth: 260, margin: 0 }}
            placeholder={["TEMPORARILY_BLOCKED", "BLACKLISTED"].includes(rate.level) ? L(lang, "Reason (required)", "કારણ (જરૂરી)") : L(lang, "Reason (optional)", "કારણ")} />}
          {rate.level && <button type="button" className="btn btn-primary" style={{ width: "auto", margin: 0 }} disabled={busy}
            onClick={() => act(() => setVendorRating(v.id, rate.level, rate.reason), () => setRate({ level: "", reason: "" }))}>{L(lang, "Save level", "સ્તર સાચવો")}</button>}
        </div>
      )}
      {open && <VendorProfile v={v} lang={lang} perf={perf} />}
    </div>
  );
}

function VendorProfile({ v, lang, perf }) {
  const [hist, setHist] = useState(null);
  const [docs, setDocs] = useState([]);
  const [notes, setNotes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const loadDocs = useCallback(() => listVendorDocuments(v.id).then(({ data }) => setDocs(data || [])), [v.id]);
  useEffect(() => {
    vendorHistory(v.id).then(({ data }) => setHist(data || []));
    getVendorNotes(v.id).then(({ data }) => setNotes(data?.remarks || ""));
    loadDocs();
  }, [v.id, loadDocs]);
  async function upload(files) {
    setBusy(true); setErr(null);
    for (const f of files) { const { error } = await uploadVendorDocument(v.id, f); if (error) setErr(friendlyError(error.message)); }
    setBusy(false);
    loadDocs();
  }
  return (
    <div className="vendor-profile">
      {perf && (
        <dl className="deadline-panel">
          <div><dt>{L(lang, "Orders", "ઓર્ડર")}</dt><dd>{perf.total_orders}</dd></div>
          <div><dt>{L(lang, "Purchase value", "ખરીદી રકમ")}</dt><dd>{money(perf.total_value)}</dd></div>
          <div><dt>{L(lang, "Average order", "સરેરાશ ઓર્ડર")}</dt><dd>{perf.avg_order_value != null ? money(perf.avg_order_value) : "—"}</dd></div>
          <div><dt>{L(lang, "On time / delayed", "સમયસર / મોડું")}</dt><dd>{perf.on_time} / {perf.delayed}{perf.open_overdue ? ` (+${perf.open_overdue} ${L(lang, "overdue now", "હાલ મોડું")})` : ""}</dd></div>
          <div><dt>{L(lang, "On-time rate", "સમયસર દર")}</dt><dd>{perf.on_time_pct != null ? `${perf.on_time_pct}%` : L(lang, "No deliveries yet", "હજુ ડિલિવરી નથી")}</dd></div>
          <div><dt>{L(lang, "Quality rejections / cancelled", "રિજેક્શન / રદ")}</dt><dd>{perf.quality_rejections} / {perf.cancelled}</dd></div>
          <div><dt>{L(lang, "Last purchase", "છેલ્લી ખરીદી")}</dt><dd>{perf.last_purchase ? fmtDate(perf.last_purchase) : "—"}</dd></div>
          <div style={{ gridColumn: "1 / -1" }}><dt>{L(lang, "By department", "વિભાગ મુજબ")}</dt>
            <dd>{Object.entries(perf.departments || {}).map(([d, n]) => `${d}: ${n}`).join(" · ") || "—"}</dd></div>
        </dl>
      )}
      {v.specifications && <div className="sub" style={{ marginTop: 6 }}><b>{L(lang, "Specifications", "સ્પષ્ટીકરણ")}:</b> {v.specifications}</div>}
      {notes && <div className="sub" style={{ marginTop: 6 }}><b>{L(lang, "Internal remarks", "આંતરિક નોંધ")}:</b> {notes}</div>}
      <h4 style={{ margin: "10px 0 4px" }}>{L(lang, "Purchase history (line by line)", "ખરીદી ઇતિહાસ")}</h4>
      {hist === null ? <div className="sub">…</div> : hist.length === 0 ? <div className="sub">{L(lang, "No allocated purchases yet.", "હજુ ખરીદી નથી.")}</div> : (
        <div className="proc-table-wrap">
          <table className="proc-table">
            <thead><tr><th>{L(lang, "Date", "તારીખ")}</th><th>{L(lang, "Order", "ઓર્ડર")}</th><th>{L(lang, "Item", "આઇટમ")}</th><th>{L(lang, "Rate", "ભાવ")}</th><th>{L(lang, "Amount", "રકમ")}</th><th>PO</th></tr></thead>
            <tbody>{hist.map((h) => (
              <tr key={h.id}><td>{fmtDate(h.created_at)}</td><td>{h.purchase_requests?.request_number}</td>
                <td style={{ whiteSpace: "normal" }}>{h.purchase_request_items?.description} {h.purchase_request_items?.qty_size && <span className="sub">· {h.purchase_request_items.qty_size}</span>}</td>
                <td>{h.rate != null ? Number(h.rate).toLocaleString("en-IN") : "—"}</td><td>{h.amount != null ? Number(h.amount).toLocaleString("en-IN") : "—"}</td><td>{h.vendor_po_reference}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <h4 style={{ margin: "10px 0 4px" }}>{L(lang, "Documents", "દસ્તાવેજ")}</h4>
      {docs.map((d) => <button key={d.id} type="button" className="btn btn-outline" style={{ width: "auto", margin: 4 }} onClick={() => openVendorDocument(d.storage_path)}>📎 {d.file_name}</button>)}
      <label className="btn btn-outline" style={{ width: "auto", margin: 4, cursor: "pointer" }}>
        {busy ? "…" : `+ ${L(lang, "Add document", "દસ્તાવેજ ઉમેરો")}`}
        <input type="file" multiple hidden accept=".pdf,.jpg,.jpeg,.png,.webp" disabled={busy} onChange={(e) => upload(Array.from(e.target.files || []))} />
      </label>
      {err && <div className="msg error">{err}</div>}
    </div>
  );
}

function CategoryEditor({ lang, cats, busy, act }) {
  const [edit, setEdit] = useState(null);
  return (
    <div className="card">
      <h2>{L(lang, "Material categories", "મટિરિયલ કેટેગરી")}</h2>
      <div className="sub">{L(lang, "An order line belongs to a category when its description or item code contains one of the keywords (whole words).", "ઓર્ડર લાઇનના વર્ણન કે કોડમાં કીવર્ડ હોય તો તે કેટેગરીની ગણાય.")}</div>
      <ul className="reminder-log">
        {cats.map((c) => (
          <li key={c.code} style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
            <span><b>{c.name_en}</b> <span className="sub">{c.code}{!c.is_active && ` · ${L(lang, "inactive", "નિષ્ક્રિય")}`}</span><br /><span className="sub">{(c.keywords || []).join(", ")}</span></span>
            <button type="button" className="btn btn-outline" style={{ width: "auto", margin: 0 }} onClick={() => setEdit({ code: c.code, name: c.name_en, keywords: (c.keywords || []).join(", "), active: c.is_active, existing: true })}>{L(lang, "Edit", "સુધારો")}</button>
          </li>
        ))}
      </ul>
      {!edit && <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setEdit({ code: "", name: "", keywords: "", active: true, existing: false })}>+ {L(lang, "Add category", "કેટેગરી ઉમેરો")}</button>}
      {edit && (
        <div className="form-grid" style={{ marginTop: 8 }}>
          <div className="field"><label>{L(lang, "Code", "કોડ")}</label><input value={edit.code} disabled={edit.existing} onChange={(e) => setEdit((x) => ({ ...x, code: e.target.value.toUpperCase() }))} placeholder="E.G. MARBLE" /></div>
          <div className="field"><label>{L(lang, "Name", "નામ")}</label><input value={edit.name} onChange={(e) => setEdit((x) => ({ ...x, name: e.target.value }))} /></div>
          <div className="field full"><label>{L(lang, "Keywords (comma separated)", "કીવર્ડ (અલ્પવિરામથી)")}</label><input value={edit.keywords} onChange={(e) => setEdit((x) => ({ ...x, keywords: e.target.value }))} /></div>
          <label className="field" style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={edit.active} onChange={(e) => setEdit((x) => ({ ...x, active: e.target.checked }))} style={{ width: "auto", margin: 0 }} />{L(lang, "Active", "સક્રિય")}</label>
          <div className="field full btn-row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act(() => saveCategory(edit.code, edit.name, edit.keywords.split(",").map((k) => k.trim()).filter(Boolean), edit.active), () => setEdit(null))}>{L(lang, "Save category", "કેટેગરી સાચવો")}</button>
            <button type="button" className="btn btn-outline" onClick={() => setEdit(null)}>{L(lang, "Cancel", "રદ")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
