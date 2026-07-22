/**
 * Copyright (c) 2025 johngbl
 * QwenBridge - OpenAI-compatible proxy for Qwen
 */

import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { app } from "../api/server.js";

const TOOLS = [
  {
    type: "function",
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
  {
    type: "function",
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

const FLAT_TOOLS = [
  {
    name: "task",
    description: "Spawn a delegated task",
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

function createSseResponse(events: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(new TextEncoder().encode(`${event}\n\n`));
      }
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, { status: 200 });
}

async function collectStreamResult(res: Response) {
  const reader = res.body?.getReader();
  assert.ok(reader, "Response should have a readable body");

  const decoder = new TextDecoder();
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let toolCallDeltaCount = 0;
  const toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);

    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;

      try {
        const data = JSON.parse(line.slice(6));
        for (const choice of data.choices || []) {
          if (
            choice.finish_reason !== null &&
            choice.finish_reason !== undefined
          ) {
            finishReason = choice.finish_reason;
          }

          const delta = choice.delta;
          if (typeof delta?.content === "string") {
            content += delta.content;
          }
          if (typeof delta?.reasoning_content === "string") {
            reasoning += delta.reasoning_content;
          }

          if (Array.isArray(delta?.tool_calls)) {
            toolCallDeltaCount += delta.tool_calls.length;
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id || "", name: "", arguments: "" };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].name = tc.function.name;
              if (tc.function?.arguments) {
                toolCalls[idx].arguments += tc.function.arguments;
              }
            }
          }
        }
      } catch {
        // Ignore heartbeat/comments and partial data
      }
    }
  }

  return {
    content,
    reasoning,
    finishReason,
    toolCallDeltaCount,
    toolCalls: toolCalls.filter(Boolean),
  };
}

test("non-stream: literal <tool_call> tags are preserved when tools are absent", async () => {
  const literal =
    'Literal <tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call> text';
  const restore = setupFetchMock(() =>
    createSseResponse([
      `data: ${JSON.stringify({
        choices: [{ delta: { phase: "answer", content: literal } }],
      })}`,
    ]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: false,
        messages: [{ role: "user", content: "show tags literally" }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    const message = body.choices[0].message;
    assert.strictEqual(message.content, literal);
    assert.strictEqual(message.tool_calls, undefined);
    assert.strictEqual(body.choices[0].finish_reason, "stop");
  } finally {
    restore();
  }
});

test("stream: literal <tool_call> tags are preserved when tools are absent", async () => {
  const literal =
    'Literal <tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call> text';
  const restore = setupFetchMock(() =>
    createSseResponse([
      `data: ${JSON.stringify({
        choices: [{ delta: { phase: "answer", content: "Literal <tool_" } }],
      })}`,
      `data: ${JSON.stringify({
        choices: [{ delta: { phase: "answer", content: literal } }],
      })}`,
    ]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: true,
        messages: [{ role: "user", content: "show tags literally" }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const result = await collectStreamResult(res);
    assert.strictEqual(result.content, literal);
    assert.strictEqual(result.toolCalls.length, 0);
    assert.strictEqual(result.finishReason, "stop");
  } finally {
    restore();
  }
});

test("stream: literal <tool_call> inside inline code is preserved when tools are present", async () => {
  const literal =
    "Para usar uma ferramenta, eu gero um bloco JSON envolto exatamente nas tags `<tool_call>`. A estrutura é sempre esta:";
  const restore = setupFetchMock(() =>
    createSseResponse([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              phase: "answer",
              content:
                "Para usar uma ferramenta, eu gero um bloco JSON envolto exatamente nas tags `",
            },
          },
        ],
      })}`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              phase: "answer",
              content: "<tool_call>`. A estrutura é sempre esta:",
            },
          },
        ],
      })}`,
    ]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: true,
        tools: TOOLS,
        messages: [{ role: "user", content: "explique tool calls" }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const result = await collectStreamResult(res);
    assert.strictEqual(result.content, literal);
    assert.strictEqual(result.toolCalls.length, 0);
    assert.strictEqual(result.finishReason, "stop");
  } finally {
    restore();
  }
});

test("non-stream: valid tool_call becomes structured tool_calls", async () => {
  const restore = setupFetchMock(() =>
    createSseResponse([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              phase: "answer",
              content:
                'Before <tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call> after',
            },
          },
        ],
      })}`,
    ]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: false,
        tools: TOOLS,
        messages: [{ role: "user", content: "read a file" }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    const message = body.choices[0].message;
    assert.strictEqual(message.content, null);
    assert.strictEqual(message.tool_calls.length, 1);
    assert.strictEqual(message.tool_calls[0].function.name, "read_file");
    assert.deepStrictEqual(
      JSON.parse(message.tool_calls[0].function.arguments),
      { path: "a.txt" },
    );
    assert.strictEqual(body.choices[0].finish_reason, "tool_calls");
  } finally {
    restore();
  }
});

