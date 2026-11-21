import test from "node:test";
import assert from "node:assert/strict";
import { addMonths, cleanGoals, currentMonthIST, fmtChange, isEndedMonth, monthLabel, monthOptions, rankWithinDepartments, scoreBand, sortTaskRows, validateWeights }
  from "../src/lib/perfRules.js";

test("months follow India time and step across years", () => {
  assert.equal(currentMonthIST(new Date("2026-10-31T19:00:00Z")), "2026-11-01"); // 00:30 IST on 1 Nov
  assert.equal(currentMonthIST(new Date("2026-10-31T18:00:00Z")), "2026-10-01");
  assert.equal(addMonths("2026-01-01", -1), "2025-12-01");
  assert.equal(addMonths("2026-11-01", 2), "2027-01-01");
  assert.equal(monthLabel("2026-10-01"), "Oct 2026");
  const opts = monthOptions(3, new Date("2026-11-21T08:00:00Z"));
  assert.deepEqual(opts, ["2026-11-01", "2026-10-01", "2026-09-01"]);
  assert.equal(isEndedMonth("2026-10-01", new Date("2026-11-21T08:00:00Z")), true);
  assert.equal(isEndedMonth("2026-11-01", new Date("2026-11-21T08:00:00Z")), false);
});

test("no score means insufficient data, never zero", () => {
  assert.equal(scoreBand(null).key, "none");
  assert.equal(scoreBand(undefined).key, "none");
  assert.equal(scoreBand(0).key, "low");
  assert.equal(scoreBand(85).key, "excellent");
  assert.equal(fmtChange(8), "+8");
  assert.equal(fmtChange(-2.5), "-2.5");
  assert.equal(fmtChange(null), "—");
});

test("ranks are only within a department; unscored people are listed without a rank", () => {
  const groups = rankWithinDepartments([
    { full_name: "A", department: "Interior", overall_score: 80 },
    { full_name: "B", department: "Interior", overall_score: 90 },
    { full_name: "C", department: "Interior", overall_score: 80 },
    { full_name: "D", department: "Interior", overall_score: null },
    { full_name: "E", department: "Factory", overall_score: 99 },
  ]);
  assert.deepEqual(groups.map((g) => g.department), ["Factory", "Interior"]);
  const interior = groups[1].people;
  assert.deepEqual(interior.map((p) => [p.full_name, p.rank]), [["B", 1], ["A", 2], ["C", 2], ["D", null]]);
  assert.equal(groups[0].people[0].rank, 1);
});

test("scored tasks come first, weakest first, so problems are visible", () => {
  const rows = sortTaskRows([
    { task_number: "T3", scored: false, outcome: "CANCELLED" },
    { task_number: "T1", scored: true, points: 90, outcome: "COMPLETED" },
    { task_number: "T2", scored: true, points: 20, outcome: "OVERDUE_OPEN" },
    { task_number: "T4", scored: false, outcome: "PENDING" },
  ]);
  assert.deepEqual(rows.map((r) => r.task_number), ["T2", "T1", "T4", "T3"]);
});

test("weights must add up to 100", () => {
  assert.equal(validateWeights({ completion: 30, deadline: 20, quality: 25, ownership: 15, collaboration: 10 }), null);
  assert.match(validateWeights({ completion: 30, deadline: 20, quality: 25, ownership: 15, collaboration: 20 }), /110/);
  assert.match(validateWeights({ completion: -1, deadline: 20, quality: 25, ownership: 15, collaboration: 41 }), /0 or more/);
});

test("goals: blank rows dropped, measurable goals need a valid target", () => {
  assert.deepEqual(cleanGoals([{ goal_type: "REDUCE_OVERDUE", target_value: "0", description: " No overdue tasks " }, { goal_type: "CUSTOM", description: "" }]),
    { goals: [{ goal_type: "REDUCE_OVERDUE", target_value: 0, description: "No overdue tasks" }] });
  assert.ok(cleanGoals([{ goal_type: "IMPROVE_ON_TIME", target_value: "120", description: "On time" }]).error);
  assert.ok(cleanGoals([{ goal_type: "IMPROVE_QUALITY", target_value: "", description: "Quality" }]).error);
  assert.deepEqual(cleanGoals([{ goal_type: "CUSTOM", target_value: "5", description: "Document every site visit" }]).goals[0].target_value, null);
});
