import test from "node:test";
import assert from "node:assert/strict";
import { QUEUES, PROC_STATUS, procStatusLabel, telHref, validateOrderForm, validateRequestForm } from "../src/lib/procurementRules.js";

const goodOrder = {
  vendor_name: "Shree Timber", vendor_contact: "+91 98765 43210", quotation_reference: "Q-17", po_number: "PO-1", order_date: "2026-11-05",
  ordered_quantity: "10", amount: "12000", expected_delivery_date: "2026-11-12", payment_terms: "30 days", remarks: "Best rate",
};

test("a complete order form passes", () => {
  assert.deepEqual(validateOrderForm(goodOrder), {});
});

test("every mandatory order field is required", () => {
  const errors = validateOrderForm({});
  for (const k of Object.keys(goodOrder)) assert.equal(errors[k], "required", k);
});

test("order form rejects a bad phone, non-positive numbers and delivery before the order date", () => {
  assert.equal(validateOrderForm({ ...goodOrder, vendor_contact: "12345" }).vendor_contact, "phone");
  assert.equal(validateOrderForm({ ...goodOrder, ordered_quantity: "0" }).ordered_quantity, "positive");
  assert.equal(validateOrderForm({ ...goodOrder, amount: "-5" }).amount, "positive");
  assert.equal(validateOrderForm({ ...goodOrder, expected_delivery_date: "2026-11-01" }).expected_delivery_date, "beforeOrder");
});

const goodRequest = {
  material_name: "Plywood 18mm", material_category: "Board", quantity: "25", unit: "sheet", required_by_date: "2026-11-20",
  priority: "NORMAL", delivery_location: "Site A",
};

test("request form requires the mandatory fields and a positive quantity", () => {
  assert.deepEqual(validateRequestForm(goodRequest), {});
  assert.equal(validateRequestForm({ ...goodRequest, material_name: " " }).material_name, "required");
  assert.equal(validateRequestForm({ ...goodRequest, quantity: "0" }).quantity, "positive");
});

test("an emergency request needs a reason", () => {
  assert.equal(validateRequestForm({ ...goodRequest, is_emergency: true }).emergency_reason, "required");
  assert.deepEqual(validateRequestForm({ ...goodRequest, is_emergency: true, emergency_reason: "Site stopped" }), {});
});

test("only a real phone number becomes a call link", () => {
  assert.equal(telHref("+91 98765-43210"), "tel:+919876543210");
  assert.equal(telHref("12345"), null);
  assert.equal(telHref(null), null);
});

test("department approval never shares a status with Procurement's queues", () => {
  const procurement = new Set([...QUEUES.procurementNew, ...QUEUES.procurementWorking]);
  for (const s of QUEUES.deptApproval) assert.equal(procurement.has(s), false, s);
});

test("every queue status has a label in both languages", () => {
  for (const s of Object.values(QUEUES).flat()) {
    assert.ok(PROC_STATUS[s]?.en && PROC_STATUS[s]?.gu, s);
    assert.notEqual(procStatusLabel(s, "gu"), s);
  }
});

import { PROGRESS_MOVES, WORK_ORDER_CATEGORIES, procurementRoles } from "../src/lib/procurementRules.js";

const DEPTS = [{ id: "p", code: "PROCUREMENT" }, { id: "g", code: "GODOWN_INV" }, { id: "a", code: "ACCOUNTS" }, { id: "f", code: "FACTORY" }, { id: "i", code: "INTERIOR" }];
const who = (department_id, roleCode, global = false) => ({ department_id, roleCode, permissions: { hasGlobalOversight: global } });

test("procurement roles follow department and role, like the database checks", () => {
  assert.equal(procurementRoles(who("p", "dept_head"), DEPTS).isProcurementHead, true);
  assert.equal(procurementRoles(who("p", "supervisor"), DEPTS).canProcure, true);
  assert.equal(procurementRoles(who("p", "employee"), DEPTS).canProcure, false);
  assert.equal(procurementRoles(who("p", "employee"), DEPTS).isProcurement, true);
  assert.equal(procurementRoles(who("i", "dept_head"), DEPTS).canProcure, false);
  assert.equal(procurementRoles(who("g", "employee"), DEPTS).isGodown, true);
  assert.equal(procurementRoles(who("g", "employee"), DEPTS).isGodownLead, false);
  assert.equal(procurementRoles(who(null, "accounts_employee"), DEPTS).isAccounts, true);
  assert.equal(procurementRoles(who("a", "employee"), DEPTS).isAccounts, true);
  assert.equal(procurementRoles(who(null, "management", true), DEPTS).isManagement, true);
  assert.equal(procurementRoles(who("f", "employee"), DEPTS).canRaiseLowStock, true);
  assert.equal(procurementRoles(who("i", "employee"), DEPTS).canRaiseLowStock, false);
});

