import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { listAllFactoryWastageRecords, listAllInhouseProductionRequests, factoryRecordWastage } from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";

const PAGE_SIZE = 20;

export default function FactoryWastage({ lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [records, setRecords] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ jobId: "", materialName: "", processStage: "", issuedQuantity: "", usedQuantity: "", returnedQuantity: "", wastageQuantity: "", reason: "", reusable: false, notes: "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [recRes, jobRes] = await Promise.all([listAllFactoryWastageRecords(), listAllInhouseProductionRequests()]);
    if (recRes.error || jobRes.error) { setError(true); setLoading(false); return; }
    setRecords(recRes.data || []);
    setJobs(jobRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory_wastage_board", "factory_wastage_records", null, load), [load]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [debouncedSearch]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return records;
    return records.filter((r) => {
      const job = r.inhouse_production_requests;
      const hay = [job?.job_order_number, job?.product_item, job?.projects?.project_code, r.material_name, r.reason].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [records, debouncedSearch]);

  const visible = filtered.slice(0, visibleCount);
  const totalWastage = useMemo(() => filtered.reduce((s, r) => s + Number(r.wastage_quantity || 0), 0), [filtered]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.jobId) { setMsg("Select a job first."); return; }
    if (!form.materialName.trim()) { setMsg("Material name is required."); return; }
    if (!form.wastageQuantity || Number(form.wastageQuantity) < 0) { setMsg("A valid wastage quantity is required."); return; }
    if (!form.reason.trim()) { setMsg("A wastage reason is required."); return; }
    setSaving(true);
    setMsg("");
    const { error: err } = await factoryRecordWastage(form.jobId, form.materialName, Number(form.wastageQuantity), form.reason, {
      processStage: form.processStage || null, issuedQuantity: form.issuedQuantity || null, usedQuantity: form.usedQuantity || null,
      returnedQuantity: form.returnedQuantity || null, reusable: form.reusable, notes: form.notes || null,
    });
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    setForm({ jobId: "", materialName: "", processStage: "", issuedQuantity: "", usedQuantity: "", returnedQuantity: "", wastageQuantity: "", reason: "", reusable: false, notes: "" });
    setShowForm(false);
    load();
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
          <h1>{t("factoryWastageTitle", lang) || "Wastage"}</h1>
          <div className="sub">Material is free text (no material master exists yet) — issued/used/returned quantities are self-reported here, not reconciled against a live inventory ledger.</div>
        </div>
      </div>

      <div className="dept-meta-grid">
        <div className="card dept-meta-tile"><div className="label">Total Wastage Qty (filtered)</div><div className="value">{totalWastage}</div></div>
        <div className="card dept-meta-tile"><div className="label">Records</div><div className="value">{filtered.length}</div></div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Search job/material/reason…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => exportRowsToExcel("Wastage-export.xlsx", "Wastage", filtered.map((r) => ({
            Job: r.inhouse_production_requests?.job_order_number, Project: r.inhouse_production_requests?.projects?.project_code,
            Material: r.material_name, WastageQty: r.wastage_quantity, Reusable: r.reusable ? "Yes" : "No", Reason: r.reason,
            Date: new Date(r.created_at).toLocaleDateString(),
          })))}>Export</button>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "Record Wastage"}
          </button>
        </div>
        <div className="sub" style={{ marginTop: 6 }}>{filtered.length} record{filtered.length === 1 ? "" : "s"}</div>
      </div>

      {showForm && (
        <div className="card">
          <form onSubmit={handleSubmit} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Job (required)</label>
              <select value={form.jobId} onChange={(e) => setForm((f) => ({ ...f, jobId: e.target.value }))} required>
                <option value="">—</option>
                {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_order_number} — {j.product_item}</option>)}
              </select>
            </div>
            <div className="field"><label>Material (required)</label><input value={form.materialName} onChange={(e) => setForm((f) => ({ ...f, materialName: e.target.value }))} /></div>
            <div className="field"><label>Process/Stage</label><input value={form.processStage} onChange={(e) => setForm((f) => ({ ...f, processStage: e.target.value }))} /></div>
            <div className="field"><label>Issued Qty</label><input type="number" value={form.issuedQuantity} onChange={(e) => setForm((f) => ({ ...f, issuedQuantity: e.target.value }))} /></div>
            <div className="field"><label>Used Qty</label><input type="number" value={form.usedQuantity} onChange={(e) => setForm((f) => ({ ...f, usedQuantity: e.target.value }))} /></div>
            <div className="field"><label>Returned Qty</label><input type="number" value={form.returnedQuantity} onChange={(e) => setForm((f) => ({ ...f, returnedQuantity: e.target.value }))} /></div>
            <div className="field"><label>Wastage Qty (required)</label><input type="number" value={form.wastageQuantity} onChange={(e) => setForm((f) => ({ ...f, wastageQuantity: e.target.value }))} /></div>
            <label className="sub" style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={form.reusable} onChange={(e) => setForm((f) => ({ ...f, reusable: e.target.checked }))} /> Reusable (not scrap)
            </label>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Reason (required)</label><input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Notes</label><input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></div>
            {msg && <div className="msg error" style={{ gridColumn: "1 / -1" }}>{msg}</div>}
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Record Wastage"}</button>
          </form>
        </div>
      )}

      <div className="card">
        {visible.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {visible.map((r) => {
          const job = r.inhouse_production_requests;
          return (
            <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 6, borderBottom: "1px solid var(--border, #e5e7eb)" }}>
              <span style={{ fontWeight: 700 }}>{job?.job_order_number || "—"}</span>
              <span className="sub">{job?.projects?.project_code} — {job?.product_item}</span>
              <span className="sub">{r.material_name}</span>
              <span className="sub">Wastage {r.wastage_quantity}</span>
              <span className={`badge ${r.reusable ? "VERIFIED" : "RETURNED"}`}>{r.reusable ? "Reusable" : "Scrap"}</span>
              <span className="sub">{r.reason}</span>
              <span className="sub">{new Date(r.created_at).toLocaleDateString()}</span>
            </div>
          );
        })}
        {visibleCount < filtered.length && (
          <button type="button" className="btn btn-outline" style={{ marginTop: 8 }} onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}>
            Load More ({filtered.length - visibleCount} more)
          </button>
        )}
      </div>
    </div>
  );
}
