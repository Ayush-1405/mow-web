// Mood of Wood — MVP Pilot Edge Functions — shared input validation helpers.

export function normalizeEmployeeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const v = input.trim().toUpperCase();
  return v.length > 0 && v.length <= 40 ? v : null;
}

export function isNonEmptyString(v: unknown, maxLen = 500): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= maxLen;
}

export function isOptionalString(v: unknown, maxLen = 500): v is string | undefined {
  return v === undefined || v === null || isNonEmptyString(v, maxLen);
}

/** Minimum 8 characters, at least one uppercase, one lowercase, one digit. */
export function isValidPassword(pw: unknown): pw is string {
  if (typeof pw !== "string") return false;
  if (pw.length < 8 || pw.length > 200) return false;
  if (!/[A-Z]/.test(pw)) return false;
  if (!/[a-z]/.test(pw)) return false;
  if (!/[0-9]/.test(pw)) return false;
  return true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

// v2.1b: strict employee_code shape, checked BEFORE the code is used in any
// ilike query or interpolated into the internal Auth email. Blocks
// SQL-wildcard-injection-via-ilike (%, _) and anything that would produce a
// surprising internal email local-part.
const EMPLOYEE_CODE_RE = /^MOW-[A-Z0-9-]{1,32}$/;

export function isValidEmployeeCode(v: unknown): v is string {
  return typeof v === "string" && EMPLOYEE_CODE_RE.test(v);
}

export function isUuidArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => isUuid(x));
}

export function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/** Strips anything but letters, digits, dot, underscore, hyphen; caps length. */
export function sanitizeFilename(name: string): string {
  const trimmed = name.trim().slice(0, 180);
  const cleaned = trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "file";
}

function baseMimeType(m: string): string {
  return m.split(";")[0].trim().toLowerCase();
}

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

// v2.1b: the previous `image` rule was `m.startsWith("image/")`, which
// permitted image/svg+xml — an SVG can carry an embedded <script>, so it is
// an executable-capable format wearing an image MIME type. This list is now
// an EXACT enumeration, mirrored line-for-line in:
//   - the storage.buckets.allowed_mime_types array (mvp_pilot_storage_patch_v2_1b.sql, part 1)
//   - the staff_record_attachment() mime_type check (mvp_pilot_storage_patch_v2_1b.sql, part 3)
// All three must be changed together if this list ever changes.
export const MIME_WHITELIST: Record<string, (mime: string) => boolean> = {
  image: (m) => ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(m),
  pdf: (m) => m === "application/pdf",
  word: (m) =>
    ["application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(m),
  excel: (m) =>
    ["application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(m),
  drawing: (m) =>
    [
      "application/dxf",
      "application/dwg",
      "image/vnd.dwg",
      "image/vnd.dxf",
      "application/x-dwg",
      "application/x-dxf",
      "application/acad",
    ].includes(m),
  voice: (m) =>
    ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-m4a", "audio/aac"].includes(
      baseMimeType(m),
    ),
};

/** Flat list form of MIME_WHITELIST, for building the storage bucket's allowed_mime_types array consistently. */
export const ALL_APPROVED_MIME_TYPES: string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/dxf",
  "application/dwg",
  "image/vnd.dwg",
  "image/vnd.dxf",
  "application/x-dwg",
  "application/x-dxf",
  "application/acad",
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-m4a",
  "audio/aac",
];

/** Clamps STAFF_SIGNED_URL_TTL_SECONDS (or its default) into [30, 900] seconds. */
export function clampDownloadTtlSeconds(raw: number): number {
  const MIN_TTL = 30;
  const MAX_TTL = 900;
  if (!Number.isFinite(raw)) return 120;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, Math.trunc(raw)));
}
