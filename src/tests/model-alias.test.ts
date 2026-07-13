import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapClientModelToQwen,
  stripThinkingSuffix,
} from "../core/model-alias.ts";
import { mapResponsesModel } from "../routes/responses/adapter.ts";

test("mapClientModelToQwen maps GPT-5 family including gpt-5-mini", () => {
  assert.equal(mapClientModelToQwen("gpt-5"), "qwen3.7-max");
  assert.equal(mapClientModelToQwen("gpt-5-mini"), "qwen3.5-flash");
  assert.equal(mapClientModelToQwen("gpt-5-nano"), "qwen3.5-flash");
  assert.equal(mapClientModelToQwen("gpt-5-pro"), "qwen3.7-max");
  assert.equal(mapClientModelToQwen("gpt-5-codex"), "qwen3-coder-plus");
  assert.equal(mapClientModelToQwen("gpt-4o-mini"), "qwen3.5-flash");
});

test("mapClientModelToQwen keeps qwen ids and unknown models", () => {
  assert.equal(mapClientModelToQwen("qwen3.7-plus"), "qwen3.7-plus");
  assert.equal(mapClientModelToQwen("qwen3.7-plus-thinking"), "qwen3.7-plus");
  assert.equal(mapClientModelToQwen("totally-custom"), "totally-custom");
});

test("stripThinkingSuffix detects enable/disable flags", () => {
  assert.deepEqual(stripThinkingSuffix("qwen3.7-plus-no-thinking"), {
    baseModel: "qwen3.7-plus",
    enableThinking: false,
  });
  assert.deepEqual(stripThinkingSuffix("qwen3.7-plus-thinking"), {
    baseModel: "qwen3.7-plus",
    enableThinking: true,
  });
  assert.deepEqual(stripThinkingSuffix("gpt-5-mini"), {
    baseModel: "gpt-5-mini",
    enableThinking: true,
  });
});

test("mapResponsesModel re-exports shared alias mapping", () => {
  assert.equal(mapResponsesModel("gpt-5-mini"), "qwen3.5-flash");
  assert.equal(mapResponsesModel("claude-sonnet-4-6"), "qwen3.7-plus");
});
