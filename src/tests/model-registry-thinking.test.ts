import { test } from "node:test";
import assert from "node:assert/strict";
import { getModelContextWindow } from "../core/model-registry.ts";

test("model-registry: handles -thinking suffix (upstream a63f054)", () => {
  // Test that -thinking suffix is properly stripped
  const contextWindow = getModelContextWindow("qwen3.7-plus-thinking");
  assert.equal(contextWindow, 1000000);
});

test("model-registry: handles -no-thinking suffix", () => {
  const contextWindow = getModelContextWindow("qwen3.7-plus-no-thinking");
  assert.equal(contextWindow, 1000000);
});

test("model-registry: handles base model without suffix", () => {
  const contextWindow = getModelContextWindow("qwen3.7-plus");
  assert.equal(contextWindow, 1000000);
});

test("model-registry: returns defaults for unknown models", () => {
  const contextWindow = getModelContextWindow("unknown-model");
  assert.equal(contextWindow, 131072); // defaultContextWindow
});
