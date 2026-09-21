// ONE list of what may be uploaded, shared by task completion, task attachments, Factory tasks and Chat.
// The server keeps the matching list in supabase/functions/_shared/fileTypes.ts (staff-file-url) and in the
// storage bucket's allowed_mime_types -- change all three together.
//
// Why this exists: for a File/Blob the Supabase SDK sends the browser's own file.type as the multipart part's
// Content-Type and ignores the contentType option. Browsers report .dwg / .dxf inconsistently (often "" which
// travels as application/octet-stream), and the bucket rightly refuses octet-stream -> HTTP 400 "invalid_mime_type".
// So the upload must present a File whose type is the approved canonical type for its (validated) extension.

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// ext -> { category (= staff_attachments.file_type), mime (canonical, always in the bucket list), label, sniff?, modules }
export const FILE_RULES = {
  dwg: { category: "drawing", mime: "application/acad", label: "AutoCAD drawing", sniff: "dwg" },
  dxf: { category: "drawing", mime: "application/dxf", label: "AutoCAD DXF", sniff: "dxf" },
  pdf: { category: "pdf", mime: "application/pdf", label: "PDF" },
  doc: { category: "word", mime: "application/msword", label: "Word" },
  docx: { category: "word", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word" },
  txt: { category: "word", mime: "text/plain", label: "Text", taskOnly: true },
  xls: { category: "excel", mime: "application/vnd.ms-excel", label: "Excel" },
  xlsx: { category: "excel", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "Excel" },
  csv: { category: "excel", mime: "text/csv", label: "CSV" },
  jpg: { category: "image", mime: "image/jpeg", label: "Image" },
  jpeg: { category: "image", mime: "image/jpeg", label: "Image" },
  png: { category: "image", mime: "image/png", label: "Image" },
  webp: { category: "image", mime: "image/webp", label: "Image" },
  heic: { category: "image", mime: "image/heic", label: "Image" },
  heif: { category: "image", mime: "image/heif", label: "Image" },
};

// Archives are deliberately NOT accepted (they can carry executables), and anything executable / scriptable is refused by name.
export const BLOCKED_EXTENSIONS = new Set([
  "exe", "bat", "cmd", "com", "scr", "msi", "dll", "js", "mjs", "vbs", "ps1", "sh", "jar", "apk", "app", "html", "htm", "svg", "php", "zip", "rar", "7z",
]);

// Browser-reported MIME types we refuse outright, whatever the extension says.
const HOSTILE_MIME = new Set(["application/x-msdownload", "application/x-dosexec", "application/x-msdos-program", "application/x-sh", "application/x-shellscript", "application/javascript", "text/javascript", "text/html", "image/svg+xml", "application/x-msi"]);

export const MODULE_CATEGORIES = {
  task: ["image", "pdf", "word", "excel", "drawing"],
  document: ["pdf", "word", "excel", "drawing"], // "document" proof: a photo does not count
  image: ["image"],
  chat: ["image", "pdf", "word", "excel", "drawing"],
};

// Camera / gallery pickers sometimes hand back a photo with no (or a odd) extension but a real image MIME type.
const IMAGE_MIME_EXT = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" };

export function extensionOf(name) {
  const m = /\.([A-Za-z0-9]{1,6})$/.exec((name || "").trim());
  return m ? m[1].toLowerCase() : "";
}

export function humanSize(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const ACCEPT_ATTR = (module = "task") => {
  const cats = MODULE_CATEGORIES[module] || MODULE_CATEGORIES.task;
  return Object.entries(FILE_RULES)
    .filter(([, r]) => cats.includes(r.category) && !(module === "chat" && r.taskOnly))
    .map(([e]) => `.${e}`).join(",");
};

// Human, actionable messages (English / Gujarati like the rest of the app).
export const UPLOAD_MSG = {
  UNSUPPORTED: "This file type is not supported. Use DWG, DXF, PDF, Word, Excel, CSV, TXT or an image. / આ ફાઇલ પ્રકાર સમર્થિત નથી.",
  BLOCKED: "This file type is not allowed for security reasons. / સુરક્ષા કારણોસર આ ફાઇલ પ્રકારની મંજૂરી નથી.",
  EMPTY: "This file is empty (0 KB). Choose a different file. / આ ફાઇલ ખાલી છે.",
  TOO_LARGE: `The file is larger than ${MAX_UPLOAD_BYTES / 1048576} MB. / ફાઇલ ${MAX_UPLOAD_BYTES / 1048576} MB કરતાં મોટી છે.`,
  DRAWING_INVALID: "This DWG/DXF drawing could not be validated. Save it again from your CAD program and retry. / DWG/DXF ડ્રોઇંગ ચકાસી શકાયું નથી.",
  WRONG_KIND: "A document or drawing is required here (PDF, Word, Excel or DWG/DXF) — a photo does not count. / અહીં દસ્તાવેજ અથવા ડ્રોઇંગ જરૂરી છે.",
  MIME_REJECTED: "Storage rejected the file type. Please retry; if it keeps failing, contact your administrator. / સ્ટોરેજે ફાઇલ પ્રકાર નકાર્યો.",
  LINK_EXPIRED: "The upload link expired. Please press Retry. / અપલોડ લિંક સમાપ્ત થઈ. કૃપા કરીને ફરી પ્રયાસ કરો.",
  DENIED: "You do not have permission to upload to this task. / તમને આ કાર્યમાં અપલોડ કરવાની પરવાનગી નથી.",
  NETWORK: "Network problem while uploading. Check your connection and press Retry. / નેટવર્ક સમસ્યા. કનેક્શન તપાસો અને ફરી પ્રયાસ કરો.",
  STORAGE_DOWN: "Document storage is unavailable right now. Please try again shortly. / દસ્તાવેજ સ્ટોરેજ હાલ ઉપલબ્ધ નથી.",
  NOT_LINKED: "The file was uploaded but could not be linked to the task, so it was removed. Please retry. / ફાઇલ અપલોડ થઈ પણ કાર્ય સાથે જોડાઈ શકી નહીં.",
  SESSION: "Your session has expired. Please sign in again. / તમારું સત્ર સમાપ્ત થયું છે.",
  NOT_COMPLETED: "The task was not completed because the document upload failed. / દસ્તાવેજ અપલોડ નિષ્ફળ થવાથી કાર્ય પૂર્ણ થયું નથી.",
  VOICE_EMPTY: "The recording is empty. Please record again. / રેકોર્ડિંગ ખાલી છે. કૃપા કરીને ફરી રેકોર્ડ કરો.",
  VOICE_TOO_SHORT: "The recording is too short (minimum 1 second). / રેકોર્ડિંગ ખૂબ ટૂંકું છે (ઓછામાં ઓછું 1 સેકન્ડ).",
  VOICE_TOO_LONG: "The recording is longer than 60 seconds. Please record a shorter message. / રેકોર્ડિંગ 60 સેકન્ડથી લાંબું છે.",
  VOICE_TOO_LARGE: "The recording is larger than 5 MB. Please record a shorter message. / રેકોર્ડિંગ 5 MB કરતાં મોટું છે.",
  VOICE_UNSUPPORTED: "This browser recorded an audio format that is not supported. Please try another browser. / આ બ્રાઉઝરનું ઑડિયો ફોર્મેટ સમર્થિત નથી.",
  VOICE_NOT_LINKED: "The voice message was uploaded but could not be attached to the task. Press Retry — your recording is still kept. / વોઇસ સંદેશ કાર્ય સાથે જોડાઈ શક્યો નહીં. ફરી પ્રયાસ કરો — તમારું રેકોર્ડિંગ સાચવેલું છે.",
  REQUIRED: "A document or drawing must be uploaded successfully before completing this task. / આ કાર્ય પૂર્ણ કરતાં પહેલાં દસ્તાવેજ અથવા ડ્રોઇંગ સફળતાપૂર્વક અપલોડ થવું જોઈએ.",
};

export class UploadError extends Error {
  constructor(code, detail) {
    super(UPLOAD_MSG[code] || detail || "Upload failed.");
    this.name = "UploadError";
    this.code = code;
    this.detail = detail || null;
    this.retryable = ["NETWORK", "LINK_EXPIRED", "STORAGE_DOWN", "NOT_LINKED"].includes(code);
  }
}

// Reads the first bytes so a renamed file (an .exe called .dwg, an HTML page called .dxf) is not accepted as a drawing.
async function sniffOk(kind, file) {
  const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  const text = new TextDecoder("latin1").decode(head);
  if (kind === "dwg") return /^AC\d/.test(text); // AC1.50, AC1002, AC1015 ... AC1032
  if (kind === "dxf") return /SECTION/.test(text) || text.startsWith("AutoCAD Binary DXF");
  return true;
}

// Returns { ext, category, mime, label } or throws UploadError. `module` picks the allowed categories.
export async function validateUploadFile(file, module = "task") {
  if (!file || typeof file !== "object" || typeof file.size !== "number") throw new UploadError("UNSUPPORTED");
  let ext = extensionOf(file.name || "");
  let filename = file.name || "photo";
  if (BLOCKED_EXTENSIONS.has(ext)) throw new UploadError("BLOCKED");
  if (!FILE_RULES[ext] && IMAGE_MIME_EXT[(file.type || "").toLowerCase()]) {
    ext = IMAGE_MIME_EXT[file.type.toLowerCase()];
    filename = `${filename.replace(/\.[A-Za-z0-9]{0,6}$/, "") || "photo"}.${ext}`;
  }
  const rule = FILE_RULES[ext];
  if (!rule || (module === "chat" && rule.taskOnly)) throw new UploadError("UNSUPPORTED");
  const cats = MODULE_CATEGORIES[module] || MODULE_CATEGORIES.task;
  if (!cats.includes(rule.category)) throw new UploadError(module === "document" ? "WRONG_KIND" : "UNSUPPORTED");
  if (file.size === 0) throw new UploadError("EMPTY");
  if (file.size > MAX_UPLOAD_BYTES) throw new UploadError("TOO_LARGE");
  // the browser's MIME is only a hint (it is "" / octet-stream for many real DWGs): the approved EXTENSION decides, and the
  // upload is re-typed to the canonical MIME. A reported type that is plainly executable / scriptable is still refused.
  if (HOSTILE_MIME.has((file.type || "").toLowerCase())) throw new UploadError("BLOCKED");
  if (rule.sniff && !(await sniffOk(rule.sniff, file))) throw new UploadError("DRAWING_INVALID");
  return { ext, category: rule.category, mime: rule.mime, label: rule.label, filename };
}

// The File the SDK will actually send: same bytes, approved type. (The SDK reads file.type for the Content-Type part.)
export function typedFile(file, mime, name) {
  return new File([file], name || file.name, { type: mime, lastModified: file.lastModified });
}

// Dev-only, secrets-free diagnostics for a failed upload.
export function logUploadFailure(stage, err, ctx) {
  if (!import.meta.env.DEV) return;
  console.warn("[upload]", stage, {
    code: err?.code || err?.statusCode, status: err?.status, message: err?.message,
    bucket: ctx?.bucket, path: ctx?.path, ext: ctx?.ext, size: ctx?.size, mime: ctx?.mime,
  });
}
