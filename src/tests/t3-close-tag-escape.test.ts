import test from "node:test";
import assert from "node:assert";
import { StreamingToolParser } from "../tools/parser.ts";

const EDIT_FILE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "edit_file",
      description: "Edit a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                old_text: { type: "string" },
                new_text: { type: "string" },
              },
              required: ["old_text", "new_text"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "grep",
      description: "Search file contents",
      parameters: {
        type: "object",
        properties: {
          regex: { type: "string" },
          include_pattern: { type: "string" },
        },
        required: ["regex"],
      },
    },
  },
];

// Guard (not a repro): this payload uses only single-escape `\"` sequences,
// which the pre-fix scanner already handled — it locks in that a literal
// `</tool_call>` inside an escaped string value never truncates the payload.
// The pre-fix failure mode (close-tag selection on unbalanced quotes) is
// reproduced by the T3 test below.
const oldTextValue =
  '\t"The listed tools are client-side tools. Do not claim they are unavailable and do not execute them in Meta AI\'s environment. ' +
  "When a tool is needed, return exactly one valid <tool_call name=" +
  '"FUNCTION_NAME"> block with JSON arguments and its closing' +
  '</tool_call>"';

// JSON-encode the value the way a model would (correct escapes), so the
// payload is syntactically valid and the ONLY failure mode left is the
// scanner exiting the string too early.
const fullBody = JSON.stringify({
  name: "edit_file",
  arguments: {
    path: "src/browser/worker.js",
    edits: [{ old_text: oldTextValue, new_text: "replacement" }],
  },
});

test("T3: close tag inside JSON string with double-escaped quotes is not truncated", () => {
  const parser = new StreamingToolParser(EDIT_FILE_TOOLS);
  const result = parser.feed(`<tool_call>${fullBody}</tool_call>`);
  const flushed = parser.flush();

  const allCalls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(parser.getMalformedToolCalls().length, 0);
  assert.strictEqual(allCalls.length, 1, "full payload must parse as one call");
  assert.strictEqual(allCalls[0].name, "edit_file");
  const edits = (allCalls[0].arguments as any)?.edits as
    | Array<{ old_text: string }>
    | undefined;
  assert.ok(edits?.[0], "edits must be present (not truncated)");
  assert.ok(
    edits[0].old_text.includes(
      "block with JSON arguments and its closing</tool_call>",
    ),
    "old_text must retain the literal inner close tag",
  );
  assert.strictEqual(
    (edits[0] as any).new_text,
    "replacement",
    "new_text must survive (payload must not be cut at the inner marker)",
  );
});

// T2+T3 interaction: an UNBALANCED quote count (malformed `arguments":regex":`
// shape) defeats the string-state scanner, so the close tag is found by the
// last-occurrence fallback. The value also quotes a literal `</tool_call>` —
// the fallback must close on the REAL trailing tag, not the inner marker, or
// the payload is truncated again (logs 02:06:35/02:06:36 double-drop).
test("T3: fallback closes on real tag when quotes are unbalanced and value quotes the marker", () => {
  const payload =
    '{"name": "grep", "arguments":regex": "foo </tool_call> bar", "include_pattern": "logs.txt"}}';

  const parser = new StreamingToolParser(EDIT_FILE_TOOLS);
  const result = parser.feed(`<tool_call>${payload}</tool_call>`);
  const flushed = parser.flush();

  const allCalls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(
    allCalls.length,
    1,
    "must recover one call, not truncate at the quoted inner marker",
  );
  assert.strictEqual(allCalls[0].name, "grep");
  assert.deepStrictEqual(allCalls[0].arguments, {
    regex: "foo </tool_call> bar",
    include_pattern: "logs.txt",
  });
  assert.strictEqual(parser.getMalformedToolCalls().length, 0);
});
