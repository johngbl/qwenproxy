import { test } from "node:test";
import assert from "node:assert/strict";
import { robustParseJSON } from "../utils/json.ts";

test("robustParseJSON: recovers missing opening quotes in JSON values (upstream a63f054, 9328bde)", () => {
  // Case 1: Missing opening quote before value
  const malformed1 = '{"path": file.txt"}';
  const result1 = robustParseJSON(malformed1);
  assert.deepEqual(result1, { path: "file.txt" });

  // Case 2: Missing opening quote with complex value
  const malformed2 = '{"command": export CI=true"}';
  const result2 = robustParseJSON(malformed2);
  assert.deepEqual(result2, { command: "export CI=true" });

  // Case 3: Multiple fields with missing quotes
  const malformed3 = '{"name": test-tool", "path": /usr/bin"}';
  const result3 = robustParseJSON(malformed3);
  assert.deepEqual(result3, { name: "test-tool", path: "/usr/bin" });

  // Case 4: Nested object with missing quote
  const malformed4 = '{"args": {"file": data.json"}}';
  const result4 = robustParseJSON(malformed4);
  assert.deepEqual(result4, { args: { file: "data.json" } });
});

test("robustParseJSON: handles edge cases from upstream 9328bde", () => {
  // Case from upstream: value with dots and hyphens
  const malformed = '{"key": my-file.name"}';
  const result = robustParseJSON(malformed);
  assert.deepEqual(result, { key: "my-file.name" });

  // Case with numbers in value
  const malformed2 = '{"id": user123"}';
  const result2 = robustParseJSON(malformed2);
  assert.deepEqual(result2, { id: "user123" });
});

test("robustParseJSON: preserves valid JSON without modification", () => {
  const valid = '{"path": "file.txt", "command": "ls -la"}';
  const result = robustParseJSON(valid);
  assert.deepEqual(result, { path: "file.txt", command: "ls -la" });
});

test("robustParseJSON: handles Python code with URLs and newlines in strings", () => {
  // Bug: global Windows path check caused false positives with https://
  const code = `import requests\n\ndef test_api():\n    url = "https://api.example.com/data"\n    response = requests.get(url)\n    assert response.status_code == 200`;
  const json = JSON.stringify({ name: "patch", arguments: { mode: "replace", new_string: code } });
  const result = robustParseJSON(json);
  assert.ok(result !== null);
  assert.strictEqual(result.name, "patch");
  assert.strictEqual(result.arguments.new_string, code);
});

test("robustParseJSON: handles Windows paths with newlines in strings", () => {
  // Bug: C:\path triggered double-escaping of \n elsewhere in the string
  const code = `path = "C:\\Users\\test\\file.txt"\nprint(path)`;
  const json = JSON.stringify({ name: "patch", arguments: { mode: "replace", new_string: code } });
  const result = robustParseJSON(json);
  assert.ok(result !== null);
  assert.strictEqual(result.name, "patch");
  assert.strictEqual(result.arguments.new_string, code);
});

test("robustParseJSON: handles double-escaped quotes only after parse fails", () => {
  // Valid JSON with \\ (literal backslash + quote) should parse directly
  const validWithBackslash = '{"path": "C:\\\\Users\\\\test"}';
  const result = robustParseJSON(validWithBackslash);
  assert.ok(result !== null);
  assert.strictEqual(result.path, "C:\\Users\\test");
});
