import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { listAllInhouseProductionRequests, listAllProductionStageUpdates, factoryUpdateStage } from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";
import { useIncludeTestData } from "../../lib/testDataVisibility";
import IncludeTestDataToggle from "../../components/IncludeTestDataToggle";

const PAGE_SIZE = 20;
const PRODUCTION_STAGES = [
  "Planning", "Drawing Pending", "Drawing Approved", "Material Pending", "Material Available",
  "Cutting", "Edge Banding", "CNC", "Carpentry/Assembly", "Polishing/Painting", "Hardware Fitting",
  "Final Assembly", "QC", "Packing", "Ready for Dispatch", "Dispatched", "Installed/Completed",
];
const STAGE_STATUSES = ["pending", "in_progress", "completed", "on_hold", "skipped"];
const STATUS_COLORS = { completed: "#15803d", in_progress: "#b45309", on_hold: "#b91c1c", skipped: "#6b7280", pending: "#9ca3af" };

// The "WIP Stages" card -- a cross-job board over the exact same
// production_stage_updates table + factory_update_stage RPC already used
// (and tested) inside a Job Order's Job Card in FactoryJobOrders.jsx. This
// is the "see every job's current stage across the whole factory floor"
// view; updating a stage here uses the identical write path.
export default function FactoryWipStages({ lang, profile }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [stages, setStages] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ jobId: "", stage: PRODUCTION_STAGES[0], status: "in_progress", notes: "", quantityCompleted: "", quantityPending: "", delayReason: "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const { includeTestData, canToggle, setIncludeTestData } = useIncludeTestData(profile);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [stageRes, jobRes] = await Promise.all([listAllProductionStageUpdates(includeTestData), listAllInhouseProductionRequests(includeTestData)]);
    if (stageRes.error || jobRes.error) { setError(true); setLoading(false); return; }
    setStages(stageRes.data || []);
    setJobs(jobRes.data || []);
    setLoading(false);
  }, [includeTestData]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory_wip_board", "production_stage_updates", null, load), [load]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [debouncedSearch, stageFilter, statusFilter]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return stages.filter((s) => {
      if (stageFilter && s.stage !== stageFilter) return false;
      if (statusFilter && s.status !== statusFilter) return false;
      if (!q) return true;
      const job = s.inhouse_production_requests;
      const hay = [job?.job_order_number, job?.product_item, job?.projects?.project_code, job?.projects?.customer, s.notes].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [stages, debouncedSearch, stageFilter, statusFilter]);

  const visible = filtered.slice(0, visibleCount);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.jobId) { setMsg("Select a job first."); return; }
    setSaving(true);
    setMsg("");
    const { error: err } = await factoryUpdateStage(form.jobId, form.stage, form.status, {
      notes: form.notes || null, quantityCompleted: form.quantityCompleted || null,
      quantityPending: form.quantityPending || null, delayReason: form.delayReason || null,
    });
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    setForm({ jobId: "", stage: PRODUCTION_STAGES[0], status: "in_progress", notes: "", quantityCompleted: "", quantityPending: "", delayReason: "" });
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
          <h1>{t("factoryWipStagesTitle", lang) || "WIP Stages"}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Search job/product/project…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">All stages</option>
            {PRODUCTION_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">All statuses</option>
            {STAGE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => exportRowsToExcel("WIP-Stages-export.xlsx", "WIP Stages", filtered.map((s) => ({
            Job: s.inhouse_production_requests?.job_order_number, Project: s.inhouse_production_requests?.projects?.project_code,
            Product: s.inhouse_production_requests?.product_item, Stage: s.stage, Status: s.status,
            QtyCompleted: s.quantity_completed ?? "", QtyPending: s.quantity_pending ?? "",
          })))}>Export</button>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "Update a Stage"}
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
                {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_order_number} — {j.product_item} ({j.purchase_requests?.projects?.project_code})</option>)}
              </select>
            </div>
            <div className="field"><label>Stage</label>
              <select value={form.stage} onChange={(e) => setForm((f) => ({ ...f, stage: e.target.value }))}>
                {PRODUCTION_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="field"><label>Status</label>
              <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
                {STAGE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="field"><label>Qty Completed</label><input type="number" value={form.quantityCompleted} onChange={(e) => setForm((f) => ({ ...f, quantityCompleted: e.target.value }))} /></div>
            <div className="field"><label>Qty Pending</label><input type="number" value={form.quantityPending} onChange={(e) => setForm((f) => ({ ...f, quantityPending: e.target.value }))} /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Notes</label><input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></div>
            {form.status === "on_hold" && <div className="field" style={{ gridColumn: "1 / -1" }}><label>Delay Reason</label><input value={form.delayReason} onChange={(e) => setForm((f) => ({ ...f, delayReason: e.target.value }))} /></div>}
            {msg && <div className="msg error" style={{ gridColumn: "1 / -1" }}>{msg}</div>}
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Update Stage"}</button>
          </form>
        </div>
      )}

      <div className="card">
        {visible.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {visible.map((s) => {
          const job = s.inhouse_production_requests;
          return (
            <div key={s.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 6, borderBottom: "1px solid var(--border, #e5e7eb)" }}>
              <span style={{ fontWeight: 700 }}>{job?.job_order_number || "—"}</span>
              <span className="sub">{job?.projects?.project_code} — {job?.projects?.customer}</span>
              <span className="sub">{job?.product_item}</span>
              <span className="sub">{s.stage}</span>
              <span className="sub" style={{ border: `1px solid ${STATUS_COLORS[s.status]}`, color: STATUS_COLORS[s.status], borderRadius: 6, padding: "2px 6px" }}>{s.status}</span>
              <span className="sub">{s.quantity_completed ?? "—"} done / {s.quantity_pending ?? "—"} pending</span>
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
