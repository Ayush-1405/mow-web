import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import OrderFormPrint from "./OrderFormPrint";
import { confirmPrint, downloadAttachment, recordOrderPrint, setPrintTemplate, uploadPrintedPdf } from "../lib/procurementApi";
import { PAPERS, PAPERS_FOR_TEMPLATE, makeCompletePdf, prepareAttachments, printPdf } from "../lib/orderFormPdf";
import { L, fmtDate, orderFormTemplate } from "../lib/procurementRules";
import { friendlyError } from "../lib/friendlyError";

// Print preview of the complete official document: page 1 is the Mood of Wood order form, then every attached photo,
// drawing and PDF. Print and Download both build that same PDF (photos embedded as data, page-numbered); Print hands it
// to the computer's own print dialog (any installed printer), Download saves it. A copy is kept with the order and each
// is recorded. A file that cannot go into the PDF is named before anything is made -- never dropped silently. Opening
// the print dialog is not taken as "printed": the user confirms that the paper came out.

const MM = 96 / 25.4;
const now = () => `${fmtDate(new Date().toISOString())} ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}`;

export default function OrderPrintPreview({ lang, request, items, context, order, files, company, taskNumber, printedBy, canChangeTemplate, onClose, onChanged }) {
  const [template, setTemplate] = useState(orderFormTemplate(request));
  const [paper, setPaper] = useState(PAPERS_FOR_TEMPLATE[orderFormTemplate(request)][0]);
  const [scale, setScale] = useState(1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [lastPrint, setLastPrint] = useState(null);
  const [tplChange, setTplChange] = useState(null);
  const [att, setAtt] = useState(null);
  const [ackMissing, setAckMissing] = useState(false);
  const sheetRef = useRef(null);
  const scrollRef = useRef(null);
  const p = PAPERS[paper];

  // Load and check every attachment once.
  useEffect(() => {
    let alive = true;
    let made = [];
    prepareAttachments(files, downloadAttachment)
      .then((res) => { made = res; if (alive) setAtt(res); })
      .catch((e) => { if (alive) setAtt([{ name: L(lang, "Attachments", "જોડાણ"), ok: false, kind: "other", error: e?.message || String(e) }]); });
    return () => { alive = false; made.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl)); };
  }, [files, lang]);

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

  const failed = (att || []).filter((a) => !a.ok);
  const included = (att || []).filter((a) => a.ok);
  const ready = att !== null && (failed.length === 0 || ackMissing);

  // Builds the complete PDF, keeps a copy with the order and records it. Returns { blob, log } or null.
  async function build(output) {
    const blob = await makeCompletePdf({ sheet: sheetRef.current, paper, attachments: included, requestNumber: request.request_number });
    const path = await uploadPrintedPdf(request.id, blob, `${request.request_number}-order-form.pdf`);
    const { data, error } = await recordOrderPrint(request.id, output, path);
    if (error) { setMsg({ type: "error", text: friendlyError(error.message) }); return null; }
    return { blob, log: data, saved: !!path };
  }

  async function doPrint() {
    setBusy(true); setMsg(null);
    try {
      const res = await build("PRINT");
      if (!res) return;
      const inPage = await printPdf(res.blob);
      setLastPrint(res.log);
      setMsg({ type: "info", text: inPage
        ? L(lang, "The print window has the complete order form. Choose your printer there.", "પ્રિન્ટ વિન્ડોમાં પૂરું ઓર્ડર ફોર્મ છે. ત્યાં પ્રિન્ટર પસંદ કરો.")
        : L(lang, "The complete order form opened in a new tab — print it from there.", "પૂરું ઓર્ડર ફોર્મ નવા ટેબમાં ખૂલ્યું — ત્યાંથી છાપો.") });
      onChanged?.();
    } catch (e) {
      setMsg({ type: "error", text: L(lang, `Could not make the document: ${e?.message || e}`, `દસ્તાવેજ બનાવી શકાયો નહીં: ${e?.message || e}`) });
    } finally { setBusy(false); }
  }

  async function doPdf() {
    setBusy(true); setMsg(null);
    try {
      const res = await build("PDF");
      if (!res) return;
      const url = URL.createObjectURL(res.blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${request.request_number}-order-form.pdf`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setMsg({ type: res.saved ? "success" : "warning", text: res.saved
        ? L(lang, "Complete PDF downloaded; a copy is kept with the order.", "પૂરી PDF ડાઉનલોડ થઈ; ઓર્ડર સાથે નકલ સાચવી.")
        : L(lang, "Complete PDF downloaded, but the copy could not be saved with the order.", "PDF ડાઉનલોડ થઈ, પણ ઓર્ડર સાથે નકલ સાચવાઈ નહીં.") });
      onChanged?.();
    } catch (e) {
      setMsg({ type: "error", text: L(lang, `Could not make the PDF: ${e?.message || e}`, `PDF બનાવી શકાઈ નહીં: ${e?.message || e}`) });
    } finally { setBusy(false); }
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

  const pdfPages = included.reduce((s, a) => s + (a.kind === "pdf" ? a.pages : 0), 0);
  return createPortal(
    <div className="op-overlay" role="dialog" aria-modal="true" aria-label={L(lang, "Order form print preview", "ઓર્ડર ફોર્મ પ્રિન્ટ પૂર્વાવલોકન")}>
      <div className="op-toolbar">
        <h2>🖨 {request.request_number} · {template === "INTERIOR" ? L(lang, "Interior form", "ઇન્ટિરિયર ફોર્મ") : L(lang, "Retail form", "રિટેલ ફોર્મ")}</h2>
        <select value={paper} onChange={(e) => setPaper(e.target.value)} aria-label={L(lang, "Paper", "કાગળ")} disabled={busy}>
          {PAPERS_FOR_TEMPLATE[template].map((k) => <option key={k} value={k}>{L(lang, PAPERS[k].en, PAPERS[k].gu)}</option>)}
        </select>
        {canChangeTemplate && !tplChange && (
          <button type="button" className="btn btn-outline" disabled={busy}
            onClick={() => setTplChange({ template: template === "INTERIOR" ? "RETAIL" : "INTERIOR", reason: "" })}>
            {L(lang, "Use the other form…", "બીજું ફોર્મ…")}
          </button>
        )}
        <button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={doPrint}>🖨 {L(lang, "Print", "પ્રિન્ટ")}</button>
        <button type="button" className="btn btn-outline" disabled={busy || !ready} onClick={doPdf}>⬇ {L(lang, "Download complete PDF", "પૂરી PDF ડાઉનલોડ")}</button>
        <button type="button" className="btn btn-outline" disabled={busy} onClick={onClose}>{L(lang, "Close", "બંધ")}</button>
      </div>
      {tplChange && (
        <div className="op-confirm">
          <span>{L(lang, `Print this order on the ${tplChange.template === "RETAIL" ? "Retail (small, portrait)" : "Interior (large, with rate & amount)"} form. Reason:`, "બીજા ફોર્મ પર છાપવાનું કારણ:")}</span>
          <input value={tplChange.reason} onChange={(e) => setTplChange((t) => ({ ...t, reason: e.target.value }))} style={{ maxWidth: 320, margin: 0 }} />
          <button type="button" className="btn btn-primary" disabled={busy || !tplChange.reason.trim()} onClick={changeTemplate}>{L(lang, "Change form", "ફોર્મ બદલો")}</button>
          <button type="button" className="btn btn-outline" onClick={() => setTplChange(null)}>{L(lang, "Cancel", "રદ")}</button>
        </div>
      )}
      {att === null && <div className="op-confirm">{L(lang, `Loading ${files.length} attachment(s) for the document…`, `દસ્તાવેજ માટે ${files.length} જોડાણ લોડ થાય છે…`)}</div>}
      {failed.length > 0 && (
        <div className="op-confirm" style={{ background: "var(--danger-bg)" }}>
          <div style={{ width: "100%" }}>
            <strong style={{ color: "var(--danger)" }}>{L(lang, "These attachments cannot be put into the PDF:", "આ જોડાણ PDF માં મૂકી શકાય તેમ નથી:")}</strong>
            <ul style={{ margin: "4px 0 6px 18px" }}>{failed.map((a) => <li key={a.name}>{a.name} — {a.error}</li>)}</ul>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 600 }}>
              <input type="checkbox" checked={ackMissing} onChange={(e) => setAckMissing(e.target.checked)} style={{ width: "auto", margin: 0 }} />
              {L(lang, "Continue without them (they stay attached to the order; send them to the vendor separately)", "તેમના વગર આગળ વધો (તે ઓર્ડર સાથે રહેશે; વેન્ડરને અલગથી મોકલો)")}
            </label>
          </div>
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
              company={company} meta={{ taskNumber, version: request.document_version || 1, printedBy, printedAt: now() }} />
          </div>
        </div>
        {att && att.length > 0 && (
          <div className="op-attachments">
            <h3>{L(lang, `Attachment pages after the form: ${included.length} file(s)${pdfPages ? `, incl. ${pdfPages} PDF page(s)` : ""}`,
              `ફોર્મ પછીના જોડાણ પાનાં: ${included.length} ફાઇલ`)}</h3>
            <div className="op-att-grid">
              {att.map((a, n) => (
                <div key={`${a.name}-${n}`} className={`op-att ${a.ok ? "" : "bad"}`}>
                  {a.kind === "image" && a.ok ? <img src={a.previewUrl} alt={a.name} /> : <div className="op-att-icon">{a.kind === "pdf" ? "📄" : "⚠"}</div>}
                  <div className="op-att-cap">{n + 1}. {a.name}{a.kind === "pdf" && a.ok ? ` — ${a.pages} ${L(lang, "page(s)", "પાનાં")}` : ""}{!a.ok ? ` — ${L(lang, "not included", "સામેલ નથી")}` : ""}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
