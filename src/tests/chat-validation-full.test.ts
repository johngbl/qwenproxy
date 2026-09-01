import test from "node:test";
import assert from "node:assert";

// Set the environment BEFORE the module graph under test loads. Static ESM
// imports are hoisted above these assignments, so the project modules are
// imported dynamically below.
process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.TOOLCALL_DEBUG = "1";

const { parseRequestBody } = await import("../routes/chat/validation.ts");
const { config } = await import("../core/config.ts");
const { logger, isToolcallDebugEnabled } = await import("../core/logger.ts");

function mockContext(body: unknown): any {
  return {
    req: {
      json: async () => body,
      header: (name: string) =>
        name === "x-request-id" ? "req-test-1" : "test-agent",
    },
  };
}

test("validation test environment has toolcall debug enabled", () => {
  // Guard: the debug branches below only execute when the logger loaded with
  // TOOLCALL_DEBUG=1 (see the dynamic imports at the top of this file).
  assert.strictEqual(isToolcallDebugEnabled(), true);
  assert.strictEqual(logger.isLevelEnabled("debug"), true);
});

test("parseRequestBody extracts session key, stream flag and model", async () => {
  const parsed = await parseRequestBody(
    mockContext({
      model: "qwen3.7-plus",
      stream: true,
      session_id: "  sess-123  ",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
    }),
  );
  assert.strictEqual(parsed.isStream, true);
  assert.strictEqual(parsed.conversationKey, "sess-123");
  assert.strictEqual(parsed.hasExplicitConversationKey, true);
  assert.strictEqual(parsed.modelId, "qwen3.7-plus");
  assert.strictEqual(typeof parsed.enableThinking, "boolean");
  assert.ok(parsed.systemPrompt.includes("You are helpful."));
  assert.ok(parsed.prompt.includes("User: Hello"));
  assert.strictEqual(parsed.shouldParseToolCalls, false);
  assert.strictEqual(parsed.toolInstructions, "");
  assert.strictEqual(parsed.allFiles.length, 0);
  assert.strictEqual(parsed.currentFiles.length, 0);
});

