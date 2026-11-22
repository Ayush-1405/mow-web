import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  GOAL_STATUS, GOAL_TYPES, L, cleanGoals, fmtScore, goalLabel, listMonthReports, monthLabel, perfFinalize, perfHeadReview, perfRecalculate, perfReport,
  perfRespond, reportStatusLabel, reportStatusTone, writeAiReview,
} from "../../lib/perfApi";
import { friendlyError } from "../../lib/friendlyError";
import { CategoryBars, MetricsGrid, ScoreBadge, TaskTable } from "./PerfParts.jsx";
import { askText } from "../../lib/askText";

// One saved monthly report (a permanent snapshot). Workflow: AI review written -> Head feedback + goals -> employee response
// -> Management final. The numbers on this page never change; a correction is a new version (Recalculate) and the old one stays.
export default function PerformanceReport({ lang }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [r, setR] = useState(null);
  const [state, setState] = useState({ loading: true, error: null, info: null });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [goals, setGoals] = useState([{ goal_type: "REDUCE_OVERDUE", target_value: "", description: "" }]);
  const [response, setResponse] = useState("");

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try { setR(await perfReport(id)); setState((s) => ({ ...s, loading: false })); }
    catch (e) { setState({ loading: false, error: friendlyError(e?.message), info: null }); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn, info) => {
    setBusy(true); setState((s) => ({ ...s, error: null, info: null }));
    try { await fn(); await load(); if (info) setState((s) => ({ ...s, info })); }
    catch (e) { setState((s) => ({ ...s, error: friendlyError(e?.message) })); }
    setBusy(false);
  };

  const writeAi = async () => {
    setBusy(true); setState((s) => ({ ...s, error: null, info: L(lang, "The AI is writing the review from the saved records — this can take up to a minute…", "AI સમીક્ષા લખી રહ્યું છે — એક મિનિટ લાગી શકે…") }));
    const res = await writeAiReview(id);
    await load();
    setState((s) => ({ ...s, info: null, error: res.ok ? null : res.reason }));
    setBusy(false);
  };
  const submitReview = () => {
    const g = cleanGoals(goals);
    if (g.error) { setState((s) => ({ ...s, error: g.error })); return; }
    run(() => perfHeadReview(id, feedback.trim(), g.goals), L(lang, "Review shared with the employee.", "સમીક્ષા કર્મચારીને મોકલી."));
  };
  const recalc = async () => {
    const reason = await askText(L(lang, "Why must this month be recalculated? (e.g. a task record was corrected). The current version is kept.", "ફરી ગણતરીનું કારણ?"), { lang });
    if (!reason || !reason.trim()) return;
    setBusy(true);
    try {
      await perfRecalculate(r.user_id, r.period_month, reason.trim());
      const { data } = await listMonthReports(r.period_month);
      const cur = (data || []).find((x) => x.user_id === r.user_id);
      if (cur) navigate(`/performance/report/${cur.id}`, { replace: true }); else await load();
    } catch (e) { setState((s) => ({ ...s, error: friendlyError(e?.message) })); }
    setBusy(false);
  };
  const download = async (kind) => {
    const mod = await import("../../lib/perfExport");
    if (kind === "pdf") await mod.reportPdf(r); else await mod.reportExcel(r);
  };

  if (state.loading && !r) return <div className="card sub">{L(lang, "Loading…", "લોડ થાય છે…")}</div>;
  if (!r) return <div className="msg error">{state.error || L(lang, "Report not found.", "અહેવાલ મળ્યો નથી.")}</div>;
  const p = r.person || {}; const a = r.ai_review; const m = r.metrics || {};
  const superseded = r.status === "SUPERSEDED";
  return (
    <div className="dept-dashboard perf-page">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🗂️</div>
        <div className="dept-header-text">
          <h1>{p.full_name} — {monthLabel(r.period_month)}</h1>
          <div className="sub">{[p.employee_code, p.department, p.designation, p.reports_to && `${L(lang, "Reports to", "રિપોર્ટ")}: ${p.reports_to}`].filter(Boolean).join(" · ")}</div>
          <div style={{ marginTop: 6 }}>
            <span className={`badge ${reportStatusTone(r.status)}`}>{reportStatusLabel(r.status, lang)}</span>
            <span className="sub"> · {L(lang, "version", "આવૃત્તિ")} {r.version} · {L(lang, "saved", "સાચવ્યું")} {String(r.generated_at).slice(0, 10)} · {r.calculation_version}</span>
          </div>
        </div>
        <div className="btn-row" style={{ marginLeft: "auto" }}>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => download("pdf")}>PDF</button>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => download("xlsx")}>Excel</button>
          <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => navigate(-1)}>{L(lang, "Back", "પાછા")}</button>
        </div>
      </div>

      {state.error && <div className="msg error">{state.error}</div>}
      {state.info && <div className="msg success">{state.info}</div>}
      {superseded && <div className="msg error">{L(lang, "This is an older version. It is kept for the record; a newer version replaced it.", "આ જૂની આવૃત્તિ છે; નવી આવૃત્તિએ બદલી છે.")}</div>}
      {r.recalc_reason && <div className="card sub">{L(lang, "Recalculated because", "ફરી ગણતરીનું કારણ")}: {r.recalc_reason}</div>}
      {(r.versions || []).length > 1 && (
        <div className="card perf-versions"><b>{L(lang, "Versions", "આવૃત્તિઓ")}:</b>
          {r.versions.map((v) => <Link key={v.id} to={`/performance/report/${v.id}`} className={v.id === r.id ? "on" : ""}>v{v.version} · {fmtScore(v.overall_score)} · {reportStatusLabel(v.status, lang)}</Link>)}
        </div>
      )}

      <div className="card perf-overview">
        <ScoreBadge score={r.overall_score} lang={lang} big />
        <div className="perf-overview-text">
          <b>{L(lang, "Overall score", "કુલ સ્કોર")}</b>
          <div className="sub">{r.overall_score === null
            ? L(lang, `Insufficient data: ${r.scored_tasks} scored task(s) this month.`, `પૂરતી માહિતી નથી: ${r.scored_tasks} ગણાયેલા કામ.`)
            : L(lang, `From ${r.scored_tasks} scored task(s). Raw average ${fmtScore(r.raw_score)}.`, `${r.scored_tasks} ગણાયેલા કામ પરથી.`)}</div>
          {r.comparison && (
            <div className="perf-compare">
              <span>{L(lang, "Previous month", "ગયા મહિને")}: <b>{fmtScore(r.comparison.previous_score)}</b></span>
              <span className={`perf-delta ${r.comparison.comparable ? (r.comparison.score_change >= 0 ? "up" : "down") : ""}`}>
                {r.comparison.comparable ? `${r.comparison.score_change > 0 ? "+" : ""}${r.comparison.score_change}` : L(lang, "Not enough data to compare", "સરખામણી માટે માહિતી નથી")}</span>
            </div>
          )}
        </div>
      </div>

      <div className="card"><h3 className="perf-h">{L(lang, "Score by area", "ક્ષેત્ર મુજબ સ્કોર")}</h3><CategoryBars scores={r.category_scores} framework={r.framework} lang={lang} /></div>
      <div className="card"><h3 className="perf-h">{L(lang, "Work in the month", "મહિનાનું કામ")}</h3><MetricsGrid m={m} lang={lang} /></div>

      <div className="card perf-ai">
        <h3 className="perf-h">🤖 {L(lang, "AI review", "AI સમીક્ષા")}</h3>
        {r.ai_status === "DONE" && a ? <AiReview a={a} lang={lang} model={r.ai_model} />
          : r.ai_status === "NOT_NEEDED" ? <p>{a?.overall_summary}</p>
            : (
              <div>
                <p className="sub">{r.ai_status === "FAILED" ? `${L(lang, "The last attempt failed", "છેલ્લો પ્રયાસ નિષ્ફળ")}: ${r.ai_error || ""}` : L(lang, "The written review has not been generated yet. The scores above do not depend on it.", "લખાણ સમીક્ષા હજી બની નથી. ઉપરના ગુણ તેના પર આધારિત નથી.")}</p>
                {r.can_write_ai && <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy} onClick={writeAi}>{L(lang, "Write AI review", "AI સમીક્ષા લખો")}</button>}
              </div>
            )}
      </div>

      {(m.goals || []).length > 0 && (
        <div className="card">
          <h3 className="perf-h">{L(lang, "Last month's goals — result", "ગયા મહિનાના લક્ષ્ય — પરિણામ")}</h3>
          {m.goals.map((g) => <div key={g.goal_id} className="perf-goal"><span className={`badge ${GOAL_STATUS[g.status]?.tone || "ASSIGNED"}`}>{L(lang, GOAL_STATUS[g.status]?.en || g.status, GOAL_STATUS[g.status]?.gu || g.status)}</span>
            <span>{g.description}</span><span className="sub">{L(lang, "target", "લક્ષ્ય")} {g.target_value ?? "—"} · {L(lang, "achieved", "પ્રાપ્ત")} {g.achieved_value ?? "—"}</span></div>)}
        </div>
      )}

      <div className="card">
        <h3 className="perf-h">{L(lang, "Head review", "વડાની સમીક્ષા")}</h3>
        {r.head_feedback
          ? <><p style={{ whiteSpace: "pre-wrap" }}>{r.head_feedback}</p><div className="sub">— {r.head_reviewer} · {String(r.head_reviewed_at).slice(0, 10)}</div></>
          : r.can_review
            ? (
              <div className="perf-review-form">
                <label>{L(lang, "Your feedback", "તમારો પ્રતિભાવ")}</label>
                <textarea rows={4} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder={L(lang, "What went well, what to improve, any context the numbers miss.", "શું સારું થયું, શું સુધારવું.")} />
                <label>{L(lang, "Goals for next month (optional)", "આવતા મહિનાના લક્ષ્ય (વૈકલ્પિક)")}</label>
                {goals.map((g, i) => (
                  <div key={i} className="perf-goal-row">
                    <select value={g.goal_type} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, goal_type: e.target.value } : x)))}>
                      {GOAL_TYPES.map((t) => <option key={t.key} value={t.key}>{L(lang, t.en, t.gu)}</option>)}
                    </select>
                    {g.goal_type !== "CUSTOM" && <input type="number" min="0" value={g.target_value} placeholder={L(lang, "target", "લક્ષ્ય")} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, target_value: e.target.value } : x)))} />}
                    <input value={g.description} placeholder={L(lang, "Describe the goal", "લક્ષ્ય લખો")} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => setGoals(goals.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
                <div className="btn-row">
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setGoals([...goals, { goal_type: "IMPROVE_ON_TIME", target_value: "", description: "" }])}>+ {L(lang, "Add goal", "લક્ષ્ય ઉમેરો")}</button>
                </div>
                <p className="sub">{L(lang, "Sharing sends the review to the employee. The AI never issues warnings or penalties; decisions stay with you and Management.", "મોકલવાથી સમીક્ષા કર્મચારીને જાય છે. AI ક્યારેય ચેતવણી કે દંડ આપતું નથી.")}</p>
                <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy || !feedback.trim()} onClick={submitReview}>{L(lang, "Share review with employee", "સમીક્ષા કર્મચારીને મોકલો")}</button>
              </div>
            )
            : <p className="sub">{L(lang, "Waiting for the Head's review.", "વડાની સમીક્ષા બાકી છે.")}</p>}
        {(r.goals_set || []).length > 0 && (
          <div style={{ marginTop: 10 }}><b>{L(lang, "Goals for next month", "આવતા મહિનાના લક્ષ્ય")}</b>
            {r.goals_set.map((g) => <div key={g.id} className="perf-goal"><span className={`badge ${GOAL_STATUS[g.status]?.tone || "ASSIGNED"}`}>{L(lang, GOAL_STATUS[g.status]?.en || g.status, GOAL_STATUS[g.status]?.gu || g.status)}</span>
              <span>{goalLabel(g.goal_type, lang)}{g.target_value !== null ? ` ${g.target_value}` : ""}: {g.description}</span></div>)}
          </div>
        )}
      </div>

      <div className="card">
        <h3 className="perf-h">{L(lang, "Employee response", "કર્મચારીનો જવાબ")}</h3>
        {r.employee_response
          ? <><p style={{ whiteSpace: "pre-wrap" }}>{r.employee_response}</p><div className="sub">{String(r.employee_responded_at).slice(0, 10)}</div></>
          : r.can_respond
            ? <><textarea rows={3} value={response} onChange={(e) => setResponse(e.target.value)} placeholder={L(lang, "Your comments on this review (optional, saved once).", "આ સમીક્ષા પર તમારી ટિપ્પણી.")} />
              <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy || !response.trim()} onClick={() => run(() => perfRespond(id, response.trim()), L(lang, "Response saved.", "જવાબ સાચવ્યો."))}>{L(lang, "Send response", "જવાબ મોકલો")}</button></>
            : <p className="sub">{L(lang, "No response.", "જવાબ નથી.")}</p>}
      </div>

      {(r.can_finalize || r.can_recalculate || r.finalized_at) && (
        <div className="card">
          <h3 className="perf-h">{L(lang, "Management", "મેનેજમેન્ટ")}</h3>
          {r.finalized_at && <p className="sub">{L(lang, "Final", "અંતિમ")} — {r.finalized_by_name} · {String(r.finalized_at).slice(0, 10)}</p>}
          <div className="btn-row">
            {r.can_finalize && <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy} onClick={() => run(() => perfFinalize(id), L(lang, "Review is final.", "સમીક્ષા અંતિમ થઈ."))}>{L(lang, "Mark final", "અંતિમ કરો")}</button>}
            {r.can_recalculate && <button type="button" className="btn btn-outline" style={{ width: "auto" }} disabled={busy} onClick={recalc}>{L(lang, "Recalculate (new version)…", "ફરી ગણો (નવી આવૃત્તિ)…")}</button>}
          </div>
        </div>
      )}

      <div className="card">
        <h3 className="perf-h">{L(lang, "Task-by-task points (as saved)", "દરેક કામના ગુણ (સાચવેલ)")}</h3>
        <div className="sub" style={{ marginBottom: 8 }}>{L(lang, "These are frozen. To correct a delay, verify it on the person's live view and recalculate the month.", "આ સ્થિર છે. સુધારવા માટે જીવંત દૃશ્યમાં વિલંબ ચકાસો અને ફરી ગણો.")}</div>
        <TaskTable rows={r.tasks} lang={lang} onOpenTask={(t) => navigate(`/tasks?focus=${t.task_id}`)} />
      </div>

      {r.history && (
        <div className="card">
          <h3 className="perf-h">{L(lang, "History", "ઇતિહાસ")}</h3>
          {r.history.map((h, i) => <div key={i} className="sub">{String(h.at).replace("T", " ").slice(0, 16)} · {h.action} · {h.by || L(lang, "monthly schedule", "માસિક સમયપત્રક")}{h.detail?.reason ? ` · ${h.detail.reason}` : ""}</div>)}
        </div>
      )}
    </div>
  );
}

