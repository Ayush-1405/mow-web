// Mood AI Phase G: the deployment manager on the Owner's laptop (v3_28).
//
// Puts the laptop's local main (what the Owner merged) live in FIXED steps -- no AI decides anything here:
//   plan:     commits on local main that are not on GitHub yet, the new migrations / test files among them, the server functions
//             they change, and whether the website changes. The Owner approves that plan for that exact commit (authenticator).
//   release:  checks -> backup -> database trial with tests (rolled back) -> apply migrations -> deploy functions -> git push
//             (Vercel publishes the website) -> health check. Stops at the first failure; every step is reported.
//   rollback: website and server functions back to the version before the release (a new commit, pushed). The database is never
//             restored automatically; the backup file is named in the report.
// Runs only when RELEASE=on in worker/.env. The database password is read from the Owner's own file (default ~/.mow-db.env,
// LIVE_DB_URL) and given only to psql / pg_dump through the PGPASSWORD environment variable; it is never logged or sent anywhere.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { redact } from "./devAgent.js";

const MIGRATIONS = "backend/supabase/migrations/";
const TESTS = "backend/supabase/tests/";
const FUNCTIONS = "backend/supabase/functions/";

export function releaseConfig(env = process.env) {
  const enabled = String(env.RELEASE || "").toLowerCase() === "on";
  const ref = (String(env.SUPABASE_URL || "").match(/^https:\/\/([a-z0-9]{20})\.supabase\.co/) || [])[1] || null;
  const pgBin = env.RELEASE_PG_BIN || "C:\\Program Files\\PostgreSQL\\17\\bin";
  return {
    enabled: enabled && !!ref,
    projectRef: ref,
    dbHost: env.RELEASE_DB_HOST || "aws-0-ap-south-1.pooler.supabase.com",
    dbUser: ref ? `postgres.${ref}` : null,
    passwordFile: env.RELEASE_DB_PASSWORD_FILE || path.join(os.homedir(), ".mow-db.env"),
    psql: path.join(pgBin, "psql.exe"),
    pgDump: path.join(pgBin, "pg_dump.exe"),
    backups: env.RELEASE_BACKUPS || "D:\\staff pilot\\backups",
    siteUrl: env.RELEASE_SITE_URL || "https://mood-of-wood-staff-pilot-git-main-mow3.vercel.app/",
  };
}

// The Owner's database password file: a line LIVE_DB_URL=<password> (a BOM at the start is ignored).
export function readDbPassword(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const m = text.match(/^LIVE_DB_URL=(.+)$/m);
  if (!m || !m[1].trim()) throw new Error(`No LIVE_DB_URL line in ${file}`);
  return m[1].trim().replace(/^["']|["']$/g, "");
}

const exec = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, maxBuffer: 50 * 1024 * 1024, timeout: 10 * 60_000, ...opts }, (err, stdout, stderr) =>
    resolve({ ok: !err, code: err?.code ?? 0, out: String(stdout || "").trim(), err: String(stderr || "").trim() }));
});

