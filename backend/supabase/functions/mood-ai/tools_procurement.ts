// Procurement AI (Phase H): live purchase-request data for the chat, read AS THE SIGNED-IN PERSON.
// Row-level security (proc_can_view_request) limits everyone to the purchase requests the Procurement / Purchase screens show
// them: their own, their department's for a head, the project's for its members, all of them for Procurement / Accounts /
// management. Amounts are only included for people the app lets see costing (purchase_costing_can_view). Vendor phone numbers,
// GSTIN and PAN are never read. Read-only.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export const PROCUREMENT_TOOL_NAMES = ["procurement_requests", "procurement_request_detail", "procurement_my_actions", "procurement_problems", "procurement_vendors"] as const;
export type ProcurementTool = typeof PROCUREMENT_TOOL_NAMES[number];

export const PROCUREMENT_HELP = `Procurement tools (only the purchase requests this person can open):
- procurement_requests: open purchase requests with stage, material, quantity, needed-by date, priority / emergency, department,
  vendor; overdue flagged (put a request number, material, customer or vendor in "search" to narrow it)
- procurement_request_detail: one purchase request in depth -- items, vendors it was placed with, purchase order, latest history
  (put the request number, material or customer in "search")
- procurement_my_actions: purchase requests waiting on this person (approve for the department, accept / work as Procurement,
  correct or answer a question on their own request)
- procurement_problems: overdue, delayed and emergency purchase requests
- procurement_vendors: approved vendors with category, rating, lead time and payment terms (put a name or category in "search")`;

type Row = Record<string, unknown>;
const s = (v: unknown, n = 160) => (v == null ? null : String(v).slice(0, n));

const LABEL: Record<string, string> = {
  DRAFT: "Draft", PENDING_DEPT_APPROVAL: "Pending department approval", RETURNED_FOR_CORRECTION: "Returned for correction",
  REJECTED_BY_DEPT_HEAD: "Rejected by department head", APPROVED_BY_DEPT_HEAD: "Approved by department head",
  EMERGENCY_APPROVAL_PENDING: "Emergency approval pending", EMERGENCY_REJECTED: "Emergency rejected", SENT_TO_PROCUREMENT: "Pending procurement",
  CLARIFICATION_REQUIRED: "Clarification required", REJECTED_BY_PROCUREMENT: "Rejected by procurement", ACCEPTED_BY_PROCUREMENT: "Accepted - awaiting print",
  DOCUMENT_GENERATED: "Printed - awaiting order", ORDER_PLACED: "Order placed", VENDOR_CONFIRMED: "Vendor confirmed", IN_PRODUCTION: "In production",
  READY_FOR_DISPATCH: "Ready for dispatch", IN_TRANSIT: "In transit", DELAYED: "Delayed", PARTIALLY_RECEIVED: "Partially delivered", RECEIVED: "Delivered",
  GRN_VERIFIED: "GRN verified", INVOICE_VERIFIED: "Invoice verified", PAYMENT_PENDING: "Payment pending", PARTIALLY_PAID: "Partially paid", PAID: "Paid",
  ON_HOLD: "On hold", CLOSED: "Completed", CANCELLED: "Cancelled",
};
// not open any more (or not a real request): never listed
const CLOSED = ["DRAFT", "LEGACY", "RECEIVED", "GRN_VERIFIED", "INVOICE_VERIFIED", "PAYMENT_PENDING", "PARTIALLY_PAID", "PAID", "CLOSED",
  "REJECTED_BY_DEPT_HEAD", "REJECTED_BY_PROCUREMENT", "EMERGENCY_REJECTED", "CANCELLED"];
const DEPT_APPROVAL = new Set(["PENDING_DEPT_APPROVAL", "EMERGENCY_APPROVAL_PENDING"]);
const PROC_WORK = new Set(["SENT_TO_PROCUREMENT", "CLARIFICATION_REQUIRED", "ON_HOLD", "ACCEPTED_BY_PROCUREMENT", "DOCUMENT_GENERATED"]);
const REQUESTER_FIX = new Set(["RETURNED_FOR_CORRECTION", "CLARIFICATION_REQUIRED"]);

const reqCols = "id, request_number, proc_status, material_name, quantity, unit, required_by_date, priority, is_emergency, requesting_department_id, requester_user_id, proc_assigned_to, assigned_purchase_person, preferred_vendor_name, client_name, customer, order_total, overdue_since, updated_at";

