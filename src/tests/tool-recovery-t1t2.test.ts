import test from "node:test";
import assert from "node:assert";
import { StreamingToolParser } from "../tools/parser.ts";

const GREP_TOOLS = [
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

const WRITE_FILE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// T2 — Repair rule for `"arguments":regex":` (missing `{` + key quotes)
// Reproduces logs2.txt 2026-08-09T02:21:02 (118-char grep drop).
// ---------------------------------------------------------------------------

test("T2: repairs unquoted key after arguments (log grep payload)", () => {
  const payload =
    '{"name": "grep", "arguments":regex": "(category|malformed|truncated|❌|⚠️|ERROR|WARN)", "include_pattern": "logs.txt"}}';

  const parser = new StreamingToolParser(GREP_TOOLS);
  const result = parser.feed(`<tool_call>${payload}</tool_call>`);

  assert.strictEqual(result.toolCalls.length, 1, "grep call must be recovered");
  assert.strictEqual(result.toolCalls[0].name, "grep");
  assert.deepStrictEqual(result.toolCalls[0].arguments, {
    regex: "(category|malformed|truncated|❌|⚠️|ERROR|WARN)",
    include_pattern: "logs.txt",
  });
  assert.strictEqual(parser.getMalformedToolCalls().length, 0);
});

// ---------------------------------------------------------------------------
// T1 — Parser must NOT capture model prose discussing the parser as a tool call
// Reproduces logs.txt 2026-08-09T01:47:43 (584-char prose drop) and the
// "It looks for <tool_call>..." pattern (95-char drop).
// ---------------------------------------------------------------------------

test("T1: prose quoting <tool_call> and JSON example is preserved as text", () => {
  const prose = [
    "` tag)",
    "   - If not found, it looks for `findRecoverableMissingOpenToolCall` (tool call with missing open tag but WITH close tag)",
    "   - If neither found, it checks for partial markers",
    "   - Content before partial markers is emitted via `emitVisibleText()`",
    "   - Content from partial markers onwards stays in buffer",
    "",
    "So the flow for the malformed tool call would be:",
    "1. Chunks arrive with `{\"name\": \"write_file\", \"arguments\": {\"path\": \"a\", \"content\": \"b\"}}`",
    "2. The parser appends to buffer",
    "3. It looks for `<tool_call>` - not found",
    "4. It looks for `findRecoverableMissingOpenToolCall` - this requires a CLOSE tag (`</tool_call>`",
  ].join("\n");

  const parser = new StreamingToolParser(WRITE_FILE_TOOLS);
  const result = parser.feed(prose);
  const flushed = parser.flush();

  const emitted = result.text + flushed.text;
  assert.strictEqual(parser.getMalformedToolCalls().length, 0, "prose must not be tracked as malformed (no spurious auto-retry)");
  assert.strictEqual(result.toolCalls.length + flushed.toolCalls.length, 0);
  assert.ok(
    emitted.includes("So the flow for the malformed tool call would be:"),
    "model prose must reach the client",
  );
  assert.ok(emitted.includes('{"name": "write_file"'), "quoted JSON example must be preserved");
});

test("T1: prose with bare <tool_call> mention and backticked close tag is text", () => {
  const prose =
    "3. It looks for <tool_call> - not found\n4. It looks for `findRecoverableMissingOpenToolCall` - this requires a CLOSE tag (`</tool_call>`)";

  const parser = new StreamingToolParser(WRITE_FILE_TOOLS);
  const result = parser.feed(prose);
  const flushed = parser.flush();

  assert.strictEqual(parser.getMalformedToolCalls().length, 0);
  assert.strictEqual(result.toolCalls.length + flushed.toolCalls.length, 0);
  const emitted = result.text + flushed.text;
  assert.ok(
    emitted.includes("It looks for") &&
      emitted.includes("findRecoverableMissingOpenToolCall") &&
      emitted.includes("CLOSE tag"),
    "prose must reach the client (round-trip)",
  );
});

// T1 guard: log 02:07:59 showed `{"name": "John"}` quoted as an example
// reaching the undeclared-name preserve path. Guard: prose quoting a JSON
// example must not be captured as a tool call at all (and therefore never
// reaches the undeclared-name malformed tracking).
test("T1: quoted JSON example with undeclared name does not register malformed", () => {
  const prose = "O resultado é ` + `{\"name\": \"John\"}` + ` quando concatenado.";

  const parser = new StreamingToolParser(WRITE_FILE_TOOLS);
  const result = parser.feed(prose);
  const flushed = parser.flush();

  assert.strictEqual(result.toolCalls.length + flushed.toolCalls.length, 0);
  assert.ok(
    (result.text + flushed.text).includes("John"),
    "example JSON must be preserved as text",
  );
  assert.strictEqual(parser.getMalformedToolCalls().length, 0);
});

// ---------------------------------------------------------------------------
// Guard tests: real tool calls must still be recovered / auto-retried
// ---------------------------------------------------------------------------

test("T1 guard: genuinely malformed tool call still tracks malformed", () => {
  const parser = new StreamingToolParser(WRITE_FILE_TOOLS);
  parser.feed(
    '<tool_call>{"name":"read_file"(oops){"path":"a.txt"}}</tool_call>',
  );
  parser.flush();
  assert.ok(
    parser.getMalformedToolCalls().length > 0,
    "real malformed payload must stay tracked for auto-retry",
  );
});

test("T1 guard: truncated write_file is dropped + tracked (no fabricated recovery)", () => {
  const parser = new StreamingToolParser(WRITE_FILE_TOOLS);
  // Cut mid-string inside `content` — exactly the logs1 2829-char class.
  // Recovery must NOT fabricate a closing quote (that streams a broken call
  // and skips the malformed auto-retry); it must be tracked instead.
  const truncated =
    '{"name": "write_file", "arguments": {"path": "QwenProxy/docs/AUDIT-FINDINGS.md", "content": "# Auditoria de repositórios — melhorias e correções 100% confirmadas\\n\\n> Documento de referência permanente.';
  parser.feed(`<tool_call>${truncated}`);
  const flushed = parser.flush();
  assert.strictEqual(flushed.toolCalls.length, 0);
  assert.ok(
    parser.getMalformedToolCalls().length > 0,
    "truncated payload must be tracked so the auto-retry can correct Qwen",
  );
});
