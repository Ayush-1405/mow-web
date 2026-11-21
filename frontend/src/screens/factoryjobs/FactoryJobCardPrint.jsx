import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MOW_LOGO } from "../../lib/brand";
import { attachmentUrl, downloadAttachment, isImageAttachment } from "../../lib/procurementApi";
import { PAPERS, makeCompletePdf, prepareAttachments, printPdf } from "../../lib/orderFormPdf";
import { L, effectiveDue, fmtQty, jobStatusLabel, priorityLabel } from "../../lib/factoryJobRules";

// PRINT JOB CARD: the Mood of Wood Factory Job Card on A4 (more pages when it is long), then every photo, drawing and
// PDF attached to the card as real pages. Print hands the PDF to the computer's own print dialog; Download saves it.
// Logo and address come from the app (brand logo + Company & settings) -- nothing invented; an empty field prints blank.

const MM = 96 / 25.4;
const fmtDate = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("-") : "");

function CompanyBlock({ company }) {
  if (!company) return null;
  const place = [company.city, company.state].filter(Boolean).join(", ") + (company.pin_code ? ` - ${company.pin_code}` : "");
  const lines = [company.address_line, place.trim(), [company.phone && `Ph: ${company.phone}`, company.email].filter(Boolean).join(" · "),
    company.gstin && `GSTIN: ${company.gstin}`].filter(Boolean);
  return (
    <div className="fjcp-company">
      {company.company_name && <div className="fjcp-company-name">{company.company_name}</div>}
      {lines.map((l) => <div key={l}>{l}</div>)}
    </div>
  );
}

export function JobCardSheet({ job, items, files, names, company, qc, imageUrls }) {
  const images = files.filter((f) => isImageAttachment(f) && f.kind !== "DISPATCH").slice(0, 6);
  const lastQc = qc[qc.length - 1];
  const row = (label, value) => <tr><th>{label}</th><td>{value || ""}</td></tr>;
  return (
    <div className="fjcp">
      <header className="fjcp-head">
        <div className="fjcp-brand"><img src={MOW_LOGO} alt="Mood of Wood" className="fjcp-logo" /><CompanyBlock company={company} /></div>
        <div className="fjcp-title">
          <div className="fjcp-title-en">FACTORY JOB CARD</div>
          <div className="fjcp-title-gu">ફેક્ટરી જોબ કાર્ડ</div>
          <div className="fjcp-no">{job.job_card_number}</div>
        </div>
      </header>

      <table className="fjcp-info"><tbody>
        <tr><th>Department</th><td>{job.departments?.name_en}</td><th>Requested by</th><td>{names[job.requested_by]}</td></tr>
        <tr><th>Client</th><td>{job.client_name}</td><th>Project</th><td>{job.project_name}</td></tr>
        <tr><th>Order date</th><td>{fmtDate(job.order_date)}</td><th>Required completion</th>
          <td><b>{fmtDate(effectiveDue(job))}</b>{job.revised_due_date ? ` (revised; original ${fmtDate(job.due_date)})` : ""}</td></tr>
        <tr><th>Priority</th><td>{priorityLabel(job.priority, "en")}</td><th>Assigned employee</th><td>{names[job.assigned_to]}</td></tr>
        <tr><th>Delivery location</th><td colSpan={3}>{job.delivery_location}</td></tr>
        <tr><th>Status</th><td>{jobStatusLabel(job.status, "en")}</td><th>Production started</th><td>{fmtDate(job.production_started_at)}</td></tr>
      </tbody></table>

      <div className="fjcp-band">PRODUCT DETAILS / ઉત્પાદન વિગત</div>
      <table className="fjcp-items">
        <thead><tr><th>#</th><th>Product / Item code</th><th>Qty</th><th>Dimensions</th><th>Material</th><th>Finish / Colour</th><th>Laminate / Fabric / Hardware</th></tr></thead>
        <tbody>{items.map((i) => (
          <tr key={i.id}>
            <td className="c">{i.line_no}</td>
            <td><b>{i.product_name}</b>{i.item_code && <div className="fjcp-sub">Code {i.item_code}</div>}{i.product_category && <div className="fjcp-sub">{i.product_category}</div>}
              {i.description && <div className="fjcp-sub">{i.description}</div>}{i.instructions && <div className="fjcp-sub">Note: {i.instructions}</div>}</td>
            <td className="c">{fmtQty(i.quantity)} {i.unit}</td><td>{i.dimensions}</td><td>{i.material_spec}</td><td>{i.finish_colour}</td><td>{i.laminate_fabric_hardware}</td>
          </tr>
        ))}</tbody>
      </table>

      <table className="fjcp-info fjcp-after"><tbody>
        {row("Production instructions", job.special_instructions)}
        {row("Production remarks", job.production_remarks)}
      </tbody></table>

      {images.length > 0 && (
        <>
          <div className="fjcp-band">PRODUCT IMAGES / ઉત્પાદન ફોટા</div>
          <div className="fjcp-images">
            {images.map((f) => imageUrls[f.id] ? <figure key={f.id}><img src={imageUrls[f.id]} alt={f.file_name} crossOrigin="anonymous" /><figcaption>{f.file_name}</figcaption></figure> : null)}
          </div>
        </>
      )}
      {files.length > 0 && (
        <div className="fjcp-files"><b>Drawings and attachments (full size on the following pages):</b> {files.map((f, n) => `${n + 1}. ${f.file_name}`).join("  ·  ")}</div>
      )}

      <div className="fjcp-band">QUALITY CHECK / ગુણવત્તા તપાસ</div>
      <table className="fjcp-qc"><tbody>
        <tr>{["Product quality", "Dimensions", "Material", "Finish", "Quantity"].map((t, n) => {
          const k = ["product_quality_ok", "dimensions_ok", "material_ok", "finish_ok", "quantity_ok"][n];
          return <td key={t}><span className="fjcp-box">{lastQc ? (lastQc[k] ? "✔" : "✘") : ""}</span> {t}</td>;
        })}</tr>
        <tr><td colSpan={3}>Defects / remarks: {lastQc?.defects || ""}</td><td>Result: <b>{lastQc?.result || ""}</b></td><td>QC by: {lastQc ? `${names[lastQc.checked_by] || ""}, ${fmtDate(lastQc.checked_on)}` : ""}</td></tr>
      </tbody></table>

      <footer className="fjcp-sign">
        <div><span className="fjcp-line" />Employee signature<br /><span className="fjcp-sub">{names[job.assigned_to] || ""}</span></div>
        <div><span className="fjcp-line" />Factory Head signature</div>
      </footer>
    </div>
  );
}

