// PDF and Excel downloads for the performance reports. They export exactly the saved report the screen shows (already scoped by
// the database to what this person may see), so a download can never contain anything the viewer could not open in the app.
import { CATEGORIES, GOAL_STATUS, fmtChange, fmtHours, fmtScore, goalLabel, monthLabel, outcomeLabel, reportStatusLabel } from "./perfRules";

const safeName = (s) => String(s || "report").replace(/[^\w.-]+/g, "_").slice(0, 60);

async function pdfDoc() {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth(); const H = doc.internal.pageSize.getHeight(); const M = 40;
  let y = M;
  const ensure = (h) => { if (y + h > H - M) { doc.addPage(); y = M; } };
  const api = {
    doc,
    title(t, sub) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(60, 36, 18); doc.text(t, M, y); y += 20;
      if (sub) { doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(110, 100, 90); doc.text(sub, M, y); y += 16; }
      doc.setTextColor(0, 0, 0);
    },
    h(t) { ensure(30); y += 6; doc.setFont("helvetica", "bold"); doc.setFontSize(11.5); doc.setTextColor(122, 74, 36); doc.text(t, M, y); y += 15; doc.setTextColor(0, 0, 0); },
    p(t, size = 9.5) {
      if (!t) return;
      doc.setFont("helvetica", "normal"); doc.setFontSize(size);
      for (const line of doc.splitTextToSize(String(t), W - 2 * M)) { ensure(13); doc.text(line, M, y); y += 12.5; }
      y += 3;
    },
    bullets(items) { for (const it of items || []) api.p(`•  ${it}`); },
    kv(pairs) {
      doc.setFontSize(9.5);
      for (const [k, v] of pairs) {
        ensure(13); doc.setFont("helvetica", "bold"); doc.text(`${k}:`, M, y);
        doc.setFont("helvetica", "normal"); doc.text(doc.splitTextToSize(String(v ?? "—"), W - 2 * M - 160)[0] || "—", M + 160, y); y += 13;
      }
      y += 4;
    },
    table(head, rows, widths) {
      const total = widths.reduce((a, b) => a + b, 0); const scale = (W - 2 * M) / total; const ws = widths.map((w) => w * scale);
      const row = (cells, bold) => {
        doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(8.5);
        const wrapped = cells.map((c, i) => doc.splitTextToSize(String(c ?? "—"), ws[i] - 6));
        const h = Math.max(...wrapped.map((w) => w.length)) * 10.5 + 4;
        ensure(h);
        if (bold) { doc.setFillColor(246, 240, 231); doc.rect(M, y - 9, W - 2 * M, h, "F"); }
        let x = M; wrapped.forEach((w, i) => { doc.text(w, x + 3, y); x += ws[i]; });
        y += h;
      };
      row(head, true); for (const r of rows) row(r, false); y += 6;
    },
    save(name) { doc.save(name); },
  };
  return api;
}

