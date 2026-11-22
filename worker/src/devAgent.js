// Laptop developer (v3_24, the Owner's choice): builds developer requests the Owner approved in Mood AI, using the Claude Code
// that is installed on this laptop (VS Code extension). Runs in the background while the worker keeps sending heartbeats.
// v3_26 (DR-0008): live build log, the laptop's own checks (build, lint, tests) and the branch diff go back to /mood-ai; a merge
// the Owner approved with the authenticator app is done here into the laptop's LOCAL main (never pushed, never deployed).
//
// Safety:
//   * only requests the Owner approved with the authenticator app reach here (the database hands out SUBMITTED ones only);
//   * each request gets its own git worktree and branch (D:\MoodAI\dev\<ref>, mood-ai/<ref>) -- the main working folder is untouched;
//   * Claude Code runs with a fixed tool list: read/edit files, build, lint, test, local git commits. No database tools, no
//     push, no deploy, no reading credential files; everything else is refused (non-interactive mode cannot ask);
//   * the checks are fixed commands run by this worker (not by Claude), so the pass/fail report cannot be talked into passing;
//   * log lines, check output and the diff are scrubbed of anything that looks like a key, token or password before upload;
//   * merging happens only after a separate verified Owner approval for the exact reviewed commit, only into a clean main, and is
//     aborted on any conflict; the result is a local merge commit. Going live always needs the Owner's separate yes.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";

const DEV_ROOT = "D:\\MoodAI\\dev";
const RUN_LIMIT_MS = 75 * 60_000; // the database lock is 90 minutes; progress pings renew it
const CHECK_LIMIT_MS = 10 * 60_000;
export const PATCH_LIMIT = 300_000; // same cap as the database; one more character is sent so the database marks it "truncated"

export const ALLOWED_TOOLS = [
  "Read", "Edit", "Write", "Glob", "Grep", "TodoWrite",
  "Bash(npm ci)", "Bash(npm install)", "Bash(npm run build)", "Bash(npm run lint)", "Bash(npm test)", "Bash(npm run test*)",
  "Bash(node --test*)", "Bash(node --check*)", "Bash(npx eslint*)", "Bash(deno check*)",
  "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git add*)", "Bash(git commit*)", "Bash(git show*)",
];
export const DENIED_TOOLS = [
  "Bash(psql*)", "Bash(pg_dump*)", "Bash(git push*)", "Bash(git remote*)", "Bash(git merge*)", "Bash(git checkout*)", "Bash(git switch*)",
  "Bash(git reset*)", "Bash(npx supabase*)", "Bash(supabase*)", "Bash(vercel*)",
  "Bash(curl*)", "Bash(rm -rf*)", "WebFetch", "WebSearch",
  "Read(~/.mow-db.env)", "Read(~/.ssh/**)", "Read(~/.claude/**)", "Read(**/.env)", "Read(**/.env.*)",
];

// The checks this worker runs itself on the branch after Claude Code finishes (fixed commands, no input from the request).
export const CHECKS = [
  { name: "frontend install", dir: "frontend", cmd: "npm", args: ["ci", "--no-audit", "--no-fund"], onlyIfMissing: "node_modules" },
  { name: "frontend build", dir: "frontend", cmd: "npm", args: ["run", "build"] },
  { name: "frontend lint", dir: "frontend", cmd: "npm", args: ["run", "lint"] },
  { name: "frontend tests", dir: "frontend", cmd: "npm", args: ["test"] },
  { name: "worker tests", dir: "worker", cmd: "npm", args: ["test"] },
  // Phase F: the server (edge) functions -- every one type-checked, and their unit tests run (no network, no database)
  { name: "server functions type check", dir: "backend/supabase/functions", cmd: "deno", args: ["check", "--node-modules-dir=none", "."] },
  { name: "server functions tests", dir: "backend/supabase/functions", cmd: "deno", args: ["test", "--node-modules-dir=none", "--no-check", "--allow-read", "--allow-env"] },
];

// Claude Code binary: CLAUDE_EXE in worker/.env, else the newest VS Code extension copy
export function findClaude(env = process.env) {
  if (env.CLAUDE_EXE && fs.existsSync(env.CLAUDE_EXE)) return env.CLAUDE_EXE;
  const ext = path.join(os.homedir(), ".vscode", "extensions");
  try {
    const dirs = fs.readdirSync(ext).filter((d) => /^anthropic\.claude-code-/.test(d)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const d of dirs) {
      const exe = path.join(ext, d, "resources", "native-binary", process.platform === "win32" ? "claude.exe" : "claude");
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* no VS Code */ }
  return null;
}

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 120_000, ...opts }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: String(stdout || "").trim(), err: String(stderr || err?.message || "").trim() }));
});

