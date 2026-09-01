import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../core/config.ts";
import {
  acquireAccountLease,
  resetAccountConcurrencyForTests,
} from "../core/account-concurrency.ts";
import {
  closeIdlePlaywrightAccounts,
  closePlaywrightForAccount,
  getIdlePlaywrightAccountIds,
  isPlaywrightInitialized,
  registerPlaywrightAccountForTests,
} from "../services/playwright.ts";
import {
  isSessionKeeperRunning,
  runSessionKeeperOnceForTesting,
  startSessionKeeper,
  stopSessionKeeper,
} from "../services/session-keeper.ts";

const IDLE_MS = 60_000;
const STALE_ACTIVITY_AT = Date.now() - 10 * 60_000;

/** The idle sweep only needs the page to exist in the account map. */
function stubPage(): any {
  return { isClosed: () => false, url: () => "https://chat.qwen.ai/" };
}

test("session keeper starts and stops safely", () => {
  stopSessionKeeper();
  assert.equal(isSessionKeeperRunning(), false);

  startSessionKeeper();
  assert.equal(
    isSessionKeeperRunning(),
    config.sessionKeeper.enabled || config.playwright.idleContextTtlMs > 0,
  );

  stopSessionKeeper();
  assert.equal(isSessionKeeperRunning(), false);
});

test("session keeper one-shot cycle is safe without initialized accounts", async () => {
  stopSessionKeeper();
  await runSessionKeeperOnceForTesting();
  assert.equal(isSessionKeeperRunning(), false);
});

test("idle sweep preserves the only warm context when max active contexts is 1", async () => {
  resetAccountConcurrencyForTests();
  const originalMax = config.playwright.maxActiveContexts;
  config.playwright.maxActiveContexts = 1;
  const accountId = "idle-preserve";
  registerPlaywrightAccountForTests(accountId, stubPage(), STALE_ACTIVITY_AT);

  try {
    assert.deepEqual(getIdlePlaywrightAccountIds(IDLE_MS), [accountId]);
    assert.equal(await closeIdlePlaywrightAccounts(IDLE_MS), 0);
    assert.equal(isPlaywrightInitialized(accountId), true);
  } finally {
    config.playwright.maxActiveContexts = originalMax;
    await closePlaywrightForAccount(accountId);
  }
});

test("idle sweep closes an idle context when no warm context must be preserved", async () => {
  resetAccountConcurrencyForTests();
  const originalMax = config.playwright.maxActiveContexts;
  config.playwright.maxActiveContexts = 0;
  const accountId = "idle-no-lease";
  registerPlaywrightAccountForTests(accountId, stubPage(), STALE_ACTIVITY_AT);

  try {
    assert.deepEqual(getIdlePlaywrightAccountIds(IDLE_MS), [accountId]);
    assert.equal(await closeIdlePlaywrightAccounts(IDLE_MS), 1);
    assert.equal(isPlaywrightInitialized(accountId), false);
  } finally {
    config.playwright.maxActiveContexts = originalMax;
  }
});

test("idle sweep never closes a context that holds a stream lease", async () => {
  resetAccountConcurrencyForTests();
  const originalMax = config.playwright.maxActiveContexts;
  config.playwright.maxActiveContexts = 0;
  const accountId = "idle-with-lease";

  try {
    // A browser generation performs no page operation, so its last activity is
    // as old as the request itself — the exact shape of a >TTL generation.
    registerPlaywrightAccountForTests(accountId, stubPage(), STALE_ACTIVITY_AT);
    const lease = await acquireAccountLease(accountId);

    try {
      assert.deepEqual(getIdlePlaywrightAccountIds(IDLE_MS), []);
      assert.equal(await closeIdlePlaywrightAccounts(IDLE_MS), 0);
      assert.equal(isPlaywrightInitialized(accountId), true);
    } finally {
      lease.release();
    }

    // The sweep refreshed the idle clock while the stream was alive, so the
    // context is not collectable the moment the lease is released either.
    assert.equal(await closeIdlePlaywrightAccounts(IDLE_MS), 0);
    assert.equal(isPlaywrightInitialized(accountId), true);
  } finally {
    config.playwright.maxActiveContexts = originalMax;
    await closePlaywrightForAccount(accountId).catch(() => {});
  }
});

// ── shutdown race: closeAllPlaywright closes contexts while a keep-alive
// cycle is in flight; the resulting "already closed" rejection is benign and
// must NOT leak a warning (the user saw it on Ctrl+C).
function closedGotoPage(message: string): any {
  return {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    goto: async () => {
      throw new Error(message);
    },
  };
}

function captureWarns(): { warns: string[]; restore: () => void } {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(" "));
  };
  return { warns, restore: () => { console.warn = original; } };
}

test("keep-alive suppresses the benign already-closed error on shutdown", async () => {
  resetAccountConcurrencyForTests();
  stopSessionKeeper();
  const accountId = "keeper-closed-race";
  registerPlaywrightAccountForTests(
    accountId,
    closedGotoPage(
      "page.goto: Target page, context or browser has been closed\nCall log:\nnavigating to https://chat.qwen.ai/",
    ),
    STALE_ACTIVITY_AT,
  );
  const captured = captureWarns();
  try {
    await runSessionKeeperOnceForTesting();
    assert.equal(
      captured.warns.filter((w) => w.includes("Keep-alive failed")).length,
      0,
      `already-closed must be silent, got: ${captured.warns.join(" | ")}`,
    );
  } finally {
    captured.restore();
    await closePlaywrightForAccount(accountId).catch(() => {});
  }
});

test("keep-alive still warns for real errors (no over-suppression)", async () => {
  resetAccountConcurrencyForTests();
  stopSessionKeeper();
  const accountId = "keeper-real-error";
  registerPlaywrightAccountForTests(
    accountId,
    closedGotoPage("page.goto: net::ERR_CONNECTION_RESET"),
    STALE_ACTIVITY_AT,
  );
  const captured = captureWarns();
  try {
    await runSessionKeeperOnceForTesting();
    assert.ok(
      captured.warns.some((w) => w.includes("Keep-alive failed")),
      "a non-closed error must still be reported",
    );
  } finally {
    captured.restore();
    await closePlaywrightForAccount(accountId).catch(() => {});
  }
});
