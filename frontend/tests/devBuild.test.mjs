import test from "node:test";
import assert from "node:assert/strict";
import { checksSummary, fmtDuration, isActive, lastLogId, logFromRow, mergeBlocker, mergeLogs, parseDiff } from "../src/lib/devBuild.js";

test("mergeLogs: no duplicates, id order, keeps only the newest lines", () => {
  const a = [{ id: 1, t: "a" }, { id: 2, t: "b" }];
  assert.equal(mergeLogs(a, []), a, "nothing new -> same array (no re-render)");
  assert.equal(mergeLogs(a, [{ id: 2, t: "b" }]), a, "a line seen twice (realtime + poll) is not added again");
  assert.deepEqual(mergeLogs(a, [{ id: 4, t: "d" }, { id: 3, t: "c" }]).map((l) => l.id), [1, 2, 3, 4], "out-of-order arrival is sorted");
  assert.deepEqual(mergeLogs(a, [{ id: 3 }, { id: 4 }, { id: 5 }], 3).map((l) => l.id), [3, 4, 5]);
  assert.deepEqual(mergeLogs([], [null, { t: "no id" }, { id: 7 }]).map((l) => l.id), [7]);
  assert.equal(lastLogId([]), 0);
  assert.equal(lastLogId(a), 2);
});

test("logFromRow maps a realtime row to the detail shape", () => {
  assert.deepEqual(logFromRow({ id: "12", stream: "stderr", line: "boom", at: "t" }), { id: 12, s: "stderr", t: "boom", at: "t" });
  assert.equal(logFromRow(null), null);
});

test("parseDiff splits files and counts added / removed lines", () => {
  const patch = [
    "diff --git a/frontend/src/a.js b/frontend/src/a.js",
    "index 111..222 100644",
    "--- a/frontend/src/a.js",
    "+++ b/frontend/src/a.js",
    "@@ -1,3 +1,3 @@",
    " keep",
    "-old",
    "+new",
    "+more",
    "--- an SQL comment that was removed",
    "\\ No newline at end of file",
    "diff --git a/worker/new.js b/worker/new.js",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/worker/new.js",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
  ].join("\n");
  const f = parseDiff(patch);
  assert.deepEqual(f.map((x) => x.path), ["frontend/src/a.js", "worker/new.js", "img.png"]);
  assert.equal(f[0].adds, 2); assert.equal(f[0].dels, 2);
  assert.deepEqual(f[0].lines.map((l) => l.k), ["hunk", "ctx", "del", "add", "add", "del"], "headers are not counted; '--- x' inside a hunk is a removed line");
  assert.ok(f[1].added); assert.equal(f[1].adds, 1);
  assert.ok(f[2].binary);
  assert.deepEqual(parseDiff(""), []);
  assert.deepEqual(parseDiff(null), []);
});

test("checks summary and the merge button follow the database rules", () => {
  assert.deepEqual(checksSummary([{ ok: true }, { ok: false }]), { total: 2, passed: 1, failed: 1, allPassed: false });
  assert.equal(checksSummary([]).allPassed, false, "no checks is not a pass");
  assert.equal(checksSummary([{ ok: "true" }]).allPassed, false, "only a real true counts");
  assert.equal(checksSummary(null).total, 0);

  const ready = { status: "READY_FOR_REVIEW", commit_ref: "abc1234", checks: [{ ok: true }, { ok: true }] };
  assert.equal(mergeBlocker(ready), "", "ready, reviewed commit, all passed -> merge allowed");
  assert.match(mergeBlocker({ ...ready, checks: [{ ok: true }, { ok: false }] }), /must pass/);
  assert.match(mergeBlocker({ ...ready, checks: [] }), /must pass/);
  assert.match(mergeBlocker({ ...ready, commit_ref: null }), /No commit/);
  assert.equal(mergeBlocker({ ...ready, status: "IN_PROGRESS" }), null, "no merge button while building");
  assert.equal(mergeBlocker({ ...ready, status: "MERGED" }), null);
});

test("active statuses and durations", () => {
  for (const s of ["SUBMITTED", "IN_PROGRESS", "MERGE_APPROVED"]) assert.ok(isActive(s));
  for (const s of ["DRAFT", "READY_FOR_REVIEW", "MERGED", "CANCELLED"]) assert.ok(!isActive(s));
  assert.equal(fmtDuration(65_000), "1 min 5 s");
  assert.equal(fmtDuration(4_400), "4 s");
  assert.equal(fmtDuration(null), "—");
});