test("parseRequestBody falls back to conversation_id and then null", async () => {
  const withConv = await parseRequestBody(
    mockContext({
      model: "qwen3.7-plus",
      session_id: "   ",
      conversation_id: " conv-9 ",
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.strictEqual(withConv.conversationKey, "conv-9");
  assert.strictEqual(withConv.hasExplicitConversationKey, true);

  const without = await parseRequestBody(
    mockContext({
      model: "qwen3.7-plus",
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.strictEqual(without.conversationKey, null);
  assert.strictEqual(without.hasExplicitConversationKey, false);
});

test("parseRequestBody handles array, object and empty content", async () => {
  const parsed = await parseRequestBody(
    mockContext({
      model: "qwen3.7-plus",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "part one" },
            { type: "text", text: "part two" },
          ],
        },
        { role: "assistant", content: { nested: "value" } },
        { role: "user", content: null },
      ],
    }),
  );
  assert.ok(parsed.prompt.includes("part one\npart two"));
  assert.ok(parsed.prompt.includes('{"nested":"value"}'));
  // Only the trailing user message belongs to the current prompt.
  assert.strictEqual(parsed.currentMessageCount, 1);
  assert.strictEqual(parsed.messageCount, 3);
});

test("parseRequestBody serializes tool calls and tool responses", async () => {
  const parsed = await parseRequestBody(
    mockContext({
      model: "qwen3.7-plus",
      messages: [
        { role: "user", content: "use the tool" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "thinking about it",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Berlin"}' },
            },
            {
              id: "call-2",
              type: "function",
              function: { name: "broken", arguments: "{oops" },
            },
            {
              id: "call-3",
              type: "function",
              function: { name: "obj_args", arguments: { a: 1 } },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "sunny" },
        { role: "function", name: "legacy", content: "42" },
      ],
    }),
  );
  assert.ok(parsed.prompt.includes("get_weather"));
  assert.ok(parsed.prompt.includes('"city":"Berlin"'));
  // Malformed JSON arguments are preserved as _raw.
  assert.ok(parsed.prompt.includes('"_raw":"{oops"'));
  assert.ok(parsed.prompt.includes("Tool Response (get_weather): sunny"));
  assert.ok(parsed.prompt.includes("Tool Response (legacy): 42"));
  assert.ok(parsed.prompt.includes("thinking about it"));
  // Trailing tool/function messages are part of the current prompt.
  assert.ok(parsed.currentPrompt.includes("Tool Response (get_weather)"));
  assert.ok(parsed.currentPrompt.includes("Tool Response (legacy)"));
});

test("parseRequestBody current prompt includes assistant tool_calls before trailing tool results", async () => {
  const parsed = await parseRequestBody(
    mockContext({
      model: "qwen3.7-plus",
      messages: [
        { role: "user", content: "old question" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "t", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "result-a" },
        { role: "function", name: "t", content: "result-b" },
        { role: "user", content: "follow up" },
      ],
    }),
  );
  // The current window starts at the assistant message that issued the calls.
  assert.ok(parsed.currentPrompt.includes("Assistant:"));
  assert.ok(parsed.currentPrompt.includes("result-a"));
  assert.ok(parsed.currentPrompt.includes("result-b"));
  assert.ok(parsed.currentPrompt.includes("follow up"));
  assert.ok(!parsed.currentPrompt.includes("old question"));
  assert.strictEqual(parsed.messageCount, 5);
});

test("parseRequestBody current prompt starts at first tool result when no tool_calls assistant precedes", async () => {
  const parsed = await parseRequestBody(
    mockContext({
      model: "qwen3.7-plus",
      messages: [
        { role: "user", content: "old" },
        { role: "assistant", content: "plain answer" },
        { role: "tool", content: "result-a" },
        { role: "user", content: "follow up" },
      ],
    }),
  );
  assert.ok(parsed.currentPrompt.includes("result-a"));
  assert.ok(parsed.currentPrompt.includes("follow up"));
  assert.ok(!parsed.currentPrompt.includes("plain answer"));
});

test("parseRequestBody uploads current-message files and keeps text", async () => {
  const originalFetch = globalThis.fetch;
  const remoteUrl = "https://example.com/docs/report.pdf";
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === remoteUrl) {
      return new Response(Buffer.from("pdf-bytes"), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }
    if (url.includes("/api/v2/files/getstsToken")) {
      return new Response(
        JSON.stringify({
          success: true,
          request_id: "req-1",
          data: {
            access_key_id: "ak",
            access_key_secret: "sk",
            security_token: "token",
            file_url: "https://oss.example/report.pdf?signature=123",
            file_path: "uploads/report.pdf",
            file_id: "file-123",
            bucketname: "bucket",
            region: "oss-region",
            endpoint: "oss.example",
          },
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const parsed = await parseRequestBody(
      mockContext({
        model: "qwen3.7-plus",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "analyze this file" },
              { type: "file_url", file_url: { url: remoteUrl } },
            ],
          },
        ],
      }),
    );
    assert.strictEqual(parsed.allFiles.length, 1);
    assert.strictEqual(parsed.currentFiles.length, 1);
    assert.strictEqual(
      parsed.allFiles[0].url,
      "https://oss.example/report.pdf",
    );
    assert.ok(parsed.currentPrompt.includes("analyze this file"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseRequestBody skips upload for media in older messages", async () => {
  const parsed = await parseRequestBody(
    mockContext({
      model: "qwen3.7-plus",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "old image" },
            {
              type: "image_url",
              image_url: { url: "https://example.com/old.png" },
            },
          ],
        },
        { role: "assistant", content: "ok" },
        { role: "user", content: "new question" },
      ],
    }),
  );
  assert.strictEqual(parsed.allFiles.length, 0);
  assert.ok(parsed.prompt.includes("old image"));
  assert.strictEqual(parsed.currentMessageCount, 1);
});

