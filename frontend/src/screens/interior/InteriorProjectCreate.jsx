import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import { listActiveInteriorEmployees, addProjectMember, notifyInteriorAssignment, notifyDeptLeadership } from "../../lib/interiorApi";

// New Project. Ownership model: Lead Executive (required, replaces the old
// "Project Manager") + optional Executive Assistant — both selected from
// the single realtime active-employee source (listActiveInteriorEmployees(),
// interior_list_active_employees() RPC), not filtered to any old functional
// role, since any authorised active Interior employee is eligible. 3D
// Designer is no longer collected here at all — designer_id stays on the
// table for historical projects but is never written by new creates.
// project_code continues the existing MOW-<number> sequence.
export default function InteriorProjectCreate({ lang }) {
  const navigate = useNavigate();
  const profile = useInteriorProfile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [people, setPeople] = useState([]);
  const [nextCode, setNextCode] = useState("");
  const [form, setForm] = useState({
    customer: "", location: "", project_value: "", lead_executive_id: "", executive_assistant_id: "",
    due_date: "", next_action: "",
  });
  const [extraMembers, setExtraMembers] = useState([]);
  const [sameEmployeeError, setSameEmployeeError] = useState(false);

  const canCreate = profile && ["director", "head", "pm"].includes(profile.role);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [peopleRes, codesRes] = await Promise.all([
      listActiveInteriorEmployees(),
      supabase.from("projects").select("project_code"),
    ]);
    if (peopleRes.error || codesRes.error) { setError(true); setLoading(false); return; }
    setPeople(peopleRes.data || []);
    const maxNum = (codesRes.data || [])
      .map((p) => parseInt((p.project_code || "").replace(/\D/g, ""), 10))
      .filter((n) => !Number.isNaN(n))
      .reduce((a, b) => Math.max(a, b), 100);
    setNextCode(`MOW-${maxNum + 1}`);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Realtime: the same live active-employee source everywhere else uses —
  // a newly created Interior employee (synced automatically the moment
  // their account is created, no login required) shows up in this
  // already-open form without a refresh.
  useEffect(() => {
    const channel = supabase
      .channel("interior_project_create_people")
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  const employeeLabel = useCallback((p) => `${p.name} — ${p.employee_code || "—"} — ${lang === "gu" ? p.role_label_gu : p.role_label_en}`, [lang]);

  // Executive Assistant candidates exclude whoever is currently the Lead
  // Executive — the two can never be the same person.
  const executiveAssistantCandidates = useMemo(
    () => people.filter((p) => p.id !== form.lead_executive_id),
    [people, form.lead_executive_id],
  );

  function selectLeadExecutive(id) {
    setForm((f) => ({ ...f, lead_executive_id: id, executive_assistant_id: f.executive_assistant_id === id ? "" : f.executive_assistant_id }));
    setSameEmployeeError(false);
  }

  // Additional Team Members must never include whoever is currently Lead
  // Executive or Executive Assistant — prune immediately when either
  // selection changes, not just filter them out of the visible checklist.
  useEffect(() => {
    setExtraMembers((cur) => cur.filter((id) => id !== form.lead_executive_id && id !== form.executive_assistant_id));
  }, [form.lead_executive_id, form.executive_assistant_id]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.customer || !form.lead_executive_id || !form.due_date || !form.next_action) return;
    if (form.executive_assistant_id && form.executive_assistant_id === form.lead_executive_id) {
      setSameEmployeeError(true);
      return;
    }
    setSaving(true);
    const { data, error: err } = await supabase.from("projects").insert({
      project_code: nextCode,
      customer: form.customer,
      location: form.location || null,
      project_value: form.project_value ? Number(form.project_value) : 0,
      lead_executive_id: form.lead_executive_id,
      executive_assistant_id: form.executive_assistant_id || null,
      due_date: form.due_date,
      next_action: form.next_action,
      stage: "Quotation",
      created_by: profile?.id || null,
    }).select().single();
    setSaving(false);
    if (err) { setError(true); return; }

    // Lead Executive = project owner with full access; Executive Assistant
    // plus any hand-picked extras join project_members so InteriorTimeline's
    // team panel and InteriorTasks' assignee picker both see them from the
    // start. Every one of them gets an assignment notification.
    const teamIds = Array.from(new Set([form.executive_assistant_id, ...extraMembers].filter(Boolean)));
    await Promise.all(teamIds.map((pid) => addProjectMember(data.id, pid)));
    const notifyIds = Array.from(new Set([form.lead_executive_id, ...teamIds]));
    notifyIds.forEach((pid) => {
      notifyInteriorAssignment(pid, "project", data.id, `New project assigned: ${data.customer} (${data.project_code})`, `નવો પ્રોજેક્ટ સોંપાયેલ: ${data.customer} (${data.project_code})`);
    });
    notifyDeptLeadership(
      "INTERIOR", "project", data.id,
      `New project created: ${data.customer} (${data.project_code})`,
      `નવો પ્રોજેક્ટ બન્યો: ${data.customer} (${data.project_code})`,
    );

    navigate(`/interior-projects/detail/${data.id}`);
  }

  if (loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 220 }} /></div>;
  if (error) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">{t("loadErrorRetry", lang)}</div>
        <button className="btn btn-primary" onClick={load}>{t("retry", lang)}</button>
      </div>
    );
  }
  if (!canCreate) {
    return (
      <div className="dept-dashboard">
        <div className="card">
          <div className="msg info">{t("interiorCreateRestricted", lang)}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">➕</div>
        <div className="dept-header-text">
          <h1>{t("interiorNewProjectTitle", lang)}</h1>
          <div className="sub">{nextCode}</div>
        </div>
      </div>

      <div className="card">
        <form onSubmit={handleSubmit} className="form-grid">
          <div className="field full">
            <label>{t("customerNameLabel", lang)} *</label>
            <input value={form.customer} onChange={(e) => setForm((f) => ({ ...f, customer: e.target.value }))} required />
          </div>
          <div className="field">
            <label>{t("interiorLocationLabel", lang)}</label>
            <input value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} />
          </div>
          <div className="field">
            <label>{t("projectValueLabel", lang)}</label>
            <input type="number" min="0" value={form.project_value} onChange={(e) => setForm((f) => ({ ...f, project_value: e.target.value }))} />
          </div>
          <div className="field full">
            <label>{t("leadExecutiveLabel", lang)} *</label>
            <select value={form.lead_executive_id} onChange={(e) => selectLeadExecutive(e.target.value)} required>
              <option value="" disabled>{t("selectLeadExecutivePlaceholder", lang)}</option>
              {people.map((p) => <option key={p.id} value={p.id}>{employeeLabel(p)}</option>)}
            </select>
            {people.length === 0 && <div className="msg info" style={{ marginTop: 6 }}>{t("noActiveEmployeeFoundMsg", lang)}</div>}
          </div>
          <div className="field full">
            <label>{t("executiveAssistantLabel", lang)}</label>
            <select
              value={form.executive_assistant_id}
              onChange={(e) => { setForm((f) => ({ ...f, executive_assistant_id: e.target.value })); setSameEmployeeError(false); }}
            >
              <option value="">{t("selectExecutiveAssistantPlaceholder", lang)}</option>
              {executiveAssistantCandidates.map((p) => <option key={p.id} value={p.id}>{employeeLabel(p)}</option>)}
            </select>
            {sameEmployeeError && <div className="msg error" style={{ marginTop: 6 }}>{t("leadExecutiveAssistantSamePersonMsg", lang)}</div>}
          </div>
          <div className="field">
            <label>{t("dueDateLabel", lang)} *</label>
            <input type="date" value={form.due_date} onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))} required />
          </div>
          <div className="field full">
            <label>{t("nextActionLabel", lang)} *</label>
            <input value={form.next_action} onChange={(e) => setForm((f) => ({ ...f, next_action: e.target.value }))} required />
          </div>
          <div className="field full">
            <label>{t("extraTeamMembersLabel", lang)}</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {people
                .filter((p) => p.id !== form.lead_executive_id && p.id !== form.executive_assistant_id)
                .map((p) => (
                  <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={extraMembers.includes(p.id)}
                      onChange={(e) => setExtraMembers((cur) => (e.target.checked ? [...cur, p.id] : cur.filter((id) => id !== p.id)))}
                    />
                    <span>{employeeLabel(p)}</span>
                  </label>
                ))}
            </div>
          </div>
          <div className="field full">
            <button className="btn btn-primary" type="submit" disabled={saving}>{t("save", lang)}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
