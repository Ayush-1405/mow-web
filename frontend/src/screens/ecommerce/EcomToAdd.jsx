import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { L, day, listListings, removeListing, saveListing, searchMasterProducts, searchShopifyProducts, setListingStatus, team } from "../../lib/ecomApi";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { EcomPage, Empty, LoadError, Thumb } from "./EcomShared.jsx";

// Products to Add: what the Marketing / E-commerce team still has to list on Shopify. Nothing is published to Shopify from here;
// an item becomes Listed by hand (with the Shopify product linked) or automatically when a Shopify variant with its SKU syncs.
const STATUS = { TO_ADD: ["To Add", "ઉમેરવાનું", "ON_HOLD"], IN_PROGRESS: ["In Progress", "ચાલુ", "IN_PROGRESS"], LISTED: ["Listed", "લિસ્ટ થયું", "COMPLETED"] };
const EMPTY = { id: null, title: "", sku: "", category: "", image_url: "", retail_product_id: null, assigned_to: "", target_date: "", notes: "" };

export default function EcomToAdd({ lang }) {
  const navigate = useNavigate();
  const [items, setItems] = useState(null);
  const [people, setPeople] = useState([]);
  const [tab, setTab] = useState("OPEN");
  const [form, setForm] = useState(null);
  const [linkFor, setLinkFor] = useState(null);
  const [removeId, setRemoveId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => { setError(null); try { setItems(await listListings()); } catch (e) { setError(e); } }, []);
  useEffect(() => { load(); team().then(setPeople).catch(() => {}); }, [load]);
  const run = async (fn, ok) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); await load(); return true; } catch (e) { setMsg({ ok: false, text: e.message }); return false; } finally { setBusy(false); }
  };
  const shown = (items || []).filter((i) => (tab === "OPEN" ? i.status !== "LISTED" : i.status === "LISTED"));
  const name = (id) => people.find((p) => p.id === id)?.full_name || "—";
  return (
    <EcomPage lang={lang} icon="➕" title="Products to Add" titleGu="ઉમેરવાના પ્રોડક્ટ"
      sub={L(lang, "The listing checklist for Shopify. Items with a SKU are marked Listed automatically once that SKU appears in Shopify.", "Shopify પર લિસ્ટ કરવાની યાદી.")}
      actions={<button type="button" className="btn btn-primary" style={{ width: "auto", marginTop: 0 }} onClick={() => setForm({ ...EMPTY })}>+ {L(lang, "Add product", "પ્રોડક્ટ ઉમેરો")}</button>}>
      {msg && <div className={`msg ${msg.ok ? "success" : "error"}`}>{msg.text}</div>}
      {form && <ListingForm lang={lang} people={people} form={form} setForm={setForm} busy={busy}
        onSave={() => run(() => saveListing(form), L(lang, "Saved.", "સાચવ્યું.")).then((ok) => ok && setForm(null))} />}
      <div className="card fx-tabs mobile-tab-list" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "OPEN"} className={tab === "OPEN" ? "active" : ""} onClick={() => setTab("OPEN")}>
          {L(lang, "To add / in progress", "બાકી / ચાલુ")} ({(items || []).filter((i) => i.status !== "LISTED").length})</button>
        <button type="button" role="tab" aria-selected={tab === "LISTED"} className={tab === "LISTED" ? "active" : ""} onClick={() => setTab("LISTED")}>
          {L(lang, "Listed", "લિસ્ટ થયું")} ({(items || []).filter((i) => i.status === "LISTED").length})</button>
      </div>
      {error && <LoadError lang={lang} error={error} onRetry={load} />}
      {items && shown.length === 0 && <Empty lang={lang}>{tab === "OPEN" ? L(lang, "Nothing waiting to be listed.", "કંઈ બાકી નથી.") : L(lang, "Nothing listed yet.", "હજુ કંઈ લિસ્ટ નથી.")}</Empty>}
      {shown.length > 0 && (
        <div className="card proc-table-wrap">
          <table className="proc-table">
            <thead><tr><th /><th>{L(lang, "Product", "પ્રોડક્ટ")}</th><th>SKU</th><th>{L(lang, "Category", "કેટેગરી")}</th><th>{L(lang, "Assigned to", "સોંપેલ")}</th>
              <th>{L(lang, "Target date", "લક્ષ્ય તારીખ")}</th><th>{L(lang, "Status", "સ્થિતિ")}</th><th>{L(lang, "Shopify product", "Shopify પ્રોડક્ટ")}</th><th>{L(lang, "Notes", "નોંધ")}</th><th /></tr></thead>
            <tbody>{shown.map((i) => {
              const late = i.status !== "LISTED" && i.target_date && i.target_date < new Date().toISOString().slice(0, 10);
              return (
                <tr key={i.id}>
                  <td><Thumb url={i.image_url} size={36} /></td>
                  <td><strong>{i.title}</strong></td><td>{i.sku || "—"}</td><td>{i.category || "—"}</td><td>{name(i.assigned_to)}</td>
                  <td style={late ? { color: "var(--danger, #b3261e)", fontWeight: 700 } : undefined}>{i.target_date ? day(i.target_date) : "—"}</td>
                  <td>
                    <select value={i.status} disabled={busy} onChange={(e) => e.target.value === "LISTED" ? setLinkFor(i) : run(() => setListingStatus(i.id, e.target.value), L(lang, "Updated.", "અપડેટ."))}>
                      {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{L(lang, v[0], v[1])}</option>)}
                    </select>
                  </td>
                  <td>{i.ecom_products ? <a href="#" onClick={(e) => { e.preventDefault(); navigate(`/ecommerce/products/${encodeURIComponent(i.shopify_product_id)}`); }}>{i.ecom_products.title}</a> : "—"}
                    {i.auto_linked && <span className="sub"> ({L(lang, "auto, by SKU", "SKU થી આપમેળે")})</span>}</td>
                  <td style={{ whiteSpace: "normal", minWidth: 140 }}>{i.notes || "—"}</td>
                  <td style={{ display: "flex", gap: 4 }}>
                    <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => setForm({ ...EMPTY, ...i, assigned_to: i.assigned_to || "", target_date: i.target_date || "" })}>{L(lang, "Edit", "ફેરફાર")}</button>
                    {i.status === "LISTED" && !i.shopify_product_id && <button type="button" className="btn btn-outline btn-sm" onClick={() => setLinkFor(i)}>{L(lang, "Link", "જોડો")}</button>}
                    {removeId === i.id
                      ? <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => { setRemoveId(null); run(() => removeListing(i.id), L(lang, "Removed.", "દૂર કર્યું.")); }}>{L(lang, "Remove?", "દૂર કરો?")}</button>
                      : <button type="button" className="btn btn-outline btn-sm" disabled={busy} title={L(lang, "Remove from the list", "યાદીમાંથી દૂર કરો")} onClick={() => setRemoveId(i.id)}>✕</button>}
                  </td>
                </tr>);
            })}</tbody>
          </table>
        </div>
      )}
      {linkFor && <LinkShopify lang={lang} item={linkFor} busy={busy} onClose={() => setLinkFor(null)}
        onPick={(pid) => run(() => setListingStatus(linkFor.id, "LISTED", pid), L(lang, "Marked Listed.", "લિસ્ટ થયું.")).then(() => setLinkFor(null))} />}
    </EcomPage>
  );
}

