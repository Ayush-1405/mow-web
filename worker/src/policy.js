// Should the worker take new work right now? Pure functions (unit-tested): the laptop is the owner's daily computer, so the worker
// steps back whenever the machine is busy, low on memory, on battery or outside the allowed hours.

export const DEFAULT_LIMITS = { max_cpu_pct: 70, min_free_ram_gb: 3, max_concurrency: 1, pause_on_battery: true, working_hours: null };

// Minutes since midnight in India time.
export function istMinutes(date = new Date()) {
  const ist = new Date(date.getTime() + 330 * 60000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + m; };

export function withinHours(hours, date = new Date()) {
  if (!hours || !hours.from || !hours.to) return true;
  const now = istMinutes(date); const from = toMin(hours.from); const to = toMin(hours.to);
  return from <= to ? now >= from && now < to : now >= from || now < to; // overnight windows like 22:00-06:00
}

// cpuHistory: recent CPU % samples (newest last). Uses the average of the last 3 so one spike does not pause the worker.
export function decide({ server = {}, metrics = {}, cpuHistory = [], limits = DEFAULT_LIMITS, now = new Date() }) {
  const l = { ...DEFAULT_LIMITS, ...(limits || {}) };
  if (server.ai_enabled === false) return { run: false, state: "STOPPED", reason: "Mood AI emergency stop is on" };
  if (server.paused) return { run: false, state: "PAUSED", reason: "Paused from the Control Center" };
  if (l.pause_on_battery && metrics.on_ac === false) return { run: false, state: "THROTTLED", reason: "On battery" };
  if (!withinHours(l.working_hours, now)) return { run: false, state: "THROTTLED", reason: `Outside working hours (${l.working_hours.from}-${l.working_hours.to})` };
  if (typeof metrics.ram_free_gb === "number" && metrics.ram_free_gb < Number(l.min_free_ram_gb)) {
    return { run: false, state: "THROTTLED", reason: `Low free memory (${metrics.ram_free_gb.toFixed(1)} GB < ${l.min_free_ram_gb} GB)` };
  }
  const recent = cpuHistory.slice(-3);
  if (recent.length) {
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (avg > Number(l.max_cpu_pct)) return { run: false, state: "THROTTLED", reason: `Laptop busy (CPU ${Math.round(avg)}% > ${l.max_cpu_pct}%)` };
  }
  return { run: true, state: "RUNNING", reason: null };
}

// CPU % between two os.cpus() snapshots.
export function cpuPercent(before, after) {
  let idle = 0; let total = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const a = before[i].times; const b = after[i].times;
    const t = (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq) + (b.idle - a.idle);
    idle += b.idle - a.idle; total += t;
  }
  return total > 0 ? Math.round((100 * (total - idle)) / total) : 0;
}

// Wait before retrying after a network failure: 30 s, 60 s, 120 s ... capped at 5 minutes.
export const backoffMs = (failures) => Math.min(300_000, 30_000 * 2 ** Math.max(0, failures - 1));
