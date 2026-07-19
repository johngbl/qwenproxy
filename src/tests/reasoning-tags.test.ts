/**
 * Copyright (c) 2025 johngbl
 * QwenBridge - OpenAI-compatible proxy for Qwen
 */

import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { app } from "../api/server.js";
import { StreamingReasoningTagSanitizer } from "../utils/reasoning-tags.ts";

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

test("sanitizer: preserves literal think tags in inline Markdown code", () => {
  const sanitizer = new StreamingReasoningTagSanitizer();
  const parsed = sanitizer.feed(
    'Before `<think>literal</think>` after <think>hidden</think> done',
  );
  const flushed = sanitizer.flush();

  assert.strictEqual(
    parsed.text + flushed.text,
    'Before `<think>literal</think>` after  done',
  );
  assert.strictEqual(parsed.reasoning + flushed.reasoning, "hidden");
  assert.strictEqual(parsed.detectedThinkTag, true);
  assert.strictEqual(parsed.hadMalformedTag, false);
});

test("sanitizer: preserves fenced-code tags split across chunks", () => {
  const sanitizer = new StreamingReasoningTagSanitizer();
  const first = sanitizer.feed('`');
  const second = sanitizer.feed('``xml\n<thi');
  const third = sanitizer.feed(
    'nk>literal</think>\n<tool_call>literal</tool_call>\n```\nVisible<think>hidden</think>',
  );
  const flushed = sanitizer.flush();

  const text = first.text + second.text + third.text + flushed.text;
  const reasoning =
    first.reasoning + second.reasoning + third.reasoning + flushed.reasoning;
  assert.strictEqual(
    text,
    '```xml\n<think>literal</think>\n<tool_call>literal</tool_call>\n```\nVisible',
  );
  assert.strictEqual(reasoning, "hidden");
  assert.ok(text.includes("<think>literal</think>"));
  assert.ok(text.includes("<tool_call>literal</tool_call>"));
});

test("sanitizer: nested and split think tags remain reasoning", () => {
  const sanitizer = new StreamingReasoningTagSanitizer();
  const first = sanitizer.feed("prefix<think>outer<thi");
  const second = sanitizer.feed("nk>inner</think>tail</think>answer");
  const flushed = sanitizer.flush();

  assert.strictEqual(first.text, "prefix");
  assert.strictEqual(first.reasoning, "outer");
  assert.strictEqual(second.text, "answer");
  assert.strictEqual(second.reasoning, "innertail");
  assert.strictEqual(second.detectedThinkTag, true);
  assert.strictEqual(second.hadMalformedTag, true);
  assert.strictEqual(flushed.text, "");
  assert.strictEqual(flushed.reasoning, "");
  assert.ok(!(first.text + second.text).includes("<think>"));
});

test("sanitizer: stray close and unclosed nested tags fail closed", () => {
  const sanitizer = new StreamingReasoningTagSanitizer();
  const parsed = sanitizer.feed(
    "visible</think>safe<think>hidden<think>nested",
  );
  const flushed = sanitizer.flush();

  assert.strictEqual(parsed.text, "visiblesafe");
  assert.strictEqual(parsed.reasoning, "hiddennested");
  assert.strictEqual(parsed.detectedThinkTag, true);
  assert.strictEqual(parsed.hadMalformedTag, true);
  assert.strictEqual(flushed.detectedThinkTag, true);
  assert.strictEqual(flushed.hadMalformedTag, true);
  assert.strictEqual(flushed.hadUnclosedTag, true);
  assert.ok(!parsed.text.includes("think"));
});

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

