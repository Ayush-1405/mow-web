import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { subscribeTable } from "../../lib/realtime";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { listAllFactoryProductionPlans, listAllInhouseProductionRequests, listInteriorPeople, factorySaveProductionPlan, factoryUpdateProductionPlanStatus } from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";
import { useIncludeTestData } from "../../lib/testDataVisibility";
import IncludeTestDataToggle from "../../components/IncludeTestDataToggle";

const PAGE_SIZE = 20;
const STATUSES = ["Draft", "Planned", "Released", "In Production", "On Hold", "Completed", "Cancelled"];
const STATUS_BADGE = { Draft: "CLOSED", Planned: "ASSIGNED", Released: "ASSIGNED", "In Production": "IN_PROGRESS", "On Hold": "REVISION", Completed: "VERIFIED", Cancelled: "CLOSED" };

export default function FactoryProductionPlanning({ lang, profile }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [plans, setPlans] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [people, setPeople] = useState([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    jobId: "", projectId: "", client: "", productItem: "", quantity: "", priority: "NORMAL",
    plannedStartDate: "", plannedCompletionDate: "", productionSequence: "", assignedTeam: "", shift: "",
    machineRequirement: "", drawingStatus: "Pending", materialAvailabilityStatus: "Pending", notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const { includeTestData, canToggle, setIncludeTestData } = useIncludeTestData(profile);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [planRes, jobRes, peopleRes] = await Promise.all([listAllFactoryProductionPlans(includeTestData), listAllInhouseProductionRequests(includeTestData), listInteriorPeople()]);
    if (planRes.error || jobRes.error) { setError(true); setLoading(false); return; }
    setPlans(planRes.data || []);
    setJobs(jobRes.data || []);
    setPeople((peopleRes.data || []).filter((p) => p.department_name === "Factory/Manufacturing"));
    setLoading(false);
  }, [includeTestData]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory_production_plans_board", "factory_production_plans", null, load), [load]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [debouncedSearch, statusFilter]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return plans.filter((p) => {
      if (statusFilter && p.status !== statusFilter) return false;
      if (!q) return true;
      const hay = [p.plan_number, p.product_item, p.client, p.projects?.project_code, p.projects?.customer, p.inhouse_production_requests?.job_order_number].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [plans, debouncedSearch, statusFilter]);

  const visible = filtered.slice(0, visibleCount);
  const summary = useMemo(() => ({
    total: plans.length,
    pending: plans.filter((p) => ["Draft", "Planned"].includes(p.status)).length,
    inProgress: plans.filter((p) => ["Released", "In Production"].includes(p.status)).length,
    completed: plans.filter((p) => p.status === "Completed").length,
  }), [plans]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.productItem.trim()) { setMsg("Product/item is required."); return; }
    setSaving(true);
    setMsg("");
    const { error: err } = await factorySaveProductionPlan(null, form);
    setSaving(false);
    if (err) { setMsg(err.message); return; }
    setForm({ jobId: "", projectId: "", client: "", productItem: "", quantity: "", priority: "NORMAL", plannedStartDate: "", plannedCompletionDate: "", productionSequence: "", assignedTeam: "", shift: "", machineRequirement: "", drawingStatus: "Pending", materialAvailabilityStatus: "Pending", notes: "" });
    setShowForm(false);
    load();
  }

  async function handleStatus(plan, status) {
    let reason = null;
    if (["On Hold", "Cancelled"].includes(status)) {
      reason = window.prompt(`Reason to mark this plan "${status}" (required):`);
      if (!reason || !reason.trim()) return;
    }
    setMsg("");
    const { error: err } = await factoryUpdateProductionPlanStatus(plan.id, status, reason);
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
          <h1>{t("factoryProductionPlanningTitle", lang) || "Production Planning"}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="dept-meta-grid">
        <div className="card dept-meta-tile"><div className="label">Total Plans</div><div className="value">{summary.total}</div></div>
        <div className="card dept-meta-tile"><div className="label">Pending</div><div className="value">{summary.pending}</div></div>
        <div className="card dept-meta-tile"><div className="label">In Progress</div><div className="value">{summary.inProgress}</div></div>
        <div className="card dept-meta-tile"><div className="label">Completed</div><div className="value">{summary.completed}</div></div>
      </div>

      <div className="card">
        <div className="task-meta" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Search plan/product/project…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => exportRowsToExcel("Production-Plans-export.xlsx", "Production Plans", filtered.map((p) => ({
            PlanNumber: p.plan_number, Project: p.projects?.project_code, Client: p.client, Product: p.product_item,
            Quantity: p.quantity ?? "", Status: p.status, PlannedStart: p.planned_start_date || "", PlannedCompletion: p.planned_completion_date || "",
            DrawingStatus: p.drawing_status, MaterialStatus: p.material_availability_status,
          })))}>Export</button>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "New Plan"}
          </button>
          <IncludeTestDataToggle canToggle={canToggle} includeTestData={includeTestData} onChange={setIncludeTestData} />
        </div>
        <div className="sub" style={{ marginTop: 6 }}>{filtered.length} plan{filtered.length === 1 ? "" : "s"}</div>
      </div>

      {msg && <div className="msg error">{msg}</div>}

      {showForm && (
        <div className="card">
          <form onSubmit={handleSubmit} className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            <div className="field"><label>Link to Existing Job (optional)</label>
              <select value={form.jobId} onChange={(e) => {
                const job = jobs.find((j) => j.id === e.target.value);
                setForm((f) => ({ ...f, jobId: e.target.value, projectId: job?.project_id || f.projectId, productItem: job?.product_item || f.productItem, client: job?.purchase_requests?.projects?.customer || f.client }));
              }}>
                <option value="">—</option>
                {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_order_number} — {j.product_item}</option>)}
              </select>
            </div>
            <div className="field"><label>Client</label><input value={form.client} onChange={(e) => setForm((f) => ({ ...f, client: e.target.value }))} /></div>
            <div className="field"><label>Product/Item (required)</label><input value={form.productItem} onChange={(e) => setForm((f) => ({ ...f, productItem: e.target.value }))} required /></div>
            <div className="field"><label>Quantity</label><input type="number" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} /></div>
            <div className="field"><label>Priority</label>
              <select value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}>
                <option value="LOW">Low</option><option value="NORMAL">Normal</option><option value="HIGH">High</option><option value="URGENT">Urgent</option>
              </select>
            </div>
            <div className="field"><label>Planned Start</label><input type="date" value={form.plannedStartDate} onChange={(e) => setForm((f) => ({ ...f, plannedStartDate: e.target.value }))} /></div>
            <div className="field"><label>Planned Completion</label><input type="date" value={form.plannedCompletionDate} onChange={(e) => setForm((f) => ({ ...f, plannedCompletionDate: e.target.value }))} /></div>
            <div className="field"><label>Production Sequence</label><input type="number" value={form.productionSequence} onChange={(e) => setForm((f) => ({ ...f, productionSequence: e.target.value }))} /></div>
            <div className="field"><label>Assigned Team</label>
              <select value={form.assignedTeam} onChange={(e) => setForm((f) => ({ ...f, assignedTeam: e.target.value }))}>
                <option value="">—</option>
                {people.map((p) => <option key={p.auth_id} value={p.auth_id}>{p.name}</option>)}
              </select>
            </div>
            <div className="field"><label>Shift</label>
              <select value={form.shift} onChange={(e) => setForm((f) => ({ ...f, shift: e.target.value }))}>
                <option value="">—</option><option value="Day">Day</option><option value="Night">Night</option><option value="General">General</option>
              </select>
            </div>
            <div className="field"><label>Machine Requirement</label><input value={form.machineRequirement} onChange={(e) => setForm((f) => ({ ...f, machineRequirement: e.target.value }))} /></div>
            <div className="field"><label>Drawing Status</label>
              <select value={form.drawingStatus} onChange={(e) => setForm((f) => ({ ...f, drawingStatus: e.target.value }))}>
                <option value="Pending">Pending</option><option value="Approved">Approved</option>
              </select>
            </div>
            <div className="field"><label>Material Availability</label>
              <select value={form.materialAvailabilityStatus} onChange={(e) => setForm((f) => ({ ...f, materialAvailabilityStatus: e.target.value }))}>
                <option value="Pending">Pending</option><option value="Available">Available</option><option value="Shortage">Shortage</option>
              </select>
            </div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Notes</label><input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></div>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save Plan"}</button>
          </form>
        </div>
      )}

      <div className="card">
        {visible.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {visible.map((p) => (
          <div key={p.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 6, borderBottom: "1px solid var(--border, #e5e7eb)" }}>
            <span style={{ fontWeight: 700 }}>{p.plan_number}</span>
            <span className="sub">{p.projects?.project_code} — {p.client}</span>
            <span className="sub">{p.product_item} × {p.quantity ?? "—"}</span>
            <span className="sub">{p.planned_start_date || "—"} → {p.planned_completion_date || "—"}</span>
            <span className="sub">Drawing: {p.drawing_status} · Material: {p.material_availability_status}</span>
            <span className={`badge ${STATUS_BADGE[p.status] || "CLOSED"}`}>{p.status}</span>
            <select value={p.status} onChange={(e) => handleStatus(p, e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
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
