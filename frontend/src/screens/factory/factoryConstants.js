// ONE status model for every Factory screen (Phase 1). These nine values are
// the database's inhouse_production_requests.factory_status; the old
// free-text `status` column is kept in sync by a trigger for legacy readers.
export const STATUS = {
  pending_verification: { en: "Needs Verification", gu: "ચકાસણી બાકી", badge: "ASSIGNED" },
  needs_clarification: { en: "Returned", gu: "પરત કર્યું", badge: "RETURNED" },
  accepted: { en: "Accepted", gu: "સ્વીકાર્યું", badge: "ACCEPTED" },
  assigned: { en: "Assigned", gu: "સોંપ્યું", badge: "ACCEPTED" },
  in_production: { en: "In Production", gu: "ઉત્પાદનમાં", badge: "IN_PROGRESS" },
  blocked: { en: "Blocked", gu: "અટકેલું", badge: "REVISION" },
  ready_for_review: { en: "Ready for Review", gu: "સમીક્ષા માટે તૈયાર", badge: "COMPLETED" },
  completed: { en: "Completed", gu: "પૂર્ણ", badge: "VERIFIED" },
  cancelled: { en: "Cancelled", gu: "રદ", badge: "CLOSED" },
};

export const ACTION_LABEL = {
  verify: { en: "Verify new Job Card", gu: "નવું જોબ કાર્ડ ચકાસો" },
  confirm_drawing: { en: "Confirm missing drawing", gu: "ખૂટતું ડ્રોઈંગ ચકાસો" },
  assign: { en: "Assign production team", gu: "પ્રોડક્શન ટીમ સોંપો" },
  confirm_completion: { en: "Confirm job completion", gu: "કામ પૂર્ણ થયાની પુષ્ટિ કરો" },
  resolve_blocker: { en: "Resolve blocked job", gu: "અટકેલું કામ ઉકેલો" },
  update_delayed: { en: "Update delayed job", gu: "વિલંબિત કામ અપડેટ કરો" },
  start_job: { en: "Start accepted job", gu: "સ્વીકારેલું કામ શરૂ કરો" },
  update_progress: { en: "Update progress", gu: "પ્રગતિ અપડેટ કરો" },
  respond_clarification: { en: "Respond to clarification", gu: "સ્પષ્ટતાનો જવાબ આપો" },
};

export const PRIORITIES = ["Normal", "High", "Urgent", "Emergency"];

// Inbox tabs: [key, label, database filter]. "New" and "Needs Verification"
// split the same pending_verification status by whether a reviewer has opened
// the card yet, so the two dashboard cards never overlap.
export const INBOX_TABS = [
  ["new", { en: "New", gu: "નવા" }],
  ["verify", { en: "Needs Verification", gu: "ચકાસણી" }],
  ["accepted", { en: "Accepted", gu: "સ્વીકાર્યા" }],
  ["assigned", { en: "Assigned", gu: "સોંપ્યા" }],
  ["in_production", { en: "In Production", gu: "ઉત્પાદનમાં" }],
  ["returned", { en: "Returned", gu: "પરત" }],
  ["delayed", { en: "Delayed", gu: "વિલંબિત" }],
  ["completed", { en: "Completed", gu: "પૂર્ણ" }],
];

export const STAGES = [
  "Cutting", "Edge Banding", "CNC", "Carpentry/Assembly", "Polishing/Painting",
  "Hardware Fitting", "Final Assembly", "Packing",
];

export const FILE_CATEGORIES = ["Working Drawing", "Production Drawing", "3D Drawing", "Reference Photo", "Material Specification", "Job Card", "Others"];
export const DRAWING_CATEGORIES = [
  "Working Drawing", "Production Drawing", "3D Drawing", "Normal Drawing", "Reference Drawing",
  "Furniture Detail Drawing", "Cutting Drawing", "Approved Design", "RCP", "Electrical Drawing", "MEP Drawing",
];

export function label(map, key, lang) {
  const e = map[key];
  if (!e) return key;
  return lang === "gu" ? e.gu || e.en : e.en;
}

export function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d.length === 10 ? `${d}T00:00:00` : d);
  return Number.isNaN(dt.getTime()) ? "—" : dt.toLocaleDateString();
}
export function fmtDateTime(d) {
  if (!d) return "—";
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? "—" : dt.toLocaleString();
}

// UI-only role hints. Every action is re-validated by the database; these
// just decide which buttons to show.
export function roleInfo(profile, lookups) {
  const factoryId = (lookups?.departments || []).find((d) => d.code === "FACTORY")?.id;
  const code = profile?.roleCode;
  const inFactory = !!factoryId && profile?.department_id === factoryId;
  const admin = !!profile?.permissions?.hasGlobalOversight;
  const isHead = admin || (inFactory && code === "dept_head");
  const isManager = isHead || (inFactory && code === "supervisor");
  return { inFactory, admin, isHead, isManager, isEmployee: inFactory && !isManager };
}

export function friendlyRpcError(err, fallback = "Something went wrong. Please try again.") {
  const m = err?.message || "";
  if (/not authorized|only the factory|You are not/i.test(m)) return m;
  if (/Only |Please |Accept the|Selected |Expected|Primary and|already|no longer|not open|not blocked|not found|Invalid/i.test(m) && m.length < 200) return m;
  console.error("[factory]", err);
  return fallback;
}
