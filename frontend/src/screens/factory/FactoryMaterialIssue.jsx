import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import {
  listFactoryMaterials, listFactoryLocationsAll, listAllInhouseProductionRequests, listFactoryMaterialTransactions,
  factoryIssueMaterial, factoryReturnMaterial,
} from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";
import { useIncludeTestData } from "../../lib/testDataVisibility";
import IncludeTestDataToggle from "../../components/IncludeTestDataToggle";

const PAGE_SIZE = 20;

// Every issue/return here is a real, safety-checked inventory transaction
// (factory_issue_material / factory_return_material) -- over-issue and
// negative stock are rejected server-side, not just discouraged in the UI.
export default function FactoryMaterialIssue({ lang, profile }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [transactions, setTransactions] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [locations, setLocations] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [mode, setMode] = useState(null);
  const [form, setForm] = useState({ materialId: "", locationId: "", jobId: "", quantity: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const { includeTestData, canToggle, setIncludeTestData } = useIncludeTestData(profile);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [txRes, matRes, locRes, jobRes] = await Promise.all([
      listFactoryMaterialTransactions(null), listFactoryMaterials(includeTestData), listFactoryLocationsAll(), listAllInhouseProductionRequests(includeTestData),
    ]);
    if (txRes.error || matRes.error || locRes.error || jobRes.error) { setError(true); setLoading(false); return; }
    setTransactions((txRes.data || []).filter((tx) => tx.transaction_type === "issue" || tx.transaction_type === "return"));
    setMaterials(matRes.data || []);
    setLocations(locRes.data || []);
    setJobs(jobRes.data || []);
    setLoading(false);
  }, [includeTestData]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory_material_issue_board", "factory_material_transactions", null, load), [load]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [debouncedSearch, typeFilter]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return transactions.filter((tx) => {
      if (typeFilter && tx.transaction_type !== typeFilter) return false;
      if (!q) return true;
      const hay = [tx.factory_materials?.material_code, tx.factory_materials?.material_name, tx.inhouse_production_requests?.job_order_number, tx.factory_locations?.name].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [transactions, debouncedSearch, typeFilter]);

  const visible = filtered.slice(0, visibleCount);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.materialId || !form.locationId || !form.jobId) { setMsg("Material, location and job are all required."); return; }
    if (!form.quantity || Number(form.quantity) <= 0) { setMsg("A positive quantity is required."); return; }
    setSaving(true);
    setMsg("");
    const fn = mode === "issue" ? factoryIssueMaterial : factoryReturnMaterial;
    const { error: err } = await fn(form.materialId, form.locationId, form.jobId, Number(form.quantity), form.notes);
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    setForm({ materialId: "", locationId: "", jobId: "", quantity: "", notes: "" });
    setMode(null);
    load();
  }

  function handleExport() {
    exportRowsToExcel("Material-Issue-export.xlsx", "Material Issue", filtered.map((tx) => ({
      Type: tx.transaction_type, Material: tx.factory_materials?.material_code, Job: tx.inhouse_production_requests?.job_order_number,
      Location: tx.factory_locations?.name, Quantity: tx.quantity, BalanceAfter: tx.balance_after, Date: new Date(tx.performed_at).toLocaleString(),
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
          <h1>{t("factoryMaterialIssueTitle", lang) || "Material Issue"}</h1>
          <div className="sub">Over-issue and negative stock are blocked server-side, not just in this form.</div>
        </div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Search material/job/location…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">All</option><option value="issue">Issue</option><option value="return">Return</option>
          </select>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={handleExport}>Export</button>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setMode(mode === "return" ? null : "return")}>{mode === "return" ? "Cancel" : "Return Material"}</button>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => setMode(mode === "issue" ? null : "issue")}>{mode === "issue" ? "Cancel" : "Issue Material"}</button>
          <IncludeTestDataToggle canToggle={canToggle} includeTestData={includeTestData} onChange={setIncludeTestData} />
        </div>
        <div className="sub" style={{ marginTop: 6 }}>{filtered.length} transaction{filtered.length === 1 ? "" : "s"}</div>
      </div>

      {mode && (
        <div className="card">
          <form onSubmit={handleSubmit} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            <div className="field"><label>Material (required)</label>
              <select value={form.materialId} onChange={(e) => setForm((f) => ({ ...f, materialId: e.target.value }))} required>
                <option value="">—</option>
                {materials.map((m) => <option key={m.id} value={m.id}>{m.material_code} — {m.material_name}</option>)}
              </select>
            </div>
            <div className="field"><label>Location (required)</label>
              <select value={form.locationId} onChange={(e) => setForm((f) => ({ ...f, locationId: e.target.value }))} required>
                <option value="">—</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="field"><label>Job (required)</label>
              <select value={form.jobId} onChange={(e) => setForm((f) => ({ ...f, jobId: e.target.value }))} required>
                <option value="">—</option>
                {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_order_number} — {j.product_item}</option>)}
              </select>
            </div>
            <div className="field"><label>Quantity (required)</label><input type="number" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Notes</label><input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></div>
            {msg && <div className="msg error" style={{ gridColumn: "1 / -1" }}>{msg}</div>}
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : mode === "issue" ? "Issue Material" : "Return Material"}</button>
          </form>
        </div>
      )}

      <div className="card">
        {visible.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {visible.map((tx) => (
          <div key={tx.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 6, borderBottom: "1px solid var(--border, #e5e7eb)" }}>
            <span className={`badge ${tx.transaction_type === "issue" ? "ASSIGNED" : "VERIFIED"}`}>{tx.transaction_type}</span>
            <span style={{ fontWeight: 700 }}>{tx.factory_materials?.material_code}</span>
            <span className="sub">{tx.inhouse_production_requests?.job_order_number}</span>
            <span className="sub">{tx.factory_locations?.name}</span>
            <span className="sub">Qty {tx.quantity} (balance {tx.balance_after})</span>
            <span className="sub">{new Date(tx.performed_at).toLocaleString()}</span>
          </div>
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
