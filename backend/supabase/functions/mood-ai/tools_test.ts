// deno test mood-ai/tools_test.ts -- Phase D tools: what the model may ask for, and the task draft, are cleaned before use
import { assertEquals } from "jsr:@std/assert@1";
import { cleanNeed, cleanTaskDraft, todayIST } from "./tools.ts";

Deno.test("only known tools, at most 3, no duplicates; search text cannot inject filter syntax", () => {
  assertEquals(cleanNeed(["my_open_tasks", "drop_table", "my_open_tasks", "my_due_today", "my_unread_notifications", "my_overdue_tasks"], "").tools,
    ["my_open_tasks", "my_due_today", "my_unread_notifications"]);
  assertEquals(cleanNeed("my_open_tasks", "").tools, []);
  const c = cleanNeed(["find_tasks"], "wardrobe),assigned_to.eq.x%_*");
  assertEquals(c.search, "wardrobe assigned to eq x");
  assertEquals(c.tools, ["find_tasks"]);
  assertEquals(cleanNeed(["find_tasks"], " ").tools, [], "a search with no words is dropped");
});

Deno.test("task draft: needs a title; priority and date are checked; nothing else gets through", () => {
  assertEquals(cleanTaskDraft({ title: "", description: "x" }), null);
  assertEquals(cleanTaskDraft(null), null);
  const d = cleanTaskDraft({ title: "Polish wardrobe shutters", description: "Site 12", priority: "CRITICAL", due_date: "2026-13-45", assignee_name: "Ramesh", extra: "x" });
  assertEquals(d, { title: "Polish wardrobe shutters", description: "Site 12", priority: "NORMAL", due_date: "", assignee_name: "Ramesh" });
  assertEquals(cleanTaskDraft({ title: "Check laminate stock", priority: "URGENT", due_date: "2026-11-28" })?.due_date, "2026-11-28");
});

Deno.test("today is India time", () => {
  assertEquals(todayIST(new Date("2026-11-21T20:00:00Z")), "2026-11-22");
});
