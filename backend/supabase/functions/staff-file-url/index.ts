import { handlePreflight } from "../_shared/cors.ts";
import { errorResponse, okResponse } from "../_shared/response.ts";
import { MSG } from "../_shared/messages.ts";
import { adminClient, extractBearerToken, userScopedClient, verifyCaller } from "../_shared/clients.ts";
import {
  isPositiveInt,
  isUuid,
  isNonEmptyString,
  clampDownloadTtlSeconds,
  MAX_FILE_BYTES,
  MIME_WHITELIST,
} from "../_shared/validation.ts";
import { resolveDocument, voiceExtension } from "../_shared/fileTypes.ts";

const BUCKET = "staff-attachments";

// Retail fulfilment-pipeline entity types (v2_93i onward): each proof photo (packing, godown receiving, dispatch, delivery,
// installation) is a real staff_attachments row, RLS-checked against its own real parent table -- never a raw storage path or a
// client-side blob URL. Kept as an explicit whitelist (not a wildcard), same discipline as the original task/bridge pair.
const RETAIL_PIPELINE_PARENT_TABLES: Record<string, string> = {
  retail_packing: "retail_packing_records",
  retail_godown_handover: "retail_godown_handovers",
  retail_dispatch: "retail_dispatch_records",
  retail_delivery: "retail_deliveries",
  retail_installation: "retail_installations",
  // Product lifecycle entity types (v2_93o/93r): staff_attachments' own CHECK constraint and
  // staff_record_attachment()'s access-check branches were widened for these back when they were added, but this
  // function's OWN separate whitelist was never updated to match — every upload for a Godown stock-intake photo
  // (entity_type='retail_product'), a damage-report photo (entity_type='retail_inventory_item'), a manual
  // quotation attachment, or a Delivery Challan attachment was refused with 400 MSG.missingFields before the
  // signed-URL was ever created. This is the exact root cause of the reported "Take Photo" failure on
  // /godown/stock-intake. Fixed by keeping this list in step with the other two.
  retail_order_item: "retail_order_items",
  retail_product: "retail_products",
  retail_inventory_item: "retail_inventory_items",
  retail_quotation: "retail_quotations",
  retail_delivery_challan: "retail_delivery_challans",
};
const MAX_VOICE_BYTES = 5 * 1024 * 1024; // 60 s of Opus/AAC is well under 1 MB; 5 MB is a generous hard cap
const STALE_VOICE_MS = 24 * 60 * 60 * 1000;
const VOICE_DOWNLOAD_TTL_SECONDS = 600; // long enough to seek around a 60 s clip; the browser is handed a fresh URL when it expires

const DOWNLOAD_TTL_SECONDS = clampDownloadTtlSeconds(
  Number.parseInt(Deno.env.get("STAFF_SIGNED_URL_TTL_SECONDS") ?? "120", 10),
);

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse(405, MSG.methodNotAllowed, origin);
  }

  const token = extractBearerToken(req);
  if (!token) {
    return errorResponse(401, MSG.unauthorized, origin);
  }

  const verifiedUser = await verifyCaller(token);
  if (!verifiedUser) {
    return errorResponse(401, MSG.unauthorized, origin);
  }

  const admin = adminClient();

  const { data: profile, error: profileError } = await admin
    .from("user_profiles")
    .select("id, is_active, must_change_password")
    .eq("id", verifiedUser.id)
    .maybeSingle();

  if (profileError) {
    console.error("staff-file-url: profile lookup failed:", profileError.message);
    return errorResponse(500, MSG.serverError, origin);
  }
  if (!profile || !profile.is_active) {
    return errorResponse(403, MSG.accountInactive, origin);
  }
  if (profile.must_change_password) {
    return errorResponse(403, MSG.mustChangePassword, origin);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, MSG.invalidJson, origin);
  }
  if (typeof body !== "object" || body === null) {
    return errorResponse(400, MSG.invalidJson, origin);
  }
  const payload = body as Record<string, unknown>;

  if (payload.action === "upload") {
    return handleUpload(payload, verifiedUser.id, token, origin);
  }
  if (payload.action === "download") {
    return handleDownload(payload, token, origin);
  }
  if (payload.action === "cleanup") {
    return handleCleanup(payload, verifiedUser.id, token, origin);
  }
  return errorResponse(400, MSG.invalidAction, origin);
});

