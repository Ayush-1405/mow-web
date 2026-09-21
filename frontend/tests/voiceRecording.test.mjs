import test from "node:test";
import assert from "node:assert/strict";
import {
  VOICE_MAX_BYTES, VOICE_MAX_SECONDS, baseMime, extensionForMime, formatBytes, formatDuration, isAllowedVoiceMime, pickRecordingFormat,
  validateRecording, voiceFileName,
} from "../src/lib/voiceRecording.js";

const fakeRecorder = (supported) => ({ isTypeSupported: (m) => supported.includes(m) });

test("Chrome / Edge: prefers webm with opus", () => {
  const f = pickRecordingFormat(fakeRecorder(["audio/webm;codecs=opus", "audio/webm", "audio/ogg"]));
  assert.deepEqual(f, { supported: true, mimeType: "audio/webm;codecs=opus" });
});

test("iPhone Safari: no webm, records mp4 (AAC)", () => {
  const f = pickRecordingFormat(fakeRecorder(["audio/mp4"]));
  assert.deepEqual(f, { supported: true, mimeType: "audio/mp4" });
});

test("Firefox: ogg/opus", () => {
  assert.equal(pickRecordingFormat(fakeRecorder(["audio/ogg;codecs=opus", "audio/ogg"])).mimeType, "audio/ogg;codecs=opus");
});

test("a browser with MediaRecorder but none of the candidates falls back to the browser default (null)", () => {
  assert.deepEqual(pickRecordingFormat(fakeRecorder([])), { supported: true, mimeType: null });
});

test("no MediaRecorder at all is reported as unsupported", () => {
  assert.deepEqual(pickRecordingFormat(undefined), { supported: false, mimeType: null });
});

test("extension always follows the REAL mime type, never a hard-coded .mp3", () => {
  assert.equal(extensionForMime("audio/webm;codecs=opus"), "webm");
  assert.equal(extensionForMime("audio/webm; codecs=opus"), "webm");
  assert.equal(extensionForMime("audio/mp4"), "m4a");
  assert.equal(extensionForMime("audio/ogg;codecs=opus"), "ogg");
  assert.equal(extensionForMime("audio/AAC"), "aac");
  assert.equal(extensionForMime("video/mp4"), null);
  assert.equal(baseMime(" Audio/WebM ; codecs=opus"), "audio/webm");
});

test("file names carry a timestamp and the right extension", () => {
  const when = new Date(2026, 8, 21, 15, 5, 9);
  assert.equal(voiceFileName("audio/webm;codecs=opus", when), "voice-message-20260921-150509.webm");
  assert.equal(voiceFileName("audio/mp4", when), "voice-message-20260921-150509.m4a");
});

test("only audio types the server accepts are allowed", () => {
  for (const m of ["audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/aac", "audio/mpeg", "audio/wav"]) assert.equal(isAllowedVoiceMime(m), true, m);
  for (const m of ["video/webm", "application/octet-stream", "", null, "text/html"]) assert.equal(isAllowedVoiceMime(m), false, String(m));
});

test("validation: empty, too short, too long, too large, wrong type", () => {
  assert.equal(validateRecording({ size: 0, seconds: 5, mime: "audio/webm" }), "EMPTY");
  assert.equal(validateRecording({ size: 1000, seconds: 0, mime: "audio/webm" }), "TOO_SHORT");
  assert.equal(validateRecording({ size: 1000, seconds: VOICE_MAX_SECONDS + 1, mime: "audio/webm" }), "TOO_LONG");
  assert.equal(validateRecording({ size: VOICE_MAX_BYTES + 1, seconds: 30, mime: "audio/webm" }), "TOO_LARGE");
  assert.equal(validateRecording({ size: 1000, seconds: 5, mime: "video/mp4" }), "UNSUPPORTED_TYPE");
  assert.equal(validateRecording({ size: 300000, seconds: 42, mime: "audio/webm;codecs=opus" }), null);
  assert.equal(validateRecording({ size: VOICE_MAX_BYTES, seconds: VOICE_MAX_SECONDS, mime: "audio/mp4" }), null);
});

test("duration and size formatting", () => {
  assert.equal(formatDuration(0), "00:00");
  assert.equal(formatDuration(42), "00:42");
  assert.equal(formatDuration(60), "01:00");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(425350), "415 KB");
  assert.equal(formatBytes(2.5 * 1048576), "2.5 MB");
});
