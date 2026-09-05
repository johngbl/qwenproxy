import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../core/config.ts";
import { ContextLengthExceededError } from "../core/errors.ts";
import {
  assertPromptWithinLimits,
  getPromptLimitStats,
  isRequestPersonalizationWithinLimit,
} from "../core/prompt-limits.ts";

test("config exposes only Playwright/thread-native current auth and context settings", () => {
  assert.equal(typeof config.playwright.headless, "boolean");
  assert.match(config.playwright.browser, /^(chromium|chrome|edge)$/);

  assert.equal("enabled" in config.playwright, false);
  assert.equal("rateLimit" in config, false);
  assert.equal("topicDetection" in config, false);

  assert.equal(typeof config.qwen.personalizationFromRequest, "boolean");
  assert.equal(config.contextMeter.enabled, true);
  assert.equal(config.contextMeter.windowTokens, 0);
  assert.equal(config.contextMeter.reportUsage, true);
  assert.equal(typeof config.playwright.initBatchSize, "number");
  assert.equal(typeof config.playwright.contextCloseTimeoutMs, "number");
  assert.equal(typeof config.playwright.idleContextTtlMs, "number");
  // Warm-context lifecycle: 1 warm context by default (browsers close quickly
  // after capture; concurrent streams keep their own context — the cap only
  // evicts idle ones) + 60s idle TTL for the overflow contexts.
  assert.equal(config.playwright.maxActiveContexts, 2);
  assert.equal(config.playwright.idleContextTtlMs, 60_000);
  assert.equal(typeof config.playwright.jsHeapMb, "number");
  assert.equal(typeof config.playwright.lowMemoryFlags, "boolean");
  assert.equal(typeof config.oss.multipartThresholdBytes, "number");
  assert.ok(config.playwright.jsHeapMb >= 64);
  assert.ok(config.oss.multipartThresholdBytes >= 1024 * 1024);

  assert.equal(typeof config.sessionKeeper.enabled, "boolean");
  assert.equal(typeof config.sessionKeeper.intervalMs, "number");
  assert.equal(typeof config.sessionKeeper.idleMs, "number");
  assert.equal(typeof config.sessionKeeper.navigationIntervalMs, "number");
  assert.ok(config.concurrency.initFailureCooldownMs >= 30_000);

  // Mid-stream silence window: 3 min with ZERO upstream bytes = dead stream.
  // Must not exceed the first-chunk deadline — flowing reasoning chunks reset
  // this timer, so only total silence is cut.
  assert.equal(config.timeouts.reasoningModelTimeout, 180_000);
  assert.equal(config.timeouts.firstChunkTimeout, 180_000);
  // chat_in_progress busy window: production default is 4s (short enough that
  // the sticky owner's next turn is not pushed to a cold account; measured
  // settle ~1-2s). .env.test overrides it to 100ms for suite speed.
  assert.ok(config.retry.chatInProgressBusyMs <= 4_000);
  assert.ok(config.retry.chatInProgressBusyMs >= 100);
  // Per-turn tool-call cap: raised from 8 to 24 so legitimate agentic batches
  // (e.g. a multi-file schema migration emitting ~20 calls in one turn) are not
  // silently dropped, while a true runaway loop is still bounded. Env-tunable
  // via MAX_TOOL_CALLS_PER_TURN; 0 disables the cap.
  assert.equal(config.retry.maxToolCallsPerTurn, 24);
});

test("config keeps Qwen anti-bot static config limited to bx-v fallback and web version", () => {
  assert.equal(typeof config.auth.userAgent, "string");
  assert.equal(typeof config.auth.bxV, "string");
  assert.equal("bxUa" in config.auth, false);
  assert.equal("bxUmidtoken" in config.auth, false);
  // Version header default matches the audited real-client bundle snapshot
  // (network HAR: qwen-chat-fe/0.2.91).
  assert.equal(config.qwen.webVersion, "0.2.91");
});

test("qwen web version updates dynamically from live DOM/header discoveries", async () => {
  const { getQwenWebVersion, updateQwenWebVersion } = await import("../services/qwen-headers.ts");
  assert.equal(getQwenWebVersion(), "0.2.91");
  updateQwenWebVersion("0.2.95");
  assert.equal(getQwenWebVersion(), "0.2.95");
  // Invalid formats should be ignored
  updateQwenWebVersion("invalid");
  assert.equal(getQwenWebVersion(), "0.2.95");
  // Reset back to baseline
  updateQwenWebVersion("0.2.91");
  assert.equal(getQwenWebVersion(), "0.2.91");
});

test("prompt limits reject byte and model-context overages locally", () => {
  assert.equal(typeof config.qwen.maxPromptBytes, "number");
  assert.equal(typeof config.qwen.maxPersonalizationBytes, "number");

  if (config.qwen.maxPromptBytes > 0) {
    const oversizedUtf8Prompt = "é".repeat(
      Math.floor(config.qwen.maxPromptBytes / 2) + 1,
    );
    assert.throws(
      () => assertPromptWithinLimits(oversizedUtf8Prompt, "qwen3.7-plus"),
      (error: unknown) => {
        assert.ok(error instanceof ContextLengthExceededError);
        assert.equal(error.code, "context_length_exceeded");
        assert.equal(error.param, "messages");
        return true;
      },
    );
  }

  const compactModel = "qwen3-omni-flash-2025-12-01";
  const stats = getPromptLimitStats("", compactModel);
  const overContextPrompt = "a".repeat((stats.usableInputTokens + 1) * 4);
  assert.throws(
    () => assertPromptWithinLimits(overContextPrompt, compactModel),
    (error: unknown) => {
      assert.ok(error instanceof ContextLengthExceededError);
      assert.match(error.message, /usable context/);
      return true;
    },
  );

  if (config.qwen.maxPersonalizationBytes > 0) {
    assert.equal(
      isRequestPersonalizationWithinLimit(
        "x".repeat(config.qwen.maxPersonalizationBytes),
      ),
      true,
    );
    assert.equal(
      isRequestPersonalizationWithinLimit(
        "x".repeat(config.qwen.maxPersonalizationBytes + 1),
      ),
      false,
    );
  }
});