// request refs come from the database ("DR-0008"); anything else is refused before it reaches a path or a branch name
export function checkRef(ref) {
  if (!/^DR-\d{4,6}$/.test(String(ref || ""))) throw new Error(`Unexpected request reference "${String(ref).slice(0, 40)}"`);
  return ref;
}

// ---- scrubbing: nothing that looks like a secret leaves the laptop in a log line, check output or diff
export function redact(text, secrets = []) {
  let s = String(text ?? "");
  for (const k of secrets) if (k && String(k).length >= 8) s = s.split(String(k)).join("***");
  return s
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "***jwt***")
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/g, "***key***")
    .replace(/((?:postgres(?:ql)?|mysql|redis):\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1***@")
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)(\s*[=:]\s*)["']?[^\s"',;]{6,}["']?/g, "$1$2***");
}

// ---- live log: lines are batched (every few seconds or 100 lines) and sent with mai_worker_dev_log
export function makeLogSink(send, { secrets = [], flushMs = 4000, maxLines = 19_000, onError = () => {} } = {}) {
  let buf = []; let sent = 0; let timer = null; let chain = Promise.resolve(); let failed = false;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!buf.length) return chain;
    const lines = buf; buf = [];
    chain = chain.then(() => send(lines)).catch((e) => { if (!failed) onError(e); failed = true; });
    return chain;
  };
  return {
    push(stream, text) {
      for (const raw of String(text ?? "").split(/\r?\n/)) {
        const t = redact(raw, secrets).trimEnd();
        if (!t) continue;
        if (sent >= maxLines) return;
        if (sent === maxLines - 1) { buf.push({ s: "progress", t: "(log limit reached; later lines are only on the laptop)" }); sent += 1; return; }
        buf.push({ s: stream, t: t.slice(0, 2000) }); sent += 1;
      }
      if (buf.length >= 100) flush();
      else if (!timer) timer = setTimeout(flush, flushMs);
    },
    flush,
    count: () => sent,
  };
}

// ---- Claude Code stream-json events -> readable log lines
const short = (v, n = 160) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
function toolLine(name, input = {}) {
  if (name === "Bash") return `$ ${short(input.command, 300)}`;
  if (["Read", "Edit", "Write", "NotebookEdit"].includes(name)) return `${name} ${short(input.file_path || input.notebook_path)}`;
  if (["Grep", "Glob"].includes(name)) return `${name} ${short(input.pattern)}${input.path ? ` in ${short(input.path, 80)}` : ""}`;
  if (name === "TodoWrite") return `Plan: ${(input.todos || []).map((t) => `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : "·"} ${short(t.content, 60)}`).join(" | ")}`;
  return name;
}
const resultText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x?.text || "")).join("\n") : "");

export function describeEvent(evt) {
  if (!evt || typeof evt !== "object") return [];
  if (evt.type === "system" && evt.subtype === "init") return [{ s: "progress", t: `Claude Code started (${evt.model || "model"})` }];
  if (evt.type === "assistant") {
    const out = [];
    for (const c of evt.message?.content || []) {
      if (c.type === "text" && c.text?.trim()) out.push({ s: "stdout", t: c.text.trim() });
      if (c.type === "tool_use") out.push({ s: "progress", t: toolLine(c.name, c.input) });
    }
    return out;
  }
  if (evt.type === "user") {
    const out = [];
    for (const c of evt.message?.content || []) {
      if (c.type !== "tool_result") continue;
      const lines = resultText(c.content).split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) continue;
      const shown = lines.slice(0, 15).join("\n") + (lines.length > 15 ? `\n… (${lines.length - 15} more lines)` : "");
      out.push({ s: c.is_error ? "stderr" : "stdout", t: shown });
    }
    return out;
  }
  if (evt.type === "result") {
    const secs = evt.duration_ms ? Math.round(evt.duration_ms / 1000) : null;
    return [{ s: "progress", t: `Claude Code finished${evt.is_error ? " with an error" : ""}${secs ? ` in ${secs} s` : ""}${evt.num_turns ? `, ${evt.num_turns} turns` : ""}` }];
  }
  return [];
}

