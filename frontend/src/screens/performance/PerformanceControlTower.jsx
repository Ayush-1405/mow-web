import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import {
  CATEGORIES, L, addMonths, currentMonthIST, fmtChange, fmtScore, getSettings, isEndedMonth, listFrameworks, listMonthReports, listViewers, monthLabel, monthOptions,
  perfCompanyReport, perfFinalizeCompany, perfGenerateCompany, perfGenerateMonth, perfSaveFramework, perfSaveSettings, perfSetViewer, perfTeam,
  rankWithinDepartments, reportStatusLabel, reportStatusTone, scoreBand, validateWeights, writeAiReview, writeCompanyAi,
} from "../../lib/perfApi";
import { friendlyError } from "../../lib/friendlyError";
import { MonthPicker } from "./PerfParts.jsx";

const TABS = [
  { key: "overview", en: "Overview", gu: "ઝાંખી" },
  { key: "monthly", en: "Monthly reviews", gu: "માસિક સમીક્ષા" },
  { key: "company", en: "Management report", gu: "મેનેજમેન્ટ અહેવાલ" },
  { key: "history", en: "History", gu: "ઇતિહાસ" },
  { key: "settings", en: "Scoring", gu: "ગુણ પદ્ધતિ" },
  { key: "access", en: "HR access", gu: "HR પ્રવેશ" },
];

// AI PERFORMANCE CONTROL TOWER (Management only; the database refuses everything here for anyone else).
export default function PerformanceControlTower({ lang, lookups }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "overview";
  const lastMonth = addMonths(currentMonthIST(), -1);
  const month = params.get("month") || (tab === "overview" ? currentMonthIST() : lastMonth);
  const set = (patch) => { const n = Object.fromEntries(params.entries()); for (const [k, v] of Object.entries(patch)) { if (v) n[k] = v; else delete n[k]; } setParams(n); };
  const months = useMemo(() => monthOptions(36), []);
  const deptName = (id) => { const d = (lookups?.departments || []).find((x) => x.id === id); return d ? L(lang, d.name_en, d.name_gu) : "—"; };

  return (
    <div className="dept-dashboard perf-page">
      <div className="dept-header card">
        <div className="dept-header-icon" aria-hidden="true">🛰️</div>
        <div className="dept-header-text">
          <h1>{L(lang, "AI Performance Control Tower", "AI પ્રદર્શન કંટ્રોલ ટાવર")}</h1>
          <div className="sub">{L(lang, "Company-wide performance from the real task records. Numbers come from a fixed scoring formula; the AI only writes the reviews.",
            "વાસ્તવિક કામના રેકોર્ડ પરથી કંપનીનું પ્રદર્શન. ગુણ નિશ્ચિત સૂત્રથી; AI ફક્ત સમીક્ષા લખે છે.")}</div>
        </div>
        {!["settings", "access", "history"].includes(tab) && (
          <div className="btn-row" style={{ marginLeft: "auto", alignItems: "flex-end" }}>
            <MonthPicker lang={lang} value={month} options={tab === "overview" ? months : months.filter((m) => isEndedMonth(m))} onChange={(m) => set({ month: m })} />
          </div>
        )}
      </div>
      <div className="perf-tabs">
        {TABS.map((t) => <button key={t.key} type="button" className={tab === t.key ? "on" : ""} onClick={() => set({ tab: t.key === "overview" ? "" : t.key, month: "" })}>{L(lang, t.en, t.gu)}</button>)}
      </div>
      {tab === "overview" && <Overview lang={lang} month={month} />}
      {tab === "monthly" && <Monthly lang={lang} month={month} deptName={deptName} />}
      {tab === "company" && <Company lang={lang} month={month} />}
      {tab === "history" && <History lang={lang} deptName={deptName} />}
      {tab === "settings" && <Scoring lang={lang} lookups={lookups} deptName={deptName} />}
      {tab === "access" && <Access lang={lang} lookups={lookups} deptName={deptName} />}
    </div>
  );
}

