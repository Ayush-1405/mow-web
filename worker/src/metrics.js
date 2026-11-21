// Laptop health readings sent with every heartbeat: CPU, memory, NVIDIA GPU, disks, charger / battery, uptime.
// Read-only commands only (nvidia-smi, a CIM battery query); each has a short timeout so a slow tool never blocks the worker.
import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { cpuPercent } from "./policy.js";

const run = (cmd, args, ms = 4000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: ms, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
});

export async function sampleCpu(ms = 1000) {
  const a = os.cpus(); await new Promise((r) => setTimeout(r, ms)); const b = os.cpus();
  return cpuPercent(a, b);
}

async function gpu() {
  const out = await run("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"]);
  if (!out) return null;
  const [name, util, used, total] = out.split("\n")[0].split(",").map((s) => s.trim());
  return { name, util_pct: Number(util), vram_used_gb: +(Number(used) / 1024).toFixed(2), vram_total_gb: +(Number(total) / 1024).toFixed(2) };
}

function disks() {
  const out = {};
  for (const d of ["C:\\", "D:\\"]) {
    try {
      const s = fs.statfsSync(d);
      out[d[0]] = { free_gb: +((s.bavail * s.bsize) / 1024 ** 3).toFixed(1), total_gb: +((s.blocks * s.bsize) / 1024 ** 3).toFixed(1) };
    } catch { /* drive not present */ }
  }
  return out;
}

// Win32_Battery.BatteryStatus: 2 = on charger; 1 = discharging. No battery reported = desktop / always on mains.
async function power() {
  if (process.platform !== "win32") return { on_ac: true, battery_pct: null };
  const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$b = Get-CimInstance Win32_Battery; if ($b) { \"$($b.BatteryStatus),$($b.EstimatedChargeRemaining)\" } else { 'none' }"], 6000);
  if (!out || out === "none") return { on_ac: true, battery_pct: null };
  const [status, pct] = out.split(",").map(Number);
  return { on_ac: status !== 1, battery_pct: Number.isFinite(pct) ? pct : null };
}

export async function readMetrics() {
  const [cpu_pct, g, p] = await Promise.all([sampleCpu(), gpu(), power()]);
  return {
    cpu_pct, cpu_cores: os.cpus().length, cpu_model: os.cpus()[0]?.model?.trim(),
    ram_total_gb: +(os.totalmem() / 1024 ** 3).toFixed(1), ram_free_gb: +(os.freemem() / 1024 ** 3).toFixed(1),
    gpu: g, disks: disks(), on_ac: p.on_ac, battery_pct: p.battery_pct,
    os_uptime_h: +(os.uptime() / 3600).toFixed(1), worker_uptime_min: +(process.uptime() / 60).toFixed(1),
    worker_ram_mb: Math.round(process.memoryUsage().rss / 1e6),
  };
}
