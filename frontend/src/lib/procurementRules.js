// Pure Procurement rules shared by the screens and the unit tests (no Supabase import, so `node --test` can load it).

// Procurement screens carry their own bilingual text inline rather than growing lib/i18n.js further.
export const L = (lang, en, gu) => (lang === "gu" ? gu : en);

export const PROC_STATUS = {
  DRAFT: { en: "Draft", gu: "ડ્રાફ્ટ", tone: "CLOSED" },
  PENDING_DEPT_APPROVAL: { en: "Pending Department Approval", gu: "વિભાગ મંજૂરી બાકી", tone: "ASSIGNED" },
  RETURNED_FOR_CORRECTION: { en: "Returned for Correction", gu: "સુધારા માટે પરત", tone: "RETURNED" },
  REJECTED_BY_DEPT_HEAD: { en: "Rejected by Department Head", gu: "વિભાગ વડાએ નામંજૂર", tone: "RETURNED" },
  APPROVED_BY_DEPT_HEAD: { en: "Approved", gu: "મંજૂર", tone: "ACCEPTED" },
  SENT_TO_PROCUREMENT: { en: "Pending Procurement", gu: "ખરીદી વિભાગ પાસે બાકી", tone: "ASSIGNED" },
  CLARIFICATION_REQUIRED: { en: "Clarification Required", gu: "સ્પષ્ટતા જરૂરી", tone: "RETURNED" },
  ON_HOLD: { en: "On Hold", gu: "અટકાવેલ", tone: "ON_HOLD" },
  REJECTED_BY_PROCUREMENT: { en: "Rejected by Procurement", gu: "ખરીદી વિભાગે નામંજૂર", tone: "RETURNED" },
  ACCEPTED_BY_PROCUREMENT: { en: "Accepted — Awaiting Print", gu: "સ્વીકાર્યું — પ્રિન્ટ બાકી", tone: "ACCEPTED" },
  EMERGENCY_APPROVAL_PENDING: { en: "Emergency Approval Pending", gu: "તાત્કાલિક મંજૂરી બાકી", tone: "RETURNED" },
  EMERGENCY_REJECTED: { en: "Emergency Rejected", gu: "તાત્કાલિક વિનંતી નામંજૂર", tone: "RETURNED" },
  DOCUMENT_GENERATED: { en: "Printed", gu: "છપાયું", tone: "IN_PROGRESS" },
  ORDER_PLACED: { en: "Order Placed", gu: "ઓર્ડર મૂકાયો", tone: "COMPLETED" },
  VENDOR_CONFIRMED: { en: "Vendor Confirmed", gu: "વેન્ડરે પુષ્ટિ કરી", tone: "COMPLETED" },
  IN_PRODUCTION: { en: "In Production", gu: "ઉત્પાદનમાં", tone: "IN_PROGRESS" },
  READY_FOR_DISPATCH: { en: "Ready for Dispatch", gu: "ડિસ્પેચ માટે તૈયાર", tone: "IN_PROGRESS" },
  IN_TRANSIT: { en: "In Transit", gu: "રસ્તામાં", tone: "IN_PROGRESS" },
  DELAYED: { en: "Delayed", gu: "વિલંબિત", tone: "RETURNED" },
  PARTIALLY_RECEIVED: { en: "Partially Delivered", gu: "આંશિક ડિલિવર", tone: "IN_PROGRESS" },
  RECEIVED: { en: "Delivered", gu: "ડિલિવર થયું", tone: "COMPLETED" },
  GRN_VERIFIED: { en: "GRN Verified", gu: "GRN ચકાસાયું", tone: "COMPLETED" },
  INVOICE_VERIFIED: { en: "Invoice Verified", gu: "ઇન્વોઇસ ચકાસાયું", tone: "COMPLETED" },
  PAYMENT_PENDING: { en: "Payment Pending", gu: "ચુકવણી બાકી", tone: "ASSIGNED" },
  PARTIALLY_PAID: { en: "Partially Paid", gu: "આંશિક ચૂકવેલ", tone: "IN_PROGRESS" },
  PAID: { en: "Paid", gu: "ચૂકવેલ", tone: "COMPLETED" },
  CLOSED: { en: "Completed", gu: "પૂર્ણ", tone: "CLOSED" },
  CANCELLED: { en: "Cancelled", gu: "રદ", tone: "CLOSED" },
  LEGACY: { en: "Earlier Interior request", gu: "અગાઉની ઇન્ટિરિયર વિનંતી", tone: "CLOSED" },
};

