import React, { useCallback, useEffect, useState } from "react";
import { uploadTaskProof, getProofPhotoUrl, removeTaskAttachment } from "../lib/api";
import { tagAttachmentSection, listFieldPhotos } from "../lib/factoryApi";
import { ACCEPT_ATTR } from "../lib/fileTypes";
import { t } from "../lib/i18n";

// Reusable field-level photo proof control (handwritten spec: a photo tied to the SPECIFIC field/section it
// proves -- PO photo, Product photo, Drawing photo -- not one generic upload box at the bottom of the form).
// Requires a real, already-created entityId (job card id): the parent form creates the job first (Step 1), then
// drops this beside each relevant field for Steps 2+. Reuses the exact same tested pipeline every other proof
// photo in this app uses (uploadTaskProof -> staff-file-url -> staff_record_attachment), tagging the result with
// section_key via the one new RPC this needs, so it never duplicates the upload/compress/retry logic.
export default function FieldPhotoProof({ lang, entityId, sectionKey, label, required = false, myUserId, onCountChange }) {
  const [photos, setPhotos] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [enlarged, setEnlarged] = useState(null);

  const load = useCallback(() => {
    if (!entityId) { setPhotos([]); onCountChange?.(0); return; }
    listFieldPhotos(entityId, sectionKey).then(async ({ data }) => {
      const rows = data || [];
      onCountChange?.(rows.length);
      const withUrls = await Promise.all(rows.map(async (r) => {
        try { return { ...r, url: await getProofPhotoUrl(r.id) }; } catch { return { ...r, url: null }; }
      }));
      setPhotos(withUrls);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, sectionKey]);
  useEffect(() => { load(); }, [load]);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !entityId) return;
    setUploading(true);
    setError(null);
    try {
      const res = await uploadTaskProof({ entityType: "factory_job_card_field", entityId, file, fileType: "image", purpose: "proof" });
      await tagAttachmentSection(res.attachmentId, sectionKey);
      load();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove(id) {
    await removeTaskAttachment(id, "retaken");
    load();
  }

  const satisfied = (photos || []).length > 0;

  return (
    <div className="field-photo-proof" style={{ marginTop: 6, padding: 8, border: "1px dashed var(--border-strong, #ccc)", borderRadius: 8 }}>
      <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <span className="sub" style={{ fontWeight: 700 }}>
          📷 {label || (lang === "gu" ? "ફોટો પુરાવો" : "Photo Proof")}
          {required && !satisfied && <span className="fx-tag bad" style={{ marginLeft: 6 }}>{lang === "gu" ? "ફોટો જરૂરી" : "Photo Required"}</span>}
          {satisfied && <span className="fx-tag" style={{ marginLeft: 6, background: "var(--accent-soft)" }}>✅ {photos.length}</span>}
        </span>
        {!entityId && <span className="sub">{lang === "gu" ? "પહેલા સાચવો" : "Save first"}</span>}
      </div>

      {entityId && (
        <div style={{ marginTop: 6 }}>
          <input type="file" accept={ACCEPT_ATTR("image")} capture="environment" disabled={uploading} onChange={handleFile} />
          {uploading && <div className="sub">{t("uploading", lang)}</div>}
          {error && <div className="msg error" style={{ marginTop: 4 }}>{error}</div>}
        </div>
      )}

      {photos && photos.length > 0 && (
        <div className="task-meta" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          {photos.map((p) => (
            <div key={p.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              {p.url ? (
                <img src={p.url} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border, #ddd)", cursor: "pointer" }}
                  onClick={() => setEnlarged(p.url)} />
              ) : <div style={{ width: 64, height: 64, borderRadius: 8, background: "var(--surface-2)" }} />}
              <span className="sub" style={{ fontSize: 10 }}>{p.uploaded_by === myUserId ? (lang === "gu" ? "તમે" : "You") : (p.uploader?.full_name || "—")}</span>
              <button type="button" className="btn btn-outline" style={{ minHeight: 28, padding: "2px 8px", fontSize: 11, width: "auto" }} onClick={() => handleRemove(p.id)}>
                🗑️ {lang === "gu" ? "કાઢી નાખો" : "Remove"}
              </button>
            </div>
          ))}
        </div>
      )}

      {enlarged && (
        <div className="proof-lightbox" role="dialog" aria-modal="true" onMouseDown={(e) => { if (e.target === e.currentTarget) setEnlarged(null); }}>
          <img src={enlarged} alt="" style={{ maxWidth: "92vw", maxHeight: "88vh", borderRadius: 8 }} />
          <button type="button" className="chat-x" aria-label={t("close", lang)} onClick={() => setEnlarged(null)} style={{ position: "absolute", top: 16, right: 16 }}>×</button>
        </div>
      )}
    </div>
  );
}
