import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { listProjectActivity, listUnassignedActivity, assignActivityToProject } from "../../lib/interiorApi";

// Project-scoped Activity History — reads interior_pilot_audit_log, the
// pilot's own audit table that logAudit() (interiorApi.js) already writes
// to on nearly every mutation. performed_by is a staff-pilot auth uid;
// user_profiles RLS only lets a plain employee see their OWN row, so names
// are resolved via staff_list_assignable_users_all — the same RPC
// AuditLog.jsx already uses for exactly this reason, not a fresh query.
export default function InteriorActivityHistory({ lang, projectId, isElevated }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rows, setRows] = useState([]);
  const [usersById, setUsersById] = useState({});
  const [showUnassigned, setShowUnassigned] = useState(false);
  const [unassignedRows, setUnassignedRows] = useState([]);

  const load = useCallback(async () => {
    if (!projectId) { setRows([]); setLoading(false); return; }
    setLoading(true);
    setError(false);
    const [{ data, error: err }, usersRes] = await Promise.all([
      listProjectActivity(projectId),
      supabase.rpc("staff_list_assignable_users_all"),
    ]);
    if (err) { setError(true); setLoading(false); return; }
    setRows(data || []);
    setUsersById(Object.fromEntries((usersRes.data || []).map((u) => [u.id, u.full_name])));
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const loadUnassigned = useCallback(async () => {
    const { data } = await listUnassignedActivity();
    setUnassignedRows(data || []);
  }, []);

  useEffect(() => { if (showUnassigned) loadUnassigned(); }, [showUnassigned, loadUnassigned]);

  async function claimForThisProject(id) {
    const { error: err } = await assignActivityToProject(id, projectId);
    if (!err) { loadUnassigned(); load(); }
  }

  if (loading) return <div className="skeleton-block" style={{ height: 220 }} />;
  if (error) {
    return (
      <div className="card">
        <div className="msg error">{t("loadErrorRetry", lang)}</div>
        <button className="btn btn-primary" onClick={load}>{t("retry", lang)}</button>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>{t("tabActivity", lang)}</h2>
      {rows.length === 0 && <div className="msg info">{t("noRecordsForProject", lang)}</div>}
      {rows.map((r) => (
        <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap", gap: 6 }}>
          <span>{r.table_name} · {r.action}</span>
          <span className="sub">{usersById[r.performed_by] || "—"}</span>
          <span className="sub">{new Date(r.performed_at).toLocaleString()}</span>
        </div>
      ))}

      {isElevated && (
        <>
          <button className="btn btn-outline" style={{ marginTop: 14 }} onClick={() => setShowUnassigned((s) => !s)}>
            {t("unassignedActivityLabel", lang)}
          </button>
          {showUnassigned && (
            <div style={{ marginTop: 10 }}>
              {unassignedRows.length === 0 && <div className="msg info">{t("noRecordsForProject", lang)}</div>}
              {unassignedRows.map((r) => (
                <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap", gap: 6 }}>
                  <span>{r.table_name} · {r.action}</span>
                  <span className="sub">{usersById[r.performed_by] || "—"} · {new Date(r.performed_at).toLocaleString()}</span>
                  <button className="btn btn-outline" style={{ marginTop: 0, width: "auto" }} onClick={() => claimForThisProject(r.id)}>
                    {t("assignToThisProjectLabel", lang)}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
