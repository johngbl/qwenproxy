import test from "node:test";
import assert from "node:assert";

// Env BEFORE module load so error-classifier/qwen use mock/stable config.
process.env.TEST_MOCK_QWEN_AUTH = "true";

import { classifyError } from "../api/error-classifier.ts";
import {
  ClientAbortedError,
  UpstreamRateLimit,
  InternalError,
  ServiceUnavailable,
} from "../core/errors.ts";
import { computeDynamicIdleTimeout } from "../services/qwen.ts";
import { config } from "../core/config.ts";

/**
 * Uses the LIVE-logs audit (2026-08-21):
 *  - client aborts were logged as ❌ unknown (should be silent);
 *  - "All configured accounts are on cooldown" surfaced as a 500 InternalError
 *    even though acquireUpstreamStream set upstreamStatus=429 (classifyError
 *    ignored the hint);
 *  - a parallel-escape stream of a THINKING model was killed by the 15s idle
 *    cap after a legitimate >15s reasoning gap (etimedout 15000ms on a
 *    564KB full-replay in the log).
 */

// --- Bug A: a client abort must classify as ClientAbortedError (silent 499),
// never as a retryable/upstream failure.
test("A: 'client aborted' message classifies as ClientAbortedError (silent)", () => {
  const err = new Error("client aborted before stream creation");
  const classified = classifyError(err);
  assert.ok(
    classified instanceof ClientAbortedError,
    `expected ClientAbortedError, got ${classified.constructor.name} (${classified.statusCode})`,
  );
});

test("A: typed ClientAbortedError stays ClientAbortedError", () => {
  const classified = classifyError(new ClientAbortedError("client aborted"));
  assert.ok(classified instanceof ClientAbortedError);
});

// --- Bug B: an error carrying upstreamStatus=429 must classify as
// UpstreamRateLimit (429), not fall through to InternalError (500).
test("B: error with upstreamStatus=429 classifies as UpstreamRateLimit, not 500", () => {
  const cooldownError: any = new Error(
    "All configured accounts are on cooldown. Retry in about 9800s.",
  );
  cooldownError.upstreamStatus = 429;
  const classified = classifyError(cooldownError);
  assert.ok(
    classified instanceof UpstreamRateLimit,
    `expected UpstreamRateLimit, got ${classified.constructor.name} (${classified.statusCode})`,
  );
  assert.strictEqual(classified.statusCode, 429);
  assert.ok(
    !(classified instanceof InternalError),
    "must NOT be InternalError (500)",
  );
});

test("B: typed UpstreamRateLimit stays 429", () => {
  const classified = classifyError(
    new UpstreamRateLimit("All accounts on cooldown"),
  );
  assert.ok(classified instanceof UpstreamRateLimit);
  assert.strictEqual(classified.statusCode, 429);
});

// --- Bug C: the parallel-escape idle cap must not kill THINKING streams.
// Thinking models legitimately pause >15s between reasoning chunks; only
// non-thinking auxiliary streams get the tight cap.
test("C: thinking + parallel-escape does NOT get the 15s idle cap (uses reasoning base)", () => {
  const ms = computeDynamicIdleTimeout({
    enableThinking: true,
    parallelEscape: true,
    baseTimeoutMs: 180_000,
    payloadSize: 564_179, // the full-replay from the log
  });
  // 180s base + 30s/MB (0.54MB → ceil(30s*0.54)=17s) = ~197s. NEVER 15s.
  assert.ok(
    ms >= 180_000,
    `thinking parallel-escape must keep the reasoning idle window, got ${ms}ms`,
  );
});

test("C: non-thinking parallel-escape still gets the tight 15s cap", () => {
  const ms = computeDynamicIdleTimeout({
    enableThinking: false,
    parallelEscape: true,
    baseTimeoutMs: 60_000,
    payloadSize: 500,
  });
  assert.ok(ms <= 15_000, `auxiliary non-thinking idle must stay short, got ${ms}ms`);
});

test("C: normal (non-escape) streams keep the dynamic per-MB idle", () => {
  const ms = computeDynamicIdleTimeout({
    enableThinking: true,
    parallelEscape: false,
    baseTimeoutMs: 180_000,
    payloadSize: 1_048_576, // 1MB
  });
  // 180s + 30s = 210000ms
  assert.strictEqual(ms, 210_000);
});

// --- Bug D: a Mutex acquire timeout (chat lock held by a long legitimate
// generation) classified as InternalError 500 in production — every concurrent
// request on the same chat died with internal_server_error. A busy resource is
// retryable: map to 503 ServiceUnavailable so clients wait and re-request
// instead of treating it as a server fault.
test("D: chat-lock acquire timeout classifies as ServiceUnavailable (503), not 500", () => {
  const err = new Error(
    "Mutex[chat:4047f7c0] acquire timeout after 60000ms (held by chat:4047f7c0-311 for 62813ms)",
  );
  const classified = classifyError(err);
  assert.ok(
    classified instanceof ServiceUnavailable,
    `expected ServiceUnavailable, got ${classified.constructor.name} (${classified.statusCode})`,
  );
  assert.strictEqual(classified.statusCode, 503);
  assert.ok(
    !(classified instanceof InternalError),
    "must NOT be InternalError (500)",
  );
});

test("D: non-mutex errors still fall through to the normal mapping", () => {
  const classified = classifyError(new Error("some other failure"));
  assert.ok(
    classified instanceof InternalError,
    "unrelated errors must keep the existing InternalError fallback",
  );
});

// --- Config: the chat lock budget must cover the longest legitimate
// generation (reasoning + huge context), not the old fixed 60s cap that
// produced the false 500s / acquire_deadline cascades above.
test("D: chat-lock timeout default covers long generations (>= 2 min)", () => {
  assert.ok(
    config.concurrency.chatLockTimeoutMs >= 120_000,
    `chat-lock timeout must exceed the longest normal turn, got ${config.concurrency.chatLockTimeoutMs}ms`,
  );
  assert.ok(
    config.concurrency.chatLockTimeoutMs <= 300_000,
    "chat-lock timeout must stay bounded",
  );
});