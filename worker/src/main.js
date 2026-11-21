// Mood AI laptop worker (step L2). Started by the Owner (start-worker.cmd); never starts itself.
//
// Every 30 s: read the laptop's health -> heartbeat to Mood AI Core (gets pause / restart / limits / emergency stop back) ->
// if allowed, take one job, run it, report the result. Network trouble: keep retrying with growing waits (30 s ... 5 min).
// Disconnected or wrong token: stop and do not restart. Exit codes: 0 = stopped, 3 = restart requested, other = crash.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeApi, NotAuthorized } from "./api.js";
import { readMetrics } from "./metrics.js";
import { backoffMs, decide } from "./policy.js";
import { PermanentError, runJob } from "./jobs.js";
import { startOllama, stopOllama } from "./ollamaProcess.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const HEARTBEAT_MS = 30_000;

// ---- logging: console + logs/worker-YYYY-MM-DD.log, kept 14 days
const LOG_DIR = path.join(ROOT, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
function log(level, msg) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(LOG_DIR, `worker-${line.slice(0, 10)}.log`), line + "\n"); } catch { /* disk full: keep running */ }
}
function pruneLogs() {
  const cutoff = Date.now() - 14 * 86400_000;
  for (const f of fs.readdirSync(LOG_DIR)) {
    const p = path.join(LOG_DIR, f);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* ignore */ }
  }
}

// ---- configuration: worker/.env (never committed)
function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) throw new Error("worker/.env is missing (see .env.example)");
  const env = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  for (const k of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "MOOD_AI_WORKER_TOKEN"]) if (!env[k]) throw new Error(`${k} is missing in worker/.env`);
  if (!/^https:\/\//.test(env.SUPABASE_URL)) throw new Error("SUPABASE_URL must be https");
  for (const k of ["OLLAMA_EMBED_MODEL", "OLLAMA_CHAT_MODEL"]) if (env[k]) process.env[k] = env[k]; // optional model overrides
  return env;
}

async function main() {
  const env = loadEnv();
  try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed: still fine */ }
  const api = makeApi({ url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY, token: env.MOOD_AI_WORKER_TOKEN });
  const startedAt = new Date().toISOString();
  const ctx = { api, version: VERSION };
  let stopping = false; let busy = false; let failures = 0; let lastState = null;
  const cpuHistory = [];

  const shutdown = (sig) => { if (!stopping) log("INFO", `${sig}: stopping after the current job`); stopping = true; };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log("INFO", `Mood AI worker ${VERSION} starting on ${os.hostname()} (Node ${process.version}), priority below normal`);
  pruneLogs();
  const ollama = await startOllama(log, LOG_DIR);
  process.on("exit", () => stopOllama(ollama));

  while (!stopping) {
    let wait = HEARTBEAT_MS;
    try {
      const metrics = await readMetrics();
      cpuHistory.push(metrics.cpu_pct); if (cpuHistory.length > 5) cpuHistory.shift();
      // report the state judged with the server's last answer (pause / stop / limits); the new answer then decides this round
      const local = decide({ server: ctx.server || {}, metrics, cpuHistory, limits: ctx.limits });
      const server = await api.heartbeat(metrics, busy ? "RUNNING" : local.state, local.reason, VERSION, os.hostname(), startedAt);
      ctx.server = server;
      ctx.limits = server.limits;
      if (failures) log("INFO", `Reconnected after ${failures} failed attempt(s)`);
      failures = 0;
      if (server.restart) { log("INFO", "Restart requested from the Control Center"); process.exitCode = 3; break; }
      const d = decide({ server, metrics, cpuHistory, limits: server.limits });
      if (d.state !== lastState) { log("INFO", `State: ${d.state}${d.reason ? ` (${d.reason})` : ""}`); lastState = d.state; }
      if (d.run && !busy) {
        const job = await api.claim();
        if (job) {
          busy = true;
          log("INFO", `Job ${job.id} ${job.job_type} attempt ${job.attempt}: started`);
          let outcome;
          try {
            const result = await runJob(job, ctx);
            outcome = await api.complete(job.id, true, result, null);
          } catch (e) {
            if (e instanceof NotAuthorized) throw e;
            log("WARN", `Job ${job.id} failed: ${e.message}`);
            outcome = await api.complete(job.id, false, null, String(e.message).slice(0, 500), !(e instanceof PermanentError));
          } finally {
            busy = false;
          }
          log("INFO", `Job ${job.id}: ${outcome === "lost" ? "result discarded (the job was handed back to the queue)" : outcome}`);
          wait = 2_000; // look for the next job soon
        }
      }
    } catch (e) {
      if (e instanceof NotAuthorized) {
        log("ERROR", `${e.message}. Stopping (not restarting). Register or rotate the worker in the Mood AI Control Center.`);
        process.exitCode = 0;
        return;
      }
      failures += 1;
      wait = backoffMs(failures);
      log("WARN", `Cannot reach Mood AI Core (${e.message}). Retrying in ${Math.round(wait / 1000)} s; the app keeps working without this laptop.`);
    }
    await new Promise((r) => { const t = setTimeout(r, wait); const check = setInterval(() => { if (stopping) { clearTimeout(t); clearInterval(check); r(); } }, 500); setTimeout(() => clearInterval(check), wait + 50); });
  }
  stopOllama(ollama);
  log("INFO", "Mood AI worker stopped");
}

main().catch((e) => { log("ERROR", `Crashed: ${e?.stack || e}`); process.exitCode = 1; });
