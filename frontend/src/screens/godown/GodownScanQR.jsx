import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import jsQR from "jsqr";
import { t } from "../../lib/i18n";

// Scan QR — plain getUserMedia + jsQR, no extra scanning service. Decodes either a full product-detail URL (what
// our own printed labels encode) or a bare code typed/scanned as plain text, and always ends up at the same
// /godown/product/:sku detail page. Camera permission can be denied or unavailable (older phones, no HTTPS in some
// dev setups) — a manual code entry is always shown too, so scanning never blocks the worker.
export default function GodownScanQR({ lang }) {
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const [cameraError, setCameraError] = useState(null);
  const [manualCode, setManualCode] = useState("");
  const [found, setFound] = useState(false);

  function codeToSku(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return "";
    try {
      const u = new URL(trimmed);
      const parts = u.pathname.split("/").filter(Boolean);
      const idx = parts.indexOf("product");
      if (idx >= 0 && parts[idx + 1]) return decodeURIComponent(parts[idx + 1]);
    } catch { /* not a URL — treat as a bare code */ }
    return trimmed;
  }

  function goToSku(text) {
    const sku = codeToSku(text);
    if (!sku || found) return;
    setFound(true);
    navigate(`/godown/product/${encodeURIComponent(sku)}`);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled) { stream.getTracks().forEach((tr) => tr.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        tick();
      } catch (e) {
        setCameraError(e?.message || "Camera unavailable");
      }
    })();

    function tick() {
      const video = videoRef.current, canvas = canvasRef.current;
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = jsQR(img.data, img.width, img.height);
        if (result?.data) { goToSku(result.data); return; }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((tr) => tr.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once; goToSku/found are stable enough for a scan loop
  }, []);

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🔍</div>
        <div className="dept-header-text"><h1>{t("scanQrTileLabel", lang)}</h1></div>
      </div>

      <div className="card" style={{ textAlign: "center" }}>
        {!cameraError ? (
          <div style={{ position: "relative", maxWidth: 420, margin: "0 auto" }}>
            <video ref={videoRef} muted playsInline style={{ width: "100%", borderRadius: 10, background: "#000" }} />
            <canvas ref={canvasRef} style={{ display: "none" }} />
          </div>
        ) : (
          <div className="msg info">{t("cameraUnavailableMsg", lang)}</div>
        )}
      </div>

      <div className="card">
        <div className="field full">
          <label>{t("enterCodeManuallyLabel", lang)}</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={manualCode} onChange={(e) => setManualCode(e.target.value)} style={{ minHeight: 48, fontSize: 16, flex: 1 }}
              placeholder="CHR-000001" onKeyDown={(e) => { if (e.key === "Enter") goToSku(manualCode); }} />
            <button type="button" className="btn btn-primary" style={{ minHeight: 48 }} onClick={() => goToSku(manualCode)}>{t("go", lang)}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
