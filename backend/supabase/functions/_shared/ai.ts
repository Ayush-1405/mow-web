// Mood AI Core client (v3_19) -- the one way every AI edge function talks to a model.
//
// Callers keep building Claude-style requests (system, messages with text / base64 image / base64 PDF blocks, an optional JSON
// schema) and get back a Claude-style reply ({ content: [{ type: "text", text }], stop_reason, usage }) whichever provider answered.
// Providers are adapters: Anthropic Claude (official SDK) and Google Gemini (REST). A self-hosted model can be added as a third.
//
// Every call goes through Mood AI Core:
//   * the emergency stop and the monthly budget (public.mai_runtime) are checked first -- a stopped Mood AI refuses every call;
//   * the call is recorded in public.mai_usage (feature, model, tokens, cost, time, success) through the service-role client.
// Provider keys stay server-side (Supabase secrets GEMINI_API_KEY, ANTHROPIC_API_KEY); nothing here is sent to the browser.

import Anthropic from "npm:@anthropic-ai/sdk";
import { adminClient } from "./clients.ts";

export type AiBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } };

export interface AiRequest {
  model?: string;
  max_tokens: number;
  system: string;
  thinking?: unknown;
  output_config?: { effort?: "low" | "medium" | "high"; format?: { type: "json_schema"; schema: Record<string, unknown> } };
  messages: { role: "user" | "assistant"; content: AiBlock[] | string }[];
}

export interface AiReply {
  content: { type: "text"; text: string }[];
  stop_reason: "end_turn" | "max_tokens" | "refusal";
  usage: { input_tokens: number; output_tokens: number };
  provider: Provider;
  model: string;
  latency_ms: number;
}

export type Provider = "gemini" | "anthropic";

export class AiError extends Error {
  constructor(public kind: "rate_limit" | "auth" | "api" | "stopped", public status: number, message: string) { super(message); }
}

const GEMINI_KEY = () => Deno.env.get("GEMINI_API_KEY") ?? "";
const CLAUDE_KEY = () => Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const providerHasKey = (p: Provider) => (p === "gemini" ? !!GEMINI_KEY() : !!CLAUDE_KEY());

// The provider a function uses when it does not ask for one: Gemini when its key is set (documents / photos), else Claude.
export const aiProvider = (): Provider | null => (GEMINI_KEY() ? "gemini" : CLAUDE_KEY() ? "anthropic" : null);
export const aiConfigured = () => aiProvider() !== null;
const geminiDefault = () => Deno.env.get("GEMINI_MODEL") ?? "gemini-3.5-flash";
// The model actually used (stored on drafts / extractions for audit). claudeModel is the function's own Claude choice.
export const aiModel = (claudeModel: string) => (aiProvider() === "gemini" ? geminiDefault() : claudeModel);

// A short, staff-readable reason for an AI failure.
export function aiFailureReason(e: unknown): string {
  if (e instanceof AiError) {
    if (e.kind === "stopped") return e.message;
    if (e.kind === "rate_limit") return "AI service is busy or its daily limit is reached -- please retry later";
    if (e.kind === "auth") return "AI service credentials are invalid";
    return `AI service error (${e.status})`;
  }
  if (e instanceof Anthropic.RateLimitError) return "AI service is busy -- please retry shortly";
  if (e instanceof Anthropic.AuthenticationError) return "AI service credentials are invalid";
  if (e instanceof Anthropic.APIError) return `AI service error (${e.status})`;
  if (e instanceof Error && /abort|timed? ?out/i.test(e.message)) return "The AI took too long to answer -- please retry";
  return "AI request failed";
}

// ---------------------------------------------------------------- Mood AI Core runtime (stop switch, budget, routing settings)
export interface AiRuntime {
  ai_enabled: boolean; stop_reason: string | null; chat_provider: Provider; chat_model: string; chat_effort: "low" | "medium" | "high";
  document_provider: Provider; document_model: string; month_cost_usd: number; monthly_budget_usd: number | null;
}
let cached: { at: number; value: AiRuntime | null } | null = null;
export async function aiRuntime(fresh = false): Promise<AiRuntime | null> {
  if (!fresh && cached && Date.now() - cached.at < 15_000) return cached.value;
  try {
    const { data, error } = await adminClient().rpc("mai_runtime");
    if (error) throw error;
    cached = { at: Date.now(), value: data as AiRuntime };
  } catch (e) {
    // Core tables not reachable: keep the existing features working, but say so in the logs.
    console.error("mood-ai runtime unavailable:", e instanceof Error ? e.message : "error");
    cached = { at: Date.now(), value: null };
  }
  return cached.value;
}
async function assertAllowed() {
  const rt = await aiRuntime();
  if (!rt) return;
  if (!rt.ai_enabled) throw new AiError("stopped", 423, `Mood AI is stopped by the Owner${rt.stop_reason ? `: ${rt.stop_reason}` : ""}`);
  if (rt.monthly_budget_usd !== null && rt.monthly_budget_usd !== undefined && Number(rt.month_cost_usd) >= Number(rt.monthly_budget_usd)) {
    throw new AiError("stopped", 423, "This month's AI budget is used up -- the Owner can raise it in the Mood AI Control Center");
  }
}
async function recordUsage(u: { userId?: string | null; feature: string; provider: Provider; model: string; inTok: number; outTok: number; ms: number; ok: boolean; error?: string }) {
  try {
    await adminClient().rpc("mai_record_usage", {
      p_user: u.userId ?? null, p_feature: u.feature, p_provider: u.provider, p_model: u.model, p_in: u.inTok, p_out: u.outTok,
      p_latency_ms: u.ms, p_ok: u.ok, p_error: u.error ? u.error.slice(0, 300) : null,
    });
  } catch {
    console.error("mood-ai usage not recorded");
  }
}

