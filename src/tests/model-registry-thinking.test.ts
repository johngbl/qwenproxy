import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getModelCapabilities,
  getModelContextWindow,
  getModelContextWindowSource,
  replaceModelMetadata,
  syncModelMetadata,
} from "../core/model-registry.ts";

syncModelMetadata([
  {
    id: "qwen3.7-plus",
    info: {
      meta: {
        max_context_length: 1_000_000,
        max_summary_generation_length: 65_536,
        capabilities: { thinking: true, vision: true },
        modality: ["text", "image", "video"],
        think_skip: { enable: true },
      },
    },
  },
]);

test("model-registry: handles -fast suffix from live metadata", () => {
  const contextWindow = getModelContextWindow("qwen3.7-plus-fast");
  assert.equal(contextWindow, 1_000_000);
});

test("model-registry: handles base model without a hardcoded entry", () => {
  const contextWindow = getModelContextWindow("qwen3.7-plus");
  assert.equal(contextWindow, 1_000_000);
  assert.equal(getModelContextWindowSource("qwen3.7-plus"), "upstream");
});

test("model-registry: keeps account metadata isolated", () => {
  syncModelMetadata(
    [
      {
        id: "account-model",
        info: { meta: { max_context_length: 900_000 } },
      },
    ],
    "account-a",
  );
  syncModelMetadata(
    [
      {
        id: "account-model",
        info: { meta: { max_context_length: 120_000 } },
      },
    ],
    "account-b",
  );

  assert.equal(getModelContextWindow("account-model", "account-a"), 900_000);
  assert.equal(getModelContextWindow("account-model", "account-b"), 120_000);
  assert.equal(getModelContextWindow("account-model", "account-c"), 131_072);
});

test("model-registry: replaces a complete account catalog", () => {
  syncModelMetadata(
    [{ id: "stale-model", context_window: 700_000 }],
    "replace-account",
  );
  replaceModelMetadata(
    [{ id: "current-model", context_window: 800_000 }],
    "replace-account",
  );

  assert.equal(getModelContextWindow("stale-model", "replace-account"), 131_072);
  assert.equal(getModelContextWindow("current-model", "replace-account"), 800_000);
});

test("model-registry: returns defaults for unknown models", () => {
  const contextWindow = getModelContextWindow("unknown-model");
  assert.equal(contextWindow, 131072); // defaultContextWindow
  assert.equal(getModelContextWindowSource("unknown-model"), "default");
});

test("model-registry: parses qwen3.8-max live metadata", () => {
  syncModelMetadata(
    [
      {
        id: "qwen3.8-max",
        info: {
          is_active: true,
          meta: {
            max_context_length: 1_000_000,
            max_summary_generation_length: 131_072,
            capabilities: {
              vision: true,
              document: true,
              video: true,
              audio: true,
              thinking: true,
              search: true,
            },
            abilities: { vision: 1, document: 1, thinking: 3 },
            modality: ["text", "image", "video"],
            chat_type: ["t2t", "t2i", "t2v"],
            mcp: ["image-generation", "code-interpreter"],
            think_skip: { enable: true },
          },
        },
      },
    ],
    "qwen3.8-account",
  );

  const capabilities = getModelCapabilities("qwen3.8-max", "qwen3.8-account");
  assert.equal(getModelContextWindow("qwen3.8-max", "qwen3.8-account"), 1_000_000);
  assert.equal(capabilities.maxOutputTokens, 131_072);
  assert.equal(capabilities.maxThinkingTokens, 131_072);
  assert.equal(capabilities.supportsVision, true);
  assert.equal(capabilities.supportsDocument, true);
  assert.equal(capabilities.supportsVideo, true);
  assert.equal(capabilities.supportsAudio, true);
  assert.equal(capabilities.canSkipThinking, true);
  assert.equal(capabilities.supportsCodeExecution, true);
  assert.equal(capabilities.chatTypes.includes("t2i"), true);
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
  assert.equal(getModelContextWindow("qwen-live-test-fast"), 777_777);
  assert.equal(getModelContextWindowSource("qwen-live-test"), "upstream");
  assert.equal(getModelCapabilities("qwen-live-test").maxOutputTokens, 12_000);
  assert.equal(getModelCapabilities("qwen-live-test").maxThinkingTokens, 4_000);
  assert.equal(getModelCapabilities("qwen-live-test").supportsVision, true);
});
