import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { formatCurrency, statusBadgeClass } from "../../lib/retailModules";
import { advanceDelivery, loadDeliveriesBoard, getDispatchForOrder, listDeliveryItems, listDeliveryProofs, getInstallationForOrder, getPackingForOrder } from "../../lib/retailApi";
import { subscribeTable } from "../../lib/realtime";
import OrderTracker from "../../components/OrderTracker.jsx";

// retail_advance_delivery() only ever accepts these 5 generic stages (v2_93j narrowed it — see retail_record_dispatch/
// retail_record_delivery_proof/_failure/retail_start_installation/retail_record_installation/retail_confirm_installation for
// everything past VEHICLE_ASSIGNED, each writing retail_deliveries.stage itself).
const GENERIC_STAGES = ["ORDER_READY", "PAYMENT_CLEARANCE", "SITE_READINESS", "DELIVERY_SCHEDULED", "VEHICLE_ASSIGNED"];
// The real stage values the pipeline RPCs write from VEHICLE_ASSIGNED onward, in lifecycle order — used only for the progress bar.
const PIPELINE_STAGES = ["OUT_FOR_DELIVERY", "DELIVERY_PROOF_UPLOADED", "DELIVERY_SUCCESSFUL", "INSTALLATION_IN_PROGRESS", "INSTALLATION_PROOF_UPLOADED", "COMPLETED"];
const STAGES = [...GENERIC_STAGES, ...PIPELINE_STAGES];
// Once dispatch is recorded, this screen's own generic "Advance Stage" control is retired — dispatch, delivery proof/failure and
// installation are only ever recorded by Godown staff from their own real screen (GodownHandovers.jsx). Past this point Retail's
// view becomes read-only: live data pulled from the real linked tables via <OrderTracker>, not a re-typed copy.

