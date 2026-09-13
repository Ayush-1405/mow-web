import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import {
  listProjects, listSiteReports, createSiteReport, notifyDeptLeadership,
  listAssignableInteriorPeople, listProjectTeamIds, createProjectTask, listProjectStaffTasks,
} from "../../lib/interiorApi";

// Daily Site Update — md/MOOD-OF-WOOD-SYSTEM.md §5. Today's Work and
// Tomorrow's Plan are now structured, person-wise work items (title +
// mandatory assignee + due date + priority) instead of free-text chips —
// each becomes a REAL linked staff_tasks row on submit (see
// interiorApi.createProjectTask / mvp_pilot_daily_update_tasks_v2_38.sql),
// not a typed @name. Material Required / Any Issue / Remarks are
// unchanged from the original flow.
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];
const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

function ChipInput({ value, onChange, placeholder }) {
  const [draft, setDraft] = useState("");
  function commit() {
    const v = draft.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setDraft("");
  }
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        {value.map((chip) => (
          <span key={chip} className="badge ASSIGNED" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {chip}
            <button type="button" onClick={() => onChange(value.filter((c) => c !== chip))} style={{ border: "none", background: "none", cursor: "pointer", color: "inherit", fontWeight: 700 }}>✕</button>
          </span>
        ))}
      </div>
      <input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
        onBlur={commit}
      />
    </div>
  );
}

function emptyItem(dueDate) {
  return { id: crypto.randomUUID(), title: "", assignedTo: "", dueDate, priority: "NORMAL" };
}

// One row: title / assign-to / due date / priority / remove — reused for
// both Today's Work and Tomorrow's Plan.
function WorkItemRow({ lang, item, candidates, onChange, onRemove, showError }) {
  return (
    <div className="card" style={{ padding: 10, marginBottom: 8, borderColor: showError ? "var(--danger)" : undefined }}>
      <div className="form-grid">
        <div className="field full">
          <label>{t("workTitleLabel", lang)}</label>
          <input value={item.title} onChange={(e) => onChange({ ...item, title: e.target.value })} placeholder={t("workTitleLabel", lang)} />
        </div>
        <div className="field">
          <label>{t("assignToLabel", lang)} *</label>
          <select value={item.assignedTo} onChange={(e) => onChange({ ...item, assignedTo: e.target.value })}>
            <option value="">—</option>
            {candidates.team.length > 0 && (
              <optgroup label={t("projectTeamLabel", lang)}>
                {candidates.team.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.role}</option>)}
              </optgroup>
            )}
            {candidates.others.length > 0 && (
              <optgroup label={t("otherTeamMembersLabel", lang)}>
                {candidates.others.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.role}</option>)}
              </optgroup>
            )}
          </select>
        </div>
        <div className="field">
          <label>{t("dueDateLabel", lang)}</label>
          <input type="date" value={item.dueDate} onChange={(e) => onChange({ ...item, dueDate: e.target.value })} />
        </div>
        <div className="field">
          <label>{t("priorityLabel", lang)}</label>
          <select value={item.priority} onChange={(e) => onChange({ ...item, priority: e.target.value })}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="field" style={{ display: "flex", alignItems: "flex-end" }}>
          <button type="button" className="btn btn-outline" style={{ marginTop: 0 }} onClick={onRemove}>✕ {t("removeItemAction", lang)}</button>
        </div>
      </div>
      {showError && <div className="msg error" style={{ marginTop: 6 }}>{t("assignWorkRequiredMsg", lang)}</div>}
    </div>
  );
}

