import { test } from "node:test";
import assert from "node:assert/strict";
import { humanDelay } from "../services/human-behavior.ts";

test("humanDelay stays within bounds", () => {
  assert.equal(humanDelay(100, 200, () => 0), 100);
  assert.equal(humanDelay(100, 200, () => 1), 200);
  assert.equal(humanDelay(100, 200, () => 0.5), 150);
});

test("humanDelay returns min when max is not greater than min", () => {
  assert.equal(humanDelay(250, 250, () => 1), 250);
  assert.equal(humanDelay(250, 100, () => 1), 250);
});
