import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { statusBadgeClass, fetchDepartmentMembers, notifyAssignment } from "../../lib/retailModules";

// Display & Visual Merchandising — retail_vm_tasks.
export default function RetailDisplay({ lang, lookups }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [members, setMembers] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", due_date: "", assigned_to: "" });

  const retailDept = useMemo(() => lookups.departments.find((d) => d.code === "RETAIL"), [lookups.departments]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [vmRes, membersRes] = await Promise.all([
      supabase.from("retail_vm_tasks").select("*").eq("is_active", true).order("created_at", { ascending: false }).limit(200),
      fetchDepartmentMembers(retailDept?.id),
    ]);
    if (vmRes.error) { setError(true); setLoading(false); return; }
    setRows(vmRes.data || []);
    setMembers(membersRes);
    setLoading(false);
  }, [retailDept?.id]);

  useEffect(() => { load(); }, [load]);

  const memberName = useCallback((id) => members.find((m) => m.id === id)?.full_name || "—", [members]);

  async function handleAdd(e) {
    e.preventDefault();
    if (!form.title || !retailDept) return;
    setSaving(true);
    const { error: err } = await supabase.from("retail_vm_tasks").insert({
      department_id: retailDept.id, title: form.title, description: form.description || null, due_date: form.due_date || null,
      assigned_to: form.assigned_to || null,
    });
    setSaving(false);
    if (err) { setError(true); return; }
    setForm({ title: "", description: "", due_date: "", assigned_to: "" });
    setShowForm(false);
    load();
  }

  async function markDone(id) {
    const { error: err } = await supabase.from("retail_vm_tasks").update({ status: "DONE" }).eq("id", id);
    if (!err) load();
  }

  async function updateAssignee(id, assignedTo) {
    const { error: err } = await supabase.from("retail_vm_tasks").update({ assigned_to: assignedTo || null }).eq("id", id);
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
        <div className="dept-header-icon" aria-hidden="true">🖼️</div>
        <div className="dept-header-text"><h1>{t("retailDisplayTitle", lang)}</h1></div>
      </div>

      <div className="card">
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>{showForm ? t("cancel", lang) : t("addNew", lang)}</button>
        {showForm && (
          <form onSubmit={handleAdd} className="form-grid" style={{ marginTop: 12 }}>
            <div className="field full">
              <label>{t("titleLabel", lang)} *</label>
              <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} required />
            </div>
            <div className="field">
              <label>{t("dueDateLabel", lang)}</label>
              <input type="date" value={form.due_date} onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))} />
            </div>
            <div className="field">
              <label>{t("assignedToLabel", lang)}</label>
              <select value={form.assigned_to} onChange={(e) => setForm((f) => ({ ...f, assigned_to: e.target.value }))}>
                <option value="">—</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
              </select>
            </div>
            <div className="field full">
              <label>{t("descriptionLabel", lang)}</label>
              <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="field full">
              <button className="btn btn-primary" type="submit" disabled={saving}>{t("save", lang)}</button>
            </div>
          </form>
        )}
      </div>

      <div className="card">
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontWeight: 700 }}>{r.title}</div>
              <div className="sub">{r.due_date || "—"} {r.assigned_to ? `· ${memberName(r.assigned_to)}` : ""}</div>
            </div>
            <select value={r.assigned_to || ""} onChange={(e) => updateAssignee(r.id, e.target.value)} title={t("assignedToLabel", lang)}>
              <option value="">{t("assignedToLabel", lang)}: —</option>
              {members.map((m) => <option key={m.id} value={m.id}>{memberName(m.id)}</option>)}
            </select>
            <span className={`badge ${statusBadgeClass(r.status)}`}>{r.status}</span>
            {r.status !== "DONE" && <button className="btn btn-outline" onClick={() => markDone(r.id)}>{t("markDone", lang)}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
