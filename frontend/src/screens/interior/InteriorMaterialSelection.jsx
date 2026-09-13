import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import { formatCurrency } from "../../lib/retailModules";
import {
  listProjects, listInteriorPeople, listMaterialSelections, createMaterialSelection,
  updateMaterialSelection, replaceMaterialSelection, markMaterialSelectionFinal,
  decideMaterialSelectionApproval, archiveMaterialSelection, uploadMaterialSelectionAttachment,
  listMaterialSelectionAttachments, deleteMaterialSelectionAttachment, getAttachmentUrl,
} from "../../lib/interiorApi";

// Area/room type options — bilingual pairs exactly as given in the spec.
// Exported so InteriorMasterReport.jsx can reuse the same catalogue for its
// "missing room selections" check, rather than duplicating the list.
export const AREA_TYPES = [
  ["Kitchen", "રસોડું"], ["Master Bedroom", "મુખ્ય બેડરૂમ"], ["Bedroom", "બેડરૂમ"],
  ["Children's Bedroom", "બાળકોનો બેડરૂમ"], ["Guest Bedroom", "ગેસ્ટ બેડરૂમ"], ["Living Room", "લિવિંગ રૂમ"],
  ["Drawing Room", "ડ્રોઇંગ રૂમ"], ["Dining Area", "ડાઇનિંગ એરિયા"], ["Hall", "હોલ"],
  ["Wardrobe", "વોર્ડરોબ"], ["TV Unit", "ટીવી યુનિટ"], ["Study Room", "સ્ટડી રૂમ"],
  ["Office", "ઑફિસ"], ["Reception", "રિસેપ્શન"], ["Bathroom", "બાથરૂમ"],
  ["Utility Area", "યુટિલિટી એરિયા"], ["Balcony", "બાલ્કની"], ["Pooja Room", "પૂજા રૂમ"],
  ["Other", "અન્ય"],
];

// Material categories / approval statuses / attachment categories were only
// given in English in the spec (no Gujarati pairs supplied, unlike area
// types above) — shown as-is regardless of language, same treatment this
// app already gives project.stage / status codes elsewhere rather than
// inventing an unverified translation.
const MATERIAL_CATEGORIES = [
  "Plywood", "Laminate", "Veneer", "MDF/HDF", "Particle Board", "Wood", "Acrylic", "Glass", "Mirror",
  "Stone", "Marble", "Granite", "Quartz", "Tiles", "Fabric", "Leather/Leatherette", "Wallpaper",
  "Paint/Polish", "Hardware", "Handles/Profiles", "Hinges", "Channels", "Kitchen Basket/Accessories",
  "Wardrobe Accessories", "Lighting", "Electrical", "Sanitary", "Flooring", "Ceiling Material",
  "Metal", "Upholstery", "Other",
];

const APPROVAL_STATUSES = [
  "Draft", "Selection Pending", "Submitted to Client", "Client Review Pending",
  "Approved", "Rejected", "Revision Required", "Replaced", "Final Selection Locked",
];

const SELECTED_BY_TYPES = ["Client", "Internal Designer", "Architect", "Management"];

const FILE_CATEGORIES = [
  "Material Photo", "Sample Photo", "Catalogue Image", "Catalogue PDF", "Specification Sheet",
  "Technical Datasheet", "Quotation", "Client Approval Proof", "WhatsApp Screenshot", "Email Proof",
  "Video", "Voice Note", "Other",
];

const STATUS_BADGE = {
  "Draft": "CLOSED", "Selection Pending": "ASSIGNED", "Client Review Pending": "ASSIGNED",
  "Submitted to Client": "ACCEPTED", "Approved": "VERIFIED", "Final Selection Locked": "VERIFIED",
  "Rejected": "RETURNED", "Revision Required": "REVISION", "Replaced": "CLOSED",
};

const emptyForm = {
  selection_date: new Date().toISOString().slice(0, 10), selected_by_type: "Internal Designer", selected_by_name: "",
  responsible_designer_id: "", area_type: "Kitchen", custom_area_type: "", area_name: "", floor: "", room_number: "",
  material_name: "", material_code: "", material_category: "Laminate", custom_material_category: "", material_type: "",
  brand: "", vendor_name: "", colour: "", finish: "", texture: "", dimensions: "", thickness: "", unit: "",
  quantity: "", rate: "", estimated_amount: "", usage_application: "", description: "", remarks: "",
  approval_status: "Draft", client_remarks: "", internal_remarks: "", design_lock_note: "",
};

