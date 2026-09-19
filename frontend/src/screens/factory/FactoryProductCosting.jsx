import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import { listAllInhouseProductionRequests, getFactoryProductCosting, factorySaveProductCosting } from "../../lib/interiorApi";

const COST_FIELDS = [
  ["materialCost", "Material Cost"], ["hardwareCost", "Hardware Cost"], ["labourCost", "Labour Cost"],
  ["machineCost", "Machine Cost"], ["outsourceCost", "Outsource/Job-work Cost"], ["packingCost", "Packing Cost"],
  ["transportCost", "Transport Cost"], ["otherCost", "Other Cost"],
];

// RLS on factory_product_costing (factory_is_costing_authorized()) means an
// unauthorized viewer's query simply returns zero rows -- there is no
// separate "hide this from employees" branch in this component because the
// database already never sends the data. The empty-state message below is
// what an unauthorized employee actually sees, not a fabricated one.
export default function FactoryProductCosting({ lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [jobId, setJobId] = useState("");
  const [costing, setCosting] = useState(null);
  const [form, setForm] = useState({ materialCost: 0, hardwareCost: 0, labourCost: 0, machineCost: 0, outsourceCost: 0, packingCost: 0, transportCost: 0, otherCost: 0, estimatedCost: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await listAllInhouseProductionRequests();
    if (err) { setError(true); setLoading(false); return; }
    setJobs(data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadCosting = useCallback(async (id) => {
    if (!id) { setCosting(null); return; }
    const { data } = await getFactoryProductCosting(id);
    setCosting(data || null);
    if (data) {
      setForm({
        materialCost: data.material_cost, hardwareCost: data.hardware_cost, labourCost: data.labour_cost, machineCost: data.machine_cost,
        outsourceCost: data.outsource_cost, packingCost: data.packing_cost, transportCost: data.transport_cost, otherCost: data.other_cost,
        estimatedCost: data.estimated_cost ?? "", notes: data.notes || "",
      });
    } else {
      setForm({ materialCost: 0, hardwareCost: 0, labourCost: 0, machineCost: 0, outsourceCost: 0, packingCost: 0, transportCost: 0, otherCost: 0, estimatedCost: "", notes: "" });
    }
  }, []);

  useEffect(() => { loadCosting(jobId); }, [jobId, loadCosting]);
  useEffect(() => subscribeTable("factory_product_costing_page", "factory_product_costing", jobId ? `job_id=eq.${jobId}` : null, () => loadCosting(jobId)), [jobId, loadCosting]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!jobId) { setMsg("Select a job first."); return; }
    setSaving(true);
    setMsg("");
    const { error: err } = await factorySaveProductCosting(jobId, { ...form, estimatedCost: form.estimatedCost || null });
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    loadCosting(jobId);
  }

  const total = COST_FIELDS.reduce((s, [k]) => s + Number(form[k] || 0), 0);
  const variance = total - Number(form.estimatedCost || 0);

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
          <h1>{t("factoryProductCostingTitle", lang) || "Mandatory Product Costing"}</h1>
          <div className="sub">Restricted to Super Admin, Management, Factory Department Head and authorized Accounts users — enforced by RLS, not just hidden in the UI.</div>
        </div>
      </div>

      <div className="card">
        <select value={jobId} onChange={(e) => setJobId(e.target.value)} style={{ width: "auto" }}>
          <option value="">Select a job…</option>
          {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_order_number} — {j.product_item}</option>)}
        </select>
      </div>

      {jobId && (
        <div className="card">
          {msg && <div className="msg error">{msg}</div>}
          <form onSubmit={handleSubmit} className="form-grid">
            {COST_FIELDS.map(([k, label]) => (
              <div className="field" key={k}><label>{label}</label>
                <input type="number" value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
              </div>
            ))}
            <div className="field"><label>Estimated Cost</label><input type="number" value={form.estimatedCost} onChange={(e) => setForm((f) => ({ ...f, estimatedCost: e.target.value }))} /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Notes</label><input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></div>
            <div className="sub" style={{ gridColumn: "1 / -1" }}>Total Actual Cost: <strong>{total.toFixed(2)}</strong> · Variance vs Estimated: <strong style={{ color: variance > 0 ? "#b91c1c" : "#15803d" }}>{variance.toFixed(2)}</strong></div>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save Costing"}</button>
          </form>
          {costing && (
            <div className="sub" style={{ marginTop: 8 }}>Last saved total: {costing.total_actual_cost} · Status: {costing.approval_status}</div>
          )}
        </div>
      )}

      {!jobId && <div className="msg info">Select a job to view or enter its product costing. If nothing loads after selecting a job, either it has no costing recorded yet, or your role is not authorized to view Factory costing.</div>}
    </div>
  );
}