test("order progress never jumps to receipt, payment or closing", () => {
  const targets = new Set(Object.values(PROGRESS_MOVES).flat());
  for (const s of ["RECEIVED", "GRN_VERIFIED", "PAID", "CLOSED", "ORDER_PLACED"]) assert.equal(targets.has(s), false, s);
  for (const t of targets) assert.ok(PROC_STATUS[t], t);
});

test("labour, turnkey, job work and services are work orders", () => {
  assert.deepEqual([...WORK_ORDER_CATEGORIES].sort(), ["JOB_WORK", "LABOUR", "SERVICE", "TURNKEY"]);
});

import { defaultOrderForm, itemAmount, orderTotal, validateOrder } from "../src/lib/procurementRules.js";

test("Interior gets the compact form, other departments the large one", () => {
  assert.equal(defaultOrderForm("INTERIOR"), "INTERIOR");
  assert.equal(defaultOrderForm("RETAIL"), "RETAIL");
  assert.equal(defaultOrderForm("FACTORY"), "RETAIL");
});

test("item amount is quantity x rate, only when both are given", () => {
  assert.equal(itemAmount({ quantity: "4", rate: "1250.50" }), 5002);
  assert.equal(itemAmount({ quantity: "1", rate: "" }), null);
  assert.equal(itemAmount({ quantity: "", rate: "10" }), null);
  assert.equal(orderTotal([{ quantity: "1", rate: "42000" }, { quantity: "1", rate: "18500" }, { quantity: "4", rate: "1250.50" }, {}]), 65502);
  assert.equal(orderTotal([{ quantity: "", rate: "" }]), null);
});

test("order validation: header fields, at least one item, each started row complete", () => {
  const h = { form_type: "INTERIOR", required_completion_date: "2026-12-01", delivery_location: "Site" };
  const ok = validateOrder(h, [{ description: "Sofa", qty_size: "1 no" }, { description: "", qty_size: "" }]);
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.items.length, 1);
  assert.equal(validateOrder(h, [{}]).errors.items, "noItems");
  assert.equal(validateOrder(h, [{ description: "Sofa", qty_size: "" }]).errors.items, "row:1");
  assert.equal(validateOrder(h, [{ description: "Sofa", qty_size: "1", rate: "abc" }]).errors.items, "row:1");
  assert.equal(validateOrder({ ...h, delivery_date: "2026-11-20" }, [{ description: "Sofa", qty_size: "1" }]).errors.delivery_date, "beforeCompletion");
  assert.equal(validateOrder({ ...h, form_type: "" }, [{ description: "Sofa", qty_size: "1" }]).errors.form_type, "required");
});

// ---- Due dates and deadlines (v3_06) ----
import { daysLeft, deadlineBucket, fmtDate, remainingText, todayIST, ORDER_PRIORITIES, priorityLabel } from "../src/lib/procurementRules.js";

test("today is counted in IST, not in the device's or UTC's date", () => {
  // 20:00 UTC on 16 Nov is already 01:30 on 17 Nov in Kolkata.
  assert.equal(todayIST(new Date("2026-11-16T20:00:00Z")), "2026-11-17");
  assert.equal(todayIST(new Date("2026-11-16T18:00:00Z")), "2026-11-16");
});

test("days left: positive before, 0 on, negative after the due date; null without one", () => {
  assert.equal(daysLeft("2026-11-19", "2026-11-16"), 3);
  assert.equal(daysLeft("2026-11-16", "2026-11-16"), 0);
  assert.equal(daysLeft("2026-11-14", "2026-11-16"), -2);
  assert.equal(daysLeft("2026-12-01", "2026-11-30"), 1);
  assert.equal(daysLeft(null, "2026-11-16"), null);
  assert.equal(daysLeft("not a date", "2026-11-16"), null);
});

test("dates show as DD-MM-YYYY; timestamps by their IST day", () => {
  assert.equal(fmtDate("2026-11-05"), "05-11-2026");
  assert.equal(fmtDate("2026-11-16T20:00:00Z"), "17-11-2026");
  assert.equal(fmtDate(null), "—");
});

