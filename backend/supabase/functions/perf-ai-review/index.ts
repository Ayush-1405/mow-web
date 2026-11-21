// Mood of Wood — AI performance review writer (v3_17).
//
// POST { report_id }          -> writes the AI review of one saved monthly employee report
// POST { company_report_id }  -> writes the AI summary of one saved monthly company report
// (Authorization: Bearer <user JWT>; OPTIONS answers the CORS preflight first.)
//
// The numbers are NOT made here: they were calculated and frozen by the database (perf_eval / perf_generate_month).
// This function only turns those frozen facts into readable text. It reads the facts and saves the text through the
// caller's own JWT (perf_ai_input / perf_save_ai_review check that the caller is Management or the person's Head), so no
// service-role key is used. Every list item must cite task numbers that exist in the report; items citing anything else
// are dropped before saving. A review is written once per report version.
//
// Secrets (server-side only): GEMINI_API_KEY (or ANTHROPIC_API_KEY), GEMINI_MODEL / PERF_AI_MODEL -- see _shared/ai.ts.

import { aiClient, aiConfigured, aiFailureReason, aiModel, AiError } from "../_shared/ai.ts";
import { buildCorsHeaders, handlePreflightStrict, rejectDisallowedOrigin } from "../_shared/cors.ts";
import { extractBearerToken, userScopedClient, verifyCaller } from "../_shared/clients.ts";

const MODEL = aiModel(Deno.env.get("PERF_AI_MODEL") ?? "claude-opus-5");
const AI_TIMEOUT_MS = 120_000;

type Item = { text: string; tasks: string[] };

function reply(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...buildCorsHeaders(origin) } });
}
const fail = (status: number, code: string, error: string, origin: string | null) => reply({ ok: false, error, code }, status, origin);

const itemList = { type: "array", items: { type: "object", properties: { text: { type: "string" }, tasks: { type: "array", items: { type: "string" } } }, required: ["text", "tasks"] } };
const strList = { type: "array", items: { type: "string" } };

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    overall_summary: { type: "string" },
    achievements: itemList,
    best_tasks: itemList,
    missed_deadlines: itemList,
    pending: itemList,
    quality_review: { type: "string" },
    collaboration: { type: "string" },
    strengths: strList,
    improvements: strList,
    recommendations: strList,
    comparison: { type: "string" },
    insufficient_data: strList,
  },
  required: ["overall_summary", "achievements", "best_tasks", "missed_deadlines", "pending", "quality_review", "collaboration",
    "strengths", "improvements", "recommendations", "comparison", "insufficient_data"],
};

const COMPANY_SCHEMA = {
  type: "object",
  properties: {
    overview: { type: "string" },
    departments: { type: "array", items: { type: "object", properties: { department_id: { type: "string" }, summary: { type: "string" } }, required: ["department_id", "summary"] } },
    top_departments: { type: "string" },
    improvement: { type: "string" },
    backlog: { type: "string" },
    overdue: { type: "string" },
    repeated_delays: { type: "string" },
    procurement: { type: "string" },
    factory: { type: "string" },
    coordination: { type: "string" },
    actions: strList,
  },
  required: ["overview", "departments", "top_departments", "improvement", "backlog", "overdue", "repeated_delays", "procurement", "factory", "coordination", "actions"],
};

const RULES = `Rules you must follow:
- Use ONLY the facts in the JSON you are given. Never invent achievements, conversations, customers, incidents or numbers.
- The scores were calculated by the company's scoring engine. Do not recalculate, change or invent scores; you may quote them.
- When you mention specific work, cite its task number(s) exactly as given (for example "TSK-001234") in the "tasks" field.
- If a section has no supporting facts, say plainly that there is insufficient data for it, and list that section in insufficient_data.
- Delays that were verified as not the person's fault, cancelled tasks, reassigned tasks and tasks completed by a colleague must not be described as failures.
- Do not recommend warnings, penalties, salary, promotion or disciplinary action. Recommendations are practical work suggestions only.
- Write in clear, respectful, plain business English. Short sentences. No emojis.`;

