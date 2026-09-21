import React, { useEffect, useMemo, useState } from "react";
import { createFactoryTask, listFactoryLocations, listFactoryStaff, listJobItems, listJobFiles, listProductionStages, searchJobCards } from "../../lib/factoryApi";
import { uploadTaskProof, resolveMimeType } from "../../lib/api";
import { useTaskVoice } from "../../lib/useTaskVoice";
import VoiceRecorder from "../VoiceRecorder.jsx";
import VoiceSubmitStatus from "../../components/VoiceSubmitStatus.jsx";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { detectFileType } from "../TaskDetail.jsx";
import { STATUS, friendlyRpcError, fmtDate } from "./factoryConstants";

const SCOPES = [["job", "Entire Job Card"], ["item", "Specific item"], ["stage", "Specific stage"]];

// Factory Task form -- used from Make Task (Factory Task mode), the Factory
// Tasks page and a Job Card. The Job Card link is OPTIONAL: leave it empty
// for standalone work (maintenance, cleaning, stock check...). Everything is
// validated again inside factory_create_task().
export default function FactoryTaskForm({ lang, lookups, presetJob = null, onCreated, onCancel }) {
  const factoryDept = lookups.departments.find((d) => d.code === "FACTORY");
  const [staff, setStaff] = useState([]);
  const [locations, setLocations] = useState([]);
  const [stages, setStages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [job, setJob] = useState(presetJob);
  const [q, setQ] = useState("");
  const dq = useDebouncedValue(q, 250);
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [items, setItems] = useState([]);
  const [files, setFiles] = useState([]);
  const [scope, setScope] = useState("job");
  const [attach, setAttach] = useState([]);
  // Optional voice instruction: uploaded first, then the task is created, then the recording is linked (see lib/useTaskVoice).
  const tv = useTaskVoice();
  const [voiceKey, setVoiceKey] = useState(0);

  const [f, setF] = useState({
    title: "", description: "", factory_location_id: "", production_department: "", primary_user: "", second_user: "",
    priority_code: "NORMAL", start_date: "", due_date: "", proof_type_code: "none", requires_acceptance: true,
    item_id: "", stage: "", total_quantity: "",
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  useEffect(() => {
    let active = true;
    (async () => {
      const [s, l, st] = await Promise.all([factoryDept ? listFactoryStaff(factoryDept.id) : { data: [] }, listFactoryLocations(), listProductionStages()]);
      if (!active) return;
      setStaff((s.data || []).filter((u) => u.is_active !== false));
      setLocations(l.data || []);
      setStages(st.data || []);
    })();
    return () => { active = false; };
  }, [factoryDept]);

  // Job Card search: number, source order, customer, project, product/item.
  useEffect(() => {
    if (job || dq.trim().length < 2) { setResults([]); return undefined; }
    let active = true;
    setSearching(true);
    searchJobCards(dq).then(({ data }) => { if (active) { setResults(data); setSearching(false); } });
    return () => { active = false; };
  }, [dq, job]);

  // Selecting a Job Card pulls its context by reference (nothing is copied into the task).
  useEffect(() => {
    if (!job) { setItems([]); setFiles([]); setScope("job"); return undefined; }
    let active = true;
    Promise.all([listJobItems(job.id), listJobFiles(job.id)]).then(([i, fl]) => {
      if (!active) return;
      setItems(i.data || []);
      setFiles(fl.data || []);
    });
    setF((s) => ({ ...s, factory_location_id: s.factory_location_id || job.factory_location_id || "" }));
    return () => { active = false; };
  }, [job]);

  const locName = useMemo(() => locations.find((l) => l.id === (f.factory_location_id || job?.factory_location_id))?.name, [locations, f.factory_location_id, job]);

  function pickScope(next) {
    setScope(next);
    if (next !== "item") set("item_id", "");
    if (next !== "stage") set("stage", "");
  }

  async function submit(e) {
    e?.preventDefault();
    if (busy || tv.busy) return;
    setError(null);
    // Validation only applies before the task exists; once it does, "Retry" just finishes attaching the voice message.
    if (!tv.taskPending) {
      if (!f.title.trim()) return setError("Please enter a task title.");
      if (!f.primary_user) return setError("Please choose the primary assignee.");
      if (f.second_user && f.second_user === f.primary_user) return setError("Primary and second assignee must be different people.");
      if (!f.due_date) return setError("Please choose a due date.");
      if (f.start_date && f.due_date < f.start_date) return setError("Due date cannot be before the start date.");
      if (job && scope === "item" && !f.item_id) return setError("Please choose the item.");
      if (job && scope === "stage" && !f.stage) return setError("Please choose the production stage.");
    }
    const outcome = await tv.submit(async () => {
      const { data, error: err } = await createFactoryTask({
        title: f.title.trim(), description: f.description.trim() || null,
        job_card_id: job?.id || null, job_card_item_id: job && scope === "item" ? f.item_id : null, production_stage: job && scope === "stage" ? f.stage : null,
        factory_location_id: f.factory_location_id || null, production_department: f.production_department.trim() || null,
        primary_user: f.primary_user, second_user: f.second_user || null, priority_code: f.priority_code,
        start_date: f.start_date || null, due_date: f.due_date, proof_type_code: f.proof_type_code, requires_acceptance: f.requires_acceptance,
        total_quantity: f.total_quantity === "" ? null : Number(f.total_quantity),
      });
      if (err || !data?.task_id) {
        console.error("[FactoryTaskForm] create failed", err);
        throw new Error(friendlyRpcError(err, "Could not create the task. Please try again."));
      }
      return data;
    });
    if (!outcome.ok) return; // the status panel explains why; nothing was reset and the recording is still here
    const data = outcome.task;
    setBusy(true);
    // Attachments use the same signed-upload path as every other task attachment.
    let failed = 0;
    for (const file of attach) {
      const fileType = detectFileType(resolveMimeType(file));
      if (!fileType) { failed += 1; continue; }
      try { await uploadTaskProof({ entityType: "task", entityId: data.task_id, file, fileType }); } catch { failed += 1; }
    }
    setBusy(false);
    tv.reset();
    setVoiceKey((k) => k + 1); // remounts the recorder (releases its preview URL) only now that everything succeeded
    onCreated?.({ ...data, attachmentsFailed: failed, voiceAttached: outcome.hadVoice });
  }

  function keepWithoutVoice() {
    const data = tv.keepTaskWithoutVoice();
    setVoiceKey((k) => k + 1);
    onCreated?.({ ...data, attachmentsFailed: 0, voiceAttached: false });
  }
  async function cancelCreatedTask() {
    const res = await tv.cancelCreatedTask();
    if (!res.ok) setError(res.message || "Could not cancel the task.");
  }

  return (
    <form className="fx-form" onSubmit={submit}>
      <fieldset className="fx-fieldset" disabled={busy || tv.busy || tv.taskPending}>
      <div className="field">
        <label>Task title *</label>
        <input value={f.title} onChange={(e) => set("title", e.target.value)} maxLength={200} required />
      </div>

      <div className="field">
        <label>Link Job Card <span className="sub">(optional — leave empty for general Factory work)</span></label>
        {job ? (
          <div className="fx-jobpick">
            <div>
              <b>{job.job_order_number}</b> <span className="fx-tag gold">{STATUS[job.factory_status]?.en || job.factory_status}</span>
              <div className="sub">{[job.customer_name, job.project_code, job.product_item].filter(Boolean).join(" · ")}</div>
            </div>
            {!presetJob && <button type="button" className="btn btn-outline" onClick={() => { setJob(null); setQ(""); }} aria-label="Clear Job Card">✕ Clear</button>}
          </div>
        ) : (
          <>
            <input type="search" placeholder="Search job no., order, customer, project or item…" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
            {searching && <div className="sub">Searching…</div>}
            {results.length > 0 && (
              <ul className="fx-results">
                {results.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => { setJob(r); setResults([]); }}>
                      <b>{r.job_order_number}</b> — {r.customer_name || r.project_code || "—"}
                      <span className="sub"> {r.product_item || ""} · {r.source_reference || r.source_department_name || ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!searching && dq.trim().length >= 2 && results.length === 0 && <div className="sub">No active Job Card matches.</div>}
          </>
        )}
      </div>

      {job && (
        <div className="fx-context">
          <div><span className="k">Job Card</span> {job.job_order_number}</div>
          <div><span className="k">Factory</span> {locName || "—"}</div>
          <div><span className="k">Source</span> {job.source_department_name || "—"}{job.source_reference ? ` · ${job.source_reference}` : ""}</div>
          <div><span className="k">Customer / project</span> {[job.customer_name, job.project_code].filter(Boolean).join(" · ") || "—"}</div>
          <div><span className="k">Product</span> {job.product_item || "—"}</div>
          <div><span className="k">Required by</span> {fmtDate(job.required_date)}</div>
          <div><span className="k">Current stage</span> {job.current_stage || "—"}</div>
          <div><span className="k">Files</span> {files.length ? `${files.length} on the Job Card (open it to view)` : "none yet"}</div>
        </div>
      )}

      {job && (
        <div className="field">
          <label>This task is for</label>
          <div className="fx-seg" role="radiogroup" aria-label="Task scope">
            {SCOPES.map(([k, lbl]) => (
              <button key={k} type="button" role="radio" aria-checked={scope === k} className={scope === k ? "on" : ""} onClick={() => pickScope(k)}>{lbl}</button>
            ))}
          </div>
          {scope === "item" && (
            <select value={f.item_id} onChange={(e) => set("item_id", e.target.value)} aria-label="Job Card item">
              <option value="">Choose item…</option>
              {items.map((i) => <option key={i.id} value={i.id}>{i.line_no}. {i.item_name}{i.quantity ? ` × ${i.quantity}` : ""}</option>)}
            </select>
          )}
          {scope === "stage" && (
            <select value={f.stage} onChange={(e) => set("stage", e.target.value)} aria-label="Production stage">
              <option value="">Choose stage…</option>
              {stages.map((s) => <option key={s.code} value={s.code}>{lang === "gu" ? s.name_gu : s.name_en}</option>)}
            </select>
          )}
        </div>
      )}

      <div className="fx-two">
        <div className="field">
          <label>Factory / location</label>
          <select value={f.factory_location_id} onChange={(e) => set("factory_location_id", e.target.value)}>
            <option value="">—</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Production department / team</label>
          <input value={f.production_department} onChange={(e) => set("production_department", e.target.value)} maxLength={80} placeholder="e.g. Carpentry, Polish" />
        </div>
      </div>

      <div className="fx-two">
        <div className="field">
          <label>Primary assignee *</label>
          <select value={f.primary_user} onChange={(e) => set("primary_user", e.target.value)} required>
            <option value="">Choose…</option>
            {staff.map((u) => <option key={u.id} value={u.id}>{u.full_name} — {u.employee_code}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Second assignee <span className="sub">(optional)</span></label>
          <select value={f.second_user} onChange={(e) => set("second_user", e.target.value)}>
            <option value="">None</option>
            {staff.filter((u) => u.id !== f.primary_user).map((u) => <option key={u.id} value={u.id}>{u.full_name} — {u.employee_code}</option>)}
          </select>
        </div>
      </div>
      {staff.length === 0 && <div className="msg info">No active Factory employees found yet. Create Factory users first, then assign work.</div>}

      <div className="fx-two">
        <div className="field">
          <label>Priority</label>
          <select value={f.priority_code} onChange={(e) => set("priority_code", e.target.value)}>
            {(lookups.priorities || []).map((p) => <option key={p.id} value={p.code}>{lang === "gu" ? p.name_gu : p.name_en}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Quantity <span className="sub">(optional)</span></label>
          <input type="number" min="0" step="any" inputMode="decimal" value={f.total_quantity} onChange={(e) => set("total_quantity", e.target.value)} />
        </div>
      </div>

      <div className="fx-two">
        <div className="field"><label>Start date</label><input type="date" value={f.start_date} onChange={(e) => set("start_date", e.target.value)} /></div>
        <div className="field"><label>Due date *</label><input type="date" value={f.due_date} onChange={(e) => set("due_date", e.target.value)} required /></div>
      </div>

      <div className="field">
        <label>Instruction / notes</label>
        <textarea value={f.description} onChange={(e) => set("description", e.target.value)} maxLength={2000} />
      </div>

      <div className="field">
        <label>Voice instruction <span className="sub">(optional)</span></label>
        <VoiceRecorder key={voiceKey} lang={lang} disabled={busy || tv.busy || tv.taskPending} onRecorded={tv.onRecorded} />
      </div>

      <div className="fx-two">
        <div className="field">
          <label>Proof required <span className="sub">(optional)</span></label>
          <select value={f.proof_type_code} onChange={(e) => set("proof_type_code", e.target.value)}>
            {(lookups.proofTypes || []).map((p) => <option key={p.id} value={p.code}>{lang === "gu" ? p.name_gu : p.name_en}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Acceptance required</label>
          <label className="fx-check"><input type="checkbox" checked={f.requires_acceptance} onChange={(e) => set("requires_acceptance", e.target.checked)} /> Assignee must accept first</label>
        </div>
      </div>

      <div className="field">
        <label>Attachments <span className="sub">(optional)</span></label>
        <input type="file" multiple onChange={(e) => setAttach(Array.from(e.target.files || []))} />
        {attach.length > 0 && <div className="sub">{attach.map((x) => x.name).join(", ")}</div>}
      </div>

      {error && <div className="msg error" role="alert">{error}</div>}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={busy || tv.busy || tv.taskPending}>{busy || tv.busy ? "Creating…" : "Create Factory Task"}</button>
        {onCancel && <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy || tv.busy}>Cancel</button>}
      </div>
      </fieldset>
      <VoiceSubmitStatus lang={lang} tv={tv} onRetry={submit} onKeepWithout={keepWithoutVoice} onCancelTask={cancelCreatedTask} taskLabel={tv.failure?.task?.task_number} />
    </form>
  );
}
