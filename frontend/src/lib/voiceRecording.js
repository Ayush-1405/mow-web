// Voice-instruction recording helpers (pure functions, unit-tested in tests/voiceRecording.test.mjs).
//
// The real recording format is decided at runtime from what THIS browser can record (MediaRecorder.isTypeSupported) and the file is named
// and typed from the recorder's ACTUAL mime type -- Chrome/Edge/Firefox record webm/opus or ogg/opus, Safari on iPhone records mp4 (AAC).
// Nothing here assumes ".mp3".

export const VOICE_MAX_SECONDS = 60;
export const VOICE_MIN_SECONDS = 1;
export const VOICE_MAX_BYTES = 5 * 1024 * 1024;

// Best first. Safari cannot record webm; Firefox cannot record mp4; Chrome prefers webm/opus.
export const RECORDING_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/aac",
];

// Base types the server accepts for a voice message (staff-file-url + staff_record_attachment).
const ALLOWED_BASE = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-m4a", "audio/aac"];
const EXT_BY_BASE = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-m4a": "m4a", "audio/aac": "aac" };

export const baseMime = (mime) => String(mime || "").split(";")[0].trim().toLowerCase();
export const isAllowedVoiceMime = (mime) => ALLOWED_BASE.includes(baseMime(mime));
export const extensionForMime = (mime) => EXT_BY_BASE[baseMime(mime)] || null;

// { supported, mimeType } -- mimeType is the first candidate this browser can record, or null (use the browser default) when none match.
export function pickRecordingFormat(MediaRecorderCtor = typeof MediaRecorder === "undefined" ? undefined : MediaRecorder) {
  if (!MediaRecorderCtor) return { supported: false, mimeType: null };
  if (typeof MediaRecorderCtor.isTypeSupported !== "function") return { supported: true, mimeType: null };
  const mimeType = RECORDING_CANDIDATES.find((c) => MediaRecorderCtor.isTypeSupported(c)) || null;
  return { supported: true, mimeType };
}

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

// voice-message-20260921-151530.webm  (extension from the REAL mime type)
export function voiceFileName(mime, when = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`;
  return `voice-message-${stamp}.${extensionForMime(mime) || "webm"}`;
}

// Returns null when the recording may be uploaded, otherwise one of: EMPTY | TOO_SHORT | TOO_LONG | TOO_LARGE | UNSUPPORTED_TYPE
export function validateRecording({ size, seconds, mime }) {
  if (!size || size <= 0) return "EMPTY";
  if (!isAllowedVoiceMime(mime)) return "UNSUPPORTED_TYPE";
  if (seconds < VOICE_MIN_SECONDS) return "TOO_SHORT";
  if (seconds > VOICE_MAX_SECONDS) return "TOO_LONG";
  if (size > VOICE_MAX_BYTES) return "TOO_LARGE";
  return null;
}
