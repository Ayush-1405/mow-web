import React from "react";
import { t } from "../../lib/i18n";

// Stock Availability — Godown/Inventory doesn't exist in this pilot yet,
// so there is no real stock data to show. Honest empty state rather than
// a fabricated number; this will connect automatically once that
// department's tables exist (see the module rollout plan).
export default function RetailStock({ lang }) {
  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📦</div>
        <div className="dept-header-text"><h1>{t("retailStockTitle", lang)}</h1></div>
      </div>
      <div className="card">
        <div className="msg info">{t("stockNotAvailableYet", lang)}</div>
      </div>
    </div>
  );
}
