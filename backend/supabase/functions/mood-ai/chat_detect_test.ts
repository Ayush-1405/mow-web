// deno test mood-ai/chat_detect_test.ts -- the Owner's app-change detection backup
import { assertEquals } from "jsr:@std/assert@1";
import { directDevDraft, localChatPayload, looksLikeAppChange } from "./chat.ts";

Deno.test("instructions to change the app are detected", () => {
  for (const t of [
    "make this ai fully indipendent and it ebels to do anything with my permition also make this ai do any thing like bilding changing modules",
    "Factory ma monthly wastage report add karo",
    "add a button to export orders to excel",
    "retail page ma customer birthday field joie che",
    "procurement dashboard ma delay alert banao",
    "fix the login page on iphone",
  ]) assertEquals(looksLikeAppChange(t), true, t);
});

Deno.test("questions and chat are not", () => {
  for (const t of [
    "How can I add a task",
    "kaise purchase request banaye?",
    "where is the dispatch queue",
    "mare app ne update karvi che?",
    "help",
    "thank you",
    "What is a job card",
  ]) assertEquals(looksLikeAppChange(t), false, t);
});

Deno.test("the laptop gets trimmed instructions, a JSON answer format and the last turns, starting with a question", () => {
  const turns = Array.from({ length: 9 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `turn ${i} ` + "x".repeat(i === 7 ? 5000 : 10) }));
  const p = localChatPayload("S".repeat(20_000), turns);
  assertEquals(p.system.startsWith("S".repeat(14_000)) && !p.system.includes("S".repeat(14_001)), true);
  assertEquals(p.system.includes('{"reply"'), true);
  assertEquals(p.json, true);
  assertEquals(p.messages[0].role, "user");
  assertEquals(p.messages[p.messages.length - 1].content.startsWith("turn 8"), true);
  assertEquals(p.messages.length <= 6 && p.messages.every((m) => m.content.length <= 2000), true);
});

Deno.test("when the request writer is down, the Owner's own words become the request (any language), with a safe default", () => {
  const msg = "Factory ma monthly wastage report add karo\nwith month filter";
  const d = directDevDraft(msg);
  assertEquals(d.title, "Factory ma monthly wastage report add karo");
  assertEquals(d.prompt.includes(msg), true);
  assertEquals(d.prompt.includes("NEEDS_INFO"), true);
  assertEquals(d.risk, "MEDIUM");
  assertEquals(directDevDraft("x".repeat(200)).title.length, 80);
});
