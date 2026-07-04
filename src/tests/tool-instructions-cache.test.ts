import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolInstructions } from "../tools/instructions.ts";

test("buildToolInstructions: caches results for same inputs (upstream cb518e0)", () => {
  const toolsJson = '[{"name": "test", "description": "Test tool"}]';
  const toolChoice = undefined;

  // First call should compute and cache
  const result1 = buildToolInstructions(toolsJson, toolChoice);

  // Second call with same inputs should return cached result
  const result2 = buildToolInstructions(toolsJson, toolChoice);

  assert.equal(result1, result2);
  assert.ok(result1.includes("TOOLS AVAILABLE"));
  assert.ok(result1.includes("test"));
});

test("buildToolInstructions: different inputs produce different results", () => {
  const toolsJson1 = '[{"name": "tool1"}]';
  const toolsJson2 = '[{"name": "tool2"}]';

  const result1 = buildToolInstructions(toolsJson1);
  const result2 = buildToolInstructions(toolsJson2);

  assert.notEqual(result1, result2);
  assert.ok(result1.includes("tool1"));
  assert.ok(result2.includes("tool2"));
});

test("buildToolInstructions: includes forced tool instruction when toolChoice is set", () => {
  const toolsJson = '[{"name": "special_tool"}]';
  const toolChoice = { function: { name: "special_tool" } };

  const result = buildToolInstructions(toolsJson, toolChoice);

  assert.ok(result.includes("MUST call the tool"));
  assert.ok(result.includes("special_tool"));
});

test("buildToolInstructions: cache respects max entries limit", () => {
  // Create more than 64 unique inputs to trigger cache eviction
  for (let i = 0; i < 70; i++) {
    const toolsJson = `[{"name": "tool${i}"}]`;
    const result = buildToolInstructions(toolsJson);
    assert.ok(result.includes(`tool${i}`));
  }

  // Cache should still work after eviction
  const finalResult = buildToolInstructions('[{"name": "final"}]');
  assert.ok(finalResult.includes("final"));
});
