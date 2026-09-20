import React, { useEffect, useRef, useState } from "react";
import {
  FACTORY_FILE_MAX_MB, FACTORY_FILE_TYPES, addComment, getFileUrl, jobTransition, updateItems, updateStage, uploadJobFile,
} from "../../lib/factoryApi";
import { DRAWING_CATEGORIES, FILE_CATEGORIES, STAGES, fmtDate, fmtDateTime, friendlyRpcError } from "./factoryConstants";

const IMG = ["jpg", "jpeg", "png", "webp"];
const extOf = (n) => (/\.([a-z0-9]+)$/i.exec(n || "")?.[1] || "").toLowerCase();

// ---------- files ----------
export function FileThumb({ file }) {
  const [url, setUrl] = useState(null);
  const isImg = IMG.includes(extOf(file.file_name || file.storage_path));
  useEffect(() => {
    let active = true;
    if (isImg) getFileUrl(file.storage_bucket, file.storage_path).then((r) => { if (active) setUrl(r.url); });
    return () => { active = false; };
  }, [file.storage_bucket, file.storage_path, isImg]);
  if (isImg && url) return <img className="thumb" src={url} alt={file.title || file.file_name || ""} loading="lazy" />;
  return <div className="thumb" aria-hidden="true">{extOf(file.file_name || file.storage_path) === "pdf" ? "📄" : "📎"}</div>;
}

export function FilePreview({ file, onClose }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    getFileUrl(file.storage_bucket, file.storage_path).then((r) => { if (!active) return; if (r.url) setUrl(r.url); else setFailed(true); });
    return () => { active = false; };
  }, [file.storage_bucket, file.storage_path]);
  const ext = extOf(file.file_name || file.storage_path);
  async function download() {
    if (!url) return;
    try {
      const blob = await (await fetch(url)).blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = file.file_name || file.title || "file";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch { window.open(url, "_blank", "noopener,noreferrer"); }
  }
  return (
    <div className="fx-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="task-meta" style={{ justifyContent: "space-between" }}>
          <strong>{file.title || file.file_name}</strong>
          <span className="btn-row" style={{ margin: 0 }}>
            <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={download} disabled={!url}>Download</button>
            <button type="button" className="btn btn-primary" style={{ width: "auto", marginTop: 0 }} onClick={onClose}>Close</button>
          </span>
        </div>
        {!url && !failed && <div className="skeleton-block" style={{ height: 200, marginTop: 8 }} />}
        {failed && <div className="msg error" style={{ marginTop: 8 }}>This file could not be opened.</div>}
        {url && IMG.includes(ext) && <img src={url} alt={file.title || ""} style={{ marginTop: 8 }} />}
        {url && ext === "pdf" && <iframe title={file.title || "PDF"} src={url} style={{ marginTop: 8 }} />}
        {url && !IMG.includes(ext) && ext !== "pdf" && <div className="msg info" style={{ marginTop: 8 }}>Preview is not available for this file type — use Download.</div>}
      </div>
    </div>
  );
}

function FileCard({ f, onOpen }) {
  return (
    <div className="fx-file">
      <FileThumb file={f} />
      <div className="info">
        <div className="t">{f.title || f.file_name}</div>
        <div className="meta" style={{ fontSize: 12, color: "var(--ink-soft)" }}>
          {f.category === "Others" && f.custom_category_name ? f.custom_category_name : f.category} · {f.file_name || "—"}
        </div>
        <div className="meta" style={{ fontSize: 12, color: "var(--ink-soft)" }}>{f.uploader_name || "—"} · {fmtDate(f.uploaded_at)}</div>
        <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 6, minHeight: 40 }} onClick={() => onOpen(f)}>Preview / Download</button>
      </div>
    </div>
  );
}

