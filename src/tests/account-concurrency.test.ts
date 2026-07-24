/**
 * Copyright (c) 2025 johngbl
 * QwenBridge - OpenAI-compatible proxy for Qwen
 */

import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  acquireAccountLease,
  tryAcquireAccountLease,
  isAccountBusy,
  isAccountTemporarilyBusy,
  markAccountTemporarilyBusy,
  clearTemporaryBusy,
  getAccountConcurrencySnapshot,
  resetAccountConcurrencyForTests,
} from "../core/account-concurrency.ts";

// config.concurrency.maxStreamsPerAccount defaults to 1 in test mode

test("AccountConcurrency: first lease is acquired immediately", async () => {
  resetAccountConcurrencyForTests();
  const lease = await acquireAccountLease("acc-1");
  assert.strictEqual(lease.accountId, "acc-1");
  lease.release();
});

test("AccountConcurrency: second lease waits until first is released", async () => {
  resetAccountConcurrencyForTests();
  const lease1 = await acquireAccountLease("acc-1");
  assert.strictEqual(isAccountBusy("acc-1"), true);

  let resolved = false;
  const lease2Promise = acquireAccountLease("acc-1", { timeoutMs: 5000 }).then(
    (lease) => {
      resolved = true;
      return lease;
    },
  );

  // Give the event loop a tick — should still be waiting
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(resolved, false);

  lease1.release();
  const lease2 = await lease2Promise;
  assert.strictEqual(resolved, true);
  assert.strictEqual(lease2.accountId, "acc-1");
  lease2.release();
});

test("AccountConcurrency: FIFO ordering for waiters", async () => {
  resetAccountConcurrencyForTests();
  const order: number[] = [];

  const lease1 = await acquireAccountLease("acc-fifo");

  const p1 = acquireAccountLease("acc-fifo", { timeoutMs: 5000 }).then((l) => {
    order.push(1);
    return l;
  });
  const p2 = acquireAccountLease("acc-fifo", { timeoutMs: 5000 }).then((l) => {
    order.push(2);
    return l;
  });

  await new Promise((r) => setTimeout(r, 10));
  lease1.release();

  const l1 = await p1;
  l1.release();

  const l2 = await p2;
  l2.release();

  assert.deepStrictEqual(order, [1, 2]);
});

test("AccountConcurrency: timeout removes waiter and rejects", async () => {
  resetAccountConcurrencyForTests();
  const lease1 = await acquireAccountLease("acc-timeout");

  await assert.rejects(
    () => acquireAccountLease("acc-timeout", { timeoutMs: 50 }),
    /timed out after 50ms/,
  );

  // Original lease still valid
  assert.strictEqual(isAccountBusy("acc-timeout"), true);
  lease1.release();
  assert.strictEqual(isAccountBusy("acc-timeout"), false);
});

test("AccountConcurrency: abort signal removes waiter and rejects", async () => {
  resetAccountConcurrencyForTests();
  const lease1 = await acquireAccountLease("acc-abort");
  const controller = new AbortController();

  const promise = acquireAccountLease("acc-abort", {
    timeoutMs: 10000,
    signal: controller.signal,
  });

  await new Promise((r) => setTimeout(r, 10));
  controller.abort();

  await assert.rejects(() => promise, /Aborted while waiting/);

  lease1.release();
});

test("AccountConcurrency: already-aborted signal rejects immediately", async () => {
  resetAccountConcurrencyForTests();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => acquireAccountLease("acc-pre-abort", { signal: controller.signal }),
    /Aborted before acquiring/,
  );
});

test("AccountConcurrency: duplicate release is safe", async () => {
  resetAccountConcurrencyForTests();
  const lease = await acquireAccountLease("acc-dup");
  lease.release();
  lease.release(); // should not throw or double-release
  assert.strictEqual(isAccountBusy("acc-dup"), false);
});

test("AccountConcurrency: different accounts do not block each other", async () => {
  resetAccountConcurrencyForTests();
  const leaseA = await acquireAccountLease("acc-a");
  const leaseB = await acquireAccountLease("acc-b");

  assert.strictEqual(isAccountBusy("acc-a"), true);
  assert.strictEqual(isAccountBusy("acc-b"), true);

  leaseA.release();
  assert.strictEqual(isAccountBusy("acc-a"), false);
  assert.strictEqual(isAccountBusy("acc-b"), true);

  leaseB.release();
});

test("AccountConcurrency: tryAcquire returns null when busy", async () => {
  resetAccountConcurrencyForTests();
  const lease = await acquireAccountLease("acc-try");
  const second = tryAcquireAccountLease("acc-try");
  assert.strictEqual(second, null);
  lease.release();

  const third = tryAcquireAccountLease("acc-try");
  assert.ok(third);
  third!.release();
});

test("AccountConcurrency: snapshot reports active and waiting counts", async () => {
  resetAccountConcurrencyForTests();
  const lease = await acquireAccountLease("acc-snap");

  // Start a waiter
  const waiterPromise = acquireAccountLease("acc-snap", { timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 10));

  const snapshot = getAccountConcurrencySnapshot();
  const entry = snapshot.find((s) => s.accountId === "acc-snap");
  assert.ok(entry);
  assert.strictEqual(entry!.active, 1);
  assert.strictEqual(entry!.waiting, 1);
  assert.strictEqual(entry!.limit, 1);

  lease.release();
  const lease2 = await waiterPromise;
  lease2.release();
});

test("AccountConcurrency: temporary busy flag expires", async () => {
  resetAccountConcurrencyForTests();
  assert.strictEqual(isAccountTemporarilyBusy("acc-temp"), false);

  markAccountTemporarilyBusy("acc-temp", 50);
  assert.strictEqual(isAccountTemporarilyBusy("acc-temp"), true);

  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(isAccountTemporarilyBusy("acc-temp"), false);
});

test("AccountConcurrency: clearTemporaryBusy removes flag immediately", () => {
  resetAccountConcurrencyForTests();
  markAccountTemporarilyBusy("acc-clear", 60000);
  assert.strictEqual(isAccountTemporarilyBusy("acc-clear"), true);
  clearTemporaryBusy("acc-clear");
  assert.strictEqual(isAccountTemporarilyBusy("acc-clear"), false);
});

test("AccountConcurrency: no pending handles after reset", async () => {
  resetAccountConcurrencyForTests();
  const lease = await acquireAccountLease("acc-handles");
  const waiter = acquireAccountLease("acc-handles", { timeoutMs: 100000 }).catch(
    () => {},
  );
  await new Promise((r) => setTimeout(r, 10));

  resetAccountConcurrencyForTests();
  lease.release(); // safe even after reset
  await waiter;
});
