// deno test mood-ai/tools_procurement_test.ts -- Procurement AI tools against a stand-in database (the real one applies row-level security)
import { assertEquals } from "jsr:@std/assert@1";
import { runProcurementTool } from "./tools_procurement.ts";
import { cleanNeed, DEPARTMENT_AGENTS } from "./tools.ts";

const TODAY = "2026-11-22";
const ME = "u-me";
const DATA: Record<string, Record<string, unknown>[]> = {
  purchase_requests: [
    { id: "p1", request_number: "PR-202611-0003", proc_status: "ORDER_PLACED", material_name: "Black laminate", quantity: 10, unit: "sheets", required_by_date: "2026-11-20", priority: "HIGH", requesting_department_id: "d1", requester_user_id: "u-x", preferred_vendor_name: "Greenply", client_name: "Shah", order_total: 45000 },
    { id: "p2", request_number: "PR-202611-0004", proc_status: "PENDING_DEPT_APPROVAL", material_name: "Natural White 4000k", quantity: 4, unit: "nos", required_by_date: "2026-11-23", is_emergency: true, requesting_department_id: "d1", requester_user_id: "u-x" },
    { id: "p3", request_number: "PR-202611-0005", proc_status: "RETURNED_FOR_CORRECTION", material_name: "Hinges", required_by_date: "2026-11-30", requesting_department_id: "d1", requester_user_id: ME },
    { id: "p4", request_number: "PR-202611-0006", proc_status: "SENT_TO_PROCUREMENT", material_name: "Plywood 18mm", required_by_date: "2026-12-02", requesting_department_id: "d1", requester_user_id: "u-x" },
  ],
  departments: [{ id: "d1", name: "Interior" }],
  purchase_request_items: [{ line_no: 1, item_name: "Black laminate 1mm", quantity: 10, unit: "sheets", rate: 4500, amount: 45000 }],
  purchase_vendor_allocations: [{ vendor_id: "v1", expected_delivery_date: "2026-11-25", amount: 45000 }],
  purchase_orders: [{ po_number: "PO-11", status: "ORDER_PLACED", order_date: "2026-11-18", vendor_id: "v1", total_order_value: 45000 }],
  purchase_request_status_history: [{ to_status: "ORDER_PLACED", remarks: "Placed with Greenply", created_at: "2026-11-18T10:00:00Z" }],
  vendors: [
    { id: "v1", name: "Greenply Traders", vendor_category: "Laminates", rating: 4.5, approved_status: "APPROVED", lead_time: "5 days", is_active: true },
    { id: "v2", name: "Bad Supplier", vendor_category: "Laminates", blacklisted: true, is_active: true },
  ],
};
function fakeDb(rpc: Record<string, unknown>) {
  const chain = (rows: unknown) => { const o = new Proxy({}, { get: (_t, k) => (k === "then" ? (res: (v: unknown) => void) => res({ data: rows, error: null }) : () => o) }); return o; };
  return { from: (t: string) => chain(DATA[t] ?? []), rpc: (n: string) => chain(rpc[n] ?? null) } as never;
}
type R = { result: Record<string, unknown>; links: { path: string }[] };
const list = (r: R, k: string) => r.result[k] as Record<string, unknown>[];

Deno.test("requests: overdue and emergency counted; amounts only for people who may see costing", async () => {
  const staff = await runProcurementTool(fakeDb({ purchase_costing_can_view: false }), "procurement_requests", "", TODAY, ME) as R;
  assertEquals([staff.result.count, staff.result.overdue, staff.result.emergency], [4, 1, 1]);
  assertEquals("order_total" in list(staff, "requests")[0], false);
  assertEquals(list(staff, "requests")[0].status, "Order placed");
  assertEquals(list(staff, "requests")[0].department, "Interior");
  const head = await runProcurementTool(fakeDb({ purchase_costing_can_view: true }), "procurement_requests", "greenply", TODAY, ME) as R;
  assertEquals(head.result.count, 1);
  assertEquals(list(head, "requests")[0].order_total, 45000);
});

Deno.test("detail: items, vendor, purchase order, history; prices hidden without costing; needs a name", async () => {
  assertEquals((await runProcurementTool(fakeDb({}), "procurement_request_detail", "", TODAY, ME) as R).result.found, false);
  const d = await runProcurementTool(fakeDb({ purchase_costing_can_view: false }), "procurement_request_detail", "pr-202611-0003", TODAY, ME) as R;
  assertEquals(d.result.request, "PR-202611-0003");
  assertEquals(list(d, "items")[0].item, "Black laminate 1mm");
  assertEquals("rate" in list(d, "items")[0], false);
  assertEquals(list(d, "placed_with")[0].vendor, "Greenply Traders");
  assertEquals(list(d, "purchase_orders")[0].po, "PO-11");
  assertEquals("value" in list(d, "purchase_orders")[0], false);
  assertEquals(d.links[0].path, "/purchase-requests/p1");
});

Deno.test("my actions: own returned request; department approval only for a head; new requests only for Procurement", async () => {
  const staff = await runProcurementTool(fakeDb({ proc_is_procurement_member: false, staff_is_dept_head: false }), "procurement_my_actions", "", TODAY, ME) as R;
  assertEquals(list(staff, "actions").map((a) => a.request), ["PR-202611-0005"]);
  const head = await runProcurementTool(fakeDb({ proc_is_procurement_member: false, staff_is_dept_head: true }), "procurement_my_actions", "", TODAY, ME) as R;
  assertEquals(list(head, "actions").map((a) => a.request).sort(), ["PR-202611-0004", "PR-202611-0005"]);
  const proc = await runProcurementTool(fakeDb({ proc_is_procurement_member: true, staff_is_dept_head: false }), "procurement_my_actions", "", TODAY, ME) as R;
  assertEquals(list(proc, "actions").find((a) => a.request === "PR-202611-0006")?.action, "accept or reject the request");
});

Deno.test("problems and vendors: overdue / emergency; blacklisted vendors never suggested; no phone numbers", async () => {
  const p = await runProcurementTool(fakeDb({}), "procurement_problems", "", TODAY, ME) as R;
  assertEquals(list(p, "overdue").map((r) => r.request), ["PR-202611-0003"]);
  assertEquals(list(p, "emergency_open").map((r) => r.request), ["PR-202611-0004"]);
  const v = await runProcurementTool(fakeDb({}), "procurement_vendors", "laminate", TODAY, ME) as R;
  assertEquals(list(v, "vendors").map((x) => x.vendor), ["Greenply Traders"]);
  assertEquals(Object.keys(list(v, "vendors")[0]).some((k) => /mobile|phone|gst|pan/i.test(k)), false);
});

Deno.test("procurement tools are offered only while Procurement AI is on; detail needs a name", () => {
  const agent = DEPARTMENT_AGENTS.find((a) => a.code === "PROCUREMENT")!;
  assertEquals(cleanNeed(["procurement_requests"], "").tools, []);
  assertEquals(cleanNeed(["procurement_requests", "procurement_request_detail"], "", agent.tools).tools, ["procurement_requests"]);
});