// Important drawings sit at the top of the Job Card so nobody has to hunt.
export function KeyDrawings({ files, onOpen }) {
  const key = files.filter((f) => DRAWING_CATEGORIES.includes(f.category)).slice(0, 4);
  if (key.length === 0) return null;
  return (
    <section className="fx-section" aria-label="Key drawings">
      <h2>Drawings</h2>
      <div className="fx-strip">{key.map((f) => <FileCard key={f.id} f={f} onOpen={onOpen} />)}</div>
    </section>
  );
}

export function FilesTab({ jobId, files, canUpload, onOpen, onChanged }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState(FILE_CATEGORIES[0]);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const inputRef = useRef(null);

  function pick(e) {
    const f = e.target.files?.[0] || null;
    setMsg(null);
    if (f) {
      if (!FACTORY_FILE_TYPES.includes(extOf(f.name))) { setMsg({ type: "error", text: "This file type is not supported." }); e.target.value = ""; return; }
      if (f.size > FACTORY_FILE_MAX_MB * 1024 * 1024) { setMsg({ type: "error", text: `File is larger than ${FACTORY_FILE_MAX_MB} MB.` }); e.target.value = ""; return; }
    }
    setFile(f);
  }
  async function upload(e) {
    e.preventDefault();
    if (busy) return;
    if (!file) { setMsg({ type: "error", text: "Please choose a file." }); return; }
    setBusy(true); setMsg(null);
    const r = await uploadJobFile(jobId, file, category, title.trim() || file.name);
    setBusy(false);
    if (r.error) { setMsg({ type: "error", text: r.step === "upload" ? "The file could not be uploaded. Please try again." : friendlyRpcError(r.error, "The file could not be saved.") }); return; }
    setFile(null); setTitle(""); if (inputRef.current) inputRef.current.value = "";
    setMsg({ type: "success", text: "File added." });
    onChanged?.();
  }

  return (
    <div>
      {files.length === 0 && <div className="fx-empty">No drawings or files attached yet.</div>}
      <div className="fx-files">{files.map((f) => <FileCard key={f.id} f={f} onOpen={onOpen} />)}</div>
      {canUpload && (
        <form className="fx-section" style={{ marginTop: 10 }} onSubmit={upload}>
          <h2>Add a drawing or photo</h2>
          <div className="form-grid">
            <div className="field"><label>Type</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)} disabled={busy}>{FILE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
            <div className="field"><label>Title (optional)</label><input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} /></div>
            <div className="field full"><label>File</label>
              <input ref={inputRef} type="file" accept={FACTORY_FILE_TYPES.map((x) => `.${x}`).join(",")} onChange={pick} disabled={busy} />
              <div className="sub">JPG, PNG, WEBP, PDF, DWG, DXF, Excel, Word · max {FACTORY_FILE_MAX_MB} MB</div></div>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Add file"}</button>
          {msg && <div className={`msg ${msg.type}`} style={{ marginTop: 8 }}>{msg.text}</div>}
        </form>
      )}
    </div>
  );
}

// ---------- items ----------
const ITEM_FIELDS = [
  ["item_name", "Item / product"], ["product_code", "Product code"], ["quantity", "Quantity"], ["unit", "Unit"],
  ["dimensions", "Dimensions"], ["material", "Material"], ["finish", "Finish / colour"], ["fabric", "Fabric"],
  ["hardware", "Hardware"], ["room_area", "Room / area"], ["instruction", "Manufacturing instruction"],
];

