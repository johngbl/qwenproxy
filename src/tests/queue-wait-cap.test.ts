import test from "node:test";
import assert from "node:assert/strict";

delete process.env.TEST_MOCK_QWEN_AUTH;

const { config } = await import("../core/config.ts");
const { classifyRetryAction } = await import("../routes/chat/retry-policy.ts");

test("queue wait for the thread owner is capped, not unbounded", () => {
  // waitQueueForever (thread owner / last usable account) previously passed
  // timeoutMs: null — a stuck lease holder made the queued request wait up to
  // ~600s (observed 597s stall in user logs). The cap bounds that wait.
  assert.equal(
    config.concurrency.queueWaitForeverCapMs,
    120_000,
    "default cap should be 2 minutes",
  );
  assert.ok(Number.isFinite(config.concurrency.queueWaitForeverCapMs));
  assert.ok(config.concurrency.queueWaitForeverCapMs > 0);
});

test("cap timeout classifies as account_busy and switches account", () => {
  // When the cap fires, the request must be retried on another account (never
  // a terminal failure): the downstream retry policy already handles it.
  const action = classifyRetryAction(
    new Error(
      `Account abc busy: timed out after ${config.concurrency.queueWaitForeverCapMs}ms waiting for a free slot`,
    ),
  );
  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, true);
  assert.equal(action.forceNewChat, false);
  assert.equal(action.reason, "account_busy");
});
