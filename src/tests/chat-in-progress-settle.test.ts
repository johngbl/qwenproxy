import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

import { app } from "../api/server.js";

/**
 * End-to-end guard for the chat_in_progress settle path: the tool loop fires
 * the next turn the instant the previous one completes, and the upstream chat
 * stays "in progress" for a few seconds. The attempt loop must retry the same
 * chat (up to three retries) before any escalation, and a request that hits
 * the transient error repeatedly must still succeed on the next attempt.
 *
 * The mock upstream returns the upstream JSON error for the first N completion
 * calls and a normal stream afterwards.
 */
function installMockFetch(failures = 2) {
  const originalFetch = globalThis.fetch;
  let completionCalls = 0;
  const calls: string[] = [];

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
      calls.push(url);
      if (completionCalls <= failures) {
        // Upstream chat-state error (Qwen keeps the chat "in progress" for a
        // moment after a completed turn). parseQwenJsonError normalizes the
        // message to chat_in_progress.
        return new Response(
          JSON.stringify({
            error: { message: "Qwen: The chat is in progress!" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices": [{"delta": {"phase": "answer", "content": "settled"}}]}\n\n',
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
    completionCalls: () => completionCalls,
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("chat_in_progress twice then success: same-chat retries before escalation", async () => {
  const mock = installMockFetch();
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          session_id: "chat-progress-settle-test",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );

    assert.strictEqual(res.status, 200, "request must survive the settle race");
    const text = await res.text();
    assert.ok(text.includes("settled"), "final attempt should stream normally");
    assert.ok(text.includes("data: [DONE]"), "stream must terminate");

    // Exactly 3 completion calls: 2 transient chat_in_progress + 1 success.
    // More would mean the settle retries were skipped; fewer would mean the
    // transient errors were treated as terminal.
    assert.strictEqual(
      mock.completionCalls(),
      3,
      "expected 2 chat_in_progress failures + 1 success",
    );
  } finally {
    mock.restore();
  }
});

test("chat_in_progress three times then success: the 3rd same-chat retry also avoids escalation", async () => {
  const mock = installMockFetch(3);
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          session_id: "chat-progress-settle-test-3",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );

    assert.strictEqual(res.status, 200, "request must survive a slow settle");
    const text = await res.text();
    assert.ok(text.includes("settled"), "final attempt should stream normally");
    assert.ok(text.includes("data: [DONE]"), "stream must terminate");

    // Exactly 4 completion calls: 3 transient chat_in_progress (settle >6s was
    // observed after huge turns) + 1 success. Escalating earlier would replay
    // the full context on another account instead. The settle window has its
    // own budget inside tryCreateStreamWithRetry (independent of the global
    // RETRY_MAX_ATTEMPTS=3), so all 4 calls happen in the same retry loop.
    assert.strictEqual(
      mock.completionCalls(),
      4,
      "expected 3 chat_in_progress failures + 1 success",
    );
  } finally {
    mock.restore();
  }
});

test("chat_in_progress four times: the settle window is exhausted and the escalation attempt succeeds", async () => {
  const mock = installMockFetch(4);
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          session_id: "chat-progress-settle-test-4",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );

    assert.strictEqual(
      res.status,
      200,
      "request must survive an exhausted settle window",
    );
    const text = await res.text();
    assert.ok(text.includes("settled"), "escalation attempt should stream normally");
    assert.ok(text.includes("data: [DONE]"), "stream must terminate");

    // 5 completion calls: 4 chat_in_progress failures (3 same-chat retries +
    // the 4th triggers the escalation) and the escalation attempt itself
    // succeeds — it gets its own budget instead of dying with the exhausted
    // settle window.
    assert.strictEqual(
      mock.completionCalls(),
      5,
      "expected 4 chat_in_progress failures + 1 escalation success",
    );
  } finally {
    mock.restore();
  }
});
