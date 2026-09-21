import React, { useCallback, useEffect, useState } from "react";
import VoicePlayer from "./VoicePlayer.jsx";
import VoiceRecorder from "../screens/VoiceRecorder.jsx";
import { attachVoiceInstruction, fetchVoiceInstructions, logVoiceFailure, removeTaskAttachment, stageVoiceRecording } from "../lib/api";
import { formatDuration } from "../lib/voiceRecording";
import { t } from "../lib/i18n";

// "🎙 Voice Instruction" section of a task: the recording made when the task was assigned, playable by everyone who can see the task.
// Renders NOTHING when the task has no voice instruction. `initial` (from the list's batched query) makes the first paint instant; the
// component then re-reads the row once so an instruction attached a moment after the task appeared (or replaced / removed elsewhere) is
// always current. `canManage` only decides whether Remove / Replace are OFFERED -- the database enforces who may actually do it.
export default function VoiceInstruction({ taskId, initial = null, canManage = false, lang, showToast, onChanged }) {
  const [row, setRow] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [replacement, setReplacement] = useState({ file: null, seconds: 0 });
  const [recorderKey, setRecorderKey] = useState(0);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const { data, error: err } = await fetchVoiceInstructions([taskId]);
    if (!err) setRow((data || [])[0] || null);
  }, [taskId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (initial) setRow(initial); }, [initial]);

  async function remove() {
    if (!window.confirm(t("voiceRemoveConfirm", lang))) return;
    setBusy(true); setError(null);
    const { error: err } = await removeTaskAttachment(row.id, "voice instruction removed");
    setBusy(false);
    if (err) { logVoiceFailure("remove", err); setError(err.message); return; }
    setRow(null);
    onChanged?.();
  }

  async function saveReplacement() {
    if (!replacement.file) return;
    setBusy(true); setError(null);
    try {
      const staged = await stageVoiceRecording({ file: replacement.file, durationSeconds: replacement.seconds });
      await attachVoiceInstruction({ taskId, staged }); // linking archives the previous instruction in the same transaction
      setReplacing(false); setReplacement({ file: null, seconds: 0 }); setRecorderKey((k) => k + 1);
      await load();
      onChanged?.();
      showToast?.("success", t("voiceReplaced", lang));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!row) return null;
  const when = row.created_at ? new Date(row.created_at).toLocaleString(lang === "gu" ? "gu-IN" : undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  return (
    <section className="voice-instruction" aria-label={t("voiceInstruction", lang)}>
      <div className="voice-instruction-head">🎙 {t("voiceInstruction", lang)}{row.duration_seconds ? <span className="sub"> · {formatDuration(row.duration_seconds)}</span> : null}</div>
      <VoicePlayer attachmentId={row.id} lang={lang} showToast={showToast} />
      <div className="sub">{t("voiceRecordedBy", lang)} {row.recorded_by_name || "—"}{when ? ` • ${when}` : ""}</div>
      {canManage && !replacing && (
        <div className="btn-row">
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setReplacing(true)}>🔁 {t("voiceReplace", lang)}</button>
          <button type="button" className="btn btn-outline" disabled={busy} onClick={remove}>🗑 {t("voiceRemove", lang)}</button>
        </div>
      )}
      {canManage && replacing && (
        <div className="voice-replace">
          <VoiceRecorder key={recorderKey} lang={lang} disabled={busy} onRecorded={(file, seconds) => setReplacement({ file, seconds })} />
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={busy || !replacement.file} onClick={saveReplacement}>{busy ? t("voiceUploading", lang) : t("voiceSaveReplacement", lang)}</button>
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => { setReplacing(false); setReplacement({ file: null, seconds: 0 }); setRecorderKey((k) => k + 1); }}>{t("cancel", lang)}</button>
          </div>
        </div>
      )}
      {error && <div className="msg error" role="alert">{error}</div>}
    </section>
  );
}
