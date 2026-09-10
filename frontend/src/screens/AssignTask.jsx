import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { uploadTaskProof } from "../lib/api";
import { t } from "../lib/i18n";
import VoiceRecorder from "./VoiceRecorder.jsx";

// Fixed bilingual message only — never a raw Supabase/Postgres error string —
// so a failed directory load can never leak backend detail. Persistent (with
// Retry) rather than a fading toast, so a failure never silently leaves the
// department/assignee pickers looking empty.
const DIRECTORY_LOAD_ERROR = {
  en: "Could not load the staff directory. Please try again.",
  gu: "સ્ટાફ ડિરેક્ટરી લોડ કરી શકાઈ નથી. કૃપા કરીને ફરી પ્રયાસ કરો.",
};

// Shown when an authorized To Department has zero active users. This is NOT
// a directory-load failure — the directory loaded fine, the department is a
// valid choice, it simply has no one to assign to yet.
const NO_ACTIVE_STAFF_MESSAGE = {
  en: "No active staff users in this department.",
  gu: "આ વિભાગમાં કોઈ સક્રિય સ્ટાફ યુઝર નથી.",
};

// Assign Task. Calls the approved staff_create_task RPC — all authorization
// (does this caller's role/department allow assigning into the chosen
// department, etc.) happens server-side inside that RPC, not here. When
// the target department differs from the caller's own department, the RPC
// creates the matching Bridge row itself and returns its number.
//
// Flow is From Department -> To Department -> Assignee -> Verifier.
//
// To Department is populated from staff_list_assignable_departments(), a
// SECURITY DEFINER RPC that returns exactly the departments this caller is
// authorized to assign into (Accounts confidentiality included) — it is
// never derived from allUsers, so an authorized department that currently
// has zero created users still appears as a valid To Department choice.
//
// The assignee/verifier pools come from staff_list_assignable_users_all(),
// a separate SECURITY DEFINER RPC that scopes its rows to exactly what this
// caller is authorized to see. Both RPCs are loaded independently on screen
// load and reloaded together by Retry, so neither can silently go stale
// relative to the other.
export default function AssignTask({ lang, profile, lookups, showToast }) {
  const [departments, setDepartments] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [directoryLoading, setDirectoryLoading] = useState(true);
  const [directoryError, setDirectoryError] = useState(null);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [voiceFile, setVoiceFile] = useState(null);
  const [voiceDuration, setVoiceDuration] = useState(0);
  const [voiceKey, setVoiceKey] = useState(0);

  const [form, setForm] = useState({
    title: "",
    description: "",
    task_type_code: lookups.taskTypes[0]?.code || "",
    priority_code: "NORMAL",
    proof_type_code: "none",
    // Defaults to the caller's own department. Only a management user with
    // no home department (profile.department_id === null) gets an editable
    // selector for this below — everyone else keeps the existing disabled,
    // derived-from-profile display, so no other role can spoof from_department.
    from_department_id: profile.department_id || "",
    to_department_id: "",
    assigned_to: "",
    verifier_id: "",
    due_date: "",
    due_time: "",
    reference_number: "",
    requirement_text: "",
    quantity: "",
  });

  // Loads the department directory and the staff directory independently
  // (two separate RPC calls) but as one unit for loading/error purposes: if
  // either fails, the whole directory is treated as unavailable and Retry
  // reloads both together, so the two never drift out of sync.
  const loadDirectories = useCallback(async () => {
    setDirectoryLoading(true);
    setDirectoryError(null);
    const [deptRes, usersRes] = await Promise.all([
      supabase.rpc("staff_list_assignable_departments"),
      supabase.rpc("staff_list_assignable_users_all"),
    ]);
    if (deptRes.error || usersRes.error) {
      setDirectoryError(DIRECTORY_LOAD_ERROR);
      setDepartments([]);
      setAllUsers([]);
    } else {
      setDepartments(deptRes.data || []);
      setAllUsers(usersRes.data || []);
    }
    setDirectoryLoading(false);
  }, []);

  useEffect(() => {
    loadDirectories();
  }, [loadDirectories]);

  // To Department options come directly from the authorized department RPC
  // rows — never from allUsers — so a department with zero users still
  // shows up here as long as the caller is authorized to assign into it.
  const toDepartmentOptions = useMemo(
    () =>
      departments
        .map((d) => ({ id: d.id, name: lang === "gu" ? d.name_gu : d.name_en }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [departments, lang],
  );

  // Active authorized users in the currently selected To Department. Shared
  // by both the assignee list (search-filtered) and the verifier list
  // (unfiltered) so the two stay in sync with the same authorized set.
  const usersInToDepartment = useMemo(
    () => allUsers.filter((u) => u.department_id === form.to_department_id),
    [allUsers, form.to_department_id],
  );

  const noActiveStaffInSelectedDept =
    !directoryLoading && !directoryError && !!form.to_department_id && usersInToDepartment.length === 0;

  const roleLabel = useCallback((u) => (lang === "gu" ? u.role_label_gu : u.role_label_en) || "", [lang]);

  // Search matches name, employee code, or role — nothing here adds or
  // removes authorization, it only narrows what's already in
  // usersInToDepartment (itself already scoped to the selected department).
  const assigneeCandidates = useMemo(() => {
    const q = assigneeSearch.trim().toLowerCase();
    const matches = !q
      ? usersInToDepartment
      : usersInToDepartment.filter((u) =>
          u.full_name.toLowerCase().includes(q) ||
          u.employee_code.toLowerCase().includes(q) ||
          roleLabel(u).toLowerCase().includes(q),
        );
    return matches.slice().sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [usersInToDepartment, assigneeSearch, roleLabel]);

  // Verifier candidates are simply every authorized user in the selected
  // destination department — no second RPC call needed.
  const verifierCandidates = useMemo(
    () => usersInToDepartment.slice().sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [usersInToDepartment],
  );

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  // Selecting a To Department resets everything that depended on the old
  // department: the chosen assignee, the chosen verifier, and the assignee
  // search text.
  function selectToDepartment(deptId) {
    setForm((f) => ({ ...f, to_department_id: deptId, assigned_to: "", verifier_id: "" }));
    setAssigneeSearch("");
  }

  // Selecting an assignee sets only assigned_to — it must never overwrite
  // to_department_id, which the caller already chose explicitly above.
  function selectAssignee(userId) {
    setForm((f) => ({ ...f, assigned_to: userId }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.from_department_id || !form.title || !form.to_department_id || !form.assigned_to || !form.due_date) {
      showToast("error", "Please fill in the required fields. / કૃપા કરીને જરૂરી ફીલ્ડ ભરો.");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const { data, error } = await supabase.rpc("staff_create_task", {
        p_title: form.title,
        p_description: form.description || null,
        p_task_type_code: form.task_type_code,
        p_priority_code: form.priority_code,
        p_proof_type_code: form.proof_type_code,
        p_from_department_id: form.from_department_id,
        p_to_department_id: form.to_department_id,
        p_assigned_to: form.assigned_to,
        p_due_date: form.due_date,
        p_due_time: form.due_time || null,
        p_verifier_id: form.verifier_id || null,
        p_reference_number: form.reference_number || null,
        p_requirement_text: form.requirement_text || null,
        p_quantity: form.quantity || null,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      setResult(row);
      showToast("success", t("taskCreated", lang));

      // Voice message is optional and only ever recorded locally in memory
      // until this point — the task must exist first since staff_record_
      // attachment/staff-file-url both require a real entity_id to check
      // access against. A failed voice upload never rolls back or blocks
      // the already-created task; it just surfaces its own toast.
      if (voiceFile) {
        try {
          await uploadTaskProof({
            entityType: "task",
            entityId: row.task_id,
            file: voiceFile,
            fileType: "voice",
            durationSeconds: voiceDuration,
          });
          showToast("success", t("voiceRecorded", lang));
        } catch (voiceErr) {
          showToast("error", voiceErr.message);
        }
        setVoiceFile(null);
        setVoiceDuration(0);
        setVoiceKey((k) => k + 1);
      }

      // Preserve from_department_id (including management's selected value),
      // task_type_code, priority_code, proof_type_code, due_date and due_time.
      // Clear everything specific to the task just created plus the whole
      // To Department -> Assignee -> Verifier chain, so the next task starts
      // the same explicit flow rather than silently reusing a stale target.
      setForm((f) => ({
        ...f,
        title: "",
        description: "",
        to_department_id: "",
        assigned_to: "",
        verifier_id: "",
        reference_number: "",
        requirement_text: "",
        quantity: "",
      }));
      setAssigneeSearch("");
    } catch (err) {
      // Surface the real reason (e.g. a role/department restriction inside
      // staff_create_task) instead of a generic message — a swallowed error
      // here previously made a legitimate server-side rejection look
      // indistinguishable from "nothing happened."
      showToast("error", err.message || "Could not create the task. Please try again. / ટાસ્ક બનાવી શકાયો નથી. કૃપા કરીને ફરી પ્રયાસ કરો.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="section-title">{t("assignTask", lang)}</div>
      <div className="card">
        <form onSubmit={handleSubmit} className="form-grid">
          <div className="field full">
            <label>{t("title", lang)} *</label>
            <input value={form.title} onChange={(e) => set("title", e.target.value)} required maxLength={200} />
          </div>

          <div className="field full">
            <label>{t("description", lang)}</label>
            <textarea value={form.description} onChange={(e) => set("description", e.target.value)} />
          </div>

          <div className="field full">
            <label>{t("voiceMessage", lang)}</label>
            <VoiceRecorder
              key={voiceKey}
              lang={lang}
              disabled={busy}
              onRecorded={(file, duration) => { setVoiceFile(file); setVoiceDuration(duration); }}
            />
          </div>

          <div className="field">
            <label>{t("taskType", lang)}</label>
            <select value={form.task_type_code} onChange={(e) => set("task_type_code", e.target.value)}>
              {lookups.taskTypes.map((tt) => (
                <option key={tt.code} value={tt.code}>{lang === "gu" ? tt.name_gu : tt.name_en}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>{t("priority", lang)}</label>
            <select value={form.priority_code} onChange={(e) => set("priority_code", e.target.value)}>
              {lookups.priorities.map((p) => (
                <option key={p.code} value={p.code}>{lang === "gu" ? p.name_gu : p.name_en}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>{t("proofType", lang)}</label>
            <select value={form.proof_type_code} onChange={(e) => set("proof_type_code", e.target.value)}>
              {lookups.proofTypes.map((p) => (
                <option key={p.code} value={p.code}>{lang === "gu" ? p.name_gu : p.name_en}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>{t("fromDepartment", lang)} *</label>
            {profile.isManagement && !profile.department_id ? (
              // Only reached when the caller is management AND has no home
              // department. A non-management profile with a missing
              // department is NOT covered by this branch — it falls through
              // to the disabled derived input below and stays blocked, never
              // receiving an editable selector.
              <select value={form.from_department_id} onChange={(e) => set("from_department_id", e.target.value)} required>
                <option value="" disabled>—</option>
                {lookups.departments.filter((d) => d.is_active).map((d) => (
                  <option key={d.id} value={d.id}>{lang === "gu" ? d.name_gu : d.name_en}</option>
                ))}
              </select>
            ) : (
              <input disabled value={lookups.departmentById[profile.department_id]?.[lang === "gu" ? "name_gu" : "name_en"] || ""} />
            )}
          </div>

          <div className="field full">
            <label>{t("toDepartment", lang)} *</label>
            {directoryLoading && <div className="msg info">…</div>}
            {directoryError && (
              <div className="msg error">
                {directoryError.en} / {directoryError.gu}
                <div className="btn-row" style={{ marginTop: 8 }}>
                  <button type="button" className="btn btn-outline" onClick={loadDirectories}>
                    Retry / ફરી પ્રયાસ કરો
                  </button>
                </div>
              </div>
            )}
            {!directoryLoading && !directoryError && (
              <select
                value={form.to_department_id}
                onChange={(e) => selectToDepartment(e.target.value)}
                required
              >
                <option value="" disabled>—</option>
                {toDepartmentOptions.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            )}
            {form.to_department_id && form.from_department_id && (
              form.to_department_id !== form.from_department_id ? (
                <div className="msg info" style={{ marginTop: 8 }}>🌉 {t("willCreateBridge", lang)}</div>
              ) : (
                <div className="msg info" style={{ marginTop: 8 }}>{t("sameDepartmentNoBridge", lang)}</div>
              )
            )}
          </div>

          <div className="field full">
            <label>{t("assignedTo", lang)} *</label>
            {noActiveStaffInSelectedDept && (
              <div className="msg info">
                {NO_ACTIVE_STAFF_MESSAGE.en} / {NO_ACTIVE_STAFF_MESSAGE.gu}
              </div>
            )}
            {!directoryLoading && !directoryError && (
              <>
                <input
                  type="text"
                  placeholder="Search name, code, role… / શોધો…"
                  value={assigneeSearch}
                  onChange={(e) => setAssigneeSearch(e.target.value)}
                  disabled={!form.to_department_id || noActiveStaffInSelectedDept}
                />
                <select
                  value={form.assigned_to}
                  onChange={(e) => selectAssignee(e.target.value)}
                  required
                  disabled={!form.to_department_id || noActiveStaffInSelectedDept}
                >
                  <option value="" disabled>—</option>
                  {assigneeCandidates.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.full_name} — {roleLabel(u)} — {u.employee_code}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>

          <div className="field full">
            <label>{t("verifier", lang)}</label>
            <select value={form.verifier_id} onChange={(e) => set("verifier_id", e.target.value)} disabled={!form.to_department_id}>
              <option value="">—</option>
              {verifierCandidates.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name} ({u.employee_code})</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>{t("dueDate", lang)} *</label>
            <input type="date" value={form.due_date} onChange={(e) => set("due_date", e.target.value)} required />
          </div>

          <div className="field">
            <label>{t("dueTime", lang)}</label>
            <input type="time" value={form.due_time} onChange={(e) => set("due_time", e.target.value)} />
          </div>

          <div className="field">
            <label>{t("referenceNumber", lang)}</label>
            <input value={form.reference_number} onChange={(e) => set("reference_number", e.target.value)} maxLength={100} />
          </div>

          <div className="field">
            <label>{t("quantity", lang)}</label>
            <input value={form.quantity} onChange={(e) => set("quantity", e.target.value)} maxLength={100} />
          </div>

          <div className="field full">
            <label>{t("requirementText", lang)}</label>
            <textarea value={form.requirement_text} onChange={(e) => set("requirement_text", e.target.value)} />
          </div>

          <div className="field full">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy && <span className="spinner" />}
              {t("createTask", lang)}
            </button>
          </div>
        </form>

        {result && (
          <div className="msg success" style={{ marginTop: 12 }}>
            {t("taskCreated", lang)}: {result.task_number}
            {result.bridge_number && <div>{t("bridgeCreated", lang)}: {result.bridge_number}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
