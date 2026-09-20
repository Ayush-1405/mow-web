// Server-side twin of frontend/src/lib/fileTypes.js. Keep the three lists in step:
//   1. this file (what staff-file-url will sign an upload for)
//   2. frontend/src/lib/fileTypes.js (what the browser offers / validates)
//   3. storage.buckets.allowed_mime_types for `staff-attachments` (what Storage itself accepts)
//
// The browser-reported MIME type of a file is only a hint (DWG/DXF are frequently reported as "" or
// application/octet-stream). The approved EXTENSION decides the category and the canonical content type the upload
// must carry; octet-stream is never trusted on its own.

export interface FileRule {
  category: "image" | "pdf" | "word" | "excel" | "drawing";
  mime: string; // canonical Content-Type the object is stored with (always present in the bucket allow-list)
  accepts: string[]; // browser-reported types that are consistent with this extension
}

const AMBIGUOUS = ["application/octet-stream", "binary/octet-stream", "application/x-octet-stream"];

export const FILE_RULES: Record<string, FileRule> = {
  dwg: { category: "drawing", mime: "application/acad", accepts: ["application/acad", "application/x-acad", "application/autocad_dwg", "application/dwg", "image/vnd.dwg", "application/x-dwg", ...AMBIGUOUS] },
  dxf: { category: "drawing", mime: "application/dxf", accepts: ["application/dxf", "application/x-dxf", "image/vnd.dxf", ...AMBIGUOUS] },
  pdf: { category: "pdf", mime: "application/pdf", accepts: ["application/pdf"] },
  doc: { category: "word", mime: "application/msword", accepts: ["application/msword"] },
  docx: { category: "word", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", accepts: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"] },
  txt: { category: "word", mime: "text/plain", accepts: ["text/plain", ...AMBIGUOUS] },
  xls: { category: "excel", mime: "application/vnd.ms-excel", accepts: ["application/vnd.ms-excel"] },
  xlsx: { category: "excel", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", accepts: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] },
  csv: { category: "excel", mime: "text/csv", accepts: ["text/csv", "application/csv", "application/vnd.ms-excel", ...AMBIGUOUS] },
  jpg: { category: "image", mime: "image/jpeg", accepts: ["image/jpeg", "image/jpg"] },
  jpeg: { category: "image", mime: "image/jpeg", accepts: ["image/jpeg", "image/jpg"] },
  png: { category: "image", mime: "image/png", accepts: ["image/png"] },
  webp: { category: "image", mime: "image/webp", accepts: ["image/webp"] },
  heic: { category: "image", mime: "image/heic", accepts: ["image/heic"] },
  heif: { category: "image", mime: "image/heif", accepts: ["image/heif", "image/heic"] },
};

// Never signable, whatever the declared type. (Archives are refused too: they can carry executables.)
export const BLOCKED_EXTENSIONS = new Set([
  "exe", "bat", "cmd", "com", "scr", "msi", "dll", "js", "mjs", "vbs", "ps1", "sh", "jar", "apk", "app", "html", "htm", "svg", "php", "zip", "rar", "7z",
]);

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

const VOICE_EXT: Record<string, string> = {
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-m4a": "m4a", "audio/aac": "aac",
};
export function voiceExtension(mime: string): string {
  return VOICE_EXT[mime.split(";")[0].trim().toLowerCase()] ?? "bin";
}

/** For non-voice uploads. Returns the extension + canonical content type, or null when the file must be refused. */
export function resolveDocument(filename: string, reportedMime: string, declaredCategory: string): { ext: string; contentType: string } | null {
  const ext = extensionOf(filename);
  if (BLOCKED_EXTENSIONS.has(ext)) return null;
  const rule = FILE_RULES[ext];
  if (!rule || rule.category !== declaredCategory) return null;
  if (!rule.accepts.includes(reportedMime.split(";")[0].trim().toLowerCase())) return null;
  return { ext, contentType: rule.mime };
}
