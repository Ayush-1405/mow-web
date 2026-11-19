// PDF of the official order form, made in the browser from the same sheet the preview shows, so the PDF and the printout
// are the same picture. html2canvas and jsPDF load only when someone downloads a PDF (they are not in the main bundle).

// Paper: size in mm, jsPDF format/orientation, and the CSS @page size used when printing.
export const PAPERS = {
  A5P: { w: 148, h: 210, format: "a5", orientation: "portrait", page: "A5 portrait", en: "A5 portrait", gu: "A5 ઊભું" },
  A4P: { w: 210, h: 297, format: "a4", orientation: "portrait", page: "A4 portrait", en: "A4 portrait", gu: "A4 ઊભું" },
  A4L: { w: 297, h: 210, format: "a4", orientation: "landscape", page: "A4 landscape", en: "A4 landscape", gu: "A4 આડું" },
  A5L: { w: 210, h: 148, format: "a5", orientation: "landscape", page: "A5 landscape", en: "A5 landscape", gu: "A5 આડું" },
};
// The Interior pad is a small portrait pad; the Retail pad is a large landscape pad.
export const PAPERS_FOR_TEMPLATE = { INTERIOR: ["A5P", "A4P"], RETAIL: ["A4L", "A5L"] };

export function pageCss(paperKey) {
  const p = PAPERS[paperKey];
  // margin boxes off: another screen's print rules add a page footer, which must not appear on the order form.
  return `@page { size: ${p.page}; margin: 6mm; @top-center { content: none; } @bottom-center { content: none; } }`;
}

// sheet: the .op-sheet element (page size incl. 6 mm margins). Returns a Blob (application/pdf).
export async function makeOrderFormPdf(sheet, paperKey) {
  const p = PAPERS[paperKey];
  if (document.fonts?.ready) await document.fonts.ready;
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
