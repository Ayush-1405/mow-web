import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { statusBadgeClass, fetchDepartmentMembers, notifyAssignment } from "../../lib/retailModules";

const STATUSES = ["NEW", "FOLLOW_UP", "QUOTED", "CONVERTED", "LOST"];

// Walk-in Leads & CRM — a real, working table (retail_leads) scoped by the
// SAME RLS pattern as every other pilot table (see mvp_pilot_retail_
// schema_v2_2b.sql): a plain Retail member sees/edits their own leads,
// a Retail Head sees the whole department, Management sees everything.
export default function RetailLeads({ lang, lookups }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [members, setMembers] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ customer_name: "", phone: "", source: "", interest_notes: "", next_follow_up_date: "", assigned_to: "" });

  const retailDept = useMemo(() => lookups.departments.find((d) => d.code === "RETAIL"), [lookups.departments]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [leadsRes, membersRes] = await Promise.all([
      supabase.from("retail_leads").select("*").eq("is_active", true).order("created_at", { ascending: false }).limit(300),
      fetchDepartmentMembers(retailDept?.id),
    ]);
    if (leadsRes.error) { setError(true); setLoading(false); return; }
    setRows(leadsRes.data || []);
    setMembers(membersRes);
    setLoading(false);
  }, [retailDept?.id]);

  useEffect(() => { load(); }, [load]);

  const memberName = useCallback((id) => members.find((m) => m.id === id)?.full_name || "—", [members]);

  async function handleAdd(e) {
    e.preventDefault();
    if (!form.customer_name || !retailDept) return;
    setSaving(true);
    const { data, error: err } = await supabase.from("retail_leads").insert({
      department_id: retailDept.id,
      customer_name: form.customer_name,
      phone: form.phone || null,
      source: form.source || null,
      interest_notes: form.interest_notes || null,
      next_follow_up_date: form.next_follow_up_date || null,
      assigned_to: form.assigned_to || null,
    }).select().single();
    setSaving(false);
    if (err) { setError(true); return; }
    if (form.assigned_to) {
      notifyAssignment(form.assigned_to, "retail_lead", data.id, `New lead assigned: ${data.customer_name}`, `નવી લીડ સોંપાયેલ: ${data.customer_name}`);
    }
    setForm({ customer_name: "", phone: "", source: "", interest_notes: "", next_follow_up_date: "", assigned_to: "" });
    setShowForm(false);
    load();
  }

  async function updateStatus(id, status) {
    const { error: err } = await supabase.from("retail_leads").update({ status }).eq("id", id);
    if (!err) load();
  }

  async function updateAssignee(id, assignedTo, customerName) {
    const { error: err } = await supabase.from("retail_leads").update({ assigned_to: assignedTo || null }).eq("id", id);
    if (!err) {
      if (assignedTo) notifyAssignment(assignedTo, "retail_lead", id, `Lead assigned to you: ${customerName}`, `તમને લીડ સોંપાયેલ: ${customerName}`);
      load();
    }
  }

  if (loading) {
    return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 60 }} /><div className="skeleton-block" style={{ height: 220 }} /></div>;
  }
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
        <div className="dept-header-icon" aria-hidden="true">🧾</div>
        <div className="dept-header-text"><h1>{t("retailLeadsTitle", lang)}</h1></div>
      </div>

      <div className="card">
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? t("cancel", lang) : t("addLead", lang)}
        </button>
        {showForm && (
          <form onSubmit={handleAdd} className="form-grid" style={{ marginTop: 12 }}>
            <div className="field full">
              <label>{t("customerNameLabel", lang)} *</label>
              <input value={form.customer_name} onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))} required />
            </div>
            <div className="field">
              <label>{t("phoneLabel", lang)}</label>
              <input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className="field">
              <label>{t("leadSourceLabel", lang)}</label>
              <input value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} />
            </div>
            <div className="field">
              <label>{t("nextFollowUpLabel", lang)}</label>
              <input type="date" value={form.next_follow_up_date} onChange={(e) => setForm((f) => ({ ...f, next_follow_up_date: e.target.value }))} />
            </div>
            <div className="field">
              <label>{t("assignedToLabel", lang)}</label>
              <select value={form.assigned_to} onChange={(e) => setForm((f) => ({ ...f, assigned_to: e.target.value }))}>
                <option value="">—</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
              </select>
            </div>
            <div className="field full">
              <label>{t("notesLabel", lang)}</label>
              <textarea value={form.interest_notes} onChange={(e) => setForm((f) => ({ ...f, interest_notes: e.target.value }))} />
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
              <div style={{ fontWeight: 700 }}>{r.customer_name}</div>
              <div className="sub">{r.phone || "—"} {r.source ? `· ${r.source}` : ""}</div>
            </div>
            <select value={r.assigned_to || ""} onChange={(e) => updateAssignee(r.id, e.target.value, r.customer_name)} title={t("assignedToLabel", lang)}>
              <option value="">{t("assignedToLabel", lang)}: —</option>
              {members.map((m) => <option key={m.id} value={m.id}>{memberName(m.id)}</option>)}
            </select>
            <select value={r.status} onChange={(e) => updateStatus(r.id, e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <span className={`badge ${statusBadgeClass(r.status)}`}>{r.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
