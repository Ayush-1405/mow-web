// Factory Job Cards (v3_15): statuses, dashboard sections and form checks. Pure functions, no Supabase -- unit tested in
// tests/factoryJobRules.test.mjs. The database (fjc_* functions) re-checks everything.

export const L = (lang, en, gu) => (lang === "gu" ? gu : en);

export const JOB_STATUS = {
  NEW: { en: "New", gu: "નવું", tone: "RETURNED" },
  ACCEPTED: { en: "Accepted", gu: "સ્વીકાર્યું", tone: "ACCEPTED" },
  PRODUCTION_STARTED: { en: "Production started", gu: "ઉત્પાદન શરૂ", tone: "IN_PROGRESS" },
  IN_PROGRESS: { en: "Production in progress", gu: "ઉત્પાદન ચાલુ", tone: "IN_PROGRESS" },
  QUALITY_CHECK: { en: "Quality check", gu: "ગુણવત્તા તપાસ", tone: "ASSIGNED" },
  READY_FOR_DISPATCH: { en: "Ready for dispatch", gu: "ડિસ્પેચ માટે તૈયાર", tone: "COMPLETED" },
  DISPATCHED: { en: "Dispatched — awaiting receipt", gu: "મોકલાયું — મળ્યાની રાહ", tone: "ACCEPTED" },
  COMPLETED: { en: "Completed", gu: "પૂર્ણ", tone: "COMPLETED" },
  CANCELLED: { en: "Cancelled", gu: "રદ", tone: "CLOSED" },
};
export const jobStatusLabel = (code, lang) => (JOB_STATUS[code] ? L(lang, JOB_STATUS[code].en, JOB_STATUS[code].gu) : code || "—");

export const PRIORITIES = [
  { code: "NORMAL", en: "Normal", gu: "સામાન્ય" },
  { code: "URGENT", en: "Urgent", gu: "તાત્કાલિક" },
  { code: "EMERGENCY", en: "Emergency", gu: "ઇમરજન્સી" },
];
export const priorityLabel = (code, lang) => { const p = PRIORITIES.find((x) => x.code === code); return p ? L(lang, p.en, p.gu) : code; };

export const FILE_KINDS = [
  { code: "PRODUCT_IMAGE", en: "Product image", gu: "ઉત્પાદન ફોટો" },
  { code: "DRAWING", en: "Technical drawing", gu: "ટેકનિકલ ડ્રોઇંગ" },
  { code: "PDF", en: "PDF", gu: "PDF" },
  { code: "REFERENCE", en: "Reference photo", gu: "સંદર્ભ ફોટો" },
];
// A sensible default kind from the file itself; the user can change it before sending.
export function guessFileKind(file) {
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  if (/\.(dwg|dxf)$/.test(name) || /drawing|dwg|layout|plan/.test(name)) return "DRAWING";
  if (type.includes("pdf") || name.endsWith(".pdf")) return "PDF";
  if (type.startsWith("image/")) return "PRODUCT_IMAGE";
  return "REFERENCE";
}

const CLOSED = ["COMPLETED", "CANCELLED"];
// The due date in force: the Factory Head's revised date, else the original.
export const effectiveDue = (j) => j?.revised_due_date || j?.due_date || null;

export function todayIST(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t) => parts.find((x) => x.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
// Production is overdue when the card is not yet ready for dispatch on its due date.
export function isOverdue(j, today = todayIST()) {
  const due = effectiveDue(j);
  return !!due && due < today && !["READY_FOR_DISPATCH", "DISPATCHED", ...CLOSED].includes(j.status);
}
export function daysLeft(j, today = todayIST()) {
  const due = effectiveDue(j);
  if (!due) return null;
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}

// The seven sections of the Factory home, in order.
export const SECTIONS = [
  { key: "new", en: "New Job Cards", gu: "નવા જોબ કાર્ડ", test: (j) => j.status === "NEW" },
  { key: "accepted", en: "Accepted", gu: "સ્વીકાર્યા", test: (j) => j.status === "ACCEPTED" },
  { key: "production", en: "Production in progress", gu: "ઉત્પાદન ચાલુ", test: (j) => ["PRODUCTION_STARTED", "IN_PROGRESS"].includes(j.status) },
  { key: "qc", en: "Quality check", gu: "ગુણવત્તા તપાસ", test: (j) => j.status === "QUALITY_CHECK" },
  { key: "ready", en: "Ready for dispatch", gu: "ડિસ્પેચ માટે તૈયાર", test: (j) => ["READY_FOR_DISPATCH", "DISPATCHED"].includes(j.status) },
  { key: "completed", en: "Completed", gu: "પૂર્ણ", test: (j) => j.status === "COMPLETED" },
  { key: "overdue", en: "Overdue", gu: "મોડું", test: (j, today) => isOverdue(j, today), danger: true },
];
export function sectionCounts(jobs, today = todayIST()) {
  return Object.fromEntries(SECTIONS.map((s) => [s.key, jobs.filter((j) => s.test(j, today)).length]));
}

export const BLANK_ITEM = {
  product_name: "", product_category: "", item_code: "", description: "", quantity: "", unit: "nos", dimensions: "", material_spec: "",
  finish_colour: "", laminate_fabric_hardware: "", instructions: "",
};
const filled = (it) => Object.entries(it).some(([k, v]) => k !== "unit" && String(v ?? "").trim() !== "");

// Form check before sending: { header: {field: code}, items: {index: {field: code}} }; empty object = fine.
export function validateJobCard(header, items, today = todayIST()) {
  const errors = {};
  if (!header.due_date) errors.due_date = "required";
  else if (header.due_date < today) errors.due_date = "past";
  if (!PRIORITIES.some((p) => p.code === header.priority)) errors.priority = "required";
  const used = items.filter(filled);
  if (!used.length) errors.items = "none";
  const itemErrors = {};
  items.forEach((it, n) => {
    if (!filled(it)) return;
    const e = {};
    if (!String(it.product_name || "").trim()) e.product_name = "required";
    const q = Number(it.quantity);
    if (String(it.quantity ?? "").trim() === "" || Number.isNaN(q) || q <= 0) e.quantity = "quantity";
    if (Object.keys(e).length) itemErrors[n] = e;
  });
  if (Object.keys(itemErrors).length) errors.lines = itemErrors;
  return errors;
}

// Item-wise progress for display: percent of ordered quantity made.
export function itemProgress(it) {
  const q = Number(it.quantity) || 0;
  return q ? Math.min(100, Math.floor((100 * (Number(it.qty_completed) || 0)) / q)) : 0;
}
export const allItemsDone = (items) => items.length > 0 && items.every((it) => Number(it.qty_completed) >= Number(it.quantity));
export const fmtQty = (n) => (n === null || n === undefined || n === "" ? "" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 }));
