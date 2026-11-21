// Laptop developer (v3_24, the Owner's choice): builds developer requests the Owner approved in Mood AI, using the Claude Code
// that is installed on this laptop (VS Code extension). Runs in the background while the worker keeps sending heartbeats.
//
// Safety:
//   * only requests the Owner approved with the authenticator app reach here (the database hands out SUBMITTED ones only);
//   * each request gets its own git worktree and branch (D:\MoodAI\dev\<ref>, mood-ai/<ref>) -- the main working folder is untouched;
//   * Claude Code runs with a fixed tool list: read/edit files, build, lint, test, local git commits. No database tools, no
//     push, no deploy, no reading credential files; everything else is refused (non-interactive mode cannot ask);
//   * the result is a local branch + a report "ready for review"; going live always needs the Owner's separate yes.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";

const DEV_ROOT = "D:\\MoodAI\\dev";
const RUN_LIMIT_MS = 75 * 60_000; // the database lock is 90 minutes; progress pings renew it

export const ALLOWED_TOOLS = [
  "Read", "Edit", "Write", "Glob", "Grep", "TodoWrite",
  "Bash(npm ci)", "Bash(npm install)", "Bash(npm run build)", "Bash(npm run lint)", "Bash(npm test)", "Bash(npm run test*)",
  "Bash(node --test*)", "Bash(node --check*)", "Bash(npx eslint*)", "Bash(deno check*)",
  "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git add*)", "Bash(git commit*)", "Bash(git show*)",
];
export const DENIED_TOOLS = [
  "Bash(psql*)", "Bash(pg_dump*)", "Bash(git push*)", "Bash(git remote*)", "Bash(npx supabase*)", "Bash(supabase*)", "Bash(vercel*)",
  "Bash(curl*)", "Bash(rm -rf*)", "WebFetch", "WebSearch",
  "Read(~/.mow-db.env)", "Read(~/.ssh/**)", "Read(~/.claude/**)", "Read(**/.env)", "Read(**/.env.*)",
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

function runClaude(exe, cwd, prompt, log) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits",
      "--allowedTools", ALLOWED_TOOLS.join(","), "--disallowedTools", DENIED_TOOLS.join(",")];
    const child = spawn(exe, args, { cwd, windowsHide: true, env: { ...process.env, CI: "1" } });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => { log("WARN", "Developer run hit the time limit; stopping it"); child.kill(); }, RUN_LIMIT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      let result = out;
      try { const j = JSON.parse(out); result = j.result ?? out; } catch { /* plain text */ }
      resolve({ code, result: String(result), err: err.slice(-800) });
    });
  });
}

// One approved request, start to finish. Never throws: every outcome is reported.
export async function workOnRequest(req, { api, repo, exe, log }) {
  let branch = `mood-ai/${req.ref}`;
  const ping = setInterval(() => { api.devReport(req.ref, "IN_PROGRESS", "Still working on it…", branch).catch(() => {}); }, 30 * 60_000);
  try {
    const wt = await prepareWorktree(repo, req.ref);
    branch = wt.branch;
    log("INFO", `Developer: ${req.ref} "${req.title}" in ${wt.dir}`);
    const started = Date.now();
    const r = await runClaude(exe, wt.dir, buildPrompt(req, branch), log);
    const outcome = r.code === 0 ? parseOutcome(r.result) : { status: "REJECTED", note: `Claude Code stopped with code ${r.code}. ${r.err || r.result}`.slice(0, 1500) };
    const commits = (await run("git", ["-C", wt.dir, "rev-list", "--count", `main..${branch}`])).out || "0";
    const head = (await run("git", ["-C", wt.dir, "rev-parse", "--short", "HEAD"])).out || null;
    const mins = Math.round((Date.now() - started) / 60_000);
    const note = `${outcome.note}\n(${commits} commit(s) on ${branch}, ${mins} min, built on this laptop; nothing is live yet.)`;
    await api.devReport(req.ref, outcome.status, note, branch, head);
    log("INFO", `Developer: ${req.ref} -> ${outcome.status}`);
  } catch (e) {
    log("WARN", `Developer: ${req.ref} failed: ${e.message}`);
    await api.devReport(req.ref, "REJECTED", `The laptop developer could not finish: ${e.message}`.slice(0, 1500), branch).catch(() => {});
  } finally {
    clearInterval(ping);
  }
}