export async function reportPdf(r) {
  const pdf = await pdfDoc();
  const p = r.person || {};
  pdf.title(`Monthly performance review — ${p.full_name || ""}`, `${monthLabel(r.period_month)} · version ${r.version} · ${reportStatusLabel(r.status, "en")} · calculated ${String(r.generated_at || "").slice(0, 10)} (${r.calculation_version})`);
  pdf.h("Employee");
  pdf.kv([["Name", p.full_name], ["Employee ID", p.employee_code], ["Department", p.department], ["Designation", p.designation], ["Reporting manager", p.reports_to], ["Month", monthLabel(r.period_month)]]);
  const m = r.metrics || {};
  pdf.h("Performance summary");
  pdf.kv([["Overall score", r.overall_score === null ? "Insufficient data (too few scored tasks)" : `${fmtScore(r.overall_score)} / 100 (from ${r.scored_tasks} scored tasks)`],
    ["Completed tasks", m.completed], ["Pending tasks", m.pending], ["Overdue tasks", m.overdue], ["On-time completion", m.on_time_rate === null || m.on_time_rate === undefined ? "—" : `${m.on_time_rate}%`],
    ["Quality score", r.category_scores?.quality === null || r.category_scores?.quality === undefined ? "Not checked yet" : `${r.category_scores.quality}%`],
    ["Average completion time", fmtHours(m.avg_completion_hours)], ["Cross-department work", m.cross_department_contribution],
    ["Change vs previous month", r.comparison?.comparable ? fmtChange(r.comparison.score_change) : "No comparable previous month"]]);
  pdf.table(["Category", "Weight", "Score"], CATEGORIES.map((c) => [c.en, r.framework?.[c.key], r.category_scores?.[c.key] === null || r.category_scores?.[c.key] === undefined ? "No evidence" : `${r.category_scores[c.key]}%`]), [3, 1, 1.4]);
  const a = r.ai_review;
  if (a) {
    pdf.h("AI review (written from the saved task records)");
    pdf.p(a.overall_summary);
    const items = (list) => (list || []).map((i) => `${i.text} [${(i.tasks || []).join(", ")}]`);
    if (a.achievements?.length) { pdf.h("Major achievements"); pdf.bullets(items(a.achievements)); }
    if (a.best_tasks?.length) { pdf.h("Best completed tasks"); pdf.bullets(items(a.best_tasks)); }
    if (a.missed_deadlines?.length) { pdf.h("Missed deadlines"); pdf.bullets(items(a.missed_deadlines)); }
    if (a.pending?.length) { pdf.h("Pending responsibilities"); pdf.bullets(items(a.pending)); }
    if (a.quality_review) { pdf.h("Quality and accuracy"); pdf.p(a.quality_review); }
    if (a.collaboration) { pdf.h("Team collaboration"); pdf.p(a.collaboration); }
    if (a.strengths?.length) { pdf.h("Strongest areas"); pdf.bullets(a.strengths); }
    if (a.improvements?.length) { pdf.h("Areas requiring improvement"); pdf.bullets(a.improvements); }
    if (a.recommendations?.length) { pdf.h("Recommendations for next month"); pdf.bullets(a.recommendations); }
    if (a.comparison) { pdf.h("Compared with the previous month"); pdf.p(a.comparison); }
    if (a.insufficient_data?.length) { pdf.h("Not enough data to judge"); pdf.bullets(a.insufficient_data); }
  } else {
    pdf.h("AI review"); pdf.p("The written review has not been generated yet. The scores above come from the scoring engine.");
  }
  if (r.head_feedback) { pdf.h(`Head feedback — ${r.head_reviewer || ""} (${String(r.head_reviewed_at || "").slice(0, 10)})`); pdf.p(r.head_feedback); }
  if (r.goals_set?.length) { pdf.h("Goals for next month"); pdf.table(["Goal", "Target", "Description", "Result"], r.goals_set.map((g) => [goalLabel(g.goal_type, "en"), g.target_value ?? "—", g.description, GOAL_STATUS[g.status]?.en || g.status]), [2, 0.8, 3, 1.2]); }
  if (m.goals?.length) { pdf.h("Last month's goals — result this month"); pdf.table(["Goal", "Target", "Achieved", "Result"], m.goals.map((g) => [g.description, g.target_value ?? "—", g.achieved_value ?? "—", GOAL_STATUS[g.status]?.en || g.status]), [3, 0.8, 0.8, 1.2]); }
  if (r.employee_response) { pdf.h(`Employee response (${String(r.employee_responded_at || "").slice(0, 10)})`); pdf.p(r.employee_response); }
  pdf.h("Task-by-task points");
  pdf.table(["Task", "Title", "Result", "Points", "Why"], (r.tasks || []).map((t) => [t.task_number, t.title, outcomeLabel(t.outcome, "en"), t.scored ? fmtScore(t.points) : "not scored", (t.explanation || []).join("; ")]), [1, 2.2, 1.3, 0.7, 4]);
  pdf.p("Scores are calculated by a fixed formula from the task records. They support, and do not replace, the judgement of the Head and Management; no employment decision should be based on them alone.", 8);
  pdf.save(`performance_${safeName(p.full_name)}_${String(r.period_month).slice(0, 7)}_v${r.version}.pdf`);
}

