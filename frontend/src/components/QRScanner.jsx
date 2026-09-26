import React, { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { t } from "../lib/i18n";

// Shared camera QR scanner (plain getUserMedia + jsQR, no extra service) — used both as Godown's full-page Scan QR
// and embedded inline inside Retail's "Scan QR / Add Product" quotation flow. Decodes either a full product-detail
// URL (what a printed label encodes) or a bare code, and always hands back the bare code string via onDetected.
// Camera permission can be denied/unavailable — a manual code entry is always shown too, so scanning never blocks.
export default function QRScanner({ lang, onDetected }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const firedRef = useRef(false);
  const [cameraError, setCameraError] = useState(null);
  const [manualCode, setManualCode] = useState("");

  function codeFromText(text) {
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

  function fire(text) {
    const code = codeFromText(text);
    if (!code || firedRef.current) return;
    firedRef.current = true;
    onDetected(code);
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
        if (result?.data) { fire(result.data); return; }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((tr) => tr.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per mount; a fresh scanner starts a fresh camera stream
  }, []);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {!cameraError ? (
        <div style={{ position: "relative", maxWidth: 380, margin: "0 auto" }}>
          <video ref={videoRef} muted playsInline style={{ width: "100%", borderRadius: 10, background: "#000" }} />
          <canvas ref={canvasRef} style={{ display: "none" }} />
        </div>
      ) : (
        <div className="msg info">{t("cameraUnavailableMsg", lang)}</div>
      )}
      <div className="field full">
        <label>{t("enterCodeManuallyLabel", lang)}</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={manualCode} onChange={(e) => setManualCode(e.target.value)} style={{ minHeight: 48, fontSize: 16, flex: 1 }}
            placeholder="CHR-000125-001" onKeyDown={(e) => { if (e.key === "Enter") fire(manualCode); }} />
          <button type="button" className="btn btn-primary" style={{ minHeight: 48 }} onClick={() => fire(manualCode)}>{t("go", lang)}</button>
        </div>
      </div>
    </div>
  );
}