test("non-stream: undeclared tool name in literal example is preserved as text", async () => {
  const literal =
    '<tool_call>{"name":"nome_da_ferramenta","arguments":{"parametro":"valor"}}</tool_call>';
  const restore = setupFetchMock(() =>
    createSseResponse([
      `data: ${JSON.stringify({
        choices: [{ delta: { phase: "answer", content: literal } }],
      })}`,
    ]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: false,
        tools: TOOLS,
        messages: [{ role: "user", content: "explique tool calls" }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    const message = body.choices[0].message;
    assert.strictEqual(message.content, literal);
    assert.strictEqual(message.tool_calls, undefined);
    assert.strictEqual(body.choices[0].finish_reason, "stop");
  } finally {
    restore();
  }
});

test("non-stream: flat tool definitions are treated as declared tools", async () => {
  const restore = setupFetchMock(() =>
    createSseResponse([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              phase: "answer",
              content:
                '<tool_call>{"name":"task","arguments":{"description":"Resume backend analysis","prompt":"Analyze all files"}}</tool_call>',
            },
          },
        ],
      })}`,
    ]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: false,
        tools: FLAT_TOOLS,
        messages: [{ role: "user", content: "delegate the task" }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    const message = body.choices[0].message;
    assert.strictEqual(message.content, null);
    assert.strictEqual(message.tool_calls.length, 1);
    assert.strictEqual(message.tool_calls[0].function.name, "task");
    assert.deepStrictEqual(
      JSON.parse(message.tool_calls[0].function.arguments),
      {
        description: "Resume backend analysis",
        prompt: "Analyze all files",
      },
    );
    assert.strictEqual(body.choices[0].finish_reason, "tool_calls");
  } finally {
    restore();
  }
});

test("stream: fragmented tool_call becomes structured tool_calls", async () => {
  const restore = setupFetchMock(() =>
    createSseResponse([
      `data: ${JSON.stringify({
        choices: [{ delta: { phase: "answer", content: "<tool_" } }],
      })}`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              phase: "answer",
              content: '<tool_call>{"name":"read_file"',
            },
          },
        ],
      })}`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              phase: "answer",
              content:
                '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>',
            },
          },
        ],
      })}`,
    ]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: true,
        tools: TOOLS,
        messages: [{ role: "user", content: "read a file" }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const result = await collectStreamResult(res);
    assert.strictEqual(result.content, "");
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].name, "read_file");
    assert.deepStrictEqual(JSON.parse(result.toolCalls[0].arguments), {
      path: "a.txt",
    });
    assert.strictEqual(result.finishReason, "tool_calls");
  } finally {
    restore();
  }
});

test("stream: write_file arguments are emitted incrementally before tool close", async () => {
  const content1 =
    '<tool_call>{"name":"write_file","arguments":{"path":"index.html","content":"<h1';
  const content2 =
    '<tool_call>{"name":"write_file","arguments":{"path":"index.html","content":"<h1>Hello';
  const content3 =
    '<tool_call>{"name":"write_file","arguments":{"path":"index.html","content":"<h1>Hello</h1>\\n<p>Wor';
  const content4 =
    '<tool_call>{"name":"write_file","arguments":{"path":"index.html","content":"<h1>Hello</h1>\\n<p>World</p>"}}</tool_call>';

  const restore = setupFetchMock(() =>
    createSseResponse([
      `data: ${JSON.stringify({
        choices: [{ delta: { phase: "answer", content: content1 } }],
      })}`,
      `data: ${JSON.stringify({
        choices: [{ delta: { phase: "answer", content: content2 } }],
      })}`,
      `data: ${JSON.stringify({
        choices: [{ delta: { phase: "answer", content: content3 } }],
      })}`,
      `data: ${JSON.stringify({
        choices: [{ delta: { phase: "answer", content: content4 } }],
      })}`,
    ]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: true,
        tools: TOOLS,
        messages: [{ role: "user", content: "write a file" }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const result = await collectStreamResult(res);
    assert.strictEqual(result.content, "");
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].name, "write_file");
    assert.ok(
      result.toolCallDeltaCount >= 3,
      `Expected multiple incremental tool call deltas, got ${result.toolCallDeltaCount}`,
    );
    assert.deepStrictEqual(JSON.parse(result.toolCalls[0].arguments), {
      path: "index.html",
      content: "<h1>Hello</h1>\n<p>World</p>",
    });
    assert.strictEqual(result.finishReason, "tool_calls");
  } finally {
    restore();
  }
});

test("non-stream: missing opening tag is recovered when closing tag is present", async () => {
  const restore = setupFetchMock(() =>
    createSseResponse([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              phase: "answer",
              content:
                '{"name":"read_file","arguments":{"arguments":{"path":"a.txt"}}}</tool_call>',
            },
          },
        ],
      })}`,
    ]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: false,
        tools: TOOLS,
        messages: [{ role: "user", content: "read a file" }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    const message = body.choices[0].message;
    assert.strictEqual(message.content, null);
    assert.strictEqual(message.tool_calls.length, 1);
    assert.strictEqual(message.tool_calls[0].function.name, "read_file");
    assert.deepStrictEqual(
      JSON.parse(message.tool_calls[0].function.arguments),
      { path: "a.txt" },
    );
    assert.strictEqual(body.choices[0].finish_reason, "tool_calls");
  } finally {
    restore();
  }
});

