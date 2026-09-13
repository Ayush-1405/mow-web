import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import {
  listProjects, listInteriorPeople, listAttachments, listProjectChanges, getAttachmentUrl,
  listWorkingDrawingAreas, createWorkingDrawingArea, archiveWorkingDrawingArea,
  getDesignBrief, upsertDesignBrief,
  listDesignVersions, createDesignVersion, createDesignRevision, updateDesignVersionStatus,
  listDesignChangeRequests, createDesignChangeRequest, computeDesignChangeCounts,
  listDesignApprovals, decideDesignApproval,
  getActiveDesignLock, createDesignLock,
  listWorkingDrawings, createWorkingDrawing, updateWorkingDrawing,
  listDrawingVersions, createDrawingVersion, issueDrawingVersion,
  listChecklistItems, listChecklistResults, listChecklistResultHistory, upsertChecklistResult,
  listDrawingIssues, createDrawingIssue, acknowledgeDrawingIssue,
  uploadWorkingDrawingAttachment, listWorkingDrawingAttachments, listWorkingDrawingAttachmentsForProject,
  deleteWorkingDrawingAttachment, createWorkingDrawingTask, listMaterialSelections,
  listMaterialSelectionAttachmentsForProject, listCurrentDesignVersionsForProject,
} from "../../lib/interiorApi";
import { AREA_TYPES } from "./InteriorMaterialSelection.jsx";
import InteriorMaterialSelection from "./InteriorMaterialSelection.jsx";
import InteriorActivityHistory from "./InteriorActivityHistory.jsx";

// ---------------------------------------------------------------------
// Fixed vocabularies. Area types reuse Material Selection's own exported
// list (same bilingual pairs). Everything below was only given in English
// in the spec (no Gujarati pairs supplied) — shown as-is, same treatment
// this app already gives Material Categories/Approval Statuses elsewhere,
// rather than inventing an unverified translation.
// ---------------------------------------------------------------------
const DESIGN_STAGES = [
  "Concept Design", "Initial 2D", "Initial 3D", "Revised 2D", "Revised 3D",
  "Detailed Design", "Pre-Lock Design", "Final Design", "Working Drawing", "Issued for Execution",
];
const VERSION_STATUSES = [
  "Draft", "In Progress", "Submitted for Internal Review", "Internal Changes Required",
  "Submitted to Client", "Client Changes Required", "Resubmitted",
  "Approved", "Approved with Conditions", "Rejected", "Locked", "Superseded",
];
const APPROVAL_METHODS = ["Signed approval", "Email", "WhatsApp", "Meeting confirmation", "Portal approval", "Other"];
const CHANGE_TYPES = ["Client", "Internal", "Site Condition", "Management"];
const DRAWING_TYPES = [
  "Layout Plan", "Furniture Layout", "Floor Plan", "Ceiling Plan", "Electrical Plan", "Plumbing Plan",
  "Elevation", "Section", "Detailed Drawing", "Joinery Drawing", "Kitchen Drawing", "Wardrobe Drawing",
  "TV-Unit Drawing", "Bed Drawing", "False-Ceiling Drawing", "Flooring Drawing", "Loose-Furniture Drawing",
  "Hardware Detail", "Material Detail", "Installation Drawing", "Other",
];
const DRAWING_STATUSES = [
  "Draft", "Under Preparation", "Internal Review", "Correction Required", "Approved",
  "Approved with Comments", "Final", "Issued for Execution", "Revised", "Superseded", "As-Built",
];
const CHECKLIST_STATUSES = ["Not Started", "In Progress", "Completed", "Correction Required", "Not Applicable"];
const ATTACHMENT_CATEGORIES = [
  "Client Reference", "Site Photo", "Measurement Sheet", "2D Design", "3D Render", "PDF", "Image",
  "CAD File", "Video", "Reference File", "Client-Marked Drawing", "Voice Note", "Approval Proof",
  "Drawing File", "Source/CAD File", "Checklist Proof", "Issue Package", "Other",
];

const STAGE_BADGE = {
  "Design Brief": "ASSIGNED", "Design Development": "ASSIGNED", "Design Approval": "ACCEPTED",
  "Material Approval": "ACCEPTED", "Design Lock": "IN_PROGRESS", "Working Drawings": "IN_PROGRESS",
  "Internal Checking": "COMPLETED", "Final Approval": "COMPLETED", "Issued for Execution": "VERIFIED",
};
const APPROVAL_BADGE = {
  Draft: "CLOSED", "In Progress": "ASSIGNED", "Submitted for Internal Review": "ASSIGNED",
  "Internal Changes Required": "REVISION", "Submitted to Client": "ACCEPTED", "Client Changes Required": "REVISION",
  Resubmitted: "ASSIGNED", Approved: "VERIFIED", "Approved with Conditions": "VERIFIED",
  Rejected: "RETURNED", Locked: "COMPLETED", Superseded: "CLOSED",
};
const DRAWING_BADGE = {
  Draft: "CLOSED", "Under Preparation": "ASSIGNED", "Internal Review": "ASSIGNED", "Correction Required": "REVISION",
  Approved: "VERIFIED", "Approved with Comments": "VERIFIED", Final: "COMPLETED",
  "Issued for Execution": "VERIFIED", Revised: "ASSIGNED", Superseded: "CLOSED", "As-Built": "COMPLETED",
};
const CHECKLIST_BADGE = {
  "Not Started": "CLOSED", "In Progress": "ASSIGNED", Completed: "VERIFIED",
  "Correction Required": "REVISION", "Not Applicable": "CLOSED",
};

const TABS = [
  ["brief", "Design Brief", "ડિઝાઇન બ્રીફ"],
  ["development", "Design Development", "ડિઝાઇન ડેવલપમેન્ટ"],
  ["revisions", "Design Revisions", "ડિઝાઇન ફેરફાર"],
  ["approval", "Design Approval", "ડિઝાઇન મંજૂરી"],
  ["material", "Material Selection & Approval", "મટિરિયલ પસંદગી અને મંજૂરી"],
  ["lock", "Design Lock", "ડિઝાઇન લોક"],
  ["drawings", "Working Drawings", "વર્કિંગ ડ્રોઇંગ્સ"],
  ["checklist", "Working Drawing Checklist", "વર્કિંગ ડ્રોઇંગ ચેકલિસ્ટ"],
  ["issue", "Final Issue for Execution", "કામ માટે અંતિમ મોકલવું"],
  ["history", "Revision & Change History", "ફેરફાર ઇતિહાસ"],
  ["files", "All Attachments", "બધી ફાઇલો"],
  ["activity", "Complete Activity History", "સંપૂર્ણ પ્રવૃત્તિ ઇતિહાસ"],
];

function personName(people, id) {
  return people.find((p) => p.id === id)?.name || "—";
}

// Shared drag-and-drop uploader for every sub-module's attachments —
// reuses the exact pattern already built for Material Selection
// (drop zone + category select + hidden file input), just parameterized
// by an onUpload(file, category) callback so it can point at any module.
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

// Generic "Create Task" quick-action (spec §17) — writes area_id/
// related_module/related_record_id/priority so the task is traceable back
// to the pending state that spawned it. Wired into the handful of panels
// where a pending state naturally needs one (Design Approval, Design Lock,
// Checklist correction, Final Issue) rather than as a separate 10-button
// menu, since createWorkingDrawingTask() already covers every module via
// its relatedModule argument.
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

export function ViewDownloadButton({ lang, storagePath }) {
  if (!storagePath) return <span className="sub">{t("noFileAttachedLabel", lang)}</span>;
  return (
    <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }}
      onClick={async () => { const { url } = await getAttachmentUrl(storagePath); if (url) window.open(url, "_blank", "noopener,noreferrer"); }}>
      {t("download", lang)}
    </button>
  );
}

