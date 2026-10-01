import React, { useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import FactoryHeader from "./FactoryHeader.jsx";
import FieldPhotoProof from "../../components/FieldPhotoProof.jsx";
import { createSegmentJob, updateSegmentSpecs } from "../../lib/factoryApi";
import { PRIORITIES, DIVISION_META, friendlyRpcError } from "./factoryConstants";

const DIVISION_BY_ROUTE = { sofa: "SOFA", modular: "MODULAR", "metal-fabrication": "METAL_FAB" };

// New [Segment] Job -- a real, three-step, worker-friendly creation flow (handwritten spec: "Step 1 of 3",
// Previous/Next, large buttons, camera over typing). Step 1 creates the real Job Card (so Steps 2-3 can attach
// specs/photos to a real id -- staff_record_attachment requires its parent to already exist); Steps 2-3 are
// then genuine edits against that row, and "Finish" is just navigation to the now-real, now-complete Job Card.
export default function FactorySegmentNewJob({ lang, profile }) {
  const { segment } = useParams();
  const navigate = useNavigate();
  const divisionCode = DIVISION_BY_ROUTE[segment];
  const meta = DIVISION_META[divisionCode];
  const idemKey = useRef(`seg-${divisionCode}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const [step, setStep] = useState(1);
  const [job, setJob] = useState(null); // {job_id, job_order_number} once Step 1 is saved
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [poCount, setPoCount] = useState(0);
  const [productCount, setProductCount] = useState(0);

  const [f, setF] = useState({
    customerName: "", productItem: "", quantity: "", unit: "Nos", requiredDate: "", priority: "Normal",
    poReceived: false, poNumber: "", poDate: "", notes: "",
  });
  const [specs, setSpecs] = useState({});

  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const setSpec = (k, v) => setSpecs((s) => ({ ...s, [k]: v }));

  const step1Valid = useMemo(() => f.productItem.trim() && Number(f.quantity) > 0 && f.requiredDate, [f]);

  if (!meta) {
    return <div className="fx-page"><div className="fx-empty">Unknown Factory segment</div></div>;
  }

  async function saveStep1AndNext() {
    if (!step1Valid) { setError(lang === "gu" ? "પ્રોડક્ટ, જથ્થો અને તારીખ જરૂરી છે" : "Product, quantity and delivery date are required"); return; }
    setError(null);
    if (job) { setStep(2); return; } // already created -- just navigate forward
    setBusy(true);
    const { data, error: err } = await createSegmentJob({
      divisionCode, customerName: f.customerName, productItem: f.productItem, quantity: Number(f.quantity), unit: f.unit,
      requiredDate: f.requiredDate, priority: f.priority, notes: f.notes, poReceived: f.poReceived, poNumber: f.poNumber,
      poDate: f.poDate || null, idempotencyKey: idemKey.current,
    });
    setBusy(false);
    if (err) { setError(friendlyRpcError(err)); return; }
    setJob(data);
    setStep(2);
  }

  async function saveStep2AndNext() {
    setBusy(true); setError(null);
    const { error: err } = await updateSegmentSpecs(job.job_id, specs);
    setBusy(false);
    if (err) { setError(friendlyRpcError(err)); return; }
    setStep(3);
  }

  const photosOk = productCount > 0 && (!f.poReceived || poCount > 0);

  return (
    <div className="fx-page">
      <FactoryHeader lang={lang} profile={profile} title={`${lang === "gu" ? "નવું" : "New"} ${lang === "gu" ? meta.gu : meta.en} ${lang === "gu" ? "કામ" : "Job"}`}
        showNav={false} />
      <button type="button" className="fx-tag gold" style={{ width: "auto" }} onClick={() => navigate(`/factory/${meta.route}`)}>
        ← {lang === "gu" ? "પાછા" : "Back"}
      </button>

      <div className="sub">{lang === "gu" ? `પગલું ${step} માંથી 3` : `Step ${step} of 3`}</div>
      {error && <div className="msg error">{error}</div>}

      {step === 1 && (
        <section className="fx-section">
          <h2>{lang === "gu" ? "ઓર્ડરની માહિતી" : "Order Information"}</h2>
          <div className="field"><label>{lang === "gu" ? "પાર્ટી/ગ્રાહકનું નામ" : "Party / Customer Name"}</label>
            <input type="text" value={f.customerName} onChange={(e) => set("customerName", e.target.value)} /></div>
          <div className="field"><label>{lang === "gu" ? "પ્રોડક્ટ *" : "Product *"}</label>
            <input type="text" value={f.productItem} onChange={(e) => set("productItem", e.target.value)} /></div>
          <div className="task-meta" style={{ gap: 10 }}>
            <div className="field" style={{ flex: 1 }}><label>{lang === "gu" ? "જથ્થો *" : "Quantity *"}</label>
              <input type="number" min="1" value={f.quantity} onChange={(e) => set("quantity", e.target.value)} /></div>
            <div className="field" style={{ flex: 1 }}><label>{lang === "gu" ? "એકમ" : "Unit"}</label>
              <input type="text" value={f.unit} onChange={(e) => set("unit", e.target.value)} /></div>
          </div>
          <div className="field"><label>{lang === "gu" ? "ડિલિવરી તારીખ *" : "Delivery Date *"}</label>
            <input type="date" value={f.requiredDate} onChange={(e) => set("requiredDate", e.target.value)} /></div>
          <div className="field"><label>{lang === "gu" ? "પ્રાથમિકતા" : "Priority"}</label>
            <select value={f.priority} onChange={(e) => set("priority", e.target.value)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select></div>

          <h2 style={{ marginTop: 14 }}>{lang === "gu" ? "PO" : "PO"}</h2>
          <label className="task-meta" style={{ gap: 8 }}>
            <input type="checkbox" checked={f.poReceived} onChange={(e) => set("poReceived", e.target.checked)} style={{ width: "auto", minHeight: "auto" }} />
            {lang === "gu" ? "PO મળ્યું છે" : "PO Received"}
          </label>
          {f.poReceived && (
            <div className="task-meta" style={{ gap: 10 }}>
              <div className="field" style={{ flex: 1 }}><label>{lang === "gu" ? "PO નંબર" : "PO Number"}</label>
                <input type="text" value={f.poNumber} onChange={(e) => set("poNumber", e.target.value)} /></div>
              <div className="field" style={{ flex: 1 }}><label>{lang === "gu" ? "PO તારીખ" : "PO Date"}</label>
                <input type="date" value={f.poDate} onChange={(e) => set("poDate", e.target.value)} /></div>
            </div>
          )}
          <div className="field"><label>{lang === "gu" ? "ખાસ સૂચનાઓ" : "Special Instructions"}</label>
            <textarea rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} /></div>

          <button type="button" className="btn btn-primary" style={{ minHeight: 48, marginTop: 10 }} disabled={busy} onClick={saveStep1AndNext}>
            {lang === "gu" ? "આગળ →" : "Next →"}
          </button>
        </section>
      )}

      {step === 2 && job && (
        <section className="fx-section">
          <h2>{lang === "gu" ? "સ્પષ્ટીકરણો" : "Specifications"}</h2>
          <div className="sub">{job.job_order_number}</div>
          {meta.specFields.map(([key, lbl]) => (
            <div className="field" key={key}><label>{lang === "gu" ? lbl.gu : lbl.en}</label>
              <input type="text" value={specs[key] || ""} onChange={(e) => setSpec(key, e.target.value)} /></div>
          ))}
          <div className="task-meta" style={{ gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-outline" style={{ minHeight: 48, width: "auto" }} onClick={() => setStep(1)}>
              ← {lang === "gu" ? "પાછળ" : "Previous"}
            </button>
            <button type="button" className="btn btn-primary" style={{ minHeight: 48, width: "auto" }} disabled={busy} onClick={saveStep2AndNext}>
              {lang === "gu" ? "આગળ →" : "Next →"}
            </button>
          </div>
        </section>
      )}

      {step === 3 && job && (
        <section className="fx-section">
          <h2>{lang === "gu" ? "ફોટો પુરાવો" : "Photo Proof"}</h2>
          <div className="sub">{job.job_order_number}</div>
          {f.poReceived && (
            <FieldPhotoProof lang={lang} entityId={job.job_id} sectionKey="po_photo" required myUserId={profile?.id}
              label={lang === "gu" ? "PO ફોટો" : "PO Photo"} onCountChange={setPoCount} />
          )}
          <FieldPhotoProof lang={lang} entityId={job.job_id} sectionKey="product_photo" required myUserId={profile?.id}
            label={lang === "gu" ? "પ્રોડક્ટ ફોટો" : "Product Photo"} onCountChange={setProductCount} />
          <FieldPhotoProof lang={lang} entityId={job.job_id} sectionKey="drawing_photo" myUserId={profile?.id}
            label={lang === "gu" ? "ડ્રોઈંગ / સંદર્ભ ફોટો" : "Drawing / Reference Photo"} />

          <div className="task-meta" style={{ gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-outline" style={{ minHeight: 48, width: "auto" }} onClick={() => setStep(2)}>
              ← {lang === "gu" ? "પાછળ" : "Previous"}
            </button>
            <button type="button" className="btn btn-primary" style={{ minHeight: 48, width: "auto" }} disabled={!photosOk}
              onClick={() => navigate(`/factory/${meta.route}/${job.job_id}`)}>
              🏁 {lang === "gu" ? "પૂર્ણ કરો" : "Finish"}
            </button>
          </div>
          {!photosOk && <div className="sub" style={{ color: "var(--danger)", marginTop: 6 }}>{lang === "gu" ? "જરૂરી ફોટો અપલોડ કરો" : "Upload the required photo(s) to finish"}</div>}
        </section>
      )}
    </div>
  );
}
