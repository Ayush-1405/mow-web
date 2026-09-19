import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import {
  listAllFactoryBoms, listFactoryBomItems, listAllInhouseProductionRequests,
  factorySaveBom, factorySubmitBom, factoryDecideBom,
} from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";
import { useIncludeTestData } from "../../lib/testDataVisibility";
import IncludeTestDataToggle from "../../components/IncludeTestDataToggle";

const PAGE_SIZE = 20;
const STATUS_BADGE = { Draft: "CLOSED", Submitted: "ASSIGNED", Approved: "VERIFIED", Rejected: "RETURNED", Revised: "ASSIGNED" };
const EMPTY_ROW = { material_name: "", material_code: "", category: "", specification: "", unit: "", required_quantity: "", available_quantity: "", reserved_quantity: "", wastage_allowance: "", approved_substitute: "", supplier_source: "", rate: "", notes: "" };

export default function FactoryBom({ lang, profile }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [boms, setBoms] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [showForm, setShowForm] = useState(false);
  const [jobId, setJobId] = useState("");
  const [rows, setRows] = useState([{ ...EMPTY_ROW }]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const debouncedSearch = useDebouncedValue(search, 250);
  const { includeTestData, canToggle, setIncludeTestData } = useIncludeTestData(profile);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [bomRes, jobRes] = await Promise.all([listAllFactoryBoms(includeTestData), listAllInhouseProductionRequests(includeTestData)]);
    if (bomRes.error || jobRes.error) { setError(true); setLoading(false); return; }
    setBoms(bomRes.data || []);
    setJobs(jobRes.data || []);
    setLoading(false);
  }, [includeTestData]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory_bom_board", "factory_boms", null, load), [load]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [debouncedSearch, statusFilter]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return boms.filter((b) => {
      if (statusFilter && b.status !== statusFilter) return false;
      if (!q) return true;
      const job = b.inhouse_production_requests;
      const hay = [b.bom_number, job?.job_order_number, job?.product_item, job?.projects?.project_code, job?.projects?.customer].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [boms, debouncedSearch, statusFilter]);

  const visible = filtered.slice(0, visibleCount);

  function updateRow(i, key, value) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, [key]: value } : row)));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!jobId) { setMsg("Select a job first."); return; }
    const items = rows.filter((r) => r.material_name.trim());
    if (items.length === 0) { setMsg("At least one BOM item is required."); return; }
    setSaving(true);
    setMsg("");
    const { error: err } = await factorySaveBom(jobId, null, items);
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    setRows([{ ...EMPTY_ROW }]);
    setJobId("");
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
          <h1>{t("factoryBomTitle", lang) || "BOM"}</h1>
          <div className="sub">Rate/amount are visible only to authorized roles (Management, Super Admin, Factory Head, Accounts) — enforced server-side.</div>
        </div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Search BOM/job/product…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">All statuses</option>
            {Object.keys(STATUS_BADGE).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => exportRowsToExcel("BOM-export.xlsx", "BOM", filtered.map((b) => ({
            BOMNumber: b.bom_number, Job: b.inhouse_production_requests?.job_order_number,
            Project: b.inhouse_production_requests?.projects?.project_code, Product: b.inhouse_production_requests?.product_item,
            Status: b.status, CreatedAt: new Date(b.created_at).toLocaleDateString(),
          })))}>Export</button>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "New BOM"}
          </button>
          <IncludeTestDataToggle canToggle={canToggle} includeTestData={includeTestData} onChange={setIncludeTestData} />
        </div>
        <div className="sub" style={{ marginTop: 6 }}>{filtered.length} BOM{filtered.length === 1 ? "" : "s"}</div>
      </div>

      {msg && <div className="msg error">{msg}</div>}

      {showForm && (
        <div className="card">
          <form onSubmit={handleSubmit}>
            <div className="field"><label>Job (required)</label>
              <select value={jobId} onChange={(e) => setJobId(e.target.value)} required>
                <option value="">—</option>
                {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_order_number} — {j.product_item}</option>)}
              </select>
            </div>
            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>{["Material", "Code", "Category", "Unit", "Required", "Available", "Reserved", "Rate", ""].map((h) => <th key={h} style={{ textAlign: "left", fontSize: 12, padding: 4 }}>{h}</th>)}</tr></thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i}>
                      <td><input value={row.material_name} onChange={(e) => updateRow(i, "material_name", e.target.value)} style={{ width: 120 }} /></td>
                      <td><input value={row.material_code} onChange={(e) => updateRow(i, "material_code", e.target.value)} style={{ width: 80 }} /></td>
                      <td><input value={row.category} onChange={(e) => updateRow(i, "category", e.target.value)} style={{ width: 80 }} /></td>
                      <td><input value={row.unit} onChange={(e) => updateRow(i, "unit", e.target.value)} style={{ width: 60 }} /></td>
                      <td><input type="number" value={row.required_quantity} onChange={(e) => updateRow(i, "required_quantity", e.target.value)} style={{ width: 80 }} /></td>
                      <td><input type="number" value={row.available_quantity} onChange={(e) => updateRow(i, "available_quantity", e.target.value)} style={{ width: 80 }} /></td>
                      <td><input type="number" value={row.reserved_quantity} onChange={(e) => updateRow(i, "reserved_quantity", e.target.value)} style={{ width: 80 }} /></td>
                      <td><input type="number" value={row.rate} onChange={(e) => updateRow(i, "rate", e.target.value)} style={{ width: 80 }} /></td>
                      <td><button type="button" className="btn btn-outline" onClick={() => setRows((r) => r.filter((_, idx) => idx !== i))}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" className="btn btn-outline" style={{ marginTop: 6, width: "auto" }} onClick={() => setRows((r) => [...r, { ...EMPTY_ROW }])}>+ Add Row</button>
            <div style={{ marginTop: 10 }}><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save BOM"}</button></div>
          </form>
        </div>
      )}

      <div className="card">
        {visible.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {visible.map((b) => (
          <BomRow key={b.id} bom={b} expanded={expandedId === b.id} onToggle={() => setExpandedId(expandedId === b.id ? null : b.id)} onChanged={load} />
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

function BomRow({ bom, expanded, onToggle, onChanged }) {
  const [items, setItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [msg, setMsg] = useState("");
  const job = bom.inhouse_production_requests;

  useEffect(() => {
    if (!expanded) return;
    setLoadingItems(true);
    listFactoryBomItems(bom.id).then(({ data }) => { setItems(data || []); setLoadingItems(false); });
  }, [expanded, bom.id]);

  async function handleSubmit() {
    setMsg("");
    const { error } = await factorySubmitBom(bom.id);
    if (error) { setMsg(error.message); return; }
    onChanged();
  }
  async function handleDecide(decision) {
    let reason = null;
    if (decision === "Rejected") {
      reason = window.prompt("Rejection reason (required):");
      if (!reason || !reason.trim()) return;
    }
    setMsg("");
    const { error } = await factoryDecideBom(bom.id, decision, reason);
    if (error) { setMsg(error.message); return; }
    onChanged();
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border, #e5e7eb)", padding: "8px 0" }}>
      <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 6, cursor: "pointer" }} onClick={onToggle}>
        <span style={{ fontWeight: 700 }}>{bom.bom_number}</span>
        <span className="sub">{job?.job_order_number} — {job?.projects?.project_code} — {job?.product_item}</span>
        <span className={`badge ${STATUS_BADGE[bom.status] || "CLOSED"}`}>{bom.status}</span>
        {bom.status === "Draft" && <button type="button" className="btn btn-outline" onClick={(e) => { e.stopPropagation(); handleSubmit(); }}>Submit</button>}
        {bom.status === "Submitted" && (
          <>
            <button type="button" className="btn btn-primary" onClick={(e) => { e.stopPropagation(); handleDecide("Approved"); }}>Approve</button>
            <button type="button" className="btn btn-outline" onClick={(e) => { e.stopPropagation(); handleDecide("Rejected"); }}>Reject</button>
          </>
        )}
      </div>
      {msg && <div className="msg error">{msg}</div>}
      {expanded && (
        <div style={{ overflowX: "auto", marginTop: 6 }}>
          {loadingItems ? <div className="skeleton-block" style={{ height: 60 }} /> : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["Material", "Unit", "Required", "Available", "Reserved", "Shortage", "Rate", "Amount"].map((h) => <th key={h} style={{ textAlign: "left", fontSize: 12, padding: 4 }}>{h}</th>)}</tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.material_name}</td><td>{i.unit}</td><td>{i.required_quantity}</td><td>{i.available_quantity}</td>
                    <td>{i.reserved_quantity}</td><td style={{ color: i.shortage_quantity > 0 ? "#b91c1c" : undefined, fontWeight: i.shortage_quantity > 0 ? 700 : 400 }}>{i.shortage_quantity}</td>
                    <td>{i.rate ?? "—"}</td><td>{i.amount ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
