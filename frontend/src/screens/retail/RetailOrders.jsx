import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { formatCurrency, statusBadgeClass } from "../../lib/retailModules";
import { confirmOrder, listFulfilmentItems, recordSalesPhotoMeta, getDelivery, getPackingForOrder, getDispatchForOrder, listDeliveryItems, listDeliveryProofs, getInstallationForOrder } from "../../lib/retailApi";
import { subscribeTable } from "../../lib/realtime";
import ProofPhotoUpload from "../../components/ProofPhotoUpload.jsx";
import ProofPhotoViewer from "../../components/ProofPhotoViewer.jsx";
import OrderTracker from "../../components/OrderTracker.jsx";

const STATUSES = ["BOOKED", "CONFIRMED", "IN_PRODUCTION", "READY", "DELIVERED", "CANCELLED"];
const MODES = ["STOCK", "FACTORY", "OUTSOURCE", "IMMEDIATE_DELIVERY"];

// Order Booking + confirmed-order fulfilment split + Payment Follow-up — retail_orders/retail_order_items, with retail_payments as the
// append-only ledger and retail_fulfilment_items as the per-line-item record of what retail_confirm_order() actually did (reserve stock /
// create a real Factory Job Card / create a Procurement Request — see mvp_pilot_retail_workflow_v2_93b.sql). Confirming is one atomic,
// retry-safe RPC call: nothing here inserts a job card or procurement row directly, and the button disables itself while it runs so a
// double-tap can never create two.
export default function RetailOrders({ lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [items, setItems] = useState([]);
  const [payments, setPayments] = useState([]);
  const [fulfilment, setFulfilment] = useState([]);
  const [modeChoice, setModeChoice] = useState({});
  const [payForm, setPayForm] = useState({ amount: "", payment_mode: "", note: "" });
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmMsg, setConfirmMsg] = useState(null);
  const [jobsByOrder, setJobsByOrder] = useState({});
  const [photoCount, setPhotoCount] = useState({});
  const [photoForm, setPhotoForm] = useState({});
  const [savingPhotoMeta, setSavingPhotoMeta] = useState(null);
  const [trackerDetail, setTrackerDetail] = useState({}); // order_id -> { delivery, packing, dispatch, items, proofs, installation }

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await supabase.from("retail_orders").select("*").eq("is_active", true).order("created_at", { ascending: false }).limit(200);
    if (err) { setError(true); setLoading(false); return; }
    setRows(data || []);
    const ids = (data || []).map((o) => o.id);
    if (ids.length > 0) {
      const { data: jobs } = await supabase.from("inhouse_production_requests").select("id, job_order_number, factory_status, source_reference").eq("source_module", "retail").in("source_reference", (data || []).map((o) => o.order_number));
      const byOrderNumber = Object.fromEntries((jobs || []).map((j) => [j.source_reference, j]));
      setJobsByOrder(byOrderNumber);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("retail_orders_screen", "retail_orders", null, load), [load]);
  useEffect(() => subscribeTable("retail_orders_jobs_screen", "inhouse_production_requests", "source_module=eq.retail", load), [load]);

  async function toggleExpand(order) {
    if (expanded === order.id) { setExpanded(null); return; }
    setExpanded(order.id);
    const [itemsRes, paymentsRes, fulfilRes] = await Promise.all([
      supabase.from("retail_order_items").select("*").eq("order_id", order.id),
      supabase.from("retail_payments").select("*").eq("order_id", order.id).order("paid_at", { ascending: false }),
      listFulfilmentItems(order.id),
    ]);
    setItems(itemsRes.data || []);
    setPayments(paymentsRes.data || []);
    setFulfilment(fulfilRes.data || []);
    setModeChoice(Object.fromEntries((itemsRes.data || []).map((it) => [it.id, it.fulfilment_mode || "STOCK"])));

    // The Amazon-style tracker only has anything real to show once the order is confirmed — retail_deliveries is
    // created automatically by retail_confirm_order, not before.
    if (order.fulfilment_locked && !trackerDetail[order.id]) {
      const { data: delivery } = await getDelivery(order.id);
      const [{ data: packing }, { data: dispatch }, { data: dItems }, { data: proofs }, { data: installation }] = await Promise.all([
        getPackingForOrder(order.id), getDispatchForOrder(order.id),
        delivery ? listDeliveryItems(delivery.id) : Promise.resolve({ data: [] }),
        delivery ? listDeliveryProofs(delivery.id) : Promise.resolve({ data: [] }),
        getInstallationForOrder(order.id),
      ]);
      setTrackerDetail((m) => ({ ...m, [order.id]: { delivery, packing, dispatch, items: dItems || [], proofs: proofs || [], installation } }));
    }
  }

  async function refreshExpanded(orderId) {
    const [itemsRes, paymentsRes, fulfilRes] = await Promise.all([
      supabase.from("retail_order_items").select("*").eq("order_id", orderId),
      supabase.from("retail_payments").select("*").eq("order_id", orderId).order("paid_at", { ascending: false }),
      listFulfilmentItems(orderId),
    ]);
    setItems(itemsRes.data || []);
    setPayments(paymentsRes.data || []);
    setFulfilment(fulfilRes.data || []);
  }

  async function doConfirm(order) {
    if (confirming) return;
    setConfirming(true); setConfirmMsg(null);
    const fulfilmentPayload = items.map((it) => ({ order_item_id: it.id, mode: modeChoice[it.id] || "STOCK" }));
    const { error: err } = await confirmOrder(order.id, fulfilmentPayload);
    setConfirming(false);
    if (err) { setConfirmMsg({ type: "error", text: err.message }); return; }
    setConfirmMsg({ type: "success", text: t("orderConfirmedMsg", lang) });
    await Promise.all([load(), refreshExpanded(order.id)]);
  }

  async function updateStatus(id, status) {
    const { error: err } = await supabase.from("retail_orders").update({ status }).eq("id", id);
    if (!err) load();
  }

  // Sales Confirmation Product Photo (v2_93m) — once uploaded, recordSalesPhotoMeta() is also the automatic trigger:
  // the backend itself creates the Godown fulfilment request the instant every IMMEDIATE_DELIVERY item's photo (and
  // payment/approval) is in place. Nothing here ever calls "send to godown" directly.
  async function submitSalesPhotoMeta(orderId, itemId) {
    const f = photoForm[itemId] || {};
    setSavingPhotoMeta(itemId);
    const { error: err } = await recordSalesPhotoMeta(itemId, f.location || null, f.serial || null, f.condition_note || null, f.notes || null);
    setSavingPhotoMeta(null);
    if (err) { setConfirmMsg({ type: "error", text: err.message }); return; }
    await Promise.all([load(), refreshExpanded(orderId)]);
  }

  async function recordPayment(orderId) {
    const amount = Number(payForm.amount);
    if (!amount || amount <= 0) return;
    setSaving(true);
    const { error: err } = await supabase.rpc("retail_record_payment", { p_order_id: orderId, p_amount: amount, p_payment_mode: payForm.payment_mode || null, p_note: payForm.note || null });
    setSaving(false);
    if (err) { setError(true); return; }
    setPayForm({ amount: "", payment_mode: "", note: "" });
    await load();
    const paymentsRes = await supabase.from("retail_payments").select("*").eq("order_id", orderId).order("paid_at", { ascending: false });
    setPayments(paymentsRes.data || []);
  }

  if (loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 60 }} /><div className="skeleton-block" style={{ height: 220 }} /></div>;
  if (error) return (
    <div className="dept-dashboard">
      <div className="msg error">{t("loadErrorRetry", lang)}</div>
      <button className="btn btn-primary" onClick={load}>{t("retry", lang)}</button>
    </div>
  );

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📦</div>
        <div className="dept-header-text"><h1>{t("retailOrdersTitle", lang)}</h1></div>
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => {
          const job = jobsByOrder[r.order_number];
          return (
            <div key={r.id} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
              <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8, cursor: "pointer" }} onClick={() => toggleExpand(r)}>
                <div>
                  <div style={{ fontWeight: 700 }}>{r.order_number} — {r.customer_name}</div>
                  <div className="sub">{formatCurrency(r.total_amount)} · {t("amountPaidLabel", lang)}: {formatCurrency(r.amount_paid)}</div>
                </div>
                <span className={`badge ${statusBadgeClass(r.status)}`}>{r.status}</span>
                <span className={`badge ${statusBadgeClass(r.payment_status)}`}>{r.payment_status}</span>
                {r.pipeline_status && r.pipeline_status !== r.status && <span className={`badge ${statusBadgeClass(r.pipeline_status)}`}>{r.pipeline_status}</span>}
                {r.fulfilment_locked && <span className="fx-tag gold">✓ {t("fulfilmentPlannedLabel", lang)}</span>}
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
                  {items.map((it) => {
                    const fi = fulfilment.find((f) => f.order_item_id === it.id);
                    return (
                      <div key={it.id} className="retail-fulfil-row">
                        <div className="task-meta" style={{ justifyContent: "space-between" }}>
                          <span>{it.item_name} × {it.quantity}{it.sku ? ` (${it.sku})` : ""}</span>
                          <span>{formatCurrency(it.line_total)}</span>
                        </div>
                        {!r.fulfilment_locked ? (
                          <select value={modeChoice[it.id] || "STOCK"} onChange={(e) => setModeChoice((m) => ({ ...m, [it.id]: e.target.value }))}>
                            {MODES.map((m) => <option key={m} value={m}>{t(`fulfil_${m}`, lang)}</option>)}
                          </select>
                        ) : fi ? (
                          <div className="task-meta" style={{ gap: 8, flexWrap: "wrap" }}>
                            <span className="fx-tag">{t(`fulfil_${fi.mode}`, lang)} · {fi.status}</span>
                            {fi.mode === "FACTORY" && job && <Link to={`/factory-job/${fi.job_card_id}`} className="fx-tag gold">{t("viewJobCardLabel", lang)} →</Link>}
                            {fi.mode === "OUTSOURCE" && <span className="fx-tag gold">{t("procurementRoutedLabel", lang)}</span>}
                            {fi.mode === "STOCK" && <span className="fx-tag">{t("stockReservedLabel", lang)}</span>}
                            {fi.mode === "IMMEDIATE_DELIVERY" && !it.sales_photo_captured_at && (
                              <span className="fx-tag">{t("awaitingSalesPhotoLabel", lang)}</span>
                            )}
                          </div>
                        ) : null}
                        {fi && fi.mode === "IMMEDIATE_DELIVERY" && it.sales_photo_captured_at && (
                          <ProofPhotoViewer lang={lang} entityType="retail_order_item" entityId={it.id} label={t("salesPhotoConfirmedLabel", lang)} />
                        )}

                        {fi && fi.mode === "IMMEDIATE_DELIVERY" && !it.sales_photo_captured_at && (
                          <div className="card" style={{ marginTop: 8, background: "var(--surface-2, #faf8f4)" }}>
                            <b>📸 {t("salesConfirmationPhotoTitle", lang)}</b>
                            <ProofPhotoUpload lang={lang} entityType="retail_order_item" entityId={it.id}
                              existingCount={photoCount[it.id] || 0}
                              onUploaded={() => setPhotoCount((c) => ({ ...c, [it.id]: (c[it.id] || 0) + 1 }))} />
                            <div className="form-grid" style={{ marginTop: 6 }}>
                              <div className="field"><label>{t("salesPhotoLocationLabel", lang)}</label>
                                <input value={photoForm[it.id]?.location || ""} onChange={(e) => setPhotoForm((f) => ({ ...f, [it.id]: { ...f[it.id], location: e.target.value } }))} /></div>
                              <div className="field"><label>{t("salesPhotoSerialLabel", lang)}</label>
                                <input value={photoForm[it.id]?.serial || ""} onChange={(e) => setPhotoForm((f) => ({ ...f, [it.id]: { ...f[it.id], serial: e.target.value } }))} /></div>
                              <div className="field full"><label>{t("salesPhotoConditionLabel", lang)}</label>
                                <input value={photoForm[it.id]?.condition_note || ""} onChange={(e) => setPhotoForm((f) => ({ ...f, [it.id]: { ...f[it.id], condition_note: e.target.value } }))} /></div>
                              <div className="field full"><label>{t("notesLabel", lang)}</label>
                                <input value={photoForm[it.id]?.notes || ""} onChange={(e) => setPhotoForm((f) => ({ ...f, [it.id]: { ...f[it.id], notes: e.target.value } }))} /></div>
                            </div>
                            <button type="button" className="btn btn-primary" style={{ marginTop: 6 }} disabled={savingPhotoMeta === it.id || !(photoCount[it.id] > 0)}
                              onClick={() => submitSalesPhotoMeta(r.id, it.id)}>
                              {t("confirmSalesPhotoAction", lang)}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {!r.fulfilment_locked && items.length > 0 && (
                    <button type="button" className="btn btn-primary" style={{ width: "auto", marginTop: 8 }} disabled={confirming} onClick={() => doConfirm(r)}>
                      {confirming ? t("confirmingOrderLabel", lang) : `✅ ${t("confirmOrderAction", lang)}`}
                    </button>
                  )}
                  {confirmMsg && <div className={`msg ${confirmMsg.type}`} style={{ marginTop: 8 }}>{confirmMsg.text}</div>}

                  {r.fulfilment_locked && (
                    <div style={{ marginTop: 10 }}>
                      <h4 style={{ margin: "4px 0" }}>{t("orderTrackerTitle", lang)}</h4>
                      {!trackerDetail[r.id] && <div className="sub">…</div>}
                      {trackerDetail[r.id] && (
                        <OrderTracker
                          lang={lang}
                          pipelineStatus={r.pipeline_status}
                          installationRequired={r.installation_required}
                          orderId={r.id}
                          deliveryId={trackerDetail[r.id].delivery?.id}
                          detail={trackerDetail[r.id]}
                        />
                      )}
                    </div>
                  )}
                  {job && (
                    <div className="task-meta" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                      <span className="badge VERIFIED">{t("factoryStatusLabel", lang)}: {job.factory_status}</span>
                      <Link to={`/factory-job/${job.id}`} className="fx-tag gold">{t("viewJobCardLabel", lang)} {job.job_order_number} →</Link>
                    </div>
                  )}

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
          );
        })}
      </div>
    </div>
  );
}
