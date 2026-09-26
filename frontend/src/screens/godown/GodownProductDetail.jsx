import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import QRCode from "qrcode";
import { t } from "../../lib/i18n";
import { scanProduct, logLabelReprint } from "../../lib/retailApi";
import ProofPhotoViewer from "../../components/ProofPhotoViewer.jsx";

// The QR/scan target — one page per product code, whether reached by camera scan, manual code entry, or a direct
// link. Shows exactly what a scan is supposed to show: the real photo, code, category, current quantity/status per
// location, condition, batch, any linked reserved order, and (for authorized staff) its movement history.
export default function GodownProductDetail({ lang }) {
  const { sku } = useParams();
  const [detail, setDetail] = useState(null); // { product, stock, reserved_for, movements } | null | "error"
  const [qrUrl, setQrUrl] = useState(null);
  const [reprintOpen, setReprintOpen] = useState(false);
  const [reprintReason, setReprintReason] = useState("");
  const [reprintBusy, setReprintBusy] = useState(false);
  const [reprintMsg, setReprintMsg] = useState(null);

  const load = useCallback(async () => {
    const { data, error } = await scanProduct(sku);
    if (error) { setDetail("error"); return; }
    setDetail(data || null);
  }, [sku]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!detail || detail === "error") { setQrUrl(null); return; }
    QRCode.toDataURL(`${window.location.origin}/godown/product/${detail.product.sku}`, { width: 240, margin: 1 }).then(setQrUrl).catch(() => setQrUrl(null));
  }, [detail]);

  async function submitReprint() {
    if (!reprintReason.trim()) return;
    setReprintBusy(true);
    const { error } = await logLabelReprint(detail.product.id, reprintReason.trim());
    setReprintBusy(false);
    if (error) { setReprintMsg({ type: "error", text: error.message }); return; }
    setReprintMsg({ type: "success", text: t("reprintLoggedMsg", lang) });
    setReprintOpen(false);
    setReprintReason("");
    window.print();
  }

  if (detail === null) return <div className="dept-dashboard"><div className="msg info">…</div></div>;
  if (detail === "error") {
    return (
      <div className="dept-dashboard">
        <div className="msg error">{t("productNotFoundMsg", lang)}</div>
        <button className="btn btn-primary" onClick={load}>{t("retry", lang)}</button>
      </div>
    );
  }

  const { product, stock, reserved_for: reservedFor, movements } = detail;
  const totalOnHand = (stock || []).reduce((s, r) => s + Number(r.on_hand_qty || 0), 0);

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🔍</div>
        <div className="dept-header-text"><h1>{product.name}</h1></div>
      </div>

      <div className="card" style={{ textAlign: "center" }} id="godown-print-labels">
        <ProofPhotoViewer lang={lang} entityType="retail_product" entityId={product.id} />
        <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: 1, marginTop: 8 }}>{product.sku}</div>
        <div className="sub">{product.category}{product.batch_number ? ` · ${product.batch_number}` : ""}</div>
        {qrUrl && <img src={qrUrl} alt={product.sku} style={{ width: 200, height: 200, margin: "10px auto" }} />}
      </div>

      <div className="card">
        <div className="task-meta" style={{ gap: 8, flexWrap: "wrap" }}>
          <span className={`badge ${product.condition === "DAMAGED" ? "RETURNED" : "VERIFIED"}`}>{product.condition === "DAMAGED" ? t("conditionDamagedLabel", lang) : t("conditionGoodLabel", lang)}</span>
          <span className="badge">{t("onHandLabel", lang)}: {totalOnHand}</span>
          {product.confirmed_at && <span className="fx-tag">{t("receivedDateLabel", lang)}: {new Date(product.confirmed_at).toLocaleDateString()}</span>}
        </div>
        {product.intake_note && <div className="sub" style={{ marginTop: 6 }}>{t("optionalNoteLabel", lang)}: {product.intake_note}</div>}
      </div>

      <div className="card">
        <h3>{t("godownRackLabel", lang)}</h3>
        {(stock || []).length === 0 && <div className="msg info">{t("noStockDataMsg", lang)}</div>}
        {(stock || []).map((s) => (
          <div key={s.location_id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
            <span>{s.location_name}{s.rack_location ? ` · ${s.rack_location}` : ""}</span>
            <span className="sub">{t("onHandLabel", lang)}: {s.on_hand_qty}{s.damaged_qty > 0 ? ` · ${t("damagedLabel", lang)}: ${s.damaged_qty}` : ""}</span>
          </div>
        ))}
      </div>

      {reservedFor && reservedFor.length > 0 && (
        <div className="card">
          <h3>{t("reservedForOrderLabel", lang)}</h3>
          {reservedFor.map((r, i) => (
            <div key={i} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
              <span>{r.order_number} — {r.customer_name}</span>
              <span className="sub">{t("quantityLabel", lang)}: {r.quantity}</span>
            </div>
          ))}
        </div>
      )}

      {movements && movements.length > 0 && (
        <div className="card">
          <h3>{t("movementHistoryLabel", lang)}</h3>
          {movements.map((m, i) => (
            <div key={i} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0" }}>
              <span>{m.from_location || "—"} → {m.to_location}</span>
              <span className="sub">{t("quantityLabel", lang)}: {m.quantity} · {new Date(m.moved_at).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ display: "grid", gap: 10 }}>
        {reprintMsg && <div className={`msg ${reprintMsg.type}`}>{reprintMsg.text}</div>}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-outline" onClick={() => window.print()}>🖨️ {t("printLabelsAction", lang)}</button>
          <a className="btn btn-outline" href={qrUrl || "#"} download={`${product.sku}.png`}>⬇️ {t("downloadLabelAction", lang)}</a>
          <button type="button" className="btn btn-outline" onClick={() => setReprintOpen((o) => !o)}>🔁 {t("reprintAction", lang)}</button>
        </div>
        {reprintOpen && (
          <div className="form-grid">
            <div className="field full"><label>{t("reprintReasonLabel", lang)} *</label>
              <input value={reprintReason} onChange={(e) => setReprintReason(e.target.value)} /></div>
            <div className="field full">
              <button type="button" className="btn btn-primary" disabled={reprintBusy || !reprintReason.trim()} onClick={submitReprint}>
                {t("confirmAssignAction", lang)}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
