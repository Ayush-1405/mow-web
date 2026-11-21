import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { L, currentMonthIST, fmtChange, fmtScore, isEndedMonth, monthLabel, monthOptions, perfDepartmentView, perfTeam, rankWithinDepartments, reportStatusLabel, reportStatusTone } from "../../lib/perfApi";
import { friendlyError } from "../../lib/friendlyError";
import { MonthPicker } from "./PerfParts.jsx";

// Department performance for a Head (their departments), HR people Management granted, and Management (everyone).
// The database decides who appears (perf_team). People are ranked only inside their own department.
export default function TeamPerformance({ lang, lookups }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const month = params.get("month") || currentMonthIST();
  const dept = params.get("dept") || "";
  const months = useMemo(() => monthOptions(24), []);
  const [data, setData] = useState(null);
  const [deptView, setDeptView] = useState(null);
  const [state, setState] = useState({ loading: true, error: null });

  const load = useCallback(async () => {
    setState({ loading: true, error: null });
    try {
      setData(await perfTeam(month, dept || null));
      setDeptView(dept && isEndedMonth(month) ? await perfDepartmentView(month, dept).catch(() => null) : null);
      setState({ loading: false, error: null });
    } catch (e) { setState({ loading: false, error: friendlyError(e?.message) }); }
  }, [month, dept]);
  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => rankWithinDepartments(data?.people || []), [data]);
  const depts = useMemo(() => {
    const ids = new Set((data?.people || []).map((p) => p.department_id));
    return (lookups?.departments || []).filter((d) => ids.has(d.id) || d.id === dept);
  }, [data, lookups, dept]);
  const toReview = (data?.people || []).filter((p) => p.status === "DRAFT").length;
  const set = (k, v) => { const n = Object.fromEntries(params.entries()); if (v) n[k] = v; else delete n[k]; setParams(n); };

  return (
    <div className="dept-dashboard perf-page">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">👥</div>
        <div className="dept-header-text">
          <h1>{L(lang, "Team AI Performance", "ટીમ AI પ્રદર્શન")}</h1>
          <div className="sub">{L(lang, "Live scores for the running month; saved monthly reports for past months. Ranks compare people only within their department.",
            "ચાલુ મહિનાના જીવંત સ્કોર; પાછલા મહિનાના સાચવેલ અહેવાલ. ક્રમ ફક્ત વિભાગની અંદર.")}</div>
        </div>
        <div className="btn-row" style={{ marginLeft: "auto", alignItems: "flex-end" }}>
          <MonthPicker lang={lang} value={month} options={months} onChange={(m) => set("month", m === currentMonthIST() ? "" : m)} />
          <label className="perf-month"><span className="sub">{L(lang, "Department", "વિભાગ")}</span>
            <select value={dept} onChange={(e) => set("dept", e.target.value)}>
              <option value="">{L(lang, "All my departments", "મારા બધા વિભાગ")}</option>
              {depts.map((d) => <option key={d.id} value={d.id}>{L(lang, d.name_en, d.name_gu)}</option>)}
            </select></label>
        </div>
      </div>

      {state.error && <div className="msg error">{state.error}</div>}
      {toReview > 0 && <div className="msg success">{L(lang, `${toReview} monthly review(s) are waiting for your review.`, `${toReview} માસિક સમીક્ષા તમારી રાહ જુએ છે.`)}</div>}
      {state.loading && !data && <div className="card sub">{L(lang, "Calculating…", "ગણતરી…")}</div>}

      {deptView?.stats && (
        <div className="card">
          <h3 className="perf-h">{deptView.stats.department} — {monthLabel(month)}</h3>
          <div className="perf-metrics">
            {[[L(lang, "People", "વ્યક્તિ"), deptView.stats.people], [L(lang, "With a score", "સ્કોર સાથે"), deptView.stats.scored_people], [L(lang, "Average score", "સરેરાશ"), fmtScore(deptView.stats.avg_score)],
              [L(lang, "Completed", "પૂર્ણ"), deptView.stats.completed], [L(lang, "Pending", "બાકી"), deptView.stats.pending], [L(lang, "Overdue", "સમય વીત્યો"), deptView.stats.overdue]]
              .map(([k, v]) => <div key={k} className="perf-metric"><span className="n">{v ?? "—"}</span><span className="t">{k}</span></div>)}
          </div>
          {deptView.ai_summary?.summary && <p style={{ marginTop: 10 }}>🤖 {deptView.ai_summary.summary}</p>}
        </div>
      )}

      {data && groups.length === 0 && <div className="card sub">{L(lang, "There is nobody in your scope.", "તમારા વિસ્તારમાં કોઈ નથી.")}</div>}
      {groups.map((g) => (
        <div key={g.department} className="card">
          <h3 className="perf-h">{g.department}</h3>
          <div className="report-table-wrap">
            <table className="report-table">
              <thead><tr>
                <th>#</th><th>{L(lang, "Person", "વ્યક્તિ")}</th><th>{L(lang, "Score", "સ્કોર")}</th><th>{L(lang, "Scored tasks", "ગણાયેલા કામ")}</th>
                <th>{L(lang, "Done", "પૂર્ણ")}</th><th>{L(lang, "Pending", "બાકી")}</th><th>{L(lang, "Overdue", "સમય વીત્યો")}</th><th>{L(lang, "Change", "ફેરફાર")}</th><th>{L(lang, "Review", "સમીક્ષા")}</th>
              </tr></thead>
              <tbody>
                {g.people.map((p) => (
                  <tr key={p.user_id} style={{ cursor: "pointer" }} onClick={() => navigate(p.report_id ? `/performance/report/${p.report_id}` : `/performance/person/${p.user_id}${month !== currentMonthIST() ? `?month=${month}` : ""}`)}>
                    <td>{p.rank ?? "—"}</td>
                    <td><b>{p.full_name}</b><div className="sub">{[p.employee_code, p.role].filter(Boolean).join(" · ")}</div></td>
                    <td><b>{fmtScore(p.overall_score)}</b>{p.overall_score === null || p.overall_score === undefined ? <div className="sub">{L(lang, "insufficient data", "પૂરતી માહિતી નથી")}</div> : null}</td>
                    <td>{p.scored_tasks ?? 0}</td>
                    <td>{p.metrics?.completed ?? 0}</td><td>{p.metrics?.pending ?? 0}</td><td>{p.metrics?.overdue ?? 0}</td>
                    <td>{p.comparison?.comparable ? fmtChange(p.comparison.score_change) : "—"}</td>
                    <td>{p.status ? <span className={`badge ${reportStatusTone(p.status)}`}>{reportStatusLabel(p.status, lang)}</span> : <span className="sub">{L(lang, "live", "જીવંત")}</span>}
                      {p.report_id && <button type="button" className="btn btn-outline btn-sm" style={{ marginLeft: 6 }}
                        onClick={(e) => { e.stopPropagation(); navigate(`/performance/person/${p.user_id}?month=${month}`); }}>{L(lang, "Live", "જીવંત")}</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <div className="card sub perf-note">{L(lang, "Scores support your judgement; they are not a basis on their own for salary, promotion or disciplinary decisions.",
        "સ્કોર તમારા નિર્ણયમાં મદદરૂપ છે; પગાર, બઢતી કે શિસ્તના નિર્ણયનો એકમાત્ર આધાર નથી.")}</div>
    </div>
  );
}
