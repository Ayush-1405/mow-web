import React, { useState } from "react";
import { aiDraftStageUpdates, aiStageDraftRecordOutcome, factoryUpdateStage } from "../../lib/interiorApi";

const STATUS_LABEL = { in_progress: "In Progress", completed: "Completed", on_hold: "On Hold", rework: "Rework", skipped: "Skipped", pending: "Pending" };
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp"];
const LOW_CONFIDENCE = 0.7;

function friendly(err) {
  const m = err?.message || "";
  if (/not authorized/i.test(m)) return "You are not assigned to update this job's stages.";
  if (/Selected employee/i.test(m)) return "Could not apply: invalid employee selection.";
  console.error("[AiStageAssistant]", err);
  return "Could not apply this update. Please use the stage buttons.";
}

// Shop-floor helper on the Job Card: describe progress in a few words or
// send a photo; AI proposes stage updates; one tap applies them. AI never
// completes QC, dispatch or job completion -- those stay manual.
export default function AiStageAssistant({ job, onApplied }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [msg, setMsg] = useState(null);
  const [draft, setDraft] = useState(null);
  const [items, setItems] = useState([]);

  function onPick(e) {
    const picked = Array.from(e.target.files || []).slice(0, 3);
    setMsg(null);
    for (const f of picked) {
      const ext = (/\.([a-z0-9]+)$/i.exec(f.name)?.[1] || "").toLowerCase();
      if (!IMAGE_EXTS.includes(ext)) { setMsg({ type: "error", text: "Only JPG, PNG or WEBP photos are supported." }); return; }
      if (f.size > 4 * 1024 * 1024) { setMsg({ type: "error", text: `"${f.name}" is larger than 4 MB.` }); return; }
    }
    setFiles(picked);
  }

  async function read(e) {
    e.preventDefault();
    if (busy) return;
    if (!text.trim() && files.length === 0) { setMsg({ type: "error", text: "Write a few words or add a photo." }); return; }
    setBusy(true); setMsg(null); setDraft(null); setItems([]);
    const res = await aiDraftStageUpdates(job.id, { text, files });
    setBusy(false);
    if (!res?.ok) { setMsg({ type: "error", text: res?.reason || "The AI could not read this. Please use the stage buttons." }); return; }
    setDraft({ id: res.draft_id, warnings: res.warnings || [] });
    setItems((res.updates || []).map((u, i) => ({ ...u, key: i, include: true, state: "draft", error: null })));
    if ((res.updates || []).length === 0) setMsg({ type: "info", text: res.notes || "Nothing to update from this." });
  }

  const setItem = (key, patch) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  async function apply() {
    if (applying) return;
    setApplying(true); setMsg(null);
    let applied = items.filter((x) => x.state === "applied").length;
    for (const it of items.filter((x) => x.include && x.state !== "applied")) {
      if ((it.status === "on_hold" || it.status === "rework") && !(it.delay_reason || "").trim()) {
        setItem(it.key, { state: "error", error: "Please add the reason." });
        continue;
      }
      const { error } = await factoryUpdateStage(job.id, it.stage, it.status, {
        quantityCompleted: it.quantity_completed, quantityPending: it.quantity_pending,
        notes: it.note, delayReason: it.delay_reason,
      });
      if (error) { setItem(it.key, { state: "error", error: friendly(error) }); continue; }
      applied += 1;
      setItem(it.key, { state: "applied", error: null });
    }
    if (draft?.id) await aiStageDraftRecordOutcome(draft.id, applied, items.length);
    setApplying(false);
    onApplied?.();
    setMsg({ type: applied ? "success" : "error", text: applied ? `${applied} update${applied > 1 ? "s" : ""} saved.` : "Nothing was saved — check the cards." });
  }

  const pending = items.filter((x) => x.include && x.state !== "applied").length;

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <h3 style={{ marginTop: 0 }}>✨ Update with AI</h3>
      <form onSubmit={read}>
        <div className="field full">
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
            placeholder="e.g. cutting done, 12 panels, 2 damaged — or just add a photo" />
        </div>
        <div className="field full">
          <input type="file" accept=".jpg,.jpeg,.png,.webp" capture="environment" multiple onChange={onPick} disabled={busy} />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Reading…" : "Read with AI"}</button>
      </form>
      {msg && <div className={`msg ${msg.type}`} style={{ marginTop: 8 }}>{msg.text}</div>}
      {draft?.warnings?.length > 0 && <div className="msg info" style={{ marginTop: 8 }}>{draft.warnings.join(" ")}</div>}

      {items.map((it) => {
        const done = it.state === "applied";
        const needsReason = it.status === "on_hold" || it.status === "rework";
        return (
          <div key={it.key} style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 8, opacity: done ? 0.7 : 1 }}>
            <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 700 }}>
                <input type="checkbox" checked={it.include} disabled={done || applying} onChange={(e) => setItem(it.key, { include: e.target.checked })} />
                {it.stage} → {STATUS_LABEL[it.status]}
              </label>
              {done && <span className="badge VERIFIED">Saved</span>}
              {!done && it.confidence < LOW_CONFIDENCE && <span className="badge REVISION">Please check</span>}
            </div>
            {it.evidence && <div className="sub">“{it.evidence}”</div>}
            <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
              <div className="field"><label>Qty done</label>
                <input type="number" min="0" value={it.quantity_completed ?? ""} disabled={done || applying}
                  onChange={(e) => setItem(it.key, { quantity_completed: e.target.value === "" ? null : Number(e.target.value) })} /></div>
              <div className="field"><label>Qty pending</label>
                <input type="number" min="0" value={it.quantity_pending ?? ""} disabled={done || applying}
                  onChange={(e) => setItem(it.key, { quantity_pending: e.target.value === "" ? null : Number(e.target.value) })} /></div>
              <div className="field full"><label>Note</label>
                <input value={it.note || ""} disabled={done || applying} onChange={(e) => setItem(it.key, { note: e.target.value })} /></div>
              {needsReason && (
                <div className="field full" style={!(it.delay_reason || "").trim() && !done ? { borderLeft: "3px solid var(--gold, #b8860b)", paddingLeft: 8 } : undefined}>
                  <label>Reason *</label>
                  <input value={it.delay_reason || ""} disabled={done || applying} onChange={(e) => setItem(it.key, { delay_reason: e.target.value })} /></div>
              )}
            </div>
            {it.error && <div className="msg error">{it.error}</div>}
          </div>
        );
      })}
      {items.length > 0 && (
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-primary" disabled={applying || pending === 0} onClick={apply}>
            {applying ? "Saving…" : `Save ${pending} update${pending === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
    </div>
  );
}
