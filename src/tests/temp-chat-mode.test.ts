import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

import { app } from "../api/server.js";
import { buildFinalContext } from "../routes/chat/context.ts";
import { buildChatNewBody } from "../services/qwen.ts";

/**
 * The "temp" conversation mode (QWEN_CHAT_MODE=temp / X-QwenProxy-Chat-Mode:
 * temp) always creates a NEW ephemeral Qwen chat (chat_mode:"local") for every
 * request and sends the FULL history inline (OpenAI standard). It must NEVER
 * reuse a thread, even when the client provides a session_id or a continuation
 * history.
 */
test("temp mode: buildFinalContext never reuses a thread and always sends the full history", async () => {
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "continue" },
  ] as any[];

  const ctx = await buildFinalContext({
    messages,
    systemPrompt: "",
    toolInstructions: "",
    prompt: "FULL_HISTORY",
    currentPrompt: "DELTA",
    modelId: "qwen3.7-plus",
    enableThinking: false,
    conversationKey: "explicit-session-id",
    hasExplicitConversationKey: true,
    chatMode: "temp",
  });

  assert.equal(ctx.chatMode, "temp");
  assert.equal(ctx.isNewSession, true);
  assert.equal(ctx.allowThreadReuse, false);
  assert.equal(ctx.sessionId, null);
  assert.equal(ctx.existingThread, false);
  assert.equal(ctx.updateLogicalThread, false);
  assert.equal(
    ctx.finalPrompt,
    "FULL_HISTORY",
    "temp mode must send the full history, never the delta",
  );
});

test("buildChatNewBody: thread → normal, temp → local", () => {
  assert.equal(buildChatNewBody("qwen3.7-plus").chat_mode, "normal");
  assert.equal(buildChatNewBody("qwen3.7-plus", "temp").chat_mode, "local");
  assert.equal(buildChatNewBody("qwen3.7-plus", "thread").chat_mode, "normal");
});

/** Intercept the completions POST (browser-relay fetch in mock mode) and return a short SSE. */
function installCompletionCapture() {
  const originalFetch = globalThis.fetch;
  let capturedBody = "";
  let completionCalls = 0;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : "url" in input
          ? input.url
          : String(input);

    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "qwen3.6-plus", owned_by: "qwen" }] }),
        { status: 200 },
      );
    }

    if (url.includes("/api/v2/chat/completions")) {
      completionCalls++;
      capturedBody = init?.body != null ? String(init.body) : "";
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices": [{"delta": {"phase": "answer", "content": "ok"}}]}\n\n',
            ),
          );
          controller.enqueue(
            encoder.encode(
              'data: {"choices": [{"delta": {"phase": "answer", "status": "finished"}}]}\n\n',
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }

    return originalFetch(input, init);
  };

  return {
    body: () => capturedBody,
    completionCalls: () => completionCalls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

const TEMP_HEADERS = {
  "Content-Type": "application/json",
  "x-qwenproxy-chat-mode": "temp",
};

test("temp mode header: completions payload uses chat_mode:local, no parent, full history", async () => {
  const mock = installCompletionCapture();
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: TEMP_HEADERS,
        body: JSON.stringify({
          model: "qwen3.6-plus",
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: "hi" },
            { role: "user", content: "continue" },
          ],
          stream: true,
        }),
      }),
    );

    assert.strictEqual(res.status, 200);
    await res.text();

    assert.strictEqual(mock.completionCalls(), 1);
    const body = JSON.parse(mock.body());
    assert.equal(body.chat_mode, "local", "temp mode must send chat_mode:local");
    assert.equal(body.parent_id, null, "temp mode never reuses a parent");
    assert.equal(body.messages?.[0]?.parent_id, null);
    const content = body.messages?.[0]?.content ?? "";
    assert.ok(content.includes("first"), "full history must include the first user message");
    assert.ok(content.includes("hi"), "full history must include the assistant message");
    assert.ok(content.includes("continue"), "full history must include the trailing user message");
  } finally {
    mock.restore();
  }
});

test("default thread mode: completions payload uses chat_mode:normal", async () => {
  const mock = installCompletionCapture();
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      }),
    );

    assert.strictEqual(res.status, 200);
    await res.text();

    assert.strictEqual(mock.completionCalls(), 1);
    const body = JSON.parse(mock.body());
    assert.equal(body.chat_mode, "normal", "thread mode must send chat_mode:normal");
  } finally {
    mock.restore();
  }
});
