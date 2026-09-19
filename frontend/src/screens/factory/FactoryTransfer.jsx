import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import {
  listAllFactoryTransfers, listFactoryLocationsAll, listAllInhouseProductionRequests, listAllFactoryFinishedGoods,
  factoryCreateTransfer, factoryUpdateTransferStatus, uploadFactoryAttachment,
} from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";
import { useIncludeTestData } from "../../lib/testDataVisibility";
import IncludeTestDataToggle from "../../components/IncludeTestDataToggle";

const PAGE_SIZE = 20;
const STATUSES = ["Draft", "Dispatched", "In Transit", "Partially Received", "Received", "Disputed"];
const STATUS_BADGE = { Draft: "CLOSED", Dispatched: "ASSIGNED", "In Transit": "IN_PROGRESS", "Partially Received": "REVISION", Received: "VERIFIED", Disputed: "RETURNED" };
const TO_TYPES = [["godown", "Godown"], ["site", "Site"], ["dispatch", "Dispatch"], ["other_location", "Other Location"]];

// "Prevent transfer above available Finished Goods" is enforced server-side
// in factory_create_transfer (verified live: a transfer requesting more
// than the linked Finished Goods record's completed_quantity is rejected).
export default function FactoryTransfer({ lang, profile }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [transfers, setTransfers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [finishedGoods, setFinishedGoods] = useState([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    fromLocationId: "", toType: "godown", toLocationId: "", toDescription: "", jobId: "", projectId: "",
    vehicleNumber: "", transporter: "", driverContact: "", dispatchDate: "", expectedReceiptDate: "",
    finishedGoodsId: "", description: "", quantity: "", packageCount: "",
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const { includeTestData, canToggle, setIncludeTestData } = useIncludeTestData(profile);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [trRes, locRes, jobRes, fgRes] = await Promise.all([
      listAllFactoryTransfers(includeTestData), listFactoryLocationsAll(), listAllInhouseProductionRequests(includeTestData), listAllFactoryFinishedGoods(includeTestData),
    ]);
    if (trRes.error || locRes.error || jobRes.error || fgRes.error) { setError(true); setLoading(false); return; }
    setTransfers(trRes.data || []);
    setLocations(locRes.data || []);
    setJobs(jobRes.data || []);
    setFinishedGoods(fgRes.data || []);
    setLoading(false);
  }, [includeTestData]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory_transfers_board", "factory_transfers", null, load), [load]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [debouncedSearch, statusFilter]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return transfers.filter((tr) => {
      if (statusFilter && tr.status !== statusFilter) return false;
      if (!q) return true;
      const hay = [tr.transfer_number, tr.projects?.project_code, tr.inhouse_production_requests?.job_order_number, tr.vehicle_number].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [transfers, debouncedSearch, statusFilter]);

  const visible = filtered.slice(0, visibleCount);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.quantity || Number(form.quantity) <= 0) { setMsg("Quantity is required."); return; }
    setSaving(true);
    setMsg("");
    const job = jobs.find((j) => j.id === form.jobId);
    const items = [{
      finished_goods_id: form.finishedGoodsId || null, description: form.description || "Transferred goods",
      quantity: Number(form.quantity), package_count: form.packageCount || null,
    }];
    const { error: err } = await factoryCreateTransfer({ ...form, projectId: form.projectId || job?.project_id || null }, items);
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    setForm({ fromLocationId: "", toType: "godown", toLocationId: "", toDescription: "", jobId: "", projectId: "", vehicleNumber: "", transporter: "", driverContact: "", dispatchDate: "", expectedReceiptDate: "", finishedGoodsId: "", description: "", quantity: "", packageCount: "" });
    setShowForm(false);
    load();
  }

  function handleExport() {
    exportRowsToExcel("Transfer-export.xlsx", "Transfer", filtered.map((tr) => ({
      TransferNumber: tr.transfer_number, Job: tr.inhouse_production_requests?.job_order_number, ToType: tr.to_type,
      VehicleNumber: tr.vehicle_number || "", DispatchDate: tr.dispatch_date || "", Status: tr.status,
    })));
  }

  if (loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 60 }} /><div className="skeleton-block" style={{ height: 220 }} /></div>;
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
        <div className="dept-header-icon" aria-hidden="true">🏭</div>
        <div className="dept-header-text">
          <h1>{t("factoryTransferTitle", lang) || "Transfer"}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Search transfer/job/vehicle…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={handleExport}>Export</button>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => setShowForm((s) => !s)}>{showForm ? "Cancel" : "New Transfer"}</button>
          <IncludeTestDataToggle canToggle={canToggle} includeTestData={includeTestData} onChange={setIncludeTestData} />
        </div>
        <div className="sub" style={{ marginTop: 6 }}>{filtered.length} transfer{filtered.length === 1 ? "" : "s"}</div>
      </div>

      {msg && <div className="msg error">{msg}</div>}

      {showForm && (
        <div className="card">
          <form onSubmit={handleSubmit} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            <div className="field"><label>From Location</label>
              <select value={form.fromLocationId} onChange={(e) => setForm((f) => ({ ...f, fromLocationId: e.target.value }))}>
                <option value="">—</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="field"><label>To Type (required)</label>
              <select value={form.toType} onChange={(e) => setForm((f) => ({ ...f, toType: e.target.value }))}>
                {TO_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            {form.toType === "other_location" ? (
              <div className="field"><label>To Description</label><input value={form.toDescription} onChange={(e) => setForm((f) => ({ ...f, toDescription: e.target.value }))} /></div>
            ) : (
              <div className="field"><label>To Location</label>
                <select value={form.toLocationId} onChange={(e) => setForm((f) => ({ ...f, toLocationId: e.target.value }))}>
                  <option value="">—</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            )}
            <div className="field"><label>Job</label>
              <select value={form.jobId} onChange={(e) => setForm((f) => ({ ...f, jobId: e.target.value }))}>
                <option value="">—</option>
                {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_order_number} — {j.product_item}</option>)}
              </select>
            </div>
            <div className="field"><label>Finished Goods Item</label>
              <select value={form.finishedGoodsId} onChange={(e) => setForm((f) => ({ ...f, finishedGoodsId: e.target.value }))}>
                <option value="">—</option>
                {finishedGoods.map((fg) => <option key={fg.id} value={fg.id}>{fg.fg_number} — qty {fg.completed_quantity}</option>)}
              </select>
            </div>
            <div className="field"><label>Description</label><input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></div>
            <div className="field"><label>Quantity (required)</label><input type="number" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} /></div>
            <div className="field"><label>Package Count</label><input type="number" value={form.packageCount} onChange={(e) => setForm((f) => ({ ...f, packageCount: e.target.value }))} /></div>
            <div className="field"><label>Vehicle Number</label><input value={form.vehicleNumber} onChange={(e) => setForm((f) => ({ ...f, vehicleNumber: e.target.value }))} /></div>
            <div className="field"><label>Transporter</label><input value={form.transporter} onChange={(e) => setForm((f) => ({ ...f, transporter: e.target.value }))} /></div>
            <div className="field"><label>Driver Contact</label><input value={form.driverContact} onChange={(e) => setForm((f) => ({ ...f, driverContact: e.target.value }))} /></div>
            <div className="field"><label>Dispatch Date</label><input type="date" value={form.dispatchDate} onChange={(e) => setForm((f) => ({ ...f, dispatchDate: e.target.value }))} /></div>
            <div className="field"><label>Expected Receipt Date</label><input type="date" value={form.expectedReceiptDate} onChange={(e) => setForm((f) => ({ ...f, expectedReceiptDate: e.target.value }))} /></div>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Create Transfer"}</button>
          </form>
        </div>
      )}

      <div className="card">
        {visible.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {visible.map((tr) => <TransferRow key={tr.id} tr={tr} profile={profile} onChanged={load} setMsg={setMsg} />)}
        {visibleCount < filtered.length && (
          <button type="button" className="btn btn-outline" style={{ marginTop: 8 }} onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}>
            Load More ({filtered.length - visibleCount} more)
          </button>
        )}
      </div>
    </div>
  );
}

