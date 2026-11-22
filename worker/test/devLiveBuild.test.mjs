// v3_26 (DR-0008) live build: log scrubbing/batching, stream-json -> log lines, the laptop's own checks, diff cap, and the
// Owner-approved merge guards. No network, no real git: fakes stand in for both.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHECKS, DENIED_TOOLS, PATCH_LIMIT, checkRef, collectDiff, describeEvent, makeLogSink, mergeApproved, redact, runChecks, summarizeChecks,
} from "../src/devAgent.js";

test("redact removes keys, tokens, JWTs and passwords but keeps ordinary text", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdEFGHijkl";
  const s = redact(`ok line\nAuthorization: Bearer ${jwt}\nANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuv\n`
    + "SUPABASE_SERVICE_ROLE_KEY: \"verysecretvalue\"\npostgres://postgres:hunter2pass@db.example.co:5432/postgres\nmy worker token here", ["worker token"]);
  assert.match(s, /ok line/);
  assert.doesNotMatch(s, /eyJhbGci/);
  assert.doesNotMatch(s, /sk-ant-api03/);
  assert.doesNotMatch(s, /verysecretvalue/);
  assert.doesNotMatch(s, /hunter2pass/);
  assert.match(s, /postgres:\/\/postgres:\*\*\*@db/);
  assert.match(s, /my \*\*\* here/, "known secrets are replaced exactly");
  assert.equal(redact("short", ["abc"]), "short", "very short 'secrets' are ignored (would mangle normal text)");
});

test("checkRef only accepts database request references", () => {
  assert.equal(checkRef("DR-0008"), "DR-0008");
  for (const bad of ["DR-1; rm", "../DR-0001", "", null, "main", "DR-0008\nx"]) assert.throws(() => checkRef(bad));
});

