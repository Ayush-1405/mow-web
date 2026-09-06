import React, { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";

// Records up to MAX_SECONDS of audio via the browser's MediaRecorder API
// and hands the parent a ready-to-upload File (never a raw Blob) plus the
// recorded duration — matches what staff_record_attachment/staff-file-url
// now require for file_type='voice' (both enforce 1–60s server-side; this
// is the client-side mirror of that limit, not the enforcement boundary).
const MAX_SECONDS = 60;
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function pickMimeType() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return null;
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

function extFor(mime) {
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";
  return "webm";
}

// onRecorded(file, durationSeconds) — called with (null, 0) when cleared.
export default function VoiceRecorder({ lang, onRecorded, disabled }) {
  const [status, setStatus] = useState("idle"); // idle | recording | recorded | unsupported | denied
  const [seconds, setSeconds] = useState(0);
  const [audioUrl, setAudioUrl] = useState(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setStatus("unsupported");
    }
    return () => {
      window.clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      let elapsed = 0;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const finalMime = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: finalMime });
        const file = new File([blob], `voice-message.${extFor(finalMime)}`, { type: finalMime });
        setAudioUrl(URL.createObjectURL(blob));
        setStatus("recorded");
        streamRef.current?.getTracks().forEach((tr) => tr.stop());
        onRecorded(file, Math.max(1, elapsed));
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setSeconds(0);
      setStatus("recording");
      timerRef.current = window.setInterval(() => {
        elapsed += 1;
        setSeconds(elapsed);
        if (elapsed >= MAX_SECONDS) stopRecording();
      }, 1000);
    } catch {
      setStatus("denied");
    }
  }

  function stopRecording() {
    window.clearInterval(timerRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  }

  function clearRecording() {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    setStatus("idle");
    setSeconds(0);
    onRecorded(null, 0);
  }

  if (status === "unsupported") {
    return <div className="msg info">{t("voiceNotSupported", lang)}</div>;
  }

  return (
    <div style={{ marginTop: 6 }}>
      {status === "idle" && (
        <button type="button" className="btn btn-outline" disabled={disabled} onClick={startRecording}>
          🎙️ {t("recordVoice", lang)}
        </button>
      )}
      {status === "recording" && (
        <button type="button" className="btn btn-gold" onClick={stopRecording}>
          ⏹ {t("stopRecording", lang)} — {seconds}s / {MAX_SECONDS}s
        </button>
      )}
      {status === "recorded" && audioUrl && (
        <div>
          <audio controls src={audioUrl} style={{ width: "100%", marginTop: 6 }} />
          <div className="btn-row">
            <button type="button" className="btn btn-outline" disabled={disabled} onClick={clearRecording}>
              {t("reRecord", lang)}
            </button>
          </div>
        </div>
      )}
      {status === "denied" && <div className="msg error">{t("micPermissionDenied", lang)}</div>}
    </div>
  );
}
