// E-commerce (v3_35): Marketing members can open the E-commerce department (mirror of can_view_department) without losing their own
// department; others cannot; and the dashboard date presets use plain India dates. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { canAccessDepartment, getAccessibleDepartments, withPermissions } from "../src/lib/access.js";
import { presetRange } from "../src/lib/ecomRules.js";

const GROUP = "g-sales";
const DEPTS = [
  { id: "d-mkt", code: "MARKETING", department_group_id: GROUP },
  { id: "d-ecom", code: "ECOMMERCE", department_group_id: GROUP, managing_department_id: "d-mkt" },
  { id: "d-ret", code: "RETAIL", department_group_id: "g-other" },
  { id: "d-acc", code: "ACCOUNTS", is_confidential_domain: true },
];
const person = (roleCode, department_id) => withPermissions({ id: "u", roleCode, department_id, is_active: true }, {});

test("a Marketing employee can open E-commerce and still Marketing, but not Retail", () => {
  const p = person("employee", "d-mkt");
  assert.equal(canAccessDepartment(p, DEPTS, DEPTS[1]), true);
  assert.equal(canAccessDepartment(p, DEPTS, DEPTS[0]), true);
  assert.equal(canAccessDepartment(p, DEPTS, DEPTS[2]), false);
  assert.deepEqual(getAccessibleDepartments(p, DEPTS).map((d) => d.code), ["MARKETING", "ECOMMERCE"]);
});

test("a Retail employee cannot open E-commerce", () => {
  assert.equal(canAccessDepartment(person("employee", "d-ret"), DEPTS, DEPTS[1]), false);
});

test("the link never opens a confidential department", () => {
  const depts = [...DEPTS, { id: "d-x", code: "FINANCE_X", is_confidential_domain: true, managing_department_id: "d-mkt" }];
  assert.equal(canAccessDepartment(person("employee", "d-mkt"), depts, depts[4]), false);
});

test("date presets: today, yesterday, last 7 days, this month, last month (also across a new year)", () => {
  assert.deepEqual(presetRange("today", "2026-11-28"), { from: "2026-11-28", to: "2026-11-28" });
  assert.deepEqual(presetRange("yesterday", "2026-11-28"), { from: "2026-11-27", to: "2026-11-27" });
  assert.deepEqual(presetRange("last7", "2026-11-28"), { from: "2026-11-22", to: "2026-11-28" });
  assert.deepEqual(presetRange("thisMonth", "2026-11-28"), { from: "2026-11-01", to: "2026-11-28" });
  assert.deepEqual(presetRange("lastMonth", "2026-11-28"), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(presetRange("lastMonth", "2027-01-05"), { from: "2026-12-01", to: "2026-12-31" });
  assert.deepEqual(presetRange("lastMonth", "2026-03-10"), { from: "2026-02-01", to: "2026-02-28" });
  assert.equal(presetRange("custom", "2026-11-28"), null);
});