test("Claude Code stream events become readable log lines", () => {
  assert.deepEqual(describeEvent({ type: "system", subtype: "init", model: "claude-opus-5-5" }), [{ s: "progress", t: "Claude Code started (claude-opus-5-5)" }]);
  const a = describeEvent({ type: "assistant", message: { content: [
    { type: "text", text: "Looking at the panel" },
    { type: "tool_use", name: "Bash", input: { command: "npm run build" } },
    { type: "tool_use", name: "Edit", input: { file_path: "frontend/src/x.jsx" } },
    { type: "tool_use", name: "Grep", input: { pattern: "mai_dev", path: "worker" } },
  ] } });
  assert.deepEqual(a.map((l) => l.t), ["Looking at the panel", "$ npm run build", "Edit frontend/src/x.jsx", "Grep mai_dev in worker"]);
  assert.deepEqual(a.map((l) => l.s), ["stdout", "progress", "progress", "progress"]);
  const u = describeEvent({ type: "user", message: { content: [
    { type: "tool_result", is_error: true, content: "boom" },
    { type: "tool_result", content: [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n") }] },
  ] } });
  assert.equal(u[0].s, "stderr"); assert.equal(u[0].t, "boom");
  assert.match(u[1].t, /l14\n… \(5 more lines\)$/, "long tool output is shortened");
  assert.match(describeEvent({ type: "result", duration_ms: 61000, num_turns: 7 })[0].t, /finished in 61 s, 7 turns/);
  assert.deepEqual(describeEvent(null), []);
  assert.deepEqual(describeEvent({ type: "unknown" }), []);
});

test("the log sink batches, scrubs, skips blank lines and stops at its limit", async () => {
  const sent = [];
  const sink = makeLogSink(async (lines) => { sent.push(lines); }, { secrets: ["tok-secret-123"], flushMs: 10_000, maxLines: 5 });
  sink.push("stdout", "a\n\n b \ntok-secret-123 used");
  assert.equal(sent.length, 0, "nothing is sent before the batch is due");
  await sink.flush();
  assert.deepEqual(sent[0], [{ s: "stdout", t: "a" }, { s: "stdout", t: " b" }, { s: "stdout", t: "*** used" }]);
  sink.push("stderr", "x\ny\nz\nw");
  await sink.flush();
  assert.equal(sink.count(), 5);
  assert.match(sent[1].at(-1).t, /log limit reached/);
  sink.push("stdout", "after the limit");
  await sink.flush();
  assert.equal(sent.length, 2, "nothing more after the limit");
});

test("the log sink sends a full batch at once and keeps working when the upload fails", async () => {
  let calls = 0; let errors = 0;
  const sink = makeLogSink(async () => { calls += 1; throw new Error("offline"); }, { flushMs: 10_000, onError: () => { errors += 1; } });
  sink.push("stdout", Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
  await sink.flush();
  sink.push("stdout", "more"); await sink.flush();
  assert.equal(calls, 2); assert.equal(errors, 1, "the failure is reported once, not per batch");
});

test("checks: fixed commands, install only when needed, stop when the install fails, honest summary", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mai-checks-"));
  fs.mkdirSync(path.join(dir, "frontend")); fs.mkdirSync(path.join(dir, "worker"));
  const ran = [];
  const runner = async (c) => { ran.push(c.name); return { name: c.name, ok: c.name !== "frontend lint", ms: 5, tail: "" }; };
  let r = await runChecks(dir, { runner });
  assert.deepEqual(ran, ["frontend install", "frontend build", "frontend lint", "frontend tests", "worker tests"]);
  assert.equal(summarizeChecks(r), "Laptop checks: 4/5 passed; failed: frontend lint (merge stays blocked until they pass).");

  fs.mkdirSync(path.join(dir, "frontend", "node_modules"));
  ran.length = 0;
  r = await runChecks(dir, { runner: async (c) => { ran.push(c.name); return { name: c.name, ok: true, ms: 1, tail: "" }; } });
  assert.ok(!ran.includes("frontend install"), "no install when dependencies are there");
  assert.match(summarizeChecks(r), /all 4 passed/);

  fs.rmSync(path.join(dir, "frontend", "node_modules"), { recursive: true });
  ran.length = 0;
  r = await runChecks(dir, { runner: async (c) => { ran.push(c.name); return { name: c.name, ok: false, ms: 1, tail: "npm ERR" }; } });
  assert.deepEqual(ran, ["frontend install"], "nothing else runs without dependencies");
  assert.equal(r.length, 1); assert.equal(r[0].ok, false);
  assert.equal(summarizeChecks([]), "No checks ran.");
  for (const c of CHECKS) assert.equal(c.cmd, "npm", "checks are fixed npm commands");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("diff: three-dot against main, credentials excluded, scrubbed, capped one past the limit", async () => {
  const calls = [];
  const git = async (cmd, args) => { calls.push(args); return { ok: true, out: args.includes("--stat") ? " 1 file changed" : "+KEY_TOKEN=abcdefgh\n" + "x".repeat(PATCH_LIMIT + 50) }; };
  const d = await collectDiff("D:\\w", "main", [], git);
  assert.equal(d.stat, " 1 file changed");
  assert.equal(d.patch.length, PATCH_LIMIT + 1, "the database sees it is longer than the cap and marks it truncated");
  assert.doesNotMatch(d.patch, /abcdefgh/);
  for (const a of calls) { assert.ok(a.includes("main...HEAD")); assert.ok(a.some((x) => x.includes(".env"))); }
});

test("Claude Code itself may not merge, check out or reset", () => {
  for (const t of ["Bash(git merge*)", "Bash(git checkout*)", "Bash(git reset*)", "Bash(git push*)"]) assert.ok(DENIED_TOOLS.includes(t), t);
});

// ---- merge guards
function fakeGit(state) {
  const calls = [];
  const git = async (cmd, args) => {
    calls.push(args.slice(2).join(" "));
    const sub = args[2];
    if (sub === "symbolic-ref") return { ok: true, out: state.head ?? "main" };
    if (sub === "status") return { ok: true, out: state.dirty ?? "" };
    if (sub === "rev-parse" && args.includes("--short")) return { ok: true, out: state.mergedShort ?? "m3rg3d1" };
    if (sub === "rev-parse") {
      const ref = args.at(-1).replace("^{commit}", "");
      const map = { [`mood-ai/${state.ref}`]: state.tip ?? "a".repeat(40), [state.commit]: state.approvedFull ?? "a".repeat(40) };
      return map[ref] ? { ok: true, out: map[ref] } : { ok: false, out: "", err: "unknown" };
    }
    if (sub === "merge-base") return { ok: !!state.alreadyMerged, out: "" };
    if (sub === "merge" && args[3] === "--abort") return { ok: true, out: "" };
    if (sub === "merge") return state.conflict ? { ok: false, out: "", err: "CONFLICT (content): Merge conflict in x.js" } : { ok: true, out: "" };
    return { ok: false, out: "", err: "unexpected" };
  };
  return { git, calls };
}
function fakeApi() {
  const reports = []; const logs = [];
  return { reports, logs, api: { devMergeReport: async (ref, ok, note, merged) => { reports.push({ ref, ok, note, merged }); }, devLog: async (ref, lines) => { logs.push(...lines); } } };
}
const job = { ref: "DR-0008", title: "Live build\nline two", branch: "evil; rm -rf /", commit: "abc1234" };
const noLog = () => {};

test("merge: a clean main at the approved commit is merged locally with --no-ff and reported (never pushed)", async () => {
  const { git, calls } = fakeGit({ ref: "DR-0008", commit: "abc1234" });
  const { api, reports, logs } = fakeApi();
  await mergeApproved(job, { api, repo: "D:\\repo", log: noLog, git });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].ok, true); assert.equal(reports[0].merged, "m3rg3d1");
  assert.match(reports[0].note, /Not pushed and not live/);
  const merge = calls.find((c) => c.startsWith("merge --no-ff"));
  assert.ok(merge.includes("Merge mood-ai/DR-0008: Live build line two (Owner approved in Mood AI)"), "one-line message, branch from the ref only");
  assert.ok(merge.endsWith("a".repeat(40)), "merges the exact verified commit, not a branch name");
  assert.ok(!calls.some((c) => /push|evil/.test(c)), "no push and the database's branch text is never used");
  assert.ok(logs.length > 0, "the merge shows in the live log");
});

for (const [name, state, pattern] of [
  ["main folder not on main", { head: "feature/x" }, /not main/],
  ["uncommitted changes on main", { dirty: " M frontend/src/App.jsx" }, /uncommitted changes/],
  ["branch moved after the review", { tip: "b".repeat(40) }, /changed after your review/],
]) {
  test(`merge refused: ${name}`, async () => {
    const { git, calls } = fakeGit({ ref: "DR-0008", commit: "abc1234", ...state });
    const { api, reports } = fakeApi();
    await mergeApproved(job, { api, repo: "D:\\repo", log: noLog, git });
    assert.equal(reports[0].ok, false); assert.match(reports[0].note, pattern);
    assert.ok(!calls.some((c) => c.startsWith("merge ")), "git merge never ran");
  });
}

test("merge: a conflict is aborted so main is unchanged", async () => {
  const { git, calls } = fakeGit({ ref: "DR-0008", commit: "abc1234", conflict: true });
  const { api, reports } = fakeApi();
  await mergeApproved(job, { api, repo: "D:\\repo", log: noLog, git });
  assert.equal(reports[0].ok, false); assert.match(reports[0].note, /nothing was changed on main/);
  assert.ok(calls.includes("merge --abort"));
});

test("merge: already merged (e.g. the laptop restarted mid-merge) is reported, not merged twice", async () => {
  const { git, calls } = fakeGit({ ref: "DR-0008", commit: "abc1234", alreadyMerged: true });
  const { api, reports } = fakeApi();
  await mergeApproved(job, { api, repo: "D:\\repo", log: noLog, git });
  assert.equal(reports[0].ok, true); assert.match(reports[0].note, /already contains/);
  assert.ok(!calls.some((c) => c.startsWith("merge --no-ff")));
});

test("merge: a bad ref or commit id is refused before git runs", async () => {
  for (const bad of [{ ...job, commit: "HEAD~1" }, { ...job, commit: "" }]) {
    const { git, calls } = fakeGit({ ref: "DR-0008", commit: "abc1234" });
    const { api, reports } = fakeApi();
    await mergeApproved(bad, { api, repo: "D:\\repo", log: noLog, git });
    assert.equal(reports[0].ok, false); assert.equal(calls.length, 0);
  }
  const { git, calls } = fakeGit({});
  const { api, reports } = fakeApi();
  await mergeApproved({ ...job, ref: "../x" }, { api, repo: "D:\\repo", log: noLog, git });
  assert.equal(reports[0].ok, false); assert.equal(calls.length, 0);
});