test("deadline buckets only for orders still open with Procurement", () => {
  const t = "2026-11-16";
  const o = (due, s = "ORDER_PLACED") => ({ proc_status: s, required_by_date: due });
  assert.equal(deadlineBucket(o("2026-11-15"), t), "OVERDUE");
  assert.equal(deadlineBucket(o("2026-11-16"), t), "TODAY");
  assert.equal(deadlineBucket(o("2026-11-17"), t), "TOMORROW");
  assert.equal(deadlineBucket(o("2026-11-19"), t), "SOON");
  assert.equal(deadlineBucket(o("2026-11-20"), t), null);
  assert.equal(deadlineBucket(o("2026-11-10", "RECEIVED"), t), null, "delivered orders are never overdue");
  assert.equal(deadlineBucket(o("2026-11-10", "ON_HOLD"), t), null, "on hold is paused");
  assert.equal(deadlineBucket(o("2026-11-10", "PENDING_DEPT_APPROVAL"), t), null, "not yet with Procurement");
  assert.equal(deadlineBucket(o("2026-11-10", "SENT_TO_PROCUREMENT"), t), "OVERDUE");
});

test("remaining-days wording", () => {
  assert.equal(remainingText(4, "en"), "4 days left");
  assert.equal(remainingText(1, "en"), "Due tomorrow");
  assert.equal(remainingText(0, "en"), "Due today");
  assert.equal(remainingText(-1, "en"), "1 day overdue");
  assert.equal(remainingText(-5, "en"), "5 days overdue");
});

test("priorities are Normal / High / Urgent / Emergency; Urgent and Emergency need a reason", () => {
  assert.deepEqual(ORDER_PRIORITIES.map((p) => p.code), ["NORMAL", "HIGH", "URGENT", "EMERGENCY"]);
  assert.equal(priorityLabel("EMERGENCY", "en"), "Emergency");
  const h = { form_type: "RETAIL", required_completion_date: "2026-12-01", delivery_location: "Showroom" };
  const row = [{ description: "Bed", qty_size: "1" }];
  assert.equal(validateOrder({ ...h, priority: "URGENT" }, row).errors.urgency_reason, "required");
  assert.equal(validateOrder({ ...h, priority: "EMERGENCY", urgency_reason: " " }, row).errors.urgency_reason, "required");
  assert.deepEqual(validateOrder({ ...h, priority: "URGENT", urgency_reason: "Handover Friday" }, row).errors, {});
  assert.deepEqual(validateOrder({ ...h, priority: "HIGH" }, row).errors, {}, "High needs no reason");
});

// ---- Order tasks (v3_07) ----
import { TASK_FILTERS, TASK_STAGES, taskStageLabel } from "../src/lib/procurementRules.js";

test("task filters sort order tasks by stage, owner and acceptance", () => {
  const f = Object.fromEntries(TASK_FILTERS.map((x) => [x.key, x.test]));
  const open = { stage: "OPEN", task_id: "t1", accepted_by: null, assigned_to: "head" };
  const mine = { stage: "ORDER_PLACED", task_id: "t2", accepted_by: "me", assigned_to: "me" };
  const theirs = { stage: "IN_PROGRESS", task_id: "t3", accepted_by: "x", assigned_to: "x" };
  assert.ok(f.new({}, open) && f.unassigned({}, open) && !f.mine({}, open, "me"));
  assert.ok(f.mine({}, mine, "me") && f.placed({}, mine) && !f.unassigned({}, mine));
  assert.ok(f.progress({}, theirs) && !f.mine({}, theirs, "me"));
  assert.ok(!f.mine({}, { ...mine, stage: "COMPLETED" }, "me"), "completed work leaves My accepted tasks");
  assert.ok(f.pending({}, { stage: "COMPLETION_PENDING" }) && f.completed({}, { stage: "COMPLETED" }) && f.vendor({}, { stage: "WAITING_FOR_VENDOR" }));
  assert.ok(f.all({}, undefined));
});

test("every stage the server can return has a label", () => {
  for (const code of ["WAITING_APPROVAL", "OPEN", "ACCEPTED", "IN_PROGRESS", "WAITING_FOR_VENDOR", "ORDER_PLACED", "IN_TRANSIT", "PARTIALLY_RECEIVED",
    "WAITING_FOR_GRN", "COMPLETION_PENDING", "COMPLETED", "ON_HOLD", "REJECTED", "CANCELLED", "RETURNED", "DRAFT"]) {
    assert.ok(TASK_STAGES[code], code);
  }
  assert.equal(taskStageLabel("WAITING_FOR_GRN", "en"), "Waiting for GRN");
});
