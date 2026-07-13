import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";
// Ensure API_KEY is empty by default for existing tests
process.env.API_KEY = "";

import { app } from "../api/server.js";

import { updateLogicalThreadState } from "../services/qwen.ts";
import { deriveSessionId } from "../utils/session-id.ts";
import {
  clearAccountCooldown,
  getAccountCooldownInfo,
} from "../core/account-manager.ts";

test("Health check endpoint returns 200", async () => {
  const req = new Request("http://localhost/health");
  const res = await app.fetch(req);

  assert.strictEqual(res.status, 200);

  const body = await res.json();
  assert.ok(body.status === "ok" || body.status === "unknown");
  assert.ok(body.timestamp);
});

test("Models endpoint returns qwen3.6-plus and qwen3.6-plus-no-thinking", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "qwen3.6-plus", owned_by: "qwen" }] }),
        { status: 200 },
      );
    }
    return originalFetch(input);
  };

  try {
    const req = new Request("http://localhost/v1/models");
    const res = await app.fetch(req);

    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.object, "list");
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.some((m: any) => m.id === "qwen3.6-plus"));
    assert.ok(body.data.some((m: any) => m.id === "qwen3.6-plus-no-thinking"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Chat Completions endpoint with qwen3.6-plus (thinking enabled)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "qwen3.6-plus", owned_by: "qwen" }] }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v2/chat/completions")) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_thought": {"content": ["Thinking..."]}}}}], "usage": {"input_tokens": 23, "output_tokens": 56, "total_tokens": 79, "input_tokens_details": {"text_tokens": 23}, "output_tokens_details": {"reasoning_tokens": 54, "text_tokens": 56}, "prompt_tokens_details": {"cached_tokens": 1}}}\n\n',
            ),
          );
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}], "usage": {"input_tokens": 23, "output_tokens": 60, "total_tokens": 83, "input_tokens_details": {"text_tokens": 23}, "output_tokens_details": {"reasoning_tokens": 54, "text_tokens": 60}, "prompt_tokens_details": {"cached_tokens": 1}}}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  await Promise.resolve();

  try {
    const payload = {
      model: "qwen3.6-plus",
      messages: [
        {
          role: "user",
          content: "What is 99 * 182? Please think step by step.",
        },
      ],
      stream: true,
    };

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("Content-Type"), "text/event-stream");

    const reader = res.body?.getReader();
    assert.ok(reader, "Response should have a readable body");

    const decoder = new TextDecoder();
    let hasReasoning = false;
    let hasContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.trim() === "data: [DONE]") {
          break;
        }
        if (line.startsWith("data: ")) {
          try {
            const dataStr = line.slice(6);
            if (dataStr !== "[DONE]") {
              const data = JSON.parse(dataStr);

              if (data.choices && data.choices[0] && data.choices[0].delta) {
                const delta = data.choices[0].delta;
                if (delta.content) {
                  hasContent = true;
                }
                if (delta.reasoning_content) {
                  hasReasoning = true;
                }
              }
            }
          } catch (err) {
            // Partial JSON ignored
            // console.error("Parse error:", err);
          }
        }
      }
    }

    assert.ok(
      hasReasoning,
      "Should have received streamed chunks with reasoning_content (Thinking enabled)",
    );
    assert.ok(hasContent, "Should have received streamed chunks with content");
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.resolve();
  }
});

test("Chat Completions stream preserves thinking titles inside reasoning_content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "qwen3.6-plus", owned_by: "qwen" }] }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v2/chat/completions")) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_title": {"content": ["Title 1"]}, "summary_thought": {"content": ["Thought 1"]}}}}]}\n\n',
            ),
          );
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_title": {"content": ["Title 1", "Title 2"]}, "summary_thought": {"content": ["Thought 1", "Thought 2"]}}}}]}\n\n',
            ),
          );
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}]}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  await Promise.resolve();

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const reader = res.body?.getReader();
    assert.ok(reader, "Response should have a readable body");

    const decoder = new TextDecoder();
    let reasoning = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ") || line.trim() === "data: [DONE]") {
          continue;
        }
        try {
          const data = JSON.parse(line.slice(6));
          const delta = data.choices?.[0]?.delta;
          if (typeof delta?.reasoning_content === "string") {
            reasoning += delta.reasoning_content;
          }
        } catch {}
      }
    }

    assert.strictEqual(
      reasoning,
      "**Title 1**\n\nThought 1\n\n**Title 2**\n\nThought 2",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.resolve();
  }
});

