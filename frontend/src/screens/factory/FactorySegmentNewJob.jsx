import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import FactoryHeader from "./FactoryHeader.jsx";
import { factoryAiSubmit, FACTORY_AI_ALLOWED_EXTS, FACTORY_AI_MAX_FILE_MB } from "../../lib/interiorApi";
import { listDivisions } from "../../lib/factoryApi";
import { PRIORITIES, DIVISION_META } from "./factoryConstants";

const DIVISION_BY_ROUTE = { sofa: "SOFA", modular: "MODULAR", "metal-fabrication": "METAL_FAB" };

// Phase 1 simplification: "New [Segment] Job" is now photo-first, not a typed form. Take/upload the PO or Order
// Form -> the segment is already known (the page the employee is on) -> submit. The job is created immediately
// and routed to this segment; the existing, already-built AI extraction pipeline (factory-ai-extract edge
// function) reads the file in the background and fills the Job Card, and the existing VerificationTab on the
// Job Card page (not rebuilt here -- it already does exactly "show only what's missing") is where anything it
// couldn't read gets corrected. This replaces the earlier, heavier typed 3-step form with the real reuse the
// spec asks for: "do not re-enter information already available in an uploaded photo/document".
export default function FactorySegmentNewJob({ lang, profile }) {
  const { segment } = useParams();
  const navigate = useNavigate();
  const divisionCode = DIVISION_BY_ROUTE[segment];
  const meta = DIVISION_META[divisionCode];
  const idemKey = useRef(crypto.randomUUID());
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);

  const [divisionId, setDivisionId] = useState(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [priority, setPriority] = useState("Normal");
  const [requiredDate, setRequiredDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  useEffect(() => {
    listDivisions().then(({ data }) => setDivisionId((data || []).find((d) => d.code === divisionCode)?.id || null));
  }, [divisionCode]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const accept = useMemo(() => FACTORY_AI_ALLOWED_EXTS.map((x) => `.${x}`).join(","), []);

  function pick(e, { fromCamera } = {}) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    if (!FACTORY_AI_ALLOWED_EXTS.includes(ext)) { setError(lang === "gu" ? "આ ફાઈલ પ્રકાર સપોર્ટેડ નથી" : "This file type isn't supported"); return; }
    if (f.size > FACTORY_AI_MAX_FILE_MB * 1024 * 1024) { setError(`${lang === "gu" ? "ફાઈલ ખૂબ મોટી છે" : "File is too large"} (max ${FACTORY_AI_MAX_FILE_MB}MB)`); return; }
    setError(null);
    setFile(f);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(f.type.startsWith("image/") ? URL.createObjectURL(f) : null);
    void fromCamera;
  }

  async function submit() {
    if (!file) { setError(lang === "gu" ? "ફોટો અથવા ફાઇલ પસંદ કરો" : "Take a photo or choose a file first"); return; }
    setBusy(true); setError(null);
    const res = await factoryAiSubmit({
      idempotencyKey: idemKey.current, projectId: null, workTitle: file.name, requiredDate: requiredDate || null,
      priority, files: [file], divisionId,
    });
    setBusy(false);
    if (res.error && res.step !== "extract") {
      setError(res.step === "upload" ? (lang === "gu" ? "ફાઈલ અપલોડ નિષ્ફળ. ફરી પ્રયાસ કરો." : "Upload failed. Please retry.") : (lang === "gu" ? "કામ ન થયું. ફરી પ્રયાસ કરો." : "Something went wrong. Please retry."));
      return;
    }
    setDone({ jobId: res.jobId, number: res.jobNumber });
    idemKey.current = crypto.randomUUID();
  }

  if (!meta) return <div className="fx-page"><div className="fx-empty">Unknown Factory segment</div></div>;

  if (done) {
    return (
      <div className="fx-page">
        <FactoryHeader lang={lang} profile={profile} title={`${meta.icon} ${lang === "gu" ? meta.gu : meta.en}`} />
        <section className="fx-section">
          <div className="msg success">
            {lang === "gu" ? `જોબ કાર્ડ ${done.number} બનાવ્યું. વિગતો આપમેળે વંચાઈ રહી છે.` : `Job Card ${done.number} created. Details are being read automatically.`}
          </div>
          <div className="task-meta" style={{ gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-primary" style={{ minHeight: 48, width: "auto" }} onClick={() => navigate(`/factory/${segment}/${done.jobId}`)}>
              {lang === "gu" ? "જોબ કાર્ડ ખોલો →" : "Open Job Card →"}
            </button>
            <button type="button" className="btn btn-outline" style={{ minHeight: 48, width: "auto" }}
              onClick={() => { setDone(null); setFile(null); setPreview(null); setRequiredDate(""); setPriority("Normal"); }}>
              {lang === "gu" ? "બીજું કામ ઉમેરો" : "Add Another"}
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="fx-page">
      <FactoryHeader lang={lang} profile={profile} title={`${lang === "gu" ? "નવું" : "New"} ${lang === "gu" ? meta.gu : meta.en} ${lang === "gu" ? "કામ" : "Job"}`} />
      <button type="button" className="fx-tag gold" style={{ width: "auto" }} onClick={() => navigate(`/factory/${segment}`)}>
        ← {lang === "gu" ? "પાછા" : "Back"}
      </button>

      <section className="fx-section">
        {!file && (
          <div className="fx-hero" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <button type="button" className="fx-seg" onClick={() => cameraInputRef.current?.click()}>
              <span className="icon">📷</span>
              <span className="names"><span className="en">{lang === "gu" ? "ફોટો લો" : "Take Photo"}</span></span>
            </button>
            <button type="button" className="fx-seg" onClick={() => fileInputRef.current?.click()}>
              <span className="icon">📁</span>
              <span className="names"><span className="en">{lang === "gu" ? "PO/ઓર્ડર અપલોડ કરો" : "Upload Order Form/PO"}</span></span>
            </button>
            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={(e) => pick(e, { fromCamera: true })} />
            <input ref={fileInputRef} type="file" accept={accept} style={{ display: "none" }} onChange={pick} />
          </div>
        )}

        {file && (
          <div>
            <div className="task-meta" style={{ justifyContent: "space-between" }}>
              <strong>{lang === "gu" ? "પસંદ કરેલ ફાઇલ" : "Selected File"}</strong>
              <button type="button" className="btn btn-outline" style={{ width: "auto", minHeight: 40 }}
                onClick={() => { setFile(null); if (preview) URL.revokeObjectURL(preview); setPreview(null); }}>
                🔄 {lang === "gu" ? "ફરી પસંદ કરો" : "Retake / Change"}
              </button>
            </div>
            {preview ? (
              <img src={preview} alt="" style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 10, marginTop: 8, display: "block" }} />
            ) : (
              <div className="sub" style={{ marginTop: 6 }}>📄 {file.name}</div>
            )}

            <div className="task-meta" style={{ gap: 10, marginTop: 12 }}>
              <div className="field" style={{ flex: 1 }}><label>{lang === "gu" ? "ડિલિવરી તારીખ" : "Delivery Date"}</label>
                <input type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} /></div>
              <div className="field" style={{ flex: 1 }}><label>{lang === "gu" ? "પ્રાથમિકતા" : "Priority"}</label>
                <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select></div>
            </div>
            <div className="sub" style={{ marginTop: 6 }}>
              {lang === "gu" ? "બાકીની વિગતો આપમેળે વંચાશે — જે ન વંચાય તે જોબ કાર્ડ પર ચકાસણીમાં બતાવાશે."
                : "The rest is read automatically — anything it can't read shows up for a quick check on the Job Card."}
            </div>

            <button type="button" className="btn btn-primary" style={{ minHeight: 48, marginTop: 12 }} disabled={busy} onClick={submit}>
              {busy ? "…" : `✅ ${lang === "gu" ? "ફેક્ટરી જોબ બનાવો" : "Create Factory Job"}`}
            </button>
          </div>
        )}
        {error && <div className="msg error" style={{ marginTop: 8 }}>{error}</div>}
      </section>
    </div>
  );
}