test("parseRequestBody logs request debug payloads without failing", async () => {
  const origChatRequests = config.logging.chatRequests;
  config.logging.chatRequests = true;
  process.env.REQUEST_DEBUG = "true";
  try {
    const longText = "x".repeat(400);
    const parsed = await parseRequestBody(
      mockContext({
        model: "qwen3.7-plus",
        stream: false,
        conversation_id: "conv-debug",
        session_id: "sess-debug",
        user: "tester",
        tools: [
          {
            type: "function",
            function: { name: "demo", description: "d", parameters: {} },
          },
        ],
        tool_choice: { type: "function", function: { name: "demo" } },
        messages: [
          { role: "system", content: longText },
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              {
                type: "image_url",
                image_url: { url: "https://example.com/x.png" },
              },
              { foo: 1 },
            ],
          },
          {
            role: "assistant",
            content: { obj: true },
            tool_calls: [
              {
                id: "t1",
                type: "function",
                function: { name: "demo", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "t1", name: "demo", content: null },
        ],
      }),
    );
    assert.ok(parsed.toolInstructions.length > 0);
    assert.strictEqual(parsed.shouldParseToolCalls, true);
  } finally {
    config.logging.chatRequests = origChatRequests;
    delete process.env.REQUEST_DEBUG;
  }
});

test("parseRequestBody debug logging tolerates system-only history", async () => {
  const origChatRequests = config.logging.chatRequests;
  config.logging.chatRequests = true;
  try {
    const parsed = await parseRequestBody(
      mockContext({
        model: "qwen3.7-plus",
        messages: [
          { role: "system", content: "only system" },
          { role: "system", content: "again" },
        ],
      }),
    );
    assert.strictEqual(parsed.messageCount, 0);
    assert.strictEqual(parsed.currentMessageCount, 0);
  } finally {
    config.logging.chatRequests = origChatRequests;
  }
});

test("parseRequestBody builds tool instructions and logs forced tool_choice", async () => {
  const parsed = await parseRequestBody(
    mockContext({
      model: "qwen3.7-plus",
      messages: [{ role: "user", content: "call it" }],
      tools: [
        {
          type: "function",
          function: {
            name: "alpha",
            description: "does things",
            parameters: { type: "object" },
          },
        },
        { name: "beta" },
      ],
      tool_choice: { type: "function", function: { name: "alpha" } },
    }),
  );
  assert.ok(parsed.shouldParseToolCalls);
  assert.ok(parsed.toolInstructions.includes("alpha"));
});

// ── reasoning_effort (OpenAI chat spec: none|minimal|low|medium|high|xhigh|max)
// Precedence: an explicit model suffix wins; effort only acts on unsuffixed
// models. Absent field must be a complete no-op (zero regression).
test("reasoning_effort absent is a no-op (auto, thinking on)", async () => {
  const parsed = await parseRequestBody(
    mockContext({
      model: "qwen3.7-plus",
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.strictEqual(parsed.reasoningMode, "auto");
  assert.strictEqual(parsed.enableThinking, true);
  assert.strictEqual(parsed.modelId, "qwen3.7-plus");
});

test("reasoning_effort low/none/minimal forces fast mode on unsuffixed model", async () => {
  for (const effort of ["low", "none", "minimal"]) {
    const parsed = await parseRequestBody(
      mockContext({
        model: "qwen3.7-plus",
        reasoning_effort: effort,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assert.strictEqual(
      parsed.reasoningMode,
      "fast",
      `effort '${effort}' must map to fast`,
    );
    assert.strictEqual(parsed.enableThinking, false);
    assert.strictEqual(parsed.modelId, "qwen3.7-plus");
  }
});

test("reasoning_effort medium/high/max keeps auto (Qwen decides)", async () => {
  for (const effort of ["medium", "high", "xhigh", "max"]) {
    const parsed = await parseRequestBody(
      mockContext({
        model: "qwen3.7-plus",
        reasoning_effort: effort,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assert.strictEqual(parsed.reasoningMode, "auto");
    assert.strictEqual(parsed.enableThinking, true);
  }
});

test("model suffix wins over reasoning_effort (both directions)", async () => {
  const thinkingWithLow = await parseRequestBody(
    mockContext({
      model: "qwen3.7-plus-thinking",
      reasoning_effort: "low",
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.strictEqual(thinkingWithLow.reasoningMode, "thinking");
  assert.strictEqual(thinkingWithLow.enableThinking, true);

  const fastWithHigh = await parseRequestBody(
    mockContext({
      model: "qwen3.7-plus-fast",
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.strictEqual(fastWithHigh.reasoningMode, "fast");
  assert.strictEqual(fastWithHigh.enableThinking, false);
});

test("camelCase reasoningEffort is accepted (OpenCode body overlay)", async () => {
  const parsed = await parseRequestBody(
    mockContext({
      model: "qwen3.7-plus",
      reasoningEffort: "low",
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.strictEqual(parsed.reasoningMode, "fast");
  assert.strictEqual(parsed.enableThinking, false);
});
