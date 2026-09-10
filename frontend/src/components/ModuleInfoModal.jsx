import React from "react";
import { t } from "../lib/i18n";

// Simple information panel for a Phase-2 function card. Deliberately does
// nothing else — no fake data, no dead links, just an honest "not built
// yet" message plus the card's own bilingual name.
export default function ModuleInfoModal({ lang, card, onClose }) {
  if (!card) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-card-title">
          {lang === "gu" ? card.gu : card.en}
          <div className="sub">{lang === "gu" ? card.en : card.gu}</div>
        </div>
        <span className="badge phase2-badge">{t("setupPending", lang)}</span>
        <p className="modal-card-body">{t("moduleInfoBody", lang)}</p>
        <button className="btn btn-outline" onClick={onClose}>{t("close", lang)}</button>
      </div>
    </div>
  );
}
