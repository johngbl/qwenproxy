/**
 * Copyright (c) 2025 johngbl
 * QwenBridge - OpenAI-compatible proxy for Qwen
 */

import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { deleteAllQwenChats } from "../services/qwen.ts";

test("deleteAllQwenChats sends DELETE to the Qwen chats endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = "";
  let seenMethod = "";
  let seenHeaders: HeadersInit | undefined;

  globalThis.fetch = async (input: any, init?: RequestInit) => {
    seenUrl = typeof input === "string" ? input : input.url;
    seenMethod = init?.method || "GET";
    seenHeaders = init?.headers;

    return new Response(
      JSON.stringify({
        success: true,
        request_id: "req-1",
        data: { status: true },
      }),
      { status: 200 },
    );
  };

  try {
    const ok = await deleteAllQwenChats();
    assert.strictEqual(ok, true);
    assert.strictEqual(seenUrl, "https://chat.qwen.ai/api/v2/chats/");
    assert.strictEqual(seenMethod, "DELETE");

    const headers = seenHeaders as Record<string, string>;
    assert.strictEqual(headers.Referer, "https://chat.qwen.ai/settings/chats");
    assert.strictEqual(headers.source, "web");
    assert.strictEqual(headers.version, "0.2.63");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