// The last line Claude writes decides the report: "READY: ..." or "NEEDS_INFO: ...". Anything else counts as not finished.
export function parseOutcome(text) {
  const lines = String(text || "").trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    const m = lines[i].match(/^(READY|NEEDS_INFO)\s*:\s*(.+)$/i);
    if (m) return { status: m[1].toUpperCase() === "READY" ? "READY_FOR_REVIEW" : "NEEDS_INFO", note: m[2] };
  }
  return { status: "REJECTED", note: "The developer run ended without a clear result. Last output: " + lines.slice(-3).join(" ").slice(0, 600) };
}

export function buildPrompt(req, branch) {
  const answers = (req.answers || []).length ? `\nThe Owner's answers to earlier questions:\n- ${req.answers.join("\n- ")}\n` : "";
  return `You are the Mood AI laptop developer for the Mood of Wood staff app. You are working in a git worktree on branch ${branch}.
Work only inside this folder.

Developer request ${req.ref}: ${req.title} (risk ${req.risk})
${req.prompt}
${answers}
Rules you must follow:
- Change code only in this worktree and commit your work on branch ${branch} with clear messages. Do not push, deploy, or switch branches.
- Do not connect to any database, do not read credential or .env files, do not run migrations against any server. If the change
  needs a database migration, write the migration file and its test file in the repo (backend/supabase/migrations, backend/supabase/tests)
  and say so -- the Owner applies it separately after review.
- Install dependencies with npm ci if needed (frontend/ and worker/), then run the frontend build and lint, and the relevant tests.
  Report the real results; never claim a test passed that you did not run.
- If you cannot continue without a decision from the Owner, stop and make your final line: NEEDS_INFO: <one clear question>
- Otherwise make your final line: READY: <3-5 sentences: what you changed, files/areas, tests run and their results, anything the Owner must do before going live>`;
}

// ---- checks + diff
export function summarizeChecks(checks) {
  if (!checks.length) return "No checks ran.";
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  return failed.length ? `Laptop checks: ${checks.length - failed.length}/${checks.length} passed; failed: ${failed.join(", ")} (merge stays blocked until they pass).`
    : `Laptop checks: all ${checks.length} passed (${checks.map((c) => c.name).join(", ")}).`;
}

