// AI Employee Performance (v3_17) -- pure helpers shared by the performance screens. No network here, so it is unit-tested
// (tests/perfRules.test.mjs). The numbers themselves always come from the database scoring engine (perf_eval).

export const L = (lang, en, gu) => (lang === "gu" ? gu : en);

export const CATEGORIES = [
  { key: "completion", en: "Task completion", gu: "કામ પૂર્ણ" },
  { key: "deadline", en: "Deadlines", gu: "સમયમર્યાદા" },
  { key: "quality", en: "Work quality", gu: "કામની ગુણવત્તા" },
  { key: "ownership", en: "Ownership & updates", gu: "જવાબદારી અને અપડેટ" },
  { key: "collaboration", en: "Collaboration", gu: "સહકાર" },
];

export const OUTCOMES = {
  COMPLETED: { en: "Completed", gu: "પૂર્ણ", tone: "COMPLETED" },
  OVERDUE_OPEN: { en: "Missed due date", gu: "સમય વીતી ગયો", tone: "RETURNED" },
  EXCUSED: { en: "Delay verified — not their fault", gu: "વિલંબ માન્ય — તેમની ભૂલ નહીં", tone: "ON_HOLD" },
  CARRIED_OVERDUE: { en: "Still open from earlier", gu: "પહેલાથી બાકી", tone: "ON_HOLD" },
  PENDING: { en: "Open, not due yet", gu: "ચાલુ, હજી સમય છે", tone: "ASSIGNED" },
  CANCELLED: { en: "Cancelled", gu: "રદ", tone: "ASSIGNED" },
  REASSIGNED_AWAY: { en: "Moved to someone else", gu: "બીજાને સોંપાયું", tone: "ASSIGNED" },
  COMPLETED_BY_COLLEAGUE: { en: "Completed by a colleague", gu: "સાથીએ પૂર્ણ કર્યું", tone: "ASSIGNED" },
  RETURNED: { en: "Returned (declined)", gu: "પરત કર્યું", tone: "ASSIGNED" },
};
export const outcomeLabel = (code, lang) => (OUTCOMES[code] ? L(lang, OUTCOMES[code].en, OUTCOMES[code].gu) : code);
export const outcomeTone = (code) => OUTCOMES[code]?.tone || "ASSIGNED";

export const REPORT_STATUS = {
  DRAFT: { en: "Waiting for Head review", gu: "વડાની સમીક્ષા બાકી", tone: "ON_HOLD" },
  SHARED: { en: "Shared with employee", gu: "કર્મચારીને મોકલ્યું", tone: "IN_PROGRESS" },
  RESPONDED: { en: "Employee responded", gu: "કર્મચારીએ જવાબ આપ્યો", tone: "ACCEPTED" },
  FINAL: { en: "Final", gu: "અંતિમ", tone: "VERIFIED" },
  SUPERSEDED: { en: "Replaced by a newer version", gu: "નવી આવૃત્તિથી બદલાયું", tone: "ASSIGNED" },
};
export const reportStatusLabel = (code, lang) => (REPORT_STATUS[code] ? L(lang, REPORT_STATUS[code].en, REPORT_STATUS[code].gu) : code);
export const reportStatusTone = (code) => REPORT_STATUS[code]?.tone || "ASSIGNED";

export const GOAL_TYPES = [
  { key: "REDUCE_OVERDUE", en: "Overdue tasks at most", gu: "વધુમાં વધુ બાકી કામ", unit: "", lowerIsBetter: true },
  { key: "IMPROVE_ON_TIME", en: "On-time completion at least (%)", gu: "સમયસર પૂર્ણ ઓછામાં ઓછું (%)", unit: "%" },
  { key: "IMPROVE_QUALITY", en: "Quality score at least (%)", gu: "ગુણવત્તા ઓછામાં ઓછી (%)", unit: "%" },
  { key: "REDUCE_REWORK", en: "Rework (reopened tasks) at most", gu: "ફરી ખોલાયેલા કામ વધુમાં વધુ", unit: "", lowerIsBetter: true },
  { key: "IMPROVE_UPDATES", en: "Ownership & updates at least (%)", gu: "જવાબદારી અને અપડેટ ઓછામાં ઓછું (%)", unit: "%" },
  { key: "IMPROVE_COLLABORATION", en: "Collaboration at least (%)", gu: "સહકાર ઓછામાં ઓછો (%)", unit: "%" },
  { key: "CUSTOM", en: "Other goal (checked by the Head)", gu: "અન્ય લક્ષ્ય (વડા તપાસશે)", unit: "" },
];
export const goalLabel = (key, lang) => { const g = GOAL_TYPES.find((x) => x.key === key); return g ? L(lang, g.en, g.gu) : key; };
export const GOAL_STATUS = {
  OPEN: { en: "Open", gu: "ચાલુ", tone: "ASSIGNED" }, ACHIEVED: { en: "Achieved", gu: "પ્રાપ્ત", tone: "COMPLETED" },
  NOT_ACHIEVED: { en: "Not achieved", gu: "પ્રાપ્ત નહીં", tone: "RETURNED" }, NOT_MEASURABLE: { en: "Head to check", gu: "વડા તપાસશે", tone: "ON_HOLD" },
  NO_DATA: { en: "No data", gu: "માહિતી નથી", tone: "ASSIGNED" },
};

