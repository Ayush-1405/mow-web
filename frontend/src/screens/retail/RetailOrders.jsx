import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { formatCurrency, statusBadgeClass } from "../../lib/retailModules";

const STATUSES = ["BOOKED", "CONFIRMED", "IN_PRODUCTION", "READY", "DELIVERED", "CANCELLED"];

// Order Booking + Payment Follow-up — retail_orders/retail_order_items,
// with retail_payments as the append-only ledger. Payments are recorded
// only through the retail_record_payment RPC so amount_paid/payment_status
// can never drift from the ledger — see mvp_pilot_retail_rpcs_v2_2c.sql.
export default function RetailOrders({ lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [items, setItems] = useState([]);
  const [payments, setPayments] = useState([]);
  const [payForm, setPayForm] = useState({ amount: "", payment_mode: "", note: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await supabase.from("retail_orders").select("*").eq("is_active", true).order("created_at", { ascending: false }).limit(200);
    if (err) { setError(true); setLoading(false); return; }
    setRows(data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggleExpand(order) {
    if (expanded === order.id) { setExpanded(null); return; }
    setExpanded(order.id);
    const [itemsRes, paymentsRes] = await Promise.all([
      supabase.from("retail_order_items").select("*").eq("order_id", order.id),
      supabase.from("retail_payments").select("*").eq("order_id", order.id).order("paid_at", { ascending: false }),
    ]);
    setItems(itemsRes.data || []);
    setPayments(paymentsRes.data || []);
  }

  async function updateStatus(id, status) {
    const { error: err } = await supabase.from("retail_orders").update({ status }).eq("id", id);
    if (!err) load();
  }

  async function recordPayment(orderId) {
    const amount = Number(payForm.amount);
    if (!amount || amount <= 0) return;
    setSaving(true);
    const { error: err } = await supabase.rpc("retail_record_payment", {
      p_order_id: orderId, p_amount: amount, p_payment_mode: payForm.payment_mode || null, p_note: payForm.note || null,
    });
    setSaving(false);
    if (err) { setError(true); return; }
    setPayForm({ amount: "", payment_mode: "", note: "" });
    await load();
    const paymentsRes = await supabase.from("retail_payments").select("*").eq("order_id", orderId).order("paid_at", { ascending: false });
    setPayments(paymentsRes.data || []);
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
        <div className="dept-header-icon" aria-hidden="true">📦</div>
        <div className="dept-header-text"><h1>{t("retailOrdersTitle", lang)}</h1></div>
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => (
          <div key={r.id} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
            <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8, cursor: "pointer" }} onClick={() => toggleExpand(r)}>
              <div>
                <div style={{ fontWeight: 700 }}>{r.order_number} — {r.customer_name}</div>
                <div className="sub">{formatCurrency(r.total_amount)} · {t("amountPaidLabel", lang)}: {formatCurrency(r.amount_paid)}</div>
              </div>
              <span className={`badge ${statusBadgeClass(r.status)}`}>{r.status}</span>
              <span className={`badge ${statusBadgeClass(r.payment_status)}`}>{r.payment_status}</span>
            </div>
            {expanded === r.id && (
              <div style={{ marginTop: 10, paddingLeft: 8 }}>
                <div className="field" style={{ maxWidth: 220 }}>
                  <label>{t("statusLabel", lang)}</label>
                  <select value={r.status} onChange={(e) => updateStatus(r.id, e.target.value)}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <h3 style={{ marginTop: 10 }}>{t("itemNameLabel", lang)}</h3>
                {items.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
                {items.map((it) => (
                  <div key={it.id} className="task-meta" style={{ justifyContent: "space-between" }}>
                    <span>{it.item_name} × {it.quantity}</span>
                    <span>{formatCurrency(it.line_total)}</span>
                  </div>
                ))}
                <h3 style={{ marginTop: 10 }}>{t("paymentHistoryLabel", lang)}</h3>
                {payments.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
                {payments.map((p) => (
                  <div key={p.id} className="task-meta" style={{ justifyContent: "space-between" }}>
                    <span>{p.payment_mode || "—"} {p.note ? `· ${p.note}` : ""}</span>
                    <span>{formatCurrency(p.amount)}</span>
                  </div>
                ))}
                {r.payment_status !== "PAID" && (
                  <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    <input type="number" placeholder={t("amountLabel", lang)} value={payForm.amount} onChange={(e) => setPayForm((f) => ({ ...f, amount: e.target.value }))} style={{ maxWidth: 120 }} min="0" />
                    <input placeholder={t("paymentModeLabel", lang)} value={payForm.payment_mode} onChange={(e) => setPayForm((f) => ({ ...f, payment_mode: e.target.value }))} style={{ maxWidth: 140 }} />
                    <button className="btn btn-primary" disabled={saving} onClick={() => recordPayment(r.id)}>{t("recordPayment", lang)}</button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
