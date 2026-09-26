import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { listGodownQueue, godownAccept, godownReject, listPackingItems, verifyPacking, listGodownStaff, assignGodownHandover, listDeliveryChallanItems, godownScanPick } from "../../lib/retailApi";
import { statusBadgeClass } from "../../lib/retailModules.js";
import ProofPhotoUpload from "../../components/ProofPhotoUpload.jsx";
import QRScanner from "../../components/QRScanner.jsx";

// Godown/Inventory's own real screen (v2_93i, extended v2_93m for Immediate Delivery): every order gets a PENDING handover row here
// — either "standard" (Retail already packed it) or "Immediate Delivery" (Godown itself must verify & pack, derived from the linked
// packing record's own status, not a separate flag). Accept requires a receiving photo already uploaded (enforced server-side by
// retail_godown_accept); reject requires a reason and puts the order on_hold, notifying Retail + the return department + Management.
export default function GodownHandovers({ lang, profile }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(null); // handover id currently expanded
  const [busyId, setBusyId] = useState(null);
  const [photoCount, setPhotoCount] = useState({});
  const [form, setForm] = useState({ packages_received: 1, quantity_verified: true, condition_verified: true, rack_location: "", notes: "" });
  const [rejectForm, setRejectForm] = useState({ reason: "", missing_qty: "", damaged_qty: "" });
  // Immediate Delivery — verify & pack, right after Accept, reusing the SAME photo-gated retail_verify_packing RPC
  // RetailPacking.jsx already uses (now additionally permitted for Godown staff — see v2_93m).
  const [packOpen, setPackOpen] = useState(null); // handover id whose packing form is showing
  const [packItems, setPackItems] = useState({}); // packing_id -> items
  const [packForm, setPackForm] = useState({ qc_status: "PASSED", package_count: 1, condition_notes: "" });
  const [packPhotoCount, setPackPhotoCount] = useState({});
  // Head/Supervisor/oversight-only "assign a specific worker" control (v2_93p) — retail_assign_godown_handover
  // itself re-checks this server-side; this just decides whether to show the picker at all.
  const canAssign = !!(profile?.permissions?.hasGlobalOversight || profile?.permissions?.isDepartmentHead || profile?.permissions?.isSupervisor);
  const [godownStaff, setGodownStaff] = useState([]);
  const [assignPickerOpen, setAssignPickerOpen] = useState(null); // handover id
  const [assignChoice, setAssignChoice] = useState({});
  const [assignBusyId, setAssignBusyId] = useState(null);
  // Scan-verified picking for an ACCEPTED handover with a linked Delivery Challan (v2_93r).
  const [pickOpenFor, setPickOpenFor] = useState(null); // handover id
  const [dcItemsByHandover, setDcItemsByHandover] = useState({}); // handover id -> retail_delivery_challan_items rows
  const [pickMsg, setPickMsg] = useState(null);
  const [scanningPick, setScanningPick] = useState(false);

  // Fetched regardless of canAssign: everyone sees WHO a handover is currently assigned to, only the reassignment
  // control itself is gated by role.
  useEffect(() => { listGodownStaff().then(({ data }) => setGodownStaff(data || [])); }, []);
  const staffName = (id) => godownStaff.find((s) => s.id === id)?.full_name || null;

  async function doAssign(handoverId) {
    const userId = assignChoice[handoverId];
    if (!userId) return;
    setAssignBusyId(handoverId);
    const { error: err } = await assignGodownHandover(handoverId, userId);
    setAssignBusyId(null);
    if (err) { setError(true); return; }
    setAssignPickerOpen(null);
    load();
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await listGodownQueue();
    if (err) { setError(true); setLoading(false); return; }
    setRows(data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function toggleOpen(id) {
    setOpen((cur) => (cur === id ? null : id));
    setForm({ packages_received: 1, quantity_verified: true, condition_verified: true, rack_location: "", notes: "" });
    setRejectForm({ reason: "", missing_qty: "", damaged_qty: "" });
  }

  async function doAccept(id, row) {
    setBusyId(id);
    const { error: err } = await godownAccept(id, Number(form.packages_received) || 1, form.quantity_verified, form.condition_verified, form.rack_location || null, form.notes || null);
    setBusyId(null);
    if (err) { setError(true); return; }
    setOpen(null);
    // Immediate Delivery: the linked packing record isn't Ready for Godown yet — open the verify & pack form right here.
    if (row.retail_packing_records && row.retail_packing_records.status !== "READY_FOR_GODOWN") {
      setPackOpen(id);
      setPackForm({ qc_status: "PASSED", package_count: 1, condition_notes: "" });
      const { data: its } = await listPackingItems(row.retail_packing_records.id);
      setPackItems((m) => ({ ...m, [row.retail_packing_records.id]: its || [] }));
    }
    load();
  }

  async function doVerifyPack(handoverId, packingId) {
    setBusyId(handoverId);
    const items = (packItems[packingId] || []).map((it) => ({ order_item_id: it.order_item_id, quantity_confirmed: it.quantity_confirmed || it.retail_order_items?.quantity || 1 }));
    const { error: err } = await verifyPacking(packingId, items, packForm.qc_status, Number(packForm.package_count) || 1, packForm.condition_notes || null, null);
    setBusyId(null);
    if (err) { setError(true); return; }
    setPackOpen(null);
    load();
  }

  async function togglePick(handover) {
    const opening = pickOpenFor !== handover.id;
    setPickOpenFor(opening ? handover.id : null);
    setPickMsg(null);
    setScanningPick(false);
    if (opening && handover.delivery_challan_id && !dcItemsByHandover[handover.id]) {
      const { data } = await listDeliveryChallanItems(handover.delivery_challan_id);
      setDcItemsByHandover((m) => ({ ...m, [handover.id]: data || [] }));
    }
  }

  async function onPickScanned(handoverId, code) {
    const { error: err } = await godownScanPick(handoverId, code);
    setScanningPick(false);
    if (err) { setPickMsg({ type: "error", text: err.message.includes("WRONG ITEM") ? `⚠️ ${t("wrongItemScannedMsg", lang)}` : err.message }); return; }
    setPickMsg({ type: "success", text: t("itemPickedMsg", lang) });
    const handover = rows.find((r) => r.id === handoverId);
    if (handover?.delivery_challan_id) {
      const { data } = await listDeliveryChallanItems(handover.delivery_challan_id);
      setDcItemsByHandover((m) => ({ ...m, [handoverId]: data || [] }));
    }
  }

  async function doReject(id) {
    if (!rejectForm.reason.trim()) return;
    setBusyId(id);
    const { error: err } = await godownReject(id, rejectForm.reason, rejectForm.missing_qty ? Number(rejectForm.missing_qty) : null, rejectForm.damaged_qty ? Number(rejectForm.damaged_qty) : null, null, null);
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

  const pending = rows.filter((r) => r.status === "PENDING");
  const decided = rows.filter((r) => r.status !== "PENDING").slice(0, 20);

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📦</div>
        <div className="dept-header-text"><h1>{t("godownHandoversTitle", lang)}</h1></div>
      </div>

      <div className="card">
        <h3>{t("pendingHandoversLabel", lang)} ({pending.length})</h3>
        {pending.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {pending.map((r) => (
          <div key={r.id} className="task-meta" style={{ flexDirection: "column", alignItems: "stretch", padding: "10px 0", borderBottom: "1px solid var(--border, #eee)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 700 }}>{r.retail_orders?.order_number} — {r.retail_orders?.customer_name}</div>
                <div className="sub">{r.retail_orders?.delivery_address}</div>
                {r.retail_orders?.installation_required && <span className="badge">{t("requiresInstallationLabel", lang)}</span>}
                {r.retail_packing_records && r.retail_packing_records.status !== "READY_FOR_GODOWN" && (
                  <span className="badge ASSIGNED">{t("godownMustPackBadgeLabel", lang)}</span>
                )}
                <div className="sub">{t("assignedToLabel", lang)}: {staffName(r.responsible_user_id) || "—"}</div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {canAssign && (
                  <button className="btn btn-outline" onClick={() => { setAssignPickerOpen((cur) => (cur === r.id ? null : r.id)); setAssignChoice((c) => ({ ...c, [r.id]: c[r.id] || r.responsible_user_id || "" })); }}>
                    👤 {t("assignWorkerAction", lang)}
                  </button>
                )}
                <button className="btn btn-outline" onClick={() => toggleOpen(r.id)}>{open === r.id ? t("cancel", lang) : t("reviewAction", lang)}</button>
              </div>
            </div>
            {assignPickerOpen === r.id && (
              <div className="task-meta" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                <select value={assignChoice[r.id] || ""} onChange={(e) => setAssignChoice((c) => ({ ...c, [r.id]: e.target.value }))}>
                  <option value="">{t("selectTeamMemberLabel", lang)}</option>
                  {godownStaff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
                </select>
                <button className="btn btn-primary" disabled={assignBusyId === r.id || !assignChoice[r.id]} onClick={() => doAssign(r.id)}>
                  {t("confirmAssignAction", lang)}
                </button>
              </div>
            )}
            {open === r.id && (
              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                <ProofPhotoUpload lang={lang} entityType="retail_godown_handover" entityId={r.id}
                  existingCount={photoCount[r.id] || 0}
                  onUploaded={() => setPhotoCount((c) => ({ ...c, [r.id]: (c[r.id] || 0) + 1 }))} />

                <div className="form-grid">
                  <div className="field"><label>{t("packagesReceivedLabel", lang)}</label>
                    <input type="number" min="0" value={form.packages_received} onChange={(e) => setForm((f) => ({ ...f, packages_received: e.target.value }))} /></div>
                  <div className="field"><label>{t("rackLocationLabel", lang)}</label>
                    <input value={form.rack_location} onChange={(e) => setForm((f) => ({ ...f, rack_location: e.target.value }))} /></div>
                  <div className="field full"><label className="task-meta" style={{ gap: 6 }}>
                    <input type="checkbox" checked={form.quantity_verified} onChange={(e) => setForm((f) => ({ ...f, quantity_verified: e.target.checked }))} />
                    {t("quantityVerifiedLabel", lang)}</label></div>
                  <div className="field full"><label className="task-meta" style={{ gap: 6 }}>
                    <input type="checkbox" checked={form.condition_verified} onChange={(e) => setForm((f) => ({ ...f, condition_verified: e.target.checked }))} />
                    {t("conditionVerifiedLabel", lang)}</label></div>
                  <div className="field full"><label>{t("notesLabel", lang)}</label>
                    <textarea rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></div>
                </div>
                <button className="btn btn-primary" disabled={busyId === r.id} onClick={() => doAccept(r.id, r)}>✅ {t("acceptHandoverAction", lang)}</button>

                <hr style={{ width: "100%", opacity: 0.3 }} />
                <div className="form-grid">
                  <div className="field full"><label>{t("rejectionReasonLabel", lang)} *</label>
                    <textarea rows={2} value={rejectForm.reason} onChange={(e) => setRejectForm((f) => ({ ...f, reason: e.target.value }))} /></div>
                  <div className="field"><label>{t("missingQtyLabel", lang)}</label>
                    <input type="number" min="0" value={rejectForm.missing_qty} onChange={(e) => setRejectForm((f) => ({ ...f, missing_qty: e.target.value }))} /></div>
                  <div className="field"><label>{t("damagedQtyLabel", lang)}</label>
                    <input type="number" min="0" value={rejectForm.damaged_qty} onChange={(e) => setRejectForm((f) => ({ ...f, damaged_qty: e.target.value }))} /></div>
                </div>
                <button className="btn btn-outline" disabled={busyId === r.id || !rejectForm.reason.trim()} onClick={() => doReject(r.id)}>✕ {t("rejectHandoverAction", lang)}</button>
              </div>
            )}

            {packOpen === r.id && r.retail_packing_records && (
              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                <b>📦 {t("verifyAndPackAction", lang)}</b>
                <ProofPhotoUpload lang={lang} entityType="retail_packing" entityId={r.retail_packing_records.id}
                  existingCount={packPhotoCount[r.retail_packing_records.id] || 0}
                  onUploaded={() => setPackPhotoCount((c) => ({ ...c, [r.retail_packing_records.id]: (c[r.retail_packing_records.id] || 0) + 1 }))} />
                <div className="form-grid">
                  <div className="field"><label>{t("qcStatusLabel", lang)}</label>
                    <select value={packForm.qc_status} onChange={(e) => setPackForm((f) => ({ ...f, qc_status: e.target.value }))}>
                      <option value="PASSED">{t("qcPassedLabel", lang)}</option>
                      <option value="FAILED">{t("qcFailedLabel", lang)}</option>
                    </select></div>
                  <div className="field"><label>{t("packageCountLabel", lang)}</label>
                    <input type="number" min="1" value={packForm.package_count} onChange={(e) => setPackForm((f) => ({ ...f, package_count: e.target.value }))} /></div>
                  <div className="field full"><label>{t("conditionNotesLabel", lang)}</label>
                    <textarea rows={2} value={packForm.condition_notes} onChange={(e) => setPackForm((f) => ({ ...f, condition_notes: e.target.value }))} /></div>
                </div>
                <button className="btn btn-primary" disabled={busyId === r.id} onClick={() => doVerifyPack(r.id, r.retail_packing_records.id)}>
                  ✅ {t("verifyPackingAction", lang)}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h3>{t("recentDecisionsLabel", lang)}</h3>
        {decided.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {decided.map((r) => (
          <div key={r.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--border, #eee)" }}>
            <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>{r.retail_orders?.order_number} — {r.retail_orders?.customer_name}</div>
              <span className={`badge ${statusBadgeClass(r.status)}`}>{r.status}</span>
              {r.status === "ACCEPTED" && r.delivery_challan_id && (
                <button className="btn btn-outline" onClick={() => togglePick(r)}>
                  🔍 {pickOpenFor === r.id ? t("cancel", lang) : t("scanToPickAction", lang)}
                </button>
              )}
            </div>
            {pickOpenFor === r.id && (
              <div style={{ marginTop: 8, display: "grid", gap: 10 }}>
                {pickMsg && <div className={`msg ${pickMsg.type}`}>{pickMsg.text}</div>}
                {(dcItemsByHandover[r.id] || []).map((it) => (
                  <div key={it.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
                    <span>{it.retail_order_items?.item_name || "—"} · {it.retail_inventory_items?.serial_number || "—"}</span>
                    <span className={`badge ${statusBadgeClass(it.retail_inventory_items?.status)}`}>{it.retail_inventory_items?.status || "—"}</span>
                  </div>
                ))}
                {!scanningPick && (
                  <button className="btn btn-primary" onClick={() => setScanningPick(true)}>📷 {t("scanToPickAction", lang)}</button>
                )}
                {scanningPick && <QRScanner lang={lang} onDetected={(code) => onPickScanned(r.id, code)} />}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