export function procStatusLabel(code, lang) {
  const s = PROC_STATUS[code];
  return s ? (lang === "gu" ? s.gu : s.en) : code || "—";
}

export const PROC_CATEGORIES = [
  { code: "MATERIAL", en: "Material", gu: "સામગ્રી" },
  { code: "RAW_MATERIAL", en: "Raw material", gu: "કાચી સામગ્રી" },
  { code: "FINISHED_GOODS", en: "Finished goods", gu: "તૈયાર માલ" },
  { code: "CONSUMABLES", en: "Consumables / packaging", gu: "વપરાશી સામગ્રી / પેકિંગ" },
  { code: "MACHINERY", en: "Machinery / spare parts", gu: "મશીનરી / સ્પેર પાર્ટ્સ" },
  { code: "JOB_WORK", en: "Vendor job work", gu: "વેન્ડર જોબ વર્ક" },
  { code: "LABOUR", en: "Labour / contractor", gu: "મજૂર / કોન્ટ્રાક્ટર" },
  { code: "TURNKEY", en: "Turnkey agency", gu: "ટર્નકી એજન્સી" },
  { code: "SERVICE", en: "Service", gu: "સેવા" },
  { code: "OTHER", en: "Other", gu: "અન્ય" },
];

export const PROC_PRIORITIES = [
  { code: "LOW", en: "Low", gu: "ઓછી" },
  { code: "NORMAL", en: "Normal", gu: "સામાન્ય" },
  { code: "HIGH", en: "High", gu: "ઊંચી" },
  { code: "URGENT", en: "Urgent", gu: "તાત્કાલિક" },
];

// Statuses each queue shows. Requests waiting for their department never appear in Procurement's actionable queue.
export const QUEUES = {
  deptApproval: ["PENDING_DEPT_APPROVAL", "EMERGENCY_APPROVAL_PENDING"],
  procurementNew: ["SENT_TO_PROCUREMENT"],
  procurementWorking: ["CLARIFICATION_REQUIRED", "ON_HOLD", "ACCEPTED_BY_PROCUREMENT", "DOCUMENT_GENERATED"],
  ordered: ["ORDER_PLACED", "VENDOR_CONFIRMED", "IN_PRODUCTION", "READY_FOR_DISPATCH", "IN_TRANSIT", "DELAYED", "PARTIALLY_RECEIVED"],
  closed: ["RECEIVED", "GRN_VERIFIED", "INVOICE_VERIFIED", "PAYMENT_PENDING", "PARTIALLY_PAID", "PAID", "CLOSED"],
  stopped: ["REJECTED_BY_DEPT_HEAD", "REJECTED_BY_PROCUREMENT", "EMERGENCY_REJECTED", "CANCELLED"],
};

// Order progress moves Procurement may make -- the same map proc_update_progress enforces.
export const PROGRESS_MOVES = {
  ORDER_PLACED: ["VENDOR_CONFIRMED", "IN_PRODUCTION", "READY_FOR_DISPATCH", "IN_TRANSIT", "DELAYED"],
  VENDOR_CONFIRMED: ["IN_PRODUCTION", "READY_FOR_DISPATCH", "IN_TRANSIT", "DELAYED"],
  IN_PRODUCTION: ["READY_FOR_DISPATCH", "IN_TRANSIT", "DELAYED"],
  READY_FOR_DISPATCH: ["IN_TRANSIT", "DELAYED"],
  IN_TRANSIT: ["DELAYED"],
  DELAYED: ["VENDOR_CONFIRMED", "IN_PRODUCTION", "READY_FOR_DISPATCH", "IN_TRANSIT"],
  PARTIALLY_RECEIVED: ["IN_TRANSIT", "DELAYED"],
};

// Labour, turnkey, job work and services are ordered as work orders, which need a written scope of work.
export const WORK_ORDER_CATEGORIES = ["LABOUR", "TURNKEY", "JOB_WORK", "SERVICE"];

