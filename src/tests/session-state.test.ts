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

test("createQwenStream matches the latest browser completion payload", async () => {
  const originalFetch = globalThis.fetch;
  let capturedPayload: any;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : "url" in input
          ? input.url
          : String(input);
    if (url.includes("/api/v2/chat/completions")) {
      capturedPayload = JSON.parse(String(init?.body || "{}"));
      return createMockStreamResponse();
    }
    return originalFetch(input, init);
  };

  try {
    const result = await createQwenStream(
      "Canonical payload",
      false,
      "qwen3.7-plus",
      null,
      "canonical-payload-account",
      undefined,
      { chatSessionId: "canonical-payload-chat" },
    );

    assert.equal(capturedPayload.chatId, "canonical-payload-chat");
    assert.equal(capturedPayload.parentId, "");
    assert.equal(capturedPayload.messages[0].id, null);
    assert.equal(capturedPayload.messages[0].model, "");
    assert.equal(capturedPayload.messages[0].childrenIds.length, 1);
    assert.equal(capturedPayload.messages[0].feature_config.auto_search, true);
    await result.stream.cancel();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createQwenStream retries an HTML WAF response once with fresh headers", async () => {
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
        return new Response(
          '<!doctype html><meta name="aliyun_waf_aa" content="challenge">',
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      return createMockStreamResponse();
    }
    return originalFetch(input, init);
  };

  try {
    const result = await createQwenStream(
      "Retry WAF response",
      false,
      "qwen3.7-plus",
      null,
      "waf-response-account",
      undefined,
      { chatSessionId: "waf-response-chat" },
    );

    assert.strictEqual(completionRequests, 2);
    await result.stream.cancel();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createQwenStream sanitizes a persistent HTML WAF challenge", async () => {
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
      return new Response(
        '<!doctype html><meta name="aliyun_waf_aa" content="do-not-expose-this-page">',
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }
    return originalFetch(input, init);
  };

  try {
    await assert.rejects(
      () =>
        createQwenStream(
          "Persistent WAF response",
          false,
          "qwen3.7-plus",
          null,
          "persistent-waf-account",
          undefined,
          { chatSessionId: "persistent-waf-chat" },
        ),
      (error: any) => {
        assert.strictEqual(error.upstreamCode, "waf_challenge");
        assert.match(error.message, /anti-bot challenge/i);
        assert.doesNotMatch(error.message, /aliyun_waf|do-not-expose-this-page/i);
        return true;
      },
    );
    assert.strictEqual(completionRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
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
