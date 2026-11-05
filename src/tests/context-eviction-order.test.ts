import test from "node:test";
import assert from "node:assert";

import {
  orderContextsForEviction,
  evictIdlePlaywrightContextsToLimit,
  registerPlaywrightAccountForTests,
  unregisterPlaywrightAccountForTests,
  isPlaywrightInitialized,
} from "../services/playwright.ts";
import { config } from "../core/config.ts";
import { markAccountRateLimited, clearAccountCooldown } from "../core/account-manager.ts";

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

test("evictIdlePlaywrightContextsToLimit evicts recently active contexts during rapid rotation and prioritizes cooldown accounts", async () => {
  const prevMax = config.playwright.maxActiveContexts;
  config.playwright.maxActiveContexts = 2;
  const now = Date.now();
  const stubPage = () => ({ isClosed: () => false, url: () => "https://chat.qwen.ai/" } as any);

  registerPlaywrightAccountForTests("rapid-1", stubPage(), now - 2000);
  registerPlaywrightAccountForTests("rapid-2", stubPage(), now - 1000);
  registerPlaywrightAccountForTests("rapid-3", stubPage(), now - 500);
  // Put rapid-3 on cooldown even though it was the most recently active
  markAccountRateLimited("rapid-3", 60_000, "RateLimited", { silent: true });

  try {
    const evicted = await evictIdlePlaywrightContextsToLimit();
    assert.strictEqual(evicted, 1, "must evict 1 context to stay within maxActiveContexts=2 even when all were active <30s ago");
    assert.strictEqual(isPlaywrightInitialized("rapid-3"), false, "cooldown account must be evicted first");
    assert.strictEqual(isPlaywrightInitialized("rapid-1"), true);
    assert.strictEqual(isPlaywrightInitialized("rapid-2"), true);
  } finally {
    config.playwright.maxActiveContexts = prevMax;
    clearAccountCooldown("rapid-3");
    unregisterPlaywrightAccountForTests("rapid-1");
    unregisterPlaywrightAccountForTests("rapid-2");
    unregisterPlaywrightAccountForTests("rapid-3");
  }
});
