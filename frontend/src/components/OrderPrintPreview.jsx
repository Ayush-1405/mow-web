import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import OrderFormPrint from "./OrderFormPrint";
import { confirmPrint, recordOrderPrint, setPrintTemplate, uploadPrintedPdf } from "../lib/procurementApi";
import { PAPERS, PAPERS_FOR_TEMPLATE, makeOrderFormPdf, pageCss } from "../lib/orderFormPdf";
import { L, fmtDate, orderFormTemplate } from "../lib/procurementRules";
import { friendlyError } from "../lib/friendlyError";

// Print preview of the official order form. Print opens the computer's own print dialog (any installed printer -- HP,
// Canon, Epson, Brother ... -- paper, orientation and copies are chosen there). Download PDF makes the PDF here, keeps a
// copy with the order and downloads it. Each is recorded first; the dialog opening is never taken as "printed": the user
// confirms afterwards that the paper came out.

const MM = 96 / 25.4;
const now = () => `${fmtDate(new Date().toISOString())} ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}`;

export default function OrderPrintPreview({ lang, request, items, context, order, files, taskNumber, printedBy, canChangeTemplate, onClose, onChanged }) {
  const [template, setTemplate] = useState(orderFormTemplate(request));
  const [paper, setPaper] = useState(PAPERS_FOR_TEMPLATE[orderFormTemplate(request)][0]);
  const [scale, setScale] = useState(1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [lastPrint, setLastPrint] = useState(null);
  const [tplChange, setTplChange] = useState(null);
  const sheetRef = useRef(null);
  const scrollRef = useRef(null);
  const p = PAPERS[paper];

  // Fit the sheet to the screen (phones) without changing what prints.
  const fit = useCallback(() => {
    const avail = (scrollRef.current?.clientWidth || window.innerWidth) - 36;
    setScale(Math.min(1, avail / (p.w * MM)));
  }, [p.w]);
  useLayoutEffect(() => { fit(); }, [fit]);
  useEffect(() => { window.addEventListener("resize", fit); return () => window.removeEventListener("resize", fit); }, [fit]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function doPrint() {
    setBusy(true); setMsg(null);
    const { data, error } = await recordOrderPrint(request.id, "PRINT");
    setBusy(false);
    if (error) { setMsg({ type: "error", text: friendlyError(error.message) }); return; }
    const style = document.createElement("style");
    style.textContent = pageCss(paper);
    document.head.appendChild(style);
    document.body.classList.add("printing-order-form");
    const done = () => {
      document.body.classList.remove("printing-order-form");
      style.remove();
      window.removeEventListener("afterprint", done);
      setLastPrint(data);
      onChanged?.();
    };
    window.addEventListener("afterprint", done);
    requestAnimationFrame(() => window.print());
  }

  async function doPdf() {
    setBusy(true); setMsg(null);
    try {
      const blob = await makeOrderFormPdf(sheetRef.current, paper);
      const name = `${request.request_number}-order-form.pdf`;
      const path = await uploadPrintedPdf(request.id, blob, name);
      const { error } = await recordOrderPrint(request.id, "PDF", path);
      if (error) { setMsg({ type: "error", text: friendlyError(error.message) }); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setMsg({ type: path ? "success" : "warning", text: path
        ? L(lang, "PDF downloaded and a copy is kept with the order.", "PDF ડાઉનલોડ થઈ અને ઓર્ડર સાથે નકલ સાચવી.")
        : L(lang, "PDF downloaded, but the copy could not be saved with the order.", "PDF ડાઉનલોડ થઈ, પણ ઓર્ડર સાથે નકલ સાચવાઈ નહીં.") });
      onChanged?.();
    } catch (e) {
      setMsg({ type: "error", text: L(lang, `Could not make the PDF: ${e?.message || e}`, `PDF બનાવી શકાઈ નહીં: ${e?.message || e}`) });
    } finally {
      setBusy(false);
    }
  }

  async function confirmPrinted() {
    setBusy(true);
    const { error } = await confirmPrint(lastPrint.log_id);
    setBusy(false);
    if (error) { setMsg({ type: "error", text: friendlyError(error.message) }); return; }
    setLastPrint(null);
    setMsg({ type: "success", text: L(lang, "Recorded: the order form was printed. Next: confirm Order Placed.", "નોંધાયું: ફોર્મ છપાયું. હવે ઓર્ડર મૂક્યાની પુષ્ટિ કરો.") });
    onChanged?.();
  }

  async function changeTemplate() {
    setBusy(true);
    const { error } = await setPrintTemplate(request.id, tplChange.template, tplChange.reason);
    setBusy(false);
    if (error) { setMsg({ type: "error", text: friendlyError(error.message) }); return; }
    setTemplate(tplChange.template);
    setPaper(PAPERS_FOR_TEMPLATE[tplChange.template][0]);
    setTplChange(null);
    onChanged?.();
  }

  return createPortal(
    <div className="op-overlay" role="dialog" aria-modal="true" aria-label={L(lang, "Order form print preview", "ઓર્ડર ફોર્મ પ્રિન્ટ પૂર્વાવલોકન")}>
      <div className="op-toolbar">
        <h2>🖨 {L(lang, "Order form", "ઓર્ડર ફોર્મ")} {request.request_number} · {template === "INTERIOR" ? L(lang, "Interior (small)", "ઇન્ટિરિયર (નાનું)") : L(lang, "Retail (large)", "રિટેલ (મોટું)")}</h2>
        <select value={paper} onChange={(e) => setPaper(e.target.value)} aria-label={L(lang, "Paper", "કાગળ")} disabled={busy}>
          {PAPERS_FOR_TEMPLATE[template].map((k) => <option key={k} value={k}>{L(lang, PAPERS[k].en, PAPERS[k].gu)}</option>)}
        </select>
        {canChangeTemplate && !tplChange && (
          <button type="button" className="btn btn-outline" disabled={busy}
            onClick={() => setTplChange({ template: template === "INTERIOR" ? "RETAIL" : "INTERIOR", reason: "" })}>
            {L(lang, "Use the other form…", "બીજું ફોર્મ…")}
          </button>
        )}
        <button type="button" className="btn btn-primary" disabled={busy} onClick={doPrint}>🖨 {L(lang, "Print", "પ્રિન્ટ")}</button>
        <button type="button" className="btn btn-outline" disabled={busy} onClick={doPdf}>{busy ? L(lang, "Working…", "ચાલુ…") : `⬇ ${L(lang, "Download PDF", "PDF ડાઉનલોડ")}`}</button>
        <button type="button" className="btn btn-outline" disabled={busy} onClick={onClose}>{L(lang, "Close", "બંધ")}</button>
      </div>
      {tplChange && (
        <div className="op-confirm">
          <span>{L(lang, `Print this order on the ${tplChange.template === "RETAIL" ? "Retail (large)" : "Interior (small)"} form. Reason:`, "બીજા ફોર્મ પર છાપવાનું કારણ:")}</span>
          <input value={tplChange.reason} onChange={(e) => setTplChange((t) => ({ ...t, reason: e.target.value }))} style={{ maxWidth: 320, margin: 0 }} />
          <button type="button" className="btn btn-primary" disabled={busy || !tplChange.reason.trim()} onClick={changeTemplate}>{L(lang, "Change form", "ફોર્મ બદલો")}</button>
          <button type="button" className="btn btn-outline" onClick={() => setTplChange(null)}>{L(lang, "Cancel", "રદ")}</button>
        </div>
      )}
      {lastPrint && (
        <div className="op-confirm">
          <strong>{L(lang, "Did the order form print correctly?", "ઓર્ડર ફોર્મ બરાબર છપાયું?")}</strong>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={confirmPrinted}>{L(lang, "Yes, it printed", "હા, છપાયું")}</button>
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => { setLastPrint(null); doPrint(); }}>{L(lang, "No — print again", "ના — ફરી છાપો")}</button>
        </div>
      )}
      {msg && <div className={`msg ${msg.type}`} style={{ margin: 0, borderRadius: 0 }}>{msg.text}</div>}
      <div className="op-scroll" ref={scrollRef}>
        <div className="op-stage" style={{ transform: `scale(${scale})`, height: scale < 1 ? `${p.h * MM * scale}px` : undefined }}>
          <div className="op-sheet" data-paper={paper} ref={sheetRef}>
            <OrderFormPrint request={{ ...request, print_template: template }} items={items} context={context} order={order} files={files} template={template}
              meta={{ taskNumber, version: request.document_version || 1, printedBy, printedAt: now() }} />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