export async function runProcurementTool(db: SupabaseClient, tool: ProcurementTool, search: string, today: string, userId: string) {
  const q = search.toLowerCase();
  const links: { path: string; label: string }[] = [];

  if (tool === "procurement_vendors") {
    const { data, error } = await db.from("vendors").select("name, vendor_category, product_service_category, categories, rating, approved_status, lead_time, avg_delivery_days, payment_terms, preference, blacklisted, is_active")
      .eq("is_active", true).order("rating", { ascending: false, nullsFirst: false }).limit(100);
    if (error) throw new Error("vendors unavailable");
    const list = ((data ?? []) as Row[]).filter((v) => v.blacklisted !== true)
      .filter((v) => !q || [v.name, v.vendor_category, v.product_service_category, ...(Array.isArray(v.categories) ? v.categories : [])].some((x) => String(x ?? "").toLowerCase().includes(q)));
    links.push({ path: "/procurement/vendors", label: "Vendors" });
    return { result: { count: list.length, vendors: list.slice(0, 20).map((v) => ({
      vendor: s(v.name, 80), category: s(v.vendor_category ?? v.product_service_category, 60), categories: Array.isArray(v.categories) ? v.categories.slice(0, 6) : [],
      rating: v.rating ?? null, status: v.approved_status ?? null, lead_time: s(v.lead_time ?? (v.avg_delivery_days != null ? `${v.avg_delivery_days} days` : null), 40),
      payment_terms: s(v.payment_terms, 60), preference: v.preference ?? null,
    })) }, links };
  }

  const [{ data: rows, error }, { data: costing }, { data: depts }] = await Promise.all([
    db.from("purchase_requests").select(reqCols).is("archived_at", null).not("proc_status", "in", `(${CLOSED.join(",")})`)
      .order("required_by_date", { ascending: true, nullsFirst: false }).limit(200),
    db.rpc("purchase_costing_can_view"),
    db.from("departments").select("id, name"),
  ]);
  if (error) throw new Error("purchase requests unavailable");
  const all = (rows ?? []) as Row[];
  const money = costing === true;
  const dept = new Map(((depts ?? []) as Row[]).map((d) => [d.id, d.name]));
  // open requests only (delivered / closed ones are not listed), so past the needed-by date = overdue
  const late = (r: Row) => !!r.required_by_date && String(r.required_by_date) < today;
  const shape = (r: Row) => ({
    request: r.request_number, status: LABEL[String(r.proc_status)] ?? r.proc_status, material: s(r.material_name, 120),
    quantity: r.quantity != null ? `${r.quantity}${r.unit ? " " + r.unit : ""}` : null, needed_by: r.required_by_date ?? null,
    priority: r.priority ?? null, emergency: r.is_emergency === true, department: s(dept.get(r.requesting_department_id), 60),
    customer: s(r.client_name ?? r.customer, 80), vendor: s(r.preferred_vendor_name, 80), overdue: late(r),
    ...(money ? { order_total: r.order_total ?? null } : {}),
  });
  const matches = (r: Row) => !q || ["request_number", "material_name", "client_name", "customer", "preferred_vendor_name"].some((k) => String(r[k] ?? "").toLowerCase().includes(q));

  if (tool === "procurement_requests") {
    const list = all.filter(matches);
    links.push({ path: "/purchase-requests", label: "Purchase requests" });
    return { result: { count: list.length, overdue: list.filter(late).length, emergency: list.filter((r) => r.is_emergency === true).length,
      amounts_shown: money, requests: list.slice(0, 20).map(shape) }, links };
  }

  if (tool === "procurement_request_detail") {
    if (!q) return { result: { found: false, note: "say which purchase request (number, material or customer)" }, links };
    // closed requests too: the person may ask about one that is already delivered
    const { data: anyRows, error: e2 } = await db.from("purchase_requests").select(reqCols).is("archived_at", null).neq("proc_status", "LEGACY").order("updated_at", { ascending: false }).limit(300);
    if (e2) throw new Error("purchase requests unavailable");
    const every = (anyRows ?? []) as Row[];
    const r = every.find((x) => String(x.request_number ?? "").toLowerCase() === q) ?? every.find(matches);
    if (!r) return { result: { found: false, note: `no purchase request they can open matches "${search}"` }, links };
    const id = String(r.id);
    const [items, alloc, po, hist] = await Promise.all([
      db.from("purchase_request_items").select("line_no, item_name, quantity, unit, size, finish, brand, status, rate, amount").eq("purchase_request_id", id).order("line_no").limit(30),
      db.from("purchase_vendor_allocations").select("vendor_id, expected_delivery_date, rate, amount, vendor_po_reference").eq("purchase_request_id", id).limit(10),
      db.from("purchase_orders").select("po_number, status, order_date, expected_delivery_date, total_order_value, payment_terms, vendor_id, is_current").eq("purchase_request_id", id).order("created_at", { ascending: false }).limit(3),
      db.from("purchase_request_status_history").select("from_status, to_status, remarks, created_at").eq("purchase_request_id", id).order("created_at", { ascending: false }).limit(6),
    ]);
    const vids = [...new Set([...((alloc.data ?? []) as Row[]), ...((po.data ?? []) as Row[])].map((x) => x.vendor_id).filter(Boolean))] as string[];
    const { data: vend } = vids.length ? await db.from("vendors").select("id, name").in("id", vids) : { data: [] };
    const vn = new Map(((vend ?? []) as Row[]).map((v) => [v.id, v.name]));
    links.push({ path: `/purchase-requests/${id}`, label: `Purchase request ${r.request_number}` });
    return { result: {
      ...shape(r), amounts_shown: money,
      items: ((items.data ?? []) as Row[]).map((i) => ({ line: i.line_no, item: s(i.item_name, 100), qty: i.quantity, unit: i.unit, size: s(i.size, 60), finish: s(i.finish, 60),
        brand: s(i.brand, 60), status: i.status ?? null, ...(money ? { rate: i.rate ?? null, amount: i.amount ?? null } : {}) })),
      placed_with: ((alloc.data ?? []) as Row[]).map((a) => ({ vendor: s(vn.get(a.vendor_id), 80) ?? "a vendor", expected_delivery: a.expected_delivery_date ?? null,
        vendor_po: s(a.vendor_po_reference, 40), ...(money ? { amount: a.amount ?? null } : {}) })),
      purchase_orders: ((po.data ?? []) as Row[]).map((o) => ({ po: o.po_number, status: o.status, ordered_on: o.order_date, expected_delivery: o.expected_delivery_date ?? null,
        vendor: s(vn.get(o.vendor_id), 80), current: o.is_current !== false, ...(money ? { value: o.total_order_value ?? null, payment_terms: s(o.payment_terms, 80) } : {}) })),
      latest_history: ((hist.data ?? []) as Row[]).map((h) => ({ to: LABEL[String(h.to_status)] ?? h.to_status, note: s(h.remarks), at: h.created_at })),
    }, links };
  }

  if (tool === "procurement_my_actions") {
    const [{ data: isProc }, { data: isHead }] = await Promise.all([db.rpc("proc_is_procurement_member"), db.rpc("staff_is_dept_head")]);
    const acts: Row[] = [];
    for (const r of all) {
      const st = String(r.proc_status);
      const mine = r.requester_user_id === userId;
      const assignedToMe = r.proc_assigned_to === userId || r.assigned_purchase_person === userId;
      let action: string | null = null;
      if (mine && REQUESTER_FIX.has(st)) action = st === "RETURNED_FOR_CORRECTION" ? "correct and resubmit your request" : "answer Procurement's question";
      else if (!mine && isHead === true && DEPT_APPROVAL.has(st)) action = st === "EMERGENCY_APPROVAL_PENDING" ? "approve or reject the emergency request" : "approve or reject for your department";
      else if (isProc === true && PROC_WORK.has(st) && (assignedToMe || (!r.proc_assigned_to && !r.assigned_purchase_person)))
        action = st === "SENT_TO_PROCUREMENT" ? "accept or reject the request" : st === "ACCEPTED_BY_PROCUREMENT" ? "print the order" : st === "DOCUMENT_GENERATED" ? "place the order" : "follow up";
      if (action) acts.push({ ...shape(r), action, assigned_to_you: assignedToMe });
    }
    links.push({ path: "/purchase-requests", label: "Purchase requests" });
    return { result: { count: acts.length, overdue: acts.filter((a) => a.overdue).length, actions: acts.slice(0, 20) }, links };
  }

  // procurement_problems
  const overdue = all.filter(late);
  const delayed = all.filter((r) => r.proc_status === "DELAYED");
  const emergency = all.filter((r) => r.is_emergency === true);
  links.push({ path: "/purchase-requests", label: "Purchase requests" });
  return { result: {
    overdue: overdue.slice(0, 15).map(shape), delayed: delayed.slice(0, 10).map(shape), emergency_open: emergency.slice(0, 10).map(shape),
  }, links };
}
