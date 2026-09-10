import React, { useState } from "react";
import { supabase } from "../lib/supabase";
import { t } from "../lib/i18n";

// Department management — Super Admin only (staff_create_department /
// staff_update_department both re-check this server-side too). No delete:
// a department is referenced across user_profiles/staff_tasks/bridges/
// task_types, so is_active := false is the safe equivalent, the same
// pattern already used to "remove" a user via deactivation rather than a
// real DELETE.
export default function AdminDepartments({ lang, lookups, showToast, onChanged }) {
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ code: "", name_en: "", name_gu: "" });
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name_en: "", name_gu: "" });
  const [rowBusy, setRowBusy] = useState(null);

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.code || !form.name_en || !form.name_gu) return;
    setSaving(true);
    const { error } = await supabase.rpc("staff_create_department", {
      p_code: form.code, p_name_en: form.name_en, p_name_gu: form.name_gu,
    });
    setSaving(false);
    if (error) { showToast("error", error.message); return; }
    showToast("success", t("savedSuccess", lang));
    setForm({ code: "", name_en: "", name_gu: "" });
    setShowForm(false);
    onChanged();
  }

  function startEdit(d) {
    setEditingId(d.id);
    setEditForm({ name_en: d.name_en, name_gu: d.name_gu });
  }

  async function saveEdit(id) {
    setRowBusy(id);
    const { error } = await supabase.rpc("staff_update_department", {
      p_department_id: id, p_name_en: editForm.name_en, p_name_gu: editForm.name_gu,
    });
    setRowBusy(null);
    if (error) { showToast("error", error.message); return; }
    setEditingId(null);
    onChanged();
  }

  async function toggleActive(d) {
    setRowBusy(d.id);
    const { error } = await supabase.rpc("staff_update_department", {
      p_department_id: d.id, p_is_active: !d.is_active,
    });
    setRowBusy(null);
    if (error) { showToast("error", error.message); return; }
    onChanged();
  }

  return (
    <div>
      <div className="section-title">{t("adminDepartmentsTitle", lang)}</div>

      <div className="card">
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? t("cancel", lang) : t("addDepartment", lang)}
        </button>
        {showForm && (
          <form onSubmit={handleCreate} className="form-grid" style={{ marginTop: 12 }}>
            <div className="field">
              <label>{t("departmentCodeLabel", lang)} *</label>
              <input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} required maxLength={40} />
            </div>
            <div className="field">
              <label>{t("nameEnLabel", lang)} *</label>
              <input value={form.name_en} onChange={(e) => setForm((f) => ({ ...f, name_en: e.target.value }))} required />
            </div>
            <div className="field">
              <label>{t("nameGuLabel", lang)} *</label>
              <input value={form.name_gu} onChange={(e) => setForm((f) => ({ ...f, name_gu: e.target.value }))} required />
            </div>
            <div className="field full">
              <button className="btn btn-primary" type="submit" disabled={saving}>{t("save", lang)}</button>
            </div>
          </form>
        )}
      </div>

      <div className="card">
        {(lookups.departments || []).map((d) => (
          <div className="task-card" key={d.id}>
            <div className="top-row">
              <div>
                <div className="task-title">{lang === "gu" ? d.name_gu : d.name_en}</div>
                <div className="task-number">{d.code}</div>
              </div>
              <span className={`badge ${d.is_active ? "VERIFIED" : "RETURNED"}`}>
                {d.is_active ? t("activeLabel", lang) : t("inactiveLabel", lang)}
              </span>
            </div>

            {editingId === d.id ? (
              <div style={{ marginTop: 10 }}>
                <label>{t("nameEnLabel", lang)}</label>
                <input value={editForm.name_en} onChange={(e) => setEditForm((f) => ({ ...f, name_en: e.target.value }))} />
                <label>{t("nameGuLabel", lang)}</label>
                <input value={editForm.name_gu} onChange={(e) => setEditForm((f) => ({ ...f, name_gu: e.target.value }))} />
                <div className="btn-row">
                  <button className="btn btn-primary" disabled={rowBusy === d.id} onClick={() => saveEdit(d.id)}>{t("saveChanges", lang)}</button>
                  <button className="btn btn-outline" onClick={() => setEditingId(null)}>{t("cancel", lang)}</button>
                </div>
              </div>
            ) : (
              <div className="btn-row">
                <button className="btn btn-outline" onClick={() => startEdit(d)}>{t("edit", lang)}</button>
                <button className="btn btn-outline" disabled={rowBusy === d.id} onClick={() => toggleActive(d)}>
                  {d.is_active ? t("deactivate", lang) : t("reactivate", lang)}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