// =======================================================================
// Main screen
// =======================================================================
export default function InteriorWorkingDrawings({ lang, staffProfile, lockedProjectId: lockedProjectIdProp }) {
  const { projectId: routeProjectId } = useParams();
  const lockedProjectId = lockedProjectIdProp || routeProjectId;
  const profile = useInteriorProfile();
  const isElevated = !!staffProfile?.isManagement || !!staffProfile?.isSuperAdmin || !!staffProfile?.isDeptHead;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [people, setPeople] = useState([]);
  const [projectId, setProjectId] = useState("");

  const [areas, setAreas] = useState([]);
  const [areaId, setAreaId] = useState("");
  const [showAreaForm, setShowAreaForm] = useState(false);
  const [areaForm, setAreaForm] = useState({ area_type: "Kitchen", custom_area_type: "", area_name: "", floor: "", assigned_designer_id: "" });
  const [activeTab, setActiveTab] = useState("brief");

  // Project-wide dashboard data
  const [currentVersions, setCurrentVersions] = useState([]);
  const [materialSelections, setMaterialSelections] = useState([]);
  const [legacyAttachments, setLegacyAttachments] = useState([]);
  const [legacyChanges, setLegacyChanges] = useState([]);
  const [allAreaAttachments, setAllAreaAttachments] = useState([]);
  const [allMaterialAttachments, setAllMaterialAttachments] = useState([]);

  // Area-scoped data
  const [brief, setBrief] = useState(null);
  const [versions, setVersions] = useState([]);
  const [changeRequests, setChangeRequests] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [lock, setLock] = useState(null);
  const [drawings, setDrawings] = useState([]);
  const [checklistItems, setChecklistItems] = useState([]);
  const [checklistResults, setChecklistResults] = useState([]);
  const [issues, setIssues] = useState([]);
  const [areaAttachments, setAreaAttachments] = useState([]);
  const [areaLoading, setAreaLoading] = useState(false);

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

  const loadProjectWide = useCallback(async () => {
    if (!projectId) return;
    const [areasRes, versionsRes, msRes, legacyAttRes, legacyChgRes, wdAttRes, msAttRes] = await Promise.all([
      listWorkingDrawingAreas(projectId), listCurrentDesignVersionsForProject(projectId),
      listMaterialSelections(projectId), listAttachments(projectId), listProjectChanges(projectId),
      listWorkingDrawingAttachmentsForProject(projectId), listMaterialSelectionAttachmentsForProject(projectId),
    ]);
    setAreas(areasRes.data || []);
    setCurrentVersions(versionsRes.data || []);
    setMaterialSelections(msRes.data || []);
    setLegacyAttachments((legacyAttRes.data || []).filter((a) => a.stage === "Design" || a.stage === "Drawings"));
    setLegacyChanges(legacyChgRes.data || []);
    setAllAreaAttachments(wdAttRes.data || []);
    setAllMaterialAttachments(msAttRes.data || []);
    setAreaId((cur) => cur || areasRes.data?.[0]?.id || "");
  }, [projectId]);

  useEffect(() => { loadProjectWide(); }, [loadProjectWide]);

  const loadAreaData = useCallback(async () => {
    if (!projectId || !areaId) {
      setBrief(null); setVersions([]); setChangeRequests([]); setApprovals([]); setLock(null);
      setDrawings([]); setChecklistItems([]); setChecklistResults([]); setIssues([]); setAreaAttachments([]);
      return;
    }
    setAreaLoading(true);
    const [briefRes, versionsRes, changesRes, approvalsRes, lockRes, drawingsRes, itemsRes, resultsRes, issuesRes, attRes] = await Promise.all([
      getDesignBrief(projectId, areaId), listDesignVersions(projectId, areaId), listDesignChangeRequests(projectId, areaId),
      listDesignApprovals(projectId, areaId), getActiveDesignLock(projectId, areaId), listWorkingDrawings(projectId, areaId),
      listChecklistItems(), listChecklistResults(projectId, areaId), listDrawingIssues(projectId, areaId),
      listWorkingDrawingAttachments(areaId),
    ]);
    setBrief(briefRes.data || null);
    setVersions(versionsRes.data || []);
    setChangeRequests(changesRes.data || []);
    setApprovals(approvalsRes.data || []);
    setLock(lockRes.data || null);
    setDrawings(drawingsRes.data || []);
    setChecklistItems(itemsRes.data || []);
    setChecklistResults(resultsRes.data || []);
    setIssues(issuesRes.data || []);
    setAreaAttachments(attRes.data || []);
    setAreaLoading(false);
  }, [projectId, areaId]);

  useEffect(() => { loadAreaData(); }, [loadAreaData]);

  const refreshAll = useCallback(() => { loadProjectWide(); loadAreaData(); }, [loadProjectWide, loadAreaData]);
  const refreshArea = useCallback(() => { loadAreaData(); }, [loadAreaData]);

  const currentArea = areas.find((a) => a.id === areaId) || null;
  const changeCounts = useMemo(() => computeDesignChangeCounts(changeRequests), [changeRequests]);

  const dashboard = useMemo(() => {
    const totalAreas = areas.length || 0;
    const approvedAreas = currentVersions.filter((v) => v.approval_status === "Approved" || v.approval_status === "Approved with Conditions").length;
    const pendingApprovals = currentVersions.filter((v) => ["Submitted for Internal Review", "Submitted to Client", "Resubmitted"].includes(v.approval_status)).length;
    const activeMaterials = materialSelections.filter((m) => m.status !== "REPLACED");
    const approvedMaterials = activeMaterials.filter((m) => ["Approved", "Approved with Conditions", "Final Selection Locked"].includes(m.approval_status)).length;
    const issuedAreas = areas.filter((a) => a.current_stage === "Issued for Execution").length;
    return {
      totalAreas,
      designProgressPct: totalAreas ? Math.round((approvedAreas / totalAreas) * 100) : 0,
      materialProgressPct: activeMaterials.length ? Math.round((approvedMaterials / activeMaterials.length) * 100) : 0,
      drawingProgressPct: totalAreas ? Math.round((issuedAreas / totalAreas) * 100) : 0,
      pendingApprovals,
    };
  }, [areas, currentVersions, materialSelections]);

  async function handleCreateArea(e) {
    e.preventDefault();
    const payload = {
      project_id: projectId, area_type: areaForm.area_type,
      custom_area_type: areaForm.area_type === "Other" ? areaForm.custom_area_type : null,
      area_name: areaForm.area_name || null, floor: areaForm.floor || null,
      assigned_designer_id: areaForm.assigned_designer_id || null,
    };
    const { data, error: err } = await createWorkingDrawingArea(payload, profile?.id);
    if (!err) {
      setShowAreaForm(false);
      setAreaForm({ area_type: "Kitchen", custom_area_type: "", area_name: "", floor: "", assigned_designer_id: "" });
      await loadProjectWide();
      setAreaId(data.id);
    }
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
            <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setAreaId(""); }}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
            </select>
          )}
        </div>
        {project && (
          <div className="dept-meta-grid" style={{ marginTop: 8 }}>
            <div className="card dept-meta-tile"><div className="label">{t("projectManagerLabel", lang)}</div><div className="value">{personName(people, project.project_manager_id)}</div></div>
            <div className="card dept-meta-tile"><div className="label">{t("assignedDesignerLabel", lang)}</div><div className="value">{personName(people, project.designer_id)}</div></div>
            <div className="card dept-meta-tile"><div className="label">{t("designProgressLabel", lang)}</div><div className="value">{dashboard.designProgressPct}%</div></div>
            <div className="card dept-meta-tile"><div className="label">{t("materialApprovalLabel", lang)}</div><div className="value">{dashboard.materialProgressPct}%</div></div>
            <div className="card dept-meta-tile"><div className="label">{t("workingDrawingProgressLabel", lang)}</div><div className="value">{dashboard.drawingProgressPct}%</div></div>
            <div className="card dept-meta-tile"><div className="label">{t("pendingApprovalsLabel", lang)}</div><div className="value">{dashboard.pendingApprovals}</div></div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="field">
          <label>{t("selectRoomLabel", lang)}</label>
          <div className="btn-row" style={{ flexWrap: "wrap" }}>
            {areas.map((a) => (
              <button key={a.id} className={`btn ${a.id === areaId ? "btn-primary" : "btn-outline"}`} style={{ marginTop: 0, width: "auto" }}
                onClick={() => setAreaId(a.id)}>
                {a.area_type === "Other" ? a.custom_area_type : a.area_type}{a.area_name ? ` — ${a.area_name}` : ""}
              </button>
            ))}
            <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => setShowAreaForm((s) => !s)}>+ {t("addRoomAction", lang)}</button>
          </div>
        </div>

        {showAreaForm && (
          <form onSubmit={handleCreateArea} className="form-grid" style={{ marginTop: 10 }}>
            <div className="field"><label>{t("areaTypeLabel", lang)}</label>
              <select value={areaForm.area_type} onChange={(e) => setAreaForm((f) => ({ ...f, area_type: e.target.value }))}>
                {AREA_TYPES.map(([en]) => <option key={en} value={en}>{lang === "gu" ? AREA_TYPES.find((a) => a[0] === en)[1] : en}</option>)}
              </select>
            </div>
            {areaForm.area_type === "Other" && (
              <div className="field"><label>{t("customAreaTypeLabel", lang)}</label>
                <input value={areaForm.custom_area_type} onChange={(e) => setAreaForm((f) => ({ ...f, custom_area_type: e.target.value }))} required /></div>
            )}
            <div className="field"><label>{t("areaNameLabel", lang)}</label>
              <input value={areaForm.area_name} onChange={(e) => setAreaForm((f) => ({ ...f, area_name: e.target.value }))} /></div>
            <div className="field"><label>Floor</label>
              <input value={areaForm.floor} onChange={(e) => setAreaForm((f) => ({ ...f, floor: e.target.value }))} /></div>
            <div className="field"><label>{t("assignedDesignerLabel", lang)}</label>
              <select value={areaForm.assigned_designer_id} onChange={(e) => setAreaForm((f) => ({ ...f, assigned_designer_id: e.target.value }))}>
                <option value="">—</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <button type="submit" className="btn btn-primary">{t("save", lang)}</button>
          </form>
        )}

        {currentArea && (
          <div className="task-meta" style={{ marginTop: 10, flexWrap: "wrap" }}>
            <span className={`badge ${STAGE_BADGE[currentArea.current_stage] || "CLOSED"}`}>{currentArea.current_stage}</span>
            {currentArea.assigned_designer_id && <span className="sub">{t("assignedDesignerLabel", lang)}: {personName(people, currentArea.assigned_designer_id)}</span>}
            {isElevated && (
              <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }}
                onClick={async () => { await archiveWorkingDrawingArea(projectId, currentArea.id); refreshAll(); }}>
                {t("archiveAction", lang)}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <div className="filter-bar" style={{ flexWrap: "wrap" }}>
          {TABS.map(([key, en, gu]) => (
            <button key={key} className={`btn ${activeTab === key ? "btn-primary" : "btn-outline"}`} style={{ marginTop: 0, width: "auto" }}
              onClick={() => setActiveTab(key)}>
              {lang === "gu" ? gu : en}
            </button>
          ))}
        </div>
      </div>

      {!areaId ? (
        <div className="card"><div className="msg info">{t("noRecordsForProject", lang)}</div></div>
      ) : areaLoading ? (
        <div className="skeleton-block" style={{ height: 200 }} />
      ) : (
        <>
          {activeTab === "brief" && (
            <DesignBriefPanel lang={lang} projectId={projectId} areaId={areaId} brief={brief} profile={profile} people={people}
              attachments={areaAttachments.filter((a) => a.module === "design_brief")} isElevated={isElevated} onChanged={refreshArea} />
          )}
          {activeTab === "development" && (
            <DesignDevelopmentPanel lang={lang} projectId={projectId} areaId={areaId} versions={versions} people={people}
              profile={profile} attachments={areaAttachments} isElevated={isElevated} onChanged={refreshAll} />
          )}
          {activeTab === "revisions" && (
            <DesignRevisionsPanel lang={lang} projectId={projectId} areaId={areaId} changeRequests={changeRequests}
              versions={versions} people={people} profile={profile} onChanged={refreshAll} />
          )}
          {activeTab === "approval" && (
            <DesignApprovalPanel lang={lang} projectId={projectId} areaId={areaId} currentArea={currentArea} versions={versions}
              approvals={approvals} changeCounts={changeCounts} people={people} profile={profile}
              attachments={areaAttachments} isElevated={isElevated} onChanged={refreshAll} />
          )}
          {activeTab === "material" && (
            <InteriorMaterialSelection lang={lang} staffProfile={staffProfile} lockedProjectId={projectId} />
          )}
          {activeTab === "lock" && (
            <DesignLockPanel lang={lang} projectId={projectId} areaId={areaId} currentArea={currentArea} versions={versions}
              lock={lock} materialSelections={materialSelections} checklistItems={checklistItems} checklistResults={checklistResults}
              people={people} profile={profile} isElevated={isElevated} onChanged={refreshAll} />
          )}
          {activeTab === "drawings" && (
            <WorkingDrawingsPanel lang={lang} projectId={projectId} areaId={areaId} versions={versions} drawings={drawings}
              people={people} profile={profile} attachments={areaAttachments} isElevated={isElevated} onChanged={refreshArea} />
          )}
          {activeTab === "checklist" && (
            <ChecklistPanel lang={lang} projectId={projectId} areaId={areaId} items={checklistItems} results={checklistResults}
              people={people} profile={profile} onChanged={refreshArea} />
          )}
          {activeTab === "issue" && (
            <FinalIssuePanel lang={lang} projectId={projectId} areaId={areaId} drawings={drawings} issues={issues}
              lock={lock} checklistItems={checklistItems} checklistResults={checklistResults} people={people}
              profile={profile} currentArea={currentArea} onChanged={refreshArea} />
          )}
          {activeTab === "history" && (
            <RevisionHistoryPanel lang={lang} versions={versions} changeRequests={changeRequests}
              legacyAttachments={legacyAttachments} legacyChanges={legacyChanges} people={people} />
          )}
          {activeTab === "files" && (
            <AllAttachmentsPanel lang={lang} areaAttachments={allAreaAttachments} materialAttachments={allMaterialAttachments}
              legacyAttachments={legacyAttachments} people={people} />
          )}
          {activeTab === "activity" && (
            <InteriorActivityHistory lang={lang} projectId={projectId} isElevated={isElevated} />
          )}
        </>
      )}
    </div>
  );
}

// =======================================================================
// Design Brief
// =======================================================================
function DesignBriefPanel({ lang, projectId, areaId, brief, profile, people, attachments, isElevated, onChanged }) {
  const [form, setForm] = useState(brief || {});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  useEffect(() => { setForm(brief || {}); }, [brief]);

  const fields = [
    ["client_requirements", "Client requirements"], ["functional_requirements", "Functional requirements"],
    ["style_theme", "Style/theme"], ["colour_preference", "Colour preference"],
    ["storage_requirements", "Storage requirements"], ["appliance_details", "Appliance details"],
    ["site_measurements", "Site measurements"], ["budget_reference", "Budget reference"],
    ["special_requirements", "Special requirements"], ["designer_notes", "Designer notes"],
  ];

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true); setMsg(t("saving", lang));
    const { error: err } = await upsertDesignBrief(projectId, areaId, form, profile?.id);
    setSaving(false);
    setMsg(err ? t("errorSaving", lang) : t("saved", lang));
    if (!err) onChanged();
  }

  async function handleUpload(file, category) {
    setUploadBusy(true);
    await uploadWorkingDrawingAttachment({ projectId, areaId, module: "design_brief", file, fileCategory: category, uploadedBy: profile?.id });
    setUploadBusy(false);
    onChanged();
  }

  async function handleDelete(id) {
    if (confirmDeleteId !== id) { setConfirmDeleteId(id); return; }
    setConfirmDeleteId(null);
    await deleteWorkingDrawingAttachment(projectId, id);
    onChanged();
  }

  return (
    <div className="card">
      <h2>Design Brief</h2>
      <form onSubmit={handleSave} className="form-grid">
        {fields.map(([key, label]) => (
          <div className="field" key={key}>
            <label>{label}</label>
            <textarea rows={2} value={form[key] || ""} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
          </div>
        ))}
        <button type="submit" className="btn btn-primary" disabled={saving}>{t("save", lang)}</button>
        {msg && <div className="sub" style={{ marginTop: 6 }}>{msg}</div>}
      </form>
      {brief && (
        <div className="sub" style={{ marginTop: 8 }}>
          {t("createdByLabel", lang)}: {personName(people, brief.created_by)} · {(brief.created_at || "").slice(0, 10)}
          {brief.updated_at && ` · ${t("lastUpdatedLabel", lang)}: ${(brief.updated_at || "").slice(0, 10)}`}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <div className="sub" style={{ fontWeight: 700 }}>{t("uploadAttachmentLabel", lang)}</div>
        <AttachmentList lang={lang} attachments={attachments} isElevated={isElevated} onDelete={handleDelete} confirmDeleteId={confirmDeleteId} />
        <AttachmentUploader lang={lang} categories={ATTACHMENT_CATEGORIES} onUpload={handleUpload} busy={uploadBusy} />
      </div>
    </div>
  );
}

// =======================================================================
// Design Development (version control)
// =======================================================================
function DesignDevelopmentPanel({ lang, projectId, areaId, versions, people, profile, attachments, isElevated, onChanged }) {
  const [showForm, setShowForm] = useState(false);
  const [mode, setMode] = useState("version");
  const [form, setForm] = useState({ design_title: "", design_stage: "Concept Design", reason_for_change: "", client_feedback: "", internal_feedback: "", change_description: "" });
  const [uploadBusyId, setUploadBusyId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const current = versions.find((v) => v.is_current) || null;
  const canRevise = current && (current.approval_status === "Approved" || current.approval_status === "Approved with Conditions");

  async function handleCreate(e) {
    e.preventDefault();
    if (mode === "revision" && current) {
      await createDesignRevision(projectId, areaId, current, { ...form, submitted_by: profile?.id, submission_date: new Date().toISOString().slice(0, 10) }, profile?.id);
    } else {
      await createDesignVersion(projectId, areaId, { ...form, submitted_by: profile?.id, submission_date: new Date().toISOString().slice(0, 10) }, profile?.id);
    }
    setShowForm(false);
    setForm({ design_title: "", design_stage: "Concept Design", reason_for_change: "", client_feedback: "", internal_feedback: "", change_description: "" });
    onChanged();
  }

  async function handleUpload(versionId, file, category) {
    setUploadBusyId(versionId);
    await uploadWorkingDrawingAttachment({ projectId, areaId, module: "design_version", relatedRecordId: versionId, file, fileCategory: category, uploadedBy: profile?.id });
    setUploadBusyId(null);
    onChanged();
  }

  async function handleDelete(id) {
    if (confirmDeleteId !== id) { setConfirmDeleteId(id); return; }
    setConfirmDeleteId(null);
    await deleteWorkingDrawingAttachment(projectId, id);
    onChanged();
  }

  return (
    <div className="card">
      <h2>Design Development</h2>
      <div className="btn-row">
        <button className="btn btn-outline" style={{ width: "auto" }} onClick={() => { setMode("version"); setShowForm(true); }}>+ New Version</button>
        {canRevise && <button className="btn btn-outline" style={{ width: "auto" }} onClick={() => { setMode("revision"); setShowForm(true); }}>+ New Revision (after approval)</button>}
      </div>
      {showForm && (
        <form onSubmit={handleCreate} className="form-grid" style={{ marginTop: 10 }}>
          <div className="field"><label>Design title</label><input value={form.design_title} onChange={(e) => setForm((f) => ({ ...f, design_title: e.target.value }))} /></div>
          <div className="field"><label>Design stage</label>
            <select value={form.design_stage} onChange={(e) => setForm((f) => ({ ...f, design_stage: e.target.value }))}>
              {DESIGN_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field"><label>Reason for change</label><textarea rows={2} value={form.reason_for_change} onChange={(e) => setForm((f) => ({ ...f, reason_for_change: e.target.value }))} /></div>
          <div className="field"><label>Client feedback</label><textarea rows={2} value={form.client_feedback} onChange={(e) => setForm((f) => ({ ...f, client_feedback: e.target.value }))} /></div>
          <div className="field"><label>Internal feedback</label><textarea rows={2} value={form.internal_feedback} onChange={(e) => setForm((f) => ({ ...f, internal_feedback: e.target.value }))} /></div>
          <div className="field"><label>Change description</label><textarea rows={2} value={form.change_description} onChange={(e) => setForm((f) => ({ ...f, change_description: e.target.value }))} /></div>
          <button type="submit" className="btn btn-primary">{t("save", lang)}</button>
        </form>
      )}

      {versions.length === 0 && <div className="msg info" style={{ marginTop: 10 }}>{t("noRecordsYet", lang)}</div>}
      {versions.map((v) => (
        <div key={v.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
          <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700 }}>
              {v.version_number}{v.revision_number ? ` · R${v.revision_number}` : ""} — {v.design_title || "—"}
              {v.is_current && <span className="badge VERIFIED" style={{ marginLeft: 6 }}>{t("currentVersionLabel", lang)}</span>}
            </span>
            <span className={`badge ${APPROVAL_BADGE[v.approval_status] || "CLOSED"}`}>{v.approval_status}</span>
            <span className="sub">{v.design_stage} · {personName(people, v.created_by)} · {(v.created_at || "").slice(0, 10)}</span>
            <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => setExpandedId((cur) => cur === v.id ? null : v.id)}>
              {expandedId === v.id ? t("hideDetails", lang) : t("viewDetails", lang)}
            </button>
          </div>
          {expandedId === v.id && (
            <div style={{ marginTop: 6 }}>
              {v.reason_for_change && <div className="sub">Reason for change: {v.reason_for_change}</div>}
              {v.client_feedback && <div className="sub">Client feedback: {v.client_feedback}</div>}
              {v.internal_feedback && <div className="sub">Internal feedback: {v.internal_feedback}</div>}
              {v.change_description && <div className="sub">Change description: {v.change_description}</div>}
              <AttachmentList lang={lang} attachments={attachments.filter((a) => a.module === "design_version" && a.related_record_id === v.id)}
                isElevated={isElevated} onDelete={handleDelete} confirmDeleteId={confirmDeleteId} />
              <AttachmentUploader lang={lang} categories={ATTACHMENT_CATEGORIES} onUpload={(f, c) => handleUpload(v.id, f, c)} busy={uploadBusyId === v.id} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// =======================================================================
// Design Revisions & Change Requests
// =======================================================================
function DesignRevisionsPanel({ lang, projectId, areaId, changeRequests, versions, people, profile, onChanged }) {
  const [form, setForm] = useState({ change_type: "Client", description: "", cost_impact: "", timeline_impact: "" });
  const current = versions.find((v) => v.is_current) || null;
  const isPostLock = current && (current.approval_status === "Approved" || current.approval_status === "Approved with Conditions");

  async function handleCreate(e) {
    e.preventDefault();
    await createDesignChangeRequest({
      project_id: projectId, area_id: areaId, change_type: form.change_type, description: form.description,
      requested_by: profile?.id, cost_impact: form.cost_impact || null, timeline_impact: form.timeline_impact || null,
      post_lock: !!isPostLock,
    });
    setForm({ change_type: "Client", description: "", cost_impact: "", timeline_impact: "" });
    onChanged();
  }

  return (
    <div className="card">
      <h2>Design Revisions &amp; Change Requests</h2>
      <form onSubmit={handleCreate} className="form-grid">
        <div className="field"><label>Change type</label>
          <select value={form.change_type} onChange={(e) => setForm((f) => ({ ...f, change_type: e.target.value }))}>
            {CHANGE_TYPES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="field"><label>Description</label><textarea rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} required /></div>
        <div className="field"><label>Additional cost impact</label><input type="number" value={form.cost_impact} onChange={(e) => setForm((f) => ({ ...f, cost_impact: e.target.value }))} /></div>
        <div className="field"><label>Timeline impact</label><input value={form.timeline_impact} onChange={(e) => setForm((f) => ({ ...f, timeline_impact: e.target.value }))} /></div>
        {isPostLock && <div className="msg info">{t("postLockChangeNote", lang)}</div>}
        <button type="submit" className="btn btn-primary">{t("save", lang)}</button>
      </form>

      {changeRequests.length === 0 && <div className="msg info" style={{ marginTop: 10 }}>{t("noRecordsYet", lang)}</div>}
      {changeRequests.map((c) => (
        <div key={c.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap" }}>
          <span className="badge ASSIGNED">{c.change_type}</span>
          <span>{c.description}</span>
          {c.post_lock && <span className="badge REVISION">Post-lock</span>}
          <span className="sub">{personName(people, c.requested_by)} · {c.requested_date}</span>
          <span className={`badge ${c.status === "Addressed" ? "VERIFIED" : "ASSIGNED"}`}>{c.status}</span>
        </div>
      ))}
    </div>
  );
}

// =======================================================================
// Design Approval
// =======================================================================
function DesignApprovalPanel({ lang, projectId, areaId, currentArea, versions, approvals, changeCounts, people, profile, attachments, isElevated, onChanged }) {
  const [form, setForm] = useState({ decision: "Approved", stage_at_approval: "Final Design", remarks: "", conditions: "", approval_method: "Signed approval" });
  const [statusForm, setStatusForm] = useState("Submitted for Internal Review");
  const [uploadBusy, setUploadBusy] = useState(false);
  const current = versions.find((v) => v.is_current) || null;
  const firstVersion = versions[versions.length - 1] || null;
  const approvedVersion = versions.find((v) => v.approval_status === "Approved" || v.approval_status === "Approved with Conditions") || null;

  const turnaroundDays = useMemo(() => {
    if (!firstVersion || !approvedVersion) return null;
    const first = new Date(firstVersion.created_at);
    const approved = approvals.find((a) => a.design_version_id === approvedVersion.id);
    if (!approved) return null;
    const days = Math.round((new Date(approved.decided_at) - first) / 86400000);
    return days >= 0 ? days : null;
  }, [firstVersion, approvedVersion, approvals]);

  async function handleMoveStatus(e) {
    e.preventDefault();
    if (!current) return;
    await updateDesignVersionStatus(projectId, areaId, current.id, statusForm);
    onChanged();
  }

  async function handleDecide(e) {
    e.preventDefault();
    if (!current) return;
    await decideDesignApproval(projectId, areaId, current.id, form.decision, {
      version_number: current.version_number, stage_at_approval: form.stage_at_approval,
      remarks: form.remarks, conditions: form.conditions, approval_method: form.approval_method, proof_storage_path: null,
    }, profile?.id);
    onChanged();
  }

  async function handleUploadProof(file) {
    setUploadBusy(true);
    await uploadWorkingDrawingAttachment({ projectId, areaId, module: "design_approval", relatedRecordId: current?.id, file, fileCategory: "Approval Proof", uploadedBy: profile?.id });
    setUploadBusy(false);
    onChanged();
  }

  return (
    <div className="card">
      <h2>Design Approval</h2>
      {!current ? <div className="msg info">{t("noRecordsYet", lang)}</div> : (
        <>
          <div className="task-meta" style={{ flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700 }}>{current.version_number}{current.revision_number ? ` · R${current.revision_number}` : ""}</span>
            <span className={`badge ${APPROVAL_BADGE[current.approval_status] || "CLOSED"}`}>{current.approval_status}</span>
          </div>

          <div className="dept-meta-grid" style={{ marginTop: 8 }}>
            <div className="card dept-meta-tile"><div className="label">{t("changeCountLabel", lang)}</div><div className="value">{changeCounts.total_change_count}</div></div>
            <div className="card dept-meta-tile"><div className="label">Client changes</div><div className="value">{changeCounts.client_change_count}</div></div>
            <div className="card dept-meta-tile"><div className="label">Internal changes</div><div className="value">{changeCounts.internal_change_count}</div></div>
            <div className="card dept-meta-tile"><div className="label">Site condition changes</div><div className="value">{changeCounts.site_condition_change_count}</div></div>
            <div className="card dept-meta-tile"><div className="label">Management changes</div><div className="value">{changeCounts.management_change_count}</div></div>
            {turnaroundDays !== null && <div className="card dept-meta-tile"><div className="label">Approval turnaround</div><div className="value">{turnaroundDays}d</div></div>}
          </div>

          {approvedVersion && (
            <div className="msg info" style={{ marginTop: 8 }}>
              {(currentArea?.area_name || currentArea?.area_type || "This area")} design was approved at {approvals.find((a) => a.design_version_id === approvedVersion.id)?.stage_at_approval || approvedVersion.design_stage} stage
              on version {approvedVersion.version_number} after {changeCounts.total_change_count} changes.
            </div>
          )}

          {current.approval_status !== "Approved" && current.approval_status !== "Approved with Conditions" && current.approval_status !== "Rejected" && (
            <>
              <form onSubmit={handleMoveStatus} className="form-grid" style={{ marginTop: 10 }}>
                <div className="field"><label>Move to workflow status</label>
                  <select value={statusForm} onChange={(e) => setStatusForm(e.target.value)}>
                    {VERSION_STATUSES.filter((s) => !["Approved", "Approved with Conditions", "Rejected", "Locked"].includes(s)).map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <button type="submit" className="btn btn-outline" style={{ width: "auto" }}>{t("save", lang)}</button>
              </form>

              <form onSubmit={handleDecide} className="form-grid" style={{ marginTop: 10 }}>
                <h3>{t("approveLabel", lang)} / {t("rejectLabel", lang)}</h3>
                <div className="field"><label>Decision</label>
                  <select value={form.decision} onChange={(e) => setForm((f) => ({ ...f, decision: e.target.value }))}>
                    <option value="Approved">Approved</option>
                    <option value="Approved with Conditions">Approved with Conditions</option>
                    <option value="Rejected">Rejected</option>
                  </select>
                </div>
                <div className="field"><label>{t("approvalStageLabel", lang)}</label>
                  <select value={form.stage_at_approval} onChange={(e) => setForm((f) => ({ ...f, stage_at_approval: e.target.value }))}>
                    {DESIGN_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="field"><label>Approval method</label>
                  <select value={form.approval_method} onChange={(e) => setForm((f) => ({ ...f, approval_method: e.target.value }))}>
                    {APPROVAL_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div className="field"><label>Conditions</label><input value={form.conditions} onChange={(e) => setForm((f) => ({ ...f, conditions: e.target.value }))} /></div>
                <div className="field"><label>Remarks</label><textarea rows={2} value={form.remarks} onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))} /></div>
                <button type="submit" className="btn btn-primary">{t("save", lang)}</button>
              </form>
              <div style={{ marginTop: 8 }}>
                <CreateTaskButton lang={lang} projectId={projectId} areaId={areaId} profile={profile} people={people}
                  title={`Design approval pending — ${current.version_number} (${currentArea?.area_name || currentArea?.area_type || ""})`}
                  relatedModule="design_approval" relatedRecordId={current.id} priority="Medium" />
              </div>
            </>
          )}

          <div style={{ marginTop: 10 }}>
            <div className="sub" style={{ fontWeight: 700 }}>{t("uploadAttachmentLabel", lang)} ({t("approveLabel", lang)} proof)</div>
            <AttachmentList lang={lang} attachments={attachments.filter((a) => a.module === "design_approval" && a.related_record_id === current.id)} isElevated={isElevated} />
            <AttachmentUploader lang={lang} categories={["Approval Proof", "Signed approval", "Email proof", "WhatsApp Screenshot", "Other"]} onUpload={(f) => handleUploadProof(f)} busy={uploadBusy} />
          </div>

          <div style={{ marginTop: 10 }}>
            <div className="sub" style={{ fontWeight: 700 }}>Approval history</div>
            {approvals.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
            {approvals.map((a) => (
              <div key={a.id} className="task-meta" style={{ padding: "4px 0", flexWrap: "wrap" }}>
                <span className={`badge ${APPROVAL_BADGE[a.decision] || "CLOSED"}`}>{a.decision}</span>
                <span className="sub">{a.version_number} · {a.stage_at_approval} · {personName(people, a.decided_by)} · {(a.decided_at || "").slice(0, 10)}</span>
                {a.remarks && <span className="sub">{a.remarks}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// =======================================================================
// Design Lock
// =======================================================================
function DesignLockPanel({ lang, projectId, areaId, currentArea, versions, lock, materialSelections, checklistItems, checklistResults, people, profile, isElevated, onChanged }) {
  const [form, setForm] = useState({ final_specifications: "", final_measurements: "", final_finish: "", lock_remarks: "", client_confirmation: "", client_approved_date: "", exception_reason: "" });
  const [msg, setMsg] = useState("");
  const approvedVersion = versions.find((v) => v.is_current && (v.approval_status === "Approved" || v.approval_status === "Approved with Conditions"));
  const areaMaterials = materialSelections.filter((m) => m.status !== "REPLACED" && (m.area_id === areaId || m.area_name === (currentArea?.area_name)));
  const materialsApproved = areaMaterials.length > 0 && areaMaterials.every((m) => ["Approved", "Approved with Conditions", "Final Selection Locked"].includes(m.approval_status));
  const requiredChecklist = checklistItems.filter((i) => i.category === "Design" || i.category === "General");
  const checklistComplete = requiredChecklist.length > 0 && requiredChecklist.every((i) => {
    const r = checklistResults.find((x) => x.checklist_item_id === i.id);
    return r && (r.status === "Completed" || r.status === "Not Applicable");
  });

  const gateOk = !!approvedVersion && materialsApproved && checklistComplete;

  async function handleLock(e) {
    e.preventDefault();
    if (!gateOk && !form.exception_reason) {
      setMsg(t("designLockGateBlockedMsg", lang));
      return;
    }
    const { error: err } = await createDesignLock(projectId, areaId, {
      locked_version_id: approvedVersion?.id || null,
      client_approved_date: form.client_approved_date || null,
      material_approval_status_snapshot: materialsApproved ? "Approved" : "Incomplete",
      final_specifications: form.final_specifications, final_measurements: form.final_measurements,
      final_finish: form.final_finish, lock_remarks: form.lock_remarks, client_confirmation: form.client_confirmation,
      exception_reason: !gateOk ? form.exception_reason : null,
      exception_by: !gateOk ? profile?.id : null,
    }, profile?.id);
    setMsg(err ? t("errorSaving", lang) : t("saved", lang));
    if (!err) onChanged();
  }

  if (lock) {
    return (
      <div className="card">
        <h2>Design Lock</h2>
        <div className="msg info">{t("designLockedMsg", lang)}</div>
        <div className="task-meta" style={{ flexWrap: "wrap" }}>
          <span className="badge COMPLETED">{t("lockedLabel", lang)}</span>
          <span className="sub">{lock.lock_date} · {personName(people, lock.locked_by)}</span>
        </div>
        {lock.final_specifications && <div className="sub">Specifications: {lock.final_specifications}</div>}
        {lock.final_measurements && <div className="sub">Measurements: {lock.final_measurements}</div>}
        {lock.final_finish && <div className="sub">Finish: {lock.final_finish}</div>}
        {lock.lock_remarks && <div className="sub">Remarks: {lock.lock_remarks}</div>}
        {lock.exception_reason && <div className="msg info">Locked with exception: {lock.exception_reason} ({personName(people, lock.exception_by)})</div>}
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Design Lock</h2>
      <div className="task-meta" style={{ flexWrap: "wrap" }}>
        <span className={`badge ${approvedVersion ? "VERIFIED" : "RETURNED"}`}>Design approved</span>
        <span className={`badge ${materialsApproved ? "VERIFIED" : "RETURNED"}`}>Material approval complete</span>
        <span className={`badge ${checklistComplete ? "VERIFIED" : "RETURNED"}`}>Design checklist complete</span>
      </div>
      <form onSubmit={handleLock} className="form-grid" style={{ marginTop: 10 }}>
        <div className="field"><label>Final specifications</label><textarea rows={2} value={form.final_specifications} onChange={(e) => setForm((f) => ({ ...f, final_specifications: e.target.value }))} /></div>
        <div className="field"><label>Final measurements</label><textarea rows={2} value={form.final_measurements} onChange={(e) => setForm((f) => ({ ...f, final_measurements: e.target.value }))} /></div>
        <div className="field"><label>Final finish</label><input value={form.final_finish} onChange={(e) => setForm((f) => ({ ...f, final_finish: e.target.value }))} /></div>
        <div className="field"><label>Client confirmation</label><input value={form.client_confirmation} onChange={(e) => setForm((f) => ({ ...f, client_confirmation: e.target.value }))} /></div>
        <div className="field"><label>Client approved date</label><input type="date" value={form.client_approved_date} onChange={(e) => setForm((f) => ({ ...f, client_approved_date: e.target.value }))} /></div>
        <div className="field"><label>Lock remarks</label><textarea rows={2} value={form.lock_remarks} onChange={(e) => setForm((f) => ({ ...f, lock_remarks: e.target.value }))} /></div>
        {!gateOk && isElevated && (
          <div className="field"><label>{t("exceptionReasonLabel", lang)}</label><textarea rows={2} value={form.exception_reason} onChange={(e) => setForm((f) => ({ ...f, exception_reason: e.target.value }))} /></div>
        )}
        {!gateOk && !isElevated && <div className="msg error">{t("designLockGateBlockedMsg", lang)}</div>}
        <button type="submit" className="btn btn-primary" disabled={!gateOk && !isElevated}>{t("lockDesign", lang)}</button>
        {msg && <div className="sub">{msg}</div>}
      </form>
      {!gateOk && (
        <div style={{ marginTop: 8 }}>
          <CreateTaskButton lang={lang} projectId={projectId} areaId={areaId} profile={profile} people={people}
            title={`Resolve pending items before Design Lock — ${currentArea?.area_name || currentArea?.area_type || ""}`}
            relatedModule="design_lock" relatedRecordId={areaId} priority="High" />
        </div>
      )}
    </div>
  );
}

// =======================================================================
// Working Drawings
// =======================================================================
function WorkingDrawingsPanel({ lang, projectId, areaId, versions, drawings, people, profile, attachments, isElevated, onChanged }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ drawing_number: "", drawing_title: "", drawing_type: "Layout Plan", related_design_version_id: "" });
  const [expandedId, setExpandedId] = useState(null);
  const [drawingVersions, setDrawingVersions] = useState({});
  const [uploadBusyId, setUploadBusyId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  async function handleCreate(e) {
    e.preventDefault();
    await createWorkingDrawing({ ...form, project_id: projectId, area_id: areaId, related_design_version_id: form.related_design_version_id || null, prepared_by: profile?.id }, profile?.id);
    setShowForm(false);
    setForm({ drawing_number: "", drawing_title: "", drawing_type: "Layout Plan", related_design_version_id: "" });
    onChanged();
  }

  async function loadVersions(drawingId) {
    const { data } = await listDrawingVersions(projectId, drawingId);
    setDrawingVersions((cur) => ({ ...cur, [drawingId]: data || [] }));
  }

  function toggleExpand(id) {
    setExpandedId((cur) => cur === id ? null : id);
    if (!drawingVersions[id]) loadVersions(id);
  }

  async function handleStatusChange(drawing, status) {
    const patch = { status };
    if (status === "Internal Review") {
      patch.checked_by = profile?.id;
      patch.checked_date = new Date().toISOString().slice(0, 10);
    }
    if (status === "Approved" || status === "Approved with Comments") {
      patch.approved_by = profile?.id;
      patch.approval_date = new Date().toISOString().slice(0, 10);
    }
    await updateWorkingDrawing(projectId, drawing.id, patch);
    onChanged();
  }

  async function handleNewVersion(drawingId) {
    await createDrawingVersion(projectId, drawingId, {}, profile?.id);
    loadVersions(drawingId);
  }

  async function handleIssueVersion(drawingId, versionId) {
    await issueDrawingVersion(projectId, drawingId, versionId);
    loadVersions(drawingId);
    onChanged();
  }

  async function handleUpload(drawingId, file, category) {
    setUploadBusyId(drawingId);
    await uploadWorkingDrawingAttachment({ projectId, areaId, module: "drawing", relatedRecordId: drawingId, file, fileCategory: category, uploadedBy: profile?.id });
    setUploadBusyId(null);
    onChanged();
  }

  async function handleDelete(id) {
    if (confirmDeleteId !== id) { setConfirmDeleteId(id); return; }
    setConfirmDeleteId(null);
    await deleteWorkingDrawingAttachment(projectId, id);
    onChanged();
  }

  return (
    <div className="card">
      <h2>Working Drawings</h2>
      <button className="btn btn-outline" style={{ width: "auto" }} onClick={() => setShowForm((s) => !s)}>+ New Drawing</button>
      {showForm && (
        <form onSubmit={handleCreate} className="form-grid" style={{ marginTop: 10 }}>
          <div className="field"><label>Drawing number</label><input value={form.drawing_number} onChange={(e) => setForm((f) => ({ ...f, drawing_number: e.target.value }))} required /></div>
          <div className="field"><label>Drawing title</label><input value={form.drawing_title} onChange={(e) => setForm((f) => ({ ...f, drawing_title: e.target.value }))} /></div>
          <div className="field"><label>Drawing type</label>
            <select value={form.drawing_type} onChange={(e) => setForm((f) => ({ ...f, drawing_type: e.target.value }))}>
              {DRAWING_TYPES.map((dt) => <option key={dt} value={dt}>{dt}</option>)}
            </select>
          </div>
          <div className="field"><label>Related design version</label>
            <select value={form.related_design_version_id} onChange={(e) => setForm((f) => ({ ...f, related_design_version_id: e.target.value }))}>
              <option value="">—</option>
              {versions.map((v) => <option key={v.id} value={v.id}>{v.version_number}</option>)}
            </select>
          </div>
          <button type="submit" className="btn btn-primary">{t("save", lang)}</button>
        </form>
      )}

      {drawings.length === 0 && <div className="msg info" style={{ marginTop: 10 }}>{t("noRecordsYet", lang)}</div>}
      {drawings.map((d) => (
        <div key={d.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
          <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700 }}>{d.drawing_number} — {d.drawing_title || d.drawing_type}</span>
            <span className={`badge ${DRAWING_BADGE[d.status] || "CLOSED"}`}>{d.status}</span>
            <select value={d.status} onChange={(e) => handleStatusChange(d, e.target.value)}>
              {DRAWING_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => toggleExpand(d.id)}>
              {expandedId === d.id ? t("hideDetails", lang) : t("viewDetails", lang)}
            </button>
          </div>
          {expandedId === d.id && (
            <div style={{ marginTop: 6 }}>
              <div className="sub">{d.drawing_type} · {t("preparedByLabel", lang)}: {personName(people, d.prepared_by)}
                {d.checked_by && ` · ${t("checkedByLabel", lang)}: ${personName(people, d.checked_by)}`}
                {d.approved_by && ` · ${t("approvedByLabel", lang)}: ${personName(people, d.approved_by)}`}
              </div>
              <div className="btn-row"><button className="btn btn-outline" style={{ width: "auto" }} onClick={() => handleNewVersion(d.id)}>+ New Drawing Version</button></div>
              {(drawingVersions[d.id] || []).map((v) => (
                <div key={v.id} className="task-meta" style={{ padding: "4px 0", flexWrap: "wrap" }}>
                  <span>{v.version_number}{v.revision_number ? ` · R${v.revision_number}` : ""}</span>
                  <span className={`badge ${v.status === "Issued for Execution" ? "VERIFIED" : v.status === "Superseded" ? "CLOSED" : v.is_current ? "ASSIGNED" : "CLOSED"}`}>
                    {v.status === "Issued for Execution" ? "ISSUED FOR EXECUTION" : v.is_current ? "CURRENT VERSION" : "SUPERSEDED VERSION"}
                  </span>
                  {v.is_current && v.status !== "Issued for Execution" && (
                    <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => handleIssueVersion(d.id, v.id)}>Issue for Execution</button>
                  )}
                </div>
              ))}
              <div style={{ marginTop: 6 }}>
                <AttachmentList lang={lang} attachments={attachments.filter((a) => a.module === "drawing" && a.related_record_id === d.id)}
                  isElevated={isElevated} onDelete={handleDelete} confirmDeleteId={confirmDeleteId} />
                <AttachmentUploader lang={lang} categories={["Drawing File", "Source/CAD File", "PDF", "Other"]} onUpload={(f, c) => handleUpload(d.id, f, c)} busy={uploadBusyId === d.id} />
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// =======================================================================
// Working Drawing Checklist
// =======================================================================
function ChecklistPanel({ lang, projectId, areaId, items, results, people, profile, onChanged }) {
  const [drafts, setDrafts] = useState({});
  const [historyFor, setHistoryFor] = useState(null);
  const [history, setHistory] = useState([]);

  const byCategory = useMemo(() => {
    const g = {};
    items.forEach((i) => { g[i.category] = g[i.category] || []; g[i.category].push(i); });
    return g;
  }, [items]);

  const resultFor = useCallback((itemId) => results.find((r) => r.checklist_item_id === itemId), [results]);

  const completionPct = useMemo(() => {
    if (items.length === 0) return 0;
    const done = items.filter((i) => { const r = resultFor(i.id); return r && (r.status === "Completed" || r.status === "Not Applicable"); }).length;
    return Math.round((done / items.length) * 100);
  }, [items, resultFor]);

  async function handleSave(item) {
    const draft = drafts[item.id] || {};
    const current = resultFor(item.id);
    const status = draft.status || current?.status || "Not Started";
    await upsertChecklistResult(projectId, areaId, item.id, {
      status, remarks: draft.remarks ?? current?.remarks, reopen_reason: draft.reopen_reason || null,
    }, profile?.id);
    setDrafts((d) => ({ ...d, [item.id]: {} }));
    onChanged();
  }

  async function viewHistory(itemId) {
    const { data } = await listChecklistResultHistory(projectId, areaId, itemId);
    setHistory(data || []);
    setHistoryFor(itemId);
  }

  return (
    <div className="card">
      <h2>Working Drawing Checklist</h2>
      <div className="msg info">{t("checklistLabel", lang)}: {completionPct}%</div>
      {Object.entries(byCategory).map(([category, catItems]) => (
        <div key={category} style={{ marginTop: 12 }}>
          <h3>{category}</h3>
          {catItems.map((item) => {
            const r = resultFor(item.id);
            const draft = drafts[item.id] || {};
            return (
              <div key={item.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0", flexWrap: "wrap" }}>
                <span style={{ flex: 1, minWidth: 220 }}>{item.item_text_en}</span>
                <span className={`badge ${CHECKLIST_BADGE[r?.status || "Not Started"]}`}>{r?.status || "Not Started"}</span>
                <select value={draft.status ?? r?.status ?? "Not Started"} onChange={(e) => setDrafts((d) => ({ ...d, [item.id]: { ...d[item.id], status: e.target.value } }))}>
                  {CHECKLIST_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => handleSave(item)}>{t("save", lang)}</button>
                <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => viewHistory(item.id)}>{t("viewHistoryAction", lang)}</button>
                {r && <span className="sub">{personName(people, r.checked_by)} {r.checked_date}</span>}
                {r?.status === "Correction Required" && (
                  <CreateTaskButton lang={lang} projectId={projectId} areaId={areaId} profile={profile} people={people}
                    title={`Checklist correction: ${item.item_text_en}`} relatedModule="drawing_checklist" relatedRecordId={item.id} priority="Medium" />
                )}
              </div>
            );
          })}
        </div>
      ))}

      {historyFor && (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="btn-row" style={{ justifyContent: "space-between" }}>
            <div className="sub" style={{ fontWeight: 700 }}>{t("viewHistoryAction", lang)}</div>
            <button className="btn btn-outline" style={{ width: "auto" }} onClick={() => setHistoryFor(null)}>{t("cancel", lang)}</button>
          </div>
          {history.map((h) => (
            <div key={h.id} className="task-meta" style={{ padding: "4px 0" }}>
              <span className={`badge ${CHECKLIST_BADGE[h.status]}`}>{h.status}</span>
              <span className="sub">{h.checked_date} {h.reopen_reason ? `· Reopened: ${h.reopen_reason}` : ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// =======================================================================
// Final Issue for Execution
// =======================================================================
function FinalIssuePanel({ lang, projectId, areaId, drawings, issues, lock, checklistItems, checklistResults, people, profile, currentArea, onChanged }) {
  const [form, setForm] = useState({ drawing_id: "", issued_to: "", department_or_vendor: "", execution_start_date: "", notes: "" });
  const [msg, setMsg] = useState("");

  const finalIssueItems = checklistItems.filter((i) => i.category === "Final Issue");
  const checklistComplete = finalIssueItems.length > 0 && finalIssueItems.every((i) => {
    const r = checklistResults.find((x) => x.checklist_item_id === i.id);
    return r && (r.status === "Completed" || r.status === "Not Applicable");
  });
  const gateOk = !!lock && checklistComplete;

  async function handleIssue(e) {
    e.preventDefault();
    if (!gateOk) { setMsg(t("finalIssueGateBlockedMsg", lang)); return; }
    const drawing = drawings.find((d) => d.id === form.drawing_id);
    const { error: err } = await createDrawingIssue(projectId, areaId, {
      drawing_id: form.drawing_id || null, design_version_id: drawing?.related_design_version_id || null,
      material_approval_status_snapshot: lock?.material_approval_status_snapshot || null,
      issued_to: form.issued_to, department_or_vendor: form.department_or_vendor,
      execution_start_date: form.execution_start_date || null, notes: form.notes,
    }, profile?.id);
    setMsg(err ? t("errorSaving", lang) : t("saved", lang));
    if (!err) onChanged();
  }

  async function handleAck(id) {
    await acknowledgeDrawingIssue(projectId, id);
    onChanged();
  }

  return (
    <div className="card">
      <h2>Final Issue for Execution</h2>
      <div className="task-meta" style={{ flexWrap: "wrap" }}>
        <span className={`badge ${lock ? "VERIFIED" : "RETURNED"}`}>Design locked</span>
        <span className={`badge ${checklistComplete ? "VERIFIED" : "RETURNED"}`}>Final issue checklist complete</span>
      </div>
      <form onSubmit={handleIssue} className="form-grid" style={{ marginTop: 10 }}>
        <div className="field"><label>Drawing</label>
          <select value={form.drawing_id} onChange={(e) => setForm((f) => ({ ...f, drawing_id: e.target.value }))} required>
            <option value="">—</option>
            {drawings.map((d) => <option key={d.id} value={d.id}>{d.drawing_number} — {d.drawing_title}</option>)}
          </select>
        </div>
        <div className="field"><label>Issued to</label><input value={form.issued_to} onChange={(e) => setForm((f) => ({ ...f, issued_to: e.target.value }))} required /></div>
        <div className="field"><label>Department / Vendor</label><input value={form.department_or_vendor} onChange={(e) => setForm((f) => ({ ...f, department_or_vendor: e.target.value }))} /></div>
        <div className="field"><label>Execution start date</label><input type="date" value={form.execution_start_date} onChange={(e) => setForm((f) => ({ ...f, execution_start_date: e.target.value }))} /></div>
        <div className="field"><label>Notes</label><textarea rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></div>
        {!gateOk && <div className="msg error">{t("finalIssueGateBlockedMsg", lang)}</div>}
        <button type="submit" className="btn btn-primary" disabled={!gateOk}>{t("issueForExecutionLabel", lang)}</button>
        {msg && <div className="sub">{msg}</div>}
      </form>
      {!gateOk && (
        <div style={{ marginTop: 8 }}>
          <CreateTaskButton lang={lang} projectId={projectId} areaId={areaId} profile={profile} people={people}
            title={`Final issue pending — ${currentArea?.area_name || currentArea?.area_type || ""}`}
            relatedModule="drawing_issue" relatedRecordId={areaId} priority="High" />
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        {issues.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {issues.map((i) => (
          <div key={i.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0", flexWrap: "wrap" }}>
            <span>{i.issued_to} — {i.department_or_vendor}</span>
            <span className={`badge ${i.superseded_at ? "CLOSED" : "VERIFIED"}`}>{i.superseded_at ? "Superseded" : "Active"}</span>
            <span className="sub">{personName(people, i.issued_by)} · {i.issue_date}</span>
            {i.receiver_ack ? <span className="badge COMPLETED">Acknowledged {i.ack_date}</span> :
              <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => handleAck(i.id)}>Acknowledge receipt</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

// =======================================================================
// Revision & Change History (new tables + legacy attachments/project_changes)
// =======================================================================
function RevisionHistoryPanel({ lang, versions, changeRequests, legacyAttachments, legacyChanges, people }) {
  return (
    <div className="card">
      <h2>Revision &amp; Change History</h2>
      <h3>Design versions</h3>
      {versions.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
      {versions.map((v) => (
        <div key={v.id} className="task-meta" style={{ padding: "4px 0", flexWrap: "wrap" }}>
          <span>{v.version_number}{v.revision_number ? ` · R${v.revision_number}` : ""}</span>
          <span className={`badge ${APPROVAL_BADGE[v.approval_status] || "CLOSED"}`}>{v.approval_status}</span>
          <span className="sub">{(v.created_at || "").slice(0, 10)} · {personName(people, v.created_by)}</span>
        </div>
      ))}

      <h3 style={{ marginTop: 10 }}>Change requests</h3>
      {changeRequests.map((c) => (
        <div key={c.id} className="task-meta" style={{ padding: "4px 0", flexWrap: "wrap" }}>
          <span className="badge ASSIGNED">{c.change_type}</span>
          <span>{c.description}</span>
          <span className="sub">{c.requested_date}</span>
        </div>
      ))}

      {(legacyChanges.length > 0 || legacyAttachments.length > 0) && (
        <>
          <h3 style={{ marginTop: 10 }}>{t("legacyRecordsLabel", lang)}</h3>
          {legacyChanges.map((c) => (
            <div key={c.id} className="task-meta" style={{ padding: "4px 0", flexWrap: "wrap" }}>
              <span className="badge CLOSED">Legacy</span>
              <span>{c.description}</span>
              <span className={`badge ${c.approval_status === "APPROVED" ? "VERIFIED" : c.approval_status === "REJECTED" ? "RETURNED" : "ASSIGNED"}`}>{c.approval_status}</span>
              <span className="sub">{c.requested_date}</span>
            </div>
          ))}
          {legacyAttachments.map((a) => (
            <div key={a.id} className="task-meta" style={{ padding: "4px 0", flexWrap: "wrap" }}>
              <span className="badge CLOSED">Legacy</span>
              <span>{a.title || a.file_name} ({a.stage})</span>
              {a.frozen && <span className="badge COMPLETED">{t("frozenLabel", lang)}</span>}
              <ViewDownloadButton lang={lang} storagePath={a.storage_path} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// =======================================================================
// All Attachments (union of every module + legacy)
// =======================================================================
function AllAttachmentsPanel({ lang, areaAttachments, materialAttachments, legacyAttachments, people }) {
  const [search, setSearch] = useState("");
  const rows = useMemo(() => {
    const a = areaAttachments.map((x) => ({ id: x.id, name: x.original_file_name || x.file_name, module: x.module, storage_path: x.storage_path, uploaded_by: x.uploaded_by, uploaded_at: x.uploaded_at }));
    const m = materialAttachments.map((x) => ({ id: x.id, name: x.original_file_name || x.file_name, module: "material_selection", storage_path: x.storage_path, uploaded_by: x.uploaded_by, uploaded_at: x.uploaded_at }));
    const l = legacyAttachments.map((x) => ({ id: x.id, name: x.title || x.file_name, module: `legacy_${x.stage}`, storage_path: x.storage_path, uploaded_by: x.uploaded_by, uploaded_at: x.created_at }));
    return [...a, ...m, ...l].filter((r) => !search || (r.name || "").toLowerCase().includes(search.toLowerCase()));
  }, [areaAttachments, materialAttachments, legacyAttachments, search]);

  return (
    <div className="card">
      <h2>All Attachments</h2>
      <input placeholder={t("searchLabel", lang)} value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: "auto", minWidth: 200 }} />
      {rows.length === 0 && <div className="msg info" style={{ marginTop: 8 }}>{t("noRecordsForProject", lang)}</div>}
      {rows.map((r) => (
        <div key={`${r.module}-${r.id}`} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap" }}>
          <span>{r.name}</span>
          <span className="badge ASSIGNED">{r.module}</span>
          <span className="sub">{personName(people, r.uploaded_by)} · {(r.uploaded_at || "").slice(0, 10)}</span>
          <ViewDownloadButton lang={lang} storagePath={r.storage_path} />
        </div>
      ))}
    </div>
  );
}
