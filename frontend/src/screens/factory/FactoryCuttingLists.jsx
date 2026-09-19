import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import {
  listAllFactoryCuttingLists, listFactoryCuttingListItems, listAllInhouseProductionRequests,
  factorySaveCuttingList, factoryCopyCuttingListAsRevision,
} from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";
import { useIncludeTestData } from "../../lib/testDataVisibility";
import IncludeTestDataToggle from "../../components/IncludeTestDataToggle";

const PAGE_SIZE = 20;
const EMPTY_ROW = { part_name: "", material: "", length: "", width: "", thickness: "", quantity: "1", edge_band_sides: "", grain_direction: "", machine_process: "" };

export default function FactoryCuttingLists({ lang, profile }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lists, setLists] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [showForm, setShowForm] = useState(false);
  const [jobId, setJobId] = useState("");
  const [drawingReference, setDrawingReference] = useState("");
  const [rows, setRows] = useState([{ ...EMPTY_ROW }]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const debouncedSearch = useDebouncedValue(search, 250);
  const { includeTestData, canToggle, setIncludeTestData } = useIncludeTestData(profile);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [listRes, jobRes] = await Promise.all([listAllFactoryCuttingLists(includeTestData), listAllInhouseProductionRequests(includeTestData)]);
    if (listRes.error || jobRes.error) { setError(true); setLoading(false); return; }
    setLists(listRes.data || []);
    setJobs(jobRes.data || []);
    setLoading(false);
  }, [includeTestData]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory_cutting_lists_board", "factory_cutting_lists", null, load), [load]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [debouncedSearch]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return lists;
    return lists.filter((l) => {
      const job = l.inhouse_production_requests;
      const hay = [l.list_number, job?.job_order_number, job?.product_item, job?.projects?.project_code, job?.projects?.customer, l.drawing_reference].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [lists, debouncedSearch]);

  const visible = filtered.slice(0, visibleCount);

  function updateRow(i, key, value) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, [key]: value } : row)));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!jobId) { setMsg("Select a job first."); return; }
    const items = rows.filter((r) => r.part_name.trim());
    if (items.length === 0) { setMsg("At least one part row is required."); return; }
    setSaving(true);
    setMsg("");
    const { error: err } = await factorySaveCuttingList(jobId, drawingReference, items);
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    setRows([{ ...EMPTY_ROW }]);
    setJobId("");
    setDrawingReference("");
    setShowForm(false);
    load();
  }

  async function handleRevise(listId) {
    setMsg("");
    const { error: err } = await factoryCopyCuttingListAsRevision(listId);
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
          <h1>{t("factoryCuttingListsTitle", lang) || "Cutting Lists"}</h1>
          <div className="sub">Excel import (template upload) is not available yet — add rows directly, export a list to Excel, or use "Revise" to copy an existing list forward as a new, separately-preserved revision.</div>
        </div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Search list/job/product…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => exportRowsToExcel("Cutting-Lists-export.xlsx", "Cutting Lists", filtered.map((l) => ({
            ListNumber: l.list_number, Job: l.inhouse_production_requests?.job_order_number,
            Project: l.inhouse_production_requests?.projects?.project_code, Revision: l.revision_number,
            DrawingReference: l.drawing_reference || "", Status: l.status,
          })))}>Export</button>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "New Cutting List"}
          </button>
          <IncludeTestDataToggle canToggle={canToggle} includeTestData={includeTestData} onChange={setIncludeTestData} />
        </div>
        <div className="sub" style={{ marginTop: 6 }}>{filtered.length} list{filtered.length === 1 ? "" : "s"}</div>
      </div>

      {msg && <div className="msg error">{msg}</div>}

      {showForm && (
        <div className="card">
          <form onSubmit={handleSubmit}>
            <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
              <div className="field"><label>Job (required)</label>
                <select value={jobId} onChange={(e) => setJobId(e.target.value)} required>
                  <option value="">—</option>
                  {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_order_number} — {j.product_item}</option>)}
                </select>
              </div>
              <div className="field"><label>Drawing Reference</label><input value={drawingReference} onChange={(e) => setDrawingReference(e.target.value)} /></div>
            </div>
            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>{["Part", "Material", "L", "W", "T", "Qty", "Edge Band", "Grain", "Process", ""].map((h) => <th key={h} style={{ textAlign: "left", fontSize: 12, padding: 4 }}>{h}</th>)}</tr></thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i}>
                      <td><input value={row.part_name} onChange={(e) => updateRow(i, "part_name", e.target.value)} style={{ width: 100 }} /></td>
                      <td><input value={row.material} onChange={(e) => updateRow(i, "material", e.target.value)} style={{ width: 90 }} /></td>
                      <td><input type="number" value={row.length} onChange={(e) => updateRow(i, "length", e.target.value)} style={{ width: 60 }} /></td>
                      <td><input type="number" value={row.width} onChange={(e) => updateRow(i, "width", e.target.value)} style={{ width: 60 }} /></td>
                      <td><input type="number" value={row.thickness} onChange={(e) => updateRow(i, "thickness", e.target.value)} style={{ width: 60 }} /></td>
                      <td><input type="number" value={row.quantity} onChange={(e) => updateRow(i, "quantity", e.target.value)} style={{ width: 60 }} /></td>
                      <td><input value={row.edge_band_sides} onChange={(e) => updateRow(i, "edge_band_sides", e.target.value)} style={{ width: 70 }} /></td>
                      <td><input value={row.grain_direction} onChange={(e) => updateRow(i, "grain_direction", e.target.value)} style={{ width: 70 }} /></td>
                      <td><input value={row.machine_process} onChange={(e) => updateRow(i, "machine_process", e.target.value)} style={{ width: 90 }} /></td>
                      <td><button type="button" className="btn btn-outline" onClick={() => setRows((r) => r.filter((_, idx) => idx !== i))}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" className="btn btn-outline" style={{ marginTop: 6, width: "auto" }} onClick={() => setRows((r) => [...r, { ...EMPTY_ROW }])}>+ Add Row</button>
            <div style={{ marginTop: 10 }}><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save Cutting List"}</button></div>
          </form>
        </div>
      )}

      <div className="card">
        {visible.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {visible.map((l) => (
          <CuttingListRow key={l.id} list={l} expanded={expandedId === l.id} onToggle={() => setExpandedId(expandedId === l.id ? null : l.id)} onRevise={() => handleRevise(l.id)} />
        ))}
        {visibleCount < filtered.length && (
          <button type="button" className="btn btn-outline" style={{ marginTop: 8 }} onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}>
            Load More ({filtered.length - visibleCount} more)
          </button>
        )}
      </div>
    </div>
  );
}

