import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { L, currentMonthIST, fmtScore, monthLabel, monthOptions, perfExcuseDelay, perfLive, perfRevokeExcuse, reportStatusLabel, reportStatusTone } from "../../lib/perfApi";
import { friendlyError } from "../../lib/friendlyError";
import { CategoryBars, Comparison, ExcuseDialog, MetricsGrid, MonthPicker, ScoreBadge, TaskTable } from "./PerfParts.jsx";

// MY AI PERFORMANCE (and, for a Head / Management / HR, the same view of one person: /performance/person/:userId).
// Live: calculated now from the real task records by the database scoring engine. Saved monthly reports are listed below
// (an employee sees their own once their Head has reviewed it).
export default function MyPerformance({ lang }) {
  const { userId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const month = params.get("month") || currentMonthIST();
  const months = useMemo(() => monthOptions(24), []);
  const [data, setData] = useState(null);
  const [state, setState] = useState({ loading: true, error: null });
  const [excuse, setExcuse] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState({ loading: true, error: null });
    try { setData(await perfLive(userId || null, month)); setState({ loading: false, error: null }); }
    catch (e) { setState({ loading: false, error: friendlyError(e?.message) }); }
  }, [userId, month]);
  useEffect(() => { load(); }, [load]);

  const saveExcuse = async (reason, note) => {
    setBusy(true);
    try { await perfExcuseDelay(excuse.task_id, data.user_id, reason, note); setExcuse(null); await load(); }
    catch (e) { setState((s) => ({ ...s, error: friendlyError(e?.message) })); }
    setBusy(false);
  };
  const removeExcuse = async (t) => {
    if (!window.confirm(L(lang, "Remove the verified delay? The task will be scored normally again.", "માન્ય વિલંબ દૂર કરવો? કામ ફરી સામાન્ય રીતે ગણાશે."))) return;
    try { await perfRevokeExcuse(t.task_id, data.user_id); await load(); } catch (e) { setState((s) => ({ ...s, error: friendlyError(e?.message) })); }
  };

  const p = data?.person;
  const isSelf = !userId;
  const live = month === currentMonthIST();
  return (
    <div className="dept-dashboard perf-page">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">📊</div>
        <div className="dept-header-text">
          <h1>{isSelf ? L(lang, "My AI Performance", "મારું AI પ્રદર્શન") : `${p?.full_name || ""} — ${L(lang, "AI Performance", "AI પ્રદર્શન")}`}</h1>
          <div className="sub">{[p?.employee_code, p?.role, p?.reports_to && `${L(lang, "Reports to", "રિપોર્ટ")}: ${p.reports_to}`].filter(Boolean).join(" · ")}</div>
        </div>
        <div className="btn-row" style={{ marginLeft: "auto", alignItems: "flex-end" }}>
          <MonthPicker lang={lang} value={month} options={months} onChange={(m) => setParams(m === currentMonthIST() ? {} : { month: m })} />
          {!isSelf && <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => navigate(-1)}>{L(lang, "Back", "પાછા")}</button>}
        </div>
      </div>

      {state.error && <div className="msg error">{state.error}</div>}
      {state.loading && !data && <div className="card sub">{L(lang, "Calculating from your task records…", "તમારા કામના રેકોર્ડથી ગણતરી…")}</div>}

      {data && (
        <>
          <div className="card perf-overview">
            <ScoreBadge score={data.overall_score} lang={lang} big />
            <div className="perf-overview-text">
              <b>{monthLabel(data.period_month)}{live ? ` · ${L(lang, "so far", "અત્યાર સુધી")}` : ""}</b>
              <div className="sub">
                {data.overall_score === null
                  ? L(lang, `Not enough evidence for an overall score yet: ${data.scored_tasks} scored task(s), at least ${data.settings?.min_tasks ?? 3} needed. The task list below still shows every point.`,
                    `કુલ સ્કોર માટે હજી પૂરતી માહિતી નથી: ${data.scored_tasks} ગણાયેલા કામ, ઓછામાં ઓછા ${data.settings?.min_tasks ?? 3} જોઈએ.`)
                  : L(lang, `From ${data.scored_tasks} scored task(s) (${data.confidence === "LOW" ? "few tasks, so the score is pulled a little toward the company baseline" : "enough tasks for a reliable score"}). Raw average ${fmtScore(data.raw_score)}.`,
                    `${data.scored_tasks} ગણાયેલા કામ પરથી. સરેરાશ ${fmtScore(data.raw_score)}.`)}
              </div>
              <Comparison current={data.overall_score} previous={data.previous} lang={lang} />
            </div>
          </div>

          <div className="card">
            <h3 className="perf-h">{L(lang, "Score by area", "ક્ષેત્ર મુજબ સ્કોર")}</h3>
            <CategoryBars scores={data.category_scores} framework={data.framework} lang={lang} />
            {data.framework?.focus_areas?.length ? <div className="sub" style={{ marginTop: 8 }}>{L(lang, "Department focus", "વિભાગનું ધ્યાન")}: {data.framework.focus_areas.join(" · ")}</div> : null}
          </div>

          <div className="card">
            <h3 className="perf-h">{L(lang, "Work this month", "આ મહિનાનું કામ")}</h3>
            <MetricsGrid m={data.metrics} lang={lang} />
          </div>

          <div className="card">
            <h3 className="perf-h">{L(lang, "Task-by-task points", "દરેક કામના ગુણ")}</h3>
            <div className="sub" style={{ marginBottom: 8 }}>{L(lang, "Tap a task to see exactly why it earned its points. Weakest tasks are shown first.", "ગુણનું કારણ જોવા કામ પર ટેપ કરો.")}</div>
            <TaskTable rows={data.tasks} lang={lang}
              onExcuse={data.can_review ? setExcuse : null} onRemoveExcuse={data.can_review ? removeExcuse : null}
              onOpenTask={(t) => navigate(`/tasks?focus=${t.task_id}`)} />
          </div>

          <div className="card">
            <h3 className="perf-h">{L(lang, "Monthly reports", "માસિક અહેવાલ")}</h3>
            {(data.reports || []).length === 0
              ? <div className="sub">{isSelf ? L(lang, "No monthly review has been shared with you yet. Reviews are saved after each month ends and shared after your Head reviews them.",
                "હજી કોઈ માસિક સમીક્ષા મોકલાઈ નથી.") : L(lang, "No saved monthly report yet.", "હજી કોઈ સાચવેલ અહેવાલ નથી.")}</div>
              : <div className="perf-history">{data.reports.map((r) => (
                <Link key={r.id} to={`/performance/report/${r.id}`} className="perf-history-row">
                  <b>{monthLabel(r.period_month)}</b>{r.version > 1 ? <span className="sub"> v{r.version}</span> : null}
                  <span className={`badge ${reportStatusTone(r.status)}`}>{reportStatusLabel(r.status, lang)}</span>
                  <span className="perf-history-score">{fmtScore(r.overall_score)}</span>
                </Link>))}</div>}
          </div>

          <div className="card sub perf-note">
            {L(lang, "How it is scored: each task you held is checked for completion (verified), the due date, quality (rework, QC, checker approval), ownership (accepting, starting, giving updates) and collaboration on cross-department work. Tasks you only created, cancelled tasks, tasks moved to someone else and delays your Head verified as not your fault are not counted against you. The AI writes the monthly review from these records; it never sets the numbers.",
              "ગણતરી: તમે સંભાળેલા દરેક કામની પૂર્ણતા, સમયમર્યાદા, ગુણવત્તા, જવાબદારી અને સહકાર તપાસાય છે. તમે ફક્ત બનાવેલા, રદ થયેલા, બીજાને સોંપાયેલા કામ અને વડાએ માન્ય કરેલા વિલંબ તમારી વિરુદ્ધ ગણાતા નથી. AI ફક્ત લખાણ લખે છે, ગુણ નહીં.")}
          </div>
        </>
      )}
      {excuse && <ExcuseDialog task={excuse} lang={lang} busy={busy} onCancel={() => setExcuse(null)} onSave={saveExcuse} />}
    </div>
  );
}