export default function InteriorDailyUpdates({ lang, lockedProjectId }) {
  const navigate = useNavigate();
  const profile = useInteriorProfile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [people, setPeople] = useState([]);
  const [teamIds, setTeamIds] = useState([]);
  const [rows, setRows] = useState([]);
  const [reportTasks, setReportTasks] = useState([]);
  const [statusById, setStatusById] = useState({});
  const [priorityById, setPriorityById] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [invalidIds, setInvalidIds] = useState(new Set());

  const [todaysWork, setTodaysWork] = useState([emptyItem(today())]);
  const [tomorrowPlan, setTomorrowPlan] = useState([emptyItem(tomorrow())]);
  const [assignAllTo, setAssignAllTo] = useState("");

  const [materialRequired, setMaterialRequired] = useState(false);
  const [materials, setMaterials] = useState([]);
  const [materialRemark, setMaterialRemark] = useState("");
  const [issuePresent, setIssuePresent] = useState(false);
  const [issueText, setIssueText] = useState("");
  const [remarks, setRemarks] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data, error: err }, peopleRes] = await Promise.all([listProjects(), listAssignableInteriorPeople()]);
    if (err) { setError(true); setLoading(false); return; }
    setProjects(data || []);
    setPeople(peopleRes.data || []);
    if (data?.length) setProjectId((cur) => cur || lockedProjectId || data[0].id);
    setLoading(false);
  }, [lockedProjectId]);

  useEffect(() => { load(); }, [load]);

  // Small, static lookups (not otherwise available to this screen) needed
  // only to display a linked staff_tasks row's real status/priority text.
  useEffect(() => {
    supabase.from("status_master").select("id, code, name_en, name_gu").then(({ data }) => {
      setStatusById(Object.fromEntries((data || []).map((s) => [s.id, s])));
    });
    supabase.from("priority_master").select("id, code, name_en, name_gu").then(({ data }) => {
      setPriorityById(Object.fromEntries((data || []).map((p) => [p.id, p])));
    });
  }, []);

  const project = projects.find((p) => p.id === projectId);

  useEffect(() => {
    if (!project) { setTeamIds([]); return; }
    listProjectTeamIds(project).then(setTeamIds);
  }, [project]);

  const candidates = useMemo(() => {
    const team = people.filter((p) => teamIds.includes(p.id));
    const others = people.filter((p) => !teamIds.includes(p.id));
    return { team, others };
  }, [people, teamIds]);

  const loadReports = useCallback(async () => {
    if (!projectId) { setRows([]); setReportTasks([]); return; }
    const [{ data, error: err }, tasksRes] = await Promise.all([listSiteReports(projectId), listProjectStaffTasks(projectId)]);
    if (!err) setRows(data || []);
    setReportTasks(tasksRes.data || []);
  }, [projectId]);

  useEffect(() => { loadReports(); setSaveMsg(""); }, [loadReports]);

  function updateItem(list, setList, id, next) {
    setList(list.map((it) => (it.id === id ? next : it)));
  }

  function handleAssignAll() {
    if (!assignAllTo) return;
    const apply = (list) => list.map((it) => (it.title.trim() && !it.assignedTo ? { ...it, assignedTo: assignAllTo } : it));
    setTodaysWork((list) => apply(list));
    setTomorrowPlan((list) => apply(list));
  }

  async function handleSend(e) {
    e.preventDefault();
    if (!projectId) return;

    const activeToday = todaysWork.filter((it) => it.title.trim());
    const activeTomorrow = tomorrowPlan.filter((it) => it.title.trim());
    const missing = new Set([...activeToday, ...activeTomorrow].filter((it) => !it.assignedTo).map((it) => it.id));
    if (missing.size > 0) {
      setInvalidIds(missing);
      setSaveMsg(t("assignWorkRequiredMsg", lang));
      return;
    }
    setInvalidIds(new Set());

    setSaving(true);
    setSaveMsg(t("savingUpdateMsg", lang));

    const { data: report, error: err } = await createSiteReport({
      project_id: projectId,
      report_date: new Date().toISOString().slice(0, 10),
      work_today: activeToday.map((it) => it.title).join(", ") || null,
      work_done: null,
      work_pending: activeToday.length ? activeToday.map((it) => it.title).join(", ") : t("noneLabel", lang),
      material: materialRequired && materials.length ? materials.join(", ") : null,
      issue: issuePresent ? issueText : null,
      tomorrow_plan: activeTomorrow.map((it) => it.title).join(", ") || null,
      remarks: remarks || null,
      submitted_by: profile?.id || null,
    });
    if (err) { setSaving(false); setSaveMsg(t("errorSaving", lang)); return; }

    if (materialRequired && materials.length) {
      await supabase.from("project_materials").insert(
        materials.map((m) => ({
          project_id: projectId, material: m, status: "Pending to Order",
          source: "daily-update", site_report_id: report.id, remark: materialRemark || null,
          requested_by: profile?.id || null,
        })),
      );
    }

    // Every assigned item -> one real staff_tasks row via the idempotent
    // RPC (source_site_report_id + source_work_item_id + assigned_to is
    // the DB-level dedup key) -- a failure here is surfaced verbatim, the
    // already-created report and any already-created tasks are kept, not
    // rolled back (matches "if task creation fails, show the exact error").
    const toCreate = [
      ...activeToday.map((it) => ({ ...it, sourceType: "todays_work" })),
      ...activeTomorrow.map((it) => ({ ...it, sourceType: "tomorrows_plan" })),
    ];
    const taskErrors = [];
    for (const it of toCreate) {
      const assignee = people.find((p) => p.id === it.assignedTo);
      const { error: taskErr } = await createProjectTask({
        projectId, title: it.title.trim(), assignedTo: assignee?.auth_id, dueDate: it.dueDate || today(),
        priorityCode: it.priority, sourceSiteReportId: report.id, sourceWorkItemId: it.id, sourceType: it.sourceType,
      });
      if (taskErr) taskErrors.push(`${it.title}: ${taskErr.message}`);
    }

    const projectLabel = project ? `${project.project_code} — ${project.customer}` : "";
    notifyDeptLeadership(
      "INTERIOR", "site_report", report.id,
      `Daily update submitted: ${projectLabel}`,
      `દૈનિક અપડેટ સબમિટ થયું: ${projectLabel}`,
    );

    setSaving(false);
    if (taskErrors.length) {
      setSaveMsg(`${t("errorSaving", lang)}: ${taskErrors.join("; ")}`);
    } else {
      setSaveMsg(t("saved", lang));
    }
    setTodaysWork([emptyItem(today())]);
    setTomorrowPlan([emptyItem(tomorrow())]);
    setAssignAllTo("");
    setMaterialRequired(false); setMaterials([]); setMaterialRemark("");
    setIssuePresent(false); setIssueText(""); setRemarks("");
    loadReports();
  }

  function personNameByAuthId(authId) {
    return people.find((p) => p.auth_id === authId)?.name || "—";
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
        <div className="dept-header-icon" aria-hidden="true">📝</div>
        <div className="dept-header-text">
          <h1>{t("interiorDailyUpdatesTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
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
      </div>

      <div className="card">
        <form onSubmit={handleSend}>
          <div className="field full" style={{ marginBottom: 6 }}>
            <label>{t("assignAllToLabel", lang)}</label>
            <div className="btn-row" style={{ marginTop: 0 }}>
              <select value={assignAllTo} onChange={(e) => setAssignAllTo(e.target.value)}>
                <option value="">—</option>
                {candidates.team.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.role}</option>)}
                {candidates.others.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.role}</option>)}
              </select>
              <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={handleAssignAll} disabled={!assignAllTo}>
                {t("applyToUnassignedAction", lang)}
              </button>
            </div>
          </div>

          <h3>{t("todaysWorkStep", lang)}</h3>
          {todaysWork.map((item) => (
            <WorkItemRow key={item.id} lang={lang} item={item} candidates={candidates} showError={invalidIds.has(item.id)}
              onChange={(next) => updateItem(todaysWork, setTodaysWork, item.id, next)}
              onRemove={() => setTodaysWork(todaysWork.filter((it) => it.id !== item.id))} />
          ))}
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setTodaysWork([...todaysWork, emptyItem(today())])}>
            + {t("addWorkItemAction", lang)}
          </button>

          <h3 style={{ marginTop: 16 }}>{t("materialRequiredQ", lang)}</h3>
          <div className="btn-row" style={{ marginTop: 0 }}>
            <button type="button" className={`btn ${materialRequired ? "btn-primary" : "btn-outline"}`} onClick={() => setMaterialRequired(true)}>{t("yesLabel", lang)}</button>
            <button type="button" className={`btn ${!materialRequired ? "btn-primary" : "btn-outline"}`} onClick={() => { setMaterialRequired(false); setMaterials([]); setMaterialRemark(""); }}>{t("noLabel", lang)}</button>
          </div>
          {materialRequired && (
            <div style={{ marginTop: 8 }}>
              <ChipInput value={materials} onChange={setMaterials} placeholder={t("materialItemPlaceholder", lang)} />
              <input placeholder={t("notesLabel", lang)} value={materialRemark} onChange={(e) => setMaterialRemark(e.target.value)} style={{ marginTop: 6 }} />
            </div>
          )}

          <h3 style={{ marginTop: 16 }}>{t("anyIssueQ", lang)}</h3>
          <div className="btn-row" style={{ marginTop: 0 }}>
            <button type="button" className={`btn ${issuePresent ? "btn-primary" : "btn-outline"}`} onClick={() => setIssuePresent(true)}>{t("yesLabel", lang)}</button>
            <button type="button" className={`btn ${!issuePresent ? "btn-primary" : "btn-outline"}`} onClick={() => { setIssuePresent(false); setIssueText(""); }}>{t("noLabel", lang)}</button>
          </div>
          {issuePresent && <textarea style={{ marginTop: 8 }} value={issueText} onChange={(e) => setIssueText(e.target.value)} />}

          <h3 style={{ marginTop: 16 }}>{t("tomorrowPlanStep", lang)}</h3>
          {tomorrowPlan.map((item) => (
            <WorkItemRow key={item.id} lang={lang} item={item} candidates={candidates} showError={invalidIds.has(item.id)}
              onChange={(next) => updateItem(tomorrowPlan, setTomorrowPlan, item.id, next)}
              onRemove={() => setTomorrowPlan(tomorrowPlan.filter((it) => it.id !== item.id))} />
          ))}
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setTomorrowPlan([...tomorrowPlan, emptyItem(tomorrow())])}>
            + {t("addWorkItemAction", lang)}
          </button>

          <div className="field full" style={{ marginTop: 16 }}>
            <label>{t("notesLabel", lang)}</label>
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </div>

          <div className="field full">
            <button className="btn btn-primary" type="submit" disabled={saving || !projectId}>
              {saving ? t("savingUpdateMsg", lang) : t("sendUpdate", lang)}
            </button>
            {saveMsg && <div className="sub" style={{ marginTop: 6 }}>{saveMsg}</div>}
          </div>
        </form>
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => {
          const linkedTasks = reportTasks.filter((tsk) => tsk.source_site_report_id === r.id);
          return (
            <div key={r.id} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
              <div style={{ fontWeight: 700 }}>{r.report_date}</div>
              {linkedTasks.length > 0 ? (
                linkedTasks.map((tsk) => (
                  <div key={tsk.id} className="task-meta" style={{ justifyContent: "space-between", padding: "4px 0", flexWrap: "wrap" }}>
                    <span>{tsk.title}</span>
                    <span className="sub">{t("assignToLabel", lang)}: {personNameByAuthId(tsk.assigned_to)}</span>
                    <span className="sub">{t("dueDateLabel", lang)}: {tsk.due_date}</span>
                    <span className="sub">{t("priorityLabel", lang)}: {lang === "gu" ? priorityById[tsk.priority_id]?.name_gu : priorityById[tsk.priority_id]?.name_en || "—"}</span>
                    <span className={`badge ${statusById[tsk.status_id]?.code || "ASSIGNED"}`}>
                      {lang === "gu" ? statusById[tsk.status_id]?.name_gu : statusById[tsk.status_id]?.name_en || tsk.status_id}
                    </span>
                    <span className="sub">{tsk.source_type === "tomorrows_plan" ? t("tomorrowLabel", lang) : t("todayLabel", lang)}</span>
                    <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => navigate(`/tasks?focus=${tsk.id}`)}>
                      {t("openTaskAction", lang)}
                    </button>
                  </div>
                ))
              ) : (
                <>
                  <div className="sub">{t("todayWorkLabel", lang)}: {r.work_today || "—"}</div>
                  <div className="sub">{t("workPendingAuto", lang)}: {r.work_pending || "—"}</div>
                </>
              )}
              <span className="badge IN_PROGRESS">{r.status}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
