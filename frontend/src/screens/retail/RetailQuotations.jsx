import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { formatCurrency, statusBadgeClass } from "../../lib/retailModules";
import { createQuotation, convertQuotationToOrder, approveQuotation, addQuotationItemFromScan, scanProduct } from "../../lib/retailApi";
import QRScanner from "../../components/QRScanner.jsx";

const STATUSES = ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"];
const emptyItem = () => ({ item_name: "", quantity: 1, unit_price: 0 });

// Sales & Quotations — quotations + line items (retail_quotations /
// retail_quotation_items). "Convert to Order" calls the
// retail_convert_quotation_to_order RPC so the items are copied
// server-side rather than duplicated by hand on the client.
export default function RetailQuotations({ lang, lookups, profile }) {
  const [searchParams] = useSearchParams();
  const leadId = searchParams.get("lead_id"); // set when arriving from RetailLeads "Create Quotation" / Won follow-up
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [actionMsg, setActionMsg] = useState(null); // { type, text } — a failed ACTION never blanks the loaded page
  const [rows, setRows] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [form, setForm] = useState({ customer_name: "", phone: "", valid_until: "", internal_approval_required: false });
  const [items, setItems] = useState([emptyItem()]);
  const canApprove = !!(profile?.isManagement || profile?.isDeptHead);
  const [scanOpenFor, setScanOpenFor] = useState(null); // quotation id whose scanner is open
  const [scanPreview, setScanPreview] = useState(null); // { code, product, quantity, discount } once a code is detected
  const [scanBusy, setScanBusy] = useState(false);
  const [scanMsg, setScanMsg] = useState(null);

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

  // Arriving from a lead (Create Quotation button, or the "Quotation Requested" follow-up outcome): prefill the
  // customer's real details from the lead record itself — never re-typed by hand — and open the form already
  // expanded so the salesperson only has to add line items.
  useEffect(() => {
    if (!leadId) return;
    supabase.from("retail_leads").select("customer_name, phone").eq("id", leadId).maybeSingle().then(({ data }) => {
      if (data) {
        setForm((f) => ({ ...f, customer_name: data.customer_name || f.customer_name, phone: data.phone || f.phone }));
        setShowForm(true);
      }
    });
  }, [leadId]);

  function updateItem(idx, field, value) {
    setItems((its) => its.map((it, i) => (i === idx ? { ...it, [field]: value } : it)));
  }
  function addItemRow() { setItems((its) => [...its, emptyItem()]); }
  function removeItemRow(idx) { setItems((its) => its.filter((_, i) => i !== idx)); }

  async function handleAdd(e) {
    e.preventDefault();
    if (!form.customer_name || !retailDept || items.every((it) => !it.item_name)) return;
    setSaving(true);
    setActionMsg(null);
    const { error: err } = await createQuotation({
      customerName: form.customer_name, phone: form.phone || null, validUntil: form.valid_until || null,
      internalApprovalRequired: form.internal_approval_required, leadId: leadId || null,
      items: items.filter((it) => it.item_name).map((it) => ({ item_name: it.item_name, quantity: Number(it.quantity) || 1, unit_price: Number(it.unit_price) || 0 })),
    });
    setSaving(false);
    if (err) { setActionMsg({ type: "error", text: err.message }); return; }
    setForm({ customer_name: "", phone: "", valid_until: "", internal_approval_required: false });
    setItems([emptyItem()]);
    setShowForm(false);
    load();
  }

  async function updateStatus(id, status) {
    const { error: err } = await supabase.from("retail_quotations").update({ status }).eq("id", id);
    if (err) { setActionMsg({ type: "error", text: err.message }); return; }
    load();
  }

  // A failed conversion (e.g. "Only an ACCEPTED quotation can be converted") is shown inline, right where the
  // action was taken — it must never blank the whole loaded list out from under the user (that was the actual bug:
  // this handler used to reuse the page-load error flag, so any rejected action looked like the page failed to load).
  async function convertToOrder(id) {
    setBusyId(id);
    setActionMsg(null);
    const { error: err } = await convertQuotationToOrder(id);
    setBusyId(null);
    if (err) { setActionMsg({ type: "error", text: err.message }); return; }
    load();
  }

  async function decideApproval(id, approved) {
    setBusyId(id);
    setActionMsg(null);
    const { error: err } = await approveQuotation(id, approved, null);
    setBusyId(null);
    if (err) { setActionMsg({ type: "error", text: err.message }); return; }
    load();
  }

  function openScan(quotationId) {
    setScanOpenFor((cur) => (cur === quotationId ? null : quotationId));
    setScanPreview(null);
    setScanMsg(null);
  }

  // Scan QR -> Fetch Product -> Show Product Preview -> Confirm Quantity -> Apply Authorized Discount -> Add.
  async function onScanDetected(code) {
    setScanMsg(null);
    const { data, error: err } = await scanProduct(code);
    if (err || !data) { setScanMsg({ type: "error", text: err?.message || t("productNotFoundMsg", lang) }); return; }
    setScanPreview({ code, product: data.product, serial: data.serial, quantity: 1, discount: 0 });
  }

  async function confirmScanAdd(quotationId) {
    if (!scanPreview) return;
    setScanBusy(true);
    setScanMsg(null);
    const { error: err } = await addQuotationItemFromScan(quotationId, scanPreview.code, Number(scanPreview.quantity) || 1, Number(scanPreview.discount) || 0);
    setScanBusy(false);
    if (err) { setScanMsg({ type: "error", text: err.message }); return; }
    setScanMsg({ type: "success", text: t("productAddedToQuotationMsg", lang) });
    setScanPreview(null);
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

      {actionMsg && <div className="card"><div className={`msg ${actionMsg.type}`}>{actionMsg.text}</div></div>}

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
              <label className="task-meta" style={{ gap: 6 }}>
                <input type="checkbox" checked={form.internal_approval_required} onChange={(e) => setForm((f) => ({ ...f, internal_approval_required: e.target.checked }))} />
                {t("requiresInternalApprovalLabel", lang)}
              </label>
            </div>
            <div className="field full">
              <button className="btn btn-primary" type="submit" disabled={saving}>{t("save", lang)}</button>
            </div>
          </form>
        )}
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => {
          const pendingApproval = r.internal_approval_required && !r.internal_approved_at;
          const canScanAdd = ["DRAFT", "SENT"].includes(r.status);
          return (
            <div key={r.id} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
              <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{r.quotation_number} — {r.customer_name}</div>
                  <div className="sub">{formatCurrency(r.total_amount)}</div>
                  {r.internal_approval_required && (
                    <div className="sub">{r.internal_approved_at ? `✅ ${t("approvedLabel", lang)}` : `⏳ ${t("pendingApprovalLabel", lang)}`}</div>
                  )}
                </div>
                <select value={r.status} onChange={(e) => updateStatus(r.id, e.target.value)}>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <span className={`badge ${statusBadgeClass(r.status)}`}>{r.status}</span>
                {canScanAdd && (
                  <button type="button" className="btn btn-outline" onClick={() => openScan(r.id)}>
                    📷 {t("scanQrAddProductAction", lang)}
                  </button>
                )}
                {canApprove && pendingApproval && (
                  <div className="task-meta" style={{ gap: 6 }}>
                    <button type="button" className="btn btn-primary" disabled={busyId === r.id} onClick={() => decideApproval(r.id, true)}>✅ {t("approveAction", lang)}</button>
                    <button type="button" className="btn btn-outline" disabled={busyId === r.id} onClick={() => decideApproval(r.id, false)}>✕ {t("rejectAction", lang)}</button>
                  </div>
                )}
                {r.status === "ACCEPTED" && !pendingApproval && (
                  <button className="btn btn-outline" disabled={busyId === r.id} onClick={() => convertToOrder(r.id)}>
                    {t("convertToOrder", lang)}
                  </button>
                )}
                {r.status === "ACCEPTED" && pendingApproval && !canApprove && (
                  <span className="sub">{t("awaitingApprovalMsg", lang)}</span>
                )}
              </div>

              {scanOpenFor === r.id && (
                <div className="card" style={{ marginTop: 10, background: "var(--surface-2, #faf8f4)" }}>
                  {scanMsg && <div className={`msg ${scanMsg.type}`}>{scanMsg.text}</div>}
                  {!scanPreview ? (
                    <>
                      <div className="sub" style={{ marginBottom: 8 }}>{t("scanToAddLabel", lang)}</div>
                      <QRScanner lang={lang} onDetected={onScanDetected} />
                    </>
                  ) : (
                    <div style={{ display: "grid", gap: 10 }}>
                      <div style={{ fontWeight: 700 }}>{scanPreview.product.name} <span className="sub">({scanPreview.code})</span></div>
                      {scanPreview.product.selling_price != null && (
                        <div className="sub">{t("sellingPriceLabel", lang)}: ₹{scanPreview.product.selling_price}</div>
                      )}
                      <div className="form-grid">
                        <div className="field"><label>{t("quantityLabel", lang)}</label>
                          <input type="number" min="1" value={scanPreview.quantity}
                            onChange={(e) => setScanPreview((p) => ({ ...p, quantity: e.target.value }))} /></div>
                        <div className="field"><label>{t("discountLabel", lang)}</label>
                          <input type="number" min="0" value={scanPreview.discount}
                            onChange={(e) => setScanPreview((p) => ({ ...p, discount: e.target.value }))} /></div>
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" className="btn btn-primary" disabled={scanBusy} onClick={() => confirmScanAdd(r.id)}>
                          ✅ {t("addToQuotationAction", lang)}
                        </button>
                        <button type="button" className="btn btn-outline" onClick={() => setScanPreview(null)}>{t("cancel", lang)}</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
