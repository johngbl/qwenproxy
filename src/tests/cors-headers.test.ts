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
