import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../core/config.ts";

test("config exposes only Playwright/thread-native current auth and context settings", () => {
  assert.equal(typeof config.playwright.headless, "boolean");
  assert.match(config.playwright.browser, /^(chromium|chrome|edge)$/);

  assert.equal("enabled" in config.playwright, false);
  assert.equal("rateLimit" in config, false);
  assert.equal("topicDetection" in config, false);

  assert.equal(typeof config.qwen.personalizationFromRequest, "boolean");
  assert.equal(typeof config.playwright.initBatchSize, "number");
  assert.equal(typeof config.playwright.contextCloseTimeoutMs, "number");
  assert.equal(typeof config.playwright.idleContextTtlMs, "number");
  assert.equal(typeof config.playwright.jsHeapMb, "number");
  assert.equal(typeof config.playwright.lowMemoryFlags, "boolean");
  assert.equal(typeof config.oss.multipartThresholdBytes, "number");
  assert.ok(config.playwright.jsHeapMb >= 64);
  assert.ok(config.oss.multipartThresholdBytes >= 1024 * 1024);
  assert.equal(typeof config.captchaSolver.enabled, "boolean");
  assert.equal(typeof config.captchaSolver.timeoutMs, "number");
  assert.equal(typeof config.sessionKeeper.enabled, "boolean");
  assert.equal(typeof config.sessionKeeper.intervalMs, "number");
  assert.equal(typeof config.sessionKeeper.idleMs, "number");
  assert.equal(typeof config.sessionKeeper.navigationIntervalMs, "number");
});

test("config keeps Qwen anti-bot static config limited to bx-v fallback", () => {
  assert.equal(typeof config.auth.userAgent, "string");
  assert.equal(typeof config.auth.bxV, "string");
  assert.equal("bxUa" in config.auth, false);
  assert.equal("bxUmidtoken" in config.auth, false);
});
