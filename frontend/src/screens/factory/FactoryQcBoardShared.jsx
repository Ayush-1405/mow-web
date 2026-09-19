import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import {
  listAllInhouseProductionRequests, listAllFactoryQualityChecks, factoryRecordQualityCheck, listInteriorPeople,
  uploadFactoryAttachment,
} from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";
import { useIncludeTestData } from "../../lib/testDataVisibility";
import IncludeTestDataToggle from "../../components/IncludeTestDataToggle";

const PAGE_SIZE = 20;

// Shared board behind both the "In-process QC" and "Final QC" dashboard
// cards -- same factory_quality_checks table and factory_record_quality_check
// RPC as the QC form nested in a Job Order's Job Card (FactoryJobOrders.jsx),
// filtered to one qc_stage. Not a separate QC system: recording a check here
// updates the exact same job/task/notification chain already tested there.
export default function FactoryQcBoardShared({ lang, profile, qcStage, titleKey, titleFallback }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [checks, setChecks] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [search, setSearch] = useState("");
  const [resultFilter, setResultFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    jobId: "", dimensions: false, material: false, finish: false, hardware: false, drawing: false, quantity: false,
    result: "pass", defectReason: "", reworkRequired: false, assignedReworkPerson: "", photoFile: null,
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const { includeTestData, canToggle, setIncludeTestData } = useIncludeTestData(profile);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [checkRes, jobRes, peopleRes] = await Promise.all([
      listAllFactoryQualityChecks(qcStage, includeTestData), listAllInhouseProductionRequests(includeTestData), listInteriorPeople(),
    ]);
    if (checkRes.error || jobRes.error) { setError(true); setLoading(false); return; }
    setChecks(checkRes.data || []);
    setJobs(jobRes.data || []);
    setForm((f) => ({ ...f, factoryPeople: (peopleRes.data || []).filter((p) => p.department_name === "Factory/Manufacturing") }));
    setLoading(false);
  }, [qcStage, includeTestData]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable(`factory_qc_board_${qcStage}`, "factory_quality_checks", `qc_stage=eq.${qcStage}`, load), [qcStage, load]);

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [debouncedSearch, resultFilter]);

  const factoryPeople = form.factoryPeople || [];

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return checks.filter((c) => {
      if (resultFilter && c.result !== resultFilter) return false;
      if (!q) return true;
      const job = c.inhouse_production_requests;
      const hay = [job?.job_order_number, job?.product_item, job?.projects?.project_code, job?.projects?.customer, c.defect_reason].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [checks, debouncedSearch, resultFilter]);

  const visible = filtered.slice(0, visibleCount);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.jobId) { setMsg("Select a job first."); return; }
    if (form.reworkRequired && !form.defectReason.trim()) { setMsg("A defect reason is required when rework is needed."); return; }
    if (form.result === "fail" && !form.photoFile) { setMsg("At least one photo is required when QC result is Fail."); return; }
    setSaving(true);
    setMsg("");
    let photos = null;
    if (form.photoFile) {
      const job = jobs.find((j) => j.id === form.jobId);
      const { path, error: uploadErr } = await uploadFactoryAttachment({
        projectId: job?.project_id, module: "factory_qc", relatedRecordId: form.jobId,
        file: form.photoFile, fileCategory: "QC Photo", uploadedBy: profile?.id,
      });
      if (uploadErr) { setSaving(false); setMsg(uploadErr.message); return; }
      photos = [path];
    }
    const { error: err } = await factoryRecordQualityCheck(form.jobId, form, form.result, {
      defectReason: form.defectReason || null, reworkRequired: form.reworkRequired,
      assignedReworkPerson: form.assignedReworkPerson || null, qcStage, photos,
    });
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    setForm((f) => ({ ...f, jobId: "", dimensions: false, material: false, finish: false, hardware: false, drawing: false, quantity: false, result: "pass", defectReason: "", reworkRequired: false, assignedReworkPerson: "", photoFile: null }));
    setShowForm(false);
    load();
  }

  function handleExport() {
    exportRowsToExcel(`${titleFallback || "QC"}-export.xlsx`, titleFallback || "QC", filtered.map((c) => ({
      Job: c.inhouse_production_requests?.job_order_number, Project: c.inhouse_production_requests?.projects?.project_code,
      Product: c.inhouse_production_requests?.product_item, Date: new Date(c.created_at).toLocaleString(),
      Result: c.result, Defect: c.defect_reason || "", ReworkRequired: c.rework_required ? "Yes" : "No",
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
          <h1>{t(titleKey, lang) || titleFallback}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Search job/product/project…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <select value={resultFilter} onChange={(e) => setResultFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">All results</option>
            <option value="pass">Pass</option><option value="conditional_pass">Conditional Pass</option><option value="fail">Fail</option>
          </select>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={handleExport}>Export</button>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "Record QC"}
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
            {[["dimensions", "Dimensions"], ["material", "Material"], ["finish", "Finish"], ["hardware", "Hardware"], ["drawing", "Drawing Match"], ["quantity", "Quantity"]].map(([k, label]) => (
              <label key={k} className="sub" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input type="checkbox" checked={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.checked }))} /> {label}
              </label>
            ))}
            <div className="field"><label>Result</label>
              <select value={form.result} onChange={(e) => setForm((f) => ({ ...f, result: e.target.value }))}>
                <option value="pass">Pass</option><option value="conditional_pass">Conditional Pass</option><option value="fail">Fail</option>
              </select>
            </div>
            <div className="field"><label>Photo{form.result === "fail" ? " (required on Fail)" : ""}</label>
              <input type="file" accept="image/*" onChange={(e) => setForm((f) => ({ ...f, photoFile: e.target.files?.[0] || null }))} />
            </div>
            <label className="sub" style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={form.reworkRequired} onChange={(e) => setForm((f) => ({ ...f, reworkRequired: e.target.checked }))} /> Rework Required
            </label>
            {form.reworkRequired && (
              <>
                <div className="field" style={{ gridColumn: "1 / -1" }}><label>Defect Reason (required)</label>
                  <input value={form.defectReason} onChange={(e) => setForm((f) => ({ ...f, defectReason: e.target.value }))} />
                </div>
                <div className="field"><label>Assign Rework To</label>
                  <select value={form.assignedReworkPerson} onChange={(e) => setForm((f) => ({ ...f, assignedReworkPerson: e.target.value }))}>
                    <option value="">—</option>
                    {factoryPeople.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              </>
            )}
            {msg && <div className="msg error" style={{ gridColumn: "1 / -1" }}>{msg}</div>}
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Record QC"}</button>
          </form>
        </div>
      )}

      <div className="card">
        {visible.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {visible.map((c) => {
          const job = c.inhouse_production_requests;
          return (
            <div key={c.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 6, borderBottom: "1px solid var(--border, #e5e7eb)" }}>
              <span style={{ fontWeight: 700 }}>{job?.job_order_number || "—"}</span>
              <span className="sub">{job?.projects?.project_code} — {job?.projects?.customer}</span>
              <span className="sub">{job?.product_item}</span>
              <span className="sub">{new Date(c.created_at).toLocaleString()}</span>
              <span className={`badge ${c.result === "pass" ? "VERIFIED" : c.result === "fail" ? "RETURNED" : "ASSIGNED"}`}>{c.result}</span>
              {c.defect_reason && <span className="sub">{c.defect_reason}</span>}
              {c.photos?.length > 0 && <span className="sub">📷 {c.photos.length}</span>}
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
