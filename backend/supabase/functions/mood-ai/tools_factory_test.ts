// deno test mood-ai/tools_factory_test.ts -- Factory AI tools against a stand-in database (the real one applies row-level security)
import { assertEquals } from "jsr:@std/assert@1";
import { runFactoryTool } from "./tools_factory.ts";
import { cleanNeed, DEPARTMENT_AGENTS } from "./tools.ts";

const TODAY = "2026-11-22";
const DATA: Record<string, Record<string, unknown>[]> = {
  factory_job_cards_v: [
    { id: "j1", job_order_number: "JC-0007", factory_status: "in_production", customer_name: "Shah", project_code: "MOW-101", product_item: "Wardrobe", qty_summary: "2 nos", required_date: "2026-11-20", priority: "HIGH", current_stage: "Polish", completion_percentage: 60, assigned_name: "Ramesh", is_delayed: true, is_blocked: false },
    { id: "j2", job_order_number: "JC-0008", factory_status: "blocked", customer_name: "Patel", product_item: "TV unit", required_date: "2026-12-05", is_delayed: true, is_blocked: true, blocked_reason: "Laminate not received" },
  ],
  factory_job_items: [{ line_no: 1, item_name: "Wardrobe 3 door", quantity: 2, unit: "nos", item_status: "in_progress" }],
  factory_job_events_v: [{ event_type: "stage", to_status: "in_production", note: "Polish started", actor_name: "Ramesh", created_at: "2026-11-21T10:00:00Z" }],
  factory_quality_checks: [{ job_id: "j1", qc_stage: "in_process", result: "fail", defect_reason: "Edge band lifting", created_at: "2026-11-21T09:00:00Z" }],
  factory_material_requests: [{ request_number: "FMR-12", material: "Laminate 1mm", quantity: 10, unit: "sheets", status: "ORDERED", required_date: "2026-11-19", job_card_id: "j2" }],
};
const RPC: Record<string, unknown[]> = { factory_my_actions: [{ job_order_number: "JC-0007", action_code: "verify", title: "Verify JC-0007", is_overdue: true }] };
function fakeDb() {
  const chain = (rows: unknown) => { const o = new Proxy({}, { get: (_t, k) => (k === "then" ? (res: (v: unknown) => void) => res({ data: rows, error: null }) : () => o) }); return o; };
  return { from: (t: string) => chain(DATA[t] ?? []), rpc: (n: string) => chain(RPC[n] ?? []) } as never;
}
type R = { result: Record<string, unknown> & { job_cards?: Record<string, unknown>[] }; links: { path: string }[] };

Deno.test("job cards: delayed and blocked are counted, the reason is shown only when blocked", async () => {
  const r = await runFactoryTool(fakeDb(), "factory_job_cards", "", TODAY) as R;
  assertEquals([r.result.count, r.result.delayed, r.result.blocked], [2, 2, 1]);
  assertEquals(r.result.job_cards![0].blocked_reason, null);
  assertEquals(r.result.job_cards![1].blocked_reason, "Laminate not received");
});

Deno.test("job card detail: found by number or customer, with items, history, QC and materials; needs a name", async () => {
  assertEquals((await runFactoryTool(fakeDb(), "factory_job_card_detail", "", TODAY) as R).result.found, false);
  const d = await runFactoryTool(fakeDb(), "factory_job_card_detail", "jc-0007", TODAY) as R;
  assertEquals(d.result.job, "JC-0007");
  assertEquals((d.result.items as Record<string, unknown>[])[0].item, "Wardrobe 3 door");
  assertEquals((d.result.quality_checks as Record<string, unknown>[])[0].result, "fail");
  assertEquals((d.result.latest_history as Record<string, unknown>[])[0].by, "Ramesh");
  assertEquals(d.links[0].path, "/factory-job/j1");
});

Deno.test("my actions, problems and late materials", async () => {
  const a = await runFactoryTool(fakeDb(), "factory_my_actions", "", TODAY) as R;
  assertEquals([a.result.count, a.result.overdue], [1, 1]);
  const p = await runFactoryTool(fakeDb(), "factory_problems", "", TODAY) as R;
  assertEquals((p.result.delayed_or_blocked as unknown[]).length, 2);
  assertEquals((p.result.failed_quality_checks as Record<string, unknown>[])[0].job, "JC-0007");
  assertEquals((p.result.late_materials as Record<string, unknown>[])[0].job, "JC-0008");
  const m = await runFactoryTool(fakeDb(), "factory_material_requests", "laminate", TODAY) as R;
  assertEquals([m.result.count, m.result.late], [1, 1]);
});

Deno.test("factory tools are offered only while Factory AI is on; job card detail needs a name", () => {
  const factory = DEPARTMENT_AGENTS.find((a) => a.code === "FACTORY")!;
  assertEquals(cleanNeed(["factory_job_cards"], "").tools, []);
  assertEquals(cleanNeed(["factory_job_cards", "factory_job_card_detail"], "", factory.tools).tools, ["factory_job_cards"]);
});
