import React, { useEffect, useState } from "react";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { searchJobCardsByDivision } from "../../lib/factoryApi";
import { DIVISION_META, fmtDate } from "./factoryConstants";

// The four Factory Segment choices (handwritten spec). Sofa/Modular/Metal Fabrication are real
// production_divisions rows; Material to Order has no division and no Job Card concept, so it skips straight
// past the "Task Link Type" step below -- there is nothing to link it to.
const SEGMENTS = [
  ["SOFA", "🛋️", { en: "Sofa", gu: "સોફા" }],
  ["MODULAR", "🗄️", { en: "Modular", gu: "મોડ્યુલર" }],
  ["METAL_FAB", "🔧", { en: "Metal Fabrication", gu: "મેટલ ફેબ્રિકેશન" }],
  ["MATERIAL_ORDER", "📦", { en: "Material to Order", gu: "મટિરિયલ ઓર્ડર" }],
];
const LINK_TYPES = [
  ["job_card", "📋", { en: "Link Existing Job Card", gu: "હાલનું જોબ કાર્ડ જોડો" }],
  ["general", "🧰", { en: "General Factory Task", gu: "સામાન્ય ફેક્ટરી કામ" }],
];

// Shared by AssignTask.jsx (any department assigning INTO Factory) -- segment selection is mandatory the
// moment To Department resolves to Factory; this component owns that whole sub-flow (segment -> link type ->
// Job Card search) as one controlled unit so it isn't rebuilt twice.
//
// value: { segmentCode, taskLinkType, jobCard } (jobCard is the full picked row, or null)
// locked: true when opened from an existing Job Card -- segment/link-type/job card are preset and read-only
// (reassignment permission, if ever added, would simply pass locked=false instead).
export default function FactorySegmentJobPicker({ lang, value, onChange, locked = false }) {
  const { segmentCode, taskLinkType, jobCard } = value;
  const [q, setQ] = useState("");
  const dq = useDebouncedValue(q, 250);
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (jobCard || taskLinkType !== "job_card" || !segmentCode || segmentCode === "MATERIAL_ORDER") { setResults([]); return undefined; }
    let active = true;
    setSearching(true);
    searchJobCardsByDivision(segmentCode, dq.trim() || null).then(({ data }) => { if (active) { setResults(data || []); setSearching(false); } });
    return () => { active = false; };
  }, [segmentCode, dq, jobCard, taskLinkType]);

  function pickSegment(code) {
    if (locked) return;
    onChange({ segmentCode: code, taskLinkType: code === "MATERIAL_ORDER" ? "general" : null, jobCard: null });
  }
  function pickLinkType(type) {
    onChange({ segmentCode, taskLinkType: type, jobCard: null });
  }
  function pickJobCard(job) {
    onChange({ segmentCode, taskLinkType, jobCard: job });
    setQ(""); setResults([]);
  }
  function clearJobCard() {
    onChange({ segmentCode, taskLinkType, jobCard: null });
  }

  return (
    <div className="field full">
      <label>{lang === "gu" ? "ફેક્ટરી સેગમેન્ટ પસંદ કરો" : "Select Factory Segment"} *</label>
      <div className="fx-cards">
        {SEGMENTS.map(([code, icon, name]) => (
          <button key={code} type="button" disabled={locked && segmentCode !== code}
            className={`fx-card ${segmentCode === code ? "hot" : ""}`} onClick={() => pickSegment(code)}
            aria-pressed={segmentCode === code} style={locked && segmentCode !== code ? { opacity: 0.4 } : undefined}>
            <span className="n" style={{ fontSize: 26 }}>{icon}</span>
            <span className="l">{lang === "gu" ? name.gu : name.en}</span>
          </button>
        ))}
      </div>

      {segmentCode && segmentCode !== "MATERIAL_ORDER" && (
        <div style={{ marginTop: 12 }}>
          <label>{lang === "gu" ? "ટાસ્ક લિંક પ્રકાર" : "Task Link Type"} *</label>
          <div className="fx-cards" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
            {LINK_TYPES.map(([type, icon, name]) => (
              <button key={type} type="button" disabled={locked && taskLinkType !== type}
                className={`fx-card ${taskLinkType === type ? "hot" : ""}`} onClick={() => pickLinkType(type)}
                aria-pressed={taskLinkType === type} style={locked && taskLinkType !== type ? { opacity: 0.4 } : undefined}>
                <span className="n" style={{ fontSize: 22 }}>{icon}</span>
                <span className="l">{lang === "gu" ? name.gu : name.en}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {taskLinkType === "job_card" && segmentCode && segmentCode !== "MATERIAL_ORDER" && (
        <div style={{ marginTop: 10 }}>
          {jobCard ? (
            <div className="fx-jobpick">
              <div>
                <b>{jobCard.job_order_number}</b>{" "}
                <span className="fx-tag gold">{jobCard.current_stage || jobCard.factory_status}</span>
                {jobCard.priority && <span className="fx-tag">{jobCard.priority}</span>}
                <div className="sub">
                  {[jobCard.customer_name, jobCard.product_item, jobCard.project_code || jobCard.source_reference].filter(Boolean).join(" · ")}
                </div>
                <div className="sub">
                  {DIVISION_META[segmentCode]?.en} · {lang === "gu" ? "ડિલિવરી" : "Delivery"}: {fmtDate(jobCard.required_date)}
                  {jobCard.photo_count > 0 ? ` · 📷 ${jobCard.photo_count}` : ""}
                </div>
              </div>
              {!locked && <button type="button" className="btn btn-outline" onClick={clearJobCard} aria-label="Change Job Card">{lang === "gu" ? "બદલો" : "Change"}</button>}
            </div>
          ) : !locked && (
            <>
              <input type="search" placeholder={lang === "gu" ? "જોબ કાર્ડ, ગ્રાહક, પ્રોડક્ટ, PO શોધો…" : "Search Job Card no., customer, product, PO…"}
                value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
              {searching && <div className="sub">{lang === "gu" ? "શોધી રહ્યા છીએ…" : "Searching…"}</div>}
              {results.length > 0 && (
                <ul className="fx-results">
                  {results.map((j) => (
                    <li key={j.id}>
                      <button type="button" onClick={() => pickJobCard(j)}>
                        <b>{j.job_order_number}</b> — {j.customer_name || j.project_code || "—"}
                        <span className="sub"> {j.product_item || ""} · {j.current_stage || j.factory_status} · {j.priority}
                          {j.photo_count > 0 ? ` · 📷 ${j.photo_count}` : ""}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {!searching && dq.trim().length > 0 && results.length === 0 && (
                <div className="sub">{lang === "gu" ? "કોઈ સક્રિય જોબ કાર્ડ મળ્યું નથી." : "No active Job Card matches."}</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
