import React, { useState } from "react";
import { uploadTaskProof } from "../lib/api";
import { ACCEPT_ATTR } from "../lib/fileTypes";
import { t } from "../lib/i18n";

// Shared "real, permanently-stored proof photo" control for the Retail fulfilment pipeline (packing / godown handover / dispatch /
// delivery / installation). Reuses the SAME uploadTaskProof() pipeline the rest of the app already uses for task attachments —
// staff-file-url mints a signed URL, the file is PUT directly to Supabase Storage, then staff_record_attachment() links it as a
// real staff_attachments row (purpose='proof'). Never a blob: URL, never base64 in state.
export default function ProofPhotoUpload({ lang, entityType, entityId, onUploaded, existingCount = 0, label }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const res = await uploadTaskProof({ entityType, entityId, file, fileType: "image", purpose: "proof" });
      onUploaded?.(res);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="field" style={{ marginTop: 6 }}>
      <label>{label || t("photoProofLabel", lang)} {existingCount > 0 ? `✅ (${existingCount})` : ""}</label>
      <input type="file" accept={ACCEPT_ATTR("image")} capture="environment" disabled={uploading} onChange={handleFile} />
      {uploading && <div className="sub">{t("uploading", lang)}</div>}
      {error && <div className="msg error" style={{ marginTop: 4 }}>{error}</div>}
    </div>
  );
}