export function ItemsTab({ jobId, items, canEdit, onChanged }) {
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => { if (!edit) setDraft(items.map((i) => ({ ...i }))); }, [items, edit]);
  const setField = (idx, k, v) => setDraft((d) => d.map((x, i) => (i === idx ? { ...x, [k]: v } : x)));

  async function save() {
    setBusy(true); setMsg(null);
    const payload = draft.map((d) => ({ ...(d.id ? { id: d.id } : {}), remove: !!d._remove, item_name: d.item_name, product_code: d.product_code, quantity: d.quantity === "" ? null : d.quantity, unit: d.unit, dimensions: d.dimensions, material: d.material, finish: d.finish, fabric: d.fabric, hardware: d.hardware, room_area: d.room_area, instruction: d.instruction }))
      .filter((d) => !(d.remove && !d.id));
    if (payload.some((d) => !d.remove && !(d.item_name || "").trim())) { setBusy(false); setMsg({ type: "error", text: "Every item needs a name." }); return; }
    const { error } = await updateItems(jobId, payload);
    setBusy(false);
    if (error) { setMsg({ type: "error", text: friendlyRpcError(error, "Items could not be saved.") }); return; }
    setEdit(false); setMsg({ type: "success", text: "Items saved." });
    onChanged?.();
  }

  if (!edit) {
    return (
      <div>
        {items.length === 0 && <div className="fx-empty">No items on this Job Card.</div>}
        {items.map((it, i) => (
          <div key={it.id} className="fx-item">
            <div className="task-meta" style={{ justifyContent: "space-between" }}>
              <strong>{i + 1}. {it.item_name}</strong>
              <span className="fx-tag">{it.quantity ?? "?"} {it.unit || ""}</span>
            </div>
            <div className="grid">
              {ITEM_FIELDS.filter(([k]) => !["item_name", "quantity", "unit"].includes(k)).map(([k, lbl]) => (
                <div key={k} style={k === "instruction" ? { gridColumn: "1 / -1" } : undefined}>
                  <div className="k">{lbl}</div>
                  <div>{it[k] || <span style={{ color: "var(--danger)" }}>—</span>}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {canEdit && <button type="button" className="btn btn-outline" onClick={() => setEdit(true)}>Edit items</button>}
        {msg && <div className={`msg ${msg.type}`} style={{ marginTop: 8 }}>{msg.text}</div>}
      </div>
    );
  }
  return (
    <div>
      {draft.map((it, idx) => it._remove ? null : (
        <div key={it.id || `new-${idx}`} className="fx-item">
          <div className="form-grid">
            {ITEM_FIELDS.map(([k, lbl]) => (
              <div key={k} className={`field${k === "instruction" ? " full" : ""}`}>
                <label>{lbl}{k === "item_name" ? " *" : ""}</label>
                {k === "instruction"
                  ? <textarea rows={2} value={it[k] || ""} onChange={(e) => setField(idx, k, e.target.value)} disabled={busy} />
                  : <input type={k === "quantity" ? "number" : "text"} min={k === "quantity" ? "0" : undefined} value={it[k] ?? ""} onChange={(e) => setField(idx, k, e.target.value)} disabled={busy} />}
              </div>
            ))}
          </div>
          {draft.filter((d) => !d._remove).length > 1 && (
            <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setField(idx, "_remove", true)} disabled={busy}>Remove item</button>
          )}
        </div>
      ))}
      <div className="btn-row">
        <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={busy} onClick={() => setDraft((d) => [...d, { item_name: "", quantity: "", unit: "" }])}>+ Add item</button>
        <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save items"}</button>
        <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={busy} onClick={() => { setEdit(false); setMsg(null); }}>Cancel</button>
      </div>
      {msg && <div className={`msg ${msg.type}`} style={{ marginTop: 8 }}>{msg.text}</div>}
    </div>
  );
}

// ---------- verification ----------
// Generated from the data already on the card -- nothing to retype. Only
// missing/unclear checks are listed unless "Show all" is switched on.
export function VerificationTab({ job, items, files, onGoItems, onGoFiles }) {
  const [all, setAll] = useState(false);
  const returned = job.factory_status === "needs_clarification";
  const every = (k) => items.length > 0 && items.every((i) => i[k] !== null && i[k] !== undefined && String(i[k]).trim() !== "");
  const qtyOk = items.length > 0 && items.every((i) => Number(i.quantity) > 0);
  const missingNames = (k) => items.filter((i) => !i[k] || String(i[k]).trim() === "").map((i) => i.item_name).slice(0, 3).join(", ");
  const checks = [
    { key: "items", label: "Product / item details available", ok: items.length > 0, detail: "No items on this Job Card", go: onGoItems },
    { key: "qty", label: "Quantity confirmed", ok: qtyOk, detail: qtyOk ? "" : `Quantity missing: ${items.filter((i) => !(Number(i.quantity) > 0)).map((i) => i.item_name).slice(0, 3).join(", ") || "—"}`, go: onGoItems },
    { key: "dims", label: "Dimensions available", ok: every("dimensions"), detail: `Missing for: ${missingNames("dimensions")}`, go: onGoItems },
    { key: "mat", label: "Material specification available", ok: every("material"), detail: `Missing for: ${missingNames("material")}`, go: onGoItems },
    { key: "fin", label: "Finish available", ok: every("finish"), detail: `Missing for: ${missingNames("finish")}`, go: onGoItems },
    { key: "dwg", label: "Drawing attached", ok: files.some((f) => DRAWING_CATEGORIES.includes(f.category)), detail: "No production drawing attached", go: onGoFiles },
    { key: "date", label: "Required date available", ok: !!job.required_date, detail: "No required date", go: null },
    { key: "site", label: "Site / delivery details available", ok: !!(job.site_location || job.customer_name), detail: "No site or customer details", go: null },
  ];
  const problems = checks.filter((c) => !c.ok);
  const shown = all ? checks : problems;
  return (
    <div>
      {problems.length === 0
        ? <div className="msg success">All {checks.length} checks are verified. This Job Card is ready to accept.</div>
        : <div className="msg info">{checks.length - problems.length} of {checks.length} checks verified. {problems.length} need attention.</div>}
      {shown.map((c) => (
        <div key={c.key} className="fx-check">
          <span className={`st ${c.ok ? "ok" : returned ? "clar" : "miss"}`}>{c.ok ? "Verified" : returned ? "Needs Clarification" : "Missing"}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700 }}>{c.label}</div>
            {!c.ok && <div className="sub">{c.detail}</div>}
          </div>
          {!c.ok && c.go && <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0, minHeight: 40 }} onClick={c.go}>Fix</button>}
        </div>
      ))}
      <button type="button" className="btn btn-outline" onClick={() => setAll((v) => !v)}>{all ? "Show only what needs attention" : "Show all checks"}</button>
    </div>
  );
}

