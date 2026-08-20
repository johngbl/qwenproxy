import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import {
  acquireAccountLease,
  tryAcquireAccountLease,
  isAccountBusy,
  resetAccountConcurrencyForTests,
} from "../core/account-concurrency.ts";
import { resolveInitialAccount } from "../routes/chat/account.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";
import { getDatabase } from "../core/database.ts";
import { clearAccountCooldown } from "../core/account-manager.ts";

// Repro of the 2026-08-20 02:43:41 incident (req=0869d768): a parallel-escape
// request tried the STICKY account first (ldyjl) which was busy with the main
// non-stream (1670064a), failed account_busy fail-fast, then rotated to a
// SECOND account (cgnx3) that was ALSO busy — stalling ~18s until the client
// aborted (499).

function withTempAccounts(
  accounts: Array<{ id: string; email: string; password: string }>,
  fn: () => void | Promise<void>,
) {
  return async () => {
    const originalEnv = process.env.QWEN_ACCOUNTS;
    delete process.env.QWEN_ACCOUNTS;
    const originalMock = process.env.TEST_MOCK_QWEN_AUTH;
    delete process.env.TEST_MOCK_QWEN_AUTH; // resolveInitialAccount short-circuits to mock otherwise

    const db = getDatabase();
    const existing = db
      .prepare("SELECT id, email, password FROM accounts")
      .all() as Array<{ id: string; email: string; password: string }>;
    db.prepare("DELETE FROM accounts").run();
    invalidateAccountsCache();

    const insert = db.prepare(
      "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
    );
    for (const acc of accounts) {
      insert.run(acc.id, acc.email, acc.password);
      clearAccountCooldown(acc.id);
    }
    invalidateAccountsCache();

    try {
      await fn();
    } finally {
      for (const acc of accounts) clearAccountCooldown(acc.id);
      db.prepare("DELETE FROM accounts").run();
      const restore = db.prepare(
        "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
      );
      for (const row of existing) restore.run(row.id, row.email, row.password);
      invalidateAccountsCache();
      if (originalEnv !== undefined) process.env.QWEN_ACCOUNTS = originalEnv;
      if (originalMock !== undefined) {
        process.env.TEST_MOCK_QWEN_AUTH = originalMock;
      } else {
        process.env.TEST_MOCK_QWEN_AUTH = "true";
      }
    }
  };
}

test("ParallelEscape fix: failover selection excludes the STICKY busy account", withTempAccounts(
  [
    { id: "ldyjl", email: "ldyjl@t", password: "p" },
    { id: "free-alt", email: "free@t", password: "p" },
  ],
  () => {
    resetAccountConcurrencyForTests();

    // Main non-stream holds the sticky account slot (maxStreamsPerAccount=1).
    const main = acquireAccountLease("ldyjl", { label: "sess-main" });

    // The parallel escape now converts to effectivePreferred=null and excludes
    // the sticky owner (account.ts), so resolveInitialAccount(null, [sticky])
    // must return the FREE account — never the sticky that the main uses.
    const resolved = resolveInitialAccount(null, ["ldyjl"]);
    assert.notStrictEqual(
      resolved.account.id,
      "ldyjl",
      "parallel escape must not select the sticky owner it is racing",
    );
    assert.strictEqual(
      resolved.account.id,
      "free-alt",
      "must select the free alternate account",
    );

    // And the parallel lease lands immediately on the free account.
    const escaped = tryAcquireAccountLease("free-alt", "sess-parallel", undefined, true);
    assert.ok(escaped, "free alternate grants the parallel lease immediately");
    escaped!.release();

    main.then((l) => l.release());
  },
));

test("ParallelEscape repro: free alternate succeeds immediately (fix target)", async () => {
  resetAccountConcurrencyForTests();
  const stickyId = "sticky-busy";
  const freeId = "free-alt";

  const main = await acquireAccountLease(stickyId, { label: "sess-main" });
  assert.strictEqual(isAccountBusy(stickyId), true);
  assert.strictEqual(isAccountBusy(freeId), false);

  const escaped = tryAcquireAccountLease(freeId, "sess-parallel", undefined, true);
  assert.ok(escaped, "a free alternate account must grant the parallel lease immediately");
  escaped!.release();
  main.release();
});

test("ParallelEscape repro (control): all busy -> parallel escape fails account_busy", async () => {
  resetAccountConcurrencyForTests();
  const stickyId = "sticky-busy";
  const busyAlt = "busy-alt";

  const main = await acquireAccountLease(stickyId, { label: "sess-main" });
  const other = await acquireAccountLease(busyAlt, { label: "sess-other" });

  assert.strictEqual(tryAcquireAccountLease(stickyId, "sess-parallel", undefined, true), null);
  assert.strictEqual(tryAcquireAccountLease(busyAlt, "sess-parallel", undefined, true), null);

  other.release();
  main.release();
});
