import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";

// Delivery Coordination — same pattern as RetailStockTransfer.jsx: reuses
// the existing staff_tasks/bridges engine (DELIVERY task type) rather than
// a new table, targeting the Dispatch/Logistics department.
export default function RetailDelivery({ lang, profile, lookups }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ title: "", assigned_to: "", due_date: "" });

  const dispatchDept = useMemo(() => lookups.departments.find((d) => d.code === "DISPATCH"), [lookups.departments]);
  const taskType = useMemo(() => lookups.taskTypes.find((tt) => tt.code === "DELIVERY"), [lookups.taskTypes]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [taskRes, usersRes] = await Promise.all([
      supabase.from("staff_tasks").select("*").eq("is_active", true).eq("task_type_id", taskType?.id || "").limit(200),
      supabase.rpc("staff_list_assignable_users_all"),
    ]);
    if (taskRes.error || usersRes.error) { setError(true); setLoading(false); return; }
    setTasks((taskRes.data || []).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")));
    setUsers((usersRes.data || []).filter((u) => u.department_id === dispatchDept?.id));
    setLoading(false);
  }, [taskType, dispatchDept]);

  useEffect(() => { if (taskType) load(); else { setLoading(false); } }, [load, taskType]);

  async function handleRequest(e) {
    e.preventDefault();
    if (!form.title || !form.assigned_to || !form.due_date || !dispatchDept || !taskType) return;
    setSaving(true);
    const { error: err } = await supabase.rpc("staff_create_task", {
      p_title: form.title,
      p_description: null,
      p_task_type_code: taskType.code,
      p_priority_code: "NORMAL",
      p_proof_type_code: "none",
      p_from_department_id: profile.department_id,
      p_to_department_id: dispatchDept.id,
      p_assigned_to: form.assigned_to,
      p_due_date: form.due_date,
    });
    setSaving(false);
    if (err) { setError(true); return; }
    setForm({ title: "", assigned_to: "", due_date: "" });
    setShowForm(false);
    load();
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
        <div className="dept-header-icon" aria-hidden="true">🚛</div>
        <div className="dept-header-text"><h1>{t("retailDeliveryTitle", lang)}</h1></div>
      </div>

      <div className="card">
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)} disabled={!taskType}>
          {showForm ? t("cancel", lang) : t("requestDelivery", lang)}
        </button>
        {showForm && (
          <form onSubmit={handleRequest} className="form-grid" style={{ marginTop: 12 }}>
            <div className="field full">
              <label>{t("titleLabel", lang)} *</label>
              <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} required />
            </div>
            <div className="field">
              <label>{t("assignedToLabel", lang)} *</label>
              <select value={form.assigned_to} onChange={(e) => setForm((f) => ({ ...f, assigned_to: e.target.value }))} required>
                <option value="" disabled>—</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>{t("dueDateLabel", lang)} *</label>
              <input type="date" value={form.due_date} onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))} required />
            </div>
            <div className="field full">
              <button className="btn btn-primary" type="submit" disabled={saving}>{t("save", lang)}</button>
            </div>
          </form>
        )}
      </div>

      <div className="card">
        {tasks.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {tasks.map((tsk) => (
          <div key={tsk.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
            <span>{tsk.task_number} — {tsk.title}</span>
            <span className={`badge ${tsk.closed_at ? "CLOSED" : "ASSIGNED"}`}>{tsk.closed_at ? "CLOSED" : "OPEN"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