async function handleUpload(
  payload: Record<string, unknown>,
  verifiedUserId: string,
  token: string,
  origin: string | null,
): Promise<Response> {
  const { entity_type, entity_id, filename, mime_type, file_type, file_size, duration_seconds } = payload;

  // Replies are read-only (their history lives in Chat), so "task_message" staging uploads are no longer accepted.
  // "staging" is a VOICE recording made while a task is being assigned: it is stored first (before the task exists, so a task is never
  // created without the recording it was meant to carry) and is linked to the task afterwards by staff_record_attachment.
  const staging = entity_type === "staging";
  const retailParentTable = typeof entity_type === "string" ? RETAIL_PIPELINE_PARENT_TABLES[entity_type] : undefined;
  if (entity_type !== "task" && entity_type !== "bridge" && !staging && !retailParentTable) {
    return errorResponse(400, MSG.missingFields, origin);
  }
  if ((!staging && !isUuid(entity_id)) || !isNonEmptyString(filename, 200) || !isNonEmptyString(mime_type, 200)) {
    return errorResponse(400, MSG.missingFields, origin);
  }
  if (staging && file_type !== "voice") {
    return errorResponse(400, MSG.fileTypeNotAllowed, origin);
  }
  if (!isPositiveInt(file_size)) {
    return errorResponse(400, MSG.missingFields, origin);
  }
  if (typeof file_type !== "string") {
    return errorResponse(400, MSG.fileTypeNotAllowed, origin);
  }

  // The object's extension and Content-Type are decided HERE, never taken from the browser. The approved extension picks
  // the canonical type (a DWG reported as "" / application/octet-stream is signed as application/acad); anything not on the
  // list, executable, or inconsistent with its declared category is refused.
  let ext: string;
  let contentType: string;
  if (file_type === "voice") {
    if (!MIME_WHITELIST.voice(mime_type as string)) return errorResponse(400, MSG.fileTypeNotAllowed, origin);
    if (!isPositiveInt(duration_seconds) || (duration_seconds as number) > 60) {
      return errorResponse(400, MSG.voiceDurationInvalid, origin);
    }
    ext = voiceExtension(mime_type as string);
    contentType = (mime_type as string).split(";")[0].trim().toLowerCase();
  } else {
    const resolved = resolveDocument(filename as string, mime_type as string, file_type);
    if (!resolved) return errorResponse(400, MSG.fileTypeNotAllowed, origin);
    ext = resolved.ext;
    contentType = resolved.contentType;
  }
  if (file_size > MAX_FILE_BYTES || (file_type === "voice" && file_size > MAX_VOICE_BYTES)) {
    return errorResponse(400, MSG.fileTooLarge, origin);
  }

  const userClient = userScopedClient(token);
  if (!staging) {
    const parentTable = retailParentTable ?? (entity_type === "bridge" ? "bridges" : "staff_tasks");
    const { data: parentRow, error: parentError } = await userClient
      .from(parentTable)
      .select("id")
      .eq("id", entity_id)
      .maybeSingle();

    if (parentError) {
      console.error("staff-file-url: parent access check failed:", parentError.message);
      return errorResponse(500, MSG.serverError, origin);
    }
    if (!parentRow) {
      return errorResponse(403, MSG.noAccessToParent, origin);
    }
  }

  // Uploader prefix (ownership is re-checked by the RPCs) + a folder that says what it is + timestamp + random id + validated extension.
  const storagePath = file_type === "voice"
    ? `${verifiedUserId}/voice/${Date.now()}-${crypto.randomUUID()}.${ext}`
    : `${verifiedUserId}/${crypto.randomUUID()}.${ext}`;

  const admin = adminClient();
  const { data: signed, error: signError } = await admin.storage.from(BUCKET).createSignedUploadUrl(storagePath);

  if (signError || !signed) {
    console.error("staff-file-url: createSignedUploadUrl failed:", signError?.message);
    return errorResponse(500, MSG.serverError, origin);
  }

  if (staging) {
    // Best effort, never blocks the upload: recordings this user made but never attached to a task (tab closed, task creation failed)
    // are removed once they are a day old. Only their own voice/ folder, and only objects no attachment row references.
    try { await sweepStaleVoice(verifiedUserId, userClient, admin); } catch (e) { console.error("staff-file-url: voice sweep failed:", (e as Error)?.message); }
  }

  return okResponse(
    {
      action: "upload",
      storage_path: storagePath,
      signed_url: signed.signedUrl,
      token: signed.token,
      content_type: contentType,
      max_bytes: MAX_FILE_BYTES,
    },
    origin,
  );
}

