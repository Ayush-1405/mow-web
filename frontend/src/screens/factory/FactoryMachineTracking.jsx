import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import {
  listFactoryMachines, listFactoryMachineLogs, listFactoryLocationsAll, listAllInhouseProductionRequests,
  factoryUpsertMachine, factoryStartMachineJob, factoryStopMachineJob, uploadFactoryAttachment,
} from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";

const PAGE_SIZE = 20;
const STATUS_BADGE = { running: "IN_PROGRESS", idle: "ASSIGNED", maintenance: "REVISION", breakdown: "RETURNED" };

export default function FactoryMachineTracking({ lang, profile }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [machines, setMachines] = useState([]);
  const [logs, setLogs] = useState([]);
  const [locations, setLocations] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [showMachineForm, setShowMachineForm] = useState(false);
  const [machineForm, setMachineForm] = useState({ machineCode: "", machineName: "", machineType: "", locationId: "" });
  const [showStartForm, setShowStartForm] = useState(false);
  const [startForm, setStartForm] = useState({ machineId: "", jobId: "", process: "", shift: "Day", plannedQuantity: "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [machRes, logRes, locRes, jobRes] = await Promise.all([
      listFactoryMachines(), listFactoryMachineLogs(null), listFactoryLocationsAll(), listAllInhouseProductionRequests(),
    ]);
    if (machRes.error || logRes.error || locRes.error || jobRes.error) { setError(true); setLoading(false); return; }
    setMachines(machRes.data || []);
    setLogs(logRes.data || []);
    setLocations(locRes.data || []);
    setJobs(jobRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory_machines_board", "factory_machines", null, load), [load]);
  useEffect(() => subscribeTable("factory_machine_logs_board", "factory_machine_logs", null, load), [load]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [debouncedSearch]);

  const filteredMachines = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return machines;
    return machines.filter((m) => [m.machine_code, m.machine_name, m.machine_type].filter(Boolean).join(" ").toLowerCase().includes(q));
  }, [machines, debouncedSearch]);

  const visible = filteredMachines.slice(0, visibleCount);
  const openLogByMachine = useMemo(() => {
    const m = new Map();
    logs.forEach((l) => { if (!l.end_time) m.set(l.machine_id, l); });
    return m;
  }, [logs]);

  async function handleMachineSubmit(e) {
    e.preventDefault();
    if (!machineForm.machineCode.trim() || !machineForm.machineName.trim()) { setMsg("Machine code and name are required."); return; }
    setSaving(true);
    setMsg("");
    const { error: err } = await factoryUpsertMachine(null, machineForm);
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    setMachineForm({ machineCode: "", machineName: "", machineType: "", locationId: "" });
    setShowMachineForm(false);
    load();
  }

  async function handleStartSubmit(e) {
    e.preventDefault();
    if (!startForm.machineId) { setMsg("Select a machine."); return; }
    setSaving(true);
    setMsg("");
    const { error: err } = await factoryStartMachineJob(startForm.machineId, startForm.jobId || null, startForm.process, startForm.shift, startForm.plannedQuantity || null);
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    setStartForm({ machineId: "", jobId: "", process: "", shift: "Day", plannedQuantity: "" });
    setShowStartForm(false);
    load();
  }

  function handleExport() {
    exportRowsToExcel("Machine-Tracking-export.xlsx", "Machines", filteredMachines.map((m) => ({
      Code: m.machine_code, Name: m.machine_name, Type: m.machine_type || "", Location: m.factory_locations?.name || "", Status: m.status,
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
          <h1>{t("factoryMachineTrackingTitle", lang) || "Machine Tracking"}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Search machine code/name/type…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={handleExport}>Export</button>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setShowMachineForm((s) => !s)}>{showMachineForm ? "Cancel" : "New Machine"}</button>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => setShowStartForm((s) => !s)}>{showStartForm ? "Cancel" : "Start Machine Job"}</button>
        </div>
      </div>

      {msg && <div className="msg error">{msg}</div>}

      {showMachineForm && (
        <div className="card">
          <form onSubmit={handleMachineSubmit} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            <div className="field"><label>Machine Code (required)</label><input value={machineForm.machineCode} onChange={(e) => setMachineForm((f) => ({ ...f, machineCode: e.target.value }))} /></div>
            <div className="field"><label>Machine Name (required)</label><input value={machineForm.machineName} onChange={(e) => setMachineForm((f) => ({ ...f, machineName: e.target.value }))} /></div>
            <div className="field"><label>Type</label><input value={machineForm.machineType} onChange={(e) => setMachineForm((f) => ({ ...f, machineType: e.target.value }))} /></div>
            <div className="field"><label>Location</label>
              <select value={machineForm.locationId} onChange={(e) => setMachineForm((f) => ({ ...f, locationId: e.target.value }))}>
                <option value="">—</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save Machine"}</button>
          </form>
        </div>
      )}

      {showStartForm && (
        <div className="card">
          <form onSubmit={handleStartSubmit} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            <div className="field"><label>Machine (required)</label>
              <select value={startForm.machineId} onChange={(e) => setStartForm((f) => ({ ...f, machineId: e.target.value }))} required>
                <option value="">—</option>
                {machines.filter((m) => m.status !== "running").map((m) => <option key={m.id} value={m.id}>{m.machine_code} — {m.machine_name}</option>)}
              </select>
            </div>
            <div className="field"><label>Job</label>
              <select value={startForm.jobId} onChange={(e) => setStartForm((f) => ({ ...f, jobId: e.target.value }))}>
                <option value="">—</option>
                {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_order_number} — {j.product_item}</option>)}
              </select>
            </div>
            <div className="field"><label>Process</label><input value={startForm.process} onChange={(e) => setStartForm((f) => ({ ...f, process: e.target.value }))} /></div>
            <div className="field"><label>Shift</label>
              <select value={startForm.shift} onChange={(e) => setStartForm((f) => ({ ...f, shift: e.target.value }))}>
                <option value="Day">Day</option><option value="Night">Night</option><option value="General">General</option>
              </select>
            </div>
            <div className="field"><label>Planned Quantity</label><input type="number" value={startForm.plannedQuantity} onChange={(e) => setStartForm((f) => ({ ...f, plannedQuantity: e.target.value }))} /></div>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Starting…" : "Start"}</button>
          </form>
        </div>
      )}

      <div className="card">
        {visible.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {visible.map((m) => (
          <MachineRow key={m.id} machine={m} openLog={openLogByMachine.get(m.id)} profile={profile} onChanged={load} setMsg={setMsg} />
        ))}
        {visibleCount < filteredMachines.length && (
          <button type="button" className="btn btn-outline" style={{ marginTop: 8 }} onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}>
            Load More ({filteredMachines.length - visibleCount} more)
          </button>
        )}
      </div>
    </div>
  );
}

