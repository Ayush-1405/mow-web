// Mood AI application tools (Phase D): live app data for the chat, read AS THE SIGNED-IN PERSON.
//
// Every query runs through the person's own sign-in token (userScopedClient), so row-level security decides what comes back:
// Mood AI can never show anyone more than the app itself would show them. Read-only: nothing here changes a record.
// Actions (e.g. a new task) are only PREPARED as a draft that opens in the normal form; the person reviews and submits it there.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { INTERIOR_HELP, INTERIOR_TOOL_NAMES, type InteriorTool, runInteriorTool } from "./tools_interior.ts";
import { FACTORY_HELP, FACTORY_TOOL_NAMES, type FactoryTool, runFactoryTool } from "./tools_factory.ts";
import { PROCUREMENT_HELP, PROCUREMENT_TOOL_NAMES, type ProcurementTool, runProcurementTool } from "./tools_procurement.ts";

export const BASE_TOOL_NAMES = ["my_open_tasks", "my_overdue_tasks", "my_due_today", "tasks_i_assigned", "find_tasks", "my_unread_notifications"] as const;
// department agents (Phase H) add their own tools; each set is offered only while its agent is switched on
export const TOOL_NAMES = [...BASE_TOOL_NAMES, ...INTERIOR_TOOL_NAMES, ...FACTORY_TOOL_NAMES, ...PROCUREMENT_TOOL_NAMES] as const;
// one entry per department agent: its code in mai_agents, its tools and the help the model gets while it is switched on
export const DEPARTMENT_AGENTS: { code: string; tools: readonly string[]; help: string }[] = [
  { code: "INTERIOR", tools: INTERIOR_TOOL_NAMES, help: INTERIOR_HELP },
  { code: "FACTORY", tools: FACTORY_TOOL_NAMES, help: FACTORY_HELP },
  { code: "PROCUREMENT", tools: PROCUREMENT_TOOL_NAMES, help: PROCUREMENT_HELP },
];
export type ToolName = typeof TOOL_NAMES[number];

export const TOOLS_HELP = `Live data tools (they read the app as this person; they only see what the app already shows them):
- my_open_tasks: tasks assigned to them that are not finished
- my_overdue_tasks: their unfinished tasks past the due date
- my_due_today: their tasks due today
- tasks_i_assigned: unfinished tasks they gave to others
- find_tasks: search tasks they can see by words or task number (put the words in "search")
- my_unread_notifications: their unread notifications
When the question needs live data, put the tool names in "need" (and "search" for find_tasks) and write only a short holding
reply; you will then get the results and answer. Do not ask for tools you do not need. Never invent records: if a tool returns
nothing, say so.`;

const DONE = new Set(["COMPLETED", "VERIFIED", "CLOSED"]);