// ---------- assignment ----------
export function AssignmentTab({ job, people, canAssign, onDone }) {
  const open = ["accepted", "assigned", "in_production", "blocked"].includes(job.factory_status);
  const [primary, setPrimary] = useState(job.assigned_factory_coordinator || "");
  const [second, setSecond] = useState(job.second_assignee_coordinator || "");
  const [start, setStart] = useState(job.planned_start || "");
  const [end, setEnd] = useState(job.expected_end || "");
  const [dept, setDept] = useState(job.production_department || "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function assign(e) {
    e.preventDefault();
    if (busy) return;
    if (!primary) { setMsg({ type: "error", text: "Please choose the primary responsible person." }); return; }
    setBusy(true); setMsg(null);
    const { error } = await jobTransition(job.id, "assign", null, { primary_profile_id: primary, second_profile_id: second || null, planned_start: start || null, expected_end: end || null, production_department: dept || null });
    setBusy(false);
    if (error) { setMsg({ type: "error", text: friendlyRpcError(error) }); return; }
    setMsg({ type: "success", text: "Assignment saved." });
    onDone?.();
  }

  return (
    <div>
      <div className="fx-kv">
        <div><div className="k">Primary responsible</div><div className="v">{job.assigned_name || "Not assigned"}</div></div>
        <div><div className="k">Second assignee</div><div className="v">{job.second_name || "—"}</div></div>
        <div><div className="k">Production department</div><div className="v">{job.production_department || "—"}</div></div>
        <div><div className="k">Planned start</div><div className="v">{fmtDate(job.planned_start)}</div></div>
        <div><div className="k">Expected completion</div><div className="v">{fmtDate(job.expected_end)}</div></div>
      </div>
      {!canAssign && <div className="msg info" style={{ marginTop: 10 }}>Only the Factory Head, Admin or Supervisor can assign work.</div>}
      {canAssign && !open && <div className="msg info" style={{ marginTop: 10 }}>Accept the Job Card first — then you can assign it.</div>}
      {canAssign && open && (
        <form onSubmit={assign} style={{ marginTop: 10 }}>
          {people.length === 0 && <div className="msg error">No active Factory employees were found. Ask an administrator to create Factory staff accounts, then try again.</div>}
          <div className="form-grid">
            <div className="field"><label>Primary responsible *</label>
              <select value={primary} onChange={(e) => setPrimary(e.target.value)} disabled={busy}>
                <option value="">—</option>{people.map((p) => <option key={p.profile_id} value={p.profile_id}>{p.name} — {p.employee_code || "—"}</option>)}
              </select></div>
            <div className="field"><label>Second assignee (optional)</label>
              <select value={second} onChange={(e) => setSecond(e.target.value)} disabled={busy}>
                <option value="">—</option>{people.filter((p) => p.profile_id !== primary).map((p) => <option key={p.profile_id} value={p.profile_id}>{p.name} — {p.employee_code || "—"}</option>)}
              </select></div>
            <div className="field"><label>Production department / team</label>
              <input list="fx-depts" value={dept} onChange={(e) => setDept(e.target.value)} disabled={busy} placeholder="e.g. Carpentry" />
              <datalist id="fx-depts">{["Carpentry", "Cutting", "CNC", "Polishing/Painting", "Upholstery", "Assembly", "Packing"].map((d) => <option key={d} value={d} />)}</datalist></div>
            <div className="field"><label>Planned start</label><input type="date" value={start} onChange={(e) => setStart(e.target.value)} disabled={busy} /></div>
            <div className="field"><label>Expected completion</label><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} disabled={busy} /></div>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || people.length === 0}>{busy ? "Saving…" : job.assigned_name ? "Update assignment" : "Assign"}</button>
        </form>
      )}
      {msg && <div className={`msg ${msg.type}`} style={{ marginTop: 8 }}>{msg.text}</div>}
    </div>
  );
}

