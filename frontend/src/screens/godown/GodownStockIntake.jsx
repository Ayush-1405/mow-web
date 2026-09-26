import React, { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import { startStockIntake, classifyStockPhoto, confirmStockIntake, listProductTypes, listInventoryItems } from "../../lib/retailApi";
import { uploadTaskProof } from "../../lib/api";
import { validateUploadFile, humanSize, ACCEPT_ATTR } from "../../lib/fileTypes";
import ProofPhotoUpload from "../../components/ProofPhotoUpload.jsx";

// New stock in, photo-first, tap-only wherever possible (v2_93r: two-tier Product Master vs. physical Inventory
// Serial; v2_93s: the actual capture flow — photo is taken/chosen FIRST and held only as a local preview, a
// location is required only right before Save, and the first real write (a placeholder retail_products row) is
// created exactly once, at Save, never re-created on a retry):
// photo (local preview) -> location -> Save (creates the placeholder + uploads the already-selected photo) ->
// Product Type (a real, Head-managed dropdown — AI may suggest one, but the worker always confirms it from this
// list, never free text) -> quantity + Good/Damaged + rack + optional note -> confirm -> ONE permanent Product
// Model Code, and — when tracking each physical unit — N unique permanent Serial Numbers/QR codes sharing one
// GRN batch. Every generated field (code/serial/batch) comes from the server, never computed here.
export default function GodownStockIntake({ lang }) {
  const fileInputRef = useRef(null);
  const galleryInputRef = useRef(null);
  const photoPreviewUrlRef = useRef(null);

  const [locations, setLocations] = useState([]);
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [locationsError, setLocationsError] = useState(null);
  const [locationId, setLocationId] = useState("");
  const [productTypes, setProductTypes] = useState([]);

  // The photo is captured/chosen before anything is written to the database. photoPreviewUrl is a LOCAL
  // (URL.createObjectURL) preview only — it is never sent anywhere and is revoked on retake/remove/unmount.
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState(null);
  const [photoError, setPhotoError] = useState(null);

  const [product, setProduct] = useState(null); // the placeholder row, created exactly once at Save (kept across a retry)
  const [starting, setStarting] = useState(false); // true across create-placeholder + upload-photo + classify
  const [startError, setStartError] = useState(null);
  const [photoCount, setPhotoCount] = useState(0); // > 0 once the first photo is confirmed uploaded (gates the rest of the flow)
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

  function loadLocations() {
    setLocationsLoading(true);
    setLocationsError(null);
    // Every active location a worker might be standing in — Godown, Factory Store, a Retail showroom, Display, etc.
    // (not filtered to type="godown", which used to hide every location except one).
    supabase.from("locations").select("id, name_en").eq("is_active", true).order("name_en").then(({ data, error: err }) => {
      setLocationsLoading(false);
      if (err) { setLocationsError(err.message); return; }
      setLocations(data || []);
    });
  }

  useEffect(() => {
    loadLocations();
    listProductTypes().then(({ data }) => setProductTypes(data || []));
  }, []);

  useEffect(() => { photoPreviewUrlRef.current = photoPreviewUrl; }, [photoPreviewUrl]);
  useEffect(() => () => { if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current); }, []);

  useEffect(() => {
    if (!confirmedProduct) { setQrUrls({}); return; }
    const codes = confirmedSerials?.length ? confirmedSerials.map((s) => s.serial_number) : [confirmedProduct.sku];
    let cancelled = false;
    Promise.all(codes.map((code) => QRCode.toDataURL(`${window.location.origin}/godown/product/${code}`, { width: 200, margin: 1 }).then((url) => [code, url]).catch(() => [code, null])))
      .then((pairs) => { if (!cancelled) setQrUrls(Object.fromEntries(pairs)); });
    return () => { cancelled = true; };
  }, [confirmedProduct, confirmedSerials]);

  async function handlePhotoSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPhotoError(null);
    try {
      // Real content validation (extension + browser MIME, HEIC/HEIF included) — never trusts the extension alone,
      // and gives a specific message instead of letting an unsupported file fail later as a generic 400.
      await validateUploadFile(file, "image");
      if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
      setPhotoFile(file);
      setPhotoPreviewUrl(URL.createObjectURL(file));
    } catch (err) {
      setPhotoError(err.message || String(err));
    }
  }

  function removePhoto() {
    if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
    setPhotoFile(null);
    setPhotoPreviewUrl(null);
    setPhotoError(null);
  }

  // Runs once, at Save: create the placeholder row (only if one doesn't already exist from a previous failed
  // attempt — never re-created on retry, so a retry can never leave behind a duplicate stock record), upload the
  // already-selected photo, then ask the AI classifier for a suggested category. The form's own values (photo,
  // location) are left exactly as they were if any step fails, so Retry never loses what the worker already did.
  async function startIntake() {
    if (!photoFile || !locationId || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      let placeholder = product;
      if (!placeholder) {
        const { data, error: err } = await startStockIntake(locationId);
        if (err) throw new Error(err.message);
        placeholder = data;
        setProduct(data);
      }
      await uploadTaskProof({ entityType: "retail_product", entityId: placeholder.id, file: photoFile, fileType: "image", purpose: "proof" });
      setPhotoCount(1);
      setClassifying(true);
      setCategoryStep("waiting");
      const res = await classifyStockPhoto(placeholder.id);
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
    } catch (err) {
      setStartError(err.message || String(err));
    } finally {
      setStarting(false);
    }
  }

  async function onMorePhotoUploaded() {
    setPhotoCount((c) => c + 1);
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
    removePhoto();
    setLocationId("");
    setProduct(null); setStarting(false); setStartError(null);
    setPhotoCount(0); setAiResult(null); setCategoryStep("waiting"); setCategoryCorrected(false);
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

      {photoCount === 0 && !confirmedProduct && (
        <div className="card" style={{ display: "grid", gap: 14 }}>
          <div className="field">
            <label style={{ fontSize: 16 }}>{t("photoProofLabel", lang)}</label>

            {/* Exact pattern: a hidden real <input type="file"> triggered by a plain type="button" — never inside
                a disabled fieldset, no invisible overlay over it, and it stays keyboard-reachable via the button. */}
            <input ref={fileInputRef} type="file" accept={ACCEPT_ATTR("image")} capture="environment" onChange={handlePhotoSelected} hidden />
            <input ref={galleryInputRef} type="file" accept={ACCEPT_ATTR("image")} onChange={handlePhotoSelected} hidden />

            {!photoPreviewUrl ? (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" className="btn btn-primary" style={{ minHeight: 56, fontSize: 18, flex: 1 }}
                  onClick={() => fileInputRef.current?.click()}>
                  📷 {t("takePhotoAction", lang)}
                </button>
                <button type="button" className="btn btn-outline" style={{ minHeight: 56, fontSize: 16, flex: 1 }}
                  onClick={() => galleryInputRef.current?.click()}>
                  🖼️ {t("chooseFromGalleryAction", lang)}
                </button>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
                <img src={photoPreviewUrl} alt="" style={{ width: "100%", maxWidth: 320, borderRadius: 8, margin: "0 auto", display: "block" }} />
                <div className="sub" style={{ textAlign: "center" }}>{photoFile ? humanSize(photoFile.size) : ""}</div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button type="button" className="btn btn-outline" style={{ flex: 1, minHeight: 48 }} onClick={() => fileInputRef.current?.click()}>
                    🔁 {t("retakePhotoAction", lang)}
                  </button>
                  <button type="button" className="btn btn-outline" style={{ flex: 1, minHeight: 48 }} onClick={removePhoto}>
                    ✕ {t("removePhotoAction", lang)}
                  </button>
                </div>
              </div>
            )}
            {photoError && <div className="msg error" style={{ marginTop: 6 }}>{photoError}</div>}
          </div>

          <div className="field">
            <label style={{ fontSize: 16 }}>{t("whereIsThisLabel", lang)}</label>
            {locationsLoading ? (
              <div className="msg info">{t("loadingLocationsMsg", lang)}…</div>
            ) : locationsError ? (
              <div style={{ display: "grid", gap: 8 }}>
                <div className="msg error">{t("couldNotLoadLocationsMsg", lang)}</div>
                <button type="button" className="btn btn-outline" onClick={loadLocations}>{t("retry", lang)}</button>
              </div>
            ) : (
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)} style={{ minHeight: 52, fontSize: 16 }}>
                <option value="">—</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name_en}</option>)}
              </select>
            )}
            {!locationsLoading && !locationsError && !locationId && (
              <div className="sub" style={{ marginTop: 4 }}>{t("selectLocationFirstMsg", lang)}</div>
            )}
          </div>

          {startError && (
            <div className="msg error" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span>{startError}</span>
              <button type="button" className="btn btn-outline" onClick={startIntake}>{t("retry", lang)}</button>
            </div>
          )}

          {photoFile && !locationId && !locationsLoading && !locationsError && (
            <div className="sub">{t("selectLocationFirstMsg", lang)}</div>
          )}
          {!photoFile && (
            <div className="sub">{t("takeOrChoosePhotoFirstMsg", lang)}</div>
          )}

          <button type="button" className="btn btn-primary" style={{ minHeight: 56, fontSize: 18 }}
            disabled={starting || !photoFile || !locationId} onClick={startIntake}>
            {starting ? `${t("uploadingPhotoMsg", lang)}…` : `✅ ${t("save", lang)}`}
          </button>
        </div>
      )}

      {photoCount > 0 && !confirmedProduct && (
        <div className="card" style={{ display: "grid", gap: 14 }}>
          <ProofPhotoUpload lang={lang} entityType="retail_product" entityId={product.id} existingCount={photoCount} onUploaded={onMorePhotoUploaded} />
          {classifying && <div className="msg info">{t("identifyingItemLabel", lang)}…</div>}

          {categoryStep === "suggested" && aiResult && (
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

          {categoryStep === "choosing" && (
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

          {categoryStep === "done" && (
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
