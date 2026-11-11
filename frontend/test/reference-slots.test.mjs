import test from "node:test";
import assert from "node:assert/strict";
import { swapReferenceSlots } from "../src/components/canvas/utils/references.ts";

test("swapping reference slots preserves count and membership", () => {
  const original = ["image-a", "image-b", "image-c"];
  const swapped = swapReferenceSlots(original, "image-c", "image-b");

  assert.deepEqual(swapped, ["image-a", "image-c", "image-b"]);
  assert.equal(swapped.length, original.length);
  assert.deepEqual([...swapped].sort(), [...original].sort());
  assert.deepEqual(original, ["image-a", "image-b", "image-c"]);
});

test("invalid or same-slot drops are no-ops", () => {
  const original = ["image-a", "image-b", "image-c"];
  assert.equal(swapReferenceSlots(original, "image-b", "image-b"), original);
  assert.equal(swapReferenceSlots(original, "missing", "image-b"), original);
  assert.equal(swapReferenceSlots(original, "image-b", "missing"), original);
});
