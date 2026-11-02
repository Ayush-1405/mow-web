import test from "node:test";
import assert from "node:assert/strict";
import { reuseMap, reuseRows, reuseValue } from "../src/lib/stableData.js";

test("reuseRows returns the previous array when nothing changed", () => {
  const prev = [{ id: 1, a: "x" }, { id: 2, a: "y" }];
  assert.equal(reuseRows(prev, [{ id: 1, a: "x" }, { id: 2, a: "y" }]), prev);
});

test("reuseRows keeps unchanged rows and takes the new value of a changed row", () => {
  const prev = [{ id: 1, a: "x" }, { id: 2, a: "y" }];
  const out = reuseRows(prev, [{ id: 1, a: "x" }, { id: 2, a: "CHANGED" }]);
  assert.notEqual(out, prev);
  assert.equal(out[0], prev[0]);
  assert.deepEqual(out[1], { id: 2, a: "CHANGED" });
});

test("reuseRows reflects added, removed and reordered rows", () => {
  const prev = [{ id: 1 }, { id: 2 }];
  assert.deepEqual(reuseRows(prev, [{ id: 1 }, { id: 2 }, { id: 3 }]), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(reuseRows(prev, [{ id: 2 }]), [{ id: 2 }]);
  const swapped = reuseRows(prev, [{ id: 2 }, { id: 1 }]);
  assert.notEqual(swapped, prev);
  assert.equal(swapped[0], prev[1]);
  assert.deepEqual(reuseRows(prev, []), []);
});

test("reuseMap returns the previous map when nothing changed", () => {
  const prev = { a: [{ id: 1 }], b: 2 };
  assert.equal(reuseMap(prev, { a: [{ id: 1 }], b: 2 }), prev);
});

test("reuseMap keeps unchanged values and reflects changed, added and removed keys", () => {
  const prev = { a: [{ id: 1 }], b: [{ id: 2 }] };
  const changed = reuseMap(prev, { a: [{ id: 1 }], b: [{ id: 9 }] });
  assert.equal(changed.a, prev.a);
  assert.deepEqual(changed.b, [{ id: 9 }]);
  assert.deepEqual(reuseMap(prev, { a: [{ id: 1 }] }), { a: [{ id: 1 }] });
  assert.deepEqual(reuseMap(prev, { ...prev, c: 1 }), { ...prev, c: 1 });
  assert.deepEqual(reuseMap({ a: 1, b: 2 }, { a: 1, c: undefined }), { a: 1, c: undefined });
});

test("reuseValue only reuses equal data", () => {
  const prev = { a: 1 };
  assert.equal(reuseValue(prev, { a: 1 }), prev);
  assert.deepEqual(reuseValue(prev, { a: 2 }), { a: 2 });
});
