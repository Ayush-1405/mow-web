import test from "node:test";
import assert from "node:assert/strict";
import { backoffMs, cpuPercent, decide, istMinutes, withinHours } from "../src/policy.js";

const ok = { ai_enabled: true, paused: false };
const fine = { cpu_pct: 10, ram_free_gb: 6, on_ac: true };

test("runs only when everything is fine", () => {
  assert.equal(decide({ server: ok, metrics: fine, cpuHistory: [10, 12, 9] }).run, true);
});

test("emergency stop and pause always win", () => {
  assert.equal(decide({ server: { ai_enabled: false }, metrics: fine }).state, "STOPPED");
  assert.equal(decide({ server: { ...ok, paused: true }, metrics: fine }).state, "PAUSED");
});

test("protects the laptop: battery, low memory, busy CPU", () => {
  assert.match(decide({ server: ok, metrics: { ...fine, on_ac: false } }).reason, /battery/i);
  assert.equal(decide({ server: ok, metrics: { ...fine, on_ac: false }, limits: { pause_on_battery: false } }).run, true);
  assert.match(decide({ server: ok, metrics: { ...fine, ram_free_gb: 2.4 } }).reason, /memory/i);
  assert.match(decide({ server: ok, metrics: fine, cpuHistory: [90, 85, 80] }).reason, /busy/i);
  assert.equal(decide({ server: ok, metrics: fine, cpuHistory: [5, 5, 95] }).run, true, "one spike does not pause");
});

test("working hours are India time, including overnight windows", () => {
  const at = (h, m) => new Date(Date.UTC(2026, 10, 21, h, m) - 330 * 60000); // h:m IST
  assert.equal(istMinutes(at(9, 30)), 570);
  assert.equal(withinHours({ from: "09:00", to: "19:00" }, at(9, 30)), true);
  assert.equal(withinHours({ from: "09:00", to: "19:00" }, at(19, 0)), false);
  assert.equal(withinHours({ from: "22:00", to: "06:00" }, at(23, 0)), true);
  assert.equal(withinHours({ from: "22:00", to: "06:00" }, at(12, 0)), false);
  assert.equal(withinHours(null, at(3, 0)), true);
});

test("CPU percent and retry waits", () => {
  const a = [{ times: { user: 100, nice: 0, sys: 50, irq: 0, idle: 850 } }];
  const b = [{ times: { user: 200, nice: 0, sys: 100, irq: 0, idle: 1700 } }];
  assert.equal(cpuPercent(a, b), 15);
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 60_000);
  assert.equal(backoffMs(10), 300_000);
});