function cleanItems(v: unknown, known: Set<string>): Item[] {
  if (!Array.isArray(v)) return [];
  const out: Item[] = [];
  for (const raw of v.slice(0, 8)) {
    const text = String((raw as Item)?.text ?? "").trim().slice(0, 600);
    const tasks = Array.isArray((raw as Item)?.tasks) ? (raw as Item).tasks.map((t) => String(t).trim()).filter((t) => known.has(t)) : [];
    if (text && tasks.length) out.push({ text, tasks: [...new Set(tasks)].slice(0, 10) });
  }
  return out;
}
const cleanStrings = (v: unknown, max = 8) => (Array.isArray(v) ? v.map((s) => String(s).trim().slice(0, 500)).filter(Boolean).slice(0, max) : []);
const cleanText = (v: unknown) => String(v ?? "").trim().slice(0, 2000);

function parseJson(text: string): Record<string, unknown> {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return JSON.parse(t);
}

async function writeEmployeeReview(token: string, reportId: string, origin: string | null): Promise<Response> {
  const db = userScopedClient(token);
  const { data: input, error } = await db.rpc("perf_ai_input", { p_report: reportId });
  if (error || !input) return fail(403, "not_allowed", "You cannot write the AI review for this report.", origin);
  if (input.ai_status === "DONE") return fail(409, "already_written", "The AI review for this report is already written.", origin);
  if (input.status === "SUPERSEDED") return fail(409, "superseded", "This report version has been replaced.", origin);

  const known = new Set<string>((input.tasks ?? []).map((t: { task_number: string }) => String(t.task_number)));
  const system = `You write the monthly performance review of one employee of Mood of Wood, a furniture and interiors company, for their Head and Management.\n${RULES}`;
  const user = `Write the review for ${input.month}. Facts (JSON):\n${JSON.stringify(input)}`;

  let reply_: Awaited<ReturnType<ReturnType<typeof aiClient>["messages"]["create"]>>;
  try {
    reply_ = await aiClient({ timeoutMs: AI_TIMEOUT_MS, maxRetries: 0 }).messages.create({
      model: MODEL, max_tokens: 4000, system, output_config: { effort: "low", format: { type: "json_schema", schema: REVIEW_SCHEMA } },
      messages: [{ role: "user", content: user }],
    });
  } catch (e) {
    const reason = aiFailureReason(e);
    await db.rpc("perf_save_ai_review", { p_report: reportId, p_review: null, p_model: MODEL, p_error: reason });
    return fail(e instanceof AiError && e.kind === "rate_limit" ? 429 : 502, "ai_failed", reason, origin);
  }
  if (reply_.stop_reason !== "end_turn") {
    const reason = reply_.stop_reason === "max_tokens" ? "The AI answer was too long -- please retry" : "The AI declined to answer";
    await db.rpc("perf_save_ai_review", { p_report: reportId, p_review: null, p_model: MODEL, p_error: reason });
    return fail(502, "ai_failed", reason, origin);
  }
  let raw: Record<string, unknown>;
  try { raw = parseJson(reply_.content.map((b) => b.text).join("")); } catch {
    await db.rpc("perf_save_ai_review", { p_report: reportId, p_review: null, p_model: MODEL, p_error: "The AI answer could not be read" });
    return fail(502, "ai_failed", "The AI answer could not be read -- please retry.", origin);
  }
  const review = {
    overall_summary: cleanText(raw.overall_summary),
    achievements: cleanItems(raw.achievements, known),
    best_tasks: cleanItems(raw.best_tasks, known),
    missed_deadlines: cleanItems(raw.missed_deadlines, known),
    pending: cleanItems(raw.pending, known),
    quality_review: cleanText(raw.quality_review),
    collaboration: cleanText(raw.collaboration),
    strengths: cleanStrings(raw.strengths),
    improvements: cleanStrings(raw.improvements),
    recommendations: cleanStrings(raw.recommendations),
    comparison: input.comparison ? cleanText(raw.comparison) : "There is no saved report for the previous month, so no comparison is made.",
    insufficient_data: cleanStrings(raw.insufficient_data, 12),
    based_on: { report_id: reportId, tasks: known.size, model: MODEL },
  };
  if (!review.overall_summary) return fail(502, "ai_failed", "The AI answer was empty -- please retry.", origin);
  const { error: saveErr } = await db.rpc("perf_save_ai_review", { p_report: reportId, p_review: review, p_model: MODEL, p_error: null });
  if (saveErr) return fail(409, "save_failed", saveErr.message, origin);
  return reply({ ok: true, review }, 200, origin);
}

