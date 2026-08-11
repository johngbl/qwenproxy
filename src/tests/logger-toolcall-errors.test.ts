/**
 * Coverage tests for the TOOLCALL_DEBUG=errors + UPSTREAM_DEBUG=true load
 * branches of src/core/logger.ts. Runs in its own process (node:test spawns
 * one per file) so the module-level startup block executes with this env.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOOLCALL_DEBUG = "errors";
process.env.UPSTREAM_DEBUG = "true";
// Isolate from a project .env that sets LOG_LEVEL (e.g. LOG_LEVEL=warn):
// dotenv does not override already-defined vars, and an empty value makes the
// logger fall back to its default (info) — the behavior this test asserts.
process.env.LOG_LEVEL = "";

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

test("logger defaults to warn level (no LOG_LEVEL set) and methods do not throw", () => {
  assert.equal(isDebugEnabled(), false);
  assert.equal(logger.isLevelEnabled("info"), false);
  assert.equal(logger.isLevelEnabled("warn"), true);
  logger.debug("suppressed");
  logger.info("i");
  logger.warn("w");
  logger.error("e", { stage: "toolcall-errors-mode" });
});
