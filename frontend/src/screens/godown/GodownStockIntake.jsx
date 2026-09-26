import React, { useEffect, useState } from "react";
import QRCode from "qrcode";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { startStockIntake, classifyStockPhoto, confirmStockIntake, listProductTypes, listInventoryItems } from "../../lib/retailApi";
import ProofPhotoUpload from "../../components/ProofPhotoUpload.jsx";

// New stock in, photo-first, tap-only wherever possible (v2_93r: corrected to the real two-tier Product Master vs.
// physical Inventory Serial shape):
// photo -> Product Type (a real, Head-managed dropdown — AI may suggest one, but the worker always confirms it
// from this list, never free text) -> quantity + Good/Damaged + rack + optional note -> confirm -> ONE permanent
// Product Model Code, and — when tracking each physical unit — N unique permanent Serial Numbers/QR codes sharing
// one GRN batch. Every generated field (code/serial/batch) comes from the server, never computed here.
export default function GodownStockIntake({ lang }) {
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState("");
  const [productTypes, setProductTypes] = useState([]);
  const [product, setProduct] = useState(null); // the placeholder row once intake has started
  const [photoCount, setPhotoCount] = useState(0);
  const [classifying, setClassifying] = useState(false);
  const [aiResult, setAiResult] = useState(null); // { category, product_name, unit, confidence } | null (AI failed/low-confidence)
  const [categoryStep, setCategoryStep] = useState("waiting"); // waiting | suggested | choosing | done
  const [form, setForm] = useState({ typeCode: "", typeName: "", name: "", unit: "Nos", quantity: 1, condition: "GOOD", rackLocation: "", note: "", itemLevel: null });
  const [categoryCorrected, setCategoryCorrected] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmedProduct, setConfirmedProduct] = useState(null); // the single Product Master row, once saved
  const [confirmedSerials, setConfirmedSerials] = useState(null); // [] of retail_inventory_items rows, if serialized
  const [qrUrls, setQrUrls] = useState({}); // code -> data URL
  const [error, setError] = useState(null);

  useEffect(() => {
    supabase.from("locations").select("id, name_en").eq("is_active", true).eq("type", "godown").order("name_en").then(({ data }) => setLocations(data || []));
    listProductTypes().then(({ data }) => setProductTypes(data || []));
  }, []);

  useEffect(() => {
    if (!confirmedProduct) { setQrUrls({}); return; }
    const codes = confirmedSerials?.length ? confirmedSerials.map((s) => s.serial_number) : [confirmedProduct.sku];
    let cancelled = false;
    Promise.all(codes.map((code) => QRCode.toDataURL(`${window.location.origin}/godown/product/${code}`, { width: 200, margin: 1 }).then((url) => [code, url]).catch(() => [code, null])))
      .then((pairs) => { if (!cancelled) setQrUrls(Object.fromEntries(pairs)); });
    return () => { cancelled = true; };
  }, [confirmedProduct, confirmedSerials]);

  async function begin() {
    if (!locationId) return;
    setError(null);
    const { data, error: err } = await startStockIntake(locationId);
    if (err) { setError(err.message); return; }
    setProduct(data);
  }

  async function onPhotoUploaded() {
    setPhotoCount((c) => c + 1);
    setClassifying(true);
    setCategoryStep("waiting");
    const res = await classifyStockPhoto(product.id);
    setClassifying(false);
    if (res?.ok && res.category) {
      setAiResult(res);
      // Match the AI's free-text guess to a real Product Type by name — never invents a type outside the list.
      const matched = productTypes.find((pt) => pt.name_en.toLowerCase() === String(res.category).toLowerCase());
      setForm((f) => ({ ...f, typeCode: matched?.code || "", typeName: matched?.name_en || res.category, name: res.product_name || res.category, unit: res.unit || "Nos" }));
      setCategoryStep("suggested");
    } else {
      setAiResult(null);
      setCategoryStep("choosing"); // AI failed — go straight to the plain Product Type buttons, never block intake.
    }
  }

  function confirmAiCategory() {
    setCategoryCorrected(false);
    setCategoryStep(form.typeCode ? "done" : "choosing"); // AI's guess didn't match a real type — still must pick one.
  }
  function openCategoryChoice() {
    setCategoryStep("choosing");
  }
  function pickType(pt) {
    setCategoryCorrected(aiResult ? pt.name_en !== aiResult.category : false);
    setForm((f) => ({ ...f, typeCode: pt.code, typeName: pt.name_en, name: f.name || pt.name_en }));
    setCategoryStep("done");
  }

  async function confirm() {
    if (!form.typeCode || (form.itemLevel === null && form.quantity > 1)) return;
    setConfirming(true);
    setError(null);
    const { data, error: err } = await confirmStockIntake(
      product.id, form.typeName, form.name || form.typeName, form.unit, form.quantity,
      form.condition, form.rackLocation || null, form.note || null, form.quantity > 1 ? !!form.itemLevel : false, categoryCorrected, form.typeCode);
    if (err) { setConfirming(false); setError(err.message); return; }
    setConfirmedProduct(data);
    if (form.quantity > 1 && form.itemLevel) {
      const { data: serials } = await listInventoryItems(data.id);
      setConfirmedSerials(serials || []);
    } else {
      setConfirmedSerials(null);
    }
    setConfirming(false);
  }

  function addAnother() {
    setProduct(null); setPhotoCount(0); setAiResult(null); setCategoryStep("waiting"); setCategoryCorrected(false);
    setForm({ typeCode: "", typeName: "", name: "", unit: "Nos", quantity: 1, condition: "GOOD", rackLocation: "", note: "", itemLevel: null });
    setConfirmedProduct(null); setConfirmedSerials(null); setQrUrls({});
  }

  const needsItemLevelChoice = form.quantity > 1 && form.itemLevel === null;
  const readyToConfirm = categoryStep === "done" && form.typeCode && !needsItemLevelChoice;
  const labels = confirmedProduct ? (confirmedSerials?.length ? confirmedSerials.map((s) => ({ code: s.serial_number, name: confirmedProduct.name })) : [{ code: confirmedProduct.sku, name: confirmedProduct.name }]) : [];

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📷</div>
        <div className="dept-header-text"><h1>{t("newStockInTileLabel", lang)}</h1></div>
      </div>

      {error && <div className="card"><div className="msg error">{error}</div></div>}

      {!product && !confirmedProduct && (
        <div className="card" style={{ display: "grid", gap: 12 }}>
          <div className="field">
            <label style={{ fontSize: 16 }}>{t("whereIsThisLabel", lang)}</label>
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)} style={{ minHeight: 52, fontSize: 16 }}>
              <option value="">—</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name_en}</option>)}
            </select>
          </div>
          <button type="button" className="btn btn-primary" style={{ minHeight: 56, fontSize: 18 }} disabled={!locationId} onClick={begin}>
            📷 {t("takePhotoAction", lang)}
          </button>
        </div>
      )}

      {product && !confirmedProduct && (
        <div className="card" style={{ display: "grid", gap: 14 }}>
          <ProofPhotoUpload lang={lang} entityType="retail_product" entityId={product.id} existingCount={photoCount} onUploaded={onPhotoUploaded} />
          {classifying && <div className="msg info">{t("identifyingItemLabel", lang)}…</div>}

          {photoCount > 0 && categoryStep === "suggested" && aiResult && (
            <div className="card" style={{ background: "var(--surface-2, #faf8f4)", display: "grid", gap: 10 }}>
              <div style={{ fontSize: 18 }}>
                {t("weIdentifiedLabel", lang)}: <b>{form.typeName}</b>
                {typeof aiResult.confidence === "number" && <span className="sub"> ({Math.round(aiResult.confidence * 100)}%)</span>}
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" className="btn btn-primary" style={{ minHeight: 52, fontSize: 17, flex: 1 }} disabled={!form.typeCode} onClick={confirmAiCategory}>✓ {t("correctAction", lang)}</button>
                <button type="button" className="btn btn-outline" style={{ minHeight: 52, fontSize: 17, flex: 1 }} onClick={openCategoryChoice}>{t("changeAction", lang)}</button>
              </div>
            </div>
          )}

          {photoCount > 0 && categoryStep === "choosing" && (
            <div className="card" style={{ display: "grid", gap: 10 }}>
              {!aiResult && <div className="msg info">{t("couldNotIdentifyMsg", lang)}</div>}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {productTypes.map((pt) => (
                  <button key={pt.code} type="button" className="btn btn-outline" style={{ minHeight: 52, fontSize: 15 }} onClick={() => pickType(pt)}>
                    {lang === "gu" ? pt.name_gu : pt.name_en}
                  </button>
                ))}
              </div>
            </div>
          )}

          {photoCount > 0 && categoryStep === "done" && (
            <>
              <div className="msg success">{t("categoryLabel", lang)}: <b>{form.typeName}</b>{categoryCorrected && <span className="sub"> ({t("changedFromAiLabel", lang)})</span>}</div>

              <div className="form-grid">
                <div className="field full"><label>{t("itemNameLabel", lang)}</label>
                  <input style={{ minHeight: 48, fontSize: 16 }} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>

                <div className="field full">
                  <label>{t("quantityLabel", lang)}</label>
                  <div className="task-meta" style={{ gap: 10 }}>
                    <button type="button" className="btn btn-outline" style={{ width: 52, minHeight: 52, fontSize: 22 }}
                      onClick={() => setForm((f) => ({ ...f, quantity: Math.max(1, Number(f.quantity) - 1), itemLevel: null }))}>−</button>
                    <span style={{ fontSize: 28, fontWeight: 800, minWidth: 50, textAlign: "center" }}>{form.quantity}</span>
                    <button type="button" className="btn btn-outline" style={{ width: 52, minHeight: 52, fontSize: 22 }}
                      onClick={() => setForm((f) => ({ ...f, quantity: Number(f.quantity) + 1, itemLevel: null }))}>+</button>
                  </div>
                </div>

                {needsItemLevelChoice && (
                  <div className="field full">
                    <label>{t("trackEachItemLabel", lang)}</label>
                    <div style={{ display: "flex", gap: 10 }}>
                      <button type="button" className="btn btn-outline" style={{ minHeight: 48, flex: 1 }} onClick={() => setForm((f) => ({ ...f, itemLevel: true }))}>{t("yesLabel", lang)}</button>
                      <button type="button" className="btn btn-outline" style={{ minHeight: 48, flex: 1 }} onClick={() => setForm((f) => ({ ...f, itemLevel: false }))}>{t("noLabel", lang)}</button>
                    </div>
                  </div>
                )}
                {form.quantity > 1 && form.itemLevel !== null && (
                  <div className="field full"><span className="fx-tag gold" style={{ cursor: "pointer" }} onClick={() => setForm((f) => ({ ...f, itemLevel: null }))}>
                    {form.itemLevel ? t("trackingEachItemLabel", lang) : t("trackingAsOneLabel", lang)} · {t("changeAction", lang)}
                  </span></div>
                )}

                <div className="field full">
                  <label>{t("conditionLabel", lang)}</label>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button type="button" className={`btn ${form.condition === "GOOD" ? "btn-primary" : "btn-outline"}`} style={{ minHeight: 48, flex: 1 }}
                      onClick={() => setForm((f) => ({ ...f, condition: "GOOD" }))}>✅ {t("conditionGoodLabel", lang)}</button>
                    <button type="button" className={`btn ${form.condition === "DAMAGED" ? "btn-primary" : "btn-outline"}`} style={{ minHeight: 48, flex: 1 }}
                      onClick={() => setForm((f) => ({ ...f, condition: "DAMAGED" }))}>⚠️ {t("conditionDamagedLabel", lang)}</button>
                  </div>
                </div>

                <div className="field full"><label>{t("rackLocationLabel", lang)}</label>
                  <input style={{ minHeight: 48, fontSize: 16 }} value={form.rackLocation} onChange={(e) => setForm((f) => ({ ...f, rackLocation: e.target.value }))} /></div>
                <div className="field full"><label>{t("optionalNoteLabel", lang)}</label>
                  <input style={{ minHeight: 48, fontSize: 16 }} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} /></div>
              </div>

              <button type="button" className="btn btn-primary" style={{ minHeight: 56, fontSize: 18 }}
                disabled={confirming || !readyToConfirm} onClick={confirm}>
                ✅ {t("confirmItemAction", lang)}
              </button>
            </>
          )}
        </div>
      )}

      {confirmedProduct && (
        <div className="card" style={{ textAlign: "center", display: "grid", gap: 12 }}>
          <div className="msg success">✅ {t("itemAddedLabel", lang)} — {labels.length > 1 ? `${labels.length} ${t("itemsLabel", lang)}` : "1"}</div>
          <div className="sub">{t("modelCodeLabel", lang)}: {confirmedProduct.sku}{confirmedProduct.batch_number ? ` · ${t("batchNumberLabel", lang)}: ${confirmedProduct.batch_number}` : ""}</div>
          <div id="godown-print-labels" style={{ display: "grid", gridTemplateColumns: labels.length > 1 ? "1fr 1fr" : "1fr", gap: 14 }}>
            {labels.map((l) => (
              <div key={l.code} style={{ border: "1px solid var(--border, #ddd)", borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: 1 }}>{l.code}</div>
                <div className="sub">{l.name}</div>
                {qrUrls[l.code] && <img src={qrUrls[l.code]} alt={l.code} style={{ width: 160, height: 160, margin: "8px auto" }} />}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-outline" style={{ minHeight: 52, fontSize: 16 }} onClick={() => window.print()}>🖨️ {t("printLabelsAction", lang)}</button>
            <button type="button" className="btn btn-primary" style={{ minHeight: 56, fontSize: 18 }} onClick={addAnother}>📷 {t("addAnotherItemAction", lang)}</button>
          </div>
        </div>
      )}
    </div>
  );
}
