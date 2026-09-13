import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { listAllInhouseProductionRequests, updateInhouseProductionStatus, listInteriorPeople } from "../../lib/interiorApi";

// The first genuinely-wired screen the Factory department has ever had —
// Interior's Working Drawings/Purchase Management "Submit to Factory"
// action creates a row in inhouse_production_requests; this is where a
// Factory-side user actually sees and updates it. There is no pre-
// existing Factory system to integrate with (deptPage("FACTORY") was a
// bare placeholder before this), so this is intentionally minimal: a
// list + one status dropdown, reusing the exact interior_is_org_wide()/
// staff_is_dept_head() RLS already governing inhouse_production_requests
// -- no separate Factory-side access table was invented.
const INHOUSE_STATUSES = [
  "Draft", "Submitted to Factory", "Factory Accepted", "Material Check Pending", "Raw Material Pending",
  "Ready for Production", "Production Started", "Work in Progress", "QC Pending", "QC Failed", "Rework",
  "QC Passed", "Packing", "Ready for Dispatch", "Dispatched", "Delivered", "Installed", "Completed", "On Hold", "Cancelled",
];
const STATUS_BADGE = {
  Draft: "CLOSED", "Submitted to Factory": "ASSIGNED", "Factory Accepted": "ASSIGNED", "Production Started": "IN_PROGRESS",
  "Work in Progress": "IN_PROGRESS", "QC Failed": "RETURNED", "QC Passed": "VERIFIED", Dispatched: "COMPLETED",
  Delivered: "VERIFIED", Installed: "VERIFIED", Completed: "VERIFIED", "On Hold": "REVISION", Cancelled: "CLOSED",
};

function personName(people, id) {
  return people.find((p) => p.id === id)?.name || "—";
}

export default function FactoryJobOrders({ lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [people, setPeople] = useState([]);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data, error: err }, peopleRes] = await Promise.all([listAllInhouseProductionRequests(), listInteriorPeople()]);
    if (err) { setError(true); setLoading(false); return; }
    setRows(data || []);
    setPeople(peopleRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleStatus(row, status) {
    await updateInhouseProductionStatus(row.purchase_requests?.project_id, row.id, { status });
    load();
  }

  const filtered = filter ? rows.filter((r) => r.status === filter) : rows;

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
          <h1>{t("factoryJobOrdersTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: "auto" }}>
          <option value="">{t("allModulesLabel", lang)}</option>
          {INHOUSE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div className="card">
        {filtered.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {filtered.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 6 }}>
            <span style={{ fontWeight: 700 }}>{r.job_order_number}</span>
            <span className="sub">{r.purchase_requests?.request_number} · {r.purchase_requests?.projects?.project_code} — {r.purchase_requests?.projects?.customer}</span>
            <span className="sub">{r.product_item}</span>
            <span className="sub">{personName(people, r.assigned_factory_coordinator)}</span>
            <span className={`badge ${STATUS_BADGE[r.status] || "CLOSED"}`}>{r.status}</span>
            <select value={r.status} onChange={(e) => handleStatus(r, e.target.value)}>
              {INHOUSE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
