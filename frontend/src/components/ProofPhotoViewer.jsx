import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { getProofPhotoUrl } from "../lib/api";
import { t } from "../lib/i18n";

// Closes the "checkmark-only" gap: every proof stage this session required a real photo, but nothing ever rendered
// it back — a salesperson only ever saw "✓ photo uploaded", never the photo itself. Given entityType/entityId, this
// lists the real staff_attachments rows (purpose='proof') and renders actual <img> thumbnails (click to enlarge),
// using the same cached-signed-URL pattern already proven for voice playback.
export default function ProofPhotoViewer({ lang, entityType, entityId, label }) {
  const [photos, setPhotos] = useState(null); // [{id, url}] once resolved
  const [enlarged, setEnlarged] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!entityId) { setPhotos([]); return; }
    (async () => {
      const { data } = await supabase.from("staff_attachments").select("id").eq("entity_type", entityType).eq("entity_id", entityId)
        .eq("purpose", "proof").eq("is_active", true).order("created_at", { ascending: false });
      const rows = data || [];
      const withUrls = await Promise.all(rows.map(async (r) => {
        try { return { id: r.id, url: await getProofPhotoUrl(r.id) }; } catch { return { id: r.id, url: null }; }
      }));
      if (!cancelled) setPhotos(withUrls);
    })();
    return () => { cancelled = true; };
  }, [entityType, entityId]);

  if (photos === null) return <div className="sub">…</div>;
  if (photos.length === 0) return null;

  return (
    <div style={{ marginTop: 6 }}>
      {label && <div className="sub" style={{ marginBottom: 4 }}>{label}</div>}
      <div className="task-meta" style={{ gap: 8, flexWrap: "wrap" }}>
        {photos.map((p) => p.url ? (
          <img key={p.id} src={p.url} alt={label || t("photoProofLabel", lang)}
            style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border, #ddd)", cursor: "pointer" }}
            onClick={() => setEnlarged(p.url)} />
        ) : null)}
      </div>
      {enlarged && (
        <div className="proof-lightbox" role="dialog" aria-modal="true" onMouseDown={(e) => { if (e.target === e.currentTarget) setEnlarged(null); }}>
          <img src={enlarged} alt="" style={{ maxWidth: "92vw", maxHeight: "88vh", borderRadius: 8 }} />
          <button type="button" className="chat-x" aria-label={t("close", lang)} onClick={() => setEnlarged(null)}
            style={{ position: "absolute", top: 16, right: 16 }}>×</button>
        </div>
      )}
    </div>
  );
}
