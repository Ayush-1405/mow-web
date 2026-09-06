import { handlePreflight } from "../_shared/cors.ts";
import { errorResponse, okResponse } from "../_shared/response.ts";
import { MSG } from "../_shared/messages.ts";
import { adminClient, extractBearerToken, userScopedClient, verifyCaller } from "../_shared/clients.ts";
import {
  isPositiveInt,
  isUuid,
  isNonEmptyString,
  sanitizeFilename,
  clampDownloadTtlSeconds,
  MAX_FILE_BYTES,
  MIME_WHITELIST,
} from "../_shared/validation.ts";

const BUCKET = "staff-attachments";

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
  return errorResponse(400, MSG.invalidAction, origin);
});

async function handleUpload(
  payload: Record<string, unknown>,
  verifiedUserId: string,
  token: string,
  origin: string | null,
): Promise<Response> {
  const { entity_type, entity_id, filename, mime_type, file_type, file_size, duration_seconds } = payload;

  if (entity_type !== "task" && entity_type !== "bridge") {
    return errorResponse(400, MSG.missingFields, origin);
  }
  if (!isUuid(entity_id) || !isNonEmptyString(filename, 200) || !isNonEmptyString(mime_type, 200)) {
    return errorResponse(400, MSG.missingFields, origin);
  }
  if (!isPositiveInt(file_size)) {
    return errorResponse(400, MSG.missingFields, origin);
  }

  if (typeof file_type !== "string" || !(file_type in MIME_WHITELIST)) {
    return errorResponse(400, MSG.fileTypeNotAllowed, origin);
  }
  if (!MIME_WHITELIST[file_type](mime_type as string)) {
    return errorResponse(400, MSG.fileTypeNotAllowed, origin);
  }
  if (file_type === "voice" && (!isPositiveInt(duration_seconds) || (duration_seconds as number) > 60)) {
    return errorResponse(400, MSG.voiceDurationInvalid, origin);
  }
  if (file_size > MAX_FILE_BYTES) {
    return errorResponse(400, MSG.fileTooLarge, origin);
  }

  const userClient = userScopedClient(token);
  const parentTable = entity_type === "task" ? "staff_tasks" : "bridges";
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

  const sanitized = sanitizeFilename(filename as string);
  const storagePath = `${verifiedUserId}/${crypto.randomUUID()}-${sanitized}`;

  const admin = adminClient();
  const { data: signed, error: signError } = await admin.storage.from(BUCKET).createSignedUploadUrl(storagePath);

  if (signError || !signed) {
    console.error("staff-file-url: createSignedUploadUrl failed:", signError?.message);
    return errorResponse(500, MSG.serverError, origin);
  }

  return okResponse(
    {
      action: "upload",
      storage_path: storagePath,
      signed_url: signed.signedUrl,
      token: signed.token,
    },
    origin,
  );
}

async function handleDownload(
  payload: Record<string, unknown>,
  token: string,
  origin: string | null,
): Promise<Response> {
  const { attachment_id } = payload;
  if (!isUuid(attachment_id)) {
    return errorResponse(400, MSG.missingFields, origin);
  }

  const userClient = userScopedClient(token);
  const { data: attachment, error: attachmentError } = await userClient
    .from("staff_attachments")
    .select("id, storage_path, original_filename, mime_type")
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
  const { data: signed, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(attachment.storage_path, DOWNLOAD_TTL_SECONDS);

  if (signError || !signed) {
    console.error("staff-file-url: createSignedUrl failed:", signError?.message);
    return errorResponse(500, MSG.serverError, origin);
  }

  return okResponse(
    {
      action: "download",
      signed_url: signed.signedUrl,
      expires_in_seconds: DOWNLOAD_TTL_SECONDS,
      original_filename: attachment.original_filename,
      mime_type: attachment.mime_type,
    },
    origin,
  );
}