// ---------------------------------------------------------------- Gemini adapter
// Gemini's response schema accepts a subset of JSON Schema: drop keywords it rejects, keep the shape.
function geminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (["$schema", "$id", "additionalProperties", "strict", "examples"].includes(k)) continue;
    out[k] = geminiSchema(v);
  }
  return out;
}

async function geminiCreate(req: AiRequest, model: string, timeoutMs: number): Promise<Omit<AiReply, "provider" | "model" | "latency_ms">> {
  const contents: Record<string, unknown>[] = [];
  for (const m of req.messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content } as AiBlock] : m.content;
    const parts = blocks.map((b) => (b.type === "text" ? { text: b.text } : { inlineData: { mimeType: b.source.media_type, data: b.source.data } }));
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: req.max_tokens,
    thinkingConfig: { thinkingLevel: req.output_config?.effort === "high" ? "high" : req.output_config?.effort === "medium" ? "medium" : "low" },
  };
  if (req.output_config?.format?.schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseJsonSchema = geminiSchema(req.output_config.format.schema);
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY() },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: req.system }] }, contents, generationConfig }),
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(body?.error?.message ?? res.statusText).slice(0, 300);
    console.error(`gemini ${model} ${res.status}: ${msg}`);
    throw new AiError(res.status === 429 ? "rate_limit" : res.status === 401 || res.status === 403 ? "auth" : "api", res.status, msg);
  }
  const usage = { input_tokens: body?.usageMetadata?.promptTokenCount ?? 0, output_tokens: (body?.usageMetadata?.candidatesTokenCount ?? 0) + (body?.usageMetadata?.thoughtsTokenCount ?? 0) };
  if (body?.promptFeedback?.blockReason) return { content: [], stop_reason: "refusal", usage };
  const cand = body?.candidates?.[0];
  const finish = String(cand?.finishReason ?? "STOP");
  const text = (cand?.content?.parts ?? []).filter((p: { thought?: boolean; text?: string }) => !p.thought && typeof p.text === "string")
    .map((p: { text: string }) => p.text).join("");
  const stop: AiReply["stop_reason"] = finish === "MAX_TOKENS" ? "max_tokens"
    : ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"].includes(finish) ? "refusal" : "end_turn";
  return { content: [{ type: "text", text }], stop_reason: stop, usage };
}

// ---------------------------------------------------------------- Anthropic adapter (official SDK)
async function claudeCreate(req: AiRequest, model: string, timeoutMs: number, maxRetries: number): Promise<Omit<AiReply, "provider" | "model" | "latency_ms">> {
  const client = new Anthropic({ apiKey: CLAUDE_KEY(), timeout: timeoutMs, maxRetries });
  // deno-lint-ignore no-explicit-any
  const r = await client.messages.create({ ...req, model } as any) as any;
  return {
    content: (r.content ?? []).filter((b: { type: string }) => b.type === "text"),
    stop_reason: r.stop_reason === "max_tokens" ? "max_tokens" : r.stop_reason === "refusal" ? "refusal" : "end_turn",
    usage: { input_tokens: r.usage?.input_tokens ?? 0, output_tokens: r.usage?.output_tokens ?? 0 },
  };
}

// ---------------------------------------------------------------- the client every function uses
export interface AiClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
  feature?: string;           // recorded in mai_usage, e.g. "ai-task-draft"
  userId?: string | null;     // the signed-in caller, when known
  provider?: Provider;        // force a provider (Mood AI routing); otherwise Gemini if configured, else Claude
}

export function aiClient(opts: AiClientOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return {
    messages: {
      async create(req: AiRequest): Promise<AiReply> {
        await assertAllowed();
        const provider: Provider | null = opts.provider ?? aiProvider();
        if (!provider || !providerHasKey(provider)) throw new AiError("auth", 503, "The AI service is not configured yet");
        const model = provider === "gemini" ? (req.model?.startsWith("gemini") ? req.model : geminiDefault()) : (req.model || "claude-opus-5-5");
        const feature = opts.feature ?? "unknown";
        const started = Date.now();
        for (let attempt = 0; ; attempt++) {
          try {
            const r = provider === "gemini" ? await geminiCreate(req, model, timeoutMs) : await claudeCreate(req, model, timeoutMs, opts.maxRetries ?? 1);
            const ms = Date.now() - started;
            await recordUsage({ userId: opts.userId, feature, provider, model, inTok: r.usage.input_tokens, outTok: r.usage.output_tokens, ms, ok: true });
            return { ...r, provider, model, latency_ms: ms };
          } catch (e) {
            // Gemini: one retry on a busy / timed-out answer, like the Anthropic SDK does itself.
            const retry = provider === "gemini" && attempt < (opts.maxRetries ?? 1)
              && ((e instanceof AiError && e.status >= 500) || (e instanceof Error && e.name === "AbortError"));
            if (retry) continue;
            await recordUsage({ userId: opts.userId, feature, provider, model, inTok: 0, outTok: 0, ms: Date.now() - started, ok: false, error: aiFailureReason(e) });
            throw e;
          }
        }
      },
    },
  };
}