test("Chat Completions non-stream preserves thinking titles inside reasoning_content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "qwen3.6-plus", owned_by: "qwen" }] }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v2/chat/completions")) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_title": {"content": ["Title 1"]}, "summary_thought": {"content": ["Thought 1"]}}}}]}\n\n',
            ),
          );
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_title": {"content": ["Title 1", "Title 2"]}, "summary_thought": {"content": ["Thought 1", "Thought 2"]}}}}]}\n\n',
            ),
          );
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "answer", "content": "Hello non-stream"}}]}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  await Promise.resolve();

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(
      body.choices[0].message.reasoning_content,
      "**Title 1**\n\nThought 1\n\n**Title 2**\n\nThought 2",
    );
    assert.strictEqual(body.choices[0].message.content, "Hello non-stream");
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.resolve();
  }
});

test("Chat Completions returns explicit error for non-SSE upstream JSON errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/v2/chat/completions")) {
      return new Response(
        JSON.stringify({
          success: false,
          data: {
            code: "RateLimited",
            details: "You've reached the upper limit for today's usage.",
            num: 3,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input);
  };

  await Promise.resolve();

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 429);

    const body = await res.json();
    assert.match(body.error.message, /Qwen upstream error: RateLimited/);
    assert.match(body.error.message, /upper limit/);
    assert.strictEqual(
      getAccountCooldownInfo("mock-account")?.reason,
      "RateLimited",
    );
  } finally {
    clearAccountCooldown("mock-account");
    globalThis.fetch = originalFetch;
    await Promise.resolve();
  }
});

test("Chat Completions returns explicit error for stream=true upstream JSON errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/v2/chat/completions")) {
      return new Response(
        JSON.stringify({
          success: false,
          data: {
            code: "RateLimited",
            details: "You've reached the upper limit for today's usage.",
            num: 3,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input);
  };

  await Promise.resolve();

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 429);
    assert.ok(
      res.headers.get("Content-Type")?.includes("application/json"),
      "stream=true upstream JSON errors must stay JSON errors",
    );

    const body = await res.json();
    assert.match(body.error.message, /Qwen upstream error: RateLimited/);
    assert.match(body.error.message, /upper limit/);
    assert.strictEqual(
      getAccountCooldownInfo("mock-account")?.reason,
      "RateLimited",
    );
  } finally {
    clearAccountCooldown("mock-account");
    globalThis.fetch = originalFetch;
    await Promise.resolve();
  }
});

test("Chat Completions releases per-chat lock after initial stream body errors", async () => {
  const originalFetch = globalThis.fetch;
  const conversationId = `lock-release-${Date.now()}`;
  const messages = [{ role: "user", content: "hello lock" }];
  const sessionId = deriveSessionId(messages as any, "", conversationId);
  updateLogicalThreadState(sessionId, {
    accountId: "mock-account",
    chatSessionId: `lock-error-chat-${Date.now()}`,
    parentId: "parent-1",
    instructionsSent: true,
  });

  let completionCalls = 0;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/v2/chat/completions")) {
      completionCalls++;
      if (completionCalls === 1) {
        return new Response(
          JSON.stringify({
            success: false,
            data: {
              code: "UpstreamError",
              details: "stream body error before SSE starts",
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }

      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "answer", "content": "after lock"}}]}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return originalFetch(input);
  };

  try {
    const firstReq = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        conversation_id: conversationId,
        messages,
        stream: true,
      }),
    });

    const firstRes = await app.fetch(firstReq);
    assert.strictEqual(firstRes.status, 502);

    const secondReq = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        conversation_id: conversationId,
        messages,
        stream: true,
      }),
    });

    const secondRes = await Promise.race([
      app.fetch(secondReq),
      new Promise<Response>((_, reject) => {
        setTimeout(
          () => reject(new Error("per-chat lock was not released")),
          1000,
        );
      }),
    ]);
    assert.strictEqual(secondRes.status, 200);
    assert.match(await secondRes.text(), /after lock/);
    assert.strictEqual(completionCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.resolve();
  }
});

