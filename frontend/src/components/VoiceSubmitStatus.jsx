import React from "react";
import { t } from "../lib/i18n";

// Progress + failure panel for a form that submits a task together with an optional voice instruction (see lib/useTaskVoice).
//  - while the sequence runs:  "Uploading voice message…" -> "Creating task…" -> "Finalizing task…"
//  - on failure: the real reason, and what the user can do. The recording is still there; nothing was reset.
export default function VoiceSubmitStatus({ lang, tv, onRetry, onKeepWithout, onCancelTask, taskLabel = "" }) {
  const { stage, failure } = tv;
  if (tv.busy) {
    const key = { uploading: "voiceUploading", creating: "creatingTask", attaching: "finalizingTask" }[stage];
    return <div className="msg info" role="status" aria-live="polite"><span className="spinner" /> {t(key, lang)}</div>;
  }
  if (!failure) return null;
  return (
    <div className="msg error voice-fail" role="alert">
      <div>
        {failure.task
          ? `${t("voiceTaskCreatedNoVoice", lang)}${taskLabel ? ` (${taskLabel})` : ""}`
          : (failure.step === "voice-upload" ? t("voiceUploadFailed", lang) : t("taskCreateFailed", lang))}
      </div>
      <div className="sub">{failure.message}</div>
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={onRetry}>↻ {t("retry", lang)}</button>
        {failure.task && (
          <>
            <button type="button" className="btn btn-outline" onClick={onKeepWithout}>{t("voiceKeepWithout", lang)}</button>
            <button type="button" className="btn btn-outline" onClick={onCancelTask}>{t("voiceCancelTask", lang)}</button>
          </>
        )}
      </div>
    </div>
  );
}
