import React, { useCallback, useEffect, useMemo, useState } from "react";
import { subscribeTable } from "../../lib/realtime";
import {
  listFactoryAiRequests, getFactoryAiRequest, listFactoryAiAttachments, getFactoryAiFileUrl,
  factoryAiCorrect, factoryAiAccept, factoryAiReject, factoryAiRequestClarification, factoryAiRunExtraction,
  listInteriorPeople,
} from "../../lib/interiorApi";

const LOW_CONFIDENCE = 0.7;
const FILTERS = [
  ["review", "Ready to Review"],
  ["failed", "Needs Manual Review"],
  ["processing", "Processing"],
  ["accepted", "Accepted"],
  ["rejected", "Rejected"],
  ["all", "All"],
];
const STATUS_LABEL = {
  uploaded: "Uploaded", processing: "Processing", extracted: "Extracted", needs_review: "Ready to Review",
  accepted: "Accepted", rejected: "Rejected", failed: "Needs Manual Review",
};
const STATUS_BADGE = { needs_review: "ASSIGNED", accepted: "VERIFIED", rejected: "RETURNED", failed: "REVISION", processing: "IN_PROGRESS", uploaded: "CLOSED", extracted: "ASSIGNED" };
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp"];

function extOf(n) { const m = /\.([a-z0-9]+)$/i.exec(n || ""); return m ? m[1].toLowerCase() : ""; }
function friendly(err, fallback) {
  const m = err?.message || "";
  if (/not authorized/i.test(m)) return "You do not have permission to do this.";
  if (/no longer open|already been decided|already rejected/i.test(m)) return "This request has already been decided.";
  if (/no linked staff login/i.test(m)) return "That coordinator has no staff login yet. Please pick someone else.";
  if (/coordinator is required/i.test(m)) return "Please choose a Factory Coordinator.";
  if (/archived/i.test(m)) return "This project is archived and cannot receive new work.";
  console.error("[FactoryAiInbox]", err);
  return fallback;
}

function SourceFile({ att }) {
  const [url, setUrl] = useState(null);
  const isImage = IMAGE_EXTS.includes(extOf(att.original_file_name));
  useEffect(() => {
    let active = true;
    getFactoryAiFileUrl(att.storage_path).then((r) => { if (active) setUrl(r.url); });
    return () => { active = false; };
  }, [att.storage_path]);
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="sub" style={{ fontWeight: 700 }}>{att.original_file_name}</div>
      {isImage && url && <img src={url} alt={att.original_file_name} style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid var(--border)" }} />}
      {!isImage && extOf(att.original_file_name) === "pdf" && url && (
        <iframe title={att.original_file_name} src={url} style={{ width: "100%", height: 360, border: "1px solid var(--border)", borderRadius: 8 }} />
      )}
      {url && <a className="btn btn-outline" style={{ width: "auto", marginTop: 6, display: "inline-block" }} href={url} target="_blank" rel="noopener noreferrer">Open / Download</a>}
    </div>
  );
}

