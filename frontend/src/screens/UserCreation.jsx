import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { staffCreateUser } from "../lib/api";
import { t } from "../lib/i18n";

// Calls staff-create-user (already deployed, already reviewed). All role/
// department authorization happens server-side against role_creation_rules
// for the VERIFIED caller — this form does not decide who is allowed to
// create whom, it just collects the fields the function needs.
export default function UserCreation({ lang, profile, lookups, showToast }) {
  const [locations, setLocations] = useState([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [codeLoading, setCodeLoading] = useState(false);
  const [form, setForm] = useState({
    employee_code: "",
    full_name: "",
    phone: "",
    role_code: "",
    department_id: profile.department_id || "",
    home_location_id: "",
    temporary_password: "",
  });

  // Roster: staff_list_department_roster() (scoped Management/Dept Head/
  // Accounts) rather than a direct user_profiles query, since the direct-
  // select RLS policy only returns is_active=true rows — a manager needs
  // to see deactivated accounts too, in order to reactivate them.
  const [roster, setRoster] = useState([]);
  const [rosterLoading, setRosterLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ full_name: "", phone: "" });
  const [statusReasonFor, setStatusReasonFor] = useState(null);
  const [statusReason, setStatusReason] = useState("");
  const [rowBusyId, setRowBusyId] = useState(null);
  const [roleEditFor, setRoleEditFor] = useState(null);
  const [roleEditValue, setRoleEditValue] = useState("");

  // Only Super Admin/Management may change an existing user's role
  // (staff_update_user_role — Management is blocked server-side from
  // granting sysadmin itself, so the option is simply not offered here).
  const canChangeRoles = profile.isSuperAdmin || profile.isManagement;
  const assignableRoleCodes = lookups.roles.filter((r) => profile.isSuperAdmin || r.code !== "sysadmin");

  function startRoleEdit(u) {
    setRoleEditFor(u.id);
    setRoleEditValue(u.role_code);
  }

  async function submitRoleChange(userId) {
    setRowBusyId(userId);
    try {
      const { error } = await supabase.rpc("staff_update_user_role", { p_user_id: userId, p_new_role_code: roleEditValue });
      if (error) throw error;
      setRoleEditFor(null);
      showToast("success", t("statusUpdated", lang));
      await loadRoster();
    } catch (err) {
      showToast("error", err.message);
    } finally {
      setRowBusyId(null);
    }
  }

  const loadRoster = useCallback(async () => {
    setRosterLoading(true);
    const { data, error } = await supabase.rpc("staff_list_department_roster");
    if (error) showToast("error", error.message);
    else setRoster(data || []);
    setRosterLoading(false);
  }, [showToast]);

  useEffect(() => {
    loadRoster();
  }, [loadRoster]);

  function startEdit(u) {
    setEditingId(u.id);
    setEditForm({ full_name: u.full_name, phone: u.phone || "" });
  }

  async function submitEdit(userId) {
    setRowBusyId(userId);
    try {
      const { error } = await supabase.rpc("staff_update_user_profile", {
        p_user_id: userId,
        p_full_name: editForm.full_name.trim(),
        p_phone: editForm.phone.trim() || null,
      });
      if (error) throw error;
      setEditingId(null);
      showToast("success", t("profileUpdated", lang));
      await loadRoster();
    } catch (err) {
      showToast("error", err.message);
    } finally {
      setRowBusyId(null);
    }
  }

  async function submitStatusChange(userId, nextActive) {
    if (!statusReason.trim()) return;
    setRowBusyId(userId);
    try {
      const { error } = await supabase.rpc("staff_set_user_active", {
        p_user_id: userId,
        p_is_active: nextActive,
        p_reason: statusReason.trim(),
      });
      if (error) throw error;
      setStatusReasonFor(null);
      setStatusReason("");
      showToast("success", t("statusUpdated", lang));
      await loadRoster();
    } catch (err) {
      showToast("error", err.message);
    } finally {
      setRowBusyId(null);
    }
  }

  useEffect(() => {
    supabase
      .from("locations")
      .select("id, name_en, name_gu")
      .eq("is_active", true)
      .then(({ data, error }) => {
        if (error) showToast("error", error.message);
        else setLocations(data || []);
      });
  }, [showToast]);

  // Employee Code is auto-generated from the selected department (server
  // side, via staff_generate_employee_code) rather than typed by hand —
  // whenever department_id changes, fetch the next free MOW-<DEPT>-NNN for
  // that department. staff-create-user still does the authoritative
  // duplicate check at submit time, so a race between two admins just
  // means a retry here, never a bad write.
  const generateCode = useCallback(
    async (departmentId) => {
      if (!departmentId) {
        set("employee_code", "");
        return;
      }
      setCodeLoading(true);
      const { data, error } = await supabase.rpc("staff_generate_employee_code", {
        p_department_id: departmentId,
      });
      setCodeLoading(false);
      if (error) {
        showToast("error", error.message);
        return;
      }
      setForm((f) => (f.department_id === departmentId ? { ...f, employee_code: data || "" } : f));
    },
    [showToast],
  );

  useEffect(() => {
    generateCode(form.department_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function selectDepartment(departmentId) {
    set("department_id", departmentId);
    generateCode(departmentId);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.employee_code || !form.full_name || !form.role_code || !form.department_id || !form.home_location_id || !form.temporary_password) {
      showToast("error", "Please fill in the required fields. / કૃપા કરીને જરૂરી ફીલ્ડ ભરો.");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const created = await staffCreateUser({
        employee_code: form.employee_code.trim().toUpperCase(),
        full_name: form.full_name.trim(),
        phone: form.phone.trim() || undefined,
        role_code: form.role_code,
        department_id: form.department_id,
        home_location_id: form.home_location_id,
        location_ids: [],
        temporary_password: form.temporary_password,
      });
      setResult(created);
      showToast("success", t("userCreated", lang));
      await loadRoster();
      setForm({
        employee_code: "",
        full_name: "",
        phone: "",
        role_code: "",
        department_id: profile.department_id || "",
        home_location_id: "",
        temporary_password: "",
      });
      generateCode(profile.department_id || "");
    } catch (err) {
      showToast("error", err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="section-title">{t("userCreation", lang)}</div>
      <div className="card">
        <form onSubmit={handleSubmit} autoComplete="off" className="form-grid">
          <div className="field">
            <label>{t("department", lang)} *</label>
            <select value={form.department_id} onChange={(e) => selectDepartment(e.target.value)} required>
              <option value="" disabled>—</option>
              {lookups.departments.map((d) => (
                <option key={d.id} value={d.id}>{lang === "gu" ? d.name_gu : d.name_en}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>{t("employeeCode", lang)} *</label>
            <input
              value={codeLoading ? "…" : form.employee_code}
              readOnly
              disabled
              placeholder={t("department", lang)}
            />
          </div>

          <div className="field">
            <label>{t("fullName", lang)} *</label>
            <input value={form.full_name} onChange={(e) => set("full_name", e.target.value)} required maxLength={200} />
          </div>

          <div className="field">
            <label>{t("phone", lang)}</label>
            <input value={form.phone} onChange={(e) => set("phone", e.target.value)} maxLength={30} />
          </div>

          <div className="field">
            <label>{t("role", lang)} *</label>
            <select value={form.role_code} onChange={(e) => set("role_code", e.target.value)} required>
              <option value="" disabled>—</option>
              {lookups.roles.filter((r) => profile.isSuperAdmin || (r.code !== "sysadmin" && r.code !== "management")).map((r) => (
                <option key={r.code} value={r.code}>{lang === "gu" ? r.name_gu : r.name_en}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>{t("homeLocation", lang)} *</label>
            <select value={form.home_location_id} onChange={(e) => set("home_location_id", e.target.value)} required>
              <option value="" disabled>—</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{lang === "gu" ? l.name_gu : l.name_en}</option>
              ))}
            </select>
          </div>

          <div className="field full">
            <label>{t("temporaryPassword", lang)} *</label>
            <input
              type="text"
              autoComplete="off"
              value={form.temporary_password}
              onChange={(e) => set("temporary_password", e.target.value)}
              placeholder="Min 8 chars, upper+lower+digit"
              required
              minLength={8}
              maxLength={200}
            />
          </div>

          <div className="field full">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy && <span className="spinner" />}
              {t("createUser", lang)}
            </button>
          </div>
        </form>

        {result && (
          <div className="msg success" style={{ marginTop: 12 }}>
            {t("userCreated", lang)}: {result.full_name} ({result.employee_code})
          </div>
        )}
      </div>

      <div className="section-title">{t("roster", lang)}</div>
      <button className="btn btn-outline" style={{ marginBottom: 10 }} onClick={loadRoster} disabled={rosterLoading}>
        {t("refresh", lang)}
      </button>
      {rosterLoading && roster.length === 0 && <div className="msg info">…</div>}
      {roster.map((u) => {
        const deptName = lookups.departmentById[u.department_id]?.[lang === "gu" ? "name_gu" : "name_en"] || "—";
        const roleName = lang === "gu" ? u.role_name_gu : u.role_name_en;
        const rowBusy = rowBusyId === u.id;
        return (
          <div className="task-card" key={u.id}>
            <div className="top-row">
              <div>
                <div className="task-title">{u.full_name}</div>
                <div className="task-number">{u.employee_code} · {roleName} · {deptName}</div>
              </div>
              <span className={`badge ${u.is_active ? "VERIFIED" : "RETURNED"}`}>
                {u.is_active ? t("active", lang) : t("inactive", lang)}
              </span>
            </div>

            {editingId === u.id ? (
              <div style={{ marginTop: 10 }}>
                <label>{t("fullName", lang)}</label>
                <input value={editForm.full_name} onChange={(e) => setEditForm((f) => ({ ...f, full_name: e.target.value }))} maxLength={200} />
                <label>{t("phone", lang)}</label>
                <input value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} maxLength={30} />
                <div className="btn-row">
                  <button className="btn btn-primary" disabled={rowBusy} onClick={() => submitEdit(u.id)}>
                    {t("saveChanges", lang)}
                  </button>
                  <button className="btn btn-outline" onClick={() => setEditingId(null)}>{t("cancel", lang)}</button>
                </div>
              </div>
            ) : (
              <div className="btn-row">
                <button className="btn btn-outline" onClick={() => startEdit(u)}>{t("edit", lang)}</button>
                {canChangeRoles && (
                  <button className="btn btn-outline" onClick={() => startRoleEdit(u)}>{t("changeRole", lang)}</button>
                )}
                <button
                  className="btn btn-outline"
                  onClick={() => setStatusReasonFor(statusReasonFor === u.id ? null : u.id)}
                >
                  {u.is_active ? t("deactivate", lang) : t("reactivate", lang)}
                </button>
              </div>
            )}

            {roleEditFor === u.id && (
              <div style={{ marginTop: 10 }}>
                <label>{t("role", lang)}</label>
                <select value={roleEditValue} onChange={(e) => setRoleEditValue(e.target.value)}>
                  {assignableRoleCodes.map((r) => (
                    <option key={r.code} value={r.code}>{lang === "gu" ? r.name_gu : r.name_en}</option>
                  ))}
                </select>
                <div className="btn-row">
                  <button className="btn btn-primary" disabled={rowBusyId === u.id} onClick={() => submitRoleChange(u.id)}>{t("saveChanges", lang)}</button>
                  <button className="btn btn-outline" onClick={() => setRoleEditFor(null)}>{t("cancel", lang)}</button>
                </div>
              </div>
            )}

            {statusReasonFor === u.id && (
              <div style={{ marginTop: 10 }}>
                <label>{t("deactivateReason", lang)} *</label>
                <textarea value={statusReason} onChange={(e) => setStatusReason(e.target.value)} />
                <div className="btn-row">
                  <button className="btn btn-primary" disabled={rowBusy} onClick={() => submitStatusChange(u.id, !u.is_active)}>
                    {t("submit", lang)}
                  </button>
                  <button className="btn btn-outline" onClick={() => { setStatusReasonFor(null); setStatusReason(""); }}>
                    {t("cancel", lang)}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
