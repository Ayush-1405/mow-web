import React, { useEffect, useState } from "react";
import QRCode from "qrcode";
import { supabase } from "../../lib/supabase";
import { t } from "../../lib/i18n";
import {
  startStockIntake, confirmStockIntake, listProductTypes, listInventoryItems, findSimilarProducts,
} from "../../lib/retailApi";
import { uploadTaskProof } from "../../lib/api";
import { humanSize, ACCEPT_ATTR } from "../../lib/fileTypes";
import { usePhotoCapture } from "../../lib/usePhotoCapture";

const AREAS = [
  ["DISPLAY", "areaDisplayLabel"],
  ["SALE_FLOOR", "areaSaleFloorLabel"],
  ["BACK_STORE", "areaBackStoreLabel"],
];

// Retail's own "Add New Product" (v2_93s) — the SAME Product Master / Inventory Serial / QR engine Godown's Stock
// Intake already uses (retail_start_stock_intake / retail_confirm_stock_intake / retail_product_types), reached by a
// plain salesperson from their phone: photo (local preview, photo-first) -> Product Type -> name -> a real
// duplicate-product check (fuzzy name + type, server-side) -> Store/Area/Quantity/Condition -> Save. A brand-new
// model a plain salesperson registers is saved Pending Retail Head Approval (never immediately quotable — enforced
// server-side, not just hidden here); Retail Head/oversight registering directly is immediately Active, same as
// Godown. Choosing an existing product from the duplicate check never mints a second model — it only adds a new
// serial + QR under the model that already exists.
export default function RetailAddProduct({ lang }) {
  const photo = usePhotoCapture();

  const [locations, setLocations] = useState([]);
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [locationsError, setLocationsError] = useState(null);
  const [locationId, setLocationId] = useState("");
  const [area, setArea] = useState("");

  const [productTypes, setProductTypes] = useState([]);
  const [typeCode, setTypeCode] = useState("");
  const [typeName, setTypeName] = useState("");
  const [name, setName] = useState("");

  const [checkingSimilar, setCheckingSimilar] = useState(false);
  const [similar, setSimilar] = useState([]);
  const [selectedExisting, setSelectedExisting] = useState(null); // a candidate row from findSimilarProducts, or null
  const [dismissedSimilar, setDismissedSimilar] = useState(false);

  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState("GOOD");
  const [note, setNote] = useState("");

  const [product, setProduct] = useState(null); // the placeholder row, created exactly once at Save (kept across a retry)
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [confirmedProduct, setConfirmedProduct] = useState(null);
  const [confirmedSerials, setConfirmedSerials] = useState(null);
  const [qrUrls, setQrUrls] = useState({});

  function loadLocations() {
    setLocationsLoading(true);
    setLocationsError(null);
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

  // Duplicate-product check: debounced, runs once a type is picked and a name of real length has been typed.
  // Never blocks the form — it just surfaces candidates for the worker to confirm/dismiss.
  useEffect(() => {
    if (!typeCode || name.trim().length < 3 || selectedExisting) { setSimilar([]); return; }
    setDismissedSimilar(false);
    const handle = setTimeout(async () => {
      setCheckingSimilar(true);
      const { data } = await findSimilarProducts(typeCode, name.trim());
      setCheckingSimilar(false);
      setSimilar(data || []);
    }, 500);
    return () => clearTimeout(handle);
  }, [typeCode, name, selectedExisting]);

  useEffect(() => {
    if (!confirmedProduct) { setQrUrls({}); return; }
    const codes = confirmedSerials?.length ? confirmedSerials.map((s) => s.serial_number) : [confirmedProduct.sku];
    let cancelled = false;
    Promise.all(codes.map((code) => QRCode.toDataURL(`${window.location.origin}/retail/product/${code}`, { width: 200, margin: 1 }).then((url) => [code, url]).catch(() => [code, null])))
      .then((pairs) => { if (!cancelled) setQrUrls(Object.fromEntries(pairs)); });
    return () => { cancelled = true; };
  }, [confirmedProduct, confirmedSerials]);

  function pickType(pt) {
    setTypeCode(pt.code);
    setTypeName(lang === "gu" ? pt.name_gu : pt.name_en);
    setSelectedExisting(null);
  }

  function chooseExisting(candidate) {
    setSelectedExisting(candidate);
  }
  function changeExistingChoice() {
    setSelectedExisting(null);
  }

  const readyToSave = !!photo.file && !!typeCode && name.trim().length > 0 && !!locationId && !!area && quantity >= 1;

  async function save() {
    if (!readyToSave || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      let placeholder = product;
      if (!placeholder) {
        const { data, error: err } = await startStockIntake(locationId);
        if (err) throw new Error(err.message);
        placeholder = data;
        setProduct(data);
      }
      await uploadTaskProof({ entityType: "retail_product", entityId: placeholder.id, file: photo.file, fileType: "image", purpose: "proof" });
      const { data, error: err } = await confirmStockIntake(
        placeholder.id, typeName, name.trim(), "Nos", quantity, condition, null, note || null,
        true, false, typeCode, area, selectedExisting?.id || null);
      if (err) throw new Error(err.message);
      setConfirmedProduct(data);
      const { data: allSerials } = await listInventoryItems(data.id);
      setConfirmedSerials((allSerials || []).slice(-Number(quantity)));
    } catch (err) {
      setSaveError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  function addAnother() {
    photo.remove();
    setProduct(null);
    setLocationId(""); setArea(""); setTypeCode(""); setTypeName(""); setName("");
    setSimilar([]); setSelectedExisting(null); setDismissedSimilar(false);
    setQuantity(1); setCondition("GOOD"); setNote("");
    setSaveError(null); setConfirmedProduct(null); setConfirmedSerials(null); setQrUrls({});
  }

  const labels = confirmedProduct
    ? (confirmedSerials?.length ? confirmedSerials.map((s) => ({ code: s.serial_number, name: confirmedProduct.name })) : [{ code: confirmedProduct.sku, name: confirmedProduct.name }])
    : [];

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📷</div>
        <div className="dept-header-text"><h1>{t("addNewProductTileLabel", lang)}</h1></div>
      </div>

      {!confirmedProduct && (
        <div className="card" style={{ display: "grid", gap: 14 }}>
          {/* Photo — taken/chosen first, held only as a local preview until Save. */}
          <div className="field">
            <label style={{ fontSize: 16 }}>{t("photoProofLabel", lang)}</label>
            <input ref={photo.fileInputRef} type="file" accept={ACCEPT_ATTR("image")} capture="environment" onChange={photo.handleSelected} hidden />
            <input ref={photo.galleryInputRef} type="file" accept={ACCEPT_ATTR("image")} onChange={photo.handleSelected} hidden />
            {!photo.previewUrl ? (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" className="btn btn-primary" style={{ minHeight: 56, fontSize: 18, flex: 1 }} onClick={photo.openCamera}>
                  📷 {t("takePhotoAction", lang)}
                </button>
                <button type="button" className="btn btn-outline" style={{ minHeight: 56, fontSize: 16, flex: 1 }} onClick={photo.openGallery}>
                  🖼️ {t("chooseFromGalleryAction", lang)}
                </button>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
                <img src={photo.previewUrl} alt="" style={{ width: "100%", maxWidth: 320, borderRadius: 8, margin: "0 auto", display: "block" }} />
                <div className="sub" style={{ textAlign: "center" }}>{photo.file ? humanSize(photo.file.size) : ""}</div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button type="button" className="btn btn-outline" style={{ flex: 1, minHeight: 48 }} onClick={photo.openCamera}>🔁 {t("retakePhotoAction", lang)}</button>
                  <button type="button" className="btn btn-outline" style={{ flex: 1, minHeight: 48 }} onClick={photo.remove}>✕ {t("removePhotoAction", lang)}</button>
                </div>
              </div>
            )}
            {photo.error && <div className="msg error" style={{ marginTop: 6 }}>{photo.error}</div>}
          </div>

          {/* Product Type + Name */}
          <div className="field">
            <label style={{ fontSize: 16 }}>{t("productTypeLabel", lang)}</label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {productTypes.map((pt) => (
                <button key={pt.code} type="button" className={`btn ${typeCode === pt.code ? "btn-primary" : "btn-outline"}`} style={{ minHeight: 48, fontSize: 14 }}
                  onClick={() => pickType(pt)}>
                  {lang === "gu" ? pt.name_gu : pt.name_en}
                </button>
              ))}
            </div>
          </div>

          <div className="field full">
            <label>{t("itemNameLabel", lang)}</label>
            <input style={{ minHeight: 48, fontSize: 16 }} value={name} onChange={(e) => { setName(e.target.value); setSelectedExisting(null); }} />
          </div>

          {/* Duplicate-product check */}
          {checkingSimilar && <div className="msg info">{t("checkingForSimilarMsg", lang)}…</div>}
          {!checkingSimilar && similar.length > 0 && !selectedExisting && !dismissedSimilar && (
            <div className="card" style={{ background: "var(--surface-2, #faf8f4)", display: "grid", gap: 10 }}>
              <div className="msg info">⚠️ {t("similarProductFoundMsg", lang)}</div>
              {similar.map((c) => (
                <div key={c.id} className="task-meta" style={{ justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap", gap: 8 }}>
                  <span>{c.sku} — {c.name}{c.material ? ` · ${c.material}` : ""}</span>
                  <button type="button" className="btn btn-outline" style={{ minHeight: 40 }} onClick={() => chooseExisting(c)}>{t("useExistingProductAction", lang)}</button>
                </div>
              ))}
              <button type="button" className="btn btn-outline" style={{ minHeight: 44 }} onClick={() => setDismissedSimilar(true)}>{t("createNewModelAction", lang)}</button>
            </div>
          )}
          {selectedExisting && (
            <div className="msg success" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span>{t("usingExistingProductMsg", lang)}: <b>{selectedExisting.sku} — {selectedExisting.name}</b></span>
              <button type="button" className="btn btn-outline" style={{ minHeight: 36 }} onClick={changeExistingChoice}>{t("changeAction", lang)}</button>
            </div>
          )}

          {/* Store / Area */}
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
            {!locationsLoading && !locationsError && !locationId && <div className="sub" style={{ marginTop: 4 }}>{t("selectLocationFirstMsg", lang)}</div>}
          </div>

          <div className="field">
            <label style={{ fontSize: 16 }}>{t("areaLabel", lang)}</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {AREAS.map(([code, labelKey]) => (
                <button key={code} type="button" className={`btn ${area === code ? "btn-primary" : "btn-outline"}`} style={{ minHeight: 48, flex: 1, minWidth: 100 }}
                  onClick={() => setArea(code)}>
                  {t(labelKey, lang)}
                </button>
              ))}
            </div>
          </div>

          <div className="field full">
            <label>{t("quantityLabel", lang)}</label>
            <div className="task-meta" style={{ gap: 10 }}>
              <button type="button" className="btn btn-outline" style={{ width: 52, minHeight: 52, fontSize: 22 }} onClick={() => setQuantity((q) => Math.max(1, Number(q) - 1))}>−</button>
              <span style={{ fontSize: 28, fontWeight: 800, minWidth: 50, textAlign: "center" }}>{quantity}</span>
              <button type="button" className="btn btn-outline" style={{ width: 52, minHeight: 52, fontSize: 22 }} onClick={() => setQuantity((q) => Number(q) + 1)}>+</button>
            </div>
          </div>

          <div className="field full">
            <label>{t("conditionLabel", lang)}</label>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" className={`btn ${condition === "GOOD" ? "btn-primary" : "btn-outline"}`} style={{ minHeight: 48, flex: 1 }} onClick={() => setCondition("GOOD")}>✅ {t("conditionGoodLabel", lang)}</button>
              <button type="button" className={`btn ${condition === "DAMAGED" ? "btn-primary" : "btn-outline"}`} style={{ minHeight: 48, flex: 1 }} onClick={() => setCondition("DAMAGED")}>⚠️ {t("conditionDamagedLabel", lang)}</button>
            </div>
          </div>

          <div className="field full">
            <label>{t("optionalNoteLabel", lang)}</label>
            <input style={{ minHeight: 48, fontSize: 16 }} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          {saveError && (
            <div className="msg error" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span>{saveError}</span>
              <button type="button" className="btn btn-outline" onClick={save}>{t("retry", lang)}</button>
            </div>
          )}

          <button type="button" className="btn btn-primary" style={{ minHeight: 56, fontSize: 18 }} disabled={saving || !readyToSave} onClick={save}>
            {saving ? `${t("uploadingPhotoMsg", lang)}…` : `✅ ${t("save", lang)}`}
          </button>
        </div>
      )}

      {confirmedProduct && (
        <div className="card" style={{ textAlign: "center", display: "grid", gap: 12 }}>
          <div className="msg success">✅ {t("itemAddedLabel", lang)} — {labels.length > 1 ? `${labels.length} ${t("itemsLabel", lang)}` : "1"}</div>
          {confirmedProduct.approval_status === "PENDING_APPROVAL" && (
            <div className="msg info">⏳ {t("pendingApprovalBannerMsg", lang)}</div>
          )}
          <div className="sub">{t("modelCodeLabel", lang)}: {confirmedProduct.sku}{confirmedProduct.batch_number ? ` · ${t("batchNumberLabel", lang)}: ${confirmedProduct.batch_number}` : ""}</div>
          <div id="retail-print-labels" style={{ display: "grid", gridTemplateColumns: labels.length > 1 ? "1fr 1fr" : "1fr", gap: 14 }}>
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