// Delivery timeline for confirmed orders (retail_deliveries, one row per order — created automatically by retail_confirm_order). This
// replaces the earlier version of this screen, which only listed generic DELIVERY-type staff_tasks with no link back to the order, its
// customer, or its payment status — a salesperson could not actually see delivery progress without calling Dispatch.
export default function RetailDelivery({ lang }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [form, setForm] = useState({ scheduledDate: "", scheduledTime: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [pipelineDetail, setPipelineDetail] = useState({}); // order_id -> { packing, dispatch, items, proofs, installation }

  const load = useCallback(async () => {
    const { data, error: err } = await loadDeliveriesBoard();
    if (err) { setError(true); return; }
    setError(false);
    setRows(data || []);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("retail_deliveries_screen", "retail_deliveries", null, load), [load]);

  async function advance(row, stage) {
    setBusy(true);
    const scheduledAt = form.scheduledDate ? `${form.scheduledDate}T${form.scheduledTime || "10:00"}:00` : null;
    const { error: err } = await advanceDelivery(row.order_id, stage, form.notes || null, scheduledAt);
    setBusy(false);
    if (!err) { setForm({ scheduledDate: "", scheduledTime: "", notes: "" }); load(); }
  }

  const nextStage = (stage) => GENERIC_STAGES[Math.min(GENERIC_STAGES.indexOf(stage) + 1, GENERIC_STAGES.length - 1)];

  async function toggleExpand(row) {
    const opening = expanded !== row.delivery_id;
    setExpanded(opening ? row.delivery_id : null);
    // Fetched unconditionally (not gated on retail_deliveries.stage): the Amazon-style tracker is driven by
    // retail_orders.pipeline_status, which advances through Godown packing/handover well before this screen's own
    // generic stage machine reaches VEHICLE_ASSIGNED — gating on stage here would hide real, already-reached steps.
    if (opening && !pipelineDetail[row.order_id]) {
      const [{ data: packing }, { data: dispatch }, { data: items }, { data: proofs }, { data: installation }] = await Promise.all([
        getPackingForOrder(row.order_id), getDispatchForOrder(row.order_id), listDeliveryItems(row.delivery_id), listDeliveryProofs(row.delivery_id), getInstallationForOrder(row.order_id),
      ]);
      setPipelineDetail((m) => ({ ...m, [row.order_id]: { packing, dispatch, items: items || [], proofs: proofs || [], installation } }));
    }
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
        <div className="dept-header-icon" aria-hidden="true">🚚</div>
        <div className="dept-header-text"><h1>{t("retailDeliveryTitle", lang)}</h1></div>
      </div>

      <div className="card">
        {rows === null && <div className="msg info">…</div>}
        {rows !== null && rows.length === 0 && <div className="msg info">{t("noConfirmedOrdersMsg", lang)}</div>}
        {rows?.map((r) => (
          <div key={r.delivery_id} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
            <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8, cursor: "pointer" }} onClick={() => toggleExpand(r)}>
              <div>
                <div style={{ fontWeight: 700 }}>{r.order_number} — {r.customer_name}</div>
                <div className="sub">{formatCurrency(r.total_amount)} · {r.phone || "—"}{r.scheduled_at ? ` · ${new Date(r.scheduled_at).toLocaleString()}` : ""}</div>
              </div>
              <span className={`badge ${statusBadgeClass(r.payment_status)}`}>{r.payment_status}</span>
              <span className="fx-tag gold">{t(`delstage_${r.stage}`, lang)}</span>
              {r.delay_reason && <span className="fx-tag" style={{ color: "var(--danger)" }}>⚠️ {t("delayedLabel", lang)}</span>}
            </div>
            {expanded === r.delivery_id && (
              <div style={{ marginTop: 8, paddingLeft: 8 }}>
                <div className="task-meta" style={{ gap: 8, flexWrap: "wrap" }}>
                  {STAGES.map((s, i) => (
                    <span key={s} className={`fx-tag${STAGES.indexOf(r.stage) >= i ? " gold" : ""}`}>{t(`delstage_${s}`, lang)}</span>
                  ))}
                </div>
                {r.stage !== "COMPLETED" && r.payment_status !== "PAID" && r.stage !== "PAYMENT_CLEARANCE" && (
                  <div className="msg info" style={{ marginTop: 8 }}>{t("orderBlockedPaymentLabel", lang)}</div>
                )}
                {GENERIC_STAGES.includes(r.stage) && r.stage !== "VEHICLE_ASSIGNED" && (
                  <div className="form-grid" style={{ marginTop: 8 }}>
                    <div className="field"><label>{t("scheduledDateLabel", lang)}</label><input type="date" value={form.scheduledDate} onChange={(e) => setForm((f) => ({ ...f, scheduledDate: e.target.value }))} /></div>
                    <div className="field"><label>{t("dueTime", lang)}</label><input type="time" value={form.scheduledTime} onChange={(e) => setForm((f) => ({ ...f, scheduledTime: e.target.value }))} /></div>
                    <div className="field full"><label>{t("notesLabel", lang)}</label><input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></div>
                    <div className="field full">
                      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => advance(r, nextStage(r.stage))}>
                        ➜ {t("advanceStageLabel", lang)}: {t(`delstage_${nextStage(r.stage)}`, lang)}
                      </button>
                    </div>
                  </div>
                )}
                {r.stage === "VEHICLE_ASSIGNED" && (
                  <div className="msg info" style={{ marginTop: 8 }}>{t("readyForDispatchTeamMsg", lang)}</div>
                )}

                <div style={{ marginTop: 10 }}>
                  <h4 style={{ margin: "4px 0" }}>{t("orderTrackerTitle", lang)}</h4>
                  {!pipelineDetail[r.order_id] && <div className="sub">…</div>}
                  {pipelineDetail[r.order_id] && (
                    <OrderTracker
                      lang={lang}
                      pipelineStatus={r.pipeline_status}
                      installationRequired={r.installation_required}
                      orderId={r.order_id}
                      deliveryId={r.delivery_id}
                      detail={pipelineDetail[r.order_id]}
                    />
                  )}
                </div>

                {pipelineDetail[r.order_id]?.items?.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <h4 style={{ margin: "4px 0" }}>{t("deliveryItemsLabel", lang)}</h4>
                    {pipelineDetail[r.order_id].items.map((it) => (
                      <div key={it.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
                        <span>{it.retail_order_items?.item_name || t("itemLabel", lang)}</span>
                        <span className="sub">{t("deliveredQtyLabel", lang)}: {it.quantity_delivered} · {t("pendingQtyLabel", lang)}: {it.quantity_pending}{it.condition ? ` · ${t("conditionLabel", lang)}: ${it.condition}` : ""}</span>
                      </div>
                    ))}
                  </div>
                )}

                {r.customer_confirmed && <div className="msg success" style={{ marginTop: 8 }}>✅ {t("customerConfirmedLabel", lang)}{r.feedback_score ? ` · ${"⭐".repeat(r.feedback_score)}` : ""}</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
