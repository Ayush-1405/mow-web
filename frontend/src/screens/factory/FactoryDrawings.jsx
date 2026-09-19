import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import {
  listAllFactoryDrawings, listAllInhouseProductionRequests, factoryUploadDrawing, factoryDecideDrawing,
  factoryIssueDrawing, uploadFactoryAttachment,
} from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";

const PAGE_SIZE = 20;
const CATEGORIES = [
  "Working Drawing", "Production Drawing", "Furniture Detail Drawing", "Cutting Drawing", "RCP",
  "Electrical Drawing", "MEP Drawing", "Material Specification", "Job Card", "Others",
];
const STATUS_BADGE = { Draft: "CLOSED", Submitted: "ASSIGNED", "Revision Required": "RETURNED", Approved: "VERIFIED", "Issued for Production": "VERIFIED" };

// Every upload is a new row (factory_upload_drawing never updates an
// existing one) -- old approved versions are never lost, verified live via
// a real revision cycle (v1 rejected -> v2 uploaded -> v1 still present).
export default function FactoryDrawings({ lang, profile }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [drawings, setDrawings] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ jobId: "", category: CATEGORIES[0], customCategoryName: "", title: "", file: null, revisionReason: "", parentDrawingId: "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [drRes, jobRes] = await Promise.all([listAllFactoryDrawings(), listAllInhouseProductionRequests()]);
    if (drRes.error || jobRes.error) { setError(true); setLoading(false); return; }
    setDrawings(drRes.data || []);
    setJobs(jobRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory_drawings_board", "factory_drawings", null, load), [load]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [debouncedSearch, categoryFilter]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return drawings.filter((d) => {
      if (categoryFilter && d.category !== categoryFilter) return false;
      if (!q) return true;
      const job = d.inhouse_production_requests;
      const hay = [d.title, job?.job_order_number, job?.product_item, job?.projects?.project_code].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [drawings, debouncedSearch, categoryFilter]);

  const visible = filtered.slice(0, visibleCount);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.jobId) { setMsg("Select a job first."); return; }
    if (!form.title.trim()) { setMsg("A title is required."); return; }
    if (!form.file) { setMsg("A file is required."); return; }
    if (form.category === "Others" && !form.customCategoryName.trim()) { setMsg("A custom category name is required when category is Others."); return; }
    setSaving(true);
    setMsg("");
    const job = jobs.find((j) => j.id === form.jobId);
    const { path, error: uploadErr } = await uploadFactoryAttachment({
      projectId: job?.project_id, module: "factory_drawing", relatedRecordId: form.jobId,
      file: form.file, fileCategory: form.category, uploadedBy: profile?.id,
    });
    if (uploadErr) { setSaving(false); setMsg(uploadErr.message); return; }
    const { error: err } = await factoryUploadDrawing(form.jobId, form.category, form.title, path, {
      customCategoryName: form.customCategoryName || null, revisionReason: form.revisionReason || null, parentDrawingId: form.parentDrawingId || null,
    });
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    setForm({ jobId: "", category: CATEGORIES[0], customCategoryName: "", title: "", file: null, revisionReason: "", parentDrawingId: "" });
    setShowForm(false);
    load();
  }

  async function handleDecide(drawing, decision) {
    let notes = null;
    if (decision === "Revision Required") {
      notes = window.prompt("Revision notes (required):");
      if (!notes || !notes.trim()) return;
    }
    setMsg("");
    const { error: err } = await factoryDecideDrawing(drawing.id, decision, notes);
    if (err) { setMsg(err.message); return; }
    load();
  }

  async function handleIssue(drawing) {
    setMsg("");
    const { error: err } = await factoryIssueDrawing(drawing.id);
    if (err) { setMsg(err.message); return; }
    load();
  }

  function handleExport() {
    exportRowsToExcel("Drawings-export.xlsx", "Drawings", filtered.map((d) => ({
      Title: d.title, Category: d.category === "Others" ? d.custom_category_name : d.category, Job: d.inhouse_production_requests?.job_order_number,
      Version: d.version_number, Status: d.status, UploadedAt: new Date(d.uploaded_at).toLocaleDateString(),
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
          <h1>{t("factoryDrawingsTitle", lang) || "Drawings"}</h1>
          <div className="sub">Draft → Submitted → Revision Required → Approved → Issued for Production. Old versions are never overwritten.</div>
        </div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Search title/job/project…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">All categories</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={handleExport}>Export</button>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => setShowForm((s) => !s)}>{showForm ? "Cancel" : "Upload Drawing"}</button>
        </div>
        <div className="sub" style={{ marginTop: 6 }}>{filtered.length} drawing{filtered.length === 1 ? "" : "s"}</div>
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
            <div className="field"><label>Category (required)</label>
              <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {form.category === "Others" && (
              <div className="field"><label>Custom Category Name (required)</label><input value={form.customCategoryName} onChange={(e) => setForm((f) => ({ ...f, customCategoryName: e.target.value }))} /></div>
            )}
            <div className="field"><label>Title (required)</label><input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} /></div>
            <div className="field"><label>File (required)</label><input type="file" onChange={(e) => setForm((f) => ({ ...f, file: e.target.files?.[0] || null }))} /></div>
            <div className="field"><label>Revising an Existing Drawing?</label>
              <select value={form.parentDrawingId} onChange={(e) => setForm((f) => ({ ...f, parentDrawingId: e.target.value }))}>
                <option value="">No — new drawing</option>
                {drawings.filter((d) => d.job_id === form.jobId).map((d) => <option key={d.id} value={d.id}>{d.title} (v{d.version_number})</option>)}
              </select>
            </div>
            {form.parentDrawingId && <div className="field"><label>Revision Reason</label><input value={form.revisionReason} onChange={(e) => setForm((f) => ({ ...f, revisionReason: e.target.value }))} /></div>}
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Uploading…" : "Upload"}</button>
          </form>
        </div>
      )}

      <div className="card">
        {visible.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {visible.map((d) => {
          const job = d.inhouse_production_requests;
          return (
            <div key={d.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 6, borderBottom: "1px solid var(--border, #e5e7eb)" }}>
              <span style={{ fontWeight: 700 }}>{d.title}</span>
              <span className="sub">{job?.job_order_number} — {job?.projects?.project_code}</span>
              <span className="sub">{d.category === "Others" ? d.custom_category_name : d.category}</span>
              <span className="sub">v{d.version_number}</span>
              <span className={`badge ${STATUS_BADGE[d.status] || "CLOSED"}`}>{d.status}</span>
              {d.status === "Draft" && <button type="button" className="btn btn-outline" onClick={() => handleDecide(d, "Approved")}>Approve</button>}
              {d.status === "Draft" && <button type="button" className="btn btn-outline" onClick={() => handleDecide(d, "Revision Required")}>Request Revision</button>}
              {d.status === "Approved" && <button type="button" className="btn btn-primary" onClick={() => handleIssue(d)}>Issue for Production</button>}
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
