import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { listAllFactoryReworkRecords, factoryCloseRework, uploadFactoryAttachment } from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";

const PAGE_SIZE = 20;

// The "Rework" card -- a cross-job board over factory_rework_records
// (created automatically whenever a QC check on any job is recorded with
// rework_required = true). Closing here uses the exact same
// factory_close_rework RPC as the Job Card drill-down -- an after-rework
// photo is mandatory to close (enforced server-side, not just here).
export default function FactoryRework({ lang, profile }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [records, setRecords] = useState([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("open");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [msg, setMsg] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await listAllFactoryReworkRecords();
    if (err) { setError(true); setLoading(false); return; }
    setRecords(data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory_rework_board", "factory_rework_records", null, load), [load]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [debouncedSearch, statusFilter]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return records.filter((r) => {
      if (statusFilter === "open" && r.is_closed) return false;
      if (statusFilter === "closed" && !r.is_closed) return false;
      if (!q) return true;
      const job = r.inhouse_production_requests;
      const hay = [r.rework_number, job?.job_order_number, job?.product_item, job?.projects?.project_code, job?.projects?.customer, r.defect_details].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [records, debouncedSearch, statusFilter]);

  const visible = filtered.slice(0, visibleCount);

  async function handleClose(rw, recheckResult, correctiveAction, afterPhotoFile) {
    if (!recheckResult.trim()) { setMsg("A recheck result is required to close a rework."); return; }
    if (!afterPhotoFile) { setMsg("An after-rework photo is required to close a rework."); return; }
    setMsg("");
    const job = rw.inhouse_production_requests;
    const { path, error: uploadErr } = await uploadFactoryAttachment({
      projectId: job?.project_id, module: "factory_rework_after", relatedRecordId: rw.id,
      file: afterPhotoFile, fileCategory: "Rework After Photo", uploadedBy: profile?.id,
    });
    if (uploadErr) { setMsg(uploadErr.message); return; }
    const { error: err } = await factoryCloseRework(rw.id, recheckResult, correctiveAction, [path]);
    if (err) { setMsg(err.message); return; }
    load();
  }

  function handleExport() {
    exportRowsToExcel("Rework-export.xlsx", "Rework", filtered.map((r) => ({
      ReworkNumber: r.rework_number, Job: r.inhouse_production_requests?.job_order_number,
      Project: r.inhouse_production_requests?.projects?.project_code, Defect: r.defect_details,
      Status: r.is_closed ? "Closed" : "Open", RecheckResult: r.recheck_result || "", ClosedAt: r.closed_at || "",
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
          <h1>{t("factoryReworkTitle", lang) || "Rework"}</h1>
          <div className="sub">Rework records are created automatically from a failed/conditional QC check — recorded from In-process QC, Final QC, or a Job Order's Job Card.</div>
        </div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Search job/rework number/product…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="open">Open only</option>
            <option value="closed">Closed only</option>
            <option value="">All</option>
          </select>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={handleExport}>Export</button>
        </div>
        <div className="sub" style={{ marginTop: 6 }}>{filtered.length} record{filtered.length === 1 ? "" : "s"}</div>
      </div>

      {msg && <div className="msg error">{msg}</div>}

      <div className="card">
        {visible.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {visible.map((rw) => <ReworkBoardRow key={rw.id} rw={rw} onClose={handleClose} />)}
        {visibleCount < filtered.length && (
          <button type="button" className="btn btn-outline" style={{ marginTop: 8 }} onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}>
            Load More ({filtered.length - visibleCount} more)
          </button>
        )}
      </div>
    </div>
  );
}

function ReworkBoardRow({ rw, onClose }) {
  const [recheckResult, setRecheckResult] = useState(rw.recheck_result || "");
  const [correctiveAction, setCorrectiveAction] = useState(rw.corrective_action || "");
  const [afterPhotoFile, setAfterPhotoFile] = useState(null);
  const job = rw.inhouse_production_requests;
  return (
    <div className="card" style={{ marginBottom: 6 }}>
      <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700 }}>{rw.rework_number}</span>
        <span className="sub">{job?.job_order_number} — {job?.projects?.project_code} — {job?.product_item}</span>
        <span className={`badge ${rw.is_closed ? "VERIFIED" : "RETURNED"}`}>{rw.is_closed ? "Closed" : "Open"}</span>
        {rw.before_photos?.length > 0 && <span className="sub">📷 before: {rw.before_photos.length}</span>}
        {rw.after_photos?.length > 0 && <span className="sub">📷 after: {rw.after_photos.length}</span>}
      </div>
      <div className="sub">{rw.defect_details}</div>
      {rw.is_closed ? (
        <div className="sub">Recheck: {rw.recheck_result}{rw.corrective_action ? ` — ${rw.corrective_action}` : ""}</div>
      ) : (
        <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", marginTop: 6 }}>
          <div className="field"><label>Recheck Result</label><input value={recheckResult} onChange={(e) => setRecheckResult(e.target.value)} /></div>
          <div className="field"><label>Corrective Action</label><input value={correctiveAction} onChange={(e) => setCorrectiveAction(e.target.value)} /></div>
          <div className="field"><label>After Photo (required)</label><input type="file" accept="image/*" onChange={(e) => setAfterPhotoFile(e.target.files?.[0] || null)} /></div>
          <button type="button" className="btn btn-primary" onClick={() => onClose(rw, recheckResult, correctiveAction, afterPhotoFile)}>Close Rework</button>
        </div>
      )}
    </div>
  );
}
