/**
 * Coverage tests for the TOOLCALL_DEBUG=errors + UPSTREAM_DEBUG=true load
 * branches of src/core/logger.ts. Runs in its own process (node:test spawns
 * one per file) so the module-level startup block executes with this env.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOOLCALL_DEBUG = "errors";
process.env.UPSTREAM_DEBUG = "true";

const {
  logger,
  isDebugEnabled,
  isToolcallDebugEnabled,
  isToolcallErrorDebugEnabled,
  toolcallDebugLevel,
  upstreamDebugEnabled,
} = await import("../core/logger.ts");

test("TOOLCALL_DEBUG=errors: level resolves to 'errors'", () => {
  assert.equal(toolcallDebugLevel, "errors");
  assert.equal(isToolcallDebugEnabled(), false);
  assert.equal(isToolcallErrorDebugEnabled(), true);
});

test("UPSTREAM_DEBUG=true enables the upstream debug flag", () => {
  assert.equal(upstreamDebugEnabled, true);
});

test("logger stays at info level (no LOG_LEVEL set) and methods do not throw", () => {
  assert.equal(isDebugEnabled(), false);
  assert.equal(logger.isLevelEnabled("info"), true);
  logger.debug("suppressed");
  logger.info("i");
  logger.warn("w");
  logger.error("e", { stage: "toolcall-errors-mode" });
});