export default function InteriorMaterialSelection({ lang, staffProfile, lockedProjectId: lockedProjectIdProp }) {
  // Explicit prop wins (passed by InteriorProjectDetail.jsx's tab array);
  // otherwise fall back to the route's own :projectId — same self-contained
  // pattern InteriorMasterReport.jsx already uses for its standalone
  // locked route (/interior-projects/material-selection/:projectId).
  const { projectId: routeProjectId } = useParams();
  const lockedProjectId = lockedProjectIdProp || routeProjectId;
  const profile = useInteriorProfile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [people, setPeople] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [replacingRow, setReplacingRow] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formMsg, setFormMsg] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [attachmentsById, setAttachmentsById] = useState({});
  const [uploadBusyId, setUploadBusyId] = useState(null);
  const [showSheet, setShowSheet] = useState(false);
  const [sheetGrouping, setSheetGrouping] = useState("room");
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [rowMsg, setRowMsg] = useState({});
  const [confirmArchiveId, setConfirmArchiveId] = useState(null);
  const [confirmDeleteAttId, setConfirmDeleteAttId] = useState(null);

  const isElevated = !!staffProfile?.isManagement || !!staffProfile?.isSuperAdmin || !!staffProfile?.isDeptHead;

  const [q, setQ] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterFinal, setFilterFinal] = useState("");
  const [filterDesigner, setFilterDesigner] = useState("");

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

  const loadSelections = useCallback(async () => {
    if (!projectId) { setRows([]); return; }
    const { data, error: err } = await listMaterialSelections(projectId);
    if (!err) setRows(data || []);
  }, [projectId]);

  useEffect(() => { loadSelections(); }, [loadSelections]);

  const currentProject = useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId]);
  const personName = useCallback((id) => people.find((p) => p.id === id)?.name || "—", [people]);

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
    setReplacingRow(null);
    setFormMsg("");
    setConfirmDuplicate(false);
  }

  // Only copies actual FORM fields (emptyForm's own keys) from an existing
  // row — never id/created_at/updated_at/previous_selection_id/
  // revision_number/status. Replace/Duplicate both insert a brand-new row;
  // letting the old row's id or timestamps leak into that insert would
  // either collide on the primary key (id) or silently backdate the new
  // row's created_at to the old row's original creation time.
  function formFieldsFromRow(row) {
    const picked = {};
    Object.keys(emptyForm).forEach((k) => { if (row[k] !== undefined && row[k] !== null) picked[k] = row[k]; });
    return picked;
  }

  function startEdit(row) {
    setForm({ ...emptyForm, ...formFieldsFromRow(row), quantity: row.quantity ?? "", rate: row.rate ?? "", estimated_amount: row.estimated_amount ?? "" });
    setEditingId(row.id);
    setReplacingRow(null);
    setShowForm(true);
    setFormMsg("");
    setConfirmDuplicate(false);
  }

  function startReplace(row) {
    setForm({ ...emptyForm, ...formFieldsFromRow(row), quantity: row.quantity ?? "", rate: row.rate ?? "", estimated_amount: row.estimated_amount ?? "", approval_status: "Draft", change_reason: "" });
    setEditingId(null);
    setReplacingRow(row);
    setShowForm(true);
    setFormMsg("");
    setConfirmDuplicate(false);
  }

  function startDuplicate(row) {
    setForm({ ...emptyForm, ...formFieldsFromRow(row), quantity: row.quantity ?? "", rate: row.rate ?? "", estimated_amount: row.estimated_amount ?? "", area_name: "", room_number: "" });
    setEditingId(null);
    setReplacingRow(null);
    setShowForm(true);
    setFormMsg("");
    setConfirmDuplicate(false);
  }

  function validate(requireAttachment) {
    if (!projectId) return t("missingRequiredFieldsMsg", lang);
    if (!form.selection_date || !form.area_type || !form.material_name || !form.material_code || !form.material_category || !form.approval_status) {
      return t("missingRequiredFieldsMsg", lang);
    }
    if (form.area_type === "Other" && !form.custom_area_type) return t("missingRequiredFieldsMsg", lang);
    if (form.material_category === "Other" && !form.custom_material_category) return t("missingRequiredFieldsMsg", lang);
    if (requireAttachment) {
      const atts = editingId ? attachmentsById[editingId] : null;
      if (!atts || atts.length === 0) return t("requireAttachmentForFinalMsg", lang);
    }
    return null;
  }

  function duplicateCodeExists(excludeId) {
    return rows.some((r) => r.id !== excludeId && r.material_code === form.material_code
      && (r.area_name || r.area_type) === (form.area_name || form.area_type));
  }

  async function handleSave(e, nextApprovalStatus) {
    e?.preventDefault();
    // Submitting for approval (anything but Draft) requires an attachment —
    // a brand-new row (editingId still null) can never have one yet, so
    // this correctly blocks "Submit for Approval" on first save and steers
    // the user to Save Draft -> attach a file -> submit from there instead.
    const requireAttachment = !!nextApprovalStatus && nextApprovalStatus !== "Draft";
    const msg = validate(requireAttachment);
    if (msg) { setFormMsg(msg); return; }
    if (!editingId && !replacingRow && !confirmDuplicate && duplicateCodeExists(null)) {
      setFormMsg(t("confirmDuplicateCodeMsg", lang));
      setConfirmDuplicate(true);
      return;
    }
    setSaving(true);
    setFormMsg("");
    const payload = {
      ...form,
      project_id: projectId,
      approval_status: nextApprovalStatus || form.approval_status,
      quantity: form.quantity === "" ? null : Number(form.quantity),
      rate: form.rate === "" ? null : Number(form.rate),
      estimated_amount: form.estimated_amount === "" ? null : Number(form.estimated_amount),
      responsible_designer_id: form.responsible_designer_id || null,
      created_by: profile?.id || null,
    };
    let result;
    if (replacingRow) {
      result = await replaceMaterialSelection(projectId, replacingRow, payload, profile?.id);
    } else if (editingId) {
      const patch = { ...payload };
      delete patch.project_id;
      delete patch.created_by;
      result = await updateMaterialSelection(projectId, editingId, patch, profile?.id);
    } else {
      result = await createMaterialSelection(payload);
    }
    setSaving(false);
    if (result.error) { setFormMsg(result.error.message || t("loadErrorRetry", lang)); return; }
    setShowForm(false);
    setEditingId(result.data.id);
    resetFormKeepEditing(result.data.id);
    loadSelections();
  }

  function resetFormKeepEditing(id) {
    setForm(emptyForm);
    setReplacingRow(null);
    setEditingId(null);
    setExpandedId(id);
    setConfirmDuplicate(false);
  }

  async function handleMarkFinal(row) {
    setRowMsg((m) => ({ ...m, [row.id]: "" }));
    if (row.approval_status === "Rejected") {
      setRowMsg((m) => ({ ...m, [row.id]: t("rejectedCannotBeFinalMsg", lang) }));
      return;
    }
    const atts = attachmentsById[row.id] || (await loadAttachmentsFor(row.id));
    if (!atts || atts.length === 0) {
      setRowMsg((m) => ({ ...m, [row.id]: t("requireAttachmentForFinalMsg", lang) }));
      return;
    }
    const { error: err } = await markMaterialSelectionFinal(projectId, row.id, row.approval_status, profile?.id);
    if (!err) loadSelections();
    else setRowMsg((m) => ({ ...m, [row.id]: err.message }));
  }

  async function handleDecide(row, decision) {
    const { error: err } = await decideMaterialSelectionApproval(projectId, row.id, decision, profile?.id);
    if (!err) loadSelections();
  }

  async function handleArchive(row) {
    if (confirmArchiveId !== row.id) { setConfirmArchiveId(row.id); return; }
    setConfirmArchiveId(null);
    const { error: err } = await archiveMaterialSelection(projectId, row.id, profile?.id);
    if (!err) loadSelections();
  }

  const loadAttachmentsFor = useCallback(async (selectionId) => {
    const { data } = await listMaterialSelectionAttachments(selectionId);
    setAttachmentsById((prev) => ({ ...prev, [selectionId]: data || [] }));
    return data || [];
  }, []);

  function toggleExpand(row) {
    if (expandedId === row.id) { setExpandedId(null); return; }
    setExpandedId(row.id);
    if (!attachmentsById[row.id]) loadAttachmentsFor(row.id);
  }

  async function handleUpload(selectionId, file, fileCategory) {
    if (!file) return;
    setUploadBusyId(selectionId);
    const { error: err } = await uploadMaterialSelectionAttachment({
      projectId, materialSelectionId: selectionId, file, fileCategory, uploadedBy: profile?.id,
    });
    setUploadBusyId(null);
    if (!err) loadAttachmentsFor(selectionId);
  }

  async function handleDeleteAttachment(selectionId, attachmentId) {
    if (confirmDeleteAttId !== attachmentId) { setConfirmDeleteAttId(attachmentId); return; }
    setConfirmDeleteAttId(null);
    const { error: err } = await deleteMaterialSelectionAttachment(projectId, attachmentId);
    if (!err) loadAttachmentsFor(selectionId);
  }

  async function openFile(storagePath) {
    const { url } = await getAttachmentUrl(storagePath);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  // History for one selection chain — walked in-memory (backward via
  // previous_selection_id, forward by scanning for a row that points back
  // at this one) since the whole project's rows are already loaded; no
  // recursive SQL needed for this project-scale dataset.
  function selectionHistory(row) {
    const chain = [row];
    let cur = row;
    while (cur.previous_selection_id) {
      const prev = rows.find((r) => r.id === cur.previous_selection_id);
      if (!prev) break;
      chain.unshift(prev);
      cur = prev;
    }
    let next = rows.find((r) => r.previous_selection_id === row.id);
    while (next) {
      chain.push(next);
      next = rows.find((r) => r.previous_selection_id === next.id);
    }
    return chain;
  }

  const filtered = useMemo(() => rows.filter((r) => {
    if (filterCategory && r.material_category !== filterCategory) return false;
    if (filterStatus && r.approval_status !== filterStatus) return false;
    if (filterFinal === "final" && !r.is_final) return false;
    if (filterFinal === "not_final" && r.is_final) return false;
    if (filterDesigner && r.responsible_designer_id !== filterDesigner) return false;
    if (q) {
      const needle = q.toLowerCase();
      const hay = [r.material_name, r.material_code, r.area_name, r.area_type, r.brand, r.vendor_name].join(" ").toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  }), [rows, filterCategory, filterStatus, filterFinal, filterDesigner, q]);

  const grouped = useMemo(() => {
    const byArea = {};
    filtered.forEach((r) => {
      const areaKey = r.area_name || (r.area_type === "Other" ? r.custom_area_type : r.area_type) || "—";
      byArea[areaKey] = byArea[areaKey] || {};
      const catKey = r.material_category === "Other" ? r.custom_material_category : r.material_category;
      byArea[areaKey][catKey] = byArea[areaKey][catKey] || [];
      byArea[areaKey][catKey].push(r);
    });
    return byArea;
  }, [filtered]);

  if (loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 60 }} /><div className="skeleton-block" style={{ height: 300 }} /></div>;
  if (error) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">{t("loadErrorRetry", lang)}</div>
        <button className="btn btn-primary" onClick={load}>{t("retry", lang)}</button>
      </div>
    );
  }

  return (
    <div className="dept-dashboard material-selection">
      <div className="dept-header card no-print">
        <div className="dept-header-icon" aria-hidden="true">🧩</div>
        <div className="dept-header-text">
          <h1>{t("materialSelectionTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card no-print">
        <div className="field">
          <label>{t("projectCodeLabel", lang)}</label>
          {lockedProjectId ? (
            <div className="sub" style={{ fontWeight: 700, marginTop: 4 }}>{currentProject ? `${currentProject.project_code} — ${currentProject.customer}` : "—"}</div>
          ) : (
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
            </select>
          )}
        </div>
        {currentProject && (
          <div className="dept-meta-grid" style={{ marginTop: 10 }}>
            <div className="card dept-meta-tile"><div className="label">{t("clientNameLabel", lang)}</div><div className="value">{currentProject.customer}</div></div>
            <div className="card dept-meta-tile"><div className="label">{t("siteAddressLabel", lang)}</div><div className="value">{currentProject.location || "—"}</div></div>
            <div className="card dept-meta-tile"><div className="label">{t("interiorRole_pm", lang)}</div><div className="value">{personName(currentProject.project_manager_id)}</div></div>
            <div className="card dept-meta-tile"><div className="label">{t("stageLabel", lang)}</div><div className="value">{currentProject.stage}</div></div>
          </div>
        )}
      </div>

      <div className="card no-print">
        <div className="btn-row" style={{ marginTop: 0, flexWrap: "wrap" }}>
          <button className="btn btn-primary" disabled={!projectId} onClick={() => { resetForm(); setShowForm((s) => !s); }}>
            {showForm ? t("cancel", lang) : t("addMaterialSelectionAction", lang)}
          </button>
          <button className="btn btn-outline" disabled={!projectId} onClick={() => setShowSheet((s) => !s)}>
            {t("viewSelectionSheetAction", lang)}
          </button>
        </div>

        {showForm && (
          <form onSubmit={handleSave} className="form-grid" style={{ marginTop: 12 }}>
            {replacingRow && <div className="msg info full">{t("replaceSelectionAction", lang)}: {replacingRow.material_name} ({replacingRow.material_code})</div>}

            <div className="field"><label>{t("selectionDateLabel", lang)} *</label>
              <input type="date" value={form.selection_date} onChange={(e) => setForm((f) => ({ ...f, selection_date: e.target.value }))} required /></div>
            <div className="field"><label>{t("selectedByLabel", lang)}</label>
              <select value={form.selected_by_type} onChange={(e) => setForm((f) => ({ ...f, selected_by_type: e.target.value }))}>
                {SELECTED_BY_TYPES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select></div>
            <div className="field"><label>{t("selectedByNameLabel", lang)}</label>
              <input value={form.selected_by_name} onChange={(e) => setForm((f) => ({ ...f, selected_by_name: e.target.value }))} /></div>
            <div className="field"><label>{t("responsibleDesignerLabel", lang)}</label>
              <select value={form.responsible_designer_id} onChange={(e) => setForm((f) => ({ ...f, responsible_designer_id: e.target.value }))}>
                <option value="">—</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></div>

            <div className="field"><label>{t("areaTypeLabel", lang)} *</label>
              <select value={form.area_type} onChange={(e) => setForm((f) => ({ ...f, area_type: e.target.value }))} required>
                {AREA_TYPES.map(([en, gu]) => <option key={en} value={en}>{lang === "gu" ? gu : en}</option>)}
              </select></div>
            {form.area_type === "Other" && (
              <div className="field"><label>{t("customAreaTypeLabel", lang)} *</label>
                <input value={form.custom_area_type} onChange={(e) => setForm((f) => ({ ...f, custom_area_type: e.target.value }))} required /></div>
            )}
            <div className="field"><label>{t("areaNameLabel", lang)}</label>
              <input value={form.area_name} onChange={(e) => setForm((f) => ({ ...f, area_name: e.target.value }))} /></div>
            <div className="field"><label>{t("floorLabel", lang)}</label>
              <input value={form.floor} onChange={(e) => setForm((f) => ({ ...f, floor: e.target.value }))} /></div>
            <div className="field"><label>{t("roomNumberLabel", lang)}</label>
              <input value={form.room_number} onChange={(e) => setForm((f) => ({ ...f, room_number: e.target.value }))} /></div>

            <div className="field"><label>{t("materialNameLabel", lang)} *</label>
              <input value={form.material_name} onChange={(e) => setForm((f) => ({ ...f, material_name: e.target.value }))} required /></div>
            <div className="field"><label>{t("materialCodeLabel", lang)} *</label>
              <input value={form.material_code} onChange={(e) => setForm((f) => ({ ...f, material_code: e.target.value }))} required /></div>
            <div className="field"><label>{t("materialCategoryLabel", lang)} *</label>
              <select value={form.material_category} onChange={(e) => setForm((f) => ({ ...f, material_category: e.target.value }))} required>
                {MATERIAL_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select></div>
            {form.material_category === "Other" && (
              <div className="field"><label>{t("customMaterialCategoryLabel", lang)} *</label>
                <input value={form.custom_material_category} onChange={(e) => setForm((f) => ({ ...f, custom_material_category: e.target.value }))} required /></div>
            )}
            <div className="field"><label>{t("materialTypeLabel", lang)}</label>
              <input value={form.material_type} onChange={(e) => setForm((f) => ({ ...f, material_type: e.target.value }))} /></div>
            <div className="field"><label>{t("brandLabel", lang)}</label>
              <input value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} /></div>
            <div className="field"><label>{t("vendorLabel", lang)}</label>
              <input value={form.vendor_name} onChange={(e) => setForm((f) => ({ ...f, vendor_name: e.target.value }))} /></div>
            <div className="field"><label>{t("colourLabel", lang)}</label>
              <input value={form.colour} onChange={(e) => setForm((f) => ({ ...f, colour: e.target.value }))} /></div>
            <div className="field"><label>{t("finishLabel", lang)}</label>
              <input value={form.finish} onChange={(e) => setForm((f) => ({ ...f, finish: e.target.value }))} /></div>
            <div className="field"><label>{t("textureLabel", lang)}</label>
              <input value={form.texture} onChange={(e) => setForm((f) => ({ ...f, texture: e.target.value }))} /></div>
            <div className="field"><label>{t("dimensionsLabel", lang)}</label>
              <input value={form.dimensions} onChange={(e) => setForm((f) => ({ ...f, dimensions: e.target.value }))} /></div>
            <div className="field"><label>{t("thicknessLabel", lang)}</label>
              <input value={form.thickness} onChange={(e) => setForm((f) => ({ ...f, thickness: e.target.value }))} /></div>
            <div className="field"><label>{t("unitLabel", lang)}</label>
              <input value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} /></div>
            <div className="field"><label>{t("quantityLabel", lang)}</label>
              <input type="number" min="0" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} /></div>
            <div className="field"><label>{t("rateLabel", lang)}</label>
              <input type="number" min="0" value={form.rate} onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))} /></div>
            <div className="field"><label>{t("estimatedAmountLabel", lang)}</label>
              <input type="number" min="0" value={form.estimated_amount} onChange={(e) => setForm((f) => ({ ...f, estimated_amount: e.target.value }))} /></div>
            <div className="field full"><label>{t("usageApplicationLabel", lang)}</label>
              <input value={form.usage_application} onChange={(e) => setForm((f) => ({ ...f, usage_application: e.target.value }))} /></div>
            <div className="field full"><label>{t("descriptionLabel", lang)}</label>
              <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></div>
            <div className="field full"><label>{t("remarksLabel", lang)}</label>
              <textarea value={form.remarks} onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))} /></div>

            <div className="field"><label>{t("approvalStatusLabel", lang)} *</label>
              <select value={form.approval_status} onChange={(e) => setForm((f) => ({ ...f, approval_status: e.target.value }))} required>
                {APPROVAL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select></div>
            <div className="field full"><label>{t("clientRemarksLabel", lang)}</label>
              <textarea value={form.client_remarks} onChange={(e) => setForm((f) => ({ ...f, client_remarks: e.target.value }))} /></div>
            <div className="field full"><label>{t("internalRemarksLabel", lang)}</label>
              <textarea value={form.internal_remarks} onChange={(e) => setForm((f) => ({ ...f, internal_remarks: e.target.value }))} /></div>
            {replacingRow && (
              <div className="field full"><label>{t("changeReasonLabel", lang)}</label>
                <textarea value={form.change_reason || ""} onChange={(e) => setForm((f) => ({ ...f, change_reason: e.target.value }))} /></div>
            )}
            <div className="field full"><label>{t("designLockNoteLabel", lang)}</label>
              <input value={form.design_lock_note} onChange={(e) => setForm((f) => ({ ...f, design_lock_note: e.target.value }))} /></div>

            {formMsg && <div className="msg error full">{formMsg}</div>}
            <div className="field full btn-row">
              <button className="btn btn-outline" type="button" disabled={saving} onClick={(e) => handleSave(e, "Draft")}>{t("saveDraftAction", lang)}</button>
              <button className="btn btn-primary" type="button" disabled={saving} onClick={(e) => handleSave(e, "Submitted to Client")}>{t("submitForApprovalAction", lang)}</button>
            </div>
          </form>
        )}
      </div>

      {showSheet ? (
        <MaterialSelectionSheet
          lang={lang} project={currentProject} rows={filtered} grouping={sheetGrouping} setGrouping={setSheetGrouping}
          onClose={() => setShowSheet(false)} personName={personName}
        />
      ) : (
        <>
          <div className="card no-print">
            <div className="filter-bar">
              <input placeholder={t("searchLabel", lang)} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "auto", minWidth: 180, flex: 1 }} />
              <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
                <option value="">{t("materialCategoryLabel", lang)}</option>
                {MATERIAL_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                <option value="">{t("approvalStatusLabel", lang)}</option>
                {APPROVAL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select value={filterFinal} onChange={(e) => setFilterFinal(e.target.value)}>
                <option value="">{t("finalSelectionLabel", lang)}</option>
                <option value="final">{t("completeStatusLabel", lang)}</option>
                <option value="not_final">{t("notStartedLabel", lang)}</option>
              </select>
              <select value={filterDesigner} onChange={(e) => setFilterDesigner(e.target.value)}>
                <option value="">{t("responsibleDesignerLabel", lang)}</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>

          {Object.keys(grouped).length === 0 && <div className="card"><div className="msg info">{t("noRecordsYet", lang)}</div></div>}

          {Object.entries(grouped).map(([areaKey, byCategory]) => (
            <div className="card" key={areaKey}>
              <h2>{areaKey}</h2>
              {Object.entries(byCategory).map(([catKey, items]) => (
                <div key={catKey} style={{ marginTop: 10 }}>
                  <div className="sub" style={{ fontWeight: 700 }}>{catKey}</div>
                  {items.map((row) => (
                    <MaterialSelectionRow
                      key={row.id} row={row} lang={lang} personName={personName}
                      expanded={expandedId === row.id} onToggle={() => toggleExpand(row)}
                      attachments={attachmentsById[row.id]} uploadBusy={uploadBusyId === row.id}
                      onEdit={() => startEdit(row)} onReplace={() => startReplace(row)} onDuplicate={() => startDuplicate(row)}
                      onMarkFinal={() => handleMarkFinal(row)} onDecide={(d) => handleDecide(row, d)}
                      onArchive={() => handleArchive(row)} onUpload={(file, cat) => handleUpload(row.id, file, cat)}
                      onDeleteAttachment={(id) => handleDeleteAttachment(row.id, id)} onOpenFile={openFile}
                      history={selectionHistory(row)} isElevated={isElevated}
                      rowMsg={rowMsg[row.id]} confirmArchive={confirmArchiveId === row.id}
                      confirmDeleteAttId={confirmDeleteAttId} onCancelArchive={() => setConfirmArchiveId(null)}
                    />
                  ))}
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function MaterialSelectionRow({
  row, lang, personName, expanded, onToggle, attachments, uploadBusy, onEdit, onReplace, onDuplicate,
  onMarkFinal, onDecide, onArchive, onUpload, onDeleteAttachment, onOpenFile, history, isElevated,
  rowMsg, confirmArchive, confirmDeleteAttId, onCancelArchive,
}) {
  const [fileCategory, setFileCategory] = useState("Material Photo");
  const [dragOver, setDragOver] = useState(false);

  function handleFiles(files) {
    if (files?.[0]) onUpload(files[0], fileCategory);
  }

  return (
    <div className="task-meta" style={{ display: "block", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6, cursor: "pointer" }} onClick={onToggle}>
        <span style={{ fontWeight: 700 }}>{row.material_name} <span className="sub" style={{ fontWeight: 400 }}>({row.material_code})</span></span>
        <span className="sub">{row.brand || "—"}</span>
        <span className="sub">{row.selection_date}</span>
        {row.is_final && <span className="badge VERIFIED">{t("finalSelectionLabel", lang)}</span>}
        <span className={`badge ${STATUS_BADGE[row.approval_status] || "CLOSED"}`}>{row.approval_status}</span>
        {row.revision_number > 1 && <span className="sub">{t("revisionLabel", lang)} {row.revision_number}</span>}
      </div>

      {expanded && (
        <div style={{ marginTop: 10 }}>
          <div className="sub">{t("responsibleDesignerLabel", lang)}: {personName(row.responsible_designer_id)} · {t("selectedByLabel", lang)}: {row.selected_by_type} {row.selected_by_name ? `(${row.selected_by_name})` : ""}</div>
          {row.colour && <div className="sub">{t("colourLabel", lang)}: {row.colour} · {t("finishLabel", lang)}: {row.finish || "—"} · {t("textureLabel", lang)}: {row.texture || "—"}</div>}
          {row.dimensions && <div className="sub">{t("dimensionsLabel", lang)}: {row.dimensions} · {t("thicknessLabel", lang)}: {row.thickness || "—"}</div>}
          {row.rate != null && <div className="sub">{t("rateLabel", lang)}: {formatCurrency(row.rate)} · {t("estimatedAmountLabel", lang)}: {formatCurrency(row.estimated_amount)}</div>}
          {row.usage_application && <div className="sub">{t("usageApplicationLabel", lang)}: {row.usage_application}</div>}
          {row.description && <div className="sub">{t("descriptionLabel", lang)}: {row.description}</div>}
          {row.remarks && <div className="sub">{t("remarksLabel", lang)}: {row.remarks}</div>}
          {row.client_remarks && <div className="sub">{t("clientRemarksLabel", lang)}: {row.client_remarks}</div>}
          {row.internal_remarks && <div className="sub">{t("internalRemarksLabel", lang)}: {row.internal_remarks}</div>}
          {row.approved_by && <div className="sub">{t("approvedByLabel", lang)}: {personName(row.approved_by)} · {row.client_approval_date || "—"}</div>}
          {row.change_reason && <div className="sub">{t("changeReasonLabel", lang)}: {row.change_reason}</div>}

          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn btn-outline" onClick={onEdit}>{t("editSelectionAction", lang)}</button>
            <button className="btn btn-outline" onClick={onReplace}>{t("replaceSelectionAction", lang)}</button>
            <button className="btn btn-outline" onClick={onDuplicate}>{t("duplicateForRoomAction", lang)}</button>
            {!row.is_final && <button className="btn btn-outline" onClick={onMarkFinal}>{t("markFinalAction", lang)}</button>}
            {row.approval_status === "Submitted to Client" || row.approval_status === "Client Review Pending" ? (
              <>
                <button className="btn btn-primary" onClick={() => onDecide("Approved")}>{t("approveLabel", lang)}</button>
                <button className="btn btn-outline" onClick={() => onDecide("Rejected")}>{t("rejectLabel", lang)}</button>
              </>
            ) : null}
            {isElevated && !confirmArchive && <button className="btn btn-outline" onClick={onArchive}>{t("deleteTask", lang)}</button>}
            {isElevated && confirmArchive && (
              <span className="btn-row" style={{ marginTop: 0 }}>
                <span className="sub">{t("areYouSure", lang)}</span>
                <button className="btn btn-danger" onClick={onArchive}>{t("confirm", lang)}</button>
                <button className="btn btn-outline" onClick={onCancelArchive}>{t("cancel", lang)}</button>
              </span>
            )}
          </div>
          {rowMsg && <div className="msg error" style={{ marginTop: 8 }}>{rowMsg}</div>}

          {history.length > 1 && (
            <div style={{ marginTop: 8 }}>
              <div className="sub" style={{ fontWeight: 700 }}>{t("viewHistoryAction", lang)}</div>
              {history.map((h) => (
                <div key={h.id} className="task-meta" style={{ padding: "4px 0" }}>
                  <span className="sub">{t("revisionLabel", lang)} {h.revision_number} — {h.material_name} ({h.material_code})</span>
                  <span className={`badge ${STATUS_BADGE[h.approval_status] || "CLOSED"}`}>{h.approval_status}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <div className="sub" style={{ fontWeight: 700 }}>{t("tabFiles", lang)}</div>
            {(attachments || []).length === 0 && <div className="msg info" style={{ marginTop: 4 }}>{t("noFileAttachedLabel", lang)}</div>}
            {(attachments || []).map((a) => (
              <div key={a.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
                <span>{a.original_file_name || a.file_name}</span>
                <span className="sub">{a.file_category}</span>
                <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => onOpenFile(a.storage_path)}>{t("download", lang)}</button>
                {isElevated && confirmDeleteAttId !== a.id && (
                  <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => onDeleteAttachment(a.id)}>{t("deleteTask", lang)}</button>
                )}
                {isElevated && confirmDeleteAttId === a.id && (
                  <span className="btn-row" style={{ marginTop: 0 }}>
                    <span className="sub">{t("areYouSure", lang)}</span>
                    <button className="btn btn-danger" style={{ marginTop: 0, width: "auto" }} onClick={() => onDeleteAttachment(a.id)}>{t("confirm", lang)}</button>
                  </span>
                )}
              </div>
            ))}

            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
              style={{
                marginTop: 8, border: `2px dashed ${dragOver ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 8, padding: 12, textAlign: "center",
              }}
            >
              <select value={fileCategory} onChange={(e) => setFileCategory(e.target.value)} style={{ marginBottom: 8 }}>
                {FILE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <label className="file-input-label">
                {uploadBusy ? t("uploading", lang) : t("dropFilesHereLabel", lang)}
                <input type="file" accept="image/*,application/pdf,video/*,audio/*" style={{ display: "none" }} disabled={uploadBusy}
                  onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MaterialSelectionSheet({ lang, project, rows, grouping, setGrouping, onClose, personName }) {
  const visible = useMemo(() => {
    if (grouping === "final") return rows.filter((r) => r.is_final);
    return rows;
  }, [rows, grouping]);

  const groups = useMemo(() => {
    const g = {};
    visible.forEach((r) => {
      const k = grouping === "category" ? (r.material_category === "Other" ? r.custom_material_category : r.material_category)
        : (r.area_name || (r.area_type === "Other" ? r.custom_area_type : r.area_type));
      g[k || "—"] = g[k || "—"] || [];
      g[k || "—"].push(r);
    });
    return g;
  }, [visible, grouping]);

  return (
    <div className="card material-selection-sheet">
      <div className="btn-row no-print" style={{ marginTop: 0, flexWrap: "wrap" }}>
        <select value={grouping} onChange={(e) => setGrouping(e.target.value)}>
          <option value="room">{t("groupByRoomLabel", lang)}</option>
          <option value="category">{t("groupByCategoryLabel", lang)}</option>
          <option value="final">{t("finalOnlyLabel", lang)}</option>
          <option value="all">{t("allRevisionsLabel", lang)}</option>
        </select>
        <button className="btn btn-outline" onClick={() => window.print()}>{t("printReportAction", lang)}</button>
        <button className="btn btn-outline" onClick={() => window.print()}>{t("downloadSheetAction", lang)}</button>
        <button className="btn btn-outline" onClick={onClose}>{t("close", lang)}</button>
      </div>

      <div style={{ marginTop: 14 }}>
        <h1 style={{ marginBottom: 0 }}>Mood of Wood</h1>
        <h2 style={{ marginTop: 4 }}>{t("selectionSheetTitle", lang)}</h2>
        <div className="sub">{project?.project_code} — {project?.customer}</div>
        <div className="sub">{t("siteAddressLabel", lang)}: {project?.location || "—"}</div>
      </div>

      {Object.entries(groups).map(([key, items]) => (
        <div key={key} style={{ marginTop: 16 }}>
          <h3>{key}</h3>
          {items.map((r) => (
            <div key={r.id} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
              <div style={{ fontWeight: 700 }}>{r.material_name} ({r.material_code}) — {r.material_category === "Other" ? r.custom_material_category : r.material_category}</div>
              <div className="sub">{t("brandLabel", lang)}: {r.brand || "—"} · {t("colourLabel", lang)}: {r.colour || "—"} · {t("finishLabel", lang)}: {r.finish || "—"}</div>
              <div className="sub">{t("dimensionsLabel", lang)}/{t("thicknessLabel", lang)}: {r.dimensions || "—"} / {r.thickness || "—"} · {t("usageApplicationLabel", lang)}: {r.usage_application || "—"}</div>
              <div className="sub">{t("remarksLabel", lang)}: {r.remarks || "—"}</div>
              <div className="sub">{t("approvalStatusLabel", lang)}: {r.approval_status} {r.client_approval_date ? `· ${r.client_approval_date}` : ""} {r.approved_by ? `· ${personName(r.approved_by)}` : ""}</div>
            </div>
          ))}
        </div>
      ))}

      <div style={{ marginTop: 24, display: "flex", justifyContent: "space-between" }}>
        <div>{t("clientSignatureLabel", lang)}: ______________________</div>
        <div>{t("designerSignatureLabel", lang)}: ______________________</div>
      </div>
    </div>
  );
}
