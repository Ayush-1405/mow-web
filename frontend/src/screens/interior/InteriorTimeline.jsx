import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { t } from "../../lib/i18n";
import { formatCurrency } from "../../lib/retailModules";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import {
  listProjects, updateProjectField, updateProjectDetails, listProjectChanges,
  setFreezeCheck, freezeProject, hasOpenMajorSnag, deleteProject, notifyDeptLeadership,
  listInteriorPeople, listProjectMembers, addProjectMember, removeProjectMember, notifyInteriorAssignment,
} from "../../lib/interiorApi";

const emptyDetails = { location: "", start_date: "", next_update: "", on_time: null, next_action: "", remarks: "" };

// The live `projects.stage` CHECK constraint (projects_stage_check) is the
// authoritative list — 11 stages, not the doc's 13. "Deal Closed" and
// "Kick-off" were never valid values in the actually-deployed system (the
// doc's §2 describes an aspirational/earlier version); using anything
// outside this exact list makes the database itself reject the write.
// Same skip-prevention rules still apply:
//   - No design approval -> no design freeze (4-point checklist below)
//   - No design freeze -> no execution release
//   - Open major snag -> no project closure
//   - Pending change request -> no stage advance
const STAGES = [
  "Quotation", "Design", "Client Approval", "Design Freeze",
  "Execution Planning", "Purchase/Production", "Execution",
  "QC", "Snagging", "Handover", "Completed",
];
const FREEZE_FIELDS = [
  ["freeze_check_3d", "freezeCheck3d"], ["freeze_check_drawing", "freezeCheckDrawing"],
  ["freeze_check_specs", "freezeCheckSpecs"], ["freeze_check_customer_approval", "freezeCheckCustomer"],
];

