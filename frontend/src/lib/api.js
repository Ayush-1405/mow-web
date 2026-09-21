import { supabase, SUPABASE_URL_BASE, SUPABASE_ANON_KEY_VALUE } from "./supabase";
import { FILE_RULES, UploadError, extensionOf, logUploadFailure, typedFile, validateUploadFile } from "./fileTypes";
import { extensionForMime, validateRecording } from "./voiceRecording";

// Mood of Wood — Staff Pilot — thin client for the four staff-* Edge
// Functions (staff-login, staff-create-user, staff-password-change,
// staff-file-url). Every authenticated call attaches the CURRENT session's
// access_token — never a client-remembered id — so the server-side
// verifyCaller()/auth.getUser() check on the other end is always the real
// authorization boundary, exactly as those functions expect.

const FUNCTIONS_URL = `${SUPABASE_URL_BASE}/functions/v1`;

// Some Android camera intents hand back a File with an empty type (common
// when a photo comes straight from "Take Photo" rather than the gallery
// picker) or the nonstandard "image/jpg" — either would fail the Edge
// Function's exact MIME whitelist (image/jpeg, not image/jpg) even though
// the file itself is a perfectly normal photo. Fall back to the file
// extension only when the browser's own reported type is missing/wrong;
// a genuinely unsupported file still fails server-side exactly as before.
// CAD files (.dwg/.dxf) almost always report an empty file.type on Windows
// — there is no registered browser MIME type for them — so without this
// fallback every DWG/DXF attachment was detected as "unsupported" and
// rejected before the upload ever reached the server, even though the
// server (storage bucket allowed_mime_types, staff-file-url's
// MIME_WHITELIST, and staff_record_attachment()) already fully supports a
// 'drawing' file_type for exactly these MIME types.
// The canonical MIME for a file: the approved extension decides (DWG/DXF are usually reported as "" or octet-stream by
// browsers). Unknown extensions keep whatever the browser reported and are refused by validateUploadFile / the server.
export function resolveMimeType(file) {
  const rule = FILE_RULES[extensionOf(file.name)];
  if (rule) return rule.mime;
  return file.type || "application/octet-stream";
}

const GENERIC_ERROR = "Something went wrong. Please try again later. / કંઈક ખોટું થયું. કૃપા કરીને પછીથી ફરી પ્રયાસ કરો.";
const NETWORK_ERROR = "Network error. Please try again. / નેટવર્ક ભૂલ. કૃપા કરીને ફરી પ્રયાસ કરો.";
const AUTH_REQUIRED_ERROR = "You are not signed in, or your session has expired. / તમે સાઇન ઇન નથી, અથવા તમારું સત્ર સમાપ્ત થયું છે.";

