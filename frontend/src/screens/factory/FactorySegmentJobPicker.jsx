import React, { useRef } from "react";
import { ACCEPT_ATTR } from "../../lib/fileTypes";

// The four Factory Segment choices (handwritten spec). Sofa/Modular/Metal Fabrication are real
// production_divisions rows; Material to Order has no division and no Job Card concept -- a PO uploaded under
// it becomes a real Material to Order request instead (see staff_set_task_factory_po in the migration).
const SEGMENTS = [
  ["SOFA", "🛋️", { en: "Sofa", gu: "સોફા" }],
  ["MODULAR", "🗄️", { en: "Modular", gu: "મોડ્યુલર" }],
  ["METAL_FAB", "🔧", { en: "Metal Fabrication", gu: "મેટલ ફેબ્રિકેશન" }],
  ["MATERIAL_ORDER", "📦", { en: "Material to Order", gu: "મટિરિયલ ઓર્ડર" }],
];
const LINK_TYPES = [
  ["po_order_form", "📎", { en: "Attach PO / Order Form", gu: "PO / ઓર્ડર ફોર્મ જોડો" }],
  ["general_factory_task", "🧰", { en: "General Factory Task", gu: "સામાન્ય ફેક્ટરી કામ" }],
];

// Shared by AssignTask.jsx -- segment selection is mandatory the moment To Department resolves to Factory.
// A task creator is NEVER asked to search for or know a Job Card number: picking "Attach PO / Order Form" shows
// a simple upload + a handful of plain reference fields; matching an existing Job Card (or creating a new one,
// or routing to a Factory Head/Supervisor for verification when more than one could match) happens entirely
// server-side, in staff_set_task_factory_po, after the task itself is created.
//
// value: { segmentCode, taskLinkType, poFile, poNumber, partyName, productName, quantity, deliveryDate, instructions }
// poFile is a plain browser File, held here (not yet uploaded) -- the task doesn't exist yet at this point in
// the flow, so the actual upload happens in AssignTask.jsx right after staff_create_task() succeeds (same
// "hold it locally, upload only after the task exists" pattern the voice recorder already uses there).
export default function FactorySegmentJobPicker({ lang, value, onChange }) {
  const { segmentCode, taskLinkType, poFile } = value;
  const fileRef = useRef(null);
  const cameraRef = useRef(null);

  function set(patch) {
    onChange({ ...value, ...patch });
  }
  function pickSegment(code) {
    set({ segmentCode: code, taskLinkType: null, poFile: null, poNumber: "", partyName: "", productName: "", quantity: "", deliveryDate: "", instructions: "" });
  }
  function pickLinkType(type) {
    set({ taskLinkType: type, poFile: type === "po_order_form" ? poFile : null });
  }
  function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) set({ poFile: file });
  }
  function removeFile() {
    set({ poFile: null });
  }

  return (
    <div className="field full">
      <label>{lang === "gu" ? "ફેક્ટરી સેગમેન્ટ પસંદ કરો" : "Select Factory Segment"} *</label>
      <div className="fx-cards">
        {SEGMENTS.map(([code, icon, name]) => (
          <button key={code} type="button" className={`fx-card ${segmentCode === code ? "hot" : ""}`}
            onClick={() => pickSegment(code)} aria-pressed={segmentCode === code}>
            <span className="n" style={{ fontSize: 26 }}>{icon}</span>
            <span className="l">{lang === "gu" ? name.gu : name.en}</span>
          </button>
        ))}
      </div>

      {segmentCode && (
        <div style={{ marginTop: 12 }}>
          <label>{lang === "gu" ? "ટાસ્ક લિંક પ્રકાર" : "Task Link Type"} *</label>
          <div className="fx-cards" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
            {LINK_TYPES.map(([type, icon, name]) => (
              <button key={type} type="button" className={`fx-card ${taskLinkType === type ? "hot" : ""}`}
                onClick={() => pickLinkType(type)} aria-pressed={taskLinkType === type}>
                <span className="n" style={{ fontSize: 22 }}>{icon}</span>
                <span className="l">{lang === "gu" ? name.gu : name.en}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {taskLinkType === "po_order_form" && (
        <div style={{ marginTop: 10 }}>
          <div className="fx-section" style={{ padding: 10 }}>
            {!poFile ? (
              <>
                <div className="sub" style={{ marginBottom: 8 }}>
                  {lang === "gu" ? "PO ફોટો લો અથવા ઓર્ડર ફોર્મ અપલોડ કરો" : "Take a PO photo or upload the Order Form"}
                </div>
                <div className="task-meta" style={{ gap: 8, flexWrap: "wrap" }}>
                  <button type="button" className="btn btn-primary" style={{ width: "auto", minHeight: 48 }} onClick={() => cameraRef.current?.click()}>
                    📷 {lang === "gu" ? "PO ફોટો લો" : "Take PO Photo"}
                  </button>
                  <button type="button" className="btn btn-outline" style={{ width: "auto", minHeight: 48 }} onClick={() => fileRef.current?.click()}>
                    🖼️ {lang === "gu" ? "ગેલેરીમાંથી પસંદ કરો" : "Choose from Gallery"}
                  </button>
                  <button type="button" className="btn btn-outline" style={{ width: "auto", minHeight: 48 }} onClick={() => fileRef.current?.click()}>
                    📄 {lang === "gu" ? "ઓર્ડર ફોર્મ અપલોડ કરો" : "Upload Order Form / Document"}
                  </button>
                </div>
                {/* Two inputs for the same target: capture=environment opens the rear camera directly on a phone;
                    the plain picker (no capture attribute) opens the gallery/file browser. Both accept every
                    format the spec lists -- ACCEPT_ATTR("task") already covers image/pdf/word/excel/drawing. */}
                <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={onFile} />
                <input ref={fileRef} type="file" accept={ACCEPT_ATTR("task")} style={{ display: "none" }} onChange={onFile} />
              </>
            ) : (
              <div className="fx-jobpick">
                <div>
                  {poFile.type?.startsWith("image/") ? (
                    <img src={URL.createObjectURL(poFile)} alt="" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border-strong)" }} />
                  ) : (
                    <div style={{ width: 72, height: 72, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, background: "var(--surface-2)", borderRadius: 8 }}>📄</div>
                  )}
                  <div className="sub" style={{ marginTop: 4, wordBreak: "break-all" }}>{poFile.name}</div>
                </div>
                <div className="task-meta" style={{ gap: 6, flexDirection: "column" }}>
                  <button type="button" className="btn btn-outline" style={{ width: "auto", minHeight: 44 }} onClick={() => fileRef.current?.click()}>
                    🔄 {lang === "gu" ? "બદલો" : "Replace"}
                  </button>
                  <button type="button" className="btn btn-outline" style={{ width: "auto", minHeight: 44 }} onClick={removeFile}>
                    🗑️ {lang === "gu" ? "કાઢી નાખો" : "Remove"}
                  </button>
                </div>
                <input ref={fileRef} type="file" accept={ACCEPT_ATTR("task")} style={{ display: "none" }} onChange={onFile} />
              </div>
            )}
          </div>

          {poFile && (
            <div className="form-grid" style={{ marginTop: 10 }}>
              <div className="field">
                <label>{lang === "gu" ? "PO / ઓર્ડર નંબર" : "PO / Order Number"}</label>
                <input value={value.poNumber || ""} onChange={(e) => set({ poNumber: e.target.value })} />
              </div>
              <div className="field">
                <label>{lang === "gu" ? "પાર્ટી / ગ્રાહકનું નામ" : "Party / Customer Name"}</label>
                <input value={value.partyName || ""} onChange={(e) => set({ partyName: e.target.value })} />
              </div>
              <div className="field">
                <label>{lang === "gu" ? "પ્રોડક્ટ / કામનું નામ" : "Product / Work Name"}</label>
                <input value={value.productName || ""} onChange={(e) => set({ productName: e.target.value })} />
              </div>
              <div className="field">
                <label>{lang === "gu" ? "જથ્થો" : "Quantity"}</label>
                <input type="number" min="0" step="any" inputMode="decimal" value={value.quantity || ""} onChange={(e) => set({ quantity: e.target.value })} />
              </div>
              <div className="field">
                <label>{lang === "gu" ? "ડિલિવરી તારીખ" : "Delivery Date"}</label>
                <input type="date" value={value.deliveryDate || ""} onChange={(e) => set({ deliveryDate: e.target.value })} />
              </div>
              <div className="field full">
                <label>{lang === "gu" ? "ટૂંકી સૂચનાઓ" : "Short Instructions"}</label>
                <textarea rows={2} value={value.instructions || ""} onChange={(e) => set({ instructions: e.target.value })} />
              </div>
              <div className="sub" style={{ gridColumn: "1 / -1" }}>
                {lang === "gu"
                  ? "અપલોડ કર્યા પછી, સિસ્ટમ હાલના જોબ કાર્ડ સાથે આપમેળે મેળ કરવાનો પ્રયાસ કરશે."
                  : "After upload, the system automatically tries to match this with an existing Job Card."}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
