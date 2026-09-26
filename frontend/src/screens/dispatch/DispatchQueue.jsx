import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import {
  listGodownQueue, startDispatch, preDispatchChecklist, recordDispatch, PRE_DISPATCH_CHECKLIST_KEYS,
  listInstallationQueue, startInstallation, recordInstallation, confirmInstallation,
} from "../../lib/retailApi";
import { statusBadgeClass } from "../../lib/retailModules.js";
import ProofPhotoUpload from "../../components/ProofPhotoUpload.jsx";

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
  const [vehicle, setVehicle] = useState({ vehicle_number: "", vehicle_transporter: "", package_count: 1, challan_ref: "" });

  const [installRows, setInstallRows] = useState([]);
  const [openInstall, setOpenInstall] = useState(null);
  const [installPhotoCount, setInstallPhotoCount] = useState({});
  const [installForm, setInstallForm] = useState({ team: "", pending_work: "", damage_rework: "" });
  const [confirmForm, setConfirmForm] = useState({ customer_confirmed: true, feedback_score: 5 });

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data, error: err }, { data: instRows }] = await Promise.all([listGodownQueue(), listInstallationQueue()]);
    if (err) { setError(true); setLoading(false); return; }
    setAccepted((data || []).filter((r) => r.status === "ACCEPTED"));
    setInstallRows(instRows || []);
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
    setVehicle({ vehicle_number: "", vehicle_transporter: "", package_count: 1, challan_ref: "" });
  }

  async function saveChecklist(orderId) {
    await preDispatchChecklist(orderId, checklist, null);
  }

  async function doRecordDispatch(orderId) {
    const rec = dispatches[orderId];
    if (!rec) return;
    setBusyId(orderId);
    const { error: err } = await recordDispatch(rec.id, vehicle.vehicle_number, vehicle.vehicle_transporter || null, Number(vehicle.package_count) || 1, vehicle.challan_ref || null, null, null);
    setBusyId(null);
    if (err) { setError(true); return; }
    setOpen(null);
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
