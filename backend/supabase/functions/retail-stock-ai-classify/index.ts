// Mood of Wood — Godown stock intake: photo -> category/name suggestion.
//
// POST { product_id }  (Authorization: Bearer <user JWT>, verify_jwt = true)
//
// Mirrors factory-ai-extract's proven shape, deliberately lighter (one photo, one small fixed schema, no
// attachment-request/review lifecycle — this feature is meant to be simpler than Factory's, not a second copy of it):
// 1. Verifies the caller via their own JWT; RLS on retail_products (via the caller-scoped client) decides
//    visibility — never trusts an id from the body for identity/authorization.
// 2. Finds the product's own 'retail_product' proof photo (already uploaded through the normal
//    ProofPhotoUpload -> staff-file-url -> staff_record_attachment pipeline) and downloads it server-side from the
//    private staff-attachments bucket. The service-role key never leaves this function.
// 3. Calls Claude with a small, strict JSON schema (category / product_name / unit / confidence) — no free text.
// 4. Validates the reply again server-side, then stores it via retail_store_stock_classification, a
//    service_role-only RPC. AI can only ever write a SUGGESTION here — committing the real SKU/name/category live
//    is retail_confirm_stock_intake, a human tap, never this function.
//
// Failure is never silent: retail_store_stock_classification is simply not called, and the caller gets a clear
// { ok: false, reason } — the frontend then just shows empty name/category fields for the worker to type instead
// of a suggestion. The placeholder product row is untouched either way.
//
// Secrets: ANTHROPIC_API_KEY (required), RETAIL_STOCK_AI_MODEL (optional, default claude-opus-5).

import Anthropic from "npm:@anthropic-ai/sdk";
import { handlePreflight } from "../_shared/cors.ts";
import { errorResponse, okResponse } from "../_shared/response.ts";
import { MSG } from "../_shared/messages.ts";
import { adminClient, extractBearerToken, userScopedClient, verifyCaller } from "../_shared/clients.ts";
import { isUuid } from "../_shared/validation.ts";

const BUCKET = "staff-attachments";
const MODEL = Deno.env.get("RETAIL_STOCK_AI_MODEL") ?? "claude-opus-5";
const MAX_FILE_BYTES = 15 * 1024 * 1024;

const CLASSIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["category", "product_name", "unit", "confidence"],
  properties: {
    category: { type: "string" }, // short, single word where possible — e.g. "Chair", "Table", "Sofa"
    product_name: { type: "string" }, // a short, human-readable description of the exact item
    unit: { type: "string", enum: ["Nos", "Set", "Pair", "Box", "Roll", "Sqft", "Kg"] },
    confidence: { type: "number" },
  },
};