function TransferRow({ tr, profile, onChanged, setMsg }) {
  const [showReceive, setShowReceive] = useState(false);
  const [damageNotes, setDamageNotes] = useState("");
  const [podFile, setPodFile] = useState(null);

  async function handleStatus(status) {
    if (status === "Disputed" && !damageNotes.trim()) { setMsg("Damage/shortage notes are required to dispute a transfer."); return; }
    let podPath = null;
    if (podFile) {
      const { path, error: uploadErr } = await uploadFactoryAttachment({ module: "factory_transfer_pod", relatedRecordId: tr.id, file: podFile, fileCategory: "POD", uploadedBy: profile?.id });
      if (uploadErr) { setMsg(uploadErr.message); return; }
      podPath = path;
    }
    const { error: err } = await factoryUpdateTransferStatus(tr.id, status, { podPath, damageShortageNotes: damageNotes || null });
    if (err) { setMsg(err.message); return; }
    setShowReceive(false);
    onChanged();
  }

  return (
    <div className="card" style={{ marginBottom: 6 }}>
      <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700 }}>{tr.transfer_number}</span>
        <span className="sub">{tr.inhouse_production_requests?.job_order_number} — {tr.projects?.project_code}</span>
        <span className="sub">To {tr.to_type}{tr.vehicle_number ? ` — ${tr.vehicle_number}` : ""}</span>
        <span className={`badge ${STATUS_BADGE[tr.status] || "CLOSED"}`}>{tr.status}</span>
        {tr.status === "Draft" && <button type="button" className="btn btn-outline" onClick={() => handleStatus("Dispatched")}>Mark Dispatched</button>}
        {["Dispatched", "In Transit"].includes(tr.status) && <button type="button" className="btn btn-outline" onClick={() => setShowReceive((s) => !s)}>{showReceive ? "Cancel" : "Receive / Dispute"}</button>}
      </div>
      {showReceive && (
        <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", marginTop: 6 }}>
          <div className="field"><label>POD (proof of delivery)</label><input type="file" onChange={(e) => setPodFile(e.target.files?.[0] || null)} /></div>
          <div className="field"><label>Damage/Shortage Notes</label><input value={damageNotes} onChange={(e) => setDamageNotes(e.target.value)} /></div>
          <button type="button" className="btn btn-primary" onClick={() => handleStatus("Received")}>Mark Received</button>
          <button type="button" className="btn btn-outline" onClick={() => handleStatus("Partially Received")}>Partially Received</button>
          <button type="button" className="btn btn-outline" onClick={() => handleStatus("Disputed")}>Mark Disputed</button>
        </div>
      )}
      {tr.damage_shortage_notes && <div className="sub" style={{ color: "#b91c1c" }}>Damage/shortage: {tr.damage_shortage_notes}</div>}
    </div>
  );
}
