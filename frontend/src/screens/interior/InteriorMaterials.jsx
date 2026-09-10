import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { listProjects, listMaterials, listProjectMaterials, updateMaterialStatus, updateMaterialField, notifyDeptLeadership } from "../../lib/interiorApi";

// Material Requirements / Purchase Coordination — both read the external
// system's `materials` + `project_materials` tables; Purchase Coordination
// is simply project_materials filtered to source='purchase' (filterSource
// prop), per the module rollout plan, rather than a separate table.
export default function InteriorMaterials({ lang, filterSource }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [materials, setMaterials] = useState([]);
  const [projectMaterials, setProjectMaterials] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: err } = await listProjects();
    if (err) { setError(true); setLoading(false); return; }
    setProjects(data || []);
    if (data?.length) setProjectId((cur) => cur || data[0].id);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadMaterials = useCallback(async () => {
    if (!projectId) { setMaterials([]); setProjectMaterials([]); return; }
    const [matRes, pmRes] = await Promise.all([
      filterSource ? Promise.resolve({ data: [] }) : listMaterials(projectId),
      listProjectMaterials(projectId, filterSource),
    ]);
    setMaterials(matRes.data || []);
    setProjectMaterials(pmRes.data || []);
  }, [projectId, filterSource]);

  useEffect(() => { loadMaterials(); }, [loadMaterials]);

  async function updateStatus(table, id, status, material) {
    const { error: err } = await updateMaterialStatus(table, id, status);
    if (err) return;
    const project = projects.find((p) => p.id === projectId);
    notifyDeptLeadership(
      "INTERIOR", "project", projectId,
      `Material status: ${material} → ${status} — ${project ? `${project.project_code} (${project.customer})` : ""}`,
      `સામગ્રી સ્થિતિ: ${material} → ${status}`,
    );
    loadMaterials();
  }

  async function toggleFlag(id, field, current) {
    const { error: err } = await updateMaterialField("materials", id, field, !current);
    if (!err) loadMaterials();
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
        <div className="dept-header-icon" aria-hidden="true">📐</div>
        <div className="dept-header-text">
          <h1>{t("interiorMaterialsTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>{t("projectCodeLabel", lang)}</label>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
          </select>
        </div>
      </div>

      {!filterSource && (
        <div className="card">
          <h2>{t("materialLabel", lang)}</h2>
          {materials.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
          {materials.map((m) => (
            <div key={m.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap", gap: 6 }}>
              <span>{m.material} ({m.quantity})</span>
              <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input type="checkbox" checked={!!m.ordered} onChange={() => toggleFlag(m.id, "ordered", m.ordered)} /> Ordered
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input type="checkbox" checked={!!m.received} onChange={() => toggleFlag(m.id, "received", m.received)} /> Received
              </label>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>{t("sourceLabel", lang)}</h2>
        {projectMaterials.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {projectMaterials.map((m) => (
          <div key={m.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
            <span>{m.material} · {t("neededByLabel", lang)}: {m.required_by || "—"}</span>
            <select value={m.status} onChange={(e) => updateStatus("project_materials", m.id, e.target.value, m.material)}>
              {["Pending to Order", "Ordered", "Received"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
