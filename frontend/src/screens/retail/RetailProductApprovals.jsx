import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../../lib/i18n";
import { listPendingProductApprovals, approveProduct, listProductTypes, mergeDuplicateProducts, scanProduct } from "../../lib/retailApi";
import ProofPhotoViewer from "../../components/ProofPhotoViewer.jsx";

// Retail Head/oversight's approval queue (v2_93s) for a Product Master a plain Retail employee just registered.
// Server-enforced (retail_pending_product_approvals/retail_approve_product already gate on role) — this screen is
// the UI for that gate, not the gate itself: a product stays un-quotable until approved here regardless of what
// this page shows.
export default function RetailProductApprovals({ lang }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [productTypes, setProductTypes] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeFromId, setMergeFromId] = useState(null);
  const [mergeIntoCode, setMergeIntoCode] = useState("");
  const [mergeReason, setMergeReason] = useState("");
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeMsg, setMergeMsg] = useState(null);

  const load = useCallback(async () => {
    const { data, error: err } = await listPendingProductApprovals();
    if (err) { setError(err.message); return; }
    setError(null);
    setRows(data || []);
  }, []);

  useEffect(() => { load(); listProductTypes().then(({ data }) => setProductTypes(data || [])); }, [load]);

  function openApproval(row) {
    setOpenId(row.id);
    setMsg(null);
    setForm({
      typeCode: "", name: row.name, material: "", colorFinish: "", dimensions: "", description: "",
      warrantyText: "", gstPercent: "", mrp: "", sellingPrice: "", minApprovedPrice: "", reason: "",
    });
  }

  async function submitApproval(productId) {
    if (!form.reason.trim()) return;
    setBusy(true);
    setMsg(null);
    const { error: err } = await approveProduct(
      productId, form.typeCode || null, form.name, form.material || null, form.colorFinish || null, form.dimensions || null,
      form.description || null, form.warrantyText || null, form.gstPercent === "" ? null : Number(form.gstPercent),
      form.mrp === "" ? null : Number(form.mrp), form.sellingPrice === "" ? null : Number(form.sellingPrice),
      form.minApprovedPrice === "" ? null : Number(form.minApprovedPrice), form.reason.trim());
    setBusy(false);
    if (err) { setMsg({ type: "error", text: err.message }); return; }
    setOpenId(null);
    setMsg({ type: "success", text: t("productApprovedMsg", lang) });
    load();
  }

  async function submitMerge() {
    if (!mergeFromId || !mergeIntoCode.trim() || !mergeReason.trim()) return;
    setMergeBusy(true);
    setMergeMsg(null);
    const { data: target, error: scanErr } = await scanProduct(mergeIntoCode.trim());
    if (scanErr || !target?.product?.id) {
      setMergeBusy(false);
      setMergeMsg({ type: "error", text: scanErr?.message || t("productNotFoundMsg", lang) });
      return;
    }
    const { error: err } = await mergeDuplicateProducts(mergeFromId, target.product.id, mergeReason.trim());
    setMergeBusy(false);
    if (err) { setMergeMsg({ type: "error", text: err.message }); return; }
    setMergeOpen(false);
    setMsg({ type: "success", text: t("productMergedMsg", lang) });
    load();
  }

  if (rows === null && !error) return <div className="dept-dashboard"><div className="msg info">…</div></div>;

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">✍️</div>
        <div className="dept-header-text"><h1>{t("productApprovalsTileLabel", lang)}</h1></div>
        <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={load}>{t("refresh", lang)}</button>
      </div>

      {error && <div className="card"><div className="msg error">{error}</div><button className="btn btn-primary" onClick={load}>{t("retry", lang)}</button></div>}
      {msg && <div className="card"><div className={`msg ${msg.type}`}>{msg.text}</div></div>}

      {rows && rows.length === 0 && <div className="card"><div className="msg info">{t("approvalQueueEmptyMsg", lang)}</div></div>}

      {rows && rows.map((row) => (
        <div key={row.id} className="card" style={{ display: "grid", gap: 10 }}>
          <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 700 }}>{row.sku} — {row.name}</div>
              <div className="sub">{row.product_type_name || row.category} · {t("registeredByLabel", lang)}: {row.created_by_name || "—"} · {new Date(row.created_at).toLocaleString()}</div>
            </div>
            <span className="badge">{t("originDepartmentLabel", lang)}: {row.origin_department}</span>
          </div>
          <ProofPhotoViewer lang={lang} entityType="retail_product" entityId={row.id} />

          {openId !== row.id ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" className="btn btn-primary" style={{ minHeight: 48 }} onClick={() => openApproval(row)}>{t("approveProductAction", lang)}</button>
              <button type="button" className="btn btn-outline" style={{ minHeight: 48 }} onClick={() => navigate(`/retail/product/${row.sku}`)}>{t("viewDetailsAction", lang)}</button>
              <button type="button" className="btn btn-outline" style={{ minHeight: 48 }} onClick={() => { setMergeOpen(true); setMergeFromId(row.id); setMergeIntoCode(""); setMergeReason(""); setMergeMsg(null); }}>
                {t("mergeProductsAction", lang)}
              </button>
            </div>
          ) : (
            <div className="form-grid">
              {msg?.type === "error" && <div className="msg error" style={{ gridColumn: "1 / -1" }}>{msg.text}</div>}
              <div className="field full">
                <label>{t("productTypeLabel", lang)}</label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  {productTypes.map((pt) => (
                    <button key={pt.code} type="button" className={`btn ${form.typeCode === pt.code ? "btn-primary" : "btn-outline"}`} style={{ minHeight: 40, fontSize: 13 }}
                      onClick={() => setForm((f) => ({ ...f, typeCode: pt.code }))}>
                      {lang === "gu" ? pt.name_gu : pt.name_en}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field full"><label>{t("itemNameLabel", lang)}</label>
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
              <div className="field"><label>{t("materialLabel", lang)}</label>
                <input value={form.material} onChange={(e) => setForm((f) => ({ ...f, material: e.target.value }))} /></div>
              <div className="field"><label>{t("colorFinishLabel", lang)}</label>
                <input value={form.colorFinish} onChange={(e) => setForm((f) => ({ ...f, colorFinish: e.target.value }))} /></div>
              <div className="field"><label>{t("dimensionsLabel", lang)}</label>
                <input value={form.dimensions} onChange={(e) => setForm((f) => ({ ...f, dimensions: e.target.value }))} /></div>
              <div className="field"><label>{t("warrantyTextLabel", lang)}</label>
                <input value={form.warrantyText} onChange={(e) => setForm((f) => ({ ...f, warrantyText: e.target.value }))} /></div>
              <div className="field full"><label>{t("descriptionLabel", lang)}</label>
                <input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></div>
              <div className="field"><label>{t("mrpLabel", lang)}</label>
                <input type="number" value={form.mrp} onChange={(e) => setForm((f) => ({ ...f, mrp: e.target.value }))} /></div>
              <div className="field"><label>{t("sellingPriceLabel", lang)}</label>
                <input type="number" value={form.sellingPrice} onChange={(e) => setForm((f) => ({ ...f, sellingPrice: e.target.value }))} /></div>
              <div className="field"><label>{t("minApprovedPriceLabel", lang)}</label>
                <input type="number" value={form.minApprovedPrice} onChange={(e) => setForm((f) => ({ ...f, minApprovedPrice: e.target.value }))} /></div>
              <div className="field"><label>{t("gstPercentLabel", lang)}</label>
                <input type="number" value={form.gstPercent} onChange={(e) => setForm((f) => ({ ...f, gstPercent: e.target.value }))} /></div>
              <div className="field full"><label>{t("reasonForChangeLabel", lang)} *</label>
                <input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} /></div>
              <div className="field full" style={{ display: "flex", gap: 10 }}>
                <button type="button" className="btn btn-primary" style={{ flex: 1, minHeight: 48 }} disabled={busy || !form.reason.trim()} onClick={() => submitApproval(row.id)}>
                  ✅ {t("approveProductAction", lang)}
                </button>
                <button type="button" className="btn btn-outline" style={{ minHeight: 48 }} onClick={() => setOpenId(null)}>{t("back", lang)}</button>
              </div>
            </div>
          )}
        </div>
      ))}

      {mergeOpen && (
        <div className="card" style={{ display: "grid", gap: 10 }}>
          <h3>{t("mergeProductsAction", lang)}</h3>
          {mergeMsg && <div className={`msg ${mergeMsg.type}`}>{mergeMsg.text}</div>}
          <div className="field full"><label>{t("mergeIntoProductCodeLabel", lang)}</label>
            <input value={mergeIntoCode} onChange={(e) => setMergeIntoCode(e.target.value)} placeholder="CHR-000125" /></div>
          <div className="field full"><label>{t("reasonForChangeLabel", lang)} *</label>
            <input value={mergeReason} onChange={(e) => setMergeReason(e.target.value)} /></div>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" className="btn btn-primary" style={{ flex: 1, minHeight: 48 }} disabled={mergeBusy || !mergeIntoCode.trim() || !mergeReason.trim()} onClick={submitMerge}>
              {t("mergeProductsAction", lang)}
            </button>
            <button type="button" className="btn btn-outline" style={{ minHeight: 48 }} onClick={() => setMergeOpen(false)}>{t("back", lang)}</button>
          </div>
        </div>
      )}
    </div>
  );
}
