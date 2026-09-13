import React, { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { listAttachments, listInteriorPeople, getAttachmentUrl, listMaterialSelectionAttachmentsForProject } from "../../lib/interiorApi";

// "All Files" — every file uploaded for THIS project across every module,
// in one place. Reuses listAttachments(projectId) with no stage filter
// (attachments.stage IS the "module" the spec asks to filter/show by —
// Quotation/Design/Drawings are the only modules that currently store
// real files through Attach a File) PLUS material_selection_attachments
// (a separate table, since those rows carry a material_selection_id the
// generic attachments table has no column for) — normalized onto the same
// shape below so both sources render through one list/filter/search.
export default function InteriorAllFiles({ lang, projectId }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [people, setPeople] = useState([]);
  const [search, setSearch] = useState("");
  const [moduleFilter, setModuleFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");

  const load = useCallback(async () => {
    if (!projectId) { setRows([]); setLoading(false); return; }
    setLoading(true);
    setError(false);
    const [{ data, error: err }, peopleRes, msAttRes] = await Promise.all([
      listAttachments(projectId), listInteriorPeople(), listMaterialSelectionAttachmentsForProject(projectId),
    ]);
    if (err) { setError(true); setLoading(false); return; }
    const generic = (data || []).map((r) => ({
      id: r.id, title: r.title || r.file_name, stage: r.stage, version: r.version, frozen: r.frozen,
      uploaded_by: r.uploaded_by, created_at: r.created_at, storage_path: r.storage_path, file_type: r.file_type,
    }));
    const materialSelection = (msAttRes.data || []).map((a) => ({
      id: a.id, title: a.original_file_name || a.file_name, stage: "Material Selection", version: null, frozen: false,
      uploaded_by: a.uploaded_by, created_at: a.uploaded_at, storage_path: a.storage_path, file_type: a.file_type,
    }));
    setRows([...generic, ...materialSelection]);
    setPeople(peopleRes.data || []);
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const personName = useCallback((id) => people.find((p) => p.id === id)?.name || "—", [people]);

  const modules = useMemo(() => Array.from(new Set(rows.map((r) => r.stage).filter(Boolean))), [rows]);
  const fileTypes = useMemo(() => Array.from(new Set(rows.map((r) => r.file_type).filter(Boolean))), [rows]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (moduleFilter && r.stage !== moduleFilter) return false;
    if (typeFilter && r.file_type !== typeFilter) return false;
    if (search && !(r.title || r.file_name || "").toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [rows, moduleFilter, typeFilter, search]);

  async function openFile(storagePath) {
    const { url } = await getAttachmentUrl(storagePath);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  if (loading) return <div className="skeleton-block" style={{ height: 220 }} />;
  if (error) {
    return (
      <div className="card">
        <div className="msg error">{t("loadErrorRetry", lang)}</div>
        <button className="btn btn-primary" onClick={load}>{t("retry", lang)}</button>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>{t("tabFiles", lang)}</h2>
      <div className="filter-bar">
        <input placeholder={t("searchLabel", lang)} value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: "auto", minWidth: 160 }} />
        <select value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)}>
          <option value="">{t("allModulesLabel", lang)}</option>
          {modules.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">{t("allFileTypesLabel", lang)}</option>
          {fileTypes.map((ft) => <option key={ft} value={ft}>{ft}</option>)}
        </select>
      </div>

      {filtered.length === 0 && <div className="msg info" style={{ marginTop: 10 }}>{t("noRecordsForProject", lang)}</div>}
      {filtered.map((r) => (
        <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 6 }}>
          <span>{r.title || r.file_name} {r.version ? `(${r.version})` : ""}</span>
          <span className="badge ASSIGNED">{r.stage}</span>
          <span className="sub">{personName(r.uploaded_by)} · {(r.created_at || "").slice(0, 10)}</span>
          {r.frozen && <span className="badge CLOSED">{t("frozenLabel", lang)}</span>}
          {r.storage_path ? (
            <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => openFile(r.storage_path)}>
              {t("download", lang)}
            </button>
          ) : (
            // A record saved via "Save without a file" (e.g. logging that a
            // physical document was handed over in person) — nothing was
            // ever uploaded, so there's genuinely no file to download.
            // Saying so beats silently showing no button at all.
            <span className="sub">{t("noFileAttachedLabel", lang)}</span>
          )}
        </div>
      ))}
    </div>
  );
}
