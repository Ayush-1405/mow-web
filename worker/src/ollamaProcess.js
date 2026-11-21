// Starts Ollama together with the worker and stops it when the worker stops, so local models only run while the Owner
// has the worker open. Ollama is bound to 127.0.0.1 (this laptop only) and keeps models on D:\MoodAI\models.
// If Ollama is already running (the Owner opened it), it is left alone. If Ollama is not installed, the worker simply
// runs without local models (local-model jobs stay queued).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ollamaStatus } from "./ollama.js";

export const OLLAMA_ENV = {
  OLLAMA_HOST: "127.0.0.1:11434",
  OLLAMA_MODELS: "D:\\MoodAI\\models",
  OLLAMA_KEEP_ALIVE: "5m",
  OLLAMA_MAX_LOADED_MODELS: "1",
  OLLAMA_NUM_PARALLEL: "1",
};

function ollamaExe() {
  const local = path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe");
  return fs.existsSync(local) ? local : null;
}

const reachable = async () => {
  try { const r = await fetch("http://127.0.0.1:11434/api/version", { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
};

export async function startOllama(log, logDir) {
  if (await reachable()) { log("INFO", "Ollama is already running; using it"); return null; }
  const exe = ollamaExe();
  if (!exe) { log("INFO", "Ollama is not installed; running without local models"); return null; }
  const out = fs.openSync(path.join(logDir, `ollama-${new Date().toISOString().slice(0, 10)}.log`), "a");
  const child = spawn(exe, ["serve"], { env: { ...process.env, ...OLLAMA_ENV }, stdio: ["ignore", out, out], windowsHide: true });
  child.on("exit", (code) => log("INFO", `Ollama stopped (code ${code})`));
  for (let i = 0; i < 30; i++) { // up to 15 s
    if (await reachable()) {
      const s = await ollamaStatus();
      log("INFO", `Ollama ${s.version || ""} started (this laptop only); models: ${(s.installed || []).map((m) => m.name).join(", ") || "none"}`);
      return child;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log("WARN", "Ollama did not start within 15 s; running without local models");
  try { child.kill(); } catch { /* ignore */ }
  return null;
}

export function stopOllama(child) {
  if (child && child.exitCode === null) { try { child.kill(); } catch { /* ignore */ } }
}
