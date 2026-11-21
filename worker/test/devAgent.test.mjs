import test from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_TOOLS, DENIED_TOOLS, buildPrompt, parseOutcome } from "../src/devAgent.js";

test("the final line decides the report", () => {
  assert.deepEqual(parseOutcome("did things\nREADY: Added the report; build and 5 tests passed."),
    { status: "READY_FOR_REVIEW", note: "Added the report; build and 5 tests passed." });
  assert.equal(parseOutcome("x\nNEEDS_INFO: Which factory units?").status, "NEEDS_INFO");
  assert.equal(parseOutcome("ready: lower case works").status, "READY_FOR_REVIEW");
  assert.equal(parseOutcome("I tried but stopped").status, "REJECTED", "no clear result is not treated as success");
  assert.equal(parseOutcome("").status, "REJECTED");
});

test("safety lists: no database, push, deploy or credential reading; no generic shell readers", () => {
  for (const t of ["Bash(psql*)", "Bash(git push*)", "Bash(npx supabase*)", "Bash(vercel*)", "Read(~/.mow-db.env)", "Read(**/.env)"]) {
    assert.ok(DENIED_TOOLS.includes(t), `${t} must be denied`);
  }
  for (const t of ALLOWED_TOOLS) assert.ok(!/psql|push|supabase|vercel|curl|cat\*|ls\*/.test(t), `${t} must not be allowed`);
});

test("the prompt carries the request, branch, answers and the rules", () => {
  const p = buildPrompt({ ref: "DR-0009", title: "T", risk: "LOW", prompt: "Do it", answers: ["Owner answered: all units"] }, "mood-ai/DR-0009");
  assert.match(p, /DR-0009/); assert.match(p, /mood-ai\/DR-0009/); assert.match(p, /all units/);
  assert.match(p, /Do not push/); assert.match(p, /NEEDS_INFO:/); assert.match(p, /READY:/);
});
