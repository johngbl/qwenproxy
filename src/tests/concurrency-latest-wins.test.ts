import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";
// Short lease lifetime so stale-detection can be exercised without long waits.
process.env.ACCOUNT_LEASE_MAX_DURATION_MS = "60";

const {
  acquireAccountLease,
  tryAcquireAccountLease,
  isAccountBusy,
  abortLeaseByLabel,
  sweepAllStaleLeases,
  startLeaseSweepTimer,
  stopLeaseSweepTimer,
  getAccountConcurrencySnapshot,
  resetAccountConcurrencyForTests,
} = await import("../core/account-concurrency.ts");

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("LatestWins: abortLeaseByLabel aborts active lease and frees the slot", async () => {
  resetAccountConcurrencyForTests();
  const ac = new AbortController();
  const lease = await acquireAccountLease("acc-abort-label", {
    label: "sess-1",
    leaseAbortController: ac,
  });
  assert.strictEqual(isAccountBusy("acc-abort-label"), true);
  assert.strictEqual(ac.signal.aborted, false);

  const aborted = abortLeaseByLabel("acc-abort-label", "sess-1");
  assert.strictEqual(aborted, true);
  assert.strictEqual(ac.signal.aborted, true);
  assert.strictEqual(isAccountBusy("acc-abort-label"), false);

  // Releasing afterwards stays safe (idempotent, no double-free).
  lease.release();
});

test("LatestWins: abortLeaseByLabel returns false for unknown label", async () => {
  resetAccountConcurrencyForTests();
  const lease = await acquireAccountLease("acc-no-label", { label: "sess-x" });
  assert.strictEqual(abortLeaseByLabel("acc-no-label", "sess-does-not-exist"), false);
  assert.strictEqual(isAccountBusy("acc-no-label"), true);
  lease.release();
});

test("LatestWins: abortLeaseByLabel returns false for unknown account", () => {
  resetAccountConcurrencyForTests();
  assert.strictEqual(abortLeaseByLabel("acc-never-seen", "sess-any"), false);
});

test("LatestWins: a same-session retry immediately gets the freed slot", async () => {
  resetAccountConcurrencyForTests();
  const oldAc = new AbortController();
  const oldLease = await acquireAccountLease("acc-retry", {
    label: "sess-retry",
    leaseAbortController: oldAc,
  });
  assert.strictEqual(isAccountBusy("acc-retry"), true);

  // The retry aborts the old generation, then acquires without queueing.
  assert.strictEqual(abortLeaseByLabel("acc-retry", "sess-retry"), true);
  const newLease = await acquireAccountLease("acc-retry", {
    label: "sess-retry",
    timeoutMs: 100,
  });
  assert.strictEqual(newLease.accountId, "acc-retry");
  assert.strictEqual(oldAc.signal.aborted, true);

  newLease.release();
  oldLease.release();
});

test("LatestWins: lease granted from the queue preserves its session label", async () => {
  resetAccountConcurrencyForTests();
  const first = await acquireAccountLease("acc-queue-label", { label: "first" });

  const waiterAc = new AbortController();
  const waiter = acquireAccountLease("acc-queue-label", {
    label: "sess-queued",
    leaseAbortController: waiterAc,
    timeoutMs: 5000,
  });
  await tick(10);

  first.release();
  const granted = await waiter;

  const snap = getAccountConcurrencySnapshot().find(
    (s: any) => s.accountId === "acc-queue-label",
  );
  assert.ok(snap);
  assert.strictEqual(snap!.holders.length, 1);
  assert.strictEqual(snap!.holders[0].label, "sess-queued");

  // latest-wins must also work on a lease that came through the queue.
  assert.strictEqual(abortLeaseByLabel("acc-queue-label", "sess-queued"), true);
  assert.strictEqual(waiterAc.signal.aborted, true);
  assert.strictEqual(isAccountBusy("acc-queue-label"), false);
  granted.release();
});

test("LatestWins: snapshot holders expose label and heldMs", async () => {
  resetAccountConcurrencyForTests();
  const lease = await acquireAccountLease("acc-snap-holders", { label: "sess-hold" });
  await tick(15);

  const snap = getAccountConcurrencySnapshot().find(
    (s: any) => s.accountId === "acc-snap-holders",
  );
  assert.ok(snap);
  assert.strictEqual(snap!.holders[0].label, "sess-hold");
  assert.ok(snap!.holders[0].heldMs >= 10);

  lease.release();
});

test("StaleLease: sweep force-releases a lease held beyond the max duration", async () => {
  resetAccountConcurrencyForTests();
  const lease = await acquireAccountLease("acc-stale", { label: "stale" });
  assert.strictEqual(isAccountBusy("acc-stale"), true);

  // Wait past ACCOUNT_LEASE_MAX_DURATION_MS (60ms in this suite).
  await tick(80);
  const swept = sweepAllStaleLeases();
  assert.ok(swept >= 1, `expected at least one swept lease, got ${swept}`);
  assert.strictEqual(isAccountBusy("acc-stale"), false);

  lease.release(); // safe no-op after force-release
});

test("StaleLease: sweep delivers the freed slot to a waiting request", async () => {
  resetAccountConcurrencyForTests();
  const stale = await acquireAccountLease("acc-stale-waiter", { label: "stale" });

  let granted = false;
  const waiter = acquireAccountLease("acc-stale-waiter", {
    label: "next",
    timeoutMs: 5000,
  }).then((l) => {
    granted = true;
    return l;
  });

  await tick(80);
  assert.strictEqual(granted, false);
  sweepAllStaleLeases();

  const lease2 = await waiter;
  assert.strictEqual(granted, true);
  lease2.release();
  stale.release();
});

test("StaleLease: sweep returns 0 when nothing is stale", async () => {
  resetAccountConcurrencyForTests();
  const lease = await acquireAccountLease("acc-fresh", { label: "fresh" });
  const swept = sweepAllStaleLeases();
  assert.strictEqual(swept, 0);
  assert.strictEqual(isAccountBusy("acc-fresh"), true);
  lease.release();
});

test("StaleLease: tryAcquire triggers a sweep and recovers a stuck slot", async () => {
  resetAccountConcurrencyForTests();
  const stale = await acquireAccountLease("acc-try-stale", { label: "stale" });
  assert.strictEqual(tryAcquireAccountLease("acc-try-stale"), null);

  await tick(80);
  const recovered = tryAcquireAccountLease("acc-try-stale", "recovered");
  assert.ok(recovered);
  recovered!.release();
  stale.release();
});

test("SweepTimer: start is idempotent and stop is safe", () => {
  resetAccountConcurrencyForTests();
  startLeaseSweepTimer();
  startLeaseSweepTimer(); // must not throw or double-schedule
  stopLeaseSweepTimer();
  stopLeaseSweepTimer(); // safe double stop
});

test("LatestWins: leases without an explicit label get the default label", async () => {
  resetAccountConcurrencyForTests();
  const lease = await acquireAccountLease("acc-default-label");

  const snap = getAccountConcurrencySnapshot().find(
    (s: any) => s.accountId === "acc-default-label",
  );
  assert.ok(snap);
  assert.strictEqual(snap!.holders[0].label, "unlabeled");

  // A different label never matches; the default label does.
  assert.strictEqual(abortLeaseByLabel("acc-default-label", "something-else"), false);
  assert.strictEqual(isAccountBusy("acc-default-label"), true);
  assert.strictEqual(abortLeaseByLabel("acc-default-label", "unlabeled"), true);
  assert.strictEqual(isAccountBusy("acc-default-label"), false);

  lease.release();
});
