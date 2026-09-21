import React, { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import {
  VOICE_MAX_SECONDS, formatBytes, formatDuration, pickRecordingFormat, validateRecording, voiceFileName,
} from "../lib/voiceRecording";

// Records up to VOICE_MAX_SECONDS of audio with MediaRecorder and hands the parent a ready-to-upload File plus the real duration.
//
//  - Nothing starts by itself: the microphone is requested only when the user taps "Record" (required by iPhone Safari).
//  - The format is chosen at runtime (webm/opus, mp4/AAC, ogg/opus ...) and the File is typed and named from the recorder's ACTUAL mime type.
//  - The microphone is released as soon as recording stops, on error, and on unmount.
//  - The preview URL (a temporary blob: URL, only ever used by the <audio> preview here) is revoked when the recording is deleted/replaced or
//    this component unmounts -- the parent unmounts it only after a successful submit, so the preview survives a failed attempt.
//  - The parent keeps the File in its own state (onRecorded); this component never uploads anything.
// onRecorded(file, seconds) is called with (null, 0) when the recording is cleared.
export default function VoiceRecorder({ lang, onRecorded, disabled = false }) {
  const [status, setStatus] = useState(() => (pickRecordingFormat().supported && navigator.mediaDevices?.getUserMedia ? "idle" : "unsupported"));
  const [seconds, setSeconds] = useState(0);
  const [preview, setPreview] = useState(null); // { url, seconds, size }
  const [problem, setProblem] = useState(null); // i18n key
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const startedAtRef = useRef(0);
  const discardRef = useRef(false);
  const previewUrlRef = useRef(null);
  const onRecordedRef = useRef(onRecorded);
  useEffect(() => { onRecordedRef.current = onRecorded; }, [onRecorded]);

  const releaseMic = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);
  const revokePreview = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
  }, []);

  useEffect(() => () => {
    window.clearInterval(timerRef.current);
    discardRef.current = true;
    if (recorderRef.current && recorderRef.current.state !== "inactive") { try { recorderRef.current.stop(); } catch { /* already stopped */ } }
    releaseMic();
    revokePreview();
  }, [releaseMic, revokePreview]);

  function stopRecording() {
    window.clearInterval(timerRef.current);
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }

  async function startRecording() {
    setProblem(null);
    setStatus("requesting");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setStatus(err?.name === "NotAllowedError" || err?.name === "SecurityError" ? "denied" : "idle");
      if (err?.name !== "NotAllowedError" && err?.name !== "SecurityError") setProblem("voiceMicError");
      return;
    }
    streamRef.current = stream;
    try {
      const { mimeType } = pickRecordingFormat();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      discardRef.current = false;

      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onerror = () => { releaseMic(); window.clearInterval(timerRef.current); setStatus("idle"); setProblem("voiceMicError"); };
      recorder.onstop = () => {
        releaseMic(); // the red "recording" indicator goes off immediately
        window.clearInterval(timerRef.current);
        if (discardRef.current) return;
        const finalMime = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: finalMime });
        const elapsed = Math.min(VOICE_MAX_SECONDS, Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000)));
        const bad = validateRecording({ size: blob.size, seconds: elapsed, mime: finalMime });
        if (bad) {
          setStatus("idle");
          setProblem({ EMPTY: "voiceEmpty", TOO_SHORT: "voiceTooShort", TOO_LONG: "voiceTooLong", TOO_LARGE: "voiceTooLarge", UNSUPPORTED_TYPE: "voiceTypeUnsupported" }[bad]);
          return;
        }
        const file = new File([blob], voiceFileName(finalMime), { type: finalMime });
        revokePreview();
        const url = URL.createObjectURL(blob);
        previewUrlRef.current = url;
        setPreview({ url, seconds: elapsed, size: blob.size });
        setSeconds(elapsed);
        setStatus("recorded");
        onRecordedRef.current?.(file, elapsed);
      };

      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      recorder.start(1000); // a chunk every second: a crash / navigation loses at most one second
      setSeconds(0);
      setStatus("recording");
      timerRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
        setSeconds(elapsed);
        if (elapsed >= VOICE_MAX_SECONDS) stopRecording();
      }, 250);
    } catch {
      releaseMic();
      setStatus("idle");
      setProblem("voiceMicError");
    }
  }

  function clearRecording() {
    revokePreview();
    setPreview(null);
    setSeconds(0);
    setProblem(null);
    setStatus("idle");
    onRecordedRef.current?.(null, 0);
  }
  function reRecord() {
    clearRecording();
    startRecording();
  }

  if (status === "unsupported") return <div className="msg info">{t("voiceNotSupported", lang)}</div>;

  return (
    <div className="voice-rec">
      {(status === "idle" || status === "denied" || status === "requesting") && (
        <button type="button" className="btn btn-outline" disabled={disabled || status === "requesting"} onClick={startRecording}>
          🎙️ {t("recordVoice", lang)}
        </button>
      )}
      {status === "recording" && (
        <div className="voice-rec-live" role="status" aria-live="polite">
          <span className="voice-rec-dot" aria-hidden="true" />
          <b>{formatDuration(seconds)}</b> / {formatDuration(VOICE_MAX_SECONDS)}
          <button type="button" className="btn btn-gold" onClick={stopRecording}>⏹ {t("stopRecording", lang)}</button>
        </div>
      )}
      {status === "recorded" && preview && (
        <div className="voice-rec-preview">
          <audio controls preload="metadata" playsInline src={preview.url} />
          <div className="sub">{t("voiceRecordedLength", lang)}: {formatDuration(preview.seconds)} · {formatBytes(preview.size)}</div>
          <div className="btn-row">
            <button type="button" className="btn btn-outline" disabled={disabled} onClick={reRecord}>🔁 {t("reRecord", lang)}</button>
            <button type="button" className="btn btn-outline" disabled={disabled} onClick={clearRecording}>🗑 {t("voiceDelete", lang)}</button>
          </div>
        </div>
      )}
      {status === "denied" && <div className="msg error" role="alert">{t("micPermissionDenied", lang)}</div>}
      {problem && <div className="msg error" role="alert">{t(problem, lang)}</div>}
    </div>
  );
}