async function callFunction(name, body, { auth = false } = {}) {
  const headers = {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY_VALUE,
  };

  if (auth) {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw Object.assign(new Error(AUTH_REQUIRED_ERROR), { code: "SESSION", status: 401 });
    headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(`${FUNCTIONS_URL}/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw Object.assign(new Error(NETWORK_ERROR), { code: "NETWORK" });
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // Non-JSON body (rare — e.g. an upstream 502). Fall through to the
    // generic bilingual error below rather than surfacing raw text.
  }

  if (!res.ok) {
    const msg = payload?.error;
    if (msg?.en && msg?.gu) throw Object.assign(new Error(`${msg.en} / ${msg.gu}`), { status: res.status });
    throw Object.assign(new Error(GENERIC_ERROR), { status: res.status });
  }

  return payload;
}

// Public: employee code + password -> { access_token, refresh_token, expires_in, must_change_password }.
export function staffLogin(employeeCode, password) {
  return callFunction("staff-login", { employee_code: employeeCode, password });
}

// Authenticated: creates a new staff user. Server enforces every
// role/department authorization; this just forwards the form fields.
export function staffCreateUser(payload) {
  return callFunction("staff-create-user", payload, { auth: true });
}

// Authenticated: changes the CURRENT user's own password (the only user id
// this can ever affect — the endpoint reads it from the verified token).
export function staffPasswordChange(newPassword) {
  return callFunction("staff-password-change", { new_password: newPassword }, { auth: true });
}

// Authenticated: Management/Sysadmin/Dept Head resets ANOTHER staff
// member's password (e.g. they forgot it). Server enforces who may reset
// whose password — see staff_authorize_password_reset(). Forces the
// target to change this temporary password on next login.
export function staffResetPassword(userId, newPassword) {
  return callFunction("staff-reset-password", { user_id: userId, new_password: newPassword }, { auth: true });
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared upload pipeline for task / bridge / reply files.
//   validate -> mint a signed upload URL (server picks path + canonical Content-Type) -> PUT the File re-typed to that
//   type -> verify the PUT -> record metadata -> (caller) complete the task. Nothing later runs if an earlier step fails.
// ---------------------------------------------------------------------------------------------------------------------
const BUCKET = "staff-attachments";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mapStorageError(err) {
  const status = Number(err?.status ?? err?.statusCode);
  const text = `${err?.message || ""} ${err?.error || ""}`.toLowerCase();
  if (/mime|invalid_mime_type|415/.test(text) || status === 415) return "MIME_REJECTED";
  if (/expired|invalid (jwt|token)|signature/.test(text) || status === 401) return "LINK_EXPIRED";
  if (/size|too large|413|exceeded/.test(text) || status === 413) return "TOO_LARGE";
  if (status === 403) return "DENIED";
  if (status >= 500 || /unavailable|timeout/.test(text)) return "STORAGE_DOWN";
  if (/fetch|network|failed to fetch/.test(text) || err?.name === "StorageUnknownError") return "NETWORK";
  return "STORAGE_DOWN";
}

function mapFunctionError(err) {
  if (err instanceof UploadError) return err;
  if (err?.code === "NETWORK") return new UploadError("NETWORK");
  if (err?.code === "SESSION" || err?.status === 401) return new UploadError("SESSION");
  if (err?.status === 403) return new UploadError("DENIED");
  if (err?.status === 400) return new UploadError("UNSUPPORTED", err.message);
  return new UploadError("STORAGE_DOWN");
}

// One signed-URL request + one PUT. Retried ONCE, automatically, only for a transient network failure or an expired link
// (a new link is minted -- an expired token is never reused). Everything else surfaces immediately for the user to act on.
async function putWithSignedUrl(request, file, ctx) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let target;
    try {
      target = await callFunction("staff-file-url", request, { auth: true });
    } catch (err) {
      const mapped = mapFunctionError(err);
      logUploadFailure("sign", err, { ...ctx, bucket: BUCKET });
      if (mapped.code === "NETWORK" && attempt === 0) { await sleep(800); lastErr = mapped; continue; }
      throw mapped;
    }
    const contentType = target.content_type || ctx.mime;
    const body = typedFile(file, contentType, ctx.fileName); // the SDK sends file.type as the multipart Content-Type
    const { error } = await supabase.storage.from(BUCKET).uploadToSignedUrl(target.storage_path, target.token, body, { upsert: false, contentType });
    if (!error) return { storagePath: target.storage_path, contentType };
    const code = mapStorageError(error);
    logUploadFailure("put", error, { ...ctx, bucket: BUCKET, path: target.storage_path, mime: contentType });
    lastErr = new UploadError(code);
    if ((code === "NETWORK" || code === "LINK_EXPIRED") && attempt === 0) { await sleep(800); continue; }
    throw lastErr;
  }
  throw lastErr || new UploadError("STORAGE_DOWN");
}

async function removeOrphan(storagePath) {
  try { await callFunction("staff-file-url", { action: "cleanup", storage_path: storagePath }, { auth: true }); } catch { /* best effort */ }
}

// A File that has already been uploaded for an entity is never uploaded again (retry after a later step failed, double-click,
// re-render): the same result is returned. A failed upload is forgotten so the user's Retry really retries.
const doneUploads = new WeakMap();

// Authenticated: uploads a proof file for a task/bridge and records its metadata. Resolves only when BOTH the stored object and
// the attachment row exist. Throws UploadError (message = human-readable) otherwise; nothing is left half-recorded.
export function uploadTaskProof({ entityType, entityId, file, fileType, durationSeconds, purpose }) {
  const hit = doneUploads.get(file);
  if (hit && hit.entityId === entityId) return hit.promise;
  const promise = doTaskProofUpload({ entityType, entityId, file, fileType, durationSeconds, purpose });
  doneUploads.set(file, { entityId, promise });
  promise.catch(() => { if (doneUploads.get(file)?.promise === promise) doneUploads.delete(file); });
  return promise;
}

async function doTaskProofUpload({ entityType, entityId, file, fileType, durationSeconds, purpose }) {
  let category = fileType;
  let mimeType;
  let ext = extensionOf(file.name || "");
  let fileName = file.name || "file";
  if (fileType === "voice") {
    mimeType = file.type || "audio/webm";
    if (file.size === 0) throw new UploadError("EMPTY");
  } else {
    const meta = await validateUploadFile(file, fileType === "image" ? "image" : "task");
    if (fileType === "image" && meta.category !== "image") throw new UploadError("WRONG_KIND");
    category = meta.category;
    mimeType = meta.mime;
    ext = meta.ext;
    fileName = meta.filename;
  }
  const ctx = { ext, size: file.size, mime: mimeType, fileName };

  const { storagePath, contentType } = await putWithSignedUrl(
    {
      action: "upload", entity_type: entityType, entity_id: entityId, filename: fileName, mime_type: mimeType, file_type: category, file_size: file.size,
      ...(durationSeconds != null ? { duration_seconds: durationSeconds } : {}),
    },
    file, ctx,
  );

  const record = () => supabase.rpc("staff_record_attachment", {
    p_entity_type: entityType, p_entity_id: entityId, p_file_type: category, p_storage_path: storagePath,
    p_original_filename: fileName, p_mime_type: contentType, p_file_size: file.size,
    ...(durationSeconds != null ? { p_duration_seconds: durationSeconds } : {}),
    ...(purpose ? { p_purpose: purpose } : {}),
  });
  let { data: attachmentId, error: recordError } = await record();
  if (recordError && /fetch|network|timeout|5\d\d/i.test(recordError.message || "")) { await sleep(800); ({ data: attachmentId, error: recordError } = await record()); }
  if (recordError || !attachmentId) {
    logUploadFailure("record", recordError, { ...ctx, path: storagePath, bucket: BUCKET });
    await removeOrphan(storagePath); // no silent orphan: the object is removed because nothing links to it
    if (recordError && /access to attach|not authorized|permission/i.test(recordError.message || "")) throw new UploadError("DENIED");
    throw new UploadError("NOT_LINKED");
  }
  return { attachmentId, storagePath, fileName, category, size: file.size };
}

// Authenticated: mints a short-lived signed download URL for an existing attachment.
export function downloadTaskProof(attachmentId) {
  return callFunction("staff-file-url", { action: "download", attachment_id: attachmentId }, { auth: true });
}

// Authenticated: mints a short-lived signed download URL for a Chat attachment that still lives in the staff-attachments bucket
// (a migrated legacy Reply file). Access is decided by chat_message_attachments' own RLS (active participant of that conversation).
export function downloadChatAttachment(attachmentId) {
  return callFunction("staff-file-url", { action: "download", chat_attachment_id: attachmentId }, { auth: true });
}


// ---------------------------------------------------------------------------------------------------------------------
// Voice instruction pipeline (Assign Task):  stage (upload)  ->  create the task  ->  attach (link).
//
// The recording is uploaded BEFORE the task is created, so a task is never created without the recording it was meant to carry, and a
// failed upload never leaves a half-made task behind. The stored object is only linked to the task by attachVoiceInstruction (one RPC that
// re-checks access, the mime type and the size). Nothing here ever stores a blob: URL or base64.
// ---------------------------------------------------------------------------------------------------------------------

const VOICE_ERR = { EMPTY: "VOICE_EMPTY", TOO_SHORT: "VOICE_TOO_SHORT", TOO_LONG: "VOICE_TOO_LONG", TOO_LARGE: "VOICE_TOO_LARGE", UNSUPPORTED_TYPE: "VOICE_UNSUPPORTED" };

// Technical details for debugging (never secrets, never the audio itself).
export function logVoiceFailure(stage, err, extra = {}) {
  console.error("[voice]", stage, { code: err?.code, status: err?.status ?? err?.statusCode, message: err?.message, ...extra });
}

// Uploads a recorded File to the private bucket. Resolves { storagePath, contentType, size, fileName, durationSeconds } -- nothing is linked yet.
export async function stageVoiceRecording({ file, durationSeconds }) {
  const seconds = Math.round(durationSeconds || 0);
  const bad = validateRecording({ size: file?.size, seconds, mime: file?.type });
  if (bad) throw new UploadError(VOICE_ERR[bad]);
  const ctx = { ext: extensionForMime(file.type), size: file.size, mime: file.type, fileName: file.name };
  try {
    const { storagePath, contentType } = await putWithSignedUrl(
      { action: "upload", entity_type: "staging", filename: file.name, mime_type: file.type, file_type: "voice", file_size: file.size, duration_seconds: seconds },
      file, ctx,
    );
    return { storagePath, contentType, size: file.size, fileName: file.name, durationSeconds: seconds };
  } catch (err) {
    logVoiceFailure("upload", err, { mime: file.type, size: file.size });
    throw err;
  }
}

// Links a staged recording to a task as its voice INSTRUCTION. Retried once for a transient failure. The stored object is KEPT on failure
// so the caller can simply retry (nothing is deleted here).
export async function attachVoiceInstruction({ taskId, staged }) {
  const call = () => supabase.rpc("staff_record_attachment", {
    p_entity_type: "task", p_entity_id: taskId, p_file_type: "voice", p_storage_path: staged.storagePath, p_original_filename: staged.fileName,
    p_mime_type: staged.contentType, p_file_size: staged.size, p_duration_seconds: staged.durationSeconds, p_purpose: "instruction",
  });
  let { data, error } = await call();
  if (error && /fetch|network|timeout|5\d\d/i.test(error.message || "")) { await sleep(800); ({ data, error } = await call()); }
  if (error || !data) {
    logVoiceFailure("link", error, { taskId });
    if (error && /access to attach|not authorized|permission|only the person/i.test(error.message || "")) throw new UploadError("DENIED");
    throw new UploadError("VOICE_NOT_LINKED", error?.message);
  }
  return { attachmentId: data };
}

// Removes a staged recording that was never linked (task creation failed and the user gave up, or re-recorded). Best effort.
export function discardStagedVoice(storagePath) {
  return storagePath ? removeOrphan(storagePath) : Promise.resolve();
}

// Archives an attachment (the storage object is retained). Used by "Remove" / "Re-record" on a voice instruction.
export function removeTaskAttachment(attachmentId, reason) {
  return supabase.rpc("staff_remove_attachment", { p_attachment_id: attachmentId, p_reason: reason || null });
}

// One round trip for a whole list of tasks: the voice instructions the caller may see (with the recorder's name).
export async function fetchVoiceInstructions(taskIds) {
  const ids = [...new Set((taskIds || []).filter(Boolean))];
  if (ids.length === 0) return { data: [], error: null };
  return supabase.rpc("staff_task_voice_instructions", { p_task_ids: ids });
}

// Playback URL for <audio>: a private signed URL, minted on demand and cached until shortly before it expires (so re-renders and re-opens do
// not mint a new one every time), refreshed with { force: true } after the browser reports a load error. Never persisted anywhere.
const voiceUrlCache = new Map();
const voiceUrlInflight = new Map();
export async function getVoicePlaybackUrl(attachmentId, { force = false } = {}) {
  const hit = voiceUrlCache.get(attachmentId);
  if (!force && hit && hit.expiresAt > Date.now()) return hit.url;
  if (voiceUrlInflight.has(attachmentId)) return voiceUrlInflight.get(attachmentId);
  const p = callFunction("staff-file-url", { action: "download", attachment_id: attachmentId, inline: true }, { auth: true })
    .then((res) => {
      voiceUrlCache.set(attachmentId, { url: res.signed_url, expiresAt: Date.now() + Math.max(15, (res.expires_in_seconds || 120) - 30) * 1000 });
      return res.signed_url;
    })
    .finally(() => voiceUrlInflight.delete(attachmentId));
  voiceUrlInflight.set(attachmentId, p);
  return p;
}
// signed links belong to the person who requested them
supabase.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") voiceUrlCache.clear(); });
