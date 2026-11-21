import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { L, fmtScore, perfMySummary, scoreBand } from "../lib/perfApi";

// "My AI performance" strip shown on every department dashboard, the Control Tower and Today's Tasks (v3_17).
// One small database call (perf_my_summary) returns this person's score for the running month and what else they may open.
// If the performance module is not installed yet, or anything fails, the strip simply does not show.
export default function PerformanceStrip({ lang }) {
  const navigate = useNavigate();
  const [s, setS] = useState(null);
  useEffect(() => {
    let live = true;
    perfMySummary().then((d) => { if (live) setS(d || null); }).catch(() => { if (live) setS(null); });
    return () => { live = false; };
  }, []);
  if (!s) return null;
  const band = scoreBand(s.overall_score);
  return (
    <div className="perf-strip card">
      <button type="button" className="perf-strip-main" onClick={() => navigate("/performance")}>
        <span className={`perf-score-dot ${band.key}`}>{fmtScore(s.overall_score)}</span>
        <span className="perf-strip-text">
          <b>{L(lang, "My AI performance", "મારું AI પ્રદર્શન")}</b>
          <span className="sub">
            {s.overall_score === null || s.overall_score === undefined
              ? L(lang, `This month: ${s.completed} done, ${s.pending} pending — a score appears once enough tasks are finished or due`,
                `આ મહિને: ${s.completed} પૂર્ણ, ${s.pending} બાકી — પૂરતાં કામ પૂર્ણ થયા પછી સ્કોર દેખાશે`)
              : L(lang, `This month: ${L(lang, band.en, band.gu)} · ${s.completed} done · ${s.pending} pending${s.overdue ? ` · ${s.overdue} overdue` : ""}`,
                `આ મહિને: ${band.gu} · ${s.completed} પૂર્ણ · ${s.pending} બાકી`)}
          </span>
        </span>
      </button>
      <div className="perf-strip-links">
        {s.my_new_report && <button type="button" className="btn btn-gold btn-sm" onClick={() => navigate(`/performance/report/${s.my_new_report}`)}>{L(lang, "Your monthly review is ready", "તમારી માસિક સમીક્ષા તૈયાર")}</button>}
        {s.can_see_team && <button type="button" className="btn btn-outline btn-sm" onClick={() => navigate("/performance/team")}>
          {L(lang, "Team performance", "ટીમ પ્રદર્શન")}{s.reviews_waiting ? ` (${s.reviews_waiting} ${L(lang, "to review", "સમીક્ષા બાકી")})` : ""}</button>}
        {s.is_management && <button type="button" className="btn btn-outline btn-sm" onClick={() => navigate("/performance/control")}>{L(lang, "AI Performance Control Tower", "AI પ્રદર્શન કંટ્રોલ ટાવર")}</button>}
      </div>
    </div>
  );
}