test("Chat Completions returns a JSON chat.completion object for non-streaming requests", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/v2/chat/completions")) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}]}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  await Promise.resolve();

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.object, "chat.completion");
    assert.strictEqual(body.choices[0].message.role, "assistant");
    assert.strictEqual(body.choices[0].message.content, "Hello");
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.resolve();
  }
});

test("API Key protection", async () => {
  // Save original values
  const originalEnvKey = process.env.API_KEY;

  // Set API key directly in env (middleware reads process.env.API_KEY at runtime)
  process.env.API_KEY = "test-api-key";

  try {
    // 1. Test request without API Key
    const req1 = new Request("http://localhost/v1/models");
    const res1 = await app.fetch(req1);
    assert.strictEqual(
      res1.status,
      401,
      "Should return 401 Unauthorized without API Key",
    );

    // 2. Test request with wrong API Key
    const req2 = new Request("http://localhost/v1/models", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    const res2 = await app.fetch(req2);
    assert.strictEqual(
      res2.status,
      401,
      "Should return 401 Unauthorized with wrong API Key",
    );

    // 3. Test request with correct API Key
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 });

    try {
      const req3 = new Request("http://localhost/v1/models", {
        headers: { Authorization: "Bearer test-api-key" },
      });
      const res3 = await app.fetch(req3);
      assert.strictEqual(
        res3.status,
        200,
        "Should return 200 OK with correct API Key",
      );

      // 4. Anthropic-style x-api-key also authenticates
      const req4 = new Request("http://localhost/v1/models", {
        headers: { "x-api-key": "test-api-key" },
      });
      const res4 = await app.fetch(req4);
      assert.strictEqual(
        res4.status,
        200,
        "Should return 200 OK with correct x-api-key",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    process.env.API_KEY = originalEnvKey;
  }
});

test("Chat Completions endpoint - Non-streaming (stream: false)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "qwen3.6-plus", owned_by: "qwen" }] }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v2/chat/completions")) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_thought": {"content": ["Thinking non-stream..."]}}}}], "usage": {"input_tokens": 23, "output_tokens": 56, "total_tokens": 79, "input_tokens_details": {"text_tokens": 23}, "output_tokens_details": {"reasoning_tokens": 54, "text_tokens": 56}, "prompt_tokens_details": {"cached_tokens": 1}}}\n\n',
            ),
          );
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "answer", "content": "Hello non-stream"}}], "usage": {"input_tokens": 23, "output_tokens": 60, "total_tokens": 83, "input_tokens_details": {"text_tokens": 23}, "output_tokens_details": {"reasoning_tokens": 54, "text_tokens": 60}, "prompt_tokens_details": {"cached_tokens": 1}}}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  await Promise.resolve();

  try {
    const payload = {
      model: "qwen3.6-plus",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    };

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get("Content-Type")?.includes("application/json"));

    const body = await res.json();
    assert.strictEqual(body.object, "chat.completion");
    assert.strictEqual(body.model, "qwen3.6-plus");
    assert.ok(body.choices);
    assert.strictEqual(body.choices.length, 1);

    const choice = body.choices[0];
    assert.strictEqual(choice.message.role, "assistant");
    assert.strictEqual(choice.message.content, "Hello non-stream");
    assert.strictEqual(
      choice.message.reasoning_content,
      "Thinking non-stream...",
    );
    assert.strictEqual(choice.finish_reason, "stop");

    assert.ok(body.usage);
    assert.strictEqual(body.usage.prompt_tokens, 23);
    assert.strictEqual(body.usage.completion_tokens, 60);
    assert.strictEqual(body.usage.total_tokens, 83);
    assert.strictEqual(body.usage.prompt_tokens_details.cached_tokens, 1);
    assert.strictEqual(body.usage.prompt_tokens_details.text_tokens, 23);
    assert.strictEqual(
      body.usage.completion_tokens_details.reasoning_tokens,
      54,
    );
    assert.strictEqual(body.usage.completion_tokens_details.text_tokens, 60);
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.resolve();
  }
});
