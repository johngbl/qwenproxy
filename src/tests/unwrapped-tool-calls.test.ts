import test from "node:test";
import assert from "node:assert/strict";
import { StreamingToolParser } from "../tools/parser.ts";

test("Parser extracts unwrapped raw JSON tool calls without tags and sanitizes trailing dots", () => {
  const tools = [
    {
      type: "function" as const,
      function: {
        name: "read",
        description: "Read file",
        parameters: {
          type: "object",
          properties: { filePath: { type: "string" } },
          required: ["filePath"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "glob",
        description: "Glob files",
        parameters: {
          type: "object",
          properties: { pattern: { type: "string" } },
          required: ["pattern"],
        },
      },
    },
  ];

  const parser = new StreamingToolParser(tools);

  // Exact payload format from user's Image 1:
  // Multiple JSONs concatenated without tags + trailing hallucinated dots
  const payload =
    '{"name":"read","arguments":{"filePath":"C:\\\\Dev\\\\Tenda\\\\PackageStatus.java"}} {"name":"read","arguments":{"filePath":"C:\\\\Dev\\\\Tenda\\\\OrderPackage.java"}} {"name":"glob","arguments":{"pattern":"**/test/**/Timeline*Test.java"}} ...... ......';

  const feedResult = parser.feed(payload);
  const flushResult = parser.flush();

  const totalToolCalls = [...feedResult.toolCalls, ...flushResult.toolCalls];
  const fullText = feedResult.text + flushResult.text;

  assert.equal(totalToolCalls.length, 3, "Should extract all 3 tool calls");
  assert.equal(totalToolCalls[0].name, "read");
  assert.equal(
    totalToolCalls[0].arguments.filePath,
    "C:\\Dev\\Tenda\\PackageStatus.java",
  );
  assert.equal(totalToolCalls[1].name, "read");
  assert.equal(
    totalToolCalls[1].arguments.filePath,
    "C:\\Dev\\Tenda\\OrderPackage.java",
  );
  assert.equal(totalToolCalls[2].name, "glob");
  assert.equal(
    totalToolCalls[2].arguments.pattern,
    "**/test/**/Timeline*Test.java",
  );

  // Assert that raw JSON and trailing dots did NOT leak as plain text
  assert.equal(fullText, "", "Text should be empty (no JSON or dots leak)");
});

test("Parser strips incomplete orphaned <tool_call tag at end of stream", () => {
  const parser = new StreamingToolParser([]);

  // Payload format from user's Image 2: text ending with orphaned <tool_call
  const payload =
    "Vou usar o terminal para explorar a estrutura do projeto.\n<tool_call";

  const feedResult = parser.feed(payload);
  const flushResult = parser.flush();
  const fullText = feedResult.text + flushResult.text;

  assert.ok(
    !fullText.includes("<tool_call"),
    "Incomplete <tool_call tag should be stripped from visible text",
  );
  assert.ok(
    fullText.includes("Vou usar o terminal para explorar a estrutura"),
    "Prose text should be preserved",
  );
});
