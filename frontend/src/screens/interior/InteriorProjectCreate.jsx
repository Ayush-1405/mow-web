import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import { addProjectMember, notifyInteriorAssignment, notifyDeptLeadership } from "../../lib/interiorApi";

// New Project — md/MOOD-OF-WOOD-SYSTEM.md §2: "Every project has one PM,
// one designer, one deadline, one stage, one next step. The new-project
// form refuses to save without them." Enforced client-side here (required
// fields) AND the project_code is generated the same way the existing 3
// live projects are named (MOW-<number>), continuing that same sequence
// rather than starting a parallel numbering scheme.
export default function InteriorProjectCreate({ lang }) {
  const navigate = useNavigate();
  const profile = useInteriorProfile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [people, setPeople] = useState([]);
  const [nextCode, setNextCode] = useState("");
  const [form, setForm] = useState({
    customer: "", location: "", project_value: "", project_manager_id: "", designer_id: "",
    due_date: "", next_action: "",
  });
  const [extraMembers, setExtraMembers] = useState([]);

  const canCreate = profile && ["director", "head", "pm"].includes(profile.role);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [peopleRes, codesRes] = await Promise.all([
      supabase.from("profiles").select("id, name, role").eq("active", true).order("name"),
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

  const pms = useMemo(() => people.filter((p) => ["pm", "head", "director"].includes(p.role)), [people]);
  const designers = useMemo(() => people.filter((p) => p.role === "designer"), [people]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.customer || !form.project_manager_id || !form.designer_id || !form.due_date || !form.next_action) return;
    setSaving(true);
    const { data, error: err } = await supabase.from("projects").insert({
      project_code: nextCode,
      customer: form.customer,
      location: form.location || null,
      project_value: form.project_value ? Number(form.project_value) : 0,
      project_manager_id: form.project_manager_id,
      designer_id: form.designer_id,
      due_date: form.due_date,
      next_action: form.next_action,
      stage: "Quotation",
      created_by: profile?.id || null,
    }).select().single();
    setSaving(false);
    if (err) { setError(true); return; }

    // PM = project owner with full access to this project; designer plus
    // any hand-picked extras join project_members so InteriorTimeline's
    // team panel and InteriorTasks' assignee picker both see them from the
    // start. Every one of them gets an assignment notification.
    const teamIds = Array.from(new Set([form.designer_id, ...extraMembers].filter(Boolean)));
    await Promise.all(teamIds.map((pid) => addProjectMember(data.id, pid)));
    const notifyIds = Array.from(new Set([form.project_manager_id, ...teamIds]));
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
          <div className="field">
            <label>{t("interiorRole_pm", lang)} ({t("projectOwnerBadge", lang)}) *</label>
            <select value={form.project_manager_id} onChange={(e) => setForm((f) => ({ ...f, project_manager_id: e.target.value }))} required>
              <option value="" disabled>—</option>
              {pms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>{t("interiorRole_designer", lang)} *</label>
            <select value={form.designer_id} onChange={(e) => setForm((f) => ({ ...f, designer_id: e.target.value }))} required>
              <option value="" disabled>—</option>
              {designers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
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
                .filter((p) => p.id !== form.project_manager_id && p.id !== form.designer_id)
                .map((p) => (
                  <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={extraMembers.includes(p.id)}
                      onChange={(e) => setExtraMembers((cur) => (e.target.checked ? [...cur, p.id] : cur.filter((id) => id !== p.id)))}
                    />
                    <span>{p.name} <span className="sub">({p.role})</span></span>
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