function MachineRow({ machine, openLog, profile, onChanged, setMsg }) {
  const [stopping, setStopping] = useState(false);
  const [stopForm, setStopForm] = useState({ processedQuantity: "", acceptedQuantity: "", rejectedQuantity: "", downtimeMinutes: "", downtimeReason: "", notes: "", newMachineStatus: "idle", breakdownPhotoFile: null });

  async function handleStop() {
    if (stopForm.newMachineStatus === "breakdown" && !stopForm.downtimeReason.trim()) { setMsg("A breakdown reason is required."); return; }
    let breakdownPhotos = null;
    if (stopForm.breakdownPhotoFile) {
      const { path, error: uploadErr } = await uploadFactoryAttachment({
        module: "factory_machine_breakdown", relatedRecordId: openLog.id, file: stopForm.breakdownPhotoFile,
        fileCategory: "Breakdown Photo", uploadedBy: profile?.id,
      });
      if (uploadErr) { setMsg(uploadErr.message); return; }
      breakdownPhotos = [path];
    }
    const { error: err } = await factoryStopMachineJob(openLog.id, { ...stopForm, breakdownPhotos });
    if (err) { setMsg(err.message); return; }
    setStopping(false);
    onChanged();
  }

  return (
    <div className="card" style={{ marginBottom: 6 }}>
      <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700 }}>{machine.machine_code}</span>
        <span className="sub">{machine.machine_name} ({machine.machine_type || "—"})</span>
        <span className="sub">{machine.factory_locations?.name || "—"}</span>
        <span className={`badge ${STATUS_BADGE[machine.status] || "CLOSED"}`}>{machine.status}</span>
        {openLog && <button type="button" className="btn btn-outline" onClick={() => setStopping((s) => !s)}>{stopping ? "Cancel" : "Stop Job"}</button>}
      </div>
      {openLog && <div className="sub">Running since {new Date(openLog.start_time).toLocaleString()}{openLog.process ? ` — ${openLog.process}` : ""}</div>}
      {stopping && openLog && (
        <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", marginTop: 6 }}>
          <div className="field"><label>Processed Qty</label><input type="number" value={stopForm.processedQuantity} onChange={(e) => setStopForm((f) => ({ ...f, processedQuantity: e.target.value }))} /></div>
          <div className="field"><label>Accepted Qty</label><input type="number" value={stopForm.acceptedQuantity} onChange={(e) => setStopForm((f) => ({ ...f, acceptedQuantity: e.target.value }))} /></div>
          <div className="field"><label>Rejected Qty</label><input type="number" value={stopForm.rejectedQuantity} onChange={(e) => setStopForm((f) => ({ ...f, rejectedQuantity: e.target.value }))} /></div>
          <div className="field"><label>Downtime (min)</label><input type="number" value={stopForm.downtimeMinutes} onChange={(e) => setStopForm((f) => ({ ...f, downtimeMinutes: e.target.value }))} /></div>
          <div className="field"><label>New Machine Status</label>
            <select value={stopForm.newMachineStatus} onChange={(e) => setStopForm((f) => ({ ...f, newMachineStatus: e.target.value }))}>
              <option value="idle">Idle</option><option value="maintenance">Maintenance</option><option value="breakdown">Breakdown</option>
            </select>
          </div>
          {stopForm.newMachineStatus === "breakdown" && (
            <>
              <div className="field"><label>Breakdown Reason (required)</label><input value={stopForm.downtimeReason} onChange={(e) => setStopForm((f) => ({ ...f, downtimeReason: e.target.value }))} /></div>
              <div className="field"><label>Breakdown Photo</label><input type="file" accept="image/*" onChange={(e) => setStopForm((f) => ({ ...f, breakdownPhotoFile: e.target.files?.[0] || null }))} /></div>
            </>
          )}
          <div className="field" style={{ gridColumn: "1 / -1" }}><label>Notes</label><input value={stopForm.notes} onChange={(e) => setStopForm((f) => ({ ...f, notes: e.target.value }))} /></div>
          <button type="button" className="btn btn-primary" onClick={handleStop}>Confirm Stop</button>
        </div>
      )}
    </div>
  );
}