function ListingForm({ lang, people, form, setForm, busy, onSave }) {
  const [q, setQ] = useState("");
  const dq = useDebouncedValue(q, 300);
  const [hits, setHits] = useState([]);
  useEffect(() => { if (dq.trim().length < 2) { setHits([]); return; } searchMasterProducts(dq.trim()).then(setHits).catch(() => setHits([])); }, [dq]);
  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <div className="card">
      <div className="section-title" style={{ marginTop: 0 }}>{form.id ? L(lang, "Edit item", "આઇટમ બદલો") : L(lang, "Add a product to list on Shopify", "Shopify પર લિસ્ટ કરવા પ્રોડક્ટ ઉમેરો")}</div>
      {!form.id && (
        <label>{L(lang, "Pick from the product master (optional)", "પ્રોડક્ટ માસ્ટરમાંથી પસંદ કરો (વૈકલ્પિક)")}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={L(lang, "Type a product name or SKU", "નામ અથવા SKU લખો")} />
          {hits.length > 0 && (
            <div className="card" style={{ margin: "4px 0", padding: 6 }}>
              {hits.map((h) => (
                <button key={h.id} type="button" className="btn btn-outline btn-sm" style={{ width: "100%", textAlign: "left", marginBottom: 4 }}
                  onClick={() => { setForm({ ...form, retail_product_id: h.id, title: h.name, sku: h.sku || "", category: h.category || "" }); setQ(""); setHits([]); }}>
                  {h.name}{h.sku ? ` · ${h.sku}` : ""}{h.category ? ` · ${h.category}` : ""}
                </button>))}
            </div>)}
        </label>)}
      {form.retail_product_id && <div className="sub">{L(lang, "Linked to the product master.", "પ્રોડક્ટ માસ્ટર સાથે જોડાયેલ.")}
        <button type="button" className="btn btn-outline btn-sm" style={{ marginLeft: 6 }} onClick={() => setForm({ ...form, retail_product_id: null })}>{L(lang, "Unlink", "છૂટું કરો")}</button></div>}
      <div className="filter-grid" style={{ display: "grid", gap: 8 }}>
        <label>{L(lang, "Product name", "પ્રોડક્ટ નામ")} *<input value={form.title} onChange={f("title")} /></label>
        <label>SKU<input value={form.sku || ""} onChange={f("sku")} placeholder={L(lang, "Used to recognise it once listed", "લિસ્ટ થયા પછી ઓળખ માટે")} /></label>
        <label>{L(lang, "Category", "કેટેગરી")}<input value={form.category || ""} onChange={f("category")} /></label>
        <label>{L(lang, "Image link (optional)", "છબી લિંક (વૈકલ્પિક)")}<input value={form.image_url || ""} onChange={f("image_url")} placeholder="https://" /></label>
        <label>{L(lang, "Assigned to", "સોંપો")}
          <select value={form.assigned_to || ""} onChange={f("assigned_to")}>
            <option value="">{L(lang, "Nobody yet", "હજુ કોઈ નહીં")}</option>{people.map((p) => <option key={p.id} value={p.id}>{p.full_name} · {p.department_code === "MARKETING" ? "Marketing" : "E-commerce"}</option>)}
          </select>
        </label>
        <label>{L(lang, "Target listing date", "લિસ્ટ કરવાની તારીખ")}<input type="date" value={form.target_date || ""} onChange={f("target_date")} /></label>
      </div>
      <label>{L(lang, "Notes", "નોંધ")}<textarea rows={2} value={form.notes || ""} onChange={f("notes")} /></label>
      <div className="btn-row">
        <button type="button" className="btn btn-primary" disabled={busy || !form.title.trim()} onClick={onSave}>{L(lang, "Save", "સાચવો")}</button>
        <button type="button" className="btn btn-outline" onClick={() => setForm(null)}>{L(lang, "Cancel", "રદ")}</button>
      </div>
    </div>
  );
}

