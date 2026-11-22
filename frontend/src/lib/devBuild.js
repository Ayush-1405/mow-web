// Pure helpers for the live build view in /mood-ai (DR-0008). No React, no network: unit-tested in tests/devBuild.test.mjs.

export const LOG_KEEP = 2000; // lines kept on screen
export const ACTIVE_STATUSES = ["SUBMITTED", "IN_PROGRESS", "MERGE_APPROVED"];

// add newly fetched / realtime log lines: no duplicates, in id order, only the last `keep`
export function mergeLogs(prev, incoming, keep = LOG_KEEP) {
  if (!incoming?.length) return prev;
  const seen = new Set(prev.map((l) => l.id));
  const add = incoming.filter((l) => l && l.id != null && !seen.has(l.id));
  if (!add.length) return prev;
  const all = prev.concat(add).sort((a, b) => a.id - b.id); // realtime and polling can arrive out of order
  return all.length > keep ? all.slice(all.length - keep) : all;
}

export const lastLogId = (logs) => (logs.length ? logs[logs.length - 1].id : 0);

// realtime row (mai_dev_logs) -> the same shape mai_dev_detail returns
export const logFromRow = (row) => (row ? { id: Number(row.id), s: row.stream, t: row.line, at: row.at } : null);

// unified diff -> files with their lines, for a readable, coloured preview
export function parseDiff(patch) {
  const files = [];
  let cur = null;
  for (const line of String(patch || "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      cur = { path: m ? m[2] : line.slice(11), adds: 0, dels: 0, lines: [], binary: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("@@")) { cur.inHunk = true; cur.lines.push({ k: "hunk", t: line }); continue; }
    // file headers only come before the first hunk ("--- x" inside a hunk is a removed "-- x" line, e.g. an SQL comment)
    if (!cur.inHunk && line.startsWith("Binary files ")) { cur.binary = true; continue; }
    if (!cur.inHunk && /^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode)/.test(line)) {
      if (line.startsWith("rename to ")) cur.path = line.slice(10);
      if (line.startsWith("new file mode")) cur.added = true;
      if (line.startsWith("deleted file mode")) cur.deleted = true;
      continue;
    }
    if (!cur.inHunk) continue;
    if (line.startsWith("+")) { cur.adds += 1; cur.lines.push({ k: "add", t: line }); continue; }
    if (line.startsWith("-")) { cur.dels += 1; cur.lines.push({ k: "del", t: line }); continue; }
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    cur.lines.push({ k: "ctx", t: line });
  }
  return files;
}

export function checksSummary(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const passed = list.filter((c) => c.ok === true).length;
  return { total: list.length, passed, failed: list.length - passed, allPassed: list.length > 0 && passed === list.length };
}

// the merge button: only when the database would accept it (same rules as mai_dev_approve_merge)
export function mergeBlocker(d) {
  if (!d) return "Loading…";
  if (d.status !== "READY_FOR_REVIEW") return null; // the button is not shown at all
  if (!d.commit_ref) return "No commit was reported for this branch.";
  if (!checksSummary(d.checks).allPassed) return "Every check (build, lint, tests) must pass before merging.";
  return "";
}

export const isActive = (status) => ACTIVE_STATUSES.includes(status);

export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return "—";
  const s = Math.round(Number(ms) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}
