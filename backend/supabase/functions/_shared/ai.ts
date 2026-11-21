// One AI client for every AI edge function. Google Gemini when GEMINI_API_KEY is set (the default for this
// project), otherwise Anthropic Claude when ANTHROPIC_API_KEY is set. Callers keep building Claude-style requests
// (system, messages with text / base64 image / base64 PDF blocks, a JSON schema for the answer) and get back a
// Claude-style reply ({ content: [{ type: "text", text }], stop_reason, usage }) whichever provider answered.
//
// Secrets (server-side only, never in the app): GEMINI_API_KEY, GEMINI_MODEL (optional, default gemini-3.5-flash),
// ANTHROPIC_API_KEY (fallback).

import Anthropic from "npm:@anthropic-ai/sdk";

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
  messages: { role: "user"; content: AiBlock[] | string }[];
}

export interface AiReply {
  content: { type: "text"; text: string }[];
  stop_reason: "end_turn" | "max_tokens" | "refusal";
  usage: { input_tokens: number; output_tokens: number };
}

export class AiError extends Error {
  constructor(public kind: "rate_limit" | "auth" | "api", public status: number, message: string) { super(message); }
}

const GEMINI_KEY = () => Deno.env.get("GEMINI_API_KEY") ?? "";
const CLAUDE_KEY = () => Deno.env.get("ANTHROPIC_API_KEY") ?? "";

export const aiProvider = (): "gemini" | "anthropic" | null => (GEMINI_KEY() ? "gemini" : CLAUDE_KEY() ? "anthropic" : null);
export const aiConfigured = () => aiProvider() !== null;
// The model actually used (stored on drafts / extractions for audit). claudeModel is the function's own Claude choice.
export const aiModel = (claudeModel: string) => (aiProvider() === "gemini" ? (Deno.env.get("GEMINI_MODEL") ?? "gemini-3.5-flash") : claudeModel);

// A short, staff-readable reason for an AI failure.
export function aiFailureReason(e: unknown): string {
  if (e instanceof AiError) {
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

async function geminiCreate(req: AiRequest, timeoutMs: number): Promise<AiReply> {
  const model = aiModel(req.model ?? "");
  const parts: Record<string, unknown>[] = [];
  for (const m of req.messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content } as AiBlock] : m.content;
    for (const b of blocks) {
      if (b.type === "text") parts.push({ text: b.text });
      else parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
    }
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
      body: JSON.stringify({ systemInstruction: { parts: [{ text: req.system }] }, contents: [{ role: "user", parts }], generationConfig }),
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
  const usage = { input_tokens: body?.usageMetadata?.promptTokenCount ?? 0, output_tokens: body?.usageMetadata?.candidatesTokenCount ?? 0 };
  if (body?.promptFeedback?.blockReason) return { content: [], stop_reason: "refusal", usage };
  const cand = body?.candidates?.[0];
  const finish = String(cand?.finishReason ?? "STOP");
  const text = (cand?.content?.parts ?? []).filter((p: { thought?: boolean; text?: string }) => !p.thought && typeof p.text === "string")
    .map((p: { text: string }) => p.text).join("");
  const stop: AiReply["stop_reason"] = finish === "MAX_TOKENS" ? "max_tokens"
    : ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"].includes(finish) ? "refusal" : "end_turn";
  return { content: [{ type: "text", text }], stop_reason: stop, usage };
}

// A client with the same create() call the functions already used with the Anthropic SDK.
export function aiClient(opts: { timeoutMs?: number; maxRetries?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return {
    messages: {
      async create(req: AiRequest): Promise<AiReply> {
        if (aiProvider() === "gemini") {
          // One retry on a busy / timed-out answer, like the Anthropic SDK did.
          for (let attempt = 0; ; attempt++) {
            try { return await geminiCreate(req, timeoutMs); } catch (e) {
              const retry = attempt < (opts.maxRetries ?? 1) && ((e instanceof AiError && (e.status === 503 || e.status >= 500)) || (e instanceof Error && e.name === "AbortError"));
              if (!retry) throw e;
            }
          }
        }
        const client = new Anthropic({ apiKey: CLAUDE_KEY(), timeout: timeoutMs, maxRetries: opts.maxRetries ?? 1 });
        // deno-lint-ignore no-explicit-any
        const r = await client.messages.create(req as any) as any;
        return {
          content: (r.content ?? []).filter((b: { type: string }) => b.type === "text"),
          stop_reason: r.stop_reason === "max_tokens" ? "max_tokens" : r.stop_reason === "refusal" ? "refusal" : "end_turn",
          usage: { input_tokens: r.usage?.input_tokens ?? 0, output_tokens: r.usage?.output_tokens ?? 0 },
        };
      },
    },
  };
}
