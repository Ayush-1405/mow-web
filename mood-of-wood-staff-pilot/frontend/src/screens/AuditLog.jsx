import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { t } from "../lib/i18n";

// Audit Log. staff_audit_log_select_scoped already restricts rows to what
// this caller is allowed to see (Management: all; Dept Head: own
// department/group only) — this screen adds no visibility filter of its
// own beyond that RLS policy. Every staff_* RPC writes here via the
// internal-only staff_write_audit() helper; nothing on this screen writes
// to the table. Each entry is clickable, revealing the full before/after
// JSON payload and remarks already stored on the row — nothing new is
// fetched, it's just hidden by default to keep the list scannable.
export default function AuditLog({ lang, lookups, showToast }) {
  const [entries, setEntries] = useState([]);
  const [usersById, setUsersById] = useState({});
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [logRes, dirRes] = await Promise.all([
      supabase.from("staff_audit_log").select("*").order("performed_at", { ascending: false }).limit(200),
      supabase.rpc("staff_list_assignable_users_all"),
    ]);
    if (logRes.error) showToast("error", logRes.error.message);
    else setEntries(logRes.data || []);
    if (!dirRes.error) setUsersById(Object.fromEntries((dirRes.data || []).map((u) => [u.id, u])));
    setLoading(false);
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const userLabel = (id) => {
    if (!id) return "—";
    const u = usersById[id];
    return u ? `${u.full_name} (${u.employee_code})` : "—";
  };
  const deptName = (id) => lookups.departmentById[id]?.[lang === "gu" ? "name_gu" : "name_en"] || "—";

  return (
    <div>
      <div className="section-title">{t("auditLog", lang)}</div>
      <button className="btn btn-outline" style={{ marginBottom: 10 }} onClick={load} disabled={loading}>
        {t("refresh", lang)}
      </button>

      {loading && entries.length === 0 && <div className="msg info">…</div>}
      {!loading && entries.length === 0 && <div className="msg info">{t("noAuditEntries", lang)}</div>}

      <div className="audit-grid">
        {entries.map((e) => {
          const expanded = expandedId === e.id;
          return (
            <div
              className="task-card audit-card"
              key={e.id}
              onClick={() => setExpandedId(expanded ? null : e.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") setExpandedId(expanded ? null : e.id); }}
            >
              <div className="top-row">
                <div>
                  <div className="task-title">{e.action} — {e.entity_type}</div>
                  {e.department_id && <div className="task-number">{deptName(e.department_id)}</div>}
                </div>
                <span className="badge">{expanded ? "▲" : "▼"}</span>
              </div>
              <div className="task-meta">
                <span>{t("performedBy", lang)}: {userLabel(e.performed_by)}</span>
                <span>{t("when", lang)}: {new Date(e.performed_at).toLocaleString()}</span>
              </div>
              {e.remarks && <div style={{ fontSize: 13, marginTop: 6 }}>{e.remarks}</div>}

              {expanded && (
                <div className="timeline" onClick={(ev) => ev.stopPropagation()}>
                  <div className="timeline-item">
                    <span className="timeline-label">{t("entity", lang)}</span>
                    <span className="timeline-value">{e.entity_type} · {e.entity_id}</span>
                  </div>
                  {e.old_value && (
                    <div>
                      <div className="timeline-label" style={{ marginTop: 8 }}>{t("before", lang)}</div>
                      <pre className="audit-json">{JSON.stringify(e.old_value, null, 2)}</pre>
                    </div>
                  )}
                  {e.new_value && (
                    <div>
                      <div className="timeline-label" style={{ marginTop: 8 }}>{t("after", lang)}</div>
                      <pre className="audit-json">{JSON.stringify(e.new_value, null, 2)}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
