import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import FactoryHeader from "./FactoryHeader.jsx";
import FactoryJobTasks from "./FactoryJobTasks.jsx";
import ChatButton from "../../components/ChatButton.jsx";
import ProofPhotoUpload from "../../components/ProofPhotoUpload.jsx";
import ProofPhotoViewer from "../../components/ProofPhotoViewer.jsx";
import FieldPhotoProof from "../../components/FieldPhotoProof.jsx";
import {
  ActivityTab, AssignmentTab, FilePreview, FilesTab, ItemsTab, KeyDrawings, ProductionUpdate, VerificationTab,
} from "./FactoryJobParts.jsx";
import {
  getJobCard, jobTransition, listFactoryLocations, listFactoryPeople, listJobEvents, listJobFiles, listJobItems, markViewed,
  subscribeJobDetail, updateDetails, listDivisions, setJobDivision, listJobStages, startStage, completeStage, updateSegmentSpecs,
} from "../../lib/factoryApi";
import { PRIORITIES, STATUS, DIVISION_META, fmtDate, fmtDateTime, friendlyRpcError, label, roleInfo } from "./factoryConstants";

const SOURCE_ROUTE = { retail: "/retail/orders", interior: "/interior-projects/purchase" };

function DetailsEditor({ job, isManager, onDone }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ required_date: job.required_date || "", priority: job.priority, customer_name: job.customer_name || "", site_location: job.site_location || "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  async function save(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setMsg(null);
    const patch = { required_date: f.required_date || null, customer_name: f.customer_name, site_location: f.site_location };
    if (f.notes.trim()) patch.notes = f.notes;
    if (isManager && f.priority !== job.priority) patch.priority = f.priority;
    const { error } = await updateDetails(job.id, patch);
    setBusy(false);
    if (error) { setMsg({ type: "error", text: friendlyRpcError(error) }); return; }
    setOpen(false); onDone?.();
  }
  if (!open) return <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setOpen(true)}>Edit details</button>;
  return (
    <form onSubmit={save} className="fx-section" style={{ marginTop: 8 }}>
      <div className="form-grid">
        <div className="field"><label>Required date</label><input type="date" value={f.required_date} onChange={(e) => setF({ ...f, required_date: e.target.value })} disabled={busy} /></div>
        {isManager && (
          <div className="field"><label>Priority</label>
            <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} disabled={busy}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
        )}
        <div className="field"><label>Customer</label><input value={f.customer_name} onChange={(e) => setF({ ...f, customer_name: e.target.value })} disabled={busy} /></div>
        <div className="field"><label>Site / delivery location</label><input value={f.site_location} onChange={(e) => setF({ ...f, site_location: e.target.value })} disabled={busy} /></div>
        <div className="field full"><label>Replace notes (leave empty to keep)</label><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} disabled={busy} /></div>
      </div>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" style={{ width: "auto" }} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {msg && <div className={`msg ${msg.type}`} style={{ marginTop: 8 }}>{msg.text}</div>}
    </form>
  );
}

// Division badge + the "simple three-button selection" the spec asks for when a Job Card's division is
// unclear. Head/Management only (factory_set_job_division re-checks this server-side regardless).
function DivisionPicker({ job, lang, isHead, onDone }) {
  const [divisions, setDivisions] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => { if (isHead && !job.division_id) listDivisions().then(({ data }) => setDivisions(data || [])); }, [isHead, job.division_id]);

  if (job.division_id) {
    return <span className="fx-tag gold">{lang === "gu" ? job.division_name_gu : job.division_name_en}</span>;
  }
  if (!isHead) return <span className="fx-tag">{lang === "gu" ? "વિભાગ નક્કી નથી" : "Division not set"}</span>;

  async function choose(d) {
    setBusy(true); setMsg(null);
    const { error } = await setJobDivision(job.id, d.id);
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    onDone?.();
  }

  return (
    <div className="task-meta" style={{ gap: 6, flexWrap: "wrap" }}>
      <span className="sub">{lang === "gu" ? "વિભાગ પસંદ કરો:" : "Select division:"}</span>
      {(divisions || []).map((d) => (
        <button key={d.id} type="button" className="btn btn-outline" style={{ minHeight: 44, width: "auto" }} disabled={busy} onClick={() => choose(d)}>
          {d.icon} {lang === "gu" ? d.name_gu : d.name_en}
        </button>
      ))}
      {msg && <span className="msg error" style={{ padding: "2px 6px" }}>{msg}</span>}
    </div>
  );
}

// --- Phase 1 "6 big buttons" restructure ---------------------------------------------------------------------
// PO Received / Party Name / Delivery Date / Priority / WIP / Material, each its own small focused section
// instead of one long form -- the PO/Party/Delivery/Priority sections save their couple of extra fields into
// segment_specs (merge, never clobbers another section's keys) plus the three real po_received/po_number/
// po_date columns, each gated behind one mandatory field-level photo. WIP opens the dedicated stage-engine
// route; Material opens its own BOM/Costing/Priority sub-choice.
function SimpleField({ label: lbl, value, onChange, type = "text", options }) {
  return (
    <div className="field">
      <label>{lbl}</label>
      {type === "select"
        ? <select value={value || ""} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
        : <input type={type} value={value || ""} onChange={(e) => onChange(e.target.value)} />}
    </div>
  );
}

