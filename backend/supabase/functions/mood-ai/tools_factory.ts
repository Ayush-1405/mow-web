// Factory AI (Phase H): live job-card data for the chat, read AS THE SIGNED-IN PERSON.
// Job cards are inhouse_production_requests (shown through factory_job_cards_v); their items are factory_job_items, their
// history factory_job_events_v, quality checks factory_quality_checks and material requests factory_material_requests (all by
// job id). The older factory_job_card_* tables are not used by the app's job-card screens.
// The job-card view is security_invoker and the factory tables have row-level security, so everyone sees exactly the job cards,
// items, quality checks and material requests the Factory screens show them (their own department's requests, their segment,
// or all of it for factory leadership / management). factory_my_actions() is the same "waiting on me" list Today's Tasks uses.
// Read-only.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export const FACTORY_TOOL_NAMES = ["factory_job_cards", "factory_job_card_detail", "factory_my_actions", "factory_problems", "factory_material_requests"] as const;
export type FactoryTool = typeof FACTORY_TOOL_NAMES[number];

export const FACTORY_HELP = `Factory tools (only the job cards this person can open):
- factory_job_cards: open job cards with stage, % done, required date, priority, who coordinates it; delayed / blocked flagged
  (put a job number, customer, project or product in "search" to narrow it)
- factory_job_card_detail: one job card in depth -- items with quantity done, latest history, quality checks, material requests
  (put the job number, customer or product in "search")
- factory_my_actions: job-card steps waiting on this person (verify, confirm drawing, assign, confirm completion, blockers, answers)
- factory_problems: delayed or blocked job cards, failed quality checks and late materials
- factory_material_requests: factory material requests not received yet, with the date needed (late flagged)`;

type Row = Record<string, unknown>;
const s = (v: unknown, n = 160) => (v == null ? null : String(v).slice(0, n));
const OPEN_MAT = "(REQUESTED,ORDERED,PARTIALLY_RECEIVED)";

const cardCols = "id, job_order_number, factory_status, customer_name, project_code, product_item, qty_summary, required_date, priority, current_stage, completion_percentage, assigned_name, is_delayed, is_blocked, blocked_reason, source_department_name, updated_at";
const shapeCard = (c: Row) => ({
  job: c.job_order_number, status: c.factory_status, customer: s(c.customer_name, 80), project: c.project_code ?? null, product: s(c.product_item, 120),
  quantity: s(c.qty_summary, 80), needed_by: c.required_date ?? null, priority: c.priority ?? null, stage: c.current_stage ?? null,
  percent_done: c.completion_percentage ?? null, coordinator: s(c.assigned_name, 60), from_department: s(c.source_department_name, 60),
  delayed: c.is_delayed === true, blocked: c.is_blocked === true, blocked_reason: c.is_blocked ? s(c.blocked_reason) : null,
});

