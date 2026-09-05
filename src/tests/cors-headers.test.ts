import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

import { app } from "../api/server.js";

test("OPTIONS preflight returns 204 with CORS headers (no auth required)", async () => {
  const res = await app.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    }),
  );

  assert.strictEqual(res.status, 204);
  assert.strictEqual(res.headers.get("access-control-allow-origin"), "*");
  assert.ok(
    res.headers
      .get("access-control-allow-methods")
      ?.includes("POST"),
  );
  assert.ok(
    res.headers.get("access-control-allow-headers")?.includes("Authorization"),
  );
});

test("every response carries OpenAI-shaped headers (doc §5.2)", async () => {
  const res = await app.fetch(new Request("http://localhost/health"));

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("openai-version"), "2020-10-01");
  assert.ok(
    /^\d+$/.test(res.headers.get("openai-processing-ms") || ""),
    "openai-processing-ms should be a number",
  );
  assert.ok(res.headers.get("x-request-id"), "x-request-id present");
  assert.strictEqual(res.headers.get("x-ratelimit-limit-requests"), "5000");
  assert.strictEqual(res.headers.get("x-ratelimit-remaining-requests"), "4999");
  assert.strictEqual(res.headers.get("x-ratelimit-reset-requests"), "0");
  assert.strictEqual(res.headers.get("x-ratelimit-limit-tokens"), "200000");
  assert.strictEqual(res.headers.get("x-ratelimit-remaining-tokens"), "199999");
  assert.strictEqual(res.headers.get("x-ratelimit-reset-tokens"), "0");
  assert.strictEqual(res.headers.get("access-control-allow-origin"), "*");
});

test("paths without /v1 redirect (308, preserves method) to the /v1 routes", async () => {
  const completions = await app.fetch(
    new Request("http://localhost/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", prompt: "hi" }),
      redirect: "manual",
    }),
  );
  assert.strictEqual(completions.status, 308);
  assert.strictEqual(completions.headers.get("location"), "/v1/completions");

  const chat = await app.fetch(
    new Request("http://localhost/chat/completions", {
      method: "POST",
      body: "{}",
      redirect: "manual",
    }),
  );
  assert.strictEqual(chat.status, 308);
  assert.strictEqual(chat.headers.get("location"), "/v1/chat/completions");

  const responses = await app.fetch(
    new Request("http://localhost/responses", {
      method: "POST",
      body: "{}",
      redirect: "manual",
    }),
  );
  assert.strictEqual(responses.status, 308);
  assert.strictEqual(responses.headers.get("location"), "/v1/responses");

  const models = await app.fetch(
    new Request("http://localhost/models", { redirect: "manual" }),
  );
  assert.strictEqual(models.status, 308);
  assert.strictEqual(models.headers.get("location"), "/v1/models");
});

test("streaming endpoints carry anti-buffering headers (X-Accel-Buffering and no-transform)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr =
      typeof input === "string" ? input : "url" in input ? input.url : String(input);
    if (urlStr.includes("/v1/chat/completions")) {
      return app.fetch(new Request("http://localhost/v1/chat/completions", init));
    }
    if (urlStr.includes("chat.qwen.ai")) {
      if (urlStr.includes("/api/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "qwen3.7-plus", owned_by: "qwen" }] }),
          { status: 200 },
        );
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n',
              ),
            );
            controller.close();
          },
        }),
        { status: 200 },
      );
    }
    return originalFetch(input, init);
  };

  try {
    // 1. OpenAI Chat Completions stream
    const chatRes = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.7-plus",
          messages: [{ role: "user", content: "ping" }],
          stream: true,
        }),
      }),
    );
    assert.strictEqual(chatRes.status, 200);
    assert.strictEqual(chatRes.headers.get("x-accel-buffering"), "no");
    assert.strictEqual(chatRes.headers.get("cache-control"), "no-cache, no-transform");

    // 2. Anthropic Messages stream
    const anthropicRes = await app.fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "sk-dummy",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-3-7-sonnet-20250219",
          max_tokens: 100,
          messages: [{ role: "user", content: "ping" }],
          stream: true,
        }),
      }),
    );
    assert.strictEqual(anthropicRes.status, 200);
    assert.strictEqual(anthropicRes.headers.get("x-accel-buffering"), "no");
    assert.strictEqual(anthropicRes.headers.get("cache-control"), "no-cache, no-transform");

    // Consume streams while fetch mock is still active
    await chatRes.text();
    await anthropicRes.text();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
