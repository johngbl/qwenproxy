import { test } from "node:test";
import assert from "node:assert";
import { StreamingToolParser } from "../tools/parser.ts";

const TOOLS = [
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

const FLAT_TOOLS = [
  {
    name: "task",
    description: "Spawn a task",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["description", "prompt"],
    },
  },
];

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
];

test("StreamingToolParser: basic tool call", () => {
  const parser = new StreamingToolParser();

  const result = parser.feed(
    'Hello! <tool_call>{"name": "t1", "arguments": {"a": 1}}</tool_call>',
  );
  // Text before tool call is held in pendingLeadIn when tools are present
  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "t1");
});

test("StreamingToolParser: drops residual environment details after tool calls", () => {
  const parser = new StreamingToolParser();
  const input =
    '<tool_call>{"name":"edit_file","arguments":{"path":"a.txt","edits":[]}}</tool_call>\n</environment_details>\nCurrent time: 2026-07-18T15:26:30-03:00\nWorking directory: /tmp/project\n</environment_details>';

  const result = parser.feed(input);
  const flushed = parser.flush();

  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "edit_file");
  assert.strictEqual(result.text + flushed.text, "");
});

test("StreamingToolParser: drops fragmented environment details after tool calls", () => {
  const parser = new StreamingToolParser();
  const input =
    '<tool_call>{"name":"edit_file","arguments":{"path":"a.txt","edits":[]}}</tool_call>\n</environment_details>\nCurrent time: x\n</environment_details>';
  let text = "";
  let toolCalls = 0;

  for (const char of input) {
    const result = parser.feed(char);
    text += result.text;
    toolCalls += result.toolCalls.length;
  }
  text += parser.flush().text;

  assert.strictEqual(toolCalls, 1);
  assert.strictEqual(text, "");
});

test("StreamingToolParser: multiple tool calls", () => {
  const parser = new StreamingToolParser();

  const result = parser.feed(
    '<tool_call>{"name": "t2", "arguments": {}}</tool_call><tool_call>{"name": "t3", "arguments": {}}</tool_call>',
  );
  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 2);
  assert.strictEqual(result.toolCalls[0].name, "t2");
  assert.strictEqual(result.toolCalls[1].name, "t3");
});

test("StreamingToolParser: fragmented tool call", () => {
  const parser = new StreamingToolParser();

  // Text before partial tag is emitted immediately (no complete tag yet)
  assert.strictEqual(parser.feed("Text <tool_").text, "Text ");
  assert.strictEqual(parser.feed("call>").text, "");
  const final = parser.feed(
    '{"name": "frag", "arguments": {}}</tool_call> trailing',
  );

  assert.strictEqual(final.toolCalls.length, 1);
  assert.strictEqual(final.toolCalls[0].name, "frag");
  assert.strictEqual(final.text, "");
});

test("StreamingToolParser: flush partial content", () => {
  const parser = new StreamingToolParser();

  // Partial tag at end - flush should return it as text
  parser.feed("Unfinished tag <tool_");
  assert.strictEqual(parser.flush().text, "<tool_");

  // Incomplete JSON in tool call - flush should recover it
  const parser2 = new StreamingToolParser();
  parser2.feed('Broken tool <tool_call>{"name": "healable"');
  const flushed = parser2.flush();
  assert.strictEqual(flushed.toolCalls.length, 1);
  assert.strictEqual(flushed.toolCalls[0].name, "healable");

  // Invalid JSON in tool call - flush drops it with warning, restores lead-in
  const parser3 = new StreamingToolParser();
  parser3.feed("Invalid <tool_call>NOT_JSON");
  const flushed2 = parser3.flush();
  // Invalid JSON is dropped with a warning message, and "Invalid " lead-in is restored
  assert.ok(
    flushed2.text.includes("[WARNING:"),
    "should include truncation warning",
  );
  assert.ok(flushed2.text.includes("Invalid "), "should restore lead-in text");
  assert.strictEqual(flushed2.toolCalls.length, 0);
});

