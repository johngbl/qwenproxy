import test from "node:test";
import assert from "node:assert";

import { orderContextsForEviction } from "../services/playwright.ts";

test("context eviction order: unranked first, then lowest priority, then oldest activity", () => {
  const rank = new Map<string, number>([
    ["p1", 0], // highest priority
    ["p2", 1],
    ["p3", 2], // lowest priority
  ]);
  const activity = new Map<string, number>([
    ["p1", 300],
    ["p2", 200],
    ["p3", 100],
    ["unranked", 50],
  ]);

  const order = orderContextsForEviction(
    ["p1", "p2", "p3", "unranked"],
    (id) => rank.get(id),
    (id) => activity.get(id) ?? 0,
  );

  // Unranked (unknown) accounts are evicted before ranked ones; among ranked,
  // the lowest priority goes first; ties break by oldest activity.
  assert.deepStrictEqual(order, ["unranked", "p3", "p2", "p1"]);
});

test("context eviction order: no rank data falls back to activity order", () => {
  const activity = new Map<string, number>([
    ["old", 100],
    ["recent", 500],
  ]);
  const order = orderContextsForEviction(
    ["recent", "old"],
    () => undefined,
    (id) => activity.get(id) ?? 0,
  );
  assert.deepStrictEqual(order, ["old", "recent"]);
});

test("context eviction order: same priority keeps the recently used context", () => {
  const rank = new Map<string, number>([["a", 1], ["b", 1]]);
  const activity = new Map<string, number>([
    ["a", 100],
    ["b", 400],
  ]);
  const order = orderContextsForEviction(
    ["a", "b"],
    (id) => rank.get(id),
    (id) => activity.get(id) ?? 0,
  );
  // b was used most recently -> survives, a is evicted first.
  assert.deepStrictEqual(order, ["a", "b"]);
});
