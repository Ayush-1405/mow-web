import test from "node:test";
import assert from "node:assert/strict";
import { SECTIONS, effectiveDue, guessFileKind, isOverdue, itemProgress, allItemsDone, sectionCounts, validateJobCard, daysLeft } from "../src/lib/factoryJobRules.js";

const today = "2026-11-20";

test("a complete Job Card passes; empty rows are ignored", () => {
  assert.deepEqual(validateJobCard({ due_date: "2026-11-30", priority: "NORMAL" }, [{ product_name: "Sofa", quantity: "2", unit: "nos" }, { product_name: "", quantity: "", unit: "nos" }], today), {});
});

test("due date, product and quantity are checked", () => {
  const e = validateJobCard({ due_date: "2026-11-19", priority: "NORMAL" }, [{ product_name: "", quantity: "0", unit: "nos" }], today);
  assert.equal(e.due_date, "past");
  assert.deepEqual(e.lines[0], { product_name: "required", quantity: "quantity" });
  assert.equal(validateJobCard({ due_date: "", priority: "NORMAL" }, [{ product_name: "", quantity: "", unit: "nos" }], today).items, "none");
});

test("revised date is the date in force; overdue only before ready", () => {
  const j = { due_date: "2026-11-18", revised_due_date: "2026-11-25", status: "IN_PROGRESS" };
  assert.equal(effectiveDue(j), "2026-11-25");
  assert.equal(isOverdue(j, today), false);
  assert.equal(isOverdue({ due_date: "2026-11-18", status: "IN_PROGRESS" }, today), true);
  assert.equal(isOverdue({ due_date: "2026-11-18", status: "READY_FOR_DISPATCH" }, today), false);
  assert.equal(daysLeft({ due_date: "2026-11-23" }, today), 3);
});

test("seven sections with counts", () => {
  assert.deepEqual(SECTIONS.map((s) => s.key), ["new", "accepted", "production", "qc", "ready", "completed", "overdue"]);
  const c = sectionCounts([{ status: "NEW", due_date: "2026-11-30" }, { status: "IN_PROGRESS", due_date: "2026-11-10" }, { status: "PRODUCTION_STARTED", due_date: "2026-12-01" },
    { status: "COMPLETED", due_date: "2026-11-01" }], today);
  assert.deepEqual(c, { new: 1, accepted: 0, production: 2, qc: 0, ready: 0, completed: 1, overdue: 1 });
});

test("item progress and completion", () => {
  assert.equal(itemProgress({ quantity: 3, qty_completed: 1 }), 33);
  assert.equal(allItemsDone([{ quantity: 2, qty_completed: 2 }, { quantity: 1, qty_completed: 0 }]), false);
  assert.equal(allItemsDone([{ quantity: 2, qty_completed: 2 }]), true);
});

test("file kind is guessed from the file", () => {
  assert.equal(guessFileKind({ name: "sofa.jpg", type: "image/jpeg" }), "PRODUCT_IMAGE");
  assert.equal(guessFileKind({ name: "layout.dwg", type: "" }), "DRAWING");
  assert.equal(guessFileKind({ name: "spec.pdf", type: "application/pdf" }), "PDF");
});