export const EXCUSE_REASONS = [
  { key: "OTHER_DEPARTMENT", en: "Blocked by another department", gu: "બીજા વિભાગને કારણે અટક્યું" },
  { key: "MANAGEMENT_APPROVAL", en: "Waiting for Management approval", gu: "મેનેજમેન્ટ મંજૂરીની રાહ" },
  { key: "VENDOR_DELAY", en: "Vendor delay", gu: "વેન્ડર વિલંબ" },
  { key: "MATERIAL_SHORTAGE", en: "Material shortage", gu: "માલની અછત" },
  { key: "SYSTEM_FAILURE", en: "System / app failure", gu: "સિસ્ટમ ખામી" },
  { key: "OTHER_VERIFIED", en: "Other (verified)", gu: "અન્ય (ચકાસેલું)" },
];

// "2026-10-01" -> "Oct 2026"
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthLabel(iso) {
  if (!iso) return "—";
  const [y, m] = String(iso).slice(0, 7).split("-").map(Number);
  return `${MONTHS_EN[m - 1]} ${y}`;
}
// First day of the month in Asia/Kolkata, as YYYY-MM-01.
export function currentMonthIST(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
export function addMonths(iso, n) {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`;
}
// The last `count` months ending with the current one (newest first), for month pickers.
export function monthOptions(count = 24, now = new Date()) {
  const cur = currentMonthIST(now);
  return Array.from({ length: count }, (_, i) => addMonths(cur, -i));
}
export const isEndedMonth = (iso, now = new Date()) => iso < currentMonthIST(now);

export function scoreBand(score) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return { key: "none", en: "Insufficient data", gu: "પૂરતી માહિતી નથી" };
  const s = Number(score);
  if (s >= 85) return { key: "excellent", en: "Excellent", gu: "ઉત્તમ" };
  if (s >= 70) return { key: "good", en: "Good", gu: "સારું" };
  if (s >= 50) return { key: "fair", en: "Needs some improvement", gu: "થોડો સુધારો જરૂરી" };
  return { key: "low", en: "Needs support", gu: "સહાયની જરૂર" };
}
export const fmtScore = (s) => (s === null || s === undefined ? "—" : Number(s).toFixed(Number(s) % 1 === 0 ? 0 : 1));
export function fmtChange(d) {
  if (d === null || d === undefined) return "—";
  const n = Number(d);
  return `${n > 0 ? "+" : ""}${n.toFixed(Math.abs(n) % 1 === 0 ? 0 : 1)}`;
}
export function fmtHours(h) {
  if (h === null || h === undefined) return "—";
  const n = Number(h);
  return n >= 48 ? `${(n / 24).toFixed(1)} days` : `${n.toFixed(1)} h`;
}

// Tasks that were scored, best first; then the rest in a stable order. Used by the task-by-task table.
export function sortTaskRows(rows) {
  const order = ["OVERDUE_OPEN", "COMPLETED", "EXCUSED", "CARRIED_OVERDUE", "PENDING", "RETURNED", "COMPLETED_BY_COLLEAGUE", "REASSIGNED_AWAY", "CANCELLED"];
  return [...(rows || [])].sort((a, b) => {
    if (a.scored !== b.scored) return a.scored ? -1 : 1;
    if (a.scored && b.scored && a.points !== b.points) return Number(a.points ?? 0) - Number(b.points ?? 0);
    const d = order.indexOf(a.outcome) - order.indexOf(b.outcome);
    return d || String(a.task_number).localeCompare(String(b.task_number));
  });
}

// Groups people by department and gives within-department ranks (raw scores are only compared inside one department).
export function rankWithinDepartments(people) {
  const by = {};
  for (const p of people || []) (by[p.department || "—"] ||= []).push(p);
  return Object.entries(by).sort(([a], [b]) => a.localeCompare(b)).map(([department, list]) => {
    const scored = list.filter((p) => p.overall_score !== null && p.overall_score !== undefined)
      .sort((a, b) => Number(b.overall_score) - Number(a.overall_score));
    let rank = 0; let prev = null;
    const ranked = scored.map((p, i) => { if (Number(p.overall_score) !== prev) { rank = i + 1; prev = Number(p.overall_score); } return { ...p, rank }; });
    const unscored = list.filter((p) => p.overall_score === null || p.overall_score === undefined).map((p) => ({ ...p, rank: null }))
      .sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
    return { department, people: [...ranked, ...unscored] };
  });
}

export function validateWeights(w) {
  const vals = CATEGORIES.map((c) => Number(w?.[c.key]));
  if (vals.some((v) => !Number.isFinite(v) || v < 0)) return "Every weight must be 0 or more";
  const total = vals.reduce((a, b) => a + b, 0);
  return Math.abs(total - 100) < 1e-9 ? null : `The weights add up to ${total}; they must add up to 100`;
}

// Goals entered by the Head -> payload for perf_head_review; drops blank rows, checks targets.
export function cleanGoals(goals) {
  const out = [];
  for (const g of goals || []) {
    const description = String(g.description || "").trim();
    if (!description) continue;
    const t = GOAL_TYPES.find((x) => x.key === g.goal_type) || GOAL_TYPES[GOAL_TYPES.length - 1];
    let target = g.target_value === "" || g.target_value === null || g.target_value === undefined ? null : Number(g.target_value);
    if (t.key === "CUSTOM") target = null;
    else if (target === null || !Number.isFinite(target) || target < 0 || (t.unit === "%" && target > 100)) return { error: `Give a valid target for "${description}"` };
    out.push({ goal_type: t.key, target_value: target, description });
  }
  return { goals: out };
}
