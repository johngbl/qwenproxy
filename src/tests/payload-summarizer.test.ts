import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rebuildPromptWithSummary,
  truncateMessages,
} from "../services/payload-summarizer.ts";

const LARGE_TEXT = "x".repeat(45_000);
const LARGE_TOOL_RESULT = "tool-result ".repeat(5_000);

test("payload-summarizer: preserves earlier tool memory when truncating oversized tool messages", () => {
  const messages = [
    {
      role: "assistant",
      content: LARGE_TEXT,
      tool_calls: [
        {
          id: "call_1",
          function: {
            name: "search_docs",
            arguments: JSON.stringify({ query: "captcha fix upstream" }),
          },
        },
      ],
    },
    {
      role: "tool",
      name: "search_docs",
      tool_call_id: "call_1",
      content: LARGE_TOOL_RESULT,
    },
  ];

  const truncated = truncateMessages(messages);

  assert.equal(truncated[0].role, "user");
  assert.match(truncated[0].content, /Earlier tool memory/);
  assert.match(truncated[0].content, /search_docs/);
  assert.match(truncated[0].content, /captcha fix upstream/);
  assert.match(truncated[0].content, /response:/);

  assert.equal(truncated.length, 3);
  assert.match(String(truncated[1].content), /truncated/);
  assert.match(String(truncated[2].content), /truncated/);
});

test("payload-summarizer: injects earlier tool memory into rebuilt prompt summary", () => {
  const prompt = rebuildPromptWithSummary(
    "System prompt",
    [
      {
        role: "assistant",
        content: LARGE_TEXT,
        tool_calls: [
          {
            id: "call_2",
            function: {
              name: "send_tools",
              arguments: JSON.stringify({ tool: "browser", mode: "native" }),
            },
          },
        ],
      } as any,
    ],
    "Conversation summary",
  );

  assert.match(prompt, /\[Previous conversation summary\]/);
  assert.match(prompt, /\[Earlier tool memory\]/);
  assert.match(prompt, /send_tools/);
  assert.match(prompt, /browser/);
});
