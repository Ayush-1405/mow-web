import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listProjects, factoryAiSubmit, FACTORY_AI_ALLOWED_EXTS, FACTORY_AI_MAX_FILE_MB, FACTORY_AI_MAX_FILES } from "../../lib/interiorApi";

const PRIORITIES = ["Normal", "High", "Urgent", "Emergency"];

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

// The minimum "Send to Factory" form (any department): project, short
// instruction, file(s), required date, priority. Everything else -- source
// department, sender, customer, project code, site, lead executive, time --
// is filled from the logged-in user and the selected project, never typed.
// AI extraction, the draft Factory Request and review all happen after this.
export default function FactoryAiIntake({ lang, profile, lookups }) {
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [requiredDate, setRequiredDate] = useState("");
  const [priority, setPriority] = useState("Normal");
  const [files, setFiles] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState(null);
  const [sent, setSent] = useState(null);
  // One key per form session: a retry (double-click, flaky network) reuses it,
  // so the server returns the same request instead of creating a second one.
  const idemKey = useRef(crypto.randomUUID());

  useEffect(() => {
    let active = true;
    listProjects().then(({ data }) => { if (active) setProjects(data || []); });
    return () => { active = false; };
  }, []);

  const project = useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId]);
  const deptName = useMemo(() => {
    const d = (lookups?.departments || []).find((x) => x.id === profile?.department_id);
    return d ? (lang === "gu" ? d.name_gu : d.name_en) || d.name_en : "—";
  }, [lookups, profile, lang]);

  function onPickFiles(e) {
    const picked = Array.from(e.target.files || []);
    setMsg(null);
    if (picked.length > FACTORY_AI_MAX_FILES) { setMsg({ type: "error", text: `Please attach at most ${FACTORY_AI_MAX_FILES} files.` }); return; }
    for (const f of picked) {
      if (!FACTORY_AI_ALLOWED_EXTS.includes(extOf(f.name))) { setMsg({ type: "error", text: `"${f.name}" is not a supported file type.` }); return; }
      if (f.size > FACTORY_AI_MAX_FILE_MB * 1024 * 1024) { setMsg({ type: "error", text: `"${f.name}" is larger than ${FACTORY_AI_MAX_FILE_MB} MB.` }); return; }
    }
    setFiles(picked);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setMsg(null);
    if (!title.trim() && files.length === 0) {
      setMsg({ type: "error", text: "Please enter a short instruction or attach a file." });
      return;
    }
    setSubmitting(true);
    const res = await factoryAiSubmit({
      idempotencyKey: idemKey.current, projectId: projectId || null,
      workTitle: title.trim() || files[0]?.name || "Factory request",
      requiredDate: requiredDate || null, priority, files,
    });
    setSubmitting(false);
    if (res.error && res.step !== "extract") {
      console.error("[FactoryAiIntake] submit failed at", res.step, res.error);
      setMsg({ type: "error", text: res.step === "upload" ? "A file could not be uploaded. Please try again." : "Could not send to Factory. Please try again." });
      return;
    }
    if (res.error) console.error("[FactoryAiIntake] extraction trigger failed", res.error);
    idemKey.current = crypto.randomUUID();
    setTitle(""); setFiles([]); setRequiredDate(""); setPriority("Normal");
    setSent({ jobId: res.jobId, number: res.jobNumber || res.requestNumber });
    setMsg({
      type: "success",
      text: res.error
        ? `Sent to Factory as Job Card ${res.jobNumber || res.requestNumber}. Automatic reading is not available right now, so the Factory team will check the details themselves.`
        : `Sent to Factory as Job Card ${res.jobNumber || res.requestNumber}. Details are being read automatically — the Factory Head will verify them.`,
    });
  }

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🏭</div>
        <div className="dept-header-text">
          <h1>Send to Factory</h1>
          <div className="sub">Give a short instruction or upload a file. Factory reads it and prepares the job for review — no re-typing.</div>
        </div>
      </div>

      <form className="card" onSubmit={handleSubmit}>
        <div className="form-grid">
          <div className="field"><label>Project / Site</label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={submitting}>
              <option value="">— No project —</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.project_code} — {p.customer}</option>)}
            </select>
          </div>
          <div className="field"><label>Required Date</label>
            <input type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} disabled={submitting} />
          </div>
          <div className="field full"><label>Work title or short instruction</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 3-door wardrobe for master bedroom" disabled={submitting} />
          </div>
          <div className="field full"><label>Upload File / Photo / Excel / Document</label>
            <input type="file" multiple accept={FACTORY_AI_ALLOWED_EXTS.map((x) => `.${x}`).join(",")} onChange={onPickFiles} disabled={submitting} />
            <div className="sub" style={{ marginTop: 4 }}>
              Excel, CSV, PDF, Word, JPG, PNG, WEBP — up to {FACTORY_AI_MAX_FILES} files, {FACTORY_AI_MAX_FILE_MB} MB each.
              {files.length > 0 && ` Selected: ${files.map((f) => f.name).join(", ")}`}
            </div>
          </div>
          <div className="field"><label>Priority</label>
            <select value={priority} onChange={(e) => setPriority(e.target.value)} disabled={submitting}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>

        <div className="sub" style={{ marginTop: 10 }}>
          From: <strong>{deptName}</strong> · Sender: <strong>{profile?.full_name || "—"}</strong>
          {project && <> · Customer: <strong>{project.customer}</strong> · Site: <strong>{project.location || "—"}</strong></>}
          <br />This goes to the Factory Head / Supervisor for review — you don't choose a Factory employee.
        </div>

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? "Sending…" : "Send to Factory"}</button>
          {msg?.type === "success" && sent?.jobId && <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => navigate(`/factory-job/${sent.jobId}`)}>View Job Card</button>}
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => navigate("/factory-requests")}>My Factory Requests</button>
        </div>
        {msg && <div className={`msg ${msg.type}`} style={{ marginTop: 8 }}>{msg.text}</div>}
      </form>
    </div>
  );
}
