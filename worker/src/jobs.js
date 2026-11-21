// Job handlers. Each job type must also be listed (and enabled) in public.mai_job_types, or the queue will never hand it out.
// None of these may purchase, pay, approve or change application records.
import os from "node:os";
import { readMetrics } from "./metrics.js";

export class PermanentError extends Error {} // do not retry

export const handlers = {
  // Reports the laptop's real readings and connection time, proving the whole path (queue -> laptop -> result) works.
  async SELFTEST(payload, ctx) {
    const m = await readMetrics();
    return {
      checked_at: new Date().toISOString(), hostname: os.hostname(), node: process.version, worker_version: ctx.version,
      db_round_trip_ms: ctx.api.lastRpcMs(), metrics: m, note: payload?.note ?? null,
    };
  },
};

export async function runJob(job, ctx) {
  const h = handlers[job.job_type];
  if (!h) throw new PermanentError(`This worker does not know job type ${job.job_type}`);
  const limitMs = Math.max(30_000, (Number(job.lease_minutes) || 10) * 60_000 - 15_000); // finish before the lock runs out
  let timer;
  try {
    return await Promise.race([
      h(job.payload || {}, ctx),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Job took too long and was stopped")), limitMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