export default function InteriorTimeline({ lang, staffProfile, lockedProjectId }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const myProfile = useInteriorProfile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [details, setDetails] = useState(emptyDetails);
  const [saving, setSaving] = useState(false);
  const [stageMsg, setStageMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState([]);
  const [team, setTeam] = useState([]);
  const [newMemberId, setNewMemberId] = useState("");
  const [teamBusy, setTeamBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteMsg, setDeleteMsg] = useState("");

  // Optimistic UI gate only — staff_delete_interior_project re-checks
  // Management/Super Admin/Interior Dept Head server-side regardless, so
  // this can't be bypassed by forging the request. No PM/Designer/
  // Execution role gets this button, however senior on this one project.
  const canDeleteProject = !!staffProfile?.isManagement || !!staffProfile?.isSuperAdmin || !!staffProfile?.isDeptHead;

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data, error: err }, peopleRes] = await Promise.all([listProjects(), listInteriorPeople()]);
    if (err) { setError(true); setLoading(false); return; }
    setProjects(data || []);
    setPeople(peopleRes.data || []);
    // lockedProjectId (opened as a Project Detail tab) wins over
    // everything else. Otherwise a notification/deep-link (?project=<id>)
    // always wins, even over an already-selected project — this screen
    // doesn't remount between two clicks on different project links (same
    // route, React Router just re-renders), so without this a second
    // click here would silently do nothing. No param at all falls back to
    // whatever's already chosen, or the first project on a first visit.
    const focusId = lockedProjectId || searchParams.get("project");
    if (data?.length) {
      if (focusId && data.some((p) => p.id === focusId)) {
        setProjectId(focusId);
      } else {
        setProjectId((cur) => cur || data[0].id);
      }
    }
    setLoading(false);
  }, [searchParams, lockedProjectId]);

  useEffect(() => { load(); }, [load]);

  const loadTeam = useCallback(async () => {
    if (!projectId) { setTeam([]); return; }
    const { data } = await listProjectMembers(projectId);
    setTeam(data || []);
  }, [projectId]);

  useEffect(() => { loadTeam(); }, [loadTeam]);

  const personName = useCallback((id) => people.find((p) => p.id === id)?.name || "—", [people]);

  const project = projects.find((p) => p.id === projectId);
  useEffect(() => {
    setDetails({
      location: project?.location || "",
      start_date: project?.start_date || "",
      next_update: project?.next_update || "",
      on_time: project?.on_time ?? null,
      next_action: project?.next_action || "",
      remarks: project?.remarks || "",
    });
    setStageMsg("");
  }, [project]);

  function refreshProject(data) {
    setProjects((ps) => ps.map((p) => (p.id === projectId ? data : p)));
  }

  async function saveDetails(e) {
    e.preventDefault();
    if (!projectId) return;
    setSaving(true);
    const { data, error: err } = await updateProjectDetails(projectId, {
      location: details.location || null,
      start_date: details.start_date || null,
      next_update: details.next_update || null,
      on_time: details.on_time,
      next_action: details.next_action || null,
      remarks: details.remarks || null,
    });
    setSaving(false);
    if (!err) refreshProject(data);
  }

  async function toggleFreezeCheck(field, value) {
    setBusy(true);
    const { data, error: err } = await setFreezeCheck(projectId, field, value);
    setBusy(false);
    if (!err) refreshProject(data);
  }

  async function doFreeze() {
    setBusy(true);
    const { data, error: err } = await freezeProject(projectId);
    setBusy(false);
    if (err) { setStageMsg(err.message); return; }
    notifyDeptLeadership(
      "INTERIOR", "project", projectId,
      `Design frozen — ${project.project_code} (${project.customer})`,
      `ડિઝાઇન ફ્રીઝ થઈ — ${project.project_code} (${project.customer})`,
    );
    refreshProject(data);
  }

  async function handleDeleteProject() {
    setBusy(true);
    setDeleteMsg("");
    const { error: err } = await deleteProject(projectId);
    setBusy(false);
    if (err) { setDeleteMsg(err.message); return; }
    setDeleteConfirm(false);
    setProjects((ps) => ps.filter((p) => p.id !== projectId));
    setProjectId("");
  }

  const stageIndex = useMemo(() => (project ? STAGES.indexOf(project.stage) : -1), [project]);
  const freezeStageIndex = STAGES.indexOf("Design Freeze");

  async function advanceStage() {
    if (!project || stageIndex < 0 || stageIndex >= STAGES.length - 1) return;
    setStageMsg("");
    setBusy(true);

    const { data: changes } = await listProjectChanges(projectId);
    if ((changes || []).some((c) => c.approval_status === "PENDING")) {
      setBusy(false);
      setStageMsg(t("stageBlockedChange", lang));
      return;
    }

    const nextStage = STAGES[stageIndex + 1];
    const nextIndex = stageIndex + 1;
    if (nextIndex > freezeStageIndex && !project.frozen) {
      setBusy(false);
      setStageMsg(t("stageBlockedFreeze", lang));
      return;
    }
    if (nextStage === "Completed") {
      const { hasOpen } = await hasOpenMajorSnag(projectId);
      if (hasOpen) {
        setBusy(false);
        setStageMsg(t("closeProjectBlocked", lang));
        return;
      }
    }

    const { data, error: err } = await updateProjectField(projectId, "stage", nextStage);
    setBusy(false);
    if (err) { setStageMsg(err.message); return; }
    notifyDeptLeadership(
      "INTERIOR", "project", projectId,
      `Stage advanced: ${project.stage} → ${nextStage} — ${project.project_code} (${project.customer})`,
      `તબક્કો આગળ વધ્યો: ${project.stage} → ${nextStage}`,
    );
    refreshProject(data);
  }

  const canFreezeNow = project && FREEZE_FIELDS.every(([f]) => project[f]);

  // "Full access" to a project = its owner (PM), designer, execution lead,
  // or anyone added to project_members; Head/Director manage every
  // project's team regardless. Same set InteriorTasks uses to decide who
  // may delegate tasks on this project.
  const isOwner = !!(project && myProfile?.id && project.project_manager_id === myProfile.id);
  const canManageTeam = isOwner || myProfile?.role === "head" || myProfile?.role === "director";
  const teamMemberIds = project ? Array.from(new Set([project.designer_id, project.execution_id, ...team.map((m) => m.profile_id)].filter(Boolean))) : [];
  const addableMembers = people.filter((p) => p.id !== project?.project_manager_id && !teamMemberIds.includes(p.id));

  async function handleAddMember() {
    if (!newMemberId || !projectId) return;
    setTeamBusy(true);
    const { error: err } = await addProjectMember(projectId, newMemberId);
    setTeamBusy(false);
    if (!err) {
      notifyInteriorAssignment(newMemberId, "project", projectId, `Added to project team: ${project.customer} (${project.project_code})`, `પ્રોજેક્ટ ટીમમાં ઉમેરાયા: ${project.customer} (${project.project_code})`);
      setNewMemberId("");
      loadTeam();
    }
  }

  async function handleRemoveMember(profileId) {
    setTeamBusy(true);
    const { error: err } = await removeProjectMember(projectId, profileId);
    setTeamBusy(false);
    if (!err) loadTeam();
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
        <div className="dept-header-icon" aria-hidden="true">🗓️</div>
        <div className="dept-header-text">
          <h1>{t("interiorTimelineTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="field-action-row">
          <div className="field">
            <label>{t("projectCodeLabel", lang)}</label>
            {lockedProjectId ? (
              <div className="sub" style={{ fontWeight: 700, marginTop: 4 }}>{project ? `${project.project_code} — ${project.customer}` : "—"}</div>
            ) : (
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
              </select>
            )}
          </div>
          {!lockedProjectId && (
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-outline" onClick={() => navigate("/interior-projects/tasks")} disabled={!projectId}>
                {t("manageTasksAction", lang)}
              </button>
              <button className="btn btn-outline" onClick={() => navigate("/interior-projects/new")}>
                {t("addNewProject", lang)}
              </button>
            </div>
          )}
        </div>
      </div>

      {project && (
        <div className="card">
          <h2>{t("projectTeamTitle", lang)}</h2>
          <div className="task-meta" style={{ marginTop: 0, padding: "4px 0" }}>
            <span className="badge VERIFIED">{t("projectOwnerBadge", lang)}</span>
            <span>{personName(project.project_manager_id)}</span>
          </div>
          {project.designer_id && (
            <div className="task-meta" style={{ padding: "4px 0" }}>
              <span className="badge ASSIGNED">{t("interiorRole_designer", lang)}</span>
              <span>{personName(project.designer_id)}</span>
            </div>
          )}
          {project.execution_id && (
            <div className="task-meta" style={{ padding: "4px 0" }}>
              <span className="badge ASSIGNED">{t("interiorRole_execution", lang)}</span>
              <span>{personName(project.execution_id)}</span>
            </div>
          )}
          {team.map((m) => (
            <div key={m.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <span>{personName(m.profile_id)}</span>
              {canManageTeam && (
                <button className="btn btn-outline" disabled={teamBusy} onClick={() => handleRemoveMember(m.profile_id)}>{t("removeMember", lang)}</button>
              )}
            </div>
          ))}
          {canManageTeam && (
            <div className="field-action-row" style={{ marginTop: 10 }}>
              <div className="field">
                <label>{t("addTeamMemberLabel", lang)}</label>
                <select value={newMemberId} onChange={(e) => setNewMemberId(e.target.value)}>
                  <option value="">—</option>
                  {addableMembers.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.role})</option>)}
                </select>
              </div>
              <button className="btn btn-primary" disabled={teamBusy || !newMemberId} onClick={handleAddMember}>{t("addTeamMemberLabel", lang)}</button>
            </div>
          )}
          {!canManageTeam && <div className="msg info" style={{ marginTop: 10 }}>{t("taskAssignRestricted", lang)}</div>}
        </div>
      )}

      {project && (
        <div className="dept-meta-grid">
          <div className="card dept-meta-tile"><div className="label">{t("stageLabel", lang)}</div><div className="value">{project.stage}</div></div>
          <div className="card dept-meta-tile"><div className="label">{t("projectValueLabel", lang)}</div><div className="value">{formatCurrency(project.project_value)}</div></div>
          <div className="card dept-meta-tile"><div className="label">{t("dueDateLabel", lang)}</div><div className="value">{project.due_date || "—"}</div></div>
          <div className="card dept-meta-tile"><div className="label">{t("lastUpdateLabel", lang)}</div><div className="value">{project.last_update || "—"}</div></div>
        </div>
      )}

      {project && stageIndex >= 0 && stageIndex < STAGES.length - 1 && (
        <div className="card">
          <h2>{t("advanceStage", lang)}</h2>
          <div className="task-meta" style={{ marginTop: 0, alignItems: "center" }}>
            <span className="badge ASSIGNED">{project.stage}</span>
            <span aria-hidden="true">→</span>
            <span className="badge VERIFIED">{STAGES[stageIndex + 1]}</span>
          </div>
          {stageMsg && <div className="msg error" style={{ marginTop: 10 }}>{stageMsg}</div>}
          <button className="btn btn-primary" style={{ marginTop: 10 }} disabled={busy} onClick={advanceStage}>{t("advanceStage", lang)}</button>
        </div>
      )}

      {project && !project.frozen && (
        <div className="card">
          <h2>{t("designFreezeTitle", lang)}</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {FREEZE_FIELDS.map(([field, labelKey]) => (
              <label key={field} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input type="checkbox" checked={!!project[field]} disabled={busy} onChange={(e) => toggleFreezeCheck(field, e.target.checked)} />
                <span>{t(labelKey, lang)}</span>
              </label>
            ))}
          </div>
          {!canFreezeNow && <div className="msg info" style={{ marginTop: 10 }}>{t("allChecksRequired", lang)}</div>}
          <button className="btn btn-primary" style={{ marginTop: 10 }} disabled={busy || !canFreezeNow} onClick={doFreeze}>{t("freezeProjectAction", lang)}</button>
        </div>
      )}
      {project && project.frozen && (
        <div className="card">
          <div className="task-meta" style={{ marginTop: 0, alignItems: "center" }}>
            <span className="badge CLOSED">{t("projectFrozenLabel", lang)}</span>
            <span>{project.freeze_date}</span>
          </div>
        </div>
      )}

      {project && (
        <div className="card">
          <h2>{t("interiorProjectDetailsTitle", lang)}</h2>
          <form onSubmit={saveDetails} className="form-grid">
            <div className="field">
              <label>{t("interiorLocationLabel", lang)}</label>
              <input value={details.location} onChange={(e) => setDetails((d) => ({ ...d, location: e.target.value }))} />
            </div>
            <div className="field">
              <label>{t("startDateLabel", lang)}</label>
              <input type="date" value={details.start_date} onChange={(e) => setDetails((d) => ({ ...d, start_date: e.target.value }))} />
            </div>
            <div className="field">
              <label>{t("nextUpdateLabel", lang)}</label>
              <input type="date" value={details.next_update} onChange={(e) => setDetails((d) => ({ ...d, next_update: e.target.value }))} />
            </div>
            <div className="field">
              <label>{t("onTimeLabel", lang)}</label>
              <div className="btn-row" style={{ marginTop: 0 }}>
                <button type="button" className={`btn ${details.on_time === true ? "btn-primary" : "btn-outline"}`} onClick={() => setDetails((d) => ({ ...d, on_time: true }))}>{t("yesLabel", lang)}</button>
                <button type="button" className={`btn ${details.on_time === false ? "btn-primary" : "btn-outline"}`} onClick={() => setDetails((d) => ({ ...d, on_time: false }))}>{t("noLabel", lang)}</button>
              </div>
            </div>
            <div className="field full">
              <label>{t("nextActionLabel", lang)}</label>
              <textarea value={details.next_action} onChange={(e) => setDetails((d) => ({ ...d, next_action: e.target.value }))} />
            </div>
            <div className="field full">
              <label>{t("remarksLabel", lang)}</label>
              <textarea value={details.remarks} onChange={(e) => setDetails((d) => ({ ...d, remarks: e.target.value }))} />
            </div>
            <div className="field full">
              <button className="btn btn-primary" type="submit" disabled={saving}>{t("save", lang)}</button>
            </div>
          </form>
        </div>
      )}

      {project && canDeleteProject && (
        <div className="card">
          <h2>{t("deleteProjectAction", lang)}</h2>
          {!deleteConfirm ? (
            <button className="btn btn-outline" onClick={() => setDeleteConfirm(true)}>{t("deleteProjectAction", lang)}</button>
          ) : (
            <div className="msg error">
              {t("confirmDeleteProject", lang)}
              {deleteMsg && <div style={{ marginTop: 6 }}>{deleteMsg}</div>}
              <div className="btn-row">
                <button className="btn btn-primary" disabled={busy} onClick={handleDeleteProject}>{t("confirmDelete", lang)}</button>
                <button className="btn btn-outline" onClick={() => { setDeleteConfirm(false); setDeleteMsg(""); }}>{t("cancel", lang)}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