export function todayIST(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// What the model may ask for, cleaned: known names only, at most 3 tools, a short search text.
export function cleanNeed(need: unknown, search: unknown, allowed: readonly string[] = BASE_TOOL_NAMES): { tools: ToolName[]; search: string } {
  const tools = (Array.isArray(need) ? need : []).filter((n): n is ToolName => allowed.includes(String(n)));
  const uniq = [...new Set(tools)].slice(0, 3);
  const q = String(search ?? "").replace(/[%_,().:"*\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  const needsSearch = new Set(["find_tasks", "interior_project_detail", "factory_job_card_detail", "procurement_request_detail"]);
  return { tools: uniq.filter((t) => !needsSearch.has(t) || q.length >= 2), search: q };
}

type Row = Record<string, unknown>;

// Runs the tools as the person and returns compact results for the model (and links for the chat).
export async function runTools(db: SupabaseClient, userId: string, tools: ToolName[], search: string) {
  const today = todayIST();
  const [{ data: statuses }, { data: priorities }] = await Promise.all([
    db.from("status_master").select("id, code, name_en"),
    db.from("priority_master").select("id, code, name_en"),
  ]);
  const st = new Map((statuses ?? []).map((s: Row) => [s.id, s]));
  const pr = new Map((priorities ?? []).map((p: Row) => [p.id, p]));
  const cols = "id, task_number, title, due_date, status_id, priority_id, assigned_to, assigned_by, is_bridge";

  const shape = (rows: Row[]) => rows.map((t) => ({
    task: t.task_number, title: String(t.title ?? "").slice(0, 140), due: t.due_date ?? null,
    status: (st.get(t.status_id) as Row | undefined)?.name_en ?? null, priority: (pr.get(t.priority_id) as Row | undefined)?.name_en ?? null,
    overdue: !!t.due_date && String(t.due_date) < today && !DONE.has(String((st.get(t.status_id) as Row | undefined)?.code ?? "")),
    _id: t.id, _assigned_to: t.assigned_to,
  }));
  const open = (rows: Row[]) => rows.filter((t) => !DONE.has(String((st.get(t.status_id) as Row | undefined)?.code ?? "")));
  const tasks = async (scope: "scope_mine" | "scope_created") => {
    const { data, error } = await db.from("staff_task_scope_v").select(cols).eq("is_active", true).eq(scope, true)
      .order("due_date", { ascending: true, nullsFirst: false }).limit(200);
    if (error) throw new Error("tasks unavailable");
    return open(data ?? []);
  };

  const results: Record<string, unknown> = { today };
  const found: { id: string; title: string }[] = [];
  const extraLinks: { path: string; label: string }[] = [];
  for (const tool of tools) {
    try {
      if (tool === "my_open_tasks" || tool === "my_overdue_tasks" || tool === "my_due_today") {
        let rows = await tasks("scope_mine");
        if (tool === "my_overdue_tasks") rows = rows.filter((t) => t.due_date && String(t.due_date) < today);
        if (tool === "my_due_today") rows = rows.filter((t) => String(t.due_date) === today);
        const list = shape(rows);
        results[tool] = { count: list.length, tasks: list.slice(0, 15).map(({ _id, _assigned_to, ...r }) => r) };
        list.slice(0, 15).forEach((t) => found.push({ id: String(t._id), title: `${t.task} ${t.title}`.slice(0, 60) }));
      } else if (tool === "tasks_i_assigned") {
        const list = shape(await tasks("scope_created"));
        const ids = [...new Set(list.slice(0, 15).map((t) => t._assigned_to).filter(Boolean))];
        const { data: people } = ids.length ? await db.from("user_profiles").select("id, full_name").in("id", ids as string[]) : { data: [] };
        const nm = new Map((people ?? []).map((p: Row) => [p.id, p.full_name]));
        results[tool] = { count: list.length, tasks: list.slice(0, 15).map(({ _id, _assigned_to, ...r }) => ({ ...r, assigned_to: nm.get(_assigned_to) ?? "someone" })) };
      } else if (tool === "find_tasks") {
        const { data, error } = await db.from("staff_task_scope_v").select(cols).eq("is_active", true)
          .or(`title.ilike.%${search}%,task_number.ilike.%${search}%`).order("created_at", { ascending: false }).limit(10);
        if (error) throw new Error("search unavailable");
        const list = shape(data ?? []);
        results[tool] = { search, count: list.length, tasks: list.map(({ _id, _assigned_to, ...r }) => r) };
        list.slice(0, 5).forEach((t) => found.push({ id: String(t._id), title: `${t.task} ${t.title}`.slice(0, 60) }));
      } else if ((INTERIOR_TOOL_NAMES as readonly string[]).includes(tool)) {
        const r = await runInteriorTool(db, tool as InteriorTool, search, today);
        results[tool] = r.result;
        extraLinks.push(...r.links);
      } else if ((FACTORY_TOOL_NAMES as readonly string[]).includes(tool)) {
        const r = await runFactoryTool(db, tool as FactoryTool, search, today);
        results[tool] = r.result;
        extraLinks.push(...r.links);
      } else if ((PROCUREMENT_TOOL_NAMES as readonly string[]).includes(tool)) {
        const r = await runProcurementTool(db, tool as ProcurementTool, search, today, userId);
        results[tool] = r.result;
        extraLinks.push(...r.links);
      } else if (tool === "my_unread_notifications") {
        const { data, error, count } = await db.from("notifications").select("title_en, created_at", { count: "exact" })
          .eq("recipient_id", userId).eq("is_read", false).order("created_at", { ascending: false }).limit(10);
        if (error) throw new Error("notifications unavailable");
        results[tool] = { count: count ?? (data ?? []).length, latest: (data ?? []).map((n: Row) => ({ title: String(n.title_en ?? "").slice(0, 140), at: n.created_at })) };
      }
    } catch (e) {
      results[tool] = { error: e instanceof Error ? e.message : "unavailable" };
    }
  }
  // links straight to the tasks that were mentioned (the Today's Tasks screen focuses ?focus=<id>)
  const links = [...found.slice(0, 3).map((t) => ({ path: `/?focus=${t.id}`, label: t.title })), ...extraLinks].slice(0, 4);
  return { results, links };
}

// A task the person asked Mood AI to set up: only a DRAFT for the normal Assign Task form (nothing is created here).
export function cleanTaskDraft(d: unknown): { title: string; description: string; priority: string; due_date: string; assignee_name: string } | null {
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  const title = String(o.title ?? "").trim().slice(0, 120);
  if (title.length < 3) return null;
  const priority = ["LOW", "NORMAL", "HIGH", "URGENT"].includes(String(o.priority)) ? String(o.priority) : "NORMAL";
  const due = String(o.due_date ?? "");
  return {
    title, description: String(o.description ?? "").trim().slice(0, 2000), priority,
    due_date: /^\d{4}-\d{2}-\d{2}$/.test(due) && !Number.isNaN(Date.parse(due)) ? due : "",
    assignee_name: String(o.assignee_name ?? "").trim().slice(0, 60),
  };
}