function CuttingListRow({ list, expanded, onToggle, onRevise }) {
  const [items, setItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const job = list.inhouse_production_requests;

  useEffect(() => {
    if (!expanded) return;
    setLoadingItems(true);
    listFactoryCuttingListItems(list.id).then(({ data }) => { setItems(data || []); setLoadingItems(false); });
  }, [expanded, list.id]);

  return (
    <div style={{ borderBottom: "1px solid var(--border, #e5e7eb)", padding: "8px 0" }}>
      <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 6, cursor: "pointer" }} onClick={onToggle}>
        <span style={{ fontWeight: 700 }}>{list.list_number}</span>
        <span className="sub">{job?.job_order_number} — {job?.projects?.project_code} — {job?.product_item}</span>
        <span className="sub">Rev {list.revision_number}</span>
        <span className={`badge ${list.status === "Approved" ? "VERIFIED" : "ASSIGNED"}`}>{list.status}</span>
        <button type="button" className="btn btn-outline" onClick={(e) => { e.stopPropagation(); onRevise(); }}>Copy as New Revision</button>
      </div>
      {expanded && (
        <div style={{ overflowX: "auto", marginTop: 6 }}>
          {loadingItems ? <div className="skeleton-block" style={{ height: 60 }} /> : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["Part", "Material", "L×W×T", "Qty", "Process"].map((h) => <th key={h} style={{ textAlign: "left", fontSize: 12, padding: 4 }}>{h}</th>)}</tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.part_name}</td><td>{i.material}</td>
                    <td>{i.length ?? "—"}×{i.width ?? "—"}×{i.thickness ?? "—"}</td>
                    <td>{i.quantity}</td><td>{i.machine_process ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={3} /><td style={{ fontWeight: 700 }}>{items.reduce((s, i) => s + Number(i.quantity || 0), 0)} pcs total</td><td /></tr></tfoot>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
