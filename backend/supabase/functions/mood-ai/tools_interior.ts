// Interior AI (Phase H): live interior-project data for the chat, read AS THE SIGNED-IN PERSON.
// Row-level security on projects / site reports / snags / materials / purchase requests limits everyone to the projects they are
// a member of (or all projects for the organisation-wide roles) -- exactly what the Interior screens show them. Read-only.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export const INTERIOR_TOOL_NAMES = ["interior_projects", "interior_project_detail", "interior_site_updates", "interior_pending_materials"] as const;
export type InteriorTool = typeof INTERIOR_TOOL_NAMES[number];

export const INTERIOR_HELP = `Interior project tools (only the projects this person can open):
- interior_projects: their active projects with stage, due date, next action, who it is pending from, last update; flags overdue
  and projects with no update for a week (put a project code / customer name in "search" to narrow it)
- interior_project_detail: one project in depth -- latest site reports, open snags, materials still to order, open tasks, purchase
  requests (put the project code or customer name in "search")
- interior_site_updates: site reports of the last 7 days, and active projects with no site report in the last 3 days
- interior_pending_materials: materials still to be ordered, with the date they are needed`;

const DONE_STAGES = new Set(["Completed"]);
type Row = Record<string, unknown>;
const days = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
const s = (v: unknown, n = 200) => (v == null ? null : String(v).slice(0, n));

export async function runInteriorTool(db: SupabaseClient, tool: InteriorTool, search: string, today: string) {
  const projCols = "id, project_code, customer, location, stage, due_date, next_action, pending_from, last_update, next_update, on_time, frozen, archived";
  const { data: projects, error } = await db.from("projects").select(projCols).eq("archived", false).order("due_date", { ascending: true, nullsFirst: false }).limit(200);
  if (error) throw new Error("projects unavailable");
  const all = (projects ?? []) as Row[];
  const active = all.filter((p) => !DONE_STAGES.has(String(p.stage)));
  const q = search.toLowerCase();
  const match = (p: Row) => !q || String(p.project_code ?? "").toLowerCase().includes(q) || String(p.customer ?? "").toLowerCase().includes(q) || String(p.location ?? "").toLowerCase().includes(q);
  const shape = (p: Row) => ({
    project: p.project_code, customer: s(p.customer, 80), location: s(p.location, 80), stage: p.stage, due: p.due_date ?? null,
    next_action: s(p.next_action), pending_from: s(p.pending_from, 80), last_update: p.last_update ?? null,
    overdue: !!p.due_date && String(p.due_date) < today && !DONE_STAGES.has(String(p.stage)),
    no_update_for_days: p.last_update ? days(today, String(p.last_update).slice(0, 10)) : null,
  });
  const links: { path: string; label: string }[] = [];

  if (tool === "interior_projects") {
    const list = active.filter(match);
    links.push({ path: "/interior-projects", label: "Interior projects" });
    return { result: { count: list.length, overdue: list.filter((p) => shape(p).overdue).length, projects: list.slice(0, 20).map(shape) }, links };
  }

  if (tool === "interior_project_detail") {
    const p = all.find((x) => q && String(x.project_code ?? "").toLowerCase() === q) ?? all.find(match);
    if (!p || !q) return { result: { found: false, note: q ? `no project they can open matches "${search}"` : "say which project (code or customer)" }, links };
    const id = String(p.id);
    const [rep, snag, mat, task, staff, pr] = await Promise.all([
      db.from("site_reports").select("report_date, work_done, work_pending, issue, tomorrow_plan, status").eq("project_id", id).order("report_date", { ascending: false }).limit(3),
      db.from("snags").select("issue, due_date, status, major").eq("project_id", id).neq("status", "COMPLETED").limit(10),
      db.from("project_materials").select("material, status, required_by").eq("project_id", id).not("status", "in", "(Received,Not Required,Delivered)").limit(15),
      db.from("tasks").select("title, due_date, status, priority").eq("project_id", id).neq("status", "COMPLETED").limit(10),
      db.from("staff_task_scope_v").select("task_number, title, due_date").eq("project_id", id).eq("is_active", true).is("completed_at", null).order("due_date", { ascending: true }).limit(8),
      db.from("purchase_requests").select("request_number, material_name, status, proc_status, required_by_date").eq("project_id", id).is("archived_at", null).order("created_at", { ascending: false }).limit(8),
    ]);
    links.push({ path: `/interior-projects/purchase/${id}`, label: `${p.project_code} purchases` }, { path: "/interior-projects/daily-updates", label: "Daily updates" });
    return { result: {
      ...shape(p),
      latest_site_reports: (rep.data ?? []).map((r: Row) => ({ date: r.report_date, done: s(r.work_done), pending: s(r.work_pending), issue: s(r.issue), tomorrow: s(r.tomorrow_plan), status: r.status })),
      open_snags: (snag.data ?? []).map((r: Row) => ({ issue: s(r.issue), due: r.due_date, major: r.major })),
      materials_to_order: (mat.data ?? []).map((r: Row) => ({ material: s(r.material, 120), status: r.status, needed_by: r.required_by })),
      open_project_tasks: [...(task.data ?? []).map((r: Row) => ({ title: s(r.title, 120), due: r.due_date, status: r.status })),
        ...(staff.data ?? []).map((r: Row) => ({ task: r.task_number, title: s(r.title, 120), due: r.due_date }))],
      purchase_requests: (pr.data ?? []).map((r: Row) => ({ request: r.request_number, material: s(r.material_name, 120), status: r.proc_status ?? r.status, needed_by: r.required_by_date })),
    }, links };
  }

  if (tool === "interior_site_updates") {
    const since = new Date(Date.parse(today) - 7 * 86_400_000).toISOString().slice(0, 10);
    const { data } = await db.from("site_reports").select("project_id, report_date, work_done, issue, status").gte("report_date", since).order("report_date", { ascending: false }).limit(60);
    const code = new Map(all.map((p) => [p.id, p.project_code]));
    const reports = (data ?? []) as Row[];
    const recent = new Set(reports.filter((r) => String(r.report_date) >= new Date(Date.parse(today) - 3 * 86_400_000).toISOString().slice(0, 10)).map((r) => r.project_id));
    links.push({ path: "/interior-projects/daily-updates", label: "Daily updates" });
    return { result: {
      reports_last_7_days: reports.slice(0, 25).map((r) => ({ project: code.get(r.project_id) ?? "?", date: r.report_date, done: s(r.work_done, 160), issue: s(r.issue, 160), status: r.status })),
      active_projects_without_report_in_3_days: active.filter((p) => !recent.has(p.id)).map((p) => p.project_code),
    }, links };
  }

  // interior_pending_materials
  const { data } = await db.from("project_materials").select("project_id, material, status, required_by").not("status", "in", "(Received,Not Required,Delivered)").order("required_by", { ascending: true, nullsFirst: false }).limit(40);
  const code = new Map(all.map((p) => [p.id, p.project_code]));
  const list = ((data ?? []) as Row[]).filter((r) => !q || String(code.get(r.project_id) ?? "").toLowerCase().includes(q));
  links.push({ path: "/interior-projects/materials", label: "Interior materials" });
  return { result: { count: list.length, materials: list.slice(0, 25).map((r) => ({ project: code.get(r.project_id) ?? "?", material: s(r.material, 120), status: r.status, needed_by: r.required_by,
    late: !!r.required_by && String(r.required_by) < today })) }, links };
}
