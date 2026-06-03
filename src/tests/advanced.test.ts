import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_PLAYWRIGHT = "true";

import { app, setCacheForTesting } from "../api/server.js";
import { MemoryCache } from "../cache/memory-cache.js";

delete process.env.API_KEY;

// Helper to mock the fetch global for testing empty response retry and caching logic
function setupFetchMock(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr =
      typeof input === "string"
        ? input
        : "url" in input
          ? input.url
          : String(input);
    if (urlStr.includes("chat.qwen.ai")) {
      // Handle models list request separately if handler doesn't
      if (urlStr.includes("/api/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "qwen3.6-plus", owned_by: "qwen" }] }),
          { status: 200 },
        );
      }
      return handler(urlStr, init);
    }
    return originalFetch(input, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("multiturn-thinking-tools: maintains reasoning_content history", async () => {
  let capturedBody = "";

  const restore = setupFetchMock((url, init) => {
    capturedBody = (init?.body as string) || "";
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: "doing something",
            reasoning_content: "thinking about hello",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "test", arguments: "{}" },
              },
            ],
          },
          { role: "tool", name: "test", content: "success" },
        ],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    // The proxy transforms messages into a Qwen-compatible prompt.
    // Verify the prompt (in the request body) contains context from all messages.
    assert.ok(
      capturedBody.includes("hello") || capturedBody.includes("User: hello"),
      "Must include user message",
    );
    assert.ok(
      capturedBody.includes("thinking about hello"),
      "Must include reasoning content",
    );
    assert.ok(
      capturedBody.includes("tool_call") ||
        capturedBody.includes('"name": "test"'),
      "Must include tool call info",
    );
    assert.ok(
      capturedBody.includes("Tool Response (test): success") ||
        capturedBody.includes("success"),
      "Must include tool response",
    );
  } finally {
    restore();
  }
});

test("streaming-whitespace: preserves exact whitespace", async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            'data: {"choices": [{"delta": {"content": "   ", "phase": "answer"}}]}\n\n',
          ),
        );
        c.enqueue(
          new TextEncoder().encode(
            'data: {"choices": [{"delta": {"content": "  hello  ", "phase": "answer"}}]}\n\n',
          ),
        );
        c.enqueue(
          new TextEncoder().encode(
            'data: {"choices": [{"delta": {"content": "\\n\\n  ", "phase": "answer"}}]}\n\n',
          ),
        );
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: "test" }],
        stream: true,
      }),
    });

    const res = await app.fetch(req);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let full = "";
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices?.[0]?.delta?.content) {
              full += data.choices[0].delta.content;
            }
          } catch (e) {}
        }
      }
    }

    // We expect exactly: "     hello  \n\n  "
    assert.strictEqual(full, "     hello  \n\n  ");
  } finally {
    restore();
  }
});

test("caching-streaming and cache-control: returns prompt_tokens_details", async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            'data: {"choices": [{"delta": {"content": "done", "phase": "answer"}}], "usage": {"input_tokens": 23, "output_tokens": 10, "total_tokens": 33, "input_tokens_details": {"text_tokens": 23}, "output_tokens_details": {"reasoning_tokens": 9, "text_tokens": 10}, "prompt_tokens_details": {"cached_tokens": 2}}}\n\n',
          ),
        );
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: "test" }],
        stream: true,
      }),
    });

    const res = await app.fetch(req);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let usageBlock = null;
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.usage) {
              usageBlock = data.usage;
            }
          } catch (e) {}
        }
      }
    }

    assert.ok(usageBlock);
    assert.strictEqual(usageBlock.prompt_tokens, 23);
    assert.strictEqual(usageBlock.completion_tokens, 10);
    assert.strictEqual(usageBlock.total_tokens, 33);
    assert.strictEqual(usageBlock.prompt_tokens_details.cached_tokens, 2);
    assert.strictEqual(usageBlock.prompt_tokens_details.text_tokens, 23);
    assert.strictEqual(usageBlock.completion_tokens_details.reasoning_tokens, 9);
    assert.strictEqual(usageBlock.completion_tokens_details.text_tokens, 10);
  } finally {
    restore();
  }
});

test("session-parent-tracking: appends messages using response message_id as parent", async () => {
  let capturedPayloads: any[] = [];

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse((init?.body as string) || "{}");
    capturedPayloads.push(bodyObj);

    // Simulate Qwen returning a response_id
    const mockMessageId =
      capturedPayloads.length === 1 ? "qwen-1001" : "qwen-1002";

    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: {"response.created":{"response_id":"${mockMessageId}"}}\n\n`,
          ),
        );
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(stream, { status: 200 });
  });

  try {
    process.env.TEST_SESSION_ID = "test-session-parent-tracking";
    // Turn 1
    const req1 = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: "Turn 1" }],
      }),
    });

    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 200);
    // Consume the stream to ensure the message_id is processed
    await res1.text();

    // Turn 2
    const req2 = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [
          { role: "user", content: "Turn 1" },
          { role: "assistant", content: "Response 1" },
          { role: "user", content: "Turn 2" },
        ],
      }),
    });

    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 200);
    await res2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    // In Turn 1, parent_id should be null (mock-session is fresh)
    assert.strictEqual(capturedPayloads[0].parent_id, null);
    // In Turn 2, parent_id should be qwen-1001 (the ID returned in Turn 1)
    assert.strictEqual(
      capturedPayloads[1].parent_id,
      "qwen-1001",
      "Turn 2 should use response_id from Turn 1 as parent",
    );
    assert.strictEqual(
      capturedPayloads[1].messages[0].content,
      "User: Turn 1\n\nAssistant: Response 1\n\nUser: Turn 2\n\n",
      "Should send the full OpenAI message history",
    );
  } finally {
    restore();
  }
});

test("topic-change reset: same conversation_id starts a fresh upstream thread after a topic shift", async () => {
  let capturedPayloads: any[] = [];
  const cache = new MemoryCache({ prefix: "topic-reset-test:" });
  await cache.connect();
  setCacheForTesting(cache);

  const originalTestSessionId = process.env.TEST_SESSION_ID;
  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse((init?.body as string) || "{}");
    capturedPayloads.push(bodyObj);

    const mockMessageId =
      capturedPayloads.length === 1 ? "qwen-topic-1" : "qwen-topic-2";
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: {"response.created":{"response_id":"${mockMessageId}"}}\n\n`,
          ),
        );
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(stream, { status: 200 });
  });

  try {
    process.env.TEST_SESSION_ID = "test-session-topic-reset";

    const req1 = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        conversation_id: "conv-topic-reset",
        messages: [{ role: "user", content: "How do Haskell monads work?" }],
      }),
    });

    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 200);
    await res1.text();

    const req2 = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        conversation_id: "conv-topic-reset",
        messages: [
          { role: "user", content: "How do Haskell monads work?" },
          { role: "assistant", content: "Monads sequence computations." },
          {
            role: "user",
            content: "Mudando de assunto, qual a melhor receita de pizza?",
          },
        ],
      }),
    });

    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 200);
    await res2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    assert.strictEqual(capturedPayloads[0].parent_id, null);
    assert.strictEqual(
      capturedPayloads[1].parent_id,
      null,
      "Topic change should reset the upstream parent chain for the same conversation_id",
    );
  } finally {
    restore();
    await cache.close();
    setCacheForTesting(undefined);
    if (originalTestSessionId === undefined) {
      delete process.env.TEST_SESSION_ID;
    } else {
      process.env.TEST_SESSION_ID = originalTestSessionId;
    }
  }
});
