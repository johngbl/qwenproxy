/**
 * Coverage tests for the TOOLCALL_DEBUG=0 load branch of src/core/logger.ts,
 * plus the LOG_LEVEL env fallback for the initial logger level.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOOLCALL_DEBUG = "0";
process.env.LOG_LEVEL = "warn";

const {
  logger,
  isDebugEnabled,
  isToolcallDebugEnabled,
  isToolcallErrorDebugEnabled,
  toolcallDebugLevel,
} = await import("../core/logger.ts");

test("TOOLCALL_DEBUG=0: level resolves to '0' and helpers report disabled", () => {
  assert.equal(toolcallDebugLevel, "0");
  assert.equal(isToolcallDebugEnabled(), false);
  assert.equal(isToolcallErrorDebugEnabled(), false);
});

test("LOG_LEVEL=warn drives the singleton level when toolcall debug is off", () => {
  assert.equal(isDebugEnabled(), false);
  assert.equal(logger.isLevelEnabled("debug"), false);
  assert.equal(logger.isLevelEnabled("info"), false);
  assert.equal(logger.isLevelEnabled("warn"), true);
  assert.equal(logger.isLevelEnabled("error"), true);
});

test("logger methods do not throw in disabled mode", () => {
  logger.debug("suppressed");
  logger.info("suppressed");
  logger.warn("shown");
  logger.error("shown", { mode: "disabled" });
});