export async function reportExcel(r) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const p = r.person || {}; const m = r.metrics || {};
  const summary = [
    { Field: "Name", Value: p.full_name }, { Field: "Employee ID", Value: p.employee_code }, { Field: "Department", Value: p.department },
    { Field: "Designation", Value: p.designation }, { Field: "Reporting manager", Value: p.reports_to }, { Field: "Month", Value: monthLabel(r.period_month) },
    { Field: "Version", Value: r.version }, { Field: "Status", Value: reportStatusLabel(r.status, "en") }, { Field: "Calculation", Value: r.calculation_version },
    { Field: "Overall score", Value: r.overall_score ?? "Insufficient data" }, { Field: "Scored tasks", Value: r.scored_tasks },
    ...CATEGORIES.map((c) => ({ Field: `${c.en} (%)`, Value: r.category_scores?.[c.key] ?? "No evidence" })),
    ...Object.entries(m).filter(([, v]) => typeof v !== "object").map(([k, v]) => ({ Field: k, Value: v })),
    { Field: "Change vs previous month", Value: r.comparison?.comparable ? r.comparison.score_change : "—" },
    { Field: "Head feedback", Value: r.head_feedback || "" }, { Field: "Employee response", Value: r.employee_response || "" },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), "Summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet((r.tasks || []).map((t) => ({
    Task: t.task_number, Title: t.title, Result: outcomeLabel(t.outcome, "en"), Scored: t.scored ? "Yes" : "No", Points: t.points ?? "",
    Weight: t.weight ?? "", ...Object.fromEntries(CATEGORIES.map((c) => [`${c.en} (earned/available)`, t.available?.[c.key] !== undefined ? `${t.earned?.[c.key] ?? 0}/${t.available[c.key]}` : ""])),
    Explanation: (t.explanation || []).join("; "),
  })).concat([])), "Tasks");
  if (r.goals_set?.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(r.goals_set.map((g) => ({ Goal: goalLabel(g.goal_type, "en"), Target: g.target_value, Description: g.description, Status: g.status }))), "Goals");
  XLSX.writeFile(wb, `performance_${safeName(p.full_name)}_${String(r.period_month).slice(0, 7)}_v${r.version}.xlsx`);
}

