import React, { useCallback, useEffect, useState } from "react";
import { t } from "../lib/i18n";
import { getMyInteriorProfile, ensureInteriorProfile } from "../lib/interiorApi";
import { InteriorProfileContext } from "../lib/interiorProfileContext";

const FUNCTIONAL_ROLES = ["pm", "designer", "execution", "purchase", "crm"];

// Every Interior screen is wrapped in this once (see App.jsx). Resolves —
// or, for Management/Interior Head, silently provisions — the caller's row
// in the external Interior system's own `profiles` table, so every write
// this app makes can finally be attributed to a real person instead of
// staying NULL. A plain Interior member who isn't Management/Dept Head is
// asked ONCE which of the five functional roles they do day to day (the
// same vocabulary profiles.role is restricted to) — never again after
// that, since the choice is persisted server-side.
export default function InteriorProfileGate({ lang, children }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [profile, setProfile] = useState(null);
  const [needsRole, setNeedsRole] = useState(false);
  const [chosenRole, setChosenRole] = useState("execution");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    setNeedsRole(false);
    const { data, error: err } = await getMyInteriorProfile();
    if (err) { setError(true); setLoading(false); return; }
    if (data) { setProfile(data); setLoading(false); return; }
    // No row yet — try the automatic path (management/dept_head map
    // unambiguously server-side); if that's not this caller, the RPC
    // raises and we fall back to asking.
    const { data: ensured, error: ensureErr } = await ensureInteriorProfile(null);
    if (ensured) { setProfile(ensured); setLoading(false); return; }
    if (ensureErr) { setNeedsRole(true); setLoading(false); return; }
    setError(true);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function confirmRole() {
    setSaving(true);
    const { data, error: err } = await ensureInteriorProfile(chosenRole);
    setSaving(false);
    if (err) { setError(true); return; }
    setProfile(data);
    setNeedsRole(false);
  }

  if (loading) {
    return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 90 }} /></div>;
  }
  if (error) {
    return (
      <div className="dept-dashboard">
        <div className="msg error">{t("loadErrorRetry", lang)}</div>
        <button className="btn btn-primary" onClick={load}>{t("retry", lang)}</button>
      </div>
    );
  }
  if (needsRole) {
    return (
      <div className="dept-dashboard">
        <div className="card">
          <h2>{t("interiorRoleQuestionTitle", lang)}</h2>
          <div className="sub">{t("interiorRoleQuestionBody", lang)}</div>
          <div className="field" style={{ maxWidth: 280, marginTop: 10 }}>
            <select value={chosenRole} onChange={(e) => setChosenRole(e.target.value)}>
              {FUNCTIONAL_ROLES.map((r) => <option key={r} value={r}>{t(`interiorRole_${r}`, lang)}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" style={{ marginTop: 10 }} disabled={saving} onClick={confirmRole}>{t("confirm", lang)}</button>
        </div>
      </div>
    );
  }

  return <InteriorProfileContext.Provider value={profile}>{children}</InteriorProfileContext.Provider>;
}