test("stream: missing opening tag is recovered when closing tag is present", async () => {
  const restore = setupFetchMock(() =>
    createSseResponse([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              phase: "answer",
              content: '{"name":"read_file"',
            },
          },
        ],
      })}`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              phase: "answer",
              content:
                '{"name":"read_file","arguments":{"arguments":{"path":"a.txt"}}}</tool_call>',
            },
          },
        ],
      })}`,
    ]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: true,
        tools: TOOLS,
        messages: [{ role: "user", content: "read a file" }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const result = await collectStreamResult(res);
    assert.strictEqual(result.content, "");
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].name, "read_file");
    assert.deepStrictEqual(JSON.parse(result.toolCalls[0].arguments), {
      path: "a.txt",
    });
    assert.strictEqual(result.finishReason, "tool_calls");
  } finally {
    restore();
  }
});

test("non-stream: unclosed tool_call is recovered on flush", async () => {
  const restore = setupFetchMock(() =>
    createSseResponse([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              phase: "answer",
              content:
                '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}',
            },
          },
        ],
      })}`,
    ]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: false,
        tools: TOOLS,
        messages: [{ role: "user", content: "read a file" }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    const message = body.choices[0].message;
    assert.strictEqual(message.content, null);
    assert.strictEqual(message.tool_calls.length, 1);
    assert.strictEqual(message.tool_calls[0].function.name, "read_file");
    assert.deepStrictEqual(
      JSON.parse(message.tool_calls[0].function.arguments),
      { path: "a.txt" },
    );
    assert.strictEqual(body.choices[0].finish_reason, "tool_calls");
  } finally {
    restore();
  }
});

test("stream: unclosed tool_call is recovered on flush", async () => {
  const restore = setupFetchMock(() =>
    createSseResponse([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              phase: "answer",
              content:
                '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}',
            },
          },
        ],
      })}`,
    ]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: true,
        tools: TOOLS,
        messages: [{ role: "user", content: "read a file" }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const result = await collectStreamResult(res);
    assert.strictEqual(result.content, "");
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].name, "read_file");
    assert.deepStrictEqual(JSON.parse(result.toolCalls[0].arguments), {
      path: "a.txt",
    });
    assert.strictEqual(result.finishReason, "tool_calls");
  } finally {
    restore();
  }
});

test("stream: malformed nameless tool_call restores lead-in text", async () => {
  const restore = setupFetchMock(() =>
    createSseResponse([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              phase: "answer",
              content:
                'Need tool result: <tool_call>{"arguments":{"path":"a.txt"}}</tool_call>',
            },
          },
        ],
      })}`,
    ]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: true,
        tools: TOOLS,
        messages: [{ role: "user", content: "read a file" }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const result = await collectStreamResult(res);
    assert.ok(
      result.content.startsWith("Need tool result: "),
      `Expected content to start with lead-in text, got: ${result.content}`,
    );
    assert.ok(
      result.content.includes("[ERROR]"),
      `Expected error feedback for malformed tool call, got: ${result.content}`,
    );
    assert.strictEqual(result.toolCalls.length, 0);
    assert.strictEqual(result.finishReason, "stop");
  } finally {
    restore();
  }
});

test("non-stream: XML parameter tool_call is supported", async () => {
  const restore = setupFetchMock(() =>
    createSseResponse([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              phase: "answer",
              content:
                '<tool_call name="read_file"><parameter name="path">a.txt</parameter></tool_call>',
            },
          },
        ],
      })}`,
    ]),
  );

  try {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: false,
        tools: TOOLS,
        messages: [{ role: "user", content: "read a file" }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    const message = body.choices[0].message;
    assert.strictEqual(message.content, null);
    assert.strictEqual(message.tool_calls.length, 1);
    assert.strictEqual(message.tool_calls[0].function.name, "read_file");
    assert.deepStrictEqual(
      JSON.parse(message.tool_calls[0].function.arguments),
      { path: "a.txt" },
    );
    assert.strictEqual(body.choices[0].finish_reason, "tool_calls");
  } finally {
    restore();
  }
});