const SYSTEM_PROMPT = `You look at ONE photo of a furniture/retail stock item for Mood of Wood's Godown team and suggest, in plain words a
warehouse worker will recognize:
- category: the general product family (a short, common word — "Chair", "Table", "Sofa", "Bed", "Wardrobe",
  "Cabinet", "Shelf", "Mattress", "Cushion", "Lamp", "Decor" — or another short, sensible word if none of these fit).
- product_name: a short, specific description of the exact item shown (material/style if visible), e.g. "Wooden
  Dining Chair" or "3-Seater Fabric Sofa".
- unit: the most sensible stock-counting unit for this item type.
- confidence: 0 to 1, honest — lower if the photo is unclear, cropped, or ambiguous.
Never invent a brand, price, or exact dimensions. This is a suggestion a human will confirm or correct, not a
final record — a slightly-wrong guess is fine, a fabricated-precise one is not.`;

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function validateClassification(x: unknown): string | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return "not an object";
  const o = x as Record<string, unknown>;
  for (const k of CLASSIFICATION_SCHEMA.required) if (!(k in o)) return `missing key ${k}`;
  if (typeof o.category !== "string" || o.category.trim() === "") return "category not a non-empty string";
  if (typeof o.product_name !== "string" || o.product_name.trim() === "") return "product_name not a non-empty string";
  if (!["Nos", "Set", "Pair", "Box", "Roll", "Sqft", "Kg"].includes(o.unit as string)) return "bad unit";
  if (typeof o.confidence !== "number" || o.confidence < 0 || o.confidence > 1) return "bad confidence";
  return null;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return errorResponse(405, MSG.methodNotAllowed, origin);

  const token = extractBearerToken(req);
  if (!token) return errorResponse(401, MSG.unauthorized, origin);
  const user = await verifyCaller(token);
  if (!user) return errorResponse(401, MSG.unauthorized, origin);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, MSG.invalidJson, origin);
  }
  if (!isUuid(body?.product_id)) return errorResponse(400, MSG.missingFields, origin);
  const productId = body.product_id as string;

  // Visibility through RLS as the caller — an unauthorized user simply gets no row back.
  const userClient = userScopedClient(token);
  const { data: visible, error: visErr } = await userClient
    .from("retail_products")
    .select("id, created_by")
    .eq("id", productId)
    .maybeSingle();
  if (visErr) {
    console.error("retail-stock-ai-classify: visibility check failed:", visErr.message);
    return errorResponse(500, MSG.serverError, origin);
  }
  if (!visible) return errorResponse(403, MSG.unauthorized, origin);

  const admin = adminClient();
  const { data: profile } = await admin.from("user_profiles").select("is_active, must_change_password").eq("id", user.id).maybeSingle();
  if (!profile?.is_active) return errorResponse(403, MSG.accountInactive, origin);
  if (profile.must_change_password) return errorResponse(403, MSG.mustChangePassword, origin);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return okResponse({ ok: false, reason: "AI service is not configured yet" }, origin, 200);

  try {
    const { data: att, error: attErr } = await admin
      .from("staff_attachments")
      .select("storage_path, mime_type, file_size")
      .eq("entity_type", "retail_product")
      .eq("entity_id", productId)
      .eq("purpose", "proof")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (attErr) throw new Error(`attachment lookup: ${attErr.message}`);
    if (!att) return okResponse({ ok: false, reason: "No photo has been uploaded for this item yet" }, origin, 200);
    if ((att.file_size ?? 0) > MAX_FILE_BYTES) return okResponse({ ok: false, reason: "Photo is larger than 15 MB" }, origin, 200);

    const mime = (att.mime_type ?? "").toLowerCase();
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
      return okResponse({ ok: false, reason: "Unsupported image type for classification" }, origin, 200);
    }

    const { data: blob, error: dlErr } = await admin.storage.from(BUCKET).download(att.storage_path);
    if (dlErr || !blob) throw new Error(`download: ${dlErr?.message}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES) return okResponse({ ok: false, reason: "Photo is larger than 15 MB" }, origin, 200);

    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      output_config: { effort: "low", format: { type: "json_schema", schema: CLASSIFICATION_SCHEMA } },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime as "image/jpeg", data: toBase64(bytes) } },
          { type: "text", text: "Classify this Godown stock item." },
        ],
      }],
    });

    if (resp.stop_reason === "refusal") return okResponse({ ok: false, reason: "The AI declined to process this photo" }, origin, 200);
    const block = resp.content.find((b) => b.type === "text");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(block && block.type === "text" ? block.text : "");
    } catch {
      return okResponse({ ok: false, reason: "AI reply was not valid JSON" }, origin, 200);
    }
    const bad = validateClassification(parsed);
    if (bad !== null) return okResponse({ ok: false, reason: `AI reply failed validation: ${bad}` }, origin, 200);

    const c = parsed as { category: string; product_name: string; unit: string; confidence: number };
    const { error: storeErr } = await admin.rpc("retail_store_stock_classification", {
      p_product_id: productId, p_category: c.category, p_product_name: c.product_name, p_unit: c.unit, p_confidence: c.confidence,
    });
    if (storeErr) throw new Error(`store: ${storeErr.message}`);

    return okResponse({ ok: true, category: c.category, product_name: c.product_name, unit: c.unit, confidence: c.confidence }, origin, 200);
  } catch (e) {
    console.error("retail-stock-ai-classify failed:", e instanceof Error ? e.message : e);
    let reason = "AI classification failed";
    if (e instanceof Anthropic.RateLimitError) reason = "AI service is busy — please retry shortly";
    else if (e instanceof Anthropic.AuthenticationError) reason = "AI service credentials are invalid";
    else if (e instanceof Anthropic.APIError) reason = `AI service error (${e.status})`;
    return okResponse({ ok: false, reason }, origin, 200);
  }
});
