import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { statusBadgeClass, fetchDepartmentMembers, notifyAssignment } from "../../lib/retailModules";

const STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];

// Complaints & Service — retail_complaints, scoped to Retail for this
// round (Customer Service's own ticket system is a separate department,
// out of scope here).
export default function RetailComplaints({ lang, lookups }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [members, setMembers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ customer_name: "", phone: "", description: "", assigned_to: "", order_id: "" });
  const [resolutionDraft, setResolutionDraft] = useState({});

  const retailDept = useMemo(() => lookups.departments.find((d) => d.code === "RETAIL"), [lookups.departments]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [complaintsRes, membersRes, ordersRes] = await Promise.all([
      supabase.from("retail_complaints").select("*").eq("is_active", true).order("created_at", { ascending: false }).limit(200),
      fetchDepartmentMembers(retailDept?.id),
      supabase.from("retail_orders").select("id, order_number, customer_name").eq("is_active", true).order("created_at", { ascending: false }).limit(200),
    ]);
    if (complaintsRes.error) { setError(true); setLoading(false); return; }
    setRows(complaintsRes.data || []);
    setMembers(membersRes);
    setOrders(ordersRes.data || []);
    setLoading(false);
  }, [retailDept?.id]);

  useEffect(() => { load(); }, [load]);

  const memberName = useCallback((id) => members.find((m) => m.id === id)?.full_name || "—", [members]);
  const orderLabel = useCallback((id) => {
    const o = orders.find((ord) => ord.id === id);
    return o ? `${o.order_number} — ${o.customer_name}` : "—";
  }, [orders]);

  async function handleAdd(e) {
    e.preventDefault();
    if (!form.customer_name || !form.description || !retailDept) return;
    setSaving(true);
    const { data, error: err } = await supabase.from("retail_complaints").insert({
      department_id: retailDept.id, customer_name: form.customer_name, phone: form.phone || null, description: form.description,
      assigned_to: form.assigned_to || null, order_id: form.order_id || null,
    }).select().single();
    setSaving(false);
    if (err) { setError(true); return; }
    if (form.assigned_to) {
      notifyAssignment(form.assigned_to, "retail_complaint", data.id, `New complaint assigned: ${data.customer_name}`, `નવી ફરિયાદ સોંપાયેલ: ${data.customer_name}`);
    }
    setForm({ customer_name: "", phone: "", description: "", assigned_to: "", order_id: "" });
    setShowForm(false);
    load();
  }

  async function updateStatus(id, status) {
    const { error: err } = await supabase.from("retail_complaints").update({ status }).eq("id", id);
    if (!err) load();
  }

  async function updateAssignee(id, assignedTo, customerName) {
    const { error: err } = await supabase.from("retail_complaints").update({ assigned_to: assignedTo || null }).eq("id", id);
    if (!err) {
      if (assignedTo) notifyAssignment(assignedTo, "retail_complaint", id, `Complaint assigned to you: ${customerName}`, `તમને ફરિયાદ સોંપાયેલ: ${customerName}`);
      load();
    }
  }

  async function resolve(id) {
    const notes = resolutionDraft[id] || "";
    const { error: err } = await supabase.from("retail_complaints").update({
      status: "RESOLVED", resolution_notes: notes, resolved_at: new Date().toISOString(),
    }).eq("id", id);
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
        <div className="dept-header-icon" aria-hidden="true">☎️</div>
        <div className="dept-header-text"><h1>{t("retailComplaintsTitle", lang)}</h1></div>
      </div>

      <div className="card">
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>{showForm ? t("cancel", lang) : t("addNew", lang)}</button>
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
              <label>{t("assignedToLabel", lang)}</label>
              <select value={form.assigned_to} onChange={(e) => setForm((f) => ({ ...f, assigned_to: e.target.value }))}>
                <option value="">—</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>{t("relatedOrderLabel", lang)}</label>
              <select value={form.order_id} onChange={(e) => setForm((f) => ({ ...f, order_id: e.target.value }))}>
                <option value="">—</option>
                {orders.map((o) => <option key={o.id} value={o.id}>{o.order_number} — {o.customer_name}</option>)}
              </select>
            </div>
            <div className="field full">
              <label>{t("descriptionLabel", lang)} *</label>
              <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} required />
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
          <div key={r.id} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
            <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 700 }}>{r.customer_name}</div>
                <div className="sub">{r.description}</div>
                {r.order_id && <div className="sub">{orderLabel(r.order_id)}</div>}
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
            {r.status !== "RESOLVED" && r.status !== "CLOSED" && (
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <input
                  placeholder={t("resolutionNotesLabel", lang)}
                  value={resolutionDraft[r.id] || ""}
                  onChange={(e) => setResolutionDraft((d) => ({ ...d, [r.id]: e.target.value }))}
                  style={{ flex: 1 }}
                />
                <button className="btn btn-outline" onClick={() => resolve(r.id)}>{t("markResolved", lang)}</button>
              </div>
            )}
            {r.resolution_notes && <div className="sub" style={{ marginTop: 4 }}>{t("resolutionNotesLabel", lang)}: {r.resolution_notes}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
