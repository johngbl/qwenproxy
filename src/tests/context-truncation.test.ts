import test from "node:test";
import assert from "node:assert";

import { estimateTokenCount } from "../utils/context-truncation.ts";

// Property-based tests. The fork uses a per-character heuristic that differs
// from the upstream divisor, so exact upstream values are intentionally not
// asserted here — these tests pin the invariants that matter to truncation.

test("estimateTokenCount: returns 0 for empty string", () => {
  assert.strictEqual(estimateTokenCount(""), 0);
});

test("estimateTokenCount: returns 0 for no parts", () => {
  assert.strictEqual(estimateTokenCount(), 0);
});

test("estimateTokenCount: ignores empty parts", () => {
  assert.strictEqual(
    estimateTokenCount("", "", ""),
    estimateTokenCount(""),
  );
});

test("estimateTokenCount: positive for non-empty printable text", () => {
  assert.ok(estimateTokenCount("hello") > 0);
  assert.ok(estimateTokenCount("a") > 0);
});

test("estimateTokenCount: monotonically non-decreasing as text grows", () => {
  const base = "some text";
  assert.ok(estimateTokenCount(base + " more") >= estimateTokenCount(base));
});

test("estimateTokenCount: splitting parts equals the concatenated form", () => {
  const a = "hello ";
  const b = "world";
  assert.strictEqual(estimateTokenCount(a, b), estimateTokenCount(a + b));
});

test("estimateTokenCount: CJK weighs more than the same count of ASCII", () => {
  const cjk = estimateTokenCount("中".repeat(20));
  const ascii = estimateTokenCount("a".repeat(20));
  assert.ok(cjk > ascii, `cjk=${cjk} should exceed ascii=${ascii}`);
});

test("estimateTokenCount: whitespace is counted but lighter than prose", () => {
  const spaces = estimateTokenCount(" ".repeat(100));
  const prose = estimateTokenCount("a".repeat(100));
  assert.ok(spaces > 0);
  assert.ok(spaces <= prose);
});

test("estimateTokenCount: structural JSON characters weigh more than letters", () => {
  const structural = estimateTokenCount("{}[]\":,;".repeat(10));
  const letters = estimateTokenCount("aaaaaaaa".repeat(10));
  assert.ok(structural > letters);
});

test("estimateTokenCount: emoji (surrogate pairs) are handled", () => {
  const tokens = estimateTokenCount("😀😀😀");
  assert.ok(Number.isFinite(tokens));
  assert.ok(tokens > 0);
});
