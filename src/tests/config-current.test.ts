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
});

test("config keeps Qwen anti-bot static config limited to bx-v fallback", () => {
  assert.equal(typeof config.auth.userAgent, "string");
  assert.equal(typeof config.auth.bxV, "string");
  assert.equal("bxUa" in config.auth, false);
  assert.equal("bxUmidtoken" in config.auth, false);
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
