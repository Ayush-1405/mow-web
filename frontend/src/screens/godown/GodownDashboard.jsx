import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../../lib/i18n";
import { listGodownQueue } from "../../lib/retailApi";

// Godown, Inventory & Dispatch's real home screen (v2_93q rebuild): five large, icon-first, bilingual actions —
// per the pilot's own instruction that Godown workers "just work", not read a 40-card grid. Head/Supervisor/
// Management reach reports and corrections through the separate "More / Reports" tap, never mixed into this list.
export default function GodownDashboard({ lang, profile }) {
  const navigate = useNavigate();
  const [pendingCount, setPendingCount] = useState(null);

  const load = useCallback(async () => {
    const { data } = await listGodownQueue();
    setPendingCount((data || []).filter((r) => r.status === "PENDING").length);
  }, []);

  useEffect(() => { load(); }, [load]);

  const canSeeReports = !!(profile?.permissions?.hasGlobalOversight || profile?.permissions?.isDepartmentHead || profile?.permissions?.isSupervisor);

  const tiles = [
    { icon: "📷", label: "newStockInTileLabel", route: "/godown/stock-intake" },
    { icon: "🚚", label: "deliveryRequestsTileLabel", route: "/godown/handovers", badge: pendingCount },
    { icon: "📋", label: "myWorkTodayTileLabel", route: "/godown/my-work" },
    { icon: "📦", label: "availableStockTileLabel", route: "/godown/stock" },
    { icon: "🔍", label: "scanQrTileLabel", route: "/godown/scan" },
  ];

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📦</div>
        <div className="dept-header-text"><h1>{t("godownHomeTitle", lang)}</h1></div>
      </div>

      <div className="card" style={{ display: "grid", gap: 14 }}>
        {tiles.map((tile) => (
          <button key={tile.route} type="button" className="godown-big-tile" onClick={() => navigate(tile.route)}>
            <span style={{ fontSize: 44 }} aria-hidden="true">{tile.icon}</span>
            <span style={{ fontSize: 19, fontWeight: 700 }}>{t(tile.label, lang)}</span>
            {tile.badge != null && tile.badge > 0 && <span className="badge ASSIGNED" style={{ fontSize: 15 }}>{tile.badge}</span>}
          </button>
        ))}
      </div>

      {canSeeReports && (
        <div className="card" style={{ textAlign: "center" }}>
          <button type="button" className="btn btn-outline" onClick={() => navigate("/godown/reports")}>
            📊 {t("moreReportsTileLabel", lang)} ▸
          </button>
        </div>
      )}
    </div>
  );
}
