import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getModelCapabilities,
  getModelContextWindow,
  getModelContextWindowSource,
  syncModelMetadata,
} from "../core/model-registry.ts";

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
  assert.equal(getModelContextWindowSource("unknown-model"), "default");
});

test("model-registry: syncs the live Qwen context window and capabilities", () => {
  syncModelMetadata([
    {
      id: "qwen-live-test",
      context_window: 777_777,
      capabilities: {
        max_output_tokens: 12_000,
        max_thinking_tokens: 4_000,
        thinking: true,
        vision: true,
        modalities: ["text", "image"],
      },
    },
  ]);

  assert.equal(getModelContextWindow("qwen-live-test"), 777_777);
  assert.equal(getModelContextWindow("qwen-live-test-thinking"), 777_777);
  assert.equal(getModelContextWindowSource("qwen-live-test"), "upstream");
  assert.equal(getModelCapabilities("qwen-live-test").maxOutputTokens, 12_000);
  assert.equal(getModelCapabilities("qwen-live-test").maxThinkingTokens, 4_000);
  assert.equal(getModelCapabilities("qwen-live-test").supportsVision, true);
});