function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [state, setState] = useState({ loading: true, error: null });
  const load = useCallback(async () => {
    setState({ loading: true, error: null });
    try { setData(await fn()); setState({ loading: false, error: null }); } catch (e) { setState({ loading: false, error: friendlyError(e?.message) }); }
  // the caller passes the inputs `fn` depends on (month, ...), like useEffect deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { data, state, load, setState };
}

function Overview({ lang, month }) {
  const navigate = useNavigate();
  const { data, state } = useLoad(() => perfTeam(month, null), [month]);
  const people = data?.people || [];
  const sum = (k) => people.reduce((a, p) => a + Number(p.metrics?.[k] || 0), 0);
  const scored = people.filter((p) => p.overall_score !== null && p.overall_score !== undefined);
  const avg = scored.length ? scored.reduce((a, p) => a + Number(p.overall_score), 0) / scored.length : null;
  const groups = rankWithinDepartments(people);
  const support = people.filter((p) => (p.overall_score !== null && p.overall_score !== undefined && Number(p.overall_score) < 50) || Number(p.metrics?.overdue || 0) >= 3);
  const improved = people.filter((p) => p.comparison?.comparable && Number(p.comparison.score_change) > 0).sort((a, b) => b.comparison.score_change - a.comparison.score_change).slice(0, 5);
  const open = (p) => navigate(p.report_id ? `/performance/report/${p.report_id}` : `/performance/person/${p.user_id}${month !== currentMonthIST() ? `?month=${month}` : ""}`);
  return (
    <>
      {state.error && <div className="msg error">{state.error}</div>}
      {state.loading && !data && <div className="card sub">{L(lang, "Calculating…", "ગણતરી…")}</div>}
      {data && (
        <>
          <div className="kpi-grid">
            {[[L(lang, "Active employees", "સક્રિય કર્મચારી"), people.length], [L(lang, "With a score", "સ્કોર સાથે"), scored.length], [L(lang, "Average score", "સરેરાશ સ્કોર"), fmtScore(avg === null ? null : Math.round(avg * 10) / 10)],
              [L(lang, "Tasks assigned", "સોંપાયેલ કામ"), sum("tasks_assigned")], [L(lang, "Completed", "પૂર્ણ"), sum("completed")], [L(lang, "Pending", "બાકી"), sum("pending")], [L(lang, "Overdue", "સમય વીત્યો"), sum("overdue")]]
              .map(([k, v]) => <div key={k} className="kpi-tile"><div className="num">{v}</div><div className="label">{k}</div></div>)}
          </div>
          <div className="card">
            <h3 className="perf-h">{L(lang, "Departments", "વિભાગો")} — {monthLabel(month)}</h3>
            <div className="report-table-wrap"><table className="report-table">
              <thead><tr><th>{L(lang, "Department", "વિભાગ")}</th><th>{L(lang, "People", "વ્યક્તિ")}</th><th>{L(lang, "Avg score", "સરેરાશ")}</th><th>{L(lang, "Completed", "પૂર્ણ")}</th><th>{L(lang, "Pending", "બાકી")}</th><th>{L(lang, "Overdue", "સમય વીત્યો")}</th><th>{L(lang, "Top (within department)", "વિભાગમાં ટોચ")}</th></tr></thead>
              <tbody>{groups.map((g) => {
                const s = g.people.filter((p) => p.rank !== null);
                const a = s.length ? s.reduce((x, p) => x + Number(p.overall_score), 0) / s.length : null;
                const deptId = g.people[0]?.department_id;
                return (
                  <tr key={g.department} style={{ cursor: "pointer" }} onClick={() => navigate(`/performance/team?dept=${deptId}${month !== currentMonthIST() ? `&month=${month}` : ""}`)}>
                    <td><b>{g.department}</b></td><td>{g.people.length}</td><td>{fmtScore(a === null ? null : Math.round(a * 10) / 10)}</td>
                    <td>{g.people.reduce((x, p) => x + Number(p.metrics?.completed || 0), 0)}</td><td>{g.people.reduce((x, p) => x + Number(p.metrics?.pending || 0), 0)}</td>
                    <td>{g.people.reduce((x, p) => x + Number(p.metrics?.overdue || 0), 0)}</td>
                    <td className="sub">{s.slice(0, 2).map((p) => `${p.full_name} (${fmtScore(p.overall_score)})`).join(", ") || "—"}</td>
                  </tr>);
              })}</tbody>
            </table></div>
          </div>
          <div className="perf-two">
            <div className="card">
              <h3 className="perf-h">{L(lang, "Employees requiring support", "સહાયની જરૂર હોય તેવા")}</h3>
              {support.length ? support.map((p) => <button key={p.user_id} type="button" className="perf-person" onClick={() => open(p)}>
                <b>{p.full_name}</b><span className="sub">{p.department} · {L(lang, "score", "સ્કોર")} {fmtScore(p.overall_score)} · {p.metrics?.overdue || 0} {L(lang, "overdue", "બાકી")}</span></button>)
                : <p className="sub">{L(lang, "Nobody below 50 or with 3+ overdue tasks.", "કોઈ નથી.")}</p>}
            </div>
            <div className="card">
              <h3 className="perf-h">{L(lang, "Most improved (saved months)", "સૌથી વધુ સુધારો")}</h3>
              {improved.length ? improved.map((p) => <button key={p.user_id} type="button" className="perf-person" onClick={() => open(p)}>
                <b>{p.full_name}</b><span className="sub">{p.department} · {fmtChange(p.comparison.score_change)}</span></button>)
                : <p className="sub">{L(lang, "Needs two saved months with scores to compare.", "સરખામણી માટે બે સાચવેલ મહિના જોઈએ.")}</p>}
            </div>
          </div>
          <div className="card">
            <h3 className="perf-h">{L(lang, "Everyone, by department", "દરેક, વિભાગ મુજબ")}</h3>
            {groups.map((g) => (
              <div key={g.department} className="perf-dept-block">
                <b>{g.department}</b>
                {g.people.map((p) => (
                  <button key={p.user_id} type="button" className="perf-person" onClick={() => open(p)}>
                    <span className={`perf-score-dot ${scoreBand(p.overall_score).key}`}>{fmtScore(p.overall_score)}</span>
                    <span><b>{p.rank ? `#${p.rank} ` : ""}{p.full_name}</b><span className="sub"> · {p.scored_tasks ?? 0} {L(lang, "scored tasks", "ગણાયેલા કામ")} · {p.metrics?.completed ?? 0} {L(lang, "done", "પૂર્ણ")} · {p.metrics?.pending ?? 0} {L(lang, "pending", "બાકી")}</span></span>
                    {p.status && <span className={`badge ${reportStatusTone(p.status)}`}>{reportStatusLabel(p.status, lang)}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Monthly({ lang, month, deptName }) {
  const navigate = useNavigate();
  const [names, setNames] = useState({});
  const { data, state, load, setState } = useLoad(async () => (await listMonthReports(month)).data || [], [month]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  useEffect(() => {
    const ids = [...new Set((data || []).map((r) => r.user_id))];
    if (!ids.length) return;
    supabase.from("user_profiles").select("id, full_name").in("id", ids).then(({ data: d }) => setNames(Object.fromEntries((d || []).map((p) => [p.id, p.full_name]))));
  }, [data]);
  const ended = isEndedMonth(month);
  const pending = (data || []).filter((r) => ["PENDING", "FAILED"].includes(r.ai_status));
  const save = async () => {
    setBusy(true);
    try { const r = await perfGenerateMonth(month); await load(); setState((s) => ({ ...s, error: null })); setProgress(L(lang, `Saved ${r.created} report(s); ${r.skipped} already existed.`, `${r.created} અહેવાલ સાચવ્યા.`)); }
    catch (e) { setState((s) => ({ ...s, error: friendlyError(e?.message) })); }
    setBusy(false);
  };
  const writeAll = async () => {
    setBusy(true); let ok = 0; let failed = 0;
    for (let i = 0; i < pending.length; i += 1) {
      setProgress(L(lang, `Writing AI reviews: ${i + 1} of ${pending.length}…`, `AI સમીક્ષા: ${i + 1} / ${pending.length}…`));
      const res = await writeAiReview(pending[i].id);
      if (res.ok) ok += 1; else { failed += 1; if (/not configured/i.test(res.reason)) { setProgress(res.reason); break; } }
    }
    await load();
    setProgress(L(lang, `AI reviews written: ${ok}. Failed: ${failed}.`, `લખાઈ: ${ok}. નિષ્ફળ: ${failed}.`));
    setBusy(false);
  };
  const rows = [...(data || [])].sort((a, b) => String(deptName(a.department_id)).localeCompare(String(deptName(b.department_id))) || String(names[a.user_id] || "").localeCompare(String(names[b.user_id] || "")));
  return (
    <div className="card">
      {state.error && <div className="msg error">{state.error}</div>}
      {progress && <div className="msg success">{progress}</div>}
      <div className="btn-row" style={{ marginBottom: 10 }}>
        {ended && <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy} onClick={save}>
          {(data || []).length ? L(lang, "Save new people for this month", "આ મહિને નવી વ્યક્તિ સાચવો") : L(lang, `Save ${monthLabel(month)} for everyone`, `${monthLabel(month)} દરેક માટે સાચવો`)}</button>}
        {pending.length > 0 && <button type="button" className="btn btn-gold" style={{ width: "auto" }} disabled={busy} onClick={writeAll}>{L(lang, `Write ${pending.length} AI review(s)`, `${pending.length} AI સમીક્ષા લખો`)}</button>}
      </div>
      <p className="sub">{ended ? L(lang, "Months are saved automatically on the 1st at 6:00 am. Saving again never overwrites a report; use Recalculate on a report to make a corrected version.",
        "મહિના દર 1લી તારીખે સવારે 6 વાગ્યે આપમેળે સાચવાય છે. ફરી સાચવવાથી અહેવાલ બદલાતો નથી.") : L(lang, "The running month can be saved after it ends.", "ચાલુ મહિનો પૂરો થયા પછી સાચવી શકાય.")}</p>
      {state.loading && !data ? <p className="sub">…</p> : rows.length === 0 ? <p className="sub">{L(lang, "No reports saved for this month yet.", "આ મહિને હજી કોઈ અહેવાલ નથી.")}</p> : (
        <div className="report-table-wrap"><table className="report-table">
          <thead><tr><th>{L(lang, "Person", "વ્યક્તિ")}</th><th>{L(lang, "Department", "વિભાગ")}</th><th>{L(lang, "Score", "સ્કોર")}</th><th>{L(lang, "Review", "સમીક્ષા")}</th><th>AI</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/performance/report/${r.id}`)}>
              <td><b>{names[r.user_id] || "…"}</b>{r.version > 1 ? <span className="sub"> v{r.version}</span> : null}</td><td>{deptName(r.department_id)}</td>
              <td>{fmtScore(r.overall_score)}</td><td><span className={`badge ${reportStatusTone(r.status)}`}>{reportStatusLabel(r.status, lang)}</span></td>
              <td className="sub">{r.ai_status === "DONE" ? "✓" : r.ai_status === "NOT_NEEDED" ? L(lang, "no tasks", "કામ નથી") : r.ai_status === "FAILED" ? `✕ ${r.ai_error || ""}` : L(lang, "pending", "બાકી")}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </div>
  );
}

function Company({ lang, month }) {
  const { data: c, state, load, setState } = useLoad(() => perfCompanyReport(month), [month]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [info, setInfo] = useState(null);
  const run = async (fn, msg) => { setBusy(true); setInfo(null); try { await fn(); await load(); if (msg) setInfo(msg); } catch (e) { setState((s) => ({ ...s, error: friendlyError(e?.message) })); } setBusy(false); };
  const ai = async () => { setBusy(true); setInfo(L(lang, "The AI is writing the summary — up to a minute…", "AI સારાંશ લખી રહ્યું છે…")); const r = await writeCompanyAi(c.id); await load(); setInfo(r.ok ? null : r.reason); setBusy(false); };
  const regen = () => { const reason = window.prompt(L(lang, "Reason for regenerating (the current version is kept):", "ફરી બનાવવાનું કારણ:")); if (reason && reason.trim()) run(() => perfGenerateCompany(month, reason.trim())); };
  const dl = async (kind) => { const mod = await import("../../lib/perfExport"); if (kind === "pdf") await mod.companyPdf(c); else await mod.companyExcel(c); };
  if (!isEndedMonth(month)) return <div className="card sub">{L(lang, "Pick a month that has ended.", "પૂરો થયેલો મહિનો પસંદ કરો.")}</div>;
  const m = c?.metrics || {}; const s = c?.ai_summary;
  return (
    <>
      {state.error && <div className="msg error">{state.error}</div>}
      {info && <div className="msg success">{info}</div>}
      {!state.loading && !c && (
        <div className="card"><p>{L(lang, "No Management report for this month yet. Save the month's employee reports first (Monthly reviews tab), then create it here.", "આ મહિનાનો અહેવાલ હજી નથી.")}</p>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy} onClick={() => run(() => perfGenerateCompany(month, null))}>{L(lang, "Create Management report", "મેનેજમેન્ટ અહેવાલ બનાવો")}</button></div>
      )}
      {c && (
        <>
          <div className="card">
            <div className="btn-row">
              <span className={`badge ${c.status === "FINAL" ? "VERIFIED" : "ON_HOLD"}`}>{c.status === "FINAL" ? L(lang, "Final", "અંતિમ") : L(lang, "Draft — review before finalising", "ડ્રાફ્ટ — અંતિમ પહેલા સમીક્ષા")}</span>
              <span className="sub">v{c.version} · {String(c.generated_at).slice(0, 10)}</span>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => dl("pdf")}>PDF</button>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => dl("xlsx")}>Excel</button>
              {c.status === "DRAFT" && <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={regen}>{L(lang, "Regenerate…", "ફરી બનાવો…")}</button>}
            </div>
            <div className="kpi-grid" style={{ marginTop: 10 }}>
              {Object.entries({ [L(lang, "Employees", "કર્મચારી")]: m.overview?.active_employees, [L(lang, "With a score", "સ્કોર સાથે")]: m.overview?.scored_employees, [L(lang, "Average score", "સરેરાશ")]: fmtScore(m.overview?.avg_score),
                [L(lang, "Tasks created", "બનાવેલા કામ")]: m.overview?.tasks_assigned, [L(lang, "Tasks completed", "પૂર્ણ કામ")]: m.overview?.tasks_completed, [L(lang, "Open now", "હાલ ચાલુ")]: m.overview?.open_tasks_now, [L(lang, "Overdue now", "હાલ બાકી")]: m.overview?.overdue_tasks_now })
                .map(([k, v]) => <div key={k} className="kpi-tile"><div className="num">{v ?? "—"}</div><div className="label">{k}</div></div>)}
            </div>
          </div>
          <div className="card perf-ai">
            <h3 className="perf-h">🤖 {L(lang, "AI Management summary", "AI મેનેજમેન્ટ સારાંશ")}</h3>
            {c.ai_status === "DONE" && s ? (
              <>
                <p>{s.overview}</p>
                {[["top_departments", "Top performing departments"], ["improvement", "Improvement"], ["backlog", "Pending backlog"], ["overdue", "Overdue tasks"], ["repeated_delays", "Repeated workflow delays"],
                  ["procurement", "Procurement bottlenecks"], ["factory", "Factory production bottlenecks"], ["coordination", "Cross-department coordination"]]
                  .filter(([k]) => s[k]).map(([k, t]) => <div key={k} className="perf-ai-sec"><b>{t}</b><p>{s[k]}</p></div>)}
                {s.departments?.length ? <div className="perf-ai-sec"><b>{L(lang, "Department summaries", "વિભાગ સારાંશ")}</b><ul>{s.departments.map((d) => <li key={d.department_id}><b>{(m.departments || []).find((x) => String(x.department_id) === String(d.department_id))?.department}:</b> {d.summary}</li>)}</ul></div> : null}
                {s.actions?.length ? <div className="perf-ai-sec"><b>{L(lang, "Recommended management actions", "ભલામણ કરેલા પગલાં")}</b><ul>{s.actions.map((x, i) => <li key={i}>{x}</li>)}</ul></div> : null}
              </>
            ) : (
              <>
                <p className="sub">{c.ai_status === "FAILED" ? `${L(lang, "Last attempt failed", "છેલ્લો પ્રયાસ નિષ્ફળ")}: ${c.ai_error}` : L(lang, "Not written yet.", "હજી લખાયું નથી.")}</p>
                {c.status !== "SUPERSEDED" && <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy} onClick={ai}>{L(lang, "Write AI summary", "AI સારાંશ લખો")}</button>}
              </>
            )}
          </div>
          <div className="card">
            <h3 className="perf-h">{L(lang, "Departments", "વિભાગો")}</h3>
            <div className="report-table-wrap"><table className="report-table">
              <thead><tr><th>{L(lang, "Department", "વિભાગ")}</th><th>{L(lang, "People", "વ્યક્તિ")}</th><th>{L(lang, "Scored", "સ્કોર")}</th><th>{L(lang, "Avg", "સરેરાશ")}</th><th>{L(lang, "Completed", "પૂર્ણ")}</th><th>{L(lang, "Pending", "બાકી")}</th><th>{L(lang, "Overdue", "સમય વીત્યો")}</th><th>{L(lang, "On time %", "સમયસર %")}</th><th>{L(lang, "Quality %", "ગુણવત્તા %")}</th></tr></thead>
              <tbody>{(m.departments || []).map((d) => <tr key={d.department_id}><td><b>{d.department}</b></td><td>{d.people}</td><td>{d.scored_people}</td><td>{fmtScore(d.avg_score)}</td><td>{d.completed}</td><td>{d.pending}</td><td>{d.overdue}</td><td>{d.avg_on_time_rate ?? "—"}</td><td>{d.avg_quality ?? "—"}</td></tr>)}</tbody>
            </table></div>
          </div>
          <div className="card">
            <h3 className="perf-h">{L(lang, "Rankings (within each department)", "ક્રમ (દરેક વિભાગમાં)")}</h3>
            <p className="sub">{L(lang, "Department percentile is shown only where 3 or more people in the department have a score, so different departments are not compared on raw numbers.", "ટકાવારી ફક્ત 3+ સ્કોરવાળા વિભાગમાં.")}</p>
            <div className="report-table-wrap"><table className="report-table">
              <thead><tr><th>{L(lang, "Department", "વિભાગ")}</th><th>#</th><th>{L(lang, "Name", "નામ")}</th><th>{L(lang, "Score", "સ્કોર")}</th><th>{L(lang, "Percentile", "ટકાવારી")}</th><th>{L(lang, "Scored tasks", "ગણાયેલા")}</th><th>{L(lang, "Done", "પૂર્ણ")}</th><th>{L(lang, "On time %", "સમયસર %")}</th><th>{L(lang, "Change", "ફેરફાર")}</th></tr></thead>
              <tbody>{(m.people || []).map((p) => <tr key={p.user_id}><td>{p.department}</td><td>{p.dept_rank ?? "—"}</td><td><b>{p.full_name}</b></td><td>{fmtScore(p.overall_score)}</td><td>{p.dept_percentile ?? "—"}</td><td>{p.scored_tasks}</td><td>{p.completed}</td><td>{p.on_time_rate ?? "—"}</td><td>{fmtChange(p.score_change)}</td></tr>)}</tbody>
            </table></div>
          </div>
          <div className="perf-two">
            <Mini title={L(lang, "Backlog by department (at generation)", "વિભાગ મુજબ બાકી કામ")} rows={(m.backlog_by_department || []).map((b) => [b.department || "—", `${b.open} ${L(lang, "open", "ચાલુ")}`, `${b.overdue} ${L(lang, "overdue", "બાકી")}`])} />
            <Mini title={L(lang, "Repeated delays (from → to)", "વારંવાર વિલંબ")} rows={(m.repeated_delays || []).map((b) => [`${b.from} → ${b.to}`, b.late_or_overdue])} />
            <Mini title={L(lang, "Procurement stages", "પ્રોક્યોરમેન્ટ તબક્કા")} rows={(m.procurement_bottlenecks || []).map((b) => [b.stage, `${b.open} ${L(lang, "open", "ચાલુ")}`, `${b.overdue} ${L(lang, "late", "મોડું")}`])} />
            <Mini title={L(lang, "Factory Job Card stages", "ફેક્ટરી જોબ કાર્ડ તબક્કા")} rows={(m.factory_bottlenecks || []).map((b) => [b.stage, `${b.open} ${L(lang, "open", "ચાલુ")}`, `${b.overdue} ${L(lang, "late", "મોડું")}`])} />
            <Mini title={L(lang, "Cross-department tasks overdue", "અન્ય વિભાગના બાકી કામ")} rows={(m.coordination_issues || []).map((b) => [`${b.from} → ${b.to}`, b.overdue_open])} />
            <Mini title={L(lang, "Needs support", "સહાયની જરૂર")} rows={(m.needs_support || []).map((p) => [p.full_name, p.department, `${fmtScore(p.overall_score)} · ${p.overdue} ${L(lang, "overdue", "બાકી")}`])} />
          </div>
          {c.status === "DRAFT" && (
            <div className="card">
              <h3 className="perf-h">{L(lang, "Finalise", "અંતિમ કરો")}</h3>
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={L(lang, "Management note (optional)", "મેનેજમેન્ટ નોંધ (વૈકલ્પિક)")} />
              <button type="button" className="btn btn-primary" style={{ width: "auto" }} disabled={busy} onClick={() => run(() => perfFinalizeCompany(c.id, note), L(lang, "Management report is final.", "અહેવાલ અંતિમ થયો."))}>{L(lang, "Mark report final", "અહેવાલ અંતિમ કરો")}</button>
            </div>
          )}
          {c.management_note && <div className="card"><b>{L(lang, "Management note", "મેનેજમેન્ટ નોંધ")}</b><p>{c.management_note}</p></div>}
        </>
      )}
    </>
  );
}

function Mini({ title, rows }) {
  return (
    <div className="card">
      <h3 className="perf-h">{title}</h3>
      {rows.length ? rows.map((r, i) => <div key={i} className="perf-mini-row">{r.map((c, j) => <span key={j}>{c}</span>)}</div>) : <p className="sub">—</p>}
    </div>
  );
}

// Every saved month, and year-on-year averages, from the permanent monthly reports.
function History({ lang, deptName }) {
  const navigate = useNavigate();
  const { data, state } = useLoad(async () => {
    const { data: rows, error } = await supabase.from("perf_monthly_reports").select("period_month, department_id, overall_score, status").neq("status", "SUPERSEDED").order("period_month");
    if (error) throw error;
    return rows || [];
  }, []);
  const byMonth = {}; const byYear = {};
  for (const r of data || []) {
    (byMonth[r.period_month] ||= []).push(r);
    if (r.overall_score !== null) (byYear[r.period_month.slice(0, 4)] ||= []).push(Number(r.overall_score));
  }
  const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
  return (
    <>
      {state.error && <div className="msg error">{state.error}</div>}
      <div className="card">
        <h3 className="perf-h">{L(lang, "Year-wise average score", "વર્ષ મુજબ સરેરાશ")}</h3>
        {Object.keys(byYear).length ? Object.entries(byYear).map(([y, a]) => <div key={y} className="perf-mini-row"><b>{y}</b><span>{fmtScore(avg(a))}</span><span className="sub">{a.length} {L(lang, "scored reports", "સ્કોરવાળા અહેવાલ")}</span></div>)
          : <p className="sub">{L(lang, "No saved months yet.", "હજી કોઈ મહિનો સાચવ્યો નથી.")}</p>}
      </div>
      <div className="card">
        <h3 className="perf-h">{L(lang, "Saved months", "સાચવેલા મહિના")}</h3>
        {Object.entries(byMonth).reverse().map(([mo, rows]) => {
          const depts = {};
          for (const r of rows) if (r.overall_score !== null) (depts[r.department_id] ||= []).push(Number(r.overall_score));
          return (
            <button key={mo} type="button" className="perf-person" onClick={() => navigate(`/performance/control?tab=monthly&month=${mo}`)}>
              <b>{monthLabel(mo)}</b>
              <span className="sub">{rows.length} {L(lang, "reports", "અહેવાલ")} · {L(lang, "avg", "સરેરાશ")} {fmtScore(avg(rows.filter((r) => r.overall_score !== null).map((r) => Number(r.overall_score))))} · {Object.entries(depts).map(([d, a]) => `${deptName(d)} ${fmtScore(avg(a))}`).join(" · ")}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function Scoring({ lang, lookups, deptName }) {
  const { data, state, load, setState } = useLoad(async () => {
    const [f, s] = await Promise.all([listFrameworks(), getSettings()]);
    if (f.error) throw f.error; if (s.error) throw s.error;
    return { frameworks: f.data || [], settings: s.data };
  }, []);
  const [edit, setEdit] = useState(null);
  const [st, setSt] = useState(null);
  const [info, setInfo] = useState(null);
  useEffect(() => { if (data?.settings) setSt({ ...data.settings, priority_factors: { ...data.settings.priority_factors } }); }, [data]);
  const saveFw = async () => {
    const err = validateWeights(edit.w);
    if (err) { setState((s) => ({ ...s, error: err })); return; }
    try { await perfSaveFramework(edit.department_id, edit.w, edit.focus.split("\n").map((x) => x.trim()).filter(Boolean)); setEdit(null); setInfo(L(lang, "Saved. New and recalculated months use it; saved reports keep the weights they were made with.", "સાચવ્યું.")); await load(); }
    catch (e) { setState((s) => ({ ...s, error: friendlyError(e?.message) })); }
  };
  const saveSettings = async () => {
    try { await perfSaveSettings(st); setInfo(L(lang, "Settings saved.", "સેટિંગ સાચવ્યા.")); await load(); } catch (e) { setState((s) => ({ ...s, error: friendlyError(e?.message) })); }
  };
  const fwFor = (deptId) => data?.frameworks.find((f) => (f.department_id || null) === (deptId || null));
  const startEdit = (deptId) => {
    const f = fwFor(deptId) || fwFor(null);
    setEdit({ department_id: deptId || null, w: { completion: f.w_completion, deadline: f.w_deadline, quality: f.w_quality, ownership: f.w_ownership, collaboration: f.w_collaboration }, focus: (f.focus_areas || []).join("\n") });
  };
  return (
    <>
      {state.error && <div className="msg error">{state.error}</div>}
      {info && <div className="msg success">{info}</div>}
      <div className="card">
        <h3 className="perf-h">{L(lang, "Points per task, by department", "વિભાગ મુજબ કામ દીઠ ગુણ")}</h3>
        <p className="sub">{L(lang, "Each task is scored out of 100 across five areas. Departments without their own row use the company default.", "દરેક કામ 100 માંથી પાંચ ક્ષેત્રમાં ગણાય છે.")}</p>
        <div className="report-table-wrap"><table className="report-table">
          <thead><tr><th>{L(lang, "Department", "વિભાગ")}</th>{CATEGORIES.map((c) => <th key={c.key}>{L(lang, c.en, c.gu)}</th>)}<th>{L(lang, "Focus areas", "ધ્યાન ક્ષેત્ર")}</th><th /></tr></thead>
          <tbody>
            {[null, ...(lookups?.departments || []).filter((d) => !d.is_control_tower).map((d) => d.id)].map((id) => {
              const f = fwFor(id); const base = f || fwFor(null);
              if (!base) return null;
              return (
                <tr key={id || "default"}>
                  <td><b>{id ? deptName(id) : L(lang, "Company default", "કંપની મૂળભૂત")}</b>{id && !f ? <div className="sub">{L(lang, "uses default", "મૂળભૂત")}</div> : null}</td>
                  <td>{base.w_completion}</td><td>{base.w_deadline}</td><td>{base.w_quality}</td><td>{base.w_ownership}</td><td>{base.w_collaboration}</td>
                  <td className="sub">{(base.focus_areas || []).join(", ")}</td>
                  <td><button type="button" className="btn btn-outline btn-sm" onClick={() => startEdit(id)}>{L(lang, "Edit", "ફેરફાર")}</button></td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </div>
      {edit && (
        <div className="card">
          <h3 className="perf-h">{edit.department_id ? deptName(edit.department_id) : L(lang, "Company default", "કંપની મૂળભૂત")}</h3>
          <div className="perf-weights">
            {CATEGORIES.map((c) => <label key={c.key}>{L(lang, c.en, c.gu)}<input type="number" min="0" max="100" value={edit.w[c.key]} onChange={(e) => setEdit({ ...edit, w: { ...edit.w, [c.key]: e.target.value } })} /></label>)}
          </div>
          <div className="sub">{L(lang, "Total", "કુલ")}: {CATEGORIES.reduce((a, c) => a + Number(edit.w[c.key] || 0), 0)} / 100</div>
          <label>{L(lang, "Department focus areas (one per line — the AI review and the report show these)", "વિભાગના ધ્યાન ક્ષેત્ર (એક લીટીમાં એક)")}</label>
          <textarea rows={5} value={edit.focus} onChange={(e) => setEdit({ ...edit, focus: e.target.value })} />
          <div className="btn-row">
            <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={saveFw}>{L(lang, "Save", "સાચવો")}</button>
            <button type="button" className="btn btn-outline" style={{ width: "auto" }} onClick={() => setEdit(null)}>{L(lang, "Cancel", "રદ")}</button>
          </div>
        </div>
      )}
      {st && (
        <div className="card">
          <h3 className="perf-h">{L(lang, "Fairness settings", "ન્યાયી ગણતરી સેટિંગ")}</h3>
          <div className="perf-weights">
            <label>{L(lang, "Minimum scored tasks for an overall score", "કુલ સ્કોર માટે ઓછામાં ઓછા કામ")}<input type="number" min="1" max="50" value={st.min_tasks} onChange={(e) => setSt({ ...st, min_tasks: e.target.value })} /></label>
            <label>{L(lang, "Baseline score few-task months are pulled toward", "ઓછા કામ હોય ત્યારે મૂળ સ્કોર")}<input type="number" min="0" max="100" value={st.prior_score} onChange={(e) => setSt({ ...st, prior_score: e.target.value })} /></label>
            <label>{L(lang, "Baseline strength (in tasks)", "મૂળ સ્કોરનું વજન (કામમાં)")}<input type="number" min="0" max="20" step="0.5" value={st.prior_weight} onChange={(e) => setSt({ ...st, prior_weight: e.target.value })} /></label>
            <label>{L(lang, "Cross-department task weight", "અન્ય વિભાગના કામનું વજન")}<input type="number" min="1" max="2" step="0.05" value={st.cross_department_factor} onChange={(e) => setSt({ ...st, cross_department_factor: e.target.value })} /></label>
            {["LOW", "NORMAL", "HIGH", "URGENT"].map((k) => <label key={k}>{L(lang, `${k} priority weight`, `${k} પ્રાથમિકતા વજન`)}<input type="number" min="0.1" max="3" step="0.1" value={st.priority_factors?.[k] ?? 1}
              onChange={(e) => setSt({ ...st, priority_factors: { ...st.priority_factors, [k]: Number(e.target.value) } })} /></label>)}
          </div>
          <p className="sub">{L(lang, "A person with very few tasks is not given a perfect score by luck: their average is blended with the baseline as if they had a few extra average tasks.", "ઓછા કામવાળી વ્યક્તિને નસીબથી પૂર્ણ ગુણ મળતા નથી.")}</p>
          <button type="button" className="btn btn-primary" style={{ width: "auto" }} onClick={saveSettings}>{L(lang, "Save settings", "સેટિંગ સાચવો")}</button>
        </div>
      )}
    </>
  );
}

function Access({ lang, lookups, deptName }) {
  const { data, state, load, setState } = useLoad(async () => {
    const [v, u] = await Promise.all([listViewers(), supabase.from("user_profiles").select("id, full_name, department_id").eq("is_active", true).order("full_name")]);
    if (v.error) throw v.error; if (u.error) throw u.error;
    return { viewers: v.data || [], users: u.data || [] };
  }, []);
  const [user, setUser] = useState("");
  const [dept, setDept] = useState("");
  const name = (id) => data?.users.find((u) => u.id === id)?.full_name || "—";
  const change = async (u, d, active) => { try { await perfSetViewer(u, d || null, active); await load(); } catch (e) { setState((s) => ({ ...s, error: friendlyError(e?.message) })); } };
  return (
    <div className="card">
      {state.error && <div className="msg error">{state.error}</div>}
      <h3 className="perf-h">{L(lang, "Who else may read performance reports", "બીજું કોણ અહેવાલ વાંચી શકે")}</h3>
      <p className="sub">{L(lang, "Heads always see their own departments and Management sees everything. Give HR (or anyone else) access to all departments or to one department. They can read reports but not review, change or finalise them.",
        "વડા પોતાના વિભાગ અને મેનેજમેન્ટ બધું જુએ છે. HR ને બધા અથવા એક વિભાગનો પ્રવેશ આપો — ફક્ત વાંચવા માટે.")}</p>
      {(data?.viewers || []).map((v) => (
        <div key={v.id} className="perf-mini-row"><b>{name(v.user_id)}</b><span>{v.department_id ? deptName(v.department_id) : L(lang, "All departments", "બધા વિભાગ")}</span>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => change(v.user_id, v.department_id, false)}>{L(lang, "Remove", "દૂર કરો")}</button></div>
      ))}
      <div className="perf-goal-row" style={{ marginTop: 10 }}>
        <select value={user} onChange={(e) => setUser(e.target.value)}><option value="">{L(lang, "Choose a person", "વ્યક્તિ પસંદ કરો")}</option>{(data?.users || []).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>
        <select value={dept} onChange={(e) => setDept(e.target.value)}><option value="">{L(lang, "All departments", "બધા વિભાગ")}</option>{(lookups?.departments || []).filter((d) => !d.is_control_tower).map((d) => <option key={d.id} value={d.id}>{L(lang, d.name_en, d.name_gu)}</option>)}</select>
        <button type="button" className="btn btn-primary btn-sm" disabled={!user} onClick={() => { change(user, dept, true); setUser(""); setDept(""); }}>{L(lang, "Give access", "પ્રવેશ આપો")}</button>
      </div>
    </div>
  );
}
