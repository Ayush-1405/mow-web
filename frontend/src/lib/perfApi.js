import { supabase } from "./supabase";

// AI Employee Performance (mvp_pilot_ai_performance_v3_17.sql). Every read and write is a perf_* database function that checks
// who is asking (yourself / your Head / Management / people Management granted); the tables are read-only to the app.
// The written AI review comes from the perf-ai-review edge function, which works only from the saved (frozen) facts.

export * from "./perfRules";

const rpc = async (name, args) => {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
};

export const perfLive = (userId, month) => rpc("perf_live", { p_user: userId || null, p_month: month || null });
export const perfMySummary = () => rpc("perf_my_summary");
export const perfTeam = (month, departmentId) => rpc("perf_team", { p_month: month || null, p_department: departmentId || null });
export const perfReport = (id) => rpc("perf_report_detail", { p_report: id });
export const perfGenerateMonth = (month) => rpc("perf_generate_month", { p_month: month });
export const perfRecalculate = (userId, month, reason) => rpc("perf_recalculate", { p_user: userId, p_month: month, p_reason: reason });
export const perfHeadReview = (id, feedback, goals) => rpc("perf_head_review", { p_report: id, p_feedback: feedback, p_goals: goals || [] });
export const perfRespond = (id, response) => rpc("perf_employee_respond", { p_report: id, p_response: response });
export const perfFinalize = (id) => rpc("perf_finalize_report", { p_report: id });
export const perfExcuseDelay = (taskId, userId, reason, note) => rpc("perf_excuse_delay", { p_task: taskId, p_user: userId, p_reason_code: reason, p_note: note });
export const perfRevokeExcuse = (taskId, userId) => rpc("perf_revoke_excuse", { p_task: taskId, p_user: userId });
export const perfCompanyReport = (month) => rpc("perf_company_report", { p_month: month });
export const perfGenerateCompany = (month, reason) => rpc("perf_generate_company_report", { p_month: month, p_reason: reason || null });
export const perfFinalizeCompany = (id, note) => rpc("perf_finalize_company_report", { p_id: id, p_note: note || null });
export const perfDepartmentView = (month, departmentId) => rpc("perf_department_view", { p_month: month, p_department: departmentId });
export const perfSaveFramework = (departmentId, w, focus) => rpc("perf_save_framework", {
  p_department: departmentId || null, p_completion: Number(w.completion), p_deadline: Number(w.deadline), p_quality: Number(w.quality),
  p_ownership: Number(w.ownership), p_collaboration: Number(w.collaboration), p_focus: focus || [],
});
export const perfSaveSettings = (s) => rpc("perf_save_settings", {
  p_min_tasks: Number(s.min_tasks), p_prior_score: Number(s.prior_score), p_prior_weight: Number(s.prior_weight),
  p_priority_factors: s.priority_factors, p_cross_factor: Number(s.cross_department_factor),
});
export const perfSetViewer = (userId, departmentId, active) => rpc("perf_set_viewer", { p_user: userId, p_department: departmentId || null, p_active: active });

export const listFrameworks = () => supabase.from("perf_frameworks").select("*").order("department_id", { nullsFirst: true });
export const getSettings = () => supabase.from("perf_settings").select("*").eq("id", 1).maybeSingle();
export const listViewers = () => supabase.from("perf_viewers").select("*").eq("is_active", true);
export const listMonthReports = (month) => supabase.from("perf_monthly_reports")
  .select("id, user_id, department_id, period_month, version, status, overall_score, scored_tasks, ai_status, ai_error")
  .eq("period_month", month).neq("status", "SUPERSEDED");

// Calls the perf-ai-review edge function. Returns { ok, reason }.
async function invokeReview(body) {
  const { data, error } = await supabase.functions.invoke("perf-ai-review", { body });
  if (error) {
    let reason = "Could not reach the AI service. Please try again.";
    try { const b = await error?.context?.json?.(); if (b && typeof b.error === "string") reason = b.error; } catch { /* not JSON */ }
    return { ok: false, reason };
  }
  if (!data?.ok) return { ok: false, reason: data?.error || "The AI could not write the review." };
  return { ok: true, data };
}
export const writeAiReview = (reportId) => invokeReview({ report_id: reportId });
export const writeCompanyAi = (companyReportId) => invokeReview({ company_report_id: companyReportId });