test("StreamingToolParser: robust parsing of malformed JSON", () => {
  const parser = new StreamingToolParser();

  const res = parser.feed(
    '<tool_call>{"name": "broken", "arguments": {"a": 1</tool_call>',
  );
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, "broken");
  assert.deepStrictEqual(res.toolCalls[0].arguments, { a: 1 });
});

test("StreamingToolParser: recovers missing opening tag and flattens nested arguments", () => {
  const parser = new StreamingToolParser([
    {
      type: "function",
      function: {
        name: "recovered",
        description: "",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ]);

  const res = parser.feed(
    '{"name": "recovered", "arguments": {"arguments": {"path": "a.txt"}}}</tool_call>',
  );
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, "recovered");
  assert.deepStrictEqual(res.toolCalls[0].arguments, { path: "a.txt" });
});

test("StreamingToolParser: preserves tags in non-tool text", () => {
  const parser = new StreamingToolParser();

  // When it looks like a tool call (has open+close tags), it tries to parse
  // If parse fails, tags are NOT preserved (they're dropped as malformed tool calls)
  const res1 = parser.feed(
    'Fake: <tool_call> { "only_args": 1 } </tool_call> ',
  );
  // Malformed tool call is dropped, lead-in restored (with trailing space)
  assert.strictEqual(res1.text, "Fake:  ");
  assert.strictEqual(res1.toolCalls.length, 0);

  const res2 = parser.feed('Real: <tool_call>{"name":"r"}</tool_call>');
  assert.strictEqual(res2.toolCalls.length, 1);
  assert.strictEqual(res2.toolCalls[0].name, "r");
});

test("StreamingToolParser: handles multiple tool calls in array format", () => {
  const parser = new StreamingToolParser();

  const chunk = `<tool_call>[
  {"name": "bash", "arguments": {"command": "ls", "description": "List files"}},
  {"name": "read", "arguments": {"path": "test.txt"}}
]</tool_call>`;

  const result = parser.feed(chunk);
  assert.strictEqual(
    result.toolCalls.length,
    2,
    "Should extract both tool calls",
  );
  assert.strictEqual(result.toolCalls[0].name, "bash");
  assert.strictEqual(result.toolCalls[1].name, "read");
  assert.strictEqual(result.toolCalls[0].arguments.command, "ls");
});

test("StreamingToolParser: no tool calls emits text normally", () => {
  const parser = new StreamingToolParser();

  const result = parser.feed("Hello, how can I help you today?");
  assert.strictEqual(result.text, "Hello, how can I help you today?");
  assert.strictEqual(result.toolCalls.length, 0);
});

test("StreamingToolParser: pendingLeadIn cleared after tool call", () => {
  const parser = new StreamingToolParser();

  // After processing a successful tool call, pendingLeadIn is cleared
  parser.feed(
    'Hello! <tool_call>{"name": "t1", "arguments": {"a": 1}}</tool_call>',
  );
  assert.strictEqual(parser.getPendingLeadIn(), "");
  assert.strictEqual(parser.getEmittedToolCallCount(), 1);
});

test("StreamingToolParser: preserves literal <tool_call> inside inline code across chunks", () => {
  const parser = new StreamingToolParser(TOOLS);

  const first = parser.feed(
    "Para usar uma ferramenta, eu gero um bloco JSON envolto exatamente nas tags `",
  );
  assert.strictEqual(
    first.text,
    "Para usar uma ferramenta, eu gero um bloco JSON envolto exatamente nas tags `",
  );
  assert.strictEqual(first.toolCalls.length, 0);

  const second = parser.feed("<tool_call>`. A estrutura é sempre esta:");
  assert.strictEqual(second.text, "<tool_call>`. A estrutura é sempre esta:");
  assert.strictEqual(second.toolCalls.length, 0);
});

test("StreamingToolParser: preserves literal <tool_call> example in fenced code block", () => {
  const parser = new StreamingToolParser(TOOLS);

  const literal = [
    "Exemplo:",
    "```json",
    "<tool_call>",
    '{"name":"nome_da_ferramenta","arguments":{"parametro":"valor"}}',
    "</tool_call>",
    "```",
  ].join("\n");

  const result = parser.feed(literal);
  assert.strictEqual(result.text, literal);
  assert.strictEqual(result.toolCalls.length, 0);
});

test("StreamingToolParser: preserves literal tool_call block when tool name is undeclared", () => {
  const parser = new StreamingToolParser(TOOLS);

  const literal =
    '<tool_call>{"name":"nome_da_ferramenta","arguments":{"parametro":"valor"}}</tool_call>';

  const result = parser.feed(literal);
  assert.strictEqual(result.text, literal);
  assert.strictEqual(result.toolCalls.length, 0);
});

test("StreamingToolParser: passes through recovered tool call with undeclared name", () => {
  const parser = new StreamingToolParser(TOOLS);

  const result = parser.feed(
    'Lead <tool_call>name": "invented_tool", "arguments": {"path": "a.txt"}}</tool_call>',
  );

  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "invented_tool");
});

