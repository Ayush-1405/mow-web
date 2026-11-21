// PDF of the official order form, made in the browser from the same sheet the preview shows, followed by every photo,
// drawing and PDF attached to the order. html2canvas, jsPDF and pdf-lib load only when a PDF is made.

// Paper: size in mm, jsPDF format/orientation, and the CSS @page size.
export const PAPERS = {
  A5P: { w: 148, h: 210, format: "a5", orientation: "portrait", page: "A5 portrait", en: "A5 portrait", gu: "A5 ઊભું" },
  A4P: { w: 210, h: 297, format: "a4", orientation: "portrait", page: "A4 portrait", en: "A4 portrait", gu: "A4 ઊભું" },
  A4L: { w: 297, h: 210, format: "a4", orientation: "landscape", page: "A4 landscape", en: "A4 landscape", gu: "A4 આડું" },
  A5L: { w: 210, h: 148, format: "a5", orientation: "landscape", page: "A5 landscape", en: "A5 landscape", gu: "A5 આડું" },
};
// The Interior form is the large landscape pad (rate and amount); the Retail form is the small portrait pad.
export const PAPERS_FOR_TEMPLATE = { INTERIOR: ["A4L", "A5L"], RETAIL: ["A5P", "A4P"] };

export function pageCss(paperKey) {
  const p = PAPERS[paperKey];
  // margin boxes off: another screen's print rules add a page footer, which must not appear on the order form.
  return `@page { size: ${p.page}; margin: 6mm; @top-center { content: none; } @bottom-center { content: none; } }`;
}

// sheet: the .op-sheet element (page size incl. 6 mm margins). Returns a Blob (application/pdf) of the form alone.
export async function makeOrderFormPdf(sheet, paperKey) {
  const p = PAPERS[paperKey];
  if (document.fonts?.ready) await document.fonts.ready;
  await Promise.all([...sheet.querySelectorAll("img")].map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; }))));
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import("html2canvas"), import("jspdf")]);
  const canvas = await html2canvas(sheet, {
    scale: 3, backgroundColor: "#ffffff", useCORS: true, logging: false,
    // The preview may be zoomed to fit the screen; the PDF is drawn at real size, without the shadow.
    onclone: (doc) => {
      doc.querySelectorAll(".op-stage").forEach((el) => { el.style.transform = "none"; });
      doc.querySelectorAll(".op-sheet").forEach((el) => { el.style.boxShadow = "none"; });
    },
  });
  const pdf = new jsPDF({ orientation: p.orientation, unit: "mm", format: p.format, compress: true });
  const pagePx = Math.round(canvas.width * (p.h / p.w));
  const slices = Math.max(1, Math.ceil((canvas.height - 4) / pagePx)); // a few px of rounding is not a new page
  for (let n = 0; n < slices; n += 1) {
    const h = Math.min(pagePx, canvas.height - n * pagePx);
    const part = document.createElement("canvas");
    part.width = canvas.width;
    part.height = h;
    const ctx = part.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, part.width, part.height);
    ctx.drawImage(canvas, 0, n * pagePx, canvas.width, h, 0, 0, canvas.width, h);
    if (n > 0) pdf.addPage(p.format, p.orientation);
    pdf.addImage(part.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, p.w, (h / canvas.width) * p.w);
  }
  return pdf.output("blob");
}

// ---- The complete document: the official form, then every photo, drawing and PDF attached to the order ----
// Files are downloaded with the user's own permissions and embedded as data, so the PDF needs no internet and no links.

const PT = 72 / 25.4; // points per mm
const A4 = { w: 210 * PT, h: 297 * PT };
const NOT_EMBEDDABLE = /\.(dwg|dxf|heic|heif|zip|rar|docx?|xlsx?|pptx?)$/i;

function fileName(f, n) { return f.original_file_name || f.file_name || `Attachment ${n + 1}`; }

// Checks and loads every attachment. Each result: { file, name, kind, ok, error?, jpeg?, w?, h?, pdfBytes?, pages?, previewUrl? }.
export async function prepareAttachments(files, download) {
  const { PDFDocument } = await import("pdf-lib");
  const out = [];
  for (const [n, file] of files.entries()) {
    const name = fileName(file, n);
    const type = String(file.file_type || "").toLowerCase();
    const isPdf = type.includes("pdf") || /\.pdf$/i.test(name);
    const isImage = type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp)$/i.test(name);
    if (NOT_EMBEDDABLE.test(name) || (!isPdf && !isImage)) {
      out.push({ file, name, kind: "other", ok: false, error: "this file type cannot be placed inside a PDF — open it separately" });
      continue;
    }
    try {
      const blob = await download(file.storage_path);
      if (isPdf) {
        const pdfBytes = new Uint8Array(await blob.arrayBuffer());
        const doc = await PDFDocument.load(pdfBytes); // throws for password-protected or damaged PDFs
        out.push({ file, name, kind: "pdf", ok: true, pdfBytes, pages: doc.getPageCount() });
      } else {
        // Decode with the photo's own orientation (phone photos), flatten on white, keep at most 3000 px on the long side.
        const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
        const scale = Math.min(1, 3000 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        if (bitmap.close) bitmap.close();
        const jpegBlob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.9));
        out.push({ file, name, kind: "image", ok: true, jpeg: new Uint8Array(await jpegBlob.arrayBuffer()), w: canvas.width, h: canvas.height,
          previewUrl: URL.createObjectURL(jpegBlob) });
      }
    } catch (e) {
      out.push({ file, name, kind: isPdf ? "pdf" : "image", ok: false,
        error: isPdf ? `this PDF cannot be opened (password-protected or damaged): ${e?.message || e}` : `this image cannot be read (e.g. an iPhone HEIC photo): ${e?.message || e}` });
    }
  }
  return out;
}

