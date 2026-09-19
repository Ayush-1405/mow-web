import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { listAllFactoryPackingRecords, listAllInhouseProductionRequests, factorySavePacking } from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";

const PAGE_SIZE = 20;
const STATUSES = ["Pending", "In Progress", "Packed", "Ready for Transfer"];
const STATUS_BADGE = { Pending: "ASSIGNED", "In Progress": "IN_PROGRESS", Packed: "VERIFIED", "Ready for Transfer": "VERIFIED" };

export default function FactoryPacking({ lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [records, setRecords] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ jobId: "", packedQuantity: "", packageCount: "", packageDimensions: "", packageWeight: "", packingMaterial: "", barcode: "", status: "Pending", notes: "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [recRes, jobRes] = await Promise.all([listAllFactoryPackingRecords(), listAllInhouseProductionRequests()]);
    if (recRes.error || jobRes.error) { setError(true); setLoading(false); return; }
    setRecords(recRes.data || []);
    setJobs(jobRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory_packing_board", "factory_packing_records", null, load), [load]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [debouncedSearch, statusFilter]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return records.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (!q) return true;
      const job = r.inhouse_production_requests;
      const hay = [r.packing_number, job?.job_order_number, job?.product_item, job?.projects?.project_code, r.barcode].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [records, debouncedSearch, statusFilter]);

  const visible = filtered.slice(0, visibleCount);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.jobId) { setMsg("Select a job first."); return; }
    setSaving(true);
    setMsg("");
    const { error: err } = await factorySavePacking(form.jobId, null, {
      packedQuantity: form.packedQuantity || null, packageCount: form.packageCount || null,
      packageDimensions: form.packageDimensions || null, packageWeight: form.packageWeight || null,
      packingMaterial: form.packingMaterial || null, barcode: form.barcode || null, status: form.status, notes: form.notes || null,
    });
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    setForm({ jobId: "", packedQuantity: "", packageCount: "", packageDimensions: "", packageWeight: "", packingMaterial: "", barcode: "", status: "Pending", notes: "" });
    setShowForm(false);
    load();
  }

  async function handleStatusChange(record, status) {
    setMsg("");
    const { error: err } = await factorySavePacking(record.job_id, record.id, {
      finishedGoodsId: record.finished_goods_id, packedQuantity: record.packed_quantity, packageCount: record.package_count,
      packageDimensions: record.package_dimensions, packageWeight: record.package_weight, packingMaterial: record.packing_material,
      checklist: record.checklist, barcode: record.barcode, status, notes: record.notes,
    });
    if (err) { setMsg(err.message); return; }
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
          <h1>{t("factoryPackingTitle", lang) || "Packing"}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Search packing/job/barcode…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => exportRowsToExcel("Packing-export.xlsx", "Packing", filtered.map((r) => ({
            PackingNumber: r.packing_number, Job: r.inhouse_production_requests?.job_order_number, Project: r.inhouse_production_requests?.projects?.project_code,
            Product: r.inhouse_production_requests?.product_item, PackedQty: r.packed_quantity ?? "", PackageCount: r.package_count ?? "", Status: r.status,
          })))}>Export</button>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "New Packing Record"}
          </button>
        </div>
        <div className="sub" style={{ marginTop: 6 }}>{filtered.length} record{filtered.length === 1 ? "" : "s"}</div>
      </div>

      {msg && <div className="msg error">{msg}</div>}

      {showForm && (
        <div className="card">
          <form onSubmit={handleSubmit} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Job (required)</label>
              <select value={form.jobId} onChange={(e) => setForm((f) => ({ ...f, jobId: e.target.value }))} required>
                <option value="">—</option>
                {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_order_number} — {j.product_item}</option>)}
              </select>
            </div>
            <div className="field"><label>Packed Quantity</label><input type="number" value={form.packedQuantity} onChange={(e) => setForm((f) => ({ ...f, packedQuantity: e.target.value }))} /></div>
            <div className="field"><label>Package Count</label><input type="number" value={form.packageCount} onChange={(e) => setForm((f) => ({ ...f, packageCount: e.target.value }))} /></div>
            <div className="field"><label>Dimensions</label><input value={form.packageDimensions} onChange={(e) => setForm((f) => ({ ...f, packageDimensions: e.target.value }))} /></div>
            <div className="field"><label>Weight</label><input type="number" value={form.packageWeight} onChange={(e) => setForm((f) => ({ ...f, packageWeight: e.target.value }))} /></div>
            <div className="field"><label>Packing Material</label><input value={form.packingMaterial} onChange={(e) => setForm((f) => ({ ...f, packingMaterial: e.target.value }))} /></div>
            <div className="field"><label>Barcode/Label</label><input value={form.barcode} onChange={(e) => setForm((f) => ({ ...f, barcode: e.target.value }))} /></div>
            <div className="field"><label>Status</label>
              <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Notes</label><input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></div>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save Packing Record"}</button>
          </form>
        </div>
      )}

      <div className="card">
        {visible.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {visible.map((r) => {
          const job = r.inhouse_production_requests;
          return (
            <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 6, borderBottom: "1px solid var(--border, #e5e7eb)" }}>
              <span style={{ fontWeight: 700 }}>{r.packing_number}</span>
              <span className="sub">{job?.job_order_number} — {job?.projects?.project_code} — {job?.product_item}</span>
              <span className="sub">Qty {r.packed_quantity ?? "—"} · {r.package_count ?? "—"} pkgs</span>
              <span className={`badge ${STATUS_BADGE[r.status] || "CLOSED"}`}>{r.status}</span>
              <select value={r.status} onChange={(e) => handleStatusChange(r, e.target.value)}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
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
