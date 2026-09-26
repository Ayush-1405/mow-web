import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../../lib/i18n";
import { loadMyWorkToday } from "../../lib/retailApi";

const ICONS = { HANDOVER_PENDING: "🆕", PACKING_PENDING: "📦", DISPATCH_PENDING: "🚚", DELIVERY_DUE_TODAY: "📬" };
const ROUTE = { HANDOVER_PENDING: "/godown/handovers", PACKING_PENDING: "/godown/handovers", DISPATCH_PENDING: "/dispatch/queue", DELIVERY_DUE_TODAY: "/dispatch/queue" };

// My Work Today — a plain Godown worker's own personal queue: what's assigned to them, right now, across every
// stage (new requests, packing, dispatch, delivery due today) in one simple list — no filters, no setup, just tap
// to go do the work. The Head/Supervisor's department-wide queue stays on the existing Handovers screen.
export default function GodownMyWorkToday({ lang }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    const { data, error: err } = await loadMyWorkToday();
    if (err) { setError(true); return; }
    setError(false);
    setRows(data || []);
  }, []);

  useEffect(() => { load(); }, [load]);

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
        <div className="dept-header-icon" aria-hidden="true">📋</div>
        <div className="dept-header-text"><h1>{t("myWorkTodayTileLabel", lang)}</h1></div>
      </div>

      <div className="card">
        {rows === null && <div className="msg info">…</div>}
        {rows !== null && rows.length === 0 && <div className="msg success">✅ {t("noWorkPendingMsg", lang)}</div>}
        {rows?.map((r) => (
          <button key={r.item_type + r.entity_id} type="button" className="task-meta"
            style={{ width: "100%", justifyContent: "space-between", padding: "12px 0", borderBottom: "1px solid var(--border)", background: "none", border: "none", textAlign: "left", cursor: "pointer" }}
            onClick={() => navigate(ROUTE[r.item_type] || "/inventory")}>
            <div className="task-meta" style={{ gap: 10 }}>
              <span style={{ fontSize: 26 }} aria-hidden="true">{ICONS[r.item_type] || "•"}</span>
              <div>
                <div style={{ fontWeight: 700 }}>{r.order_number} — {r.customer_name}</div>
                <div className="sub">{r.title}</div>
              </div>
            </div>
            {r.is_overdue && <span className="fx-tag" style={{ color: "var(--danger)" }}>⚠️ {t("overdueLabel", lang)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
