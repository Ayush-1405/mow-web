// deno test mood-ai/tools_interior_test.ts -- Interior AI tools against a stand-in database (the real one applies row-level security)
import { assertEquals } from "jsr:@std/assert@1";
import { runInteriorTool } from "./tools_interior.ts";
import { cleanNeed } from "./tools.ts";

const TODAY = "2026-11-22";
const DATA: Record<string, Record<string, unknown>[]> = {
  projects: [
    { id: "p1", project_code: "MOW-101", customer: "Shah", location: "Surat", stage: "Purchase/Production", due_date: "2026-11-15", next_action: "Order laminate", pending_from: "Purchase", last_update: "2026-11-10", archived: false },
    { id: "p2", project_code: "MOW-102", customer: "Patel", location: "Vadodara", stage: "Design", due_date: "2026-12-30", next_action: "3D", pending_from: "Designer", last_update: "2026-11-21", archived: false },
    { id: "p3", project_code: "MOW-090", customer: "Old", location: "x", stage: "Completed", due_date: "2026-10-01", archived: false },
  ],
  site_reports: [{ project_id: "p2", report_date: "2026-11-21", work_done: "Carcass fixed", issue: null, status: "ON TRACK" }],
  project_materials: [{ project_id: "p1", material: "Laminate 1mm", status: "Pending to Order", required_by: "2026-11-20" }],
  snags: [], tasks: [], staff_task_scope_v: [], purchase_requests: [],
};
// a tiny stand-in for the Supabase query builder: every filter is accepted, the table's rows come back
function fakeDb() {
  return { from(t: string) {
    const q: Record<string, unknown> = { data: DATA[t] ?? [], error: null };
    const chain = new Proxy(q, { get: (o, k) => (k === "then" ? (res: (v: unknown) => void) => res({ data: o.data, error: null }) : () => chain) });
    return chain;
  } } as never;
}

Deno.test("projects: active only, overdue and days without an update are worked out", async () => {
  const r = await runInteriorTool(fakeDb(), "interior_projects", "", TODAY) as { result: { count: number; overdue: number; projects: Record<string, unknown>[] } };
  assertEquals(r.result.count, 2, "completed projects are left out");
  assertEquals(r.result.overdue, 1);
  assertEquals(r.result.projects[0].project, "MOW-101");
  assertEquals(r.result.projects[0].no_update_for_days, 12);
});

Deno.test("project detail needs a project and finds it by code or customer", async () => {
  const none = await runInteriorTool(fakeDb(), "interior_project_detail", "", TODAY) as { result: { found?: boolean } };
  assertEquals(none.result.found, false);
  const d = await runInteriorTool(fakeDb(), "interior_project_detail", "patel", TODAY) as { result: Record<string, unknown>; links: { path: string }[] };
  assertEquals(d.result.project, "MOW-102");
  assertEquals(d.links[0].path, "/interior-projects/purchase/p2");
});

Deno.test("site updates list active projects with no report in 3 days; late materials are flagged", async () => {
  const s = await runInteriorTool(fakeDb(), "interior_site_updates", "", TODAY) as { result: { active_projects_without_report_in_3_days: string[] } };
  assertEquals(s.result.active_projects_without_report_in_3_days, ["MOW-101"]);
  const m = await runInteriorTool(fakeDb(), "interior_pending_materials", "", TODAY) as { result: { materials: Record<string, unknown>[] } };
  assertEquals(m.result.materials[0], { project: "MOW-101", material: "Laminate 1mm", status: "Pending to Order", needed_by: "2026-11-20", late: true });
});

Deno.test("interior tools are only allowed while Interior AI is on", () => {
  assertEquals(cleanNeed(["interior_projects", "my_open_tasks"], "").tools, ["my_open_tasks"]);
  assertEquals(cleanNeed(["interior_projects"], "", ["interior_projects"]).tools, ["interior_projects"]);
  assertEquals(cleanNeed(["interior_project_detail"], "", ["interior_project_detail"]).tools, [], "project detail needs a project name");
});