// A caption line drawn in the browser (so Gujarati file names render), returned as PNG bytes and its size in points.
async function captionPng(text, widthPt) {
  if (document.fonts?.ready) await document.fonts.ready;
  const px = 3;
  const hPt = 14;
  const c = document.createElement("canvas");
  c.width = Math.round(widthPt * px);
  c.height = Math.round(hPt * px);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#222222";
  ctx.font = `${9 * px}px Arial, "Noto Sans Gujarati", sans-serif`;
  ctx.textBaseline = "middle";
  let t = text;
  while (ctx.measureText(t).width > c.width && t.length > 4) t = `${t.slice(0, -2)}…`;
  ctx.fillText(t, 0, c.height / 2);
  const blob = await new Promise((res) => c.toBlob(res, "image/png"));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: widthPt, h: hPt };
}

// The standard PDF font has no Gujarati: page footers use plain characters only (captions are drawn as images instead).
const plain = (s) => String(s).replace(/[^\x20-\x7e]/g, "-");

// sheet/paper: the form, as for makeOrderFormPdf. attachments: the ok results of prepareAttachments, in order.
export async function makeCompletePdf({ sheet, paper, attachments, requestNumber, title = "Production Supply Order Form" }) {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const formBlob = await makeOrderFormPdf(sheet, paper);
  const doc = await PDFDocument.create();
  doc.setTitle(`${requestNumber} - ${title}`);
  doc.setCreator("Mood of Wood Staff Pilot");
  const formDoc = await PDFDocument.load(new Uint8Array(await formBlob.arrayBuffer()));
  (await doc.copyPages(formDoc, formDoc.getPageIndices())).forEach((p) => doc.addPage(p));
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const total = attachments.length;
  const M = 10 * PT;
  const gap = 6;
  const footer = 16;
  const placeImage = async (page, a, n, box) => {
    const img = await doc.embedJpg(a.jpeg);
    const cap = await captionPng(`Attachment ${n + 1} of ${total} — ${a.name}${a.file.description ? ` (${a.file.description})` : ""}`, box.w);
    page.drawImage(await doc.embedPng(cap.bytes), { x: box.x, y: box.y + box.h - cap.h, width: cap.w, height: cap.h });
    const availH = box.h - cap.h - gap;
    const s = Math.min(box.w / a.w, availH / a.h); // contain: never stretched
    const w = a.w * s;
    const h = a.h * s;
    page.drawImage(img, { x: box.x + (box.w - w) / 2, y: box.y + (availH - h) / 2, width: w, height: h });
  };

  for (let i = 0; i < attachments.length; i += 1) {
    const a = attachments[i];
    if (a.kind === "pdf") {
      const src = await PDFDocument.load(a.pdfBytes);
      const pages = await doc.copyPages(src, src.getPageIndices());
      pages.forEach((p, k) => {
        doc.addPage(p);
        const { width } = p.getSize();
        p.drawText(plain(`Attachment ${i + 1} of ${total}: ${a.name} (page ${k + 1}/${pages.length})`), {
          x: 14, y: 6, size: 6.5, font, color: rgb(0.35, 0.35, 0.35), maxWidth: width - 150,
        });
      });
      continue;
    }
    const next = attachments[i + 1];
    if (a.w > a.h && next?.kind === "image" && next.w > next.h) {
      // Two wide photos share one portrait page, one above the other.
      const page = doc.addPage([A4.w, A4.h]);
      const half = (A4.h - 2 * M - footer - gap) / 2;
      await placeImage(page, a, i, { x: M, y: M + footer + half + gap, w: A4.w - 2 * M, h: half });
      await placeImage(page, next, i + 1, { x: M, y: M + footer, w: A4.w - 2 * M, h: half });
      i += 1;
    } else {
      const size = a.w > a.h ? [A4.h, A4.w] : [A4.w, A4.h];
      const page = doc.addPage(size);
      await placeImage(page, a, i, { x: M, y: M + footer, w: size[0] - 2 * M, h: size[1] - 2 * M - footer });
    }
  }

  // Order number and page numbers on every page.
  const all = doc.getPages();
  all.forEach((p, n) => {
    const { width } = p.getSize();
    const text = plain(`${requestNumber}  |  Page ${n + 1} of ${all.length}`);
    p.drawText(text, { x: width - 14 - font.widthOfTextAtSize(text, 7), y: 6, size: 7, font, color: rgb(0.35, 0.35, 0.35) });
  });
  return new Blob([await doc.save()], { type: "application/pdf" });
}

// Prints a PDF through the browser's own PDF viewer -> the computer's print dialog (any installed printer).
// Resolves false when the browser cannot print it from the page; the PDF is then opened in a new tab to print from there.
export function printPdf(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;";
    frame.src = url;
    frame.onload = () => setTimeout(() => {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        resolve(true);
      } catch {
        window.open(url, "_blank", "noopener");
        resolve(false);
      }
    }, 400);
    document.body.appendChild(frame);
    setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 10 * 60 * 1000);
  });
}
