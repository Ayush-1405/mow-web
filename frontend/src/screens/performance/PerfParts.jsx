import React, { useState } from "react";
import { CATEGORIES, EXCUSE_REASONS, L, fmtChange, fmtHours, fmtScore, monthLabel, outcomeLabel, outcomeTone, scoreBand, sortTaskRows } from "../../lib/perfApi";

// Building blocks shared by My Performance (live) and the saved monthly report screens.

export function ScoreBadge({ score, lang, big = false }) {
  const band = scoreBand(score);
  return (
    <div className={`perf-score ${band.key}${big ? " big" : ""}`}>
      <span className="n">{fmtScore(score)}</span>
      <span className="t">{score === null || score === undefined ? L(lang, "Insufficient data", "પૂરતી માહિતી નથી") : `/100 · ${L(lang, band.en, band.gu)}`}</span>
    </div>
  );
}

export function CategoryBars({ scores, framework, lang }) {
  return (
    <div className="perf-cats">
      {CATEGORIES.map((c) => {
        const v = scores?.[c.key];
        return (
          <div key={c.key} className="perf-cat">
            <div className="perf-cat-top"><span>{L(lang, c.en, c.gu)}</span><span className="sub">{framework?.[c.key] !== undefined ? `${framework[c.key]} ${L(lang, "pts", "ગુણ")}` : ""}</span>
              <b>{v === null || v === undefined ? L(lang, "no evidence", "પુરાવો નથી") : `${fmtScore(v)}%`}</b></div>
            <div className="perf-bar"><span style={{ width: `${Math.max(0, Math.min(100, Number(v) || 0))}%` }} className={v === null || v === undefined ? "none" : scoreBand(v).key} /></div>
          </div>
        );
      })}
    </div>
  );
}

export function MetricsGrid({ m, lang }) {
  if (!m) return null;
  const items = [
    [L(lang, "Assigned this month", "આ મહિને સોંપાયેલ"), m.tasks_assigned],
    [L(lang, "Completed", "પૂર્ણ"), m.completed],
    [L(lang, "On time", "સમયસર"), m.completed_on_time],
    [L(lang, "Late", "મોડું"), m.completed_late],
    [L(lang, "Pending", "બાકી"), m.pending],
    [L(lang, "Overdue", "સમય વીતી ગયો"), m.overdue],
    [L(lang, "Returned / declined", "પરત"), m.returned],
    [L(lang, "Sent back for rework", "ફરી કામ માટે પરત"), m.reopened],
    [L(lang, "On-time rate", "સમયસર દર"), m.on_time_rate === null || m.on_time_rate === undefined ? "—" : `${m.on_time_rate}%`],
    [L(lang, "Average completion time", "સરેરાશ પૂર્ણ સમય"), fmtHours(m.avg_completion_hours)],
    [L(lang, "Own-department work done", "પોતાના વિભાગનું કામ"), m.department_contribution],
    [L(lang, "Cross-department work done", "અન્ય વિભાગ સાથેનું કામ"), m.cross_department_contribution],
    [L(lang, "Delays verified (not their fault)", "માન્ય વિલંબ"), m.excused_delays],
    [L(lang, "Tasks they created (not scored)", "બનાવેલા કામ (ગણાતા નથી)"), m.tasks_created],
    [L(lang, "Others' tasks they verified", "બીજાના કામ ચકાસ્યા"), m.verified_for_others],
  ];
  return (
    <div className="perf-metrics">
      {items.map(([k, v]) => <div key={k} className="perf-metric"><span className="n">{v ?? 0}</span><span className="t">{k}</span></div>)}
    </div>
  );
}

export function Comparison({ current, previous, lang }) {
  if (!previous) return null;
  const can = current !== null && current !== undefined && previous.overall_score !== null && previous.overall_score !== undefined;
  return (
    <div className="perf-compare">
      <span>{L(lang, "Previous month", "ગયા મહિને")}: <b>{fmtScore(previous.overall_score)}</b>{previous.source === "live" ? <span className="sub"> ({L(lang, "not saved yet", "હજી સાચવ્યું નથી")})</span> : null}</span>
      <span>{L(lang, "This month", "આ મહિને")}: <b>{fmtScore(current)}</b></span>
      <span className={`perf-delta ${can ? (current - previous.overall_score >= 0 ? "up" : "down") : ""}`}>
        {can ? fmtChange(Math.round((current - previous.overall_score) * 10) / 10) : L(lang, "Not enough data to compare", "સરખામણી માટે પૂરતી માહિતી નથી")}</span>
    </div>
  );
}

