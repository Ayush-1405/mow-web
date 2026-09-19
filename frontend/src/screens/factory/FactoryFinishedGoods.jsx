import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { listAllFactoryFinishedGoods, listAllInhouseProductionRequests, factoryRecordFinishedGoods } from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";
import { useIncludeTestData } from "../../lib/testDataVisibility";
import IncludeTestDataToggle from "../../components/IncludeTestDataToggle";

const PAGE_SIZE = 20;

export default function FactoryFinishedGoods({ lang, profile }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [records, setRecords] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ jobId: "", quantity: "", storageLocation: "", barcode: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const { includeTestData, canToggle, setIncludeTestData } = useIncludeTestData(profile);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [recRes, jobRes] = await Promise.all([listAllFactoryFinishedGoods(includeTestData), listAllInhouseProductionRequests(includeTestData)]);
    if (recRes.error || jobRes.error) { setError(true); setLoading(false); return; }
    setRecords(recRes.data || []);
    setJobs(jobRes.data || []);
    setLoading(false);
  }, [includeTestData]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory_finished_goods_board", "factory_finished_goods", null, load), [load]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [debouncedSearch]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return records;
    return records.filter((r) => {
      const job = r.inhouse_production_requests;
      const hay = [r.fg_number, job?.job_order_number, job?.product_item, job?.projects?.project_code, r.storage_location, r.barcode].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [records, debouncedSearch]);

  const visible = filtered.slice(0, visibleCount);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.jobId) { setMsg("Select a job first."); return; }
    if (!form.quantity || Number(form.quantity) <= 0) { setMsg("Completed quantity is required."); return; }
    setSaving(true);
    setMsg("");
    const { error: err } = await factoryRecordFinishedGoods(form.jobId, Number(form.quantity), {
      storageLocation: form.storageLocation || null, barcode: form.barcode || null, notes: form.notes || null,
    });
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    setForm({ jobId: "", quantity: "", storageLocation: "", barcode: "", notes: "" });
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
          <h1>{t("factoryFinishedGoodsTitle", lang) || "Finished Goods"}</h1>
          <div className="sub">Only jobs with a Final QC Pass or Conditional Pass can be recorded here — enforced server-side.</div>
        </div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Search FG number/job/location/barcode…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => exportRowsToExcel("Finished-Goods-export.xlsx", "Finished Goods", filtered.map((r) => ({
            FGNumber: r.fg_number, Job: r.inhouse_production_requests?.job_order_number, Project: r.inhouse_production_requests?.projects?.project_code,
            Product: r.inhouse_production_requests?.product_item, Quantity: r.completed_quantity, Location: r.storage_location || "", Barcode: r.barcode || "",
            Date: new Date(r.created_at).toLocaleDateString(),
          })))}>Export</button>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "Record Finished Goods"}
          </button>
          <IncludeTestDataToggle canToggle={canToggle} includeTestData={includeTestData} onChange={setIncludeTestData} />
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
            <div className="field"><label>Completed Quantity (required)</label><input type="number" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} /></div>
            <div className="field"><label>Storage Location</label><input value={form.storageLocation} onChange={(e) => setForm((f) => ({ ...f, storageLocation: e.target.value }))} /></div>
            <div className="field"><label>Barcode/QR</label><input value={form.barcode} onChange={(e) => setForm((f) => ({ ...f, barcode: e.target.value }))} /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Notes</label><input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></div>
            {msg && <div className="msg error" style={{ gridColumn: "1 / -1" }}>{msg}</div>}
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Record Finished Goods"}</button>
          </form>
        </div>
      )}

      <div className="card">
        {visible.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {visible.map((r) => {
          const job = r.inhouse_production_requests;
          return (
            <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 6, borderBottom: "1px solid var(--border, #e5e7eb)" }}>
              <span style={{ fontWeight: 700 }}>{r.fg_number}</span>
              <span className="sub">{job?.job_order_number} — {job?.projects?.project_code} — {job?.product_item}</span>
              <span className="sub">Qty {r.completed_quantity}</span>
              <span className="sub">{r.storage_location || "—"}</span>
              <span className="sub">{r.barcode || "—"}</span>
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
