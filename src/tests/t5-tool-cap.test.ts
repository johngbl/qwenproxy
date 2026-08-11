import test from "node:test";
import assert from "node:assert";
import { StreamingToolParser } from "../tools/parser.ts";

const READ_FILE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
];

function callBlock(path: string): string {
  return `<tool_call>{"name": "read_file", "arguments": {"path": "${path}"}}</tool_call>`;
}

// Reproduces logs2.txt 2026-08-09T02:22:30 / 02:23:00:
// "WARN [parser] Dropping tool call: per-turn cap reached { read_file, max 8 }"
// — valid calls beyond the cap were dropped with no visibility into the stream
// summary. They must be tracked distinctly from malformed calls (a cap-drop is
// a VALID call that was intentionally not emitted) and must NOT trigger the
// [SYSTEM CORRECTION] auto-retry (the turn already has emitted calls).
test("T5: per-turn cap drops are tracked as capped, not malformed", () => {
  const parser = new StreamingToolParser(READ_FILE_TOOLS, {
    maxToolCallsPerTurn: 2,
  });

  const result = parser.feed(
    callBlock("a.txt") + callBlock("b.txt") + callBlock("c.txt"),
  );
  const flushed = parser.flush();

  const allCalls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(allCalls.length, 2, "only calls up to the cap are emitted");
  assert.strictEqual(parser.getEmittedToolCallCount(), 3, "dropped call counts toward the cap");

  const capped = parser.getCappedToolCalls();
  assert.strictEqual(capped.length, 1, "over-cap call must be tracked");
  assert.strictEqual(capped[0].toolName, "read_file");
  assert.ok(typeof capped[0].timestamp === "number");

  assert.strictEqual(
    parser.getMalformedToolCalls().length,
    0,
    "cap-drops are NOT malformed: no spurious [SYSTEM CORRECTION] auto-retry",
  );
});

test("T5: cap disabled (0) emits everything and tracks nothing", () => {
  const parser = new StreamingToolParser(READ_FILE_TOOLS, {
    maxToolCallsPerTurn: 0,
  });

  const result = parser.feed(
    callBlock("a.txt") + callBlock("b.txt") + callBlock("c.txt"),
  );
  const flushed = parser.flush();

  const allCalls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(allCalls.length, 3);
  assert.strictEqual(parser.getCappedToolCalls().length, 0);
  assert.strictEqual(parser.getMalformedToolCalls().length, 0);
});

test("T5: cap-drop does not disturb subsequent text/tool parsing", () => {
  const parser = new StreamingToolParser(READ_FILE_TOOLS, {
    maxToolCallsPerTurn: 1,
  });

  const result = parser.feed(
    callBlock("a.txt") + "then some text" + callBlock("b.txt"),
  );
  const flushed = parser.flush();

  const allCalls = [...result.toolCalls, ...flushed.toolCalls];
  assert.strictEqual(allCalls.length, 1, "only the first call is emitted");
  assert.strictEqual(allCalls[0].arguments.path, "a.txt");
  assert.strictEqual(parser.getCappedToolCalls().length, 1);
  assert.strictEqual(parser.getCappedToolCalls()[0].toolName, "read_file");
});
