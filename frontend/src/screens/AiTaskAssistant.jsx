import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { aiDraftTasks, aiTaskDraftRecordOutcome, AI_TASK_ALLOWED_EXTS, AI_TASK_MAX_FILES, AI_TASK_MAX_FILE_MB } from "../lib/interiorApi";

const LOW_CONFIDENCE = 0.7;
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];

function extOf(n) { const m = /\.([a-z0-9]+)$/i.exec(n || ""); return m ? m[1].toLowerCase() : ""; }
function rpcMessage(err) {
  const m = err?.message || "";
  if (/authorized|only create tasks|outside your|from your own department|must belong|Invalid|archived|different people/i.test(m)) return m.split("/")[0].trim();
  console.error("[AiTaskAssistant] create failed", err);
  return "Could not create this task. Please check the details and try again.";
}

// Paste a message or upload a document/photo/sheet; Claude drafts the tasks
// (title, department, assignee, due date, project); a person edits and
// confirms. Nothing is created until "Create selected tasks", and every task
// goes through staff_create_task, so normal role/department rules still apply.
export default function AiTaskAssistant({ profile, lookups }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [draft, setDraft] = useState(null); // { draft_id, notes, warnings }
  const [cards, setCards] = useState([]);
  const [depts, setDepts] = useState([]);
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [fromDept, setFromDept] = useState(profile?.department_id || "");
  const [creating, setCreating] = useState(false);

  const loadDirectories = useCallback(async () => {
    const [d, u, p] = await Promise.all([
      supabase.rpc("staff_list_assignable_departments"),
      supabase.rpc("staff_list_assignable_users_all"),
      supabase.rpc("staff_list_interior_project_options"),
    ]);
    setDepts((d.data || []).filter((x) => x.is_active));
    setUsers((u.data || []).filter((x) => x.is_active));
    setProjects(p.data || []);
  }, []);
  useEffect(() => { loadDirectories(); }, [loadDirectories]);

  const interiorId = useMemo(() => depts.find((d) => d.code === "INTERIOR")?.id, [depts]);

  function onPick(e) {
    const picked = Array.from(e.target.files || []);
    setMsg(null);
    if (picked.length > AI_TASK_MAX_FILES) { setMsg({ type: "error", text: `Attach at most ${AI_TASK_MAX_FILES} files.` }); return; }
    for (const f of picked) {
      if (!AI_TASK_ALLOWED_EXTS.includes(extOf(f.name))) { setMsg({ type: "error", text: `"${f.name}" is not a supported file type.` }); return; }
      if (f.size > AI_TASK_MAX_FILE_MB * 1024 * 1024) { setMsg({ type: "error", text: `"${f.name}" is larger than ${AI_TASK_MAX_FILE_MB} MB.` }); return; }
    }
    setFiles(picked);
  }

  async function handleDraft(e) {
    e.preventDefault();
    if (busy) return;
    if (!text.trim() && files.length === 0) { setMsg({ type: "error", text: "Paste a message or attach a file first." }); return; }
    setBusy(true); setMsg(null); setDraft(null); setCards([]);
    const res = await aiDraftTasks({ text, files });
    setBusy(false);
    if (!res?.ok) { setMsg({ type: "error", text: res?.reason || "The AI could not read this. Please create the task manually." }); return; }
    setDraft({ draft_id: res.draft_id, notes: res.notes, warnings: res.warnings || [] });
    setCards((res.tasks || []).map((t, i) => ({ ...t, key: i, include: true, status: "draft", error: null, taskNumber: null })));
    if ((res.tasks || []).length === 0) setMsg({ type: "info", text: res.notes || "No actionable tasks found in this content." });
  }

  const setCard = (key, patch) => setCards((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)));

  async function createSelected() {
    if (creating) return;
    if (!fromDept) { setMsg({ type: "error", text: "Choose the department these tasks are from." }); return; }
    setCreating(true); setMsg(null);
    const createdIds = [];
    for (const c of cards.filter((x) => x.include && x.status !== "created")) {
      if (!c.title.trim() || !c.to_department_id || !c.assigned_to || !c.due_date) {
        setCard(c.key, { status: "error", error: "Needs a title, department, assignee and due date." });
        continue;
      }
      setCard(c.key, { status: "creating", error: null });
      const { data, error } = await supabase.rpc("staff_create_task", {
        p_title: c.title.trim(), p_description: c.description || null, p_task_type_code: c.task_type_code,
        p_priority_code: c.priority_code, p_proof_type_code: "none", p_from_department_id: fromDept,
        p_to_department_id: c.to_department_id, p_assigned_to: c.assigned_to, p_due_date: c.due_date,
        p_due_time: null, p_verifier_id: null, p_reference_number: c.reference_number || null,
        p_requirement_text: null, p_quantity: c.quantity || null, p_second_assignee: null,
        p_project_id: c.to_department_id === interiorId ? c.project_id || null : null,
      });
      if (error) { setCard(c.key, { status: "error", error: rpcMessage(error) }); continue; }
      const row = Array.isArray(data) ? data[0] : data;
      createdIds.push(row.task_id);
      setCard(c.key, { status: "created", taskNumber: row.task_number, taskId: row.task_id, error: null });
    }
    if (draft?.draft_id) {
      const earlier = cards.filter((c) => c.status === "created" && c.taskId).map((c) => c.taskId);
      await aiTaskDraftRecordOutcome(draft.draft_id, [...earlier, ...createdIds], cards.length);
    }
    setCreating(false);
    setMsg({ type: createdIds.length ? "success" : "error", text: createdIds.length ? `${createdIds.length} task${createdIds.length > 1 ? "s" : ""} created.` : "No tasks were created — see the messages on each card." });
  }

  const selectedCount = cards.filter((c) => c.include && c.status !== "created").length;

  return (
    <div>
      <div className="section-title">✨ Draft tasks with AI</div>
      <form className="card" onSubmit={handleDraft}>
        <div className="field full">
          <label>Paste a message, list or instruction</label>
          <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
            placeholder="e.g. Ask Factory to make 2 wardrobes for MOW-109 by 25th, and Accounts to send the advance receipt to the client" />
        </div>
        <div className="field full">
          <label>…or upload a document, sheet or photo</label>
          <input type="file" multiple accept={AI_TASK_ALLOWED_EXTS.map((x) => `.${x}`).join(",")} onChange={onPick} disabled={busy} />
          <div className="sub" style={{ marginTop: 4 }}>
            PDF, Excel/CSV, Word, JPG/PNG/WEBP, text — up to {AI_TASK_MAX_FILES} files, {AI_TASK_MAX_FILE_MB} MB each.{files.length > 0 && ` Selected: ${files.map((f) => f.name).join(", ")}`}
          </div>
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Reading…" : "Draft Tasks with AI"}</button>
        <div className="sub" style={{ marginTop: 6 }}>AI only suggests. You review and confirm before anything is created.</div>
      </form>

      {msg && <div className={`msg ${msg.type}`} style={{ marginTop: 8 }}>{msg.text}</div>}
      {draft?.warnings?.length > 0 && <div className="msg info" style={{ marginTop: 8 }}>{draft.warnings.join(" ")}</div>}

      {cards.length > 0 && (
        <>
          {!profile?.department_id && (
            <div className="card field" style={{ marginTop: 8 }}>
              <label>Tasks are from department *</label>
              <select value={fromDept} onChange={(e) => setFromDept(e.target.value)}>
                <option value="">—</option>
                {depts.map((d) => <option key={d.id} value={d.id}>{d.name_en}</option>)}
              </select>
            </div>
          )}
          {cards.map((c) => {
            const poolUsers = users.filter((u) => !c.to_department_id || u.department_id === c.to_department_id);
            const done = c.status === "created";
            const lowConf = c.confidence < LOW_CONFIDENCE;
            return (
              <div key={c.key} className="card" style={{ marginTop: 8, opacity: done ? 0.7 : 1 }}>
                <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={c.include} disabled={done || creating} onChange={(e) => setCard(c.key, { include: e.target.checked })} />
                    Task {c.key + 1}
                  </label>
                  {done && <span className="badge VERIFIED">Created {c.taskNumber}</span>}
                  {!done && lowConf && <span className="badge REVISION">Please check</span>}
                  {!done && <span className="sub">confidence {Math.round(c.confidence * 100)}%</span>}
                </div>
                <div className="form-grid">
                  <div className="field full"><label>Title *</label>
                    <input value={c.title} maxLength={200} disabled={done || creating} onChange={(e) => setCard(c.key, { title: e.target.value })} /></div>
                  <div className="field full"><label>Description</label>
                    <textarea rows={2} value={c.description || ""} disabled={done || creating} onChange={(e) => setCard(c.key, { description: e.target.value })} /></div>
                  <div className="field" style={!c.to_department_id && !done ? { borderLeft: "3px solid var(--gold, #b8860b)", paddingLeft: 8 } : undefined}>
                    <label>To department *</label>
                    <select value={c.to_department_id || ""} disabled={done || creating}
                      onChange={(e) => setCard(c.key, { to_department_id: e.target.value || null, assigned_to: null, project_id: null })}>
                      <option value="">—</option>
                      {depts.map((d) => <option key={d.id} value={d.id}>{d.name_en}</option>)}
                    </select></div>
                  <div className="field" style={!c.assigned_to && !done ? { borderLeft: "3px solid var(--gold, #b8860b)", paddingLeft: 8 } : undefined}>
                    <label>Assignee *</label>
                    <select value={c.assigned_to || ""} disabled={done || creating} onChange={(e) => setCard(c.key, { assigned_to: e.target.value || null })}>
                      <option value="">—</option>
                      {poolUsers.map((u) => <option key={u.id} value={u.id}>{u.full_name} — {u.employee_code}</option>)}
                    </select></div>
                  <div className="field" style={!c.due_date && !done ? { borderLeft: "3px solid var(--gold, #b8860b)", paddingLeft: 8 } : undefined}>
                    <label>Due date *</label>
                    <input type="date" value={c.due_date || ""} disabled={done || creating} onChange={(e) => setCard(c.key, { due_date: e.target.value || null })} /></div>
                  <div className="field"><label>Priority</label>
                    <select value={c.priority_code} disabled={done || creating} onChange={(e) => setCard(c.key, { priority_code: e.target.value })}>
                      {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select></div>
                  <div className="field"><label>Type</label>
                    <select value={c.task_type_code} disabled={done || creating} onChange={(e) => setCard(c.key, { task_type_code: e.target.value })}>
                      {(lookups?.taskTypes || []).map((tt) => <option key={tt.code} value={tt.code}>{tt.name_en || tt.code}</option>)}
                    </select></div>
                  {c.to_department_id === interiorId && (
                    <div className="field"><label>Project / Site</label>
                      <select value={c.project_id || ""} disabled={done || creating} onChange={(e) => setCard(c.key, { project_id: e.target.value || null })}>
                        <option value="">—</option>
                        {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
                      </select></div>
                  )}
                </div>
                {!done && c.missing?.length > 0 && <div className="sub">AI could not find: {c.missing.join(", ")}</div>}
                {c.error && <div className="msg error" style={{ marginTop: 6 }}>{c.error}</div>}
              </div>
            );
          })}
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-primary" disabled={creating || selectedCount === 0} onClick={createSelected}>
              {creating ? "Creating…" : `Create ${selectedCount} selected task${selectedCount === 1 ? "" : "s"}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