async function sweepStaleVoice(userId: string, userClient: ReturnType<typeof userScopedClient>, admin: ReturnType<typeof adminClient>) {
  const { data: objs } = await admin.storage.from(BUCKET).list(`${userId}/voice`, { limit: 100, sortBy: { column: "created_at", order: "asc" } });
  const old = (objs ?? []).filter((o) => o.created_at && Date.now() - new Date(o.created_at).getTime() > STALE_VOICE_MS).map((o) => `${userId}/voice/${o.name}`);
  if (old.length === 0) return;
  const { data: linked, error } = await userClient.from("staff_attachments").select("storage_path").in("storage_path", old);
  if (error) return; // fail SAFE: unknown => delete nothing
  const keep = new Set((linked ?? []).map((r: { storage_path: string }) => r.storage_path));
  const drop = old.filter((p) => !keep.has(p));
  if (drop.length > 0) await admin.storage.from(BUCKET).remove(drop);
}

// Removes an object that was uploaded but never linked (metadata insert failed). Only the uploader's own prefix, and only
// when no attachment / message row references the path -- a linked file can never be removed through here.
async function handleCleanup(
  payload: Record<string, unknown>,
  verifiedUserId: string,
  token: string,
  origin: string | null,
): Promise<Response> {
  const { storage_path } = payload;
  if (typeof storage_path !== "string" || !storage_path.startsWith(`${verifiedUserId}/`) || storage_path.includes("..")) {
    return errorResponse(400, MSG.missingFields, origin);
  }
  // service_role has no SELECT on these tables (grants are deliberately narrow), so the "is it linked?" lookup runs as the CALLER:
  // a file they uploaded and linked is visible to them under RLS. Fail SAFE: any lookup error or any hit means nothing is deleted.
  const userClient = userScopedClient(token);
  const admin = adminClient();
  const refs = await Promise.all([
    userClient.from("staff_attachments").select("id").eq("storage_path", storage_path).limit(1),
    userClient.from("task_messages").select("id").eq("attachment_path", storage_path).limit(1),
    userClient.from("task_messages").select("id").eq("voice_path", storage_path).limit(1),
    userClient.from("chat_message_attachments").select("id").eq("storage_path", storage_path).limit(1),
  ]);
  if (refs.some((r) => r.error)) {
    console.error("staff-file-url: cleanup reference check failed:", refs.map((r) => r.error?.message).filter(Boolean).join("; "));
    return errorResponse(500, MSG.serverError, origin);
  }
  if (refs.some((r) => (r.data?.length ?? 0) > 0)) {
    return okResponse({ action: "cleanup", removed: false, reason: "linked" }, origin);
  }
  const { error } = await admin.storage.from(BUCKET).remove([storage_path]);
  if (error) {
    console.error("staff-file-url: cleanup failed:", error.message);
    return errorResponse(500, MSG.serverError, origin);
  }
  return okResponse({ action: "cleanup", removed: true }, origin);
}

