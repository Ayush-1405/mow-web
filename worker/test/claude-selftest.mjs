// Manual self-test (not part of `node --test`): can this laptop run Claude Code non-interactively with the developer's tool limits?
// Usage: node test/claude-selftest.mjs     (sends one tiny prompt; uses the signed-in Claude account)
import fs from "node:fs";
import { spawn } from "node:child_process";
import { ALLOWED_TOOLS, DENIED_TOOLS, findClaude, parseOutcome } from "../src/devAgent.js";

const exe = findClaude();
if (!exe) { console.log("Claude Code not found"); process.exit(1); }
const cwd = "D:\\MoodAI\\dev\\_selftest";
fs.mkdirSync(cwd, { recursive: true });
const args = ["-p", "This is a connectivity self-test. Do not use any tools. Reply with exactly one line: READY: self-test ok",
  "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", ALLOWED_TOOLS.join(","), "--disallowedTools", DENIED_TOOLS.join(",")];
const c = spawn(exe, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let out = ""; let err = "";
c.stdout.on("data", (d) => { out += d; });
c.stderr.on("data", (d) => { err += d; });
c.on("error", (e) => { console.log("spawn error:", e.code, e.message); });
c.on("close", (code) => {
  let r = out;
  try { const j = JSON.parse(out); r = j.result; console.log("cost_usd:", j.total_cost_usd, "turns:", j.num_turns, "is_error:", j.is_error); } catch { /* text */ }
  console.log("exit:", code);
  console.log("result:", String(r).slice(0, 300));
  console.log("outcome:", JSON.stringify(parseOutcome(r)));
  if (err) console.log("stderr:", err.slice(0, 400));
});