// What the signed-in person may do in Procurement, mirroring the database's own checks (proc_is_procurement_authorized,
// staff_is_godown_staff, proc_is_accounts ...). Used only to decide which buttons to show; the database decides for real.
export function procurementRoles(profile, departments) {
  const code = (id) => departments.find((d) => d.id === id)?.code;
  const dept = code(profile?.department_id);
  const role = profile?.roleCode;
  const lead = role === "dept_head" || role === "supervisor";
  const management = !!profile?.permissions?.hasGlobalOversight;
  return {
    isProcurement: dept === "PROCUREMENT",
    canProcure: dept === "PROCUREMENT" && lead,
    isProcurementHead: dept === "PROCUREMENT" && role === "dept_head",
    isGodown: dept === "GODOWN_INV",
    isGodownLead: dept === "GODOWN_INV" && lead,
    isAccounts: dept === "ACCOUNTS" || ["accounts_head", "accounts_employee", "cfo"].includes(role),
    isManagement: management,
    canRaiseLowStock: dept === "GODOWN_INV" || dept === "FACTORY",
  };
}

// Mirrors proc_confirm_order's checks so the form can point at the field before the round trip; the database re-checks everything.
// orderForm: a Production Supply Order Form order, where only vendor, PO / reference number, order date and expected delivery
// are required (proc_confirm_order v3_08); anything else typed is still checked.
export function validateOrderForm(f, { orderForm = false } = {}) {
  const errors = {};
  const req = orderForm ? ["vendor_name", "po_number", "order_date", "expected_delivery_date"]
    : ["vendor_name", "vendor_contact", "quotation_reference", "po_number", "order_date", "ordered_quantity", "amount", "expected_delivery_date", "payment_terms", "remarks"];
  req.forEach((k) => { if (!String(f[k] ?? "").trim()) errors[k] = "required"; });
  const digits = String(f.vendor_contact || "").replace(/\D/g, "");
  if (!errors.vendor_contact && (digits.length || !orderForm) && (digits.length < 10 || digits.length > 13)) errors.vendor_contact = "phone";
  const filled = (v) => String(v ?? "").trim() !== "";
  if (!errors.ordered_quantity && (filled(f.ordered_quantity) || !orderForm) && !(Number(f.ordered_quantity) > 0)) errors.ordered_quantity = "positive";
  if (!errors.amount && (filled(f.amount) || !orderForm) && !(Number(f.amount) > 0)) errors.amount = "positive";
  if (!errors.expected_delivery_date && !errors.order_date && f.expected_delivery_date < f.order_date) errors.expected_delivery_date = "beforeOrder";
  return errors;
}

export function validateRequestForm(f) {
  const errors = {};
  ["material_name", "material_category", "quantity", "unit", "required_by_date", "priority", "delivery_location"].forEach((k) => {
    if (!String(f[k] ?? "").trim()) errors[k] = "required";
  });
  if (!errors.quantity && !(Number(f.quantity) > 0)) errors.quantity = "positive";
  if (f.is_emergency && !String(f.emergency_reason || "").trim()) errors.emergency_reason = "required";
  return errors;
}

