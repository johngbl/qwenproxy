import test from "node:test";
import assert from "node:assert/strict";
import {
  computePersonalizationDeadlineMs,
  PERSONALIZATION_SYNC_DEADLINE_MS,
  COLD_ACCOUNT_PERSONALIZATION_SYNC_DEADLINE_MS,
} from "../routes/chat/account.ts";
import {
  registerPlaywrightAccountForTests,
  unregisterPlaywrightAccountForTests,
} from "../services/playwright.ts";

test("Personalization Deadline: cold or undefined account gets at least 120s for Playwright initialization", () => {
  // For undefined or non-initialized account, it should give at least COLD_ACCOUNT_PERSONALIZATION_SYNC_DEADLINE_MS (120s)
  const deadlineCold = computePersonalizationDeadlineMs("non-existent-account-id", 60_000);
  assert.equal(deadlineCold, COLD_ACCOUNT_PERSONALIZATION_SYNC_DEADLINE_MS);
  assert.ok(deadlineCold >= 120_000);

  const deadlineUndefined = computePersonalizationDeadlineMs(undefined, 60_000);
  assert.equal(deadlineUndefined, COLD_ACCOUNT_PERSONALIZATION_SYNC_DEADLINE_MS);

  // If navigation timeout is larger (e.g. 150s), it honors the larger timeout
  const deadlineLargeNav = computePersonalizationDeadlineMs("cold-acc", 150_000);
  assert.equal(deadlineLargeNav, 150_000);
});

test("Personalization Deadline: returns standard 90s when account is warm and recently active", () => {
  const warmAccountId = "test-warm-acc-" + Date.now();
  try {
    registerPlaywrightAccountForTests(warmAccountId, {} as any, Date.now());
    const deadlineWarm = computePersonalizationDeadlineMs(warmAccountId, 60_000);
    assert.equal(deadlineWarm, PERSONALIZATION_SYNC_DEADLINE_MS);
    assert.equal(deadlineWarm, 90_000);
  } finally {
    unregisterPlaywrightAccountForTests(warmAccountId);
  }
});

test("Personalization Deadline: returns 120s when initialized account has been dormant (> 5min)", () => {
  const dormantAccountId = "test-dormant-acc-" + Date.now();
  try {
    // Registered 10 minutes ago
    registerPlaywrightAccountForTests(dormantAccountId, {} as any, Date.now() - 10 * 60 * 1000);
    const deadlineDormant = computePersonalizationDeadlineMs(dormantAccountId, 60_000);
    assert.equal(deadlineDormant, COLD_ACCOUNT_PERSONALIZATION_SYNC_DEADLINE_MS);
    assert.equal(deadlineDormant, 120_000);
  } finally {
    unregisterPlaywrightAccountForTests(dormantAccountId);
  }
});
