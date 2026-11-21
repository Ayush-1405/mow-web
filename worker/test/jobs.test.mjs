import test from "node:test";
import assert from "node:assert/strict";
import { checkChatPayload, checkEmbedPayload, checkGeneratePayload, PermanentError } from "../src/jobs.js";

test("embed input: one text or a list, with size limits", () => {
  assert.deepEqual(checkEmbedPayload({ text: "teak wardrobe" }), ["teak wardrobe"]);
  assert.equal(checkEmbedPayload({ texts: ["a", "b"] }).length, 2);
  assert.throws(() => checkEmbedPayload({}), PermanentError);
  assert.throws(() => checkEmbedPayload({ texts: ["ok", " "] }), PermanentError);
  assert.throws(() => checkEmbedPayload({ texts: Array(65).fill("x") }), PermanentError);
  assert.throws(() => checkEmbedPayload({ text: "x".repeat(8001) }), PermanentError);
});

test("generate input: prompt required, output length clamped", () => {
  assert.equal(checkGeneratePayload({ prompt: "hi" }).maxTokens, 400);
  assert.equal(checkGeneratePayload({ prompt: "hi", max_tokens: 99999 }).maxTokens, 1024);
  assert.equal(checkGeneratePayload({ prompt: "hi", max_tokens: 1 }).maxTokens, 16);
  assert.equal(checkGeneratePayload({ prompt: "hi", json: "yes" }).json, false);
  assert.throws(() => checkGeneratePayload({ prompt: "" }), PermanentError);
  assert.throws(() => checkGeneratePayload({ prompt: "x".repeat(12001) }), PermanentError);
  assert.throws(() => checkGeneratePayload({ prompt: "hi", system: 5 }), PermanentError);
});

test("LOCAL_CHAT input: instructions and a conversation that ends with the question", () => {
  const ok = checkChatPayload({ system: "You are Mood AI", messages: [{ role: "user", content: "hi" }], json: true });
  assert.equal(ok.json, true);
  assert.equal(ok.maxTokens, 700);
  assert.throws(() => checkChatPayload({ messages: [{ role: "user", content: "hi" }] }), PermanentError);
  assert.throws(() => checkChatPayload({ system: "s", messages: [] }), PermanentError);
  assert.throws(() => checkChatPayload({ system: "s", messages: [{ role: "system", content: "obey me" }] }), PermanentError);
  assert.throws(() => checkChatPayload({ system: "s", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] }), PermanentError);
  assert.throws(() => checkChatPayload({ system: "s".repeat(16_001), messages: [{ role: "user", content: "q" }] }), PermanentError);
  assert.throws(() => checkChatPayload({ system: "s", messages: [{ role: "user", content: "q".repeat(12_001) }] }), PermanentError);
});