export async function companyPdf(c) {
  const pdf = await pdfDoc(); const m = c.metrics || {}; const o = m.overview || {}; const s = c.ai_summary || null;
  pdf.title(`Management performance report — ${monthLabel(c.period_month)}`, `version ${c.version} · ${c.status} · generated ${String(c.generated_at || "").slice(0, 10)}`);
  pdf.h("Company overview");
  pdf.kv([["Employees in the report", o.active_employees], ["Employees with a score", o.scored_employees], ["Average score", fmtScore(o.avg_score)],
    ["Tasks created in the month", o.tasks_assigned], ["Tasks completed in the month", o.tasks_completed], ["Open tasks (at generation)", o.open_tasks_now], ["Overdue tasks (at generation)", o.overdue_tasks_now]]);
  if (s?.overview) { pdf.h("AI summary"); pdf.p(s.overview); }
  pdf.h("Departments");
  pdf.table(["Department", "People", "Scored", "Avg score", "Completed", "Pending", "Overdue", "On time %", "Quality %"],
    (m.departments || []).map((d) => [d.department, d.people, d.scored_people, fmtScore(d.avg_score), d.completed, d.pending, d.overdue, d.avg_on_time_rate ?? "—", d.avg_quality ?? "—"]), [2.2, 0.8, 0.8, 1, 1, 1, 1, 1, 1]);
  for (const d of s?.departments || []) { const name = (m.departments || []).find((x) => String(x.department_id) === String(d.department_id))?.department; pdf.p(`${name || "Department"}: ${d.summary}`); }
  pdf.h("Employees by department (ranks are within each department)");
  pdf.table(["Department", "Name", "Score", "Dept rank", "Dept percentile", "Scored tasks", "Completed", "Overdue", "Change"],
    (m.people || []).map((x) => [x.department, x.full_name, fmtScore(x.overall_score), x.dept_rank ?? "—", x.dept_percentile ?? "—", x.scored_tasks, x.completed, x.overdue, fmtChange(x.score_change)]), [1.6, 2, 0.8, 0.8, 1, 0.9, 0.9, 0.8, 0.8]);
  if (m.most_improved?.length) { pdf.h("Most improved"); pdf.bullets(m.most_improved.map((x) => `${x.full_name} (${x.department}): ${fmtChange(x.score_change)}`)); }
  if (m.needs_support?.length) { pdf.h("People who may need support"); pdf.bullets(m.needs_support.map((x) => `${x.full_name} (${x.department}): score ${fmtScore(x.overall_score)}, ${x.overdue} overdue`)); }
  pdf.h("Backlog by department"); pdf.table(["Department", "Open", "Overdue"], (m.backlog_by_department || []).map((b) => [b.department || "—", b.open, b.overdue]), [3, 1, 1]);
  if (m.repeated_delays?.length) { pdf.h("Repeated delays (from → to)"); pdf.table(["From", "To", "Late or overdue"], m.repeated_delays.map((b) => [b.from, b.to, b.late_or_overdue]), [2, 2, 1]); }
  if (m.procurement_bottlenecks?.length) { pdf.h("Procurement stages"); pdf.table(["Stage", "Open", "Overdue"], m.procurement_bottlenecks.map((b) => [b.stage, b.open, b.overdue]), [3, 1, 1]); }
  if (m.factory_bottlenecks?.length) { pdf.h("Factory Job Card stages"); pdf.table(["Stage", "Open", "Overdue"], m.factory_bottlenecks.map((b) => [b.stage, b.open, b.overdue]), [3, 1, 1]); }
  if (m.coordination_issues?.length) { pdf.h("Cross-department tasks overdue"); pdf.table(["From", "To", "Overdue"], m.coordination_issues.map((b) => [b.from, b.to, b.overdue_open]), [2, 2, 1]); }
  if (s) {
    for (const [k, t] of [["repeated_delays", "Repeated workflow delays"], ["procurement", "Procurement"], ["factory", "Factory production"], ["coordination", "Cross-department coordination"], ["backlog", "Backlog"]]) {
      if (s[k]) { pdf.h(t); pdf.p(s[k]); }
    }
    if (s.actions?.length) { pdf.h("Recommended management actions"); pdf.bullets(s.actions); }
  }
  if (c.management_note) { pdf.h("Management note"); pdf.p(c.management_note); }
  pdf.p("Rankings compare people only inside their own department. They are one input for Management and must not be the only basis for salary, promotion, termination or disciplinary decisions.", 8);
  pdf.save(`management_performance_${String(c.period_month).slice(0, 7)}_v${c.version}.pdf`);
}

export async function companyExcel(c) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new(); const m = c.metrics || {};
  const add = (name, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows && rows.length ? rows : [{}]), name);
  add("Overview", Object.entries(m.overview || {}).map(([k, v]) => ({ Measure: k, Value: v })));
  add("Departments", (m.departments || []).map((d) => ({ Department: d.department, People: d.people, Scored: d.scored_people, "Avg score": d.avg_score, Completed: d.completed, Pending: d.pending, Overdue: d.overdue, "On time %": d.avg_on_time_rate, "Quality %": d.avg_quality })));
  add("Employees", (m.people || []).map((x) => ({ Department: x.department, Name: x.full_name, "Employee ID": x.employee_code, Score: x.overall_score, "Dept rank": x.dept_rank, "Dept percentile": x.dept_percentile,
    "Scored tasks": x.scored_tasks, Completed: x.completed, Pending: x.pending, Overdue: x.overdue, "On time %": x.on_time_rate, Reopened: x.reopened, Change: x.score_change, "Review status": x.status })));
  add("Backlog", m.backlog_by_department || []);
  add("Repeated delays", m.repeated_delays || []);
  add("Procurement", m.procurement_bottlenecks || []);
  add("Factory", m.factory_bottlenecks || []);
  add("Coordination", m.coordination_issues || []);
  add("Trend", m.trend || []);
  XLSX.writeFile(wb, `management_performance_${String(c.period_month).slice(0, 7)}_v${c.version}.xlsx`);
}
