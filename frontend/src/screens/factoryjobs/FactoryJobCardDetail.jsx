import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  FILE_KINDS, L, JOB_STATUS, allItemsDone, amFactoryLead, amFactoryMember, daysLeft, effectiveDue, factoryTeam, fmtQty, getFactoryTask, getJobCard, isOverdue,
  itemProgress, jobAction, jobStatusLabel, listDispatches, listEvents, listFiles, listItems, listMaterialOrders, listQc, peopleNames, priorityLabel,
  requestMaterial, todayIST, uploadJobFile,
} from "../../lib/factoryJobApi";
import { getCompanyProfile, procStatusLabel } from "../../lib/procurementApi";
import { subscribeTable } from "../../lib/realtime";
import { friendlyError } from "../../lib/friendlyError";
import AttachmentGallery from "../../components/AttachmentGallery";
import FactoryJobCardPrint from "./FactoryJobCardPrint";

// One Job Card: everything about it, and only the next step(s) the current person may take -- the database (fjc_action)
// checks the same rules again.

const fmtDate = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("-") : "—");
const fmtTime = (t) => (t ? new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const QC_CHECKS = [
  ["product_quality_ok", "Product quality", "ઉત્પાદન ગુણવત્તા"], ["dimensions_ok", "Dimensions verified", "માપ ચકાસ્યા"],
  ["material_ok", "Material verified", "મટિરિયલ ચકાસ્યું"], ["finish_ok", "Finish verified", "ફિનિશ ચકાસી"], ["quantity_ok", "Quantity verified", "જથ્થો ચકાસ્યો"],
];

export default function FactoryJobCardDetail({ lang, profile }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [job, setJob] = useState(null);
  const [items, setItems] = useState([]);
  const [files, setFiles] = useState([]);
  const [events, setEvents] = useState([]);
  const [qc, setQc] = useState([]);
  const [dispatches, setDispatches] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [task, setTask] = useState(null);
  const [team, setTeam] = useState([]);
  const [names, setNames] = useState({});
  const [me, setMe] = useState({ member: false, lead: false });
  const [company, setCompany] = useState(null);
  const [state, setState] = useState({ loading: true, error: null });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(params.get("upload_failed") ? { type: "error", text: `${L(lang, "These files did not upload: ", "આ ફાઇલો અપલોડ ન થઈ: ")}${params.get("upload_failed")}` } : null);
  const [printOpen, setPrintOpen] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await getJobCard(id);
    if (error) { setState({ loading: false, error: friendlyError(error.message) }); return; }
    if (!data) { setState({ loading: false, error: L(lang, "This Job Card doesn't exist or you can't see it.", "આ જોબ કાર્ડ નથી અથવા તમે જોઈ શકતા નથી.") }); return; }
    const [it, fi, ev, q, d, m, t, tm, mem, lead] = await Promise.all([listItems(id), listFiles(id), listEvents(id), listQc(id), listDispatches(id),
      listMaterialOrders(id), getFactoryTask(id), factoryTeam(), amFactoryMember(), amFactoryLead()]);
    setJob(data); setItems(it.data || []); setFiles(fi.data || []); setEvents(ev.data || []); setQc(q.data || []); setDispatches(d.data || []);
    setMaterials(m.data || []); setTask(t.data || null); setTeam(tm.data || []); setMe({ member: !!mem.data, lead: !!lead.data });
    setNames(await peopleNames([data.requested_by, data.department_head_id, data.assigned_to, data.accepted_by, data.received_by,
      ...(ev.data || []).map((e) => e.actor_id), ...(q.data || []).map((x) => x.checked_by), ...(d.data || []).map((x) => x.created_by)]));
    setState({ loading: false, error: null });
  }, [id, lang]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { getCompanyProfile().then(({ data }) => setCompany(data || null)); }, []);
  useEffect(() => subscribeTable(`fjc-${id}`, "factory_job_cards", `id=eq.${id}`, () => load()), [id, load]);
  useEffect(() => { if (params.get("upload_failed")) setParams({}, { replace: true }); }, [params, setParams]);

  async function act(action, payload, okText) {
    setBusy(true); setMsg(null);
    const { error } = await jobAction(id, action, payload);
    setBusy(false);
    if (error) { setMsg({ type: "error", text: friendlyError(error.message) }); return false; }
    if (okText) setMsg({ type: "success", text: okText });
    await load();
    return true;
  }

  if (state.loading) return <div className="dept-dashboard"><div className="skeleton-block" style={{ height: 120 }} /><div className="skeleton-block" style={{ height: 320 }} /></div>;
  if (state.error) return <div className="dept-dashboard"><div className="msg error">{state.error}</div><Link className="btn btn-outline" style={{ width: "auto" }} to="/factory-job-cards">{L(lang, "All Job Cards", "બધા જોબ કાર્ડ")}</Link></div>;

  const s = job.status;
  const mine = job.assigned_to === profile.id;
  const canWork = me.lead || mine;
  const requesterSide = job.requested_by === profile.id || job.requesting_department_id === profile.department_id || profile.permissions?.hasGlobalOversight;
  const closed = ["COMPLETED", "CANCELLED"].includes(s);
  const overdue = isOverdue(job);
  const left = daysLeft(job);
  const totalQty = items.reduce((a, i) => a + Number(i.quantity || 0), 0);
  const dispatchedQty = dispatches.reduce((a, d) => a + Number(d.quantity || 0), 0);

  return (
    <div className="dept-dashboard">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🏭</div>
        <div className="dept-header-text">
          <h1>{job.job_card_number}</h1>
          <div className="sub">{items[0]?.product_name}{items.length > 1 ? ` +${items.length - 1}` : ""} · {L(lang, job.departments?.name_en, job.departments?.name_gu)}</div>
        </div>
        <div className="btn-row" style={{ marginLeft: "auto", alignItems: "center" }}>
          <span className={`badge ${JOB_STATUS[s]?.tone || "ASSIGNED"}`}>{jobStatusLabel(s, lang)}</span>
          {job.priority !== "NORMAL" && <span className={`badge ${job.priority === "EMERGENCY" ? "RETURNED" : "ON_HOLD"}`}>{priorityLabel(job.priority, lang)}</span>}
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setPrintOpen(true)}>🖨 {L(lang, "Print Job Card", "જોબ કાર્ડ છાપો")}</button>
          <Link className="btn btn-outline" style={{ width: "auto" }} to="/factory-job-cards">{L(lang, "All Job Cards", "બધા જોબ કાર્ડ")}</Link>
        </div>
      </div>

      {overdue && <div className="msg error">⚠ {L(lang, `Overdue: production was due ${fmtDate(effectiveDue(job))} (${-left} day(s) late).`, `મોડું: ${fmtDate(effectiveDue(job))} સુધીમાં પૂરું થવાનું હતું.`)}</div>}
      {!overdue && left !== null && left <= 2 && !closed && !["READY_FOR_DISPATCH", "DISPATCHED"].includes(s) && (
        <div className="msg warning">⏰ {left === 0 ? L(lang, "Due today.", "આજે નિયત.") : L(lang, `Due in ${left} day(s).`, `${left} દિવસમાં નિયત.`)}</div>)}
      {job.revised_due_date && <div className="msg info">{L(lang, `Factory proposed a revised completion date ${fmtDate(job.revised_due_date)} (original ${fmtDate(job.due_date)}): ${job.revised_reason}`,
        `ફેક્ટરીની નવી તારીખ ${fmtDate(job.revised_due_date)} (મૂળ ${fmtDate(job.due_date)}): ${job.revised_reason}`)}</div>}
      {msg && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="card">
        <dl className="deadline-panel">
          <div><dt>{L(lang, "Requesting department", "વિભાગ")}</dt><dd>{L(lang, job.departments?.name_en, job.departments?.name_gu)}</dd></div>
          <div><dt>{L(lang, "Requested by", "વિનંતી કરનાર")}</dt><dd>{names[job.requested_by] || "—"}</dd></div>
          <div><dt>{L(lang, "Department Head", "વિભાગના વડા")}</dt><dd>{names[job.department_head_id] || "—"}</dd></div>
          <div><dt>{L(lang, "Client / project", "ગ્રાહક / પ્રોજેક્ટ")}</dt><dd>{[job.client_name, job.project_name].filter(Boolean).join(" · ") || "—"}</dd></div>
          <div><dt>{L(lang, "Order date", "ઓર્ડર તારીખ")}</dt><dd>{fmtDate(job.order_date)}</dd></div>
          <div><dt>{L(lang, "Required completion", "પૂર્ણ તારીખ")}</dt><dd className={overdue ? "danger" : ""}><b>{fmtDate(effectiveDue(job))}</b>{job.revised_due_date && <span className="sub"> ({L(lang, "original", "મૂળ")} {fmtDate(job.due_date)})</span>}</dd></div>
          <div><dt>{L(lang, "Assigned employee", "સોંપાયેલ કર્મચારી")}</dt><dd>{names[job.assigned_to] || L(lang, "Not yet", "હજુ નહીં")}</dd></div>
          <div><dt>{L(lang, "Accepted", "સ્વીકાર્યું")}</dt><dd>{job.accepted_by ? `${names[job.accepted_by] || ""} · ${fmtTime(job.accepted_at)}` : "—"}</dd></div>
          <div><dt>{L(lang, "Production started", "ઉત્પાદન શરૂ")}</dt><dd>{fmtTime(job.production_started_at)}</dd></div>
          <div><dt>{L(lang, "Production completed", "ઉત્પાદન પૂર્ણ")}</dt><dd>{fmtTime(job.production_completed_at)}</dd></div>
          <div><dt>{L(lang, "Progress", "પ્રગતિ")}</dt><dd><div className="fjc-bar"><span style={{ width: `${job.progress_pct}%` }} /></div>{job.progress_pct}%</dd></div>
          <div><dt>{L(lang, "Factory task", "ફેક્ટરી કાર્ય")}</dt><dd>{task ? <Link to={`/tasks?focus=${task.id}`}>{task.task_number}</Link> : "—"}</dd></div>
          {job.delivery_location && <div style={{ gridColumn: "1 / -1" }}><dt>{L(lang, "Delivery location", "ડિલિવરી સ્થળ")}</dt><dd>{job.delivery_location}</dd></div>}
          {job.special_instructions && <div style={{ gridColumn: "1 / -1" }}><dt>{L(lang, "Instructions", "સૂચના")}</dt><dd>{job.special_instructions}</dd></div>}
          {job.production_remarks && <div style={{ gridColumn: "1 / -1" }}><dt>{L(lang, "Production remarks", "ઉત્પાદન નોંધ")}</dt><dd>{job.production_remarks}</dd></div>}
          {job.cancelled_reason && <div style={{ gridColumn: "1 / -1" }}><dt>{L(lang, "Cancelled", "રદ")}</dt><dd>{job.cancelled_reason}</dd></div>}
        </dl>
      </div>

      <NextStep lang={lang} job={job} items={items} me={me} canWork={canWork} requesterSide={requesterSide} team={team} busy={busy} act={act}
        profile={profile} totalQty={totalQty} dispatchedQty={dispatchedQty} />

      <div className="card">
        <h2>{L(lang, "Products", "ઉત્પાદનો")}</h2>
        <div className="proc-table-wrap">
          <table className="proc-table">
            <thead><tr><th>#</th><th>{L(lang, "Product", "ઉત્પાદન")}</th><th>{L(lang, "Qty", "જથ્થો")}</th><th>{L(lang, "Dimensions", "માપ")}</th><th>{L(lang, "Material", "મટિરિયલ")}</th>
              <th>{L(lang, "Finish / colour", "ફિનિશ")}</th><th>{L(lang, "Laminate / fabric / hardware", "લેમિનેટ / ફેબ્રિક / હાર્ડવેર")}</th><th>{L(lang, "Made", "બન્યું")}</th></tr></thead>
            <tbody>{items.map((i) => (
              <tr key={i.id}>
                <td>{i.line_no}</td>
                <td style={{ whiteSpace: "normal", minWidth: 180 }}><b>{i.product_name}</b>{i.item_code && <span className="sub"> · {i.item_code}</span>}{i.product_category && <div className="sub">{i.product_category}</div>}
                  {i.description && <div className="sub">{i.description}</div>}{i.instructions && <div className="sub">📝 {i.instructions}</div>}{i.remarks && <div className="sub">🏭 {i.remarks}</div>}</td>
                <td>{fmtQty(i.quantity)} {i.unit}</td><td style={{ whiteSpace: "normal" }}>{i.dimensions || "—"}</td><td style={{ whiteSpace: "normal" }}>{i.material_spec || "—"}</td>
                <td style={{ whiteSpace: "normal" }}>{i.finish_colour || "—"}</td><td style={{ whiteSpace: "normal" }}>{i.laminate_fabric_hardware || "—"}</td>
                <td>{fmtQty(i.qty_completed)} / {fmtQty(i.quantity)}<div className="fjc-bar"><span style={{ width: `${itemProgress(i)}%` }} /></div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>{L(lang, "Drawings and attachments", "ડ્રોઇંગ અને જોડાણ")} ({files.length})</h2>
        {files.length === 0 && <div className="sub">{L(lang, "No files attached.", "કોઈ ફાઇલ નથી.")}</div>}
        {FILE_KINDS.concat([{ code: "QC", en: "QC photos", gu: "QC ફોટા" }, { code: "DISPATCH", en: "Dispatch documents", gu: "ડિસ્પેચ દસ્તાવેજ" }]).map((k) => {
          const list = files.filter((f) => f.kind === k.code);
          return list.length ? <div key={k.code} style={{ marginTop: 8 }}><div className="vs-tier">{L(lang, k.en, k.gu)}</div><AttachmentGallery files={list} lang={lang} /></div> : null;
        })}
        {!closed && <AddFiles lang={lang} jobId={id} kinds={me.member || me.lead ? ["PRODUCT_IMAGE", "DRAWING", "PDF", "REFERENCE", "QC", "DISPATCH"] : ["PRODUCT_IMAGE", "DRAWING", "PDF", "REFERENCE"]}
          onDone={(failed) => { if (failed.length) setMsg({ type: "error", text: L(lang, "These files did not upload: ", "આ ફાઇલો અપલોડ ન થઈ: ") + failed.join(", ") }); load(); }} />}
      </div>

      {(materials.length > 0 || ((me.member || me.lead) && !closed && !["READY_FOR_DISPATCH", "DISPATCHED"].includes(s))) && (
        <MaterialPanel lang={lang} job={job} materials={materials} canRequest={(me.member || me.lead) && !closed && !["READY_FOR_DISPATCH", "DISPATCHED"].includes(s)}
          onDone={(t) => { setMsg(t); load(); }} />
      )}

      {qc.length > 0 && (
        <div className="card">
          <h2>{L(lang, "Quality check history", "ગુણવત્તા તપાસ ઇતિહાસ")}</h2>
          <ul className="reminder-log">{qc.map((x) => (
            <li key={x.id}><b className={x.result === "PASSED" ? "" : "danger"}>{x.result === "PASSED" ? `✅ ${L(lang, "Passed", "પાસ")}` : `❌ ${L(lang, "Failed", "નિષ્ફળ")}`}</b> · {names[x.checked_by]} · {fmtDate(x.checked_on)}
              <div className="sub">{QC_CHECKS.map(([k, en, gu]) => `${x[k] ? "✔" : "✘"} ${L(lang, en, gu)}`).join("  ")}</div>
              {x.defects && <div className="sub">{L(lang, "Defects / remarks", "ખામી / નોંધ")}: {x.defects}</div>}</li>
          ))}</ul>
        </div>
      )}

      {dispatches.length > 0 && (
        <div className="card">
          <h2>{L(lang, "Dispatch", "ડિસ્પેચ")} · {fmtQty(dispatchedQty)} / {fmtQty(totalQty)}</h2>
          <ul className="reminder-log">{dispatches.map((d) => (
            <li key={d.id}>{fmtDate(d.dispatch_date)} · {fmtQty(d.quantity)} · {L(lang, "Ref", "સંદર્ભ")} <b>{d.delivery_reference}</b>{d.transport_details && ` · ${d.transport_details}`}
              <div className="sub">{names[d.created_by]}{d.remarks && ` · ${d.remarks}`}</div></li>
          ))}</ul>
          {job.received_at && <div className="msg success">{L(lang, `Received by ${names[job.received_by] || ""} on ${fmtTime(job.received_at)}`, `${names[job.received_by] || ""} એ ${fmtTime(job.received_at)} એ મેળવ્યું`)}{job.receipt_remarks && ` — ${job.receipt_remarks}`}</div>}
        </div>
      )}

      <div className="card">
        <h2>{L(lang, "History", "ઇતિહાસ")}</h2>
        <ul className="reminder-log">{events.slice().reverse().map((e) => (
          <li key={e.id}><b>{e.action.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</b>
            {e.to_status && e.to_status !== e.from_status && <> → {jobStatusLabel(e.to_status, lang)}</>}
            <span className="sub"> · {names[e.actor_id] || L(lang, "System", "સિસ્ટમ")} · {fmtTime(e.created_at)}</span>
            {e.note && <div className="sub">{e.note}</div>}</li>
        ))}</ul>
      </div>

      {printOpen && <FactoryJobCardPrint lang={lang} job={job} items={items} files={files} names={names} company={company} qc={qc} onClose={() => setPrintOpen(false)} />}
      {s === "NEW" && job.requested_by === profile.id && <div className="sub" style={{ textAlign: "center" }}>
        <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => navigate("/factory-job-cards/new")}>+ {L(lang, "Create another Job Card", "બીજું જોબ કાર્ડ")}</button></div>}
    </div>
  );
}

// The step(s) this person can take now.
function NextStep({ lang, job, items, me, canWork, requesterSide, team, busy, act, profile, totalQty, dispatchedQty }) {
  const s = job.status;
  const [assignee, setAssignee] = useState("");
  const [progress, setProgress] = useState({});
  const [remarks, setRemarks] = useState("");
  const [qcForm, setQcForm] = useState({ product_quality_ok: false, dimensions_ok: false, material_ok: false, finish_ok: false, quantity_ok: false, defects: "" });
  const [disp, setDisp] = useState({ dispatch_date: todayIST(), quantity: "", delivery_reference: "", transport_details: "", remarks: "" });
  const [receipt, setReceipt] = useState("");
  const [revise, setRevise] = useState(null);
  const [cancel, setCancel] = useState(null);
  const pending = useMemo(() => items.map((i) => ({ ...i, qty_completed: progress[i.id]?.qty ?? i.qty_completed })), [items, progress]);
  useEffect(() => { setProgress({}); }, [items]);
  useEffect(() => { setDisp((d) => ({ ...d, quantity: d.quantity || String(Math.max(0, totalQty - dispatchedQty) || "") })); }, [totalQty, dispatchedQty]);

  const blocks = [];
  if (s === "NEW") {
    if (me.lead) {
      blocks.push(
        <div key="acc" className="btn-row" style={{ alignItems: "center" }}>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} style={{ width: "auto", margin: 0 }} aria-label={L(lang, "Assign to", "કોને સોંપવું")}>
            <option value="">{L(lang, "Assign to…", "સોંપો…")}</option>
            {team.map((t) => <option key={t.id} value={t.id}>{t.full_name}{t.id === profile.id ? ` (${L(lang, "me", "હું")})` : ""}</option>)}
          </select>
          <button type="button" className="btn btn-primary" disabled={busy || !assignee} style={{ width: "auto", margin: 0 }}
            onClick={() => act("accept", { assignee }, L(lang, "Accepted and assigned.", "સ્વીકાર્યું અને સોંપ્યું."))}>✅ {L(lang, "Accept & assign", "સ્વીકારો અને સોંપો")}</button>
        </div>);
    } else if (me.member) {
      blocks.push(<button key="acc" type="button" className="btn btn-gold" disabled={busy} style={{ fontSize: 17, minHeight: 52 }}
        onClick={() => act("accept", {}, L(lang, "You accepted this Job Card. It is in your My Tasks.", "તમે જોબ કાર્ડ સ્વીકાર્યું."))}>✅ {L(lang, "Accept Job Card", "જોબ કાર્ડ સ્વીકારો")}</button>);
    } else if (requesterSide) {
      blocks.push(<div key="wait" className="msg info">{L(lang, "Sent to the Factory — waiting for the Factory to accept it.", "ફેક્ટરીને મોકલ્યું — સ્વીકારની રાહ.")}</div>);
    }
  }
  if (s === "ACCEPTED" && canWork) {
    blocks.push(<button key="start" type="button" className="btn btn-gold" disabled={busy} style={{ fontSize: 17, minHeight: 52 }}
      onClick={() => act("start", {}, L(lang, "Production started.", "ઉત્પાદન શરૂ."))}>▶ {L(lang, "Start production", "ઉત્પાદન શરૂ કરો")}</button>);
  }
  if (["PRODUCTION_STARTED", "IN_PROGRESS"].includes(s) && canWork) {
    blocks.push(
      <div key="prog">
        {job.qc_status === "FAILED" && <div className="msg error">{L(lang, "Quality Check failed — fix the defects below, then send it to QC again.", "QC નિષ્ફળ — ખામી સુધારી ફરી QC માં મોકલો.")}</div>}
        <div className="proc-table-wrap">
          <table className="proc-table">
            <thead><tr><th>#</th><th>{L(lang, "Product", "ઉત્પાદન")}</th><th>{L(lang, "Ordered", "ઓર્ડર")}</th><th>{L(lang, "Completed", "પૂર્ણ")}</th><th>{L(lang, "Pending", "બાકી")}</th><th>{L(lang, "Item remarks", "નોંધ")}</th></tr></thead>
            <tbody>{pending.map((i) => (
              <tr key={i.id}>
                <td>{i.line_no}</td><td style={{ whiteSpace: "normal" }}>{i.product_name}</td><td>{fmtQty(i.quantity)} {i.unit}</td>
                <td><input type="number" min="0" max={i.quantity} step="any" inputMode="decimal" style={{ width: 90, margin: 0 }} value={progress[i.id]?.qty ?? i.qty_completed}
                  onChange={(e) => setProgress((p) => ({ ...p, [i.id]: { ...p[i.id], qty: e.target.value } }))} /></td>
                <td>{fmtQty(Math.max(0, Number(i.quantity) - Number(i.qty_completed || 0)))}</td>
                <td><input style={{ minWidth: 140, margin: 0 }} value={progress[i.id]?.remarks ?? ""} placeholder={i.remarks || ""}
                  onChange={(e) => setProgress((p) => ({ ...p, [i.id]: { ...p[i.id], remarks: e.target.value } }))} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder={L(lang, "Production remarks (optional)", "ઉત્પાદન નોંધ (વૈકલ્પિક)")} />
        <div className="btn-row">
          <button type="button" className="btn btn-primary" disabled={busy}
            onClick={() => act("progress", { remarks, items: items.map((i) => ({ id: i.id, qty_completed: progress[i.id]?.qty ?? i.qty_completed, remarks: progress[i.id]?.remarks || "" })) },
              L(lang, "Progress saved.", "પ્રગતિ સાચવી.")).then((ok) => ok && setRemarks(""))}>💾 {L(lang, "Save progress", "પ્રગતિ સાચવો")}</button>
          <button type="button" className="btn btn-gold" disabled={busy || !allItemsDone(pending) || Object.keys(progress).length > 0}
            title={!allItemsDone(pending) ? L(lang, "Every quantity must be completed first", "બધો જથ્થો પહેલા પૂરો થવો જોઈએ") : Object.keys(progress).length ? L(lang, "Save progress first", "પહેલા પ્રગતિ સાચવો") : ""}
            onClick={() => act("send_to_qc", {}, L(lang, "Sent to Quality Check.", "QC માટે મોકલ્યું."))}>🔍 {L(lang, "Send to Quality Check", "ગુણવત્તા તપાસમાં મોકલો")}</button>
        </div>
      </div>);
  }
  if (s === "QUALITY_CHECK") {
    if (job.qc_status === "PASSED") {
      if (canWork) blocks.push(<button key="ready" type="button" className="btn btn-gold" disabled={busy} style={{ fontSize: 17, minHeight: 52 }}
        onClick={() => act("ready", {}, L(lang, "Marked ready for dispatch. The requesting department is told.", "ડિસ્પેચ માટે તૈયાર."))}>📦 {L(lang, "Mark ready for dispatch", "ડિસ્પેચ માટે તૈયાર")}</button>);
    } else if (me.lead) {
      const allOk = QC_CHECKS.every(([k]) => qcForm[k]);
      blocks.push(
        <div key="qc">
          <div className="day-picks">{QC_CHECKS.map(([k, en, gu]) => (
            <label key={k}><input type="checkbox" checked={qcForm[k]} onChange={(e) => setQcForm((f) => ({ ...f, [k]: e.target.checked }))} />{L(lang, en, gu)}</label>
          ))}</div>
          <textarea rows={2} value={qcForm.defects} onChange={(e) => setQcForm((f) => ({ ...f, defects: e.target.value }))} placeholder={L(lang, "Defects / remarks (required if QC fails)", "ખામી / નોંધ (નિષ્ફળ હોય તો જરૂરી)")} />
          <div className="sub">{L(lang, "QC by", "QC કરનાર")}: {profile.full_name} · {fmtDate(todayIST())}</div>
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={busy || !allOk} onClick={() => act("qc", { ...qcForm, result: "PASSED" }, L(lang, "QC passed.", "QC પાસ."))}>✅ {L(lang, "QC passed", "QC પાસ")}</button>
            <button type="button" className="btn btn-outline danger" disabled={busy || !qcForm.defects.trim()} onClick={() => act("qc", { ...qcForm, result: "FAILED" }, L(lang, "QC failed — returned to production.", "QC નિષ્ફળ — ઉત્પાદનમાં પાછું."))}>❌ {L(lang, "QC failed — return to production", "QC નિષ્ફળ — પાછું મોકલો")}</button>
          </div>
        </div>);
    } else {
      blocks.push(<div key="qcw" className="msg info">{L(lang, "Waiting for Quality Check by the Factory Head.", "ફેક્ટરી હેડની QC ની રાહ.")}</div>);
    }
  }
  if (s === "READY_FOR_DISPATCH" && canWork) {
    blocks.push(
      <div key="disp" className="form-grid">
        <div className="field"><label>{L(lang, "Dispatch date", "ડિસ્પેચ તારીખ")} *</label><input type="date" value={disp.dispatch_date} onChange={(e) => setDisp((d) => ({ ...d, dispatch_date: e.target.value }))} /></div>
        <div className="field"><label>{L(lang, "Quantity dispatched", "મોકલેલો જથ્થો")} * <span className="sub">({L(lang, "of", "માંથી")} {fmtQty(totalQty - dispatchedQty)} {L(lang, "left", "બાકી")})</span></label>
          <input type="number" min="0" step="any" inputMode="decimal" value={disp.quantity} onChange={(e) => setDisp((d) => ({ ...d, quantity: e.target.value }))} /></div>
        <div className="field"><label>{L(lang, "Delivery reference (challan / LR)", "ડિલિવરી સંદર્ભ (ચલણ / LR)")} *</label><input value={disp.delivery_reference} onChange={(e) => setDisp((d) => ({ ...d, delivery_reference: e.target.value }))} /></div>
        <div className="field"><label>{L(lang, "Transport details", "વાહન વિગત")}</label><input value={disp.transport_details} onChange={(e) => setDisp((d) => ({ ...d, transport_details: e.target.value }))} /></div>
        <div className="field full"><label>{L(lang, "Remarks", "નોંધ")}</label><input value={disp.remarks} onChange={(e) => setDisp((d) => ({ ...d, remarks: e.target.value }))} /></div>
        <div className="field full sub">{L(lang, "Add the challan / LR copy under Drawings and attachments as a Dispatch document.", "ચલણ / LR ની નકલ જોડાણમાં ડિસ્પેચ દસ્તાવેજ તરીકે ઉમેરો.")}</div>
        <div className="field full btn-row"><button type="button" className="btn btn-gold" disabled={busy || !disp.delivery_reference.trim() || !(Number(disp.quantity) > 0)}
          onClick={() => act("dispatch", disp, L(lang, "Dispatch recorded.", "ડિસ્પેચ નોંધાયું.")).then((ok) => ok && setDisp((d) => ({ ...d, delivery_reference: "", transport_details: "", remarks: "", quantity: "" })))}>
          🚚 {L(lang, "Record dispatch", "ડિસ્પેચ નોંધો")}</button></div>
      </div>);
  }
  if (s === "DISPATCHED") {
    if (requesterSide && !me.member) {
      blocks.push(
        <div key="rec">
          <input value={receipt} onChange={(e) => setReceipt(e.target.value)} placeholder={L(lang, "Receipt remarks (condition, quantity)", "મળ્યાની નોંધ (સ્થિતિ, જથ્થો)")} />
          <button type="button" className="btn btn-gold" disabled={busy} style={{ fontSize: 17, minHeight: 52 }}
            onClick={() => act("confirm_receipt", { remarks: receipt }, L(lang, "Receipt confirmed — Job Card completed.", "મળ્યાની પુષ્ટિ — પૂર્ણ."))}>📥 {L(lang, "Confirm received", "મળ્યાની પુષ્ટિ કરો")}</button>
        </div>);
    } else {
      blocks.push(<div key="recw" className="msg info">{L(lang, "Dispatched — waiting for the requesting department to confirm receipt.", "મોકલાયું — વિભાગની પુષ્ટિની રાહ.")}</div>);
    }
  }

  // Factory Head tools, while the card is open.
  const leadTools = me.lead && !["COMPLETED", "CANCELLED"].includes(s);
  const canCancel = !["DISPATCHED", "COMPLETED", "CANCELLED"].includes(s) && (me.lead || (job.requested_by === profile.id && s === "NEW"));
  if (!blocks.length && !leadTools && !canCancel) return null;

  return (
    <div className="card">
      <h2>{L(lang, "Next step", "આગળનું પગલું")}</h2>
      {blocks}
      {(leadTools || canCancel) && (
        <div className="btn-row" style={{ marginTop: 10, alignItems: "center", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          {leadTools && s !== "NEW" && (
            <>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)} style={{ width: "auto", margin: 0 }} aria-label={L(lang, "Reassign to", "ફરી સોંપો")}>
                <option value="">{L(lang, "Reassign to…", "ફરી સોંપો…")}</option>
                {team.filter((t) => t.id !== job.assigned_to).map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
              </select>
              {assignee && <button type="button" className="btn btn-outline" disabled={busy} style={{ width: "auto", margin: 0 }}
                onClick={() => act("assign", { assignee }, L(lang, "Reassigned.", "ફરી સોંપ્યું.")).then((ok) => ok && setAssignee(""))}>{L(lang, "Reassign", "ફરી સોંપો")}</button>}
            </>
          )}
          {leadTools && !["READY_FOR_DISPATCH", "DISPATCHED"].includes(s) && !revise && (
            <button type="button" className="btn btn-outline" style={{ width: "auto", margin: 0 }} onClick={() => setRevise({ date: "", reason: "" })}>📅 {L(lang, "Propose revised date", "નવી તારીખ સૂચવો")}</button>)}
          {canCancel && !cancel && <button type="button" className="btn btn-outline danger" style={{ width: "auto", margin: 0 }} onClick={() => setCancel({ reason: "" })}>{L(lang, "Cancel Job Card", "જોબ કાર્ડ રદ કરો")}</button>}
        </div>
      )}
      {revise && (
        <div className="form-grid" style={{ marginTop: 8 }}>
          <div className="field"><label>{L(lang, "Revised completion date", "નવી પૂર્ણ તારીખ")}</label><input type="date" min={todayIST()} value={revise.date} onChange={(e) => setRevise((r) => ({ ...r, date: e.target.value }))} /></div>
          <div className="field"><label>{L(lang, "Reason (sent to the requesting department)", "કારણ (વિભાગને મોકલાશે)")}</label><input value={revise.reason} onChange={(e) => setRevise((r) => ({ ...r, reason: e.target.value }))} /></div>
          <div className="field full sub">{L(lang, "The original due date stays on record; the requester and their Department Head are told.", "મૂળ તારીખ નોંધમાં રહે છે; વિભાગને જાણ થશે.")}</div>
          <div className="field full btn-row">
            <button type="button" className="btn btn-primary" disabled={busy || !revise.date || !revise.reason.trim()} onClick={() => act("revise_date", revise, L(lang, "Revised date sent.", "નવી તારીખ મોકલી.")).then((ok) => ok && setRevise(null))}>{L(lang, "Send revised date", "નવી તારીખ મોકલો")}</button>
            <button type="button" className="btn btn-outline" onClick={() => setRevise(null)}>{L(lang, "Close", "બંધ")}</button>
          </div>
        </div>
      )}
      {cancel && (
        <div className="msg error" style={{ marginTop: 8 }}>
          <textarea rows={2} value={cancel.reason} onChange={(e) => setCancel({ reason: e.target.value })} placeholder={L(lang, "Reason for cancelling (required)", "રદ કરવાનું કારણ (જરૂરી)")} />
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={busy || !cancel.reason.trim()} onClick={() => act("cancel", cancel, L(lang, "Job Card cancelled.", "જોબ કાર્ડ રદ."))}>{L(lang, "Cancel this Job Card", "આ જોબ કાર્ડ રદ કરો")}</button>
            <button type="button" className="btn btn-outline" onClick={() => setCancel(null)}>{L(lang, "Keep it", "રાખો")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function AddFiles({ lang, jobId, kinds, onDone }) {
  const [kind, setKind] = useState(kinds[0]);
  const [busy, setBusy] = useState(false);
  const all = FILE_KINDS.concat([{ code: "QC", en: "QC photo", gu: "QC ફોટો" }, { code: "DISPATCH", en: "Dispatch document", gu: "ડિસ્પેચ દસ્તાવેજ" }]);
  async function add(list) {
    setBusy(true);
    const failed = [];
    for (const f of list) { const { error } = await uploadJobFile(jobId, f, kind); if (error) failed.push(f.name); }
    setBusy(false);
    onDone(failed);
  }
  return (
    <div className="btn-row" style={{ marginTop: 10, alignItems: "center" }}>
      <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: "auto", margin: 0 }} aria-label={L(lang, "File kind", "ફાઇલનો પ્રકાર")}>
        {all.filter((k) => kinds.includes(k.code)).map((k) => <option key={k.code} value={k.code}>{L(lang, k.en, k.gu)}</option>)}
      </select>
      <label className="btn btn-outline" style={{ width: "auto", margin: 0, cursor: "pointer" }}>
        {busy ? "…" : `+ ${L(lang, "Add files", "ફાઇલ ઉમેરો")}`}
        <input type="file" multiple hidden disabled={busy} accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.dwg,.dxf" onChange={(e) => { const l = Array.from(e.target.files || []); e.target.value = ""; if (l.length) add(l); }} />
      </label>
    </div>
  );
}

// Missing material -> a normal Procurement order linked to this card; its progress shows here.
function MaterialPanel({ lang, job, materials, canRequest, onDone }) {
  const blank = { material: "", specification: "", quantity: "", unit: "" };
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState([{ ...blank }]);
  const [date, setDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function send() {
    const used = lines.filter((l) => l.material.trim() || l.quantity.trim());
    if (!used.length || used.some((l) => !l.material.trim() || !l.quantity.trim()) || !date) { setErr(L(lang, "Give each material with its quantity, and the date it is needed.", "દરેક મટિરિયલ, જથ્થો અને તારીખ આપો.")); return; }
    setBusy(true); setErr(null);
    const { data, error } = await requestMaterial(job.id, used, date, remarks);
    setBusy(false);
    if (error) { setErr(friendlyError(error.message)); return; }
    setOpen(false); setLines([{ ...blank }]); setDate(""); setRemarks("");
    onDone({ type: "success", text: L(lang, `Procurement order ${data.request_number} raised for the material.`, `મટિરિયલ માટે ખરીદી ઓર્ડર ${data.request_number}.`) });
  }
  return (
    <div className="card">
      <h2>{L(lang, "Material requirements (Procurement)", "મટિરિયલ જરૂરિયાત (ખરીદી)")}</h2>
      {materials.length === 0 && <div className="sub">{L(lang, "No material requested for this Job Card.", "આ જોબ કાર્ડ માટે મટિરિયલ મંગાવ્યું નથી.")}</div>}
      <ul className="reminder-log">{materials.map((m) => (
        <li key={m.id}><Link to={`/purchase-requests/${m.id}`}><b>{m.request_number}</b></Link> · {procStatusLabel(m.proc_status, lang)} · {L(lang, "needed by", "જરૂરી")} {fmtDate(m.required_by_date)}</li>
      ))}</ul>
      {canRequest && !open && <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setOpen(true)}>+ {L(lang, "Material unavailable — request from Procurement", "મટિરિયલ નથી — ખરીદીને વિનંતી")}</button>}
      {open && (
        <div style={{ marginTop: 8 }}>
          {lines.map((l, n) => (
            <div key={n} className="form-grid" style={{ marginBottom: 4 }}>
              <div className="field"><input value={l.material} placeholder={L(lang, "Material", "મટિરિયલ")} onChange={(e) => setLines((x) => x.map((y, i) => (i === n ? { ...y, material: e.target.value } : y)))} /></div>
              <div className="field"><input value={l.specification} placeholder={L(lang, "Specification", "સ્પષ્ટીકરણ")} onChange={(e) => setLines((x) => x.map((y, i) => (i === n ? { ...y, specification: e.target.value } : y)))} /></div>
              <div className="field" style={{ display: "flex", gap: 6 }}>
                <input value={l.quantity} placeholder={L(lang, "Qty", "જથ્થો")} inputMode="decimal" onChange={(e) => setLines((x) => x.map((y, i) => (i === n ? { ...y, quantity: e.target.value } : y)))} />
                <input value={l.unit} placeholder={L(lang, "Unit", "એકમ")} style={{ width: 90 }} onChange={(e) => setLines((x) => x.map((y, i) => (i === n ? { ...y, unit: e.target.value } : y)))} />
              </div>
            </div>
          ))}
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setLines((x) => [...x, { ...blank }])}>+ {L(lang, "Another material", "બીજું મટિરિયલ")}</button>
          <div className="form-grid" style={{ marginTop: 6 }}>
            <div className="field"><label>{L(lang, "Needed by", "ક્યારે જોઈએ")} *</label><input type="date" min={todayIST()} value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="field"><label>{L(lang, "Remarks", "નોંધ")}</label><input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
          </div>
          {err && <div className="msg error">{err}</div>}
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={send}>{busy ? "…" : L(lang, "Send to Procurement", "ખરીદીને મોકલો")}</button>
            <button type="button" className="btn btn-outline" onClick={() => setOpen(false)}>{L(lang, "Close", "બંધ")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