export default function FactoryJobCardPrint({ lang, job, items, files, names, company, qc, onClose }) {
  const [att, setAtt] = useState(null);
  const [urls, setUrls] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [scale, setScale] = useState(1);
  const [ack, setAck] = useState(false);
  const sheetRef = useRef(null);
  const scrollRef = useRef(null);
  const paper = "A4P";
  const p = PAPERS[paper];

  useEffect(() => {
    let alive = true; let made = [];
    prepareAttachments(files, downloadAttachment).then((r) => { made = r; if (alive) setAtt(r); })
      .catch((e) => { if (alive) setAtt([{ name: "Attachments", ok: false, kind: "other", error: e?.message || String(e) }]); });
    // Product images on the card itself: as data URLs, so they are inside the PDF (not links).
    Promise.all(files.filter((f) => isImageAttachment(f)).slice(0, 8).map(async (f) => {
      try {
        const blob = await downloadAttachment(f.storage_path);
        const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
        return [f.id, data];
      } catch { return [f.id, await attachmentUrl(f.storage_path)]; }
    })).then((pairs) => { if (alive) setUrls(Object.fromEntries(pairs)); });
    return () => { alive = false; made.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl)); };
  }, [files]);

  const fit = useCallback(() => setScale(Math.min(1, ((scrollRef.current?.clientWidth || window.innerWidth) - 36) / (p.w * MM))), [p.w]);
  useLayoutEffect(() => { fit(); }, [fit]);
  useEffect(() => { window.addEventListener("resize", fit); return () => window.removeEventListener("resize", fit); }, [fit]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const failed = (att || []).filter((a) => !a.ok);
  const included = (att || []).filter((a) => a.ok);
  const ready = att !== null && (failed.length === 0 || ack);
  const make = () => makeCompletePdf({ sheet: sheetRef.current, paper, attachments: included, requestNumber: job.job_card_number, title: "Factory Job Card" });

  async function run(kind) {
    setBusy(true); setMsg(null);
    try {
      const blob = await make();
      if (kind === "print") {
        const inPage = await printPdf(blob);
        setMsg({ type: "info", text: inPage ? L(lang, "The print window has the complete Job Card. Choose your printer there.", "પ્રિન્ટ વિન્ડોમાં પૂરું જોબ કાર્ડ છે.")
          : L(lang, "The Job Card opened in a new tab — print it from there.", "જોબ કાર્ડ નવા ટેબમાં ખૂલ્યું — ત્યાંથી છાપો.") });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `${job.job_card_number}-job-card.pdf`; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        setMsg({ type: "success", text: L(lang, "Job Card PDF downloaded, with every drawing and photo inside.", "જોબ કાર્ડ PDF ડાઉનલોડ થઈ.") });
      }
    } catch (e) {
      setMsg({ type: "error", text: L(lang, `Could not make the PDF: ${e?.message || e}`, `PDF બનાવી શકાઈ નહીં: ${e?.message || e}`) });
    } finally { setBusy(false); }
  }

  return createPortal(
    <div className="op-overlay" role="dialog" aria-modal="true" aria-label={L(lang, "Job Card print preview", "જોબ કાર્ડ પ્રિન્ટ પૂર્વાવલોકન")}>
      <div className="op-toolbar">
        <h2>🖨 {job.job_card_number}</h2>
        <button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={() => run("print")}>🖨 {L(lang, "Print", "પ્રિન્ટ")}</button>
        <button type="button" className="btn btn-outline" disabled={busy || !ready} onClick={() => run("pdf")}>⬇ {L(lang, "Download PDF", "PDF ડાઉનલોડ")}</button>
        <button type="button" className="btn btn-outline" disabled={busy} onClick={onClose}>{L(lang, "Close", "બંધ")}</button>
      </div>
      {att === null && <div className="op-confirm">{L(lang, `Loading ${files.length} attachment(s)…`, `${files.length} જોડાણ લોડ થાય છે…`)}</div>}
      {failed.length > 0 && (
        <div className="op-confirm" style={{ background: "var(--danger-bg)" }}>
          <div style={{ width: "100%" }}>
            <strong style={{ color: "var(--danger)" }}>{L(lang, "These attachments cannot be put into the PDF:", "આ જોડાણ PDF માં મૂકી શકાય તેમ નથી:")}</strong>
            <ul style={{ margin: "4px 0 6px 18px" }}>{failed.map((a) => <li key={a.name}>{a.name} — {a.error}</li>)}</ul>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 600 }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ width: "auto", margin: 0 }} />
              {L(lang, "Continue without them (they stay on the Job Card)", "તેમના વગર આગળ વધો")}
            </label>
          </div>
        </div>
      )}
      {msg && <div className={`msg ${msg.type}`} style={{ margin: 0, borderRadius: 0 }}>{msg.text}</div>}
      <div className="op-scroll" ref={scrollRef}>
        <div className="op-stage" style={{ transform: `scale(${scale})`, height: scale < 1 ? `${p.h * MM * scale}px` : undefined }}>
          <div className="op-sheet" data-paper={paper} ref={sheetRef}>
            <JobCardSheet job={job} items={items} files={files} names={names} company={company} qc={qc} imageUrls={urls} />
          </div>
        </div>
        {included.length > 0 && (
          <div className="op-attachments">
            <h3>{L(lang, `Pages after the Job Card: ${included.length} file(s)`, `જોબ કાર્ડ પછીના પાનાં: ${included.length} ફાઇલ`)}</h3>
            <div className="op-att-grid">
              {att.map((a, n) => (
                <div key={`${a.name}-${n}`} className={`op-att ${a.ok ? "" : "bad"}`}>
                  {a.kind === "image" && a.ok ? <img src={a.previewUrl} alt={a.name} /> : <div className="op-att-icon">{a.kind === "pdf" ? "📄" : "⚠"}</div>}
                  <div className="op-att-cap">{n + 1}. {a.name}</div>
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
