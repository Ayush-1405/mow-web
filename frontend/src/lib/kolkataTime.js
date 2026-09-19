// Mood of Wood — Staff Pilot — Asia/Kolkata-safe date helpers.
//
// The bug this file exists to prevent: `new Date().toISOString().slice(0,10)`
// gives TODAY IN UTC, not in India. Asia/Kolkata is UTC+5:30 with no DST, so
// anywhere from 00:00 to 05:29 IST, `toISOString()` still reports the
// PREVIOUS calendar day — a task due today would briefly show as tomorrow's
// (or an overdue task would briefly not count as overdue yet) until the UTC
// date finally rolled over hours later. Every "what is today" computation in
// this app must go through `kolkataDateStr()`, never a raw `toISOString()`.
//
// `due_date` itself is a plain SQL `date` (already just "YYYY-MM-DD", no
// time/timezone attached) — comparing it against `kolkataDateStr()` is
// always correct with no further conversion. Only genuine timestamptz
// columns (assigned_at, completed_at, closed_at, created_at) need the
// start/end-of-day boundary helpers below before comparing them to a
// selected calendar date.

const KOLKATA_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

// Kolkata's calendar-date representation of a given instant (default: now).
// `en-CA` formats as YYYY-MM-DD directly — no manual string assembly needed.
export function kolkataDateStr(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Whole-day difference between two YYYY-MM-DD calendar dates (b - a), safe
// against DST-free Kolkata dates by comparing via UTC midnight instants.
export function daysBetweenDateStrs(aStr, bStr) {
  const [ay, am, ad] = aStr.split("-").map(Number);
  const [by, bm, bd] = bStr.split("-").map(Number);
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.round((b - a) / 86400000);
}

// [startUtcIso, endUtcIsoExclusive) for one Kolkata calendar date — use this
// to bound a timestamptz column against a user-selected date, never a plain
// string-prefix compare.
export function kolkataDayBoundsUtc(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const startUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0) - KOLKATA_OFFSET_MS;
  return [new Date(startUtcMs).toISOString(), new Date(startUtcMs + 86400000).toISOString()];
}

// Kolkata calendar date for a timestamptz value (or null if the value is
// missing) — the correct way to ask "what Kolkata date did this instant
// fall on", e.g. for assigned_at/completed_at.
export function kolkataDateOf(isoTimestamp) {
  if (!isoTimestamp) return null;
  return kolkataDateStr(new Date(isoTimestamp));
}

// True if the given timestamptz instant falls on the given Kolkata date.
export function isOnKolkataDate(isoTimestamp, dateStr) {
  if (!isoTimestamp || !dateStr) return false;
  const [start, end] = kolkataDayBoundsUtc(dateStr);
  return isoTimestamp >= start && isoTimestamp < end;
}

// Milliseconds until the next Kolkata local midnight, computed by reading
// Kolkata's own wall-clock h/m/s via Intl — correct regardless of what
// timezone the device itself is set to.
export function msUntilNextKolkataMidnight() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const secondsSinceMidnight = hour * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return (86400 - secondsSinceMidnight) * 1000 + 500;
}
