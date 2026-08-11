import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

import { config } from "../core/config.ts";
import { createQwenStream } from "../services/qwen.ts";
import { app } from "../api/server.js";

/**
 * Upstream that sends the SSE terminal event and then KEEPS the connection
 * open (keep-alive) — the exact repro of the 120s stall: the proxy read loop
 * exits on the terminal chunk (upstreamDone break) WITHOUT completing the
 * wrapper's pull, so the per-account stream lock is only released by an
 * explicit cancel (the finally) or the idle timeout.
 */
function terminalThenOpenStream() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_thought": {"content": ["Thinking..."]}}}}], "usage": {"input_tokens": 23, "output_tokens": 56, "total_tokens": 79}}\n\n',
        ),
      );
      controller.enqueue(
        encoder.encode(
          'data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}], "usage": {"input_tokens": 23, "output_tokens": 60, "total_tokens": 83}}\n\n',
        ),
      );
      // Terminal event — deliberately NO controller.close() afterwards.
      controller.enqueue(
        encoder.encode(
          'data: {"choices": [{"delta": {"phase": "answer", "status": "finished"}}]}\n\n',
        ),
      );
    },
  });
  return new Response(stream, { status: 200 });
}

function installMockFetch(
  handler: (url: string) => Response,
  onCall?: (url: string) => void,
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : "url" in input
          ? input.url
          : String(input);
    if (url.includes("/api/v2/chat/completions")) {
      onCall?.(url);
      return handler(url);
    }
    return originalFetch(input, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

test("terminal-then-open upstream: cancelling the reader releases the stream lock", async () => {
  const restore = installMockFetch(() => terminalThenOpenStream());
  try {
    const account = "terminal-cancel-a";

    const first = await createQwenStream(
      "Prompt 1",
      true,
      "qwen3.6-plus",
      undefined,
      account,
    );
    const reader = first.stream.getReader();

    // Consume until the terminal event is seen (the proxy's read loop would
    // break right here; the upstream connection stays open underneath).
    const { value } = await reader.read();
    assert.ok(value, "first upstream chunk should be readable");
    const text = new TextDecoder().decode(value);
    assert.ok(text.includes("thinking_summary"), "terminal-then-open mock");

    // What the processStreamingResponse finally now does: cancel the reader.
    await reader.cancel();

    // The lock must hand off immediately — a second create on the same
    // account must NOT block (without the cancel it would wait for the idle
    // timeout; bound the wait so a regression fails fast).
    const second = await withTimeout(
      createQwenStream("Prompt 2", true, "qwen3.6-plus", undefined, account),
      5_000,
      "stream lock not released after reader.cancel()",
    );
    // The second stream is only a lock-probe: cancel it so its 180s idle
    // timer does not hold the event loop (test hygiene).
    await second.stream.cancel();
  } finally {
    restore();
  }
});

test("abort while queued on the stream lock throws without an upstream request", async () => {
  const upstreamCalls: string[] = [];
  const restore = installMockFetch(
    () => terminalThenOpenStream(),
    (url) => upstreamCalls.push(url),
  );
  try {
    const account = "abort-queue-b";

    // Holder occupies the account stream lock.
    const holder = await createQwenStream(
      "Hold",
      true,
      "qwen3.6-plus",
      undefined,
      account,
    );

    // Queued create with a controllable signal: passes the pre-lock check,
    // then waits on the mutex. The acquire deadline / supersede abort fires
    // while it is queued.
    const abort = new AbortController();
    const queued = createQwenStream(
      "Queued",
      true,
      "qwen3.6-plus",
      undefined,
      account,
      undefined,
      undefined,
      abort.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    abort.abort();
    await holder.stream.cancel();

    await assert.rejects(queued, /client aborted before stream creation/);
    // The aborted attempt must not have made an upstream request.
    assert.strictEqual(upstreamCalls.length, 1);
  } finally {
    restore();
  }
});

test("full HTTP flow: a turn after a terminal-then-open upstream acquires the stream lock immediately", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "qwen3.6-plus", owned_by: "qwen" }] }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v2/chat/completions")) {
      return terminalThenOpenStream();
    }
    return originalFetch(input);
  };

  const chatRequest = (content: string) =>
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [{ role: "user", content }],
        stream: true,
      }),
    });

  try {
    // Turn 1: the upstream sends the terminal event but never closes. The
    // proxy still completes the response ([DONE]); the finally must cancel
    // the reader so the account stream lock is released.
    const res1 = await app.fetch(chatRequest("turn one"));
    const text1 = await res1.text();
    assert.ok(text1.includes("Hello"), "turn 1 should emit the answer");
    assert.ok(text1.includes("data: [DONE]"), "turn 1 should terminate");

    // Turn 2 on the same account: must NOT block on the stream lock held by
    // turn 1's unclosed upstream. Bounded so a regression fails fast instead
    // of hanging until the 180s idle timeout.
    const res2 = await withTimeout(
      Promise.resolve(app.fetch(chatRequest("turn two"))),
      10_000,
      "second turn blocked on the stream lock of an unclosed upstream",
    );
    const text2 = await res2.text();
    assert.ok(text2.includes("data: [DONE]"), "turn 2 should complete");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("config sanity: acquire deadline default is 120s (fix scope guard)", () => {
  assert.equal(config.concurrency.acquireDeadlineMs, 120_000);
});