// a fixed command with a time limit; output goes to the live log, the last 40 lines are kept for the report
function runCheckCmd(check, cwd, sink, secrets) {
  return new Promise((resolve) => {
    const started = Date.now();
    let tail = []; let done = false;
    const keep = (stream) => (d) => {
      const text = String(d);
      sink?.push(stream, text);
      tail = tail.concat(text.split(/\r?\n/).filter((l) => l.trim())).slice(-40);
    };
    // npm is npm.cmd on Windows and needs a shell; the command and arguments are fixed constants above
    const child = spawn(check.cmd, check.args, { cwd, windowsHide: true, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    child.stdout.on("data", keep("stdout"));
    child.stderr.on("data", keep("stderr"));
    const finish = (ok, extra) => {
      if (done) return; done = true; clearTimeout(timer);
      if (extra) tail.push(extra);
      resolve({ name: check.name, ok, ms: Date.now() - started, tail: redact(tail.join("\n"), secrets).slice(-4000) });
    };
    const timer = setTimeout(() => { child.kill(); finish(false, `Stopped after ${CHECK_LIMIT_MS / 60_000} min`); }, CHECK_LIMIT_MS);
    child.on("error", (e) => finish(false, e.message));
    child.on("close", (code) => finish(code === 0, code === 0 ? null : `exit code ${code}`));
  });
}

export async function runChecks(dir, { sink, secrets = [], checks = CHECKS, runner = runCheckCmd } = {}) {
  const results = [];
  for (const c of checks) {
    const cwd = path.join(dir, c.dir);
    if (!fs.existsSync(cwd)) continue;
    if (c.onlyIfMissing && fs.existsSync(path.join(cwd, c.onlyIfMissing))) continue;
    sink?.push("progress", `Check: ${c.name} (${c.dir}: ${c.cmd} ${c.args.join(" ")})`);
    const r = await runner(c, cwd, sink, secrets);
    sink?.push("progress", `Check ${c.name}: ${r.ok ? "PASS" : "FAIL"} (${Math.round(r.ms / 1000)} s)`);
    results.push(r);
    if (c.onlyIfMissing && !r.ok) break; // without dependencies the other checks cannot mean anything
  }
  return results;
}

const DIFF_EXCLUDE = [":(exclude,glob)**/.env", ":(exclude,glob)**/.env.*", ":(exclude,glob)**/package-lock.json"];
export async function collectDiff(dir, base = "main", secrets = [], git = run) {
  const stat = await git("git", ["-C", dir, "diff", "--stat", `${base}...HEAD`, "--", ".", ...DIFF_EXCLUDE]);
  const patch = await git("git", ["-C", dir, "diff", "--no-color", `${base}...HEAD`, "--", ".", ...DIFF_EXCLUDE]);
  return { stat: redact(stat.out, secrets), patch: redact(patch.out, secrets).slice(0, PATCH_LIMIT + 1) };
}

async function prepareWorktree(repo, ref) {
  const branch = `mood-ai/${ref}`;
  const dir = path.join(DEV_ROOT, ref);
  fs.mkdirSync(DEV_ROOT, { recursive: true });
  if (!fs.existsSync(dir)) {
    const exists = (await run("git", ["-C", repo, "rev-parse", "--verify", "--quiet", branch])).ok;
    const r = exists ? await run("git", ["-C", repo, "worktree", "add", dir, branch])
      : await run("git", ["-C", repo, "worktree", "add", "-b", branch, dir, "main"]);
    if (!r.ok) throw new Error(`git worktree failed: ${r.err.slice(0, 300)}`);
  }
  return { branch, dir };
}

function runClaude(exe, cwd, prompt, log, sink) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
      "--allowedTools", ALLOWED_TOOLS.join(","), "--disallowedTools", DENIED_TOOLS.join(",")];
    const child = spawn(exe, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    let pending = ""; let result = null; let lastText = ""; let err = "";
    const handleLine = (line) => {
      if (!line.trim()) return;
      let evt = null;
      try { evt = JSON.parse(line); } catch { sink.push("stdout", line); lastText = line; return; }
      for (const l of describeEvent(evt)) sink.push(l.s, l.t);
      if (evt.type === "result") result = evt;
      if (evt.type === "assistant") for (const c of evt.message?.content || []) if (c.type === "text" && c.text) lastText = c.text;
    };
    child.stdout.on("data", (d) => {
      pending += d;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      lines.forEach(handleLine);
    });
    child.stderr.on("data", (d) => { err += d; sink.push("stderr", String(d)); });
    const timer = setTimeout(() => { log("WARN", "Developer run hit the time limit; stopping it"); sink.push("stderr", "Time limit reached; Claude Code stopped"); child.kill(); }, RUN_LIMIT_MS);
    child.on("error", (e) => { err += e.message; });
    child.on("close", (code) => {
      clearTimeout(timer);
      handleLine(pending);
      resolve({ code, result: String(result?.result ?? lastText ?? ""), err: err.slice(-800) });
    });
  });
}

// One approved request, start to finish. Never throws: every outcome is reported.
export async function workOnRequest(req, { api, repo, exe, log, secrets = [] }) {
  let branch = `mood-ai/${req.ref}`;
  const ping = setInterval(() => { api.devReport(req.ref, "IN_PROGRESS", "Still working on it…", branch).catch(() => {}); }, 30 * 60_000);
  const sink = makeLogSink((lines) => api.devLog(req.ref, lines), { secrets, onError: (e) => log("WARN", `Developer: live log upload failed (${e.message}); continuing`) });
  try {
    checkRef(req.ref);
    const wt = await prepareWorktree(repo, req.ref);
    branch = wt.branch;
    log("INFO", `Developer: ${req.ref} "${req.title}" in ${wt.dir}`);
    await api.devResult(req.ref, [], null, null).catch(() => {}); // clear an earlier run's report
    sink.push("progress", `Run started on branch ${branch} (laptop ${os.hostname()})`);
    const started = Date.now();
    const r = await runClaude(exe, wt.dir, buildPrompt(req, branch), log, sink);
    const outcome = r.code === 0 ? parseOutcome(r.result) : { status: "REJECTED", note: `Claude Code stopped with code ${r.code}. ${r.err || r.result}`.slice(0, 1500) };
    let checks = [];
    if (outcome.status === "READY_FOR_REVIEW") {
      sink.push("progress", "Running the laptop's own checks on the branch");
      checks = await runChecks(wt.dir, { sink, secrets });
    }
    const diff = await collectDiff(wt.dir, "main", secrets);
    const commits = (await run("git", ["-C", wt.dir, "rev-list", "--count", `main..${branch}`])).out || "0";
    const head = (await run("git", ["-C", wt.dir, "rev-parse", "--short", "HEAD"])).out || null;
    const mins = Math.round((Date.now() - started) / 60_000);
    sink.push("progress", `${outcome.status}: ${commits} commit(s), head ${head || "?"}, ${mins} min`);
    await sink.flush();
    await api.devResult(req.ref, checks, diff.stat || null, diff.patch || null)
      .catch((e) => log("WARN", `Developer: could not upload the check report / diff (${e.message})`));
    const checkNote = outcome.status === "READY_FOR_REVIEW" ? `\n${summarizeChecks(checks)}` : "";
    const note = `${outcome.note}${checkNote}\n(${commits} commit(s) on ${branch}, ${mins} min, built on this laptop; nothing is live yet.)`;
    await api.devReport(req.ref, outcome.status, note, branch, head);
    log("INFO", `Developer: ${req.ref} -> ${outcome.status}${checks.length ? ` (${checks.filter((c) => c.ok).length}/${checks.length} checks)` : ""}`);
  } catch (e) {
    log("WARN", `Developer: ${req.ref} failed: ${e.message}`);
    sink.push("stderr", `Stopped: ${e.message}`);
    await sink.flush();
    await api.devReport(req.ref, "REJECTED", `The laptop developer could not finish: ${e.message}`.slice(0, 1500), branch).catch(() => {});
  } finally {
    clearInterval(ping);
  }
}

