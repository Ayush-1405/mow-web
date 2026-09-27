import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import {
  listGodownQueue, startDispatch, preDispatchChecklist, recordDispatch, PRE_DISPATCH_CHECKLIST_KEYS,
  listInstallationQueue, startInstallation, recordInstallation, confirmInstallation,
  loadDeliveriesBoard, AWAITING_DELIVERY_PROOF_STAGES, getDeliveryChallanForOrder, listDeliveryChallanItems,
  listOrderItemsForDelivery, recordDeliveryProof, recordDeliveryFailure, completeOrder,
} from "../../lib/retailApi";
import { statusBadgeClass } from "../../lib/retailModules.js";
import ProofPhotoUpload from "../../components/ProofPhotoUpload.jsx";

// Best-effort, non-blocking GPS capture (spec section 13): never blocks a legitimate delivery just because the
// device/browser refuses or the signal is unavailable — the caller always gets a result, success or not.
function captureGps() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve({ ok: false }); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ ok: true, latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () => resolve({ ok: false }),
      { timeout: 8000 }
    );
  });
}

// Dispatch/Logistics' own real screen (v2_93j): orders Godown has ACCEPTED, ready to leave. Starting dispatch creates the record;
// recording dispatch requires the pre-dispatch checklist complete (or a management-recorded exception) AND a dispatch photo
// already uploaded — both enforced server-side, this form is just where they get satisfied.
export default function DispatchQueue({ lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [accepted, setAccepted] = useState([]);
  const [dispatches, setDispatches] = useState({}); // order_id -> dispatch record
  const [open, setOpen] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [photoCount, setPhotoCount] = useState({});
  const [checklist, setChecklist] = useState({});
  const [vehicle, setVehicle] = useState({ vehicle_number: "", vehicle_transporter: "", package_count: 1, challan_ref: "", driver_name: "", driver_phone: "" });

  const [installRows, setInstallRows] = useState([]);
  const [openInstall, setOpenInstall] = useState(null);
  const [installPhotoCount, setInstallPhotoCount] = useState({});
  const [installForm, setInstallForm] = useState({ team: "", pending_work: "", damage_rework: "" });
  const [confirmForm, setConfirmForm] = useState({ customer_confirmed: true, feedback_score: 5 });

  // Delivery proof / failure — the step that had NO screen anywhere before this pass (retail_record_delivery_proof
  // and retail_record_delivery_failure existed server-side, photo-gated, but nothing in the app ever called them).
  const [deliveryRows, setDeliveryRows] = useState([]);
  const [openDelivery, setOpenDelivery] = useState(null);
  const [dcItems, setDcItems] = useState({}); // order_id -> retail_delivery_challan_items rows (serialized orders)
  const [orderItems, setOrderItems] = useState({}); // order_id -> retail_order_items rows (non-serialized orders)
  const [deliveredCheck, setDeliveredCheck] = useState({}); // dc_item_id -> boolean
  const [nonSerialQty, setNonSerialQty] = useState({}); // order_item_id -> quantity_delivered
  const [deliveryForm, setDeliveryForm] = useState({}); // order_id -> { site_rep_name, pod_method, pod_reference, condition_notes }
  const [deliveryPhotoCount, setDeliveryPhotoCount] = useState({});
  const [gpsByOrder, setGpsByOrder] = useState({}); // order_id -> { latitude, longitude } | { unverifiable: true }
  const [failForm, setFailForm] = useState({}); // order_id -> { reason, next_date }
  const [showFailFor, setShowFailFor] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data, error: err }, { data: instRows }, { data: delivRows }] = await Promise.all([
      listGodownQueue(), listInstallationQueue(), loadDeliveriesBoard(),
    ]);
    if (err) { setError(true); setLoading(false); return; }
    setAccepted((data || []).filter((r) => r.status === "ACCEPTED"));
    setInstallRows(instRows || []);
    setDeliveryRows((delivRows || []).filter((r) => AWAITING_DELIVERY_PROOF_STAGES.includes(r.stage) || r.stage === "DELIVERY_SUCCESSFUL"));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function beginDispatch(orderId) {
    setBusyId(orderId);
    const { data, error: err } = await startDispatch(orderId);
    setBusyId(null);
    if (err) { setError(true); return; }
    setDispatches((d) => ({ ...d, [orderId]: data }));
    setOpen(orderId);
    setChecklist({});
    setVehicle({ vehicle_number: "", vehicle_transporter: "", package_count: 1, challan_ref: "", driver_name: "", driver_phone: "" });
  }

  async function saveChecklist(orderId) {
    await preDispatchChecklist(orderId, checklist, null);
  }

  async function doRecordDispatch(orderId) {
    const rec = dispatches[orderId];
    if (!rec) return;
    setBusyId(orderId);
    const { error: err } = await recordDispatch(rec.id, vehicle.vehicle_number, vehicle.vehicle_transporter || null, Number(vehicle.package_count) || 1,
      vehicle.challan_ref || null, null, null, vehicle.driver_name || null, vehicle.driver_phone || null);
    setBusyId(null);
    if (err) { setError(true); return; }
    setOpen(null);
    load();
  }

  // ---- Delivery proof / failure / completion (v2_93u — no screen anywhere called these RPCs before) ------------------------------
  async function toggleDeliveryOpen(row) {
    const opening = openDelivery !== row.order_id;
    setOpenDelivery(opening ? row.order_id : null);
    setShowFailFor(null);
    if (!opening) return;
    setDeliveryForm((f) => ({ ...f, [row.order_id]: f[row.order_id] || { site_rep_name: "", pod_method: "SIGNATURE", pod_reference: "", condition_notes: "" } }));
    if (dcItems[row.order_id] === undefined) {
      const { data: dc } = await getDeliveryChallanForOrder(row.order_id);
      if (dc) {
        const { data: items } = await listDeliveryChallanItems(dc.id);
        setDcItems((m) => ({ ...m, [row.order_id]: items || [] }));
        const initial = {};
        (items || []).forEach((it) => { initial[it.id] = it.retail_inventory_items?.status !== "DISPATCHED" ? it.retail_inventory_items?.status === "SOLD" : true; });
        setDeliveredCheck((m) => ({ ...m, ...initial }));
      } else {
        setDcItems((m) => ({ ...m, [row.order_id]: null }));
        const { data: oItems } = await listOrderItemsForDelivery(row.order_id);
        setOrderItems((m) => ({ ...m, [row.order_id]: oItems || [] }));
        const q = {};
        (oItems || []).forEach((it) => { q[it.id] = it.quantity; });
        setNonSerialQty((m) => ({ ...m, ...q }));
      }
    }
  }

  async function tryGps(orderId) {
    const res = await captureGps();
    if (res.ok) setGpsByOrder((m) => ({ ...m, [orderId]: { latitude: res.latitude, longitude: res.longitude } }));
    else {
      const reason = window.prompt(t("locationUnverifiableReasonLabel", lang));
      setGpsByOrder((m) => ({ ...m, [orderId]: { unverifiable: true, reason: reason || t("locationUnavailableDefaultMsg", lang) } }));
    }
  }

  async function submitDeliveryProof(row) {
    const f = deliveryForm[row.order_id] || {};
    if (!f.site_rep_name?.trim()) return;
    const dcRows = dcItems[row.order_id];
    let items = []; let deliveredSerials = null;
    if (dcRows) {
      // Serialized order: derive both the per-order-item delivered quantity AND the exact delivered serials from
      // the same checkbox list — never re-typed, never a second source of truth.
      deliveredSerials = dcRows.filter((it) => deliveredCheck[it.id] && it.retail_inventory_items?.status !== "SOLD").map((it) => it.retail_inventory_items?.serial_number).filter(Boolean);
      const byItem = {};
      dcRows.forEach((it) => {
        byItem[it.order_item_id] = byItem[it.order_item_id] || { order_item_id: it.order_item_id, quantity_delivered: 0, total: 0 };
        byItem[it.order_item_id].total += Number(it.quantity) || 1;
        if (deliveredCheck[it.id]) byItem[it.order_item_id].quantity_delivered += Number(it.quantity) || 1;
      });
      items = Object.values(byItem).map((x) => ({ order_item_id: x.order_item_id, quantity_delivered: x.quantity_delivered }));
    } else {
      items = (orderItems[row.order_id] || []).map((it) => ({ order_item_id: it.id, quantity_delivered: Number(nonSerialQty[it.id]) || 0 }));
    }
    const gps = gpsByOrder[row.order_id] || {};
    setBusyId(row.order_id);
    const { error: err } = await recordDeliveryProof(
      row.order_id, f.site_rep_name, f.pod_method || "SIGNATURE", f.pod_reference || null, items, f.condition_notes || null,
      deliveredSerials, gps.latitude ?? null, gps.longitude ?? null, gps.unverifiable ? gps.reason : null);
    setBusyId(null);
    if (err) { setError(true); return; }
    setOpenDelivery(null);
    load();
  }

  async function submitDeliveryFailure(orderId) {
    const f = failForm[orderId] || {};
    if (!f.reason?.trim()) return;
    setBusyId(orderId);
    const { error: err } = await recordDeliveryFailure(orderId, f.reason, f.next_date || null);
    setBusyId(null);
    if (err) { setError(true); return; }
    setShowFailFor(null);
    load();
  }

  async function doCompleteOrder(orderId) {
    setBusyId(orderId);
    const { error: err } = await completeOrder(orderId);
    setBusyId(null);
    if (err) { setError(true); return; }
    load();
  }

  async function doStartInstall(orderId) {
    setBusyId(orderId);
    const { error: err } = await startInstallation(orderId);
    setBusyId(null);
    if (err) { setError(true); return; }
    load();
  }

  async function doRecordInstall(installationId) {
    setBusyId(installationId);
    const { error: err } = await recordInstallation(installationId, installForm.team || null, installForm.pending_work || null, installForm.damage_rework || null);
    setBusyId(null);
    if (err) { setError(true); return; }
    load();
  }

  async function doConfirmInstall(installationId) {
    setBusyId(installationId);
    const { error: err } = await confirmInstallation(installationId, confirmForm.customer_confirmed, confirmForm.customer_confirmed ? Number(confirmForm.feedback_score) : null);
    setBusyId(null);
    if (err) { setError(true); return; }
    setOpenInstall(null);
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
        <div className="dept-header-icon" aria-hidden="true">🚚</div>
        <div className="dept-header-text"><h1>{t("dispatchQueueTitle", lang)}</h1></div>
      </div>

      <div className="card">
        {accepted.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {accepted.map((r) => {
          const dispatchRow = dispatches[r.order_id];
          const isOpen = open === r.order_id;
          return (
            <div key={r.id} className="task-meta" style={{ flexDirection: "column", alignItems: "stretch", padding: "10px 0", borderBottom: "1px solid var(--border, #eee)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{r.retail_orders?.order_number} — {r.retail_orders?.customer_name}</div>
                  <div className="sub">{r.retail_orders?.delivery_address}</div>
                </div>
                {!isOpen && (
                  <button className="btn btn-primary" disabled={busyId === r.order_id} onClick={() => beginDispatch(r.order_id)}>
                    {t("startDispatchAction", lang)}
                  </button>
                )}
                {isOpen && <button className="btn btn-outline" onClick={() => setOpen(null)}>{t("cancel", lang)}</button>}
              </div>

              {isOpen && dispatchRow && (
                <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                  <div className="field full">
                    <label>{t("preDispatchChecklistLabel", lang)}</label>
                    {PRE_DISPATCH_CHECKLIST_KEYS.map(([key, labelKey]) => (
                      <label key={key} className="task-meta" style={{ gap: 6, display: "block", marginTop: 4 }}>
                        <input type="checkbox" checked={!!checklist[key]} onChange={(e) => setChecklist((c) => ({ ...c, [key]: e.target.checked }))} />
                        {t(labelKey, lang)}
                      </label>
                    ))}
                    <button type="button" className="btn btn-outline" style={{ marginTop: 6 }} onClick={() => saveChecklist(r.order_id)}>{t("saveChecklistAction", lang)}</button>
                  </div>

                  <ProofPhotoUpload lang={lang} entityType="retail_dispatch" entityId={dispatchRow.id}
                    label={t("dispatchPhotoLabel", lang)}
                    existingCount={photoCount[dispatchRow.id] || 0}
                    onUploaded={() => setPhotoCount((c) => ({ ...c, [dispatchRow.id]: (c[dispatchRow.id] || 0) + 1 }))} />

                  <div className="form-grid">
                    <div className="field"><label>{t("vehicleNumberLabel", lang)} *</label>
                      <input value={vehicle.vehicle_number} onChange={(e) => setVehicle((v) => ({ ...v, vehicle_number: e.target.value }))} /></div>
                    <div className="field"><label>{t("transporterLabel", lang)}</label>
                      <input value={vehicle.vehicle_transporter} onChange={(e) => setVehicle((v) => ({ ...v, vehicle_transporter: e.target.value }))} /></div>
                    <div className="field"><label>{t("packageCountLabel", lang)}</label>
                      <input type="number" min="1" value={vehicle.package_count} onChange={(e) => setVehicle((v) => ({ ...v, package_count: e.target.value }))} /></div>
                    <div className="field"><label>{t("challanRefLabel", lang)}</label>
                      <input value={vehicle.challan_ref} onChange={(e) => setVehicle((v) => ({ ...v, challan_ref: e.target.value }))} /></div>
                    <div className="field"><label>{t("driverNameLabel", lang)}</label>
                      <input value={vehicle.driver_name} onChange={(e) => setVehicle((v) => ({ ...v, driver_name: e.target.value }))} /></div>
                    <div className="field"><label>{t("driverPhoneLabel", lang)}</label>
                      <input value={vehicle.driver_phone} onChange={(e) => setVehicle((v) => ({ ...v, driver_phone: e.target.value }))} /></div>
                  </div>
                  <button className="btn btn-primary" disabled={busyId === r.order_id || !vehicle.vehicle_number.trim()} onClick={() => doRecordDispatch(r.order_id)}>
                    🚚 {t("recordDispatchAction", lang)}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="card">
        <h3>{t("deliveryProofQueueLabel", lang)}</h3>
        {deliveryRows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {deliveryRows.map((r) => {
          const isOpen = openDelivery === r.order_id;
          const dcRows = dcItems[r.order_id];
          const gps = gpsByOrder[r.order_id];
          return (
            <div key={r.delivery_id} className="task-meta" style={{ flexDirection: "column", alignItems: "stretch", padding: "10px 0", borderBottom: "1px solid var(--border, #eee)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{r.order_number} — {r.customer_name}</div>
                  <div className="sub">{r.delivery_address}{r.contact_person ? ` · ${r.contact_person} (${r.contact_phone || "—"})` : ""}</div>
                  <span className={`badge ${statusBadgeClass(r.stage)}`}>{t(`delstage_${r.stage}`, lang)}</span>
                </div>
                {r.stage === "DELIVERY_SUCCESSFUL" && !r.installation_required && (
                  <button className="btn btn-primary" disabled={busyId === r.order_id} onClick={() => doCompleteOrder(r.order_id)}>
                    🏁 {t("completeOrderAction", lang)}
                  </button>
                )}
                {r.stage !== "DELIVERY_SUCCESSFUL" && (
                  <button className="btn btn-outline" onClick={() => toggleDeliveryOpen(r)}>{isOpen ? t("cancel", lang) : t("recordDeliveryProofAction", lang)}</button>
                )}
              </div>

              {isOpen && (
                <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                  <ProofPhotoUpload lang={lang} entityType="retail_delivery" entityId={r.delivery_id}
                    label={t("deliverySitePhotoLabel", lang)}
                    existingCount={deliveryPhotoCount[r.delivery_id] || 0}
                    onUploaded={() => setDeliveryPhotoCount((c) => ({ ...c, [r.delivery_id]: (c[r.delivery_id] || 0) + 1 }))} />

                  {dcRows === undefined && <div className="sub">…</div>}
                  {dcRows && dcRows.length > 0 && (
                    <div className="field full">
                      <label>{t("deliveredItemsLabel", lang)}</label>
                      {dcRows.map((it) => {
                        const already = it.retail_inventory_items?.status === "SOLD";
                        return (
                          <label key={it.id} className="task-meta" style={{ gap: 6, display: "block", marginTop: 4, opacity: already ? 0.6 : 1 }}>
                            <input type="checkbox" checked={!!deliveredCheck[it.id]} disabled={already}
                              onChange={(e) => setDeliveredCheck((m) => ({ ...m, [it.id]: e.target.checked }))} />
                            {it.retail_order_items?.item_name || t("itemLabel", lang)} · {it.retail_inventory_items?.serial_number || "—"}
                            {already ? ` (${t("alreadyDeliveredLabel", lang)})` : ""}
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {dcRows === null && (orderItems[r.order_id] || []).map((it) => (
                    <div className="form-grid" key={it.id}>
                      <div className="field full"><label>{it.item_name} ({t("orderedQtyLabel", lang)}: {it.quantity})</label>
                        <input type="number" min="0" max={it.quantity} value={nonSerialQty[it.id] ?? it.quantity}
                          onChange={(e) => setNonSerialQty((m) => ({ ...m, [it.id]: e.target.value }))} /></div>
                    </div>
                  ))}

                  <div className="form-grid">
                    <div className="field"><label>{t("siteRepresentativeLabel", lang)} *</label>
                      <input value={deliveryForm[r.order_id]?.site_rep_name || ""}
                        onChange={(e) => setDeliveryForm((m) => ({ ...m, [r.order_id]: { ...m[r.order_id], site_rep_name: e.target.value } }))} /></div>
                    <div className="field"><label>{t("podMethodLabel", lang)}</label>
                      <select value={deliveryForm[r.order_id]?.pod_method || "SIGNATURE"}
                        onChange={(e) => setDeliveryForm((m) => ({ ...m, [r.order_id]: { ...m[r.order_id], pod_method: e.target.value } }))}>
                        <option value="SIGNATURE">{t("podSignatureOption", lang)}</option>
                        <option value="OTP">{t("podOtpOption", lang)}</option>
                        <option value="PHOTO_CONFIRM">{t("podPhotoConfirmOption", lang)}</option>
                      </select></div>
                    <div className="field"><label>{t("podReferenceLabel", lang)}</label>
                      <input value={deliveryForm[r.order_id]?.pod_reference || ""}
                        onChange={(e) => setDeliveryForm((m) => ({ ...m, [r.order_id]: { ...m[r.order_id], pod_reference: e.target.value } }))} /></div>
                    <div className="field full"><label>{t("conditionNotesLabel", lang)}</label>
                      <textarea rows={2} value={deliveryForm[r.order_id]?.condition_notes || ""}
                        onChange={(e) => setDeliveryForm((m) => ({ ...m, [r.order_id]: { ...m[r.order_id], condition_notes: e.target.value } }))} /></div>
                  </div>

                  <div className="task-meta" style={{ gap: 8, flexWrap: "wrap" }}>
                    <button type="button" className="btn btn-outline" onClick={() => tryGps(r.order_id)}>📍 {t("captureLocationAction", lang)}</button>
                    {gps?.latitude != null && <span className="fx-tag gold">✓ {t("locationCapturedLabel", lang)}</span>}
                    {gps?.unverifiable && <span className="fx-tag">{t("locationUnavailableLabel", lang)}</span>}
                  </div>

                  <button className="btn btn-primary" disabled={busyId === r.order_id || !(deliveryPhotoCount[r.delivery_id] > 0) || !deliveryForm[r.order_id]?.site_rep_name}
                    onClick={() => submitDeliveryProof(r)}>
                    ✅ {t("recordDeliveryProofAction", lang)}
                  </button>

                  <hr style={{ width: "100%", opacity: 0.3 }} />
                  {!showFailFor && (
                    <button type="button" className="btn btn-outline" style={{ color: "var(--danger)" }} onClick={() => setShowFailFor(r.order_id)}>
                      ⚠️ {t("markDeliveryFailedAction", lang)}
                    </button>
                  )}
                  {showFailFor === r.order_id && (
                    <div className="form-grid">
                      <div className="field full"><label>{t("failureReasonLabel", lang)} *</label>
                        <textarea rows={2} value={failForm[r.order_id]?.reason || ""}
                          onChange={(e) => setFailForm((m) => ({ ...m, [r.order_id]: { ...m[r.order_id], reason: e.target.value } }))} /></div>
                      <div className="field"><label>{t("nextDeliveryDateLabel", lang)}</label>
                        <input type="date" value={failForm[r.order_id]?.next_date || ""}
                          onChange={(e) => setFailForm((m) => ({ ...m, [r.order_id]: { ...m[r.order_id], next_date: e.target.value } }))} /></div>
                      <div className="field full">
                        <button className="btn btn-outline" style={{ color: "var(--danger)" }} disabled={busyId === r.order_id || !failForm[r.order_id]?.reason?.trim()}
                          onClick={() => submitDeliveryFailure(r.order_id)}>
                          {t("markDeliveryFailedAction", lang)}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="card">
        <h3>{t("installationQueueLabel", lang)}</h3>
        {installRows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {installRows.map((d) => {
          const installation = d.retail_installations?.[0] || null;
          const isOpen = openInstall === d.id;
          return (
            <div key={d.id} className="task-meta" style={{ flexDirection: "column", alignItems: "stretch", padding: "10px 0", borderBottom: "1px solid var(--border, #eee)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{d.retail_orders?.order_number} — {d.retail_orders?.customer_name}</div>
                  <div className="sub">{d.retail_orders?.delivery_address}</div>
                  {installation && <span className={`badge ${statusBadgeClass(installation.status)}`}>{installation.status}</span>}
                </div>
                {!installation && (
                  <button className="btn btn-primary" disabled={busyId === d.order_id} onClick={() => doStartInstall(d.order_id)}>{t("startInstallationAction", lang)}</button>
                )}
                {installation && installation.status !== "COMPLETED" && (
                  <button className="btn btn-outline" onClick={() => setOpenInstall(isOpen ? null : d.id)}>{isOpen ? t("cancel", lang) : t("continueAction", lang)}</button>
                )}
              </div>

              {isOpen && installation && installation.status !== "COMPLETED" && (
                <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                  <ProofPhotoUpload lang={lang} entityType="retail_installation" entityId={installation.id}
                    existingCount={installPhotoCount[installation.id] || 0}
                    onUploaded={() => setInstallPhotoCount((c) => ({ ...c, [installation.id]: (c[installation.id] || 0) + 1 }))} />
                  <div className="form-grid">
                    <div className="field"><label>{t("installationTeamLabel", lang)}</label>
                      <input value={installForm.team} onChange={(e) => setInstallForm((f) => ({ ...f, team: e.target.value }))} /></div>
                    <div className="field full"><label>{t("pendingWorkLabel", lang)}</label>
                      <textarea rows={2} value={installForm.pending_work} onChange={(e) => setInstallForm((f) => ({ ...f, pending_work: e.target.value }))} /></div>
                    <div className="field full"><label>{t("damageReworkLabel", lang)}</label>
                      <textarea rows={2} value={installForm.damage_rework} onChange={(e) => setInstallForm((f) => ({ ...f, damage_rework: e.target.value }))} /></div>
                  </div>
                  <button className="btn btn-outline" disabled={busyId === installation.id} onClick={() => doRecordInstall(installation.id)}>{t("save", lang)}</button>

                  <hr style={{ width: "100%", opacity: 0.3 }} />
                  <div className="form-grid">
                    <div className="field full"><label className="task-meta" style={{ gap: 6 }}>
                      <input type="checkbox" checked={confirmForm.customer_confirmed} onChange={(e) => setConfirmForm((f) => ({ ...f, customer_confirmed: e.target.checked }))} />
                      {t("customerConfirmedLabel", lang)}</label></div>
                    {confirmForm.customer_confirmed && (
                      <div className="field"><label>{t("feedbackScoreLabel", lang)}</label>
                        <select value={confirmForm.feedback_score} onChange={(e) => setConfirmForm((f) => ({ ...f, feedback_score: e.target.value }))}>
                          {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{"⭐".repeat(n)}</option>)}
                        </select></div>
                    )}
                  </div>
                  <button className="btn btn-primary" disabled={busyId === installation.id} onClick={() => doConfirmInstall(installation.id)}>✅ {t("confirmInstallationAction", lang)}</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
