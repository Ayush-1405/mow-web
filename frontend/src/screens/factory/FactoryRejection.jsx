import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { listAllInhouseProductionRequests, listAllFactoryRejectionRecords, factoryRecordRejection, uploadFactoryAttachment } from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";
import { useIncludeTestData } from "../../lib/testDataVisibility";
import IncludeTestDataToggle from "../../components/IncludeTestDataToggle";

const PAGE_SIZE = 20;
const DISPOSITIONS = [["scrap", "Scrap"], ["return_to_vendor", "Return to Vendor"], ["other", "Other"]];

// The "Rejection" card -- distinct from Rework: a rejection is a permanent
// scrap/return outcome (factory_rejection_records), not something sent back
// for correction. A photo is mandatory to record a rejection (enforced
// server-side in factory_record_rejection, not just in this form).
export default function FactoryRejection({ lang, profile }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [records, setRecords] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [search, setSearch] = useState("");
  const [dispositionFilter, setDispositionFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ jobId: "", quantity: "", reason: "", responsibleStage: "", disposition: "scrap", notes: "", photoFile: null });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const { includeTestData, canToggle, setIncludeTestData } = useIncludeTestData(profile);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [recRes, jobRes] = await Promise.all([listAllFactoryRejectionRecords(includeTestData), listAllInhouseProductionRequests(includeTestData)]);
    if (recRes.error || jobRes.error) { setError(true); setLoading(false); return; }
    setRecords(recRes.data || []);
    setJobs(jobRes.data || []);
    setLoading(false);
  }, [includeTestData]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory_rejection_board", "factory_rejection_records", null, load), [load]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [debouncedSearch, dispositionFilter]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return records.filter((r) => {
      if (dispositionFilter && r.disposition !== dispositionFilter) return false;
      if (!q) return true;
      const job = r.inhouse_production_requests;
      const hay = [job?.job_order_number, job?.product_item, job?.projects?.project_code, job?.projects?.customer, r.reason].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [records, debouncedSearch, dispositionFilter]);

  const visible = filtered.slice(0, visibleCount);
  const totalRejected = useMemo(() => filtered.reduce((sum, r) => sum + Number(r.rejected_quantity || 0), 0), [filtered]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.jobId) { setMsg("Select a job first."); return; }
    if (!form.quantity || Number(form.quantity) <= 0) { setMsg("Rejected quantity is required."); return; }
    if (!form.reason.trim()) { setMsg("A rejection reason is required."); return; }
    if (!form.photoFile) { setMsg("At least one photo is required to record a rejection."); return; }
    setSaving(true);
    setMsg("");
    const job = jobs.find((j) => j.id === form.jobId);
    const { path, error: uploadErr } = await uploadFactoryAttachment({
      projectId: job?.project_id, module: "factory_rejection", relatedRecordId: form.jobId,
      file: form.photoFile, fileCategory: "Rejection Photo", uploadedBy: profile?.id,
    });
    if (uploadErr) { setSaving(false); setMsg(uploadErr.message); return; }
    const { error: err } = await factoryRecordRejection(form.jobId, Number(form.quantity), form.reason, {
      responsibleStage: form.responsibleStage || null, disposition: form.disposition, notes: form.notes || null, photos: [path],
    });
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    setForm({ jobId: "", quantity: "", reason: "", responsibleStage: "", disposition: "scrap", notes: "", photoFile: null });
    setShowForm(false);
    load();
  }

  function handleExport() {
    exportRowsToExcel("Rejection-export.xlsx", "Rejection", filtered.map((r) => ({
      Job: r.inhouse_production_requests?.job_order_number, Project: r.inhouse_production_requests?.projects?.project_code,
      Product: r.inhouse_production_requests?.product_item, Quantity: r.rejected_quantity, Disposition: r.disposition,
      Reason: r.reason, Date: new Date(r.rejected_at).toLocaleDateString(),
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
          <h1>{t("factoryRejectionTitle", lang) || "Rejection"}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="dept-meta-grid">
        <div className="card dept-meta-tile"><div className="label">Total Rejected Qty (filtered)</div><div className="value">{totalRejected}</div></div>
        <div className="card dept-meta-tile"><div className="label">Records</div><div className="value">{filtered.length}</div></div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Search job/product/project…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <select value={dispositionFilter} onChange={(e) => setDispositionFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">All dispositions</option>
            {DISPOSITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={handleExport}>Export</button>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "Record Rejection"}
          </button>
          <IncludeTestDataToggle canToggle={canToggle} includeTestData={includeTestData} onChange={setIncludeTestData} />
        </div>
      </div>

      {showForm && (
        <div className="card">
          <form onSubmit={handleSubmit} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Job (required)</label>
              <select value={form.jobId} onChange={(e) => setForm((f) => ({ ...f, jobId: e.target.value }))} required>
                <option value="">—</option>
                {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_order_number} — {j.product_item} ({j.purchase_requests?.projects?.project_code})</option>)}
              </select>
            </div>
            <div className="field"><label>Rejected Quantity (required)</label><input type="number" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} /></div>
            <div className="field"><label>Responsible Stage</label><input value={form.responsibleStage} onChange={(e) => setForm((f) => ({ ...f, responsibleStage: e.target.value }))} /></div>
            <div className="field"><label>Disposition</label>
              <select value={form.disposition} onChange={(e) => setForm((f) => ({ ...f, disposition: e.target.value }))}>
                {DISPOSITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Reason (required)</label><input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} /></div>
            <div className="field"><label>Photo (required)</label><input type="file" accept="image/*" onChange={(e) => setForm((f) => ({ ...f, photoFile: e.target.files?.[0] || null }))} /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Notes</label><input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></div>
            {msg && <div className="msg error" style={{ gridColumn: "1 / -1" }}>{msg}</div>}
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Record Rejection"}</button>
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
              <span className="sub">{job?.projects?.project_code} — {job?.projects?.customer}</span>
              <span className="sub">{job?.product_item}</span>
              <span className="sub">Qty {r.rejected_quantity}</span>
              <span className="badge RETURNED">{r.disposition}</span>
              <span className="sub">{r.reason}</span>
              {r.photos?.length > 0 && <span className="sub">📷 {r.photos.length}</span>}
              <span className="sub">{new Date(r.rejected_at).toLocaleDateString()}</span>
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
