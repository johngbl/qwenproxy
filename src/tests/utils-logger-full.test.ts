/**
 * Coverage tests for src/core/logger.ts with TOOLCALL_DEBUG=1.
 *
 * The env var is set BEFORE the dynamic import so the module-level constants
 * (toolcallDebugLevel, initialLevel, upstreamDebugEnabled) observe it at load
 * time. Static imports are hoisted and would freeze the env too early.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOOLCALL_DEBUG = "1";

const {
  Logger,
  logger,
  maskEmail,
  isDebugEnabled,
  isToolcallDebugEnabled,
  isToolcallErrorDebugEnabled,
  toolcallDebugLevel,
  upstreamDebugEnabled,
} = await import("../core/logger.ts");

test("maskEmail: keeps only the local part of a valid email", () => {
  assert.equal(maskEmail("user@example.com"), "user");
  assert.equal(maskEmail("john.doe+tag@domain.co"), "john.doe+tag");
});

test("maskEmail: null/undefined/empty input maps to <unknown>", () => {
  assert.equal(maskEmail(null), "<unknown>");
  assert.equal(maskEmail(undefined), "<unknown>");
  assert.equal(maskEmail(""), "<unknown>");
});

test("maskEmail: strings without a usable @ map to <invalid>", () => {
  assert.equal(maskEmail("invalid"), "<invalid>");
  assert.equal(maskEmail("@leading-at.com"), "<invalid>");
});

test("logger singleton: TOOLCALL_DEBUG=1 enables full debug mode", () => {
  assert.equal(toolcallDebugLevel, "1");
  assert.equal(isToolcallDebugEnabled(), true);
  assert.equal(isToolcallErrorDebugEnabled(), true);
  // TOOLCALL_DEBUG=1 forces the singleton logger level to "debug".
  assert.equal(isDebugEnabled(), true);
  assert.equal(logger.isLevelEnabled("debug"), true);
  // UPSTREAM_DEBUG is not set in this process.
  assert.equal(upstreamDebugEnabled, false);
});

test("logger.debug: does not throw, with and without data payload", () => {
  logger.debug("debug message");
  logger.debug("debug message with data", { key: "value", nested: { n: 1 } });
});

test("logger.info: does not throw, with and without data payload", () => {
  logger.info("info message");
  logger.info("info message with data", { count: 42 });
});

test("logger.warn: does not throw, with and without data payload", () => {
  logger.warn("warn message");
  logger.warn("warn message with data", { reason: "test" });
});

test("logger.error: does not throw, with and without data payload", () => {
  logger.error("error message");
  logger.error("error message with data", { err: "boom", code: 500 });
});

test("Logger: debug-level instance with context logs every method", () => {
  const log = new Logger("debug", "unit-test");
  log.debug("d");
  log.info("i");
  log.warn("w");
  log.error("e");
  log.debug("d", { a: 1 });
  log.info("i", { b: 2 });
  log.warn("w", { c: 3 });
  log.error("e", { d: 4 });
  assert.equal(log.isLevelEnabled("debug"), true);
  assert.equal(log.isLevelEnabled("error"), true);
});

test("Logger: error-level instance suppresses lower levels without throwing", () => {
  const log = new Logger("error", "quiet");
  log.debug("hidden");
  log.info("hidden");
  log.warn("hidden");
  log.error("shown");
  log.error("shown with data", { fatal: true });
  assert.equal(log.isLevelEnabled("debug"), false);
  assert.equal(log.isLevelEnabled("info"), false);
  assert.equal(log.isLevelEnabled("warn"), false);
  assert.equal(log.isLevelEnabled("error"), true);
});

test("Logger: warn-level instance without context", () => {
  const log = new Logger("warn");
  log.debug("hidden");
  log.info("hidden");
  log.warn("shown");
  log.error("shown");
  assert.equal(log.isLevelEnabled("info"), false);
  assert.equal(log.isLevelEnabled("warn"), true);
});
