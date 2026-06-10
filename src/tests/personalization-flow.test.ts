/**
 * Diagnostic test for personalization flow.
 * Tests the header chain: auth-http.ts → playwright.ts → Qwen API
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

// Mock config before imports
process.env.PLAYWRIGHT_ENABLED = "false"; // Use HTTP auth mode for testing
process.env.TEST_MOCK_QWEN_AUTH = "true";

import { config } from "../core/config.ts";

// Save originals
const savedPlaywrightEnabled = config.playwright.enabled;

afterEach(() => {
  (config as any).playwright.enabled = savedPlaywrightEnabled;
});

test("Personalization: getQwenHeaders returns valid header structure", async () => {
  const { getQwenHeaders } = await import("../services/auth-http.ts");

  const result = await getQwenHeaders(false, undefined);

  assert.ok(result.headers, "headers should exist");
  assert.ok(
    typeof result.headers.cookie === "string",
    "cookie should be string",
  );
  assert.ok(
    typeof result.headers["user-agent"] === "string",
    "user-agent should be string",
  );
  assert.ok(
    typeof result.headers["bx-v"] === "string",
    "bx-v should be string",
  );
  assert.strictEqual(result.chatSessionId, "", "chatSessionId should be empty");
  assert.strictEqual(
    result.parentMessageId,
    null,
    "parentMessageId should be null",
  );
});

test("Personalization: getQwenHeaders with forceNew returns fresh headers", async () => {
  const { getQwenHeaders } = await import("../services/auth-http.ts");

  const result1 = await getQwenHeaders(false, undefined);
  const result2 = await getQwenHeaders(true, undefined);

  assert.ok(result2.headers, "headers should exist after forceNew");
  assert.ok(
    typeof result2.headers.cookie === "string",
    "cookie should be string",
  );
});

test("Personalization: syncQwenRequestPersonalization handles 401 gracefully", async () => {
  // This test verifies that syncQwenRequestPersonalization doesn't throw
  // when the API returns 401 — it should return silently (non-fatal)

  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    fetchCallCount++;
    const url =
      typeof args[0] === "string" ? args[0] : args[0]?.toString() || "";

    if (url.includes("/api/v2/users/user/settings/update")) {
      return new Response(
        JSON.stringify({
          success: false,
          request_id: "test-123",
          data: { code: "Unauthorized", details: "401 Não Autorizado" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("/api/v2/users/user/settings")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: { personalization: { instruction: "test" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return originalFetch(...args);
  }) as typeof globalThis.fetch;

  try {
    const { syncQwenRequestPersonalization } =
      await import("../services/qwen.ts");

    // Should NOT throw — non-fatal
    await syncQwenRequestPersonalization("test instruction", undefined, {
      model: "qwen3.7-plus",
      toolsCount: 0,
      sessionId: null,
      promptChars: 100,
    });

    // If we get here, the function didn't throw — correct behavior
    assert.ok(true, "syncQwenRequestPersonalization should not throw on 401");
  } catch (err) {
    assert.fail(
      `syncQwenRequestPersonalization should NOT throw on 401, but got: ${(err as Error).message}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Personalization: buildCapturedQwenHeaders includes all required fields", async () => {
  // Verify that the headers built for personalization POST include cookie, bx-ua, etc.
  const { getQwenHeaders } = await import("../services/auth-http.ts");
  const { buildQwenRequestHeaders } =
    await import("../services/qwen-headers.ts");

  const { headers } = await getQwenHeaders(false, undefined);

  const requestHeaders = buildQwenRequestHeaders({
    cookie: headers["cookie"],
    userAgent: headers["user-agent"],
    bxUa: headers["bx-ua"],
    bxUmidtoken: headers["bx-umidtoken"],
    bxV: headers["bx-v"],
    extra: { Referer: "https://chat.qwen.ai/settings/personalization" },
  });

  assert.ok(requestHeaders["Cookie"], "Cookie should be present");
  assert.ok(requestHeaders["User-Agent"], "User-Agent should be present");
  assert.ok(requestHeaders["bx-v"], "bx-v should be present");
  assert.ok(requestHeaders["Origin"], "Origin should be present");
  assert.ok(requestHeaders["X-Request-Id"], "X-Request-Id should be present");
});

test("Personalization: isAuthMockEnabled returns true in test mode", async () => {
  const { isAuthMockEnabled } = await import("../services/auth-http.ts");
  assert.strictEqual(
    isAuthMockEnabled(),
    true,
    "should be mock enabled in test",
  );
});

test("Personalization: error propagation from syncQwenRequestPersonalization", async () => {
  // Verify that even if the POST fails with a non-401 error, it doesn't throw
  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    fetchCallCount++;
    const url =
      typeof args[0] === "string" ? args[0] : args[0]?.toString() || "";

    if (url.includes("/api/v2/users/user/settings/update")) {
      return new Response(
        JSON.stringify({
          success: false,
          data: { code: "ServerError", details: "Internal error" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return originalFetch(...args);
  }) as typeof globalThis.fetch;

  try {
    const { syncQwenRequestPersonalization } =
      await import("../services/qwen.ts");

    // Should NOT throw — non-fatal
    await syncQwenRequestPersonalization("test instruction", undefined, {
      model: "qwen3.7-plus",
    });

    assert.ok(true, "should not throw on server error");
  } catch (err) {
    assert.fail(
      `should NOT throw on server error, but got: ${(err as Error).message}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
