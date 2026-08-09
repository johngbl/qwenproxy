/**
 * Coverage tests for src/utils/json.ts (robustParseJSON) with
 * TOOLCALL_DEBUG=1, so every debug-logging branch inside the parser is
 * executed. The env var must be set before the dynamic import because
 * `isDebug` is captured at module load time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOOLCALL_DEBUG = "1";

const { robustParseJSON } = await import("../utils/json.ts");

test("robustParseJSON: valid object parses directly", () => {
  const result = robustParseJSON('{"path": "a.txt", "line": 10}');
  assert.deepEqual(result, { path: "a.txt", line: 10 });
});

test("robustParseJSON: valid object with arrays parses directly", () => {
  const result = robustParseJSON('{"items": [1, 2, 3], "nested": {"arr": [{"k": "v"}]}}');
  assert.deepEqual(result, { items: [1, 2, 3], nested: { arr: [{ k: "v" }] } });
});

test("robustParseJSON: strips ```json code fences before parsing", () => {
  const result = robustParseJSON("```json\n{\"a\": 1}\n```");
  assert.deepEqual(result, { a: 1 });
});

test("robustParseJSON: returns null when there is no opening brace", () => {
  assert.equal(robustParseJSON("no braces here at all"), null);
  assert.equal(robustParseJSON("   "), null);
});

test("robustParseJSON: quotes bare keys (quote-fix parse path)", () => {
  const result = robustParseJSON('{name: "John", age: 30}');
  assert.deepEqual(result, { name: "John", age: 30 });
});

test("robustParseJSON: recovers missing opening quote in value", () => {
  const result = robustParseJSON('{"path": file.txt"}');
  assert.deepEqual(result, { path: "file.txt" });
});

test("robustParseJSON: closes a truncated object (balanced-parse path)", () => {
  const result = robustParseJSON('{"a": 1, "b": 2');
  assert.deepEqual(result, { a: 1, b: 2 });
});

test("robustParseJSON: recovers an unclosed string at end of input", () => {
  const result = robustParseJSON('{"a": "hello');
  assert.deepEqual(result, { a: "hello" });
});

test("robustParseJSON: unclosed string ending in an escaped quote", () => {
  const result = robustParseJSON('{"text": "abc\\"');
  assert.deepEqual(result, { text: 'abc"' });
});

test("robustParseJSON: closes nested array/object truncation in LIFO order", () => {
  const result = robustParseJSON('{"a":[{"x":1');
  assert.deepEqual(result, { a: [{ x: 1 }] });
});

test("robustParseJSON: truncates trailing unbalanced content after a complete object", () => {
  const result = robustParseJSON('{"a":1} {"b":2');
  assert.deepEqual(result, { a: 1 });
});

test("robustParseJSON: invalid \\u escape sequence is double-escaped", () => {
  // \u not followed by 4 hex digits must survive as a literal backslash-u.
  const result = robustParseJSON('{"a":"bad \\uZZZZ escape');
  assert.deepEqual(result, { a: "bad \\uZZZZ escape" });
});

test("robustParseJSON: valid \\u escape inside truncated string is preserved", () => {
  const result = robustParseJSON('{"a":"\\u0041');
  assert.deepEqual(result, { a: "A" });
});

test("robustParseJSON: unknown escape sequences are kept literally", () => {
  const result = robustParseJSON('{"a":"oops \\q here');
  assert.deepEqual(result, { a: "oops \\q here" });
});

test("robustParseJSON: unrecoverable garbage throws after all attempts", () => {
  assert.throws(() => robustParseJSON("{{{:::"));
});