test("non-stream: literal think/tool tags inside fenced code stay visible", async () => {
  const code =
    'Example:\n```xml\n<think>literal</think>\n<tool_call>literal</tool_call>\n```';
  const restore = setupFetchMock(() => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { phase: "answer", content: code } }] })}\n\n`,
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
        messages: [{ role: "user", content: "show markup" }],
        stream: false,
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const message = body.choices[0].message;
    assert.strictEqual(message.content, code);
    assert.strictEqual(message.reasoning_content, undefined);
    assert.strictEqual(message.tool_calls, undefined);
  } finally {
    restore();
  }
});

test("non-stream: reasoning-contaminated tool block is not parsed or exposed", async () => {
  const restore = setupFetchMock(() => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>junk"}}]}\n\n',
                  ),
                );
                c.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>junk<think>secret</think></tool_call>Visible answer"}}]}\n\n',
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
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
              },
            },
          },
        ],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const message = body.choices[0].message;
    assert.strictEqual(message.content, "Visible answer");
        assert.strictEqual(message.reasoning_content, undefined);
        assert.strictEqual(message.tool_calls, undefined);
    assert.ok(!message.content.includes("tool_call"));
    assert.ok(!message.content.includes("think"));
  } finally {
    restore();
  }
});

test("non-stream: valid tool call wrapped in think is still executed", async () => {
  const toolBlock =
    '<think><tool_call>{"name":"grep","arguments":{"regex":"thinking","include_pattern":"src/**/*.ts"}}</tool_call></think>';
  const restore = setupFetchMock(() => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { phase: "answer", content: toolBlock } }] })}\n\n`,
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
        messages: [{ role: "user", content: "analyze" }],
        stream: false,
        tools: [
          {
            type: "function",
            function: {
              name: "grep",
              parameters: {
                type: "object",
                properties: {
                  regex: { type: "string" },
                  include_pattern: { type: "string" },
                },
              },
            },
          },
        ],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const message = body.choices[0].message;
    assert.strictEqual(message.content, null);
    assert.strictEqual(message.tool_calls.length, 1);
    assert.strictEqual(message.tool_calls[0].function.name, "grep");
    assert.deepStrictEqual(
      JSON.parse(message.tool_calls[0].function.arguments),
      { regex: "thinking", include_pattern: "src/**/*.ts" },
    );
  } finally {
    restore();
  }
});

test("stream: literal think tag inside active tool arguments is preserved", async () => {
  const firstContent =
    '<tool_call>{"name":"grep","arguments":{"regex":"mapResponsesModel|';
  const fullContent =
    firstContent +
    '<think>|thinking","include_pattern":"src/**/*.ts"}}</tool_call>';
  const restore = setupFetchMock(() => {
    const stream = new ReadableStream({
      start(c) {
        for (const content of [firstContent, fullContent]) {
          c.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { phase: "answer", content } }] })}\n\n`,
            ),
          );
        }
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
        messages: [{ role: "user", content: "analyze" }],
        stream: true,
        tools: [
          {
            type: "function",
            function: {
              name: "grep",
              parameters: {
                type: "object",
                properties: {
                  regex: { type: "string" },
                  include_pattern: { type: "string" },
                },
              },
            },
          },
        ],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    let toolName = "";
    let argumentChunks = "";
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const event = JSON.parse(line.slice(6));
      const toolDelta = event.choices?.[0]?.delta?.tool_calls?.[0]?.function;
      if (toolDelta?.name) toolName = toolDelta.name;
      if (typeof toolDelta?.arguments === "string") {
        argumentChunks += toolDelta.arguments;
      }
    }

    assert.strictEqual(toolName, "grep");
    assert.deepStrictEqual(JSON.parse(argumentChunks), {
      regex: "mapResponsesModel|<think>|thinking",
      include_pattern: "src/**/*.ts",
    });
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

test("non-stream: unclosed abc<think> tag fails closed into reasoning", async () => {
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
    assert.strictEqual(message.content, "abc");
        assert.strictEqual(message.reasoning_content, "internal plan");
        assert.ok(!message.content.includes("<think>"));
  } finally {
    restore();
  }
});

test("stream: unclosed <think> tag split across chunks fails closed", async () => {
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

    assert.strictEqual(content, "");
        assert.strictEqual(reasoning, "internal plan");
        assert.ok(!content.includes("<think>"));
  } finally {
    restore();
  }
});
