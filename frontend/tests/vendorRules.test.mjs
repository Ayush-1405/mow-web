import test from "node:test";
import assert from "node:assert/strict";
import { TASK_FILTERS, TIER_LABELS, VENDOR_LEVELS, vendorLevel, vendorSelectable, whatsappHref } from "../src/lib/procurementRules.js";

test("vendor level follows block status before preference", () => {
  assert.equal(vendorLevel({ preference: "HIGHLY_PREFERRED" }), "HIGHLY_PREFERRED");
  assert.equal(vendorLevel({}), "REGULAR");
  assert.equal(vendorLevel({ preference: "PREFERRED", approved_status: "Temporarily Blocked" }), "TEMPORARILY_BLOCKED");
  assert.equal(vendorLevel({ preference: "PREFERRED", blacklisted: true }), "BLACKLISTED");
  assert.equal(vendorLevel({ approved_status: "Blocked" }), "BLACKLISTED");
  assert.deepEqual(VENDOR_LEVELS.map((x) => x.code), ["HIGHLY_PREFERRED", "PREFERRED", "REGULAR", "TEMPORARILY_BLOCKED", "BLACKLISTED"]);
});

test("blocked, blacklisted and inactive vendors cannot be selected", () => {
  assert.equal(vendorSelectable({ approved_status: "Approved" }), true);
  assert.equal(vendorSelectable({ approved_status: "Temporarily Blocked" }), false);
  assert.equal(vendorSelectable({ blacklisted: true }), false);
  assert.equal(vendorSelectable({ is_active: false }), false);
  assert.equal(vendorSelectable(null), false);
});

test("WhatsApp links only from a real number", () => {
  assert.equal(whatsappHref("98765 43210"), "https://wa.me/919876543210");
  assert.equal(whatsappHref("+91-98765-43210"), "https://wa.me/919876543210");
  assert.equal(whatsappHref("12345"), null);
  assert.equal(whatsappHref(""), null);
});

test("vendor selection pending filter matches printed orders without a vendor", () => {
  const f = TASK_FILTERS.find((x) => x.key === "select");
  assert.ok(f);
  assert.equal(f.test({ proc_status: "DOCUMENT_GENERATED" }), true);
  assert.equal(f.test({ proc_status: "ORDER_PLACED" }), false);
  assert.deepEqual(Object.keys(TIER_LABELS), ["1", "2", "3"]);
});
