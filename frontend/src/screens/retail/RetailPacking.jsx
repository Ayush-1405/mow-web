import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { startPacking, verifyPacking, sendToGodown, listPackingItems, listGodownStaff } from "../../lib/retailApi";
import { statusBadgeClass } from "../../lib/retailModules.js";
import ProofPhotoUpload from "../../components/ProofPhotoUpload.jsx";

// Packing (v2_93i): confirmed orders whose fulfilment items are Ready. "Ready for Godown" is only reachable through
// retail_verify_packing(), which itself refuses without a real, already-uploaded packing photo — this screen cannot bypass that.
export default function RetailPacking({ lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [confirmedOrders, setConfirmedOrders] = useState([]);
  const [packingByOrder, setPackingByOrder] = useState({});
  const [open, setOpen] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [photoCount, setPhotoCount] = useState({});
  const [items, setItems] = useState({});
  const [form, setForm] = useState({ qc_status: "PASSED", package_count: 1, condition_notes: "" });
  const [godownForm, setGodownForm] = useState({ location_id: "", responsible_user_id: "", expected_at: "" });
  const [locations, setLocations] = useState([]);
  const [godownStaff, setGodownStaff] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data: orders, error: err1 }, { data: pk, error: err2 }, { data: locs }] = await Promise.all([
      supabase.from("retail_orders").select("*").eq("is_active", true).eq("status", "CONFIRMED").order("created_at", { ascending: false }).limit(100),
      supabase.from("retail_packing_records").select("*").order("created_at", { ascending: false }).limit(200),
      supabase.from("locations").select("id, name_en, type").eq("is_active", true).in("type", ["godown"]),
    ]);
    if (err1 || err2) { setError(true); setLoading(false); return; }
    setConfirmedOrders(orders || []);
    const byOrder = {};
    (pk || []).forEach((p) => { byOrder[p.order_id] = p; });
    setPackingByOrder(byOrder);
    setLocations(locs || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { listGodownStaff().then(({ data }) => setGodownStaff(data || [])); }, []);

  async function beginPacking(orderId, partialReason) {
    setBusyId(orderId);
    const { data, error: err } = await startPacking(orderId, partialReason || null);
    setBusyId(null);
    if (err) {
      if (!partialReason && /not Ready/i.test(err.message || "")) {
        const reason = window.prompt(t("partialReasonPromptLabel", lang));
        if (reason) return beginPacking(orderId, reason);
      }
      setError(true);
      return;
    }
    setPackingByOrder((m) => ({ ...m, [orderId]: data }));
    setOpen(orderId);
    const { data: its } = await listPackingItems(data.id);
    setItems((m) => ({ ...m, [data.id]: its || [] }));
  }

  async function doVerify(packing) {
    setBusyId(packing.order_id);
    const payload = (items[packing.id] || []).map((it) => ({ order_item_id: it.order_item_id, quantity_confirmed: it.quantity_confirmed || it.retail_order_items?.quantity || 1 }));
    const { data, error: err } = await verifyPacking(packing.id, payload, form.qc_status, Number(form.package_count) || 1, form.condition_notes || null, null);
    setBusyId(null);
    if (err) { setError(true); return; }
    setPackingByOrder((m) => ({ ...m, [packing.order_id]: data }));
  }

  async function doSendToGodown(orderId) {
    if (!godownForm.responsible_user_id) return;
    setBusyId(orderId);
    const { error: err } = await sendToGodown(orderId, godownForm.location_id || null, godownForm.responsible_user_id, godownForm.expected_at || null, null);
    setBusyId(null);
    if (err) { setError(true); return; }
    setOpen(null);
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
        <div className="dept-header-icon" aria-hidden="true">📦</div>
        <div className="dept-header-text"><h1>{t("retailPackingTitle", lang)}</h1></div>
      </div>

      <div className="card">
        {confirmedOrders.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {confirmedOrders.map((o) => {
          const packing = packingByOrder[o.id];
          const isOpen = open === o.id;
          return (
            <div key={o.id} className="task-meta" style={{ flexDirection: "column", alignItems: "stretch", padding: "10px 0", borderBottom: "1px solid var(--border, #eee)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{o.order_number} — {o.customer_name}</div>
                  {packing && <span className={`badge ${statusBadgeClass(packing.status)}`}>{packing.status}</span>}
                </div>
                {!packing && <button className="btn btn-primary" disabled={busyId === o.id} onClick={() => beginPacking(o.id)}>{t("startPackingAction", lang)}</button>}
                {packing && packing.status !== "READY_FOR_GODOWN" && (
                  <button className="btn btn-outline" onClick={() => { setOpen(isOpen ? null : o.id); if (!items[packing.id]) listPackingItems(packing.id).then(({ data }) => setItems((m) => ({ ...m, [packing.id]: data || [] }))); }}>
                    {isOpen ? t("cancel", lang) : t("continueAction", lang)}
                  </button>
                )}
                {packing && packing.status === "READY_FOR_GODOWN" && (
                  <button className="btn btn-primary" onClick={() => setOpen(isOpen ? null : o.id)}>{isOpen ? t("cancel", lang) : t("sendToGodownAction", lang)}</button>
                )}
              </div>

              {isOpen && packing && packing.status !== "READY_FOR_GODOWN" && (
                <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                  <ProofPhotoUpload lang={lang} entityType="retail_packing" entityId={packing.id}
                    existingCount={photoCount[packing.id] || 0}
                    onUploaded={() => setPhotoCount((c) => ({ ...c, [packing.id]: (c[packing.id] || 0) + 1 }))} />
                  <div className="form-grid">
                    <div className="field"><label>{t("qcStatusLabel", lang)}</label>
                      <select value={form.qc_status} onChange={(e) => setForm((f) => ({ ...f, qc_status: e.target.value }))}>
                        <option value="PASSED">{t("qcPassedLabel", lang)}</option>
                        <option value="FAILED">{t("qcFailedLabel", lang)}</option>
                      </select></div>
                    <div className="field"><label>{t("packageCountLabel", lang)}</label>
                      <input type="number" min="1" value={form.package_count} onChange={(e) => setForm((f) => ({ ...f, package_count: e.target.value }))} /></div>
                    <div className="field full"><label>{t("conditionNotesLabel", lang)}</label>
                      <textarea rows={2} value={form.condition_notes} onChange={(e) => setForm((f) => ({ ...f, condition_notes: e.target.value }))} /></div>
                  </div>
                  <button className="btn btn-primary" disabled={busyId === o.id} onClick={() => doVerify(packing)}>{t("verifyPackingAction", lang)}</button>
                </div>
              )}

              {isOpen && packing && packing.status === "READY_FOR_GODOWN" && (
                <div style={{ marginTop: 10, display: "grid", gap: 10 }} className="form-grid">
                  <div className="field"><label>{t("godownLocationLabel", lang)}</label>
                    <select value={godownForm.location_id} onChange={(e) => setGodownForm((f) => ({ ...f, location_id: e.target.value }))}>
                      <option value="">—</option>
                      {locations.map((l) => <option key={l.id} value={l.id}>{l.name_en}</option>)}
                    </select></div>
                  <div className="field"><label>{t("godownResponsiblePersonLabel", lang)} *</label>
                    <select value={godownForm.responsible_user_id} onChange={(e) => setGodownForm((f) => ({ ...f, responsible_user_id: e.target.value }))}>
                      <option value="">—</option>
                      {godownStaff.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                    </select></div>
                  <div className="field"><label>{t("expectedHandoverLabel", lang)}</label>
                    <input type="datetime-local" value={godownForm.expected_at} onChange={(e) => setGodownForm((f) => ({ ...f, expected_at: e.target.value }))} /></div>
                  <div className="field full">
                    <button className="btn btn-primary" disabled={busyId === o.id || !godownForm.responsible_user_id} onClick={() => doSendToGodown(o.id)}>
                      📦 {t("sendToGodownAction", lang)}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
