/**
 * Copyright (c) 2025 johngbl
 * QwenBridge - OpenAI-compatible proxy for Qwen
 */

import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  clearAllSessionsForAccount,
  createQwenStream,
  updateSessionParent,
} from "../services/qwen.ts";

function createMockStreamResponse() {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("clearAllSessionsForAccount only clears matching account sessions", async () => {
  const originalFetch = globalThis.fetch;
  const originalSessionId = process.env.TEST_SESSION_ID;
  const capturedParents: Array<string | null> = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : "url" in input
          ? input.url
          : String(input);
    if (url.includes("/api/v2/chat/completions")) {
      const payload = JSON.parse((init?.body as string) || "{}");
      capturedParents.push(payload.parent_id ?? null);
      return createMockStreamResponse();
    }
    return originalFetch(input, init);
  };

  try {
    updateSessionParent("session-acc-a", "parent-a", "acc-a");
    updateSessionParent("session-acc-b", "parent-b", "acc-b");

    clearAllSessionsForAccount("acc-a");

    process.env.TEST_SESSION_ID = "session-acc-a";
    const streamA = await createQwenStream(
      "Prompt A",
      true,
      "qwen3.6-plus",
      undefined,
      "acc-a",
    );
    await streamA.stream.cancel();

    process.env.TEST_SESSION_ID = "session-acc-b";
    const streamB = await createQwenStream(
      "Prompt B",
      true,
      "qwen3.6-plus",
      undefined,
      "acc-b",
    );
    await streamB.stream.cancel();

    assert.deepStrictEqual(capturedParents, [null, "parent-b"]);
  } finally {
    clearAllSessionsForAccount("acc-a");
    clearAllSessionsForAccount("acc-b");
    globalThis.fetch = originalFetch;
    if (originalSessionId === undefined) {
      delete process.env.TEST_SESSION_ID;
    } else {
      process.env.TEST_SESSION_ID = originalSessionId;
    }
  }
});

test("createQwenStream retries an empty successful response with fresh headers", async () => {
  const originalFetch = globalThis.fetch;
  let completionRequests = 0;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : "url" in input
          ? input.url
          : String(input);

    if (url.includes("/api/v2/chat/completions")) {
      completionRequests++;
      if (completionRequests === 1) {
        return new Response(null, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }
      return createMockStreamResponse();
    }
    return originalFetch(input, init);
  };

  try {
    const result = await createQwenStream(
      "Retry empty response",
      true,
      "qwen3.6-plus",
      undefined,
      "empty-response-account",
      undefined,
      { chatSessionId: "empty-response-chat" },
    );

    assert.strictEqual(completionRequests, 2);
    assert.strictEqual(result.headers.cookie, "token=mock");
    await result.stream.cancel();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
