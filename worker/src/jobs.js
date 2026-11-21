// Job handlers. Each job type must also be listed (and enabled) in public.mai_job_types, or the queue will never hand it out.
// None of these may purchase, pay, approve or change application records.
import os from "node:os";
import { readMetrics } from "./metrics.js";
import { embed, generate, LIMITS, ollamaStatus } from "./ollama.js";

export class PermanentError extends Error {} // do not retry

// Checks a job's input before it reaches a local model. Bad input is a permanent failure (retrying will not help).
export function checkEmbedPayload(p) {
  const texts = Array.isArray(p?.texts) ? p.texts : typeof p?.text === "string" ? [p.text] : null;
  if (!texts || !texts.length) throw new PermanentError("LOCAL_EMBED needs text or texts");
  if (texts.length > LIMITS.embedTexts) throw new PermanentError(`At most ${LIMITS.embedTexts} texts per job`);
  for (const t of texts) {
    if (typeof t !== "string" || !t.trim()) throw new PermanentError("Every text must be non-empty");
    if (t.length > LIMITS.embedChars) throw new PermanentError(`Each text must be at most ${LIMITS.embedChars} characters`);
  }
  return texts;
}

export function checkGeneratePayload(p) {
  if (typeof p?.prompt !== "string" || !p.prompt.trim()) throw new PermanentError("LOCAL_GENERATE needs a prompt");
  if (p.prompt.length > LIMITS.promptChars) throw new PermanentError(`The prompt must be at most ${LIMITS.promptChars} characters`);
  if (p.system != null && (typeof p.system !== "string" || p.system.length > LIMITS.systemChars)) throw new PermanentError(`The system note must be at most ${LIMITS.systemChars} characters`);
  const maxTokens = Math.min(LIMITS.maxOutputTokens, Math.max(16, Number(p.max_tokens) || 400));
  return { prompt: p.prompt, system: p.system || null, maxTokens, json: p.json === true };
}

// A chat question answered on this laptop when the cloud AI services fail: the app's instructions plus the last few turns.
export function checkChatPayload(p) {
  if (typeof p?.system !== "string" || !p.system.trim()) throw new PermanentError("LOCAL_CHAT needs the system instructions");
  if (p.system.length > LIMITS.chatSystemChars) throw new PermanentError(`The instructions must be at most ${LIMITS.chatSystemChars} characters`);
  const msgs = Array.isArray(p.messages) ? p.messages : [];
  if (!msgs.length || msgs.length > 12) throw new PermanentError("LOCAL_CHAT needs 1-12 messages");
  let total = 0;
  for (const m of msgs) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim()) throw new PermanentError("Every message needs a role and text");
    total += m.content.length;
  }
  if (total > LIMITS.promptChars) throw new PermanentError(`The conversation must be at most ${LIMITS.promptChars} characters`);
  if (msgs[msgs.length - 1].role !== "user") throw new PermanentError("The last message must be the person's question");
  const maxTokens = Math.min(LIMITS.maxOutputTokens, Math.max(64, Number(p.max_tokens) || 700));
  return { system: p.system, messages: msgs.map((m) => ({ role: m.role, content: m.content })), maxTokens, json: p.json === true };
}

async function needModel(kind) {
  const s = await ollamaStatus();
  if (!s.up) throw new Error("Ollama is not running on this laptop"); // retryable: it may be starting
  const name = kind === "embed" ? s.embed_model : s.chat_model;
  if (!name) throw new PermanentError(`The ${kind} model is not installed on this laptop`);
}

export const handlers = {
  // Search vectors for company text. Only the vectors and timings are returned.
  async LOCAL_EMBED(payload) {
    const texts = checkEmbedPayload(payload);
    await needModel("embed");
    const r = await embed(texts);
    return { model: r.model, count: r.vectors.length, dimensions: r.dimensions, ms: r.ms, vectors: r.vectors };
  },

  // A short text answer from the small local model. It has no tools and cannot change any record.
  async LOCAL_GENERATE(payload) {
    const input = checkGeneratePayload(payload);
    await needModel("chat");
    return await generate(input);
  },

  // Mood AI chat fallback: one answer from the local model (text only, no tools, cannot change any record).
  async LOCAL_CHAT(payload) {
    const input = checkChatPayload(payload);
    await needModel("chat");
    return await generate({ ...input, numCtx: 8192, timeoutMs: 100_000 });
  },

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