function Items({ list, lang }) {
  if (!list?.length) return <p className="sub">{L(lang, "Nothing to report.", "કંઈ નથી.")}</p>;
  return <ul>{list.map((i, k) => <li key={k}>{i.text} <span className="sub">[{(i.tasks || []).join(", ")}]</span></li>)}</ul>;
}
function AiReview({ a, lang, model }) {
  const sec = (title, body) => <div className="perf-ai-sec"><b>{title}</b>{body}</div>;
  const plain = (s) => (s ? <p>{s}</p> : <p className="sub">{L(lang, "Insufficient data.", "પૂરતી માહિતી નથી.")}</p>);
  const list = (l) => (l?.length ? <ul>{l.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="sub">—</p>);
  return (
    <div>
      {sec(L(lang, "1. Overall summary", "1. સારાંશ"), plain(a.overall_summary))}
      {sec(L(lang, "2. Major achievements", "2. મુખ્ય સિદ્ધિઓ"), <Items list={a.achievements} lang={lang} />)}
      {sec(L(lang, "3. Best completed tasks", "3. શ્રેષ્ઠ પૂર્ણ કામ"), <Items list={a.best_tasks} lang={lang} />)}
      {sec(L(lang, "4. Missed deadlines", "4. ચૂકેલી સમયમર્યાદા"), <Items list={a.missed_deadlines} lang={lang} />)}
      {sec(L(lang, "5. Pending responsibilities", "5. બાકી જવાબદારી"), <Items list={a.pending} lang={lang} />)}
      {sec(L(lang, "6. Quality and accuracy", "6. ગુણવત્તા અને ચોકસાઈ"), plain(a.quality_review))}
      {sec(L(lang, "7. Team collaboration", "7. ટીમ સહકાર"), plain(a.collaboration))}
      {sec(L(lang, "8. Strongest areas", "8. મજબૂત ક્ષેત્રો"), list(a.strengths))}
      {sec(L(lang, "9. Areas requiring improvement", "9. સુધારાના ક્ષેત્રો"), list(a.improvements))}
      {sec(L(lang, "10. Recommendations for next month", "10. આવતા મહિના માટે ભલામણ"), list(a.recommendations))}
      {a.comparison && sec(L(lang, "Compared with last month", "ગયા મહિના સાથે સરખામણી"), plain(a.comparison))}
      {a.insufficient_data?.length ? sec(L(lang, "Not enough data to judge", "નક્કી કરવા પૂરતી માહિતી નથી"), list(a.insufficient_data)) : null}
      <p className="sub">{L(lang, "Written by AI from the saved task records only; task numbers show the evidence.", "ફક્ત સાચવેલા રેકોર્ડ પરથી AIએ લખ્યું.")} {model ? `(${model})` : ""}</p>
    </div>
  );
}
