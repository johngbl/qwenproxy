import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapClientModelToQwen,
  mapKnownModelAlias,
  stripThinkingSuffix,
} from "../core/model-alias.ts";

test("mapClientModelToQwen keeps qwen ids (stripping reasoning suffix)", () => {
  assert.equal(mapClientModelToQwen("qwen3.7-plus"), "qwen3.7-plus");
  assert.equal(mapClientModelToQwen("qwen3.7-plus-low"), "qwen3.7-plus");
  assert.equal(mapClientModelToQwen("qwen3.7-plus-medium"), "qwen3.7-plus");
  assert.equal(mapClientModelToQwen("qwen3.7-plus-high"), "qwen3.7-plus");
  assert.equal(mapClientModelToQwen("qwen3.7-plus-fast"), "qwen3.7-plus");
  assert.equal(mapClientModelToQwen("qwen3.7-plus-thinking"), "qwen3.7-plus");
  assert.equal(mapClientModelToQwen("qwen3.8-max"), "qwen3.8-max");
  assert.equal(mapClientModelToQwen("qwen3.8-max-high"), "qwen3.8-max");
});

test("mapKnownModelAlias maps popular OpenAI/Anthropic models to Qwen tiers", () => {
  assert.equal(mapKnownModelAlias("gpt-4o"), "qwen3.8-max");
  assert.equal(mapKnownModelAlias("gpt-4o-mini"), "qwen3.7-plus");
  assert.equal(mapKnownModelAlias("gpt-4-turbo"), "qwen3.8-max");
  assert.equal(mapKnownModelAlias("gpt-3.5-turbo"), "qwen3.7-plus");
  assert.equal(mapKnownModelAlias("o1"), "qwen3.8-max");
  assert.equal(mapKnownModelAlias("o1-mini"), "qwen3.7-plus");
  assert.equal(mapKnownModelAlias("o3-mini"), "qwen3.7-plus");
  assert.equal(mapKnownModelAlias("chatgpt-4o-latest"), "qwen3.8-max");
  assert.equal(mapKnownModelAlias("claude-3-7-sonnet"), "qwen3.8-max");
  assert.equal(mapKnownModelAlias("claude-3-5-haiku"), "qwen3.7-plus");
  assert.equal(mapKnownModelAlias("totally-custom"), "totally-custom");
  assert.equal(mapKnownModelAlias(""), "");
});

test("mapClientModelToQwen respects enableAliases parameter", () => {
  // When enabled (default), maps known aliases
  assert.equal(mapClientModelToQwen("gpt-4o", true), "qwen3.8-max");
  assert.equal(mapClientModelToQwen("gpt-4o-mini", true), "qwen3.7-plus");
  assert.equal(mapClientModelToQwen("o1-preview", true), "qwen3.8-max");
  // When disabled, preserves raw name
  assert.equal(mapClientModelToQwen("gpt-5", false), "gpt-5");
  assert.equal(mapClientModelToQwen("gpt-5-mini", false), "gpt-5-mini");
  assert.equal(mapClientModelToQwen("totally-custom", false), "totally-custom");
});

test("stripThinkingSuffix maps base and public Fast variants", () => {
  assert.deepEqual(stripThinkingSuffix("qwen3.7-plus-low"), {
    baseModel: "qwen3.7-plus",
    enableThinking: false,
    reasoningMode: "fast",
  });
  assert.deepEqual(stripThinkingSuffix("qwen3.7-plus-medium"), {
    baseModel: "qwen3.7-plus",
    enableThinking: true,
    reasoningMode: "auto",
  });
  assert.deepEqual(stripThinkingSuffix("qwen3.7-plus-high"), {
    baseModel: "qwen3.7-plus",
    enableThinking: true,
    reasoningMode: "thinking",
  });
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