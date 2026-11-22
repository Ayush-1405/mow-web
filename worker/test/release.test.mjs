// Phase G deployment manager: the plan, the database-trial verdict and the configuration -- plus a real git repository to prove
// the plan is read from git correctly (no network, no database).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { computePlan, judgeTrial, parseCommits, planRelease, readDbPassword, releaseConfig } from "../src/release.js";

const FN = ["mood-ai", "send-push", "staff-login"];

test("plan: new migrations in the order they were added, tests, changed functions, website", () => {
  const { plan, problem } = computePlan({
    commits: [{ sha: "a1", subject: "x" }],
    nameStatus: ["A\tbackend/supabase/migrations/z_v2.sql", "A\tbackend/supabase/migrations/a_v3.sql", "A\tbackend/supabase/tests/t.sql",
      "M\tbackend/supabase/functions/mood-ai/chat.ts", "M\tfrontend/src/App.jsx", "M\tworker/src/main.js"].join("\n"),
    addedOrder: "backend/supabase/migrations/z_v2.sql\n\nbackend/supabase/migrations/a_v3.sql\n", allFunctions: FN,
  });
  assert.equal(problem, null);
  assert.deepEqual(plan.migrations, ["backend/supabase/migrations/z_v2.sql", "backend/supabase/migrations/a_v3.sql"], "added order, not name order");
  assert.deepEqual(plan.tests, ["backend/supabase/tests/t.sql"]);
  assert.deepEqual(plan.functions, ["mood-ai"]);
  assert.equal(plan.website, true);
});

test("plan: a change to _shared deploys every function; worker-only changes do not touch the website", () => {
  const { plan } = computePlan({ commits: [], nameStatus: "M\tbackend/supabase/functions/_shared/ai.ts\nM\tworker/src/x.js", addedOrder: "", allFunctions: FN });
  assert.deepEqual(plan.functions, FN);
  assert.equal(plan.website, false);
});

test("plan: editing or deleting a migration that may already be live is refused", () => {
  const { problem } = computePlan({ commits: [], nameStatus: "M\tbackend/supabase/migrations/old_v1.sql", addedOrder: "", allFunctions: FN });
  assert.match(problem, /already be live/);
  assert.match(computePlan({ commits: [], nameStatus: "D\tbackend/supabase/migrations/old_v1.sql", addedOrder: "", allFunctions: FN }).problem, /changed or deleted/);
});

test("database trial verdict: only PASS lines and the empty report errors count as success", () => {
  const good = "BEGIN\nCREATE FUNCTION\npsql:t.sql:40: ERROR:  \nPASS  one\nPASS  two\nROLLBACK";
  assert.equal(judgeTrial(good, 1).ok, true);
  assert.equal(judgeTrial(good, 1).passes, 2);
  assert.equal(judgeTrial("psql:t.sql:40: ERROR:  \nPASS  one\nFAIL  two", 1).ok, false);
  assert.equal(judgeTrial("psql:t.sql:9: ERROR:  permission denied for table x", 1).ok, false);
  assert.equal(judgeTrial("BEGIN\nROLLBACK", 1).ok, false, "a test file that reported nothing is not a pass");
  assert.equal(judgeTrial("BEGIN\nCREATE TABLE\nROLLBACK", 0).ok, true, "no tests: the migrations applying cleanly is the trial");
});

test("commits are read from git log lines", () => {
  assert.deepEqual(parseCommits("abc123\tFix login\ndef456\tAdd report\twith tab\n"), [{ sha: "abc123", subject: "Fix login" }, { sha: "def456", subject: "Add report\twith tab" }]);
});

test("configuration: off unless RELEASE=on; project from the Supabase address; password from the Owner's file only", () => {
  assert.equal(releaseConfig({ SUPABASE_URL: "https://bykmyttaesuyjwvtnxks.supabase.co" }).enabled, false);
  const c = releaseConfig({ RELEASE: "on", SUPABASE_URL: "https://bykmyttaesuyjwvtnxks.supabase.co" });
  assert.equal(c.enabled, true);
  assert.equal(c.dbUser, "postgres.bykmyttaesuyjwvtnxks");
  assert.equal(releaseConfig({ RELEASE: "on", SUPABASE_URL: "http://evil.example" }).enabled, false);
  const f = path.join(os.tmpdir(), `mai-pw-${process.pid}.env`);
  fs.writeFileSync(f, "﻿OTHER=1\nLIVE_DB_URL=s3cret-pass\n");
  assert.equal(readDbPassword(f), "s3cret-pass");
  fs.writeFileSync(f, "OTHER=1\n");
  assert.throws(() => readDbPassword(f), /No LIVE_DB_URL/);
  fs.rmSync(f);
});

test("plan from a real git repository: only commits not on GitHub yet; a dirty folder or another branch is refused", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mai-rel-"));
  const origin = path.join(root, "origin.git"); const repo = path.join(root, "repo");
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString().trim();
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, repo);
  git(repo, "config", "user.email", "t@test.invalid"); git(repo, "config", "user.name", "t");
  git(repo, "checkout", "-q", "-b", "main");
  const write = (p, s) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), s); };
  write("backend/supabase/functions/mood-ai/index.ts", "x"); write("backend/supabase/functions/send-push/index.ts", "x");
  write("backend/supabase/migrations/one_v1.sql", "select 1;"); write("frontend/a.js", "1");
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "live"); git(repo, "push", "-q", "origin", "main");
  write("backend/supabase/migrations/two_v2.sql", "select 2;"); write("backend/supabase/functions/mood-ai/chat.ts", "y");
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "Add two");
  const r = await planRelease(repo);
  assert.equal(r.problem, null);
  assert.deepEqual(r.plan.commits.map((c) => c.subject), ["Add two"]);
  assert.deepEqual(r.plan.migrations, ["backend/supabase/migrations/two_v2.sql"]);
  assert.deepEqual(r.plan.functions, ["mood-ai"]);
  assert.equal(r.plan.website, false);
  write("frontend/a.js", "2");
  assert.match((await planRelease(repo)).problem, /uncommitted/);
  git(repo, "checkout", "-q", "--", "frontend/a.js"); git(repo, "checkout", "-q", "-b", "other");
  assert.match((await planRelease(repo)).problem, /not main/);
  fs.rmSync(root, { recursive: true, force: true });
});