test("StreamingToolParser: accepts declared tool names from flat tool definitions", () => {
  const parser = new StreamingToolParser(FLAT_TOOLS as any);

  const result = parser.feed(
    '<tool_call>{"name":"task","arguments":{"description":"Resume backend analysis","prompt":"Analyze all files"}}</tool_call>',
  );

  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "task");
  assert.deepStrictEqual(result.toolCalls[0].arguments, {
    description: "Resume backend analysis",
    prompt: "Analyze all files",
  });
});

test("StreamingToolParser: fuzzy-matches declared tool names safely", () => {
  const parser = new StreamingToolParser(TOOLS);

  const result = parser.feed(
    '<tool_call>{"name":"readFile","arguments":{"path":"src/index.ts"}}</tool_call>',
  );

  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "read_file");
  assert.deepStrictEqual(result.toolCalls[0].arguments, {
    path: "src/index.ts",
  });
});

test("StreamingToolParser: parses case-insensitive tool close tags", () => {
  const parser = new StreamingToolParser(TOOLS);

  const result = parser.feed(
    '<tool_call>{"name":"read_file","arguments":{"path":"package.json"}}</TOOL_CALL>',
  );

  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "read_file");
  assert.deepStrictEqual(result.toolCalls[0].arguments, {
    path: "package.json",
  });
});

test("StreamingToolParser: parses double-escaped JSON argument strings", () => {
  const parser = new StreamingToolParser(EDIT_FILE_TOOLS);

  const escapedEdits = JSON.stringify([
    { old_text: "a", new_text: "b" },
  ]).replaceAll('"', "\\" + '"');
  const payload = `<tool_call>${JSON.stringify({
    name: "edit_file",
    arguments: { path: "src/a.ts", edits: escapedEdits },
  })}</tool_call>`;
  const result = parser.feed(payload);

  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "edit_file");
  assert.deepStrictEqual(result.toolCalls[0].arguments.edits, [
    { old_text: "a", new_text: "b" },
  ]);
});

test("StreamingToolParser: parses JSON-stringified nested argument fields", () => {
  const parser = new StreamingToolParser(EDIT_FILE_TOOLS);
  const edits = [
    {
      old_text:
        "        const streamState = createStreamState(responseId, requestModel);\n        let completionTokens = 0;\n        let streamError: Error | null = null;",
      new_text:
        "        const streamState = createStreamState(responseId, requestModel);\n        let completionTokens = 0;\n        let streamError: Error | null = null;\n        resetTimeout();",
    },
  ];

  const result = parser.feed(
    `<tool_call>${JSON.stringify({
      name: "edit_file",
      arguments: {
        path: "src/routes/responses/index.ts",
        edits: JSON.stringify(edits),
      },
    })}</tool_call>`,
  );

  assert.strictEqual(result.text, "");
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, "edit_file");
  assert.strictEqual(
    result.toolCalls[0].arguments.path,
    "src/routes/responses/index.ts",
  );
  assert.deepStrictEqual(result.toolCalls[0].arguments.edits, edits);
});