// Task-by-task points. `onExcuse(task)` is passed only when the viewer may verify a delay (Head / Management, live view).
export function TaskTable({ rows, lang, onExcuse, onRemoveExcuse, onOpenTask }) {
  const [open, setOpen] = useState(null);
  const list = sortTaskRows(rows);
  if (!list.length) return <div className="sub">{L(lang, "No tasks for this month.", "આ મહિને કોઈ કામ નથી.")}</div>;
  return (
    <div className="report-table-wrap">
      <table className="report-table perf-task-table">
        <thead><tr><th>{L(lang, "Task", "કામ")}</th><th>{L(lang, "Result", "પરિણામ")}</th><th>{L(lang, "Points", "ગુણ")}</th><th /></tr></thead>
        <tbody>
          {list.map((t) => {
            const id = t.task_id; const isOpen = open === id; const facts = t.facts || {};
            const canExcuse = onExcuse && (t.outcome === "OVERDUE_OPEN" || (t.outcome === "COMPLETED" && Number(facts.days_late) > 0 && !facts.excuse));
            return (
              <React.Fragment key={id}>
                <tr className={t.scored ? "" : "muted-row"} onClick={() => setOpen(isOpen ? null : id)} style={{ cursor: "pointer" }}>
                  <td><b>{t.task_number}</b><div className="sub">{t.title}</div></td>
                  <td><span className={`badge ${outcomeTone(t.outcome)}`}>{outcomeLabel(t.outcome, lang)}</span>
                    {facts.cross_department ? <span className="sub"> · {L(lang, "cross-department", "અન્ય વિભાગ")}</span> : null}</td>
                  <td>{t.scored ? <b>{fmtScore(t.points)}</b> : <span className="sub">{L(lang, "not scored", "ગણાયું નથી")}</span>}</td>
                  <td className="sub">{isOpen ? "▲" : "▼"}</td>
                </tr>
                {isOpen && (
                  <tr className="perf-task-detail"><td colSpan={4}>
                    {t.scored && (
                      <div className="perf-task-points">
                        {Object.keys(t.available || {}).map((k) => (
                          <span key={k}>{L(lang, k[0].toUpperCase() + k.slice(1), k)}: <b>{fmtScore(t.earned?.[k] ?? 0)}</b>/{t.available[k]}</span>
                        ))}
                        {t.weight ? <span className="sub">{L(lang, "weight", "ભાર")} ×{t.weight}</span> : null}
                      </div>
                    )}
                    <ul className="perf-why">{(t.explanation || []).map((e, i) => <li key={i}>{e}</li>)}</ul>
                    <div className="btn-row">
                      {onOpenTask && <button type="button" className="btn btn-outline btn-sm" onClick={() => onOpenTask(t)}>{L(lang, "Open task", "કામ ખોલો")}</button>}
                      {canExcuse && <button type="button" className="btn btn-outline btn-sm" onClick={() => onExcuse(t)}>{L(lang, "Delay was not their fault…", "વિલંબ તેમની ભૂલ નથી…")}</button>}
                      {onRemoveExcuse && (facts.excuse || t.outcome === "EXCUSED") && <button type="button" className="btn btn-outline btn-sm" onClick={() => onRemoveExcuse(t)}>{L(lang, "Remove verified delay", "માન્ય વિલંબ દૂર કરો")}</button>}
                    </div>
                  </td></tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ExcuseDialog({ task, lang, onCancel, onSave, busy }) {
  const [reason, setReason] = useState(EXCUSE_REASONS[0].key);
  const [note, setNote] = useState("");
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card" style={{ maxWidth: 460 }}>
        <h3 className="modal-card-title" style={{ marginTop: 0 }}>{L(lang, "Verify the delay", "વિલંબ ચકાસો")} — {task.task_number}</h3>
        <p className="sub">{L(lang, "Only confirm this if you checked that the delay was caused by something outside this person's control. It is recorded with your name.",
          "ફક્ત ત્યારે જ પુષ્ટિ કરો જ્યારે તમે ચકાસ્યું હોય કે વિલંબ આ વ્યક્તિના નિયંત્રણ બહાર હતો. તમારા નામે નોંધાશે.")}</p>
        <label>{L(lang, "Cause", "કારણ")}</label>
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          {EXCUSE_REASONS.map((r) => <option key={r.key} value={r.key}>{L(lang, r.en, r.gu)}</option>)}
        </select>
        <label>{L(lang, "What happened", "શું થયું")}</label>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={L(lang, "e.g. Vendor delivered the hardware 6 days late", "ઉદા. વેન્ડરે 6 દિવસ મોડો માલ આપ્યો")} />
        <div className="btn-row">
          <button type="button" className="btn btn-primary" disabled={busy || !note.trim()} onClick={() => onSave(reason, note.trim())}>{L(lang, "Save", "સાચવો")}</button>
          <button type="button" className="btn btn-outline" onClick={onCancel}>{L(lang, "Cancel", "રદ")}</button>
        </div>
      </div>
    </div>
  );
}

export function MonthPicker({ value, options, onChange, lang, label }) {
  return (
    <label className="perf-month">
      <span className="sub">{label || L(lang, "Month", "મહિનો")}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
      </select>
    </label>
  );
}
