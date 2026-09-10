import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { formatCurrency, statusBadgeClass } from "../../lib/retailModules";

const STATUSES = ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"];
const emptyItem = () => ({ item_name: "", quantity: 1, unit_price: 0 });

// Sales & Quotations — quotations + line items (retail_quotations /
// retail_quotation_items). "Convert to Order" calls the
// retail_convert_quotation_to_order RPC so the items are copied
// server-side rather than duplicated by hand on the client.
export default function RetailQuotations({ lang, lookups }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [form, setForm] = useState({ customer_name: "", phone: "", valid_until: "" });
  const [items, setItems] = useState([emptyItem()]);

  const retailDept = useMemo(() => lookups.departments.find((d) => d.code === "RETAIL"), [lookups.departments]);
  const total = useMemo(() => items.reduce((sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.unit_price) || 0), 0), [items]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await supabase.from("retail_quotations").select("*").eq("is_active", true).order("created_at", { ascending: false }).limit(200);
    if (err) { setError(true); setLoading(false); return; }
    setRows(data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function updateItem(idx, field, value) {
    setItems((its) => its.map((it, i) => (i === idx ? { ...it, [field]: value } : it)));
  }
  function addItemRow() { setItems((its) => [...its, emptyItem()]); }
  function removeItemRow(idx) { setItems((its) => its.filter((_, i) => i !== idx)); }

  async function handleAdd(e) {
    e.preventDefault();
    if (!form.customer_name || !retailDept || items.every((it) => !it.item_name)) return;
    setSaving(true);
    const quotationNumber = "QUO-" + Date.now().toString(36).toUpperCase();
    const { data: quotation, error: err } = await supabase.from("retail_quotations").insert({
      department_id: retailDept.id,
      quotation_number: quotationNumber,
      customer_name: form.customer_name,
      phone: form.phone || null,
      valid_until: form.valid_until || null,
      total_amount: total,
    }).select().single();
    if (err) { setSaving(false); setError(true); return; }
    const rowsToInsert = items.filter((it) => it.item_name).map((it) => ({
      quotation_id: quotation.id,
      item_name: it.item_name,
      quantity: Number(it.quantity) || 1,
      unit_price: Number(it.unit_price) || 0,
      line_total: (Number(it.quantity) || 0) * (Number(it.unit_price) || 0),
    }));
    if (rowsToInsert.length) await supabase.from("retail_quotation_items").insert(rowsToInsert);
    setSaving(false);
    setForm({ customer_name: "", phone: "", valid_until: "" });
    setItems([emptyItem()]);
    setShowForm(false);
    load();
  }

  async function updateStatus(id, status) {
    const { error: err } = await supabase.from("retail_quotations").update({ status }).eq("id", id);
    if (!err) load();
  }

  async function convertToOrder(id) {
    setBusyId(id);
    const { error: err } = await supabase.rpc("retail_convert_quotation_to_order", { p_quotation_id: id });
    setBusyId(null);
    if (err) { setError(true); return; }
    load();
  }

  if (loading) {
    return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 60 }} /><div className="skeleton-block" style={{ height: 220 }} /></div>;
  }
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
        <div className="dept-header-icon" aria-hidden="true">📃</div>
        <div className="dept-header-text"><h1>{t("retailQuotationsTitle", lang)}</h1></div>
      </div>

      <div className="card">
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? t("cancel", lang) : t("addQuotation", lang)}
        </button>
        {showForm && (
          <form onSubmit={handleAdd} className="form-grid" style={{ marginTop: 12 }}>
            <div className="field full">
              <label>{t("customerNameLabel", lang)} *</label>
              <input value={form.customer_name} onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))} required />
            </div>
            <div className="field">
              <label>{t("phoneLabel", lang)}</label>
              <input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className="field">
              <label>{t("validUntilLabel", lang)}</label>
              <input type="date" value={form.valid_until} onChange={(e) => setForm((f) => ({ ...f, valid_until: e.target.value }))} />
            </div>
            <div className="field full">
              <label>{t("retailQuotationsTitle", lang)} — {t("itemNameLabel", lang)}</label>
              {items.map((it, idx) => (
                <div key={idx} style={{ display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                  <input placeholder={t("itemNameLabel", lang)} value={it.item_name} onChange={(e) => updateItem(idx, "item_name", e.target.value)} style={{ flex: 2 }} />
                  <input type="number" placeholder={t("quantityLabel", lang)} value={it.quantity} onChange={(e) => updateItem(idx, "quantity", e.target.value)} style={{ flex: 1 }} min="0" />
                  <input type="number" placeholder={t("unitPriceLabel", lang)} value={it.unit_price} onChange={(e) => updateItem(idx, "unit_price", e.target.value)} style={{ flex: 1 }} min="0" />
                  {items.length > 1 && <button type="button" className="btn btn-outline" onClick={() => removeItemRow(idx)}>✕</button>}
                </div>
              ))}
              <button type="button" className="btn btn-outline" onClick={addItemRow}>{t("addItemRow", lang)}</button>
            </div>
            <div className="field full">
              <strong>{t("totalAmountLabel", lang)}: {formatCurrency(total)}</strong>
            </div>
            <div className="field full">
              <button className="btn btn-primary" type="submit" disabled={saving}>{t("save", lang)}</button>
            </div>
          </form>
        )}
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontWeight: 700 }}>{r.quotation_number} — {r.customer_name}</div>
              <div className="sub">{formatCurrency(r.total_amount)}</div>
            </div>
            <select value={r.status} onChange={(e) => updateStatus(r.id, e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <span className={`badge ${statusBadgeClass(r.status)}`}>{r.status}</span>
            {r.status === "ACCEPTED" && (
              <button className="btn btn-outline" disabled={busyId === r.id} onClick={() => convertToOrder(r.id)}>
                {t("convertToOrder", lang)}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