// ---- merge (after the Owner's verified approval of commit job.commit). Into the laptop's main folder only; never pushes.
export async function mergeApproved(job, { api, repo, log, secrets = [], git = run }) {
  const sink = makeLogSink((lines) => api.devLog(job.ref, lines), { secrets, onError: () => {} });
  const report = async (ok, note, merged) => {
    sink.push(ok ? "progress" : "stderr", note);
    await sink.flush();
    await api.devMergeReport(job.ref, ok, note, merged ?? null);
    log(ok ? "INFO" : "WARN", `Developer: merge ${job.ref} -> ${ok ? "merged" : "not merged"}: ${note}`);
  };
  try {
    checkRef(job.ref);
    if (!/^[0-9a-f]{7,40}$/i.test(String(job.commit || ""))) return await report(false, "The approved commit is missing or not a commit id");
    const branch = `mood-ai/${job.ref}`; // never a name from outside
    sink.push("progress", `Merge approved by the Owner: ${branch} @ ${job.commit} into the laptop's main (local only)`);
    const head = await git("git", ["-C", repo, "symbolic-ref", "--short", "HEAD"]);
    if (head.out !== "main") return await report(false, `The laptop's main folder is on "${head.out || "?"}", not main. Switch it to main, then approve again.`);
    const dirty = await git("git", ["-C", repo, "status", "--porcelain", "--untracked-files=no"]);
    if (!dirty.ok || dirty.out) return await report(false, "The laptop's main folder has uncommitted changes. Commit or set them aside, then approve again.");
    const tip = await git("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${branch}^{commit}`]);
    const approved = await git("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${job.commit}^{commit}`]);
    if (!tip.ok || !approved.ok || tip.out !== approved.out) {
      return await report(false, `The branch is not at the commit you approved (${job.commit}); it changed after your review. Review it again.`);
    }
    if ((await git("git", ["-C", repo, "merge-base", "--is-ancestor", tip.out, "HEAD"])).ok) {
      const cur = (await git("git", ["-C", repo, "rev-parse", "--short", "HEAD"])).out;
      return await report(true, `main already contains ${branch} @ ${job.commit} (main is at ${cur}). Not pushed, not live.`, cur);
    }
    const msg = `Merge ${branch}: ${String(job.title || "").replace(/[\r\n]+/g, " ").slice(0, 120)} (Owner approved in Mood AI)`;
    const m = await git("git", ["-C", repo, "merge", "--no-ff", "--no-edit", "-m", msg, tip.out]);
    if (!m.ok) {
      await git("git", ["-C", repo, "merge", "--abort"]);
      return await report(false, `git could not merge cleanly, so nothing was changed on main: ${redact(m.err || m.out, secrets).slice(0, 400)}`);
    }
    const merged = (await git("git", ["-C", repo, "rev-parse", "--short", "HEAD"])).out;
    return await report(true, `Merged ${branch} @ ${job.commit} into the laptop's main as ${merged}. Not pushed and not live: pushing, database changes and going live stay your separate steps.`, merged);
  } catch (e) {
    await report(false, `The merge step failed: ${e.message}`.slice(0, 800)).catch(() => {});
  }
}