async function handleDownload(
  payload: Record<string, unknown>,
  token: string,
  origin: string | null,
): Promise<Response> {
  const { attachment_id, message_id, chat_attachment_id, inline } = payload;

  if (isUuid(chat_attachment_id)) {
    return handleDownloadChatAttachment(chat_attachment_id, token, origin);
  }

  if (isUuid(message_id)) {
    return handleDownloadMessage(message_id, token, origin);
  }

  if (!isUuid(attachment_id)) {
    return errorResponse(400, MSG.missingFields, origin);
  }

  const userClient = userScopedClient(token);
  const { data: attachment, error: attachmentError } = await userClient
    .from("staff_attachments")
    .select("id, storage_path, original_filename, mime_type, file_type")
    .eq("id", attachment_id)
    .maybeSingle();

  if (attachmentError) {
    console.error("staff-file-url: attachment lookup failed:", attachmentError.message);
    return errorResponse(500, MSG.serverError, origin);
  }
  if (!attachment) {
    return errorResponse(404, MSG.attachmentNotFound, origin);
  }

  const admin = adminClient();
  // inline=true is for PLAYBACK (an <audio> element): no forced-download header, and a longer-lived link for voice so seeking keeps working.
  const wantInline = inline === true;
  const ttl = wantInline && attachment.file_type === "voice" ? VOICE_DOWNLOAD_TTL_SECONDS : DOWNLOAD_TTL_SECONDS;
  const { data: signed, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(attachment.storage_path, ttl, wantInline ? undefined : { download: attachment.original_filename });

  if (signError || !signed) {
    console.error("staff-file-url: createSignedUrl failed:", signError?.message);
    return errorResponse(500, MSG.serverError, origin);
  }

  return okResponse(
    {
      action: "download",
      signed_url: signed.signedUrl,
      expires_in_seconds: ttl,
      original_filename: attachment.original_filename,
      mime_type: attachment.mime_type,
    },
    origin,
  );
}

// Downloads a task_messages reply's attachment or voice file. Access is gated by task_messages' own RLS policy
// (task_messages_select_scoped -> staff_task_visible) via the userScopedClient select below.
async function handleDownloadMessage(
  messageId: string,
  token: string,
  origin: string | null,
): Promise<Response> {
  const userClient = userScopedClient(token);
  const { data: message, error: messageError } = await userClient
    .from("task_messages")
    .select("id, attachment_path, attachment_name, attachment_type, voice_path, is_deleted")
    .eq("id", messageId)
    .maybeSingle();

  if (messageError) {
    console.error("staff-file-url: task_message lookup failed:", messageError.message);
    return errorResponse(500, MSG.serverError, origin);
  }
  if (!message || message.is_deleted) {
    return errorResponse(404, MSG.attachmentNotFound, origin);
  }

  const path = message.voice_path ?? message.attachment_path;
  if (!path) {
    return errorResponse(404, MSG.attachmentNotFound, origin);
  }

  const admin = adminClient();
  const { data: signed, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, DOWNLOAD_TTL_SECONDS);

  if (signError || !signed) {
    console.error("staff-file-url: createSignedUrl (message) failed:", signError?.message);
    return errorResponse(500, MSG.serverError, origin);
  }

  return okResponse(
    {
      action: "download",
      signed_url: signed.signedUrl,
      expires_in_seconds: DOWNLOAD_TTL_SECONDS,
      original_filename: message.attachment_name ?? "voice-message",
      mime_type: message.attachment_type ?? null,
      is_voice: !!message.voice_path,
    },
    origin,
  );
}

// A Chat attachment whose object still sits in its ORIGINAL private bucket (a migrated legacy Reply file). The caller must be an
// active participant of the conversation: chat_message_attachments' own RLS decides that through the caller-scoped client. The
// bucket comes from that row (constrained by a CHECK) and is re-checked against an allow-list here; nothing from the request picks it.
const CHAT_ATTACHMENT_BUCKETS = new Set(["staff-attachments", "chat-attachments"]);

async function handleDownloadChatAttachment(
  attachmentId: string,
  token: string,
  origin: string | null,
): Promise<Response> {
  const userClient = userScopedClient(token);
  const { data: att, error: attError } = await userClient
    .from("chat_message_attachments")
    .select("id, storage_path, file_name, mime_type, bucket")
    .eq("id", attachmentId)
    .maybeSingle();

  if (attError) {
    console.error("staff-file-url: chat attachment lookup failed:", attError.message);
    return errorResponse(500, MSG.serverError, origin);
  }
  if (!att || !CHAT_ATTACHMENT_BUCKETS.has(att.bucket)) {
    return errorResponse(404, MSG.attachmentNotFound, origin);
  }

  const admin = adminClient();
  const { data: signed, error: signError } = await admin.storage
    .from(att.bucket)
    .createSignedUrl(att.storage_path, DOWNLOAD_TTL_SECONDS, { download: att.file_name });

  if (signError || !signed) {
    console.error("staff-file-url: createSignedUrl (chat attachment) failed:", signError?.message);
    return errorResponse(500, MSG.serverError, origin);
  }

  return okResponse(
    {
      action: "download",
      signed_url: signed.signedUrl,
      expires_in_seconds: DOWNLOAD_TTL_SECONDS,
      original_filename: att.file_name,
      mime_type: att.mime_type,
    },
    origin,
  );
}
