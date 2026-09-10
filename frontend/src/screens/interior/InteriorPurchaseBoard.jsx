import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { updateMaterialStatus } from "../../lib/interiorApi";

// Purchase Board — md/MOOD-OF-WOOD-SYSTEM.md §6: five clickable status
// cards over ALL running projects' project_materials rows, filtering the
// list below, plus a Needs Attention block (new request / pending / due
// within 2 days / delayed).
const STATUSES = ["Pending to Order", "Ordered", "In Transit", "Delayed", "Received"];
const STATUS_KEY = { "Pending to Order": "pendingToOrderLabel", Ordered: "orderedLabel", "In Transit": "inTransitLabel", Delayed: "delayedLabel", Received: "receivedLabel" };

export default function InteriorPurchaseBoard({ lang }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [projects, setProjects] = useState([]);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [matRes, projRes] = await Promise.all([
      supabase.from("project_materials").select("*").order("created_at", { ascending: false }).limit(500),
      supabase.from("projects").select("id, project_code, customer").eq("archived", false),
    ]);
    if (matRes.error || projRes.error) { setError(true); setLoading(false); return; }
    setRows(matRes.data || []);
    setProjects(projRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const projectLabel = (id) => {
    const p = projects.find((pr) => pr.id === id);
    return p ? `${p.project_code} — ${p.customer}` : "—";
  };

  const counts = useMemo(() => {
    const c = {};
    for (const s of STATUSES) c[s] = rows.filter((r) => r.status === s).length;
    return c;
  }, [rows]);

  const filteredRows = useMemo(() => (filter ? rows.filter((r) => r.status === filter) : rows), [rows, filter]);

  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const attention = useMemo(() => rows.filter((r) =>
    r.status === "Pending to Order"
    || (r.required_by && r.required_by <= soon && r.required_by >= today && r.status !== "Received")
    || r.status === "Delayed",
  ), [rows, today, soon]);

  async function changeStatus(id, status) {
    const { error: err } = await updateMaterialStatus("project_materials", id, status);
    if (!err) load();
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
        <div className="dept-header-icon" aria-hidden="true">🧾</div>
        <div className="dept-header-text">
          <h1>{t("purchaseBoardTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="kpi-grid kpi-grid-wide">
        {STATUSES.map((s) => (
          <button key={s} className={`kpi-tile${filter === s ? " gold" : ""}`} onClick={() => setFilter(filter === s ? "" : s)}>
            <div className="num">{counts[s] || 0}</div><div className="label">{t(STATUS_KEY[s], lang)}</div>
          </button>
        ))}
      </div>

      <div className="card">
        <h2>{t("needsAttentionLabel", lang)}</h2>
        {attention.length === 0 && <div className="msg info">{t("allCaughtUp", lang)}</div>}
        {attention.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
            <span>{r.material} — {projectLabel(r.project_id)}</span>
            <span className="badge ASSIGNED">{r.status}</span>
          </div>
        ))}
      </div>

      <div className="card">
        {filteredRows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {filteredRows.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap", gap: 6 }}>
            <span>{r.material} — {projectLabel(r.project_id)}</span>
            <span className="sub">{t("requiredByLabel", lang)}: {r.required_by || "—"}</span>
            <select value={r.status} onChange={(e) => changeStatus(r.id, e.target.value)}>
              {[...STATUSES, "Not Required"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
