import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { factoryProductTimeTracking, listAllInhouseProductionRequests } from "../../lib/interiorApi";

// Read-only, derived directly from production_stage_updates.planned_start/
// planned_end/actual_start/actual_end for each stage. NOTE (disclosed, not
// hidden): production_stage_updates stores ONE current-state row per
// (job, stage) rather than an append-only event log, so this shows the
// current planned-vs-actual duration per stage -- it cannot reconstruct
// multiple hold/resume cycles on the same stage. That finer-grained
// history lives in the audit log, not surfaced in this report.
export default function FactoryProductTimeTracking({ lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [jobFilter, setJobFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [rowsRes, jobRes] = await Promise.all([factoryProductTimeTracking(jobFilter || null), listAllInhouseProductionRequests()]);
    if (rowsRes.error || jobRes.error) { setError(true); setLoading(false); return; }
    setRows(rowsRes.data || []);
    setJobs(jobRes.data || []);
    setLoading(false);
  }, [jobFilter]);

  useEffect(() => { load(); }, [load]);

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
          <h1>{t("factoryProductTimeTrackingTitle", lang) || "Product Time Tracking"}</h1>
          <div className="sub">Planned vs. actual duration per stage, derived from real stage-update timestamps.</div>
        </div>
      </div>

      <div className="card">
        <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)} style={{ width: "auto" }}>
          <option value="">All jobs</option>
          {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_order_number} — {j.product_item}</option>)}
        </select>
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>{["Job", "Stage", "Planned (min)", "Actual (min)", "Delay (min)", "Started By", "Completed By"].map((h) => <th key={h} style={{ textAlign: "left", fontSize: 12, padding: 6 }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--border, #e5e7eb)" }}>
                    <td style={{ padding: 6, fontWeight: 600 }}>{r.job_order_number}</td>
                    <td style={{ padding: 6 }}>{r.stage}</td>
                    <td style={{ padding: 6 }}>{r.planned_minutes != null ? Math.round(r.planned_minutes) : "—"}</td>
                    <td style={{ padding: 6 }}>{r.actual_minutes != null ? Math.round(r.actual_minutes) : "—"}</td>
                    <td style={{ padding: 6, color: r.delay_minutes > 0 ? "#b91c1c" : undefined }}>{Math.round(r.delay_minutes || 0)}</td>
                    <td style={{ padding: 6 }}>{r.started_by_name || "—"}</td>
                    <td style={{ padding: 6 }}>{r.completed_by_name || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
