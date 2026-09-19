import { supabase, SUPABASE_URL_BASE, SUPABASE_ANON_KEY_VALUE } from "./supabase";

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
const EXTENSION_MIME_FALLBACK = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  heic: "image/heic", heif: "image/heif",
  dwg: "application/acad", dxf: "application/dxf",
};
export function resolveMimeType(file) {
  if (file.type && file.type !== "image/jpg" && file.type !== "application/octet-stream") return file.type;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  return EXTENSION_MIME_FALLBACK[ext] || file.type || "application/octet-stream";
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
    if (!token) throw new Error(AUTH_REQUIRED_ERROR);
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
    throw new Error(NETWORK_ERROR);
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
    if (msg?.en && msg?.gu) throw new Error(`${msg.en} / ${msg.gu}`);
    throw new Error(GENERIC_ERROR);
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

// Authenticated: uploads a proof file for a task/bridge.
// 1) mint a short-lived signed upload URL scoped to entityId, via staff-file-url
// 2) PUT the file straight to Storage using that signed URL
// 3) register the attachment via staff_record_attachment (RLS-gated RPC),
//    which re-verifies the object actually landed before recording it
export async function uploadTaskProof({ entityType, entityId, file, fileType, durationSeconds }) {
  const mimeType = resolveMimeType(file);
  const urlRes = await callFunction(
    "staff-file-url",
    {
      action: "upload",
      entity_type: entityType,
      entity_id: entityId,
      filename: file.name,
      mime_type: mimeType,
      file_type: fileType,
      file_size: file.size,
      ...(durationSeconds != null ? { duration_seconds: durationSeconds } : {}),
    },
    { auth: true },
  );

  const { error: uploadError } = await supabase.storage
    .from("staff-attachments")
    .uploadToSignedUrl(urlRes.storage_path, urlRes.token, file);
  if (uploadError) {
    throw new Error("Could not upload the file. Please try again. / ફાઇલ અપલોડ કરી શકાઈ નથી. કૃપા કરીને ફરી પ્રયાસ કરો.");
  }

  const { data: attachmentId, error: recordError } = await supabase.rpc("staff_record_attachment", {
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_file_type: fileType,
    p_storage_path: urlRes.storage_path,
    p_original_filename: file.name,
    p_mime_type: mimeType,
    p_file_size: file.size,
    ...(durationSeconds != null ? { p_duration_seconds: durationSeconds } : {}),
  });
  if (recordError) throw recordError;

  return { attachmentId, storagePath: urlRes.storage_path };
}

// Authenticated: mints a short-lived signed download URL for an existing attachment.
export function downloadTaskProof(attachmentId) {
  return callFunction("staff-file-url", { action: "download", attachment_id: attachmentId }, { auth: true });
}

// Authenticated: uploads an attachment/voice file for a task Reply, BEFORE
// the reply itself is created — mirrors uploadTaskProof's own
// mint-URL / PUT / verify-server-side shape, but stops short of recording
// any metadata row (there's no message to attach it to yet). The returned
// object is exactly the p_attachment_metadata shape
// staff_send_task_message expects; that RPC re-verifies the uploaded
// object exists before it's ever linked to a reply, so an upload that's
// never followed by a send just leaves an orphaned, never-referenced
// object under the uploader's own storage prefix.
export async function uploadTaskMessageFile({ taskId, file, fileType, durationSeconds }) {
  const mimeType = resolveMimeType(file);
  const urlRes = await callFunction(
    "staff-file-url",
    {
      action: "upload",
      entity_type: "task_message",
      entity_id: taskId,
      filename: file.name,
      mime_type: mimeType,
      file_type: fileType,
      file_size: file.size,
      ...(durationSeconds != null ? { duration_seconds: durationSeconds } : {}),
    },
    { auth: true },
  );

  const { error: uploadError } = await supabase.storage
    .from("staff-attachments")
    .uploadToSignedUrl(urlRes.storage_path, urlRes.token, file);
  if (uploadError) {
    throw new Error("Could not upload the file. Please try again. / ફાઇલ અપલોડ કરી શકાઈ નથી. કૃપા કરીને ફરી પ્રયાસ કરો.");
  }

  return {
    kind: fileType === "voice" ? "voice" : "attachment",
    storage_path: urlRes.storage_path,
    filename: file.name,
    file_type: fileType,
    file_size: file.size,
    ...(durationSeconds != null ? { duration_seconds: durationSeconds } : {}),
  };
}

// Authenticated: mints a short-lived signed download/playback URL for a
// Reply's own attachment or voice message (access gated by task_messages'
// own RLS via the Edge Function's user-scoped client — see
// handleDownloadMessage).
export function downloadTaskMessageFile(messageId) {
  return callFunction("staff-file-url", { action: "download", message_id: messageId }, { auth: true });
}
