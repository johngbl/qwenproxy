import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

import { app } from "../api/server.js";
import { config } from "../core/config.ts";

const INTERNAL_CHAT_URL = `http://127.0.0.1:${config.server.port}/v1/chat/completions`;

const NON_STREAM_CHAT_RESPONSE = {
  id: "chatcmpl-mock-legacy",
  object: "chat.completion",
  created: 1700000000,
  model: "qwen3.6-plus",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Legacy hello" },
      logprobs: null,
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
};

function streamChatResponse() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1700000000,"model":"qwen3.6-plus","choices":[{"index":0,"delta":{"role":"assistant","content":"Legacy "},"logprobs":null,"finish_reason":null}]}\n\n',
        ),
      );
      controller.enqueue(
        encoder.encode(
          'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1700000000,"model":"qwen3.6-plus","choices":[{"index":0,"delta":{"content":"stream"},"logprobs":null,"finish_reason":null}]}\n\n',
        ),
      );
      controller.enqueue(
        encoder.encode(
          'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1700000000,"model":"qwen3.6-plus","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}]}\n\n',
        ),
      );
      controller.enqueue(
        encoder.encode(
          'data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1700000000,"model":"qwen3.6-plus","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

interface CapturedChatRequest {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function installMockFetch(chatHandler: (req: CapturedChatRequest) => Response) {
  const originalFetch = globalThis.fetch;
  const captured: CapturedChatRequest[] = [];
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : "url" in input ? input.url : String(input);
    if (url === INTERNAL_CHAT_URL) {
      const body = JSON.parse(String(init?.body || "{}"));
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers as Record<string, string>) || {})) {
        headers[k] = String(v);
      }
      captured.push({ body, headers });
      return chatHandler(captured[captured.length - 1]);
    }
    return originalFetch(input, init);
  };
  return {
    captured,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function readSse(response: Response): Promise<string[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
}

test("POST /v1/completions (non-stream) maps chat output to text_completion", async () => {
  const mock = installMockFetch(() => {
    return new Response(JSON.stringify(NON_STREAM_CHAT_RESPONSE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          prompt: "Write a tagline.",
          temperature: 0.5,
        }),
      }),
    );

    assert.strictEqual(res.status, 200);
    const body = await res.json();

    assert.ok(body.id.startsWith("cmpl-"), `id should start with cmpl-, got ${body.id}`);
    assert.strictEqual(body.object, "text_completion");
    assert.strictEqual(body.created, 1700000000);
    assert.strictEqual(body.model, "qwen3.6-plus");
    assert.strictEqual(body.choices[0].text, "Legacy hello");
    assert.strictEqual(body.choices[0].index, 0);
    assert.strictEqual(body.choices[0].logprobs, null);
    assert.strictEqual(body.choices[0].finish_reason, "stop");
    assert.deepStrictEqual(body.usage, {
      prompt_tokens: 5,
      completion_tokens: 3,
      total_tokens: 8,
    });

    // The internal chat dispatch received the adapted body.
    assert.strictEqual(mock.captured.length, 1);
    const chatBody = mock.captured[0].body;
    assert.strictEqual(chatBody.model, "qwen3.6-plus");
    assert.deepStrictEqual(chatBody.messages, [
      { role: "user", content: "Write a tagline." },
    ]);
    assert.strictEqual(chatBody.stream, false);
    assert.strictEqual(chatBody.temperature, 0.5);
  } finally {
    mock.restore();
  }
});

test("POST /v1/completions joins array prompts with newlines", async () => {
  const mock = installMockFetch(() => {
    return new Response(JSON.stringify(NON_STREAM_CHAT_RESPONSE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          prompt: ["first", "second", 3],
        }),
      }),
    );
    assert.strictEqual(res.status, 200);
    const chatBody = mock.captured[0].body;
    const messages = chatBody.messages as Array<{ content: string }>;
    assert.strictEqual(messages[0].content, "first\nsecond\n3");
  } finally {
    mock.restore();
  }
});

test("POST /v1/completions (stream) translates SSE chunks to text_completion", async () => {
  const mock = installMockFetch(() => streamChatResponse());

  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          prompt: "stream me",
          stream: true,
        }),
      }),
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "text/event-stream");

    const events = await readSse(res);
    assert.ok(events.some((e) => e === "[DONE]"), "[DONE] sentinel required");
    const parsed = events
      .filter((e) => e !== "[DONE]")
      .map((e) => JSON.parse(e));

    // Content deltas map to choices[0].text
    const deltas = parsed.filter(
      (p) => p.choices?.length && p.choices[0].text,
    );
    assert.strictEqual(deltas.length, 2);
    assert.strictEqual(deltas[0].choices[0].text, "Legacy ");
    assert.strictEqual(deltas[1].choices[0].text, "stream");
    for (const d of deltas) {
      assert.strictEqual(d.object, "text_completion");
      assert.ok(d.id.startsWith("cmpl-"));
      assert.strictEqual(d.choices[0].index, 0);
      assert.strictEqual(d.choices[0].finish_reason, null);
    }

    // Finish chunk carries the finish_reason with empty text
    const finish = parsed.find(
      (p) => p.choices?.length && p.choices[0].finish_reason,
    );
    assert.ok(finish, "finish chunk should be present");
    assert.strictEqual(finish.choices[0].finish_reason, "stop");
    assert.strictEqual(finish.choices[0].text, "");

    // Usage chunk (empty choices) passes through
    const usageChunk = parsed.find(
      (p) => Array.isArray(p.choices) && p.choices.length === 0 && p.usage,
    );
    assert.ok(usageChunk, "usage chunk should be present");
    assert.deepStrictEqual(usageChunk.usage, {
      prompt_tokens: 5,
      completion_tokens: 3,
      total_tokens: 8,
    });

    assert.strictEqual(mock.captured[0].body.stream, true);
  } finally {
    mock.restore();
  }
});

test("POST /v1/completions validates model and prompt", async () => {
  const mock = installMockFetch(() => {
    return new Response(JSON.stringify(NON_STREAM_CHAT_RESPONSE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    const noModel = await app.fetch(
      new Request("http://localhost/v1/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    assert.strictEqual(noModel.status, 400);
    assert.strictEqual((await noModel.json()).error.type, "invalid_request_error");

    const noPrompt = await app.fetch(
      new Request("http://localhost/v1/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "qwen3.6-plus" }),
      }),
    );
    assert.strictEqual(noPrompt.status, 400);

    // No internal dispatch should have happened for validation failures.
    assert.strictEqual(mock.captured.length, 0);
  } finally {
    mock.restore();
  }
});