// ---------------------------------------------------------------- plan (pure parts are exported for tests)
// nameStatus: lines "A\tpath" / "M\tpath" / "D\tpath" (git diff --no-renames --name-status base head)
// addedOrder: migration paths in the order they were added (git log --reverse --diff-filter=A --name-only base..head)
export function computePlan({ commits, nameStatus, addedOrder, allFunctions }) {
  const files = nameStatus.split(/\r?\n/).filter(Boolean).map((l) => { const [st, ...p] = l.split("\t"); return { st: st[0], path: p.join("\t") }; });
  const problems = [];
  const changedMigrations = files.filter((f) => f.path.startsWith(MIGRATIONS) && f.path.endsWith(".sql") && f.st !== "A");
  if (changedMigrations.length) problems.push(`A database migration that may already be live was changed or deleted: ${changedMigrations.map((f) => f.path).join(", ")}. Add a new migration instead.`);
  const added = new Set(files.filter((f) => f.st === "A" && f.path.startsWith(MIGRATIONS) && f.path.endsWith(".sql")).map((f) => f.path));
  const migrations = [...new Set(addedOrder.split(/\r?\n/).filter((p) => added.has(p)))];
  for (const p of added) if (!migrations.includes(p)) migrations.push(p);
  const tests = files.filter((f) => f.st !== "D" && f.path.startsWith(TESTS) && f.path.endsWith(".sql")).map((f) => f.path).sort();
  const fnFiles = files.filter((f) => f.path.startsWith(FUNCTIONS)).map((f) => f.path.slice(FUNCTIONS.length).split("/")[0]);
  const shared = fnFiles.some((d) => d === "_shared");
  const functions = [...new Set(shared ? allFunctions : fnFiles.filter((d) => allFunctions.includes(d)))].sort();
  const website = files.some((f) => f.path.startsWith("frontend/") || f.path === "vercel.json" || f.path === "package.json");
  return { plan: { commits, migrations, tests, functions, website, files: files.length }, problem: problems.join(" ") || null };
}

export function parseCommits(log) {
  return log.split(/\r?\n/).filter(Boolean).slice(0, 200).map((l) => { const [sha, ...s] = l.split("\t"); return { sha, subject: s.join("\t").slice(0, 160) }; });
}

// Output of the database trial: migrations must apply cleanly, and every test file must report only PASS lines. A test file
// reports through an exception with an EMPTY message followed by its PASS/FAIL lines; any other error is a real failure.
export function judgeTrial(output, testCount) {
  const lines = String(output).split(/\r?\n/);
  const realErrors = lines.filter((l) => /ERROR:\s+\S/.test(l));
  const fails = lines.filter((l) => /^FAIL\s/.test(l));
  const passes = lines.filter((l) => /^PASS\s/.test(l)).length;
  const ok = realErrors.length === 0 && fails.length === 0 && (testCount === 0 || passes > 0);
  const note = ok ? `${passes} check(s) passed${testCount ? ` in ${testCount} test file(s)` : ""}; everything rolled back`
    : [...realErrors.slice(0, 3), ...fails.slice(0, 5)].join(" | ").slice(0, 1500) || "The tests reported nothing";
  return { ok, passes, note };
}

const SAFE_FN = /^[a-z0-9][a-z0-9-]{0,60}$/;
const sqlPath = (repo, p) => `'${path.join(repo, p).replace(/\\/g, "/").replace(/'/g, "''")}'`;

export async function planRelease(repo, { git = exec } = {}) {
  const g = (args, o) => git("git", ["-C", repo, ...args], o);
  const branch = (await g(["symbolic-ref", "--short", "HEAD"])).out;
  if (branch !== "main") return { problem: `The laptop's main folder is on "${branch || "?"}", not main.` };
  const dirty = (await g(["status", "--porcelain", "--untracked-files=no"])).out;
  if (dirty) return { problem: "The laptop's main folder has uncommitted changes; commit or set them aside first." };
  const f = await g(["fetch", "--quiet", "origin", "main"], { timeout: 90_000 });
  if (!f.ok) return { problem: `Could not reach GitHub: ${f.err.slice(0, 200)}` };
  const base = (await g(["rev-parse", "origin/main"])).out;
  const head = (await g(["rev-parse", "HEAD"])).out;
  if (!(await g(["merge-base", "--is-ancestor", base, head])).ok) return { base, head, problem: "GitHub main has changes the laptop does not have; pull them first (no force push)." };
  const commits = parseCommits((await g(["log", "--format=%h%x09%s", `${base}..${head}`])).out);
  const nameStatus = (await g(["diff", "--no-renames", "--name-status", base, head])).out;
  const addedOrder = (await g(["log", "--reverse", "--diff-filter=A", "--name-only", "--format=", `${base}..${head}`, "--", MIGRATIONS])).out;
  const fnRoot = path.join(repo, FUNCTIONS);
  const allFunctions = fs.readdirSync(fnRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "_shared" && fs.existsSync(path.join(fnRoot, d.name, "index.ts"))).map((d) => d.name);
  const { plan, problem } = computePlan({ commits, nameStatus, addedOrder, allFunctions });
  return { base, head, plan, problem };
}

