// Local models (step L3): talks to Ollama on this laptop only (127.0.0.1). Ollama itself is started and stopped by the
// worker (ollamaProcess.js), keeps its models on D:\MoodAI\models, and is never reachable from the network.
// Model names can be changed in worker/.env (OLLAMA_EMBED_MODEL, OLLAMA_CHAT_MODEL).

const BASE = "http://127.0.0.1:11434";
export const LIMITS = { embedTexts: 64, embedChars: 8_000, promptChars: 12_000, systemChars: 2_000, chatSystemChars: 16_000, maxOutputTokens: 1_024 };

export function models(env = process.env) {
  return { embed: env.OLLAMA_EMBED_MODEL || "nomic-embed-text", chat: env.OLLAMA_CHAT_MODEL || "qwen3:4b-instruct" };
}

async function call(path, body, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(BASE + path, body === undefined ? { signal: ctrl.signal } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Ollama ${path} answered ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Ollama ${path} took too long`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Sent with every heartbeat; the queue only hands out local-model jobs when up = true.
export async function ollamaStatus(env = process.env) {
  try {
    const [tags, ps, ver] = await Promise.all([call("/api/tags", undefined, 3000), call("/api/ps", undefined, 3000), call("/api/version", undefined, 3000)]);
    const installed = (tags.models || []).map((m) => ({ name: m.name, size_gb: +(m.size / 1024 ** 3).toFixed(2) }));
    const want = models(env);
    const has = (n) => installed.some((m) => m.name === n || m.name === `${n}:latest`);
    return {
      up: has(want.embed) || has(want.chat), version: ver.version || null, installed,
      loaded: (ps.models || []).map((m) => ({ name: m.name, vram_gb: +((m.size_vram || 0) / 1024 ** 3).toFixed(2) })),
      embed_model: has(want.embed) ? want.embed : null, chat_model: has(want.chat) ? want.chat : null,
    };
  } catch {
    return { up: false };
  }
}

export async function embed(texts, env = process.env) {
  const model = models(env).embed;
  const started = Date.now();
  const out = await call("/api/embed", { model, input: texts }, 120_000);
  return { model, vectors: out.embeddings, dimensions: out.embeddings?.[0]?.length ?? 0, ms: Date.now() - started };
}

// One answer from the chat model: a single prompt, or a whole conversation (messages) for the chat fallback.
export async function generate({ prompt, system, messages: turns, maxTokens, json, numCtx = 4096, timeoutMs = 8 * 60_000 }, env = process.env) {
  const model = models(env).chat;
  const started = Date.now();
  const messages = [...(system ? [{ role: "system", content: system }] : []), ...(turns ?? [{ role: "user", content: prompt }])];
  const out = await call("/api/chat", {
    model, messages, stream: false, think: false, ...(json ? { format: "json" } : {}),
    options: { num_ctx: numCtx, num_predict: maxTokens, temperature: 0.3 },
  }, timeoutMs);
  return {
    model, text: out.message?.content ?? "", ms: Date.now() - started,
    input_tokens: out.prompt_eval_count ?? null, output_tokens: out.eval_count ?? null,
    tokens_per_s: out.eval_duration ? +((out.eval_count || 0) / (out.eval_duration / 1e9)).toFixed(1) : null,
  };
}