// ---------- activity ----------
const EVENT_LABEL = {
  submitted: "Request submitted", job_card_generated: "Job Card generated", file_added: "File uploaded", accept: "Accepted",
  return: "Returned for clarification", resubmit: "Re-submitted after correction", assign: "Assignment changed", start: "Production started",
  block: "Marked blocked", unblock: "Unblocked", mark_ready: "Marked ready for review", complete: "Completion confirmed",
  cancel: "Cancelled", reopen: "Reopened", progress_update: "Progress update", comment: "Comment added", items_updated: "Items updated",
  details_updated: "Details updated", priority_changed: "Priority changed", ai_extracted: "Read by AI", ai_failed: "AI could not read the file",
};

export function ActivityTab({ jobId, events, canComment, onChanged }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  async function post(e) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true); setMsg(null);
    const { error } = await addComment(jobId, text);
    setBusy(false);
    if (error) { setMsg({ type: "error", text: friendlyRpcError(error) }); return; }
    setText(""); onChanged?.();
  }
  return (
    <div>
      {canComment && (
        <form onSubmit={post} style={{ marginBottom: 12 }}>
          <div className="field"><label>Add a comment</label><textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} /></div>
          <button type="submit" className="btn btn-outline" style={{ width: "auto" }} disabled={busy || !text.trim()}>{busy ? "Posting…" : "Post comment"}</button>
          {msg && <div className={`msg ${msg.type}`} style={{ marginTop: 8 }}>{msg.text}</div>}
        </form>
      )}
      {events.length === 0 && <div className="fx-empty">No activity yet.</div>}
      <div className="fx-timeline">
        {events.map((e) => (
          <div key={e.id} className="ev">
            <div className="t">{EVENT_LABEL[e.event_type] || e.event_type}</div>
            {e.note && <div className="m">{e.note}</div>}
            <div className="m">{e.actor_name || "System"} · {fmtDateTime(e.created_at)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- one-tap production update ----------
export function ProductionUpdate({ job, isManager, onDone }) {
  const [stage, setStage] = useState(STAGES.includes(job.current_stage) ? job.current_stage : STAGES[0]);
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState(null);
  const [blocker, setBlocker] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);
  const blocked = job.factory_status === "blocked";

  async function submit(status) {
    if (busy) return;
    if (status === "completed" && !photo && !isManager) { setMsg({ type: "error", text: "Please add a proof photo to mark this stage complete." }); return; }
    setBusy(true); setMsg(null);
    if (photo) {
      const r = await uploadJobFile(job.id, photo, "Reference Photo", `Proof: ${stage}`, note || null);
      if (r.error) { setBusy(false); setMsg({ type: "error", text: r.step === "upload" ? "The photo could not be uploaded. Please try again." : friendlyRpcError(r.error, "The photo could not be saved.") }); return; }
    }
    const { error } = await updateStage(job.id, stage, status, { quantity: qty === "" ? null : Number(qty), notes: note });
    setBusy(false);
    if (error) { setMsg({ type: "error", text: friendlyRpcError(error) }); return; }
    setQty(""); setNote(""); setPhoto(null); if (fileRef.current) fileRef.current.value = "";
    setMsg({ type: "success", text: status === "completed" ? "Stage marked complete." : "Progress saved." });
    onDone?.();
  }
  async function block() {
    if (!reason.trim()) { setMsg({ type: "error", text: "Please give the reason it is blocked." }); return; }
    setBusy(true); setMsg(null);
    const { error } = await jobTransition(job.id, "block", reason);
    setBusy(false);
    if (error) { setMsg({ type: "error", text: friendlyRpcError(error) }); return; }
    setBlocker(false); setReason(""); onDone?.();
  }

  return (
    <section className="fx-section" aria-label="Production update">
      <h2>Update production</h2>
      {blocked && <div className="msg error">Blocked: {job.blocked_reason || "—"}</div>}
      <div className="form-grid">
        <div className="field"><label>Current stage</label>
          <select value={stage} onChange={(e) => setStage(e.target.value)} disabled={busy}>{STAGES.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        <div className="field"><label>Produced quantity</label>
          <input type="number" min="0" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} disabled={busy} placeholder={job.total_qty ? `of ${job.total_qty}` : ""} /></div>
        <div className="field full"><label>Note (optional)</label><input value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} /></div>
        <div className="field full"><label>Proof photo{isManager ? " (optional)" : " (needed to complete a stage)"}</label>
          <input ref={fileRef} type="file" accept=".jpg,.jpeg,.png,.webp" capture="environment" onChange={(e) => setPhoto(e.target.files?.[0] || null)} disabled={busy} /></div>
      </div>
      <div className="fx-bigbtns">
        <button type="button" className="btn btn-primary" disabled={busy || blocked} onClick={() => submit("in_progress")}>{busy ? "Saving…" : "Save progress"}</button>
        <button type="button" className="btn btn-gold" disabled={busy || blocked} onClick={() => submit("completed")}>Stage complete</button>
        {!blocked && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setBlocker((v) => !v)}>Report blocker</button>}
      </div>
      {blocker && (
        <div className="field" style={{ marginTop: 8 }}>
          <label>What is blocking the work? *</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy || !reason.trim()} onClick={block}>Mark blocked</button>
        </div>
      )}
      {msg && <div className={`msg ${msg.type}`} style={{ marginTop: 8 }}>{msg.text}</div>}
    </section>
  );
}

