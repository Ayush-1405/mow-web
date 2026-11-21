// Mood AI Core API (v3_19, Phase B).
//
// POST { action: "health" }   (Authorization: Bearer <user JWT>; Owner or Management only)
//   Sends a tiny real request to every enabled connected model through the Mood AI client, records the result
//   (mai_models.last_ok_at / last_error, and a mai_usage row with real tokens and cost), and returns what happened.
//   Respects the emergency stop: when Mood AI is stopped nothing is sent.
//
// POST { action: "chat", thread_id?, message, page: { path, title }, departments: [codes], management }   (any signed-in staff
//   member allowed by the Owner's chat setting) -- the floating chat, Phase C: answers and explains, changes nothing. See chat.ts.
//
// Tools with approvals come in Phase D. The browser never talks to a model directly.

import { aiClient, aiFailureReason, aiRuntime, AiError, type Provider } from "../_shared/ai.ts";
import { buildCorsHeaders, handlePreflightStrict, rejectDisallowedOrigin } from "../_shared/cors.ts";
import { adminClient, extractBearerToken, userScopedClient, verifyCaller } from "../_shared/clients.ts";
import { chat, type ChatInput } from "./chat.ts";

function reply(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...buildCorsHeaders(origin) } });
}
const fail = (status: number, code: string, error: string, origin: string | null) => reply({ ok: false, error, code }, status, origin);

async function health(userId: string, origin: string | null): Promise<Response> {
  const rt = await aiRuntime(true);
  if (rt && !rt.ai_enabled) return fail(423, "ai_stopped", `Mood AI is stopped${rt.stop_reason ? `: ${rt.stop_reason}` : ""}`, origin);
  const admin = adminClient();
  const { data: models, error } = await admin.from("mai_models").select("provider, model, label").eq("enabled", true);
  if (error) return fail(500, "server_error", "Could not read the connected models.", origin);
  const results = await Promise.all((models ?? []).map(async (m: { provider: Provider; model: string; label: string }) => {
    try {
      const r = await aiClient({ provider: m.provider, feature: "health-check", userId, timeoutMs: 60_000, maxRetries: 0 }).messages.create({
        model: m.model, max_tokens: 400, system: "You are a connectivity check. Reply with the single word OK.",
        output_config: { effort: "low" }, messages: [{ role: "user", content: "Health check: reply OK." }],
      });
      const text = r.content.map((b) => b.text).join("").trim();
      await admin.rpc("mai_model_health", { p_provider: m.provider, p_model: m.model, p_ok: true, p_latency_ms: r.latency_ms, p_error: null });
      return { provider: m.provider, model: m.model, label: m.label, ok: true, latency_ms: r.latency_ms, reply: text.slice(0, 40),
        input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens };
    } catch (e) {
      const reason = aiFailureReason(e);
      await admin.rpc("mai_model_health", { p_provider: m.provider, p_model: m.model, p_ok: false, p_latency_ms: null, p_error: e instanceof AiError ? `${reason} (${e.status})` : reason });
      return { provider: m.provider, model: m.model, label: m.label, ok: false, error: reason };
    }
  }));
  return reply({ ok: true, results }, 200, origin);
}

async function handle(req: Request, origin: string | null): Promise<Response> {
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.", origin);
  const token = extractBearerToken(req);
  const user = token ? await verifyCaller(token) : null;
  if (!token || !user) return fail(401, "unauthorized", "Please sign in again.", origin);
  let body: { action?: string } & ChatInput;
  try { body = await req.json(); } catch { return fail(400, "bad_request", "Invalid request.", origin); }
  if (body.action === "chat") {
    const r = await chat(user.id, body);
    return reply(r.body, r.status, origin);
  }
  if (body.action === "health") {
    const { data: allowed } = await userScopedClient(token).rpc("mai_can_monitor");
    if (!allowed) return fail(403, "not_allowed", "Only the Owner and Management can run the model health check.", origin);
    return await health(user.id, origin);
  }
  return fail(400, "bad_request", "Unknown action.", origin);
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const preflight = handlePreflightStrict(req);
  if (preflight) return preflight;
  const blocked = rejectDisallowedOrigin(req);
  if (blocked) return blocked;
  try {
    return await handle(req, origin);
  } catch (e) {
    console.error("mood-ai unhandled:", e instanceof Error ? e.name : "error");
    return fail(500, "server_error", "Something went wrong. Please try again.", origin);
  }
});
