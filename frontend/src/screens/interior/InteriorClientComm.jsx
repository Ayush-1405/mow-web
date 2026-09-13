import React, { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { useInteriorProfile } from "../../lib/interiorProfileContext";
import { listProjects, listInteriorPeople, listActivity, logActivity, notifyDeptLeadership } from "../../lib/interiorApi";

// Client Communication — the external system's `activity_logs` table, per
// project.
export default function InteriorClientComm({ lang, lockedProjectId }) {
  const profile = useInteriorProfile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [projects, setProjects] = useState([]);
  const [people, setPeople] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState([]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const [{ data, error: err }, peopleRes] = await Promise.all([listProjects(), listInteriorPeople()]);
    if (err) { setError(true); setLoading(false); return; }
    setProjects(data || []);
    setPeople(peopleRes.data || []);
    if (data?.length) setProjectId((cur) => cur || lockedProjectId || data[0].id);
    setLoading(false);
  }, [lockedProjectId]);

  useEffect(() => { load(); }, [load]);

  const loadActivity = useCallback(async () => {
    if (!projectId) { setRows([]); return; }
    const { data, error: err } = await listActivity(projectId);
    if (!err) setRows(data || []);
  }, [projectId]);

  // loadActivity's identity only changes when projectId changes (it's a
  // useCallback keyed on projectId) — never when handleLog calls it
  // manually after a save — so clearing saveMsg here only happens on an
  // actual project switch, not on the very save that just set the message.
  useEffect(() => { loadActivity(); setSaveMsg(""); }, [loadActivity]);

  const personName = useCallback((id) => people.find((p) => p.id === id)?.name || "—", [people]);

  async function handleLog() {
    const trimmed = note.trim();
    if (!projectId || !trimmed) return;
    setSaving(true);
    setSaveMsg(t("saving", lang));
    const { error: err } = await logActivity(projectId, "client_communication", trimmed, profile?.id);
    setSaving(false);
    if (err) { setSaveMsg(t("errorSaving", lang)); return; }
    const project = projects.find((p) => p.id === projectId);
    notifyDeptLeadership(
      "INTERIOR", "project", projectId,
      `Client communication logged: ${trimmed} — ${project ? `${project.project_code} (${project.customer})` : ""}`,
      `ક્લાયન્ટ કમ્યુનિકેશન નોંધાયું: ${trimmed}`,
    );
    setNote("");
    setSaveMsg(t("saved", lang));
    loadActivity();
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
        <div className="dept-header-icon" aria-hidden="true">💬</div>
        <div className="dept-header-text">
          <h1>{t("interiorClientCommTitle", lang)}</h1>
          <div className="sub">{t("interiorLiveDataNote", lang)}</div>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>{t("projectCodeLabel", lang)}</label>
          {lockedProjectId ? (
            <div className="sub" style={{ fontWeight: 700, marginTop: 4 }}>
              {(() => { const p = projects.find((pr) => pr.id === projectId); return p ? `${p.project_code} — ${p.customer}` : "—"; })()}
            </div>
          ) : (
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
            </select>
          )}
        </div>
        <div className="field full" style={{ marginTop: 10 }}>
          <label>{t("logUpdate", lang)}</label>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("logUpdate", lang)} />
          <div className="btn-row">
            <button className="btn btn-primary" style={{ width: "auto" }} disabled={saving || !note.trim()} onClick={handleLog}>
              {saving ? t("saving", lang) : t("save", lang)}
            </button>
          </div>
          {saveMsg && <div className="sub" style={{ marginTop: 4 }}>{saveMsg}</div>}
        </div>
      </div>

      <div className="card">
        <h2>{t("activityLabel", lang)}</h2>
        {rows.length === 0 && <div className="msg info">{t("noRecordsYet", lang)}</div>}
        {rows.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "8px 0", flexWrap: "wrap", gap: 6 }}>
            <span style={{ flex: "1 1 260px" }}>{r.description}</span>
            <span className="sub">{personName(r.user_id)} · {(r.created_at || "").slice(0, 10)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
