import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";
import { attachVoiceInstruction, discardStagedVoice, logVoiceFailure, stageVoiceRecording } from "./api";

// The safe submit sequence for "Assign Task" / "Create Factory Task" with an OPTIONAL voice instruction.
//
//   1. upload the recording           (so a task is never created without the recording it was meant to carry)
//   2. create the task                (the caller's own RPC -- returns the real task id)
//   3. link the recording to the task (staff_record_attachment, purpose = instruction)
//   4. only now: success -> the caller refreshes and resets its form
//
// Each step remembers its result in `run`, so a RETRY resumes at the step that failed: the recording is never uploaded twice, the task is
// never created twice, and the recorded File stays in `voice` until the whole sequence has succeeded. A second click while a submit is in
// flight is ignored. With no recording, step 1 and 3 are skipped and this is just "create the task".
const emptyRun = () => ({ staged: null, task: null, attachmentId: null, locked: false });

export function useTaskVoice({ getTaskId = (row) => row?.task_id } = {}) {
  const [voice, setVoice] = useState({ file: null, seconds: 0 });
  const [stage, setStage] = useState("idle"); // idle | uploading | creating | attaching | done | failed
  const [failure, setFailure] = useState(null); // { message, step, task }
  const run = useRef(emptyRun());
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const onRecorded = useCallback((file, seconds) => {
    const r = run.current;
    // a different (or deleted) recording makes whatever was uploaded for the previous one useless
    if (r.staged && !r.task) { discardStagedVoice(r.staged.storagePath); r.staged = null; }
    setVoice({ file: file || null, seconds: seconds || 0 });
    setFailure(null);
    setStage("idle");
  }, []);

  // best effort: leaving the screen with an uploaded-but-unused recording removes it (a day-old stray is also swept server-side)
  useEffect(() => () => {
    const r = run.current;
    if (r.staged && !r.task && !r.attachmentId) discardStagedVoice(r.staged.storagePath);
  }, []);

  const submit = useCallback(async (createTask) => {
    const r = run.current;
    if (r.locked) return { ok: false, busy: true };
    r.locked = true;
    setFailure(null);
    let step = "task";
    try {
      const { file, seconds } = voiceRef.current;
      if (file && !r.staged) {
        step = "voice-upload";
        setStage("uploading");
        r.staged = await stageVoiceRecording({ file, durationSeconds: seconds });
      }
      if (!r.task) {
        step = "task";
        setStage("creating");
        r.task = await createTask();
      }
      if (file && !r.attachmentId) {
        step = "voice-link";
        setStage("attaching");
        r.attachmentId = (await attachVoiceInstruction({ taskId: getTaskId(r.task), staged: r.staged })).attachmentId;
      }
      setStage("done");
      return { ok: true, task: r.task, hadVoice: !!file };
    } catch (err) {
      if (step === "task") logVoiceFailure("create-task", err);
      setStage("failed");
      setFailure({ message: err?.message || "Something went wrong.", step, task: r.task });
      return { ok: false, error: err, step };
    } finally {
      r.locked = false;
    }
  }, [getTaskId]);

  // After a fully successful submit: forget everything (the caller also resets its own fields and remounts the recorder).
  const reset = useCallback(() => {
    run.current = emptyRun();
    setVoice({ file: null, seconds: 0 });
    setStage("idle");
    setFailure(null);
  }, []);

  // The task exists but its voice could not be attached and the user chooses to keep it without the recording.
  const keepTaskWithoutVoice = useCallback(() => {
    const r = run.current;
    if (r.staged) discardStagedVoice(r.staged.storagePath);
    const task = r.task;
    reset();
    return task;
  }, [reset]);

  // The task exists but its voice could not be attached and the user chooses to cancel the task instead (soft delete, audited). The recording
  // stays staged so the whole form can simply be submitted again.
  const cancelCreatedTask = useCallback(async () => {
    const r = run.current;
    if (!r.task) return { ok: true };
    const { error } = await supabase.rpc("staff_delete_task", { p_task_id: getTaskId(r.task) });
    if (error) { logVoiceFailure("cancel-task", error); return { ok: false, message: error.message }; }
    r.task = null;
    setFailure(null);
    setStage("idle");
    return { ok: true };
  }, [getTaskId]);

  return {
    voice, onRecorded, submit, reset, keepTaskWithoutVoice, cancelCreatedTask,
    stage, failure,
    hasVoice: !!voice.file,
    busy: stage === "uploading" || stage === "creating" || stage === "attaching",
    // the task was created but the voice is not attached yet: the form must stay frozen until the user resolves it
    taskPending: !!(failure && failure.task),
  };
}
