// deno test mood-ai/chat_detect_test.ts -- the Owner's app-change detection backup
import { assertEquals } from "jsr:@std/assert@1";
import { looksLikeAppChange } from "./chat.ts";

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
