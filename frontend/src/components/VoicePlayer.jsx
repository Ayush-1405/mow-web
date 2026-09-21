import React, { useCallback, useEffect, useRef, useState } from "react";
import { downloadTaskProof, getVoicePlaybackUrl, logVoiceFailure } from "../lib/api";
import { t } from "../lib/i18n";

// Plays one stored voice attachment with the browser's native, accessible player (play / pause / seek / volume; never autoplays).
// The private bucket is reached only through a short-lived signed URL: minted once when the player mounts (cached in lib/api until shortly
// before it expires -- not on every render) and re-minted if the browser reports a load error because it expired while the page was open,
// resuming from the same position. "Download" mints a separate download link.
const MAX_REFRESHES = 2; // an expired link is refreshed at most twice in a row: a genuinely broken file must not cause a request loop

export default function VoicePlayer({ attachmentId, lang, showToast }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const audioRef = useRef(null);
  const resumeAt = useRef(0);
  const refreshes = useRef(0);

  useEffect(() => {
    let active = true;
    refreshes.current = 0;
    setFailed(false);
    getVoicePlaybackUrl(attachmentId)
      .then((u) => { if (active) setUrl(u); })
      .catch((err) => { logVoiceFailure("playback-url", err, { attachmentId }); if (active) setFailed(true); });
    return () => { active = false; };
  }, [attachmentId]);

  const onError = useCallback(async () => {
    if (refreshes.current >= MAX_REFRESHES) { setFailed(true); return; }
    refreshes.current += 1;
    resumeAt.current = audioRef.current?.currentTime || 0;
    try { setUrl(await getVoicePlaybackUrl(attachmentId, { force: true })); } catch (err) { logVoiceFailure("playback-refresh", err, { attachmentId }); setFailed(true); }
  }, [attachmentId]);

  const onLoadedMetadata = () => {
    if (resumeAt.current > 0 && audioRef.current) { audioRef.current.currentTime = resumeAt.current; resumeAt.current = 0; }
    refreshes.current = 0;
  };

  async function download() {
    try {
      const res = await downloadTaskProof(attachmentId);
      window.open(res.signed_url, "_blank", "noopener,noreferrer");
    } catch (err) {
      logVoiceFailure("download", err, { attachmentId });
      showToast?.("error", err.message);
    }
  }

  return (
    <div className="voice-player">
      {failed ? (
        <div className="msg error" role="alert">{t("voiceLoadFailed", lang)}</div>
      ) : url ? (
        <audio ref={audioRef} controls preload="metadata" playsInline src={url} onError={onError} onLoadedMetadata={onLoadedMetadata} />
      ) : (
        <div className="sub">…</div>
      )}
      <button type="button" className="btn btn-outline voice-download" onClick={download}>⬇ {t("download", lang)}</button>
    </div>
  );
}
