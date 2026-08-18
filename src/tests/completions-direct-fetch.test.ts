import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../core/config.ts";

const originalFetch = globalThis.fetch;

/**
 * Direct (Node-side) completion fetch fast path — `tryDirectCompletionFetch`
 * + its per-account circuit breaker. This is the latency lever that skips the
 * CDP bridge for POST /api/v2/chat/completions: only a clean SSE success is
 * used; WAF/HTML/non-SSE responses and network errors fall back to the browser
 * relay, and after repeated failures the per-account breaker opens so
 * WAF-hostile accounts go straight to the browser.
 */
const VALID_CAPTURED_HEADERS: Record<string, string> = {
  cookie: "qwen_session=abc; x5sec=def",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0",
  "bx-v": "2.5.37",
  "bx-ua": "231!token",
  "bx-umidtoken": "umid-token",
  "sec-ch-ua": '"Edge";v="151"',
  version: "0.2.86",
};

const abortSignal = new AbortController().signal;

async function loadModule() {
  return await import("../services/qwen.ts");
}

test("direct completion fetch: clean SSE response is returned (body untouched)", async () => {
  globalThis.fetch = (async () => {
    return new Response("data: {\"x\":1}\n\ndata: [DONE]\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    const { tryDirectCompletionFetch } = await loadModule();
    const result = await tryDirectCompletionFetch(
      "d-acc1",
      "chat-1",
      "https://chat.qwen.ai/api/v2/chat/completions?chat_id=chat-1",
      JSON.stringify({ stream: true }),
      VALID_CAPTURED_HEADERS,
      abortSignal,
    );
    assert.ok(result, "a clean SSE response must be returned");
    assert.equal(result!.status, 200);
    const text = await result!.text();
    assert.ok(text.includes("[DONE]"), "stream body must be intact");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direct completion fetch: HTML WAF response falls back (undefined)", async () => {
  globalThis.fetch = (async () => {
    return new Response("<!doctype html><title>captcha</title>", {
      status: 403,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;
  try {
    const { tryDirectCompletionFetch } = await loadModule();
    const result = await tryDirectCompletionFetch(
      "d-acc2",
      "chat-2",
      "https://chat.qwen.ai/api/v2/chat/completions?chat_id=chat-2",
      "{}",
      VALID_CAPTURED_HEADERS,
      abortSignal,
    );
    assert.equal(result, undefined, "an HTML WAF page must fall back to the browser");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direct completion fetch: non-SSE JSON response falls back (undefined)", async () => {
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: "boom" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const { tryDirectCompletionFetch } = await loadModule();
    const result = await tryDirectCompletionFetch(
      "d-acc3",
      "chat-3",
      "https://chat.qwen.ai/api/v2/chat/completions?chat_id=chat-3",
      "{}",
      VALID_CAPTURED_HEADERS,
      abortSignal,
    );
    assert.equal(result, undefined, "a non-SSE body must fall back to the browser");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direct completion fetch: network error falls back without throwing", async () => {
  globalThis.fetch = (async () => {
    throw new Error("ETIMEDOUT");
  }) as typeof fetch;
  try {
    const { tryDirectCompletionFetch } = await loadModule();
    const result = await tryDirectCompletionFetch(
      "d-acc4",
      "chat-4",
      "https://chat.qwen.ai/api/v2/chat/completions?chat_id=chat-4",
      "{}",
      VALID_CAPTURED_HEADERS,
      abortSignal,
    );
    assert.equal(result, undefined, "a network error must fall back, not throw");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direct completion fetch: circuit breaker opens after 3 consecutive failures", async () => {
  const { recordDirectFetchFailure, recordDirectFetchSuccess, canUseDirectFetchRequest } =
    await loadModule();
  const prev = config.qwen.directFetch;
  config.qwen.directFetch = true; // test the breaker logic if the opt-in is enabled
  const acc = "d-acc-circuit";
  try {
    assert.equal(canUseDirectFetchRequest(acc), true, "breaker starts closed");
    recordDirectFetchFailure(acc);
    recordDirectFetchFailure(acc);
    assert.equal(canUseDirectFetchRequest(acc), true, "breaker still closed after 2");
    recordDirectFetchFailure(acc);
    assert.equal(
      canUseDirectFetchRequest(acc),
      false,
      "breaker opens after 3 consecutive failures",
    );
    // A success resets the counter — but the account is still blocked until the
    // 5-min window elapses; success only stops counting, it does not close the
    // breaker early.
    recordDirectFetchSuccess(acc);
    assert.equal(
      canUseDirectFetchRequest(acc),
      false,
      "opened breaker stays open until its window expires",
    );
  } finally {
    config.qwen.directFetch = prev;
  }
});

test("direct completion fetch: default is OFF (safe) until explicitly opted in", () => {
  // A live probe proved the Qwen WAF blocks Node/undici completions posts with
  // FAIL_SYS_USER_VALIDATE / RGV587_ERROR (challenge captcha) even with
  // browser-captured headers — so the default must not add ~1.4s of failed
  // latency per request; the browser relay stays primary until QWEN_DIRECT_FETCH
  // is explicitly enabled in a WAF-free environment.
  assert.equal(config.qwen.directFetch, false, "QWEN_DIRECT_FETCH defaults to false");
});

test("direct completion headers: inject bx-ua/bx-umidtoken and chat referer", async () => {
  const { buildDirectCompletionHeaders } = await loadModule();
  const built = buildDirectCompletionHeaders(VALID_CAPTURED_HEADERS, "chat-9");
  assert.equal(built["bx-ua"], "231!token", "bx-ua must be injected");
  assert.equal(built["bx-umidtoken"], "umid-token", "bx-umidtoken must be injected");
  assert.equal(built["bx-v"], "2.5.37");
  assert.equal(
    built["Referer"],
    "https://chat.qwen.ai/c/chat-9",
    "referer must use the chat id (matches the HAR)",
  );
});
