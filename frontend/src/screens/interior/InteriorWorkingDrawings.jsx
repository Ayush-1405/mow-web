import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import {
  listProjects, listInteriorPeople, getAttachmentUrl,
  uploadWorkingDrawingFile, listWorkingDrawingFiles, updateWorkingDrawingFileCategory,
  createWorkingDrawingTask,
} from "../../lib/interiorApi";

// Working Drawings — simplified per explicit request: a plain project-wise
// file register (title + mandatory category + optional note), not the
// room/area/design-version/checklist workflow built earlier this session.
// That richer schema (working_drawing_areas, design_versions, etc.) is
// left completely alone in the database — nothing here deletes or reads
// it destructively — this screen just no longer offers a UI for it.
export const FILE_CATEGORIES = [
  "Furniture Drawing", "RCP – Reflected Ceiling Plan", "Electrical Drawing", "Furniture Detail Working Drawing",
  "Production Drawing", "Planning Drawing", "Material Specification", "Job Card", "Work Schedule",
  "MEP Drawing", "Plumbing Drawing", "HVAC Drawing", "Civil Drawing", "Flooring Drawing", "Elevation Drawing",
  "Section Drawing", "Furniture Layout", "Kitchen Drawing", "Wardrobe Drawing", "False Ceiling Drawing",
  "Hardware Details", "Installation Drawing", "BOQ", "Other",
];

function personName(people, id) {
  return people.find((p) => p.id === id)?.name || "—";
}

function formatFileSize(bytes) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(fileType) {
  if (!fileType) return "📎";
  if (fileType.startsWith("image/")) return "🖼️";
  if (fileType === "application/pdf") return "📄";
  if (fileType.startsWith("video/")) return "🎥";
  if (fileType.startsWith("audio/")) return "🎙️";
  return "📎";
}

function extOf(name) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name || "");
  return m ? m[1].toUpperCase() : "";
}

// Kept exported — InteriorPurchaseManagement.jsx reuses these four generic
// building blocks (upload drop-zone, attachment list, view/download
// button, quick "create task" action) rather than duplicating them.
export function AttachmentUploader({ lang, categories, onUpload, busy }) {
  const [dragOver, setDragOver] = useState(false);
  const [category, setCategory] = useState(categories[0]);

  function handleFiles(fileList) {
    const file = fileList?.[0];
    if (file) onUpload(file, category);
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
      style={{ marginTop: 8, border: `2px dashed ${dragOver ? "var(--accent)" : "var(--border)"}`, borderRadius: 8, padding: 12, textAlign: "center" }}
    >
      <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ marginBottom: 8 }}>
        {categories.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <label className="file-input-label">
        {busy ? t("uploading", lang) : t("dropFilesHereLabel", lang)}
        <input type="file" style={{ display: "none" }} disabled={busy}
          onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
      </label>
    </div>
  );
}

export function AttachmentList({ lang, attachments, isElevated, onDelete, confirmDeleteId }) {
  if (!attachments || attachments.length === 0) return <div className="msg info" style={{ marginTop: 4 }}>{t("noFileAttachedLabel", lang)}</div>;
  return attachments.map((a) => (
    <div key={a.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0", flexWrap: "wrap" }}>
      <span>{a.original_file_name || a.file_name}</span>
      <span className="sub">{a.file_category}</span>
      <ViewDownloadButton lang={lang} storagePath={a.storage_path} />
      {isElevated && onDelete && confirmDeleteId !== a.id && (
        <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => onDelete(a.id)}>{t("deleteTask", lang)}</button>
      )}
      {isElevated && onDelete && confirmDeleteId === a.id && (
        <span className="btn-row" style={{ marginTop: 0 }}>
          <span className="sub">{t("areYouSure", lang)}</span>
          <button className="btn btn-danger" style={{ marginTop: 0, width: "auto" }} onClick={() => onDelete(a.id)}>{t("confirm", lang)}</button>
        </span>
      )}
    </div>
  ));
}

