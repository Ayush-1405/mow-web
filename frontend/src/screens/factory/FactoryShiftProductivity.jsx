import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { factoryShiftProductivity } from "../../lib/interiorApi";
import { useIncludeTestData } from "../../lib/testDataVisibility";
import IncludeTestDataToggle from "../../components/IncludeTestDataToggle";

// Read-only computed report grouped by (date, shift) -- shift is an
// optional tag captured when a stage is updated (Job Orders' Job Card, or
// the WIP Stages board). There is no separate "shift master" in this app
// yet, so this groups by whatever shift value was recorded, defaulting to
// "General" when none was set.
export default function FactoryShiftProductivity({ lang, profile }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { includeTestData, canToggle, setIncludeTestData } = useIncludeTestData(profile);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await factoryShiftProductivity(from || null, to || null, includeTestData);
    if (err) { setError(true); setLoading(false); return; }
    setRows(data || []);
    setLoading(false);
  }, [from, to, includeTestData]);

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
          <h1>{t("factoryShiftProductivityTitle", lang) || "Shift Productivity"}</h1>
          <div className="sub">Computed automatically from real production entries, grouped by date and shift.</div>
        </div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <div className="field" style={{ width: "auto" }}><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field" style={{ width: "auto" }}><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <button type="button" className="btn btn-outline" style={{ width: "auto", alignSelf: "flex-end" }} onClick={() => { setFrom(""); setTo(""); }}>Clear Filters</button>
          <IncludeTestDataToggle canToggle={canToggle} includeTestData={includeTestData} onChange={setIncludeTestData} />
        </div>
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>{["Date", "Shift", "Jobs Touched", "Stages Completed", "QC Pass", "QC Fail", "Rework", "Rejection"].map((h) => <th key={h} style={{ textAlign: "left", fontSize: 12, padding: 6 }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--border, #e5e7eb)" }}>
                    <td style={{ padding: 6, fontWeight: 600 }}>{r.shift_date}</td>
                    <td style={{ padding: 6 }}>{r.shift}</td>
                    <td style={{ padding: 6 }}>{r.jobs_touched}</td>
                    <td style={{ padding: 6 }}>{r.stages_completed}</td>
                    <td style={{ padding: 6, color: "#15803d" }}>{r.qc_pass}</td>
                    <td style={{ padding: 6, color: r.qc_fail > 0 ? "#b91c1c" : undefined }}>{r.qc_fail}</td>
                    <td style={{ padding: 6 }}>{r.rework_count}</td>
                    <td style={{ padding: 6 }}>{r.rejection_count}</td>
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