function PoSection({ job, lang, canEdit, onDone }) {
  const [f, setF] = useState({ poReceived: job.po_received ?? false, poNumber: job.po_number || "", poDate: job.po_date || "",
    orderReference: job.segment_specs?.order_reference || "", instructions: job.segment_specs?.po_instructions || "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function save() {
    setBusy(true); setMsg(null);
    const r1 = await updateDetails(job.id, { po_received: f.poReceived, po_number: f.poNumber, po_date: f.poDate || null });
    const r2 = await updateSegmentSpecs(job.id, { order_reference: f.orderReference, po_instructions: f.instructions });
    setBusy(false);
    if (r1.error || r2.error) { setMsg(friendlyRpcError(r1.error || r2.error)); return; }
    setMsg(null); onDone?.();
  }

  return (
    <div>
      <label className="task-meta" style={{ gap: 8 }}>
        <input type="checkbox" checked={f.poReceived} disabled={!canEdit} onChange={(e) => setF({ ...f, poReceived: e.target.checked })} style={{ width: "auto", minHeight: "auto" }} />
        {lang === "gu" ? "PO મળ્યું છે" : "PO Received"}
      </label>
      <SimpleField label={lang === "gu" ? "PO નંબર" : "PO Number"} value={f.poNumber} onChange={(v) => setF({ ...f, poNumber: v })} />
      <SimpleField label={lang === "gu" ? "PO તારીખ" : "PO Date"} type="date" value={f.poDate} onChange={(v) => setF({ ...f, poDate: v })} />
      <SimpleField label={lang === "gu" ? "ઓર્ડર/સંદર્ભ નંબર" : "Order/Reference Number"} value={f.orderReference} onChange={(v) => setF({ ...f, orderReference: v })} />
      <SimpleField label={lang === "gu" ? "ટૂંકી સૂચનાઓ" : "Short Instructions"} value={f.instructions} onChange={(v) => setF({ ...f, instructions: v })} />
      <FieldPhotoProof lang={lang} entityId={job.id} sectionKey="po_photo" required label={lang === "gu" ? "PO ફોટો" : "PO Photo"} />
      {canEdit && <button type="button" className="btn btn-primary" style={{ minHeight: 44, marginTop: 8 }} disabled={busy} onClick={save}>{lang === "gu" ? "સાચવો" : "Save"}</button>}
      {msg && <div className="msg error" style={{ marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

function PartySection({ job, lang, canEdit, onDone }) {
  const [f, setF] = useState({ customerName: job.customer_name || "", siteLocation: job.site_location || "",
    contactPerson: job.segment_specs?.contact_person || "", referenceNumber: job.segment_specs?.party_reference || "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function save() {
    setBusy(true); setMsg(null);
    const r1 = await updateDetails(job.id, { customer_name: f.customerName, site_location: f.siteLocation });
    const r2 = await updateSegmentSpecs(job.id, { contact_person: f.contactPerson, party_reference: f.referenceNumber });
    setBusy(false);
    if (r1.error || r2.error) { setMsg(friendlyRpcError(r1.error || r2.error)); return; }
    onDone?.();
  }

  return (
    <div>
      <SimpleField label={lang === "gu" ? "પાર્ટી/ગ્રાહકનું નામ" : "Party / Customer Name"} value={f.customerName} onChange={(v) => setF({ ...f, customerName: v })} />
      <SimpleField label={lang === "gu" ? "પ્રોજેક્ટ/સાઈટ" : "Project / Site"} value={f.siteLocation} onChange={(v) => setF({ ...f, siteLocation: v })} />
      <SimpleField label={lang === "gu" ? "સંપર્ક વ્યક્તિ" : "Contact Person"} value={f.contactPerson} onChange={(v) => setF({ ...f, contactPerson: v })} />
      <SimpleField label={lang === "gu" ? "સંદર્ભ નંબર" : "Reference Number"} value={f.referenceNumber} onChange={(v) => setF({ ...f, referenceNumber: v })} />
      <FieldPhotoProof lang={lang} entityId={job.id} sectionKey="party_photo" required label={lang === "gu" ? "પાર્ટી/ઓર્ડર ફોટો" : "Party/Order Reference Photo"} />
      {canEdit && <button type="button" className="btn btn-primary" style={{ minHeight: 44, marginTop: 8 }} disabled={busy} onClick={save}>{lang === "gu" ? "સાચવો" : "Save"}</button>}
      {msg && <div className="msg error" style={{ marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

function DeliverySection({ job, lang, canEdit, onDone }) {
  const [f, setF] = useState({ requiredDate: job.required_date || "", plannedCompletion: job.segment_specs?.planned_completion || "",
    address: job.segment_specs?.delivery_address || job.site_location || "", instructions: job.segment_specs?.delivery_instructions || "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function save() {
    setBusy(true); setMsg(null);
    const r1 = await updateDetails(job.id, { required_date: f.requiredDate });
    const r2 = await updateSegmentSpecs(job.id, { planned_completion: f.plannedCompletion, delivery_address: f.address, delivery_instructions: f.instructions });
    setBusy(false);
    if (r1.error || r2.error) { setMsg(friendlyRpcError(r1.error || r2.error)); return; }
    onDone?.();
  }

  return (
    <div>
      <SimpleField label={lang === "gu" ? "જરૂરી ડિલિવરી તારીખ" : "Required Delivery Date"} type="date" value={f.requiredDate} onChange={(v) => setF({ ...f, requiredDate: v })} />
      <SimpleField label={lang === "gu" ? "ફેક્ટરી પૂર્ણતા તારીખ" : "Planned Factory Completion"} type="date" value={f.plannedCompletion} onChange={(v) => setF({ ...f, plannedCompletion: v })} />
      <SimpleField label={lang === "gu" ? "ડિલિવરી/સાઈટ સરનામું" : "Delivery / Site Address"} value={f.address} onChange={(v) => setF({ ...f, address: v })} />
      <SimpleField label={lang === "gu" ? "ડિલિવરી સૂચનાઓ" : "Delivery Instructions"} value={f.instructions} onChange={(v) => setF({ ...f, instructions: v })} />
      <FieldPhotoProof lang={lang} entityId={job.id} sectionKey="delivery_photo" label={lang === "gu" ? "ડિલિવરી સંદર્ભ ફોટો" : "Delivery Reference Photo"} />
      {canEdit && <button type="button" className="btn btn-primary" style={{ minHeight: 44, marginTop: 8 }} disabled={busy} onClick={save}>{lang === "gu" ? "સાચવો" : "Save"}</button>}
      {msg && <div className="msg error" style={{ marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

function PrioritySection({ job, lang, canEdit, onDone }) {
  const [priority, setPriority] = useState(job.priority || "Normal");
  const [f, setF] = useState({ reason: job.segment_specs?.priority_reason || "", approvedBy: job.segment_specs?.priority_approved_by || "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const BTNS = [["Normal", "🟢"], ["High", "🟠"], ["Urgent", "🔴"]];

  async function save() {
    setBusy(true); setMsg(null);
    const r1 = await updateDetails(job.id, { priority });
    const r2 = await updateSegmentSpecs(job.id, { priority_reason: f.reason, priority_approved_by: f.approvedBy });
    setBusy(false);
    if (r1.error || r2.error) { setMsg(friendlyRpcError(r1.error || r2.error)); return; }
    onDone?.();
  }

  return (
    <div>
      <div className="task-meta" style={{ gap: 8 }}>
        {BTNS.map(([p, icon]) => (
          <button key={p} type="button" className={`btn ${priority === p ? "btn-primary" : "btn-outline"}`} disabled={!canEdit}
            style={{ minHeight: 48, width: "auto" }} onClick={() => setPriority(p)}>{icon} {p}</button>
        ))}
      </div>
      <SimpleField label={lang === "gu" ? "કારણ" : "Priority Reason"} value={f.reason} onChange={(v) => setF({ ...f, reason: v })} />
      <SimpleField label={lang === "gu" ? "મંજૂર કરનાર" : "Approved By"} value={f.approvedBy} onChange={(v) => setF({ ...f, approvedBy: v })} />
      <FieldPhotoProof lang={lang} entityId={job.id} sectionKey="priority_photo" label={lang === "gu" ? "પ્રાથમિકતા સંદર્ભ ફોટો" : "Priority Reference Photo"} />
      {canEdit && <button type="button" className="btn btn-primary" style={{ minHeight: 44, marginTop: 8 }} disabled={busy} onClick={save}>{lang === "gu" ? "સાચવો" : "Save"}</button>}
      {msg && <div className="msg error" style={{ marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

// Material = BOM / Costing / Priority -- three large sub-buttons, progressive disclosure again. Costing is
// gated client-side (role.isManager -- Head/Management/Supervisor) AND the data itself is only ever stored in
// segment_specs.costing, which this component is the only place in the app that reads/writes -- an ordinary
// worker's UI never requests or renders it.
function MaterialSection({ job, lang, canEdit, isManager, navigate, segment, onDone }) {
  const [sub, setSub] = useState(null);
  const [bom, setBom] = useState(job.segment_specs?.bom || []);
  const [item, setItem] = useState({ name: "", spec: "", quantity: "", unit: "Nos", available: true, requiredDate: "" });
  const [cost, setCost] = useState({ material: job.segment_specs?.costing?.material || "", labour: job.segment_specs?.costing?.labour || "",
    other: job.segment_specs?.costing?.other || "", note: job.segment_specs?.costing?.note || "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const total = (Number(cost.material) || 0) + (Number(cost.labour) || 0) + (Number(cost.other) || 0);

  async function addBomItem() {
    if (!item.name.trim() || !(Number(item.quantity) > 0)) return;
    setBusy(true);
    const next = [...bom, { ...item, quantity: Number(item.quantity) }];
    const { error } = await updateSegmentSpecs(job.id, { bom: next });
    setBusy(false);
    if (!error) { setBom(next); setItem({ name: "", spec: "", quantity: "", unit: "Nos", available: true, requiredDate: "" }); onDone?.(); }
  }

  async function saveCosting() {
    setBusy(true); setMsg(null);
    const { error } = await updateSegmentSpecs(job.id, { costing: { ...cost, total } });
    setBusy(false);
    if (error) { setMsg(friendlyRpcError(error)); return; }
    onDone?.();
  }

  if (!sub) {
    return (
      <div className="task-meta" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-outline" style={{ minHeight: 48, width: "auto" }} onClick={() => setSub("bom")}>📋 BOM</button>
        {isManager && <button type="button" className="btn btn-outline" style={{ minHeight: 48, width: "auto" }} onClick={() => setSub("costing")}>💰 {lang === "gu" ? "કોસ્ટિંગ" : "Costing"}</button>}
        <button type="button" className="btn btn-outline" style={{ minHeight: 48, width: "auto" }}
          onClick={() => navigate(`/factory/material-to-order?jobCardId=${job.id}&jobCardLabel=${encodeURIComponent(`${job.job_order_number} · ${job.product_item || ""}`)}`)}>
          📦 {lang === "gu" ? "મટિરિયલ પ્રાથમિકતા" : "Material Priority"}
        </button>
      </div>
    );
  }

  return (
    <div>
      <button type="button" className="fx-tag gold" style={{ width: "auto" }} onClick={() => setSub(null)}>← {lang === "gu" ? "પાછા" : "Back"}</button>
      {sub === "bom" && (
        <div style={{ marginTop: 8 }}>
          {bom.map((b, i) => (
            <div key={i} className="fx-action"><span className="t">{b.name} · {b.quantity} {b.unit}</span><span className="m">{b.spec || "—"}{b.requiredDate ? ` · ${b.requiredDate}` : ""}</span></div>
          ))}
          {canEdit && (
            <>
              <SimpleField label={lang === "gu" ? "મટિરિયલ/આઇટમ નામ" : "Material/Item Name"} value={item.name} onChange={(v) => setItem({ ...item, name: v })} />
              <SimpleField label={lang === "gu" ? "સ્પષ્ટીકરણ" : "Specification"} value={item.spec} onChange={(v) => setItem({ ...item, spec: v })} />
              <div className="task-meta" style={{ gap: 8 }}>
                <SimpleField label={lang === "gu" ? "જથ્થો" : "Quantity"} type="number" value={item.quantity} onChange={(v) => setItem({ ...item, quantity: v })} />
                <SimpleField label={lang === "gu" ? "એકમ" : "Unit"} value={item.unit} onChange={(v) => setItem({ ...item, unit: v })} />
              </div>
              <button type="button" className="btn btn-outline" style={{ minHeight: 44 }} disabled={busy} onClick={addBomItem}>➕ {lang === "gu" ? "ઉમેરો" : "Add Item"}</button>
            </>
          )}
          <FieldPhotoProof lang={lang} entityId={job.id} sectionKey="bom_photo" label={lang === "gu" ? "BOM ફોટો/દસ્તાવેજ" : "BOM Photo/Document"} />
        </div>
      )}
      {sub === "costing" && isManager && (
        <div style={{ marginTop: 8 }}>
          <SimpleField label={lang === "gu" ? "મટિરિયલ ખર્ચ" : "Material Cost"} type="number" value={cost.material} onChange={(v) => setCost({ ...cost, material: v })} />
          <SimpleField label={lang === "gu" ? "મજૂરી ખર્ચ" : "Labour Cost"} type="number" value={cost.labour} onChange={(v) => setCost({ ...cost, labour: v })} />
          <SimpleField label={lang === "gu" ? "અન્ય ખર્ચ" : "Other Approved Cost"} type="number" value={cost.other} onChange={(v) => setCost({ ...cost, other: v })} />
          <div className="sub" style={{ marginTop: 4, fontWeight: 700 }}>{lang === "gu" ? "કુલ" : "Total"}: {total}</div>
          <SimpleField label={lang === "gu" ? "નોંધ" : "Note"} value={cost.note} onChange={(v) => setCost({ ...cost, note: v })} />
          <FieldPhotoProof lang={lang} entityId={job.id} sectionKey="costing_photo" required label={lang === "gu" ? "કોસ્ટિંગ પુરાવો" : "Costing Proof / Quotation"} />
          <button type="button" className="btn btn-primary" style={{ minHeight: 44, marginTop: 8 }} disabled={busy} onClick={saveCosting}>{lang === "gu" ? "સાચવો" : "Save"}</button>
          {msg && <div className="msg error" style={{ marginTop: 6 }}>{msg}</div>}
        </div>
      )}
      {void segment}
    </div>
  );
}

const FEATURES = [
  ["po", "📄", { en: "PO Received", gu: "PO મળ્યું" }],
  ["party", "🧾", { en: "Party Name", gu: "પાર્ટી નામ" }],
  ["delivery", "🚚", { en: "Delivery Date", gu: "ડિલિવરી તારીખ" }],
  ["priority", "🚩", { en: "Priority", gu: "પ્રાથમિકતા" }],
  ["wip", "🛠️", { en: "WIP", gu: "WIP" }],
  ["material", "📦", { en: "Material", gu: "મટિરિયલ" }],
];

function FeatureSections({ job, lang, role, mine, onDone }) {
  const navigate = useNavigate();
  const [active, setActive] = useState(null);
  const canEdit = role.isManager || mine;
  const segmentRoute = DIVISION_META[job.division_code]?.route;

  function openFeature(key) {
    if (key === "wip") {
      if (!segmentRoute) { setActive("wip-needs-division"); return; }
      navigate(`/factory/${segmentRoute}/${job.id}/wip`);
      return;
    }
    setActive(active === key ? null : key);
  }

  return (
    <section className="fx-section">
      <div className="fx-cards" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        {FEATURES.map(([key, icon, lbl]) => (
          <button key={key} type="button" className={`fx-card ${active === key ? "hot" : ""}`} onClick={() => openFeature(key)}>
            <span className="n" style={{ fontSize: 22 }}>{icon}</span>
            <span className="l">{lang === "gu" ? lbl.gu : lbl.en}</span>
          </button>
        ))}
      </div>
      {active === "wip-needs-division" && (
        <div className="msg info" style={{ marginTop: 8 }}>{lang === "gu" ? "પહેલા ઉપર ફેક્ટરી સેગમેન્ટ પસંદ કરો" : "Select a Factory segment above first"}</div>
      )}
      {active === "po" && <div style={{ marginTop: 10 }}><PoSection job={job} lang={lang} canEdit={canEdit} onDone={onDone} /></div>}
      {active === "party" && <div style={{ marginTop: 10 }}><PartySection job={job} lang={lang} canEdit={canEdit} onDone={onDone} /></div>}
      {active === "delivery" && <div style={{ marginTop: 10 }}><DeliverySection job={job} lang={lang} canEdit={canEdit} onDone={onDone} /></div>}
      {active === "priority" && <div style={{ marginTop: 10 }}><PrioritySection job={job} lang={lang} canEdit={canEdit && role.isManager} onDone={onDone} /></div>}
      {active === "material" && <div style={{ marginTop: 10 }}><MaterialSection job={job} lang={lang} canEdit={canEdit} isManager={role.isManager} navigate={navigate} segment={segmentRoute} onDone={onDone} /></div>}
    </section>
  );
}

// The real, button-based "WIP Stage Updates" workflow (handwritten spec): one row per division-configured stage,
// Start/Complete buttons, and a mandatory photo before a photo-required stage can complete -- the server (not
// this component) is the actual gate; a disabled button here is just a head start on the same rule.
export function StagesTab({ job, lang, canAct, onDone }) {
  const [stages, setStages] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    listJobStages(job.id).then(({ data }) => setStages(data || []));
  }, [job.id]);
  useEffect(() => { load(); }, [load, job.updated_at]);

  if (!job.division_id) {
    return <div className="fx-empty">{lang === "gu" ? "પહેલા ફેક્ટરી સેગમેન્ટ પસંદ કરો (ઉપર)" : "Select a Factory segment above before tracking production stages"}</div>;
  }
  if (job.factory_status !== "in_production" && job.factory_status !== "blocked") {
    return <div className="fx-empty">{lang === "gu" ? "સ્ટેજ ફક્ત ઉત્પાદન ચાલુ હોય ત્યારે જ અપડેટ થાય છે" : "Stages can be tracked once this Job Card is in production"}</div>;
  }
  if (stages === null) return <div className="skeleton-block" style={{ height: 120 }} />;

  const activeIdx = stages.findIndex((s) => s.status !== "completed");
  const current = activeIdx >= 0 ? stages[activeIdx] : null;
  const rest = stages.filter((_, i) => i !== activeIdx);

  async function doStart(s) {
    setBusy(true); setMsg(null);
    const { error } = await startStage(job.id, s.stage_code, null);
    setBusy(false);
    if (error) { setMsg(friendlyRpcError(error)); return; }
    load(); onDone?.();
  }
  async function doComplete(s) {
    setBusy(true); setMsg(null);
    const { error } = await completeStage(job.id, s.stage_code, note || null);
    setBusy(false);
    if (error) { setMsg(friendlyRpcError(error)); return; }
    setNote("");
    load(); onDone?.();
  }

  function Row({ s, big }) {
    const badgeClass = s.status === "completed" ? "ok" : s.status === "in_progress" ? "info" : "";
    const photoBlocked = s.requires_photo && s.status === "in_progress" && s.photo_count === 0;
    return (
      <div className={big ? "fx-section" : "fx-action"} style={big ? { marginTop: 10 } : { marginTop: 8 }}>
        <div className="task-meta" style={{ justifyContent: "space-between" }}>
          <strong>{lang === "gu" ? s.name_gu : s.name_en}</strong>
          <span className={`badge ${badgeClass}`}>
            {s.status === "completed" ? (lang === "gu" ? "પૂર્ણ" : "Completed")
              : s.status === "in_progress" ? (lang === "gu" ? "ચાલુ" : "In Progress")
              : (lang === "gu" ? "બાકી" : "Pending")}
          </span>
        </div>
        {s.requires_photo && <span className="fx-tag gold" style={{ marginTop: 4 }}>📷 {lang === "gu" ? "ફોટો જરૂરી" : "Photo required"}</span>}
        {s.status === "completed" && (
          <div className="sub" style={{ marginTop: 4 }}>
            {s.completed_by_name || "—"} · {fmtDateTime(s.completed_at)}
          </div>
        )}
        {big && s.status === "in_progress" && (
          <div style={{ marginTop: 8 }}>
            <div className="sub">{lang === "gu" ? `શરૂ: ${s.started_by_name || "—"}` : `Started by ${s.started_by_name || "—"}`} · {fmtDateTime(s.started_at)}</div>
            {s.stage_update_id && (
              <>
                <ProofPhotoUpload lang={lang} entityType="factory_job_card_stage" entityId={s.stage_update_id} existingCount={s.photo_count} onUploaded={load} />
                <ProofPhotoViewer lang={lang} entityType="factory_job_card_stage" entityId={s.stage_update_id} />
              </>
            )}
            {canAct && (
              <>
                <input type="text" placeholder={lang === "gu" ? "ટૂંકી નોંધ (વૈકલ્પિક)" : "Short note (optional)"} value={note} onChange={(e) => setNote(e.target.value)} style={{ marginTop: 6 }} />
                <button type="button" className="btn btn-primary" style={{ marginTop: 6, minHeight: 48 }} disabled={busy || photoBlocked} onClick={() => doComplete(s)}>
                  🔄 {lang === "gu" ? "સ્ટેજ પૂર્ણ કરો" : "Complete Stage"}
                </button>
                {photoBlocked && <div className="sub" style={{ color: "var(--danger)" }}>{lang === "gu" ? "પૂર્ણ કરવા માટે ફોટો જરૂરી છે" : "A photo is required before this stage can be completed"}</div>}
              </>
            )}
          </div>
        )}
        {big && s.status === "pending" && canAct && (
          <button type="button" className="btn btn-primary" style={{ marginTop: 8, minHeight: 48 }} disabled={busy} onClick={() => doStart(s)}>
            ▶️ {lang === "gu" ? "સ્ટેજ શરૂ કરો" : "Start Stage"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="sub">{job.completion_percentage ?? 0}% {lang === "gu" ? "પૂર્ણ" : "complete"}</div>
      {current ? <Row s={current} big /> : <div className="fx-empty">{lang === "gu" ? "બધા સ્ટેજ પૂર્ણ" : "All stages completed"}</div>}
      {msg && <div className="msg error" style={{ marginTop: 8 }}>{msg}</div>}
      <button type="button" className="btn btn-outline" style={{ marginTop: 10, width: "auto" }} onClick={() => setShowAll((v) => !v)}>
        {showAll ? (lang === "gu" ? "ઓછું બતાવો" : "Hide other stages") : (lang === "gu" ? "બધા સ્ટેજ બતાવો" : `Show all stages (${stages.length})`)}
      </button>
      {showAll && rest.map((s) => <Row key={s.stage_code} s={s} />)}
    </div>
  );
}

// Only the actions that are valid for this status AND this person are shown;
// the database re-checks every one of them regardless.
function QuickActions({ job, role, mine, isSource, goTab, onDone, onOpenUpdate }) {
  const navigate = useNavigate();
  const [ask, setAsk] = useState(null); // { action, title, required }
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const s = job.factory_status;
  const mgr = role.isManager;
  const head = role.isHead;
  const buttons = [];
  const go = (action, note) => async () => {
    if (busy) return;
    setBusy(true); setMsg(null);
    const { error } = await jobTransition(job.id, action, note || null);
    setBusy(false);
    if (error) { setMsg({ type: "error", text: friendlyRpcError(error) }); return; }
    setAsk(null); setText(""); onDone?.();
  };
  const withNote = (action, title, required = true) => () => { setAsk({ action, title, required }); setText(""); setMsg(null); };

  if (s === "pending_verification" && mgr) {
    buttons.push(["Accept", "btn-primary", go("accept")]);
    buttons.push(["Return for Clarification", "btn-outline", withNote("return", "What needs clarification?")]);
    if (SOURCE_ROUTE[job.source_module]) buttons.push(["View Source Order", "btn-outline", () => navigate(SOURCE_ROUTE[job.source_module])]);
    buttons.push(["View Drawings", "btn-outline", () => goTab("files")]);
  }
  if (s === "accepted" && mgr) {
    buttons.push(["Assign Team", "btn-primary", () => goTab("assign")]);
    buttons.push(["Set Plan Date", "btn-outline", () => goTab("assign")]);
    buttons.push(["Return for Clarification", "btn-outline", withNote("return", "What needs clarification?")]);
  }
  if (s === "assigned" && (mgr || mine)) {
    buttons.push(["Start Production", "btn-primary", go("start")]);
    buttons.push(["Put On Hold", "btn-outline", withNote("block", "Why is it on hold?")]);
    if (mgr) buttons.push(["Reassign", "btn-outline", () => goTab("assign")]);
  }
  if (s === "in_production" && (mgr || mine)) {
    buttons.push(["Update Progress", "btn-primary", onOpenUpdate]);
    buttons.push(["Mark Blocked", "btn-outline", withNote("block", "What is blocking the work?")]);
    buttons.push(["Upload Photo", "btn-outline", () => goTab("files")]);
    buttons.push(["Mark Ready", "btn-gold", go("mark_ready")]);
  }
  if (s === "blocked" && (mgr || mine)) buttons.push(["Unblock — resume work", "btn-primary", go("unblock")]);
  if (s === "ready_for_review" && head) buttons.push(["Approve completion", "btn-primary", go("complete")]);
  if (s === "needs_clarification") {
    if (isSource || mgr) buttons.push(["Re-submit after correction", "btn-primary", withNote("resubmit", "What did you correct? (optional)", false)]);
    buttons.push(["View Clarification", "btn-outline", () => goTab("verify")]);
  }
  if (s === "completed") {
    buttons.push(["View Final Summary", "btn-outline", () => goTab("summary")]);
    if (head) buttons.push(["Reopen", "btn-outline", withNote("reopen", "Reason for reopening")]);
  }
  if (s === "cancelled" && head) buttons.push(["Reopen", "btn-outline", withNote("reopen", "Reason for reopening")]);
  if (head && !["completed", "cancelled"].includes(s)) buttons.push(["Cancel Job Card", "btn-outline", withNote("cancel", "Reason for cancelling")]);

  if (buttons.length === 0) return null;
  return (
    <section className="fx-section" aria-label="Actions">
      <div className="fx-bigbtns">
        {buttons.map(([lbl, cls, fn]) => <button key={lbl} type="button" className={`btn ${cls}`} disabled={busy} onClick={fn}>{lbl}</button>)}
      </div>
      {ask && (
        <div className="field" style={{ marginTop: 10 }}>
          <label>{ask.title}{ask.required ? " *" : ""}</label>
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} autoFocus />
          <div className="btn-row">
            <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy || (ask.required && !text.trim())} onClick={go(ask.action, text)}>{busy ? "Saving…" : "Confirm"}</button>
            <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={busy} onClick={() => setAsk(null)}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <div className={`msg ${msg.type}`} style={{ marginTop: 8 }}>{msg.text}</div>}
    </section>
  );
}

export default function FactoryJobCardPage({ lang, profile, lookups }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const role = roleInfo(profile, lookups);
  const [job, setJob] = useState(undefined); // undefined = loading, null = not found
  const [items, setItems] = useState([]);
  const [files, setFiles] = useState([]);
  const [events, setEvents] = useState([]);
  const [people, setPeople] = useState([]);
  const [locations, setLocations] = useState([]);
  const [myProfile, setMyProfile] = useState(null);
  const [tab, setTab] = useState("summary");
  const [error, setError] = useState(false);
  const [preview, setPreview] = useState(null);
  const viewed = useRef(false);
  const updateRef = useRef(null);

  useEffect(() => { supabase.rpc("factory_my_profile_id").then(({ data }) => setMyProfile(data || null)); }, []);
  useEffect(() => { listFactoryLocations().then(({ data }) => setLocations(data || [])); }, []);
  useEffect(() => { if (role.isManager) listFactoryPeople().then(({ data }) => setPeople(data || [])); }, [role.isManager]);

  const load = useCallback(async () => {
    const [j, it, fl, ev] = await Promise.all([getJobCard(id), listJobItems(id), listJobFiles(id), listJobEvents(id)]);
    if (j.error || it.error || fl.error || ev.error) {
      console.error("[FactoryJobCard] load failed", { job: j.error?.message, items: it.error?.message, files: fl.error?.message, events: ev.error?.message });
      setError(true);
      return;
    }
    setError(false);
    setJob(j.data || null);
    setItems(it.data || []);
    setFiles(fl.data || []);
    setEvents(ev.data || []);
  }, [id]);

  useEffect(() => { setJob(undefined); viewed.current = false; load(); }, [load]);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => subscribeJobDetail(id, () => loadRef.current()), [id]);

  useEffect(() => {
    if (job && role.isManager && !job.viewed_at && !viewed.current && job.factory_status === "pending_verification") {
      viewed.current = true;
      markViewed(job.id);
    }
  }, [job, role.isManager]);

  if (error) {
    return (
      <div className="fx-page">
        <div className="msg error">Unable to load this Job Card <button type="button" className="btn btn-outline" style={{ width: "auto", marginLeft: 8 }} onClick={load}>Retry</button></div>
      </div>
    );
  }
  if (job === undefined) return <div className="fx-page"><div className="skeleton-block" style={{ height: 200 }} /></div>;
  if (job === null) {
    return (
      <div className="fx-page">
        <div className="fx-empty">This Job Card was not found, or you do not have access to it.</div>
        <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => navigate(-1)}>← Back</button>
      </div>
    );
  }

  const mine = !!myProfile && (job.assigned_factory_coordinator === myProfile || job.second_assignee_coordinator === myProfile);
  const isSource = job.requested_by === profile?.id;
  const sourceCanEdit = (isSource || (!!job.source_department_id && job.source_department_id === profile?.department_id)) && ["pending_verification", "needs_clarification"].includes(job.factory_status);
  const canEditItems = role.isManager || sourceCanEdit;
  const canUpload = role.isManager || sourceCanEdit || mine;
  const showNav = role.inFactory || role.admin;
  const locName = locations.find((l) => l.id === job.factory_location_id)?.name;
  const open = ["assigned", "in_production", "blocked"].includes(job.factory_status);
  const tabs = [
    ["summary", "Summary"], ["items", `Items (${items.length})`], ["files", `Drawings & Files (${files.length})`],
    ["verify", `Verification${job.missing_count > 0 && ["pending_verification", "needs_clarification"].includes(job.factory_status) ? ` (${job.missing_count})` : ""}`],
    ["stages", `Stages${job.completion_percentage ? ` (${job.completion_percentage}%)` : ""}`],
    ["tasks", "Tasks"], ["assign", "Assignment"], ["activity", "Activity"],
  ];

  return (
    <div className="fx-page">
      <FactoryHeader lang={lang} profile={profile} title={job.job_order_number} onRefresh={load} showNav={showNav} />
      {!showNav && <div><Link to="/factory-requests" className="fx-tag gold">← {lang === "gu" ? "મારી વિનંતીઓ" : "My Factory Requests"}</Link></div>}

      <div className="task-meta" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className={`badge ${STATUS[job.factory_status]?.badge}`}>{label(STATUS, job.factory_status, lang)}</span>
        {job.is_delayed && <span className="fx-tag bad">{job.is_blocked ? "Blocked" : "Delayed"}</span>}
        <span className="fx-tag">{job.priority}</span>
        <strong>{job.product_item || "—"}</strong>
      </div>
      <div style={{ marginTop: 4 }}>
        <DivisionPicker job={job} lang={lang} isHead={role.isHead} onDone={load} />
      </div>

      <FeatureSections job={job} lang={lang} role={role} mine={mine} onDone={load} />

      {job.factory_status === "needs_clarification" && (
        <div className="msg info"><strong>Returned for clarification:</strong> {job.clarification_note || "—"}</div>
      )}
      {job.factory_status === "blocked" && <div className="msg error"><strong>Blocked:</strong> {job.blocked_reason || "—"}</div>}

      <div><ChatButton jobId={job.id} label="💬 Job Card chat" /></div>

      <KeyDrawings files={files} onOpen={setPreview} />
      <QuickActions job={job} role={role} mine={mine} isSource={isSource} goTab={setTab} onDone={load} onOpenUpdate={() => updateRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} />
      {open && (role.isManager || mine) && (
        <div ref={updateRef}><ProductionUpdate job={job} isManager={role.isManager} onDone={load} /></div>
      )}

      <div className="fx-tabs2" role="tablist">
        {tabs.map(([k, lbl]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{lbl}</button>)}
      </div>

      <section className="fx-section">
        {tab === "summary" && (
          <>
            <div className="fx-kv">
              <div><div className="k">Job Card</div><div className="v">{job.job_order_number}</div></div>
              <div><div className="k">Source department</div><div className="v">{(lang === "gu" ? job.source_department_name_gu : null) || job.source_department_name || "—"} · {job.source_module || "—"}</div></div>
              <div><div className="k">Source order / project</div><div className="v">{job.source_reference || "—"}{job.project_code ? ` · ${job.project_code}` : ""}</div></div>
              <div><div className="k">Requested by</div><div className="v">{job.requested_by_name || "—"}</div></div>
              <div><div className="k">Customer</div><div className="v">{job.customer_name || "—"}</div></div>
              <div><div className="k">Site / delivery</div><div className="v">{job.site_location || "—"}</div></div>
              <div><div className="k">Required date</div><div className="v">{fmtDate(job.required_date)}</div></div>
              <div><div className="k">Priority</div><div className="v">{job.priority}</div></div>
              <div><div className="k">Status</div><div className="v">{label(STATUS, job.factory_status, lang)}</div></div>
              <div><div className="k">Factory / location</div><div className="v">{locName || "—"}</div></div>
              <div><div className="k">Coordinator / team</div><div className="v">{job.assigned_name ? `${job.assigned_name}${job.second_name ? ` + ${job.second_name}` : ""}` : "Not assigned"}{job.production_department ? ` · ${job.production_department}` : ""}</div></div>
              <div><div className="k">Current stage</div><div className="v">{job.current_stage || "—"}</div></div>
              <div><div className="k">Created</div><div className="v">{fmtDateTime(job.created_at)}</div></div>
              <div><div className="k">Last update</div><div className="v">{fmtDateTime(job.updated_at)}</div></div>
            </div>
            {(role.isManager || sourceCanEdit) && <div style={{ marginTop: 10 }}><DetailsEditor key={job.updated_at} job={job} isManager={role.isManager} onDone={load} /></div>}
          </>
        )}
        {tab === "items" && <ItemsTab jobId={job.id} items={items} canEdit={canEditItems} onChanged={load} />}
        {tab === "files" && <FilesTab jobId={job.id} files={files} canUpload={canUpload} onOpen={setPreview} onChanged={load} />}
        {tab === "verify" && <VerificationTab job={job} items={items} files={files} onGoItems={() => setTab("items")} onGoFiles={() => setTab("files")} />}
        {tab === "stages" && <StagesTab job={job} lang={lang} canAct={role.isManager || mine} onDone={load} />}
        {tab === "tasks" && <FactoryJobTasks job={job} lang={lang} lookups={lookups} canCreate={role.isManager} />}
        {tab === "assign" && <AssignmentTab key={job.updated_at} job={job} people={people} canAssign={role.isManager} onDone={load} />}
        {tab === "activity" && <ActivityTab jobId={job.id} events={events} canComment onChanged={load} />}
      </section>

      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