async function writeCompanySummary(token: string, companyId: string, origin: string | null): Promise<Response> {
  const db = userScopedClient(token);
  const { data: input, error } = await db.rpc("perf_company_ai_input", { p_id: companyId });
  if (error || !input) return fail(403, "not_allowed", "Only Management can write the company summary.", origin);
  if (input.ai_status === "DONE") return fail(409, "already_written", "The AI summary is already written.", origin);
  const deptIds = new Set<string>((input.metrics?.departments ?? []).map((d: { department_id: string }) => String(d.department_id)));
  const system = `You write the monthly Management performance summary of Mood of Wood, a furniture and interiors company.\n${RULES}
- Compare departments only with the department averages given; do not rank people across departments.
- In "departments" write one short summary per department_id that appears in metrics.departments, using that exact department_id.`;
  let reply_: Awaited<ReturnType<ReturnType<typeof aiClient>["messages"]["create"]>>;
  try {
    reply_ = await aiClient({ timeoutMs: AI_TIMEOUT_MS, maxRetries: 0 }).messages.create({
      model: MODEL, max_tokens: 5000, system, output_config: { effort: "low", format: { type: "json_schema", schema: COMPANY_SCHEMA } },
      messages: [{ role: "user", content: `Write the summary for ${input.month}. Facts (JSON):\n${JSON.stringify(input.metrics)}` }],
    });
  } catch (e) {
    const reason = aiFailureReason(e);
    await db.rpc("perf_save_company_ai", { p_id: companyId, p_summary: null, p_model: MODEL, p_error: reason });
    return fail(502, "ai_failed", reason, origin);
  }
  let raw: Record<string, unknown>;
  try { raw = parseJson(reply_.content.map((b) => b.text).join("")); } catch {
    await db.rpc("perf_save_company_ai", { p_id: companyId, p_summary: null, p_model: MODEL, p_error: "The AI answer could not be read" });
    return fail(502, "ai_failed", "The AI answer could not be read -- please retry.", origin);
  }
  const summary = {
    overview: cleanText(raw.overview),
    departments: (Array.isArray(raw.departments) ? raw.departments : [])
      .map((d) => ({ department_id: String((d as { department_id: string }).department_id ?? ""), summary: cleanText((d as { summary: string }).summary) }))
      .filter((d) => deptIds.has(d.department_id) && d.summary),
    top_departments: cleanText(raw.top_departments), improvement: cleanText(raw.improvement), backlog: cleanText(raw.backlog),
    overdue: cleanText(raw.overdue), repeated_delays: cleanText(raw.repeated_delays), procurement: cleanText(raw.procurement),
    factory: cleanText(raw.factory), coordination: cleanText(raw.coordination), actions: cleanStrings(raw.actions, 10),
    based_on: { company_report_id: companyId, model: MODEL },
  };
  if (!summary.overview) return fail(502, "ai_failed", "The AI answer was empty -- please retry.", origin);
  const { error: saveErr } = await db.rpc("perf_save_company_ai", { p_id: companyId, p_summary: summary, p_model: MODEL, p_error: null });
  if (saveErr) return fail(409, "save_failed", saveErr.message, origin);
  return reply({ ok: true, summary }, 200, origin);
}

async function handle(req: Request, origin: string | null): Promise<Response> {
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.", origin);
  const token = extractBearerToken(req);
  if (!token || !(await verifyCaller(token))) return fail(401, "unauthorized", "Please sign in again.", origin);
  if (!aiConfigured()) return fail(503, "ai_not_configured", "The AI service is not configured yet.", origin);
  let body: { report_id?: string; company_report_id?: string };
  try { body = await req.json(); } catch { return fail(400, "bad_request", "Invalid request.", origin); }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (body.report_id && uuid.test(body.report_id)) return await writeEmployeeReview(token, body.report_id, origin);
  if (body.company_report_id && uuid.test(body.company_report_id)) return await writeCompanySummary(token, body.company_report_id, origin);
  return fail(400, "bad_request", "Send report_id or company_report_id.", origin);
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
    console.error("perf-ai-review unhandled:", e instanceof Error ? e.name : "error");
    return fail(500, "server_error", "Something went wrong. Please try again.", origin);
  }
});
