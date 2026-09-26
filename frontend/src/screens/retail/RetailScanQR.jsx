import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../../lib/i18n";
import QRScanner from "../../components/QRScanner.jsx";

// Retail's own prominent "Scan Product QR" entry point — same shared scanner as Godown's, landing on the same
// product-detail page (price shown, since the viewer is Retail staff), so status/availability/reserved-linkage is
// always the live, connected record — never a disconnected demo lookup.
export default function RetailScanQR({ lang }) {
  const navigate = useNavigate();
  const [found, setFound] = useState(false);

  function onDetected(code) {
    if (found) return;
    setFound(true);
    navigate(`/retail/product/${encodeURIComponent(code)}`);
  }

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🔍</div>
        <div className="dept-header-text"><h1>{t("scanQrTileLabel", lang)}</h1></div>
      </div>
      <div className="card">
        <QRScanner lang={lang} onDetected={onDetected} />
      </div>
    </div>
  );
}
