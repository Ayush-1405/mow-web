import { addDaysToDateStr, kolkataDateStr } from "./kolkataTime.js";

// E-commerce date presets in the company's timezone (India): plain YYYY-MM-DD dates, inclusive. No database access here.
export function presetRange(preset, today = kolkataDateStr()) {
  const [y, m] = today.split("-").map(Number);
  const firstOf = (yy, mm) => `${yy}-${String(mm).padStart(2, "0")}-01`;
  switch (preset) {
    case "today": return { from: today, to: today };
    case "yesterday": { const d = addDaysToDateStr(today, -1); return { from: d, to: d }; }
    case "last7": return { from: addDaysToDateStr(today, -6), to: today };
    case "thisMonth": return { from: firstOf(y, m), to: today };
    case "lastMonth": { const py = m === 1 ? y - 1 : y; const pm = m === 1 ? 12 : m - 1; return { from: firstOf(py, pm), to: addDaysToDateStr(firstOf(y, m), -1) }; }
    default: return null;
  }
}
export const PRESETS = [["today", "Today", "આજે"], ["yesterday", "Yesterday", "ગઈકાલે"], ["last7", "Last 7 days", "છેલ્લા 7 દિવસ"],
  ["thisMonth", "This month", "આ મહિને"], ["lastMonth", "Last month", "ગયા મહિને"], ["custom", "Custom", "કસ્ટમ"]];
