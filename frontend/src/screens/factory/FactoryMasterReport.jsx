import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import {
  listFactoryMaterials, listFactoryMaterialStock,
  factoryWorkerProductivity, factoryShiftProductivity, factoryInventoryCosting,
  listAllFactoryQualityChecks, listAllFactoryReworkRecords, listAllFactoryRejectionRecords,
  listAllFactoryFinishedGoods, listAllFactoryPackingRecords, listAllFactoryTransfers,
  listAllFactoryProductCosting,
} from "../../lib/interiorApi";
import { exportRowsToExcel } from "../../lib/exportExcel";
import SimpleBarChart from "../../components/SimpleBarChart.jsx";
import FilterChips from "../../components/FilterChips.jsx";
import { useIncludeTestData } from "../../lib/testDataVisibility";
import IncludeTestDataToggle from "../../components/IncludeTestDataToggle";

const TERMINAL_STATUSES = ["Completed", "Installed", "Delivered", "Dispatched", "Cancelled"];
const CAN_SEE_COSTING_ROLES = new Set(["dept_head", "accounts_head", "cfo", "sysadmin"]);

function isoDate(d) { return d.toISOString().slice(0, 10); }

function Section({ title, children }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

function Tile({ label, value, tone }) {
  return (
    <div className="card dept-meta-tile">
      <div className="label">{label}</div>
      <div className="value" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );
}

// The Factory Master Report — combines information already computed by
// live queries/RPCs elsewhere in the module (worker/shift productivity,
// inventory costing, QC, rework/rejection, finished goods/packing/transfer,
// restricted product costing) into one drill-down view, rather than
// maintaining a second parallel set of totals that could drift from the
// screens that already own each number.
export default function FactoryMasterReport({ lang, profile }) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [jobs, setJobs] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [materialStock, setMaterialStock] = useState([]);
  const [workerProd, setWorkerProd] = useState([]);
  const [shiftProd, setShiftProd] = useState([]);
  const [inventoryCosting, setInventoryCosting] = useState([]);
  const [qcChecks, setQcChecks] = useState([]);
  const [reworkRecords, setReworkRecords] = useState([]);
  const [rejectionRecords, setRejectionRecords] = useState([]);
  const [finishedGoods, setFinishedGoods] = useState([]);
  const [packingRecords, setPackingRecords] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [productCosting, setProductCosting] = useState([]);

  const [deptFilter, setDeptFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const { includeTestData, canToggle, setIncludeTestData } = useIncludeTestData(profile);
  const canSeeCosting = !!profile?.isManagement || !!profile?.isSuperAdmin || CAN_SEE_COSTING_ROLES.has(profile?.roleCode);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    let jobQuery = supabase
      .from("inhouse_production_requests")
      .select(`*, purchase_requests(request_number, project_id, projects(project_code, customer)),
        linked_task:staff_tasks!inhouse_production_requests_linked_task_id_fkey(id, from_department_id, departments:from_department_id(code, name_en, name_gu))`)
      .order("created_at", { ascending: false });
    if (!includeTestData) jobQuery = jobQuery.eq("is_test_data", false);

    const calls = [
      jobQuery,
      supabase.from("departments").select("id, code, name_en, name_gu").eq("is_active", true).eq("is_control_tower", false).neq("code", "FACTORY").order("name_en"),
      listFactoryMaterials(includeTestData),
      listFactoryMaterialStock(includeTestData),
      factoryWorkerProductivity(dateFrom || null, dateTo || null, includeTestData),
      factoryShiftProductivity(dateFrom || null, dateTo || null, includeTestData),
      factoryInventoryCosting(dateFrom || null, dateTo || null, includeTestData),
      listAllFactoryQualityChecks(null, includeTestData),
      listAllFactoryReworkRecords(includeTestData),
      listAllFactoryRejectionRecords(includeTestData),
      listAllFactoryFinishedGoods(includeTestData),
      listAllFactoryPackingRecords(includeTestData),
      listAllFactoryTransfers(includeTestData),
    ];
    if (canSeeCosting) calls.push(listAllFactoryProductCosting(includeTestData));

    const results = await Promise.all(calls);
    if (results.some((r) => r.error)) { setError(true); setLoading(false); return; }
    const [jobRes, deptRes, matRes, stockRes, wpRes, spRes, icRes, qcRes, rwRes, rjRes, fgRes, pkRes, trRes, costRes] = results;
    setJobs(jobRes.data || []);
    setDepartments(deptRes.data || []);
    setMaterials(matRes.data || []);
    setMaterialStock(stockRes.data || []);
    setWorkerProd(wpRes.data || []);
    setShiftProd(spRes.data || []);
    setInventoryCosting(icRes.data || []);
    setQcChecks(qcRes.data || []);
    setReworkRecords(rwRes.data || []);
    setRejectionRecords(rjRes.data || []);
    setFinishedGoods(fgRes.data || []);
    setPackingRecords(pkRes.data || []);
    setTransfers(trRes.data || []);
    setProductCosting(canSeeCosting ? (costRes?.data || []) : []);
    setLoading(false);
  }, [includeTestData, dateFrom, dateTo, canSeeCosting]);

  useEffect(() => { load(); }, [load]);

  function sourceDept(row) {
    const d = row.linked_task?.departments;
    if (d) return d;
    return { code: "INTERIOR", name_en: "Interior Projects", name_gu: "ઈન્ટિરિયર પ્રોજેક્ટ્સ" };
  }

  const today = isoDate(new Date());
  const filteredJobs = useMemo(() => jobs.filter((r) => {
    if (deptFilter && sourceDept(r).code !== deptFilter) return false;
    if (statusFilter && r.status !== statusFilter) return false;
    if (dateFrom && (!r.required_completion_date || r.required_completion_date < dateFrom)) return false;
    if (dateTo && (!r.required_completion_date || r.required_completion_date > dateTo)) return false;
    return true;
  }), [jobs, deptFilter, statusFilter, dateFrom, dateTo]);

  const filteredJobIds = useMemo(() => new Set(filteredJobs.map((j) => j.id)), [filteredJobs]);

  // A. Source summary
  const sourceSummary = useMemo(() => {
    const byCode = new Map();
    departments.forEach((d) => byCode.set(d.code, { code: d.code, name_en: d.name_en, name_gu: d.name_gu, total: 0, open: 0, inProgress: 0, completed: 0, overdue: 0 }));
    if (!byCode.has("INTERIOR")) byCode.set("INTERIOR", { code: "INTERIOR", name_en: "Interior Projects", name_gu: "ઈન્ટિરિયર પ્રોજેક્ટ્સ", total: 0, open: 0, inProgress: 0, completed: 0, overdue: 0 });
    filteredJobs.forEach((r) => {
      const d = sourceDept(r);
      const b = byCode.get(d.code) || byCode.set(d.code, { code: d.code, name_en: d.name_en, name_gu: d.name_gu, total: 0, open: 0, inProgress: 0, completed: 0, overdue: 0 }).get(d.code);
      b.total += 1;
      if (!TERMINAL_STATUSES.includes(r.status)) b.open += 1;
      if (["Production Started", "Work in Progress"].includes(r.status)) b.inProgress += 1;
      if (["Completed", "Installed", "Delivered"].includes(r.status)) b.completed += 1;
      if (r.required_completion_date && r.required_completion_date < today && !TERMINAL_STATUSES.includes(r.status)) b.overdue += 1;
    });
    const grandTotal = filteredJobs.length || 1;
    return Array.from(byCode.values()).map((b) => ({ ...b, pct: Math.round((b.total / grandTotal) * 100) })).sort((a, b) => b.total - a.total);
  }, [departments, filteredJobs, today]);

  // B. Job summary
  const jobSummary = useMemo(() => {
    const byStage = new Map();
    filteredJobs.forEach((r) => { const s = r.current_stage || "—"; byStage.set(s, (byStage.get(s) || 0) + 1); });
    const completedJobs = filteredJobs.filter((r) => ["Completed", "Installed", "Delivered"].includes(r.status) && r.submitted_at && r.actual_completion_date);
    const avgDays = completedJobs.length
      ? Math.round(completedJobs.reduce((s, r) => s + (new Date(r.actual_completion_date) - new Date(r.submitted_at)) / 86400000, 0) / completedJobs.length)
      : null;
    return {
      total: filteredJobs.length,
      dueToday: filteredJobs.filter((r) => r.required_completion_date === today && !TERMINAL_STATUSES.includes(r.status)).length,
      delayed: filteredJobs.filter((r) => r.required_completion_date && r.required_completion_date < today && !TERMINAL_STATUSES.includes(r.status)).length,
      completed: filteredJobs.filter((r) => ["Completed", "Installed", "Delivered"].includes(r.status)).length,
      avgCompletionDays: avgDays,
      byStage: Array.from(byStage.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [filteredJobs, today]);

  // C. Project summary
  const projectSummary = useMemo(() => {
    const byProject = new Map();
    filteredJobs.forEach((r) => {
      const pid = r.purchase_requests?.project_id;
      if (!pid) return;
      if (!byProject.has(pid)) byProject.set(pid, { code: r.purchase_requests?.projects?.project_code, customer: r.purchase_requests?.projects?.customer, dept: sourceDept(r).name_en, total: 0, completed: 0, delayed: 0 });
      const b = byProject.get(pid);
      b.total += 1;
      if (["Completed", "Installed", "Delivered"].includes(r.status)) b.completed += 1;
      if (r.required_completion_date && r.required_completion_date < today && !TERMINAL_STATUSES.includes(r.status)) b.delayed += 1;
    });
    return Array.from(byProject.values()).sort((a, b) => b.total - a.total);
  }, [filteredJobs, today]);

  // D. Material summary
  const materialSummary = useMemo(() => {
    let available = 0, reserved = 0, shortageCount = 0;
    const byMaterial = new Map(materialStock.map((s) => [s.material_id, s]));
    materials.forEach((m) => {
      const s = byMaterial.get(m.id);
      const onHand = s ? Number(s.quantity_on_hand) : 0;
      const res = s ? Number(s.reserved_quantity) : 0;
      available += onHand - res;
      reserved += res;
      if (m.reorder_level != null && (onHand - res) < m.reorder_level) shortageCount += 1;
    });
    return { materialCount: materials.length, available, reserved, shortageCount };
  }, [materials, materialStock]);

  // F. Quality summary
  const qcInScope = useMemo(() => qcChecks.filter((c) => filteredJobIds.has(c.job_id)), [qcChecks, filteredJobIds]);
  const reworkInScope = useMemo(() => reworkRecords.filter((r) => filteredJobIds.has(r.job_id)), [reworkRecords, filteredJobIds]);
  const rejectionInScope = useMemo(() => rejectionRecords.filter((r) => filteredJobIds.has(r.job_id)), [rejectionRecords, filteredJobIds]);
  const qualitySummary = useMemo(() => {
    const total = qcInScope.length || 1;
    const pass = qcInScope.filter((c) => c.result === "pass").length;
    const fail = qcInScope.filter((c) => c.result === "fail").length;
    return {
      total: qcInScope.length, pass, fail, passPct: Math.round((pass / total) * 100), failPct: Math.round((fail / total) * 100),
      rework: reworkInScope.length, openRework: reworkInScope.filter((r) => !r.is_closed).length, rejections: rejectionInScope.length,
    };
  }, [qcInScope, reworkInScope, rejectionInScope]);

  // G. Finished goods summary
  const fgInScope = useMemo(() => finishedGoods.filter((f) => filteredJobIds.has(f.job_id)), [finishedGoods, filteredJobIds]);
  const packingInScope = useMemo(() => packingRecords.filter((p) => filteredJobIds.has(p.job_id)), [packingRecords, filteredJobIds]);
  const transfersInScope = useMemo(() => transfers.filter((t) => filteredJobIds.has(t.job_id)), [transfers, filteredJobIds]);
  const fgSummary = useMemo(() => ({
    finishedQty: fgInScope.reduce((s, f) => s + Number(f.completed_quantity || 0), 0),
    packed: packingInScope.filter((p) => p.status === "Packed" || p.status === "Ready for Transfer").length,
    pendingPacking: fgInScope.length - packingInScope.length,
    readyForTransfer: packingInScope.filter((p) => p.status === "Ready for Transfer").length,
    transferred: transfersInScope.filter((t) => t.status === "Received").length,
    receiptPending: transfersInScope.filter((t) => ["Dispatched", "In Transit", "Partially Received"].includes(t.status)).length,
  }), [fgInScope, packingInScope, transfersInScope]);

  // H. Costing (restricted)
  const costingInScope = useMemo(() => productCosting.filter((c) => filteredJobIds.has(c.job_id)), [productCosting, filteredJobIds]);
  const costingSummary = useMemo(() => ({
    estimated: costingInScope.reduce((s, c) => s + Number(c.estimated_cost || 0), 0),
    actual: costingInScope.reduce((s, c) => s + Number(c.total_actual_cost || 0), 0),
    variance: costingInScope.reduce((s, c) => s + Number(c.variance || 0), 0),
  }), [costingInScope]);

  function handleExport() {
    exportRowsToExcel("Factory-Master-Report-export.xlsx", "Job Summary", filteredJobs.map((r) => ({
      JobOrder: r.job_order_number, SourceDept: sourceDept(r).name_en, Project: r.purchase_requests?.projects?.project_code,
      Customer: r.purchase_requests?.projects?.customer, Product: r.product_item, Status: r.status, Stage: r.current_stage,
      Progress: r.completion_percentage ?? 0, DueDate: r.required_completion_date || "",
      GeneratedBy: profile?.full_name || profile?.id || "", GeneratedAt: new Date().toISOString(),
      FiltersApplied: `dept=${deptFilter || "All"}; status=${statusFilter || "All"}; from=${dateFrom || "-"}; to=${dateTo || "-"}`,
    })));
  }

  if (loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 90 }} /><div className="kpi-grid">{[1, 2, 3, 4].map((i) => <div key={i} className="skeleton-block kpi-skeleton" />)}</div></div>;
  if (error) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">Could not load the Factory Master Report. Please retry.</div>
        <button className="btn btn-primary" onClick={load}>Retry</button>
      </div>
    );
  }

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📊</div>
        <div className="dept-header-text">
          <h1>Factory Master Report</h1>
          <div className="sub">Live, reconciled against the same records every other Factory screen reads — generated {new Date().toLocaleString()} by {profile?.full_name || "—"}</div>
        </div>
      </div>

      <div className="card">
        <button type="button" className="btn btn-outline filter-toggle-btn" style={{ width: "100%", marginBottom: 8 }} onClick={() => setFiltersOpen((s) => !s)}>
          {filtersOpen ? "Hide Filters ▲" : "Filters ▼"}
        </button>
        <FilterChips chips={[
          deptFilter && { key: "dept", label: departments.find((d) => d.code === deptFilter) ? (lang === "gu" ? departments.find((d) => d.code === deptFilter).name_gu : departments.find((d) => d.code === deptFilter).name_en) : deptFilter, onClear: () => setDeptFilter("") },
          statusFilter && { key: "status", label: statusFilter, onClear: () => setStatusFilter("") },
          dateFrom && { key: "from", label: `From ${dateFrom}`, onClear: () => setDateFrom("") },
          dateTo && { key: "to", label: `To ${dateTo}`, onClear: () => setDateTo("") },
        ]} />
        <div className={`task-meta collapsible-filters ${filtersOpen ? "filters-open" : ""}`} style={{ flexWrap: "wrap", gap: 8 }}>
          <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">All Departments</option>
            {departments.map((d) => <option key={d.id} value={d.code}>{lang === "gu" ? d.name_gu : d.name_en}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">All Statuses</option>
            {[...new Set(jobs.map((j) => j.status))].sort().map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} title="From (required-by date)" />
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} title="To (required-by date)" />
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => { setDeptFilter(""); setStatusFilter(""); setDateFrom(""); setDateTo(""); }}>Clear Filters</button>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={load}>Refresh</button>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={handleExport}>Export Excel</button>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => window.print()}>Print / PDF</button>
          <IncludeTestDataToggle canToggle={canToggle} includeTestData={includeTestData} onChange={setIncludeTestData} />
        </div>
      </div>

      <Section title="A. Source Summary — Work Received by Department">
        <div className="dept-meta-grid">
          {sourceSummary.map((d) => (
            <div key={d.code} className="card dept-meta-tile">
              <div className="label">{lang === "gu" ? d.name_gu : d.name_en}</div>
              <div className="value">{d.total} <span className="sub">({d.pct}%)</span></div>
              <div className="sub">Open {d.open} · In Progress {d.inProgress} · Completed {d.completed} · Overdue {d.overdue}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12 }}>
          <SimpleBarChart data={sourceSummary.filter((d) => d.total > 0).map((d) => ({ label: lang === "gu" ? d.name_gu : d.name_en, value: d.total }))} />
        </div>
      </Section>

      <Section title="B. Job Summary">
        <div className="kpi-grid">
          <Tile label="Total Jobs" value={jobSummary.total} />
          <Tile label="Due Today" value={jobSummary.dueToday} tone={jobSummary.dueToday ? "#b45309" : undefined} />
          <Tile label="Delayed" value={jobSummary.delayed} tone={jobSummary.delayed ? "#b91c1c" : undefined} />
          <Tile label="Completed" value={jobSummary.completed} />
          <Tile label="Avg. Completion Time" value={jobSummary.avgCompletionDays != null ? `${jobSummary.avgCompletionDays}d` : "—"} />
        </div>
        <div style={{ marginTop: 12 }}>
          <SimpleBarChart color="var(--accent)" data={jobSummary.byStage.map(([s, c]) => ({ label: s, value: c }))} />
        </div>
      </Section>

      <Section title="C. Project/Order Summary">
        {projectSummary.length === 0 && <div className="msg info">No jobs match the current filters.</div>}
        {projectSummary.map((p) => (
          <div key={`${p.code}-${p.customer}`} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border, #e5e7eb)" }}>
            <span style={{ fontWeight: 700 }}>{p.code} — {p.customer}</span>
            <span className="sub">{p.dept}</span>
            <span className="sub">Jobs {p.total} · Completed {p.completed} · Delayed {p.delayed}</span>
          </div>
        ))}
      </Section>

      <Section title="D. Material Summary">
        <div className="kpi-grid">
          <Tile label="Materials Tracked" value={materialSummary.materialCount} />
          <Tile label="Available (all locations)" value={materialSummary.available} />
          <Tile label="Reserved" value={materialSummary.reserved} />
          <Tile label="Below Reorder Level" value={materialSummary.shortageCount} tone={materialSummary.shortageCount ? "#b91c1c" : undefined} />
        </div>
      </Section>

      <Section title="E. Production Summary — Worker/Shift Productivity, Inventory Costing">
        <div className="sub">Worker productivity ({workerProd.length} employees) and Shift productivity ({shiftProd.length} shift-days) — see the dedicated Worker/Shift Productivity screens for full detail; figures here are the same live RPCs, not recomputed.</div>
        <div className="kpi-grid" style={{ marginTop: 8 }}>
          <Tile label="Employees Tracked" value={workerProd.length} />
          <Tile label="Shift-Days Tracked" value={shiftProd.length} />
          <Tile label="Inventory Value Rows" value={inventoryCosting.length} />
        </div>
      </Section>

      <Section title="F. Quality Summary">
        <div className="kpi-grid">
          <Tile label="QC Checks" value={qualitySummary.total} />
          <Tile label="Pass %" value={`${qualitySummary.passPct}%`} />
          <Tile label="Fail %" value={`${qualitySummary.failPct}%`} tone={qualitySummary.fail ? "#b91c1c" : undefined} />
          <Tile label="Rework (open)" value={`${qualitySummary.rework} (${qualitySummary.openRework})`} />
          <Tile label="Rejections" value={qualitySummary.rejections} />
        </div>
      </Section>

      <Section title="G. Finished Goods Summary">
        <div className="kpi-grid">
          <Tile label="Finished Qty" value={fgSummary.finishedQty} />
          <Tile label="Packed" value={fgSummary.packed} />
          <Tile label="Pending Packing" value={Math.max(fgSummary.pendingPacking, 0)} />
          <Tile label="Ready for Transfer" value={fgSummary.readyForTransfer} />
          <Tile label="Transferred" value={fgSummary.transferred} />
          <Tile label="Receipt Pending" value={fgSummary.receiptPending} />
        </div>
      </Section>

      {canSeeCosting ? (
        <Section title="H. Costing — Restricted">
          <div className="kpi-grid">
            <Tile label="Estimated Cost" value={costingSummary.estimated.toFixed(0)} />
            <Tile label="Actual Cost" value={costingSummary.actual.toFixed(0)} />
            <Tile label="Variance" value={costingSummary.variance.toFixed(0)} tone={costingSummary.variance > 0 ? "#b91c1c" : undefined} />
          </div>
          <div className="sub" style={{ marginTop: 6 }}>Visible to you because your role is authorized (Management/Super Admin/Factory Head/Accounts). RLS on factory_product_costing enforces this server-side — this section is not just hidden by the UI for anyone else.</div>
        </Section>
      ) : (
        <Section title="H. Costing — Restricted">
          <div className="msg info">Costing figures are restricted to Management, Super Admin, Factory Department Head and authorized Accounts roles.</div>
        </Section>
      )}

      <Section title="Job Cards (drill-down)">
        {filteredJobs.length === 0 && <div className="msg info">No matching Factory jobs for the current filters.</div>}
        {filteredJobs.slice(0, 50).map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap", gap: 6, borderBottom: "1px solid var(--border, #e5e7eb)" }}>
            <span style={{ fontWeight: 700 }}>{r.job_order_number}</span>
            <span className="sub">{sourceDept(r).name_en}</span>
            <span className="sub">{r.purchase_requests?.projects?.project_code} — {r.product_item}</span>
            <span className="badge ASSIGNED">{r.status}</span>
            <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => navigate(`/factory/job-orders?job=${r.id}`)}>Open Job Card</button>
          </div>
        ))}
        {filteredJobs.length > 50 && <div className="sub" style={{ marginTop: 6 }}>Showing first 50 of {filteredJobs.length} — refine filters or use Export for the complete list.</div>}
      </Section>
    </div>
  );
}
