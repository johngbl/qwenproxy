import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { app, setCacheForTesting } from "../api/server.js";
import { MemoryCache } from "../cache/memory-cache.js";

delete process.env.API_KEY;

// Fixture reconstructed from a real chat.qwen.ai SSE capture (sanitized: no
// cookies, tokens or fingerprint headers — only the SSE event shapes matter).
// The model "qwen3.6-plus" resolves to enableThinking=true via
// stripThinkingSuffix, so the answer/thinking_summary phases are exercised.

function sse(events: Array<Record<string, unknown> | "[DONE]">): string {
  return events
    .map((e) => (e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`))
    .join("");
}

function answerDelta(content: string, status = "typing") {
  return {
    choices: [
      { delta: { role: "assistant", content, phase: "answer", status } },
    ],
    response_id: "mock-response-id",
  };
}

function setupFetchMockFor(sseBody: string) {
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
      if (urlStr.includes("/api/v2/chats/new")) {
        return new Response(JSON.stringify({ chat_id: "mock-chat-thinking" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(sseBody));
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return originalFetch(input, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function collectStreamDeltas(res: Response): Promise<{
  content: string;
  reasoning: string;
  sawDone: boolean;
}> {
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let content = "";
  let reasoning = "";
  let sawDone = false;

  while (true) {
    const { done, value } = await reader!.read();
    if (done) break;
    for (const line of decoder.decode(value).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const dataStr = trimmed.slice(6);
      if (dataStr === "[DONE]") {
        sawDone = true;
        continue;
      }
      try {
        const data = JSON.parse(dataStr);
        const delta = data.choices?.[0]?.delta;
        if (delta?.content) content += delta.content;
        if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      } catch {
        // ignore partial frames
      }
    }
  }

  return { content, reasoning, sawDone };
}

function buildRequest() {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen3.6-plus",
      messages: [{ role: "user", content: "oi" }],
      stream: true,
    }),
  });
}

test("thinking-summary stream: emits reasoning_content then content", async () => {
  const sseBody = sse([
    {
      choices: [
        {
          delta: {
            role: "assistant",
            content: "",
            phase: "thinking_summary",
            extra: {
              summary_title: {
                content: ["Responding to the casual greeting with warmth"],
              },
              summary_thought: {
                content: [
                  "I recognize the informal tone of the user's message and reply naturally.",
                ],
              },
            },
            status: "typing",
          },
        },
      ],
      response_id: "mock-response-id",
    },
    {
      choices: [
        {
          delta: { role: "assistant", content: "", phase: "thinking_summary", status: "finished" },
        },
      ],
      response_id: "mock-response-id",
    },
    answerDelta("Oi!"),
    answerDelta(" 👋 Como posso"),
    answerDelta(" te ajudar hoje?"),
    answerDelta("", "finished"),
    "[DONE]",
  ]);

  const restore = setupFetchMockFor(sseBody);
  try {
    const res = await app.fetch(buildRequest());
    assert.strictEqual(res.status, 200);

    const { content, reasoning, sawDone } = await collectStreamDeltas(res);

    assert.ok(
      reasoning.includes("Responding to the casual greeting with warmth"),
      `reasoning_content should carry the summary title, got: ${JSON.stringify(reasoning)}`,
    );
    assert.ok(
      reasoning.includes("I recognize the informal tone"),
      `reasoning_content should carry the summary thought, got: ${JSON.stringify(reasoning)}`,
    );

    assert.ok(content.includes("Oi!"), `content should start with greeting, got: ${JSON.stringify(content)}`);
    assert.ok(
      content.includes("te ajudar hoje?"),
      `content should assemble the answer, got: ${JSON.stringify(content)}`,
    );

    assert.ok(!content.includes("Responding to the casual"), "title must not leak into content");
    assert.ok(!reasoning.includes("te ajudar hoje?"), "answer must not leak into reasoning");
    assert.strictEqual(sawDone, true, "stream must terminate with [DONE]");
  } finally {
    restore();
  }
});

test("thinking-summary stream: response.created binds the session id", async () => {
  const cache = new MemoryCache({ prefix: "thinking-created-test:" });
  await cache.connect();
  setCacheForTesting(cache);

  const sseBody = sse([
    {
      "response.created": {
        chat_id: "mock-chat-thinking",
        parent_id: "mock-parent-id",
        response_id: "mock-response-id",
        response_index: "0",
      },
    },
    answerDelta("Olá!"),
    answerDelta("", "finished"),
    "[DONE]",
  ]);

  const restore = setupFetchMockFor(sseBody);
  try {
    const res = await app.fetch(buildRequest());
    assert.strictEqual(res.status, 200);
    const { content, sawDone } = await collectStreamDeltas(res);
    assert.ok(content.includes("Olá!"), `content should be emitted, got: ${JSON.stringify(content)}`);
    assert.strictEqual(sawDone, true);
  } finally {
    restore();
    await cache.close();
    setCacheForTesting(undefined);
  }
});