// True when the database doesn't have the Procurement changes yet (mvp_pilot_procurement_v3_01_foundation.sql not applied):
// a missing column (42703) or a missing function (PGRST202 / 42883).
export function isProcurementSetupMissing(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`;
  return /42703|PGRST202|42883|proc_status|proc_[a-z_]+.*(does not exist|could not find)|could not find the function public\.proc_/i.test(text);
}

export const SETUP_MISSING_TEXT = [
  "Procurement is not switched on in this database yet. Its database update still has to be applied, so nothing can be raised or tracked here for now.",
  "આ ડેટાબેઝમાં ખરીદી વિભાગ હજુ ચાલુ નથી. તેનું ડેટાબેઝ અપડેટ હજુ લાગુ કરવાનું બાકી છે, તેથી હાલ અહીં કંઈ નોંધી કે જોઈ શકાશે નહીં.",
];

// A number the phone can dial: digits with an optional leading +. Anything else is not offered as a call link.
export function telHref(phone) {
  const clean = String(phone || "").replace(/[^\d+]/g, "");
  return clean.replace(/\D/g, "").length >= 10 ? `tel:${clean}` : null;
}

// ---- Production Supply Order Forms ----

// Interior uses the compact form; every other department the large form with rate and amount. Either can be chosen.
export function defaultOrderForm(departmentCode) {
  return departmentCode === "INTERIOR" ? "INTERIOR" : "RETAIL";
}

const num = (v) => (v === "" || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

// Amount = quantity x rate when both are given (same rule as proc_normalise_order_items), rounded to paise.
export function itemAmount(item) {
  const q = num(item.quantity);
  const r = num(item.rate);
  return q !== null && r !== null ? Math.round(q * r * 100) / 100 : null;
}

export function orderTotal(items) {
  const amounts = items.map(itemAmount).filter((a) => a !== null);
  return amounts.length ? Math.round(amounts.reduce((s, a) => s + a, 0) * 100) / 100 : null;
}

// Rows with nothing typed are ignored; a started row needs a description and a quantity / size.
export function validateOrder(header, items) {
  const errors = {};
  if (!["INTERIOR", "RETAIL"].includes(header.form_type)) errors.form_type = "required";
  if (!String(header.required_completion_date || "").trim()) errors.required_completion_date = "required";
  if (!String(header.delivery_location || "").trim()) errors.delivery_location = "required";
  if (header.delivery_date && header.required_completion_date && header.delivery_date < header.required_completion_date) errors.delivery_date = "beforeCompletion";
  if (["URGENT", "EMERGENCY"].includes(header.priority) && !String(header.urgency_reason || "").trim()) errors.urgency_reason = "required";
  const filled = items.filter((i) => ["item_code", "description", "qty_size", "quantity", "rate", "remarks"].some((k) => String(i[k] ?? "").trim()));
  if (!filled.length) errors.items = "noItems";
  const badNumber = (v) => String(v ?? "").trim() !== "" && (num(v) === null || num(v) < 0);
  filled.forEach((i) => {
    const incomplete = !String(i.description || "").trim() || !String(i.qty_size || "").trim();
    if (!errors.items && (incomplete || badNumber(i.quantity) || badNumber(i.rate))) errors.items = `row:${items.indexOf(i) + 1}`;
  });
  return { errors, items: filled };
}

// ---- Due dates and deadlines (mvp_pilot_order_reminders_v3_06.sql) ----

// Order priorities. Emergency is the emergency purchase: Management approves it before Procurement sees it.
export const ORDER_PRIORITIES = [
  { code: "NORMAL", en: "Normal", gu: "સામાન્ય" },
  { code: "HIGH", en: "High", gu: "ઊંચી" },
  { code: "URGENT", en: "Urgent", gu: "તાત્કાલિક" },
  { code: "EMERGENCY", en: "Emergency", gu: "ઇમરજન્સી" },
];

export function priorityLabel(code, lang) {
  const p = ORDER_PRIORITIES.find((x) => x.code === code) || PROC_PRIORITIES.find((x) => x.code === code);
  return p ? (lang === "gu" ? p.gu : p.en) : code || "—";
}

// Statuses whose due date is watched (with Procurement, not yet delivered) -- the database's proc_due_watch_statuses().
export const DUE_WATCH_STATUSES = [
  "SENT_TO_PROCUREMENT", "CLARIFICATION_REQUIRED", "ACCEPTED_BY_PROCUREMENT", "DOCUMENT_GENERATED", "ORDER_PLACED", "VENDOR_CONFIRMED",
  "IN_PRODUCTION", "READY_FOR_DISPATCH", "IN_TRANSIT", "DELAYED", "PARTIALLY_RECEIVED",
];

// Today's date in the company's timezone (Asia/Kolkata) as YYYY-MM-DD, whatever the device's own timezone is.
export function todayIST(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t) => parts.find((x) => x.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Whole days from today (IST) to the due date: 0 = due today, negative = overdue. null without a date.
export function daysLeft(due, today = todayIST()) {
  const d = String(due || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}

// DD-MM-YYYY, the format used on every Procurement screen, form and message. Accepts a date or a timestamp.
export function fmtDate(value) {
  if (!value) return "—";
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  const ist = todayIST(d);
  return `${ist.slice(8, 10)}-${ist.slice(5, 7)}-${ist.slice(0, 4)}`;
}

// The deadline group an open order is in: OVERDUE, TODAY, TOMORROW, SOON (2-3 days), or null (later / not watched).
export function deadlineBucket(request, today = todayIST()) {
  if (!DUE_WATCH_STATUSES.includes(request?.proc_status)) return null;
  const n = daysLeft(request.required_by_date, today);
  if (n === null) return null;
  if (n < 0) return "OVERDUE";
  if (n === 0) return "TODAY";
  if (n === 1) return "TOMORROW";
  if (n <= 3) return "SOON";
  return null;
}

// "3 days left", "Due today", "2 days overdue" (only meaningful for an order still open).
export function remainingText(days, lang) {
  if (days === null || days === undefined) return "—";
  if (days > 1) return L(lang, `${days} days left`, `${days} દિવસ બાકી`);
  if (days === 1) return L(lang, "Due tomorrow", "આવતીકાલે");
  if (days === 0) return L(lang, "Due today", "આજે");
  if (days === -1) return L(lang, "1 day overdue", "1 દિવસ મોડું");
  return L(lang, `${-days} days overdue`, `${-days} દિવસ મોડું`);
}

// ---- Order tasks (v3_07): the Procurement work stage, derived on the server by proc_task_stage() ----
export const TASK_STAGES = {
  WAITING_APPROVAL: { en: "Waiting for Department approval", gu: "વિભાગ મંજૂરી બાકી", tone: "ASSIGNED" },
  OPEN: { en: "Open — unassigned", gu: "ખુલ્લું — કોઈને સોંપાયું નથી", tone: "RETURNED" },
  ACCEPTED: { en: "Accepted", gu: "સ્વીકાર્યું", tone: "ACCEPTED" },
  IN_PROGRESS: { en: "In progress", gu: "ચાલુ", tone: "IN_PROGRESS" },
  WAITING_FOR_VENDOR: { en: "Waiting for vendor", gu: "વેન્ડરની રાહ", tone: "IN_PROGRESS" },
  ORDER_PLACED: { en: "Order placed", gu: "ઓર્ડર મૂકાયો", tone: "IN_PROGRESS" },
  IN_TRANSIT: { en: "In transit", gu: "રસ્તામાં", tone: "IN_PROGRESS" },
  PARTIALLY_RECEIVED: { en: "Partially received", gu: "આંશિક મળ્યું", tone: "IN_PROGRESS" },
  WAITING_FOR_GRN: { en: "Waiting for GRN", gu: "GRN બાકી", tone: "ASSIGNED" },
  COMPLETION_PENDING: { en: "Completion pending", gu: "પૂર્ણતા બાકી", tone: "ACCEPTED" },
  COMPLETED: { en: "Completed", gu: "પૂર્ણ", tone: "COMPLETED" },
  ON_HOLD: { en: "On hold", gu: "અટકાવેલ", tone: "ON_HOLD" },
  REJECTED: { en: "Rejected", gu: "નામંજૂર", tone: "RETURNED" },
  CANCELLED: { en: "Cancelled", gu: "રદ", tone: "CLOSED" },
  RETURNED: { en: "Returned for correction", gu: "સુધારા માટે પરત", tone: "RETURNED" },
  DRAFT: { en: "Draft", gu: "ડ્રાફ્ટ", tone: "CLOSED" },
};

export function taskStageLabel(code, lang) {
  const s = TASK_STAGES[code];
  return s ? (lang === "gu" ? s.gu : s.en) : code || "—";
}

// Task filters on the Procurement dashboard. Each takes (request, taskInfo, me) -> boolean.
export const TASK_FILTERS = [
  { key: "new", en: "New order tasks", gu: "નવા ઓર્ડર કાર્ય", test: (r, t) => t?.stage === "OPEN" },
  { key: "unassigned", en: "Unassigned", gu: "સોંપાયા વગર", test: (r, t) => !!t?.task_id && !t.accepted_by && ["OPEN", "ON_HOLD"].includes(t.stage) },
  { key: "mine", en: "My accepted tasks", gu: "મારા કાર્ય", test: (r, t, me) => t?.assigned_to === me && !!t.accepted_by && !["COMPLETED", "REJECTED", "CANCELLED"].includes(t.stage) },
  { key: "progress", en: "In progress", gu: "ચાલુ", test: (r, t) => ["ACCEPTED", "IN_PROGRESS"].includes(t?.stage) },
  { key: "vendor", en: "Waiting for vendor", gu: "વેન્ડરની રાહ", test: (r, t) => t?.stage === "WAITING_FOR_VENDOR" },
  { key: "placed", en: "Order placed", gu: "ઓર્ડર મૂકાયા", test: (r, t) => ["ORDER_PLACED", "IN_TRANSIT", "PARTIALLY_RECEIVED", "WAITING_FOR_GRN"].includes(t?.stage) },
  { key: "pending", en: "Completion pending", gu: "પૂર્ણતા બાકી", test: (r, t) => t?.stage === "COMPLETION_PENDING" },
  { key: "completed", en: "Completed", gu: "પૂર્ણ", test: (r, t) => t?.stage === "COMPLETED" },
  { key: "all", en: "All records", gu: "બધા રેકોર્ડ", test: () => true },
];

// The form an order prints on: the Procurement Head's override, else the form chosen when it was raised (v3_08).
export function orderFormTemplate(request) {
  return request?.print_template || request?.order_form_type || "RETAIL";
}

// ---- Customer details on order forms (v3_10). The database re-checks everything (proc_apply_order_customer). ----
const EMPTY_ADDRESS = { line1: "", line2: "", city: "", state: "", pin: "" };
export function emptyCustomer() {
  return { name: "", mobile: "", alt_mobile: "", email: "", gstin: "", retail_customer_id: null,
    billing: { ...EMPTY_ADDRESS }, delivery: { ...EMPTY_ADDRESS, contact_person: "", contact_phone: "" }, delivery_same_as_billing: false };
}
// A stored / searched customer (missing keys allowed) as a full editable object.
export function toCustomerForm(c) {
  const e = emptyCustomer();
  if (!c) return e;
  return { ...e, ...c, retail_customer_id: c.retail_customer_id || null, billing: { ...e.billing, ...(c.billing || {}) },
    delivery: { ...e.delivery, ...(c.delivery || {}) }, delivery_same_as_billing: !!c.delivery_same_as_billing };
}
const mobileOk = (v) => {
  let d = String(v || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2); else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d);
};
const blank = (v) => !String(v ?? "").trim();
// Errors keyed by field path ("mobile", "billing.pin", ...).
export function validateCustomer(c) {
  const e = {};
  if (!c) return e;
  const any = ["mobile", "alt_mobile", "email", "gstin"].some((k) => !blank(c[k])) || Object.values(c.billing || {}).some((v) => !blank(v));
  if (blank(c.name) && any) e.name = "required";
  if (!blank(c.mobile) && !mobileOk(c.mobile)) e.mobile = "mobile";
  if (!blank(c.alt_mobile) && !mobileOk(c.alt_mobile)) e.alt_mobile = "mobile";
  if (!blank(c.email) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(c.email).trim())) e.email = "email";
  if (!blank(c.gstin) && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(String(c.gstin).trim().toUpperCase())) e.gstin = "gst";
  if (!blank(c.billing?.pin) && !/^[1-9]\d{5}$/.test(String(c.billing.pin).trim())) e["billing.pin"] = "pin";
  if (!c.delivery_same_as_billing && !blank(c.delivery?.pin) && !/^[1-9]\d{5}$/.test(String(c.delivery.pin).trim())) e["delivery.pin"] = "pin";
  if (!blank(c.delivery?.contact_phone) && !mobileOk(c.delivery.contact_phone)) e["delivery.contact_phone"] = "mobile";
  return e;
}
// The delivery address with "same as billing" applied (the contact person / number stay the delivery's own).
export function withDeliveryCopied(c) {
  if (!c?.delivery_same_as_billing) return c;
  const { line1, line2, city, state, pin } = c.billing;
  return { ...c, delivery: { ...c.delivery, line1, line2, city, state, pin } };
}
// "line1, line2, city, state - pin" for screens and the printed form.
export function addressLines(a) {
  if (!a) return [];
  const place = [a.city, a.state].filter((x) => !blank(x)).join(", ") + (blank(a.pin) ? "" : ` - ${a.pin}`);
  return [a.line1, a.line2, place].filter((x) => !blank(x));
}
