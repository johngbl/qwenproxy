import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_PLAYWRIGHT = "true";

import { app } from "../api/server.js";

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

test("non-stream: leaked <think> tags are moved to reasoning_content", async () => {
  const restore = setupFetchMock(() => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            'data: {"choices": [{"delta": {"phase": "answer", "content": "<think>internal plan</think>Visible answer"}}]}\n\n',
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
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    const message = body.choices[0].message;
    assert.strictEqual(message.content, "Visible answer");
    assert.strictEqual(message.reasoning_content, "internal plan");
    assert.ok(!message.content.includes("<think>"));
  } finally {
    restore();
  }
});

test("stream: leaked <think> tags split across chunks are sanitized", async () => {
  const restore = setupFetchMock(() => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            'data: {"choices": [{"delta": {"phase": "answer", "content": "<thi"}}]}\n\n',
          ),
        );
        c.enqueue(
          new TextEncoder().encode(
            'data: {"choices": [{"delta": {"phase": "answer", "content": "<think>internal"}}]}\n\n',
          ),
        );
        c.enqueue(
          new TextEncoder().encode(
            'data: {"choices": [{"delta": {"phase": "answer", "content": "<think>internal plan</think>Vis"}}]}\n\n',
          ),
        );
        c.enqueue(
          new TextEncoder().encode(
            'data: {"choices": [{"delta": {"phase": "answer", "content": "<think>internal plan</think>Visible answer"}}]}\n\n',
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
    assert.strictEqual(res.status, 200);

    const reader = res.body?.getReader();
    assert.ok(reader, "Response should have a readable body");

    const decoder = new TextDecoder();
    let content = "";
    let reasoning = "";

    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);

      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        try {
          const data = JSON.parse(line.slice(6));
          const delta = data.choices?.[0]?.delta;
          if (typeof delta?.content === "string") {
            content += delta.content;
          }
          if (typeof delta?.reasoning_content === "string") {
            reasoning += delta.reasoning_content;
          }
        } catch {
          // Ignore heartbeat/comments and partial data
        }
      }
    }

    assert.strictEqual(content, "Visible answer");
    assert.strictEqual(reasoning, "internal plan");
    assert.ok(!content.includes("<think>"));
  } finally {
    restore();
  }
});

test("non-stream: unclosed abc<think> tag is preserved as literal content", async () => {
  const restore = setupFetchMock(() => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            'data: {"choices": [{"delta": {"phase": "answer", "content": "abc<think>internal plan"}}]}\n\n',
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
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    const message = body.choices[0].message;
    assert.strictEqual(message.content, "abc<think>internal plan");
    assert.strictEqual(message.reasoning_content, undefined);
  } finally {
    restore();
  }
});

test("stream: unclosed <think> tag split across chunks stays literal", async () => {
  const restore = setupFetchMock(() => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            'data: {"choices": [{"delta": {"phase": "answer", "content": "<thi"}}]}\n\n',
          ),
        );
        c.enqueue(
          new TextEncoder().encode(
            'data: {"choices": [{"delta": {"phase": "answer", "content": "<think>internal"}}]}\n\n',
          ),
        );
        c.enqueue(
          new TextEncoder().encode(
            'data: {"choices": [{"delta": {"phase": "answer", "content": "<think>internal plan"}}]}\n\n',
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
    assert.strictEqual(res.status, 200);

    const reader = res.body?.getReader();
    assert.ok(reader, "Response should have a readable body");

    const decoder = new TextDecoder();
    let content = "";
    let reasoning = "";

    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);

      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        try {
          const data = JSON.parse(line.slice(6));
          const delta = data.choices?.[0]?.delta;
          if (typeof delta?.content === "string") {
            content += delta.content;
          }
          if (typeof delta?.reasoning_content === "string") {
            reasoning += delta.reasoning_content;
          }
        } catch {
          // Ignore heartbeat/comments and partial data
        }
      }
    }

    assert.strictEqual(content, "<think>internal plan");
    assert.strictEqual(reasoning, "");
  } finally {
    restore();
  }
});
