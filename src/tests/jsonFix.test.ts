import { test } from "node:test";
import assert from "node:assert";
import { robustParseJSON } from "../utils/json.ts";

test("robustParseJSON: handles problematic string with trailing parenthesis", () => {
    const problematicString = '{"name": "suggest", "arguments": {"suggest": "Landing page para escritório", "actions": [{"label": "Revisar", "prompt": "/local-review"}]})';
    const result = robustParseJSON(problematicString);
    assert.ok(result !== null);
    assert.strictEqual(result.name, "suggest");
    assert.strictEqual(result.arguments.actions.length, 1);
});

test("robustParseJSON: handles missing closing braces", () => {
    const missingBraces = '{"name": "test", "arguments": {"foo": "bar"';
    const result = robustParseJSON(missingBraces);
    assert.ok(result !== null);
    assert.strictEqual(result.arguments.foo, "bar");
});

test("robustParseJSON: handles control characters in string", () => {
    const literalNewline = '{"name": "control", "msg": "line 1\nline 2"}';
    const result = robustParseJSON(literalNewline);
    assert.ok(result !== null);
    assert.ok(result.msg.includes("line 1"));
    assert.ok(result.msg.includes("line 2"));
});

test("robustParseJSON: handles invalid backslash escapes in string", () => {
    const invalidEscapes = '{"path": "C:\\\\Users\\\\name\\\\Documents"}';
    const result = robustParseJSON(invalidEscapes);
    assert.ok(result !== null);
    assert.ok(result.path.includes("Users"));
});

test("robustParseJSON: handles double key hallucination", () => {
    const doubleKey = '{"name": "name": "create_file", "arguments": {"path": "b.txt"}}';
    const result = robustParseJSON(doubleKey);
    assert.ok(result !== null);
    assert.strictEqual(result.name, "create_file");
});

test("robustParseJSON: handles unquoted arguments key", () => {
    const unquotedArgs = '{"name":"Read",arguments:{"file_path":"test.ts","limit":100}}';
    const result = robustParseJSON(unquotedArgs);
    assert.ok(result !== null);
    assert.strictEqual(result.arguments.limit, 100);
});

test("robustParseJSON: handles stream truncation mid-string (ECONNRESET scenario)", () => {
    const truncatedJson = '{"name":"apply_diff","arguments":{"path":"src/api/server.ts","diff":"<<<<<<< SEARCH\\n';
    const result = robustParseJSON(truncatedJson);

    assert.ok(result !== null, "Should not return null");
    assert.strictEqual(result.name, "apply_diff");
    assert.strictEqual(result.arguments.path, "src/api/server.ts");
    assert.ok(result.arguments.diff.includes("<<<<<<< SEARCH"), "Should recover the diff string");
});

test("robustParseJSON: handles stream truncation mid-string with escaped quote", () => {
    const truncatedJson = '{"name":"apply_diff","arguments":{"diff":"content with \\"quote';
    const result = robustParseJSON(truncatedJson);

    assert.ok(result !== null, "Should not return null");
    assert.strictEqual(result.name, "apply_diff");
    assert.ok(result.arguments.diff.includes('content with "quote'), "Should recover the string with escaped quote");
});
