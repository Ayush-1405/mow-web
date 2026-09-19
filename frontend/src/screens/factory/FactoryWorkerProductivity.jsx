import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { factoryWorkerProductivity } from "../../lib/interiorApi";

// Read-only computed report -- entirely derived from production_stage_updates
// / factory_quality_checks / factory_rework_records via the
// factory_worker_productivity() SQL function. There is no write path here:
// a productivity percentage can never be typed in by hand, only computed.
export default function FactoryWorkerProductivity({ lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await factoryWorkerProductivity(from || null, to || null);
    if (err) { setError(true); setLoading(false); return; }
    setRows(data || []);
    setLoading(false);
  }, [from, to]);

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
          <h1>{t("factoryWorkerProductivityTitle", lang) || "Worker Productivity"}</h1>
          <div className="sub">Computed automatically from real stage/QC/rework records — figures cannot be edited.</div>
        </div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <div className="field" style={{ width: "auto" }}><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field" style={{ width: "auto" }}><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <button type="button" className="btn btn-outline" style={{ width: "auto", alignSelf: "flex-end" }} onClick={() => { setFrom(""); setTo(""); }}>Clear Filters</button>
        </div>
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>{["Employee", "Assigned Jobs", "Completed Stages", "Planned (min)", "Actual (min)", "QC Accepted", "QC Rejected", "Rework"].map((h) => <th key={h} style={{ textAlign: "left", fontSize: 12, padding: 6 }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.employee_id} style={{ borderTop: "1px solid var(--border, #e5e7eb)" }}>
                    <td style={{ padding: 6, fontWeight: 600 }}>{r.employee_name}</td>
                    <td style={{ padding: 6 }}>{r.assigned_jobs}</td>
                    <td style={{ padding: 6 }}>{r.completed_stages}</td>
                    <td style={{ padding: 6 }}>{Math.round(r.planned_minutes)}</td>
                    <td style={{ padding: 6 }}>{Math.round(r.actual_minutes)}</td>
                    <td style={{ padding: 6, color: "#15803d" }}>{r.qc_accepted}</td>
                    <td style={{ padding: 6, color: r.qc_rejected > 0 ? "#b91c1c" : undefined }}>{r.qc_rejected}</td>
                    <td style={{ padding: 6 }}>{r.rework_count}</td>
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
