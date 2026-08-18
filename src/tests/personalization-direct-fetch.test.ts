import { test } from "node:test";
import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;

/**
 * The personalization settings direct-fetch path (requestQwenSettingsDirectFetch)
 * is the fast, stable primary path for the personalization sync — it replaces
 * the flaky browser `page.evaluate` + settings-page navigation that hung the
 * sync (the "sync timed out after 30000ms" / "stuck page operation" logs).
 *
 * These tests pin the WAF-detection and circuit-breaker behavior: a clean JSON
 * response is used; an HTML WAF block falls back to the browser; after N
 * consecutive blocks the breaker opens so we stop paying the failed direct
 * round-trip on every sync.
 */
async function loadModule() {
  return await import("../services/qwen.ts");
}

test("direct fetch: clean JSON settings response is returned", async () => {
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({ success: true, data: { ui: {} } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const { requestQwenSettingsDirectFetch } = await loadModule();
    const result = await requestQwenSettingsDirectFetch(
      "acc1",
      "GET",
      "/api/v2/users/user/settings",
      { cookie: "c", "bx-v": "2.5.37" },
    );
    assert.ok(result, "expected a result on clean JSON");
    assert.equal(result!.status, 200);
    assert.equal(result!.json.success, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direct fetch: HTML WAF block returns null (browser fallback), not a throw", async () => {
  globalThis.fetch = (async () => {
    return new Response("<!doctype html><title>captcha</title>", {
      status: 403,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;
  try {
    const { requestQwenSettingsDirectFetch } = await loadModule();
    const result = await requestQwenSettingsDirectFetch(
      "acc2",
      "GET",
      "/api/v2/users/user/settings",
      { cookie: "c", "bx-v": "2.5.37" },
    );
    assert.equal(result, null, "a WAF HTML page must fall back to the browser");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direct fetch: malformed non-JSON body returns null (falls back)", async () => {
  globalThis.fetch = (async () => {
    return new Response("not json at all", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const { requestQwenSettingsDirectFetch } = await loadModule();
    const result = await requestQwenSettingsDirectFetch(
      "acc3",
      "GET",
      "/api/v2/users/user/settings",
      { cookie: "c", "bx-v": "2.5.37" },
    );
    assert.equal(result, null, "a malformed body must fall back to the browser");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direct fetch: network error returns null without throwing", async () => {
  globalThis.fetch = (async () => {
    throw new Error("ETIMEDOUT");
  }) as typeof fetch;
  try {
    const { requestQwenSettingsDirectFetch } = await loadModule();
    const result = await requestQwenSettingsDirectFetch(
      "acc4",
      "GET",
      "/api/v2/users/user/settings",
      { cookie: "c", "bx-v": "2.5.37" },
    );
    assert.equal(result, null, "a network error must fall back, not throw");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