// ---------------------------------------------------------------- release / rollback
function makeTools(cfg, repo, secrets) {
  const password = readDbPassword(cfg.passwordFile);
  secrets.push(password);
  const pgEnv = { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: "20" };
  const conn = ["-h", cfg.dbHost, "-p", "5432", "-U", cfg.dbUser, "-d", "postgres"];
  return {
    git: (args, o) => exec("git", ["-C", repo, ...args], o),
    psql: (args, o) => exec(cfg.psql, [...conn, ...args], { env: pgEnv, ...o }),
    pgDump: (args) => exec(cfg.pgDump, [...conn, ...args], { env: pgEnv, timeout: 20 * 60_000 }),
    // npx.cmd needs a shell on Windows; every argument is a fixed word or a checked function name
    deploy: (fn) => SAFE_FN.test(fn) ? exec("npx.cmd", ["supabase", "functions", "deploy", fn, "--project-ref", cfg.projectRef, "--use-api", "--yes"],
      { cwd: path.join(repo, "backend"), shell: true, timeout: 5 * 60_000 }) : Promise.resolve({ ok: false, err: `bad function name ${fn}` }),
  };
}

async function fetchText(url, method = "GET") {
  try {
    const res = await fetch(url, { method, signal: AbortSignal.timeout(20_000), headers: { "cache-control": "no-cache" } });
    return { status: res.status, text: method === "GET" ? await res.text() : "" };
  } catch (e) { return { status: 0, text: String(e?.message || e) }; }
}

async function healthCheck(cfg, t, plan, { applied, siteBefore }) {
  const notes = [];
  let ok = true;
  const db = await t.psql(["-At", "-c", "select 1"]);
  if (db.out !== "1") { ok = false; notes.push("database did not answer"); } else notes.push("database answers");
  if (applied.length) {
    const names = applied.map((m) => path.basename(m, ".sql"));
    const r = await t.psql(["-At", "-c", `select count(*) from supabase_migrations.schema_migrations where name in (${names.map((n) => `'${n.replace(/'/g, "''")}'`).join(",")})`]);
    if (Number(r.out) !== names.length) { ok = false; notes.push("not every migration is recorded"); } else notes.push(`${names.length} migration(s) recorded`);
  }
  for (const fn of plan.functions) {
    const r = await fetchText(`https://${cfg.projectRef}.supabase.co/functions/v1/${fn}`, "OPTIONS");
    if (!r.status || r.status >= 500) { ok = false; notes.push(`${fn} not answering (${r.status})`); }
  }
  if (plan.functions.length) notes.push(`${plan.functions.length} function(s) answering`);
  // website: Vercel publishes the pushed commit; wait for a new page when the website changed, else just check it answers
  const deadline = Date.now() + 9 * 60_000;
  let site = await fetchText(cfg.siteUrl);
  while (plan.website && Date.now() < deadline && (site.status !== 200 || site.text === siteBefore)) {
    await new Promise((r) => setTimeout(r, 20_000));
    site = await fetchText(cfg.siteUrl);
  }
  if (site.status !== 200) { ok = false; notes.push(`website answered ${site.status}`); }
  else if (plan.website && site.text === siteBefore) { ok = false; notes.push("the website still shows the old version after 9 minutes (Vercel may still be building)"); }
  else {
    const js = (site.text.match(/src="(\/assets\/[^"]+\.js)"/) || [])[1];
    const a = js ? await fetchText(new URL(js, cfg.siteUrl).href) : { status: 0 };
    if (a.status !== 200) { ok = false; notes.push("website page loads but its app file does not"); } else notes.push(plan.website ? "new website version is up" : "website answers");
  }
  return { ok, note: notes.join("; ") };
}

