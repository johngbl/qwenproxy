import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { app } from "../api/server.ts";

const modelsPayload = {
  data: [
    {
      id: "qwen-test-model",
      owned_by: "qwen",
      info: {
        created_at: 123,
        meta: { max_context_length: 4096 },
      },
    },
  ],
};

function installModelsFetchMock(): typeof globalThis.fetch {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/models")) {
      return new Response(JSON.stringify(modelsPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
  return originalFetch;
}

test("models endpoint returns ETag and supports 304", async () => {
  const originalFetch = installModelsFetchMock();
  try {
    const first = await app.fetch(new Request("http://localhost/v1/models"));
    assert.equal(first.status, 200);
    const etag = first.headers.get("etag");
    assert.ok(etag, "ETag should be set");

    const body = (await first.json()) as any;
    assert.equal(body.object, "list");
    assert.ok(body.data.some((model: any) => model.id === "qwen-test-model"));
    assert.ok(
      body.data.some(
        (model: any) => model.id === "qwen-test-model-no-thinking",
      ),
      "synthetic no-thinking variant should be listed",
    );

    const second = await app.fetch(
      new Request("http://localhost/v1/models", {
        headers: { "If-None-Match": etag! },
      }),
    );
    assert.equal(second.status, 304);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("models endpoint returns Anthropic format with thinking variants when anthropic-version is set", async () => {
  const originalFetch = installModelsFetchMock();
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/models", {
        headers: { "anthropic-version": "2023-06-01" },
      }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.has_more, false);
    assert.ok(body.data.some((m: any) => m.id === "qwen-test-model"));
    assert.ok(
      body.data.some((m: any) => m.id === "qwen-test-model-thinking"),
      "Anthropic models list should include thinking variants",
    );
    assert.equal(
      body.data.find((m: any) => m.id === "qwen-test-model").type,
      "model",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("models endpoint returns a single model and 404 for missing model", async () => {
  const originalFetch = installModelsFetchMock();
  try {
    const found = await app.fetch(
      new Request("http://localhost/v1/models/qwen-test-model"),
    );
    assert.equal(found.status, 200);
    const model = (await found.json()) as any;
    assert.equal(model.id, "qwen-test-model");

    const missing = await app.fetch(
      new Request("http://localhost/v1/models/not-a-model"),
    );
    assert.equal(missing.status, 404);
    const error = (await missing.json()) as any;
    assert.equal(error.error.code, "resource_not_found");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
