import React, { useEffect, useState } from "react";
import { attachmentUrl, isImageAttachment, isPdfAttachment } from "../lib/procurementApi";

// An order's photos and drawings as real thumbnails (signed, short-lived links from private storage -- nothing public).
// Click a photo for the full-size view; PDFs and drawings open in a new tab.
export default function AttachmentGallery({ files, lang }) {
  const [urls, setUrls] = useState({});
  const [open, setOpen] = useState(null);
  const L = (en, gu) => (lang === "gu" ? gu : en);

  useEffect(() => {
    let alive = true;
    Promise.all(files.map(async (f) => [f.id, await attachmentUrl(f.storage_path)])).then((pairs) => { if (alive) setUrls(Object.fromEntries(pairs)); });
    return () => { alive = false; };
  }, [files]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!files.length) return null;
  return (
    <>
      <div className="att-grid">
        {files.map((f, n) => {
          const name = f.original_file_name || f.file_name || `File ${n + 1}`;
          const url = urls[f.id];
          const image = isImageAttachment(f);
          return (
            <button key={f.id} type="button" className="att-tile" title={name}
              onClick={() => (image ? setOpen({ url, name }) : url && window.open(url, "_blank", "noopener"))} disabled={!url}>
              {image ? (url ? <img src={url} alt={name} loading="lazy" /> : <span className="att-icon">…</span>)
                : <span className="att-icon">{isPdfAttachment(f) ? "📄" : "📐"}</span>}
              <span className="att-name">{n + 1}. {name}</span>
            </button>
          );
        })}
      </div>
      {open && (
        <div className="att-lightbox" role="dialog" aria-modal="true" aria-label={open.name} onClick={() => setOpen(null)}>
          <img src={open.url} alt={open.name} onClick={(e) => e.stopPropagation()} />
          <div className="att-lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <span>{open.name}</span>
            <a className="btn btn-outline" href={open.url} target="_blank" rel="noopener noreferrer">{L("Open original", "મૂળ ખોલો")}</a>
            <button type="button" className="btn btn-primary" onClick={() => setOpen(null)}>{L("Close", "બંધ")}</button>
          </div>
        </div>
      )}
    </>
  );
}