export async function runRelease(job, { api, repo, cfg = releaseConfig(), log }) {
  const secrets = [];
  const step = async (name, ok, note) => { const n = redact(note, secrets).slice(0, 1900); await api.releaseStep(job.ref, name, ok, n); log(ok ? "INFO" : "WARN", `Release ${job.ref}: ${name} ${ok ? "OK" : "FAILED"} - ${n}`); return ok; };
  const finish = async (ok, note, backup) => { await api.releaseFinish(job.ref, ok, redact(note, secrets).slice(0, 1900), backup ?? null); log(ok ? "INFO" : "WARN", `Release ${job.ref}: ${ok ? "LIVE" : "FAILED"}`); };
  let backup = null;
  try {
    const t = makeTools(cfg, repo, secrets);
    const plan = job.plan || {};
    // 1. checks: still exactly what the Owner approved
    const now = await planRelease(repo, { git: exec });
    if (now.problem) { await step("checks", false, now.problem); return await finish(false, now.problem); }
    if (now.head !== job.commit && !String(now.head).startsWith(job.commit)) { const m = `main moved since your approval (now ${String(now.head).slice(0, 9)}); prepare a new release`; await step("checks", false, m); return await finish(false, m); }
    if (now.base !== job.base_commit) { const m = "GitHub main changed since the plan was made; prepare a new release"; await step("checks", false, m); return await finish(false, m); }
    for (const f of [cfg.psql, cfg.pgDump]) if (!fs.existsSync(f)) { const m = `${f} not found`; await step("checks", false, m); return await finish(false, m); }
    const known = await t.psql(["-At", "-c", "select name from supabase_migrations.schema_migrations"]);
    if (!known.ok) { const m = `database not reachable: ${known.err.slice(0, 200)}`; await step("checks", false, m); return await finish(false, m); }
    const done = new Set(known.out.split(/\r?\n/));
    const todo = (plan.migrations || []).filter((m) => !done.has(path.basename(m, ".sql")));
    await step("checks", true, `main is at the approved commit; ${todo.length} new database change(s)${todo.length < (plan.migrations || []).length ? " (others already applied)" : ""}, ${(plan.functions || []).length} function(s)`);
    const siteBefore = (await fetchText(cfg.siteUrl)).text;

    if (todo.length) {
      // 2. backup
      fs.mkdirSync(cfg.backups, { recursive: true });
      backup = path.join(cfg.backups, `release-${job.ref}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}.dump`);
      const b = await t.pgDump(["-n", "public", "-Fc", "-f", backup]);
      const size = fs.existsSync(backup) ? fs.statSync(backup).size : 0;
      if (!b.ok || size < 100_000) { await step("backup", false, `backup failed (${b.err.slice(0, 200) || `${size} bytes`})`); return await finish(false, "Stopped before any change: the backup failed", backup); }
      await step("backup", true, `${backup} (${(size / 1e6).toFixed(1)} MB)`);

      // 3. database trial: migrations + tests in one transaction that is always rolled back
      const tests = plan.tests || [];
      const trialFile = path.join(os.tmpdir(), `mai-release-${job.ref}.sql`);
      fs.writeFileSync(trialFile, ["\\set ON_ERROR_STOP 1", "begin;", ...todo.map((m) => `\\i ${sqlPath(repo, m)}`), "\\set ON_ERROR_STOP 0",
        "savepoint zz_tests;", ...tests.flatMap((x) => [`\\i ${sqlPath(repo, x)}`, "rollback to savepoint zz_tests;"]), "rollback;", ""].join("\n"));
      const trial = await t.psql(["-f", trialFile], { timeout: 15 * 60_000 });
      fs.rmSync(trialFile, { force: true });
      const judged = trial.ok ? judgeTrial(`${trial.out}\n${trial.err}`, tests.length) : { ok: false, note: `a migration failed in the trial: ${(trial.err.match(/ERROR:.*$/m) || [trial.err])[0].slice(0, 400)}` };
      if (!(await step("database trial", judged.ok, judged.note))) return await finish(false, "Stopped before any change: the database trial failed (nothing was applied)", backup);

      // 4. apply, one transaction per migration, recorded like the CLI does
      const applied = [];
      for (const [i, m] of todo.entries()) {
        const version = new Date(Date.now() + i * 1000).toISOString().replace(/[-:T]/g, "").slice(0, 14);
        const name = path.basename(m, ".sql").replace(/'/g, "''");
        const r = await t.psql(["-v", "ON_ERROR_STOP=1", "-1", "-f", path.join(repo, m), "-c",
          `insert into supabase_migrations.schema_migrations (version, name) values ('${version}', '${name}')`], { timeout: 15 * 60_000 });
        if (!r.ok) {
          await step("database change", false, `${path.basename(m)} failed and was rolled back: ${(r.err.match(/ERROR:.*$/m) || [r.err])[0].slice(0, 400)}${applied.length ? `; already applied: ${applied.map((x) => path.basename(x)).join(", ")}` : ""}`);
          return await finish(false, `Stopped: a database change failed${applied.length ? " after earlier ones were applied (see steps; backup " + backup + ")" : " (nothing applied)"}`, backup);
        }
        applied.push(m);
      }
      await step("database change", true, `applied ${applied.map((x) => path.basename(x)).join(", ")}`);
      job._applied = applied;
    }

    // 5. server functions
    for (const fn of plan.functions || []) {
      const r = await t.deploy(fn);
      if (!(await step(`deploy ${fn}`, r.ok, r.ok ? "deployed" : (r.err || r.out).slice(-400)))) return await finish(false, `Stopped: the ${fn} function did not deploy${todo.length ? " (the database change is already live)" : ""}`, backup);
    }

    // 6. website: push main to GitHub (fast-forward only); Vercel publishes it
    const p = await t.git(["push", "origin", "main"], { timeout: 3 * 60_000 });
    if (!(await step("publish", p.ok, p.ok ? `pushed ${String(job.commit).slice(0, 9)} to GitHub; Vercel is publishing` : (p.err || p.out).slice(-400)))) return await finish(false, "Stopped: could not push to GitHub", backup);

    // 7. health check
    const h = await healthCheck(cfg, t, plan, { applied: job._applied || [], siteBefore });
    await step("health check", h.ok, h.note);
    return await finish(h.ok, h.ok ? `Live and healthy: ${h.note}` : `Released, but the health check found a problem: ${h.note}. You can roll back the website and functions.`, backup);
  } catch (e) {
    await finish(false, `The release stopped unexpectedly: ${e?.message || e}`, backup).catch(() => {});
  }
}

export async function runRollback(job, { api, repo, cfg = releaseConfig(), log }) {
  const secrets = [];
  const step = async (name, ok, note) => { const n = redact(note, secrets).slice(0, 1900); await api.releaseStep(job.ref, name, ok, n); log(ok ? "INFO" : "WARN", `Rollback ${job.ref}: ${name} ${ok ? "OK" : "FAILED"} - ${n}`); return ok; };
  const finish = (ok, note) => api.releaseFinish(job.ref, ok, redact(note, secrets).slice(0, 1900), null);
  try {
    const t = makeTools(cfg, repo, secrets);
    const plan = job.plan || {};
    const base = String(job.base_commit || "");
    if (!/^[0-9a-f]{7,40}$/.test(base)) { await step("checks", false, "no earlier version recorded"); return await finish(false, "Rollback not possible: no earlier version recorded"); }
    const branch = (await t.git(["symbolic-ref", "--short", "HEAD"])).out;
    const dirty = (await t.git(["status", "--porcelain", "--untracked-files=no"])).out;
    const head = (await t.git(["rev-parse", "HEAD"])).out;
    await t.git(["fetch", "--quiet", "origin", "main"], { timeout: 90_000 });
    const remote = (await t.git(["rev-parse", "origin/main"])).out;
    const problem = branch !== "main" ? "the main folder is not on main" : dirty ? "the main folder has uncommitted changes"
      : !head.startsWith(job.commit) && !String(job.commit).startsWith(head) ? "main has newer changes than this release; roll back by hand"
      : remote !== head ? "GitHub main is not at this release" : null;
    if (problem) { await step("checks", false, problem); return await finish(false, `Rollback not started: ${problem}`); }
    await step("checks", true, `main is at the released commit; going back to ${base.slice(0, 9)} for the website and server functions`);

    // the release's files except database migrations / tests, back to the earlier version, as one new commit
    const files = (await t.git(["diff", "--no-renames", "--name-status", base, head, "--", ".", `:!${MIGRATIONS}`, `:!${TESTS}`])).out
      .split(/\r?\n/).filter(Boolean).map((l) => { const [st, ...p] = l.split("\t"); return { st: st[0], path: p.join("\t") }; });
    if (!files.length) {
      await step("restore files", true, "the release changed only the database: no website or function files to roll back");
      return await finish(true, "Nothing to roll back on the website or server functions. The database changes were NOT undone (that could delete data); ask the developer if they must be reversed.");
    }
    const added = files.filter((f) => f.st === "A").map((f) => f.path);
    const back = files.filter((f) => f.st !== "A").map((f) => f.path);
    if (added.length) await t.git(["rm", "-q", "--", ...added]);
    if (back.length) await t.git(["checkout", base, "--", ...back]);
    const c = await t.git(["commit", "-q", "-m", `Roll back ${job.ref}: website and server functions back to ${base.slice(0, 9)} (database unchanged)`]);
    if (!c.ok) { await t.git(["reset", "-q", "--hard", head]); await step("restore files", false, (c.err || c.out).slice(0, 300)); return await finish(false, "Rollback failed while restoring files; nothing was changed"); }
    await step("restore files", true, `${files.length} file(s) back to ${base.slice(0, 9)}`);
    for (const fn of plan.functions || []) {
      const r = await t.deploy(fn);
      if (!(await step(`deploy ${fn}`, r.ok, r.ok ? "earlier version deployed" : (r.err || r.out).slice(-400)))) return await finish(false, `Rollback stopped: ${fn} did not deploy`);
    }
    const siteBefore = (await fetchText(cfg.siteUrl)).text;
    const p = await t.git(["push", "origin", "main"], { timeout: 3 * 60_000 });
    if (!(await step("publish", p.ok, p.ok ? "rollback pushed; Vercel is publishing" : (p.err || p.out).slice(-400)))) return await finish(false, "Rollback stopped: could not push");
    const h = await healthCheck(cfg, t, { ...plan, website: !!plan.website }, { applied: [], siteBefore });
    await step("health check", h.ok, h.note);
    const db = (plan.migrations || []).length ? ` The database changes were NOT undone (that could delete data); ask the developer if they must be reversed.` : "";
    return await finish(h.ok, `${h.ok ? "Rolled back" : "Rolled back, but the health check found a problem"}: ${h.note}.${db}`);
  } catch (e) {
    await finish(false, `The rollback stopped unexpectedly: ${e?.message || e}`).catch(() => {});
  }
}

export async function handleRelease(job, ctx) {
  if (job.action === "plan") {
    try {
      const r = await planRelease(ctx.repo);
      await ctx.api.releasePlan(job.ref, r.base ?? null, r.head ?? null, r.plan ?? { commits: [] }, r.problem ?? null);
      ctx.log("INFO", `Release ${job.ref}: plan ${r.problem ? `not possible: ${r.problem}` : `${r.plan.commits.length} commit(s), ${r.plan.migrations.length} migration(s), ${r.plan.functions.length} function(s)`}`);
    } catch (e) {
      await ctx.api.releasePlan(job.ref, null, null, { commits: [] }, `Planning failed: ${e?.message || e}`).catch(() => {});
    }
  } else if (job.action === "release") await runRelease(job, ctx);
  else if (job.action === "rollback") await runRollback(job, ctx);
}
