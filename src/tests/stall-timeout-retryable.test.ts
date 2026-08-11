import test from "node:test";
import assert from "node:assert";
import { isRetryableFetchErrorMessage, QwenNetworkError } from "../services/qwen.ts";
import { isNetworkLikeError, classifyRetryAction } from "../routes/chat/retry-policy.ts";
import { classifyError } from "../api/error-classifier.ts";
import { UpstreamError, InternalError } from "../core/errors.ts";

// Reproduces the "request hangs forever" symptom from the 2026-08-09 server
// log: the completion fetch never received response headers (upstream/WAF
// swallowed the POST) and the stall was classified as a terminal 500, forcing
// the client to retry in a loop. Both the header-wait timeout and the
// stream idle-abort must be RETRYABLE so the bridge auto-rotates accounts.
test("stall: header-wait timeout is classified retryable (rotates account)", () => {
  assert.strictEqual(
    isRetryableFetchErrorMessage(
      "Qwen browser stream timed out waiting for response headers after 60000ms",
    ),
    true,
    "no-first-byte stall must be retryable, not a terminal error",
  );
});

test("stall: stream idle-abort is classified retryable (etimedout marker)", () => {
  assert.strictEqual(
    isRetryableFetchErrorMessage(
      "Qwen stream abc etimedout (idle timeout after 600000ms without upstream data)",
    ),
    true,
  );
});

test("stall: non-stall errors are NOT over-matched", () => {
  assert.strictEqual(
    isRetryableFetchErrorMessage("model not found: qwen3.7-plus"),
    false,
  );
  assert.strictEqual(
    isRetryableFetchErrorMessage("chat is not exist"),
    false,
  );
  assert.strictEqual(
    isRetryableFetchErrorMessage("WAF challenge"),
    false,
  );
});

test("stall: retry-policy treats the idle-abort as a network-like error", () => {
  assert.strictEqual(
    isNetworkLikeError(
      new Error(
        "Qwen stream abc etimedout (idle timeout after 600000ms without upstream data)",
      ),
    ),
    true,
  );
});

test("stall: QwenNetworkError header timeout is retryable with account switch", () => {
  const policy = classifyRetryAction(
    new QwenNetworkError(
      "Qwen browser stream timed out waiting for response headers after 60000ms",
    ),
  );
  assert.strictEqual(policy.retryable, true);
  assert.strictEqual(policy.switchAccount, true);
});

test("stall: header timeout surfaces as retryable UpstreamError, not 500 InternalError", () => {
  const classified = classifyError(
    new QwenNetworkError(
      "Qwen browser stream timed out waiting for response headers after 60000ms",
    ),
  );
  assert.ok(classified instanceof UpstreamError, "must not be InternalError (500)");
  assert.ok(!(classified instanceof InternalError));
});