export function CreateTaskButton({ lang, projectId, areaId, profile, people, title, relatedModule, relatedRecordId, priority }) {
  const [open, setOpen] = useState(false);
  const [assignedTo, setAssignedTo] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [done, setDone] = useState(false);

  async function handleCreate() {
    await createWorkingDrawingTask({
      projectId, areaId, title, assignedTo: assignedTo || null, dueDate: dueDate || null,
      createdBy: profile?.id, relatedModule, relatedRecordId, priority,
    });
    setOpen(false);
    setDone(true);
  }

  if (done) return <span className="badge VERIFIED">{t("taskCreatedLabel", lang)}</span>;
  if (!open) return <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => setOpen(true)}>{t("createTaskAction", lang)}</button>;
  return (
    <span className="btn-row" style={{ marginTop: 0 }}>
      <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
        <option value="">—</option>
        {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      <button className="btn btn-primary" style={{ marginTop: 0, width: "auto" }} onClick={handleCreate}>{t("save", lang)}</button>
    </span>
  );
}

export function ViewDownloadButton({ lang, storagePath, fileName }) {
  const [busy, setBusy] = useState(false);
  if (!storagePath) return <span className="sub">{t("noFileAttachedLabel", lang)}</span>;

  async function handleView() {
    const { url } = await getAttachmentUrl(storagePath);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  async function handleDownload() {
    setBusy(true);
    const { url } = await getAttachmentUrl(storagePath);
    if (url) {
      try {
        const blob = await (await fetch(url)).blob();
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = fileName || storagePath.split("/").pop();
        link.click();
        URL.revokeObjectURL(link.href);
      } catch {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    }
    setBusy(false);
  }

  return (
    <span className="btn-row" style={{ marginTop: 0 }}>
      <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={handleView}>{t("viewDetails", lang)}</button>
      <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} disabled={busy} onClick={handleDownload}>{t("download", lang)}</button>
    </span>
  );
}

// staffProfile is still accepted (App.jsx / InteriorProjectDetail.jsx both
// pass it, matching every other Interior screen's call signature) but this
// simplified page has no role-gated action left that needs it.
export default function InteriorWorkingDrawings({ lang, lockedProjectId: lockedProjectIdProp }) {
  const { projectId: routeProjectId } = useParams();
  const lockedProjectId = lockedProjectIdProp || routeProjectId;
  const profile = useInteriorProfile();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [people, setPeople] = useState([]);
  const [projectId, setProjectId] = useState("");

  const [files, setFiles] = useState([]);
  const [filesLoading, setFilesLoading] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", file_category: "", custom_category: "", note: "" });
  const [file, setFile] = useState(null);
  const [highlightCategory, setHighlightCategory] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const [uploading, setUploading] = useState(false);

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [uploadedByFilter, setUploadedByFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [typeFilter, setTypeFilter] = useState("");

  const [categoryDrafts, setCategoryDrafts] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data, error: err }, peopleRes] = await Promise.all([listProjects(), listInteriorPeople()]);
    if (err) { setError(true); setLoading(false); return; }
    setProjects(data || []);
    setPeople(peopleRes.data || []);
    if (data?.length) setProjectId((cur) => cur || lockedProjectId || data[0].id);
    setLoading(false);
  }, [lockedProjectId]);

  useEffect(() => { load(); }, [load]);

  const loadFiles = useCallback(async () => {
    if (!projectId) { setFiles([]); return; }
    setFilesLoading(true);
    const { data, error: err } = await listWorkingDrawingFiles(projectId);
    if (!err) setFiles(data || []);
    setFilesLoading(false);
  }, [projectId]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  function handleFileSelect(e) {
    const f = e.target.files?.[0] || null;
    setFile(f);
    if (f && !form.file_category) setHighlightCategory(true);
  }

  const canSave = !!projectId && !!form.title.trim() && !!form.file_category
    && (form.file_category !== "Other" || !!form.custom_category.trim()) && !!file;

  async function handleUpload(e) {
    e.preventDefault();
    if (!canSave || !file) return;
    setUploading(true);
    setUploadMsg(t("saving", lang));
    const { error: err } = await uploadWorkingDrawingFile({
      projectId, title: form.title.trim(), fileCategory: form.file_category,
      customCategory: form.file_category === "Other" ? form.custom_category.trim() : null,
      file, note: form.note || null, uploadedBy: profile?.id,
    });
    setUploading(false);
    if (err) { setUploadMsg(t("errorSaving", lang)); return; }
    setForm({ title: "", file_category: "", custom_category: "", note: "" });
    setFile(null);
    setHighlightCategory(false);
    setUploadMsg(t("saved", lang));
    setShowForm(false);
    loadFiles();
  }

  async function handleAssignCategory(row) {
    const draft = categoryDrafts[row.id];
    if (!draft?.file_category) return;
    await updateWorkingDrawingFileCategory(row.source, projectId, row.id, draft.file_category, draft.custom_category || null);
    setCategoryDrafts((d) => ({ ...d, [row.id]: null }));
    loadFiles();
  }

  const uploaders = useMemo(() => Array.from(new Set(files.map((f) => f.uploaded_by).filter(Boolean))), [files]);
  const fileTypes = useMemo(() => Array.from(new Set(files.map((f) => extOf(f.original_file_name)).filter(Boolean))), [files]);

  const filtered = useMemo(() => files.filter((f) => {
    if (categoryFilter && f.file_category !== categoryFilter) return false;
    if (uploadedByFilter && f.uploaded_by !== uploadedByFilter) return false;
    if (typeFilter && extOf(f.original_file_name) !== typeFilter) return false;
    if (dateFrom && (f.uploaded_at || "").slice(0, 10) < dateFrom) return false;
    if (dateTo && (f.uploaded_at || "").slice(0, 10) > dateTo) return false;
    if (search) {
      const hay = `${f.title || ""} ${f.original_file_name || ""}`.toLowerCase();
      if (!hay.includes(search.toLowerCase())) return false;
    }
    return true;
  }), [files, categoryFilter, uploadedByFilter, typeFilter, dateFrom, dateTo, search]);

  function clearFilters() {
    setSearch(""); setCategoryFilter(""); setUploadedByFilter(""); setDateFrom(""); setDateTo(""); setTypeFilter("");
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

  const project = projects.find((p) => p.id === projectId);

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📐</div>
        <div className="dept-header-text">
          <h1>{t("workingDrawingsTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>{t("selectProjectLabel", lang)}</label>
          {lockedProjectId ? (
            <div className="sub" style={{ fontWeight: 700, marginTop: 4 }}>{project ? `${project.project_code} — ${project.customer}` : "—"}</div>
          ) : (
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
            </select>
          )}
        </div>
      </div>

      <div className="card">
        <button className="btn btn-outline" style={{ width: "auto" }} onClick={() => setShowForm((s) => !s)}>
          + {t("uploadFileAction", lang)}
        </button>

        {showForm && (
          <form onSubmit={handleUpload} className="form-grid" style={{ marginTop: 10 }}>
            <div className="field full">
              <label>{t("titleLabel", lang)} *</label>
              <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} required />
            </div>
            <div className="field">
              <label>{t("fileCategoryLabel", lang)} *</label>
              <select
                value={form.file_category}
                onChange={(e) => { setForm((f) => ({ ...f, file_category: e.target.value })); setHighlightCategory(false); }}
                style={highlightCategory ? { borderColor: "var(--danger)", boxShadow: "0 0 0 2px rgba(200,60,60,0.25)" } : undefined}
                required
              >
                <option value="" disabled>—</option>
                {FILE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              {highlightCategory && <div className="msg error" style={{ marginTop: 6 }}>{t("selectCategoryFirstMsg", lang)}</div>}
            </div>
            {form.file_category === "Other" && (
              <div className="field">
                <label>{t("customCategoryLabel", lang)} *</label>
                <input value={form.custom_category} onChange={(e) => setForm((f) => ({ ...f, custom_category: e.target.value }))} required />
              </div>
            )}
            <div className="field">
              <label>{t("fileUploadLabel", lang)} *</label>
              <input type="file" onChange={handleFileSelect} required />
              {file && <div className="sub" style={{ marginTop: 4 }}>{file.name} ({formatFileSize(file.size)})</div>}
            </div>
            <div className="field full">
              <label>{t("notesLabel", lang)}</label>
              <textarea rows={2} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={!canSave || uploading}>
              {uploading ? t("saving", lang) : t("save", lang)}
            </button>
            {uploadMsg && <div className="sub" style={{ marginTop: 6 }}>{uploadMsg}</div>}
          </form>
        )}
      </div>

      <div className="card">
        <div className="filter-bar" style={{ flexWrap: "wrap" }}>
          <input placeholder={t("searchLabel", lang)} value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: "auto", minWidth: 180 }} />
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">{t("allCategoriesLabel", lang)}</option>
            {FILE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={uploadedByFilter} onChange={(e) => setUploadedByFilter(e.target.value)}>
            <option value="">{t("allUploadersLabel", lang)}</option>
            {uploaders.map((id) => <option key={id} value={id}>{personName(people, id)}</option>)}
          </select>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} title={t("uploadDateLabel", lang)} style={{ width: "auto" }} />
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} title={t("uploadDateLabel", lang)} style={{ width: "auto" }} />
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">{t("allFileTypesLabel", lang)}</option>
            {fileTypes.map((ft) => <option key={ft} value={ft}>{ft}</option>)}
          </select>
          <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={clearFilters}>{t("clearFiltersAction", lang)}</button>
        </div>
        <div className="sub" style={{ marginTop: 8 }}>{t("showingLabel", lang)} {filtered.length} {t("ofLabel", lang)} {files.length} {t("filesLabel", lang)}</div>
      </div>

      <div className="card">
        {filesLoading ? <div className="skeleton-block" style={{ height: 140 }} /> : (
          <>
            {filtered.length === 0 && <div className="msg info">{t("noRecordsForProject", lang)}</div>}
            {filtered.map((f) => {
              const draft = categoryDrafts[f.id];
              const displayCategory = f.file_category === "Other" ? f.custom_category : f.file_category;
              return (
                <div key={`${f.source}-${f.id}`} className="task-meta" style={{ justifyContent: "space-between", padding: "10px 0", flexWrap: "wrap", gap: 6, borderBottom: "1px solid var(--border)" }}>
                  <span style={{ fontSize: 20 }}>{fileIcon(f.file_type)}</span>
                  <span style={{ flex: "1 1 200px", fontWeight: 700 }}>{f.title}</span>
                  <span className="sub">{f.original_file_name}</span>
                  {displayCategory ? (
                    <span className="badge ASSIGNED">{displayCategory}</span>
                  ) : draft ? (
                    <span className="btn-row" style={{ marginTop: 0 }}>
                      <select value={draft.file_category || ""} onChange={(e) => setCategoryDrafts((d) => ({ ...d, [f.id]: { ...d[f.id], file_category: e.target.value } }))}>
                        <option value="" disabled>—</option>
                        {FILE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      {draft.file_category === "Other" && (
                        <input placeholder={t("customCategoryLabel", lang)} value={draft.custom_category || ""} onChange={(e) => setCategoryDrafts((d) => ({ ...d, [f.id]: { ...d[f.id], custom_category: e.target.value } }))} />
                      )}
                      <button className="btn btn-primary" style={{ marginTop: 0, width: "auto" }} onClick={() => handleAssignCategory(f)}>{t("save", lang)}</button>
                    </span>
                  ) : (
                    <span className="btn-row" style={{ marginTop: 0 }}>
                      <span className="badge CLOSED">{t("uncategorisedLabel", lang)}</span>
                      <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => setCategoryDrafts((d) => ({ ...d, [f.id]: { file_category: "" } }))}>
                        {t("assignCategoryAction", lang)}
                      </button>
                    </span>
                  )}
                  {f.note && <span className="sub">{t("notesLabel", lang)}: {f.note}</span>}
                  <span className="sub">{personName(people, f.uploaded_by)} · {f.uploaded_at ? new Date(f.uploaded_at).toLocaleString() : "—"}</span>
                  <span className="sub">{formatFileSize(f.file_size)}</span>
                  <ViewDownloadButton lang={lang} storagePath={f.storage_path} fileName={f.original_file_name} />
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
