import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapClientModelToQwen,
  stripThinkingSuffix,
} from "../core/model-alias.ts";

test("mapClientModelToQwen keeps qwen ids (stripping reasoning suffix)", () => {
  assert.equal(mapClientModelToQwen("qwen3.7-plus"), "qwen3.7-plus");
  assert.equal(mapClientModelToQwen("qwen3.7-plus-fast"), "qwen3.7-plus");
  assert.equal(mapClientModelToQwen("qwen3.7-plus-thinking"), "qwen3.7-plus");
  assert.equal(mapClientModelToQwen("qwen3.8-max"), "qwen3.8-max");
});

test("mapClientModelToQwen passes through non-Qwen ids (no GPT/Claude aliases)", () => {
  // Codex/Grok custom provider sends the real Qwen id. Any other id must reach
  // the upstream unchanged so it responds with a clear model-not-found error
  // instead of silently mapping to an unrelated tier.
  assert.equal(mapClientModelToQwen("gpt-5"), "gpt-5");
  assert.equal(mapClientModelToQwen("gpt-5-mini"), "gpt-5-mini");
  assert.equal(mapClientModelToQwen("gpt-4o-mini"), "gpt-4o-mini");
  assert.equal(mapClientModelToQwen("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(mapClientModelToQwen("totally-custom"), "totally-custom");
  assert.equal(mapClientModelToQwen(""), "");
});

test("stripThinkingSuffix maps base and public Fast variants", () => {
  assert.deepEqual(stripThinkingSuffix("qwen3.7-plus-fast"), {
    baseModel: "qwen3.7-plus",
    enableThinking: false,
    reasoningMode: "fast",
  });
  assert.deepEqual(stripThinkingSuffix("qwen3.7-plus"), {
    baseModel: "qwen3.7-plus",
    enableThinking: true,
    reasoningMode: "auto",
  });
  assert.deepEqual(stripThinkingSuffix("qwen3.7-plus-no-thinking"), {
    baseModel: "qwen3.7-plus",
    enableThinking: false,
    reasoningMode: "fast",
  });
  assert.deepEqual(stripThinkingSuffix("qwen3.7-plus-thinking"), {
    baseModel: "qwen3.7-plus",
    enableThinking: true,
    reasoningMode: "thinking",
  });
  assert.deepEqual(stripThinkingSuffix("gpt-5-mini"), {
    baseModel: "gpt-5-mini",
    enableThinking: true,
    reasoningMode: "auto",
  });
});