function LinkShopify({ lang, item, busy, onPick, onClose }) {
  const [q, setQ] = useState(item.title || "");
  const dq = useDebouncedValue(q, 300);
  const [hits, setHits] = useState([]);
  useEffect(() => { if (dq.trim().length < 2) { setHits([]); return; } searchShopifyProducts(dq.trim()).then(setHits).catch(() => setHits([])); }, [dq]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-card-title">{L(lang, "Mark Listed", "લિસ્ટ થયું")}: {item.title}</div>
        <p className="modal-card-body">{L(lang, "Link the Shopify product it was listed as (it must have synchronised), or mark it Listed without a link.", "Shopify પ્રોડક્ટ સાથે જોડો.")}</p>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={L(lang, "Search Shopify products", "Shopify પ્રોડક્ટ શોધો")} />
        <div style={{ maxHeight: 220, overflowY: "auto", margin: "8px 0" }}>
          {hits.map((h) => <button key={h.shopify_id} type="button" className="btn btn-outline btn-sm" disabled={busy} style={{ width: "100%", textAlign: "left", marginBottom: 4 }}
            onClick={() => onPick(h.shopify_id)}>{h.title} <span className="sub">· {h.status.toLowerCase()}</span></button>)}
          {dq.trim().length >= 2 && hits.length === 0 && <div className="sub">{L(lang, "No synchronised product matches.", "કોઈ પ્રોડક્ટ મળ્યો નથી.")}</div>}
        </div>
        <div className="btn-row">
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => onPick(null)}>{L(lang, "Listed, no link", "લિંક વગર લિસ્ટ")}</button>
          <button type="button" className="btn btn-outline" onClick={onClose}>{L(lang, "Cancel", "રદ")}</button>
        </div>
      </div>
    </div>
  );
}