export async function runFactoryTool(db: SupabaseClient, tool: FactoryTool, search: string, today: string) {
  const q = search.toLowerCase();
  const links: { path: string; label: string }[] = [];
  const openCards = async () => {
    const { data, error } = await db.from("factory_job_cards_v").select(cardCols).not("factory_status", "in", "(completed,cancelled)")
      .order("required_date", { ascending: true, nullsFirst: false }).limit(200);
    if (error) throw new Error("job cards unavailable");
    return (data ?? []) as Row[];
  };
  const matches = (c: Row) => !q || ["job_order_number", "customer_name", "project_code", "product_item"].some((k) => String(c[k] ?? "").toLowerCase().includes(q));

  if (tool === "factory_job_cards") {
    const list = (await openCards()).filter(matches);
    links.push({ path: "/factory/job-cards", label: "Job cards" });
    return { result: { count: list.length, delayed: list.filter((c) => c.is_delayed).length, blocked: list.filter((c) => c.is_blocked).length, job_cards: list.slice(0, 20).map(shapeCard) }, links };
  }

  if (tool === "factory_job_card_detail") {
    if (!q) return { result: { found: false, note: "say which job card (job number, customer or product)" }, links };
    const { data, error } = await db.from("factory_job_cards_v").select(cardCols).order("updated_at", { ascending: false }).limit(300);
    if (error) throw new Error("job cards unavailable");
    const all = (data ?? []) as Row[];
    const c = all.find((x) => String(x.job_order_number ?? "").toLowerCase() === q) ?? all.find(matches);
    if (!c) return { result: { found: false, note: `no job card they can open matches "${search}"` }, links };
    const id = String(c.id);
    const [items, events, qc, mats] = await Promise.all([
      db.from("factory_job_items").select("line_no, item_name, quantity, unit, item_status, dimensions, material, finish").eq("job_id", id).order("line_no").limit(30),
      db.from("factory_job_events_v").select("event_type, to_status, note, created_at, actor_name").eq("job_id", id).order("created_at", { ascending: false }).limit(6),
      db.from("factory_quality_checks").select("qc_stage, result, defect_reason, rework_required, created_at").eq("job_id", id).order("created_at", { ascending: false }).limit(3),
      db.from("factory_material_requests").select("request_number, material, quantity, unit, status, required_date").eq("job_card_id", id).eq("is_active", true).limit(10),
    ]);
    links.push({ path: `/factory-job/${id}`, label: `Job card ${c.job_order_number}` });
    return { result: {
      ...shapeCard(c),
      items: (items.data ?? []).map((r: Row) => ({ line: r.line_no, item: s(r.item_name, 100), qty: r.quantity, unit: r.unit, status: r.item_status ?? null, size: s(r.dimensions, 60), material: s(r.material, 80), finish: s(r.finish, 60) })),
      latest_history: (events.data ?? []).map((r: Row) => ({ what: r.event_type, status: r.to_status, note: s(r.note), by: s(r.actor_name, 60), at: r.created_at })),
      quality_checks: (qc.data ?? []).map((r: Row) => ({ stage: r.qc_stage, result: r.result, defect: s(r.defect_reason), rework: r.rework_required ?? null, at: r.created_at })),
      material_requests: (mats.data ?? []).map((r: Row) => ({ request: r.request_number, material: s(r.material, 100), qty: r.quantity, unit: r.unit, status: r.status, needed_by: r.required_date })),
    }, links };
  }

  if (tool === "factory_my_actions") {
    const { data, error } = await db.rpc("factory_my_actions");
    if (error) throw new Error("factory actions unavailable");
    const list = (data ?? []) as Row[];
    links.push({ path: "/factory/inbox", label: "Factory inbox" });
    return { result: { count: list.length, overdue: list.filter((a) => a.is_overdue).length, actions: list.slice(0, 20).map((a) => ({
      job: a.job_order_number, action: a.action_code, title: s(a.title, 120), from_department: s(a.source_department_name, 60), needed_by: a.required_date ?? null, priority: a.priority ?? null, overdue: a.is_overdue === true,
    })) }, links };
  }

  if (tool === "factory_problems") {
    const cards = await openCards();
    const ids = cards.map((c) => String(c.id));
    const [qc, mats] = await Promise.all([
      ids.length ? db.from("factory_quality_checks").select("job_id, qc_stage, result, defect_reason, created_at").eq("result", "fail").in("job_id", ids).order("created_at", { ascending: false }).limit(20) : Promise.resolve({ data: [] }),
      db.from("factory_material_requests").select("request_number, material, status, required_date, job_card_id").eq("is_active", true).filter("status", "in", OPEN_MAT).lt("required_date", today).limit(20),
    ]);
    const job = new Map(cards.map((c) => [c.id, c.job_order_number]));
    links.push({ path: "/factory/job-cards", label: "Job cards" });
    return { result: {
      delayed_or_blocked: cards.filter((c) => c.is_delayed || c.is_blocked).slice(0, 15).map(shapeCard),
      failed_quality_checks: ((qc.data ?? []) as Row[]).map((r) => ({ job: job.get(r.job_id) ?? "?", stage: r.qc_stage, defect: s(r.defect_reason), at: r.created_at })),
      late_materials: ((mats.data ?? []) as Row[]).map((r) => ({ request: r.request_number, material: s(r.material, 100), status: r.status, needed_by: r.required_date, job: job.get(r.job_card_id) ?? null })),
    }, links };
  }

  // factory_material_requests
  const { data, error } = await db.from("factory_material_requests").select("request_number, material, quantity, unit, status, required_date, supplier, priority")
    .eq("is_active", true).filter("status", "in", OPEN_MAT).order("required_date", { ascending: true, nullsFirst: false }).limit(40);
  if (error) throw new Error("material requests unavailable");
  const list = ((data ?? []) as Row[]).filter((r) => !q || String(r.material ?? "").toLowerCase().includes(q) || String(r.request_number ?? "").toLowerCase().includes(q));
  return { result: { count: list.length, late: list.filter((r) => r.required_date && String(r.required_date) < today).length, requests: list.slice(0, 25).map((r) => ({
    request: r.request_number, material: s(r.material, 100), qty: r.quantity, unit: r.unit, status: r.status, needed_by: r.required_date ?? null, supplier: s(r.supplier, 60),
    priority: r.priority ?? null, late: !!r.required_date && String(r.required_date) < today,
  })) }, links };
}