function Detail({ id, canReview, factoryPeople, onClose, onChanged }) {
  const [req, setReq] = useState(null);
  const [atts, setAtts] = useState([]);
  const [edit, setEdit] = useState({});
  const [coordinator, setCoordinator] = useState("");
  const [second, setSecond] = useState("");
  const [mode, setMode] = useState(null); // 'reject' | 'clarify'
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    const [{ data: r }, { data: a }] = await Promise.all([getFactoryAiRequest(id), listFactoryAiAttachments(id)]);
    setReq(r || null);
    setAtts(a || []);
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable(`factory-ai-detail-${id}`, "factory_ai_requests", `id=eq.${id}`, load), [id, load]);

  // AI result with human corrections layered on top -- never mutates ai_extraction.
  const merged = useMemo(() => ({ ...(req?.ai_extraction || {}), ...(req?.verified_extraction || {}) }), [req]);
  const conf = req?.ai_extraction?.confidence?.fields || {};
  const missing = req?.ai_extraction?.missing_information || [];
  const open = req && ["needs_review", "extracted", "failed", "uploaded"].includes(req.status);

  const fields = [
    { key: "work_title", label: "Work / Product", type: "text", value: merged.work_title ?? req?.work_title ?? "" },
    { key: "quantity", label: "Quantity", type: "number", value: merged.quantity ?? "" },
    { key: "unit", label: "Unit", type: "text", value: merged.unit ?? "" },
    { key: "required_date", label: "Required Date", type: "date", value: merged.required_date ?? req?.required_date ?? "" },
  ];
  const isLow = (f) => {
    const empty = f.value === "" || f.value == null;
    const c = conf[f.key];
    const mentioned = missing.some((m) => m.toLowerCase().includes(f.label.toLowerCase().split(" ")[0]) || m.toLowerCase().includes(f.key.replace("_", " ")));
    return req?.ai_extraction ? empty || (typeof c === "number" && c < LOW_CONFIDENCE) || mentioned : empty;
  };
  const flagged = fields.filter(isLow);
  const extractedCount = fields.filter((f) => f.value !== "" && f.value != null).length + (merged.product_items?.length || 0);
  const val = (f) => (f.key in edit ? edit[f.key] : f.value ?? "");

  async function saveEditsIfAny() {
    const patch = {};
    for (const f of fields) {
      if (!(f.key in edit)) continue;
      patch[f.key] = f.type === "number" ? (edit[f.key] === "" ? null : Number(edit[f.key])) : (edit[f.key] === "" ? null : edit[f.key]);
    }
    if (Object.keys(patch).length === 0) return null;
    const { error } = await factoryAiCorrect(id, patch);
    if (!error) setEdit({});
    return error;
  }

  async function run(fn, okText) {
    setBusy(true); setMsg(null);
    const err = await fn();
    setBusy(false);
    if (err) { setMsg({ type: "error", text: friendly(err, "Something went wrong. Please try again.") }); return false; }
    if (okText) setMsg({ type: "success", text: okText });
    await load(); onChanged();
    return true;
  }

  const accept = () => run(async () => {
    if (!coordinator) return { message: "coordinator is required" };
    const e1 = await saveEditsIfAny();
    if (e1) return e1;
    const m = { ...merged };
    const { data, error } = await factoryAiAccept(id, {
      coordinatorProfileId: coordinator, secondAssigneeProfileId: second || null,
      productItem: m.work_title || req.work_title, quantity: m.quantity, unit: m.unit, requiredDate: m.required_date || req.required_date,
    });
    if (error) return error;
    const row = Array.isArray(data) ? data[0] : data;
    setMsg({ type: "success", text: `Job ${row.job_order_number} ${row.already_accepted ? "already exists" : "created"}.` });
    return null;
  });

  if (!req) return <div className="card"><div className="skeleton-block" style={{ height: 120 }} /></div>;

  return (
    <div className="card">
      <div className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700 }}>{req.request_number} · {req.work_title}</span>
        <span className={`badge ${STATUS_BADGE[req.status] || "CLOSED"}`}>{STATUS_LABEL[req.status] || req.status}</span>
        <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={onClose}>Close</button>
      </div>
      <div className="sub">
        From {req.departments?.name_en || "—"} · {req.priority}
        {req.projects && <> · {req.projects.project_code} — {req.projects.customer} ({req.projects.location || "—"})</>}
        {req.ai_served_from_cache && " · reused from an identical earlier file"}
      </div>

      {req.status === "failed" && (
        <div className="msg error" style={{ marginTop: 8 }}>
          Automatic reading did not complete ({req.ai_failure_reason || "unknown reason"}). Your original file is safe — enter the details below manually, or retry.
          {canReview && <button type="button" className="btn btn-outline" style={{ width: "auto", marginLeft: 8 }} disabled={busy}
            onClick={() => run(async () => (await factoryAiRunExtraction(id)).error, "Retry started.")}>Retry Extraction</button>}
        </div>
      )}
      {req.clarification_note && <div className="msg info" style={{ marginTop: 8 }}>Clarification asked: {req.clarification_note}</div>}
      {req.status === "rejected" && <div className="msg error" style={{ marginTop: 8 }}>Rejected: {req.rejection_reason}</div>}

      <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", marginTop: 10 }}>
        <div>
          <h3 style={{ marginTop: 0 }}>Original document</h3>
          {atts.length === 0 && <div className="msg info">No file attached — instruction only.</div>}
          {atts.map((a) => <SourceFile key={a.id} att={a} />)}
        </div>

        <div>
          <h3 style={{ marginTop: 0 }}>Draft Job Card</h3>
          {req.ai_extraction && (
            <div className="msg info">
              AI extracted {extractedCount} fields.{flagged.length > 0 ? ` Please verify ${flagged.length} highlighted field${flagged.length > 1 ? "s" : ""}.` : " Nothing needs attention."}
              {typeof req.ai_confidence_overall === "number" && ` (overall confidence ${Math.round(req.ai_confidence_overall * 100)}%)`}
            </div>
          )}
          {fields.map((f) => {
            const low = isLow(f);
            // High-confidence fields collapse to a read-only line; only flagged ones open for editing.
            if (!low && !(f.key in edit)) {
              return (
                <div key={f.key} className="sub" style={{ padding: "3px 0" }}>
                  {f.label}: <strong>{String(f.value)}</strong>
                  {canReview && open && <button type="button" className="btn btn-outline" style={{ width: "auto", marginLeft: 8, padding: "0 8px", marginTop: 0 }} onClick={() => setEdit((e) => ({ ...e, [f.key]: f.value }))}>Edit</button>}
                </div>
              );
            }
            return (
              <div key={f.key} className="field" style={low ? { borderLeft: "3px solid var(--gold, #b8860b)", paddingLeft: 8 } : undefined}>
                <label>{f.label}{low && " — please verify"}</label>
                <input type={f.type} value={val(f)} disabled={!canReview || !open}
                  onChange={(e) => setEdit((x) => ({ ...x, [f.key]: e.target.value }))} />
              </div>
            );
          })}

          {(merged.product_items || []).length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="report-table" style={{ width: "100%", fontSize: 13 }}>
                <thead><tr><th>Item</th><th>Room</th><th>Qty</th><th>Size</th><th>Material</th><th>Finish</th></tr></thead>
                <tbody>
                  {merged.product_items.map((it, i) => (
                    <tr key={i}><td>{it.item_name || "—"}</td><td>{it.room_area || "—"}</td><td>{it.quantity ?? "—"} {it.unit || ""}</td><td>{it.dimensions || "—"}</td><td>{it.material || "—"}</td><td>{it.finish || "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {missing.length > 0 && <div className="msg info" style={{ marginTop: 6 }}>Missing: {missing.join("; ")}</div>}
          {(req.ai_extraction?.warnings || []).length > 0 && <div className="msg error" style={{ marginTop: 6 }}>Check: {req.ai_extraction.warnings.join("; ")}</div>}
          {(merged.suggested_factory_stages || []).length > 0 && <div className="sub" style={{ marginTop: 6 }}>Suggested stages: {merged.suggested_factory_stages.join(" → ")}</div>}
        </div>
      </div>

      {canReview && open && (
        <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <div className="form-grid">
            <div className="field"><label>Factory Coordinator *</label>
              <select value={coordinator} onChange={(e) => setCoordinator(e.target.value)} disabled={busy}>
                <option value="">—</option>
                {factoryPeople.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.employee_code || "—"}</option>)}
              </select>
            </div>
            <div className="field"><label>Second Assignee (optional)</label>
              <select value={second} onChange={(e) => setSecond(e.target.value)} disabled={busy}>
                <option value="">—</option>
                {factoryPeople.filter((p) => p.id !== coordinator).map((p) => <option key={p.id} value={p.id}>{p.name} — {p.employee_code || "—"}</option>)}
              </select>
            </div>
          </div>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={accept}>{busy ? "Working…" : "Accept & Create Job"}</button>
            <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={busy} onClick={() => run(async () => saveEditsIfAny(), "Corrections saved.")}>Save Corrections</button>
            <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={busy} onClick={() => { setMode("clarify"); setNote(""); }}>Request Clarification</button>
            <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={busy} onClick={() => { setMode("reject"); setNote(""); }}>Reject</button>
          </div>
          {mode && (
            <div className="field" style={{ marginTop: 8 }}>
              <label>{mode === "reject" ? "Reason for rejection *" : "What needs clarification? *"}</label>
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="btn-row" style={{ marginTop: 6 }}>
                <button type="button" className="btn btn-primary" disabled={busy || !note.trim()} onClick={async () => {
                  const ok = await run(async () => (mode === "reject" ? (await factoryAiReject(id, note.trim())).error : (await factoryAiRequestClarification(id, note.trim())).error),
                    mode === "reject" ? "Request rejected." : "Clarification sent to the requester.");
                  if (ok) setMode(null);
                }}>{mode === "reject" ? "Confirm Reject" : "Send Clarification"}</button>
                <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setMode(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
      {msg && <div className={`msg ${msg.type}`} style={{ marginTop: 8 }}>{msg.text}</div>}
    </div>
  );
}

// AI Factory Inbox: every request sent to Factory, newest first, with the
// verification panel beneath. Head/Supervisor/Admin can accept/correct/
// reject/clarify; a sender sees only their own requests read-only.
export default function FactoryAiInbox({ profile, lookups }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("review");
  const [selected, setSelected] = useState(null);
  const [people, setPeople] = useState([]);

  const factoryDeptId = (lookups?.departments || []).find((d) => d.code === "FACTORY")?.id;
  const canReview = !!(profile?.isManagement || profile?.isSuperAdmin
    || (["dept_head", "supervisor"].includes(profile?.roleCode) && factoryDeptId && profile?.department_id === factoryDeptId));

  const load = useCallback(async () => {
    const { data } = await listFactoryAiRequests();
    setRows(data || []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribeTable("factory_ai_inbox", "factory_ai_requests", null, load), [load]);
  useEffect(() => { listInteriorPeople().then(({ data }) => setPeople(data || [])); }, []);

  const factoryPeople = useMemo(() => people.filter((p) => p.department_name === "Factory/Manufacturing"), [people]);
  const shown = useMemo(() => rows.filter((r) => {
    if (filter === "all") return true;
    if (filter === "review") return ["needs_review", "extracted", "uploaded"].includes(r.status);
    return r.status === filter;
  }), [rows, filter]);

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📥</div>
        <div className="dept-header-text">
          <h1>AI Factory Inbox</h1>
          <div className="sub">Requests from every department, read and drafted automatically. Review, correct, then accept.</div>
        </div>
      </div>

      <div className="card">
        <div className="filter-bar" style={{ flexWrap: "wrap" }}>
          {FILTERS.map(([k, label]) => (
            <button key={k} type="button" className={`btn ${filter === k ? "btn-primary" : "btn-outline"}`} style={{ marginTop: 0, width: "auto" }} onClick={() => setFilter(k)}>
              {label}{k !== "all" && ` (${rows.filter((r) => (k === "review" ? ["needs_review", "extracted", "uploaded"].includes(r.status) : r.status === k)).length})`}
            </button>
          ))}
        </div>
        {loading && <div className="skeleton-block" style={{ height: 80, marginTop: 8 }} />}
        {!loading && shown.length === 0 && <div className="msg info" style={{ marginTop: 8 }}>Nothing here right now.</div>}
        {shown.map((r) => (
          <div key={r.id} className="task-meta" style={{ justifyContent: "space-between", flexWrap: "wrap", padding: "8px 0", gap: 6, borderBottom: "1px solid var(--border)" }}>
            <span style={{ fontWeight: 700 }}>{r.request_number}</span>
            <span style={{ flex: 1, minWidth: 160 }}>{r.work_title}<span className="sub"> · {r.departments?.name_en || "—"}{r.projects ? ` · ${r.projects.project_code}` : ""}</span></span>
            <span className="sub">{r.priority}{r.required_date ? ` · due ${r.required_date}` : ""}</span>
            <span className={`badge ${STATUS_BADGE[r.status] || "CLOSED"}`}>{STATUS_LABEL[r.status] || r.status}</span>
            <button type="button" className="btn btn-outline" style={{ width: "auto", marginTop: 0 }} onClick={() => setSelected(r.id)}>{canReview && ["needs_review", "failed", "extracted"].includes(r.status) ? "Verify AI Draft" : "View"}</button>
          </div>
        ))}
      </div>

      {selected && <Detail id={selected} canReview={canReview} factoryPeople={factoryPeople} onClose={() => setSelected(null)} onChanged={load} />}
    </div>
  );
}
